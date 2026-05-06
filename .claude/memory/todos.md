# Tasks

## In Progress
- [ ] **Tyler action required**: run `npm run db:push` against the production-bound `DATABASE_URL` to apply `intake_forms` + `agent_external_credentials` tables before deploying the calculator + intake form release. Until then, the new claim-gate will surface "Failed to claim" for vrs_agent role users (admins bypass and continue to work). **NOTE**: the Stage 3 reordering follow-up (2026-04-26) needs NO additional db:push — it reuses existing columns only.
- [ ] **Tyler action required**: review `COMMITS.md` and run the suggested commits 1–12 in sequence on the feature branch (commits 9–12 are the Stage 3 reordering).
- [ ] **Follow-up — incomplete branches in field map**: `docs/intake_form_field_map.md` has the SPHW / SHW / SRW / ISP branches flagged INCOMPLETE pending another verbatim walk. The fieldset will render only the fields we DO know for those branches; missing required fields will be added in a follow-up PR.
- [ ] **Follow-up — Smartsheet success-page detection**: the new modal attestation checkbox is honor-system because Smartsheet's hosted form is cross-origin. If Todd Pennington enables Smartsheet's redirect-URL feature (already on the Phase 2 deferred list), we can replace the checkbox with a real success signal.

## Blocked
- Phase 2 calculator auto-login — pending decision between (a) get calc owner to add `?token=` param, (b) build VRS-distributed Chrome extension, (c) fork the Replit. Needs an external conversation first.
- Phase 2 Smartsheet redirect-URL completion — needs Todd Pennington to flip a setting in form properties.
- Phase 3 direct Smartsheet API row-write — original proposal path; needs API token from Todd Pennington.

## Done
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
