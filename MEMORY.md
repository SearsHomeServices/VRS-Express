# Memory - VRS-Agent-Core

> **Last Touched:** Codex - 2026-04-27 22:19 - Synced GitHub main and added technician video fast-ship plan.

## Current State
- Local repo is on `main` and fast-forwarded to `origin/main` commit `52ebd75`.
- GitHub remote `origin` is `https://github.com/jtmorgan0513-alt/VRS-Agent-Core.git`.
- No remote branch named `development` exists; GitHub currently exposes `main` and `feat/pilot-feedback-fixes`.
- Technician submission form currently exposes three request types: `Authorization`, `Infestation / Non-Accessible`, and `Parts - No Longer Available (NLA)`.
- NLA in-app guidance limits VRS NLA submissions to Sears Protect / Sears PA / Sears Home Warranty (Cinch); AHS / First American NLA is routed to TechHub.
- A fast video plan now lives at `docs/vrs-tech-submission-video-plan.md`.
- Root `AGENTS.md` exists locally as an untracked file.

## Recent Decisions
- [CX] 2026-04-27 - Treated Tyler's "development" wording as a request for the latest published development state, but verified GitHub branch reality before pulling. Since no `development` branch exists, fast-forwarded `main` from `origin/main`.
- [CX] 2026-04-27 - Recommended one 7-9 minute technician-only screen walkthrough for the 2026-04-28 East Coast meeting, scoped to the three technician request types and excluding agent/admin flows.

## Open Threads
- [CX] Record and export the technician instructional MP4 before the 2026-04-28 morning team meeting.
- [CX] Confirm which running environment should be recorded: Replit/dev URL is preferred if database and object storage already work; local recording needs environment variables present.
- [CX] Decide whether to update the older user guide section that still describes the request selection primarily as Authorization vs Infestation / Non-Accessible.

## Gotchas & Lessons
- [CX] 2026-04-27 - Bundled `rg.exe` failed with Windows `Access is denied`; PowerShell `Select-String` worked as the fallback.
- [CX] 2026-04-27 - Project root had no `MEMORY.md` and no `.Codex/memory` directory at session start, despite repo instructions requiring both to be maintained.
