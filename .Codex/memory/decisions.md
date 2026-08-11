# Codex Decisions - VRS-Agent-Core

Updated: 2026-08-10 22:55

## Decisions

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
- [CX] 2026-08-10 - Implement V8 retryable terminal failure as a new public
  call ID on the same Express ticket, preserving the previous attempt in the
  existing event ledger and requiring another Stage 1 review; avoid a schema
  change and acknowledge late callbacks for superseded terminal attempts.
