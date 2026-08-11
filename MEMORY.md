# Memory - VRS-Agent-Core

> **Last Touched:** Codex — 2026-08-10 22:55 — Approved and documented the authoritative V8 retrofit after syncing local main to current GitHub.

## Current State
- Local `main` was fast-forwarded to current GitHub `origin/main` at
  `1433f43`. User-owned `graphify-out/` and `output/audio/` remain untracked
  and untouched.
- API Contract V8 is now the authoritative wire contract by explicit project
  direction; V5 was the incomplete contract supplied during the original
  implementation.
- The approved implementation design is
  `docs/superpowers/specs/2026-08-10-vrs-api-contract-v8-retrofit-design.md`.
  It keeps the same endpoint and VRS Express Stage 1 gate, adopts all V8
  fields/placeholders, and adds same-ticket retryable-failure rearming with a
  new call ID and existing-ledger audit preservation.
- No V8 runtime code, schema operation, push, Replit sync, deployment, or
  publication has occurred yet. The prior live/published status below is a
  2026-07-29 snapshot and was not revalidated in this design step.
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
- [CX] 2026-08-10 - V8 supersedes V5 as the single contract source. Retrofit
  the existing `/vrs/authorize` bridge in place while preserving the VRS
  Express Stage 1 human gate and unrelated manual workflows.
- [CX] 2026-08-10 - Use the existing bridge row and event ledger for a
  retryable terminal-failure rearm: new Express call ID, new payload/secret,
  same requeued ticket, prior-attempt audit snapshot, and late old-callback
  acknowledgement. No schema change.
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
- [CX] Implement the approved V8 retrofit test-first, update all platform-only
  handoff artifacts, and complete local verification.
- [CX] Obtain explicit approval before push, Replit sync, configuration change,
  or publication.
- [CX] Prepare the secure staging key/secret/callback-origin exchange outside
  Git and collect the three VRS AI decisions plus joint acceptance evidence.
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
- [CX] 2026-07-29 - Removing a DOCX hyperlink element without removing or
  replacing its relationship can leave a dangling `rId` that Word repairs on
  open. Flatten external hyperlink text and audit every relationship before
  exporting the final PDF.
