# Direct AHS → VRS AI contract, version 1

Status: Express implementation and simulated acceptance tests. **VRS AI must implement this new contract before live activation.** This is not the Sasha API. No Sasha files, intake, ledger, callback forwarding or secrets are used. Repair-authorization requests with warranty type `american_home_shield` only; NLA, First American and Sasha-linked requests remain on their existing workflows.

## Flow and responsibility

1. Assigned VRS reviewer clicks **Approve and Send to VRS AI**, supplies review notes, and confirms.
2. Express atomically records human approval and an immutable request snapshot. Human approval is not an AHS authorization.
3. Express POSTs to AI's **`/api/direct-ahs/v1/authorize`**, using `X-API-Key` and `Idempotency-Key: <requestId>`.
4. AI obtains AHS's decision, including the actual approval or denial code. It must not fabricate a code or treat a call failure as a denial.
5. **AI owns the technician SMS. Express sends no SMS for this workflow.** AI must include the decision code and send to the supplied IH technician number.
6. AI sends signed result/status events to Express. Express records the decision, notes and SMS status. The ticket remains open while SMS is pending/failed.
7. A decision plus `sent`/`delivered` SMS with a provider message ID and code-bearing body closes the ticket: approval → `completed`; denial → `rejected_closed`. `sent` confirms dispatch to the SMS provider, not delivery to the handset.
8. Structured WOM-ready notes are persisted. **No WOM connection or write is implemented.**

## Dedicated configuration (do not reuse Sasha credentials)

Provision via workspace Secrets/configuration after the AI service is ready:

- `DIRECT_AHS_AI_ENABLED=true` — explicit outbound activation. Defaults off.
- `DIRECT_AHS_AI_BASE_URL` — clean HTTPS AI origin.
- `DIRECT_AHS_AI_API_KEY` — outbound authentication.
- `DIRECT_AHS_AI_CALLBACK_URL` — verified deployed Express origin plus `/api/integrations/direct-ahs/v1/result`.
- `DIRECT_AHS_AI_WEBHOOK_SECRET` — shared signing secret, provisioned separately to AI. Never sent in request payloads.

Turning outbound dispatch off does not disable authenticated callbacks for in-flight requests. Do not remove their signing secret.

## Outbound payload

The executable TypeScript contract is `shared/direct-ahs.ts` (`DirectAhsPayload`).

```json
{
  "version": 1,
  "source": "vrs_express_direct_ahs",
  "requestId": "00000000-0000-4000-8000-000000000001",
  "submissionId": 123,
  "serviceOrder": "12345678",
  "warranty": "american_home_shield",
  "technician": {"id": "EXAMPLE_IH", "phone": "+15555550123", "name": "Example technician"},
  "applianceType": "laundry",
  "diagnosis": "Technician diagnosis",
  "estimateAmount": "325.00",
  "partNumbers": ["EXAMPLE-PART"],
  "photoUrls": [],
  "videoUrl": null,
  "voiceNoteUrl": null,
  "review": {"reviewerId": 42, "notes": "Evidence reviewed", "approvedAt": "2026-10-13T12:00:00Z"},
  "callbackUrl": "https://EXPRESS-ORIGIN/api/integrations/direct-ahs/v1/result",
  "instructions": {"smsOwner": "vrs_ai", "includeDecisionCodeInSms": true, "womWrite": false}
}
```

No invented customer, policy, model or serial information is supplied. AI must obtain any additional AHS-required data using its supported service-order enrichment; if unavailable, report a workflow failure rather than guessing. Uploaded object-storage media is signed for 24 hours; unsupported references explicitly prevent dispatch. Signed URLs are sensitive: do not log or publish them.

AI responds HTTP **202** (new) or **200** (same request already accepted):

```json
{"requestId":"00000000-0000-4000-8000-000000000001","callId":"example-call","status":"accepted"}
```

Idempotency is mandatory and durable on the AI side: concurrent/repeated identical request IDs MUST return the original call without calling AHS or texting twice. A changed payload under the same ID must fail. Request IDs must remain deduplicated for the full lifecycle/retention of the request, not a short cache TTL. SMS sending must separately deduplicate by request ID and decision.

## Result callback

`POST /api/integrations/direct-ahs/v1/result`

- `Content-Type: application/json`
- `X-Direct-AHS-Timestamp`: Unix seconds at delivery time.
- `X-Direct-AHS-Signature`: `sha256=<hex HMAC-SHA256(secret, timestamp + "." + exact JSON bytes)>`.
- A five-minute clock window is enforced. Sign each retry with a fresh header timestamp; keep event payload unchanged.
- Maximum accepted raw callback size: 128 KB.

```json
{
  "version": 1,
  "source": "vrs_express_direct_ahs",
  "requestId": "00000000-0000-4000-8000-000000000001",
  "submissionId": 123,
  "eventId": "example-event-1",
  "sequence": 1,
  "callId": "example-call",
  "serviceOrder": "12345678",
  "technicianId": "EXAMPLE_IH",
  "occurredAt": "2026-10-13T12:05:00Z",
  "outcome": "decision",
  "decision": {"state": "approved", "code": "EXAMPLE-AUTH", "notes": "AHS authorized the repair.", "authorizedAmount": 325},
  "sms": {"status": "sent", "recipient": "+15555550123", "providerMessageId": "example-message", "body": "AHS approved your repair. Code: EXAMPLE-AUTH"}
}
```

Denial uses `decision.state="denied"` and the actual denial code. It is terminal, not a technician resubmission request.

For SMS pending/failed, keep the decision and use `sms.status="pending"` or `"failed"` with the recipient and optional `reason`; provider ID/body are not required until sent. Retry **only the SMS**, not AHS authorization. Report success as a new event ID with a higher sequence, same immutable decision and call identity. The sent SMS body must include the decision code.

If no decision was obtained, use `outcome="failed"` plus `failureReason`, omitting both `decision` and `sms`. The ticket stays open and locked for reconciliation. There is deliberately no automatic second AHS call or manual fallback that could double-authorize.

Events are strictly validated (`directAhsResultSchema`). Unique event IDs and increasing sequence numbers are per request. Duplicate identical events return success without repeating work; changed event IDs/payloads, mismatched identity, conflicting decisions and reused sequence numbers return 409. Older events are recorded but cannot roll back a newer outcome. A later `delivered` receipt can update SMS status without re-closing the ticket.

HTTP 200 acknowledges durable processing. Retry transient 503/network failures with the same event. Do not blindly retry 400/401/409; reconcile the contract, signature or identity problem first.

## Express staff endpoints

- `GET /api/submissions/:id/direct-ahs`: eligibility, configuration readiness and redacted workflow state.
- `POST /api/submissions/:id/direct-ahs`: `{ "reviewNotes": "..." }`; assigned reviewer only.
- `POST /api/submissions/:id/direct-ahs/retry`: same-request reconciliation for unacknowledged dispatches; original reviewer only.

An outbound timeout/non-acknowledgment is **unknown**, not success or failure of the AHS call. Retry reuses the original payload and idempotency key. Requests stuck sending after a process restart become retryable after 30 seconds. In-flight and completed direct tickets cannot be manually reprocessed or have their reviewed inputs reassigned/changed. A callback failure leaves the record visible for reconciliation.

## WOM preparation

`womNotes` stores version/source, request and ticket identity, service order, technician and reviewer IDs, review notes, AI call ID, decision/code/notes, SMS metadata, outcome timestamp and `womWriteStatus="not_requested"`. This is a staging format, not an assertion that WOM accepts this schema. Map it to the future WOM contract separately.

## Release acceptance

Local tests use a simulated AI transport and disposable PostgreSQL, not AHS, Twilio or live tickets. Before activation: AI implements durable request/SMS idempotency; both sides agree on denial codes and additional required data; dedicated credentials and verified callback origin are provisioned; controlled approval, denial and SMS-recovery acceptance is explicitly authorized and passes. Only then enable/publish the live workflow.
