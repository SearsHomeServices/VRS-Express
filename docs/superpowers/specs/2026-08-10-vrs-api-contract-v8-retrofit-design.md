# VRS API Contract V8 Retrofit Design

**Status:** Approved for implementation on 2026-08-10

**Authoritative input:** `vrs-api-contract-v8.md` received 2026-08-10

**Supersedes:** The V5 wire-contract assumptions in the existing bridge

## Decision

V8 is the contract VRS Express should have implemented originally. It is not a
parallel feature, optional extension, or separate endpoint. The existing V5
bridge will be retrofitted in place so `POST /vrs/authorize` accepts and
forwards the V8 request shape while preserving the established VRS Express
human-review workflow.

The V8 document is authoritative for wire fields, placeholder behavior,
responses, callback events, idempotency, and retry semantics. The existing
VRS Express architecture remains authoritative for system topology:

```text
SASHA / Tech Hub
    -> POST /vrs/authorize
VRS Express
    -> normal pending authorization ticket
    -> human Stage 1 approval
    -> POST /vrs/authorize
VRS AI
    -> signed result webhook
VRS Express
    -> existing ticket/SMS effects
    -> signed callback using the original Express call ID
SASHA / Tech Hub
```

The contract's direct SASHA-to-VRS diagram is therefore implemented as two
wire-compatible hops around the required VRS Express approval boundary. VRS
Express changes only callback ownership and credentials for the VRS AI hop;
it does not reinterpret or discard V8 business fields.

## Goals

- Make the existing endpoint conform to the complete V8 request contract.
- Preserve every V8 business field in durable bridge storage and forward it
  to VRS AI after Stage 1 approval.
- Make the V8 context visible to the reviewing VRS Express agent.
- Implement the contract's new-request behavior after a retryable terminal
  failure without creating a duplicate Express ticket.
- Keep callbacks, HMAC validation, idempotency, and normal ticket/SMS effects
  compatible with the established bridge.
- Replace V5-oriented handoff material with a single V8 implementation package
  that names only VRS Express and VRS AI.
- Avoid changes to manual technician submissions, First American, NLA,
  infestation, replacement-review, and unrelated authorization workflows.

## Non-goals

- VRS Express will not fetch SIS, Tina, HomeSpy, or Tech Assist enrichment.
  V8 assigns that work to the SASHA BFF.
- VRS Express will not generate missing wire values. It validates the V8
  placeholders supplied by SASHA and preserves them.
- VRS Express will not add Phase 2 `dialing`, `connected`, or
  `awaiting_decision` callbacks.
- No production database command, deployment, secret rotation, or publication
  is part of implementation verification.
- No separate `/v8` route or V5/V8 mode switch will be introduced.

## Production Non-Regression Contract

Publishing V8 must not change the behavior of the currently functioning VRS
Express application outside bridge-backed authorization tickets. This is a
hard acceptance gate, not a best-effort goal.

### Production-source baseline

The Replit workspace is the publish source. Before implementation, its clean
`main` at `972409d` was fetched read-only and made the parent of this design;
the desktop copy is not being treated as authoritative over newer Replit work.
The pre-change baseline captured on 2026-08-10 is:

- published root: HTTP `200`, title `VRS Express`;
- published `/api/healthz`: `ok: true`, including a successful database check;
- focused bridge suite: 32 of 32 passing;
- production build: passing;
- all locally runnable Vitest tests: 45 passing; the 17 server-backed intake
  tests skip/fail at setup because this desktop has no app on port 5000 and no
  PostgreSQL on port 5432, which is the recorded pre-change environment
  baseline rather than a V8 regression; and
- TypeScript baseline: 56 raw diagnostics / 26 normalized unique diagnostics.

Post-change verification must equal or improve these results. Any new test,
build, runtime, or TypeScript failure blocks publication.

### Isolation rules

- V8 parsing, storage, dispatch, and retry logic execute only for
  `POST /vrs/authorize` or a submission with a durable VRS bridge row.
- A manual/PWA submission with no bridge row must never call VRS AI and must
  continue through the existing Stage 1 and Stage 2 behavior.
- New agent-dashboard content renders only when `selectedSubmission.vrsAi`
  exists. Standard authorization, First American, NLA, infestation,
  replacement-review, admin, technician, upload, WebSocket, and SMS views keep
  their current branches.
- Missing bridge variables continue to fail only the bridge route/action with
  the existing `503`; they must not prevent application startup or affect
  normal submissions.
- Retry rearming requires a bridge row whose current terminal state is exactly
  `failed` with `retryable: true`. It cannot reset or requeue a manual ticket.
- No `shared/schema.ts`, startup migration, seed behavior, or production
  database change is permitted for this retrofit.
- Shared files such as `server/routes.ts` and the agent dashboard require a
  focused diff review proving every new branch is guarded by bridge state.

### Publish gates

The change is not publish-ready until all of the following are recorded:

1. The final branch still contains every production-source commit through
   `972409d`, with no dropped or overwritten Replit work.
2. Existing 32 bridge tests plus the new V8 tests pass.
3. The production build passes and TypeScript reports no diagnostics beyond
   the recorded 56 raw / 26 normalized baseline.
4. The full local test run has no regression from its recorded baseline.
5. In a non-production environment, the existing technician login/submission,
   agent claim, manual authorization, two-stage AHS, NLA, admin dashboard,
   media, WebSocket, and SMS paths pass smoke checks.
6. The V8 flow passes intake, Stage 1 review, VRS AI dispatch, signed result,
   SASHA forwarding, and retryable-failure retry end to end.
7. A rollback target and the exact pre-publish Replit commit are recorded.
8. Source sync, configuration, and publication each receive explicit approval.

If staging cannot exercise the existing workflows and the V8 flow, the result
must be reported as not publish-ready rather than inferred safe from unit tests.

## V8 Authorize Schema

The runtime schema remains strict: fields not defined by V8, including
`cta_no`, are rejected. All keys described as always present by V8 become
required at the Express boundary.

### Added fields

| Field | Accepted value |
|---|---|
| `appliance_color` | Non-empty string up to 40 characters, including `"N/A"` |
| `contract_number` | Non-empty bounded string, including `"N/A"` |
| `purchase_year` | Positive integer year, `"TBD"`, or `"N/A"`; never `0` |
| `symptom` | Non-empty bounded string, including `"N/A"` |

### V8 always-present changes

| Field | V8 behavior |
|---|---|
| `tech_phone` | E.164 or exactly `"N/A"` |
| `appliance_grade` | `entry`, `mid`, `top`, or `"N/A"` |
| `partner_id` | Non-empty string or `"N/A"`; no longer optional |
| `appliance_photos` | Required array, zero to ten URLs |
| `comments` | Required array, zero to twenty structured comments |

### Gap-fill compatibility

V8 deliberately sends placeholders instead of blocking upstream. Express must
accept the documented fallback values:

- Empty strings where V8 permits them, including `tech_name`,
  `customer_name`, `part_function`, and `repair_replace_rationale`.
- Zero for documented numeric gap-fill fields, including labor, tax,
  appliance age, part price, and `parts[].sell_price`.
- `other` / `repair` for missing location, failure, or recommendation input.
- `N/A`, `TBD`, and empty arrays only in the fields defined by V8.

Validation must not trim or otherwise mutate the accepted payload. The exact
business payload, minus the cleartext callback secret, is stored and later
forwarded.

## Intake and Internal Ticket Mapping

1. Authenticate with the existing timing-safe `X-API-Key` check.
2. Validate the complete V8 body.
3. Continue exact SASHA callback URL allowlisting.
4. Treat `partner_id` as V8 business context, not the old routing enum.
   Phase 1 accepts the verified AHS labels `ahs`, `american_home_shield`,
   `American Home Shield`, `Sears Home Warranty`, and the contract-approved
   `N/A` placeholder. Explicit non-AHS partner values remain rejected so an
   unsupported workflow cannot be silently processed as AHS.
5. Resolve `tech_id` against the existing technician directory and district.
6. Create the normal VRS Express authorization ticket through the shared
   submission handler.
7. Store all V8 fields in `request_payload`; continue encrypting the original
   SASHA callback secret separately with AES-256-GCM.
8. Return `202` with an Express-owned call ID. An active call for the same
   service order returns the existing `409` response.

The internal ticket mapper may derive safe display/operational fallbacks but
must not alter the stored or forwarded V8 payload:

- Use the directory technician phone for Express SMS when the wire phone is
  `N/A`; never send SMS to the literal placeholder.
- If both sources lack a usable phone, retain the ticket and skip invalid SMS
  attempts with an explicit diagnostic log.
- Build the required Express issue description from the first available value
  among rationale, symptom, failure cause, and a neutral authorization label.
- Keep raw V8 photo URLs in bridge context rather than rewriting them as
  VRS Express object-storage paths.

## Stage 1 Review

Bridge-backed tickets continue to require a human **Approve & Send to VRS AI**
action. Manual/PWA tickets continue through their existing action path.

The bridge detail panel will expose the complete decision-relevant V8 context:

- partner and contract number;
- symptom and repair/replace rationale;
- purchase year, derived appliance age, grade, color, brand, type, model, and
  serial;
- technician identity and usable/missing phone state;
- labor, tax, total part price, per-part price/function;
- structured comments; and
- up to ten appliance photo links/previews.

Placeholder values remain visible as `N/A` or `TBD` so reviewers can
distinguish unavailable information from an omitted UI element.

## VRS AI Dispatch and Callback

After Stage 1 approval, Express sends the stored V8 body to the configured VRS
AI `POST /vrs/authorize` endpoint. It replaces only:

- `callback_url` with the VRS Express result receiver; and
- `callback_secret` with the Express-to-VRS-AI HMAC secret.

The provider call ID remains separate from the public Express call ID. VRS AI
callbacks continue to be verified against the exact raw body and five-minute
timestamp window. When forwarding the event to SASHA, Express restores the
public Express call ID and signs the exact forwarded bytes with the original
SASHA callback secret.

The V8 event shapes are unchanged from the implemented callback union:
`approved`, `partial`, `denied`, `failed`, and `requires_info`. Existing
terminal ticket/SMS effects and event-level idempotency remain shared with the
normal submission process handler.

## Retryable Terminal Failure

V8 defines `failed` as terminal and permits the user to submit a new authorize
request when `retryable: true`. Express will implement that behavior on the
same endpoint:

1. A normal active attempt still returns `409`.
2. A new request for a service order whose latest bridge result is terminal
   `failed` with `retryable: true` rearms the existing Express ticket.
3. Rearming runs under the existing service-order advisory lock.
4. Before reset, an internal event-ledger snapshot records the prior Express
   call ID, provider call ID, terminal result, and retry transition.
5. The bridge row receives a new Express call ID, new V8 payload, new encrypted
   SASHA callback secret, cleared provider/result/delivery fields, and
   `pending_review` state.
6. The same Express ticket is requeued for another human Stage 1 review. This
   avoids duplicate tickets while preserving the prior attempt in the ledger.
7. The endpoint returns a fresh `202` response and call ID, matching V8.
8. Late callbacks for the superseded provider call ID are recognized from the
   event ledger, acknowledged with `200`, and ignored as post-terminal events.

A terminal non-retryable failure, approval, partial approval, or denial is not
rearmed automatically. A pre-acceptance Express-to-AI dispatch failure remains
retryable from the existing Stage 1 action because no provider call exists.

This design uses the existing bridge and event tables; it requires no database
schema change.

## Error Semantics

- `400`: V8 body validation failure.
- `401`: missing or invalid SASHA API key.
- `409`: an active call already exists, or the service order cannot be safely
  rearmed.
- `422`: technician/district resolution failure or explicit unsupported
  partner.
- `503`: bridge configuration is incomplete.
- `202`: a new pending-review attempt was durably accepted; it does not claim
  that VRS AI has dialed AHS.

No response includes callback secrets, encryption material, API keys, or the
VRS AI provider call ID.

## Documentation Deliverables

The V8 implementation will update:

- runtime schemas and TypeScript types;
- the architecture document, renamed/reframed as V8;
- the human-readable VRS Express/VRS AI handoff;
- the OpenAPI 3.1 contract and all examples;
- the editable DOCX and matching PDF; and
- the single drag-and-drop handoff package.

The external package will identify only VRS Express and VRS AI. It will not
contain personal names, internal meeting history, repository history, live
credentials, or obsolete V5 implementation instructions.

## Test Strategy

Implementation follows red-green-refactor. Tests will first prove the existing
code fails V8 requirements, then drive each change.

### Contract tests

- Accept the complete V8 example.
- Accept every documented placeholder and zero/empty gap-fill combination.
- Require all always-present V8 keys.
- Reject `purchase_year: 0`, invalid placeholder placement, excess arrays,
  invalid URLs, invalid callback destinations, and unknown keys such as
  `cta_no`.
- Prove `appliance_color`, `contract_number`, `purchase_year`, and `symptom`
  survive parse, storage projection, review projection, and outbound dispatch.

### Workflow tests

- Accept verified AHS labels and `partner_id: "N/A"`; reject explicit
  unsupported partners.
- Use directory phone operationally while preserving wire `tech_phone: "N/A"`.
- Preserve the manual/PWA Stage 1 behavior.
- Require Stage 1 approval before VRS AI dispatch.
- Preserve callback ID replacement, signature verification, event
  idempotency, and result application.
- Rearm only retryable terminal failures, issue a new Express call ID, preserve
  audit history, requeue the same ticket, and ignore old late callbacks.

### UI and documentation tests

- Assert the V8 review fields and photo context appear in the agent dashboard.
- Parse the OpenAPI document and resolve every local reference.
- Validate authorize and callback examples against runtime schemas.
- Recalculate and verify the deterministic HMAC example.
- Scan generated handoff files and metadata for personal names, obsolete V5
  claims, secrets, and mismatched version labels.
- Render and visually inspect every final PDF/DOCX page.

### Regression verification

- Run the focused bridge suite.
- Run the production build.
- Compare TypeScript diagnostics with a fresh `main` baseline when the
  repository-wide check is not clean.
- Confirm the worktree contains no unrelated edits and the user-owned
  `graphify-out/` and `output/audio/` paths remain untouched.

## Rollout Boundary

Implementation and local verification do not activate production. After code
review, the approved rollout sequence is:

1. Commit the verified source and handoff artifacts on top of the captured
   Replit production-source baseline.
2. Push only with explicit approval.
3. Sync the VRS Express Replit checkout without overwriting newer box work.
4. Apply any required schema/configuration only through the approved
   development-first pipeline. This design adds no schema change.
5. Configure staging secrets outside Git.
6. Run a joint V8 transaction through intake, Stage 1, VRS AI, callback, and
   SASHA receipt, including one retryable-failure test.
7. Publish or activate production only after explicit approval and captured
   staging evidence.
