# Same-SO Cross-Tech Duplicate Block (2026-05-27)

## Bug
VRS reported two same-day same-SO# tickets ending in pending against different agents:
- Eric Green SO# 7435-13748939 (Zorn Jones + Tony Higginbotham)
- Veaceslav Versigora SO# 8206-13757917 (Jeff Van Ness + John Santana)

## Root cause
`storage.hasActiveSubmissionForServiceOrder` filtered by `technicianId`, so it only
blocked the SAME tech. Two different tech rows (or an LDAP/JWT identity mismatch under
the same SO) sailed through. `createSubmissionWithIdempotency` advisory lock was also
keyed on `(technicianId, soHash)`, so concurrent cross-tech submitters did not even
serialize against each other.

## Fix
Invariant enforced: **one ticket per SO per calendar day across all techs; the only
exception is the resubmit path on a `rejected` ticket the caller owns**.

1. `server/storage.ts hasActiveSubmissionForServiceOrder(serviceOrder, callerTechnicianId?)`
   - Dropped technicianId from WHERE.
   - `activeStatuses = ["queued", "pending", "completed"]`.
   - Returns `{exists, status, technicianId, sameTech}`.
2. `server/storage.ts createSubmissionWithIdempotency`
   - Advisory lock now `pg_advisory_xact_lock(SO_LOCK_NAMESPACE, soHash)` —
     SO-scoped, not tech-scoped. NAMESPACE = `0x53484F4D | 0` ('SHOM').
   - Inside the lock (skipped only when `resubmissionOf` is set): re-checks
     SO + activeStatuses + same calendar day across ALL techs.
   - Same-tech hit → idempotent replay (returns existing row).
   - Different-tech hit → returns `{wasDuplicate, blockedByOther, blockingTechnicianId, blockingStatus}` (no row leaked).
3. `server/routes.ts POST /api/submissions`
   - Pre-check error message distinguishes "You already have" vs "Another technician already has", mentions resubmit flow for rejected. Logs `[duplicate-block]` warn with both tech IDs + sameTech.
   - Race-loser path (blockedByOther) → 409 with same copy + `[duplicate-block-tx]` warn.
   - Resubmission branch hard-requires `originalSub.ticketStatus === "rejected"` (architect-flagged: otherwise a tech could pass `resubmissionOf` pointing at their own queued/pending/completed ticket and bypass the same-day block since both pre-check and tx conflict check skip when `resubmissionOf` is set).

## Why these statuses
- `rejected` NOT in activeStatuses: legitimate resubmit case (handled by `resubmissionOf` branch which now requires status === 'rejected').
- `invalid` NOT in activeStatuses: prior didn't count.
- `rejected_closed` has its own gate (`hasRejectedClosedForServiceOrder`).
- `completed` IS in activeStatuses per VRS "one per SO per day" spec.

## Architect iterations
1. PASS pre-check, FAIL concurrency → added SO-scoped lock + inside-tx cross-tech recheck.
2. PASS concurrency, FAIL resubmit gap → added rejected-only resubmit guard.
3. PASS.

## Files
- `server/storage.ts` (hasActiveSubmissionForServiceOrder, createSubmissionWithIdempotency, IStorage)
- `server/routes.ts` (POST /api/submissions pre-check, resubmission branch, tx-race 409 handler)

## Suggested follow-up (not done)
Regression tests for: cross-tech sequential 409, cross-tech concurrent race (one wins / one 409), `resubmissionOf` on non-rejected returns 400.
