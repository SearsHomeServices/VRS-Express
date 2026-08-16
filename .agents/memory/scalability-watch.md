---
name: Scalability watch (volume-growth risks)
description: The tables/paths that get slow or costly as data grows, ranked. Check here before perf work.
---

# Volume-growth risks (audited 2026-06-23, prod; updated 2026-06-26)

## #1 agent_activity_log — unbounded growth (MITIGATED 2026-06-27)
**MITIGATED:** a scheduled retention sweep (pruneAgentActivityLog) now batch-prunes
WS telemetry events at 14d and all other audit events at 180d; runs ~60s post-boot
and every 24h. Growth is now bounded. Original finding below for context.

Largest table BY FAR: ~504k rows / 208 MB after ~1 month, +~20k rows/day
(142k in 7 days). It logs every status change / auto-offline. There is NO
pruning/retention anywhere in the codebase. Left alone it trends to multi-GB/yr
→ storage cost + vacuum pressure. **Fix = a retention/archival policy** (delete or
archive rows older than N days). The retention window is a BUSINESS decision
(how long must agent audit history be kept) — ask before picking a number.
Query access is fine (indexed on (user_id,created_at) and (event_type,created_at));
the problem is pure growth, not query speed.

## #2 Admin GET /api/submissions ticketStatus='all' — unbounded payload, 60s poll (MITIGATED 2026-06-27)
**MITIGATED:** the admin/super_admin branch now imposes a default date window + hard
row cap (env-tunable) when no createdAfter is supplied; the cap honors the active
ORDER BY. Agent views stay uncapped. Behavior unchanged at current volume. Original finding below.

Route accepts createdAfter but does NOT enforce a window for admin all-time;
returns the whole submissions table (500KB-1MB today) and the admin dashboard
polls it every 60s. Cost scales linearly with the table. Fix = enforce a default
date window + pagination.

## #3 Snowflake — new connection + JWT auth on EVERY call, no pool/cache/timeout (PARTLY MITIGATED 2026-06-27)
**PARTLY MITIGATED:** fetchProcIdForServiceOrder now has a bounded connect+execute
timeout (fails fast, always destroys the connection) + an in-memory TTL cache keyed by
service order, so repeats are instant and a stall returns within the timeout. Still
per-call connect (no pool) and submit stays synchronous — left intentionally. Original finding below.

`getConnection()` in services/snowflake.ts does createConnection+connect (full TCP+JWT
handshake, ~4s observed) per request, destroyed in finally — no reuse/singleton, no
result cache, NO timeout, no retry. Awaited synchronously in the request path, worst at
POST /api/submissions (fetchProcIdForServiceOrder, ~18s observed) which blocks the tech's
submit; also lookup-warranty (rate-limited 10/hr), techhub-photos, sync-technicians,
backfill-proc-ids (loop). NOT held inside a PG txn (they avoided that). A Snowflake slowdown
piles up pending requests → latency/event-loop pressure. Fix = bounded timeout + small TTL
cache keyed by service order (repeats/resubmits hit it constantly) + make submit path
non-blocking (insert first, enrich procId async). Highest-leverage external-pull fix.

## #4 WebSocket state is in-memory → single-instance only (blocks horizontal scale)
clients/presence/timers are local Maps in websocket.ts: broadcast + heartbeat are O(N) over
all connections, and the 5-min revalidation does 1-2 DB reads PER connected user. Fine on one
VM at current size; correctness breaks (split presence, missed broadcasts, cross-instance
false-offline) the moment you run >1 instance. Scaling out needs a shared pub/sub + shared
presence store (e.g. Redis). Until then, scale = vertical only.

## Lower tiers
- CSV export (routes.ts ~4801): 3 awaited getUser per row (N+1) on all-time export — batch the user fetch.
- pg.Pool now max=20 + connectionTimeout/statement_timeout (see reserved-vm-hang-pool-exhaustion.md), fixed the 2026-06-26 hang. Measured post-fix on prod: 20 concurrent /api/agent/stats & /api/admin/users stay <1.3s, but 12 concurrent all-time /api/submissions = ~7s avg (the #2 unbounded query is the next ceiling). Mind the managed-DB connection cap before raising max further.
- Analytics (getAnalytics, district rollup, NLA) are full-table aggregates, not server-cached. Add short server cache as submissions grow.
- WS broadcast is O(N) over ALL clients; 5-min revalidation does per-user getUser+getSpecializations. Fine at current size, notable at high concurrency.

## Confirmed NON-issues (don't re-flag)
telemetryLastSeen map (5000-cap eviction), object-storage metadata cache (1000 LRU),
websocket clients map (cleaned on close + 60min stale timer). idleVotes map has a
tiny theoretical leak (entry per user never returning) — negligible.

## Index hygiene done this session
Added FK indexes on intake_forms.submission_id, submission_notes.submission_id,
sms_notifications.submission_id (all were PK-only). See perf-index-pattern.md.

## #5 Admin Ticket Overview client-side render — MITIGATED 2026-08-16
At ~11.5k prod submissions the admin list response was ~9 MB JSON (slim rows incl.
photos/thumbnail JSON) and the table rendered ALL filtered rows with the whole
derived pipeline (filters/counts/sort/search) re-running un-memoized on every
render. Fixed: pipeline staged in useMemo (decorate-sort-undecorate for sorts),
table body paginated (100 rows + "Show more"; counts/exports still full-set),
audit detail endpoint reads parallelized. NOT a RAM/CPU/DB problem — DB is 23 MB
total; the cost was payload transfer + browser parse/render. Next lever if it
regrows: drop photos/photoThumbnails from list payload (detail dialog already
fetches /:id) — mind the photo-thumbnails invariant + micro-cache version stamp.
