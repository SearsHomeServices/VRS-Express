import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import jwt from "jsonwebtoken";
import { storage } from "./storage";
import { log } from "./index";

interface ConnectedClient {
  ws: WebSocket;
  userId: number;
  name: string;
  role: string;
  divisions: string[];
  agentStatus: string;
  ldapId?: string;
}

interface WSEvent {
  type: string;
  payload: Record<string, any>;
}

const clients = new Map<number, ConnectedClient[]>();

// Tyler 2026-05-11 (VRS follow-up): brief WS disconnects (laptop sleep,
// Wi-Fi blip, browser tab backgrounded, mobile browser throttling)
// used to immediately flip the agent's DB status to "offline" and
// notify admins. The agent's own UI didn't know — they kept seeing
// "Available" while admin saw "Unavailable", and no new tickets routed
// to them because server-side `client.agentStatus` was offline.
// VRS confirmed they want agents to stay Available through transient
// drops since the desktop notification + audio alert fires regardless
// of which tab is focused. We schedule the auto-offline with a 5min
// grace window — generous enough to ride out a backgrounded tab, a
// laptop lid close-and-reopen, a coffee-shop Wi-Fi reconnect, etc. If
// the agent's reconnect loop (client/src/lib/websocket.ts
// scheduleReconnect, exponential backoff capped at 30s) lands a new
// socket within that window, we cancel the timer and the agent stays
// online without a flicker. If they're truly gone (browser fully
// closed, machine asleep > 5min), the timer fires and admins/techs are
// notified as before.
// Tyler 2026-05-20 (afternoon) — Auto-offline logic moved client-side.
// Thomas Bottoms reported being marked Unavailable mid-NLA ticket while
// actively typing in a form. Root cause: WS-idle is the wrong signal for
// "agent walked away" — proxy drops, tab focus changes, and autoscale
// churn all look like "inactivity" while the agent is actively working.
// The primary auto-offline path is now client-side SCREEN inactivity
// (mousemove/keydown/touch/scroll) in agent-dashboard.tsx → POST
// /api/agent/auto-offline.
//
// We keep a much longer (60 min) server-side disconnect-presence
// fallback below to cover "agent closed the browser/laptop entirely"
// — otherwise their DB row stays online forever, inflating the
// tech-facing onlineAgents count and admin visibility. Window is
// deliberately 2x the client's 30-min idle threshold so the client
// path is always the first to fire when a tab is still alive. This
// fallback does NOT stamp autoOfflinedAt (no modal needed — the
// agent's browser is gone).
const PRESENCE_STALE_MS = 60 * 60 * 1000;
const pendingPresenceTimers = new Map<number, NodeJS.Timeout>();

// Tyler 2026-06-25 — authoritative record of agents WE demoted via the
// presence-stale fallback (not a manual/admin toggle, not the 30-min idle
// path). Populated only when the cleanup actually flips an agent offline, and
// cleared by ANY explicit status change (updateClientStatus) or restore. It is
// the sole gate for auto-restore-on-reconnect, so the decision never depends on
// best-effort activity-log writes succeeding.
const presenceDemotedUsers = new Set<number>();

// Tyler 2026-06-25 — last time we heard ANYTHING from a user across all of
// their sockets (a new connection, an app-level keepalive ping, any inbound
// frame). The 60-min presence-stale fallback below used to demote an agent
// purely because the `clients` map read empty at the moment its timer fired.
// Under heavy zombie/reconnect churn (a fresh socket registers behind two
// awaits while an older one's close races it) that map can read empty for an
// agent who is actively present and reconnecting every few minutes — which
// flipped real, working agents to "Unavailable" mid-shift (Efrain Neives and
// ~30 others, 2026-06-25). The cleanup now additionally requires genuine
// silence for the full window before demoting, so socket churn alone can
// never knock an agent offline.
const lastSeenByUser = new Map<number, number>();
function touchLastSeen(userId: number) {
  lastSeenByUser.set(userId, Date.now());
}

// Arm (or re-arm) the long presence-stale cleanup for an agent whose last
// socket just closed. The timer self-reschedules if we've heard from the
// agent within the window, so transient reconnect churn can never demote a
// present agent — only a true 60-min absence (browser fully closed) does.
function schedulePresenceCleanup(client: ConnectedClient) {
  const prior = pendingPresenceTimers.get(client.userId);
  if (prior) clearTimeout(prior);
  const fire = async () => {
    pendingPresenceTimers.delete(client.userId);
    const live = clients.get(client.userId);
    if (live && live.length > 0) return;
    const sinceSeen = Date.now() - (lastSeenByUser.get(client.userId) ?? 0);
    if (sinceSeen < PRESENCE_STALE_MS) {
      // We heard from this user within the window (a reconnect or keepalive
      // landed even though no socket is registered at this exact instant).
      // Re-check when the window would actually elapse instead of demoting a
      // present-but-churning agent.
      const timer = setTimeout(fire, PRESENCE_STALE_MS - sinceSeen);
      pendingPresenceTimers.set(client.userId, timer);
      return;
    }
    try {
      const fresh = await storage.getUser(client.userId);
      if (!fresh || (fresh as any).agentStatus !== "online") return;
      // Don't strand a pending ticket.
      const pendingCount = await storage.getPendingCount(client.userId);
      const nlaPendingCount = await storage.getNlaPendingCount(client.userId);
      if (pendingCount > 0 || nlaPendingCount > 0) {
        log(`Skipped presence cleanup for ${client.name} — open pending ticket`, "ws");
        try {
          await storage.logAgentActivity({
            userId: client.userId,
            eventType: "presence_stale_skipped_pending",
            details: { pendingCount, nlaPendingCount, staleMinutes: PRESENCE_STALE_MS / 60000 } as any,
          } as any);
        } catch {}
        return;
      }
      await storage.updateUser(client.userId, { agentStatus: "offline", updatedAt: new Date() } as any);
      lastSeenByUser.delete(client.userId);
      // Mark this as a presence-stale demotion so a later reconnect can self-heal.
      presenceDemotedUsers.add(client.userId);
      try {
        await storage.logAgentActivity({
          userId: client.userId,
          eventType: "presence_stale_cleanup",
          details: { staleMinutes: PRESENCE_STALE_MS / 60000, reason: "no_active_ws_sessions" } as any,
        } as any);
      } catch {}
      broadcastToAdmins({
        type: "agent_status_changed",
        payload: { userId: client.userId, name: client.name, status: "offline" },
      });
      const onlineCount = await storage.getOnlineAgentCount();
      const queuedCount = await storage.getQueuedCountAll();
      broadcastToTechnicians({
        type: "vrs_availability",
        payload: { onlineAgents: onlineCount, queuedTickets: queuedCount },
      });
      log(`Agent ${client.name} cleaned up after ${PRESENCE_STALE_MS / 60000}min of no sessions`, "ws");
    } catch (err) {
      log(`Presence cleanup failed for ${client.name}: ${err}`, "ws");
    }
  };
  const timer = setTimeout(fire, PRESENCE_STALE_MS);
  pendingPresenceTimers.set(client.userId, timer);
}

// Tyler 2026-06-25 — self-healing reconnect restore. If our 60-min presence
// fallback ever demotes an agent who is in fact still working, the moment their
// browser reconnects we put them back online. Eligibility is authoritative on
// OUR OWN action: `presenceDemotedUsers` is populated only by the cleanup path
// when it actually demotes, and cleared by any explicit status change
// (updateClientStatus) — so a later manual/admin offline always cancels
// auto-restore, independent of whether best-effort activity-log writes
// succeeded. We never touch the 30-min screen-idle path (autoOfflinedAt set),
// which intentionally requires the agent to acknowledge the inactivity modal.
// On a process restart the set is empty: the safe failure mode is "leave the
// agent offline until they toggle", never "wrongly force them online". Returns
// the effective status the reconnecting client should re-sync its UI to.
async function maybeAutoRestoreAgent(client: ConnectedClient, user: any): Promise<string> {
  const status = (user?.agentStatus as string) || "offline";
  if (client.role !== "vrs_agent") return status;
  if (status !== "offline") return status;
  if (user?.autoOfflinedAt) return status; // 30-min idle path — needs manual ack
  // Atomically claim eligibility: delete() returns true only for the first
  // caller, so concurrent multi-tab reconnects can't double-restore and the
  // token is consumed before any await yields the event loop.
  if (!presenceDemotedUsers.delete(client.userId)) return status; // not our demotion
  try {
    await storage.updateUser(client.userId, { agentStatus: "online", updatedAt: new Date() } as any);
    try {
      await storage.logAgentActivity({
        userId: client.userId,
        eventType: "presence_auto_restored",
        details: { reason: "reconnect_after_presence_stale", restoredFrom: "offline" } as any,
      } as any);
    } catch {}
    broadcastToAdmins({
      type: "agent_status_changed",
      payload: { userId: client.userId, name: client.name, status: "online" },
    });
    const onlineCount = await storage.getOnlineAgentCount();
    const queuedCount = await storage.getQueuedCountAll();
    broadcastToTechnicians({
      type: "vrs_availability",
      payload: { onlineAgents: onlineCount, queuedTickets: queuedCount },
    });
    log(`Agent ${client.name} auto-restored to online on reconnect (was presence-stale offline)`, "ws");
    return "online";
  } catch (err) {
    // Restore failed — re-arm eligibility so the next reconnect can retry.
    presenceDemotedUsers.add(client.userId);
    log(`Auto-restore failed for ${client.name}: ${err}`, "ws");
    return status;
  }
}

// Tyler 2026-06-25 — WS reconnect-storm watch. The disease behind the
// false-offline incident was ~9,700 zombie reconnects/day caused by the
// Autoscale deployment killing idle WebSockets ~every 60s. After moving to a
// Reserved VM (always-on, single instance, no idle-kill) that churn should
// collapse to genuine reconnects only. This records every accepted connection
// in a rolling 5-min window; if the count crosses a threshold it opens a
// `ws_reconnect_storm` incident in the System Health Regression Watch (and
// clears it when churn returns to normal) so any regression surfaces on the
// admin health view instead of silently flipping agents offline again.
const CHURN_WINDOW_MS = 5 * 60 * 1000;
const CHURN_ALERT_THRESHOLD = Number(process.env.WS_CHURN_ALERT_THRESHOLD) || 250;
const CHURN_CHECK_NAME = "ws_reconnect_storm";
const CHURN_EVAL_INTERVAL_MS = 60 * 1000;
let connectionTimes: number[] = [];
function recordConnectionForChurn() {
  const now = Date.now();
  connectionTimes.push(now);
  if (connectionTimes.length > 10000) {
    const cutoff = now - CHURN_WINDOW_MS;
    connectionTimes = connectionTimes.filter((t) => t >= cutoff);
  }
}
async function evaluateChurn() {
  const now = Date.now();
  const cutoff = now - CHURN_WINDOW_MS;
  connectionTimes = connectionTimes.filter((t) => t >= cutoff);
  const count = connectionTimes.length;
  const perMin = Math.round(count / (CHURN_WINDOW_MS / 60000));
  try {
    const existing = await storage.findOpenHealthIncident(CHURN_CHECK_NAME, "system", 0);
    if (count > CHURN_ALERT_THRESHOLD) {
      log(`[ws] CHURN ALERT: ${count} connections in last 5min (~${perMin}/min, threshold ${CHURN_ALERT_THRESHOLD})`, "ws");
      if (existing) {
        await storage.touchHealthIncident(existing.id);
      } else {
        await storage.openHealthIncident({
          checkName: CHURN_CHECK_NAME,
          severity: "warning",
          entityType: "system",
          entityId: 0,
          finding: { connectionsLast5Min: count, approxPerMin: perMin, threshold: CHURN_ALERT_THRESHOLD } as any,
        } as any);
        broadcastToAdmins({
          type: "system_health_alert",
          payload: { checkName: CHURN_CHECK_NAME, severity: "warning", connectionsLast5Min: count, approxPerMin: perMin },
        });
      }
    } else if (existing) {
      await storage.clearHealthIncident(existing.id, undefined, "ws reconnect rate returned to normal");
      broadcastToAdmins({
        type: "system_health_alert",
        payload: { checkName: CHURN_CHECK_NAME, severity: "ok", connectionsLast5Min: count, approxPerMin: perMin, cleared: true },
      });
    }
  } catch (err) {
    log(`[ws] churn evaluation failed: ${err}`, "ws");
  }
}

const WARRANTY_LABELS: Record<string, string> = {
  sears_protect: "SPHW",
  sears_pa: "Sears PA",
  legacy_sears_cinch: "Cinch",
  ahs: "American Home Shield",
  first_american: "First American",
};

const DIVISION_LABELS: Record<string, string> = {
  refrigeration: "Refrigeration",
  laundry: "Laundry",
  cooking: "Cooking",
  dishwasher: "Dishwasher / Compactor",
  microwave: "Microwave",
  hvac: "HVAC",
  all_other: "All Other",
  nla: "NLA Parts",
};

export function getWarrantyLabel(warrantyKey: string): string {
  return WARRANTY_LABELS[warrantyKey] || warrantyKey;
}

export function getDivisionLabel(divisionKey: string): string {
  return DIVISION_LABELS[divisionKey] || divisionKey;
}

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Tyler 2026-05-08 — application-level heartbeat. Replit's load balancer
  // (and corporate proxies between agents and us) silently drop idle WS
  // connections after ~30–60s of inactivity, which produced cascades of
  // [ws] WebSocket disconnected lines in prod and made agents feel "kicked
  // out" because real-time updates stopped flowing. We ping every 25s
  // (under the typical 30s proxy idle window). The browser auto-replies
  // with a protocol-level pong; if we don't see a pong before the next
  // tick we terminate the dead socket so the client's reconnect loop
  // (client/src/lib/websocket.ts scheduleReconnect) takes over cleanly.
  const HEARTBEAT_INTERVAL_MS = 25000;
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const tagged = ws as WebSocket & { isAlive?: boolean };
      if (tagged.isAlive === false) {
        try { ws.terminate(); } catch {}
        return;
      }
      tagged.isAlive = false;
      try { ws.ping(); } catch {}
    });
  }, HEARTBEAT_INTERVAL_MS);
  wss.on("close", () => clearInterval(heartbeatInterval));

  wss.on("connection", async (ws, req) => {
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on("pong", () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });

    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      ws.close(4001, "No token provided");
      return;
    }

    try {
      const secret = process.env.SESSION_SECRET!;
      const decoded = jwt.verify(token, secret) as {
        id: number;
        name: string;
        role: string;
      };

      const user = await storage.getUser(decoded.id);
      if (!user || !user.isActive) {
        ws.close(4002, "User not found or inactive");
        return;
      }

      let divisions: string[] = [];
      if (user.role === "admin" || user.role === "super_admin") {
        divisions = Object.keys(DIVISION_LABELS);
      } else if (user.role === "vrs_agent") {
        const specs = await storage.getSpecializations(decoded.id);
        divisions = specs.map(s => s.division);
      }

      const client: ConnectedClient = {
        ws,
        userId: decoded.id,
        name: user.name || decoded.name,
        role: user.role,
        divisions,
        agentStatus: (user as any).agentStatus || "offline",
        ldapId: (decoded as any).ldapId,
      };

      // Agent reconnected within the presence-stale window — cancel any
      // pending "browser closed for 60 min" cleanup.
      const pendingPresence = pendingPresenceTimers.get(decoded.id);
      if (pendingPresence) {
        clearTimeout(pendingPresence);
        pendingPresenceTimers.delete(decoded.id);
      }

      const existing = clients.get(decoded.id) || [];
      existing.push(client);
      clients.set(decoded.id, existing);
      touchLastSeen(decoded.id);
      log(`WebSocket connected: ${client.name} (${client.role}, id=${client.userId}, sessions=${existing.length})`, "ws");

      // Count this accepted connection for the reconnect-storm watch.
      recordConnectionForChurn();

      // Self-heal: if this agent was demoted by the presence-stale fallback
      // and is now reconnecting, put them back online. Returns the status the
      // client UI should re-sync to (unchanged for everyone else).
      const effectiveStatus = await maybeAutoRestoreAgent(client, user);
      if (effectiveStatus !== client.agentStatus) {
        updateClientStatus(decoded.id, effectiveStatus);
      }

      // Tyler 2026-05-26 — app-level ping/pong, attached AFTER auth so
      // unauthenticated traffic during the close handshake is never
      // parsed. Pairs with the client's 20s keepalive — gives the
      // client deterministic inbound activity (so quiet days don't
      // trigger false-positive zombie detection) while letting us
      // detect a dead outbound socket via send() throwing.
      //
      // Rate-limited per connection: client sends every 20s, so a sane
      // client sees ~3 pings/min. We allow 60/min (a 20x burst) and
      // terminate on abuse to keep this from becoming a DoS surface.
      const PING_WINDOW_MS = 60_000;
      const PING_MAX_PER_WINDOW = 60;
      const MAX_PING_BYTES = 256;
      let pingWindowStart = Date.now();
      let pingsInWindow = 0;
      ws.on("message", (raw) => {
        const buf = raw as Buffer;
        if (buf.length > MAX_PING_BYTES) return;
        // Any inbound frame (the client's 20s keepalive ping included) proves
        // this user is still present — feeds the presence-stale guard.
        touchLastSeen(client.userId);
        const now = Date.now();
        if (now - pingWindowStart > PING_WINDOW_MS) {
          pingWindowStart = now;
          pingsInWindow = 0;
        }
        pingsInWindow++;
        if (pingsInWindow > PING_MAX_PER_WINDOW) {
          log(`WS ping flood from ${client.name} (id=${client.userId}) — terminating`, "ws");
          try { ws.terminate(); } catch {}
          return;
        }
        try {
          const msg = JSON.parse(buf.toString());
          if (msg && msg.type === "ping") {
            try { ws.send(JSON.stringify({ type: "pong", t: msg.t })); } catch {}
          }
        } catch {}
      });

      ws.on("close", async () => {
        const sessions = clients.get(decoded.id);
        if (sessions) {
          const remaining = sessions.filter(c => c.ws !== ws);
          if (remaining.length > 0) {
            clients.set(decoded.id, remaining);
            log(`WebSocket session closed: ${client.name} (id=${client.userId}, remaining=${remaining.length})`, "ws");
          } else {
            clients.delete(decoded.id);
            log(`WebSocket disconnected: ${client.name} (id=${client.userId}, last session)`, "ws");

            // Agent's last session is gone. If they're a VRS agent still
            // marked online, start a long (60 min) presence cleanup so
            // tech-facing onlineAgents and admin visibility don't show
            // a ghost-online agent forever. Does NOT stamp autoOfflinedAt
            // (no modal — the browser is closed). Cancelled on reconnect.
            // Only the agent-online path keeps lastSeen (the cleanup timer
            // consumes it); everyone else's entry is dropped here so the
            // map can't grow unbounded across the user base.
            if (client.role === "vrs_agent" && client.agentStatus !== "offline") {
              schedulePresenceCleanup(client);
            } else {
              lastSeenByUser.delete(decoded.id);
            }
          }
        }
      });

      ws.on("error", () => {
        const sessions = clients.get(decoded.id);
        if (sessions) {
          const remaining = sessions.filter(c => c.ws !== ws);
          if (remaining.length > 0) {
            clients.set(decoded.id, remaining);
          } else {
            clients.delete(decoded.id);
            // No presence timer is armed on the error path (the trailing
            // close finds an empty session list), so nothing will consume
            // lastSeen — drop it to keep the map bounded.
            lastSeenByUser.delete(decoded.id);
          }
        }
      });

      // Echo back the authoritative DB agentStatus so the client's
      // local UI state can re-sync on every (re)connect. Without this,
      // a UI that stuck on "Available" through a disconnect could
      // disagree with the DB and with admin's view.
      sendToClient(ws, {
        type: "connected",
        payload: {
          userId: decoded.id,
          agentStatus: effectiveStatus,
          autoOfflinedAt: (user as any).autoOfflinedAt || null,
        },
      });

      if (client.role === 'technician') {
        try {
          const onlineAgents = await storage.getOnlineAgentCount();
          const queuedTickets = await storage.getQueuedCountAll();
          sendToClient(ws, {
            type: 'vrs_availability',
            payload: { onlineAgents, queuedTickets }
          });
        } catch (e) {
          sendToClient(ws, {
            type: 'vrs_availability',
            payload: { onlineAgents: 0, queuedTickets: 0 }
          });
        }
      }

    } catch (err) {
      ws.close(4003, "Invalid token");
    }
  });

  log("WebSocket server initialized on /ws", "ws");
}

function sendToClient(ws: WebSocket, event: WSEvent) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function sendToUser(userId: number, event: WSEvent) {
  const sessions = clients.get(userId);
  if (sessions) {
    for (const c of sessions) {
      sendToClient(c.ws, event);
    }
  }
}

export function broadcastToAgent(userId: number, event: WSEvent) {
  sendToUser(userId, event);
}

// Tyler 2026-05-26 — pick the freshest live session for filter eligibility,
// not sessions[0]. The prior code consulted sessions[0] for role/status/
// divisions, which silently dropped users whose first-opened tab had gone
// stale (laptop slept, browser tab backgrounded long enough for the WS to
// die before eviction) while a newer tab was active. We now prefer the
// first session whose socket is still OPEN; the closed-socket session is
// kept in the list until the connection close handler evicts it, but it
// no longer gates delivery for the user's other live tabs.
function pickLiveSession(sessions: ConnectedClient[]): ConnectedClient | null {
  for (const s of sessions) {
    if (s.ws.readyState === WebSocket.OPEN) return s;
  }
  return null;
}

// Tyler 2026-05-26 — broadcast audit log. Emits one [broadcast] line per
// new_ticket fan-out so we can prove which users were eligible, which were
// skipped, and which sessions actually received the event. Only logs for
// `new_ticket` to avoid spamming on every status/heartbeat event.
type BroadcastDecision = {
  userId: number;
  name: string;
  role: string;
  status: string;
  divisions: string[];
  liveSessions: number;
  totalSessions: number;
  delivered: boolean;
  skipReason?: string;
};

function logBroadcast(channel: string, target: string, eventType: string, submissionId: unknown, decisions: BroadcastDecision[]) {
  if (eventType !== "new_ticket") return;
  const delivered = decisions.filter(d => d.delivered);
  const skipped = decisions.filter(d => !d.delivered);
  const summary = {
    channel,
    target,
    submissionId: submissionId ?? null,
    deliveredCount: delivered.length,
    skippedCount: skipped.length,
    delivered: delivered.map(d => `${d.name}(${d.role}/${d.status}/${d.liveSessions}of${d.totalSessions})`),
    skipped: skipped.map(d => `${d.name}(${d.role}/${d.status}):${d.skipReason}`),
  };
  log(`[broadcast] ${JSON.stringify(summary)}`, "ws");
}

export function broadcastToDivisionAgents(division: string, event: WSEvent, excludeUserId?: number) {
  const decisions: BroadcastDecision[] = [];
  for (const [userId, sessions] of clients) {
    if (excludeUserId && userId === excludeUserId) continue;
    const primary = pickLiveSession(sessions);
    const liveCount = sessions.filter(s => s.ws.readyState === WebSocket.OPEN).length;
    const baseRecord = (skipReason: string, delivered = false): BroadcastDecision => ({
      userId,
      name: primary?.name ?? sessions[0]?.name ?? `user_${userId}`,
      role: primary?.role ?? sessions[0]?.role ?? "?",
      status: primary?.agentStatus ?? sessions[0]?.agentStatus ?? "?",
      divisions: primary?.divisions ?? sessions[0]?.divisions ?? [],
      liveSessions: liveCount,
      totalSessions: sessions.length,
      delivered,
      skipReason: delivered ? undefined : skipReason,
    });

    if (!primary) { decisions.push(baseRecord("no_live_session")); continue; }

    const isAgent = primary.role === "vrs_agent";
    const isAdmin = primary.role === "admin" || primary.role === "super_admin";
    if (!isAgent && !isAdmin) { decisions.push(baseRecord("not_agent_or_admin")); continue; }

    if (isAgent && primary.agentStatus !== "online" && primary.agentStatus !== "working") {
      decisions.push(baseRecord(`agent_status_${primary.agentStatus}`)); continue;
    }

    const isGeneralist = primary.divisions.includes("generalist") ||
      primary.divisions.length >= Object.keys(DIVISION_LABELS).length;
    if (!(isGeneralist || primary.divisions.includes(division))) {
      decisions.push(baseRecord(`division_mismatch(${division})`)); continue;
    }

    for (const c of sessions) {
      sendToClient(c.ws, event);
    }
    decisions.push(baseRecord("", true));
  }
  logBroadcast("division", division, (event as any).type, (event as any)?.payload?.submissionId, decisions);
}

export function broadcastToNlaDivisionAgents(applianceType: string, event: WSEvent, excludeUserId?: number) {
  const decisions: BroadcastDecision[] = [];
  for (const [userId, sessions] of clients) {
    if (excludeUserId && userId === excludeUserId) continue;
    const primary = pickLiveSession(sessions);
    const liveCount = sessions.filter(s => s.ws.readyState === WebSocket.OPEN).length;
    const baseRecord = (skipReason: string, delivered = false): BroadcastDecision => ({
      userId,
      name: primary?.name ?? sessions[0]?.name ?? `user_${userId}`,
      role: primary?.role ?? sessions[0]?.role ?? "?",
      status: primary?.agentStatus ?? sessions[0]?.agentStatus ?? "?",
      divisions: primary?.divisions ?? sessions[0]?.divisions ?? [],
      liveSessions: liveCount,
      totalSessions: sessions.length,
      delivered,
      skipReason: delivered ? undefined : skipReason,
    });

    if (!primary) { decisions.push(baseRecord("no_live_session")); continue; }

    const isAgent = primary.role === "vrs_agent";
    const isAdmin = primary.role === "admin" || primary.role === "super_admin";
    if (!isAgent && !isAdmin) { decisions.push(baseRecord("not_agent_or_admin")); continue; }

    if (isAgent && primary.agentStatus !== "online" && primary.agentStatus !== "working") {
      decisions.push(baseRecord(`agent_status_${primary.agentStatus}`)); continue;
    }

    if (!primary.divisions.includes("nla")) {
      decisions.push(baseRecord("no_nla_division")); continue;
    }

    const allApplianceDivisions = Object.keys(DIVISION_LABELS).filter(k => k !== "nla");
    const agentApplianceDivisions = primary.divisions.filter((d: string) => d !== "nla" && d !== "generalist");
    const isApplianceGeneralist = agentApplianceDivisions.length >= allApplianceDivisions.length ||
      primary.divisions.includes("generalist");

    if (!(isApplianceGeneralist || agentApplianceDivisions.includes(applianceType))) {
      decisions.push(baseRecord(`nla_appliance_mismatch(${applianceType})`)); continue;
    }

    for (const c of sessions) {
      sendToClient(c.ws, event);
    }
    decisions.push(baseRecord("", true));
  }
  logBroadcast("nla", applianceType, (event as any).type, (event as any)?.payload?.submissionId, decisions);
}

export function broadcastToAdmins(event: WSEvent) {
  for (const [, sessions] of clients) {
    for (const c of sessions) {
      if (c.role === "admin" || c.role === "super_admin") {
        sendToClient(c.ws, event);
      }
    }
  }
}

export function broadcastToAllAgents(event: WSEvent, excludeUserId?: number) {
  for (const [userId, sessions] of clients) {
    if (excludeUserId && userId === excludeUserId) continue;
    const primary = sessions[0];
    if (primary && primary.role === "vrs_agent") {
      for (const c of sessions) {
        sendToClient(c.ws, event);
      }
    }
  }
}

export function updateClientStatus(userId: number, status: string) {
  // Any explicit status change (self toggle, admin toggle, ticket-flow
  // transition, or the client auto-offline route) cancels presence-stale
  // auto-restore eligibility — even when the user has no live sessions.
  presenceDemotedUsers.delete(userId);
  const sessions = clients.get(userId);
  if (sessions) {
    for (const c of sessions) {
      c.agentStatus = status;
    }
  }
}

export function updateClientDivisions(userId: number, divisions: string[]) {
  const sessions = clients.get(userId);
  if (sessions) {
    for (const c of sessions) {
      c.divisions = divisions;
    }
  }
}

// Tyler 2026-05-26 — count of live (readyState OPEN) WS sessions for a
// user. Used by the auto-offline route to refuse to demote a user when
// they have another active tab open — without this, Tab A backgrounding
// for 30 min would offline them globally while Tab B is being actively
// worked. The presence-stale safety net already handles "all tabs
// gone" via its own multi-session check.
export function getLiveSessionCount(userId: number): number {
  const sessions = clients.get(userId);
  if (!sessions) return 0;
  let n = 0;
  for (const s of sessions) {
    if (s.ws.readyState === WebSocket.OPEN) n++;
  }
  return n;
}

export function getOnlineAgentCount(): number {
  let count = 0;
  for (const [, sessions] of clients) {
    const primary = sessions[0];
    if (primary && primary.role === 'vrs_agent' && primary.agentStatus === 'online') {
      count++;
    }
  }
  return count;
}

export function broadcastToTechnicians(event: WSEvent) {
  for (const [, sessions] of clients) {
    for (const c of sessions) {
      if (c.role === 'technician') {
        sendToClient(c.ws, event);
      }
    }
  }
}

// Force-close all WebSocket sessions for a user. Called immediately when a
// user is deactivated or has their role changed so they cannot continue
// receiving privileged real-time events for the remainder of their connection.
export function forceDisconnectUser(userId: number): void {
  const sessions = clients.get(userId);
  if (!sessions) return;
  for (const c of sessions) {
    try { c.ws.close(4010, "Session revoked"); } catch {}
  }
  clients.delete(userId);
  const pending = pendingPresenceTimers.get(userId);
  if (pending) {
    clearTimeout(pending);
    pendingPresenceTimers.delete(userId);
  }
  lastSeenByUser.delete(userId);
  presenceDemotedUsers.delete(userId);
  log(`Force-disconnected WebSocket sessions for user ${userId} (revocation)`, "ws");
}

// Periodic background revalidation — every 5 minutes check every connected
// client against the DB to catch deactivations/demotions that happened while
// the socket was alive. This is a safety net; `forceDisconnectUser` handles
// the immediate case when the admin UI makes the change.
const WS_REVALIDATION_INTERVAL_MS = 5 * 60 * 1000;
async function revalidateConnectedClients(): Promise<void> {
  for (const [userId, sessions] of clients) {
    const primary = pickLiveSession(sessions);
    if (!primary) continue;
    try {
      if (primary.ldapId) {
        // Technician: check both the users row and the technicians directory.
        // Also disconnect if role has changed away from technician.
        const [techUser, technician] = await Promise.all([
          storage.getUser(userId),
          storage.getTechnicianByLdapId(primary.ldapId),
        ]);
        if (!techUser || !techUser.isActive || !technician || !technician.isActive) {
          forceDisconnectUser(userId);
        } else if (techUser.role !== primary.role) {
          // Role changed (e.g., promoted from technician to vrs_agent) — disconnect
          // so the client re-authenticates with a fresh token carrying the new role.
          forceDisconnectUser(userId);
        }
      } else {
        // Non-technician: check isActive and role in the users table.
        const user = await storage.getUser(userId);
        if (!user || !user.isActive || user.role !== primary.role) {
          forceDisconnectUser(userId);
        }
      }
    } catch {
      // Ignore transient DB errors — the next tick will retry.
    }
  }
}

setInterval(() => {
  revalidateConnectedClients().catch((err) =>
    log(`WS revalidation error: ${err}`, "ws")
  );
}, WS_REVALIDATION_INTERVAL_MS);

setInterval(() => {
  evaluateChurn().catch((err) => log(`[ws] churn interval error: ${err}`, "ws"));
}, CHURN_EVAL_INTERVAL_MS);
