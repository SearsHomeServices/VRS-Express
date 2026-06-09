# VRS Digital Authorization Platform

## Overview
The VRS Digital Authorization Platform is a full-stack web application designed for Sears Home Services. It digitalizes the authorization process, moving away from traditional call-in methods. The platform features two distinct interfaces: a mobile-first Progressive Web Application (PWA) for field technicians and a desktop dashboard for VRS agents and administrators. This system aims to streamline workflows, improve efficiency in authorization requests, and enhance communication between technicians and agents.

## User Preferences
- I prefer clear and concise communication.
- I appreciate explanations that are straightforward and to the point.
- I value a structured and organized approach to development tasks.
- I expect the agent to ask for clarification if instructions are ambiguous.
- I prefer detailed explanations for complex solutions or significant changes.

## System Architecture
The application is built with a robust architecture utilizing a modern tech stack. The backend is powered by Node.js, Express, and TypeScript, while the frontend is developed with React, Vite, TailwindCSS, and shadcn/ui. PostgreSQL is used as the database, managed with Drizzle ORM. Authentication is handled via JWT with bcryptjs.

Key architectural patterns include:
- **Role-Based Access Control (RBAC):** Users (technicians, VRS agents, admins, super_admins) have distinct roles with varying access permissions.
- **Two-Stage Submission Review:** Authorization requests, particularly for AHS/First American warranties, undergo a two-stage review process to manage initial approval and subsequent authorization code entry.
- **Real-time Communication:** A WebSocket server (ws library) facilitates live push notifications for critical events like new tickets, claimed tickets, and agent status changes, ensuring immediate updates across the platform.
- **Resubmission Routing (2026-05-06):** All resubmissions land in the general queue (`assignedTo: null`, `ticketStatus: "queued"`) so any available agent can claim them. Previously, resubmissions auto-assigned back to the original reviewing agent if that agent was online or working — VRS reported this caused resubmissions to pile up on busy agents (e.g. ticket #13670462 reassigned to Brandon while he was mid-ticket on something else). The prior reviewer still receives an informational `resubmission_received` notification so they see the activity in their UI, and the resubmission is broadcast as `new_ticket` to all division (or NLA division) agents. Tech gets the claim SMS when an agent actually claims from the queue, not at submit-time. Includes ownership validation (tech can only resubmit their own tickets) and a blue "Resubmission" badge in the agent's ticket list.
- **Unified Ticket Workflow:** Submissions progress through defined `ticketStatus` states (queued, pending, completed, rejected, invalid) managed by agents.
- **Division Auto-Assignment:** Admins and super_admins automatically access all divisions, while VRS agents can select their specializations, influencing ticket routing.
- **Division Correction:** Agents can correct the appliance type mid-review, with intelligent handling of ticket ownership based on their assigned divisions.
- **Comprehensive Onboarding & Help System:** Features first-login wizards, "What's New" modals, contextual help tooltips, and a searchable Help Center to guide users.
- **Mobile-First Design:** The technician PWA and agent/admin dashboards are designed with responsiveness in mind, adapting to various screen sizes.
- **Dark Mode:** App-wide dark mode toggle via `ThemeProvider` (`client/src/components/theme-provider.tsx`) using Tailwind's `darkMode: ["class"]`. Persists user preference to `localStorage` (key `vrs-theme`) with OS preference fallback. Toggle buttons in tech header (icon-only), agent sidebar footer, and admin sidebar footer.

**Frontend Pages:**
- **Technician:** Login, Home, Submission Form, History, Submission Detail, Help Center.
- **VRS Agent:** Login, Dashboard (unified Queue, My Tickets, Completed views + dedicated NLA Queue, NLA My Tickets, NLA Completed sub-tabs), supporting claim-to-process workflow, division correction. SHSAI panel is suppressed for NLA tickets.
- **Admin:** Login, Dashboard (user management, division assignments, analytics with resubmission rate tracking, district-level rollup, and NLA analytics card, real-time agent status, ticket overview with FIFO queue and request type filter (All/Authorization Only/NLA Only), clickable audit trail per ticket, technician feedback management, export with CSV + XLSX).
- **Technician Feedback:** Technicians can submit feedback (issue, improvement, general) with priority and optional attachments from /tech/feedback. Admins manage feedback from the "Technician Feedback" view in the admin dashboard with status tracking (new, in_progress, resolved, dismissed) and admin notes.

## NLA (Parts No Longer Available)
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

## Ticket Timing
- `claimedAt` timestamp records when an agent first claims a ticket, set in claim route and resubmission auto-assignment.
- Admin ticket overview timing columns: Queue Wait (createdAt → claimedAt), Handle Time (claimedAt → statusChangedAt), Total Time (createdAt → statusChangedAt).
- Graceful fallbacks for tickets without claimedAt (pre-existing data).

## Agent Activity Log (2026-05-20)
- **Table:** `agent_activity_log` (id, user_id, event_type varchar(48), details jsonb, created_at). Append-only. Indexes on (user_id, created_at) and (event_type, created_at). FK ON DELETE CASCADE.
- **Storage:** `storage.logAgentActivity({userId, eventType, details})` + `storage.getRecentAgentActivity({userId?, eventType?, since?, limit?})`.
- **Helper:** `safeLogActivity()` in `server/routes.ts` — never throws, never blocks the underlying status change.
- **Event types:**
  - `auto_offline_fired` — POST /api/agent/auto-offline succeeded (client 30-min idle); details include `idleMsClient` + source IP/UA
  - `auto_offline_skipped_pending` — blocked by pending or NLA pending ticket; details include both counts
  - `auto_offline_skipped_not_online` — agent was already offline when client posted
  - `auto_offline_ack` — agent dismissed inactivity modal via "Stay Unavailable"
  - `status_toggle_self` — PATCH /api/agent/status; details `{from, to, clearedAutoOfflinedFlag}`
  - `status_toggle_admin` — PATCH /api/admin/users/:id/status; details include `adminUserId` + `adminName`
  - `presence_stale_cleanup` — server WS-disconnect 60-min fallback fired (browser closed)
  - `presence_stale_skipped_pending` — fallback declined due to open ticket
  - `status_change_ticket_flow` — auto-transition triggered by ticket flow; details `{from, to, trigger, submissionId, action?}` where trigger is one of `claim` (→working), `process` (→online), `process_nla` (→online), `send_to_nla` (→online), `correct_division_release` (→online)
- **Endpoint:** `GET /api/admin/agent-activity?userId=&eventType=&sinceHours=&limit=` (admin/super_admin). sinceHours default 24, limit cap 1000. Returns `{events: [{id, userId, userName, eventType, details, createdAt}], filters}` DESC by createdAt.
- **Client testing knob:** `/agent/dashboard?inactivityMs=N&checkMs=M` overrides the 30-min/60-s intervals. Both clamped to production maximum via `Math.min(N, prodDefault)` — cannot weaken a real deployment.

## Notification Sound System
- 5 tone options: Chime, Bell, Pulse, Cascade, Alert — each user can choose their own.
- Volume slider 0–100% per user.
- Settings stored per-user on the `users` table (`notificationTone`, `notificationVolume` columns) via `/api/settings/notification-tone` GET/PUT (authenticated, any role).
- Shared `NotificationSettings` dialog component (`client/src/components/notification-settings.tsx`) with gear icon, accessible from both admin and agent sidebar footers above Help Center.
- All users load their settings on dashboard init via `loadNotificationSettings()` in `client/src/lib/websocket.ts` (sends Bearer token).

## Schema & Data Safety
- `drizzle.config.ts` has `strict: true` and `verbose: true` — `db:push` will prompt for confirmation on any destructive changes.
- `shared/schema.ts` has safety rules at the top: never change column types, never rename columns, never remove columns without approval.
- `server/seed.ts` test cleanup (`cleanupTestSubmissions`) is skipped in production (NODE_ENV === "production").
- `server/seed.ts` one-time migrations (resetAllPasswords, backfillClaimedAt) use flag rows — do not remove these checks.
- `server/storage.ts` `deleteUser()` refuses system accounts and logs cascading submission deletes.
- `DELETE /api/admin/users/:id` blocks: self-delete, system accounts, super_admin role.
- All primary keys are `serial`. Never change to varchar/UUID.

## System Health Regression Watch (2026-05-11)
- **Table:** `system_health_log` (id, check_name, severity, entity_type, entity_id, finding jsonb, detected_at, last_seen_at, cleared_at). Storage methods: `findOpenHealthIncident`, `openHealthIncident`, `touchHealthIncident`, `clearHealthIncident`, `listHealthIncidents`, `listOpenHealthIncidentsByCheck`.
- **Endpoint:** `GET /api/admin/health/regression-check` (admin/super_admin) runs all named checks, upserts findings (opens new, touches still-present, clears resolved), returns `{ overallStatus, totalActiveFindings, checks[] }`.
- **History:** `GET /api/admin/health/incidents?checkName=&openOnly=&limit=` lists rows from the audit log.
- **Checks (one per shipped fix area):**
  - `send_to_nla_status_stuck` — VRS agents/admins on `agent_status='working'` with no open pending tickets and `updated_at > 10 min` ago. Watches Rob's bug class.
  - `escalate_audit_gap` — completed `parts_nla` rows where `nla_resolution='part_found_vrs_ordered'` and `nla_escalated_by IS NULL` (last 7 days). Watches Zorn's #985 footprint.
  - `stale_pending_nla` — `parts_nla` pending > 4 hours assigned to an offline agent. Catches abandoned escalates.
- **Add new checks** by adding another `await runCheck(name, severity, async () => [...])` call inside the route handler — no schema changes needed.

## Replacement Review Outcome (2026-05-20)
- **Action:** `approve_replacement_review` on the standard `/api/submissions/:id/process` route (NOT available on `/process-nla` — NLA has its own replacement actions).
- **Schema:** `submissions.replacement_review_recommended` boolean (default false). Idempotent column-add in `server/seed.ts` (`ensureReplacementReviewColumn`).
- **Behavior:** Mirrors `approve` — issues today's RGC code, captures external auth code for AHS / First American warranties, sets `ticketStatus='completed'` + `stage1Status='approved'` + `stage2Status='approved'` — but additionally sets `replacement_review_recommended=true` and sends a distinct SMS via `buildReplacementReviewMessage()` (`server/sms.ts`) using the exact copy: *"Placed into Replacement Review, remove all parts from the order and select the proper replacement labor code and close the call."*
- **Terminal.** Resubmit route blocks resubmission of any ticket with `replacement_review_recommended=true`.
- **Agent UI:** 5th purple button on the agent process panel (hidden on NLA tickets). Reuses the auth-code input — label flips to "Replacement Code". Validators extend external-auth-required + rgc-set-for-today gating to this action.
- **Tech UI (`submission-detail.tsx`):** Purple `bg-purple-700` header "Placed Into Replacement Review" inserted BEFORE the green completed branches; auth-code card relabels to "Replacement Code" and switches to purple background; Copy button label "Copy Replacement Code".
- **Admin:** Purple `REPLACEMENT REVIEW` badge next to ticket status pill in the queue. New "Replacement Review Outcomes" analytics card (Today/Week/Month/All Time) sourced from `GET /api/admin/replacement-review-analytics` → `storage.getReplacementReviewAnalytics()`. XLSX export's "Authorization Tickets" sheet has a new trailing "Replacement Review" column (`YES` or empty).

## Memory System Boundaries
- **`memory/`** — Replit Agent's memory (this agent). Do NOT read or write from Claude AI.
- **`.claude/memory/`** — Claude AI's memory (VS Code SSH). Do NOT read or write from Replit Agent.
- **`CHANGELOG.md`** — Shared between both agents. Both update the `[Unreleased]` section.
- **`CLAUDE.md`** — Instructions file for Claude AI. Replit Agent should not modify unless the user asks.
- **`replit.md`** — Instructions file for Replit Agent (this file).

## Flexed Technicians (VRS Access)
- Team leads (e.g. Billie Gambrell / LDAP `bgambre`) work in the field as technicians AND log in as VRS agents when "flexed". They have a single `users` row.
- **Model (role-based, no DB migration):** granting VRS access flips that row's `role` from `technician` → `vrs_agent` plus a password + division assignments. "VRS-enabled" is derivable from `role` + roster (`technicians.ldap_id`) membership — no extra column.
- **Why this is safe:** `authenticateToken` trusts the JWT's role (never re-fetches DB), `signToken` uses the stored `user.role`, and field tech-login (`/api/auth/tech-login`) is passwordless/roster-based and ALWAYS forces a `technician` token regardless of stored role. So flipping the stored role does NOT affect field login, but gives a native agent session on agent login. No auth special-casing needed.
- **Grant/Revoke UI:** admin Technicians list shows a blue "VRS-enabled" badge + Grant/Revoke buttons. Grant reuses the user edit dialog (role locked to `vrs_agent`, password required min 6 chars). Revoke flips role back to `technician` and clears specializations (confirm dialog). Agents list shows a "Field Tech" badge for agents who also have a roster entry.
- **Tech-list query:** `getTechnicianUsers()` includes `u.role='technician' OR (u.role='vrs_agent' AND t.ldap_id IS NOT NULL)` — deliberately EXCLUDES admin/super_admin so privileged users can never be demoted via the Technicians-list Revoke button.
- **Demotion guard:** `PATCH /api/admin/users/:id` blocks changing a `super_admin` role at all, and only a super_admin may change an `admin`'s role.
- **Create collision:** admin Create User returns a guided 409 ("belongs to a field technician … use Grant VRS access") when the LDAP already exists as a technician.
- **Known limitation:** revoking does NOT immediately invalidate an already-issued agent JWT (valid until 7-day expiry). This matches existing platform behavior for deactivate/delete/role-edit — middleware trusts the JWT until expiry across the board.

## External Dependencies
- **Twilio:** Used for sending SMS notifications to technicians.
- **Snowflake:** Integrates for synchronizing technician data into the platform's database. Also provides ProcID (CMB_THD_PTY_ID) and Client Name lookup per service order via `fetchProcIdForServiceOrder` in `server/services/snowflake.ts`, stored as `procId` and `clientNm` on the submissions table.
- **SHSAI Service:** An external AI service for querying service order history and handling follow-up questions during the authorization process.
- **LDAP Service:** Utilized for secure authentication of technicians (passwordless) and verifying credentials for agents and administrators.