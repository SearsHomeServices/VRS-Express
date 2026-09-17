---
name: Pilot queue isolation
description: Agreed separation of pilot work and legacy queues
---
Bridge-linked tickets belong exclusively in the Pilot staff work view. Admin dashboard is tracking-only; admins work pilot tickets through Agent Queue View. VRS agents retain access under existing authorization.

**Why:** The user explicitly replaced the earlier additional-tracking-view decision with exclusive pilot work queues while preserving legacy processing.

**How to apply:** Keep ordinary staff queues and their counts free of bridge-linked tickets. Do not remove technicians' own history, change bridge contracts, or infer a ticket is actionable from bridge state when its canonical ticket status is already terminal.

The Pilot overview may expose existing organization-wide sign-in and executive-summary tools, but must label them Global rather than imply that the pilot filters apply.

**Why:** Matching the standard Ticket Overview should not silently change the audience or contents of existing scheduled executive reports. Ticket exports and bulk ticket actions, unlike these global tools, must retain the pilot boundary.