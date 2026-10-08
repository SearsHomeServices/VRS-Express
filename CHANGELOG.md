# Changelog

All notable changes to the VRS Digital Authorization Platform will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added - Technician AHS tickets enroll in the VRS AI bridge (2026-10-08)
- New flag `VRS_AI_APP_ENROLL_ENABLED` (default off). When it is `"true"`, every
  new queued AHS authorization ticket from the technician app or the external
  v1 API gets a `vrs_ai_calls` row at creation, the same row a SASHA call gets.
  The ticket moves to the VRS AI Pilot view, and Stage 1 approval sends it to
  VRS AI. Enrollment never blocks ticket creation; failures are logged under
  `[vrs-app-enroll]`.
- App-origin rows carry a V9 payload built from the ticket. Fields the app does
  not capture use contract placeholders and `0` amounts, and a comment tells
  VRS AI to use the photos or look up the order. Technician photos are signed
  at dispatch.
- App-origin rows have no SASHA callback. Dispatch revalidates without the
  SASHA pin, and VRS AI results are applied locally without an upstream
  forward. SASHA-origin rows behave exactly as before.
- For app enrollment only, an earlier undispatched row for the same order whose
  ticket is rejected or invalid is retired as `superseded`, so resubmissions
  can enroll.
- No schema change. Tests: `tests/vrs-app-enroll.test.ts`.


### Fixed - Release type-check gate (2026-09-18)
- `npm run build` now requires the strict TypeScript check to pass before
  bundling. Replit deployments use this same command, so type regressions stop
  the release without changing the existing client and server build outputs.

### Fixed - Development Snowflake SDK loading (2026-09-18)
- Load Snowflake lazily with a module-relative Node loader in both the tsx ESM
  development server and the production CJS bundle, including version diagnostics.
- Added isolated runtime regression tests for real SDK loading, caching, failure
  diagnostics/retry, missing version metadata, and synthetic encrypted-key lookups.
  No deployment, credentials, or bridge settings were changed.

### Fixed - Repository TypeScript baseline (2026-09-18)
- Resolved the 53 existing TypeScript diagnostics while retaining strict checks
  and the existing check scope. Set the language target to ES2022 for the
  supported modern runtime, fixing Map/Set iteration without runtime rewrites.
- Corrected password-input props, agent dashboard mutation signatures, route
  parameter/authentication narrowing, nullable report handling, Snowflake SDK
  connection types, and PostgreSQL result types without suppressing errors.
- Preserved the server-owned submission status timestamp and added focused
  password-input and storage-result regression coverage.

### Added - Agent notes after an AI close (2026-09-11)
- VRS agents can now read and add notes on a ticket after it has been closed,
  including tickets closed automatically by VRS AI. Two separate gaps were
  fixed. (1) The agent dashboard had no note UI at all: `submission_notes` rows
  could only ever be written from the technician's own detail page, so no agent
  had anywhere to record follow-up on any ticket, closed or open. A new
  `client/src/components/submission-notes-thread.tsx` renders the thread plus a
  post box on every ticket in every dashboard view. (2) `POST/GET
  /api/submissions/:id/notes` gated `vrs_agent` on
  `assignedTo === me || ticketStatus === 'queued' || reviewedBy === me`. A
  rejected close nulls `assignedTo`, and an AI close is attributed to whichever
  human happened to hold the ticket, so every other agent got 403. Non-queued
  tickets are now open to any VRS agent; queued tickets keep the existing
  division-specialization gate, and technicians remain limited to their own
  submissions.
- Notes are internal only. Posting one does not text the technician and does not
  call VRS AI. Notes created after the close timestamp are badged "after close"
  so the sequence is visible at a glance.

### Added - Weekly executive summary email via SendGrid (2026-09-11)
- New `server/services/weekly-exec-summary.ts` generates a one-week operating
  summary every Wednesday at 4:00 PM ET, persists it to `weekly_reports`
  (`report_type = 'exec_summary'`), and emails it to the app owners. Replaces
  the manual weekly "ask the Replit agent for an executive summary" loop.
- New `server/services/email.ts` is the app's first outbound email path
  (previously SMS-only via Twilio). It calls the SendGrid v3 REST API with raw
  `fetch` rather than adding `@sendgrid/mail`, so a rebuild that skips
  `npm install` cannot take the report down — the same failure mode that bit
  `browser-image-compression`. It fails soft: a missing key, an unverified
  sender, or a SendGrid outage returns `{ sent: false, reason }` and logs,
  never throwing into a scheduler tick. 401 and 403 responses are translated
  into the actual cause (bad key vs unverified Sender Identity).
- Sender defaults to `notifications@shs.com` (`SENDGRID_FROM_EMAIL` overrides).
  Recipients default to the three VRS Express owners and are overridable at
  runtime via the `vrs_exec_summary_recipients` system setting, so the
  distribution list changes without a redeploy.
- Admin routes: `GET /api/admin/reports/exec-summary` (list + config),
  `GET .../preview` (renders the current summary without saving or sending;
  `?format=html` returns the email body itself), `POST .../run`
  (`{ send, dryRun }`), and `PUT .../recipients`.
- Scheduler mirrors the existing Wednesday 5:00 PM tech-no-login report:
  DST-safe ET wall clock, a distinct advisory lock, and once-per-ET-day
  idempotence, so a restart on a Wednesday cannot send the summary twice.
  Registered production-only; preview and run-now work in every environment.
- Content follows the house exec format: a governing sentence carrying the
  headline number, three KPI cards, then a MECE stage table ordered by
  certainty. Two reporting corrections found during verification: the governing
  sentence no longer says "closed N of them" (arrivals and closures are
  different cohorts and closures can exceed arrivals), and durations are
  formatted by magnitude rather than rounded to hours, because average time to
  auth code is about a minute and was rendering as "0 h".
- Verification: TypeScript diagnostics unchanged at the normalized 56 baseline
  with none in the new or changed files. Test suite 294 passed / 42 skipped;
  `tests/intake-confirm.test.ts` fails identically on pristine HEAD and is
  pre-existing. Metrics and both renderers executed against the live dev
  database; the send path exercised with `dryRun` (correct sender, correct three
  recipients, no provider call). No email has been sent and nothing published.

### Fixed - Preserve intake availability independently of AI dispatch (2026-09-08)
- Removed the coupling that made `/vrs/authorize` return 503 whenever outbound
  production AI automation was disabled or incomplete. Existing authentication,
  payload validation and V5/V8/V9 intake behavior remain available for testing
  and normal operation. The direct and signed result routes remain available.
- Outbound AI dispatch still requires its existing explicit activation and valid
  configuration. No activation setting or key was changed and no call was made.
- Added regression coverage for V5/V8/V9 acceptance with outbound activation off
  and malformed-body validation with disabled/incomplete outbound configuration.
- Verification: 284/284 safe tests pass, production build passes, and the exact
  normalized 56-diagnostic TypeScript baseline is unchanged. Independent review
  passed. Replit DEV was refreshed through normal Workflows controls; public
  intake/callback validation and app entry points are reachable. No production
  Publish or real callback closure was performed.


### Fixed - Callback release safety and recovery (2026-09-08)
- Preserved both callback routes and all existing manual, PWA, NLA and V5/V8/V9
  routes. Automated closes now require matching call/order/technician/known
  part data and approved authorization workflow. Optional submissionId keeps
  ambiguous manual/PWA history resolvable without guessing.
- Added durable direct-result receipts bound before ticket effects. Validation
  failures remain correctable; accepted results remain immutable across retries
  and crashes. Completed-ticket recovery verifies the recorded callback note.
- Serialized signed application and forwarding; enforce event/payload ownership,
  terminal state ordering, durable forwarding claims and stale-worker fencing.
  Local callback lock reservations are capped to preserve shared DB capacity,
  and lost lock connections are handled without an unhandled client error.
- Unknown APIs return JSON 404 before SPA fallback. False HTML/error receipts
  are rejected, while the legacy empty-200 signed partner acknowledgment and
  original upstream envelope are preserved.
- Automated actions append notes and preserve human Stage 1 audit stamps.
  Failed or unknown SMS outcomes are distinct from completion. Production
  missing-provider configuration cannot report a mock success. Added an
  admin-only, confirmed-undelivered notification retry with a durable claim,
  preserving the original failure and never reapproving the ticket.
- Two additive receipt/recovery tables use bounded best-effort startup setup;
  no existing table definitions, UI source or dependencies changed. No actual
  activation setting, production data, real notification or Publish changed.
- Validation: 281/281 safe tests pass, including real isolated PostgreSQL concurrency,
  interruption/recovery, real conditional UPDATE and callback-handler probes;
  production build passed. Exact normalized TypeScript diagnostics match the
  existing 56-error baseline. Independent review findings were repaired and
  the targeted re-review found no remaining Important issues.


### Fixed - Approval callback metadata (2026-09-08)
- Existing VRS AI webhook accepts optional partId, techId, and partDescription
  on approved events, preserving them in the event ledger and upstream callback.
  Call/order correlation, signature validation, and duplicate handling remain
  enforced. Updated the OpenAPI contract and partner integration handoff.
- Verification: regression reproduced HTTP 400 before the change; all 192
  bridge tests and the production build pass. TypeScript has the same 56
  baseline diagnostics, with none in the changed runtime or test file.
- No real callback was sent and no ticket or production data was changed.

### Added — VRS AI call-result ticket close route (2026-09-08)
- New `POST /api/integrations/vrs-ai/v1/call-result` accepts the richer
  call-result payload VRS AI emits for a completed approval — the approved
  callback envelope (`version`, `eventId`, `callId`, `soNo`, `occurredAt`,
  `state`, `authNumber`, `authorizedAmount`, optional `durationSec` /
  `recordingUrl`) PLUS the required `partId`, `partDescription`, and `techId`
  fields — resolves the corresponding Express ticket and closes it.
- Deliberately separate from the signed partner webhook at
  `POST /api/integrations/vrs-ai/v1/webhook`, which is left untouched: this
  route does NOT write the `vrs_ai_call_events` ledger and does NOT forward
  the result upstream to SASHA. Use `/webhook` when the partner hop matters.
- Auth reuses the existing `VRS_SASHA_API_KEY` `X-API-Key` (timing-safe
  compare), the same credential VRS AI already presents on inbound authorize
  and the service-order lookup. No new Secret, no schema change.
- Ticket resolution prefers the authoritative bridge row for the call id, then
  falls back to matching the bare eight-digit `soNo` against the dashed
  `submissions.service_order` suffix, so PWA/manual tickets with no bridge row
  can still be closed. `techId` narrows service-order matches when it matches
  at least one of them, `pending` is preferred, then newest.
- The close runs through `processSubmissionHandler` with `action: "approve"`,
  so SMS, audit columns, optimistic locking, and WS broadcasts behave exactly
  as they do for a human agent approval. The part/tech/duration/recording
  fields are written into the ticket's agent notes so the approval is fully
  reconstructable from the ticket alone.
- Idempotent: a replay of an approval that already closed the ticket returns
  `200 { closed: false, deduped: true }` without re-approving or re-texting the
  technician. A ticket that is not `pending` returns `409 TICKET_NOT_CLOSABLE`
  with its real status rather than being forced.
- New `storage.getSubmissionCandidatesByServiceOrderSuffix(soNo, limit)` —
  bounded projection, parameterized `LIKE '%-<soNo>'`, `LIMIT 10`.
- Verification: 21/21 new tests in `tests/vrs-ai-call-result.test.ts` pass, the
  existing bridge suite still passes 179/179, the production build passes, and
  TypeScript is unchanged at the 56-diagnostic repository baseline with zero
  diagnostics in the new module. NOT yet exercised against a live database —
  the DB-backed resolver/closer wiring is typechecked and bundled but
  unexecuted; see ADR-016. No publish, no push, no schema or Secret change.

### Added — V9 bridge contract compatibility (2026-08-14)
- Added strict V9 selection on the existing `POST /vrs/authorize` route when
  either `cta_no` or `district_number` is present. V9 requires the complete V8
  shape plus both fields, requires `cta_no` to equal `contract_number`, and
  accepts only a four-digit order district or `N/A`.
- VRS Express preserves the V9 business payload through intake, human review,
  Stage 1 dispatch, retryable-failure handling, service-order lookup, and
  signed-photo enrichment. V5 and V8 parsing and dispatch remain available on
  the same endpoint with no database, schema, Secret, or production change.
- Added the two fields to the DEV review panel, OpenAPI 9.0 contract, Markdown
  handoff, architecture, and environment-specific DEV test sheet.
- Verification: 179/179 focused bridge tests pass, the production build
  passes, and TypeScript remains at the known 60-diagnostic repository
  baseline with zero diagnostics in the V9 change scope.
- Merged the two newer Replit commits without replacing them, synchronized
  GitHub and the Replit DEV workspace, restarted only DEV, and confirmed
  public health `200`. A complete authenticated V9 request for DEV service
  order `99081205` returned `202`; the authenticated lookup then returned
  `200`, `contract_version: v9`, the exact CTA and order district, and no
  callback credential fields. No publish, production, schema, Secret, or
  manual database action ran.

### Fixed — DEV bridge contract-key compatibility (2026-08-14)
- VRS Express DEV approval dispatch now recognizes the already-configured
  contract `X-API-Key` under its existing `VRS_SASHA_API_KEY` Secret name when
  `VRS_AI_API_KEY` is absent. The fallback is strictly development-only;
  production still requires an explicit outbound credential.
- Centralized Stage 1 environment resolution and added a regression proving
  the existing key is accepted in development and refused as a fallback in
  production. The full bridge suite passes 161/161 and the production build
  passes; TypeScript remains at the known 60-diagnostic repository baseline
  with no diagnostic in the changed bridge scope.
- Updated the DEV connection sheet to remove the duplicate-key handoff and to
  state the remaining external activation blocker accurately: the contract's
  `vrs-dev.stage.nextgen.shs.com` hostname has no public DNS record. No publish,
  production configuration, schema, or database action ran.
- Fast-forwarded GitHub and the clean Replit DEV workspace to `278447c`,
  restarted only the development process, and confirmed public health `200`.
  Live resolution reports `STAGE_ONE_CONFIGURED` while `VRS_AI_API_KEY` remains
  absent; a real outbound-client probe advances past configuration and fails
  with `DNS_ENOTFOUND` for the contract hostname. No database write ran.

### Added — Authenticated service-order and photo lookup (2026-08-13)
- Added `GET /api/integrations/vrs-ai/v1/service-orders/{service_order}` for
  VRS AI to retrieve the latest bridge-received service-order information and
  up to 10 directly downloadable photo URLs using the existing VRS Express
  DEV `X-API-Key`.
- The response removes callback fields, preserves valid sender HTTPS photo
  URLs, converts linked VRS Express `/objects/` paths into 24-hour signed
  Object Storage URLs, de-duplicates results, and fails closed if signing does
  not succeed. The lookup is read-only and adds no schema or secret.
- Updated the environment-specific DEV connection sheet with the exact live
  URL, request, response, authentication, expiry, and error behavior.
- Verification: 160/160 bridge tests pass, the production build passes, and
  the known repository TypeScript baseline has no diagnostic in the new
  service-order lookup modules.
- Fast-forwarded GitHub and the clean Replit DEV workspace, restarted only the
  DEV process, and confirmed public health `200`. The public lookup rejects a
  missing key with `401`; an authenticated lookup for existing V8 service
  order `99081204` returned `200`, one photo location, no callback fields, and
  no internal `/objects/` path. No publish, schema operation, or database write
  ran.

### Added — Direct V8 object-storage photo delivery (2026-08-13)
- VRS Express now converts ticket-owned `/objects/` photo paths into direct
  signed HTTPS Object Storage `GET` URLs during approved V8 dispatch when the
  accepted `appliance_photos` array is empty. URLs expire after 24 hours and
  require no VRS Express API key, login cookie, or media token.
- Sender-provided external HTTPS photo URLs remain unchanged, V5 remains
  unchanged, populated V8 photo arrays remain unchanged, and at most 10 URLs
  are sent. If an internal photo cannot be signed, dispatch fails before any
  VRS AI authorize call instead of sending a broken internal path.
- Updated the architecture, handoff, OpenAPI, DEV connection sheet, DOCX,
  matching PDF, and exact three-file ZIP package. The 10-page handoff was
  rendered through Microsoft Word and visually inspected page-by-page after
  the prescribed LibreOffice renderer proved unavailable.
- Verification: 155/155 bridge tests pass, the production build passes,
  `git diff --check` is clean, and TypeScript remains exactly at the 60-error
  HEAD baseline with zero diagnostics in the new photo-signing scope.
- Fast-forwarded GitHub and the clean Replit DEV workspace to the same source,
  restarted only DEV, and confirmed public health `200`. A read-only live test
  signed an existing DEV ticket photo for approximately 24 hours and fetched
  byte range `0-0` directly with HTTP `206`; the signed URL was not printed.
  No production publish, production configuration, or database write ran.

### Fixed — Real technician district normalization (2026-08-13)
- Fixed VRS bridge intake for real DEV technicians whose roster district uses
  the standard seven-character `000DDDD` form. VRS Express now derives and
  normalizes that value to the four-digit `DDDD` service-order prefix; callers
  continue sending only `tech_id` and do not add a district field.
- Added a regression using `dhanse9` / `0008175` that requires an accepted
  intake to create service order `8175-13538277`. Unsupported district shapes
  retain the existing `INVALID_TECHNICIAN_DISTRICT` rejection.
- Verification: all 151 focused bridge tests pass, the production build
  passes, and TypeScript remains at the known 56 repository diagnostics with
  zero diagnostics in the changed intake/test scope.
- Synchronized the fix on top of the Replit Agent's two newer weekly-report
  commits without overwriting them, restarted only DEV, and proved the live
  path with unchanged `dhanse9` V8 request `99081204`: `202` with a new public
  call ID and the derived `8175` district prefix. No production publish ran.

### Changed — Live VRS bridge DEV configuration and intake proof (2026-08-12)
- Added generated DEV-only `VRS_SASHA_API_KEY`,
  `VRS_AI_WEBHOOK_SECRET`, and `VRS_BRIDGE_ENCRYPTION_KEY` values through
  Replit Secrets. Added the confirmed VRS AI staging origin and VRS Express
  public DEV origin under `.replit`'s development-only configuration. A
  future production publish does not inherit either DEV URL. No secret value
  was written to Git, logs, documentation, or task output.
- Verified through the connected Replit app that the current August 10
  production deployment contains none of the six new bridge variables. Replit
  can capture synchronized App Secrets on a later republish, so production
  must not be republished until its bridge-secret selection and production
  endpoint values are deliberately reviewed.
- Restarted only the Replit development process and confirmed its environment
  contains every Express-owned bridge value. `VRS_AI_API_KEY` remains the one
  missing value and must be supplied by the VRS AI platform through a secure
  channel before Direction B can dispatch.
- Verified the public DEV authorize route returns `401` without a key and the
  configured key reaches strict contract validation (`400` for an empty
  payload). A complete strict V8 smoke request for active DEV technician
  `test_tech_1` and unique service order `99081201` returned `202`, created one
  pending-review bridge/ticket, and retained a null provider call ID before
  human approval.
- Added a separate platform-only Markdown DEV connection sheet alongside the
  contract package with the exact four test endpoints, credential direction,
  provisioned DEV technician, one-time service-order guidance, expected
  checkpoints, and joint run sequence. Credential values remain outside it.
- No production publication, production configuration, schema operation, or
  production database action occurred.

### Changed — Replit development workspace synchronization (2026-08-11)
- Fast-forwarded the clean VRS Express Replit workspace `main` from
  `972409d` to the verified V5/V8 handoff commit `6c69bab`, restarted its
  configured development server, and confirmed the public DEV health endpoint
  returns `200`.
- Pushed the same clean `main` history from the Replit box to GitHub. No
  production publish, schema/data write, deployment configuration change, or
  production database action occurred.
- Read-only runtime checks confirmed the existing bridge tables are present.
  DEV bridge secrets/endpoints, including the callback-secret encryption key,
  are still absent, so the live authorize route intentionally returns `503
  NOT_CONFIGURED` until secure configuration is supplied outside Git.

### Added — Regenerated V5/V8 development handoff package (2026-08-11)
- Rebuilt the direct-delivery handoff from the approved strict V5/V8 Markdown
  and OpenAPI sources: editable DOCX, matching PDF, and a ZIP containing
  exactly those two files plus the source OpenAPI YAML at the archive root.
- The platform-only package includes both development directions, strict
  version selection, complete V5/V8 payloads and constraints, response/error
  behavior, all five signed callback shapes and effects, raw-byte HMAC and
  retry rules, signed-photo handling, the narrow immediate retryable-failed
  V8 exception, and the DEV acceptance checklist.
- Scrubbed DOCX personal metadata, rendered and inspected all 10 PDF pages,
  verified exact table geometry, extracted and scanned DOCX/PDF text, and
  verified the exact three ZIP members and byte-for-byte bundled artifacts.
- The source documentation regression passes 16/16. No database, container,
  remote, configuration, deployment, publication, or production action ran.

### Changed — V5/V8 bridge handoff sources (2026-08-11)
- Revised the existing VRS Express/VRS AI bridge documentation in place for
  strict V5 and strict V8 compatibility on the same authorize endpoint. The
  architecture, Markdown handoff, and OpenAPI now agree on deterministic
  four-key V8 selection, same-version dispatch, human approval, controlled V8
  placeholder enrichment, signed-photo pass-through, callbacks, and
  active-only duplicate behavior.
- Replaced live endpoints with four development placeholders and removed
  individual names, upstream implementation labels, internal provenance, and
  credential material from all platform-facing source documents.
- Added executable documentation checks for OpenAPI references, strict
  V5/V8 `oneOf`, runtime-valid request/callback examples, exact constraints,
  deterministic raw-byte HMAC, Markdown/OpenAPI parity, approved placeholders,
  and the two-direction development acceptance boundary.
- Review hardening added the real `422 UNSUPPORTED_PARTNER` intake response
  plus callback retry coverage for network failures and HTTP `500`, `502`, or
  `503`, with five total attempts and 1/2/4/8-second backoff.
- Final review hardening documents the complete `409`/`422` intake rejection
  families, replace-before-test DEV technician/service-order prerequisites,
  directional clean-HTTPS callback allowlisting, and the exact ticket/SMS
  effect of all five callback states. `SUBMISSION_REJECTED` is explicitly
  documented under both statuses because captured conflict statuses return
  `409` while other submission rejections return `422`.
- Final V5/V8 verification passes 16/16 documentation tests and 150/150
  focused non-database bridge tests, with a passing production build.
  TypeScript remains at the known 56-raw/26-normalized baseline with zero new
  Task 6 module diagnostics. No database, container, remote, configuration,
  deployment, or publication action ran.

### Changed — Active-only V5/V8 bridge intake compatibility (2026-08-11)
- Extracted the production SASHA/Tech Hub intake orchestration from the route
  into an injected seam while retaining the existing active-duplicate,
  partner, technician, normal ticket, receipt-SMS, and API response behavior.
- Preserved the `972409d` active-only duplicate model: active bridge states
  keep the existing duplicate response. V5 and nonretryable V8 terminal
  repeats retain ordinary ticket/service-order policy.
- Added the narrow V8 §2.4 exception: after the latest same-service-order
  retryable `failed` V8 callback is locally applied, a strict new V8 request
  creates a new normal ticket, bridge row, and public call ID immediately.
  Only prior retryable-failed V8 bridge ticket IDs are excluded from all four
  legacy duplicate queries; unrelated, active, V5, and nonretryable ticket
  blockers remain in force. Old rows are never reset or reused.
- Upstream forwarding is not a retry precondition. Its durable ledger retries
  independently by the old call ID, without altering the new request;
  `dispatch_failed` remains the existing Stage 1 resend behavior.
- Removed the unapproved retry/reset, prior-attempt snapshot,
  historical provider lookup, callback lock-order override, and URL-gated
  PostgreSQL test. The existing locked fresh bridge insert remains the final
  active-race authority after normal ticket creation.
- Task 6 final non-database verification passes 16/16 intake and 16/16
  documentation tests, 150/150 full bridge tests, and the production build.
  `npm run check` remains at the known 56-raw-diagnostic baseline with zero
  diagnostics in the new Task 6 modules. No schema, seed, startup, migration,
  database connection/write, container, configuration, remote, deploy, or
  publication action ran.

### Changed — Complete bridge review context (2026-08-11)
- Bridge status now derives `contractVersion` as `v5` or `v8` from the stored
  strict payload without adding a wire/stored `contract_version` field or
  placing version metadata inside the review context.
- The existing bridge-only agent panel now labels the contract, partner,
  diagnosis, appliance, technician, estimate, part, comment, and sender-photo
  context required for V8 review while retaining V5 optionality and the
  unchanged manual-ticket approval path.
- Sender photo links and previews use the sender URL byte-for-byte with safe
  new-tab/referrer attributes. The VRS photo block does not request Express
  media tokens or use the normal submission lightbox path.
- Added server projection and bounded UI-source regressions. The UI suite
  passes 6/6, the affected queue suite passes 29/29, the focused bridge suite
  passes 115/115, and the production build passes. TypeScript remains at the
  known 56-raw-diagnostic baseline, so Task 5 added zero diagnostics. No
  schema, seed, startup, database, configuration, remote, sync, deployment,
  or publication action ran.
- **Review correction.** Replaced source-string checks as the primary UI proof
  with server-rendered tests of the production `VrsAiBridgeReview` component;
  retained only a narrow dashboard-wiring/manual-copy assertion. The component
  now includes raw request,
  technician, customer, address/location, appliance, problem, financial,
  part, full comment-metadata, and sender-photo context. V8-only rows are
  version-gated; absent optional V5 partner/grade rows do not render.
- The production store status method now consumes an injectable row-loader
  seam before the tested status projection. Coverage invokes
  `getStatusBySubmissionId` directly and proves neither wire-version spelling
  enters stored payload or review context. Follow-up verification is 6/6 UI,
  30/30 queue, 116/116 focused bridge tests, a passing build, and the unchanged
  56-diagnostic baseline.
- **Final review correction.** Moved the outer null guard, state, dispatch
  error, retryable-failure copy, and review composition into the production
  `VrsAiBridgePanel` consumed directly by the dashboard. Runtime rendering now
  proves null/manual state produces no panel while V5/V8 state produces the
  expected status and review. The primary mapping fixture gives every review
  field its own value and asserts its exact rendered row; a separate fixture
  proves intentional empty values, preventing equal-value field swaps.
- Final Task 5 verification is 8/8 UI, 30/30 queue, and 118/118 focused bridge
  tests plus a passing production build and unchanged 56-diagnostic baseline.
- **Closure proof correction.** The primary exact-row fixture now gives
  technician name and repair/replace rationale separate nonempty sentinels, so
  swapping those mappings fails. A separate rendered V8 case proves both rows
  preserve exact empty strings alongside literal `N/A`, `TBD`, and numeric
  zeroes.

### Changed — Stage 1 VRS AI dispatch gate (2026-08-11)
- Extracted the bridge-only Stage 1 decision behind injected store,
  configuration, client-construction, enrichment, and dispatcher boundaries.
  Manual/PWA tickets now prove the bridge lookup returns `not_applicable`
  before configuration is read or a VRS AI client is constructed.
- Bridge-backed approval now returns the existing bounded 503/409/429/502
  errors before the unchanged legacy Stage 1 update/SMS block. Only accepted
  or already-dispatched calls fall through; dispatch still occurs before the
  Stage 1 mutation.
- Added focused boundary tests to the bridge suite. The boundary passes 12/12,
  the focused suite passes 109/109, the production build passes, and
  TypeScript remains at the known 56-diagnostic baseline with zero Task 4
  diagnostics. No schema, seed, startup, database, configuration, remote,
  sync, deployment, or publication action ran.
- **Review correction.** Replaced the test-only Stage 1 continuation wrapper
  with a production route-gate adapter consumed by `processSubmissionHandler`.
  Dynamic tests prove its stop/continue behavior, while a bounded route-source
  regression proves the gate call and early return stay inside
  `approve_submission` and ahead of all legacy Stage 1 mutation.

### Changed — Safe V8 mapping and same-version dispatch (2026-08-11)
- V8 `tech_phone: "N/A"` now uses the resolved technician phone only for the
  normal Express ticket/SMS path while the durable parsed wire JSON retains
  the placeholder. Blank rationale receives an internal-only description in
  symptom, structured-comment, specific-failure-cause, then neutral order.
- Stage 1 dispatch keeps V5 unchanged and enriches V8 only for existing
  `tech_phone`, `tech_name`, and empty `appliance_photos` placeholders from
  valid same-field Express values. Populated values and signed TINA URLs are
  preserved byte-for-byte; authenticated `/objects/` paths and `cta_no` are
  never sent. The stored contract version is revalidated before the client.
- Added mapping/dispatch regression coverage. The focused bridge suite passes
  97/97, the production build passes, and TypeScript remains at the captured
  56-raw-diagnostic baseline with no new Task 3 file diagnostic. No schema,
  seed, startup, database, configuration, remote, sync, deployment, or
  publication action ran.
- **Review correction.** Extracted the intake operational projection and
  Stage 1 enrichment-candidate projection into focused helpers consumed by
  `server/routes.ts`, then covered their exact phone, immutable sanitized
  payload, technician-name, and parsed-photo outputs. Removed redundant V8
  parsing inside enrichment so dispatch's explicit same-version validator is
  the single tested pre-client enforcement gate.

### Changed — Authenticated V5/V8 authorize API boundary (2026-08-11)
- `POST /vrs/authorize` now selects the strict V5 or V8 validator only after
  its existing configuration and timing-safe API-key checks. Authenticated V5
  and V8 payloads reach intake unchanged, partial V8 requests return bounded
  V8 validation fields, and the existing `202`/active-duplicate `409` bodies
  remain unchanged without exposing callback secrets or provider call IDs.
- Added route-boundary coverage for V5/V8 intake fidelity, 401/503-before-
  parsing order, partial V8 errors, unchanged response shapes, and secret
  exclusion. The focused bridge suite passes 83/83 and the production build
  passes. TypeScript remains at the 56-raw-diagnostic baseline with no
  changed-file diagnostic. No schema, database, configuration, remote, sync,
  deployment, or publication action ran.

### Added — Strict V5/V8 authorize contract schemas (2026-08-11)
- Added canonical V5 and complete V8 authorize fixtures plus version-aware
  contract tests. Any `appliance_color`, `contract_number`, `purchase_year`,
  or `symptom` key selects strict V8 validation; incomplete V8 payloads cannot
  fall through to V5.
- Preserved the existing V5 schema export and trimming behavior while adding
  a non-mutating V8 schema, documented gap values, strict root/nested key
  rejection, TINA/signed URL byte preservation, and same-version outbound
  source validation. `contract_number` and `symptom` are nonblank but have no
  invented `maxLength`, matching the source V8 contract; the application JSON
  body limit remains the outer bound. No database schema, seed, startup,
  route, or deployment change was made in this increment.
- Added the new contract suite to `test:vrs-ai-bridge`. The focused bridge
  suite now passes 78/78, the production build passes, and TypeScript remains
  at the captured 56-raw-diagnostic baseline with no changed-file diagnostic.
- **Review correction.** Removed an unsound type cast that advertised the V5
  `ZodEffects` validator as a `ZodObject`. The exported schema now exposes its
  actual runtime class, while `VrsAuthorizeV5Request` is derived separately
  from the clean shape schema to preserve consumer types and the diagnostic
  baseline.

### Planned — VRS V5/V8 development integration (2026-08-11)
- **Execution plan recorded.** Added the test-first implementation and DEV
  rollout plan at
  `docs/superpowers/plans/2026-08-11-vrs-v5-v8-dev-integration.md`, including
  strict version selection, manual-workflow isolation, retry safety, document
  generation, regression evidence, Replit reconciliation, and explicit
  pre-sync/pre-publication gates.
- **V5 and V8 coexist.** Corrected the earlier replacement assumption after
  the integration meeting. The existing strict V5 Tech Hub-compatible payload
  remains accepted; the complete strict V8 SASHA payload is added on the same
  `POST /vrs/authorize` route and each accepted request keeps its version
  through VRS Express Stage 1 review and VRS AI dispatch.
- **Development test flow.** VRS AI first acts as a SASHA simulator by sending
  a V8 dummy payload to VRS Express DEV, then receives that same-version
  payload from VRS Express DEV after human approval. Development and
  production use separate database/configuration bindings; this design does
  not publish or alter production.
- **Design corrected.** Updated
  `docs/superpowers/specs/2026-08-10-vrs-api-contract-v8-retrofit-design.md`
  with strict dual-schema parsing, same-version dispatch, permitted
  placeholder-only enrichment, TINA/signed-photo pass-through, review UI,
  V8 retry, test, documentation, and rollout boundaries. No runtime code,
  schema, deployment, or production state changed in this correction.
- **Production preservation gate.** Rebased the design on the clean Replit
  publish source at `972409d` after discovering it was six commits ahead of
  GitHub. Captured the live HTTP/health response, 32/32 bridge tests, passing
  production build, full-test environment baseline, and 56-raw/26-normalized
  TypeScript baseline. The integration cannot be marked publish-ready with any regression,
  schema/startup migration, unguarded manual-flow change, missing staged
  workflow evidence, or unapproved sync/publication.

### Added — VRS Express ↔ VRS AI AHS bridge (2026-07-28)
- **External handoff finalized (2026-07-29).** Refreshed the human-readable handoff and OpenAPI contract to the merged/published VRS Express state, regenerated the polished 10-page DOCX, exported a matching PDF, and bundled the PDF, editable DOCX, and OpenAPI file in `output/doc/VRS-Express-VRS-AI-Handoff-Package.zip`. The external package names only VRS Express and VRS AI as the platforms and excludes individual names, internal meeting/PR/commit history, and internal security-incident language. Fresh validation passed: 32/32 bridge tests, 34/34 local OpenAPI references, the authorize example, all five callback examples, the deterministic HMAC vector, DOCX/PDF metadata scans, exact ZIP contents, and visual review of every rendered page. The package is ready for direct implementation handoff; bridge activation still requires secure staging configuration, the additive development schema, the three documented VRS AI decisions, and joint end-to-end evidence.
- **Initial handoff and publication audit (2026-07-29).** Revalidated 32/32 bridge tests, all 34 local OpenAPI references, the authorize example, all five callback examples, and the deterministic HMAC vector. The published app is healthy and serves the merged client bundle, but both bridge routes correctly return `503 NOT_CONFIGURED`: all six bridge variables are absent and the read-only schema check confirms `vrs_ai_calls` / `vrs_ai_call_events` do not exist. Repository handoff files are not public download routes. This audit identified stale draft metadata, which the finalized external handoff entry above resolves. Live keys/URLs, three VRS AI decisions, and staging evidence remain intentionally external or unresolved.
- **Merged and synchronized (2026-07-29).** After Tyler confirmed the bridge and documentation belong on `main` for publication, draft PR #1 was marked ready and merged through `f1b9398`. Local and VRS Express `main` were fast-forwarded to the merged history; the clean Replit checkout contains all three handoff deliverables and passed the 32 focused tests plus the production build. Replit's shell could not authenticate a raw private-GitHub fetch, so the verified Git history was transferred over the existing SSH connection. No production database change or deployment was performed.
- **Sync first.** Reconciled the live Replit `main` with GitHub before implementation: Replit's clean 14-commit lead was transferred over SSH and pushed, then the local checkout was fast-forwarded. All three sources were confirmed at `98542cf` before this branch began.
- **Architecture source corrected.** Used the July 24 Granola meeting as the ownership source of truth: SASHA/Tech Hub → VRS Express pending review → human approval → VRS AI → result back through Express, while the existing technician SMS remains in place. Removed the earlier AI-owned admission/rate-limit/worker design from the Express side.
- **V5 intake.** `POST /vrs/authorize` now authenticates with `VRS_SASHA_API_KEY`, strictly validates the V5 request, gates Phase 1 to AHS, resolves the technician/district, maps the bare SO and appliance into the normal VRS ticket shape, and invokes the existing submission handler so duplicate rules, routing, broadcasts, ProcID lookup, and SMS stay shared.
- **Human handoff.** Bridge-backed tickets show **Approve & Send to VRS AI**. Stage 1 sends the payload to the confirmed VRS AI `/vrs/authorize` endpoint and only marks the ticket approved/notifies the technician after the AI service accepts it. Manual tickets retain their existing flow.
- **Signed result path.** Added `POST /api/integrations/vrs-ai/v1/webhook` with exact raw-body HMAC verification, five-minute timestamp enforcement, event-ID matching, service-order/provider-call correlation, terminal outcome application through the existing ticket process handler, and signed forwarding to SASHA using the public Express call ID.
- **Durable idempotency.** Reworked `vrs_ai_calls` as an Express bridge record and added `vrs_ai_call_events` so callbacks can resume forwarding without reapplying ticket/SMS effects. Terminal callbacks after the first are acknowledged and ignored; `requires_info` can precede a terminal event.
- **Secret separation.** SASHA callback secrets are AES-256-GCM encrypted with a new dedicated `VRS_BRIDGE_ENCRYPTION_KEY`; `SESSION_SECRET` is no longer reused, so JWT/session rotation cannot break in-flight callbacks. SASHA callback destinations remain restricted to the exact confirmed prod/stage endpoints.
- **Scope.** Phase 1 is AHS only. First American remains a separate portal workflow pending a validated execution path; Choice/OEM are excluded and Assurance follows later. VRS AI retains responsibility for admission limits, Twilio/AI execution, prompt composition, recordings, and callback production.
- **Safety and validation.** No production schema/data update or deployment was performed. Added 32 focused contract/orchestration/UI-copy tests plus the architecture/rollout guide; production build passes.
- **VRS Express to VRS AI integration package.** Added an implementation handoff in Markdown and DOCX plus an OpenAPI 3.1 contract. The package defines the Express-to-AI request, provider call-ID rules, all five Phase 1 callback events, raw-body HMAC signing, deterministic test vector, retry/idempotency requirements, business effects, staging acceptance evidence, and the three decisions still needed from VRS AI.

### Added — External REST API v1 for non-Replit app integration (2026-07-21)
- **Why.** An external (non-Replit) application needs to read all VRS workflows and write (create authorization/infestation/NLA requests on behalf of technicians AND record decisions) without going through the PWA/dashboard UIs.
- **Surface (`server/routes.ts`, helpers in new `server/external-api.ts`).** `GET /api/external/v1/service-orders/:so`, `GET /api/external/v1/submissions` (filters + descending-id cursor pagination, limit ≤100), `POST /api/external/v1/submissions`, `POST /api/external/v1/submissions/:id/decision`. Auth via `x-api-key`: reads reuse `VRS_LOOKUP_API_KEY`, writes require a separate `VRS_EXTERNAL_WRITE_API_KEY` (timing-safe compare, 401 + IP/UA warn log). In-process global rate limits: 60 reads/min, 10 writes/min.
- **Adapter design (no logic duplication).** The four inline internal handlers (create submission, claim, process, process-nla) were named as consts with byte-identical bodies and re-registered on their original paths; the external write routes rebuild `req.body`/`req.user` and invoke those same consts via a captured-response shim. SMS, WS broadcasts, audit stamps, idempotent-create, optimistic-lock claim conflicts, and the submissions micro-cache bump behave identically to in-app actions.
- **Identity.** Creates resolve `technicianLdapId` against the Snowflake-synced technicians table and attribute the submission to the real tech user (auto-provisioned via the same path as passwordless login) — the tech gets the normal SMS chain. Decisions are attributed to a new seeded `VRS_EXTERNAL_API` system account (`server/seed.ts ensureExternalApiUser`): role vrs_agent with all divisions + nla, `isSystemAccount`, `isActive:false`, random unrecoverable password, seeded after `resetAllPasswords()` so a fresh DB can't assign it the generic password. Queued tickets are auto-claimed by that account; tickets claimed by a live agent return 403 (external cannot override a human review).
- **Bounded output.** Reads use a new explicit `ExternalSubmissionRow` projection (`server/storage.ts`); write responses pass through `projectSubmissionForExternal`. Media paths/thumbnails, `phoneOverride`, `rejectedMedia`, and RGC codes are never returned. v1 accepts NO media fields and no `resubmissionOf` on create (path-injection / ownership-chain risk). Decision actions are allowlisted (5 auth + 5 NLA); replacement-review, B2B replacement, and P-card flows deferred from v1.
- **Decision hardening (post-review).** (a) Auto-claim rollback: if the decision step fails after the system account auto-claimed a queued ticket, the route returns it to the general queue (`updateSubmissionIfStatus` pending→queued with `expectAssignee` = system account, so a concurrent legitimate move wins) and re-broadcasts `ticket_queued` (NLA-aware) — no more tickets stranded invisibly on the system account. (b) System-account status reset: a `finally` block parks the account back to `offline` after every decision flow (the claim/process handlers flip it to working/online), so it never lingers on the admin live-status board. (c) Write responses re-read via new `storage.getSubmissionByIdForExternal` so create/decision return the same nested `{technician, agent}` shape as reads.
- **Docs.** `docs/architecture/external-api.md` (full contract + consequences), replit.md pointer. Public shareable integration guide at `GET /api/external/v1/docs` (unauthenticated static HTML, placeholder keys only, noindex, own 30/min rate bucket) — `server/external-api-docs.ts`.
- **Warranty-gate fix (found via external-API testing, affects internal flows too).** The AHS/First American substring gate (`"american home shield"/"ahs"/"first american"`) never matched underscore enum values (`american_home_shield`, `first_american`) when `warrantyProvider` was empty, so such tickets could be finally approved *without* an external auth code (RGC issued instead). All four gate sites in `server/routes.ts` (two-stage detection, B2B replacement, approve, replacement review) now normalize `_` → space before matching. The agent dashboard's `needsExternalAuth`/`getProviderAuthLabel` (`client/src/pages/agent-dashboard.tsx`) mirror the same gate (previously they checked `warrantyProvider` only — an AHS ticket with empty provider would have hidden the auth-code input while the server demanded one), and the external create adapter now defaults `warrantyProvider` from `warrantyType` ("American Home Shield" / "First American") when omitted. Verified end-to-end: external AHS create (no provider) → provider defaulted → stage-1 `approve_submission` → `approve` without `authCode` 400s; with `authCode` completes and stores the external code.
- **Extensive external-API test pass (2026-07-21).** ~60 checks green in dev: auth/401s (incl. cross-key), SO lookup, list filters + cursor pagination, validation 400s, unknown/inactive tech 422, create 201 + idempotent replay 200, duplicate active SO 409, decision 404/BAD_ID/ACTION_MISMATCH both directions, live-agent 403, terminal-state 400, NLA create + required-instructions 400 (with rollback re-queue verified) + `nla_reject` 200, two-stage AHS flow, write 429 + read 429 + docs page unaffected by read limit.
- **Verified.** Dev curl: 401 no/bad key, list + pagination (`nextCursor` chain), `requestType` filter, bad-enum 400, SO lookup happy + bad-format 400, no media keys in payloads; create 201 with nested technician; `approve` without RGC → 400 with ticket confirmed back in queue (agent null) and system account back to offline; follow-up `reject` → 200. Clean boot; system account seeded id=113. `tsc` — only pre-existing baseline noise in edited files; zero new errors.

### Changed — Four load/latency performance fixes (2026-07-08)
- **Why.** Dashboard load profiling showed four independent hot spots: large uncompressed JSON payloads, all connected staff dashboards polling and WS-refetching in lockstep, and one media-token round-trip per photo when opening a ticket.
- **gzip (`server/index.ts`).** `compression` middleware mounted app-wide with a filter that skips `/objects/*` (media bytes are already compressed; keeps Range/206 streaming untouched). Verified: admin list 23,984B → 2,766B on the wire.
- **Poll jitter (`client/src/lib/queryClient.ts`, agent/admin dashboards).** `JITTERED_POLL_INTERVAL_MS` (per-client random offset) applied to the four polling `refetchInterval` sites so clients desynchronize instead of stampeding each interval tick.
- **Staff list micro-cache (`server/routes.ts`, `server/storage.ts`).** 2s TTL in-process cache for the STAFF branch of `GET /api/submissions` only. Key = role class + fully resolved filters (incl. agent-derived `assignedTo`/`reviewedBy`/sorted `divisionFilter`) + `completedToday` + lowercased search, computed before the admin default-window injection (that value is `Date.now()`-derived). Freshness = TTL **and** a `submissionsDataVersion` stamp bumped by every storage write path touching `submissions`/`intake_forms` (9 sites), so any write invalidates instantly. Tech/provider branch (warranty redaction) is never cached. Single-process only — must move to a shared store if the app ever scales horizontally.
- **WS invalidation coalescing (`client/src/lib/queryClient.ts` + all agent/admin WS handlers).** `scheduleWsInvalidate()` batches WebSocket-triggered `invalidateQueries` behind a 2.5s trailing debounce, so an event burst produces one refetch wave instead of N. Mutation `onSuccess` invalidations remain immediate; claim conflicts stay safe server-side via `updateSubmissionIfStatus` (409 on stale status).
- **Batched media tokens (`server/routes.ts`, `client/src/lib/auth.tsx`).** New `POST /api/media-tokens` (zod: 1–60 paths, each ≤500 chars, `/objects/` prefix). Staff get tokens for all paths; technicians/1099 providers get tokens only for paths verified to belong to their own submissions (single SQL ownership query + per-path literal membership re-verification; unverified paths silently omitted — same boundary as the existing single `GET /api/media-token`, verified stricter against LIKE-wildcard input). Client `prefetchMediaTokens()`/`collectSubmissionMediaPaths()` warm the token cache when a ticket detail opens (agent dashboard, admin ticket dialog, tech submission detail), with per-path fallback to single fetches on any batch failure.
- **Verified.** Live curl checks: gzip header + size, cache-hit latencies, batch endpoint 401/400 handling, staff full-grant, tech own-paths-only with foreign path omitted. `tsc` shows only pre-existing baseline noise — zero new errors in changed ranges. Architect review: PASS.
- **Deferred (not approved).** ffmpeg conversion concurrency throttle — discussed but intentionally not implemented.

### Fixed — Stage-2 reviews now expose all six outcomes (not just approve) (2026-06-27)
- **Why.** On two-stage AHS / First American tickets, once an agent had completed Stage 1 (`approve_submission` → `submissionApproved=true`), the Stage-2 review screen only offered the approve/authorize path. A guard in `/process` blocked every non-`approve_submission` action while `submissionApproved` was true, so an agent who reached Stage 2 and then needed to reject, reject-and-close, mark invalid, or send a B2B approved replacement had no way to do it from the UI and the API refused the call.
- **Server (`server/routes.ts`).** Relaxed the Stage-2 guard so it now blocks ONLY a repeat `approve_submission` while `submissionApproved` is true. `reject`, `reject_and_close`, `invalid`, `approve_replacement_review`, and `b2b_approved_replacement` now fall through to their normal handlers at Stage 2. A resubmit creates a brand-new row and rejected rows are not re-claimable, so no `submissionApproved` reset is needed.
- **Server — Stage-2 audit stamp (`server/routes.ts`).** The negative handlers (`reject`, `reject_and_close`, `invalid`) were originally Stage-1 actions and write `stage1Status`/`stage1ReviewedAt`/`reviewedBy` to reflect the final outcome. When one of them now lands at Stage 2 (`submissionApproved===true`) it ADDITIVELY stamps the dedicated `stage2Outcome` (`reject` / `reject_and_close` / `invalid`), `stage2ReviewedBy`, and `stage2ReviewedAt` so the authorization-stage decision is recorded for audit/export. The Stage-1 fields are deliberately left untouched: the analytics layer in `server/storage.ts` treats `stage1Status` as the overall outcome (Approval-Rate card filters `stage1Status='approved'|'rejected'`) and keys the agent Completed-Today tile off `stage1ReviewedAt`, so preserving a stale `stage1Status='approved'` there would have counted a rejected ticket as approved and dropped the agent's Stage-2 work from their Completed-Today count. `stage2Status` is intentionally NOT set to `"declined"` so the Submission-History timeline renders a single Rejected/Invalid entry instead of double-rendering a Declined entry.
- **Agent dashboard (`client/src/pages/agent-dashboard.tsx`).** Collapsed the previous Stage-2-only branch into the unified enhanced outcome grid so both stages render from one code path. The approve card is now stage-aware ("Authorize & Send" / `action=approve` at Stage 2). Added the indigo **B2B Approved Replacement** card (gated to `submissionApproved` Stage 2 + non-`parts_nla`) with its own message input and SMS preview. Submit button label/style now reflect the selected Stage-2 action. The confirm-dialog title AND confirm CTA for the approve action are now stage-aware too — both read "Authorize & Send" at Stage 2 (previously the dialog still said "Approved to Repair").
- **Tech submission detail (`client/src/pages/submission-detail.tsx`).** The Rejected and Invalid entries in the per-ticket Submission-History timeline now append "· at authorization stage" when `stage2Outcome` is present, so the audit trail distinguishes a Stage-2 reversal of a previously-approved submission from a plain Stage-1 rejection.
- **Verified.** API integration test through the real routes: tech-submit AHS authorization → agent claim → `approve_submission` (Stage 1) → `reject` (Stage 2) now returns `200` with `ticketStatus=rejected` (previously `400`). `invalid` and `reject_and_close` share the identical fall-through path. Clean boot on port 5000; `tsc` shows only the project's pre-existing baseline noise (ES5 target / `authReq.user` strictness) — zero new errors in any edited range.

### Fixed — Admin reassign now frees the previous assignee's pending slot (2026-06-27)
- **Why.** When an admin reassigned a claimed ticket from agent A to agent B, agent A's pending-ticket count was not decremented, leaving a phantom claimed ticket that could block A from going offline and skew workload accounting.
- **Server (`server/routes.ts`).** The reassign route now calls a `freePreviousAssignee` helper that releases the prior assignee's hold on the ticket as part of the reassignment so the slot is correctly transferred to the new assignee.

### Changed — Approve action relabeled "Approved to Repair" + SMS now carries explicit status line (2026-05-21)
- **Why.** VRS rename: the single-stage "Approve" button now reads "Approved to Repair" to make the outcome unambiguous, and the technician SMS now leads with a `Status: APPROVED TO REPAIR` line above the auth/RGC code block so the tech sees the outcome at a glance.
- **Agent dashboard (`client/src/pages/agent-dashboard.tsx`).** Button label changed from `Approve` → `Approved to Repair`. Confirm dialog title `Approve Ticket` → `Approved to Repair` and confirm CTA `Approve & Notify` → `Approved to Repair & Notify` (post-architect-review fix — kept consistent across the full action flow). Two-stage warranty branch (Stage-1 button) unchanged — still reads `Approve Submission`. Action key + selectedAction state values unchanged (still `approve`) so no server-side or analytics rewiring needed.
- **SMS preview (`client/src/lib/smsPreview.ts`).** Updated the `approve` branch (non-NLA) to match the new template/fallback bodies — agent preview was previously drifting from what techs actually receive (post-architect-review fix).
- **SMS templates — defaults (`server/seed.ts`).** Prepended `Status: APPROVED TO REPAIR\n` to the three `ticket_approved.*` bodies: `.with_auth_and_rgc`, `.rgc_only`, `.auth_only`. The `.auth_only` body was also normalised to the same `VRS Authorization for SO# {n}` header shape as the other two for consistency.
- **SMS fallback strings (`server/sms.ts`).** Three hard-coded fallback strings in `buildAuthCodeMessage()` updated to match — protects against the template-render path failing (admin deleted the row, render error, etc).
- **One-time migration (`server/seed.ts`).** New `ensureApprovedToRepairStatusLine()` flag-row migration (flag rac_id `__approved_to_repair_status_line_v1_done__`). For each of the three `ticket_approved.*` rows: if body already contains `APPROVED TO REPAIR` → skip; if admin has edited the template (`isDefault=false` OR `currentVersion>1`) → log a warning and leave untouched (the rename must be re-applied via the admin Communication Templates UI to avoid clobbering custom copy); otherwise → direct `db.update()` of the body. Wired into `seedDatabase()` after `seedDefaultCommunicationTemplates()`. Idempotent — re-runs are no-ops via the flag row.
- **Migration verified.** On restart all three DB rows updated, flag row inserted, no admin-edited rows present so no manual follow-up needed for this environment.
- **Not changed (intentional).** Tech-side `Approved` badge (`submission-detail.tsx` L810 + history page) and admin queue status pill left as `Approved` — those are status labels, not the outcome action, and would create visual noise across history. The two-stage `Approve Submission` button left alone — that's a Stage-1 action, not the final repair-ready outcome. Toast confirmation copy left as `Approved` — agent-facing only, immediately disappears.

### Added — Replacement Review outcome on standard /process route (2026-05-20 afternoon)
- **Why.** VRS management asked for a distinct outcome when a tech submission should be closed in VRS but the warranty company will handle the actual unit replacement externally. Previously agents had to either Approve (which signals repair-ready) or Reject — neither matched the workflow. The fix: a fifth purple "Replacement Review" action on the standard `/process` route, terminal (no resubmit), with its own tech-facing screen and SMS copy.
- **Schema (`shared/schema.ts`).** New `replacement_review_recommended` boolean column on `submissions` (default false, NOT NULL). Added to `SubmissionListItem` Pick so the badge can render in the admin queue without an extra select.
- **Seed (`server/seed.ts`).** `ensureReplacementReviewColumn()` idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` wired into the existing background-init block. Logs `[replacement-review] submissions.replacement_review_recommended ensured (default false)` on startup.
- **SMS (`server/sms.ts`, `client/src/lib/smsPreview.ts`).** New `buildReplacementReviewMessage()` builder + `ticket_replacement_review` template key + matching `smsPreview` case. Exact mandated copy: *"Placed into Replacement Review, remove all parts from the order and select the proper replacement labor code and close the call."* Includes the Replacement Code line (collapsed to one line if Replacement Code === RGC).
- **Server (`server/routes.ts`).** `approve_replacement_review` added to the `/process` action enum. Handler branch mirrors `approve` (issues RGC code, captures external auth code for AHS/First American, sets `ticketStatus='completed'`, `stage1Status='approved'`, `stage2Status='approved'`) but additionally sets `replacementReviewRecommended=true` and sends the new SMS template. Terminal guard added to the resubmit route so tickets flagged `replacementReviewRecommended` cannot be resubmitted. NLA-rejection guard added (the action is invalid for `requestType='parts_nla'` — NLA has its own replacement actions on `/process-nla`).
- **Storage + analytics (`server/storage.ts`).** New `getReplacementReviewAnalytics()` (today / week / month / all-time counts, keyed on `statusChangedAt` for the bucketed counts so a backfill or test-data import doesn't pollute "today"). Added to `IStorage`. New `GET /api/admin/replacement-review-analytics` admin-only route.
- **XLSX export (`server/routes.ts`).** New "Replacement Review" column appended to the Authorization Tickets sheet header + body row (`YES` or empty). NLA sheet untouched (the flag is meaningless there).
- **Agent dashboard (`client/src/pages/agent-dashboard.tsx`).** Added 5th purple action button (`Replacement Review`) next to the existing Approve / Reject / Reject & Close / Invalid buttons. Hidden when `requestType==='parts_nla'`. Reuses the auth-code input (label flips to "Replacement Code"), additional-message textarea, and SMS preview. Validators extended: external-auth-required and rgc-set-for-today checks now also gate Replacement Review. Submit button label "Send to Replacement Review", purple background (`rgb(126 34 206)` inline since shadcn `Button` has no purple variant).
- **Tech submission detail (`client/src/pages/submission-detail.tsx`).** New header branch (purple `bg-purple-700`, title "Placed Into Replacement Review") inserted **before** the green completed branches so the tech sees a distinct screen — never the misleading "Authorization Ready". Mandated instruction copy rendered as the subtitle. Auth-code card relabeled "Replacement Code" with a purple background when the flag is set; Copy button label switches to "Copy Replacement Code".
- **Admin dashboard (`client/src/pages/admin-dashboard.tsx`).** New purple "REPLACEMENT REVIEW" badge next to the ticket status pill (parallel to the existing NLA amber badge). New "Replacement Review Outcomes" analytics card with Today/Week/Month/All Time tiles, placed above the NLA Parts Submissions card.

### Changed — Auto-offline now driven by SCREEN inactivity, not WebSocket inactivity (2026-05-20 afternoon)
- **Symptom (VRS report).** Thomas Bottoms: "This keeps happening while I'm working orders in the app… I was in the process of working the most recent NLA ticket when it popped up that time." Screenshot showed the "marked Unavailable due to inactivity" modal appearing while Thomas was actively filling an NLA form. Hamed (VRS): "if you don't work a ticket in 30 min system will ask that" — confirming the prior behavior was too aggressive: an agent typing in a form for 30 min with no WS events looked "idle" to the server.
- **Root cause.** The WS-disconnect grace timer used "no live WebSocket sessions for 30 min" as the inactivity signal. Proxy idle-drops, tab-focus switches, autoscale instance churn, and even a long-running form session with no incoming events can all look like WS-idle while the agent is sitting right there working. WS-idle is just the wrong signal.
- **Fix — replace server WS-idle timer with client-side SCREEN inactivity tracker.**
  - **Removed (`server/websocket.ts`).** Deleted `AUTO_OFFLINE_GRACE_MS`, `pendingOfflineTimers`, the cancel-on-reconnect logic, and the auto-offline setTimeout in `ws.on("close")`. WS disconnect handling now only logs and cleans up the session map — no status changes.
  - **Added (`server/routes.ts`).** New `POST /api/agent/auto-offline` endpoint. Sets `agentStatus='offline'` and stamps `autoOfflinedAt=NOW()`, broadcasts the status change to admins/self, refreshes VRS availability for techs. Returns `{ skipped: true, reason: 'pending_ticket' }` if the agent has an open claimed ticket (don't strand an in-flight ticket), or `{ skipped: true, reason: 'not_online' }` if they're already offline.
  - **Added (`client/src/pages/agent-dashboard.tsx`).** New `useEffect` registers `mousemove`/`mousedown`/`keydown`/`touchstart`/`scroll`/`wheel` listeners on window. Any of these resets `lastActivity`. A 60-second interval checks if `Date.now() - lastActivity >= 30 min`; if yes (and agent is `online`, not in admin-viewing mode), POSTs `/api/agent/auto-offline`. On success: sets local state to offline, populates `autoOfflinedAt`, surfaces the existing "marked Unavailable due to inactivity" modal. Effect only runs when `localAgentStatus === 'online'` so the tracker tears down once the agent goes offline (no wasted ticks).
- **Why this is correct.** "Did you walk away from your computer?" is what we actually want to detect — and real keyboard/mouse/touch activity is the proxy that maps to that question. An agent reading a long ticket description or filling a form for 30 min straight will move the mouse or scroll at least once, so the timer stays reset. An agent who actually walks away gets the prompt on return (next mouse wiggle or page reload).
- **Pending-ticket safety.** Server-side check ensures auto-offline never strands a claimed ticket; the agent stays online and the modal won't fire. They can still go offline manually (which is also blocked when pending — they have to complete or get admin to reassign).
- **Modal copy unchanged.** Existing modal in `agent-dashboard.tsx` (lines 4847+) still keys off `autoOfflinedAt`. Yes → PATCH /api/agent/status online (clears flag). No → POST /api/agent/auto-offline-ack (clears flag, stays offline).
- **Architect review fixes (same day):**
  - **NLA pending guard (server/routes.ts).** `storage.getPendingCount(userId)` excludes `request_type='parts_nla'` (it's NLA-specific accounting). The new `POST /api/agent/auto-offline` route AND the existing `PATCH /api/agent/status` offline branch both now check `getPendingCount + getNlaPendingCount` so an agent with a claimed NLA ticket can't be auto-offlined (or manually go offline) and strand the NLA work. The latent bug in PATCH was pre-existing — fixed while in the area.
  - **Server-side presence-stale fallback (server/websocket.ts).** Removed the original 30-min WS-disconnect auto-offline timer, but kept a much longer 60-min `PRESENCE_STALE_MS` cleanup so an agent who fully closes their browser/laptop doesn't sit at `agent_status='online'` forever and inflate the tech-facing online-agent count. This fallback uses a different mechanism than the inactivity modal: it does NOT stamp `autoOfflinedAt` (the browser is gone — no modal to show), it's gated by the same pending-ticket safety check (won't strand a claimed ticket), and the 60-min window is intentionally 2x the client's 30-min screen-idle threshold so the client path is always the first to fire when a tab is still alive.
  - **Client retry timing (client/src/pages/agent-dashboard.tsx).** The `finally{}` block previously reset `lastActivity = Date.now()` unconditionally, which on a failed `POST /api/agent/auto-offline` (network blip, 5xx) would defer the retry by another full 30 minutes. Moved the reset into the success and explicit-skip branches only — true failures now retry on the next 60s tick. `finally{}` is now just `firing = false`.
  - **Deferred (low severity):** iframe activity blind spot — events inside cross-origin iframes (Smartsheet intake, SHSAI) don't bubble to the parent window's listeners. In practice agents constantly touch the surrounding UI (sidebar, notes input, dropdowns, scroll) while working a ticket, so timer reset isn't dependent on iframe activity alone. Will revisit if real reports surface.

### Fixed — Agent Activity Log architect follow-ups (2026-05-20 afternoon, same-day)
- **Prod bootstrap migration (critical).** Initial cut only created `agent_activity_log` via a one-shot raw SQL run against the dev DB — prod deploys would have 500'd on the first `safeLogActivity()` write. Added `ensureAgentActivityLogTable()` in `server/seed.ts` mirroring the existing `ensureSystemHealthLogTable` pattern (CREATE TABLE IF NOT EXISTS + both indexes, idempotent, runs in the background block of `seedDatabase()`). Confirmed on restart: `[agent-activity-log] Table + (user_id, created_at) + (event_type, created_at) indexes ensured`.
- **Ticket-flow status transitions now logged.** Five sites in `server/routes.ts` quietly flip `agentStatus` during the ticket workflow but weren't being recorded — meaning a VRS investigation of "why did my status change" would have blind spots whenever the trigger was ticket activity instead of a manual toggle or the idle timer. Added `safeLogActivity` at all five with a new `status_change_ticket_flow` event type and a `trigger` discriminator: `claim` (online→working), `process` (working→online), `process_nla` (working→online), `send_to_nla` (working→online), `correct_division_release` (working→online). Each row carries `submissionId` so we can trace the status change back to the exact ticket.
- **Admin endpoint param hardening.** `GET /api/admin/agent-activity` previously trusted `parseInt`/`parseFloat` output and could push `NaN` or negative numbers into the storage layer. Replaced with a zod `querySchema` (`userId` positive int, `eventType` ≤48 chars, `sinceHours` positive ≤720, `limit` positive int ≤1000) that returns `400 {error, issues}` on invalid input. Verified: `userId=abc` → 400, `limit=-5` → 400, `sinceHours=99999` → 400, valid call → 200.
- **Docs.** Added `status_change_ticket_flow` to the event-type taxonomy in `replit.md`.

### Added: Agent Activity Log — confirming auto-offline is firing for the right reasons (2026-05-20 afternoon)
- **Why:** Now that the auto-offline path lives on the client, we need an audit trail that proves it's firing for genuine 30-min idle and not (a) some new spurious trigger or (b) silent server-side path. Also lets us answer "why was I marked Unavailable at 2:14?" without guessing.
- **New table** `agent_activity_log` (id, user_id FK→users CASCADE, event_type varchar(48), details jsonb, created_at) with indexes on (user_id, created_at) and (event_type, created_at). Defined in `shared/schema.ts`. Migrated via raw SQL `CREATE TABLE IF NOT EXISTS` (idempotent — safe to run on prod). Append-only; nothing deletes from it.
- **Storage** (`server/storage.ts`): `logAgentActivity(data)` insert + `getRecentAgentActivity({userId?, eventType?, since?, limit?})` query that joins users for the agent name.
- **Wired into every status-change path:**
  - `POST /api/agent/auto-offline` → `auto_offline_fired` (success), `auto_offline_skipped_pending` (NLA/standard pending blocked), `auto_offline_skipped_not_online` (already offline). Each row captures request IP, user-agent snippet, and the client-sent `idleMs` (ms since last keyboard/mouse activity) — so we can prove the timer actually fired organically and isn't being hit by some script or stale tab.
  - `POST /api/agent/auto-offline-ack` → `auto_offline_ack` (modal "Stay Unavailable" dismissal).
  - `PATCH /api/agent/status` → `status_toggle_self` with `{from, to, clearedAutoOfflinedFlag}`. The flag-cleared bit tells us whether the user dismissed an inactivity prompt by going Available.
  - `PATCH /api/admin/users/:id/status` → `status_toggle_admin` with the admin actor's id and name attached (so VRS can tell admin overrides apart from agent self-toggles when reviewing the log).
  - WS presence-stale fallback (`server/websocket.ts`) → `presence_stale_cleanup` (browser closed >60min, agent flipped offline) and `presence_stale_skipped_pending` (fallback declined because of an open ticket). The `details` records stale-window minutes so future config changes are traceable.
- **All logging via `safeLogActivity()` helper** in `server/routes.ts`: any insert failure is logged to console and swallowed — a broken activity log will never break a status change.
- **Admin endpoint** `GET /api/admin/agent-activity` (admin/super_admin only) with filters: `?userId=N&eventType=...&sinceHours=N&limit=N` (sinceHours default 24, limit capped at 1000). Returns `{events: [{id, userId, userName, eventType, details, createdAt}], filters}` ordered DESC by createdAt. Sufficient for VRS to investigate any "I got bumped offline" report without engineering involvement.
- **Client `idleMs` body** (`agent-dashboard.tsx`): the auto-offline POST now sends `{idleMs: Date.now() - lastActivity}` so the server log captures the true wait time. Lets us catch a regression where the threshold gets accidentally lowered (idleMs would land suspiciously close to whatever broken value is being used).
- **Test-only URL overrides:** `?inactivityMs=N&checkMs=M` on the dashboard URL shorten the 30-min idle / 60-s check intervals for e2e tests. Both are clamped to the production maximum via `Math.min(N, prodDefault)` so a shipped build can't be weakened by anyone passing these params — server-side pending-ticket guards also still apply regardless of call cadence.
- **Tests (23 pass / 0 fail):**
  - Backend: every event type writes a row with correct details (fired+idleMs, skipped_pending+nlaPendingCount, skipped_not_online, ack, self toggle with from/to, admin toggle with adminUserId+name); GET endpoint returns rows + supports filters; non-admin gets 403; WS presence-stale code paths log both branches; client clamps overrides + sends idleMs.
  - **End-to-end (Playwright):** real browser logs in as ZZTEST9, goes online, navigates to `/agent/dashboard?inactivityMs=5000&checkMs=2000`, sits idle, and the modal appears + status flips to offline + the activity log row appears with `idleMsClient=6001` (proving the full client tracker → fetch → server log → modal chain works without any synthetic kicks).

### Fixed — Agents reporting toggle randomly flipping to Unavailable (2026-05-20)
- **Symptom (VRS report).** Zorn Jones at 10:02 AM: "VRS Express seems to randomly turn itself to Unavailable." Roger Imhoff at 09:49 AM: "my accepting calls keeps turning off not sure why about every 15 min or so."
- **Triage findings.** Prod logs across all of 5/20 showed **zero `auto-set offline` events** — the server-side grace was already catching every disconnect (Zorn dropped twice in 10 min, reconnected within 2s both times, grace cancelled). Direct DB check confirmed Zorn's row was `agent_status='online'` even while he was reporting being flipped. → the flip was **client-side UI only**, never reflected in the DB. So when the toggle visually went Unavailable, the agent was still routing tickets correctly server-side — but UX-wise they saw "Unavailable" and reasonably assumed they were cut off.
- **Direction from VRS.** UI must always reflect the backend — no client-side guards or blocks that could create a UI/DB mismatch. The only knob is the inactivity grace window.
- **Fix 1 — bump WS-inactivity grace 10 min → 30 min (`server/websocket.ts`).** "Inactivity" here = no live WebSocket session (browser closed / laptop asleep / network drop / autoscale instance rotation). Mouse and keyboard activity do NOT factor in; only the WS connection does. With 25s heartbeats and the client's `visibilitychange`/`focus`/`online` force-reconnect listeners (shipped 5/15), an active agent's tab reconnects within seconds — so raising the grace to 30 min costs nothing for the normal case but closes the remaining edge case of a 10-15 min laptop-suspend flipping the agent out from under a reconnecting browser. Detection of "agent actually went home" still works fine: the heartbeat detects socket death within ~30s and starts the timer; admin status view sees the eventual broadcast.
- **Fix 2 — diagnostic logging (`agent-dashboard.tsx`).** Every status transition flows through a thin `applyAgentStatus(next, source)` wrapper that logs `[diag][agent-status] <prev> → <next> (source: <X>)` to the browser console. Sources: `toggle-mutation`, `own_status_changed`, `connected-echo`, `visibility-refresh`, `user-query-mirror`, `claim-success`, `process-success-clear`, `process-success-resolved`, `nla-escalate`, `nla-resolved`, `division-corrected-rerouted`, `smartsheet-confirm`. **No blocking, no guards** — the wrapper just observes. Next time an agent reports the flip, DevTools will show exactly which path fired without speculation.
- **Fix 3 — "Were you marked Unavailable due to inactivity?" confirm modal.**
  - **Schema (`shared/schema.ts`).** Added nullable `autoOfflinedAt timestamp` column on `users`. Set when the 30-min grace timer fires; cleared on any explicit status toggle or ack.
  - **Server (`server/websocket.ts`).** The auto-offline grace timer now also stamps `autoOfflinedAt = now()` alongside `agentStatus = 'offline'`.
  - **Server (`server/routes.ts`).** `PATCH /api/agent/status` clears `autoOfflinedAt` on any explicit toggle (online or offline). New `POST /api/agent/auto-offline-ack` clears the flag without changing status — called by the modal's "No" answer. The WS `connected` payload and `GET /api/agent/status` both now include `autoOfflinedAt` so the client can detect "you were auto-offlined while away" on next connect.
  - **Client (`client/src/pages/agent-dashboard.tsx`).** When the WS `connected` echo arrives with `agentStatus='offline'` AND `autoOfflinedAt != null`, the existing status modal is forced open with revised copy: "You were marked Unavailable due to inactivity. Your connection was inactive for 30 minutes, so we set you to Unavailable. Want to go back online and start receiving tickets again?" with **Yes, Go Available** / **No, stay Unavailable** buttons. Yes → PATCH status=online (which also clears the flag). No → POST /auto-offline-ack to clear the flag so it doesn't re-prompt on every reconnect.
- **What this does NOT fix.** The architectural root cause — autoscale instance rotation causing fleet-wide 5-min WS drops — is unchanged. Reserved VM migration remains the structural fix, still deferred pending billing sign-off.

### Fixed — Service Order History empty on brand-new tickets until manual refresh (2026-05-20)
- **Symptom (VRS report).** Agent added a test ticket with a real service order number to verify the new SHSAI Service Order History link. Opened the ticket — history panel stayed empty. Refreshing the browser made it populate immediately. Same SO worked fine on existing tickets.
- **Root cause (`client/src/pages/agent-dashboard.tsx` line 802-809).** The SHSAI auto-fetch effect depended on `[selectedId, activeView, shsaiVisible]` — `submissionsData` was missing. The effect body calls `(submissionsData?.submissions || []).find((s) => s.id === selectedId)` to pull `serviceOrder` off the selected row. For a brand-new ticket the sequence is: (1) ticket created → `selectedId` changes → effect fires → list query hasn't refetched yet, `.find()` returns undefined → no fetch. (2) Moments later the list refetches and now contains the new row — but `submissionsData` wasn't a dep so the effect didn't re-run. Refreshing the page re-mounted the effect with the loaded list, which is why the manual refresh worked.
- **Fix.** Added `submissionsData` to the dep array. The existing `sub.id !== lastQueriedSubmissionId` guard prevents the new dep from causing duplicate SHSAI calls under the 60s background poll or WebSocket-triggered list refetches — after the first successful fetch per ticket selection, subsequent effect runs short-circuit on the guard.

### Added — `scripts/seed-test-ticket-from-prod.mjs` (2026-05-20)
- **Why.** Verifying the restored SHSAI Service Order History tab needs a dev ticket whose `service_order` actually has customer history in SHSAI's backend. The existing `scripts/seed-test-tickets.ts` uses synthetic `99999000xxx` SOs that SHSAI doesn't recognize, so the new tab would render an empty result on those.
- **What.** New `.mjs` script that reads the most recent completed ticket from `PROD_DATABASE_URL` (or a specific SO passed as argv[2]) and inserts a queued/claimable copy into `DEV_DATABASE_URL`. Idempotent — skips if a row with that service_order already exists in dev. Only non-PII columns are read from prod (service_order, proc_id, client_nm, district_code, appliance_type, warranty_type); customer name/phone/address live in SHSAI's data store and are fetched on demand by the agent dashboard, never copied into dev.
- **Tech tags.** Reuses the `test_tech_1` / `TEST_TECH_1` / `9999001` fixture conventions from `seed-test-tickets.ts` and tags the dev row's `issue_description` with `[TEST]` for easy cleanup (`DELETE FROM submissions WHERE issue_description LIKE '[TEST]%'`).
- **Usage.** `PROD_DATABASE_URL=... DEV_DATABASE_URL=... node scripts/seed-test-ticket-from-prod.mjs [SO]`.

### Restored — Service Order History tab (new Sears-hosted SHSAI) (2026-05-20)
- **Background.** On 2026-05-09 the upstream SHSAI service at `ais.tellurideplatform.com` (Telluride UAT) started returning 403 on every request. The Service Order History tab was hidden, the auto-fetch was disabled, and a notice banner was added telling agents a new source was being located (commit `307f514`).
- **New host discovered.** Tyler was given `https://shsai-routing-ui.prod.nextgen.shs.com/` as the new UI. Inspecting that UI's JS bundle revealed the new API host: `https://shsai-routing-assist.prod.nextgen.shs.com/tell/api/hs/routing/v1`. Path structure (`/init`, `/sse/assist`, `/prompt`, …) is unchanged from the old Telluride API — only the host moved.
- **Server (`server/services/shsai.ts`).** One-line change: `SHSAI_BASE_URL` swapped from `ais.tellurideplatform.com/tell/api/hs/routing/v1` to `shsai-routing-assist.prod.nextgen.shs.com/tell/api/hs/routing/v1`. No contract changes: `/init` still returns `{status, thread_id, session_id}` (session_id read from response body via existing fallback because the new host does not echo it back as a `sessionid` response header), `/sse/assist` still streams `{"type":"TEXT","content":"..."}` SSE chunks terminated by `{"type":"STATUS","content":"COMPLETE"}`. End-to-end probe with a real SO# returned a populated customer-history response in ~7s.
- **Client (`client/src/pages/agent-dashboard.tsx`).** Reverted the 2026-05-09 hide:
  - Default `rightPanelView` back to `"shsai"`; persisted-preference effect honors saved `"shsai"` again instead of demoting it to `"calculator"`.
  - Re-enabled the auto-fetch useEffect — opening any non-NLA ticket fires `fetchShsaiData(serviceOrder, id)` once per submission (`lastQueriedSubmissionId` guard prevents duplicate fetches).
  - Removed the amber "Service Order History is currently unavailable" banner (`data-testid="banner-shsai-unavailable"`).
  - Restored the `<TabsTrigger value="shsai">` Service Order History tab in the right-panel tab strip.
  - Restored the per-tab refresh button (`data-testid="button-shsai-refresh"`) — only renders when the SHSAI tab is active.
- **Verification.** `npm run check` shows the same 45 pre-existing baseline errors; zero new errors from this change. End-to-end curl probe against the new host hit `/init` → `/sse/assist` → fully streamed markdown response in ~7s.

### Fixed — Agents flipping offline all day (WebSocket churn under autoscale) (2026-05-15)
- **Symptom (VRS report).** "VRS Express keeps flipping techs offline." Prod logs over a 3-hour window showed ~100 actual `agent_status='offline'` auto-flips concentrated on ~25 repeat-offender agents (Damian Mueller 8x, William Smith 7x, Israel Carrasco 6x, Michael Prefontaine 5x, Brandon Brownlee 5x, Maneul Quinones 5x, …), plus a constant background of 1-3 second disconnect/reconnect churn that mostly self-cancelled inside the grace window.
- **Root cause (architectural, unfixed in this PR).** Deployment runs as `autoscale` (`.replit` `deploymentTarget = "autoscale"`). Autoscale aggressively cycles backend instances; every migration kills every WebSocket on that instance simultaneously. With ~25 agents online, one scaler event = 25 simultaneous reconnects. Migrating to a Reserved VM deployment would eliminate this root cause but requires a billing change — flagged to user, not done here.
- **Root cause (client-side, fixed).** `client/src/lib/websocket.ts` reconnected via exponential backoff capped at 30s but had **no `visibilitychange`, `focus`, or `navigator.onLine` listeners**. Browsers throttle `setTimeout` to ~1 fire/min in backgrounded tabs, so a socket killed during an autoscale event while the agent's tab was backgrounded could take many minutes to retry — long enough to blow past the server's 5-min auto-offline grace.
- **Fix A — client (`client/src/lib/websocket.ts`).** Added module-level `visibilitychange` (visible), `window.focus`, and `window.online` listeners that call a new `forceReconnectIfDead()` helper. The helper no-ops if `ws` is OPEN or CONNECTING; otherwise cancels the pending backoff timer and immediately calls `connect()`. Importantly, it **does not reset `reconnectAttempts`** — that still resets only on a successful `ws.onopen` — so repeated visibility/focus events against a genuinely down server cannot create a connect storm; the next failed attempt falls back into exponential backoff naturally. SSR-safe via `typeof window !== 'undefined'` guard. Listeners are intentionally not removed (module singleton, lives for app lifetime).
- **Fix B — server (`server/websocket.ts`).** Bumped `AUTO_OFFLINE_GRACE_MS` from 5 min to 10 min. Absorbs the residual cases where backgrounded-tab throttling + autoscale migration combine to exceed 5 min before the client's new force-reconnect listeners can fire. Trade-off: agents who actually went home stay "Available" up to 10 min before the auto-flip, but the heartbeat-driven socket termination (25s ping, terminate-on-no-pong) and the explicit close handler still detect real session loss within ~30-60s of socket death — the 10-min timer only fires when there is *zero* active session, so admin status / queue routing accuracy is unaffected for active agents.
- **Coverage.** Both auto-offline triggers (no live sessions after explicit `ws.close`, and heartbeat termination) flow through the same `setTimeout(…, AUTO_OFFLINE_GRACE_MS)` path. Visibility/focus/online events on the client all funnel through one helper. Architect review flagged "connect storm via reset reconnectAttempts" as Medium — addressed before commit.
- **Deferred.** Migration `autoscale → Reserved VM` deployment type is the structural fix; tracked separately pending user sign-off on the billing change.

### Fixed — Admin Ticket Overview stayed pending up to 60s after completion (2026-05-15)
- **Symptom (VRS report).** Admin watched a ticket showing pending status with a live "Handle Time" counter ticking past 58 minutes; on manual page refresh the same ticket was already completed. The row was stale — completion never pushed to the admin in realtime.
- **Root cause.** Admin's `/api/submissions` query polls every 60s with a 45s staleTime (intentionally throttled in the 2026-05-05 perf pass that traded poll frequency for WebSocket coverage). The admin dashboard subscribed to `new_ticket`, `ticket_queued`, `pending_tickets`, `ticket_claimed`, `ticket_assigned`, and `resubmission_received` — but **no completion event**. Server side, `/api/submissions/:id/process` (the regular VRS completion path) never broadcast `ticket_updated` to admins at all; `/process-nla` did broadcast it, but the admin had no listener. Either way: completions were invisible until the next 60s poll fired, leaving the row "still pending" with the live handle-time counter ticking up.
- **Fix — server (`server/routes.ts`).** Added a `broadcastToAdmins({ type: "ticket_updated", payload: { submissionId, ticketStatus } })` at the end of `/process` (~line 1948), inside the existing post-commit best-effort `try/catch` so a websocket failure cannot 500 a route whose DB row is already committed. Mirrors the `/process-nla` pattern that has been in place since the NLA work.
- **Fix — client (`client/src/pages/admin-dashboard.tsx`).** Added a silent `subscribe("ticket_updated", ...)` listener (~line 2654) that invalidates both `/api/submissions*` and `/api/admin/analytics` caches. Silent (no toast/sound) — admins don't need to be paged on every completion, just kept in sync. Cleanup `unsub9()` added to the effect teardown.
- **Coverage.** Both terminal-transition routes (`/process` for `completed`/`rejected`/`invalid`, `/process-nla` for the eight NLA actions) now push `ticket_updated`. Non-terminal transitions (claim/assign/queue/reassign/send-to-nla) were already covered by existing subscribed events. Architect code review confirmed no other route can move a ticket to a terminal status without emitting a realtime admin event.

### Changed — Coaching report groups duplicate new tickets per rejection + clickable IDs (2026-05-15)
- **Problem.** When a tech filed multiple brand-new tickets for the same SO after one rejection (instead of using resubmit), the original `LAG()`-based query only surfaced the FIRST offending new ticket — subsequent duplicates were silently dropped because their immediate predecessor was the previous NEW ticket (status `queued`/`pending`/etc.), not the original rejection. VRS asked to "show ALL the SO# in resubmissions column so we can locate and coach on all," and to make them clickable. Confirmed in prod: tech 144 / SO 7108-13659589 / prev=545 has 2 duplicate new tickets that the old report collapsed to 1 visible row.
- **Backend (`server/storage.ts`).** Replaced the `LAG()` window with a `LATERAL` lookup: for every NEW ticket (`resubmission_of IS NULL`) in the window, find the most recent prior `rejected`/`rejected_closed`/`invalid` row on the same `(technician_id, service_order)`. Then `GROUP BY (technician, SO, prev_id)` and `jsonb_agg(...)` all the new tickets that chain back to the same rejection. Return shape now exposes `newTickets: { id, status, at, minutesAfter }[]`, `newCount`, and `latestNewAt` instead of a single flat `newId`/`newStatus`/`newAt`. The 90-day lookback backstop is gone — the lateral subquery scans the full SO history for that tech, so a coaching event no longer gets dropped at the window boundary.
- **Frontend (`client/src/pages/admin-dashboard.tsx`).** `CoachingDuplicate` interface updated to match. New Tickets column now stacks one row per new ticket with badge + timestamp + per-ticket "+gap" (minutes/hours/days since the rejection). Both the Previous (red) badge and every New (outline) badge are now buttons that open the existing admin ticket detail dialog via `setSelectedTicketId(...)`. When a coaching case has 2+ duplicates, an amber "N duplicate new tickets" eyebrow appears above the stack so the magnitude is impossible to miss.
- **Verification.** Dev endpoint returns the new shape (`{ days, rows: [] }`) and renders without errors. New SQL validated end-to-end on the production read replica: 20 well-formed grouped cases for the last 90 days, including the 2-duplicate case for tech 144 that the old query suppressed.

### Audit — SO 8035-13723638 timing breakdown (2026-05-15)
- **Read-only prod query** to deep-dive the lifecycle of submission #1330 (SO 8035-13723638, Will Taylor / wtayl21, AHS cooking authorization, claimed by Zorn Jones / ZJONES5). All times stored UTC; ET = UTC−4 (EDT, May 15).
- **Timeline.**
  - 13:11:03.644 UTC (09:11:03 ET) — tech submitted (`created_at`).
  - 13:11:10.115 UTC (09:11:10 ET) — Zorn claimed (`claimed_at`). Queue wait = **6.5 seconds** (essentially instant — empty queue).
  - 13:14:28.631 UTC (09:14:28 ET) — Stage 1 approved (`submission_approved_at` / `stage1_status='approved'`). Stage-1 review = **3 min 18s** after claim.
  - 13:47:36.261 UTC (09:47:36 ET) — Stage 2 / final completion (`status_changed_at` / `reviewed_at` / `stage2_status='approved'`, ticket_status `completed`, auth code `150ZNJS`). Stage-2 wait = **33 min 7s** after Stage 1.
  - **Total handle time (claim → done): 36 min 26s. Total ticket lifetime (submit → done): 36 min 32s.**
- **What the agent did.** Per `agent_notes`: *"VRS AUTHREP REVIEW. Worked in App. AHS auth 150ZNJS trip/diag only $150.00 → RGC33296 AHS denied repair for glass cooktop (crack due to negligence). Customer would have to pay for call."* Translation: Zorn approved Stage 1 in ~3 minutes (good), then spent ~33 minutes working AHS to a final disposition — AHS denied the repair (negligence — cracked glass cooktop) and only authorized the $150 trip/diag fee. The 33-minute Stage-2 gap is **not idle time**, it's the agent on the phone / in the AHS portal getting a denial reversed/scoped down to a partial auth.
- **Other signals.** No SMS rows in `communication_send_audit` or `sms_notifications` for submission_id=1330 (the tech apparently was not notified via SMS, or notifications used a different path). Single ticket — no resubmissions, no rejections, no NLA escalation. No reassignment.
- **Conclusion.** Healthy ticket end-to-end. The "long" portion of the 36-minute lifetime was external dependency on AHS, not VRS bottleneck. Pure VRS-controlled time was ~3.5 minutes (claim + Stage 1).

### Fixed + Changed — Admin Analytics hierarchy + Coaching report invisible in prod (2026-05-15)
- **Coaching report was invisible in production.** The new "Coaching: New ticket after rejection" card never rendered because its custom `queryFn` was reading the auth token from `localStorage.getItem("token")` — but this app stores it under the key `vrs_token` (see `client/src/lib/auth.tsx`). Result: every request went out unauthenticated, hit 401, the query stayed `undefined`, and the `{coachingData && (...)}` guard hid the whole card. Verified the rest of the codebase consistently uses `vrs_token`.
- **Fix (`client/src/pages/admin-dashboard.tsx`).** Swapped the localStorage key in the coaching `queryFn` to `vrs_token`. One-character bug, complete invisibility — classic.
- **Reorganized admin Analytics view for "key sections first."** New top-down hierarchy with section headings (uppercase eyebrow + one-line subtitle):
  1. **Volume** — submissions counts grid + NLA Parts card
  2. **Quality Signals** — Resubmission Rate Tracking + Coaching: New ticket after rejection (moved up from below Export — these are the actionable management reports)
  3. **Performance** — Approval Rate + Processing Times grid
  4. **Breakdown** — District-Level Rollup
  5. **Tools** — Export Tickets (moved from middle to bottom — it's a utility, not a metric)
- **No data/logic changes** — the queries, cards, and rendered content are byte-identical. Pure JSX reorder + 5 heading blocks.

### Changed — Admin Ticket Overview table fits in one view (2026-05-15)
- **Problem.** The 11-column ticket overview table overflowed horizontally — admins couldn't see Total Time without scrolling. Verbose headers ("Service Order", "Intake Form Complete", "Last Updated", "Queue Wait", "Handle Time", "Total Time", "Assigned To", "Technician") consumed the width.
- **Fix (`client/src/pages/admin-dashboard.tsx`).** Shortened headers (Service Order→SO #, Assigned To→Assigned, Technician→Tech, Intake Form Complete→Intake, Last Updated→Updated, Queue Wait→Queue, Handle Time→Handle, Total Time→Total). Full names preserved as `title` tooltips. Compacted the table with `text-xs` + `[&_th]:px-2 [&_td]:px-2`, dropped SO column from 140px→110px, added `whitespace-nowrap` to header buttons so sort labels don't wrap on clicks.
- **Bonus warranty mapping fix.** The Warranty column was rendering raw `american_home_shield` (visible in the bug screenshot) — only `ahs` was mapped. Added the alias in both the ticket overview row (`~1466`) and the ticket detail dialog (`~602`) so both values render as "AHS" everywhere admins see warranty data. Architect code review caught the second site after only the first was patched.
- **Sort handlers, test IDs, conditional Actions column — all unchanged.** Pure visual compression.

### Added — Resubmission Coaching admin report (2026-05-15)
- **Surfaces techs who submit a brand-new ticket for the same service order after a rejection** (instead of using the proper resubmit-after-rejection flow). VRS reported this pattern was hard to spot; ad-hoc prod queries earlier today found 20+ real cases in the last 30 days (e.g. Eric Kennedy submitted a fresh ticket 26 minutes after his rejection on SO 7084-13719960; Steven Harrington did it 6 days later on SO 8096-13694856).
- **Detection logic.** A coaching pair = same `(technician_id, service_order)` where the immediately-prior row was terminal (`ticket_status IN ('rejected','rejected_closed','invalid')`) and the next row has `resubmission_of IS NULL` (= tech hit "Submit New Ticket" instead of the resubmit flow). Implemented as a `LAG(...) OVER (PARTITION BY tech, SO ORDER BY created_at)` window in PostgreSQL.
- **Backend.** New `IStorage.getCoachingDuplicateSubmissions(days)` in `server/storage.ts` and `GET /api/admin/analytics/coaching-duplicates?days=N` in `server/routes.ts` (admin/super_admin, days clamped 1–365, default 30, hard `LIMIT 500`). Inner CTE expands lookback by 90 days so a "new" ticket inside the requested window can still find a prior rejection that occurred just before the window opens — without that backstop, `lag()` would return NULL at the boundary and silently miss real cases. Returns `{ days, rows[] }` with techName, techLdap (rac_id), serviceOrder, previousId, previousStatus, previousAt, newId, newStatus, newAt, minutesBetween.
- **Frontend.** New "Coaching: New ticket after rejection" card in the admin Analytics view (`client/src/pages/admin-dashboard.tsx`), placed between Resubmission Rate Tracking and District-Level Rollup. Window selector (7/14/30/60/90 days), case count, and a flat sortable table — Tech, LDAP, SO, Previous (red badge + timestamp), New (timestamp), Gap. Uses an explicit `queryFn` because the default fetcher does `queryKey.join("/")`, which would have made the URL `/api/admin/analytics/coaching-duplicates/30` instead of `?days=30`.
- **Verification.** Endpoint smoke-tested end-to-end on dev (auth 401 without token, days clamping at 999→365, valid 200 with seeded-empty `rows: []`); SQL verified on production read-replica returning 20 well-formed coaching pairs with correct tech name + LDAP joins. Architect code review caught and resolved the queryFn URL bug and the lag-window boundary issue before ship.

### Removed — Dead/legacy code sweep (2026-05-15)
- **Codebase audit + targeted removal of confirmed-dead exports** (zero references via ts-prune + ripgrep). No behavior change.
- `server/sms.ts` — Removed `buildResubmissionClaimMessage` (already noted obsolete in `server/routes.ts:46` since the resubmission routing change on 2026-05-06 — resubmissions enter the queue and the standard claim SMS fires when an agent claims).
- `server/routes.ts` — Removed the now-stale comment that referenced the deleted helper.
- `server/websocket.ts` — Removed unused exports `getConnectedClient` and `isAgentConnectedAndOnline` (never imported anywhere; `getOnlineAgentCount` is the live one).
- `client/src/lib/business-hours.ts` — Pruned re-exports with zero consumers: `VRS_OPEN_HOUR_ET`, `VRS_CLOSE_HOUR_ET`, `getBusinessElapsedFromNow`, `DEFAULT_PROFILE`, `DEFAULT_HVAC_PROFILE`, `DayKey`, and the unused hook `useBusinessHoursProfile`. The dashboards' actual imports (`getBusinessElapsedMs`, `formatBusinessElapsed`, `useBusinessHoursConfig`, `categoryForApplianceType`, `BusinessHoursProfile`, etc.) are preserved.
- `shared/business-hours.ts` — Removed the deprecated `VRS_OPEN_HOUR_ET` / `VRS_CLOSE_HOUR_ET` constants AND the unused `getBusinessElapsedFromNow` function (the only consumer was the client re-export above; removed in tandem).
- **Intentionally NOT removed** (safety per `replit.md`): `server/seed.ts` one-time migration guards, `shared/schema.ts` insert schemas/types (public surface), `client/src/components/ObjectUploader.tsx` + `client/src/hooks/use-upload.ts` (documented helpers from the `javascript_object_storage` integration template — kept as building blocks), and intentional structured `console.log` audit lines in `routes.ts` / `websocket.ts`.
- **Verification.** `tsc --noEmit` shows only the pre-existing errors that predate this sweep (none reference any removed symbol). Workflow restarted clean. `rg` for every removed identifier returns zero hits.

### Fixed — Agent NLA escalate killed by edge HTML 403 + shared retry helper (2026-05-11)
- **Zorn (NLA agent) tried to escalate an NLA ticket to a P-Card agent (action `nla_escalate_to_pcard`, SO 8380-13547409) and got "Processing Failed" with the body = Replit's edge-proxy HTML 403 page (`<!doctype html>…<title>403</title>403 Forbidden`).** Same edge-flake we already self-heal on tech submissions earlier today — but the agent dashboard's `nlaProcessMutation` (and `processMutation`) called bare `apiRequest` with no retry, so a single edge blip killed Zorn's escalate.
- **Extracted shared retry helper (`client/src/lib/queryClient.ts`).** New exports: `isTransientApiError(msg)` detects HTML 403/5xx pages, `Failed to fetch`, `NetworkError`, generic 5xx; `apiRequestWithRetry(method, url, data, {maxAttempts=3, logTag})` wraps `apiRequest` with 800ms / 1600ms exponential backoff. JSON 4xx errors (real validation failures from our app) are NOT retried — caller still sees the actual message immediately.
- **Wired `apiRequestWithRetry` into 4 mutations:**
  - `client/src/pages/agent-dashboard.tsx` :: `nlaProcessMutation` (the failing path — Zorn's escalate)
  - `client/src/pages/agent-dashboard.tsx` :: `processMutation` (same vulnerability for AUTH approve/reject — silent fix before VRS hits it on a different ticket)
  - `client/src/pages/tech-submit.tsx` :: `mutation` — DRY refactor of the inline copy from earlier today
  - `client/src/pages/tech-resubmit.tsx` :: `mutation` — same DRY refactor
- **Why retrying a non-idempotent PATCH is safe here.** `/process` and `/process-nla` use `updateSubmissionIfStatus` (status-conditional UPDATE on the DB). If a first attempt succeeded but the response was lost at the edge, the retry finds the ticket no longer in `pending` status and returns JSON `409 STALE_STATUS` — not a duplicate side effect (no double SMS, no double assignee flip, no double WS broadcast). The user sees a readable "ticket has changed" toast instead of the confusing edge HTML. POST `/api/submissions` is similarly protected by 60s `(tech, SO#)` idempotency at `routes.ts:~590`.
- **Verification.** Workflow restarted clean. End-to-end smoke through the new wrapper path: NLA action route reachable, returns 200, no edge HTML 403 thrown by the wrapper, no functional change for non-transient cases.

### Fixed — Agent stuck "Working" after sending ticket to NLA (2026-05-11)
- **VRS reported Rob Seda took an authorization call, switched it to NLA, Zorn Picked up the NLA ticket — but the app still showed Rob as "Working" and blocked him from going Unavailable with "You have an open ticket. Complete it or ask an admin to reassign it."** Root cause: `/api/submissions/:id/send-to-nla` (`server/routes.ts`) cleared the ticket's `assignedTo` and flipped `requestType=parts_nla` so the ticket correctly left Rob's queue, but the route never restored Rob's `users.agent_status` from `working` back to `online` — every other "I'm done with this ticket" path (`/process`, `/process-nla`, `/correct-division` release branch) does this. Result: Rob's UI toggle stayed locked on Working, and any concurrent non-NLA ticket landing in his lap (e.g. a fresh claim or a race-window write) would have left the offline check blocking him.
- **Fix (`server/routes.ts:2700`).** After a successful send-to-nla, when the actor is a `vrs_agent`, the route now updates `agentStatus = "online"`, fires `updateClientStatus`, broadcasts `agent_status_changed` to admins + `own_status_changed` back to the agent, and refreshes `broadcastVrsAvailability`. Wrapped in best-effort try/catch so a status-update hiccup can't 500 a route that already moved the ticket. Admins keep their independent status flow. Mirrors the canonical pattern at `routes.ts:1853` (`/process`) and `:2261` (`/process-nla`).
- **Verification.** End-to-end programmatic test: agent claims auth ticket → `agent_status='working'` ✓, agent sends to NLA → `agent_status='online'` ✓, agent immediately able to toggle Unavailable without the popup ✓.

### Added — Tech submission self-heal on transient edge errors + entry logging (2026-05-11)
- **Field tech (Mike, AHS, "All Other", SO 8420-13676372) hit "Submission Failed" on Confirm & Submit** with a body that was Replit's edge-proxy stock HTML 403 page (`<!doctype html>…<title>403</title>403 Forbidden`). Crucially, the corresponding `POST /api/submissions` never appeared in the deployment logs — meaning the request was rejected at Replit's edge layer before reaching Express. Our app's own 403s are all JSON.
- **Client self-heal (`client/src/pages/tech-submit.tsx` + `tech-resubmit.tsx`).** The submit/resubmit mutations now retry POST `/api/submissions` up to 2 extra times with 800ms / 1600ms backoff when the error looks transient: edge-proxy HTML 403/5xx pages, `Failed to fetch` network errors, or generic 5xx. JSON 4xx errors (real validation failures from our app) are not retried — the tech still sees the actual message immediately. **Safe by construction**: the server already enforces 60s (tech, SO#) idempotency at `server/routes.ts:~590` via `storage.createSubmissionWithIdempotency`, so a retry that races with a successful first attempt returns the existing row without a duplicate insert or duplicate `submission_received` SMS.
- **Server entry-point logging (`server/routes.ts`).** Added a tiny pre-route middleware that fires for every `POST /api/submissions` and logs `[submit-entry] reached Express auth=present|MISSING content-length=… ua="…"` BEFORE `authenticateToken` runs. Next time a tech reports an HTML 403, we can grep for `[submit-entry]` to definitively answer "did the request hit Express, or was it killed at the edge?"  No body, no PII, only headers — keeps the logs grep-friendly without bloating them.

### Fixed — Two agents working the same ticket (2026-05-11)
- **VRS reported "last week we had two agents working the same ticket — can that be looked into."** Audited every write path that touches `submissions.ticketStatus` / `assignedTo`. The atomic claim path (`storage.claimSubmission`) is solid — single `UPDATE … WHERE ticketStatus='queued'` makes the claim race-safe and the loser already gets 409. The bugs were on the **process / reassign / send-to-nla** paths, all of which had time-of-check vs time-of-write windows where two agents could each commit a write the other never saw.
- **Closed the assignee TOCTOU on `/process` and `/process-nla` (server/routes.ts).** The optimistic-lock guard added 2026-05-01 only checked status. So if an admin reassigned a still-pending ticket from agent A → agent B between A's `getSubmission` read and A's UPDATE, A's write still won (status was still `pending`). Both agents then thought the ticket was theirs: B got the `ticket_assigned` toast, A's open detail pane completed it. Now `updateSubmissionIfStatus` accepts an optional `expectedAssignedTo` and the route passes it for `vrs_agent` actors — admins keep their long-standing intentional ownership-bypass. Stale assignee → 409 with code `STALE_STATUS` and refresh prompt.
- **Closed the status race on `/api/submissions/:id/reassign` (server/routes.ts).** Was an unconditional `updateSubmission(id, …)` after a read-time status check. Could clobber a ticket the assignee had just `/process`'d in the read→write gap, re-surfacing a finished ticket as `pending` in the new agent's queue (the cleanest reproduction of "two agents working it"). Both branches (reassign-to-agent and reassign-back-to-queue) now go through `updateSubmissionIfStatus(id, ["queued","pending"], …)`. Stale → 409.
- **Closed the same race on `/api/submissions/:id/send-to-nla` (server/routes.ts).** Same unconditional UPDATE pattern — could overwrite a ticket the assigned agent had just resolved. Now status-conditional on `pending` and (for non-admin actors) also pinned to the actor's user id, so a concurrent admin reassign cannot be silently overwritten either.
- **Closed the same race on `/api/submissions/:id/correct-division` (server/routes.ts) — caught during post-fix audit.** Both branches (keeps-ticket and release-ticket) used unconditional `updateSubmission`. The release branch is the dangerous one: it sets `assignedTo=null + ticketStatus='queued'`, which overlaps with `/reassign`'s columns. A vrs_agent landing this UPDATE after an admin had reassigned the ticket would silently un-reassign and re-queue it. Now both branches use `updateSubmissionIfStatus(["pending"], …, expectedAssignedTo)` — vrs_agent actors pin their own id; admins keep ownership-bypass. Verified with reverse-timing race test (15/15 stale writes blocked).
- **Storage helper extended (server/storage.ts).** `updateSubmissionIfStatus` now takes an optional `expectedAssignedTo` argument: `undefined` = don't check, `null` = "must still be unassigned", number = "must still be assigned to this user". The check is lifted INTO the UPDATE WHERE clause so the database (not application code) is the source of truth for the race.
- **DB review.** Queried 30 days of `submissions`, `sms_notifications`, and `communication_send_audit` for evidence: zero duplicate `ticket_claimed` SMS sends, zero distinct stage1/stage2 reviewers on the same ticket, zero non-test rows where `assigned_to <> reviewed_by`. The reported VRS incident is rare in practice but reproducible from the code paths above — the fix narrows all three windows to a single atomic write.

### Fixed — Agent status desync between agent UI and admin view (2026-05-09)
- **VRS reported agents (e.g. Robert Jones) showing "Available" on their own dashboard while admin saw them as "Unavailable".** Root cause: any WS disconnect (laptop sleep, Wi-Fi blip, browser tab backgrounded long enough for the socket to drop) immediately flipped the agent's DB `agentStatus` to `offline` and broadcast `agent_status_changed` to admins, but the agent's own UI still showed local React state `"online"` and got no notification of the flip. After auto-reconnect, the server-side in-memory `client.agentStatus` was also `offline`, so `broadcastToDivisionAgents` skipped them and they silently stopped receiving new tickets.
- **Fix 1 (server/websocket.ts) — 5min grace window before auto-offline.** Brief disconnects no longer cost an agent their status. On WS close we `setTimeout` the offline flip; on (re)connect we cancel any pending timer for that user. Window bumped from initial 30s to 5min on 2026-05-11 — VRS confirmed they want agents to stay Available through backgrounded tabs, laptop-lid close/reopen, mobile browser throttling, and Wi-Fi roams since the desktop + audio notification fires regardless of which tab is focused. Truly closed browsers / machines asleep > 5min still go offline as before. Tracked in `pendingOfflineTimers: Map<userId, NodeJS.Timeout>`.
- **Fix 2 (server/websocket.ts + client/src/pages/agent-dashboard.tsx) — `connected` payload echoes authoritative DB `agentStatus`.** New `connected` subscription on the agent dashboard syncs `localAgentStatus` from the payload on every (re)connect so the toggle can never silently disagree with the DB / admin view. If the agent really did get past the grace window and was auto-offlined, the toggle now flips back to gray "Unavailable" automatically without a page refresh — no more lying UI.
- **Fix 3 (2026-05-11) — refetch authoritative status on tab refocus.** Added a `visibilitychange` + `focus` listener on the agent dashboard that hits a new lightweight `GET /api/agent/status` endpoint whenever the tab regains focus. Closes the last edge case caught by e2e testing: if a backgrounded tab's WebSocket was killed by the 25s heartbeat and an admin flipped the agent's status from the Live Agent Status table during that window, the `own_status_changed` broadcast had no live session to deliver to. Now, the moment the agent looks at the tab again, the toggle reconciles against the DB. Skipped when `isAdminViewing` so admin shadow-views don't overwrite their own status.

### Added — Admin ticket detail now shows tech + agent notes from prior resubmissions (2026-05-09)
- **Admin's Ticket Detail dialog** now surfaces (1) the technician's `appealNotes` for the current row (resubmission "what changed" comments) and (2) a "Previous Submissions in this Thread" section listing every prior submission in the SO# resubmission chain with that ticket's tech issue description, tech appeal notes, rejection reasons, message-to-tech, internal agent notes, invalid reason, reviewer name, and timestamp. Mirrors the context agents get on the Previous Rejection card so admins reviewing a ticket no longer have to bounce between rows. Backed by extending `GET /api/admin/submissions/:id/audit` to include `priorSubmissions` (root + all rows whose `resubmissionOf` points at the root, current excluded). User name lookup expanded to cover prior reviewers.

### Changed — Agent Status page sorts Available agents to the top (2026-05-09)
- **Live Agent Status table now sorts by status**: Available (green) → Working (yellow) → Unavailable/offline (gray). Within each bucket, alphabetical by name for stable ordering across WebSocket-driven refreshes. VRS requested this so an admin can see who's pickable at a glance during peak. Single `useMemo` sort in `admin-dashboard.tsx` `AgentStatusSection`.

### Added — After-hours paper-close advisory in tech submission SMS (2026-05-09)
- **After-hours `submission_received` SMS now explicitly tells the tech to fall back to the paper close process** so they don't stand by at the site waiting on VRS. Appended to all three after-hours variants (standard / external-warranty / NLA) in `server/sms.ts`. Also added to the `normalizeLegacyAfterHoursSubmissionCopy` helper so admin-edited templates without the line still get it appended (idempotent — skipped if the template author already wrote it in).
- **Confirmed agents and admins are NOT blocked from working tickets after hours.** Audited `/api/submissions/:id/claim`, `/process`, and `/process-nla` — none has a business-hours gate. The 24h intake-form claim gate was removed 2026-04-26 (ADR-013) and the only remaining checks are role / assignment / status / division.

### Fixed — Same SO# on a different day no longer blocked (2026-05-09)
- **Tech submissions for a service order that already has a queued/pending ticket from a previous day are now allowed.** VRS reported techs getting `409 "you already have a submission in the queue"` on day-2 visits when yesterday's ticket hadn't been processed before agent shift-end. The duplicate-block in `hasActiveSubmissionForServiceOrder` (`server/storage.ts`) now only fires when the prior queued/pending submission was created on the **same calendar day**. Different calendar day → pass through. Same-day double-tap protection (and the 60s silent idempotency window) is preserved.

### Performance — In-process LRU cache for GCS object metadata (2026-05-09)
- **Added a 5000-entry / 10-minute LRU cache for object-storage metadata** (`server/replit_integrations/object_storage/objectStorage.ts`). After the prior 3-RPC → 1-RPC collapse (commit 711c4d9), each `/objects/*` request still paid one `file.getMetadata()` GCS round-trip. Photos in this app are immutable (uploaded once via signed URL to `/uploads/<uuid>`, never overwritten) so the `[size, contentType, etag]` triple is safe to cache. Net effect: a 12-photo Ticket Detail dialog reopen drops from 12 GCS RPCs to **0** on warm cache, and the dialog opens roughly instantly. Cache hits also free Node event-loop slots that were previously blocked on metadata RPCs — directly addresses the "lag during peak review" reports. Capacity bound is ~500KB. ETag/304 conditional-GET behavior is preserved.

### Changed — Service Order History (SHSAI) tab hidden with unavailable notice (2026-05-09)
- **Hidden the "Service Order History" tab in the agent right-panel** because the upstream SHSAI service (`https://ais.tellurideplatform.com/tell/api/hs/routing/v1/init`) is returning 403 Forbidden on every request — confirmed by direct curl from the Replit network and by the `/api/shsai/query 500` errors flooding the workflow logs (Hamed report 2026-05-09). Likely an IP-allowlist change or credentials change on Telluride's side; not fixable from our app.
- **Added an amber notice banner** above the right-panel tab strip that reads *"Service Order History is currently unavailable. The previous source is no longer working — a new source for service order history is being located."* The banner sits above the Calculator and Intake Form tabs so it's visible regardless of which tab is active.
- **Default landing tab switched from `shsai` → `calculator`.** Saved per-user `localStorage` preferences of `"shsai"` are migrated to `"calculator"` on hydrate so existing users don't land on a hidden tab.
- **Disabled the auto-fetch** that previously fired `/api/shsai/query` on every ticket selection — was producing one 500 server error per ticket open. The `fetchShsaiData` function and `TabsContent value="shsai"` block remain in source so we can quickly restore once a replacement source is wired up.

### Security — Hardened `/api/submissions/:id/history` agent gating (2026-05-09)
- **`GET /api/submissions/:id/history` now enforces the same vrs_agent assignment / division / queued-NLA-specialization gating as `GET /api/submissions/:id`.** Previously the history route only blocked non-owner technicians; any authenticated `vrs_agent` could enumerate IDs and pull full submission chains (including `agentNotes`, `auditTrail`, `rejectedMedia`, etc.) for tickets in other queues or other divisions. Surfaced by architect review of the Internal Agent Notes change below — that change deliberately consumes `agentNotes` in agent UI, raising the practical sensitivity of the gap. Logic mirrors lines 1055-1078 of the single-submission route (server/routes.ts).

### Added — Internal Agent Notes visible to other agents on resubmissions and NLA P-Card escalations (2026-05-09)
- **Resubmission "Previous Rejection" card now shows the prior reviewer's `agentNotes`.** When an agent claims a resubmission, the red "Previous Rejection" panel previously showed only rejection reasons, the customer-facing technician message, and the reviewer's name — but NOT the prior reviewer's internal notes. Hamed's feedback (2026-05-09 screenshot) flagged that admins could see these notes in the audit trail but agents could not, so the next reviewer re-evaluated blind to context the original reviewer left for them. Now `priorRejection.agentNotes` is surfaced in both the standard auth-ticket "Previous Rejection" panel AND the NLA "Previous Rejection" panel under a clearly labeled "Internal Agent Notes" subhead. Wired through the existing `priorRejection` memo (`client/src/pages/agent-dashboard.tsx`) so no API change.
- **NLA P-Card escalation pickup now shows the escalating agent's internal notes.** The "Pre-Filled by Research Agent" block in the NLA P-Card pickup form previously displayed the resolution, part number, and tech-facing message — but not the `agentNotes` the escalating research agent wrote in their Internal Notes textarea before escalating (the literal scenario in Hamed's screenshot: "Sam Jones, Ready for P-card order"). The P-card tech now sees those notes in the same block, immediately above their own additional-instructions and internal-notes fields.
- **`/process-nla` no longer null-overwrites escalation notes on P-card confirm.** When the P-card tech confirms via `nla_pcard_confirm` and leaves their own Internal Notes textarea blank, the route now preserves the escalating agent's existing `agentNotes` instead of clobbering them with `null`. All other NLA actions retain the prior overwrite-or-null behavior. (Surfaced by architect review.)

### Fixed — Object-storage hot path collapsed from 3 GCS RPCs to 1 (2026-05-09)
- **Eliminated 2 of 3 GCS round-trips per `/objects/*` request.** `server/replit_integrations/object_storage/objectStorage.ts` previously did three serialized GCS calls per image: `objectFile.exists()` in `getObjectEntityFile`, `file.getMetadata()` in `downloadObject`, and `getObjectAclPolicy()` (which internally also calls `getMetadata()`). With ~12 photos in a Ticket Detail dialog opening simultaneously that produced **~36 GCS RPCs** before any bytes started flowing — root cause of the grey-tile race agents kept screenshotting (Wayne Harrison report 2026-05-08, persisted through the lazy-load fix in commit 60cef71). It also blocked Node event-loop slots during heavy review periods, contributing to the general dashboard lag agents reported. The ACL lookup was useless for this route: `getObjectEntityFile` only resolves paths under PRIVATE_OBJECT_DIR so every result is effectively private — the ACL was solely used to flip `Cache-Control` public/private. The `exists()` preflight was also redundant because `getMetadata()` itself throws a 404 when the object is missing — translated into the existing `ObjectNotFoundError` so the route still returns a clean 404. Net: **1 GCS RPC per request**, ~3× speedup on dialog open and meaningful event-loop relief during peak review periods.
- **Added ETag + RFC-9110-compliant `If-None-Match` conditional GET.** Object store contents are immutable (uploaded once via signed URL, never overwritten), so the GCS `etag` is a strong validator. Comparison handles `*`, comma-separated tag lists, and `W/` weak-validator prefixes. After the browser's 1h cache expires, subsequent loads now return `304 Not Modified` instead of re-streaming the image — cuts both server bandwidth and per-image wall time on revisits to ~zero.

### Fixed — Agent kick-out and lag patch set (2026-05-08)
- **Hair-trigger 401 → forced logout removed.** `client/src/lib/queryClient.ts` previously nuked the JWT and `window.location.href = "/login"` on *any* 401 response from any endpoint. A single transient 401 (deploy restart, network blip, momentary auth-middleware hiccup) was kicking active agents out mid-ticket — Jeff Van Ness and Wayne Harrison reports on 2026-05-08. Now only `/api/auth/me` 401s are treated as definitively logged-out (that route exists specifically to validate the session). 401s on any other endpoint throw a normal error so the caller can surface a toast / let the user retry, but the token is preserved and the user stays on the page.
- **WebSocket heartbeat added.** `server/websocket.ts` now pings every 25s and terminates sockets that miss a pong, and the browser handles the pong reply at the protocol level automatically. Replit's load balancer (and corporate proxies between agents and us) silently drop idle WS connections after ~30–60s, which produced the cascade of `[ws] WebSocket disconnected` lines and made agents feel "kicked out" because real-time updates stopped flowing. With heartbeat the server detects dead sockets, the client's existing exponential-backoff reconnect loop takes over cleanly, and live updates resume without a page refresh.
- **Removed `loading="lazy"` from agent/admin photo grids inside the Ticket Detail dialog.** The lazy attribute combined with the dialog's scrollable container produced unreliable IntersectionObserver firing — agents saw a grid of grey placeholder tiles where only the first thumbnail rendered (Wayne Harrison report 2026-05-08). Photo grids only render after a user opens a ticket so eager-loading 5–12 thumbnails is not a meaningful cost. `decoding="async"` is preserved so decode work still happens off the main thread.

### Fixed — Performance hot-path patch set (2026-05-08)
- **Per-photo upload timeout raised from 120s to 300s** in `client/src/pages/tech-submit.tsx` to address technicians on weak cell signal whose 5–6 MB iPhone photos were aborting mid-PUT and retrying from byte 0 (visible as `[UPLOAD-DIAGNOSTIC] xhr-timeout` storms in deployment logs). The 5-minute ceiling preserves a reasonable upper bound while letting slow-but-progressing uploads complete instead of failing and re-consuming bandwidth on retry. Bounded concurrency (3 in-flight) from the prior commit is unchanged.
- **Technician photo uploads are now concurrent (bounded) instead of strictly sequential** in both new submission and resubmission flows. `client/src/pages/tech-submit.tsx` and `client/src/pages/tech-resubmit.tsx` now upload up to 3 files in parallel per batch, which materially reduces total wait time on mobile networks (including iPhone) when technicians attach many photos.
- **Upload content-type handling is more robust for iPhone/empty-MIME edge cases.** Upload calls now use a safe MIME fallback derived from extension when `file.type` is empty, preventing uploads with blank content-type that can later fail to render correctly.
- **Agent/Admin photo grids now lazy-load thumbnails** to reduce immediate network + decode pressure when opening ticket details with many images. Added `loading="lazy"` and `decoding="async"` for review-media thumbnail images in `client/src/pages/agent-dashboard.tsx` and `client/src/pages/admin-dashboard.tsx`.
- **Server hot-path logging overhead reduced by default.** `server/index.ts` no longer serializes full API JSON response bodies unless `DEBUG_API_BODY_LOGS=true`, and `/objects/*` success logs are now gated behind `LOG_ALL_OBJECT_REQUESTS=true` (errors still log). This cuts avoidable CPU and I/O load under high request volume.

### Changed — After-hours processing policy messaging (2026-05-08)
- **Technician after-hours messaging no longer implies agent/admin processing is blocked until the next business day.** Updated `buildSubmissionReceivedMessage` in `server/sms.ts` so after-hours texts still include business-hours context (`{hoursLabel}`) but now state tickets may be processed outside posted hours when agents/admins are available.
- **Backward-compatible safeguard for existing production templates.** Added normalization in `server/sms.ts` for legacy after-hours template phrases like "next business day" / "back online the following business day" so environments with pre-existing template rows immediately reflect the updated policy without requiring manual template edits.
- **Seed template defaults and Help Center wording aligned.** Updated `server/seed.ts` after-hours `submission_received.*_after_hours` templates and technician guidance in `client/src/pages/help-center.tsx` to match the new policy while preserving business-hours notices.

### Fixed — Hamed pilot feedback (2026-05-06)
- **RGC code lookup no longer fails after 8 PM EDT.** All daily-keyed RGC date lookups now compute "today" in `America/New_York` instead of UTC. Previously `new Date().toISOString().slice(0, 10)` rolled over at 8 PM EDT (midnight UTC), so an agent attempting to approve a ticket at 9 PM saw "No RGC code has been set for today" even though the day's code was set normally that morning. Hamed reported this 2026-05-05 — VRS had to call the tech and provide auth over the phone, then close the ticket as admin around 11 PM. New helper `getEtDateString()` lives in `shared/business-hours.ts` (re-exported from `client/src/lib/business-hours.ts`); call sites swapped: `server/routes.ts` (auth approval, NLA approval, admin GET, admin upsert verify, agent rgc-status), `client/src/pages/admin-dashboard.tsx` (admin date picker default). VRS business hours (8 AM–8 PM ET) are unchanged — agents still on after 8 can keep working, technicians can still submit at any hour, only the day-boundary anchor for the RGC code shifted from UTC to ET so the daily code stays valid through the entire ET calendar day.
- **Resubmission review now shows the prior rejection inline.** The agent's Stage 1 review card and the NLA review card both used to display only a one-line "This is a resubmission" badge — the prior rejection reasons and (more importantly) the Message-Sent-to-Technician text were buried in a separate Submission History card and frequently missed. Both review cards now render a "Previous Rejection" panel directly under the resubmission badge, populated from the `/api/submissions/:id/history` data already on the wire: rejection reasons (categorical or stage1RejectionReason fallback), the actual message sent to the tech, the prior reviewer's name, and review timestamp. No API or schema changes — the data was always there, only the rendering was missing. Hamed flagged this 2026-05-05.

### Fixed — Round 4 (2026-05-06)
- **Tech could not submit a fresh ticket on a previously-approved SO.** `storage.hasActiveSubmissionForServiceOrder` listed `"completed"` alongside `"queued"` and `"pending"` in its block list, so any SO# that had already been approved by VRS would 409 a new submission days or weeks later. Tyler reported a tech who finished a job earlier in the week and needed a fresh authorization on the same SO# for a follow-up visit (parts came in, related issue) — got blocked with "already approved." Approved tickets are closed business; they should not gate future submissions on the same SO. `activeStatuses` is now `["queued", "pending"]` only — concurrent in-flight work still blocks (preventing duplicate-text incidents Tyler asked for in 2026-04-30), but past completed work no longer does. The dead `completed: "already approved"` status label in the route handler is left in place as defense-in-depth.
- **Agent now sees prior submission's photos / video / voice note alongside the new ones.** Round 3 surfaced the prior `issueDescription`; this extends to the rest of the comparable media. `priorRejection` memo extended with `photos`, `videoUrl`, `voiceNoteUrl` from the most recent prior rejected submission. A new blue-bordered "Media on Previous Submission" card renders below the current Photos & Media card (only when a resubmission has a prior with media). Read-only — same parsing as the current photos (issue / estimate / legacy formats), lightbox click for zoom, separate gallery from the current photos so the index doesn't collide. Multi-video support reuses the existing `parseVideoUrls` helper (videoUrl can hold a JSON array). Voice note plays via the same `<audio controls>` element. No API or schema change.

### Fixed — Round 3 (2026-05-06, Tyler clarified Hamed's complaint)
- **Agent reviewing a resubmission now sees the prior submission's issue description inline.** Tyler clarified that Hamed's actual complaint was that the agent cannot see the issue description that was on the original submission (not just the rejection reasons). The agent dashboard renders `selectedSubmission.issueDescription` for the resubmission, but never surfaced the prior submission's description text — agents had no way to compare what the tech wrote before vs. now without leaving the page. The `priorRejection` memo now also exposes `issueDescription`, `aiEnhanced`, `originalDescription`, and `createdAt` from the most recent prior rejected submission (data already on the wire from `/api/submissions/:id/history`). A new blue-bordered "Description on Previous Submission" panel renders directly under the current description with the prior text + a `<details>` toggle for the tech's pre-AI-enhancement original (when applicable) + a timestamp. No API or schema change.

### Fixed — Round 2 audit (2026-05-06)
- **Tech resubmit page now shows full prior-rejection context.** `client/src/pages/tech-resubmit.tsx` previously rendered only `stage1RejectionReason`, which is the legacy free-text field — when an agent rejected via the categorical-checkbox path (the dominant flow), the tech got no reason text at all and never saw the agent's `technicianMessage` either, so they resubmitted blind. The rejection card now displays the categorical `rejectionReasons` array as a bulleted list (with `stage1RejectionReason` as fallback when no JSON list exists) and a separate "Message from VRS" block for `technicianMessage`. Same data shape as the agent-side fix above — same fields, no API change. Round 2 audit catch.
- **Admin export "Today" preset no longer captures tomorrow after 8 PM EDT.** `client/src/pages/admin-dashboard.tsx` `setExportPreset` formatted dates with `d.toISOString().slice(0, 10)` (UTC), so clicking "Today" at 9 PM EDT set both startDate and endDate to tomorrow's UTC date — the day's tickets were excluded. Now formats via `getEtDateString()` so "Today" maps to the current ET calendar day. Week/month spans keep their browser-local Date math (correct for VRS users in ET); only the day-key formatter routed through ET.
- **CSV / XLSX export filenames now ET-anchored.** `server/routes.ts` was suffixing exports with `now.toISOString().slice(0, 10)` so a 9 PM EDT export was filed as tomorrow's date in the filename. Now uses `getEtDateString(now)`. Cosmetic (filename only — actual data range was driven by query params), but makes the file label match the UI date the operator just selected.

### Documentation
- Added a technician-side instructional video fast-ship plan covering the current VRS submission flow and the three technician request types: Authorization, Infestation / Non-Accessible, and Parts — No Longer Available (NLA).

### Deployment Notes
- This release adds a new `submission_notes` table. Before deploying, run `npm run db:push` in the Replit environment (production-bound `DATABASE_URL`) or the `POST|GET /api/submissions/:id/notes` endpoints will 500 on first write.
- This release **also adds two more tables**: `intake_forms` (Smartsheet "VRS Unrep Intake Form 2.0" submission audit) and `agent_external_credentials` (encrypted per-agent calculator credentials). Run `npm run db:push` once before deploy or the new endpoints (`POST /api/submissions/:id/intake-form/{preview,confirm}`, `GET /api/submissions/:id/intake-form-status`, `GET|POST|DELETE /api/agent/credentials/calculator`, `POST .../reveal`, `GET /api/agent/intake-status`) and the new claim-gate (`PATCH /api/submissions/:id/claim`) will 500 on first call. The new claim-gate query (`getMissingIntakeForAgent`) only runs for `vrs_agent` role users — admins bypass it — so super_admin / admin sessions will continue to work even before db:push, but agents will see "Failed to claim" until the migration is applied.
- **The Stage 3 reordering follow-up (2026-04-26) requires NO additional schema changes** — it reuses the existing `intake_forms`, `submissions.ticket_status`, `submissions.auth_code`, and `submissions.request_type` columns. The single new endpoint (`GET /api/submissions/:id/intake-form-status`) does not touch any new tables.

### Changed — Stage 3 Smartsheet Intake reordering (2026-04-26)
- **Smartsheet intake is now the LAST step in the agent flow, gated behind a successful Authorize & Send.** Previously the intake fieldset appeared on the resolution panel during Stage 1 / Stage 2 (`ticketStatus === "pending"`); it now appears in a new **Stage 3** card that replaces Stage 2 in the resolution-panel slot the moment the ticket flips to `ticketStatus === "approved"` with `auth_code` populated. The 3-segment progress bar makes the journey visible from the start (Stage 1 → Stage 2 → Stage 3), and Stage 3 collapses into a "Smartsheet Intake Recorded" success card after the agent confirms.
- **New endpoint**: `GET /api/submissions/:id/intake-form-status` — single source of truth for Stage 3 visibility. Returns `{ required, recorded, reason?, intakeForm? }`. The agent dashboard never re-derives the gate locally; client UI and server-side claim gate read from the same predicate.
- **Tightened claim-gate predicate** in `storage.getMissingIntakeForAgent`: previously fired for any reviewed-but-not-recorded non-NLA submission in the last 24h (`ticket_status IN ('completed','rejected','invalid','approved')`); now narrows to `ticket_status = 'approved' AND auth_code IS NOT NULL`. **Net effect**: rejected / invalid tickets no longer block the agent's next claim — they never needed a Smartsheet row in the first place. The claim-gate still uses an `intake_forms` row as the release signal, so the 24h window from T5 is preserved unchanged.
- **Required attestation checkbox** in the intake review modal: the "I submitted Smartsheet" button is now disabled until the agent ticks "I confirmed the Smartsheet success page appeared after clicking Submit inside the form above." Guards against the audit row in `intake_forms` being recorded when the agent never clicked Smartsheet's own Submit button inside the iframe.
- **Pending Smartsheet Intake (N) sidebar badge** on the agent dashboard. Click-through routes to the most-recent blocking submission and auto-switches to My Tickets so Stage 3 renders without further interaction. The badge is driven by the same `/api/agent/intake-status` endpoint the claim-gate uses, so the badge can never disagree with a 409 INTAKE_REQUIRED.
- **Post-Authorize redirect**: `processMutation.onSuccess` now keeps the just-authorized ticket selected when Stage 3 is required (non-NLA `approve` actions), and scrolls Stage 3 into view after the cache flips. Stage 1 mid-flow (`approve_submission` on 2-stage warranties) keeps the ticket selected as before. Reject / invalid / reject_and_close still clear the selection.
- **Tech-side impact: zero.** Smartsheet intake is internal to VRS — no SMS, no field on the tech's submission view, no notification. Tech experience after Authorize & Send is identical.
- **Files**: `server/storage.ts`, `server/routes.ts`, `client/src/pages/agent-dashboard.tsx`, `client/src/components/intake-form-review-modal.tsx`. Smoke test (`tsx scripts/test-intake-url.ts`) still passes — URL builder behavior unchanged.

### Added — Calculator + Smartsheet Intake Form (2026-04-26)
- **Tabbed right-panel** on the agent dashboard: the existing "Service Order History" panel is now the left tab of a `Tabs` control whose right tab embeds the Repair/Replace Calculator (`https://repairreplacecalculator.replit.app/`) as a sandboxed iframe. Tab choice is persisted per-agent in `localStorage` under `agent:${user.id}:rightPanel`. Existing show/hide test IDs (`button-show-shsai`, `button-hide-shsai`) and the SHSAI refresh button are preserved.
- **Per-agent encrypted calculator credentials**: agents can save their calculator username + password once (gear icon inside the Calculator tab) and the iframe will auto-fill on load via `postMessage` (clipboard-copy fallback in the iframe header for the current Streamlit form, which doesn't yet listen for the envelope). Cleartext is encrypted server-side with AES-256-GCM, key derived from `SESSION_SECRET` via scrypt with a per-row salt; the server never logs cleartext and the `/reveal` endpoint is the only path that ever returns the password (over HTTPS, only to the owning agent's session). The browser-side `postMessage` call pins `targetOrigin` to the calculator origin (never `"*"`), and credentials are NEVER appended as iframe URL query params (avoiding leaks to browser history and remote access logs). New file: `server/services/crypto.ts`. New table: `agent_external_credentials` (unique on user_id+service).
- **Smartsheet intake form fieldset** on the resolution panel: branch-aware (AHS / Sears Protect Heating-Cooling / Sears Protect Whole Home / Sears Repair Warranty / Insurance Service Plan), surfacing only the fields the chosen branch actually requires. Hard-block validation gates the "Submit Intake to Smartsheet" button until required fields are filled. Detected from the ticket's `procId` against the field map in `docs/intake_form_field_map.md`. New files: `client/src/lib/intake-form-config.ts`, `client/src/components/intake-form-fieldset.tsx`.
- **Intake form review modal**: clicking "Submit Intake to Smartsheet" opens a modal that previews the agent's payload, embeds the pre-filled Smartsheet form as an iframe (live URL built server-side via `server/services/smartsheet.ts` with a column-label allow-list), and on confirm records the row in `intake_forms`. New file: `client/src/components/intake-form-review-modal.tsx`. New endpoints: `POST /api/submissions/:id/intake-form/preview` and `.../confirm`.
- **Server-side claim gate**: `PATCH /api/submissions/:id/claim` now (1) checks `getMissingIntakeForAgent` and returns `409 INTAKE_REQUIRED { blockingSubmissionId, blockingServiceOrder }` if the agent has any reviewed-but-not-recorded non-NLA submission from the last 24h; (2) replaces the read-then-update claim with an atomic `UPDATE submissions SET ... WHERE id = $1 AND ticket_status = 'queued'` so two agents racing for the same row both go through auth checks but only one wins. Frontend handles the 409 by auto-routing to the blocking submission and popping the intake review modal. New storage methods in `server/storage.ts`: `claimSubmission`, `getMissingIntakeForAgent`, `getIntakeFormBySubmission`, `createIntakeForm`, plus `getAgentCredential`, `upsertAgentCredential`, `deleteAgentCredential`.
- **Intake form smoke test + checklist**: `scripts/test-intake-url.ts` (runnable via `tsx scripts/test-intake-url.ts`) exercises `buildIntakeFormUrl` across all five branches, and `docs/intake_form_smoke_checklist.md` walks through a manual end-to-end pass post-deploy.
- **Field map doc**: `docs/intake_form_field_map.md` captures the verbatim branch / column mapping Tyler walked through, including the four branches still flagged INCOMPLETE (full Repair-Warranty + ISP question lists). `docs/intake_form_default_snapshot.yml` was extended with branch metadata.

### Added
- **Core Platform**: Full-stack authorization request management (Express + React + PostgreSQL)
- **Technician PWA**: Mobile-first submission form with photo/video/voice note uploads, AI description enhancement, submission history, and detail view
- **Agent Dashboard**: Real-time ticket queue with claim-to-process workflow, division-based routing, SHSAI integration panel, and notification sounds (5 tones)
- **Admin Dashboard**: User management, analytics, agent status monitoring, ticket overview with audit trail, CSV/XLSX export, technician sync from Snowflake
- **NLA Workflow**: Dedicated Parts No Longer Available queue with 8 resolution actions, P-card escalation system, and NLA-specific analytics
- **Two-Stage Review**: AHS and First American warranties support internal approval + external auth code entry
- **Warranty Providers**: Sears Protect, American Home Shield, and First American all enabled for technician submissions
- **Split NLA Parts Entry**: Separate sections for NLA parts (unavailable) and other required parts (available) on the submission form
- **Real-Time Notifications**: WebSocket-based sound dings, toasts, and browser notifications for new tickets, claimed tickets, and queue changes — for agents, admins, and super_admins
- **Upload Diagnostics**: Client-side upload error reporting endpoint (`POST /api/uploads/report-error`) logs failure details server-side with `[UPLOAD-DIAGNOSTIC]` prefix
- **iPhone HEIC Fix**: Photo upload file filter accepts empty MIME types (common on iOS HEIC photos)
- **Resubmission System**: Technicians can resubmit rejected tickets; auto-assigns to original reviewer if online
- **Division Correction**: Agents can correct appliance type mid-review with intelligent ownership handling
- **RGC Code System**: Daily rotating codes required before agents can process tickets
- **Notification Sound System**: 5 tone options (Chime, Bell, Pulse, Cascade, Alert) with per-user volume control
- **Dark Mode**: App-wide dark mode toggle persisted to localStorage with OS preference fallback
- **Onboarding**: First-login wizard, What's New modal, contextual help tooltips, searchable Help Center
- **SMS Notifications**: Twilio-based notifications to technicians on ticket status changes
- **Technician Feedback**: In-app feedback submission with admin management (status tracking, notes)
- **Test Cleanup**: Automatic purge of test submissions (testtech1/tmorri1) on every server restart
- **Mobile Touch Targets**: 44px minimum touch targets on technician login page
### Added
- **Core Platform**: Full-stack authorization request management (Express + React + PostgreSQL)
- **Technician PWA**: Mobile-first submission form with photo/video/voice note uploads, AI description enhancement, submission history, and detail view
- **Agent Dashboard**: Real-time ticket queue with claim-to-process workflow, division-based routing, SHSAI integration panel, and notification sounds (5 tones)
- **Admin Dashboard**: User management, analytics, agent status monitoring, ticket overview with audit trail, CSV/XLSX export, technician sync from Snowflake
- **NLA Workflow**: Dedicated Parts No Longer Available queue with 8 resolution actions, P-card escalation system, and NLA-specific analytics
- **Two-Stage Review**: AHS and First American warranties support internal approval + external auth code entry
- **Warranty Providers**: Sears Protect, American Home Shield, and First American all enabled for technician submissions
- **Split NLA Parts Entry**: Separate sections for NLA parts (unavailable) and other required parts (available) on the submission form
- **Real-Time Notifications**: WebSocket-based sound dings, toasts, and browser notifications for new tickets, claimed tickets, and queue changes — for agents, admins, and super_admins
- **Upload Diagnostics**: Client-side upload error reporting endpoint (`POST /api/uploads/report-error`) logs failure details server-side with `[UPLOAD-DIAGNOSTIC]` prefix
- **iPhone HEIC Fix**: Photo upload file filter accepts empty MIME types (common on iOS HEIC photos)
- **Resubmission System**: Technicians can resubmit rejected tickets; auto-assigns to original reviewer if online
- **Division Correction**: Agents can correct appliance type mid-review with intelligent ownership handling
- **RGC Code System**: Daily rotating codes required before agents can process tickets
- **Notification Sound System**: 5 tone options (Chime, Bell, Pulse, Cascade, Alert) with per-user volume control
- **Dark Mode**: App-wide dark mode toggle persisted to localStorage with OS preference fallback
- **Onboarding**: First-login wizard, What's New modal, contextual help tooltips, searchable Help Center
- **SMS Notifications**: Twilio-based notifications to technicians on ticket status changes
- **Technician Feedback**: In-app feedback submission with admin management (status tracking, notes)
- **Test Cleanup**: Automatic purge of test submissions (testtech1/tmorri1) on every server restart
- **Mobile Touch Targets**: 44px minimum touch targets on technician login page
### Changed
- **Standardized "Message to Technician" branding across SMS and in-app**: Previously the same `technicianMessage` field appeared to techs under four different labels — "Agent message:", "Agent notes:", "Instructions:", and "Agent Message:" — depending on which action path was used. All channels now use a consistent, branded prefix:
  - **`Feedback from VRS — Action required:`** when the tech needs to do something (Stage 1 reject + resubmit, NLA reject + resubmit, NLA part-found-tech-orders).
  - **`Feedback from VRS:`** for informational messages (reject and close, NLA P-card confirm).
  - **No prefix** on approval paths (Stage 1 approve, final approve / auth code, NLA approval) — the agent's optional note is appended inline as an extra paragraph since "feedback" wording felt awkward on positive outcomes. If the agent leaves the note blank, the SMS is just the standard approval text with no extra section.
  - Updated in `server/sms.ts` (`buildNlaApprovalMessage`, `buildAuthCodeMessage`), six call sites in `server/routes.ts` (lines ~1233, 1328, 1347, 1555, 1611, 1630), and three rendered labels in `client/src/pages/submission-detail.tsx` (NLA tech-orders, rejected, rejected_closed). Two agent-side preview labels in `client/src/pages/agent-dashboard.tsx` (lines ~1993, 3170) were also unified to "Message to Technician:" for clarity to the agent.

### Fixed
- **Per-file upload failure visibility**: When a photo fails to upload, the file now appears in a red-bordered list under the photo grid with a Retry button, instead of only showing an aggregate toast. Techs can retry individual files without reselecting the ones that already succeeded.
- **Resubmit form silently failed for AHS / First American tickets**: The Zod schema on `client/src/pages/tech-resubmit.tsx` only allowed `warrantyType: "sears_protect"`, so form validation silently rejected rejected AHS/FA tickets on submit (no visible error — the field isn't rendered). Technicians had to create a new ticket instead. Schema now matches `tech-submit.tsx` and accepts all three providers.

### Added
- **Core Platform**: Full-stack authorization request management (Express + React + PostgreSQL)
- **Technician PWA**: Mobile-first submission form with photo/video/voice note uploads, AI description enhancement, submission history, and detail view
- **Agent Dashboard**: Real-time ticket queue with claim-to-process workflow, division-based routing, SHSAI integration panel, and notification sounds (5 tones)
- **Admin Dashboard**: User management, analytics, agent status monitoring, ticket overview with audit trail, CSV/XLSX export, technician sync from Snowflake
- **NLA Workflow**: Dedicated Parts No Longer Available queue with 8 resolution actions, P-card escalation system, and NLA-specific analytics
- **Two-Stage Review**: AHS and First American warranties support internal approval + external auth code entry
- **Warranty Providers**: Sears Protect, American Home Shield, and First American all enabled for technician submissions
- **Split NLA Parts Entry**: Separate sections for NLA parts (unavailable) and other required parts (available) on the submission form
- **Real-Time Notifications**: WebSocket-based sound dings, toasts, and browser notifications for new tickets, claimed tickets, and queue changes — for agents, admins, and super_admins
- **Upload Diagnostics**: Client-side upload error reporting endpoint (`POST /api/uploads/report-error`) logs failure details server-side with `[UPLOAD-DIAGNOSTIC]` prefix
- **iPhone HEIC Fix**: Photo upload file filter accepts empty MIME types (common on iOS HEIC photos)
- **Resubmission System**: Technicians can resubmit rejected tickets; auto-assigns to original reviewer if online
- **Division Correction**: Agents can correct appliance type mid-review with intelligent ownership handling
- **RGC Code System**: Daily rotating codes required before agents can process tickets
- **Notification Sound System**: 5 tone options (Chime, Bell, Pulse, Cascade, Alert) with per-user volume control
- **Dark Mode**: App-wide dark mode toggle persisted to localStorage with OS preference fallback
- **Onboarding**: First-login wizard, What's New modal, contextual help tooltips, searchable Help Center
- **SMS Notifications**: Twilio-based notifications to technicians on ticket status changes
- **Technician Feedback**: In-app feedback submission with admin management (status tracking, notes)
- **Test Cleanup**: Automatic purge of test submissions (testtech1/tmorri1) on every server restart
- **Mobile Touch Targets**: 44px minimum touch targets on technician login page
### Added
- **Core Platform**: Full-stack authorization request management (Express + React + PostgreSQL)
- **Technician PWA**: Mobile-first submission form with photo/video/voice note uploads, AI description enhancement, submission history, and detail view
- **Agent Dashboard**: Real-time ticket queue with claim-to-process workflow, division-based routing, SHSAI integration panel, and notification sounds (5 tones)
- **Admin Dashboard**: User management, analytics, agent status monitoring, ticket overview with audit trail, CSV/XLSX export, technician sync from Snowflake
- **NLA Workflow**: Dedicated Parts No Longer Available queue with 8 resolution actions, P-card escalation system, and NLA-specific analytics
- **Two-Stage Review**: AHS and First American warranties support internal approval + external auth code entry
- **Warranty Providers**: Sears Protect, American Home Shield, and First American all enabled for technician submissions
- **Split NLA Parts Entry**: Separate sections for NLA parts (unavailable) and other required parts (available) on the submission form
- **Real-Time Notifications**: WebSocket-based sound dings, toasts, and browser notifications for new tickets, claimed tickets, and queue changes — for agents, admins, and super_admins
- **Upload Diagnostics**: Client-side upload error reporting endpoint (`POST /api/uploads/report-error`) logs failure details server-side with `[UPLOAD-DIAGNOSTIC]` prefix
- **iPhone HEIC Fix**: Photo upload file filter accepts empty MIME types (common on iOS HEIC photos)
- **Resubmission System**: Technicians can resubmit rejected tickets; auto-assigns to original reviewer if online
- **Division Correction**: Agents can correct appliance type mid-review with intelligent ownership handling
- **RGC Code System**: Daily rotating codes required before agents can process tickets
- **Notification Sound System**: 5 tone options (Chime, Bell, Pulse, Cascade, Alert) with per-user volume control
- **Dark Mode**: App-wide dark mode toggle persisted to localStorage with OS preference fallback
- **Onboarding**: First-login wizard, What's New modal, contextual help tooltips, searchable Help Center
- **SMS Notifications**: Twilio-based notifications to technicians on ticket status changes
- **Technician Feedback**: In-app feedback submission with admin management (status tracking, notes)
- **Test Cleanup**: Automatic purge of test submissions (testtech1/tmorri1) on every server restart
- **Mobile Touch Targets**: 44px minimum touch targets on technician login page
## [0.1.0] - 2026-04-16

### Added
- **Core Platform**: Full-stack authorization request management (Express + React + PostgreSQL)
- **Technician PWA**: Mobile-first submission form with photo/video/voice note uploads, AI description enhancement, submission history, and detail view
- **Agent Dashboard**: Real-time ticket queue with claim-to-process workflow, division-based routing, SHSAI integration panel, and notification sounds (5 tones)
- **Admin Dashboard**: User management, analytics, agent status monitoring, ticket overview with audit trail, CSV/XLSX export, technician sync from Snowflake
- **NLA Workflow**: Dedicated Parts No Longer Available queue with 8 resolution actions, P-card escalation system, and NLA-specific analytics
- **Two-Stage Review**: AHS and First American warranties support internal approval + external auth code entry
- **Warranty Providers**: Sears Protect, American Home Shield, and First American all enabled for technician submissions
- **Split NLA Parts Entry**: Separate sections for NLA parts (unavailable) and other required parts (available) on the submission form
- **Real-Time Notifications**: WebSocket-based sound dings, toasts, and browser notifications for new tickets, claimed tickets, and queue changes — for agents, admins, and super_admins
- **Upload Diagnostics**: Client-side upload error reporting endpoint (`POST /api/uploads/report-error`) logs failure details server-side with `[UPLOAD-DIAGNOSTIC]` prefix
- **iPhone HEIC Fix**: Photo upload file filter accepts empty MIME types (common on iOS HEIC photos)
- **Resubmission System**: Technicians can resubmit rejected tickets; auto-assigns to original reviewer if online
- **Division Correction**: Agents can correct appliance type mid-review with intelligent ownership handling
- **RGC Code System**: Daily rotating codes required before agents can process tickets
- **Notification Sound System**: 5 tone options (Chime, Bell, Pulse, Cascade, Alert) with per-user volume control
- **Dark Mode**: App-wide dark mode toggle persisted to localStorage with OS preference fallback
- **Onboarding**: First-login wizard, What's New modal, contextual help tooltips, searchable Help Center
- **SMS Notifications**: Twilio-based notifications to technicians on ticket status changes
- **Technician Feedback**: In-app feedback submission with admin management (status tracking, notes)
- **Test Cleanup**: Automatic purge of test submissions (testtech1/tmorri1) on every server restart
- **Mobile Touch Targets**: 44px minimum touch targets on technician login page
