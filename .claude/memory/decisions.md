## 2026-10-23 — The VRS manager completes the AHS details at Stage 1

The tech form no longer has an AHS section. Submit stores a server-built draft
in `submissions.ahs_details` (no new column). The manager saves the full
details through `PATCH /api/submissions/:id/ahs-details`
(server/ahs-review-api.ts), and only that save enrolls the ticket in VRS AI.
- **Parts provenance:** `"parts"` was added to `AHS_PREFILL_FIELDS`, rather than
  a separate `prefilledParts` flag, so the reviewer reads one list. Server
  loops over single-value fields use `AHS_PREFILL_TEXT_FIELDS`.
- **Replacing the bridge payload:** the store's only supersede helper retires
  closed tickets' rows, and `getBySubmissionId` has no ordering, so a second
  row per ticket would be ambiguous. Added `replaceUndispatchedAppIntake` to
  vrs-sasha-store.ts instead. It is an in-place UPDATE conditional on
  pending_review/dispatch_failed, no provider call id and app origin, so it
  races `markDispatching` safely.
- **Resubmission:** the new draft starts from the previous ticket's stored
  details, and the lookups fill only blanks.

## 2026-10-22 — Customer name/address from HSSOM, never shown to the tech

**HSSOM Order Lookup is the only confirmed source.** ai-agent-mcp reads it with
`CustomerTools.get_customer_details_by_order`. The internal address
(`hssolookup.intra.searshc.com`) needs no secret, but Replit can't reach it. So
VRS Express uses the gateway with an HSSOM client token, under the same env
names as the planned HSSOM Send Message work, so one credential covers both.

**Server-only PII.** The browser learns only `hasCustomer`. Technician-facing
submission responses strip customer fields the server filled, and a
resubmission restores them on the server. Reviewers (agents) see them with a
"From service order" badge. Both lookups are bounded and best-effort: a
failure only means the tech can type the values.

## 2026-10-22 — Trim the technician AHS form; prefill from Snowflake on the server

**Ask the tech only what no system has.** VRS AI hard-requires only
service_order, tech_id, tech_phone, callback and parts. It defaults every
other field to "" and says it will confirm with AHS. So the form requires
only the diagnosis facts AHS asks for (failure cause, location, repair or
replace, labor, parts with prices). Everything else is optional.

**No new credentials or external services.** The prefill reuses the
Snowflake connection the app already has. The HSSOM Order Lookup and Work
Order APIs (used by ai-agent-mcp) would cover customer data too, but they
need new credentials. Reading the estimate screenshot with OpenAI was
rejected: it would send customer PII to a new place.

**PII stays on the server.** The dispatch number is filled at submit and the
browser only learns whether one exists. The endpoint returns brand, model and
serial only. The lookup filters on SVC_UN_NO + SO_NO, because SO numbers
repeat across units.

**Relax validation only for app-origin payloads.** The SASHA contract and
its dispatch checks are unchanged. App-origin payloads send "" rather than
"N/A", because VRS AI reads "N/A" aloud.

## 2026-10-08 — Technician AHS tickets enroll in the VRS AI bridge

**Reuse the bridge row; don't add a second dispatch path.** Pilot membership,
the Stage 1 "Approve & Send to VRS AI" gate, the dispatch, the webhook ledger
and the per-order duplicate lock all key off a `vrs_ai_calls` row. Giving app
tickets that row at creation is the smallest change that gets them all of it.
The human Stage 1 approval stays the only gate before VRS AI.

**Empty `callback_url` marks app origin, so no schema change.** An `origin`
column would need a `db:push` in both environments before publishing. The
empty string satisfies the existing NOT NULL columns and can never be a valid
SASHA URL. Code checks it only through `isAppOriginVrsBridgeRecord`. SASHA
rows keep the inbound revalidation and the mandatory upstream forward
unchanged.

**Superseded 2026-10-16: the tech now enters real AHS details.** A
technician gave the required field list. The details are stored as JSON in
`submissions.ahs_details`, using the same idempotent ensure-column pattern
as the other columns, so no `db:push` is needed. Tickets without them are no
longer enrolled. The detailed AHS appliance list is used only for AHS
tickets, and the routing division is derived from it; other warranties keep
the old dropdown (user's choice). Quantity and failure reason have no
contract field, so they are carried in the part description and the
comments rather than changing the VRS AI contract (user's choice).

**Placeholders, not guesses (original, superseded).** The technician form has no customer,
model/serial, parts or price fields; that data is in the estimate and tag
photos. The payload uses the V9 contract's own `"N/A"`/`""` values and `0`
amounts, and says so in a comment. It does not invent values. The flag stays
off until VRS AI is confirmed to handle these payloads.

**Supersede only for app enrollment.** Stage 1 rejection never updates the
bridge row, so an undispatched `pending_review` row would block a resubmission
forever. Retiring it is limited to rows VRS AI never received
(`provider_call_id IS NULL`) whose ticket is closed without approval. SASHA
intake keeps its existing duplicate behavior.

## 2026-09-11 — Weekly exec summary + post-close agent notes

**Raw fetch to SendGrid, not `@sendgrid/mail`.** A new npm dependency is a live
deploy risk on this app specifically: `browser-image-compression` shipped once
and the Replit build quietly skipped its install. The v3 Mail Send API is a
single POST, so the dependency buys nothing and costs a failure mode.

**Email failures never throw.** `sendEmail` returns `{ sent, reason }`. A
scheduler tick that throws would kill the weekly loop; a report that generated
correctly should still persist even when delivery fails.

**Latency numbers come from `storage.getAnalytics()`, not fresh SQL.** The
dashboard's averages are business-hours aware. Computing wall-clock averages
here would have printed a number that contradicts the Analytics page for the
same metric. They are all-time rather than windowed and are labelled that way.

**Durations are formatted by magnitude, not fixed to hours.** Measured
2026-09-11: average time to auth code is ~0.02 h (auth lands in about a minute),
which one-decimal hours rendered as "0 h". Raw milliseconds are stored and the
unit is chosen at render time.

**AI-closed tickets are detected by the `agent_notes` prefix, not
`vrs_ai_calls`.** Measured 2026-09-11 on dev: all 50 `vrs_ai_calls` rows had
`auth_number IS NULL` while 7 submissions carried the
`'VRS AI approved%'` marker that `buildVrsAiCallResultAgentNotes` writes on every
close. Do not switch to the `vrs_ai_calls` column without re-measuring.

**Post-close notes open to ANY vrs_agent, not just the closer.** The old gate
was `assignedTo === me || queued || reviewedBy === me`. Because a close nulls the
claim and an AI close is attributed to whoever held the ticket, only one person
could ever follow up. Queued tickets keep the division-specialization gate:
an unclaimed ticket outside your division is still not yours to touch.

**Recipients live in `system_settings`, not an env var.** Changing who gets the
weekly email should not require a redeploy. Code defaults cover the three owners
so it works before anyone configures anything.

# Architectural Decisions

Use this format for new entries:

```
### ADR-NNN: Title
**Date**: YYYY-MM-DD
**Status**: Active | Superseded | Deprecated
**Context**: What prompted this decision?
**Decision**: What was decided?
**Consequences**: What are the trade-offs?
```

---

### ADR-016: VRS AI call results close tickets on a separate route, not by loosening the signed webhook
**Date**: 2026-09-08
**Status**: Active
**Context**: VRS AI emits a completed-approval payload that is the approved-callback envelope plus three fields with no place in the current contract: `partId`, `partDescription`, and `techId`. It needs to close the corresponding Express ticket. The existing signed partner webhook (`POST /api/integrations/vrs-ai/v1/webhook`) would reject that payload outright — `vrsWebhookEventSchema` is a `.strict()` discriminated union, so the three extra keys are unrecognized keys. Two ways forward: relax the webhook's schema to tolerate/consume the new fields, or add a dedicated route.
**Decision**: Add a dedicated route, `POST /api/integrations/vrs-ai/v1/call-result`, in a new dependency-injected module `server/vrs-ai-call-result.ts`. Leave `/webhook` byte-for-byte alone. The new route authenticates with the existing `VRS_SASHA_API_KEY` `X-API-Key` (timing-safe compare, same as inbound authorize and the service-order lookup), validates the payload strictly, resolves the ticket (bridge row for the call id first, then the bare 8-digit `soNo` matched against the dashed `service_order` suffix via a new bounded storage query), and closes it by calling `processSubmissionHandler` with `action: "approve"` under the ticket's human reviewer — the same mechanism the webhook sink already uses. The three new fields are written into the ticket's agent notes.
**Consequences**:
- (+) The documented V5/V8/V9 partner contract, its OpenAPI file, the handoff docs, and the HMAC/ledger/forward chain are all untouched. The bridge suite still passes 179/179 unmodified, so nothing in the V9 chain regressed.
- (+) Reusing `processSubmissionHandler` means SMS, audit columns, the optimistic lock, and WS broadcasts are identical to a human agent approval — no second, divergent close path to keep in sync.
- (+) The `soNo`-suffix fallback lets the route close tickets that have no bridge row at all (PWA / manual submissions), which is the likely shape of most DEV testing.
- (−) **This route has no HMAC signature check and no timestamp window.** It is API-key-only, so it is materially weaker than `/webhook` and must not be treated as a replacement for the partner hop. If VRS AI's result must reach SASHA, `/webhook` is still the only path that forwards it.
- (−) **It writes no `vrs_ai_call_events` ledger row**, so its idempotency is weaker than the webhook's: it dedupes by observing that the ticket is already `completed` with the same `authNumber`. That covers the realistic retry, but two *different* approvals for one ticket are not ordered by a ledger.
- (−) The close inherits the `approve` path's requirement that a daily RGC code exist for the ET day. With no code set, every close fails (surfaced as `422 TICKET_CLOSE_FAILED` carrying the real message). This is existing policy, not new, but it makes an automated close dependent on a human having set the day's code.
- (−) `state` is pinned to `"approved"`; `denied` / `partial` / `failed` / `requires_info` are rejected with 400 rather than silently mapped, since "close the ticket" has no defined meaning for them. If those need handling here, decide per-state behavior explicitly (tracked in todos).
- The ticket-selection rule lives in the pure exported `selectVrsAiCallResultTicket` so it is unit-testable without a DB: bridge link wins; `techId` narrows the service-order matches only when it matches at least one (roster casing/format can drift, and hard-filtering would strand a legitimate close); prefer `pending`; else newest.

### ADR-015: SHSAI Service Order History migrated from Telluride UAT to Sears-hosted prod
**Date**: 2026-05-20
**Status**: Active
**Context**: On 2026-05-09 the SHSAI service at `ais.tellurideplatform.com/tell/api/hs/routing/v1` (Telluride UAT) began returning 403 on every request. Commit `307f514` hid the Service Order History tab, disabled the auto-fetch on ticket selection, and added an amber "currently unavailable" banner so the panel could land cleanly on the Calculator tab in the interim. Tyler was then given a new UI URL `https://shsai-routing-ui.prod.nextgen.shs.com/` for the prod-hosted replacement and was uncertain whether the API contract had changed.
**Decision**: Treat the migration as a drop-in API base swap. Discovery: the new UI host serves a tiny Vite SPA whose JS bundle (`/assets/index-*.js`) compiles in the API base as `https://shsai-routing-assist.prod.nextgen.shs.com/tell/api/hs/routing/v1` — verified by grepping the bundle for endpoint strings (`/init`, `/sse/assist`, `/prompt`, etc., all present at that base). End-to-end probe (`/init` → `/sse/assist` against a real SO#) returned `status:SUCCESS` + a populated streamed customer-history markdown response. Implementation: one-line change in `server/services/shsai.ts` (constant `SHSAI_BASE_URL`); UI restoration in `client/src/pages/agent-dashboard.tsx` reverts the five visual/behavioral changes from `307f514` (default tab, persisted-pref migration, auto-fetch useEffect, banner, TabsTrigger + refresh button).
**Consequences**:
- (+) Zero contract changes. `/init` still returns `{status, thread_id, session_id}` in the body; `/sse/assist` still streams `{"type":"TEXT","content":"..."}` chunks terminated by `{"type":"STATUS","content":"COMPLETE"}`. Existing TS client (`initSession`, `sseAssist`, `queryServiceOrder`, `sendFollowup`) works unmodified.
- (+) The `sessionId` response-header path in `initSession` is now unused — the new host returns session_id only in the body. Code keeps the `response.headers.get("sessionid") || data.session_id` fallback chain for safety; both branches now resolve to the body value.
- (+) Restoration leaves all original test IDs intact (`tab-shsai`, `button-shsai-refresh`, `shsai-loading`, `shsai-error`, `shsai-messages`, `shsai-response-${idx}`) — downstream tooling that referenced them by ID continues to work.
- (−) None known. The new host is in `prod.nextgen.shs.com` (Sears-managed) so reliability is now under our own infra rather than a vendor's UAT environment — a strict improvement.
- **If the new host ever drops the JSON-body session_id and returns it only via response header again, the existing code path still works** (header lookup runs first). If both paths fail, `initSession` returns `sessionId: ""` and `sseAssist` fails fast at the upstream with the same `REQ_SESSION_ID_ERROR` we saw during discovery — a clean failure mode.

### ADR-013: ET-canonical day boundary for daily-keyed records (RGC codes)
**Date**: 2026-05-06
**Status**: Active
**Context**: Hamed reported on 2026-05-05 that after 8 PM EDT the agent dashboard rejected approval attempts with "No RGC code has been set for today" even though the day's code had been set normally that morning. Root cause: every daily-keyed RGC lookup keyed on `new Date().toISOString().slice(0, 10)` (UTC date). EDT is UTC−4, so 8 PM EDT = midnight UTC, which flips the date to "tomorrow" — `getDailyRgcCode("2026-05-06")` returns nothing because the code was filed under "2026-05-05". VRS staffing is east-coast-anchored and the daily RGC code is a single shared code, so the day boundary should follow ET, not UTC.
**Decision**: Add `getEtDateString(d?: Date)` to `shared/business-hours.ts` (re-exported from `client/src/lib/business-hours.ts`). It returns the ET wall-clock date as `YYYY-MM-DD` using the same `getEtCalendarParts()` helper already used by the business-hours timer. Replace all six existing UTC slices with calls to it: 5 in `server/routes.ts` (auth approval line 1482, NLA approval line 1717, admin GET line 2496, admin verify line 2528, agent rgc-status line 2549) and 1 in `client/src/pages/admin-dashboard.tsx` (rgcDate state initializer line 1739).
**Consequences**:
- (+) Day boundary now flips at ET midnight, matching when admins actually set the next day's code.
- (+) DST-correct — `getEtCalendarParts` formats with `timeZone: "America/New_York"` so EST/EDT transitions handle themselves.
- (+) No schema change — the `valid_date` column is already a `YYYY-MM-DD` string with no embedded timezone.
- (+) Agents still working past 8 PM ET keep being able to approve normally; technicians submitting at any hour are unaffected (no time check on submission); business-hours-aware analytics timers (`getBusinessElapsedMs`) still pause overnight as before — this change only affects the day key, not the work window.
- (−) None known. Any consumer that genuinely wanted UTC date (none in this codebase) would need to call `toISOString().slice(0,10)` explicitly.

### ADR-014: Inline previous-rejection panel on the agent review cards
**Date**: 2026-05-06
**Status**: Active
**Context**: Hamed reported on 2026-05-05 that agents reviewing a resubmission see only a one-line "This is a resubmission" badge in the resolution slot, with the prior rejection reasons + Message-Sent-to-Technician buried in a separate Submission History card lower on the page. Several agents were re-rejecting tickets without realizing what the prior agent had asked the tech to fix. The data was already returned by `GET /api/submissions/:id/history` (full chain of submission rows including `rejectionReasons`, `stage1RejectionReason`, `technicianMessage`, `stage1ReviewedBy`); only the rendering was missing.
**Decision**: Add a `priorRejection` `useMemo` near the existing `submissionHistoryQuery` in `client/src/pages/agent-dashboard.tsx` that filters the history chain for submissions strictly older than the current selection with a rejected status (`ticketStatus IN ('rejected','rejected_closed')` OR `stage1Status === 'rejected'`), takes the most recent one, and exposes `{ reasons, stage1Reason, technicianMessage, reviewerName, reviewedAt }`. Render a red-bordered "Previous Rejection" panel using that memo at the top of both the Stage 1 review card (line ~2820, where the resubmission badge already lives) and the NLA review card (line ~2360). Show categorical reasons as a bulleted list, with `stage1RejectionReason` as a free-text fallback when no JSON reasons exist; show `technicianMessage` under a "Message Sent to Technician" sub-heading because that's the narrative agents need to evaluate the resubmission against. Reviewer name + timestamp render as a single de-emphasized footer line. The panel only appears when `priorRejection` is non-null — original-submission tickets and resubmissions with no prior rejection (e.g. resubmission after Invalid) keep the existing minimal behavior.
**Consequences**:
- (+) Zero API or schema work — the `/history` endpoint already returns whole submission rows, so all fields (including `technicianMessage`) were already on the wire.
- (+) Agents see the full prior-rejection context without scrolling, reducing redundant rejections of resubmissions that did address the prior feedback.
- (+) The existing Submission History card (rendered when `history.length > 1`) is unchanged — still serves as the full chain audit log.
- (−) Some duplication: the chain-summary line at line 2327 also surfaces `rejectionReasons` of past entries. Acceptable — the chain card is small and shows ALL prior entries; the new panel highlights only the most recent rejection at the top of the review card where decisions happen.
- (−) The panel can't show photos or the prior submission's full description; that's by design — when the agent needs the full prior submission they can click into the chain entry. Adding photo deltas would require a new API and was deferred.

### ADR-010: AES-256-GCM + scrypt(SESSION_SECRET, perRowSalt) for agent credential storage
**Date**: 2026-04-26
**Status**: Active
**Context**: TD3b in the calculator + intake form plan required at-rest encryption for per-agent calculator credentials. We need to decrypt on every iframe load so an envelope/KMS round-trip per request is too expensive, and we don't want to add a new managed-secret dependency.
**Decision**: Use Node's built-in `crypto` AES-256-GCM. Derive a per-row encryption key via `scrypt(SESSION_SECRET, perRowSalt, 32)` — `SESSION_SECRET` is already managed in Replit Secrets, already required for JWT signing, and rotating it already invalidates all sessions, so binding credential decryption to the same secret has no new operational cost. Per-row 16-byte salt prevents key reuse across rows. Store base64(ciphertext), base64(iv), base64(authTag), base64(salt) in `agent_external_credentials`. Pack BOTH per-field GCM auth tags into a single 32-byte base64 column (with xor'd IVs across the two ciphertexts) so the schema only needs one auth_tag column instead of two.
**Consequences**:
- (+) Zero new infra. Server never logs cleartext.
- (+) Rotating SESSION_SECRET invalidates stored credentials AND sessions atomically — agents are re-prompted to log in AND to re-save calculator credentials. Acceptable given the rarity of secret rotation.
- (−) No HSM-grade isolation. A server-side process compromise would let the attacker decrypt all stored credentials — this is documented and accepted in the threat model since the alternative is to not store calculator credentials at all and force agents to type them every time.
- (−) The xor'd IV trick needs a brief comment in `crypto.ts` so future maintainers don't think the IV is being reused naively.

**Browser-side handling (added 2026-04-26 after architect review):** the iframe `src` is the calculator base URL ONLY — credentials are never appended as query params (would leak to history + remote access logs). The `postMessage` envelope's `targetOrigin` is pinned to the parsed calculator origin (never `"*"`), so a navigated/compromised iframe will not receive credentials. Final fallback is the agent manually copying via the iframe header's Copy buttons (clipboard write).

### ADR-012: Stage 3 Smartsheet Intake reordered to AFTER Authorize & Send
**Date**: 2026-04-26
**Status**: Active (amends ADR-011's gate predicate; ADR-011 itself remains the architecture for atomic claim + 24h release window)
**Context**: Tyler reviewed the original ordering (intake collected DURING Stage 1/Stage 2 review, before Authorize & Send) and asked us to make Smartsheet the LAST step, gated behind a successful Authorize & Send. The original ordering had three real problems: (1) it asked agents to type Smartsheet payload while still deciding whether the ticket should even be approved — many fields differ depending on the decision; (2) rejected/invalid tickets were unnecessarily blocking the next claim because they were caught by the gate predicate `ticket_status IN ('completed','rejected','invalid','approved')` even though they have no Smartsheet row to file; (3) agents could complete the intake before authorize and then never authorize, leaving an `intake_forms` row referencing a not-yet-authorized submission.
**Decision**: Make the resolution panel a 3-stage progressive disclosure. Stage 3 (Smartsheet Intake) replaces Stage 2 in the same panel slot the moment `ticketStatus` flips to `"approved"` AND `auth_code` is non-null AND `request_type != 'parts_nla'` AND no `intake_forms` row exists. Server is the single source of truth via `GET /api/submissions/:id/intake-form-status`. Tighten `getMissingIntakeForAgent`'s WHERE clause to match (`ticket_status = 'approved' AND auth_code IS NOT NULL`) so the sidebar badge, claim-gate, and Stage 3 visibility all read the same predicate. Add a required attestation checkbox to the intake review modal so the audit row is only created when the agent attests they actually saw Smartsheet's success page. Keep the post-Authorize redirect inside the same ticket: scroll Stage 3 into view rather than clearing selection. NO schema changes — every signal already existed.
**Consequences**:
- (+) Workflow now matches the natural decision sequence: review → decide → authorize → log. Zero context-switching mid-decision.
- (+) Rejected / invalid tickets stop blocking the agent's next claim — they never needed a Smartsheet row.
- (+) The audit row in `intake_forms` is now harder to fabricate — the modal's required checkbox forces a deliberate attestation.
- (+) Server-side single source of truth eliminates the class of bug where client-side gating logic drifts from server-side gating.
- (−) Adds one more network round-trip per opened ticket (the `/intake-form-status` query). Acceptable: it's a single tiny GET, cached by TanStack Query, invalidated on the same events that already invalidate the `/api/submissions` predicate.
- (−) The required attestation checkbox is honor-system — Smartsheet's hosted form is cross-origin, we can't programmatically detect their success page from inside the iframe. Accepted as the cheapest correct option until/unless Todd Pennington enables Smartsheet's redirect-URL feature (already deferred to Phase 2).
- (−) An agent who navigates away mid-flow may not realize Stage 3 is waiting; the sidebar "Pending Smartsheet Intake (N)" badge is the visual forcing function before the gate kicks in.

**Race-condition fix (added after architect review, 2026-04-26):** `selectedSubmission.ticketStatus` and `intakeFormStatusQuery.data` come from two separate queries. During the invalidation window after Authorize, the per-submission intake-form-status endpoint may already report `required=true` (because the server-side update has landed) while the cached `selectedSubmission` still reports `ticketStatus='pending'`. Without an additional client-side guard, this caused Stage 1/2 and Stage 3 to render simultaneously for a few hundred ms. Mitigation: the Stage 1/2 card render predicate now also requires `!stage3Required && !stage3Recorded`, making Stage 3 a true replacement rather than an addition. NLA Stage 1/2 is unaffected (NLA tickets never trigger Stage 3).

**Note on per-submission vs. per-agent gating predicates:** the per-submission `/intake-form-status` endpoint and the per-agent `getMissingIntakeForAgent`/sidebar query intentionally use slightly different predicates. The per-submission endpoint asks "is THIS ticket missing an intake row?" and answers yes for any approved+authorized non-NLA ticket without an `intake_forms` row, regardless of who reviewed it or when. The per-agent query asks "does the current agent have unfinished intake work in their last 24h?" and is scoped to `reviewed_by = agent` + 24h window. They're aligned on the core release signal (`intake_forms` row exists) but the per-submission view is broader so that opening any historical missing-intake ticket surfaces Stage 3 immediately. This is by design and the architect's note about predicate "drift" was reframed accordingly — they're complementary, not redundant.

### ADR-011: Atomic UPDATE-WHERE claim + 24h intake-form gate (vrs_agent only)
**Date**: 2026-04-26
**Status**: Active
**Context**: T5 in the calculator + intake form plan required two protections on `PATCH /api/submissions/:id/claim`: (1) prevent two agents from racing to claim the same row; (2) prevent agents from racking up unfinished intake forms by gating new claims on completing the Smartsheet intake form for any recently-reviewed non-NLA ticket.
**Decision**: Replace the read-then-update sequence with `storage.claimSubmission(id, agentId)` which executes `UPDATE submissions SET ... WHERE id = $1 AND ticket_status = 'queued' RETURNING *` — atomic at the DB level, no advisory locks needed. Add `storage.getMissingIntakeForAgent(agentId)` which scans for submissions reviewed by this agent in the last 24h with `ticket_status != 'queued'`, `request_type != 'parts_nla'`, and no matching `intake_forms` row. Apply the gate ONLY for `vrs_agent` role; admins/super_admins bypass (they're often picking up someone else's queue or covering escalations and asking them to fill an unrelated intake form would be wrong). On 409, frontend auto-routes to the blocking submission and pops the intake review modal.
**Consequences**:
- (+) Race-free claim with zero coordination overhead.
- (+) Gate is psychologically and operationally aligned: agents finish what they started before grabbing the next one.
- (+) Clean 409 contract with structured codes (`INTAKE_REQUIRED`, `ALREADY_CLAIMED`) and `blockingSubmissionId`.
- (−) Gate state is computed on every claim attempt — O(N) over recent reviews. Negligible at current volume; if it becomes hot we'd add a `pending_intake_count` denormalized counter on `users`.
- (−) The existing claim-route code path was rewritten — care taken to keep auth checks identical and to handle the case where the row was already claimed between auth checks and atomic UPDATE (returns 409 ALREADY_CLAIMED rather than 200).

### ADR-001: Part Numbers Storage Format
**Date**: 2026-04-16
**Status**: Active
**Context**: NLA submissions needed to distinguish between parts that are unavailable (NLA) and parts that are available but must stay on the order.
**Decision**: Store as JSON object `{"nla": [...], "available": [...]}` in the existing `partNumbers` text column. Backward compatible — old array format `["PART1", "PART2"]` still parses and displays correctly.
**Consequences**: All display code (agent dashboard, tech detail, XLSX export) must handle both formats.

### ADR-002: Upload Diagnostics as Server Logs Only
**Date**: 2026-04-16
**Status**: Active
**Context**: iPhone photo uploads were failing with zero server-side visibility. Needed diagnostics without adding database complexity.
**Decision**: Fire-and-forget `POST /api/uploads/report-error` endpoint that logs `console.error("[UPLOAD-DIAGNOSTIC]", ...)`. No database table, no retention policy.
**Consequences**: Diagnostics only visible in deployment logs. Sufficient for debugging since upload failures are infrequent.

### ADR-003: Admin Notification Without Status Toggle
**Date**: 2026-04-16
**Status**: Active
**Context**: Admins had no online/offline toggle, so their `agentStatus` defaulted to "offline" and they were excluded from all WebSocket broadcasts.
**Decision**: Broadcast functions check role separately — admins/super_admins skip status check entirely and always receive notifications when connected via WebSocket.
**Consequences**: Admins cannot opt out of notifications while on the dashboard. Acceptable since they are supervisory.

### ADR-004: Schema and Data Safety Guardrails
**Date**: 2026-04-16
**Status**: Active
**Context**: Two AI agents (Replit Agent + Claude AI) both modify code. Schema changes via Drizzle `db:push` can silently drop columns/data. Seed.ts runs on every restart with potentially destructive operations.
**Decision**: Multi-layer protection: (1) `drizzle.config.ts` uses `strict: true` + `verbose: true` to force confirmation on destructive changes. (2) `shared/schema.ts` has a safety header with explicit rules. (3) `cleanupTestSubmissions()` gated behind `NODE_ENV !== "production"`. (4) `deleteUser()` in storage refuses system accounts and logs cascading deletes. (5) Delete user API blocks self-delete and super_admin deletion.
**Consequences**: Schema changes require explicit confirmation. Test cleanup won't run in production. Accidental user deletion is harder. Both AI agents have documented rules in their respective instruction files.
