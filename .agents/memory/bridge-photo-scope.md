---
name: Bridge photo delivery scope
description: DEV-only durable photo approval, retention boundary, and source expiration limitation
---
Bridge photo delivery and private durable copies are approved for DEV only. The user explicitly confirmed 30-day retention on 2026-09-18, measured from ticket intake and continuing after closure, not indefinite storage. Production enablement requires separate approval.

**Why:** The user requested isolated DEV verification while preserving production and legacy media behavior. Sasha signed media links can expire and return 410; its same-origin resource policy can also block direct embedding.

**How to apply:** Capture private copies before source expiration, retain ticket-level authorization, and clean up expired/deleted-ticket copies. Do not invent refresh endpoints or promise recovery of already-expired sources. No supported refresh contract was found on 2026-09-16. Real Sasha expiration verification and physical-device zoom must not be represented as passing based only on mocked images or emulated touch. Authenticated browser photo fetches must validate local proxy paths even when a feature flag is enabled, because stale payloads can still contain external URLs.

For acceptance evidence, distinguish intake-time capture, startup recovery,
and capture triggered by opening a photo.

**Why:** A stopped DEV workflow can recover still-live photos when started;
successful viewing afterward does not prove they were saved when intake arrived.

**How to apply:** Inspect private-object creation metadata before the first
authorized photo request, and report which capture path the evidence establishes.

Photo-gallery regression evidence must exercise response wiring and mounted
component behavior, not just source-string assertions or a mocked gallery.

**Why:** A successful desktop photo check did not prevent the Admin audit
response from omitting bridge context. A photo component can work in isolation
while its parent receives no photos.

**How to apply:** Cover the real endpoint's enabled/disabled payload and the
parent viewer's rendered empty/mixed attachment states. Keep these automated
checks separate from real-expiration and physical-device acceptance evidence.

Ticket-switch regressions must inspect every committed DOM, not only the
settled result after effects. Gallery state, including the open lightbox,
must be isolated by ticket.

**Why:** Clearing loaded photos in a passive effect can still commit the old
ticket's images once before that effect runs, and leave a lightbox open for
the next ticket. A final-DOM assertion misses the initial stale-image commit.

**How to apply:** Capture committed image sources while switching between
loaded tickets and while detail/photo requests are deferred. Resolve old
requests after the switch and confirm they cannot replace current images.

Object-level storage access does not imply permission to configure bucket lifecycle rules.

**Why:** The 2026-09-19 lifecycle assessment received 403 for bucket metadata, despite working private-object access. Existing lifecycle rules could not be inspected or safely preserved.

**How to apply:** Do not claim platform-enforced deletion while this permission boundary remains. Require scoped lifecycle access and preserve unrelated bucket rules before changing lifecycle settings; application cleanup still depends on a running process.

Do not infer object ownership from absence of a ticket in the current environment's database.

**Why:** DEV and production can share the private object prefix while having different ticket rows; a flag-independent cleanup process can otherwise mistake another environment's photos for orphans.

**How to apply:** Scheduled cleanup uses the stored retention deadline. Immediate ticket-deletion cleanup must prove source identity; without that provenance, leave the object for expiration rather than deleting by numeric ticket ID alone.