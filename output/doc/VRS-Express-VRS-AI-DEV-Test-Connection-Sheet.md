# VRS Express and VRS AI DEV Test Connection Sheet

Use this sheet with `VRS-Express-VRS-AI-Handoff-Package.zip`. The ZIP is the
wire contract; this sheet supplies the current development environment and the
exact joint-test sequence. It contains no credential values.

## Live development endpoints

| Direction | Endpoint |
|---|---|
| VRS AI simulator -> VRS Express | `POST https://a11bb216-7de2-40f6-ada7-2f3b2631048f-00-8qow8i4553hq.riker.replit.dev/vrs/authorize` |
| VRS AI -> VRS Express service order and photos | `GET https://a11bb216-7de2-40f6-ada7-2f3b2631048f-00-8qow8i4553hq.riker.replit.dev/api/integrations/vrs-ai/v1/service-orders/{service_order}` |
| VRS Express -> VRS AI | `POST https://vrs-dev.stage.nextgen.shs.com/vrs/authorize` |
| VRS AI result -> VRS Express | `POST https://a11bb216-7de2-40f6-ada7-2f3b2631048f-00-8qow8i4553hq.riker.replit.dev/api/integrations/vrs-ai/v1/webhook` |
| VRS Express result -> upstream DEV | `POST https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook` |
| VRS Express health check | `GET https://a11bb216-7de2-40f6-ada7-2f3b2631048f-00-8qow8i4553hq.riker.replit.dev/api/healthz` |

Do not use `https://vrs-auth-tool.replit.app` for this test. That is the
published VRS Express production URL; this test is development-only.

## Credential exchange

| Credential | Supplied by | Used by | Current action |
|---|---|---|---|
| VRS Express DEV `X-API-Key` | VRS Express | VRS AI simulator when creating an intake or retrieving a service order and its photos | VRS Express has generated and configured it. Use the same key for both VRS Express endpoints and transfer its value through the approved secure channel. |
| VRS AI DEV `X-API-Key` | VRS AI | VRS Express when calling VRS AI | VRS AI must transfer its value through the approved secure channel. VRS Express will store it as `VRS_AI_API_KEY`. |
| Outbound `callback_secret` | VRS Express | VRS AI when signing result callbacks | VRS Express sends this value inside each authorized DEV request. VRS AI must sign with the exact received value; no separate preconfiguration is needed. |
| Simulator `callback_secret` | VRS AI simulator | VRS Express when forwarding the result upstream | Include a DEV-only value in each simulator request and use the same value to verify the forwarded callback. |

Never place credential values in Git, this sheet, the contract ZIP, tickets,
screenshots, or ordinary test logs.

## Photo retrieval

VRS AI can retrieve the latest VRS Express bridge request and its current
photo download URLs by replacing `{service_order}` with the eight-digit
service order and sending the same VRS Express DEV `X-API-Key` used for
`POST /vrs/authorize`:

```http
GET /api/integrations/vrs-ai/v1/service-orders/99081203 HTTP/1.1
Host: a11bb216-7de2-40f6-ada7-2f3b2631048f-00-8qow8i4553hq.riker.replit.dev
X-API-Key: <VRS_EXPRESS_DEV_API_KEY>
```

The `200` response contains `service_order_info` and `appliance_photos`.
VRS Express removes callback credentials and converts its internal
`/objects/` paths into direct signed HTTPS Object Storage URLs. Generated
photo URLs are valid until `photo_urls_expire_at`; call the lookup again to
obtain fresh URLs after expiry.

```json
{
  "service_order": "99081203",
  "call_id": "vrs_call_example",
  "state": "pending_review",
  "contract_version": "v8",
  "service_order_info": {
    "service_order": "99081203",
    "tech_id": "test_tech_1",
    "brand": "Whirlpool",
    "model_number": "WTW5000DW1",
    "serial_number": "C31290822",
    "symptom": "Washer does not drain"
  },
  "appliance_photos": [
    "https://storage.googleapis.com/example-object?X-Goog-Signature=temporary"
  ],
  "photo_urls_expire_at": "2026-08-14T17:30:00.000Z"
}
```

`404 SERVICE_ORDER_NOT_FOUND` means VRS Express has not received that service
order through the bridge. `502 PHOTO_URL_GENERATION_FAILED` means the photo
URLs could not be generated and should be retried later.

The approved-ticket outbound payload remains a second supported delivery
path. For an approved V8 ticket, `appliance_photos` in the VRS Express -> VRS
AI payload contains the same usable photo locations.

Sender-provided external HTTPS
URLs remain unchanged. If VRS Express owns the photo, it replaces the internal
`/objects/` path with a direct signed HTTPS Object Storage `GET` URL valid for
24 hours.

VRS AI downloads each URL with a plain HTTP `GET`. Do not attach the VRS
Express `X-API-Key`, a login cookie, or a media token to that photo request.
The URL is generated per dispatch and should be downloaded during the test;
it is not a permanent bucket path. A photo-signing failure prevents the
authorize request from being sent, so VRS AI will never receive a known-broken
internal path.

Example outbound field (the real signature is generated at dispatch):

```json
{
  "appliance_photos": [
    "https://storage.googleapis.com/example-object?X-Goog-Signature=temporary"
  ]
}
```

## Test data

- Active VRS Express DEV technician: `test_tech_1`
- Technician district: `8175`
- Use `test_tech_1` in both root `tech_id` and `comments[].tech_id`.
- A sender never supplies district. VRS Express resolves it from `tech_id` and
  normalizes a real roster value such as `0008175` to the `8175` service-order
  prefix.
- Reserved/used smoke-test service order: `99081201` - do not reuse.
- Suggested one-time V5 service order: `99081202`.
- Suggested one-time V8 service order: `99081203`.
- If either suggested order has already been used, choose a new unique
  eight-digit DEV value before sending.
- Use only synthetic DEV customer, appliance, part, phone, and photo data.

## Joint test sequence

1. Confirm the VRS Express health endpoint returns `200`.
2. VRS AI simulator sends the complete strict V5 example from the handoff ZIP
   to the VRS Express DEV authorize endpoint. Replace the sample technician,
   service order, upstream callback URL, callback secret, and synthetic data.
3. Confirm VRS Express returns `202` with a public `call_id` and creates one
   pending human-review ticket.
4. Confirm VRS AI has received zero outbound authorize requests for that
   ticket before human approval.
5. Repeat steps 2-4 with the complete strict V8 example and a different unique
   service order.
6. A VRS Express human reviewer claims and approves each DEV ticket.
7. Confirm VRS AI receives exactly one authorize request per approved ticket,
   with the same contract version received by VRS Express and the VRS Express
   DEV callback URL.
8. For the V8 ticket, confirm each `appliance_photos` URL downloads with a
   plain `GET` and no VRS Express credentials.
9. VRS AI returns `202` with its provider `call_id`.
10. VRS AI sends a correctly signed result event to the VRS Express DEV callback
   URL, using the exact raw body and the `callback_secret` received in step 7.
11. Confirm VRS Express records the event, applies the expected ticket result,
    performs the applicable technician notification once, and forwards one
    signed result to the simulator's upstream DEV callback.
12. Replay the same event and confirm `200`, `deduped: true`, and no repeated
    ticket or notification effect.
13. Run the remaining callback shapes and retryable-failed V8 case from the
    acceptance checklist in the handoff ZIP.

## Expected checkpoints

| Checkpoint | Expected result |
|---|---|
| Missing or invalid VRS Express intake key | `401 UNAUTHORIZED` |
| Invalid or incomplete strict payload | `400 VALIDATION_ERROR` |
| Valid unique V5 or V8 intake | `202`, public VRS Express call ID, `pending_review` |
| Before human approval | No VRS AI outbound request and no provider call ID |
| After human approval | One same-version VRS AI authorize request |
| V8 ticket with VRS Express photos | Up to 10 direct signed HTTPS URLs; plain `GET` succeeds without VRS Express credentials |
| Service-order and photo lookup | `200` with sanitized `service_order_info`, up to 10 direct photo URLs, and photo expiry; same VRS Express DEV `X-API-Key` as intake |
| Valid signed result callback | `200`, durable event record, expected ticket effect |
| Exact event replay | `200`, `deduped: true`, no duplicate side effect |

## Current readiness

- VRS Express DEV intake and strict V8 admission have been proven with a real
  `202` response and a stored pending-review bridge record.
- VRS Express DEV photo signing has been proven against an existing stored
  photo: the generated HTTPS URL carried an approximately 24-hour expiry and a
  credential-free byte-range `GET` returned `206`. The temporary URL was not
  recorded in this sheet or test output.
- VRS Express owns and has configured its intake, callback, encryption, and
  environment values.
- Direction B is waiting only for the VRS AI DEV `X-API-Key` and the joint
  test window.
- No production publish or production database action is part of this test.
