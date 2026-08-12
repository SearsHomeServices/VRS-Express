# VRS Express V5/V8 Development Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Preserve the functioning V5 bridge, add the complete strict V8 SASHA contract, and prove the two-role VRS AI simulator flow against VRS Express development without changing or publishing production.

**Architecture:** Keep one authenticated `POST /vrs/authorize` boundary. Any V8-only key selects strict V8 validation; otherwise the unchanged V5 schema applies. Store the validated payload in the existing bridge JSON, preserve its version through Stage 1, and send it to VRS AI only after human approval. V8 outbound enrichment is field-specific and placeholder-only. Manual tickets are guarded by the absence of a bridge row, and the retry path reuses the current bridge row/event ledger without a schema migration.

**Tech Stack:** Node.js 20, TypeScript, Express 4, Zod, React 18, Drizzle/PostgreSQL, Vitest, OpenAPI 3.1, Markdown/DOCX/PDF.

**Design source:** `docs/superpowers/specs/2026-08-10-vrs-api-contract-v8-retrofit-design.md`

## Execution rules

- Work only in the isolated `.worktrees/vrs-v5-v8-dev-integration` checkout on branch `codex/vrs-v5-v8-dev-integration`.
- Do not change `shared/schema.ts`, `server/seed.ts`, startup migrations, production data, or production configuration.
- Preserve the user-owned root paths `graphify-out/` and `output/audio/`.
- Follow red-green-refactor: run each listed focused test and observe the requirement-specific failure before production code.
- After every task, update `CHANGELOG.md` under `[Unreleased]`, `.Codex/memory/context.md`, `.Codex/memory/todos.md`, `.Codex/memory/decisions.md`, and `MEMORY.md`, then commit only that task's files.
- Never print API keys, database URLs, callback secrets, or other secret values. Configuration checks report names/presence only.
- Do not sync Replit, change development secrets, push to the shared remote, or publish production until the explicit rollout checkpoint in Task 9.

## Baseline and worktree setup

### Task 0: Create the isolated checkout and reproduce the baseline

**Files:**

- Verify: `.gitignore`
- Create via Git: `.worktrees/vrs-v5-v8-dev-integration`

**Step 1: Verify the branch base and ignored worktree directory**

Run from the repository root:

```powershell
git status --short --branch
git log -1 --oneline
git check-ignore .worktrees
```

Expected: current `main` includes the corrected design/plan commits; only the two known user-owned output directories are untracked; `.worktrees` is ignored.

**Step 2: Create the implementation worktree**

```powershell
git worktree add .worktrees/vrs-v5-v8-dev-integration -b codex/vrs-v5-v8-dev-integration
Set-Location .worktrees/vrs-v5-v8-dev-integration
```

Expected: new branch is checked out without the root untracked output.

**Step 3: Install dependencies and run the recorded baseline**

```powershell
npm install
npm run test:vrs-ai-bridge
npm run build
npm run check 2>&1 | Tee-Object -FilePath .codex-vrs-check-baseline.txt
```

Expected:

- bridge suite: 32/32 passing;
- production build: passing;
- TypeScript: 56 raw diagnostics / 26 normalized unique diagnostics, with no new failures attributed to worktree setup.

Do not commit `.codex-vrs-check-baseline.txt`; remove it after comparison at Task 9.

## Contract boundary

### Task 1: Add canonical V5/V8 fixtures and strict version-aware schemas

**Files:**

- Create: `tests/fixtures/vrs-authorize-payloads.ts`
- Create: `tests/vrs-sasha-contract-v5-v8.test.ts`
- Modify: `server/vrs-sasha-contract.ts`
- Modify: `package.json`
- Modify required project memory/changelog files

**Step 1: Write canonical fixtures**

Export exact values:

```ts
export const signedTinaPhotoUrl =
  "https://tina.example.test/download/photo%2Fwasher.jpg?signature=abc%2B123&expires=1786406400";

export const validV5AuthorizePayload = {
  service_order: "13538277",
  tech_id: "0123456",
  tech_phone: "+12145550199",
  tech_name: "Carlos Rivera",
  reason_for_call: "authorization" as const,
  callback_url:
    "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
  callback_secret: "sasha-test-secret-with-at-least-32-characters",
  parts: [{
    part_id: "WPW10503278",
    part_description: "Electronic Control Board",
    sell_price: 245,
    part_function: "Controls wash cycle timing and motor speed.",
  }],
  customer_name: "Maria Gonzalez",
  customer_address: "742 Evergreen Terrace, Hagerstown, MD 21740",
  service_address: "742 Evergreen Terrace, Hagerstown, MD 21740",
  brand: "Whirlpool",
  model_number: "WTW5000DW1",
  serial_number: "C31290822",
  appliance_type: "Washer",
  appliance_age: 4,
  labor_amount: 120,
  tax_amount: 15.6,
  part_price: 245,
  appliance_location: "laundry room",
  failure_cause: "normal-wear" as const,
  tech_recommendation: "repair" as const,
  repair_replace_rationale:
    "Board failure is isolated and repair is within the coverage threshold.",
  appliance_grade: "mid" as const,
  partner_id: "ahs",
  appliance_photos: ["https://srdm.example.com/photo_1.jpg"],
  comments: [{
    tech_id: "0123456",
    work_item: "failure_diagnosis" as const,
    text: "Diagnostic code F7E1.",
    timestamp: "2026-05-12T13:55:00Z",
  }],
};

export const validV8AuthorizePayload = {
  ...validV5AuthorizePayload,
  appliance_color: "stainless steel",
  contract_number: "1234567890",
  purchase_year: 2022,
  symptom: "Washer not draining",
  appliance_grade: "mid",
  partner_id: "American Home Shield",
  appliance_photos: [signedTinaPhotoUrl],
  comments: [],
};
```

The V8 fixture must contain every required key. The V5 fixture must not contain the four V8-only keys.

**Step 2: Write the failing contract tests**

Cover:

- valid V5 classifies as `v5` and preserves its exact key set;
- valid V8 classifies as `v8`;
- the presence of any one V8-only key selects V8 and missing remaining V8 keys fails;
- V8 accepts `tech_phone: "N/A"`, required `N/A`/`TBD`, allowed `""`, allowed numeric zeroes, and empty photos/comments;
- V8 requires `appliance_color`, `contract_number`, `purchase_year`, `symptom`, `appliance_grade`, `partner_id`, `appliance_photos`, and `comments`;
- `purchase_year` accepts an integer year, `"TBD"`, and `"N/A"`, but rejects `0`, negative, fractional, empty, and numeric strings;
- unknown root/nested keys, `cta_no`, V4 aliases, invalid photo URLs, more than ten photos, and more than twenty comments fail;
- signed TINA URL bytes and accepted business strings are not trimmed or reordered; and
- no internal `contract_version` key appears on either wire payload.

Run:

```powershell
npx vitest run tests/vrs-sasha-contract-v5-v8.test.ts --reporter=verbose
```

Expected RED: V8 exports/classification do not exist or the V8 fixture is rejected by the current V5 schema.

**Step 3: Implement separate strict schemas and the intent selector**

In `server/vrs-sasha-contract.ts`, preserve the current schema as V5 and add:

```ts
export const VRS_V8_ONLY_KEYS = [
  "appliance_color",
  "contract_number",
  "purchase_year",
  "symptom",
] as const;

export type VrsAuthorizeContractVersion = "v5" | "v8";
export type VrsAuthorizeV5Request = z.infer<typeof vrsAuthorizeV5RequestSchema>;
export type VrsAuthorizeV8Request = z.infer<typeof vrsAuthorizeV8RequestSchema>;
export type VrsAuthorizeRequest =
  | VrsAuthorizeV5Request
  | VrsAuthorizeV8Request;

export function getVrsAuthorizeContractVersion(
  input: unknown,
): VrsAuthorizeContractVersion;

export function safeParseVrsAuthorizeRequest(input: unknown):
  | { success: true; version: VrsAuthorizeContractVersion; data: VrsAuthorizeRequest }
  | { success: false; version: VrsAuthorizeContractVersion; error: z.ZodError };
```

Selection rule: an object containing any V8-only key is parsed only as V8; all other objects are parsed only as V5. Build separate outbound-source schemas with the same shapes but a clean HTTPS callback URL instead of the SASHA callback allowlist.

V8 nonblank checks must validate without using Zod string transforms, so accepted strings remain byte-preserved. V5 retains its current behavior.

**Step 4: Add the new contract test to the focused script and run green**

```powershell
npm run test:vrs-ai-bridge
```

Expected GREEN: existing 32 tests plus all new contract cases pass.

**Step 5: Update required project records and commit**

```powershell
git add -- server/vrs-sasha-contract.ts tests/fixtures/vrs-authorize-payloads.ts tests/vrs-sasha-contract-v5-v8.test.ts package.json CHANGELOG.md MEMORY.md .Codex/memory/context.md .Codex/memory/todos.md .Codex/memory/decisions.md
git diff --cached --check
git commit -m "Add strict V5 and V8 authorize schemas"
```

### Task 2: Make the authenticated API boundary use the selected contract

**Files:**

- Modify: `tests/vrs-sasha-api-v5.test.ts`
- Modify: `server/vrs-sasha-api.ts`
- Modify required project memory/changelog files

**Step 1: Add failing API tests**

Add cases proving:

- authenticated V5 passes the exact V5 payload to intake;
- authenticated V8 passes the exact V8 payload to intake;
- a wrong key plus malformed body returns `401` and never calls intake;
- missing server configuration plus malformed body returns `503`;
- an authenticated partial V8 body returns `400` with V8 fields;
- V5 and V8 retain the same `202` and active-duplicate `409` response shapes; and
- responses never include either callback secret or the provider call ID.

Run:

```powershell
npx vitest run tests/vrs-sasha-api-v5.test.ts --reporter=verbose
```

Expected RED: authenticated V8 is rejected and the new version-aware assertions fail.

**Step 2: Replace direct schema parsing with the selector**

Use `safeParseVrsAuthorizeRequest(req.body)` only after the existing configuration and timing-safe API-key checks. Keep endpoint, headers, status codes, bounded error field list, and response bodies unchanged.

Update `VrsExpressIntake.receive` to accept the V5/V8 request union, without adding a wire version field.

**Step 3: Run focused tests**

```powershell
npx vitest run tests/vrs-sasha-api-v5.test.ts --reporter=verbose
npm run test:vrs-ai-bridge
```

Expected GREEN: old V5 behavior and new V8/auth-order behavior pass.

**Step 4: Update required project records and commit**

```powershell
git add -- server/vrs-sasha-api.ts tests/vrs-sasha-api-v5.test.ts CHANGELOG.md MEMORY.md .Codex/memory/context.md .Codex/memory/todos.md .Codex/memory/decisions.md
git diff --cached --check
git commit -m "Accept authenticated V5 and V8 intake"
```

## Mapping and dispatch

### Task 3: Add safe V8 operational fallbacks and same-version outbound enrichment

**Files:**

- Modify: `tests/vrs-sasha-queue.test.ts`
- Modify: `server/vrs-sasha-queue.ts`
- Modify: `server/vrs-sasha-store.ts`
- Modify: `server/routes.ts`
- Modify required project memory/changelog files

**Step 1: Write failing mapping and dispatch tests**

Add cases proving:

- V8 `tech_phone: "N/A"` uses the resolved directory phone for the normal Express ticket/SMS and never stores/texts literal `N/A` operationally;
- blank V8 rationale produces a nonempty internal issue description from, in order, real `symptom`, a structured comment, `failure_cause`, then `Authorization review requested`;
- durable bridge JSON remains the parsed wire payload rather than the operational ticket fallback;
- the review projection includes every V8 field and removes both callback fields;
- V5 dispatch retains exactly the V5 business key set;
- V8 dispatch retains every V8 key and the signed TINA URL byte-for-byte;
- enrichment fills only V8 `tech_phone: "N/A"`, empty `tech_name`, and an empty `appliance_photos` array when explicit same-field authoritative candidates are valid;
- enrichment never overwrites populated values, never appends an absent key, rejects non-HTTPS/authenticated object-path photo candidates, and never adds `cta_no`; and
- dispatch revalidates against the original version before calling the client.

Run:

```powershell
npx vitest run tests/vrs-sasha-queue.test.ts --reporter=verbose
```

Expected RED: current mapper emits literal `N/A`, blank rationale fails normal-ticket requirements, and controlled enrichment/version assertions have no implementation.

**Step 2: Implement operational mapping without mutating wire JSON**

Extend the mapper signature:

```ts
export interface VrsSubmissionOperationalValues {
  technicianPhone?: string | null;
}

export function mapVrsPayloadToSubmission(
  payload: VrsAuthorizeRequest,
  districtCode: string,
  operational?: VrsSubmissionOperationalValues,
): {
  serviceOrder: string;
  applianceType: VrsExpressApplianceDivision;
  requestType: "authorization";
  warrantyType: "american_home_shield";
  warrantyProvider: "American Home Shield";
  issueDescription: string;
  estimateAmount: string;
  partNumbers: string;
  phone: string;
};
```

Use the resolved technician phone when the wire value is `N/A`. Do not write a literal placeholder into the normal ticket. Build the internal issue fallback without changing `requestPayload`.

**Step 3: Implement a pure controlled-enrichment helper**

```ts
export interface VrsAuthorizeEnrichment {
  techPhone?: string | null;
  techName?: string | null;
  appliancePhotos?: string[] | null;
}

export function enrichVrsAuthorizeForDispatch(
  payload: VrsAuthorizeRequest,
  enrichment: VrsAuthorizeEnrichment,
): VrsAuthorizeRequest;
```

Return V5 unchanged. For V8, replace only existing documented placeholder values with valid same-field candidates. Filter photo candidates to clean absolute HTTPS URLs; never use `/objects/` or session-authenticated URLs. Validate the result with its outbound V8 schema.

Pass candidates from the Stage 1 route using `submission.phone`, the resolved technician user name, and already-absolute URLs from `submission.photos`. The sender-provided V8 photo array remains authoritative and is not replaced when nonempty.

**Step 4: Update bridge/store union types and run green**

Change TypeScript casts/interfaces only; do not change SQL, tables, or `shared/schema.ts`.

```powershell
npx vitest run tests/vrs-sasha-queue.test.ts --reporter=verbose
npm run test:vrs-ai-bridge
```

Expected GREEN: exact version/key-set and enrichment assertions pass; prior queue/callback tests remain green.

**Step 5: Update required project records and commit**

```powershell
git add -- server/vrs-sasha-queue.ts server/vrs-sasha-store.ts server/routes.ts tests/vrs-sasha-queue.test.ts CHANGELOG.md MEMORY.md .Codex/memory/context.md .Codex/memory/todos.md .Codex/memory/decisions.md
git diff --cached --check
git commit -m "Preserve versioned payloads through dispatch"
```

### Task 4: Lock the human Stage 1 and manual-ticket isolation boundary

**Files:**

- Create: `server/vrs-stage-one-bridge.ts`
- Create: `tests/vrs-sasha-stage-one.test.ts`
- Modify: `server/routes.ts`
- Modify: `package.json`
- Modify required project memory/changelog files

**Step 1: Write the failing boundary tests**

Use injected bridge store/config/dispatcher functions and prove:

- no bridge row returns `not_applicable` before reading bridge configuration;
- a manual ticket never constructs a VRS AI client or calls dispatch;
- a bridge ticket with missing configuration returns `VRS_AI_NOT_CONFIGURED` without Stage 1 mutation;
- an outbound dispatch happens before the existing Stage 1 update/SMS callback;
- failed dispatch leaves Stage 1 unapproved; and
- accepted dispatch allows the existing Stage 1 mutation exactly once.

Run:

```powershell
npx vitest run tests/vrs-sasha-stage-one.test.ts --reporter=verbose
```

Expected RED: the isolated helper does not exist.

**Step 2: Extract only the bridge decision**

Create a helper returning:

```ts
export type VrsStageOneBridgeResult =
  | { kind: "not_applicable" }
  | { kind: "accepted"; dispatch: DispatchVrsAiResult }
  | { kind: "http_error"; status: 409 | 429 | 502 | 503; code: string; message: string };
```

It must call `getBySubmissionId` first. Configuration resolution and VRS AI construction occur only after a bridge row exists. Keep the legacy Stage 1 update and SMS code in `server/routes.ts` byte-equivalent after a `not_applicable` or accepted result.

**Step 3: Run the boundary, focused, and build checks**

```powershell
npx vitest run tests/vrs-sasha-stage-one.test.ts --reporter=verbose
npm run test:vrs-ai-bridge
npm run build
```

Expected GREEN: manual isolation tests, full focused suite, and build pass.

**Step 4: Update required project records and commit**

```powershell
git add -- server/vrs-stage-one-bridge.ts server/routes.ts tests/vrs-sasha-stage-one.test.ts package.json CHANGELOG.md MEMORY.md .Codex/memory/context.md .Codex/memory/todos.md .Codex/memory/decisions.md
git diff --cached --check
git commit -m "Lock VRS AI dispatch behind human approval"
```

## V8 review and retry behavior

### Task 5: Show the complete V8 context only on bridge-backed tickets

**Files:**

- Modify: `client/src/lib/vrsAiBridge.ts`
- Modify: `client/src/pages/agent-dashboard.tsx`
- Modify: `tests/vrs-ai-bridge-ui.test.ts`
- Modify required project memory/changelog files

**Step 1: Add failing UI/source assertions**

Assert the guarded bridge panel includes:

- contract version;
- partner and contract number;
- symptom and repair/replace rationale;
- purchase year, age, grade, color, brand, appliance type, model, and serial;
- technician name/phone availability;
- labor/tax/parts totals and part price/function;
- comments; and
- photo links/previews using sender-provided URLs.

Also assert every new block remains under `selectedSubmission.vrsAi` and the manual approval copy remains present.

```powershell
npx vitest run tests/vrs-ai-bridge-ui.test.ts --reporter=verbose
```

Expected RED: V8-only fields/photos/version are absent from types or source.

**Step 2: Extend the review projection/type and guarded UI**

Expose an internal derived `contractVersion` alongside `reviewContext`; do not add it to the stored/wire payload. Render `N/A` and `TBD` literally. Open photos safely in a new tab with `rel="noreferrer noopener"`; do not request Express media tokens for TINA/signed URLs.

**Step 3: Run focused tests and build**

```powershell
npx vitest run tests/vrs-ai-bridge-ui.test.ts --reporter=verbose
npm run test:vrs-ai-bridge
npm run build
```

Expected GREEN: UI assertions, bridge suite, and build pass.

**Step 4: Update required project records and commit**

```powershell
git add -- client/src/lib/vrsAiBridge.ts client/src/pages/agent-dashboard.tsx tests/vrs-ai-bridge-ui.test.ts CHANGELOG.md MEMORY.md .Codex/memory/context.md .Codex/memory/todos.md .Codex/memory/decisions.md
git diff --cached --check
git commit -m "Show complete V8 review context"
```

### Task 6: Preserve active-only duplicate behavior for V5 and V8 intake

**Files:**

- Create: `server/vrs-sasha-intake.ts`
- Create: `tests/vrs-sasha-intake.test.ts`
- Modify: `server/vrs-sasha-store.ts`
- Modify: `server/vrs-sasha-queue.ts`
- Modify: `server/routes.ts`
- Modify: `package.json`
- Modify required project memory/changelog files

**Step 1: Write failing intake/retry tests with injected fakes**

Cover:

- active V5/V8 attempt returns the current duplicate response before ticket creation;
- a new request creates one normal ticket and one bridge row;
- every terminal V5/V8 repeat creates a normal new ticket and bridge row with
  a new public call ID, subject to existing normal ticket/SO policy;
- retryable V8 failure is a normal new request/new public call ID without
  reusing the prior ticket or bridge row; and
- the existing pre-acceptance `dispatch_failed` retry remains a Stage 1 resend.

```powershell
npx vitest run tests/vrs-sasha-intake.test.ts --reporter=verbose
```

Expected RED: the intake orchestration API does not exist.

**Step 2: Extract intake orchestration from the route closure**

Inject technician resolution, ticket creation, encryption, call-ID generation, and bridge store. Preserve the existing successful path and status/error bodies.

**Step 3: Preserve the active-only bridge admission lock**

Keep the existing advisory-locked `createIntake` final active-race check after
normal ticket creation. Do not inspect or mutate terminal bridge rows, reset a
ticket, add a ledger snapshot, or add historical callback lookup behavior.

**Step 4: Run green and protect existing callbacks**

```powershell
npx vitest run tests/vrs-sasha-intake.test.ts --reporter=verbose
npx vitest run tests/vrs-sasha-queue.test.ts --reporter=verbose
npm run test:vrs-ai-bridge
npm run build
```

Expected GREEN: terminal-repeat, existing queue/callback, full bridge, and build checks pass.

**Step 5: Update required project records and commit**

```powershell
git add -- server/vrs-sasha-intake.ts server/vrs-sasha-store.ts server/vrs-sasha-queue.ts server/routes.ts tests/vrs-sasha-intake.test.ts package.json CHANGELOG.md MEMORY.md .Codex/memory/context.md .Codex/memory/todos.md .Codex/memory/decisions.md
git diff --cached --check
git commit -m "Preserve active-only V5 V8 bridge intake"
```

## External handoff

### Task 7: Update architecture, Markdown handoff, and OpenAPI for both versions

**Files:**

- Modify: `docs/architecture/vrs-sasha-api-v5.md`
- Modify: `docs/integration/vrs-express-vrs-ai-bridge-handoff.md`
- Modify: `docs/integration/vrs-express-vrs-ai-bridge-openapi.yaml`
- Create: `tests/vrs-bridge-docs.test.ts`
- Modify: `package.json`
- Modify required project memory/changelog files

**Step 1: Write failing documentation contract tests**

Parse OpenAPI and prove:

- every local `$ref` resolves;
- `/vrs/authorize` request body is `oneOf` strict V5 and strict V8 schemas;
- V5 example validates as V5 and has no V8-only keys;
- V8 example validates as V8 and includes all required keys;
- all five callback examples validate against runtime schemas;
- the deterministic HMAC vector still matches; and
- Markdown/OpenAPI contain only the platform names, no individual names, no live credentials, and no claim that `202` means an AHS call started.

```powershell
npx vitest run tests/vrs-bridge-docs.test.ts --reporter=verbose
```

Expected RED: handoff/OpenAPI describe only V5 and lack the V8 schema/example.

**Step 2: Update the platform-only source documents**

The handoff must state exactly:

- VRS AI's simulator calls `<VRS_EXPRESS_DEV_BASE_URL>/vrs/authorize` with the development `X-API-Key`;
- V5 and V8 use the same route, with the strict selection rule;
- V8 required fields/placeholders and a full copyable test payload;
- VRS Express creates a DEV pending ticket and does not call VRS AI until human approval;
- approval sends the same contract version to `<VRS_AI_DEV_BASE_URL>/vrs/authorize` using the separate Express-to-AI key;
- Express may fill only documented placeholders in existing keys;
- sender-provided TINA/signed photo URLs pass through and require no Replit login, while internal authenticated `/objects/` paths are not exposed;
- callback/HMAC, public/provider call-ID, idempotency, and retry behavior; and
- the exact two-direction development acceptance checklist.

Retitle the V5 architecture document as the V5/V8 bridge architecture while preserving its path for existing links.

OpenAPI uses `additionalProperties: false` and separate `V5AuthorizeRequest` / `V8AuthorizeRequest` schemas. `V8AuthorizeRequest` requires every always-present key. Do not include internal `contractVersion` or `cta_no`.

**Step 3: Run documentation and runtime tests**

```powershell
npx vitest run tests/vrs-bridge-docs.test.ts --reporter=verbose
npm run test:vrs-ai-bridge
```

Expected GREEN: examples and references align with runtime; no platform-facing name leaks.

**Step 4: Update required project records and commit**

```powershell
git add -- docs/architecture/vrs-sasha-api-v5.md docs/integration/vrs-express-vrs-ai-bridge-handoff.md docs/integration/vrs-express-vrs-ai-bridge-openapi.yaml tests/vrs-bridge-docs.test.ts package.json CHANGELOG.md MEMORY.md .Codex/memory/context.md .Codex/memory/todos.md .Codex/memory/decisions.md
git diff --cached --check
git commit -m "Document the V5 V8 development bridge"
```

### Task 8: Regenerate the three-file drag-and-drop package

**Files:**

- Modify: `output/doc/VRS-Express-VRS-AI-Bridge-Integration-Handoff.docx`
- Modify: `output/doc/VRS-Express-VRS-AI-Bridge-Integration-Handoff.pdf`
- Modify: `output/doc/VRS-Express-VRS-AI-Handoff-Package.zip`
- Modify required project memory/changelog files

**Step 1: Use the documents and PDF skills**

Read and follow the complete `documents:documents` and `pdf:pdf` skill instructions before generation. Treat the Markdown source as authoritative and the OpenAPI file as the machine-readable third artifact.

**Step 2: Generate DOCX, export matching PDF, and build the ZIP**

The ZIP must contain exactly:

```text
VRS-Express-VRS-AI-Bridge-Integration-Handoff.pdf
VRS-Express-VRS-AI-Bridge-Integration-Handoff.docx
vrs-express-vrs-ai-bridge-openapi.yaml
```

**Step 3: Validate text, metadata, structure, and visuals**

- extract DOCX/PDF visible text and scan for individual names, internal meeting/repository history, secrets, and obsolete single-V5/single-V8 claims;
- verify all three exact ZIP members and no extras;
- render every DOCX/PDF page and visually inspect for clipping, overlap, missing tables, bad page breaks, and unreadable examples; and
- rerun `tests/vrs-bridge-docs.test.ts` against the source documents.

Expected: three clean, mutually consistent files ready for direct drag-and-drop.

**Step 4: Update required project records and commit**

```powershell
git add -- output/doc/VRS-Express-VRS-AI-Bridge-Integration-Handoff.docx output/doc/VRS-Express-VRS-AI-Bridge-Integration-Handoff.pdf output/doc/VRS-Express-VRS-AI-Handoff-Package.zip CHANGELOG.md MEMORY.md .Codex/memory/context.md .Codex/memory/todos.md .Codex/memory/decisions.md
git diff --cached --check
git commit -m "Regenerate the V5 V8 handoff package"
```

## Verification and development rollout checkpoint

### Task 9: Prove regression safety and stage the DEV integration test

**Files:**

- Verify all changed files
- Remove: `.codex-vrs-check-baseline.txt` after comparison
- Update required project memory/changelog files with actual evidence

**Step 1: Run the complete local verification matrix fresh**

```powershell
npm run test:vrs-ai-bridge
npm run build
npm run check 2>&1 | Tee-Object -FilePath .codex-vrs-check-final.txt
npx vitest run
git diff main...HEAD --check
git status --short
```

Expected:

- all focused bridge/docs tests pass;
- production build passes;
- final normalized TypeScript diagnostics do not exceed or differ from the 56 raw / 26 normalized baseline;
- repository-wide run has no regression from 45 passing and the recorded 17 environment-bound intake tests;
- only planned files changed; and
- no `shared/schema.ts`, `server/seed.ts`, migration, user-owned output, or unrelated diff exists.

Delete both temporary diagnostic files after the comparison.

**Step 2: Request a final code review agent**

The reviewer must compare every changed file to the corrected design and explicitly report:

- V5 compatibility;
- V8 strictness;
- no up-conversion or extra keys;
- Stage 1/manual isolation;
- retry/late-callback safety;
- no schema/startup changes;
- docs/runtime agreement; and
- remaining development environment blockers.

Fix any High or Medium issue test-first, rerun the matrix, and commit the fix with required project records.

**Step 3: Read-only reconcile the Replit publish source before any transfer**

Using the canonical `vrs-express` SSH alias, report only:

- current commit;
- branch;
- clean/dirty state;
- existence, not values, of required development variable names; and
- the development URL exposed by the current Replit workspace.

Stop if the box advanced beyond the captured source or has uncommitted work. Do not overwrite it.

**Step 4: Hold the explicit rollout checkpoint**

Before any push, Replit source transfer, development-secret change, dev-server restart, or production publication, present:

- exact verified branch/commit;
- full test/build/type evidence;
- exact file diff summary;
- discovered VRS Express DEV URL;
- required-but-missing variable names;
- exact VRS AI DEV base URL/callback inputs still needed; and
- rollback target `972409d` or the newer reconciled pre-transfer commit.

Only after explicit approval may the verified commit be transferred to the clean Replit development source and configured against the development database. Production publication remains a second, separate approval after successful joint testing.

**Step 5: Run the joint DEV test after approval and secure inputs**

Use a unique dummy service order/technician approved for the development database:

1. VRS AI simulator posts the complete V8 payload to VRS Express DEV and receives `202`.
2. Confirm exactly one pending DEV ticket and zero outbound VRS AI calls before approval.
3. Human tester claims and approves it.
4. Confirm exactly one same-version request reaches VRS AI DEV, including usable signed photo URLs.
5. VRS AI sends a correctly signed result to the Express DEV webhook.
6. Confirm one ticket/SMS effect and one signed upstream callback; replay the event and confirm dedupe.
7. Send a retryable failure and prove a new V8 request creates a normal new
   ticket, bridge row, and public call ID.
8. Smoke-test the listed manual/PWA, two-stage AHS, First American, NLA, admin, media, WebSocket, and SMS paths against the development database.

Record sanitized timestamps, IDs, HTTP statuses, and screenshots/log evidence without secrets or customer data.

**Step 6: Final commit and branch handoff**

Update all required project records with the actual result. Do not claim production-ready if joint DEV or manual smoke evidence is incomplete.

```powershell
git status --short
git log --oneline --decorate -12
```

Then use `superpowers:finishing-a-development-branch` to present the verified integration options. Production publish is never automatic.
