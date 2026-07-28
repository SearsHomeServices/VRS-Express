# VRS ↔ SASHA API Contract V5

Implementation boundary for the July 2026 SASHA contract supplied by Tyler on
2026-07-28. This surface is separate from `/api/external/v1/*`, which manages
human VRS tickets. SASHA's endpoint queues AI-assisted AHS authorization calls.

## Current implementation status

### Implemented

- `POST /vrs/authorize`
- Dedicated static `X-API-Key` using `VRS_SASHA_API_KEY`
- Strict V5 request validation, including the V5 names
  `appliance_grade`, `appliance_photos`, `parts[].sell_price`,
  `parts[].part_function`, and `repair_replace_rationale`
- Callback URL allowlist restricted to the exact confirmed production and
  staging SASHA HTTPS webhook URLs
- Contract responses: `202`, `400`, `401`, `409`, and `429`
- Durable PostgreSQL queue in `vrs_ai_calls`
- Atomic admission lock covering duplicate SO detection, 10 calls/hour per
  technician, and 100 concurrent active calls
- AES-256-GCM encryption of each request's `callback_secret`; cleartext is not
  stored in the JSON payload or database columns
- HMAC-SHA256 webhook signing and the documented retry policy (network errors
  or `500`/`502`/`503`, maximum five attempts, stable event ID)
- Unit/integration contract coverage in `tests/vrs-sasha-*.test.ts`

### Not implemented yet

The existing VRS app has no Twilio voice/AI authorization-call runner. This
change creates the safe API and durable queue boundary but does not pretend a
queued row has dialed AHS.

The follow-on worker still must:

1. Claim `queued` rows and drive `dialing`/`connected`/terminal states.
2. Fetch `cta_no` from Snowflake
   `IH_SERVICEORDER_FULLDETAIL_TBL`.
3. Derive `partner_id` and `appliance_grade` when absent, expand
   `failure_cause`, chronologically join `comments[]`, and build the AI prompt,
   including the still-open V5 decision for how
   `repair_replace_rationale` is injected.
4. Place the AHS call, store the recording, and expose the protected recording
   URL.
5. Persist webhook delivery attempts and invoke `deliverVrsWebhook()` for
   terminal and `requires_info` events.

The contract's `vrs.prod.nextgen.shs.com` and
`vrs-dev.stage.nextgen.shs.com` hostnames also require enterprise DNS/proxy
routing outside this repository.

## Request admission

`server/vrs-sasha-contract.ts` is the wire-contract source. Requests must use
the confirmed SASHA callback URL exactly:

- Production:
  `https://sasha.prod.nextgen.shs.com/sasha/api/vrs/webhook`
- Staging:
  `https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook`

No alternate host, port, credentials, query string, or fragment is accepted.
This prevents the caller-controlled callback from becoming an SSRF path.

`server/vrs-sasha-queue.ts` owns admission behavior. The database adapter in
`server/vrs-sasha-store.ts` takes a transaction-scoped PostgreSQL advisory
lock before checking:

- one active call per `service_order`
- ten requests per `tech_id` in a rolling hour
- 100 active calls globally

Active states are `queued`, `dialing`, `connected`,
`awaiting_decision`, `requires_info`, and `in_progress`.

## Database rollout

`vrs_ai_calls` is a new table only; no existing columns are changed or removed.
Per production safety rules, do not run `db:push` against production.

Required rollout sequence:

1. Apply `npm run db:push` to the VRS development database.
2. Set `VRS_SASHA_API_KEY` through the environment's secret manager.
3. Confirm `SESSION_SECRET` remains set; it is the encryption root for callback
   secrets.
4. Run the contract tests and a staging `POST /vrs/authorize`.
5. Promote through the normal Replit deployment pipeline.

Until the schema is applied and the AI-call worker exists, this feature is not
production-ready.

## Validation

```powershell
npm run test:vrs-sasha
npm run check
npm run build
```

The repository has pre-existing TypeScript errors; compare `npm run check`
against the current `main` baseline and require zero new errors in the VRS
SASHA files.
