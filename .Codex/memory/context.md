# Codex Context - VRS-Agent-Core

Updated: 2026-07-29 11:10

## Current Session

- Audited whether the three integration artifacts contain everything needed for
  a VRS AI handoff.
- Fresh evidence:
  - 32/32 focused bridge tests passed.
  - OpenAPI 3.1 parsed; all 34 local references resolve.
  - The authorize example and all five callback examples pass the committed
    runtime schemas.
  - The deterministic HMAC vector matches the implementation.
  - The DOCX contains all three explicitly requested VRS AI decisions and has
    zero individual-owner-name references.
- The wire-level contract is sufficient to implement against, but the package
  is not yet final-send-ready:
  - Markdown and DOCX still say draft PR #1 / commit `6ec180f`.
  - They do not reflect merged `main` at `3c4cee7`.
  - Actual API keys, callback secrets, and the real Express staging callback
    origin must be exchanged securely outside the documents.
  - Prompt placement, retryable-failure ownership, and recording access
    retention/expiry still require VRS AI decisions.
  - Endpoint reachability and joint staging evidence have not been completed.
- Verified Tyler's newly published Replit deployment:
  - `https://vrs-auth-tool.replit.app/` returns `200`.
  - `/api/healthz` reports healthy with a successful database check.
  - The live client bundle is `assets/index-CFNuQpM-.js`, matching the merged
    build produced on the VRS Express box.
  - `/vrs/authorize` exists but returns `503 NOT_CONFIGURED` because
    `VRS_SASHA_API_KEY` is missing.
  - `/api/integrations/vrs-ai/v1/webhook` exists but returns
    `503 NOT_CONFIGURED` because `VRS_AI_WEBHOOK_SECRET` is missing.
  - All six bridge variables are absent:
    `VRS_SASHA_API_KEY`, `VRS_BRIDGE_ENCRYPTION_KEY`, `VRS_AI_BASE_URL`,
    `VRS_AI_API_KEY`, `VRS_AI_WEBHOOK_SECRET`, and `VRS_AI_CALLBACK_URL`.
  - Read-only DB inspection confirms `vrs_ai_calls` and
    `vrs_ai_call_events` do not exist.
  - Direct URLs under `/docs/integration/*` and `/output/doc/*` return the SPA
    HTML shell, not the Markdown/OpenAPI/DOCX files; publishing the app did not
    make the handoff package downloadable.
- Tyler confirmed the bridge and handoff documentation belong on `main` so VRS
  Express can be published and the package shared.
- Marked PR #1 ready and merged it into GitHub `main` through merge commit
  `f1b9398`.
- Fast-forwarded local `main` and the clean VRS Express Replit checkout to the
  merged history.
- Replit's raw private-GitHub fetch could not authenticate through its askpass
  helper, so the verified complete Git history was transferred over the
  existing SSH connection and used to update `origin/main` and `main`.
- Verified on the VRS Express box:
  - `main` matched `origin/main` at the merged commit.
  - Markdown, OpenAPI, and DOCX handoff artifacts were present.
  - 32/32 focused tests passed.
  - The production build passed.
- Reconciled source before changing code:
  - Replit `main` was clean and 14 commits ahead of GitHub.
  - GitHub was 181 commits ahead of the stale local checkout.
  - Replit tip `98542cf` was transferred over SSH, pushed to GitHub, and used
    to fast-forward local `main`.
- Created `codex/vrs-sasha-api-v5` from synchronized commit `98542cf`.
- Earlier AI-side admission work was pushed for review, then explicitly
  superseded after the July 24 Granola meeting clarified ownership.
- Opened draft PR #1:
  `https://github.com/jtmorgan0513-alt/VRS-Agent-Core/pull/1`.
- Located and reviewed the July 24 Granola meeting:
  "VRS Express API integration — tech hub, Sasha, and AI system endpoints."
- The meeting confirms the intended flow is:
  SASHA/Tech Hub → VRS Express → human approval → VRS AI → VRS Express result,
  with the existing technician SMS retained for now.
- Reworked the implementation to the confirmed bridge:
  - strict authenticated SASHA/Tech Hub V5 intake
  - normal pending VRS Express ticket through `createSubmissionHandler`
  - AHS-only gate and district/SO/appliance mapping
  - **Approve & Send to VRS AI** human action
  - outbound `/vrs/authorize` client
  - signed/timestamped VRS AI callback receiver
  - result application through `processSubmissionHandler`
  - signed callback forwarding to SASHA with the Express call ID
  - event-level idempotency checkpoints
- Callback secrets now use `VRS_BRIDGE_ENCRYPTION_KEY`, not `SESSION_SECRET`.
- Final verification: 32/32 bridge tests pass and the production build passes.
  Branch and a fresh `origin/main` worktree each have the same 56 raw / 26
  normalized pre-existing TypeScript diagnostics, with zero branch delta.
- Added the VRS Express-to-VRS AI integration package:
  - `docs/integration/vrs-express-vrs-ai-bridge-handoff.md`
  - `docs/integration/vrs-express-vrs-ai-bridge-openapi.yaml`
  - `output/doc/VRS-Express-VRS-AI-Bridge-Integration-Handoff.docx`
- The package documents the exact Express-to-AI request and response contract,
  five Phase 1 callback shapes, raw-body HMAC and retry rules, a deterministic
  signing vector, ownership, business effects, staging evidence, and three
  decisions VRS AI must return.
- Documentation validation passes: OpenAPI 3.1 parses with all local schema
  references resolved; its authorize example and all five callback examples
  pass the committed Zod schemas; the HMAC vector matches the implementation.
  The DOCX was rendered through Word and all 10 pages were visually inspected.
- Removed the individual owner's name from every platform-facing integration
  artifact, filename, heading, ownership table, readiness checklist, and HMAC
  test secret. The package now identifies the parties only as VRS Express and
  VRS AI.

## Scope Boundary

- The bridge source and handoff package are now present on VRS Express `main`.
  Publication/deployment remains Tyler's action.
- Source merge does not activate a working live bridge by itself. The additive
  dev schema, staging secrets/URLs, and complete AHS staging transaction remain
  required before production activation.
- The currently published app contains the bridge code but the bridge is
  disabled by missing configuration and schema. Do not represent it as an
  operational VRS Express-to-VRS AI connection.
- Do not send the current DOCX as a final merged-state handoff until its stale
  draft-branch metadata is updated and the regenerated pages are revalidated.
- The supplied V5 contract defines the wire shape; the Granola meeting defines
  the extra Express human-approval boundary and system ownership.
- Phase 1 is AHS phone authorization. First American's portal automation is a
  separate, incompletely validated execution path; Choice/OEM are excluded and
  Assurance is later.
- No production database schema or data changes were made.
- Security incident: the final nested-shell SSH verification printed the Replit
  environment into task tool output. No values were saved to files or Git, but
  all box credentials must be treated as exposed pending Tyler-approved
  rotation.

## Notes

- Required staging variables are documented in
  `docs/architecture/vrs-sasha-api-v5.md`.
- The integration package deliberately contains no live keys, callback secrets, or
  customer data. Actual staging values must be exchanged securely.
- Additive `vrs_ai_calls` / `vrs_ai_call_events` schema remains unapplied.
- A `failed` AI callback remains pending for the existing manual authorization
  flow; `retryable` is surfaced to the agent, but automatic redial is owned by
  VRS AI and is not claimed here.
- The local user-owned `graphify-out/` directory remains untracked and was not
  staged or modified.
- Full `npm run check` has a pre-existing TypeScript baseline: 56 raw
  diagnostics collapse to 26 unique diagnostics after line/column
  normalization. The branch and fresh `origin/main` outputs match exactly.
