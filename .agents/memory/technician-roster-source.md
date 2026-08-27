---
name: Technician roster source decision
description: Business decision about which Snowflake source should feed the VRS Express technician roster.
---

Keep the VRS Express technician sync on the existing PRD_TPMS source rather than switching it to the Parts Supply Chain TPMS_EXTRACT view.

**Why:** The user reviewed the alternative source and explicitly chose to leave the current integration unchanged after confirming that phone values align and the available populations are comparable.

**How to apply:** Treat a source change as a new business decision requiring explicit approval; do not substitute TPMS_EXTRACT during unrelated technician-sync work.