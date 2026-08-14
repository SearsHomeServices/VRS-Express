# Codex Context - VRS-Agent-Core

Updated: 2026-08-14 14:14

## Current Session

- Corrected the DEV bridge key-name mismatch without adding or exposing a
  Secret. Stage 1 configuration now falls back to the existing
  `VRS_SASHA_API_KEY` only in development; production still requires
  `VRS_AI_API_KEY`. A regression proves both boundaries. Full bridge tests are
  161/161, build passes, and the known TypeScript baseline remains 60 with no
  scoped diagnostic. The contract VRS AI DEV hostname still has no public DNS
  record, so the external platform must provision it or provide a corrected
  reachable URL before approval can complete.
- GitHub `main` and Replit DEV contain commit `278447c`; only DEV was
  restarted and health is `200`. The running process resolves Stage 1 as
  configured without `VRS_AI_API_KEY`. The real outbound client then fails at
  DNS with `ENOTFOUND` for `vrs-dev.stage.nextgen.shs.com`, isolating the
  remaining fault outside VRS Express.

- Added an authenticated, read-only VRS AI service-order lookup at
  `GET /api/integrations/vrs-ai/v1/service-orders/{service_order}`. It uses
  the already-configured inbound VRS Express `X-API-Key`, loads only the latest
  bridge request for the exact eight-digit service order, strips callback
  fields, merges sender and linked-ticket photos, and converts internal
  `/objects/` paths into direct 24-hour signed URLs. No new secret, schema, or
  database write is involved. Local verification is 160/160 bridge tests and
  a passing production build. GitHub/Replit DEV are synchronized, only DEV was
  restarted, health is `200`, no-key lookup is `401`, and authenticated
  service order `99081204` returns `200` with sanitized V8 data and one photo
  location. No publish or database write ran.

- Diagnosed real-technician `INVALID_TECHNICIAN_DISTRICT` without data writes:
  `dhanse9` is active and its DEV roster district is `0008175`; 1,635 active
  technicians use the same `000DDDD` representation. Bridge intake now
  normalizes exact `000DDDD` to `DDDD` internally. The external payload remains
  unchanged and contains no district field. Focused bridge verification is
  151/151 and the production build passes; TypeScript retains the known 56
  repository diagnostics with zero in this change's intake/test scope. The
  fix was merged over the Replit Agent's two newer weekly-report commits and
  synchronized to DEV. Live request `dhanse9` / `99081204` returned `202`.
- VRS AI photo retrieval is implemented for approved V8 dispatch. When the
  accepted `appliance_photos` array is empty, VRS Express converts its ticket
  `/objects/` paths into direct signed Object Storage `GET` URLs valid for 24
  hours. Plain `GET` needs no Express key/login/media token. External HTTPS
  URLs pass through; V5 and populated V8 arrays do not change; signing failure
  stops before the VRS AI call. Tests are 155/155, build passes, and the exact
  60-diagnostic HEAD TypeScript baseline has zero new scoped diagnostics.
- Implementation commit `4c61ecc` is live on the synchronized GitHub/Replit
  DEV history; DEV was restarted and health is `200`. A read-only live test
  generated an approximately 24-hour HTTPS URL for
  an existing DEV object photo and a credential-free byte-range GET returned
  `206`. The signed URL was not emitted. No publish or database write ran.
- Updated and verified the external Markdown/OpenAPI sources, DEV connection
  sheet, DOCX, matching 10-page PDF, and three-file ZIP. Word produced the PDF
  because the prescribed LibreOffice renderer is unavailable; all pages were
  rendered to PNG and visually inspected without layout defects.

- Configured the Express-owned bridge values in Replit DEV without exposing
  values: generated `VRS_SASHA_API_KEY`, `VRS_AI_WEBHOOK_SECRET`, and
  `VRS_BRIDGE_ENCRYPTION_KEY`, plus the confirmed VRS AI staging origin and
  VRS Express public DEV origin. Both URLs live under `.replit`'s development
  section and cannot leak into a later production publish. The restarted DEV
  process contains all five Express-owned values. DEV now recognizes the
  existing contract key under `VRS_SASHA_API_KEY`; no duplicate
  `VRS_AI_API_KEY` is required for the joint DEV test. Production keeps the
  explicit outbound-key requirement.
- Live DEV proof: public no-key authorize returns `401`; authenticated empty
  input reaches strict validation and returns `400`; a complete strict V8
  request using active DEV technician `test_tech_1` / district `8175` and
  unique service order `99081201` returned `202`. The stored ticket remains
  queued with Stage 1 pending, bridge state `pending_review`, and no provider
  call ID, proving no pre-approval outbound dispatch.
- The existing handoff package intentionally contains no live endpoint or key.
  Added the separate platform-only Markdown DEV connection sheet with the
  exact environment URLs and secure credential-exchange/run sequence. A proposed
  DEV-only, admin-authenticated, read-only bridge monitor awaits Tyler's design
  approval before implementation.
- Connected Replit inspection confirms the current August 10 production
  deployment has none of the six new bridge variables. App Secrets can be
  captured on a later republish, so publishing remains blocked until the
  production secret selection and production endpoint values are explicitly
  reviewed; the current production app remains unchanged.

- Synchronized verified commit `6c69bab` to the clean VRS Express Replit
  workspace `main`, then pushed that same `main` history to GitHub. Restarted
  the configured Replit DEV process and confirmed its public health endpoint
  returns `200`. No production publication, deployment, schema/data write, or
  production configuration change occurred.
- Read-only runtime checks confirmed `vrs_ai_calls` and `vrs_ai_call_events`
  already exist in the DEV database. The running DEV process is missing the
  bridge configuration names `VRS_SASHA_API_KEY`, `VRS_AI_BASE_URL`,
  `VRS_AI_API_KEY`, `VRS_AI_WEBHOOK_SECRET`, `VRS_BRIDGE_ENCRYPTION_KEY`,
  `VRS_AI_CALLBACK_URL`, and `VRS_EXPRESS_PUBLIC_URL`; endpoint testing correctly stops at `503
  NOT_CONFIGURED` until secure DEV values are supplied.

- Completed Task 8 from corrected source `bc3ff67`: regenerated the
  platform-only direct-delivery package in `output/doc/` as an editable DOCX,
  matching 10-page PDF, and ZIP with exactly those two files plus the
  authoritative OpenAPI YAML at archive root. No standalone YAML exists in
  `output/doc/`.
- The document carries strict V5/V8 selection, two-direction DEV flow, full
  payloads/constraints, responses, five callback payloads/effects, raw-byte
  HMAC/retry details, signed-photo handling, the narrow immediate retryable V8
  exception, and the acceptance checklist. It contains only VRS Express/VRS
  AI and the four approved DEV placeholders.
- Artifact verification passes: 16/16 source docs tests, complete DOCX table
  geometry audit, scrubbed DOCX metadata, DOCX/PDF text scans, exact ZIP byte
  membership, and visual inspection of all 10 PDF pages. Word was used only
  hidden for local conversion and exited afterward; no database, container,
  remote, configuration, deployment, publication, or production action ran.

- Completed Task 7 test-first as an in-place documentation revision. The
  architecture, Markdown handoff, and OpenAPI now describe strict V5 and V8
  on the existing route, VRS Express human approval, same-version VRS AI
  dispatch, exact callbacks/HMAC, controlled V8 enrichment, durable dedupe,
  and active-only duplicate behavior.
- All platform-facing sources use only VRS Express/VRS AI identities and the
  four approved DEV URL placeholders; they contain no individual names,
  internal source history, live URLs, or credentials. Copyable Markdown V5,
  V8, and five callback examples are byte-equivalent to the runtime-validated
  OpenAPI examples.
- Final review added every runtime `409`/`422` intake rejection shape, explicit
  replace-before-test DEV technician and service-order prerequisites, exact
  clean-HTTPS callback direction rules, and the ticket/SMS matrix for all five
  result events. The final parity correction places `SUBMISSION_REJECTED` in
  both status families: captured ticket conflicts are `409`; other submission
  rejections are `422`.
- Task 7 RED was 9 expected failures against the stale V5-only handoff, plus
  one review RED for missing `422`/callback-retry details and a four-failure
  final-review RED for the remaining response/prerequisite/effect details.
   GREEN is 16/16 docs tests, 150/150 focused non-database bridge tests, a
   passing build, and unchanged 56-raw/26-normalized TypeScript diagnostics
   with zero new Task 6 module matches. No database, container, remote, config,
   deploy, or publish action ran.

- Corrected Task 6 to retain the `972409d` active-only duplicate model. The
  production route still consumes the injected intake seam and retains its
  cheap active lookup before partner, technician, encryption, normal ticket,
  receipt-SMS, and response behavior.
- An active V5 or V8 bridge returns the existing duplicate result. V5 and
  nonretryable V8 terminal repeats retain ordinary ticket/service-order policy.
  The narrow V8 §2.4 exception applies only when a strict V8 request follows a
  latest same-service-order retryable `failed` V8 callback that was locally
  applied: it creates a new normal ticket, bridge row, and public call ID.
  It excludes only every prior eligible retryable-failed V8 bridge ticket ID
  from all legacy duplicate queries; unrelated, active, V5, and nonretryable
  rows remain blockers.
- This does not reset or reuse the old ticket, bridge, or event. Upstream
  callback forwarding stays independent by old call ID, so an old forward
  retry may resume without delaying or altering the new V8 request.
- Removed the unapproved ticket/bridge reset, attempt snapshot, historical
  provider callback lookup, special callback locking, and PostgreSQL test.
  Current callback durability and Stage 1 `dispatch_failed` resend remain
  baseline behavior. Final non-database verification is 16/16 intake and
  documentation tests, 150/150 bridge tests, a passing build, and the known 56 raw
  TypeScript diagnostics with zero new Task 6 module diagnostics. No database
  or container action was run.

- Closed the final narrow Task 5 proof gap: the main rendered V8 fixture now
  uses unique nonempty technician-name and rationale sentinels, while a
  separate rendered V8 case asserts exact empty rows plus `N/A`, `TBD`, and
  zero preservation. This prevents swapped mappings from passing only because
  both source values were empty.
- Closed the final Task 5 rigor findings test-first. A production
  `VrsAiBridgePanel` now owns the nullable guard plus outer state, dispatch
  error, failed/retryable copy, and complete review. The dashboard passes its
  nullable bridge directly; rendered tests prove null/manual state produces no
  bridge UI and V5/V8 produce their exact status/review.
- Rebuilt the primary V8 mapping fixture with unique nonempty values for every
  swappable field and assert each against its exact `data-field`: both distinct
  addresses, all request/technician/customer/appliance/problem fields,
  financial arithmetic, every part field, and every comment metadata field.
  The remaining source check is narrow dashboard-to-panel wiring/manual copy,
  not conditional behavior. Final verification is 8/8 UI, 30/30 queue,
  118/118 focused bridge tests, a passing production build, and the unchanged
  56-diagnostic baseline with zero new Task 5 file diagnostics.

- Closed the Task 5 review findings test-first. The guarded dashboard now
  consumes a dedicated production review component that is rendered through
  `react-dom/server` in tests. It displays raw service/reason, technician,
  customer/address/location, complete appliance/problem/financial/part data,
  full comment metadata, and direct sender photos.
- V8-only contract/symptom/year/color rows are gated on derived `v8` status.
  V5 keeps all common review content and renders optional partner/grade rows
  only when present. Tests prove literal `N/A`, `TBD`, empty strings, zeroes,
  total arithmetic, exact signed photo URLs, and safe link/image attributes.
- `getStatusBySubmissionId` now uses an injectable production row-loader seam
  and the shared projector. The real method is directly tested without a DB;
  both `contract_version` and `contractVersion` remain absent from payload and
  review context. Follow-up verification is 6/6 UI, 30/30 queue, 116/116
  focused bridge tests, a passing build, and the unchanged 56-diagnostic
  baseline.

- Completed Task 5 test-first. `VrsAiBridgeStatus` now exposes a derived
  `v5`/`v8` contract version outside both stored request JSON and the review
  context. Server tests prove V5/V8 derivation, payload immutability, exact
  V8 placeholders/zeroes, and signed TINA URL preservation.
- Expanded only the existing `selectedSubmission.vrsAi` panel with labeled
  contract, diagnosis, appliance, technician, estimate, part, comment, and
  sender-photo details. Sender URLs go directly to safe links/previews with no
  Express token helper or shared lightbox. Manual tickets remain `vrsAi:null`
  and keep the existing approval copy; bridge wording is version-neutral.
- Task 5 verification: 6/6 UI tests, 29/29 affected queue tests, 115/115
  focused bridge tests, and the production build pass. `npm run check`
  remains at the 56-raw pre-existing baseline, so Task 5 added zero
  diagnostics. No schema, seed, startup, database, remote, configuration,
  sync, deployment, or publication action ran.

- Closed the Task 4 review gap test-first. The original test-owned
  continuation wrapper did not prove route consumption, so it was removed.
  `processSubmissionHandler` now consumes a small production route-gate
  adapter whose stop/continue behavior is dynamically tested.
- A bounded regression reads only the real process-handler region and proves
  the gate remains inside `approve_submission`, the responded branch returns
  before `updateData`, and Stage 1 approval remains after both. The legacy
  update/SMS suffix remains byte-equivalent.
- Review-fix verification: 12/12 boundary tests, 109/109 focused bridge tests,
  and the production build pass; TypeScript remains at 56 raw diagnostics
  with zero Task 4 diagnostics. No schema, seed, startup, database, remote,
  configuration, sync, deployment, or publication action ran.
- Completed Task 4 test-first. The Stage 1 bridge helper performs the durable
  bridge-row lookup before reading VRS AI configuration, constructing a
  client, resolving enrichment, or dispatching. Manual/PWA tickets return
  `not_applicable` with none of those bridge-only operations.
- Missing configuration, busy dispatch, rate limiting, and other dispatch
  failures return the existing 503/409/429/502 error contracts before the
  legacy Stage 1 update/SMS path. Accepted and already-dispatched results fall
  through to the byte-equivalent legacy block exactly once.
- Initial Task 4 verification: 8/8 boundary tests, 105/105 focused bridge tests, and
  the production build pass. `npm run check` remains at the known 56 raw
  diagnostics with zero Task 4 diagnostics. No schema, seed, startup,
  database, remote, configuration, sync, deployment, or publication action
  ran.
- Completed Task 3 test-first. V8 wire `tech_phone: "N/A"` and blank rationale
  now receive bridge-only operational fallbacks without mutating durable JSON.
  Review projection retains every V8 business field and removes both callback
  fields.
- Stage 1 keeps V5 byte-for-byte compatible and applies narrow V8 enrichment
  only to existing `tech_phone`, `tech_name`, and empty `appliance_photos`
  placeholders. Invalid candidates and authenticated `/objects/` paths are
  ignored, populated input and signed TINA URLs are retained, no key or
  `cta_no` is appended, and the original contract version is revalidated
  before the VRS AI client.
- Task 3 review correction extracted route-consumed pure helpers for intake
  operational projection and Stage 1 candidate projection. Tests now prove
  the route inputs keep `tech_phone: "N/A"` in sanitized durable JSON while
  using the resolved ticket phone, and source candidate phone/name/photos
  from the actual submission/user/photo fields. Dispatch's explicit
  same-version guard is now the single pre-client validation path and is
  directly exercised by invalid stored V8.
- Task 3 verification: 27/27 queue tests and 97/97 focused bridge tests pass;
  the production build passes; TypeScript remains at the 56 raw pre-existing
  diagnostic baseline with no new Task 3 file diagnostic. No schema, seed,
  startup, database, remote, configuration, sync, deployment, or publication
  action ran.
- Completed Task 2 test-first: authenticated `POST /vrs/authorize` now runs
  `safeParseVrsAuthorizeRequest` only after its existing 503 configuration and
  timing-safe 401 API-key gates, then passes the accepted V5/V8 union
  unchanged to intake without a wire version field. The response contract is
  unchanged; tests prove V5/V8 202 and duplicate 409 shapes, secret/provider
  ID exclusion, partial V8 validation fields, and authentication ordering.
- Verification: 22/22 route tests and 83/83 focused bridge tests pass; the
  production build passes; TypeScript remains at the 56 raw pre-existing
  diagnostic baseline with no changed-file diagnostic. No schema/database,
  remote, configuration, sync, deployment, or publication action ran.
- Corrected the Task 1 review finding test-first: the exported V5 validator is
  now truthfully typed as its runtime `ZodEffects` class instead of being cast
  to `ZodObject`. `VrsAuthorizeV5Request` is derived separately from the clean
  shape schema, preserving payload types and the 56-diagnostic baseline.
- Added runtime and compile-time regression coverage that prevents object-only
  APIs such as `.extend` from being exposed on the effects validator.
- Implemented Task 1 test-first: canonical V5/V8 authorize fixtures, strict
  separate schemas, deterministic V8 intent selection from the four V8-only
  keys, a version-bearing safe parser, and same-version outbound source
  validation. V8 validation does not transform accepted strings or signed
  photo URLs; V5 retains its existing schema export and trimming behavior.
- Confirmed against the source V8 contract that `contract_number` and
  `symptom` have no `maxLength`; they are nonblank/nonmutating without an
  invented cap. `appliance_color` retains the contract's explicit max 40.
- Added the contract suite to `test:vrs-ai-bridge`. Fresh evidence: 78/78
  focused tests, production build passing, and the original 56 raw TypeScript
  diagnostics with no changed-file diagnostic. No database/schema/seed/
  startup/remote/deployment action occurred.

- Reconciled the 2026-08-11 integration meeting with the supplied V8 contract
  and corrected two earlier assumptions: V5 remains supported alongside V8,
  and Express may fill only an existing placeholder with authoritative data
  for that exact field.
- Corrected the implementation design at
  `docs/superpowers/specs/2026-08-10-vrs-api-contract-v8-retrofit-design.md`.
  Both strict contracts use `POST /vrs/authorize`; V8-only required keys make
  version detection deterministic, and the durable JSON payload records the
  shape without a schema change.
- The development test has two explicit VRS AI roles: it first sends a V8
  dummy request as a SASHA simulator, then receives the V8 payload from VRS
  Express after a human approves the DEV ticket. This is not a call loop.
- The same Replit project may serve development and production, but the test
  must use the development URL, development database binding, and development
  credentials. Production remains unchanged and unpublished.
- The implementation baseline remains clean Replit publish source `972409d`,
  32/32 focused bridge tests, a passing production build, 45 locally runnable
  tests, and 56 raw / 26 normalized pre-existing TypeScript diagnostics.
- Tasks 1 and 2 provide strict V5/V8 schemas, authenticated version-aware
  intake, and same-version outbound source validation in the isolated
  worktree. No schema operation, push, Replit sync, configuration change,
  deployment, or publication has occurred.
- Wrote the executable red-green plan at
  `docs/superpowers/plans/2026-08-11-vrs-v5-v8-dev-integration.md` and ignored
  `.worktrees/` so runtime work stays isolated from `main` and user output.

## Previous Handoff Snapshot (2026-07-29)

- Finalized the external VRS Express-to-VRS AI implementation handoff.
- External deliverables:
  - `output/doc/VRS-Express-VRS-AI-Handoff-Package.zip`
  - `output/doc/VRS-Express-VRS-AI-Bridge-Integration-Handoff.pdf`
  - `output/doc/VRS-Express-VRS-AI-Bridge-Integration-Handoff.docx`
  - `docs/integration/vrs-express-vrs-ai-bridge-openapi.yaml`
- The ZIP intentionally contains exactly the PDF, editable DOCX, and OpenAPI
  contract. The repository Markdown remains the canonical source for the
  human-readable document.
- Removed individual names and internal meeting, PR, commit, and
  security-incident history from every platform-facing file. The handoff
  identifies VRS Express and VRS AI as the two integration platforms.
- Replaced stale draft metadata with the accurate merged/published source
  status. The document does not expose Git history or live credentials.
- Exported the final DOCX through Microsoft Word to a 10-page PDF. All 10
  rendered pages were reviewed individually with no clipping, overlap, or
  visible internal-name leakage.
- Fresh validation:
  - 32/32 focused bridge tests passed.
  - OpenAPI 3.1 parsed with all 34 local references resolved.
  - The authorize example and all five callback examples passed the committed
    runtime schemas.
  - The deterministic HMAC vector matched the implementation.
  - DOCX/PDF visible text and metadata scans were clean.
  - The ZIP contains exactly the three intended files.
- The package is ready for direct implementation handoff.

## Scope Boundary

- The published VRS Express state and bridge activation status have not been
  revalidated in this V8 design step. Statements below are the 2026-07-29
  snapshot and may be stale.
- At that snapshot, the published VRS Express app contained the merged bridge
  source, but the live bridge was not operational yet.
- All six bridge environment variables remain absent, both bridge routes return
  `503 NOT_CONFIGURED`, and the additive `vrs_ai_calls` /
  `vrs_ai_call_events` tables are absent.
- No production database schema/data change and no deployment were performed in
  this documentation-finalization session.
- Secure keys, callback secrets, and the actual staging callback origin must be
  exchanged outside the handoff package.
- VRS AI still needs to return the three decisions documented in the handoff:
  prompt placement, retryable terminal-failure ownership, and recording access
  retention/authorization/expiry.
- Joint AHS staging evidence remains required before production activation.
- The published app does not expose repository documents as download routes;
  use the direct ZIP/PDF/DOCX/OpenAPI files.
- Local user-owned `graphify-out/` remains untracked and untouched.
- Credential rotation from the prior SSH-output incident remains pending
  Tyler's explicit approval and coordination.

## Notes

- Required staging variables remain documented in
  `docs/architecture/vrs-sasha-api-v5.md`.
- The external integration package contains no live keys, callback secrets, or
  customer data.
- Full `npm run check` has a pre-existing TypeScript baseline: 56 raw
  diagnostics collapse to 26 unique diagnostics after line/column
  normalization. The previously compared branch and fresh `origin/main`
  outputs matched exactly.
