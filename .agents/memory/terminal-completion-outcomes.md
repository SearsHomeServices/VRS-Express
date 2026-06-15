---
name: Terminal completion outcomes (Replacement Review, B2B Approved Replacement)
description: The full surface area to wire when adding a new terminal "completed with a special outcome" action to the two-stage authorization flow.
---

# Terminal completion outcomes

The platform has a family of terminal authorization outcomes that complete a ticket
with a distinct flag + reporting instead of the normal "Authorized to Repair" path:
Replacement Review (purple) and B2B Approved Replacement (indigo). They are mutually
exclusive boolean flags on `submissions`, and adding another one means touching the
**same fixed set of layers** — miss one and the outcome silently disappears in part
of the UI or exports.

**Why this is a recurring pattern:** management keeps asking for new "complete-but-
special" outcomes that mirror an existing one but must report separately. Each is a
new boolean flag, not a reuse of an existing flag, because analytics counts must stay
distinct.

**How to apply — the checklist (each is a real, separate edit site):**
1. `shared/schema.ts` — new boolean column (default false) AND add it to the
   `SubmissionListItem` pick, or the agent/admin lists won't see it.
2. `server/seed.ts` — idempotent `ensure<X>Column()` with `ADD COLUMN IF NOT EXISTS`,
   called in the background block. `db:push` is gated/strict, so column-adds go here.
3. `server/storage.ts` — add the field to the list-select, plus a
   `get<X>Analytics()` (today/week/month/allTime) and its interface decl.
4. `server/sms.ts` — a `build<X>Message()` builder. No seeded template row needed;
   `renderTemplate` returns null with no row and the fallback copy is used.
5. `server/routes.ts` — action enum on `/process`; a guard (valid only non-NLA +
   AHS/First American + submissionApproved for a Stage-2 outcome); the action block
   (set completed, both stages approved, flag=true, set/omit auth+rgc as appropriate);
   a resubmit-block guard (these are terminal); an analytics endpoint; AND the column
   in BOTH the CSV and XLSX exports (header + value, two separate code sites each).
6. Client `lib/smsPreview.ts` — union member + case.
7. `client/src/pages/agent-dashboard.tsx` — Stage 2 panel section, selectedAction
   union, mutation body, onSuccess labels, and every branch of the confirm dialog.
8. `client/src/pages/submission-detail.tsx` — a tech header branch that sits BEFORE
   the green completed branches (order matters — first match wins), plus an
   instructions paragraph, plus exclude the flag from the generic "You're Clear to
   Go" fallback.
9. `client/src/pages/admin-dashboard.tsx` — ticket badge, analytics card, the
   `useQuery` for the analytics endpoint, and the cache `invalidateQueries` in the
   WS-subscription effect.

**Color convention:** purple = Replacement Review, indigo = B2B Approved Replacement.
Pick an unused color for any new one.
