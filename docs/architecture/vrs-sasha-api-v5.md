# VRS Express ↔ VRS AI Bridge Architecture (Contracts V5 and V8)

This architecture defines the development bridge between VRS Express and VRS
AI. The existing path is preserved: VRS Express creates a normal pending
ticket, a human reviews it, and only an approval can dispatch an authorization
request to VRS AI.

## Development flow

```text
VRS AI simulator
  -> POST <VRS_EXPRESS_DEV_BASE_URL>/vrs/authorize
  -> VRS Express validates strict V5 or strict V8
  -> VRS Express creates one pending development ticket
  -> human review and approval
  -> POST <VRS_AI_DEV_BASE_URL>/vrs/authorize
  -> VRS AI returns asynchronous admission
  -> VRS AI signs a result to <VRS_EXPRESS_DEV_CALLBACK_URL>
  -> VRS Express applies the normal ticket/SMS result once
  -> VRS Express signs the result to <UPSTREAM_DEV_CALLBACK_URL>
```

The VRS Express `202` response means a pending human-review ticket exists. It
does not call VRS AI and does not mean a phone call has begun. After approval,
the VRS AI `202` response means asynchronous admission only.

Manual and PWA tickets without a bridge record never invoke VRS AI. Their
current approval, ticket, WebSocket, and SMS behavior remains unchanged.
The current automated bridge accepts American Home Shield authorization only;
other partner workflows remain outside this interface.

## Contract selection and preservation

V5 and V8 share `POST /vrs/authorize`; there is no version field on the wire.
The selector is deterministic:

- If any one of `appliance_color`, `contract_number`, `purchase_year`, or
  `symptom` is present, validate the entire body as strict V8.
- Otherwise validate the entire body as strict V5.
- Partial V8 requests fail V8 validation and never fall through to V5.
- Never send `contractVersion`, `contract_version`, `cta_no`, `end_level`, or
  `diagnostic_photos`.

VRS Express stores the accepted business shape and dispatches the same
contract version after approval. It never up-converts V5.

| Contract | Required authorize shape | Retryable failed attempt |
|---|---|---|
| V5 | Core fields; `appliance_grade`, `partner_id`, `appliance_photos`, and `comments` remain optional | V5 does not rearm; the failed attempt remains terminal |
| V8 | Every V5 field plus the four V8-only fields; the four formerly optional V5 fields are required | A new incoming V8 request may receive a new public call ID on the same ticket and must return to human review |

## Callback ownership and identifiers

The inbound request carries the sender's callback URL and per-request secret.
VRS Express stores that secret encrypted and does not place it in review data.
At approval, VRS Express replaces only `callback_url` and `callback_secret`
for the VRS AI hop.

VRS Express owns the public call ID returned to the sender. VRS AI owns the
provider call ID returned after approval. VRS AI callbacks use the provider
call ID; the final forwarded callback restores the public call ID.

VRS AI signs the exact raw UTF-8 request-body bytes with HMAC-SHA256 and sends
`X-VRS-Signature`, `X-VRS-Event-Id`, and `X-VRS-Timestamp`. VRS Express accepts
exactly five event states: `approved`, `partial`, `denied`, `failed`, and
`requires_info`.

A durable event ledger records event identity plus apply/forward checkpoints.
It prevents a replay from repeating the ticket decision or technician SMS and
allows a transient upstream delivery failure to resume safely. No time-based
dedupe expiry is part of this interface.

Callback delivery retries network failures and HTTP `500`, `502`, or `503`
for at most five attempts, waiting 1, 2, 4, and 8 seconds. The event ID and
exact body remain stable; only the timestamp header is refreshed.

## Data and media rules

VRS Express may enrich outbound V8 only when all of these are true:

1. The key already exists in the accepted V8 body.
2. The received value is a documented placeholder.
3. VRS Express has authoritative data for that exact field.

The implemented candidates are `tech_phone`, `tech_name`, and an empty
`appliance_photos` array. Populated sender values always win. VRS Express does
not append fields, overwrite facts, or add `cta_no`.

Sender-provided TINA/signed photo URLs pass through byte-for-byte and require
no VRS Express login. Authenticated internal `/objects/` paths are never
converted or exposed as sender photo URLs.

## Failure and rearm behavior

`approved`, `partial`, `denied`, and `failed` are terminal callback states;
`requires_info` is non-terminal. VRS AI owns call admission and rate limits.

A V8 rearm requires a new incoming complete V8 request after a retryable
`failed` result has been fully applied and forwarded. VRS Express reuses the
same ticket, creates a new public call ID and callback material, preserves the
prior attempt in the durable ledger, clears prior dispatch/result state, and
requires another human approval. Late callbacks for the superseded provider
call ID are acknowledged as duplicates without reapplying business effects.

## Development safety boundary

Development testing uses development URLs, credentials, configuration, and
data only. Inbound testing requires a provisioned active VRS Express DEV
technician mapped to a valid four-digit district and a unique eight-digit DEV
service order. Source readiness, environment activation, and production
release are separate decisions. The bridge must not be activated until both
directions of the development acceptance checklist in the handoff pass with
sanitized evidence.
