---
name: Same-day duplicate ticket prevention
description: How VRS gates one ticket per service order per ET day, and the resubmission / Additional Request exceptions.
---

# Same-day duplicate ticket prevention (POST /api/submissions)

Three submission kinds, each with a different "what counts as a same-day
conflict" status set (all compared on the America/New_York calendar day):

- **Normal new submission** — blocks on queued/pending/**completed**. A
  same-day approved ticket still blocks (otherwise a tech could burn a second
  auth slot). Rejected/invalid do NOT block here.
- **Resubmission** (`resubmissionOf` set) — original must be `rejected`; blocks
  on **active only** (queued/pending). Completed/rejected priors don't block.
- **Additional Request** (`additionalRequest: true`, transient flag, NOT a DB
  column) — deliberate same-day second ticket for a return visit; blocks on
  **active only** (queued/pending). The whole point is to allow a second ticket
  once priors are resolved.

**"active" = queued OR pending.** `pending` also covers the AHS/First American
approved-awaiting-auth-code state (ticketStatus stays "pending" with
submissionApproved=true). "resolved" = completed/rejected.

**Why both orders are covered with one fix:** the resubmission path used to skip
the active check entirely, which let `rejected → fresh ticket active →
resubmission` both get worked (prod SO 7088-13792068). Adding the active-only
check to the resubmission path closes it; the normal block already catches a
fresh submit while a resubmission is queued.

**Two enforcement points, must stay in sync:** the route-level pre-check
(`hasActiveSubmissionForServiceOrder(so, techId, statuses?)`) AND the
advisory-locked atomic re-check inside
`createSubmissionWithIdempotency(..., { additionalRequest })`. The tx check
serializes concurrent same-SO requests; same-tech hit → idempotent replay,
other-tech hit → blockedByOther (409). `rejected_closed` permanent block always
applies first and is never overridden.

**Client signal:** the normal-submit 409 returns `canRequestAdditional: true`
only when the blocker is a same-day *completed* ticket. The tech UI uses that to
offer the Additional Request confirmation dialog (re-sends payload with
`additionalRequest:true`). `throwIfResNotOk` in `client/src/lib/queryClient.ts`
attaches `.status` and `.body` to thrown errors so callers can branch on this.
