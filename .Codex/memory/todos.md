# Codex Todos - VRS-Agent-Core

Updated: 2026-07-28 12:31

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

## Open

- [ ] Add server-side pagination and SQL-backed search for `/api/submissions` to avoid broad fetch + in-memory filtering under large volumes.
- [ ] Stream CSV export rows instead of building one large in-memory string.
- [ ] Remove duplicate metadata/ACL fetches in object-serving path to reduce image/video time-to-first-byte.
- [ ] Add indexes for hottest submission filters/sorts and verify with `EXPLAIN ANALYZE`.
- [ ] Apply the additive `vrs_ai_calls` schema to the VRS development DB only, then promote through the normal deployment pipeline.
- [ ] Configure `VRS_SASHA_API_KEY` in staging through the environment secret manager.
- [ ] Build the Twilio/AI AHS call worker that claims queued VRS AI calls and drives state transitions.
- [ ] Add Snowflake `cta_no` lookup from `IH_SERVICEORDER_FULLDETAIL_TBL`.
- [ ] Persist webhook events/attempts and invoke `deliverVrsWebhook()` from the call worker.
- [ ] Implement protected recording retrieval and populate `recordingUrl`.
- [ ] Resolve V5 O-V5-3: how `repair_replace_rationale` enters the AI prompt.
- [ ] Configure/verify the confirmed NextGen staging and production hostnames.
- [ ] Run a real SASHA → VRS → callback staging transaction before production approval.
