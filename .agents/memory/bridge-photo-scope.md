---
name: Bridge photo delivery scope
description: DEV-only durable photo approval, retention boundary, and source expiration limitation
---
Bridge photo delivery and private durable copies are approved for DEV only. The user explicitly approved private storage on 2026-09-17 without specifying retention; use a limited 30-day DEV retention policy, not indefinite storage. Production enablement requires separate approval.

**Why:** The user requested isolated DEV verification while preserving production and legacy media behavior. Sasha signed media links can expire and return 410; its same-origin resource policy can also block direct embedding.

**How to apply:** Capture private copies before source expiration, retain ticket-level authorization, and clean up expired/deleted-ticket copies. Do not invent refresh endpoints or promise recovery of already-expired sources. No supported refresh contract was found on 2026-09-16. Real Sasha expiration verification and physical-device zoom must not be represented as passing based only on mocked images or emulated touch. Authenticated browser photo fetches must validate local proxy paths even when a feature flag is enabled, because stale payloads can still contain external URLs.

For acceptance evidence, distinguish intake-time capture, startup recovery,
and capture triggered by opening a photo.

**Why:** A stopped DEV workflow can recover still-live photos when started;
successful viewing afterward does not prove they were saved when intake arrived.

**How to apply:** Inspect private-object creation metadata before the first
authorized photo request, and report which capture path the evidence establishes.