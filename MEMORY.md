# Memory - VRS-Agent-Core

> **Last Touched:** Codex — 2026-08-11 22:40 — Synced the verified V5/V8 branch to the Replit DEV workspace and GitHub; DEV configuration remains the only test blocker.

## Current State
- The verified V5/V8 branch is now live in the VRS Express Replit development
  workspace `main` and GitHub `main` at `6c69bab`. The Replit DEV process was
  restarted and its public health endpoint returned `200`; production was not
  published or changed.
- The DEV database already contains `vrs_ai_calls` and `vrs_ai_call_events`,
  so no schema action is required. The running DEV process is missing
  `VRS_SASHA_API_KEY`, `VRS_AI_BASE_URL`, `VRS_AI_API_KEY`,
  `VRS_AI_WEBHOOK_SECRET`, and both callback/public-URL alternatives. Until
  those secure DEV values are configured, `/vrs/authorize` correctly returns
  `503 NOT_CONFIGURED` and an end-to-end partner test cannot start.
- Next activation step: configure the secure DEV bridge values outside Git,
  use a provisioned DEV technician plus a unique DEV service order, and run
  the documented VRS AI -> VRS Express -> human approval -> VRS AI callback
  acceptance flow. Production publication remains separate.
- Task 8 is complete in the isolated worktree. `output/doc/` now contains the
  regenerated platform-only DOCX, matching 10-page PDF, and direct-delivery
  ZIP. The ZIP has exactly the PDF, editable DOCX, and authoritative OpenAPI
  YAML at its root; no standalone YAML was added under `output/doc/`.
- The package faithfully covers strict V5/V8 selection, two-way DEV flow,
  complete payloads and constraints, response/error behavior, callback HMAC,
  retries/effects, signed photo handling, the narrow immediate retryable V8
  exception, and the acceptance checklist. It uses only the four approved DEV
  URL placeholders and only the two platform identities.
- Local artifact checks pass: source docs 16/16, DOCX table geometry audit,
  DOCX/PDF extracted-text and metadata scans, exact ZIP membership/bytes, and
  visual inspection of all 10 rendered PDF pages. No database, container,
  remote, configuration, deployment, publication, or production action ran.
- Task 7 is implemented in the isolated worktree as an in-place handoff
  revision. The architecture, Markdown handoff, and OpenAPI now describe
  strict V5 and strict V8 on the same route, deterministic four-key selection,
  pending human review before VRS AI dispatch, same-version forwarding,
  exact callback/HMAC behavior, controlled V8 placeholder enrichment,
  signed-photo pass-through, durable dedupe, and active-only duplicate
  behavior.
- Platform-facing sources contain only VRS Express/VRS AI identities and the
  four approved DEV URL placeholders, with no individual names, internal
  source history, live URLs, or credentials. Markdown request/callback
  examples exactly match the runtime-validated OpenAPI examples.
- The handoff now exposes all runtime `409`/`422` intake response alternatives,
  replace-before-test DEV technician/service-order prerequisites, exact
  clean-HTTPS callback direction rules, and the ticket/SMS effects of all five
  callback states.
- `SUBMISSION_REJECTED` appears under both generic response statuses: captured
  ticket conflict statuses return `409`; other submission rejections return
  `422`.
- Task 7 documentation regressions remain green: 16/16 documentation tests
  and 150/150 focused non-database bridge tests, a passing production build,
  and the known 56-raw/26-normalized TypeScript baseline with zero new Task 6
  module diagnostics. No database, container, remote, configuration,
  deployment, or publication action ran.
- Task 6 preserves the `972409d` active-only duplicate model in the isolated
  worktree. The production route uses an injected intake orchestrator with the
  existing cheap active lookup first. Active V5/V8 requests retain the current
  duplicate response before technician, user, encryption, or ticket work.
- V5 and nonretryable V8 terminal repeats remain subject to normal
  ticket/service-order policy. The narrow V8 §2.4 exception applies only when
  a strict V8 request follows a latest same-service-order retryable `failed`
  V8 callback that was locally applied: it creates a new normal ticket, bridge
  row, and public call ID immediately. Only prior retryable-failed V8 bridge
  ticket IDs are excluded from all legacy duplicate queries; active, unrelated,
  V5, and nonretryable rows remain blockers.
- The old ticket, bridge, and event are never reset or reused. Upstream
  callback forwarding is independent rather than a retry precondition: its
  old-call durable ledger may resume without delaying or altering the new V8
  request.
- The unapproved retry reset, immutable prior-attempt snapshot, historical
  provider lookup, special callback locking, and URL-gated PostgreSQL test are
  removed. Callback durability and Stage 1 `dispatch_failed` resend remain
  baseline behavior. Final verification is 16/16 intake and 16/16
  documentation tests, 150/150 full bridge tests, a passing production build,
  and the known 56 raw
  TypeScript diagnostics with zero new Task 6 module diagnostics. No database
  connection/write, container, schema, seed, startup, migration, config,
  remote, deploy, or publish action ran.
- Tasks 1-6 of the V5/V8 integration are implemented in the isolated
  worktree. The dashboard directly consumes a server-render-tested production
  panel whose runtime null guard owns status/errors/failure copy and the
  complete review component. The review includes raw request, technician,
  customer/address, appliance/problem, financial/part, full comment metadata,
  and direct sender-photo context. V8-only rows are version-gated; optional V5
  partner/grade rows render only when present, and manual approval is unchanged.
- Final Task 5 UI coverage renders null, V5, and V8 through the production
  panel. The primary mapping fixture gives every potentially swappable field a
  distinct nonempty value, including technician name and repair/replace
  rationale, and asserts each exact `data-field`. A separate rendered case
  proves those two fields preserve exact empty strings alongside `N/A`, `TBD`,
  and numeric zeroes. Manual/null state renders no bridge panel or bridge copy.
  Final verification is 8/8 UI, 30/30 queue, 118/118 focused bridge tests, a
  passing production build, and the unchanged 56-diagnostic baseline.
- `getStatusBySubmissionId` now consumes an injectable production row-loader
  before deriving `v5`/`v8`; neither `contract_version` nor `contractVersion`
  enters stored request JSON or review context. Task 5 follow-up verification
  is 6/6 UI tests, 30/30 queue tests, 116/116 focused bridge tests, a passing
  production build, and the unchanged 56-raw TypeScript baseline. No schema,
  seed, startup, database, remote, configuration, sync, deployment, or
  publication action ran.
- Tasks 1-4 of the V5/V8 integration are implemented in the isolated
  worktree. V8 gap values now map safely into the normal Express ticket/SMS
  path without mutating durable wire JSON, V5 dispatch remains unchanged,
  and V8 dispatch fills only eligible existing phone/name/empty-photo
  placeholders from valid authoritative values. Signed TINA URLs remain
  byte-identical, authenticated `/objects/` paths and `cta_no` are excluded,
  and the inferred stored version is revalidated before the client.
- Task 4 isolates the Stage 1 bridge decision behind injected boundaries.
  `getBySubmissionId` is the first operation; manual/PWA tickets never read
  VRS AI configuration, construct a client, resolve bridge enrichment, or
  dispatch. Bridge configuration/dispatch failures return before the existing
  Stage 1 update/SMS block, while accepted and already-dispatched calls fall
  through to that legacy block exactly once.
- Task 4 review coverage now exercises the production route-gate adapter used
  by `processSubmissionHandler` and checks the real route structure: the gate
  is inside `approve_submission`, its responded branch returns early, and
  `updateData` plus Stage 1 approval remain afterward. The test-owned
  continuation wrapper was removed.
- Task 4 verification is 12/12 boundary tests, 109/109 focused bridge tests, a
  passing production build, and the unchanged 56-raw TypeScript baseline with
  zero Task 4 diagnostics. No schema, seed, startup, database, remote,
  configuration, sync, deployment, or publication action ran.
- Task 3 review now proves the actual route projections: intake derives the
  normal ticket/resolved phone and immutable sanitized request JSON together,
  while Stage 1 candidates come from submission phone, resolved user name,
  and parsed submission photos. Enrichment no longer validates early;
  dispatch's explicit same-version guard is the single tested pre-client gate.
- Task 3 verification is 27/27 queue tests, 97/97 focused bridge tests, a
  passing production build, and the unchanged 56-raw TypeScript baseline
  with no new Task 3 file diagnostic. No schema, seed, startup, database,
  remote, configuration, sync, deployment, or publication action ran.
- Task 1 of the V5/V8 integration is implemented in the isolated worktree:
  canonical fixtures, strict separate V5/V8 schemas, four-key V8 intent
  selection, versioned safe parsing, and version-aware outbound source
  validation. The existing `vrsAuthorizeRequestSchema` remains the V5
  compatibility export until the API task adopts the version-aware parser.
- Task 1 review correction removed the false `ZodObject` cast from the actual
  V5 `ZodEffects` validator. The clean V5 request type is derived separately,
  so consumers keep the intended payload type without nonexistent `.extend`,
  `.shape`, or `.strict` runtime APIs being advertised.
- Task 1 verification is 78/78 focused bridge tests, a passing production
  build, and the unchanged 56-raw TypeScript diagnostic baseline. No schema,
  seed, startup, database, remote, configuration, or publication action ran.
- Local `main` was fast-forwarded to current GitHub `origin/main` at
  `1433f43`. User-owned `graphify-out/` and `output/audio/` remain untracked
  and untouched.
- V5 and V8 now coexist by the 2026-08-11 integration-meeting correction: V5
  remains Tech Hub-compatible and V8 is the complete SASHA contract. Both use
  the existing authenticated `POST /vrs/authorize` route.
- The corrected implementation design is
  `docs/superpowers/specs/2026-08-10-vrs-api-contract-v8-retrofit-design.md`.
  It uses strict dual-schema parsing, same-version dispatch, controlled
  placeholder-only V8 enrichment, TINA/signed-photo pass-through, and
  active-only terminal-repeat behavior without a schema change.
- Tasks 1 and 2 now provide strict V5/V8 schemas, version-aware authenticated
  intake, and same-version outbound source validation in the isolated
  worktree. `POST /vrs/authorize` keeps its existing 503 configuration and
  timing-safe 401 checks before selecting a schema, then passes the accepted
  V5/V8 payload unchanged to intake; no wire version field was added. Route
  tests prove V8 activation, V5 compatibility, bounded V8 errors, unchanged
  202/409 responses, and response-secret exclusion. The focused suite is
  83/83, the production build passes, and TypeScript remains at the 56-raw
  baseline with no changed-file diagnostic. No schema operation, push, Replit
  sync, deployment, configuration, or publication has occurred. The prior
  live/published status below is a 2026-07-29 snapshot and was not revalidated.
- The executable plan is
  `docs/superpowers/plans/2026-08-11-vrs-v5-v8-dev-integration.md`; runtime
  changes will use ignored worktree `.worktrees/vrs-v5-v8-dev-integration`.
- Read-only reconciliation found the clean Replit publish source at `972409d`,
  six commits ahead of GitHub `1433f43`. Local V8 design work is now rebased on
  `972409d`; no Replit file or live configuration was changed.
- Pre-change evidence: published root 200, health/DB check healthy, 32/32
  focused bridge tests, production build passing, 45 locally runnable tests
  passing, and a 56-raw/26-normalized pre-existing TypeScript baseline. The 17
  remaining intake tests require a local server/database and are not silently
  counted as product failures.
- The V5/V8 integration is blocked from publication if it changes schema/startup migrations,
  leaks into a non-bridge workflow, adds any regression, lacks staged legacy
  and V8 evidence, or lacks explicit sync/publish approval.
- The VRS Express-to-VRS AI bridge source is merged and published on `main`.
- The external implementation handoff is ready for direct delivery as
  `output/doc/VRS-Express-VRS-AI-Handoff-Package.zip`; it contains exactly the
  polished PDF, editable DOCX, and OpenAPI 3.1 contract.
- Platform-facing content identifies VRS Express and VRS AI as the two
  platforms and excludes individual names plus internal meeting, PR, commit,
  repository-provenance, and credential-incident details.
- Fresh validation passed: 32/32 focused tests, 34/34 local OpenAPI references,
  the authorize example, all five callback examples, the deterministic HMAC
  vector, DOCX/PDF metadata and text scans, exact ZIP contents, and visual
  review of all 10 rendered pages.
- The published `https://vrs-auth-tool.replit.app` remains healthy and contains
  the bridge routes, but both return `503 NOT_CONFIGURED`; all six bridge
  variables and both additive bridge tables are absent.
- The handoff is implementation-ready, not activation proof. Secure staging
  configuration, the additive development schema, three VRS AI decisions, and
  joint AHS staging evidence remain required.
- Repository handoff paths are not public download routes in the published app;
  deliver the finalized files directly.
- No production database change or deployment was performed during the handoff
  refresh. Local user-owned `graphify-out/` remains untracked and untouched.
- [HANDOFF] Credentials exposed in the prior Replit SSH task output still
  require Tyler-approved coordinated rotation before they are relied on.

## Recent Decisions
- [CX] 2026-08-11 - Regenerate external handoff artifacts only after the
  corrected source contract is approved. Ship one direct-delivery ZIP with
  exactly the PDF, editable DOCX, and authoritative OpenAPI YAML at archive
  root. Treat visual render review, text/metadata scrub, and exact archive
  membership as package completion gates; do not imply any deployment or
  activation.
- [CX] 2026-08-11 - Keep `SUBMISSION_REJECTED` in both documented authorize
  status families because runtime status mapping depends on the captured ticket
  result: conflicts are `409`, while other submission rejections are `422`.
- [CX] 2026-08-11 - Revise the existing bridge handoff in place, keeping V5
  and V8 as strict alternatives on one endpoint with no wire version or V5
  up-conversion. Use only the four approved DEV URL placeholders in the
  platform-facing sources.
- [CX] 2026-08-11 - Keep the OpenAPI V5, V8, and five callback examples
  machine-readable and runtime-validated, then require the Markdown copies to
  match exactly. Encode only documented limits; do not invent maxima for the
  parts array, rationale, contract number, symptom, or numeric purchase year.
- [CX] 2026-08-11 - Supersede the unapproved retry-reset design while retaining
  the required narrow V8 §2.4 immediate retry: an active call remains the
  established duplicate response; V5 and nonretryable V8 terminal repeats use
  ordinary ticket/SO policy. A strict V8 request after the latest locally
  applied retryable failed V8 callback creates a fresh ticket/bridge/public ID
  by excluding only every prior eligible V8 bridge ticket ID from duplicate
  queries. Do not reuse/reset old rows or require upstream forwarding.
- [CX] 2026-08-11 - Keep active duplicate lookup before technician/user/
  encryption work. Normal ticket creation remains outside the advisory-locked
  fresh bridge insert; the existing `createIntake` lock is the final active
  race check and does not inspect terminal rows.
- [CX] 2026-08-11 - Keep field-routing proof and empty-value proof in separate
  rendered V8 fixtures. The routing fixture uses unique nonempty sentinels for
  every swappable field; the preservation fixture uses exact empty technician
  name and rationale values plus `N/A`, `TBD`, and zeroes.
- [CX] 2026-08-11 - Put the bridge null guard and full outer status/error/
  failure composition in `VrsAiBridgePanel`, then have the dashboard always
  pass its nullable `selectedSubmission.vrsAi`. Runtime rendering, not a JSX
  source conditional, is authoritative for manual isolation. Use distinct
  field fixtures plus exact row assertions so swapped fields fail tests.
- [CX] 2026-08-11 - Test bridge review behavior by rendering the exact
  production component consumed inside the dashboard's `vrsAi` guard. Keep
  only narrow source assertions for guard placement/manual copy. Gate the four
  V8-only rows on derived version and conditionally render optional V5
  partner/grade rows instead of showing blank labels.
- [CX] 2026-08-11 - Give `DrizzleVrsBridgeStore` an injectable status-row
  loader so tests invoke the real `getStatusBySubmissionId` method, its
  submission-ID forwarding, and the shared projection without a database.
  The default loader retains the exact existing Drizzle query.
- [CX] 2026-08-11 - Derive bridge `contractVersion` from the stored strict
  payload only in the status projection. Keep version out of both durable
  request JSON and `reviewContext`; keep V8-only review keys optional for V5.
  Render sender photo URLs directly in the existing bridge guard with safe
  link/referrer attributes and no Express media-token or lightbox path.
- [CX] 2026-08-11 - Route-order safety needs proof at the production consumer,
  not only at the isolated decision helper. Use a small route-gate adapter for
  dynamic stop/continue behavior plus a bounded structural assertion on the
  actual process handler; keep the byte-equivalent legacy mutation/SMS block
  outside and after that gate.
- [CX] 2026-08-11 - Make the durable bridge-row lookup the first Stage 1
  integration operation. Resolve configuration, construct the outbound
  client, and load enrichment only after that row exists; map bridge errors to
  bounded HTTP decisions and leave the legacy update/SMS implementation after
  the decision unchanged.
- [CX] 2026-08-11 - Keep route mapping testable through focused pure helpers
  that `server/routes.ts` actually consumes. Let enrichment operate only on
  the typed clone, then make dispatch's explicit safe-parse/version comparison
  the single validation gate immediately before the client.
- [CX] 2026-08-11 - Separate V8 operational fallbacks from durable wire JSON:
  resolved phone/name may support the normal ticket and eligible outbound
  placeholders, but stored request fields stay as received. Keep V5
  unenriched; for V8, never overwrite populated values, append keys, expose
  authenticated `/objects/` media, or alter sender-provided signed URLs, and
  revalidate the inferred version before client dispatch.
- [CX] 2026-08-11 - Adopt `safeParseVrsAuthorizeRequest` at the existing
  authenticated `/vrs/authorize` boundary only after the existing missing-
  configuration and timing-safe API-key gates. Intake receives the accepted
  V5/V8 union with no added wire version; response status codes and bodies
  remain compatibility behavior.
- [CX] 2026-08-11 - Export the V5 validator with its actual `ZodEffects`
  runtime type. Derive `VrsAuthorizeV5Request` from the clean object-shape
  schema separately; never cast an effects schema to `ZodObject` merely to
  influence payload inference.
- [CX] 2026-08-11 - Preserve the legacy `vrsAuthorizeRequestSchema` as the V5
  compatibility export while adding explicit V5/V8 schemas and a four-key
  intent selector. V8 nonblank checks inspect trimmed length without applying
  transforms, so accepted business strings and signed URLs remain unchanged.
  Do not invent `maxLength` rules for V8 `contract_number` or `symptom`; the
  source contract defines none, while `appliance_color` remains capped at 40.
- [CX] 2026-08-11 - Execute in an isolated
  `codex/vrs-v5-v8-dev-integration` worktree and require local regression,
  final review, read-only Replit reconciliation, and an explicit rollout
  checkpoint before source sync, config changes, or publication.
- [CX] 2026-08-11 - Supersede the 2026-08-10 single-version conclusion. Keep
  strict V5 and add strict V8 on the same endpoint, infer the version from the
  stored strict payload, and never up-convert V5.
- [CX] 2026-08-11 - Permit outbound enrichment only for an existing V8 key
  whose value is a documented placeholder and only from authoritative Express
  data for that exact field. Never add keys or rewrite TINA/signed photo URLs.
- [CX] 2026-08-11 - The first integration test is DEV-only: VRS AI acts as a
  SASHA simulator for intake, then receives the approved payload as VRS AI.
  Use the development URL/database/configuration and leave production
  unpublished.
- [CX] 2026-08-10 - V8 supersedes V5 as the single contract source. Retrofit
  the existing `/vrs/authorize` bridge in place while preserving the VRS
  Express Stage 1 human gate and unrelated manual workflows.
- [CX] 2026-08-11 - Make retry eligibility locally durable rather than
  upstream-forwarded: terminal callback application establishes the old V8
  failure state, while its callback forward retry stays isolated by old call
  ID. This permits the required immediate fresh request without mutating the
  prior ticket, bridge, or event rows.
- [CX] 2026-08-10 - The Replit workspace is the publish source. Base V8 on
  clean Replit commit `972409d`, not the six-commit-older GitHub mirror.
- [CX] 2026-08-10 - Require zero regression from the captured baseline plus
  staged legacy-workflow and V8 end-to-end proof before publication. Keep all
  new runtime behavior behind integration-route or bridge-row guards.
- [CX] 2026-04-27 - Treated Tyler's "development" wording as a request for the latest published development state, but verified GitHub branch reality before pulling. Since no `development` branch exists, fast-forwarded `main` from `origin/main`.
- [CX] 2026-04-27 - Recommended one 7-9 minute technician-only screen walkthrough for the 2026-04-28 East Coast meeting, scoped to the three technician request types and excluding agent/admin flows.
- [CX] 2026-07-28 - Kept the SASHA AI-call contract separate from the existing `/api/external/v1/*` human-ticket API.
- [CX] 2026-07-28 - Implemented a durable admission boundary only; `202 queued` does not claim the Twilio/AI worker has dialed AHS.
- [CX] 2026-07-28 - Used a dedicated API key, exact SASHA callback allowlist, AES-256-GCM callback-secret encryption, random public call IDs, and transaction advisory locking.
- [CX] 2026-07-28 - Did not apply the additive table to any production-connected database; schema rollout remains dev-first through the normal deployment pipeline.
- [CX] 2026-07-28 - The July 24 Granola meeting is the architecture source of truth for this integration: VRS Express receives/enriches the request, holds it for human approval, then calls Enzo's VRS AI service. The current draft PR implements AI-owned behavior on the Express side and must be reworked before merge.
- [CX] 2026-07-28 - Phase 1 automation is AHS phone authorization. First American is a separate portal workflow whose execution-capable API remains unvalidated; Choice and OEM partners are excluded, and Assurance follows after AHS/FA validation.
- [CX] 2026-07-28 - Reused the normal Express create/process handlers at both bridge boundaries so routing, audit fields, optimistic locks, WebSocket updates, and technician SMS remain one implementation.
- [CX] 2026-07-28 - Gave Express and VRS AI separate call IDs and added an event ledger so `requires_info` can precede a terminal event and failed SASHA forwarding can resume without reapplying ticket/SMS side effects.
- [CX] 2026-07-28 - Separated bridge-secret encryption from `SESSION_SECRET`; rotating an auth secret must not make in-flight SASHA callbacks undecryptable.
- [CX] 2026-07-28 - Treat VRS AI `failed` as terminal under V5 but leave the Express ticket pending for the existing manual path; Enzo must confirm whether retryable failures are redialed by AI or need an explicit Express retry action.
- [CX] 2026-07-28 - Use a paired human-readable handoff plus OpenAPI 3.1 as the Enzo integration source, with the committed Express schemas authoritative over older narrative examples.
- [CX] 2026-07-28 - Do not include Phase 2 intermediate call-state callbacks in the Enzo Phase 1 contract; Express currently accepts only the five implemented V5 result shapes.
- [CX] 2026-07-28 - Use only the VRS Express and VRS AI platform names in external integration artifacts; individual owner names remain internal context only.
- [CX] 2026-07-29 - Do not treat a pushed feature branch as deployed or present on VRS Express `main`. Keep PR #1 unmerged until Tyler explicitly approves and the documented dev-schema/staging gates are satisfied.
- [CX] 2026-07-29 - Tyler explicitly directed that PR #1 be merged so the bridge and documentation are on VRS Express `main`. Source merge is approved; production bridge activation remains gated by the dev schema, staging configuration, and end-to-end AHS validation.
- [CX] 2026-07-29 - Treat the handoff as wire-contract complete but not final-send-ready until the stale draft metadata is refreshed. Live secrets stay out of documents; VRS AI decisions and staging proof remain separate completion inputs.
- [CX] 2026-07-29 - A published source build is not proof of an operational bridge or a document-delivery surface. Require live configuration/schema/staging evidence for activation, and deliver the handoff files directly or through an explicitly implemented protected route.
- [CX] 2026-07-29 - Finalized the external handoff as one direct-delivery ZIP containing the PDF, editable DOCX, and OpenAPI contract. Keep only VRS Express and VRS AI as platform identities; omit people and internal provenance because those details do not help implementation.
- [CX] 2026-07-29 - The handoff package is ready to send even though activation is not complete. The document explicitly carries the remaining secure configuration, development-schema, VRS AI decision, and joint staging gates instead of implying the live bridge works.

## Open Threads
- [CX] Obtain explicit approval before push, Replit sync, configuration change,
  or publication.
- [CX] Run the staged non-bridge workflow matrix and record a rollback target
  before classifying V8 as safe to publish.
- [CX] Prepare the secure staging key/secret/callback-origin exchange outside
  Git and collect the three VRS AI decisions plus joint acceptance evidence.
- [CX] Resolve V5 O-V5-3 for `repair_replace_rationale` prompt placement.
- [CX] Apply the additive bridge schema to the VRS development database only
  through the approved dev-first pipeline; never push it directly to prod.
- [CX] Configure the staging bridge/API/HMAC secrets and Express public callback
  URL without exposing their values in Git or task output.
- [CX] Complete an AHS-only staging transaction through the full Express
  approval bridge before any production approval.
- [CX] A qualifying strict V8 retry after a locally applied retryable failed
  V8 callback creates a normal new VRS Express request; V5 and nonretryable
  terminal repeats retain ordinary policy. No Express ticket-reset endpoint or
  button is part of this bridge contract.
- [CX] Confirm VRS AI recording URL retention, `X-API-Key` authorization, and
  expiry behavior.
- [CX] Validate an execution-capable First American portal path separately
  before including it; Choice/OEM remain excluded and Assurance remains later.
- [HANDOFF] Rotate exposed Replit environment credentials before relying on
  them again: OpenAI, Snowflake credentials/key material, Twilio auth,
  Replit identity/DB tokens, `SESSION_SECRET`, VRS API keys, and VRS master
  password. Do not rotate or restart without Tyler's approval and coordination.

## Gotchas & Lessons
- [CX] 2026-08-11 - URL placeholders make external handoffs safe to share but
  are not valid runtime callback URLs. Documentation tests should substitute a
  known permitted test callback only for runtime schema validation, while
  separately proving that platform-facing sources contain no live URLs.
- [CX] 2026-08-11 - Never invoke global-DB ticket creation from inside a
  Drizzle transaction callback. Normal ticket creation must complete before
  the existing advisory-locked fresh bridge insert so pool connections cannot
  deadlock on nested global DB work.
- [CX] 2026-08-11 - A rendered page containing all expected values can still
  pass after two fields are swapped when fixture values overlap or assertions
  search the whole markup. Give swappable fields unique values and assert each
  against its own stable rendered row.
- [CX] 2026-08-11 - Source containment tests can prove labels exist while
  missing incomplete rendering, blank V5-only rows, and lost comment metadata.
  Render the production presentational component and assert its values,
  conditional rows, arithmetic, and safe link attributes instead.
- [CX] 2026-08-11 - `agent-dashboard.tsx` already owns four diagnostics in
  the 56-raw TypeScript baseline. A changed-file name filter alone therefore
  cannot classify Task 5 regressions; the unchanged total of 56 is the
  relevant zero-new-diagnostic comparison.
- [CX] 2026-08-11 - A test-owned continuation wrapper can prove its own branch
  logic while missing a deleted or reordered production route guard. Coverage
  of ordering invariants must include the actual route consumer or another
  production seam that the route demonstrably uses.
- [CX] 2026-08-11 - Passing a preloaded bridge row through a narrow dispatcher
  store adapter avoids a second database lookup while preserving dispatch's
  existing store contract. Without the outer lookup, manual tickets can read
  configuration or construct an outbound client before isolation is known.
- [CX] 2026-08-11 - V8 permits operationally unusable gap values such as an
  empty rationale, `tech_phone: "N/A"`, `symptom: "N/A"`, and
  `failure_cause: "other"`. Keep their wire representation intact, but derive
  nonempty internal ticket values and reject/ignore invalid enrichment
  candidates so placeholders never become SMS recipients or outbound facts.
- [CX] 2026-04-27 - Bundled `rg.exe` failed with Windows `Access is denied`; PowerShell `Select-String` worked as the fallback.
- [CX] 2026-04-27 - Project root had no `MEMORY.md` and no `.Codex/memory` directory at session start, despite repo instructions requiring both to be maintained.
- [CX] 2026-07-28 - `git push` from the Replit shell hung on an HTTPS credential prompt. Safe path: fetch the Replit branch over SSH into the authenticated local checkout, verify fast-forward ancestry, then push locally.
- [CX] 2026-07-28 - `npm run check` is not clean on `main`; compare normalized diagnostics against a fresh baseline instead of claiming the whole repository type-checks.
- [CX] 2026-07-28 - A nested `ssh ... sh -c` quoting failure executed `set`
  without the intended options and printed the Replit environment. Never place
  shell setup plus verification in a nested quoted command on this box; use
  single direct commands and ensure secret-bearing environment output is
  impossible.
- [CX] 2026-07-28 - The V5 document's architecture diagram skips VRS Express
  and assigns `/vrs/authorize`, call admission, Twilio/AI execution, and
  outbound callbacks to VRS AI. Read it together with the July 24 Granola
  meeting; implementing the contract literally in this repository puts the AI
  service on the wrong side of the bridge.
- [CX] 2026-07-28 - Windows OpenSSH hung against the Replit host in this
  environment; Git's bundled `C:\Program Files\Git\usr\bin\ssh.exe` completed
  the same read-only verification successfully.
- [CX] 2026-07-29 - Removing a DOCX hyperlink element without removing or
  replacing its relationship can leave a dangling `rId` that Word repairs on
  open. Flatten external hyperlink text and audit every relationship before
  exporting the final PDF.
