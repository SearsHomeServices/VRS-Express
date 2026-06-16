---
name: Seed column-migration ordering
description: A newly-added Drizzle column must be ensured before the first query on that table, or boot crashes — Drizzle selects all mapped columns.
---

# Seed column-migration ordering

**Rule:** when you add a column to a Drizzle table in `shared/schema.ts`, its
idempotent `ADD COLUMN IF NOT EXISTS` migration must run **awaited, before the
first query on that table** (e.g. at the top of `seedDatabase()`), not in the
fire-and-forget `void (async () => { ...ensure* })()` block.

**Why:** Drizzle selects every mapped column on every query. A brand-new column
that does not yet exist in the DB makes the very first read throw and crash boot.
The background ensure-block works only for columns that already exist in deployed
DBs (their reads don't fail); it runs too late for a genuinely new column.

**How to apply:** new column → ensure it awaited before any read of that table.
Pre-existing columns can stay in the background block.
