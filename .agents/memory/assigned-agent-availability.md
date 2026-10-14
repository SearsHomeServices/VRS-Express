---
name: Assigned agent availability
description: Business rule for releasing agents when someone else processes their ticket.
---
When an admin completes an agent's ticket, recalculate the assigned agent's availability without releasing them if they have another active ticket.

**Why:** The user requested this after an admin-completed ticket left its assigned agent stuck Working and unable to claim again.

**How to apply:** Distinguish the acting reviewer from the assigned agent in ticket transitions. Preserve intentional Unavailable status and do not equate successful ticket completion with permission to make every involved account Available.
