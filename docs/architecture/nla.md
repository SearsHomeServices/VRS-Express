# NLA (Parts No Longer Available)

- "nla" is a standalone agent specialization/division, independent of appliance type divisions.
- NLA tickets (`requestType === "parts_nla"`) route to agents with the "nla" specialization via WebSocket `broadcastToNlaDivisionAgents(applianceType, event)`.
- Agent dashboard has dedicated NLA sub-tabs (NLA Queue, NLA My Tickets, NLA Completed) in the sidebar, using amber-colored badges and `Package` icon.
- **Send to NLA**: Any agent can send a claimed VRS ticket to the NLA queue via `POST /api/submissions/:id/send-to-nla` with optional `division` and `notes` params. The agent selects the target NLA division from a dropdown (pre-set to the ticket's current appliance type). The ticket's `requestType` changes to `parts_nla`, it's unassigned and queued, and broadcast to NLA division agents. Agent-to-agent reassignment remains admin-only.
- NLA tickets are excluded from standard queue/pending/completed counts; separate `getNlaQueuedCount`, `getNlaPendingCount`, `getNlaCompletedTodayCount` storage methods provide NLA-specific counts.
- `getNlaQueuedCount(divisions?)` and `getNlaCompletedTodayCount(agentId?, divisions?)` accept optional appliance-type divisions array for division-based filtering.
- **NLA Division Filtering:** NLA agents only see NLA tickets matching their appliance type specializations. Generalists (agents with all appliance divisions) see all NLA tickets. Division filters in sidebar are visible for NLA views. Claim guard checks agent's appliance divisions against ticket's applianceType.
- Admin ticket overview supports filtering by request type (All / Authorization Only / NLA Only).
- Admin analytics includes an NLA Parts Submissions card (Today/Week/Month/All Time).
- XLSX export (`/api/admin/export-xlsx`) produces a 2-sheet workbook: Sheet 1 "Authorization Tickets" and Sheet 2 "NLA Parts Tickets" with Part Numbers, NLA Resolution, Found Part Number columns. Uses `exceljs` package.
- Admins and super_admins automatically receive "nla" division assignment via seed.ts.
- **NLA Resolution Actions:** Dedicated `/api/submissions/:id/process-nla` route (separate from standard `/process` route). Eight NLA-specific actions: `nla_replacement_submitted`, `nla_replacement_tech_initiates`, `nla_part_found_vrs_ordered`, `nla_part_found_tech_orders`, `nla_reject`, `nla_invalid`, `nla_escalate_to_pcard`, `nla_pcard_confirm`. Dropdown UI uses Select component with verbose management-specified labels.
- **Mandatory Instructions for Technician:** `technicianMessage` field is required for all NLA actions. Backend returns 400 if empty; frontend disables submit buttons and shows toast validation.
- **P-Card System:** `canOrderParts` boolean on users table. Only P-card agents can finalize `part_found_vrs_ordered` actions. Non-P-card agents escalate to P-card agents (`nla_escalate_to_pcard` action), which sends the ticket back to the NLA queue with `nlaEscalatedBy` set. Escalated tickets show "Ready for Order" badge in queue and are restricted to P-card agents for claiming.
- **P-Card Admin Toggle:** Admin user management includes a P-card toggle (visible for vrs_agent/admin roles). P-card badge displayed in user list.
- **Technician NLA Detail:** Completed NLA tickets display resolution type (including replacement_tech_initiates), part number (for tech_orders), and agent instructions on the technician submission detail page.
