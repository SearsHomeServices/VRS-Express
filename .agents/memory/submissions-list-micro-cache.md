---
name: Submissions list micro-cache contract
description: Invalidation contract and keying pitfalls for the 2s staff list cache on GET /api/submissions
---

**Rule:** Any new code path that writes `submissions` or `intake_forms` (the list view's `intakeFormCompletedAt` subquery reads intake_forms) must call `bumpSubmissionsDataVersion()` from `server/storage.ts` — otherwise the staff list cache can serve up to 2s of stale data silently. Grep for `.insert(submissions|intakeForms)` / `.update(submissions)` / `.delete(submissions)` when auditing.

**Why:** Cache freshness is TTL + an in-process version stamp, not DB-driven. A missed bump degrades quietly (bounded staleness), so it won't show up in tests.

**How to apply:**
- Prefer routing writes through existing storage methods (all bump already) instead of raw `db.update(submissions)` in routes.
- Cache is staff-branch only; the tech/provider branch redacts warranty data and must NEVER be cached (shared cache there would leak unredacted rows).
- Keying pitfall: the admin default `createdAfter` window is `Date.now()`-derived — the cache key must be computed BEFORE that injection or every request gets a unique key and the cache silently never hits. Same trap for any future time-derived default filter.
- Stamp is in-process; single Reserved-VM only. Horizontal scaling requires moving it to a shared store (see scalability-watch).
