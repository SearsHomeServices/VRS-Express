# Memory - VRS-Agent-Core

> **Last Touched:** Codex — 2026-07-29 09:08 — Verified the bridge is pushed to a draft feature PR, not merged into the Replit-synced main branch.

## Current State
- Replit `main`, GitHub `main`, and local `main` were reconciled at `98542cf`
  before new work. A fresh post-implementation SSH check confirmed Replit is
  still clean on `main...origin/main` at `98542cf`.
- Current branch is `codex/vrs-sasha-api-v5`; its corrected bridge
  implementation is pushed for review in draft PR #1.
- Draft PR #1 is open: `https://github.com/jtmorgan0513-alt/VRS-Agent-Core/pull/1`.
- Live 2026-07-29 verification confirmed GitHub `main` and the clean VRS
  Express Replit checkout both remain at `98542cf`; the latest bridge
  implementation/artifact commit on the feature branch is `4d00c29`. Git Sync
  on Replit `main` therefore has nothing to pull until the PR is merged.
- The corrected PR implements the meeting-confirmed flow:
  SASHA/Tech Hub → normal VRS Express pending ticket → human
  **Approve & Send to VRS AI** action → VRS AI → signed result callback
  → normal VRS Express result/SMS handling → signed SASHA callback.
- Phase 1 is AHS-only. The bridge reuses the existing submission and process
  handlers, persists safe review context, tracks AI dispatch separately, and
  uses an event ledger so a callback retry cannot repeat the ticket/SMS action.
- SASHA callback secrets are encrypted with the dedicated
  `VRS_BRIDGE_ENCRYPTION_KEY`; they are excluded from staff API projections.
- Verification: 32/32 focused tests pass, the production build passes, and a
  fresh `origin/main` worktree comparison produced the exact same 56 raw / 26
  normalized pre-existing TypeScript diagnostics (zero branch delta).
- The VRS Express-to-VRS AI partner package now exists as Markdown, OpenAPI 3.1, and a polished
  10-page DOCX. It covers exact request/response/callback contracts, HMAC test
  vector, retries/idempotency, staging acceptance evidence, and VRS AI's three
  remaining decisions.
- Platform-facing package filenames, headings, ownership language, readiness
  checks, and test-vector identifiers now reference only VRS Express and VRS
  AI. All 10 revised DOCX pages were rendered and visually reviewed.
- The OpenAPI parses with all local references resolved; its authorize example
  and all five callback examples pass the committed Zod schemas; the HMAC
  vector matches the implementation. All DOCX pages were rendered and visually
  inspected.
- No production DB schema/data change and no deployment were performed.
- Local user-owned `graphify-out/` remains untracked and untouched.
- [HANDOFF] Final SSH verification accidentally printed the Replit environment
  into the task tool output due to nested-shell quoting. Treat every secret
  present on the box as exposed; rotation is pending Tyler's explicit approval.

## Recent Decisions
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

## Open Threads
- [CX] After explicit merge approval and completion of the dev/staging gates,
  merge PR #1 into `main`, sync VRS Express, and verify the exact resulting
  commit on the box.
- [CX] Resolve V5 O-V5-3 for `repair_replace_rationale` prompt placement.
- [CX] Apply the additive bridge schema to the VRS development database only
  through the approved dev-first pipeline; never push it directly to prod.
- [CX] Configure the staging bridge/API/HMAC secrets and Express public callback
  URL without exposing their values in Git or task output.
- [CX] Complete an AHS-only staging transaction through the full Express
  approval bridge before any production approval.
- [CX] Confirm with the VRS AI team whether retryable terminal failures are redialed by
  VRS AI or require an explicit Express retry endpoint/button.
- [CX] Confirm VRS AI recording URL retention, `X-API-Key` authorization, and
  expiry behavior.
- [CX] Validate an execution-capable First American portal path separately
  before including it; Choice/OEM remain excluded and Assurance remains later.
- [HANDOFF] Rotate exposed Replit environment credentials before relying on
  them again: OpenAI, Snowflake credentials/key material, Twilio auth,
  Replit identity/DB tokens, `SESSION_SECRET`, VRS API keys, and VRS master
  password. Do not rotate or restart without Tyler's approval and coordination.

## Gotchas & Lessons
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
