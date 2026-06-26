---
name: WS reconnect churn root cause
description: Why ~9k/day "zombie" WS reconnects persisted after the Autoscale→Reserved-VM move; it's a client-side false positive, not platform idle-kill.
---

## Root cause
Browsers throttle `setInterval` to ~once/60s in a BACKGROUND tab. The client keepalive
(client/src/lib/websocket.ts) runs every 20s and declares the socket a "zombie" if no
inbound data for > ZOMBIE_INBOUND_TIMEOUT_MS (was 45s). A desktop agent who leaves the
dashboard in a background tab gets the keepalive firing late (~60s), which sees ~59s of
EXPECTED silence (no client ping sent → no server pong back) and tears down a perfectly
HEALTHY socket + reconnects — once per minute per backgrounded tab × ~54 agents ≈ 9k/day.

**Evidence (prod telemetry, 7d):** 99% of `ws_zombie_detected` had idleMs 46-70s with a
razor spike at "no inbound for 59-60s"; 99.96% DESKTOP (not mobile); reconnect downtime
<3s in 99.3% (nothing was actually wrong); spread across all 54 agents (systemic).

**Why the VM switch didn't help:** the churn is client-side and platform-independent. The
original 2026-06 diagnosis blamed Autoscale idle-killing idle WS every ~60s; the Reserved
VM removed that path but the dominant driver (bg-tab timer throttle vs a too-tight 45s
threshold) remained. Browser protocol-level ping/pong frames (server's 25s `ws.ping()`) do
NOT surface to JS `onmessage`, so they can't refresh the client's inbound clock — only an
app-level data message can.

## Why it matters
Harmless to presence now (presence gates on lastSeen) but each false reconnect = WS
handshake + getUser + getSpecializations + broadcast + 2 telemetry POSTs → real DB/CPU
load + ~18k junk rows/day in agent_activity_log.

## How to fix (durable principles)
- An inactivity/zombie check is only valid if its timer actually fired on schedule. Skip it
  while `document.hidden`; on a tick that fired much later than its interval, treat it as a
  PROBE (send ping, reset grace), not a verdict.
- Threshold must exceed the worst-case background throttle: ≥~80s (≥3× the 25s server ping),
  with 2 consecutive failed probes before reconnecting.
- On visibilitychange→visible / online, reset lastInboundAt and PROBE (ping + short timeout)
  before reconnecting — never reconnect just because the hidden stretch left the clock stale.
- Server defense-in-depth: push an APP-LEVEL heartbeat (`{type:"hb"}`) ~every 20-25s so the
  client's inbound clock refreshes from the server regardless of its throttled timer (WS
  onmessage is not throttled like setInterval; protocol pings can't do this).
- Validate by watching ws_zombie_detected/day collapse and the 59-60s idleMs spike vanish;
  genuine dead-socket detection (original corporate-proxy case) is preserved by
  sustained-silence + failed-probe detection.
