---
name: Test fixtures & login quirks (dev)
description: How to build reliable e2e test data and log in during dev testing for this repo
---

# Dev testing gotchas

## Seed purges test submissions on every dev startup
- On dev startup, `server/seed.ts` runs `cleanupTestSubmissions` → `purgeTestSubmissions`, which DELETEs every `submissions` row whose `rac_id` is in `TEST_SUBMISSION_RAC_IDS` (currently `testtech1`, `tmorri1`).
- **Consequence:** any precondition row you insert with one of those rac_ids vanishes the next time the app restarts (and the app does restart on its own / after edits), giving false-negative test results.
- **How to apply:** for DB fixtures that must survive a restart, use a `rac_id` NOT in that list (e.g. `fieldtech9`). The duplicate-prevention check keys on `technician_id`/service_order, not `rac_id`, so a non-test rac_id still exercises the logic. Clean these up manually — they are not auto-purged.

## All seeded passwords were reset to a single generic value
- `resetAllPasswords()` (one-time, flag `__pw_reset_v2_done__`) set EVERY non-`VRS_MASTER` user's password to `VRS2026!`.
- Test accounts (`TEST_RAC_IDS`: ZZTEST9, testagent1, TESTADMIN, testtech1, tmorri1, sysadmin) get `mustChangePassword=false`; all other accounts get `mustChangePassword=true` (forced change on login — avoid them for automated login).
- So for UI tests log in as `sysadmin` (admin) / `ZZTEST9` (generalist agent) with `VRS2026!`. The original seed passwords (admin123/agent123) do NOT work.
- ZZTEST9's stored password may drift from VRS2026! depending on seed order; if login 401s, set it deterministically via bcrypt + SQL UPDATE (it's a synthetic test account).

## Tech submission form is un-testable via UI (photo gate)
- `client/src/pages/tech-submit.tsx` requires at least one issue photo AND one estimate screenshot client-side before the submit button enables; the testing subagent cannot upload files.
- The server (`createSubmissionSchema`) makes `photos` optional, so submission/duplicate-prevention logic is best validated at the API level: mint a tech JWT via `POST /api/auth/tech-login {ldapId}` then `POST /api/submissions`.

## FK children block submission deletes
- Deleting `submissions` fails on FK from `sms_notifications` (and `communication_send_audit`). Delete those children first, then the submissions row.
