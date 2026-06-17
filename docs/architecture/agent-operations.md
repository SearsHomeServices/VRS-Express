# Agent Operations: Timing, Activity Log & Health Watch

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

## System Health Regression Watch (2026-05-11)
- **Table:** `system_health_log` (id, check_name, severity, entity_type, entity_id, finding jsonb, detected_at, last_seen_at, cleared_at). Storage methods: `findOpenHealthIncident`, `openHealthIncident`, `touchHealthIncident`, `clearHealthIncident`, `listHealthIncidents`, `listOpenHealthIncidentsByCheck`.
- **Endpoint:** `GET /api/admin/health/regression-check` (admin/super_admin) runs all named checks, upserts findings (opens new, touches still-present, clears resolved), returns `{ overallStatus, totalActiveFindings, checks[] }`.
- **History:** `GET /api/admin/health/incidents?checkName=&openOnly=&limit=` lists rows from the audit log.
- **Checks (one per shipped fix area):**
  - `send_to_nla_status_stuck` — VRS agents/admins on `agent_status='working'` with no open pending tickets and `updated_at > 10 min` ago. Watches Rob's bug class.
  - `escalate_audit_gap` — completed `parts_nla` rows where `nla_resolution='part_found_vrs_ordered'` and `nla_escalated_by IS NULL` (last 7 days). Watches Zorn's #985 footprint.
  - `stale_pending_nla` — `parts_nla` pending > 4 hours assigned to an offline agent. Catches abandoned escalates.
- **Add new checks** by adding another `await runCheck(name, severity, async () => [...])` call inside the route handler — no schema changes needed.
