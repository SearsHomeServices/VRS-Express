# Codex Decisions - VRS-Agent-Core

Updated: 2026-08-14 16:28

## Decisions

- [CX] 2026-08-14 - Activate V9 by fast-forwarding the existing Replit DEV
  `main` history after merging its two newer dashboard/publish commits; do not
  overwrite the box, run the configured post-merge database script, or
  publish production. Treat an authenticated real-box `202` plus sanitized
  V9 lookup as the activation proof, while leaving human approval and outbound
  dispatch for the joint test because the contracted VRS AI DEV hostname still
  does not resolve.

- [CX] 2026-08-14 - Implement V9 as a third strict wire shape on the existing
  versionless endpoint. Select V9 before V8 whenever `cta_no` or
  `district_number` is present; require the complete V8 baseline plus both V9
  fields; enforce `cta_no === contract_number`; accept order district only as
  `DDDD` or `N/A`; and preserve both fields unchanged through review and
  dispatch. Treat V9 as V8+ for the already-approved immediate retryable-fail
  and signed-photo paths. Do not change schema, Secrets, routes, callbacks,
  production, or the existing V5/V8 behavior.

- [CX] 2026-08-14 - Treat the platform team's statement that the DEV contract
  key is already configured under another name as authority for a narrow
  compatibility mapping. Only development may use `VRS_SASHA_API_KEY` when
  `VRS_AI_API_KEY` is absent; production must retain an explicit outbound key.
  Do not hide the independent external blocker: the contract VRS AI DEV host
  must resolve publicly from Replit before approval dispatch can succeed.

- [CX] 2026-08-13 - Give VRS AI a read-only service-order retrieval surface
  under the existing VRS Express inbound trust boundary. Reuse the configured
  `X-API-Key`; do not add or depend on `VRS_AI_API_KEY`. Return only the latest
  bridge-received request, strip callback ownership fields, combine its sender
  URLs with linked-ticket photos, sign exact `/objects/` paths for 24 hours,
  cap/de-duplicate at 10, and make no schema or data mutation.

- [CX] 2026-08-13 - Supersede the earlier no-conversion photo boundary after
  Tyler approved VRS AI access to VRS Express photos. Only approved V8
  dispatch with an empty `appliance_photos` placeholder may convert exact
  ticket `/objects/` paths into direct signed Object Storage `GET` URLs. Use a
  24-hour lifetime, preserve sender HTTPS URLs and V5/populated V8 bodies, cap
  at 10, require no Express credential on download, and fail dispatch before
  the VRS AI call when signing fails.

- [CX] 2026-08-11 - Treat the verified Replit workspace sync as DEV source
  activation, not production publication. The box `main` and GitHub `main`
  now share `6c69bab`; the restarted DEV process is healthy, existing bridge
  tables are present, and no schema/data/configuration write was needed.
  Secure bridge variables remain an external DEV activation prerequisite and
  must not be stored in Git or handoff documents.

- [CX] 2026-08-11 - Package the approved V5/V8 handoff as exactly three
  root-level direct-delivery files: matching PDF, editable DOCX, and the
  authoritative OpenAPI YAML. Keep artifact content platform-only and
  development-placeholder-only. A package is complete only after a metadata
  scrub, exact membership/byte check, source-contract test, and every-page
  visual render review; packaging does not authorize any deployment.

- [CX] 2026-08-11 - Revise the existing bridge handoff in place: document V5
  and V8 as strict alternatives on one endpoint, selected only by the four
  V8-only keys, with no wire version or V5 up-conversion. Keep every external
  artifact limited to VRS Express/VRS AI identities and four DEV URL
  placeholders.
- [CX] 2026-08-11 - Treat OpenAPI examples as the machine-readable source for
  V5, V8, and all five callbacks, and require the Markdown copies to match
  them exactly after runtime validation. Model exact stated bounds and avoid
  invented maxima for parts, rationale, contract number, symptom, and numeric
  purchase year.
- [CX] 2026-08-11 - Make development examples intentionally non-runnable until
  the tester supplies an active VRS Express DEV technician in a valid
  four-digit district and a unique eight-digit DEV service order. Publish the
  runtime `409`/`422` body alternatives and callback ticket/SMS effects instead
  of collapsing distinct intake and result outcomes.
- [CX] 2026-08-11 - Document `SUBMISSION_REJECTED` in both authorize status
  families: it is `409` when the captured ticket status maps to a conflict and
  `422` for other submission rejections. Both use the generic error/message
  response shape.

- [CX] 2026-08-11 - Preserve the `972409d` active-only bridge rule while adding
  the narrow V8 §2.4 immediate retry. V5 and nonretryable V8 terminal repeats
  retain ordinary policy. A strict V8 request may bypass only prior
  retryable-failed V8 bridge tickets after the latest same-SO failure callback
  is locally applied; it creates a new ticket/bridge/public ID and never resets
  or reuses the prior attempt.
- [CX] 2026-08-11 - Apply the qualifying prior-ID set query-side in all four
  legacy duplicate reads, including the pre-limit 60-second read and both
  atomic transaction reads. Upstream callback forwarding is independent of
  retry eligibility, so old-call forwarding can retry without blocking or
  mutating the new V8 request.
- [CX] 2026-08-11 - Keep the cheap active lookup before technician/user/
  encryption work. After normal ticket creation, rely on the existing
  advisory-locked `createIntake` insert for the final active-race check; do not
  inspect or mutate terminal bridge or callback rows during intake.

- [CX] 2026-08-11 - Use distinct nonempty sentinels in the primary field-map
  fixture, including technician name and repair/replace rationale. Prove empty
  preservation in a separate rendered V8 fixture so a field swap cannot hide
  behind equal empty values.
- [CX] 2026-08-11 - Make `VrsAiBridgePanel` the production owner of nullable
  bridge isolation and the complete status/error/failure/review composition.
  Dashboard source should only pass `selectedSubmission.vrsAi`; runtime panel
  tests prove the conditional behavior. Exact `data-field` assertions with
  distinct fixtures protect against cross-field swaps.

- [CX] 2026-08-11 - Make UI behavior tests render the same presentational
  component used by `agent-dashboard`. Source inspection remains only for the
  enclosing bridge guard and unchanged manual copy. Derived `v8` status owns
  the four V8-only rows; optional V5 partner/grade rows require actual values.
- [CX] 2026-08-11 - Inject only the bridge-status row loader into
  `DrizzleVrsBridgeStore`. This keeps the default Drizzle query unchanged while
  allowing the real `getStatusBySubmissionId` method and projector connection
  to run in focused tests without database access.

- [CX] 2026-08-11 - Derive the review-facing `contractVersion` in the server
  status projection from stored payload shape. Do not persist or return a
  `contract_version` inside request JSON or `reviewContext`; V8-only client
  fields stay optional so V5 remains compatible.
- [CX] 2026-08-11 - Render sender-provided VRS photo URLs byte-for-byte in the
  existing bridge-only panel using safe direct links and no-referrer previews.
  Do not send them through Express token builders, prefetch, or the normal
  submission lightbox because signed TINA URLs are already authorized by the
  sender and must not be rewritten.

- [CX] 2026-08-11 - Prove Stage 1 ordering through a production adapter that
  `processSubmissionHandler` actually consumes. Pair dynamic stop/continue
  tests with one bounded source-structure regression so deleting the call,
  deleting its early return, or moving legacy mutation ahead of it fails.
  Do not move or edit the legacy Stage 1 update/SMS block.
- [CX] 2026-08-11 - Keep Stage 1 mutation and SMS in the existing route block
  and extract only the bridge decision. That decision must load the bridge row
  first, lazily resolve configuration/client/enrichment, dispatch through the
  existing queue, and return bounded HTTP errors; `not_applicable`, accepted,
  and already-dispatched outcomes preserve the legacy fall-through.
- [CX] 2026-08-11 - Route wiring for V8 operational values must consume the
  same focused pure projections covered by tests: one projects sanitized
  intake JSON plus the normal ticket body/phone, and one projects Stage 1
  phone/name/photo enrichment candidates. Enrichment only transforms the
  typed clone; dispatch owns the single explicit same-version validation gate
  immediately before its client call.
- [CX] 2026-08-11 - Keep operational ticket values separate from durable V8
  wire JSON. A directory/user phone may replace wire `N/A` for the normal
  ticket and SMS path, but the stored request keeps `N/A`; if no usable phone
  exists, the normal submission validator blocks ticket creation rather than
  attempting SMS to a placeholder.
- [CX] 2026-08-11 - V8 dispatch enrichment is limited to existing documented
  placeholders in `tech_phone`, `tech_name`, and `appliance_photos`, using
  valid same-field values from the resolved technician and submission.
  Populated sender values and signed URLs win; `/objects/` paths, invalid
  candidates, added keys, and `cta_no` are forbidden. Revalidate the inferred
  stored version before invoking the client; V5 remains unenriched.
- [CX] 2026-08-11 - The existing authenticated `/vrs/authorize` route adopts
  the shared V5/V8 selector only after its existing 503 configuration and
  timing-safe API-key checks. Its intake type is the V5/V8 request union, not
  a new wire version wrapper, so its endpoint, headers, bounded errors, and
  response shapes remain stable.
- [CX] 2026-08-11 - An exported Zod validator must retain its actual runtime
  class in TypeScript. For the V5 passthrough-plus-refinement validator,
  derive the payload type from the clean shape schema rather than falsely
  casting `ZodEffects` to `ZodObject`.
- [CX] 2026-08-11 - Keep `vrsAuthorizeRequestSchema` bound to the unchanged V5
  runtime validator for compatibility while introducing explicit V5/V8
  schemas and `safeParseVrsAuthorizeRequest` for staged caller adoption. Any
  own V8-only key selects V8 exclusively; validation-only trimmed-length
  checks must never transform accepted V8 strings.
- [CX] 2026-08-11 - Apply only field bounds present in the source V8
  contract: `appliance_color` has max 40, while `contract_number` and
  `symptom` are nonblank with no invented maximum. Rely on the existing JSON
  request-body limit for the outer payload bound.

- [CX] 2026-04-27 - Used `origin/main` as the current GitHub source because no `development` branch exists on the remote.
- [CX] 2026-04-27 - For the urgent training need, recommend a single technician-only screen walkthrough instead of separate videos or a polished course.
- [CX] 2026-04-27 - Video scope should cover only technician login, home, new submission, three request types, review, submit, and after-submit status/SMS expectations.
- [CX] 2026-04-27 - Training should explicitly distinguish VRS-supported NLA for Sears Protect / PA / Cinch from AHS / First American NLA, which should stay in TechHub.
- [CX] 2026-05-08 - Prioritized low-risk, high-impact latency fixes first (upload concurrency, lazy media loading, logging overhead reduction) before structural DB/query refactors.
- [CX] 2026-05-08 - Set technician photo upload concurrency to 3 workers as a balance between iPhone/mobile throughput gains and avoiding request storms.
- [CX] 2026-05-08 - Keep verbose API response-body logging opt-in via env flag (`DEBUG_API_BODY_LOGS=true`) to preserve diagnostics without default production overhead.
- [CX] 2026-05-08 - Keep `/objects/*` success logs opt-in (`LOG_ALL_OBJECT_REQUESTS=true`) while always retaining error logs for media troubleshooting.
- [CX] 2026-05-08 - Do not add new business-hours processing blocks for agents/admins; align technician-facing after-hours copy so it communicates posted hours without claiming processing must wait until the next business day.
- [CX] 2026-05-08 - Preserve admin template-edit functionality by keeping template rendering, but normalize legacy "next business day only" phrases in `buildSubmissionReceivedMessage` to apply policy immediately in environments with existing template rows.
- [CX] 2026-07-28 - Treat live Replit as the missing source only after proving its worktree was clean and its 14 commits were a fast-forward descendant of GitHub; transfer over SSH and push with the authenticated local GitHub session rather than storing credentials on Replit.
- [CX] 2026-07-28 - Keep SASHA `/vrs/authorize` separate from `/api/external/v1/*`; the latter is a human-ticket adapter and does not represent an AI call.
- [CX] 2026-07-28 - Define this increment as a durable admission boundary, not a simulated call runner. A `202` response proves queue persistence only.
- [CX] 2026-07-28 - Use a dedicated `VRS_SASHA_API_KEY`, exact callback URL allowlisting, random public call IDs, and AES-256-GCM encryption of callback secrets.
- [CX] 2026-07-28 - Serialize VRS AI call admission with a PostgreSQL transaction advisory lock so duplicate, per-tech, and global-cap checks remain atomic across concurrent service orders.
- [CX] 2026-07-28 - Add only a new table in Drizzle schema and do not run `db:push` against the production-connected Replit environment.
- [CX] 2026-07-28 - Use the July 24 Granola meeting as the ownership source of truth: VRS Express receives/enriches the SASHA/Tech Hub request, waits for a human approval action, then sends to Enzo's VRS AI service.
- [CX] 2026-07-28 - Do not merge the current AI-side admission implementation. Rework it so VRS Express owns intake, human review, outbound AI invocation, callback intake, ticket updates, and existing technician SMS; the AI platform owns call admission, Twilio/AI execution, recording, and webhook delivery.
- [CX] 2026-07-28 - Limit the initial phone-automation path to AHS. Treat First American portal automation as a separate integration pending an execution-capable API or validated scraper; exclude Choice/OEM and defer Assurance.
- [CX] 2026-07-28 - Reuse the normal submission and process handlers at both bridge boundaries so ticket routing, optimistic locks, audits, WebSocket updates, and technician SMS do not fork into a second implementation.
- [CX] 2026-07-28 - Give Express its own public bridge call ID, retain VRS AI's provider call ID separately, replace callback ownership only for the AI hop, and restore the Express call ID when forwarding events to SASHA.
- [CX] 2026-07-28 - Use a separate event ledger because `requires_info` may precede a terminal event and because a failed SASHA forward must resume without repeating ticket or SMS side effects.
- [CX] 2026-07-28 - Use `VRS_BRIDGE_ENCRYPTION_KEY` instead of `SESSION_SECRET` for stored SASHA callback secrets so auth-secret rotation does not make in-flight callbacks undecryptable.
- [CX] 2026-07-28 - Treat VRS AI `failed` as terminal per V5, surface its reason/retryable flag on the pending ticket, and preserve the existing manual authorization path until Enzo confirms where redial ownership belongs.
- [CX] 2026-07-28 - Give Enzo one versioned partner package with a human-readable handoff, machine-readable OpenAPI 3.1 contract, and deterministic HMAC vector. Treat the committed Express schemas as authoritative when the older V5 narrative differs.
- [CX] 2026-07-28 - Explicitly exclude Phase 2 `queued`, `dialing`, `connected`, and `awaiting_decision` callbacks from the Enzo Phase 1 contract; the Express receiver currently accepts only `approved`, `partial`, `denied`, `failed`, and `requires_info`.
- [CX] 2026-07-28 - Platform-facing integration documentation names only VRS Express and VRS AI. Individual owners must not appear in filenames, titles, ownership tables, readiness sections, examples, or test-vector identifiers.
- [CX] 2026-07-29 - Keep draft PR #1 unmerged until Tyler explicitly approves and the documented dev-schema/staging gates are satisfied. A VRS Express Git Sync while the box remains on `main` cannot pull commits that exist only on `codex/vrs-sasha-api-v5`.
- [CX] 2026-07-29 - Tyler explicitly directed that the bridge and its documentation be placed on `main` for VRS Express publication and sharing. Merge the source now, while retaining the separate rule that schema/configuration/staging validation must complete before activating the live production bridge.
- [CX] 2026-07-29 - Classify the current package as wire-contract complete but not final-send-ready. Refresh the stale draft-branch metadata first; keep live keys/secrets out of the documents, and treat the three VRS AI decisions plus joint staging evidence as required completion inputs.
- [CX] 2026-07-29 - Distinguish source publication from bridge activation and document distribution. The deployed app contains the merged routes, but missing variables/tables keep them disabled, and repository docs are not served as downloadable files.
- [CX] 2026-07-29 - Deliver one external ZIP containing the polished PDF, editable DOCX, and OpenAPI 3.1 contract. Keep the Markdown as the repository source instead of making the recipient sort through duplicate source formats.
- [CX] 2026-07-29 - External handoff content identifies only VRS Express and VRS AI as the integration platforms. Exclude individual names and internal meeting, PR, commit, credential-incident, and repository-provenance details because they do not help the receiving implementation team.
- [CX] 2026-07-29 - Classify the finalized package as ready for implementation handoff, while continuing to classify the live bridge as inactive until secure configuration, the additive development schema, the three documented VRS AI decisions, and joint staging evidence are complete.
- [CX] 2026-08-10 - Treat API Contract V8 as the authoritative contract that
  should have been implemented originally. Retrofit the existing bridge in
  place; do not create a parallel V8 endpoint or retain V5 as the handoff
  source of truth.
- [CX] 2026-08-10 - Preserve the VRS Express human Stage 1 boundary around the
  V8 wire contract. Store and forward the accepted V8 business payload
  unchanged except for the bridge-owned callback URL and secret.
- [CX] 2026-08-10 - Use clean Replit `main` at `972409d` as the current
  production publish-source baseline because it contains six valid commits
  beyond GitHub. Rebase V8 work on that history; never overwrite the box with
  the older GitHub snapshot.
- [CX] 2026-08-10 - Treat production non-regression as a hard V8 release gate:
  no schema/startup migration, no unguarded non-bridge branch, no new test,
  build, TypeScript, or runtime failure, and no publish without staged legacy
  plus V8 evidence and explicit approval.
- [CX] 2026-08-11 - Supersede the 2026-08-10 single-version decision after the
  integration meeting: retain strict V5 for Tech Hub-compatible requests and
  add strict V8 for SASHA on the same `POST /vrs/authorize` endpoint. Detect
  and preserve the received version from its strict JSON shape; do not add a
  schema column or up-convert V5.
- [CX] 2026-08-11 - VRS Express may enrich outbound V8 only by replacing an
  allowed placeholder in an already-present key with authoritative data for
  that exact field. Never overwrite real input, append keys, invent values, or
  convert authenticated Express object paths into purported TINA URLs.
- [CX] 2026-08-11 - Run the initial two-role integration entirely in DEV: VRS
  AI sends a dummy V8 request as a SASHA simulator, a human approves the DEV
  Express ticket, and Express sends the same-version request to VRS AI DEV.
  Shared source does not permit use of the production database or publication
  without separate evidence and approval.
- [CX] 2026-08-12 - Generate and store the three Express-owned bridge secrets
  only in Replit DEV. Use the V8-confirmed VRS AI staging origin and the live
  VRS Express `.replit.dev` origin under `.replit`'s development-only section;
  never allow those URLs into the production configuration and never copy
  secret values into Git or the external handoff. The VRS AI platform remains
  the authority for its outbound `X-API-Key`.
- [CX] 2026-08-12 - Treat a DEV-only integration monitor as a read-only
  observability surface over existing bridge/ticket/event rows. It must be
  unavailable in production, require admin authentication in DEV, redact
  secrets, and make the Stage 1 hold plus both API directions visually
  auditable without changing bridge behavior.
- [CX] 2026-08-12 - Keep the current production deployment unchanged: live
  inspection confirms it contains none of the new VRS bridge variables. Treat
  any later republish as a separate approval gate because Replit may capture
  synchronized App Secrets; review production secret selection and endpoint
  values before publishing.
- [CX] 2026-08-13 - Treat technician district as VRS Express-owned directory
  data, never an inbound contract field. Accept exact `DDDD` and normalize only
  the observed roster form `000DDDD` to `DDDD`; continue rejecting every other
  district shape instead of guessing.
- [CX] 2026-08-13 - Preserve the Replit Agent's newer weekly-report commits
  when delivering the district fix: merge histories and fast-forward both
  GitHub and Replit rather than resetting either source. Keep the proposed
  object-storage photo delivery separate and approval-gated.
- [CX] 2026-08-11 - Implement runtime changes on an isolated
  `codex/vrs-v5-v8-dev-integration` worktree. Require focused/full regression,
  build, normalized type-diagnostic, final review, and read-only Replit
  reconciliation evidence before any source transfer or configuration change.
