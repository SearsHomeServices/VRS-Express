# Codex Todos - VRS-Agent-Core

Updated: 2026-07-29 11:10

## Done

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

## Open

- [ ] Update Markdown and DOCX metadata from draft PR #1 / `6ec180f` to the
  merged `main` state, regenerate the DOCX, and visually inspect every page
  before external delivery.
- [ ] Package the secure out-of-band exchange for the staging API key, callback
  secret, and actual Express staging callback origin; do not place secrets in
  Git or the handoff documents.
- [ ] Decide whether the external team receives the three files directly or
  whether VRS Express should add an authenticated documentation download
  surface; publishing the app alone does not expose the files.
- [ ] Tyler publishes VRS Express after reviewing the synchronized `main`
  source and documentation package.
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
