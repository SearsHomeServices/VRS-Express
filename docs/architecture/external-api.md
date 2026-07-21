# External API v1

Machine-to-machine REST surface (`/api/external/v1/*`) for a non-Replit external app. Read access to every workflow (authorization, infestation, NLA) plus write access to create requests and record decisions. Added 2026-07-21.

## Design principle: adapter over existing handlers

The write routes do NOT reimplement any business logic. `server/routes.ts` names four previously inline handlers as consts — `createSubmissionHandler`, `claimSubmissionHandler`, `processSubmissionHandler`, `processNlaSubmissionHandler` — re-registers them on their original internal paths unchanged, and the external adapters invoke those same consts with an impersonated user on the request. Every side effect is therefore identical to an in-app action: Snowflake ProcID lookup, SMS chain, WebSocket broadcasts, audit/timing stamps, optimistic-locking claim semantics, idempotent create, and the submissions micro-cache bump.

The external v1 block is registered AFTER `processNlaSubmissionHandler` in `registerRoutes` — the consts are referenced by value at registration time (TDZ), so do not move the block earlier.

Shared helpers (key middleware factory, rate limiters, zod contracts, response projection) live in `server/external-api.ts`.

## Authentication — two keys, header `x-api-key`

| Key (secret) | Scope |
|---|---|
| `VRS_LOOKUP_API_KEY` | Reads (both GET routes). Same key as the legacy `GET /api/external/service-order/:so/nla`. |
| `VRS_EXTERNAL_WRITE_API_KEY` | Writes (create + decision). Separate, higher-privilege key. |

Timing-safe comparison; 503 `NOT_CONFIGURED` if the env var is unset; 401 `UNAUTHORIZED` (with IP/UA warn log) on mismatch.

Rate limits (in-process, global sliding window per key class — intentional: bounds total SMS/WS/DB cost for the single external caller; single-VM deployment): **60 reads/min**, **10 writes/min** → 429 `RATE_LIMITED`.

## Response conventions

- Success: `{ "data": ... }` (list route adds top-level `nextCursor`).
- Errors: `{ "error": string, "code"?: string }`. Errors forwarded from the internal handlers keep their original shape (`{ error }`).
- All submission payloads are **bounded projections** (`ExternalSubmissionRow` in `server/storage.ts` for reads; `projectSubmissionForExternal` for write responses). Media paths/thumbnails, `phoneOverride`, `rejectedMedia`, reassignment/appeal fields, and RGC codes are never returned.

## Routes

### GET `/api/external/v1/service-orders/:so`
All submissions for a service order (format `DDDD-SSSSSSSS`), newest first.
Returns `{ data: { serviceOrder, submissionCount, submissions: [...] } }`.

### GET `/api/external/v1/submissions`
Filterable list, descending id. Query params: `requestType`, `ticketStatus`, `createdAfter`/`createdBefore` (ISO dates), `cursor`, `limit` (default 50, max 100). `nextCursor` is non-null when the page was full; pass it back as `cursor` for the next page (may return an empty final page).

### POST `/api/external/v1/submissions` — create a request
Body (`externalCreateSubmissionSchema`):

- `technicianLdapId` (required) — resolved server-side against the Snowflake-synced `technicians` table (`getTechnicianByLdapId`, case-insensitive). 422 `UNKNOWN_TECHNICIAN` / `INACTIVE_TECHNICIAN` if not usable. The users row is created on demand via `getOrCreateTechUser` (same path as passwordless tech login); 409 `NOT_A_TECHNICIAN` if the resolved account isn't a technician.
- `serviceOrder`, `applianceType`, `requestType` (`authorization` | `infestation_non_accessible` | `parts_nla`), `warrantyType` (default `sears_protect`), `warrantyProvider?`, `issueDescription`, `estimateAmount?`, `partNumbers?` (same JSON-string contract as the PWA), `phone?` (defaults to the technician's phone on file; 400 `NO_PHONE` if neither), `additionalRequest?`.

**Deliberately not accepted in v1:** media fields (`photos`, `videoUrls`, `voiceNoteUrl`, thumbnails — external `/objects/` path injection risk) and `resubmissionOf` (ownership/chain semantics an external caller can't satisfy). Agents will see these tickets without photos.

The submission is attributed to the real technician user — SO duplicate/idempotency guards, Snowflake ProcID lookup, queue broadcast, and the "received" SMS to the tech all run normally. Internal handler statuses pass through (e.g. 409 duplicate-SO, 201 created, 200 idempotent replay). On success the row is re-read through `getSubmissionByIdForExternal` so the write response carries the same nested `{technician, agent}` shape as the read routes (falls back to the flat projection only if the re-read misses).

### POST `/api/external/v1/submissions/:id/decision` — record a decision
Body (`externalDecisionSchema`): `action` plus the same optional fields agents send (`agentNotes`, `technicianMessage`, `authCode`, `rejectionReasons`, `invalidReason`, `invalidInstructions`, `nlaFoundPartNumber`, `nlaResolution`).

Allowlisted actions:
- Authorization/infestation tickets: `approve_submission` (Stage 1 of AHS/First American), `approve`, `reject`, `reject_and_close`, `invalid`.
- NLA tickets (`requestType=parts_nla`): `nla_replacement_submitted`, `nla_replacement_tech_initiates`, `nla_part_found_tech_orders`, `nla_reject`, `nla_invalid`.
- Action-family must match the ticket type → 400 `ACTION_MISMATCH`.
- **Deferred from v1** (need capabilities the system account doesn't have): `approve_replacement_review`, `b2b_approved_replacement`, `nla_part_found_vrs_ordered`, `nla_escalate_to_pcard`, `nla_pcard_confirm`, `nla_rfr_eligible`.

Flow: decisions are attributed to the seeded **`VRS_EXTERNAL_API` system account** (503 `NOT_CONFIGURED` if missing). A `queued` ticket is auto-claimed by that account first via the real claim handler (fires the normal claim SMS + broadcasts + claim/optimistic-lock conflict handling — a lost race returns the claim handler's 409/403 as-is). Then the real process / process-nla handler runs. On success the row is re-read through `getSubmissionByIdForExternal` for the nested read shape.

**Auto-claim rollback:** if the decision step fails (4xx/5xx or throw) *after* the auto-claim succeeded, the route returns the ticket to the general queue (`updateSubmissionIfStatus(["pending"] → queued, assignedTo: null, expectAssignee = system account)`) and re-broadcasts `ticket_queued` to the right division (NLA-aware) — otherwise the ticket would strand assigned to the system account, invisible to human agents. The `expectAssignee` guard means a concurrent legitimate move wins and the rollback becomes a no-op. Verified: `approve` without today's RGC → 400 and the ticket lands back in queue.

**System-account status reset:** the claim handler flips the actor to `working` and the process handler to `online` — real agent lifecycle states that would leave the system account lingering on the admin live board. A `finally` block parks it back to `offline` after every decision flow (DB update + WS status map + `agent_status_changed` broadcast to admins, only when it isn't already offline).

Consequences to know:
- A ticket already claimed by a **live agent** returns 403 — external callers cannot override a human's active review. This is intentional.
- All internal business rules apply unchanged: `approve` requires today's RGC code to be set (400 if not); AHS/First American finals require `authCode`; every NLA resolution action requires `technicianMessage` (400 "Instructions for technician are required" if missing — and the failed decision triggers the auto-claim rollback like any other 4xx); NLA P-card escalated tickets are claim-blocked; etc.
- A decision on a ticket already in a terminal state (completed/rejected/invalid) returns **400** "Ticket must be in pending status to process" — not 409.
- The tech receives the claim SMS and the decision SMS back-to-back on an auto-claimed decision.
- Terminal rejections show `agent: null` in responses — the internal reject flow clears `assignedTo` (same as human-agent rejects); `reviewedBy` in the audit trail records the decision-maker.

**Warranty-gate normalization (2026-07-21):** the AHS/First American detection in the internal process handlers matches `warrantyProvider || warrantyType` (lowercased) against the substrings "american home shield" / "ahs" / "first american". Stored `warrantyType` enum values use underscores (`american_home_shield`, `first_american`), which never matched — so an external create with `warrantyType: "american_home_shield"` and no `warrantyProvider` skipped the external-auth-code requirement and completed with the RGC code. All four gate sites (`isTwoStage`, `b2b_approved_replacement`, `approve`, `approve_replacement_review`) now normalize underscores to spaces before matching. This also tightens internal tickets stored with an underscore warrantyType and empty provider. Two companion changes keep client and server in agreement: (a) the agent dashboard's `needsExternalAuth` / `getProviderAuthLabel` now mirror the exact server gate (`warrantyProvider || warrantyType`, lowercased, underscores normalized) so such tickets render the two-stage flow with the auth-code input; (b) the external create adapter defaults `warrantyProvider` to "American Home Shield" / "First American" when the caller omits it, so externally created rows carry a human-readable provider like internal ones.

## Public docs page

`GET /api/external/v1/docs` — unauthenticated, static self-contained HTML integration guide (`server/external-api-docs.ts`, `EXTERNAL_API_DOCS_HTML`). Placeholder keys only, `noindex`, own 30/min rate-limit bucket so doc fetches never consume the read budget. Shareable URL: `https://vrs-auth-tool.replit.app/api/external/v1/docs`. Keep it in sync when the contract changes.

## The `VRS_EXTERNAL_API` system account

Seeded by `ensureExternalApiUser()` in `server/seed.ts` (idempotent, keyed on rac_id; called AFTER `resetAllPasswords()` so a fresh DB can never give it the generic password). Role `vrs_agent` — deliberately NOT admin, so normal assignment checks still apply — with all 8 divisions incl. `nla` so the claim division gate passes for every ticket. `isSystemAccount: true` (delete-protected), `isActive: false` + random unrecoverable password (dashboard login impossible; the adapter impersonates it in-process, no JWT involved). It appears in ticket history/audit as "VRS External API".

## Testing notes

Reads are curl-testable in dev with `$VRS_LOOKUP_API_KEY` (never print the key). Writes require `VRS_EXTERNAL_WRITE_API_KEY` to be set. Remember the tech-side seed cleanup quirks in dev (test submissions for seeded techs are purged on restart).
