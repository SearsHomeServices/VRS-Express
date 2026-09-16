---
name: Bridge photo delivery scope
description: DEV-only photo proxy boundary and source expiration limitation
---
Bridge photo delivery is approved for DEV only. Keep production opt-in separate; do not add a production Sasha hostname or permanent image storage without explicit approval.

**Why:** The user requested isolated DEV verification while preserving production and legacy media behavior. Sasha signed media links can expire and return 410; its same-origin resource policy can also block direct embedding.

**How to apply:** Do not treat proxying as a solution to expiration. No documented refresh mechanism was found during investigation on 2026-09-16; request a supported upstream contract or approval for storage before promising lasting access. Authenticated browser photo fetches must validate local proxy paths even when a feature flag is enabled, because stale payloads can still contain external URLs.