---
name: Test fixtures & login quirks (dev)
description: How to build reliable e2e test data and log in during dev testing for this repo
---

# Dev testing gotchas

## Seed purges test submissions on every dev startup
- On dev startup, `server/seed.ts` runs `cleanupTestSubmissions` → `purgeTestSubmissions`, which DELETEs every `submissions` row whose `rac_id` is in `TEST_SUBMISSION_RAC_IDS` (currently `testtech1`, `tmorri1`).
- **Consequence:** any precondition row you insert with one of those rac_ids vanishes the next time the app restarts (and the app does restart on its own / after edits), giving false-negative test results.
- **The `runTest` harness itself restarts the app**, so a fixture seeded with a test rac_id is already gone by the time the browser logs in — symptom is an empty list / "0 results" for data you just confirmed via API. Seen as a confusing e2e failure where API shows the row but the UI never surfaces it.
- **How to apply:** for DB fixtures that must survive a restart, give them a `rac_id` NOT in that list. Easiest robust path: seed normally via API (tech-login as `testtech1` → POST/claim/process), then `UPDATE submissions SET rac_id='fieldtech9' WHERE id IN (...)` so the startup purge can't touch them. The duplicate-prevention check keys on `technician_id`/service_order, not `rac_id`, so a non-test rac_id still exercises the logic. Clean these up manually — they are not auto-purged.

## All seeded passwords were reset to a single generic value
- `resetAllPasswords()` (one-time, flag `__pw_reset_v2_done__`) set EVERY non-`VRS_MASTER` user's password to `VRS2026!`.
- Test accounts (`TEST_RAC_IDS`: ZZTEST9, testagent1, TESTADMIN, testtech1, tmorri1, sysadmin) get `mustChangePassword=false`; all other accounts get `mustChangePassword=true` (forced change on login — avoid them for automated login).
- So for UI tests log in as `sysadmin` (admin) / `ZZTEST9` (generalist agent) with `VRS2026!`. The original seed passwords (admin123/agent123) do NOT work.
- **CAVEAT — the reset is one-time/flag-gated, so accounts created AFTER it ran keep their own seed password, NOT `VRS2026!`.** Confirmed: `TESTADMIN` logs in with `TestAdmin2026!` (its seed value), not `VRS2026!`; `ZZTEST9` does use `VRS2026!`. Don't assume `VRS2026!` works for every test account — if it 401s, try the account's seed password from `SEED_USERS`, or set it deterministically via bcrypt + SQL UPDATE.

## Tech submission form is un-testable via UI (photo gate)
- `client/src/pages/tech-submit.tsx` requires at least one issue photo AND one estimate screenshot client-side before the submit button enables; the testing subagent cannot upload files.
- The server (`createSubmissionSchema`) makes `photos` optional, so submission/duplicate-prevention logic is best validated at the API level: mint a tech JWT via `POST /api/auth/tech-login {ldapId}` then `POST /api/submissions`.

## FK children block submission deletes
- Deleting `submissions` fails on FK from `sms_notifications` (and `communication_send_audit`). Delete those children first, then the submissions row.
