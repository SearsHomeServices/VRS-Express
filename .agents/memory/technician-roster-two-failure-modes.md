---
name: Technician login failures have two distinct root causes
description: "Not a Technician" can be a stray-char lookup miss OR a roster/Snowflake-sync deactivation — they need different fixes.
---

When a field tech sees "Not a Technician / enter admin password", there are two
unrelated causes — diagnose which before "fixing":

1. **Stray-character lookup miss** (login-layer). Mobile keyboards inject
   zero-width chars, NBSP, internal/trailing whitespace, trailing punctuation,
   or odd casing. `shared/ldap.ts normalizeLdapId()` is the single source of
   truth that cleans input on both client and server; lookup is
   case-insensitive (`lower(ldap_id)`). The format regex must run AFTER
   normalization, not inside the zod schema. The tech IS in the roster and
   active in this case.

2. **Roster / Snowflake-sync membership** (data-layer). The roster
   (`technicians` table) is synced from Snowflake `COMTTU_TECH_UN` (admin-only
   `POST /api/admin/sync-technicians` — NOT run on startup/schedule), filtered to
   `TECH_STS_CD='A' AND ACTIVE_IND='Y' AND MBL_PH_NO` present. The sync upserts
   every qualifying tech as `is_active=true` and `deactivateTechniciansNotIn()`
   deactivates any roster tech with ZERO qualifying rows.

   **CRITICAL: `COMTTU_TECH_UN` has MANY rows per LDAP_ID** (one per assignment /
   TECH_UN_NO — e.g. crobbi2 had 28 rows: 1 `A/Y`, the rest `A/N` or `T/N`).
   Looking at a single row's `ACTIVE_IND` is MISLEADING. A tech qualifies if
   **ANY** row is `A/Y` + phone. Always aggregate:
   `... WHERE UPPER(LDAP_ID)='X' AND TECH_STS_CD='A' AND ACTIVE_IND='Y' AND MBL_PH_NO IS NOT NULL`.
   Both crobbi2 (Clayton) and jsausal (Junny Sausal) each have exactly 1
   qualifying row, so both are legitimately active — a sync ADDS them and does
   NOT deactivate them. (Earlier worry that a sync would deactivate Clayton was
   wrong; it was based on reading one non-qualifying row.)

   A tech legitimately active at source but missing from the roster just means
   the sync is stale — running Sync Technicians imports them. Normalization does
   NOT fix a roster-membership miss.

**How to apply:** confirm the tech's row in `technicians` (present? active?) AND
aggregate their Snowflake rows for ANY qualifying `A/Y`+phone row before deciding
which layer to fix.
