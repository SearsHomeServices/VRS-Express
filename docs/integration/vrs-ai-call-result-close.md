# VRS AI → VRS Express: Call-Result Ticket Close

**Route:** `POST /api/integrations/vrs-ai/v1/call-result`
**Purpose:** VRS AI posts a completed-approval call result; VRS Express finds the corresponding ticket and closes it.
**Status:** Implemented, unit-tested (21/21), **not yet exercised against a live database.** Not committed, not deployed.

This document is the complete contract for building the **sender**. Everything a client needs is here; no other file is required.

---

## 1. What this route is and is not

| | This route (`/call-result`) | The signed partner webhook (`/webhook`) |
|---|---|---|
| Auth | `X-API-Key` only | HMAC-SHA256 signature + timestamp window + event-id header |
| Accepts part/tech fields | **Yes** (`partId`, `partDescription`, `techId` required) | No — rejects them as unrecognized keys |
| Accepted states | `approved` only | `approved`, `partial`, `denied`, `failed`, `requires_info` |
| Writes the `vrs_ai_call_events` ledger | **No** | Yes |
| Forwards the result upstream to SASHA | **No** | Yes |
| Closes the Express ticket | **Yes** | Yes |

> **Important:** if the result must reach SASHA, `/webhook` is still the only path that forwards it. This route closes the Express ticket and stops there. Do not treat it as a replacement for the partner callback chain.

---

## 2. Request

### Endpoint

```
POST {VRS_EXPRESS_BASE_URL}/api/integrations/vrs-ai/v1/call-result
```

Use the DEV Express base URL for DEV testing. There is no separate host for this route — it sits on the same origin as `POST /vrs/authorize` and `GET /api/integrations/vrs-ai/v1/service-orders/{so}`.

### Headers

| Header | Value | Notes |
|---|---|---|
| `X-API-Key` | `{VRS_SASHA_API_KEY}` | **The same key VRS AI already presents on inbound authorize and the service-order lookup.** No new credential. Compared timing-safely. |
| `Content-Type` | `application/json` | Required. |

No signature header. No timestamp header. Those belong to `/webhook`.

### Body schema

Validation is **strict**: any field not in this table is rejected with `400`, and the response names the offending key.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `version` | number | yes | Must be exactly `1` |
| `eventId` | string | yes | 1–100 chars. **Stable across retries of the same result** (see §4) |
| `callId` | string | yes | 1–100 chars. VRS AI's provider call id |
| `soNo` | string | yes | Exactly 8 digits, e.g. `"10866426"`. No district prefix, no hyphen |
| `occurredAt` | string | yes | ISO 8601 with `Z` or a numeric offset |
| `state` | string | yes | Must be exactly `"approved"` |
| `authNumber` | string | yes | 1–100 chars. The warranty company's external auth code |
| `authorizedAmount` | number | yes | ≥ 0, ≤ 1,000,000, **at most 2 decimal places** |
| `partId` | string | yes | 1–100 chars |
| `partDescription` | string | yes | 1–500 chars |
| `techId` | string | yes | 1–50 chars. Technician LDAP id |
| `durationSec` | number | no | Integer ≥ 0 |
| `recordingUrl` | string | no | Valid absolute URL |

### Reference request

```bash
curl -sS -X POST "$VRS_EXPRESS_BASE_URL/api/integrations/vrs-ai/v1/call-result" \
  -H "X-API-Key: $VRS_SASHA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "version": 1,
  "eventId": "8f3a5e10-58a4-4fe0-a3a1-95038a7e4ee6",
  "callId": "vrs_536",
  "soNo": "10866426",
  "occurredAt": "2026-09-08T14:01:45.289Z",
  "state": "approved",
  "authNumber": "AHS-001",
  "authorizedAmount": 380.6,
  "durationSec": 187,
  "partId": "EAD61906701",
  "techId": "BCURTI",
  "partDescription": "Dishwasher Wire Harness",
  "recordingUrl": "https://agentic-vrs-agent-dev.stage.nextgen.shs.com/recordings/536_combined.wav"
}'
```

---

## 3. Responses

### 200 — closed

The ticket moved to `completed` with `authNumber` written as its auth code. The technician was texted once.

```json
{
  "ok": true,
  "closed": true,
  "deduped": false,
  "submission_id": 4211,
  "service_order": "8175-10866426",
  "ticket_status": "completed",
  "auth_number": "AHS-001",
  "call_id": "vrs_536",
  "event_id": "8f3a5e10-58a4-4fe0-a3a1-95038a7e4ee6"
}
```

### 200 — already closed (idempotent replay)

The ticket was already `completed` with this same `authNumber`. Nothing was re-approved and **no second SMS was sent**. Treat exactly like success.

```json
{
  "ok": true,
  "closed": false,
  "deduped": true,
  "submission_id": 4211,
  "service_order": "8175-10866426",
  "ticket_status": "completed",
  "auth_number": "AHS-001",
  "call_id": "vrs_536",
  "event_id": "8f3a5e10-58a4-4fe0-a3a1-95038a7e4ee6"
}
```

### Error responses

| HTTP | `error` | Meaning | Sender action |
|---|---|---|---|
| `400` | `VALIDATION_ERROR` | Payload failed strict validation. `fields` names the offending keys | **Do not retry.** Fix the payload |
| `401` | `UNAUTHORIZED` | Missing or wrong `X-API-Key` | **Do not retry.** Fix the credential |
| `404` | `TICKET_NOT_FOUND` | No Express ticket matches this service order | **Do not retry blindly.** Confirm the ticket exists for that SO |
| `409` | `TICKET_NOT_CLOSABLE` | Ticket found but not in `pending` state. `ticket_status` carries the real status | **Do not blind-retry.** See §5 |
| `409` / `422` | `TICKET_CLOSE_FAILED` | Ticket resolution succeeded but the close was refused. `message` carries the reason verbatim | Retry with backoff; see §5 — some causes are operator-fixable |
| `500` | `INTERNAL` | Lookup or close threw unexpectedly | Retry with backoff |
| `503` | `NOT_CONFIGURED` | `VRS_SASHA_API_KEY` is not set on the Express side | **Do not retry.** Operator must configure |

Error body shape:

```json
{
  "error": "TICKET_NOT_CLOSABLE",
  "message": "Ticket 4211 for service order 8175-10866426 is \"queued\", not \"pending\", so it cannot be closed by this call result.",
  "submission_id": 4211,
  "ticket_status": "queued",
  "call_id": "vrs_536",
  "event_id": "8f3a5e10-58a4-4fe0-a3a1-95038a7e4ee6"
}
```

`400` responses instead carry `fields`:

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Unrecognized key(s) in object: 'contract_version'",
  "fields": ["contract_version"]
}
```

---

## 4. Retry and idempotency rules for the sender

1. **Reuse the identical `eventId` and body on every retry of the same result.** Dedupe is keyed on the ticket already being `completed` with the same `authNumber`; changing the payload between attempts defeats it.
2. **`200` is terminal** — whether `closed: true` or `deduped: true`. Stop.
3. **Retry only `500` and `503`-after-config, plus `TICKET_CLOSE_FAILED`.** Exponential backoff, e.g. 1s → 2s → 4s → 8s, max 5 attempts, then surface to a human.
4. **Never retry `400`, `401`, or `503`** — they need a payload or configuration fix, and retrying just burns attempts.
5. This route has **no event ledger**, so its dedupe is weaker than `/webhook`'s. It reliably absorbs a repeat of the *same* approval; it does not order two *different* approvals for one ticket. Send one terminal approval per ticket.

---

## 5. Express-side preconditions (why a well-formed request can still fail)

A `409` or `422` usually means the Express ticket wasn't ready, not that the payload was wrong. For a close to succeed:

- **A ticket must exist for the service order.** Resolution tries the bridge row for `callId` first, then matches the bare 8-digit `soNo` against the dashed `service_order` suffix (`%-10866426`). Tickets submitted from the PWA with no bridge row are still found.
- **The ticket must be `pending`** — i.e. claimed by an agent and under review. A `queued` (unclaimed) ticket returns `409` with `ticket_status: "queued"`.
- **The ticket must have an assigned agent** to attribute the close to. Without one: `409`, `"has no assigned agent to attribute the close to"`.
- **A daily RGC code must be set for the current Eastern-time day.** This is existing VRS policy inherited from the agent approval path. With no code set, every close fails with `422` and `message` = `"No RGC code has been set for today. Please contact an administrator."` An admin sets it in the dashboard; then retry.
- **AHS / First American tickets require the external auth code** — that's what `authNumber` supplies, so this is satisfied automatically.

When multiple tickets match one service order, selection is: bridge-linked ticket wins → `techId` narrows the matches when it matches at least one (case-insensitive) → prefer `pending` → newest.

---

## 6. Reference sender

```ts
type CallResult = {
  version: 1;
  eventId: string;
  callId: string;
  soNo: string;            // 8 digits
  occurredAt: string;      // ISO 8601
  state: "approved";
  authNumber: string;
  authorizedAmount: number; // max 2 decimals
  partId: string;
  partDescription: string;
  techId: string;
  durationSec?: number;
  recordingUrl?: string;
};

const NO_RETRY = new Set([400, 401, 404, 503]);

export async function sendCallResult(
  result: CallResult,
  opts: { baseUrl: string; apiKey: string; maxAttempts?: number },
): Promise<{ ok: true; closed: boolean; body: any } | { ok: false; status: number; body: any }> {
  const endpoint = new URL(
    "/api/integrations/vrs-ai/v1/call-result",
    opts.baseUrl,
  );
  const maxAttempts = opts.maxAttempts ?? 5;
  // Serialize ONCE so every retry sends byte-identical content.
  const rawBody = JSON.stringify(result);

  let last: { status: number; body: any } = { status: 0, body: null };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": opts.apiKey,
        },
        body: rawBody,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      last = { status: 0, body: { message: String(error) } };
      if (attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      continue;
    }

    const body = await response.json().catch(() => ({}));

    // 200 is terminal for both closed:true and deduped:true.
    if (response.status === 200) {
      return { ok: true, closed: Boolean(body.closed), body };
    }

    last = { status: response.status, body };

    // Payload/credential/config problems will never fix themselves.
    if (NO_RETRY.has(response.status)) break;

    // 409 TICKET_NOT_CLOSABLE means the ticket isn't pending — a human needs
    // to look. Only TICKET_CLOSE_FAILED and 5xx are worth another attempt.
    if (response.status === 409 && body?.error === "TICKET_NOT_CLOSABLE") break;

    if (attempt === maxAttempts) break;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
  }

  return { ok: false, status: last.status, body: last.body };
}
```

---

## 7. Side effects of a successful close

So the sender knows what it triggered:

- Ticket `ticket_status` → `completed`; both review stages marked approved; `auth_code` = `authNumber`; `rgc_code` = the day's RGC code.
- **One SMS to the technician** with the auth code. Not re-sent on a deduped replay.
- An agent-notes audit line carrying the fields that have no column of their own, e.g.:
  `VRS AI approved $380.60 (auth AHS-001, event 8f3a5e10-…, call vrs_536). Part EAD61906701 — Dishwasher Wire Harness. Tech BCURTI. Call duration 187s. Recording: https://…/536_combined.wav`
- WebSocket `ticket_updated` to the assigned agent and to admins.
- Nothing is sent to SASHA. No `vrs_ai_call_events` row is written.
