---
name: Test fixtures & login quirks (dev)
description: How to build reliable e2e test data and log in during dev testing for this repo
---

# Dev testing gotchas

## Seed purges test submissions on every dev startup
- On dev startup, `server/seed.ts` runs `cleanupTestSubmissions` → `purgeTestSubmissions`, which DELETEs every `submissions` row whose `rac_id` is in `TEST_SUBMISSION_RAC_IDS` (currently `testtech1`, `tmorri1`).
- **Consequence:** any precondition row you insert with one of those rac_ids vanishes the next time the app restarts (and the app does restart on its own / after edits), giving false-negative test results.
- **The `runTest` harness itself restarts the app**, so a fixture seeded with a test rac_id is already gone by the time the browser logs in — symptom is an empty list / "0 results" for data you just confirmed via API. Seen as a confusing e2e failure where API shows the row but the UI never surfaces it.
- **How to apply:** for DB fixtures that must survive a restart, give them a `rac_id` NOT in that list. Simplest: tech-login as `VRSTEST` (seeded tech, NOT in the purge list) and create the submission via API — it survives restarts with no SQL touch-up. Alternative: seed as `testtech1` then `UPDATE submissions SET rac_id='fieldtech9' WHERE id IN (...)`. The duplicate-prevention check keys on `technician_id`/service_order, not `rac_id`, so a non-test rac_id still exercises the logic. Clean these up manually — they are not auto-purged.
- Note: tech-login rejects ldapIds failing `/^[a-z][a-z0-9]*$/` after lowercasing — underscores fail, so `test_tech_1` can't log in; uppercase like `VRSTEST` is fine (normalized to lowercase).

## All seeded passwords were reset to a single generic value
- `resetAllPasswords()` (one-time, flag `__pw_reset_v2_done__`) set EVERY non-`VRS_MASTER` user's password to `VRS2026!`.
- Test accounts (`TEST_RAC_IDS`: ZZTEST9, testagent1, TESTADMIN, testtech1, tmorri1, sysadmin) get `mustChangePassword=false`; all other accounts get `mustChangePassword=true` (forced change on login — avoid them for automated login).
- So for UI tests log in as `sysadmin` (admin) / `ZZTEST9` (generalist agent) with `VRS2026!`. The original seed passwords (admin123/agent123) do NOT work.
- **Test technicians use passwordless tech-login** (`POST /api/auth/tech-login {ldapId}`), which looks up the `technicians` table — a `users` row alone is NOT enough. Seeded test techs: `testtech1`, `tmorri1`, `VRSTEST` (in `seed.ts` `testTechEntries` + protected from Snowflake-sync deactivation in `deactivateTechniciansNotIn`). A test tech created only as a `users` row (role=technician) will 404 on tech-login until a `technicians` row exists.
- **CAVEAT — the reset is one-time/flag-gated, so accounts created AFTER it ran keep their own seed password, NOT `VRS2026!`.** Don't assume `VRS2026!` works for every test account — if it 401s, set it deterministically via bcrypt + SQL UPDATE (`node -e` with bcryptjs hashSync, then `UPDATE users SET password=..., must_change_password=false WHERE rac_id=...`). Done for `TESTADMIN` on 2026-07-08, so it now uses `VRS2026!` in dev; `ZZTEST9` also uses `VRS2026!`.

## Tech submission form: full submit is gated, but file-selection handlers ARE UI-testable
- `client/src/pages/tech-submit.tsx` requires ≥1 issue photo AND ≥1 estimate screenshot before the submit button enables. For end-to-end *submission/duplicate-prevention* logic, still prefer the API: mint a tech JWT via `POST /api/auth/tech-login {ldapId}` then `POST /api/submissions` (server `createSubmissionSchema` makes `photos` optional).
- CORRECTION to the old "subagent cannot upload files" claim: the Playwright testing subagent CAN attach an in-memory file via `setInputFiles` with `{ name, mimeType, buffer }` (no filesystem needed) — target the hidden `<input type=file>` directly by its `data-testid`. It can ALSO use `page.route` to force failures. So upload-failure UX (the toasts that fire from `handlePhotosSelect`/`handleVideoSelect`/feedback `handleFileUpload`) IS e2e-testable.
- To force an upload failure deterministically: `page.route('**/api/uploads/request-url**')` → fulfill HTTP 500. That makes the upload-URL fetch fail; the client returns null after its retries and fires the failure toast.

## Catching transient toasts in tests (this app)
- Toasts are shadcn/Radix: **TOAST_LIMIT=1** (a newer toast replaces the visible one) and **no custom duration** so they auto-dismiss ~5s. Never "wait N seconds then check once" — poll with `page.waitForFunction(() => document.body.innerText.includes("..."), { timeout, polling: 250 })`; portaled toast text shows up in `document.body.innerText`.
- The **photo** path runs `imageCompression` in a **web worker** before upload; its timing is highly variable in the headless browser (seen sub-9s on a warm worker, >15s cold), so the failure toast can land far outside a short window. Use a long poll (~45s) AND isolate one toast per check (don't select a second file, or its toast replaces the one you're verifying). The **video** and **feedback** paths have no compression and fire deterministically (~immediately to a few seconds).

## UI-test traps in the agent/admin dashboards (learned 2026-07-09)
- **Clicking a Queue ticket CLAIMS it** — the agent dashboard has no read-only "view" from Queue; opening a queued ticket fires `PATCH /api/submissions/:id/claim` (state change + tech SMS attempt). For read-only e2e inspection, only open tickets from the Completed tab, and say so explicitly in the test plan. Undo an accidental claim with `UPDATE submissions SET ticket_status='queued', assigned_to=NULL, claimed_at=NULL`.
- **Forced password-change screen silently changes passwords during e2e** — accounts with `must_change_password=true` (e.g. `jmorga7`, `MTHOMA2`) get a blocking change-password form on login; the Playwright subagent will complete it with an arbitrary password, breaking the account for later runs (401s that look like a regression; no activity-log trace). Before UI login tests: `UPDATE users SET first_login=false, must_change_password=false WHERE rac_id=...`. Restore a known password via bcryptjs hashSync + SQL UPDATE.
- **Agent "Completed Today" tab is scoped to `reviewedBy = self`** (server-derived, not client-passed) — empty list for an agent who never reviewed anything is CORRECT, not a bug. To test it, point a completed submission's `reviewed_by` at the agent temporarily and restore after. Default window is 30d; the tab has a 30d/60d/90d/All filter.

## FK children block submission deletes
- Deleting `submissions` fails on FK from `sms_notifications` (and `communication_send_audit`). Delete those children first, then the submissions row.
