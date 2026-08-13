# Codex Todos - VRS-Agent-Core

Updated: 2026-08-13 12:45

## Done

- [x] Diagnose real technician district rejection and normalize the roster's
  exact `000DDDD` representation to the four-digit service-order prefix inside
  VRS Express; callers continue sending only `tech_id`. Verified 151/151
  focused bridge tests, passing build, no new scoped TypeScript diagnostic,
  and live DEV `202` for `dhanse9` / `99081204` after preserving and merging
  the two newer Replit Agent weekly-report commits.

- [x] Fast-forwarded the clean VRS Express Replit DEV workspace and GitHub
  `main` to verified commit `6c69bab`; restarted the configured DEV process
  and confirmed its public health endpoint returns `200`. Confirmed the
  existing bridge tables are present without a schema write.

- [x] Regenerated the platform-only V5/V8 integration package from approved
  source: editable DOCX, matching 10-page PDF, and exact three-file ZIP with
  OpenAPI at archive root. Verified all pages visually, metadata/text scans,
  table geometry, source docs tests (16/16), and exact archive bytes/members.

- [x] Revised the existing bridge architecture, Markdown handoff, and OpenAPI
  for strict V5+V8 compatibility, platform-only DEV placeholders, exact
  request/callback constraints, HMAC, media handling, and active-only terminal
  repeat behavior.
- [x] Added documentation contract tests and final-review coverage for runtime
  intake errors, safe DEV identifiers, callback URL direction, and event
  effects, including status-dependent `SUBMISSION_REJECTED` under both `409`
  and `422`; verified 16/16 docs tests, 150/150 focused non-database bridge
  tests, the production build, and the
  unchanged 56-raw/26-normalized TypeScript baseline.

- [x] Corrected Task 6 to preserve the `972409d` active-only duplicate rule
  with the narrow V8 §2.4 exception: active V5/V8 requests keep the existing
  duplicate response; V5 and nonretryable V8 terminal repeats retain ordinary
  policy; a strict V8 request after a latest locally applied retryable failed
  V8 callback creates a fresh ticket/bridge/public ID by excluding only prior
  eligible V8 bridge ticket IDs from duplicate checks.
- [x] Removed the unapproved ticket/bridge reset, immutable retry snapshot,
  historical-provider callback path, special callback locking, and URL-gated
  PostgreSQL test; retained callback durability and Stage 1
  `dispatch_failed` resend behavior.
- [x] Proved selector eligibility, private duplicate-query exclusions, old
  callback-forward isolation, active duplicate behavior, V5/nonretryable
  isolation, and recurrence with focused intake/docs regressions. Final
  verification is 16/16 intake, 16/16 docs, 150/150 full bridge, a passing
  build, and the known 56-raw TypeScript baseline.

## Open

- [x] Configure the Express-owned Replit DEV bridge values and prove a strict
  V8 Direction A intake with active DEV technician `test_tech_1` and unique
  service order `99081201`.
- [ ] Obtain the VRS AI development `X-API-Key` through a secure channel and
  save it as `VRS_AI_API_KEY`; restart only the DEV process afterward.
- [ ] Before any future production republish, review which synchronized App
  Secrets the deployment will capture and set deliberate production values;
  never publish the DEV bridge URLs or assume workspace configuration is a
  production activation decision.
- [ ] After Tyler approves the design, add a DEV-only, admin-authenticated,
  read-only integration monitor showing intake, Stage 1, outbound dispatch,
  callback, forwarding, and failure checkpoints without secret values.
- [ ] After Tyler approves the bounded photo design and link lifetime, convert
  VRS Express `/objects/` photo paths to direct time-limited object-storage GET
  URLs only for V8 placeholder enrichment during bridge dispatch.
- [x] Produced the platform-only DEV connection sheet with exact environment
  URLs, key direction, safe test technician, unique-SO guidance, and the joint
  test sequence; keep live credentials out of the file.

- [x] Separated unique field-routing proof from empty-value preservation for
  technician name and repair/replace rationale; retained exact `N/A`, `TBD`,
  and zero assertions in the rendered empty-field case.
- [x] Hardened final Task 5 regression coverage with distinct exact-row
  assertions for every review field and a runtime-tested production panel
  that owns null/manual isolation plus V5/V8 status/review composition.
- [x] Verified the final Task 5 rigor pass with 8/8 UI, 30/30 queue, 118/118
  focused bridge tests, a passing build, and the unchanged 56-diagnostic
  baseline.

- [x] Closed the Task 5 review findings with a rendered production review
  component, complete V8/common fields and comment metadata, V8-only row
  gating, conditional V5 optionals, and a directly tested injectable store
  status-loading path.
- [x] Verified the Task 5 correction with 6/6 UI tests, 30/30 queue tests,
  116/116 focused bridge tests, a passing production build, and the unchanged
  56-diagnostic baseline.

- [x] Added derived V5/V8 bridge status and the complete guarded review panel
  with exact placeholder/zero preservation, all V8 business fields, and
  direct safe sender-photo links/previews without Express media tokens.
- [x] Verified Task 5 with 6/6 UI tests, 29/29 affected queue tests, 115/115
  focused bridge tests, a passing production build, and the unchanged
  56-diagnostic TypeScript baseline.

- [x] Closed the Task 4 review gap by removing the test-owned continuation
  wrapper, dynamically testing the production route-gate adapter, and proving
  its actual `approve_submission` call/early-return ordering before all Stage
  1 mutation in `server/routes.ts`.
- [x] Verified the Task 4 correction with 12/12 boundary tests, 109/109 focused
  bridge tests, a passing production build, and the unchanged 56-diagnostic
  baseline with zero Task 4 diagnostics.
- [x] Locked bridge-backed Stage 1 dispatch behind the human approval
  boundary. Manual/PWA tickets now stop after the first bridge lookup without
  configuration/client/dispatch work, and bridge errors cannot reach the
  unchanged update/SMS block.
- [x] Verified initial Task 4 with 8/8 boundary tests, 105/105 focused bridge tests, a
  passing production build, and the unchanged 56-diagnostic TypeScript
  baseline with zero Task 4 diagnostics.
- [x] Preserved V5/V8 through durable bridge JSON and outbound dispatch;
  added V8-only operational phone/rationale fallbacks, placeholder-only
  same-field enrichment, signed TINA pass-through, authenticated-object-path
  rejection, exact key-set checks, and pre-client same-version revalidation.
- [x] Closed Task 3 review gaps by testing route-consumed intake/candidate
  projection helpers and directly exercising dispatch's explicit pre-client
  same-version validation path.
- [x] Verified Task 3 with 27/27 queue tests, 97/97 focused bridge tests, a
  passing production build, and the unchanged 56-diagnostic TypeScript
  baseline with no new Task 3 file diagnostic.
- [x] Adopted the version-aware V5/V8 parser in authenticated
  `POST /vrs/authorize` after 503 configuration and timing-safe 401 checks;
  preserved V5 behavior, response bodies, and no-wire-version intake.
- [x] Added Task 2 route coverage and verified 22/22 API tests, 83/83 focused
  bridge tests, a passing production build, and the 56-diagnostic TypeScript
  baseline with no changed-file diagnostic.
- [x] Corrected the Task 1 review finding: removed the false V5 `ZodObject`
  cast, derived the clean request type separately, and added runtime/type-level
  regression coverage for the exported schema API.
- [x] Added canonical V5/V8 authorize fixtures, strict separate schemas,
  four-key V8 intent selection, non-mutating V8 validation, and version-aware
  outbound source validation with RED/GREEN evidence, including proof that
  `contract_number` and `symptom` do not receive invented maximum lengths.

- [x] Fast-forwarded local `main` to current GitHub `origin/main` at
  `1433f43` without touching user-owned untracked output.
- [x] Compared API Contract V8 with the implemented V5 bridge and identified
  the V6/V7/V8 fields, always-present placeholders, UI gaps, partner mismatch,
  and retryable-terminal retry gap.
- [x] Corrected the contract ownership after the 2026-08-11 integration
  meeting: V5 remains Tech Hub-compatible while V8 is the complete SASHA
  contract; both must coexist.
- [x] Corrected and approved the dual V5/V8 bridge and DEV test design.
- [x] Wrote the task-by-task test-first implementation/verification plan and
  prepared ignored `.worktrees/` isolation.
- [x] Fetched the clean Replit publish source at `972409d`, confirmed it is a
  six-commit fast-forward of GitHub, and rebased the local design onto it.
- [x] Captured the pre-change production baseline: root/health healthy, 32/32
  bridge tests, production build passing, 45 locally runnable tests passing,
  and 56-raw/26-normalized existing TypeScript diagnostics.
- [x] Added explicit production non-regression, isolation, staging, rollback,
  approval, and publication gates to the V8 design.
- [x] Shipped bounded-concurrency photo uploads in `tech-submit`.
- [x] Shipped bounded-concurrency photo uploads in `tech-resubmit`.
- [x] Added safe content-type fallback for upload requests with empty MIME type.
- [x] Enabled lazy image loading for agent/admin media thumbnail grids.
- [x] Reduced API/object-route logging overhead in `server/index.ts`.
- [x] Documented the performance patch set in `CHANGELOG.md`.
- [x] Updated technician after-hours SMS wording to keep business-hours notice without implying agents/admins are blocked until next business day.
- [x] Added legacy after-hours template normalization in `server/sms.ts` for existing template rows.
- [x] Updated Help Center after-hours/pending guidance to match the new processing policy.
- [x] Updated seeded after-hours submission templates to the new policy wording.
- [x] Reconciled Replit, GitHub, and local `main` at commit `98542cf`.
- [x] Added `POST /vrs/authorize` for SASHA API Contract V5.
- [x] Added durable `vrs_ai_calls` admission queue and atomic limits.
- [x] Added exact SASHA callback URL allowlisting and encrypted callback-secret storage.
- [x] Added HMAC-SHA256 webhook signing and the V5 retry policy utility.
- [x] Added 15 V5 contract/queue tests and architecture documentation.
- [x] Located and reviewed the July 24 Granola architecture meeting.
- [x] Confirmed VRS Express is the human approval/data-enrichment bridge and
  VRS AI owns call execution.
- [x] Removed AI-owned admission/rate-limit/worker behavior from VRS Express.
- [x] Implemented authenticated SASHA/Tech Hub V5 intake into a normal pending
  VRS Express ticket.
- [x] Added the AHS-only **Approve & Send to VRS AI** agent action.
- [x] Added the outbound VRS AI `/vrs/authorize` client and dispatch tracking.
- [x] Added the signed/timestamped VRS AI result receiver, existing ticket/SMS
  result application, and signed callback forwarding to SASHA.
- [x] Added event-level callback idempotency and retryable forwarding.
- [x] Separated callback-secret encryption from `SESSION_SECRET`.
- [x] Added focused bridge/UI-copy tests and updated architecture documentation.
- [x] Completed final 32/32 tests, production build, exact `origin/main`
  TypeScript-baseline comparison, commit/push, and draft PR #1 update.
- [x] Created the VRS Express-to-VRS AI integration handoff in Markdown and DOCX plus a matching
  OpenAPI 3.1 contract, deterministic HMAC vector, and staging acceptance
  checklist.
- [x] Validated the OpenAPI/example payloads against the committed schemas and
  visually inspected all 10 rendered DOCX pages.
- [x] Removed the individual owner's name from the platform-facing package,
  renamed all three deliverables, recalculated the neutral HMAC test vector,
  and re-rendered/reviewed all 10 DOCX pages.
- [x] Verified why VRS Express Git Sync showed no changes: Replit and GitHub
  `main` match at `98542cf`, while the pushed bridge is isolated in draft PR #1
  at `4d00c29`.
- [x] Marked PR #1 ready, merged the bridge and documentation into `main`, and
  fast-forwarded local and VRS Express `main` to the merged history.
- [x] Verified all three handoff files on the VRS Express box and reran the
  focused suite (32/32) plus the production build successfully.
- [x] Audited handoff completeness against the merged implementation: 32/32
  tests, 34/34 OpenAPI references, authorize example, five callback examples,
  and deterministic HMAC vector all validated.
- [x] Verified the newly published Replit app is healthy and contains the
  merged bridge routes/client build.
- [x] Confirmed the published bridge is intentionally non-operational: all six
  bridge variables are absent and both additive bridge tables are absent.
- [x] Confirmed repository Markdown/OpenAPI/DOCX paths are not public download
  routes in the published app.
- [x] Refreshed the external handoff to the merged/published source state and
  removed individual names plus internal meeting/PR/commit/security-history
  language from every platform-facing artifact.
- [x] Regenerated the polished 10-page DOCX, exported the matching PDF, and
  visually inspected every rendered page.
- [x] Built `VRS-Express-VRS-AI-Handoff-Package.zip` containing exactly the
  PDF, editable DOCX, and OpenAPI contract for direct delivery.
- [x] Revalidated 32/32 tests, 34/34 OpenAPI references, the authorize example,
  five callback examples, deterministic HMAC vector, external text/metadata,
  and ZIP contents.

## Open

- [ ] Complete the secure VRS Express DEV bridge configuration outside Git:
  `VRS_SASHA_API_KEY`, `VRS_AI_BASE_URL`, `VRS_AI_API_KEY`,
  `VRS_AI_WEBHOOK_SECRET`, `VRS_BRIDGE_ENCRYPTION_KEY`, and either `VRS_AI_CALLBACK_URL` or
  `VRS_EXPRESS_PUBLIC_URL`. Every Express-owned value is now configured and
  verified in the running DEV process; only `VRS_AI_API_KEY` remains missing.
- [ ] Run the joint DEV V5/V8 acceptance exchange using a provisioned DEV
  technician and unique DEV service orders: VRS AI intake, human approval,
  same-version outbound request, all five signed callback shapes, replay, and
  retryable-failed V8 retry.
- [ ] Run the listed manual/PWA, two-stage AHS, First American, NLA, admin,
  media, WebSocket, and SMS smoke checks against the DEV database, then obtain
  separate approval before any production publication.
- [ ] With Tyler's explicit approval and coordination, rotate every credential
  exposed by the 2026-07-28 Replit SSH output: OpenAI, Snowflake key/password/
  passphrase, Twilio auth, Replit identity/DB tokens, `SESSION_SECRET`, VRS API
  keys, and VRS master password. Restart/redeploy only after Tyler approves.
- [ ] Add server-side pagination and SQL-backed search for `/api/submissions` to avoid broad fetch + in-memory filtering under large volumes.
- [ ] Stream CSV export rows instead of building one large in-memory string.
- [ ] Remove duplicate metadata/ACL fetches in object-serving path to reduce image/video time-to-first-byte.
- [ ] Add indexes for hottest submission filters/sorts and verify with `EXPLAIN ANALYZE`.
- [ ] Apply the additive bridge schema to the VRS development DB through the
  approved dev-first pipeline; never push it directly to production.
- [ ] Configure staging `VRS_SASHA_API_KEY`,
  `VRS_BRIDGE_ENCRYPTION_KEY`, `VRS_AI_API_KEY`,
  `VRS_AI_WEBHOOK_SECRET`, and the Express public callback URL.
- [ ] Resolve V5 O-V5-3: how `repair_replace_rationale` enters the AI prompt.
- [ ] Configure/verify the confirmed NextGen staging and production hostnames.
- [ ] Run a real SASHA/Tech Hub → VRS Express → human approval → VRS AI →
  VRS Express callback staging transaction before production approval.
- [ ] Decide with the VRS AI team whether retryable terminal failures are redialed inside
  VRS AI or need an explicit Express retry endpoint/button.
- [ ] Confirm VRS AI recording URL retention, `X-API-Key` authorization, and
  expiry behavior with the VRS AI team.
