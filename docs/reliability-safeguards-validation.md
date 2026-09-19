# Reliability safeguards: change and validation record

## Scope

Targeted safeguards around existing photo, service-order lookup, and release
flows. No new dependencies, production deployment, production database writes,
credential changes, or bucket lifecycle mutations were performed.

## Changes and checks

| Safeguard | Implementation | Verification |
| --- | --- | --- |
| Flag-independent 30-day cleanup | Startup/hourly expiry sweep runs outside the Pilot gate; expiry is intake-based, not renewed by retries. | Photo storage/reliability tests cover deadlines and scheduler wiring. |
| Safe shared-prefix deletion | Scheduled cleanup is TTL-only. Immediate deletion requires matching source hash, submission/index metadata and object path, with object-generation targeting when available. Missing provenance defers deletion to expiry. | Cross-environment mismatch, missing provenance, matching-source deletion and unrelated-object preservation tests. |
| Persistent photo capture | Additive per-ticket receipt table records immutable deadlines, counts, attempts and retry/terminal state. Recovery runs every minute with three-ticket concurrency and isolated failures. | Persistent recovery/deadline tests; DEV table existence confirmed; restarted DEV reported six verified photos on three tickets and explicit failures for 39 older expired-source tickets. This is recovery evidence, not fresh-intake evidence. |
| Storage verification | Download/read checks on both newly written and preexisting private copies before marking capture successful. | Tests reject unreadable existing objects and verify retry/recovery without unnecessary source fetching. |
| Capture alerts | System Health warning after one hour of unresolved capture; terminal alert at the assumed two-hour source deadline; successful recovery clears related incidents. Batch alerts precede potentially slow media reads. | Alert/retry isolation tests and authenticated DEV browser inspection of counts, source deadline, retention deadline and corrective instructions. |
| Explicit Snowflake outcomes | FOUND, NOT_FOUND, LOOKUP_UNAVAILABLE. Only a successful zero-row query means missing. | Fake-SDK outcome, authentication/error, cancellation and actual ESM/CJS loader tests. No live credentialed Snowflake query was used. |
| Lookup load control | Four active/32 queued unique lookups, normalized in-flight deduplication, queue-inclusive timeout, cancellation/destruction including late connect, capped outcome-specific caches. | Bound/deadline/late-completion/cache tests. |
| Safe outage consumers | Submission/warranty outage returns retryable 503 before classification persistence. Repair preserves existing fields and reports unavailable/failed-update counts separately. | Consumer and mounted component tests; DEV browser interception confirms technician data/photos persist on 503 and Admin renders all aggregated repair counters and retry guidance. |
| Release gate | Direct build entrypoint executes TypeScript then critical tests before deleting/building artifacts. No skip flag. Publishing continues to use this same build entrypoint. | Gate ordering/failure/config tests and complete npm build. A real failing viewer assertion blocked bundling during validation, confirming fail-closed behavior. |

## Release test isolation

Final validation: `npm run build` passed the strict TypeScript check, all
**323 critical tests across 27 files**, and both client/server bundling.
One opt-in real GCS integration test was skipped. The DEV app was restarted
after the final code changes; `/api/healthz` returned `ok: true`, and the login
page rendered normally. The guarded Snowflake `import.meta` CJS build warning
remains non-fatal; both ESM/CJS loader regression checks passed.

Critical tests use a restricted configuration, not the unrestricted test glob.
The server-dependent coaching export parity suite remains available separately
via its existing command; it is not a release prerequisite. The opt-in real GCS
integration test remains skipped unless deliberately enabled. Release checks do
not require a running app, provider credentials, or actual email/SMS delivery.

The Agent media test's single-event-loop-tick assumption was replaced with a
bounded condition-based wait. All stale-image commit and exact next-ticket image
assertions remain; no test was disabled to make the build pass.

## Browser evidence and limitations

- System Health incident details: passed.
- Technician lookup outage/retry control: passed.
- Technician submit 503 retains form fields, review data and photo previews:
  passed with browser-only interception; no real submission or SMS.
- Admin repair counters and retry guidance: passed with the route's actual
  HTTP 200 aggregated-result contract. An initial HTTP 503 mock tested a
  whole-request failure instead; the corrected test passed without app edits.
- Development HMR WebSocket warnings were observed; tested UI flows still worked.

## Storage lifecycle blocker

Bucket metadata access returned HTTP 403. Existing lifecycle rules cannot be
inspected/preserved with current permissions, so no bucket lifecycle was changed.
The app refuses expired copies and sweeps while running, but deletion during
application downtime is **not yet platform-enforced**. Before lifecycle setup,
obtain scoped permission and preserve unrelated bucket rules/objects; restrict
any rule to the bridge-photo prefix and align it with original intake deadlines.

## Schema and production rollout

The additive receipt table is in shared/schema.ts and was applied and verified
in DEV using scripts/bridge-photo-reliability-dev.sql. It is not startup DDL and
must not be run directly against managed production. A future Publish applies
the development-to-production schema diff; review it normally in Publish.

Capture remains DEV-only. Cleanup is deliberately flag-independent. Successful
classification behavior is preserved; **unavailable classification now blocks
submission with a retryable 503**, rather than accepting uncertain classification.
This is the intentional production behavior change if these safeguards are
published. Physical-device zoom, a fresh real Sasha intake through URL expiry,
and live Snowflake authentication were not certified by this validation.

Detailed behavior and focused test commands:
- docs/photo-reliability-safeguards.md
- docs/snowflake-reliability-safeguards.md