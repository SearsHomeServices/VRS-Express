## Open — technician AHS → VRS AI enrollment (2026-10-08)

- [x] Enroll new queued AHS authorization tickets from the app or external API
      in the VRS AI bridge, behind `VRS_AI_APP_ENROLL_ENABLED` (default off).
- [x] Replace the placeholder payload with real fields entered by the tech
      (2026-10-16, `shared/ahs-details.ts`).
- [ ] Before enabling: confirm VRS AI is fine with quantity carried in
      `part_description` (price multiplied out), failure reasons in `comments`,
      `tech_recommendation` always `repair` and `purchase_year` `N/A`.
- [ ] Confirm the division mapping with VRS ops: Trash Compactor → Dishwasher,
      Free Standing Ice Maker → Refrigeration, Garbage Disposal → All Other.
- [ ] Before enabling: confirm VRS AI does not also post app-origin results
      straight to SASHA (its pinned `VRS_SASHA_CALLBACK_URL`). SASHA has no
      record of these calls.
- [ ] Enable in DEV (`VRS_AI_APP_ENROLL_ENABLED=true` in `[userenv.development]`),
      submit a test AHS ticket, check the `[vrs-app-enroll]` log and the Pilot
      view, then approve Stage 1 and confirm the VRS AI 202.
- [ ] Optional: prefill customer/model/serial/contract from Snowflake
      `IH_SERVICEORDER_FULLDETAIL_TBL` so techs type less. Column names have
      not been verified yet.
- [ ] 1099 providers and the external v1 API have no AHS details, so their AHS
      tickets are not enrolled.

## Open — weekly executive summary (2026-09-11)

- [ ] BLOCKING BEFORE FIRST SEND: confirm `notifications@shs.com` is a verified
      Sender Identity (or that shs.com is an authenticated domain) on the
      SendGrid account behind `SENDGRID_API_KEY`. If it is not, SendGrid returns
      403 and nothing is delivered. `POST /api/admin/reports/exec-summary/run`
      with `{"dryRun": false}` surfaces the exact cause.
- [ ] Align the email's content with what Meghna Saraf actually asked for. The
      current section set (governing thought, 3 KPIs, MECE stage table, top
      rejection reasons, top districts, turnaround) was chosen from what VRS
      Express measures, NOT from her request — her message could not be located
      in Teams via search or the Graph connector on 2026-09-11.
- [ ] No admin UI yet for the exec summary. List / preview / run / recipients
      are API-only. Add a card to the admin dashboard next to the existing
      weekly-report controls.
- [ ] `msUntilNextWednesday4pmET` duplicates the DST-safe scheduler math in
      `weekly-tech-report.ts` (`msUntilNextWednesday5pmET`). Deliberately not
      refactored — the 5 PM report is live and unrelated to this change. Extract
      a shared `msUntilNextWeeklyEt(dow, hour)` when one of them next changes.
- [x] Agent notes after an AI close — implemented 2026-09-11 (server RBAC +
      `submission-notes-thread.tsx` on the agent dashboard).

# Tasks

## In Progress
- [ ] **DB-level verification of the call-result close route** (2026-09-08) — `POST /api/integrations/vrs-ai/v1/call-result` is unit-tested (21/21) and typechecks/bundles, but the DB-backed `loadTicketCandidates` / `closeTicket` wiring has never executed against a real database. Next step: on DEV, set the day's RGC code, take a ticket to `pending` with an assigned agent for an 8-digit SO, then POST the payload with the `VRS_SASHA_API_KEY` header and confirm the ticket goes `completed` with `auth_code` set and one technician SMS.
- [ ] **Decide whether the call-result route should also accept non-approved states** (2026-09-08) — it currently accepts `state: "approved"` only and 400s on `denied` / `partial` / `failed` / `requires_info`, since "close the ticket" has no obvious meaning for those. If VRS AI will post them here, decide per-state behavior rather than letting them fall into the approve path.
- [ ] **Tyler action required**: run `npm run db:push` against the production-bound `DATABASE_URL` to apply `intake_forms` + `agent_external_credentials` tables before deploying the calculator + intake form release. Until then, the new claim-gate will surface "Failed to claim" for vrs_agent role users (admins bypass and continue to work). **NOTE**: the Stage 3 reordering follow-up (2026-04-26) needs NO additional db:push — it reuses existing columns only.
- [ ] **Tyler action required**: review `COMMITS.md` and run the suggested commits 1–12 in sequence on the feature branch (commits 9–12 are the Stage 3 reordering).
- [ ] **Follow-up — incomplete branches in field map**: `docs/intake_form_field_map.md` has the SPHW / SHW / SRW / ISP branches flagged INCOMPLETE pending another verbatim walk. The fieldset will render only the fields we DO know for those branches; missing required fields will be added in a follow-up PR.
- [ ] **Follow-up — Smartsheet success-page detection**: the new modal attestation checkbox is honor-system because Smartsheet's hosted form is cross-origin. If Todd Pennington enables Smartsheet's redirect-URL feature (already on the Phase 2 deferred list), we can replace the checkbox with a real success signal.

## Blocked
- Phase 2 calculator auto-login — pending decision between (a) get calc owner to add `?token=` param, (b) build VRS-distributed Chrome extension, (c) fork the Replit. Needs an external conversation first.
- Phase 2 Smartsheet redirect-URL completion — needs Todd Pennington to flip a setting in form properties.
- Phase 3 direct Smartsheet API row-write — original proposal path; needs API token from Todd Pennington.

## Done
- [x] **VRS AI call-result ticket close route** (2026-09-08) — new `POST /api/integrations/vrs-ai/v1/call-result` accepts the approval payload with `partId` / `partDescription` / `techId` and closes the corresponding ticket via the existing approve path. New `server/vrs-ai-call-result.ts` + `tests/vrs-ai-call-result.test.ts` (21 tests), one new bounded storage query, wiring in `routes.ts`. Signed `/webhook` partner route untouched. ADR-016.
- [x] **Added `scripts/seed-test-ticket-from-prod.mjs`** (2026-05-20) — One-shot seeder that copies a real prod SO into dev as a queued ticket so SHSAI returns real customer history during testing.
- [x] **SHSAI Service Order History restored on new Sears-hosted host** (2026-05-20) — Telluride UAT 403 hide from 2026-05-09 (`307f514`) reverted now that prod SHSAI is live. Base URL swapped to `shsai-routing-assist.prod.nextgen.shs.com`; tab + auto-fetch + refresh button + banner all restored in `agent-dashboard.tsx`. End-to-end probe verified the new host accepts the same request shape and streams SSE responses identically. ADR-015 captures the migration rationale.
- [x] **Round 4 — completed-SO submission block + prior media comparison** (2026-05-06) — fixed `hasActiveSubmissionForServiceOrder` so completed (approved) tickets no longer block fresh submissions on the same SO#; added "Media on Previous Submission" card to agent dashboard so agents can compare prior photos/video/voice against the resubmission.
- [x] **Round 3 — prior submission's issue description on resubmissions** (2026-05-06) — Tyler clarified Hamed's complaint was specifically about the original issue description not being visible when reviewing a resubmission. Extended priorRejection memo + added "Description on Previous Submission" panel inline under the current description.
- [x] **Round 2 audit catches** (2026-05-06) — tech-resubmit page now shows categorical reasons + technicianMessage (not just stage1RejectionReason); admin export "Today" preset ET-anchored; CSV/XLSX export filename uses ET date.
- [x] **Hamed pilot feedback fixes** (2026-05-06) — RGC daily-code lookup now keys on ET (`getEtDateString` in `shared/business-hours.ts`) instead of UTC, so agents working past 8 PM EDT no longer hit "No RGC code has been set for today." Six call sites swapped (5 in `server/routes.ts`, 1 in `client/src/pages/admin-dashboard.tsx`). Agent's Stage 1 + NLA review cards now show an inline "Previous Rejection" panel (rejection reasons + Message-Sent-to-Technician + reviewer + timestamp) for resubmissions, sourced from existing `/api/submissions/:id/history` data via a new `priorRejection` `useMemo`. No schema, no API, no db:push needed. ADR-013 + ADR-014 capture rationale.
- [x] **Executed Calculator + Intake Form plan** (2026-04-26) — all 7 tasks (T0–T6) plus T7 docs. D1=a, D2=a, D3=b, D4=GO. See `CHANGELOG.md [Unreleased] → Added — Calculator + Smartsheet Intake Form (2026-04-26)` and `COMMITS.md` for the per-task commit messages and file lists.
- [x] Drafted Calculator + Intake Form plan (2026-04-25). Verified Smartsheet pre-fill + iframe behavior live via Playwright. Plan covers Phase 1 (this PR), Phase 2 (deferred auto-login + redirect URL), Phase 3 (proposal's API path).
- [x] Task 2 — pilot-feedback-fixes (implemented 2026-04-23)
- [x] Task 3 — pilot-feedback-fixes (implemented 2026-04-23)
- [x] Task 4 — pilot-feedback-fixes (implemented 2026-04-23)
- [x] Pre-submit review dialog (Kenneth Hokanson field feedback) — implemented 2026-04-23
- [x] Task 1 (per-file upload failure UI + retry) — implemented in `client/src/pages/tech-submit.tsx` (2026-04-23)
- [x] Show rejection reason on tech history list cards — previously only a red badge, no reason text; tech had to drill into each ticket to see why it was rejected (2026-04-16)
- [x] Fix resubmit form silent failure for AHS / First American rejected tickets — schema only allowed `sears_protect`, so Zod silently blocked submit on the day AHS was enabled (2026-04-16)
- [x] Fix iPhone photo upload HEIC MIME type filtering (2026-04-16)
- [x] Add client-side upload diagnostics logging (2026-04-16)
- [x] Fix real-time notifications for agents in "working" status (2026-04-16)
- [x] Fix real-time notifications for admins/super_admins (2026-04-16)
- [x] Add notification subscriptions to admin dashboard (2026-04-16)
- [x] Enable AHS and First American warranty submissions (2026-04-16)
- [x] Split NLA parts entry into NLA and Available Parts sections (2026-04-16)
