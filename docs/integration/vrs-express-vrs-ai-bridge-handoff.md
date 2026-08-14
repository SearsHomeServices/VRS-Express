# VRS Express to VRS AI Development Integration Handoff

| Item | Value |
|---|---|
| Platforms | VRS Express and VRS AI |
| Interface | Strict V5, strict V8, and strict V9 on `POST /vrs/authorize` |
| Environment | Development only until both acceptance directions pass |
| Machine-readable contract | [vrs-express-vrs-ai-bridge-openapi.yaml](./vrs-express-vrs-ai-bridge-openapi.yaml) |

This is an in-place revision of the existing bridge, not a replacement
system. It is the exact development handoff for both directions and contains
no live URL, key, or customer data. Substitute the four approved URL
placeholders only in the controlled development environment.

## 1. What each platform does

| Platform | Responsibility |
|---|---|
| VRS Express | Authenticate authorize intake, create the normal pending ticket, hold for human approval, dispatch the same contract version, verify result signatures, apply ticket/SMS effects once, and forward the result |
| VRS AI | Simulate the upstream sender for inbound testing; receive approved requests for outbound testing; own call admission, rate limits, call execution, recordings, callback production, and callback retries |

Manual and PWA tickets with no bridge record never call VRS AI.

The current automated bridge is for American Home Shield authorization. VRS
Express normalizes `partner_id` case, spaces, and hyphens and accepts `ahs`,
`american_home_shield`, or `N/A`; missing V5 `partner_id` defaults to AHS.
Other partner values are rejected before ticket creation.

| Placeholder | Required development value |
|---|---|
| `<VRS_EXPRESS_DEV_BASE_URL>` | Public VRS Express development origin, without `/vrs/authorize` |
| `<VRS_AI_DEV_BASE_URL>` | Public VRS AI development origin, without `/vrs/authorize` |
| `<VRS_EXPRESS_DEV_CALLBACK_URL>` | Exact VRS Express development callback ending `/api/integrations/vrs-ai/v1/webhook` |
| `<UPSTREAM_DEV_CALLBACK_URL>` | Exact clean HTTPS upstream development webhook already permitted by VRS Express intake |

### Development data prerequisites

Before Direction A, replace each sample `tech_id` with a provisioned active
VRS Express DEV technician. VRS Express resolves its internal ticket prefix
from `tech_id` and normalizes the roster's `000DDDD` representation to four
digits. V9 separately requires the order-scoped `district_number`; that field
does not replace the technician roster check. Use the same technician ID in
`comments[].tech_id`.
Replace each sample `service_order` with a unique eight-digit DEV value. The
literal identifiers in the examples are format-safe samples only and must not
be sent unchanged.

## 2. Exact two-direction development flow

### Direction A: VRS AI simulator to VRS Express

1. VRS AI's simulator sends `POST
   <VRS_EXPRESS_DEV_BASE_URL>/vrs/authorize`.
2. It authenticates with the development VRS Express intake `X-API-Key`.
3. It sends one complete strict V5, V8, or V9 body with
   `callback_url: "<UPSTREAM_DEV_CALLBACK_URL>"`.
4. VRS Express returns `202` with its public call ID after creating one pending
   human-review ticket. This `202` means pending human review and does not call VRS AI.
5. Before human approval, the expected VRS AI receive count is zero.

### Direction B: VRS Express to VRS AI

1. A human reviews and approves the development ticket.
2. VRS Express sends the same contract version to
   `<VRS_AI_DEV_BASE_URL>/vrs/authorize` using the separate VRS Express-to-VRS
   AI development `X-API-Key`.
3. VRS Express preserves the business payload and replaces only
   `callback_url` with `"<VRS_EXPRESS_DEV_CALLBACK_URL>"` and
   `callback_secret` with its per-attempt callback secret.
4. A VRS AI `202` means asynchronous admission. It does not prove that dialing
   or any phone call has started or completed.
5. VRS AI returns its provider `call_id`, then sends signed events to the exact
   callback URL received in the request.

The two `X-API-Key` values are separate credentials and are exchanged outside
this handoff.

## 3. Strict contract selection

All three versions use the same route and have `additionalProperties: false`.

- If either `cta_no` or `district_number` exists, the entire request is strict
  V9.
- If any one of `appliance_color`, `contract_number`, `purchase_year`, or
  `symptom` exists, the entire request is strict V8.
- Otherwise the entire request is strict V5.
- A partial V8/V9 request fails its selected validation; it never falls through.
- VRS Express dispatches the same contract version received and never
  up-converts V5.
- Never emit `contractVersion`, `contract_version`, `end_level`, or
  `diagnostic_photos`.

## 4. Copyable V5 development payload

V5 requires the core fields below. `appliance_grade`, `partner_id`,
`appliance_photos`, and `comments` are optional, but this complete example
includes them.

```json
{
  "service_order": "13538277",
  "tech_id": "replace-with-dev-tech-id",
  "tech_phone": "+12145550199",
  "tech_name": "Example Technician",
  "reason_for_call": "authorization",
  "callback_url": "<UPSTREAM_DEV_CALLBACK_URL>",
  "callback_secret": "example-callback-secret-not-for-live-use",
  "parts": [
    {
      "part_id": "WPW10503278",
      "part_description": "Electronic Control Board",
      "sell_price": 245,
      "part_function": "Controls wash cycle timing and motor speed."
    }
  ],
  "customer_name": "Example Customer",
  "customer_address": "100 Example Street, Example City, NC 27000",
  "service_address": "100 Example Street, Example City, NC 27000",
  "brand": "Whirlpool",
  "model_number": "WTW5000DW1",
  "serial_number": "C31290822",
  "appliance_type": "Washer",
  "appliance_age": 4,
  "labor_amount": 120,
  "tax_amount": 15.6,
  "part_price": 245,
  "appliance_location": "laundry room",
  "failure_cause": "normal-wear",
  "tech_recommendation": "repair",
  "repair_replace_rationale": "The isolated board failure is repairable.",
  "appliance_grade": "mid",
  "partner_id": "ahs",
  "appliance_photos": [],
  "comments": [
    {
      "tech_id": "replace-with-dev-tech-id",
      "work_item": "failure_diagnosis",
      "text": "Diagnostic code F7E1 was confirmed.",
      "timestamp": "2026-08-11T18:00:00Z"
    }
  ]
}
```

## 5. Copyable V8 development payload

V8 requires every V5 key, including the four fields optional in V5, plus the
four V8-only keys.

```json
{
  "service_order": "13538278",
  "tech_id": "replace-with-dev-tech-id",
  "tech_phone": "+12145550199",
  "tech_name": "Example Technician",
  "reason_for_call": "authorization",
  "callback_url": "<UPSTREAM_DEV_CALLBACK_URL>",
  "callback_secret": "example-callback-secret-not-for-live-use",
  "parts": [
    {
      "part_id": "WPW10503278",
      "part_description": "Electronic Control Board",
      "sell_price": 245,
      "part_function": "Controls wash cycle timing and motor speed."
    }
  ],
  "customer_name": "Example Customer",
  "customer_address": "100 Example Street, Example City, NC 27000",
  "service_address": "100 Example Street, Example City, NC 27000",
  "brand": "Whirlpool",
  "model_number": "WTW5000DW1",
  "serial_number": "C31290822",
  "appliance_type": "Washer",
  "appliance_age": 4,
  "labor_amount": 120,
  "tax_amount": 15.6,
  "part_price": 245,
  "appliance_location": "laundry room",
  "failure_cause": "normal-wear",
  "tech_recommendation": "repair",
  "repair_replace_rationale": "The isolated board failure is repairable.",
  "appliance_grade": "mid",
  "partner_id": "American Home Shield",
  "appliance_photos": [],
  "comments": [
    {
      "tech_id": "replace-with-dev-tech-id",
      "work_item": "failure_diagnosis",
      "text": "Diagnostic code F7E1 was confirmed.",
      "timestamp": "2026-08-11T18:00:00Z"
    }
  ],
  "appliance_color": "stainless steel",
  "contract_number": "1234567890",
  "purchase_year": 2022,
  "symptom": "Washer does not drain"
}
```

V8 placeholder values are part of the contract:

- `tech_phone`: E.164 or `"N/A"`.
- `appliance_grade`: `entry`, `mid`, `top`, or `"N/A"`.
- `appliance_color`, `contract_number`, `symptom`, and `partner_id`: nonblank;
  `"N/A"` is permitted.
- `purchase_year`: a positive integer with no contract upper limit, `"TBD"`,
  or `"N/A"`.
- `tech_name`, `customer_name`, `parts[].part_function`, and
  `repair_replace_rationale` may be the empty string.
- `appliance_photos` and `comments` may be empty arrays but must be present.

## 5A. V9 development delta

V9 is the complete V8 payload plus these two required fields. The complete
copyable V9 example is also under `examples.v9` in the OpenAPI file.

```json
{
  "cta_no": "1234567890",
  "district_number": "8206"
}
```

- `cta_no` is nonblank with no contract maximum and must exactly equal
  `contract_number`, including when both are `"N/A"`.
- `district_number` is the order-scoped four-digit district (`"8206"`) or
  `"N/A"`. It is not the technician's routing-area district.
- VRS Express preserves both fields through review and dispatch. It does not
  derive or overwrite them.

## 6. Exact field constraints

Unknown root, part, and comment keys are rejected.

| Field | V5 | V8 |
|---|---|---|
| `service_order` | Exactly 8 digits | Exactly 8 digits |
| `tech_id` | Nonblank, max 50 | Nonblank, max 50 |
| `tech_phone` | E.164 | E.164 or `N/A` |
| `tech_name` | Nonblank, max 255 | String, max 255; empty allowed |
| `reason_for_call` | Literal `authorization` | Literal `authorization` |
| `callback_url` | Direction-specific development callback URL | Same |
| `callback_secret` | 16-512 characters | 16-512 characters |
| `parts` | At least 1; no contract maximum | At least 1; no contract maximum |
| `customer_name` | Nonblank, max 255 | String, max 255; empty allowed |
| `customer_address`, `service_address` | Nonblank, max 1000 each | Same |
| `brand`, `model_number`, `serial_number`, `appliance_type` | Nonblank, max 100 each | Same |
| `appliance_age` | Number, 0-100 | Number, 0-100 |
| `labor_amount`, `tax_amount`, `part_price` | 0-1,000,000; at most 2 decimals | Same |
| `appliance_location` | Nonblank, max 100 | Nonblank, max 100 |
| `failure_cause` | `normal-wear`, `power-surge`, `impact`, `installation-error`, `abuse`, `age`, or `other` | Same |
| `tech_recommendation` | `repair` or `replace` | Same |
| `repair_replace_rationale` | Nonblank; no contract maximum | String; empty allowed; no contract maximum |
| `appliance_grade` | Optional: `entry`, `mid`, `top` | Required: `entry`, `mid`, `top`, `N/A` |
| `partner_id` | Optional nonblank string, max 50 | Required nonblank string, max 50 |
| `appliance_photos` | Optional; maximum 10 absolute URLs | Required; maximum 10 absolute URLs |
| `comments` | Optional; maximum 20 | Required; maximum 20 |
| `appliance_color` | Not allowed | Required nonblank string, max 40 |
| `contract_number` | Not allowed | Required nonblank string; no contract maximum |
| `purchase_year` | Not allowed | Positive integer with no upper limit, `TBD`, or `N/A` |
| `symptom` | Not allowed | Required nonblank string; no contract maximum |

V9 keeps every V8 constraint and adds:

| Field | V9 constraint |
|---|---|
| `cta_no` | Required nonblank string; no contract maximum; exactly equals `contract_number` |
| `district_number` | Required four digits or `N/A` |

Each `parts[]` item is strict:

| Field | Constraint |
|---|---|
| `part_id` | Nonblank, max 100 |
| `part_description` | Nonblank, max 500 |
| `sell_price` | 0-1,000,000; at most 2 decimals |
| `part_function` | Max 200; V5 nonblank, V8 empty allowed |

Each `comments[]` item is strict:

| Field | Constraint |
|---|---|
| `tech_id` | Nonblank, max 50 |
| `work_item` | `failure_diagnosis`, `tech_recommendation`, `appliance_features`, `customer_history`, `tech_observation`, or `other` |
| `text` | Nonblank, max 2000 |
| `timestamp` | ISO-8601 date-time with offset |

## 7. Controlled V8/V9 enrichment and photos

After approval, VRS Express may fill only a documented placeholder in an
already-existing V8/V9 key from authoritative data for that exact field. The
implemented candidates are `tech_phone`, `tech_name`, and an empty
`appliance_photos` array. It never overwrites a populated value, appends a
missing key or changes contract version. V9 `cta_no` and `district_number`
pass through unchanged.

Sender-provided TINA/signed photo URLs pass through byte-for-byte and require
no VRS Express login. When an accepted V8/V9 request has an empty
`appliance_photos` array and its VRS Express ticket contains authenticated
internal `/objects/` photo paths, VRS Express converts those paths at dispatch
into direct signed HTTPS Object Storage `GET` URLs valid for 24 hours. VRS AI
downloads each URL with a plain `GET`; it does not send a VRS Express API key,
session cookie, or media token. A signing failure stops dispatch before VRS AI
is called. The internal path itself is never sent as the outbound photo URL.

## 8. Authorize responses and identifiers

### Accepted

```json
{
  "call_id": "vrs_call_456",
  "service_order": "13538278",
  "state": "queued",
  "created_at": "2026-08-11T18:01:00Z"
}
```

For Direction A, `call_id` is the public VRS Express call ID. For Direction B,
it is the provider VRS AI call ID. VRS Express stores both and never exposes
the provider ID in its upstream admission response.

### Other responses

| Status | Meaning |
|---|---|
| `400` | Strict validation failed |
| `401` | Missing or invalid `X-API-Key` |
| `409` | `DUPLICATE_CALL` includes `existing_call_id`; `NOT_A_TECHNICIAN`, `SUBMISSION_ALREADY_EXISTS`, and `SUBMISSION_REJECTED` when the captured ticket status maps to a conflict return `{ "error", "message" }` |
| `422` | Unsupported partner code `UNSUPPORTED_PARTNER` includes `partner_id`; `UNKNOWN_TECHNICIAN`, `INACTIVE_TECHNICIAN`, `INVALID_TECHNICIAN_DISTRICT`, and non-conflict `SUBMISSION_REJECTED` return `{ "error", "message" }` |
| `429` | Admission limit reached; body includes `retry_after_seconds` |
| `500`, `502`, `503`, timeout | Admission was not proven |

VRS AI owns rate limits and its `429` policy. VRS Express does not add a
second contract rate schedule.

## 9. VRS AI result callback

VRS AI sends `POST <VRS_EXPRESS_DEV_CALLBACK_URL>` with:

```text
Content-Type: application/json
X-VRS-Signature: sha256=64-lowercase-hex-digest
X-VRS-Event-Id: evt_001
X-VRS-Timestamp: 1786471260000
```

All events require `version: 1`, `eventId` max 100, `callId` max 100, exact
8-digit `soNo`, an ISO-8601 `occurredAt`, and one of these five shapes:

```json
{"version":1,"eventId":"evt_approved_001","callId":"vrs_ai_call_456","soNo":"13538278","occurredAt":"2026-08-11T18:04:00Z","state":"approved","authNumber":"AHS-001","authorizedAmount":365.6,"durationSec":187}
```

```json
{"version":1,"eventId":"evt_partial_001","callId":"vrs_ai_call_456","soNo":"13538278","occurredAt":"2026-08-11T18:04:00Z","state":"partial","authNumber":"AHS-002","authorizedAmount":250,"requestedAmount":380.6,"denyReason":"Labor exceeded the coverage limit","durationSec":214}
```

```json
{"version":1,"eventId":"evt_denied_001","callId":"vrs_ai_call_456","soNo":"13538278","occurredAt":"2026-08-11T18:04:00Z","state":"denied","denyReason":"Repair cost exceeds the authorization limit","durationSec":142}
```

```json
{"version":1,"eventId":"evt_failed_001","callId":"vrs_ai_call_456","soNo":"13538278","occurredAt":"2026-08-11T18:04:00Z","state":"failed","reason":"busy","retryable":true}
```

```json
{"version":1,"eventId":"evt_info_001","callId":"vrs_ai_call_456","soNo":"13538278","occurredAt":"2026-08-11T18:04:00Z","state":"requires_info","question":"What is the unit age?","field":"appliance_age","urgency":"hard"}
```

`authNumber`, callback `callId`, and callback `eventId` have maximum length
100. `denyReason` and `question` have maximum length 2000; `field` has maximum
length 100. The `failed.reason` enum is
`busy`, `no_answer`, `ivr_error`, `agent_error`, `timeout`, or `aborted`.

### Event effects

| Event | VRS Express ticket effect | Technician SMS |
|---|---|---|
| `approved` | Approve and complete using `authNumber` | Yes, the normal approval SMS is attempted |
| `partial` | Approve and complete using `authNumber` and the partial detail | Yes, the normal approval SMS is attempted |
| `denied` | Reject using `denyReason` | Yes, the normal rejection SMS is attempted |
| `failed` | Status-only; no ticket decision | No |
| `requires_info` | Status-only; no ticket decision | No |

Every accepted event is recorded and forwarded. SMS delivery is best effort,
and replaying an event cannot repeat its ticket or SMS effect.

## 10. Callback acknowledgement and retry

VRS Express returns `200` after processing an event or recognizing an already
processed event. Either result is delivery success. VRS AI retries network
failures and callback HTTP `500`, `502`, or `503`; unchanged `400` and `401`
responses are not retryable.

The callback retry policy is a maximum of five attempts. Wait 1, 2, 4, and 8
seconds after successive failed attempts. Every retry keeps the same
`eventId` and exact body bytes and refreshes only `X-VRS-Timestamp`.

## 11. Exact raw-byte HMAC

Calculate the digest over the exact UTF-8 bytes transmitted as the body:

```text
digest = HMAC-SHA256(callback_secret, exact_raw_request_body_bytes)
X-VRS-Signature = "sha256=" + lowercase_hex(digest)
```

- Do not parse and reserialize after signing.
- Do not include the timestamp, URL, or headers in the HMAC input.
- `X-VRS-Event-Id` must exactly equal body `eventId`.
- `X-VRS-Timestamp` is current Unix epoch milliseconds and must be within five
  minutes of VRS Express.
- Retries keep the same event ID and exact body but refresh the timestamp.

Deterministic test vector:

```text
Secret: vrs-ai-test-secret-do-not-use-in-prod
Raw body: {"version":1,"eventId":"evt_001","callId":"vrs_ai_call_456","soNo":"13538277","occurredAt":"2026-07-24T17:24:00Z","state":"approved","authNumber":"AHS-001","authorizedAmount":365.6}
Expected: sha256=5631d513c93853fa58efc382eed0c19db14ab42b94b1fa44938bb44ee352d4b6
```

## 12. Idempotency, ordering, forwarding, and terminal repeats

VRS Express uses a durable event ledger with separate apply and forward
checkpoints. A replay of the same event returns `200` with `deduped: true` and
cannot repeat the ticket decision or technician SMS. There is no time-based
dedupe expiry in this interface.

`requires_info` may precede one terminal event. The terminal states are
`approved`, `partial`, `denied`, and `failed`. VRS Express forwards the accepted
event to `<UPSTREAM_DEV_CALLBACK_URL>` with its public call ID and the
sender-provided secret.

Only active bridge calls return `409 DUPLICATE_CALL`. V5 and nonretryable V8+
terminal repeats remain subject to ordinary ticket/service-order policy.

The narrow V8+ exception is a strict V8 or V9 request whose latest
same-service-order bridge is a retryable `failed` V8+ call with its terminal failed callback
locally applied. VRS Express creates a new normal ticket, new bridge row, and
new public call ID immediately. It excludes only prior retryable-failed V8+
bridge tickets from the legacy same-day duplicate checks; every other ticket
constraint remains in force. It never reuses or resets the old ticket, bridge,
or event. Upstream forwarding remains independent: an old callback-forward
retry may continue from its durable ledger without delaying or altering the
new request.

## 13. Exact development acceptance checklist

### Direction A acceptance: VRS AI simulator to VRS Express

- [ ] Provision an active VRS Express DEV technician, then replace both sample
      `tech_id` occurrences. VRS Express derives its internal ticket prefix
      from the technician roster; V9 still sends the separate order-scoped
      `district_number`.
- [ ] Replace each sample `service_order` with a unique eight-digit DEV value.
- [ ] Substitute `<VRS_EXPRESS_DEV_BASE_URL>` and
      `<UPSTREAM_DEV_CALLBACK_URL>` only in the development test runner.
- [ ] Send one unique complete V5 payload and receive `202` with a public call
      ID.
- [ ] Send one unique complete V8 payload and receive `202` with a public call
      ID.
- [ ] Send one unique complete V9 payload and receive `202` with a public call
      ID. Confirm `cta_no` equals `contract_number` and `district_number` is
      the order's four-digit district.
- [ ] Confirm each request creates exactly one pending development ticket.
- [ ] Confirm VRS AI receives zero outbound requests before human approval.
- [ ] Confirm a partial V8 body returns `400` and does not fall through to V5.
- [ ] Confirm a partial V9 body returns `400` and does not fall through to V8.
- [ ] Confirm a duplicate active service order returns `409`.

### Direction B acceptance: VRS Express to VRS AI

- [ ] Substitute `<VRS_AI_DEV_BASE_URL>` and
      `<VRS_EXPRESS_DEV_CALLBACK_URL>` only in development configuration.
- [ ] Approve the V5 ticket and confirm exactly one strict V5 request arrives
      with only callback ownership replaced.
- [ ] Approve the V8 ticket and confirm exactly one strict V8 request arrives,
      with the same contract version and usable sender-signed photos.
- [ ] Approve the V9 ticket and confirm exactly one strict V9 request arrives
      with both V9 fields unchanged and usable sender-signed photos.
- [ ] Return each of the five signed event shapes and confirm the expected
      ticket state, one technician SMS effect where applicable, and one signed
      upstream callback.
- [ ] Replay one event and confirm `200`, `deduped: true`, and no repeated
      ticket/SMS effect.
- [ ] Send a retryable V8/V9 failure, confirm its failed callback is applied
      locally, then immediately send a strict new same-version request and confirm a new
      normal ticket, new bridge row, and new public call ID. The old upstream
      forward retry may remain pending and must stay independent.
- [ ] Confirm V5 and nonretryable V8/V9 terminal repeats remain subject to
      ordinary ticket/service-order policy.

Do not use production URLs, credentials, or customer data for this checklist.
