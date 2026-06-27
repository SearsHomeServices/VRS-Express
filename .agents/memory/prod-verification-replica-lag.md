---
name: Prod read-replica freezes after a big retention prune
description: Why post-deploy verification via the production read replica stalls right after boot, and which real-time signals to trust instead.
---

A large `agent_activity_log` retention prune (e.g. ~290k rows, the 60s-post-boot sweep) makes the production **read replica freeze** for ~25-30 min: `now()` advances but `max(created_at)` sticks at the prune instant and `now()-max` grows 1:1 with wall clock (zero forward progress). It then jumps current all at once when replay finishes. This blocks any churn/presence measurement that reads the replica immediately after a (re)deploy — exactly when you want to verify a fix.

**Why:** the replica replays the WAL serially; a single huge delete transaction stalls replay of everything after it. Normal lag is ~0 (near real-time), so the freeze is purely prune-triggered and transient.

**How to apply:** don't trust replica "zero rows since boot" right after a deploy — confirm `now()-max(created_at)` is small first. For immediate, replica-independent health use real-time signals: `getDeploymentInfo()` (primaryUrl/deploymentType/hasSuccessfulBuild), `curl https://<app>/api/healthz` (returns uptimeSec/dbMs — uptimeSec pins the actual boot time) and `/api/config`, plus deployment logs (perf-indexes count, retention "pruned N rows", error grep). Once the replica catches up it backfills the gap, so the churn/presence numbers become readable a few minutes later. A second redeploy soon after has almost nothing left to prune, so its boot won't re-freeze the replica.

**Bonus interpretation gotcha:** during ET dead hours (~6am ET = 10:00 UTC) a *working* WS build produces a genuinely empty log — pre-fix, idle background tabs still emitted ~3.9 ws_zombie/min even at 6am, so "zero ws events" post-fix is the success signal, not missing data. Each deploy still emits one expected reconnect spike (all sockets drop on VM restart); steady-state between deploys should be ~0.
