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

## Tech submission form: full submit is gated, but file-selection handlers ARE UI-testable
- `client/src/pages/tech-submit.tsx` requires ≥1 issue photo AND ≥1 estimate screenshot before the submit button enables. For end-to-end *submission/duplicate-prevention* logic, still prefer the API: mint a tech JWT via `POST /api/auth/tech-login {ldapId}` then `POST /api/submissions` (server `createSubmissionSchema` makes `photos` optional).
- CORRECTION to the old "subagent cannot upload files" claim: the Playwright testing subagent CAN attach an in-memory file via `setInputFiles` with `{ name, mimeType, buffer }` (no filesystem needed) — target the hidden `<input type=file>` directly by its `data-testid`. It can ALSO use `page.route` to force failures. So upload-failure UX (the toasts that fire from `handlePhotosSelect`/`handleVideoSelect`/feedback `handleFileUpload`) IS e2e-testable.
- To force an upload failure deterministically: `page.route('**/api/uploads/request-url**')` → fulfill HTTP 500. That makes the upload-URL fetch fail; the client returns null after its retries and fires the failure toast.

## Catching transient toasts in tests (this app)
- Toasts are shadcn/Radix: **TOAST_LIMIT=1** (a newer toast replaces the visible one) and **no custom duration** so they auto-dismiss ~5s. Never "wait N seconds then check once" — poll with `page.waitForFunction(() => document.body.innerText.includes("..."), { timeout, polling: 250 })`; portaled toast text shows up in `document.body.innerText`.
- The **photo** path runs `imageCompression` in a **web worker** before upload; its timing is highly variable in the headless browser (seen sub-9s on a warm worker, >15s cold), so the failure toast can land far outside a short window. Use a long poll (~45s) AND isolate one toast per check (don't select a second file, or its toast replaces the one you're verifying). The **video** and **feedback** paths have no compression and fire deterministically (~immediately to a few seconds).

## FK children block submission deletes
- Deleting `submissions` fails on FK from `sms_notifications` (and `communication_send_audit`). Delete those children first, then the submissions row.
