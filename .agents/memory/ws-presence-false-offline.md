---
name: WS presence-stale false offlines
description: Why the 60-min presence fallback must gate on a last-seen timestamp, not on the clients map being empty.
---

# Presence-stale fallback must not demote on a momentarily-empty clients map

The server-side 60-min presence fallback in `server/websocket.ts` demotes a VRS
agent to `offline` when their last WS session has been gone for the full window.
It must gate demotion on a per-user **last-heard-from timestamp**
(`lastSeenByUser`, touched on connect-register and on every inbound frame /
20s client keepalive), NOT solely on `clients.get(userId)` reading empty.

**Why:** Production runs with chronic WS churn — every agent's socket goes silent
~60s and force-reconnects every ~3 min (thousands of zombie reconnects/day). A
reconnecting socket registers in the `clients` map only *after* two awaits
(`getUser` + `getSpecializations`), so the map can read empty for an agent who is
actively present. The old guard (clients-map-empty only) therefore demoted real,
working agents mid-shift ("Unavailable" while on the app). Confirmed via the
`presence_stale_cleanup` event (reason `no_active_ws_sessions`) firing ~60×/24h
across 30+ agents while they were reconnecting normally.

**How to apply:** Keep the cleanup timer self-rescheduling: if `clients` has live
sessions → skip; else if `now - lastSeen < PRESENCE_STALE_MS` → reschedule for the
remainder (don't demote); else run cleanup. Only the agent-online path retains a
`lastSeen` entry (the timer consumes it); drop it everywhere else
(non-agent last-session close, error last-session branch, `forceDisconnectUser`,
and inside cleanup after demotion) so the map stays bounded across the user base.

**Root cause of the churn (the disease) — FIXED:** the deployment was on
**Autoscale** (`.replit` → `[deployment] deploymentTarget`). Autoscale is
request-oriented (Cloud Run-style): it idle-kills long-lived WebSockets ~every
60s and can run multiple stateless instances. That produced the ~60s "no
inbound" gap and ~9,700 reconnects/day, and the in-memory `clients`/presence
Maps fragment across instances. **Switched to Reserved VM (`vm`)** — always-on,
single persistent instance, no idle-kill — via `deployConfig`. Needs a republish
to take effect.

**Why this matters as a rule:** any app here that relies on long-lived
WebSockets + in-memory connection/presence state MUST deploy as `vm`, never
`autoscale`. Autoscale will silently shred WS connections and split in-memory
state across instances.

**Self-healing safety net added (server/websocket.ts):**
- *Auto-restore on reconnect* — a `vrs_agent` demoted by the presence fallback is
  flipped back online the moment they reconnect. Eligibility is gated ONLY by an
  in-memory `presenceDemotedUsers` Set (set in the cleanup demotion path; cleared
  by `updateClientStatus` on any explicit toggle/ticket-flow/auto-offline, and by
  `forceDisconnectUser`). Claim it atomically via `Set.delete()` (true only for
  the first caller → no multi-tab double-restore); re-arm in the catch.
  **Why not read agent_activity_log to infer intent:** those writes are
  best-effort (`safeLogActivity` swallows failures), so a failed manual-offline
  log would let a reconnect wrongly restore — the Set is authoritative on our own
  action. Never overrides the 30-min idle path (guarded by `autoOfflinedAt`).
- *Reconnect-storm watch* — every accepted WS connection is counted in a rolling
  5-min window; over `WS_CHURN_ALERT_THRESHOLD` (default 250) it opens a
  `ws_reconnect_storm` incident via the System Health Regression Watch
  (`storage.openHealthIncident`, entityType `system`, entityId `0`) and clears it
  when churn normalizes — so an Autoscale-style regression surfaces on the admin
  health view instead of silently flipping agents offline again.
