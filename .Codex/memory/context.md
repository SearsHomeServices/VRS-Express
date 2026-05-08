# Codex Context - VRS-Agent-Core

Updated: 2026-05-08 00:00

## Current Session

- Implemented and shipped a first-pass performance hot-path patch set focused on sluggishness and lag:
  - Bounded-concurrency photo uploads (3 workers) in tech submit/resubmit flows.
  - Safe upload MIME fallback when `File.type` is empty (common iPhone edge case).
  - Lazy image loading in agent/admin media grids.
  - Reduced logging overhead in `server/index.ts` by disabling full API body serialization unless explicitly enabled.
- Updated `CHANGELOG.md` under `[Unreleased]` with the shipped performance fixes.
- Implemented business-hours policy wording update requested by Tyler:
  - Agents/admins are not implied to be blocked outside business hours.
  - Technician after-hours messaging still includes business-hours notice.
  - Added legacy-template normalization in `server/sms.ts` so existing production template rows stop saying "next business day only".
  - Updated help-center copy and seed defaults to match.

## Technician Submission Flow Verified

- `client/src/pages/tech-submit.tsx` request types:
  - `authorization` -> Authorization
  - `infestation_non_accessible` -> Infestation / Non-Accessible
  - `parts_nla` -> Parts - No Longer Available (NLA)
- NLA path includes separate NLA part numbers and other available parts.
- NLA guidance says Sears Protect / Sears PA / Sears Home Warranty (Cinch) only.
- AHS / First American NLA displays a warning to use TechHub.

## Notes

- `rg.exe` failed with Access denied in this Windows/Codex bundle; use `Select-String` if it recurs.
- Root `AGENTS.md` is currently untracked.
- Current modified files from performance patch: `client/src/pages/tech-submit.tsx`, `client/src/pages/tech-resubmit.tsx`, `client/src/pages/agent-dashboard.tsx`, `client/src/pages/admin-dashboard.tsx`, `server/index.ts`, plus changelog/memory files.
- Additional modified files for policy wording: `server/sms.ts`, `server/seed.ts`, `client/src/pages/help-center.tsx`.
