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

**Deeper unfixed cause (follow-up):** the WS reconnect storm itself — clients see
"no inbound for ~60s" repeatedly despite 25s server pings + 20s client app-pings,
i.e. server→client frames stall ~60s (likely proxy/LB idle behavior in the
deployment). This fix only stops the false offlines; it does not reduce churn.
