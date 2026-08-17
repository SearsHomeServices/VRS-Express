---
name: VRS AI bridge DEV pilot
description: Where the V9 bridge pilot actually runs, its config invariants, and how its failures surface in Slack reports
---

# VRS AI bridge DEV pilot

- The SASHA/VRS AI bridge pilot runs on the **DEV instance** (the `.replit.dev` URL), not production. Contractors/agents doing pilot reviews are on DEV. Production `vrs_ai_calls` is empty by design so far — prod has no `VRS_AI_BASE_URL` configured, so bridge code is inert there.
- **Why:** an Aug 2026 "production incident" Slack report ("Fetch error when approving", "no photos in VRS Express") turned out to be entirely DEV-pilot behavior. Check `vrs_ai_calls` in BOTH environments before assuming prod.

## Config invariants
- `sendVrsAuthorizeRequest` (server/vrs-sasha-contract.ts) requires `VRS_AI_BASE_URL` to be a **clean `https://` origin** — `new URL()` throws `Invalid URL` on a bare hostname, and non-https is rejected. A scheme-less env value silently breaks every dispatch.
- Dispatch failures are stored as the bare error message; undici network errors record only `fetch failed` with the real cause (`e.cause`) discarded — DNS failure, TLS, and refused connections are indistinguishable in `vrs_ai_calls.dispatch_error`.
- **How to apply:** when a dispatch fails, reproduce with a one-off `node -e 'fetch(...)'` from the workspace and log `e.cause`; also compare the *running process's* env (`tr "\0" "\n" < /proc/<pid>/environ | grep KEY`) against current env vars — a long-lived orphan dev process can hold a stale `VRS_AI_BASE_URL` (this exact combo caused the Aug 17 incident: orphan held a decommissioned host, new value lacked `https://`).

## Photos on bridge tickets
- SASHA intake (`server/vrs-sasha-intake.ts`) never populates `submissions.photos`; bridge tickets show "no photo attached" in VRS Express unless the sender supplied `appliance_photos` (DEV test payloads send `[]`). "No photos" on a bridge ticket is expected sender behavior, not a rendering regression.
