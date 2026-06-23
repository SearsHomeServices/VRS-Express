---
name: Scalability watch (volume-growth risks)
description: The tables/paths that get slow or costly as data grows, ranked. Check here before perf work.
---

# Volume-growth risks (audited 2026-06-23, prod)

## #1 agent_activity_log — unbounded, no retention
Largest table BY FAR: ~504k rows / 208 MB after ~1 month, +~20k rows/day
(142k in 7 days). It logs every status change / auto-offline. There is NO
pruning/retention anywhere in the codebase. Left alone it trends to multi-GB/yr
→ storage cost + vacuum pressure. **Fix = a retention/archival policy** (delete or
archive rows older than N days). The retention window is a BUSINESS decision
(how long must agent audit history be kept) — ask before picking a number.
Query access is fine (indexed on (user_id,created_at) and (event_type,created_at));
the problem is pure growth, not query speed.

## #2 Admin GET /api/submissions ticketStatus='all' — unbounded payload, 60s poll
Route accepts createdAfter but does NOT enforce a window for admin all-time;
returns the whole submissions table (500KB-1MB today) and the admin dashboard
polls it every 60s. Cost scales linearly with the table. Fix = enforce a default
date window + pagination.

## Lower tiers
- CSV export (routes.ts ~4801): 3 awaited getUser per row (N+1) on all-time export — batch the user fetch.
- pg.Pool has no explicit max → defaults to 10; /api/agent/stats fires 3-6 queries via Promise.all polled every 30s → pool-exhaustion risk as agent count grows. Bump max (mind Neon connection cap).
- Analytics (getAnalytics, district rollup, NLA) are full-table aggregates, not server-cached. Add short server cache as submissions grow.
- WS broadcast is O(N) over ALL clients; 5-min revalidation does per-user getUser+getSpecializations. Fine at current size, notable at high concurrency.

## Confirmed NON-issues (don't re-flag)
telemetryLastSeen map (5000-cap eviction), object-storage metadata cache (1000 LRU),
websocket clients map (cleaned on close + 60min stale timer). idleVotes map has a
tiny theoretical leak (entry per user never returning) — negligible.

## Index hygiene done this session
Added FK indexes on intake_forms.submission_id, submission_notes.submission_id,
sms_notifications.submission_id (all were PK-only). See perf-index-pattern.md.
