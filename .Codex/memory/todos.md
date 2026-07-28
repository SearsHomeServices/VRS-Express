# Codex Todos - VRS-Agent-Core

Updated: 2026-07-28 13:07

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
  Enzo's VRS AI platform owns call execution.

## Open

- [ ] Rework draft PR #1 (`codex/vrs-sasha-api-v5`) before review or merge.
- [ ] With Tyler's explicit approval and coordination, rotate every credential
  exposed by the 2026-07-28 Replit SSH output: OpenAI, Snowflake key/password/
  passphrase, Twilio auth, Replit identity/DB tokens, `SESSION_SECRET`, VRS API
  keys, and VRS master password. Restart/redeploy only after Tyler approves.
- [ ] Add server-side pagination and SQL-backed search for `/api/submissions` to avoid broad fetch + in-memory filtering under large volumes.
- [ ] Stream CSV export rows instead of building one large in-memory string.
- [ ] Remove duplicate metadata/ACL fetches in object-serving path to reduce image/video time-to-first-byte.
- [ ] Add indexes for hottest submission filters/sorts and verify with `EXPLAIN ANALYZE`.
- [ ] Remove AI-owned admission/rate-limit/webhook-sender behavior from the
  VRS Express side of the draft.
- [ ] Define and implement authenticated SASHA/Tech Hub intake into a pending
  VRS Express review ticket.
- [ ] Add the new human approval/send-to-VRS-AI action and UI button.
- [ ] Add the outbound VRS AI `/vrs/authorize` client and outbound-call
  tracking suitable for VRS Express.
- [ ] Add a signed VRS AI result callback receiver that updates the ticket and
  preserves the existing technician SMS flow.
- [ ] Gate Phase 1 automation to AHS; keep First American portal automation
  separate until its execution path is validated.
- [ ] Do not apply the current `vrs_ai_calls` schema until the Express-side
  tracking design is reworked and reviewed.
- [ ] Resolve V5 O-V5-3: how `repair_replace_rationale` enters the AI prompt.
- [ ] Configure/verify the confirmed NextGen staging and production hostnames.
- [ ] Run a real SASHA/Tech Hub → VRS Express → human approval → VRS AI →
  VRS Express callback staging transaction before production approval.
