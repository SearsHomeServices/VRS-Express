---
name: stage1Status is the de-facto overall outcome
description: Why two-stage (AHS/First American) negative outcomes must NOT preserve stage1Status='approved', and how to record Stage-2 audit instead.
---

# `stage1Status` is the de-facto OVERALL outcome, not a pure Stage-1 field

On two-stage AHS / First American tickets a submission can be Stage-1 approved
(`approve_submission` → `submissionApproved=true`) and then later rejected /
reject-and-closed / marked invalid at Stage 2 (the authorization stage).

**Rule:** a Stage-2 negative outcome MUST keep writing `stage1Status` to the
final result (`'rejected'` / `'invalid'`), with `stage1ReviewedAt=now` and the
top-level `reviewedBy=acting agent`. Do NOT preserve a stale
`stage1Status='approved'` to "keep the Stage-1 approval visible." Record the
Stage-2-specific audit ADDITIVELY in the dedicated `stage2Outcome` /
`stage2ReviewedBy` / `stage2ReviewedAt` columns instead.

**Why:** the analytics layer in `server/storage.ts` reads `stage1Status` /
`stage1ReviewedAt` as the OVERALL outcome, because historically that was the
only review field:
- Agent Completed-Today tile counts `stage1Status IN ('approved','rejected')
  AND stage1ReviewedAt >= today AND reviewedBy = agent`. Preserving a stale
  Stage-1 `stage1ReviewedAt` (old date) would DROP the agent's Stage-2
  rejection from their daily count.
- Approval-Rate card buckets on `stage1Status='approved'` vs `'rejected'`.
  Preserving `'approved'` would count a rejected ticket as approved.
- `getStage2QueueCount` / Stage-2 arm of `getAgentQueueCount` =
  `stage1Status='approved' AND stage2Status='pending'`; the terminal negative
  must leave that set via `stage1Status` (don't strand it in queue counts).

**How to apply:** any future two-stage outcome handling — or any analytics that
reads these columns — should treat `stage1Status` + `stage1ReviewedAt` as
"final overall outcome + when", and treat the `stage2*` columns as the
Stage-2-decision detail. When adding a Stage-2 path, stamp the `stage2*`
columns; never repurpose `stage1Status` to mean only Stage 1. Also: do NOT set
`stage2Status='declined'` for these negatives — the per-ticket Submission-History
timeline renders a Declined block on `stage2Status==='declined'` AND a
Rejected/Invalid block on `stage1Status`, so setting both double-renders.

**Note on the lost datum:** the Stage-1 approver's user id lives only in
`stage1ReviewedBy` and gets overwritten by the Stage-2 actor. In the normal
flow the SAME agent does both stages, so this is usually a no-op; a different
actor only happens after an admin reassignment between stages. The fact that
Stage 1 was approved is still preserved in `submissionApproved=true` +
`submissionApprovedAt` (there is no `submissionApprovedBy` column).
