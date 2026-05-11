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
const AUTO_OFFLINE_GRACE_MS = 5 * 60 * 1000;
const pendingOfflineTimers = new Map<number, NodeJS.Timeout>();

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
      };

      // Cancel any pending auto-offline timer for this user — they're
      // back within the grace window, treat the prior disconnect as
      // transient and keep their status as-is.
      const pendingTimer = pendingOfflineTimers.get(decoded.id);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingOfflineTimers.delete(decoded.id);
        log(`Cancelled pending auto-offline for ${user.name} (reconnected within ${AUTO_OFFLINE_GRACE_MS / 1000}s grace)`, "ws");
      }

      const existing = clients.get(decoded.id) || [];
      existing.push(client);
      clients.set(decoded.id, existing);
      log(`WebSocket connected: ${client.name} (${client.role}, id=${client.userId}, sessions=${existing.length})`, "ws");

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

            if (client.role === "vrs_agent" && client.agentStatus !== "offline") {
              // Schedule the offline flip with a grace window. The
              // (re)connect handler above clears this timer if the
              // agent is back in time.
              const existingPending = pendingOfflineTimers.get(client.userId);
              if (existingPending) clearTimeout(existingPending);
              const timer = setTimeout(async () => {
                pendingOfflineTimers.delete(client.userId);
                // Double-check: user may have come back without our
                // connect path cancelling for some reason.
                const liveSessions = clients.get(client.userId);
                if (liveSessions && liveSessions.length > 0) {
                  log(`Skipped auto-offline for ${client.name} — sessions reappeared after grace`, "ws");
                  return;
                }
                try {
                  await storage.updateUser(client.userId, { agentStatus: "offline", updatedAt: new Date() } as any);
                  broadcastToAdmins({
                    type: "agent_status_changed",
                    payload: { userId: client.userId, name: client.name, status: "offline" },
                  });
                  log(`Agent ${client.name} auto-set offline after ${AUTO_OFFLINE_GRACE_MS / 1000}s grace`, "ws");
                  const onlineCount = await storage.getOnlineAgentCount();
                  const queuedCount = await storage.getQueuedCountAll();
                  broadcastToTechnicians({
                    type: 'vrs_availability',
                    payload: { onlineAgents: onlineCount, queuedTickets: queuedCount }
                  });
                } catch (err) {
                  log(`Failed to auto-offline agent ${client.name}: ${err}`, "ws");
                }
              }, AUTO_OFFLINE_GRACE_MS);
              pendingOfflineTimers.set(client.userId, timer);
              log(`Scheduled auto-offline for ${client.name} in ${AUTO_OFFLINE_GRACE_MS / 1000}s (no live sessions)`, "ws");
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
          }
        }
      });

      // Echo back the authoritative DB agentStatus so the client's
      // local UI state can re-sync on every (re)connect. Without this,
      // a UI that stuck on "Available" through a disconnect could
      // disagree with the DB and with admin's view.
      sendToClient(ws, {
        type: "connected",
        payload: { userId: decoded.id, agentStatus: (user as any).agentStatus || "offline" },
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

export function broadcastToDivisionAgents(division: string, event: WSEvent, excludeUserId?: number) {
  for (const [userId, sessions] of clients) {
    if (excludeUserId && userId === excludeUserId) continue;
    const primary = sessions[0];
    if (!primary) continue;

    const isAgent = primary.role === "vrs_agent";
    const isAdmin = primary.role === "admin" || primary.role === "super_admin";
    if (!isAgent && !isAdmin) continue;

    if (isAgent && primary.agentStatus !== "online" && primary.agentStatus !== "working") continue;

    const isGeneralist = primary.divisions.includes("generalist") ||
      primary.divisions.length >= Object.keys(DIVISION_LABELS).length;
    if (isGeneralist || primary.divisions.includes(division)) {
      for (const c of sessions) {
        sendToClient(c.ws, event);
      }
    }
  }
}

export function broadcastToNlaDivisionAgents(applianceType: string, event: WSEvent, excludeUserId?: number) {
  for (const [userId, sessions] of clients) {
    if (excludeUserId && userId === excludeUserId) continue;
    const primary = sessions[0];
    if (!primary) continue;

    const isAgent = primary.role === "vrs_agent";
    const isAdmin = primary.role === "admin" || primary.role === "super_admin";
    if (!isAgent && !isAdmin) continue;

    if (isAgent && primary.agentStatus !== "online" && primary.agentStatus !== "working") continue;

    const hasNla = primary.divisions.includes("nla");
    if (!hasNla) continue;

    const allApplianceDivisions = Object.keys(DIVISION_LABELS).filter(k => k !== "nla");
    const agentApplianceDivisions = primary.divisions.filter((d: string) => d !== "nla" && d !== "generalist");
    const isApplianceGeneralist = agentApplianceDivisions.length >= allApplianceDivisions.length ||
      primary.divisions.includes("generalist");

    if (isApplianceGeneralist || agentApplianceDivisions.includes(applianceType)) {
      for (const c of sessions) {
        sendToClient(c.ws, event);
      }
    }
  }
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

export function getConnectedClient(userId: number): ConnectedClient | undefined {
  const sessions = clients.get(userId);
  return sessions?.[0];
}

export function isAgentConnectedAndOnline(userId: number): boolean {
  const sessions = clients.get(userId);
  return !!sessions && sessions.length > 0 && sessions[0].agentStatus === "online";
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
