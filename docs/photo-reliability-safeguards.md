# Bridge photo reliability safeguards (DEV only)

Capture remains behind the existing DEV photo/pilot gate; this change does not enable production capture. Legacy media paths are unchanged.

## Capture and recovery

An additive per-ticket `vrs_bridge_photo_captures` receipt records the original intake time, immutable 30-day retention deadline, expected/verified counts, state, attempts, and next attempt. Intake starts capture asynchronously. Startup and one-minute recovery passes seed missing receipts and process up to 100 due tickets with at most three concurrent tickets, oldest due first (earliest intake breaks ties). Every attempted receipt advances its next-attempt time, including thrown failures, so continually failing older tickets cannot monopolize each batch. Each selected batch receives due warnings before any media reads; one ticket's capture or alert failure cannot abort other tickets. Failed attempts retry while the two-hour source window remains open. Recovery checks already stored bytes after source expiry, but never contacts an expired source or invents a refresh endpoint. It marks incomplete capture terminal and requests fresh photos.

Every save downloads the private copy and compares bytes; existing copies must also be readable before capture is counted. A transient read failure can recover on the next pass. Read verification does not prove photographic quality or future storage availability. The authenticated proxy continues to serve usable source bytes if private saving fails; scheduled receipt reconciliation remains authoritative.

After one hour, incomplete capture opens an actionable `bridge_photo_capture_at_risk` incident. At two hours it opens `bridge_photo_capture_failed`; scheduler/database failures open `bridge_photo_recovery_unavailable` immediately. Existing Admin → System Health incident history displays ticket ID, counts, source deadline, retention deadline, and the operator action. No source URLs, signed URLs, provider exception details, or secrets enter incidents. Recovery clears ticket capture incidents. Incident creation precedes terminal status persistence so an alert delivery failure retries.

## Retention and lifecycle

Deletion and hourly TTL-only sweeps are independent of capture/pilot flags, and startup also sweeps. Listing/deletion is scoped to the private `vrs-bridge-photos/` prefix. Keys have no environment namespace and DEV/production may share the private directory, so scheduled cleanup must never infer orphans from one environment's database. Ticket deletion snapshots the Bridge source URLs before cascading DB deletion and removes only copies whose ticket/index/source hash match that payload. Missing/mismatched provenance leaves the bytes for TTL cleanup; orphan cleanup is therefore deferred to TTL when safe provenance is unavailable. Retry uses the persisted intake deadline, never save time. A stopped application cannot run sweeps, so physical deletion may lag until restart.

Official `searchReplitDocs` search for prefix-scoped lifecycle support returned no relevant documentation. The installed GCS SDK supports `matchesPrefix`, `daysSinceCustomTime`, and bucket metadata updates. However, a **read-only** `bucket.getMetadata()` probe against the configured private bucket returned **403**. Existing policies and metageneration therefore cannot be inspected or safely preserved. No lifecycle policy or bucket setting was mutated; no write-permission claim is inferred from that read denial. Platform/operator access is required before lifecycle automation can be safely installed. It must preserve existing rules, use the full private directory plus bridge-only prefix, and anchor expiry to intake (not object creation on retry). Broad bucket TTL rules are prohibited.

## Migration

`scripts/bridge-photo-reliability-dev.sql` is the exact idempotent migration. It creates only the isolated receipt table/index with cascade-on-ticket-delete. Applied via the development database tool during implementation. No startup DDL and no production database mutations were performed. Future environments need this migration explicitly reviewed/applied before enabling capture. Do not use a broad schema push as a substitute.

## Verification

Focused tests: `tests/vrs-bridge-photo-reliability.test.ts` and `tests/vrs-bridge-photo-storage.test.ts`. Coverage includes retry recovery, pre-expiry warning, terminal expiry without upstream fetch, immutable retry deadlines, unreadable-byte verification/recovery, flag-off cleanup, deleted-ticket/orphan cleanup, scoped preservation of unrelated media, and bounded sweep pagination. The live GCS round-trip remains opt-in. These tests are not proof of real Sasha expiration or physical-device behavior.