# Memory - VRS-Agent-Core

> **Last Touched:** Codex — 2026-07-28 13:07 — Located the July 24 Granola handoff and corrected the VRS Express/VRS AI ownership boundary for draft PR #1.

## Current State
- Replit `main`, GitHub `main`, and local `main` were reconciled at `98542cf` before new work; the Replit worktree was clean.
- Replit's 14-commit lead was transferred over SSH and pushed to GitHub; the stale local checkout was fast-forwarded by 195 commits total.
- Current local branch is `codex/vrs-sasha-api-v5`, pushed at commit `1629114`.
- Draft PR #1 is open: `https://github.com/jtmorgan0513-alt/VRS-Agent-Core/pull/1`.
- The PR adds `POST /vrs/authorize`, strict SASHA V5 validation, a durable `vrs_ai_calls` queue, atomic admission limits, encrypted callback secrets, and HMAC webhook delivery utilities.
- **Do not merge the PR in its current form.** The July 24 Granola meeting
  ("VRS Express API integration — tech hub, Sasha, and AI system endpoints")
  confirms that this repository is the VRS Express approval/data-enrichment
  bridge, not Enzo's VRS AI call-execution service.
- Confirmed target flow: SASHA/Tech Hub payload → VRS Express pending human
  review → new approval action/button → outbound payload to VRS AI → result
  returned to VRS Express, while the existing technician SMS remains in place.
- The supplied V5 contract describes SASHA BFF calling VRS AI directly and
  returning results to SASHA. It does not fully specify the additional VRS
  Express intake/approval boundary required by the meeting.
- Verification: 15/15 focused tests pass, production build passes, and TypeScript comparison shows the same 26 normalized baseline errors on both branch and `origin/main` (0 new).
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

## Open Threads
- [CX] Rework draft PR #1 before review: remove AI-owned call admission,
  rate-limit, and webhook-sender responsibilities from VRS Express.
- [CX] Implement the Express-owned bridge: authenticated SASHA/Tech Hub intake,
  pending human review, a new approval/send-to-AI action, outbound
  `/vrs/authorize` client, signed result callback receiver, ticket status
  updates, and the existing technician SMS path.
- [CX] Do not apply the current `vrs_ai_calls` schema until its role is revised
  for outbound integration tracking and the new design is reviewed.
- [CX] Reconcile the V5 contract's direct SASHA → VRS AI callback model with
  the meeting's SASHA/Tech Hub → VRS Express → VRS AI flow.
- [CX] Resolve V5 O-V5-3 for `repair_replace_rationale` prompt placement.
- [CX] Complete an AHS-only staging transaction through the full Express
  approval bridge before any production approval.
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
