---
name: NLA worked queue clock
description: Queue waiting stops after research handoff, not after the P-card order is completed.
---

Researched NLA tickets awaiting a part order must display Ready for Order and
stop accumulating queue-wait time at the research handoff. Simply claiming an
unresearched NLA ticket does not mean it is ready for ordering.

**Why:** The user explicitly requested that worked/order-needed tickets stop
looking like untouched queue work. P-card claims and reassignments happen later
and must not restart that clock or replace the recorded research handoff time.

**How to apply:** Preserve the handoff timestamp through ordering and
reassignment, hide readiness on terminal outcomes, and keep handle time
separate. Legacy timestamps may be approximate when the original handoff
audit is unavailable; never invent the current time as a historical handoff.

Admin five-minute queue alerts follow the existing business-hours queue clock,
not wall-clock age, and exclude research handoffs (including legacy escalations).

**Why:** An alert must not call a researched, ordering-ready ticket untouched
queue work or disagree with the queue wait shown to admins.

**How to apply:** Preserve these exclusions when changing alert thresholds or
timer behavior. Audio uses the existing notification settings, not a separate
alarm volume.