# Codex Decisions - VRS-Agent-Core

Updated: 2026-07-28 12:31

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
