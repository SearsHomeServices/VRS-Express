# VRS Express ↔ VRS AI Bridge (SASHA Contract V5)

This design combines two sources:

- The V5 wire contract supplied on 2026-07-28.
- The July 24 Granola meeting, “VRS Express API integration — tech hub,
  Sasha, and AI system endpoints.”

The meeting is the ownership source of truth. The contract's diagram shows
SASHA calling VRS AI directly, but the operational design requires VRS Express
to remain the human approval and data-enrichment bridge.

## Phase 1 flow

```text
SASHA / Tech Hub
  → POST /vrs/authorize on VRS Express
  → normal pending VRS Express ticket
  → human agent: Approve & Send to VRS AI
  → POST /vrs/authorize on VRS AI
  → AHS phone authorization
  → signed callback to VRS Express
  → existing VRS ticket decision + technician SMS
  → signed callback forwarded to SASHA
```

Phase 1 is American Home Shield only. First American remains a separate portal
workflow until its execution path is validated. Choice, OEM, and Assurance are
outside this increment.

## Ownership

| System | Responsibility |
|---|---|
| SASHA / Tech Hub | Assemble the V5 payload, call Express, and receive the final callback. |
| VRS Express (this repository) | Authenticate intake, create/enrich the human ticket, hold for approval, dispatch to VRS AI, apply results, keep the existing SMS path, and forward callbacks. |
| VRS AI | Enforce call admission limits, build the AI prompt, dial AHS, manage recordings/call state, and send V5 events. |

The existing `/api/external/v1/*` API remains a separate general-purpose
human-ticket integration surface.

## Implemented surfaces

### SASHA → VRS Express intake

- `POST /vrs/authorize`
- Timing-safe `X-API-Key` authentication with `VRS_SASHA_API_KEY`
- Strict V5 validation, including `repair_replace_rationale`,
  `appliance_grade`, `appliance_photos`, and the V5 part/comment shapes
- Exact SASHA callback allowlist:
  - `https://sasha.prod.nextgen.shs.com/sasha/api/vrs/webhook`
  - `https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook`
- AHS-only partner gate
- Technician lookup against the Snowflake-synced technician table
- Bare eight-digit SO mapped to the normal `DDDD-SSSSSSSS` ticket format using
  the technician's four-digit district
- Normal `createSubmissionHandler` reuse, preserving duplicate checks, queue
  routing, broadcasts, ProcID lookup, and the existing received SMS
- Upstream callback secret encrypted with AES-256-GCM using the dedicated
  `VRS_BRIDGE_ENCRYPTION_KEY`

The `202 queued` response means the Express review ticket exists. It does not
claim that VRS AI has dialed AHS.

### Human approval → VRS AI

Bridge-backed Stage 1 tickets show **Approve & Send to VRS AI**. That action:

1. Atomically reserves one outbound dispatch.
2. Replaces SASHA's callback URL/secret with the Express callback.
3. Sends the unchanged V5 business payload to the configured VRS AI
   `/vrs/authorize` endpoint.
4. Records the VRS AI `call_id`.
5. Only then marks Stage 1 approved and sends the existing technician SMS.

Manual/PWA tickets without a bridge record retain their current approval flow.

### VRS AI → Express → SASHA callback

VRS AI posts to:

`POST /api/integrations/vrs-ai/v1/webhook`

Express verifies:

- HMAC-SHA256 over the exact raw body
- `X-VRS-Timestamp` within five minutes
- required matching `X-VRS-Event-Id`
- V5 event schema and matching service order/provider call ID

An event ledger makes ticket/SMS application idempotent and allows a failed
upstream forward to resume without repeating the technician side effects.
Terminal `approved`, `partial`, and `denied` events run through the existing
ticket process handler. `failed` and `requires_info` remain visible on the
pending ticket for agent/manual follow-up. The callback forwarded to SASHA
restores the public Express `call_id` and is signed with SASHA's original
per-request secret.

## Persistence

- `vrs_ai_calls`: one Express bridge record per submission, sanitized source
  payload, encrypted SASHA secret, provider call ID, dispatch/result state, and
  aggregate delivery status.
- `vrs_ai_call_events`: event-level idempotency and apply/forward checkpoints.

Both are additive tables/columns. No schema or data change has been applied to
the production-connected Replit database.

## Required configuration

| Variable | Purpose |
|---|---|
| `VRS_SASHA_API_KEY` | SASHA/Tech Hub → Express intake key |
| `VRS_BRIDGE_ENCRYPTION_KEY` | Dedicated 32+ character encryption root for stored SASHA callback secrets |
| `VRS_AI_BASE_URL` | `https://vrs-dev.stage.nextgen.shs.com` in staging; `https://vrs.prod.nextgen.shs.com` in production |
| `VRS_AI_API_KEY` | Express → VRS AI key |
| `VRS_AI_WEBHOOK_SECRET` | VRS AI → Express callback HMAC secret |
| `VRS_AI_CALLBACK_URL` | Exact public Express callback URL ending `/api/integrations/vrs-ai/v1/webhook` |
| `VRS_EXPRESS_PUBLIC_URL` | Optional origin used to derive the callback URL and rejection links |

Do not reuse `SESSION_SECRET` as the bridge encryption key. Rotating JWT/session
credentials must not make in-flight callback secrets undecryptable.

## Safe rollout

1. Rotate the credentials exposed by the earlier SSH-output incident before
   relying on them.
2. Apply the additive schema to the VRS development database only.
3. Configure staging secrets and the public callback URL.
4. Run the focused tests and production build.
5. Complete one AHS staging transaction end to end:
   intake → agent approval → VRS AI → Express callback → SASHA callback.
6. Promote through the normal deployment pipeline only after that evidence is
   captured.

Never run `db:push` against the production-connected Replit database.

## Remaining external dependencies

- Valid staging API/HMAC keys from SASHA and VRS AI
- A routable public Express callback URL
- VRS AI's decision for V5 O-V5-3: how
  `repair_replace_rationale` enters the AI prompt
- A real AHS staging transaction and known callback test vector

## Validation

```powershell
npm run test:vrs-ai-bridge
npm run build
npm run check
```

`npm run check` has a pre-existing repository baseline. Require zero new
diagnostics relative to `origin/main`; focused tests and the production build
must both pass.
