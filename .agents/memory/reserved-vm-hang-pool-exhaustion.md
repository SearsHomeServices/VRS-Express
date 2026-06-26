---
name: Reserved-VM hang from DB pool exhaustion (502 that won't self-heal)
description: Why an unbounded pg pool wait under load turns a Reserved VM into a permanent 502, and the pool-config hardening that prevents it.
---

# A hung (not exited) Reserved-VM process serves 502 forever

**Symptom:** production live URL returns **502 on every route** (fast ~0.13s, not a
slow timeout), the deployment logs simply **stop** (no crash/OOM/SIGTERM trace —
last line is normal traffic), and it never recovers on its own. Preceded by a
window of escalating latency (5–18s responses) and intermittent 500s with
connection-level `Failed query` errors across *many unrelated* queries
(technicians, submissions, agent stats, media-token) — that "many different
queries fail at once" pattern is the signature of **DB connection-pool
exhaustion**, not a single bad query or missing index.

**Why it becomes a permanent outage:** a Reserved VM (`deploymentType: "vm"`)
supervisor only restarts the process on **exit**. A process that is *hung but
alive* (event loop saturated, not listening) is never auto-restarted, so it
serves 502 until a **manual redeploy**. (A boot window is different: it returns
**500** for ~40s, then `serving on port 5000`. Sustained **502** = down/hung.)

**Root cause here:** `new Pool({ connectionString, keepAlive: true })` in
`server/storage.ts` set **no `max`**, so pg defaulted to **10** connections. Under
~40 concurrent agents polling `/api/submissions` + `/api/agent/stats` +
`/api/admin/users` every few seconds (plus slow Snowflake-backed submission
posts), 10 connections saturate; with **no `connectionTimeoutMillis`**, requests
queue for a connection **indefinitely**, pending promises pile up, the event loop
backs up, and the process hangs.

**Fix (the durable rule):** any always-on Node server (VM) MUST configure the pool
so saturation **fails fast** instead of hanging the whole process:
- `max` sized for real concurrency (raised 10→20; keep below the managed-DB
  connection ceiling — there's a single pool in this app, verified via `rg "new Pool"`).
- `connectionTimeoutMillis` (10s) — the key anti-hang lever: a request that can't
  get a connection rejects instead of waiting forever.
- `statement_timeout` (30s) — server-side cancel so a runaway query releases its
  connection.
- `idleTimeoutMillis` (30s).
**Why:** converts a whole-process hang (total 502 outage, manual redeploy needed)
into graceful per-request 500s (partial degradation, self-correcting as load eases).

**Downstream symptoms that are really this one bug:** "tickets disappear while
working" = `/api/submissions` 500 → React Query renders an empty list; "agents
show offline/online wrong" = `/api/agent/stats` & `/api/agent/status` 500 → status
can't update. Both clear once the DB layer is stable; don't chase them as separate
bugs during a saturation outage.

**Aggravating load to reduce as follow-up (not required to restore service):**
`agent_activity_log` was **234 MB / ~572k rows** with no retention and is written
on every WS connect/disconnect + read by presence logic (hot path under WS churn);
and `fetchProcIdForServiceOrder` (Snowflake) is awaited synchronously in
`POST /api/submissions` (~18s observed). Add log retention/archival and make the
Snowflake call bounded/non-blocking to cut baseline DB+latency pressure.

**Recovery runbook:** restore service first with a **redeploy/republish** (only the
user can restart prod — agent `restart_workflow` only restarts the dev workflow).
Shipping a code fix via republish both restarts the hung process AND deploys the
fix in one action.
