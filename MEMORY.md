# Memory - VRS-Agent-Core

> **Last Touched:** Codex — 2026-07-28 12:36 — Reconciled Replit/GitHub and opened draft PR #1 for the SASHA V5 admission queue.

## Current State
- Replit `main`, GitHub `main`, and local `main` were reconciled at `98542cf` before new work; the Replit worktree was clean.
- Replit's 14-commit lead was transferred over SSH and pushed to GitHub; the stale local checkout was fast-forwarded by 195 commits total.
- Current local branch is `codex/vrs-sasha-api-v5`, pushed at commit `7f2c996`.
- Draft PR #1 is open: `https://github.com/jtmorgan0513-alt/VRS-Agent-Core/pull/1`.
- The PR adds `POST /vrs/authorize`, strict SASHA V5 validation, a durable `vrs_ai_calls` queue, atomic admission limits, encrypted callback secrets, and HMAC webhook delivery utilities.
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

## Open Threads
- [CX] Review/merge draft PR #1.
- [CX] Apply `vrs_ai_calls` to the VRS development DB only and configure `VRS_SASHA_API_KEY` in staging.
- [CX] Build the Twilio/AI call worker, Snowflake `cta_no` lookup, recording route, and durable webhook-event worker.
- [CX] Resolve V5 O-V5-3 for `repair_replace_rationale` prompt placement.
- [CX] Configure the confirmed NextGen hostnames and complete a real SASHA-to-VRS-to-callback staging transaction.
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
