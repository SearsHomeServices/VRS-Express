# Codex Context - VRS-Agent-Core

Updated: 2026-08-11 18:18

## Current Session

- Reconciled the 2026-08-11 integration meeting with the supplied V8 contract
  and corrected two earlier assumptions: V5 remains supported alongside V8,
  and Express may fill only an existing placeholder with authoritative data
  for that exact field.
- Corrected the implementation design at
  `docs/superpowers/specs/2026-08-10-vrs-api-contract-v8-retrofit-design.md`.
  Both strict contracts use `POST /vrs/authorize`; V8-only required keys make
  version detection deterministic, and the durable JSON payload records the
  shape without a schema change.
- The development test has two explicit VRS AI roles: it first sends a V8
  dummy request as a SASHA simulator, then receives the V8 payload from VRS
  Express after a human approves the DEV ticket. This is not a call loop.
- The same Replit project may serve development and production, but the test
  must use the development URL, development database binding, and development
  credentials. Production remains unchanged and unpublished.
- The implementation baseline remains clean Replit publish source `972409d`,
  32/32 focused bridge tests, a passing production build, 45 locally runnable
  tests, and 56 raw / 26 normalized pre-existing TypeScript diagnostics.
- No runtime implementation, schema operation, push, Replit sync,
  configuration change, deployment, or publication has occurred yet.

## Previous Handoff Snapshot (2026-07-29)

- Finalized the external VRS Express-to-VRS AI implementation handoff.
- External deliverables:
  - `output/doc/VRS-Express-VRS-AI-Handoff-Package.zip`
  - `output/doc/VRS-Express-VRS-AI-Bridge-Integration-Handoff.pdf`
  - `output/doc/VRS-Express-VRS-AI-Bridge-Integration-Handoff.docx`
  - `docs/integration/vrs-express-vrs-ai-bridge-openapi.yaml`
- The ZIP intentionally contains exactly the PDF, editable DOCX, and OpenAPI
  contract. The repository Markdown remains the canonical source for the
  human-readable document.
- Removed individual names and internal meeting, PR, commit, and
  security-incident history from every platform-facing file. The handoff
  identifies VRS Express and VRS AI as the two integration platforms.
- Replaced stale draft metadata with the accurate merged/published source
  status. The document does not expose Git history or live credentials.
- Exported the final DOCX through Microsoft Word to a 10-page PDF. All 10
  rendered pages were reviewed individually with no clipping, overlap, or
  visible internal-name leakage.
- Fresh validation:
  - 32/32 focused bridge tests passed.
  - OpenAPI 3.1 parsed with all 34 local references resolved.
  - The authorize example and all five callback examples passed the committed
    runtime schemas.
  - The deterministic HMAC vector matched the implementation.
  - DOCX/PDF visible text and metadata scans were clean.
  - The ZIP contains exactly the three intended files.
- The package is ready for direct implementation handoff.

## Scope Boundary

- The published VRS Express state and bridge activation status have not been
  revalidated in this V8 design step. Statements below are the 2026-07-29
  snapshot and may be stale.
- At that snapshot, the published VRS Express app contained the merged bridge
  source, but the live bridge was not operational yet.
- All six bridge environment variables remain absent, both bridge routes return
  `503 NOT_CONFIGURED`, and the additive `vrs_ai_calls` /
  `vrs_ai_call_events` tables are absent.
- No production database schema/data change and no deployment were performed in
  this documentation-finalization session.
- Secure keys, callback secrets, and the actual staging callback origin must be
  exchanged outside the handoff package.
- VRS AI still needs to return the three decisions documented in the handoff:
  prompt placement, retryable terminal-failure ownership, and recording access
  retention/authorization/expiry.
- Joint AHS staging evidence remains required before production activation.
- The published app does not expose repository documents as download routes;
  use the direct ZIP/PDF/DOCX/OpenAPI files.
- Local user-owned `graphify-out/` remains untracked and untouched.
- Credential rotation from the prior SSH-output incident remains pending
  Tyler's explicit approval and coordination.

## Notes

- Required staging variables remain documented in
  `docs/architecture/vrs-sasha-api-v5.md`.
- The external integration package contains no live keys, callback secrets, or
  customer data.
- Full `npm run check` has a pre-existing TypeScript baseline: 56 raw
  diagnostics collapse to 26 unique diagnostics after line/column
  normalization. The previously compared branch and fresh `origin/main`
  outputs matched exactly.
