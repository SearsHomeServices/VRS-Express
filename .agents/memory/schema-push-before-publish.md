---
name: Schema push before publish
description: New Drizzle tables must exist in the DEV database before publishing, or prod never gets them
---
Publish migrates prod by diffing DEV DB vs PROD DB — not code vs prod. If a new table/column exists only in `shared/schema.ts` but `npm run db:push` was never run in dev, the diff is empty and the published code crashes with `relation ... does not exist` in production (and dev).

**Why:** 2026-07-29 the `vrs_ai_calls` feature shipped to prod with the table missing in BOTH dev and prod; every agent Approve failed with "Failed to process ticket" until db:push in dev + republish.

**How to apply:** after any schema.ts change (especially from merged task-agent work), verify with `to_regclass('public.<table>')` in dev before declaring done or suggesting publish. Fix = `npm run db:push -- --force` in dev, then republish (never DDL against prod).
