# Codex Context - VRS-Agent-Core

Updated: 2026-04-27 22:19

## Current Session

- GitHub fetch/pull completed from `origin`.
- Local `main` fast-forwarded from `c23a9b5` to `52ebd75`.
- Remote branches verified: `main` and `feat/pilot-feedback-fixes`; no `development` branch exists.
- Added `docs/vrs-tech-submission-video-plan.md` for Tyler's East Coast technician training video.

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
