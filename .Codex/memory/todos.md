# Codex Todos - VRS-Agent-Core

Updated: 2026-05-08 00:00

## Done

- [x] Shipped bounded-concurrency photo uploads in `tech-submit`.
- [x] Shipped bounded-concurrency photo uploads in `tech-resubmit`.
- [x] Added safe content-type fallback for upload requests with empty MIME type.
- [x] Enabled lazy image loading for agent/admin media thumbnail grids.
- [x] Reduced API/object-route logging overhead in `server/index.ts`.
- [x] Documented the performance patch set in `CHANGELOG.md`.

## Open

- [ ] Add server-side pagination and SQL-backed search for `/api/submissions` to avoid broad fetch + in-memory filtering under large volumes.
- [ ] Stream CSV export rows instead of building one large in-memory string.
- [ ] Remove duplicate metadata/ACL fetches in object-serving path to reduce image/video time-to-first-byte.
- [ ] Add indexes for hottest submission filters/sorts and verify with `EXPLAIN ANALYZE`.
