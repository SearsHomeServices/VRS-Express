---
name: Seed column-migration ordering
description: A newly-added Drizzle column must be ensured before the first query on that table, or boot crashes — Drizzle selects all mapped columns.
---

# Seed column-migration ordering

**Rule:** when adding a mapped Drizzle column, apply the development schema
change before restarting the application. Managed production schema changes
must go through Publish, not startup DDL or a custom production migration.

**Why:** Drizzle selects every mapped column on every query. A brand-new column
that does not yet exist in the DB makes the very first read throw and crash boot.
The historical background ensure-block runs too late for genuinely new
columns. Adding more startup migrations is not the supported solution.

**How to apply:** update the schema source, apply and verify the DEV schema,
then restart. Review the schema diff when publishing. Do not extend existing
startup DDL patterns to new columns.
