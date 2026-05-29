---
name: Agent stuck on "working" status
description: Every code path that removes an agent's claimed ticket must restore agentStatus working→online, or the agent's toggle locks.
---

# Agent stuck on "working"

The VRS `agent_status='working'` flag is set on claim and is only cleared by the
ticket-flow paths that *finish* a claimed ticket: `/process`, `/process-nla`,
`/send-to-nla`, and division-correction release. Any NEW path that makes an
agent's claimed ticket disappear must mirror the same working→online restore
(update user, log `status_change_ticket_flow`, `updateClientStatus`,
broadcast `agent_status_changed` + `own_status_changed`, `broadcastVrsAvailability`).

**Why:** Admin ticket *deletion* (`DELETE /api/submissions/:id`) deleted a ticket
an agent had claimed but never reset the claimer — the agent was pinned on
"working" with zero open tickets, toggle locked, unable to go available or claim.
Same bug class as the earlier "send-to-NLA" stuck-working incident.

**How to apply:** When adding a route/job that clears `assigned_to` or deletes a
claimed submission, guard the restore with "no other open pending ticket"
(`getPendingCount + getNlaPendingCount === 0`) so you don't demote an agent who
still has another claimed ticket. The `send_to_nla_status_stuck` health check
(working + no open pending + stale >10min) already catches the symptom in prod.

**Prod note:** dev and prod use separate databases. Symptoms reported from the
published app must be confirmed with `executeSql({environment:"production"})`
(read-only) — the dev DB will look fine.
