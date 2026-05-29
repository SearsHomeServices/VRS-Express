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

2. **Roster / Snowflake-sync deactivation** (data-layer). The roster
   (`technicians` table) is synced from Snowflake `COMTTU_TECH_UN`, filtered to
   `TECH_STS_CD='A' AND ACTIVE_IND='Y'`. A tech back from leave can have
   `TECH_STS_CD='A'` but **`ACTIVE_IND='N'`** at the source — they get filtered
   out and `deactivateTechniciansNotIn()` flips their local `is_active=false`
   on the next sync, yielding "Account is inactive".
   **Normalization does NOT fix this.** The permanent fix is HR flipping
   `ACTIVE_IND` to 'Y' in Snowflake. A manual local `is_active=true` is only a
   patch that the next sync will undo.

**How to apply:** confirm the tech's row in `technicians` (active?) AND their
raw Snowflake `ACTIVE_IND` before deciding which layer to fix. Clayton Robbins
(crobbi2) hit both: stray-char miss at login, and `ACTIVE_IND='N'` at source.
