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
