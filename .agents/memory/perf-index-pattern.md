---
name: Performance index pattern
description: How perf indexes are added/applied in this repo, and why list-view correlated subqueries need FK indexes.
---

# Adding a performance index

Indexes are created at **boot** by `ensurePerformanceIndexes()` in `server/seed.ts`
(an array of `{name, table, cols}` run as `CREATE INDEX CONCURRENTLY IF NOT EXISTS`,
with invalid-build recovery). A new index MUST be added in **two** places:

1. The seed.ts list (this is what actually creates it at runtime, incl. prod-on-deploy).
2. `shared/schema.ts` as an `index(...)` in the table's metadata callback — otherwise
   `drizzle-kit push` will try to **drop** the runtime-created index on schema sync.
   Name + columns must match exactly.

**Why:** production DDL is blocked — `executeSql({environment:"production"})` is
read-only, so you cannot `CREATE INDEX` on prod manually. The index reaches prod
only when a deploy boots and runs `ensurePerformanceIndexes()`. Dev applies it on
workflow restart (look for `[perf-indexes] Ensured N/N`).

# List-view correlated subqueries need FK indexes
`getSubmissionsListView` selects a per-row correlated subquery
(`MAX(intake_forms.agent_confirmed_at) WHERE submission_id = s.id`). With the FK
column unindexed, that's a full Seq Scan of the child table **per returned row**
(measured ~265k buffer hits / 355ms on a 709-row window) — the cause of the
occasional 1.2-2.2s agent queue-load spikes. Always index the child FK column any
time a list/queue query carries a per-row correlated subquery or lateral join.
Tiny dev tables won't show the regression (planner picks Seq Scan under ~hundreds
of rows); profile on prod-sized data.

# Fixing per-row name/lookup N+1s — batch, don't fan out
When a list/export/detail handler resolves names per row (e.g. `getUser(id)` for
tech/reviewer/assignee inside the row loop), fix it with ONE batched query feeding
an id->name map — for users that's `storage.getUsers()` built into a `Record`.
**Do NOT** "parallelize" by `Promise.all`-ing `getUser` over a large id set: the pg
pool max is 10 (see reserved-vm-hang-pool-exhaustion), so a few hundred concurrent
lookups just serialize on the pool and risk exhaustion. `Promise.all` is only for a
*bounded handful* of independent reads (e.g. a ticket's ≤few reviewers + tech, or
two count queries). Trick to avoid touching call sites: keep the helper `async`
(returns `Promise<string>`) but resolve from the prebuilt map — existing
`await getUserName(...)` sites stay unchanged. The two admin exports
(export-csv/export-xlsx) and the ticket-history route were already converted this way.
