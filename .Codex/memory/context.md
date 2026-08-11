# Codex Context - VRS-Agent-Core

Updated: 2026-08-11 19:56

## Current Session

- Closed the final Task 5 rigor findings test-first. A production
  `VrsAiBridgePanel` now owns the nullable guard plus outer state, dispatch
  error, failed/retryable copy, and complete review. The dashboard passes its
  nullable bridge directly; rendered tests prove null/manual state produces no
  bridge UI and V5/V8 produce their exact status/review.
- Rebuilt the V8 fixture with unique values for every swappable field and
  assert each against its exact `data-field`: both distinct addresses, all
  request/technician/customer/appliance/problem fields, empty strings,
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
