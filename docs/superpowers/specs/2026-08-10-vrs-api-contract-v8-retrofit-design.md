# VRS Express V5/V8 Bridge and Development Test Design

**Status:** Corrected after the 2026-08-11 integration meeting; approved for test-first implementation

**Contract inputs:** SASHA Contract V8 received 2026-08-10 and the already-implemented V5 bridge contract

**Operational source:** “VRS Express and VRS AI integration testing” meeting, 2026-08-11

## Decision

V5 and V8 must coexist. V8 does not replace the functioning V5 path:

- V5 remains the accepted Tech Hub-compatible contract.
- V8 is the complete SASHA contract, carrying forward V5 plus the V6, V7,
  and V8 additions.
- Both use the existing authenticated `POST /vrs/authorize` route.
- VRS Express records which strict schema accepted each request and forwards
  that same contract version to VRS AI after human approval.
- No database schema change is required. The two payload shapes are
  distinguishable from the durable JSON request payload because every V8-only
  field is required in V8 and forbidden by V5's strict schema.

The integration is a bridge, not a direct SASHA-to-AI call:

```text
Normal production ownership

SASHA or Tech Hub
    -> POST /vrs/authorize on VRS Express
VRS Express
    -> normal pending authorization ticket
    -> human Stage 1 review and approval
    -> POST /vrs/authorize on VRS AI
VRS AI
    -> AHS test/phone workflow
    -> signed result webhook to VRS Express
VRS Express
    -> existing result, SMS, and signed upstream callback behavior
```

For the development integration test, VRS AI first acts as a SASHA simulator
and later as the real VRS AI receiver. Those are two roles in one test, not a
request loop:

```text
VRS AI SASHA simulator
    -> V8 dummy request to VRS Express DEV
VRS Express DEV + development database
    -> pending ticket and human approval
    -> same V8 payload, with permitted enrichment, to VRS AI DEV
VRS AI DEV
    -> verifies receipt and continues its AHS test workflow
```

Production stays on its current URL, database, secrets, and published build
until the development evidence is complete and publication is separately
approved.

## Goals

- Preserve every request currently accepted by the V5 bridge.
- Accept the complete strict V8 request, including documented gap values.
- Preserve the incoming version and every valid business field through
  intake, review, storage, and outbound dispatch.
- Let VRS Express fill an existing placeholder only when it has an
  authoritative value for that exact field.
- Expose the complete V8 decision context, including TINA/signed photo URLs,
  to the human reviewer.
- Support V8's source-required immediate new-request behavior after a locally
  applied retryable terminal failure through a fresh Express ticket and bridge,
  without relaxing ordinary V5 or nonretryable V8 ticket policy.
- Prove the integration in the development runtime and database before any
  production publication.
- Keep platform-facing handoff material limited to VRS Express and VRS AI.

## Non-goals

- Do not remove, loosen, or reinterpret V5.
- Do not add `/v5`, `/v8`, or environment-specific route aliases.
- Do not make VRS Express fetch SIS, TINA, HomeSpy, or Tech Assist data that the
  sender owns.
- Do not invent business values, translate one field into an unrelated field,
  add `cta_no`, or add any other outbound key.
- Do not turn an internal `/objects/` path into a purported TINA URL.
- Do not change callback event schemas or add Phase 2 call-state events.
- Do not change manual technician, First American, NLA, infestation,
  replacement-review, admin, upload, WebSocket, or SMS behavior.
- Do not run a production database command, change a production secret, or
  publish production as part of implementation.

## Versioned Authorize Boundary

Authentication is evaluated before request validation with the existing
timing-safe `X-API-Key` comparison. An unauthenticated sender must not learn
which contract version or fields are valid.

After authentication, contract intent is selected from the body and then only
that strict schema is used:

1. If any V8-only key is present (`appliance_color`, `contract_number`,
   `purchase_year`, or `symptom`), validate the complete strict V8 schema.
2. Otherwise validate the unchanged strict V5 schema.
3. Return the existing bounded `400 VALIDATION_ERROR` when the selected schema
   does not match.

This prevents a partial V8 request containing one or more new keys from
falling through to V5. The contracts do not define a version header or body
discriminator, so a body omitting every V8-only key is, by definition,
indistinguishable from V5 and is handled as V5. The version is an internal
projection only; the existing `202`, `409`, `422`, and error response bodies
remain unchanged.

### V5 preservation

The committed V5 schema and fixtures are a compatibility contract. Existing
valid V5 payloads, optional V5 fields, partner handling, storage, dashboard
projection, dispatch shape, callbacks, and errors must retain their current
observable behavior.

### V8 schema

V8 carries forward the V5 keys and adds these required fields:

| Field | Accepted value |
|---|---|
| `appliance_color` | Non-empty string up to 40 characters, including `"N/A"` |
| `contract_number` | Non-empty bounded string, including `"N/A"` |
| `purchase_year` | Positive integer year, `"TBD"`, or `"N/A"`; never `0` |
| `symptom` | Non-empty bounded string, including `"N/A"`; never `""` |

V8 also changes these carried-forward keys:

| Field | V8 behavior |
|---|---|
| `tech_phone` | E.164 or exactly `"N/A"` |
| `appliance_grade` | Required: `entry`, `mid`, `top`, or `"N/A"` |
| `partner_id` | Required non-empty string, including `"N/A"` |
| `appliance_photos` | Required array of zero to ten valid URLs |
| `comments` | Required array of zero to twenty structured comments |

V8 intentionally permits documented gap fills:

- `""` for fields such as `tech_name`, `customer_name`,
  `parts[].part_function`, and `repair_replace_rationale`;
- `0` for labor, tax, part price, appliance age, and
  `parts[].sell_price` where documented;
- `other` / `repair` for missing location, failure, or recommendation;
- `N/A`, `TBD`, and empty arrays only in the fields that define them.

Unknown keys remain rejected. In particular, `cta_no` is never a wire key.
Parsing must not trim or otherwise mutate an accepted business payload.

## Intake and Ticket Creation

Both versions continue through the existing intake transaction:

1. Authenticate and parse the versioned payload.
2. Enforce the exact upstream callback allowlist.
3. Limit this phone-automation lane to AHS-compatible labels. The V8
   placeholder `N/A` is accepted like V5's absent optional partner because V8
   requires that placeholder when upstream identity is unavailable; the
   dedicated route/API key remains the AHS integration boundary. Explicit
   non-AHS partner names are rejected with `422`.
4. Resolve `tech_id` against the existing technician directory and district.
5. Create the normal pending Express authorization ticket through the shared
   submission handler.
6. Store the full sanitized request JSON and separately encrypt the original
   callback secret.
7. Return the existing Express-owned call ID with `202 queued`.

`202` means the Express review ticket exists. It does not claim that VRS AI
has accepted the request or called AHS.

Operational ticket fallbacks never rewrite the durable wire payload. If V8
sends `tech_phone: "N/A"`, Express may use the directory phone for its own SMS
workflow but must preserve `"N/A"` until the controlled outbound enrichment
step. A missing usable phone must not cause an SMS attempt to the literal
placeholder.

## Controlled Outbound Enrichment

Immediately before VRS AI dispatch, Express may replace a placeholder only
when all of these are true:

1. The key already exists in the received contract version.
2. The current value is a placeholder allowed for that field (`""`, `"N/A"`,
   `"TBD"`, `0`, or an empty array as applicable).
3. Express holds an authoritative value for that same semantic field.
4. The replacement itself satisfies the received version's schema.

The first implementation is deliberately narrow:

- fill `tech_phone` from the resolved Express technician/ticket phone when V8
  carries `"N/A"` and the Express value is valid E.164;
- fill `tech_name` from the resolved technician identity when V8 carries an
  empty value;
- retain sender-provided `appliance_photos` exactly, including TINA or signed
  media URLs; and
- use additional Express photo URLs only if they are already absolute HTTPS
  URLs that VRS AI can retrieve without Express session authentication.

No non-placeholder is overwritten. No key is appended. V5 dispatch remains
unchanged except for the callback URL/secret replacement it already performs.
The completed outbound payload is validated again against its original schema
before network dispatch.

## Stage 1 Review

Only a submission with a durable bridge row shows **Approve & Send to VRS AI**.
A manual/PWA ticket without that row uses the existing action path and cannot
call VRS AI.

For V8, the bridge panel shows:

- contract version, partner, and contract number;
- symptom and repair/replace rationale;
- purchase year, appliance age, grade, color, brand, type, model, and serial;
- technician identity and phone availability;
- labor, tax, total part price, and each part's price/function;
- structured comments; and
- up to ten sender-provided appliance photo links/previews.

`N/A` and `TBD` stay visible so a reviewer can distinguish missing source data
from a UI omission. Rendering remains guarded by `selectedSubmission.vrsAi`.

## Dispatch and Callback

After human approval, Express sends the stored payload to the configured VRS
AI development or production base URL. It changes only:

- permitted placeholder values described above;
- `callback_url` to the VRS Express result receiver; and
- `callback_secret` to the Express-to-VRS-AI HMAC secret.

The provider call ID remains separate from the public Express call ID. The
existing signed callback receiver, timestamp window, event-ID idempotency,
ticket/SMS effects, and signed upstream forwarding stay unchanged. Express
restores its public call ID when forwarding the final event upstream.

The implemented event union remains `approved`, `partial`, `denied`, `failed`,
and `requires_info` for both request versions.

The V8 contract's ten-per-tech/hour and 100-concurrent admission limits remain
owned by VRS AI, which owns the call queue and execution capacity. Express
continues its active-service-order duplicate guard. A VRS AI `429` received
after Stage 1 is recorded as a dispatch failure and surfaced to the reviewer;
Express's earlier `202` never represents VRS AI rate-limit admission.

## Terminal Repeat Behavior

The baseline duplicate rule is active-only for both request versions. V5 and
nonretryable V8 terminal repeats remain subject to ordinary ticket/SO policy.

The narrow V8 exception is a strict V8 request whose latest same-service-order
bridge is a retryable `failed` V8 call with its terminal failed callback
locally applied. VRS Express creates a new normal ticket, new bridge row, and
new public call ID immediately. It excludes only prior retryable-failed V8
bridge tickets from legacy same-day duplicate checks; every other ticket
constraint remains in force. The prior ticket, bridge, and event rows are not
reset or reused. Upstream forwarding remains independent: a callback-forward
retry can continue through its own durable ledger without delaying or altering
the new request.

Only active bridge states return `409 DUPLICATE_CALL`. This adds no schema or
startup migration.

## Production Non-Regression Contract

The captured publish-source baseline is Replit commit `972409d`:

- published root HTTP 200 and `/api/healthz` healthy with DB check;
- 32/32 focused bridge tests passing;
- production build passing;
- 45 locally runnable Vitest tests passing, with 17 server/database-backed
  tests unavailable on the desktop baseline; and
- 56 raw / 26 normalized pre-existing TypeScript diagnostics.

Post-change results must equal or improve that baseline. Publication is
blocked by any of the following:

- a new schema, seed, startup migration, or production DB operation;
- any new behavior outside the authenticated bridge route or a durable bridge
  row;
- a V5 regression;
- a manual/PWA ticket reaching VRS AI;
- a build, focused-test, full-test, or normalized type-diagnostic regression;
- missing development evidence for the current manual workflows and the new
  V8 flow; or
- missing explicit approval for source sync, configuration, or publication.

The development and production runtimes may share one Replit project/source,
but they must use their separate database bindings and environment-specific
credentials. Test documentation must use a supplied development base URL, not
the published production URL.

## Documentation Deliverables

Update the platform-only handoff so it gives VRS AI exactly:

- the VRS Express development `POST /vrs/authorize` URL placeholder;
- the request API-key header requirement;
- complete V5 and V8 request examples and strict field rules;
- the Stage 1/human-approval behavior and `202` meaning;
- the VRS AI development `/vrs/authorize` destination that Express must be
  configured to call;
- callback/HMAC rules and examples;
- photo behavior: sender-provided TINA/signed URLs are passed through and need
  no Replit access; authenticated Express object paths are not silently
  exposed; and
- a development acceptance checklist covering both directions.

The final external files name only VRS Express and VRS AI. They contain no
individual names, internal meeting or repository history, or live credentials.

## Test Strategy

Implementation follows red-green-refactor.

### Contract and API

- Existing V5 fixtures remain green and retain their outbound key set.
- A complete V8 example and every documented V8 gap fill are accepted.
- The presence of any V8-only key selects strict V8 validation; incomplete V8
  cannot fall through to V5. A body with none is the defined V5 shape because
  the external contracts provide no version discriminator.
- `purchase_year: 0`, invalid placeholder placement, oversized arrays,
  unapproved callback destinations, invalid URLs, and unknown keys are
  rejected.
- Authentication is proven to run before version/schema feedback.

### Mapping and dispatch

- Intake stores every V8 field without mutation.
- Dispatch preserves the received version and does not add keys.
- Controlled enrichment fills only eligible existing placeholders, never
  overwrites a real value, and revalidates the result.
- TINA/signed photo URLs survive intake, review projection, and dispatch.
- Human approval is required before any VRS AI request.
- Manual tickets without bridge rows never dispatch.

### Retry, callbacks, and UI

- Active V5/V8 attempts remain conflicts. V5 and nonretryable V8 terminal
  repeats retain ordinary ticket/SO policy.
- A strict V8 request after a locally applied retryable failed V8 callback
  receives a new normal ticket, new bridge, and new public call ID by excluding
  only prior retryable-failed V8 bridge tickets from same-day duplicate checks.
  Its old callback-forward retry remains independent and no old row is reset.
- Existing callback signature, ID replacement, result idempotency, and ticket
  effects remain unchanged.
- The V8 review fields and photos render only for bridge-backed tickets.

### Verification and development evidence

- Run the focused bridge suite and production build.
- Run the repository suite and compare its environment-limited baseline.
- Compare normalized TypeScript diagnostics with the captured baseline.
- Prove no unrelated/user-owned files changed.
- On the development runtime/database, smoke-test technician intake, manual
  authorization, agent claim/decision, AHS two-stage, NLA, admin, media,
  WebSocket, and SMS behavior.
- Run the V8 simulator flow through Express intake, human approval, outbound
  VRS AI receipt, signed result, and upstream callback.

## Rollout Boundary

Implementation is not production activation. The sequence is:

1. Implement and review in an isolated worktree based on `972409d` plus the
   corrected design.
2. Pass local regression gates and inspect every shared-file diff.
3. Sync only after confirming the Replit checkout is still clean and has not
   advanced unexpectedly.
4. Configure only development credentials and the development database.
5. Run the two-role VRS AI/SASHA simulator test and the manual-workflow smoke
   matrix against the development URL.
6. Record the exact rollback commit and test evidence.
7. Publish production only after a separate explicit approval.
