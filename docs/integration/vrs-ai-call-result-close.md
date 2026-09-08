# VRS AI direct call-result integration

This route completes one reviewed authorization ticket. The signed `/webhook`
route remains available for the existing V5/V8/V9 bridge and upstream SASHA
forwarding. Choose the intended lane; do not send both as a retry strategy.

| Behavior | Direct `/api/integrations/vrs-ai/v1/call-result` | Signed `/api/integrations/vrs-ai/v1/webhook` |
|---|---|---|
| Authentication | Existing `X-API-Key` (`VRS_SASHA_API_KEY`) | Existing HMAC, event-ID and millisecond timestamp headers |
| Input | Approved result with part and technician metadata | Existing state union; optional approval metadata supported |
| Durable record | Separate direct-result receipt | Existing signed-event ledger |
| Upstream forwarding | None | Existing partner callback envelope; additional metadata retained locally |
| Manual/PWA tickets | Supported when exact and eligible | Existing provider-call bridge link required |

## Request

`POST /api/integrations/vrs-ai/v1/call-result`

Headers: `Content-Type: application/json` and `X-API-Key` with the existing inbound
key. Do not substitute the webhook secret for this key.

```json
{
  "version": 1,
  "eventId": "fixture-event-001",
  "callId": "fixture-call-001",
  "soNo": "99090801",
  "occurredAt": "2026-09-08T14:01:45.289Z",
  "state": "approved",
  "authNumber": "TEST-AUTH",
  "authorizedAmount": 380.6,
  "durationSec": 187,
  "partId": "TEST-PART",
  "techId": "TESTTECH",
  "partDescription": "Test dishwasher part",
  "recordingUrl": "https://recordings.example.test/fixture.wav"
}
```

These are synthetic values, not a live ticket. `durationSec` and `recordingUrl`
remain optional. Optional positive-integer `submissionId` can identify a specific
manual/PWA ticket when order history is ambiguous. It never bypasses call, order,
technician, part or workflow checks.

`callId` can be the stored provider call ID or public bridge call ID. If there is
a bridge link, it must agree with an explicitly supplied submission ID. For an
unlinked manual ticket, the order and technician must identify exactly one row,
or the sender must supply `submissionId`. Newest or pending-first guessing is
not used. Technician matching is case-insensitive and whitespace-normalized.

The ticket must be in the authorization workflow for AHS or First American, and
Stage 1 must have been approved by a human. NLA and other workflows use their
existing routes. A result predating the ticket or disagreeing with its known
parts is rejected. There must be a reviewer and today's Eastern-time RGC.

## Successful response

```json
{
  "ok": true,
  "closed": true,
  "deduped": false,
  "submission_id": 101,
  "service_order": "0001-99090801",
  "ticket_status": "completed",
  "auth_number": "TEST-AUTH",
  "call_id": "fixture-call-001",
  "event_id": "fixture-event-001",
  "notification": { "status": "accepted", "notificationId": 501 }
}
```

Validation failures before a ticket is selected reserve no receipt, so the
sender can correct a rejected mapping or add `submissionId`. Once a validated
ticket is bound, the event ID, call ID and full payload are immutable.

An identical completed retry returns the original receipt with `closed:false`
and `deduped:true`. An interrupted request is bound to its original submission
before any ticket effect. It cannot select a later ticket on retry. A completed
ticket without a matching durable receipt and the exact recorded callback note is not evidence of this event's
application and returns a conflict for operator review.

Notification `accepted` means the provider accepted the send, not confirmed
handset delivery. `failed` and `unknown` require separate notification recovery;
never re-run approval to resend a text. A crash after ticket commit can return
an unknown notification outcome on recovery, without repeating the send.

## Sender acknowledgment validation

HTTP 200 alone is insufficient. Require JSON and verify the actual result:

```typescript
function validateCallResultAcknowledgment(response: Response, body: any, event: any) {
  const json = response.headers.get("content-type")?.includes("application/json");
  const validOutcome = (body?.closed === true && body?.deduped === false) ||
    (body?.closed === false && body?.deduped === true);
  const order = /^(?:\d{4}-)?(\d{8})$/.exec(body?.service_order ?? "")?.[1];
  return response.status === 200 && json && body?.ok === true && validOutcome &&
    body.event_id === event.eventId && body.call_id === event.callId &&
    body.ticket_status === "completed" && order === event.soNo &&
    body.auth_number === event.authNumber &&
    Number.isSafeInteger(body.submission_id) && body.submission_id > 0 &&
    (event.submissionId === undefined || body.submission_id === event.submissionId);
}
```

Serialize the event once and keep the same event ID and body on every retry.
Do not catch a JSON parsing error and convert it into a successful empty object.
HTML, a wrong event/order, or an incoherent outcome is an invalid acknowledgment,
even if the response status is 200. Persist unresolved delivery for review.

| Response | Meaning / action |
|---|---|
| 400 validation error | Correct invalid input; do not blind-retry. |
| 401 | Correct credentials. No ticket action occurred. |
| 404 ticket/event not found | Confirm the identity and deployment. |
| 409 `EVENT_IN_PROGRESS` | Retry the identical event after a delay. |
| 409 `EVENT_CONFLICT` | Event/call already belongs to another payload. Operator review; never generate a new event merely to bypass it. |
| 409 identity/ambiguity/workflow conflict | Correct the underlying mapping or review state. No guessing or forced close. |
| 409 `TICKET_NOT_CLOSABLE` | Review the current ticket and any existing receipt. |
| 422 missing RGC / processing prerequisite | Correct the prerequisite, then retry the same event. Binding is preserved. |
| 429 callback capacity | Back off and retry the same event. |
| 503 disabled / receipts not ready | Restore configuration or receipt storage, then retry the same event. |
| 500 or lost response | Inspect the receipt, then retry the same event. A prior ticket commit is possible. |

Read-only receipt lookup:
`GET /api/integrations/vrs-ai/v1/call-results/{eventId}` with the same `X-API-Key`.
It returns identifiers, processing state, last response/error and update time,
not the stored raw payload or credentials. It works while direct callbacks are
paused. Receipt state, not a separate signed-bridge state, is authoritative for
this direct lane.

## Notification recovery

The ticket's existing SMS history retains the original failure and any later
send. Production missing-Twilio configuration is an actual failed outcome,
never a mock success. Development mock behavior is retained.

For an administrator who has confirmed the original approval message was not
delivered:

`POST /api/admin/vrs-ai/notifications/{notificationId}/retry`

Use the normal authenticated admin/super-admin session and body
`{"confirmUndelivered":true}`. This is not an API-key callback action. It sends
only the recorded approval message to its recorded recipient, and never
processes the ticket again. The ticket must already be completed.

A separate durable retry claim prevents this record being resent twice. If the
provider/audit outcome is uncertain, the claim remains blocked for operator
review. Do not automatically retry unknown outcomes. A definite failed attempt
has a new SMS-history record that can be reviewed separately.

Inspect recovery state with
`GET /api/admin/vrs-ai/notifications/{notificationId}/retry` using the same admin
session. No recovery action was executed against a real recipient during testing.

## Deployment and compatibility

- Both integration routes, all existing agent/manual/NLA routes, and the UI remain.
- Existing tables and dependencies are unchanged. Two additive tables are
  declared in `shared/schema.ts`: `vrs_ai_direct_results` and
  `vrs_ai_notification_retries`.
- Startup creates only those tables in a bounded, best-effort background setup
  (two-second lock timeout, five-second statement timeout). It does not block
  the normal app startup. Missing receipt storage returns a clear unavailable
  callback response; it never falls back to unsafe processing.
- No production DDL, database writes or Publish were run during development.
  Table creation at the next deployment is a release consideration for Tyler.
- `VRS_AI_PRODUCTION_ENABLED` retains its existing intake/dispatch meaning.
  `VRS_AI_CALL_RESULT_ENABLED=false` can separately pause direct processing;
  omission preserves direct-route availability. No actual secret or activation
  setting was changed by the repair.
- The signed lane protects event identity and terminal ordering. Local application
  locks have a four-callback limit to preserve shared database capacity; slow
  upstream forwarding occurs after releasing the application connection.
  Forwarding has a separate durable claim, serialized per call and fenced
  against expired workers; a late failure cannot erase successful delivery.
- The signed partner's legacy empty HTTP 200 acknowledgment is retained. HTML,
  explicit error bodies and conflicting event IDs are rejected. No new required
  acknowledgment fields are imposed on that pre-existing contract.

Before publishing, run the safe regression suite and the isolated PostgreSQL
suite in the repair plan. After publishing, verify a missing-key call-result
POST returns JSON 401, an unknown API returns JSON 404, frontend navigation
still works, and the two new tables are ready. Only then run one approved,
controlled integration example and its identical retry. Git sync and frontend
asset names do not prove the deployed backend revision.
