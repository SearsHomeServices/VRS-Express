---
name: VRS AI bridge DEV pilot
description: Where the V9 bridge pilot actually runs, its config invariants, and how its failures surface in Slack reports
---

# VRS AI bridge DEV pilot

- Do not assume the bridge is DEV-only or infer live activation from deployment configuration alone. The DEV-only description was an August 2026 observation, not a permanent scope restriction.
- **Why:** an August 2026 "production incident" actually concerned DEV, but later production configuration work invalidated the assumption that production must be inert.
- **How to apply:** Check the relevant environment's actual configuration, bridge records, and callback readiness before claiming where the pilot runs or whether production routing works.

## Config invariants
- `sendVrsAuthorizeRequest` (server/vrs-sasha-contract.ts) requires `VRS_AI_BASE_URL` to be a **clean `https://` origin** — `new URL()` throws `Invalid URL` on a bare hostname, and non-https is rejected. A scheme-less env value silently breaks every dispatch.
- Dispatch failures are stored as the bare error message; undici network errors record only `fetch failed` with the real cause (`e.cause`) discarded — DNS failure, TLS, and refused connections are indistinguishable in `vrs_ai_calls.dispatch_error`.
- **How to apply:** when a dispatch fails, reproduce with a one-off `node -e 'fetch(...)'` from the workspace and log `e.cause`; also compare the *running process's* env (`tr "\0" "\n" < /proc/<pid>/environ | grep KEY`) against current env vars — a long-lived orphan dev process can hold a stale `VRS_AI_BASE_URL` (this exact combo caused the Aug 17 incident: orphan held a decommissioned host, new value lacked `https://`).

## Photos on bridge tickets
- SASHA intake (`server/vrs-sasha-intake.ts`) never populates `submissions.photos`; bridge tickets show "no photo attached" in VRS Express unless the sender supplied `appliance_photos` (DEV test payloads send `[]`). "No photos" on a bridge ticket is expected sender behavior, not a rendering regression.
