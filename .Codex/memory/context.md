# Codex Context - VRS-Agent-Core

Updated: 2026-07-28 13:07

## Current Session

- Reconciled source before changing code:
  - Replit `main` was clean and 14 commits ahead of GitHub.
  - GitHub was 181 commits ahead of the stale local checkout.
  - Replit tip `98542cf` was transferred over SSH, pushed to GitHub, and used
    to fast-forward local `main`.
- Created `codex/vrs-sasha-api-v5` from synchronized commit `98542cf`.
- Implemented the safe admission boundary from the supplied VRS ↔ SASHA API
  Contract V5:
  - `POST /vrs/authorize`
  - dedicated `VRS_SASHA_API_KEY`
  - strict V5 request schema
  - exact SASHA callback allowlist
  - durable `vrs_ai_calls` queue
  - atomic duplicate/per-tech/global admission limits
  - encrypted callback secrets
  - HMAC callback signing and retry utility
- Added 15 passing contract/queue tests and architecture documentation.
- Pushed commit `7f2c996` to `origin/codex/vrs-sasha-api-v5`.
- Opened draft PR #1:
  `https://github.com/jtmorgan0513-alt/VRS-Agent-Core/pull/1`.
- Located and reviewed the July 24 Granola meeting:
  "VRS Express API integration — tech hub, Sasha, and AI system endpoints."
- The meeting confirms the intended flow is:
  SASHA/Tech Hub → VRS Express → human approval → VRS AI → VRS Express result,
  with the existing technician SMS retained for now.
- This makes the current draft architecture incorrect for this repository:
  call admission, Twilio/AI execution, rate limits, and webhook sending belong
  to Enzo's VRS AI service. VRS Express owns intake, review, the new
  approval/send action, outbound client, result receiver, and ticket/SMS update.

## Scope Boundary

- **Draft PR #1 must not be merged in its current form.**
- The current branch implements the VRS AI-side admission boundary inside the
  VRS Express repository and must be reworked into the Express bridge.
- The supplied V5 contract describes SASHA BFF → VRS AI directly; it does not
  define the extra VRS Express intake/pending-review contract required by the
  meeting.
- Phase 1 is AHS phone authorization. First American's portal automation is a
  separate, incompletely validated execution path; Choice/OEM are excluded and
  Assurance is later.
- No production database schema or data changes were made.
- Security incident: the final nested-shell SSH verification printed the Replit
  environment into task tool output. No values were saved to files or Git, but
  all box credentials must be treated as exposed pending Tyler-approved
  rotation.

## Notes

- Existing `/api/external/v1/*` routes may provide reusable human-ticket
  adapter logic, but the exact SASHA/Tech Hub intake route and payload mapping
  still need to be defined for the bridge.
- The local user-owned `graphify-out/` directory remains untracked and was not
  staged or modified.
- Full `npm run check` has a pre-existing TypeScript baseline; require zero new
  errors in the VRS SASHA files and use the focused tests plus production build
  as the feature gate.
