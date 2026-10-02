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

Queue monitoring must not narrow with the admin table's search or date filters.
Consume a threshold crossing even when muted, and retain the per-ticket audio
deduplication for the same user and queue scope within a browser-tab session.

**Why:** Filtering the table can otherwise silently stop monitoring, and
reopening the overview or unmuting can replay a backlog of alarms.

**How to apply:** Keep monitoring separate from presentation filters; wait for
confirmed business hours and successful sound-settings loading before sound.

Pilot queue wait alerts must sound different from traditional queue alerts.
**Why:** The user requested an audible distinction between the two queues.
**How to apply:** Preserve the distinct Pilot chime while sharing existing volume and mute settings.