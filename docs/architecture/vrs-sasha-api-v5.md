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
| V5 | Core fields; `appliance_grade`, `partner_id`, `appliance_photos`, and `comments` remain optional | A terminal repeat remains subject to ordinary ticket/SO policy |
| V8 | Every V5 field plus the four V8-only fields; the four formerly optional V5 fields are required | A strict V8 retry after a locally applied retryable `failed` V8 callback gets a new normal ticket, bridge, and public call ID; other terminal repeats use ordinary ticket/SO policy |

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
no VRS Express login. For V8 only, when `appliance_photos` is empty and the
ticket contains authenticated internal `/objects/` photo paths, dispatch
converts those paths to direct signed HTTPS Object Storage `GET` URLs valid
for 24 hours. VRS AI retrieves them with a plain `GET` and no VRS Express API
key, session cookie, or media token. A signing failure fails dispatch before
the VRS AI call; the authenticated internal path is never sent outbound.

For direct development lookup, VRS AI may call
`GET <VRS_EXPRESS_DEV_BASE_URL>/api/integrations/vrs-ai/v1/service-orders/{service_order}`
with the same VRS Express `X-API-Key` used by inbound authorize. The route
returns only the latest bridge-received request for that eight-digit service
order, removes callback fields, and merges sender photo URLs with the linked
VRS Express ticket photos. Internal `/objects/` values are converted to
24-hour signed HTTPS URLs; no database or schema mutation occurs.

## Failure and terminal-repeat behavior

`approved`, `partial`, `denied`, and `failed` are terminal callback states;
`requires_info` is non-terminal. VRS AI owns call admission and rate limits.

Only active bridge calls produce a duplicate conflict. V5 and nonretryable V8
terminal repeats remain subject to ordinary ticket/SO policy.

The narrow V8 exception is a strict V8 request whose latest same-service-order
bridge is a retryable `failed` V8 call with its terminal failed callback
locally applied. VRS Express creates a new normal ticket, new bridge row, and
new public call ID immediately. It excludes only prior retryable-failed V8
bridge tickets from the legacy same-day duplicate checks; every other ticket
constraint remains in force. It never reuses or resets the old ticket, bridge,
or event. Upstream forwarding remains independent: an old callback-forward
retry may continue from its durable ledger without delaying or altering the
new request.

## Development safety boundary

Development testing uses development URLs, credentials, configuration, and
data only. Inbound testing requires a provisioned active VRS Express DEV
technician and a unique eight-digit DEV service order. VRS Express derives the
district from `tech_id` and normalizes the roster's `000DDDD` form to the
four-digit service-order prefix; district is not an inbound payload field.
Source readiness, environment activation, and production
release are separate decisions. The bridge must not be activated until both
directions of the development acceptance checklist in the handoff pass with
sanitized evidence.
