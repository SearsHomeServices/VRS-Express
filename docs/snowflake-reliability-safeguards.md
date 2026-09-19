# Snowflake service-order lookup safeguards

## Scope and behavior

- Service-order classification now returns a discriminated `FOUND`, `NOT_FOUND`,
  or retryable `LOOKUP_UNAVAILABLE` result. Only a successfully executed query
  with zero rows is `NOT_FOUND`. A row with null classification fields is still
  `FOUND`; its fields retain the existing `"Not Found"` display values.
- Missing configuration, SDK/key/authentication/connect/query failures,
  deadline expiry and overload are unavailable, never missing.
- Successful query SQL, bound parameters, field trimming, key-pair handling and
  lazy ESM/CJS `createRequire` SDK loader are preserved.
- Process-local admission allows four active classification lookups and 32 queued
  unique keys. Trimming and the existing prefix removal happen before in-flight
  deduplication. Duplicate callers share the same promise and deadline.
- Deadline includes queue time and defaults to 15 seconds. The existing
  `SNOWFLAKE_OP_TIMEOUT_MS` override is bounded to 1–60,000 milliseconds for
  classification. Timed-out queued work is removed. Completion releases the slot;
  late resolution/rejection cannot update the cache or release another slot.
- An abort listener destroys the SDK connection even if connect has not called
  back. A late connect callback destroys it again and cannot execute a query.
  Abort also attempts statement cancellation. SDK cleanup is best effort; the
  application cannot guarantee remote cancellation acknowledgement.
- Classification cache is capped at 5,000 entries: found six hours, genuine
  missing two minutes, unavailable five seconds. Queue-overflow results are not
  cached. All cache and concurrency controls are per process, not distributed.

## Consumers

- Submission and warranty lookup return HTTP 503, `Retry-After: 5`,
  `code: LOOKUP_UNAVAILABLE`, a retryable flag and a safe retry message before
  deriving or persisting classification. Normal successful behavior is unchanged.
- Admin repair skips writes entirely for unavailable lookups, preserving existing
  fields/classification. Response separates `unavailable` and `failedUpdates`
  from `notFound`, with a retryable flag. No automatic backfill is introduced.
- Technician warranty lookup shows a lookup-error message and retry button rather
  than presenting lookup errors as a missing provider. The server still enforces
  submission availability independently of the UI.
- Admin backfill displays `Unavailable` and `Failed Updates` counts plus retry
  guidance, preserving existing result labels. Submission outage handling uses
  a narrow error callback without reset/navigation effects and explicitly tells
  technicians their form and uploaded photos remain available for another submit.
- Photo lookup and technician synchronization keep their existing behavior and
  limits; the new admission/cache contract specifically covers service-order
  classification. Photo routes were not modified.

## Credential-free verification

Focused command:

`npx vitest run tests/snowflake-lookup.test.ts tests/snowflake-loader.test.ts tests/snowflake-consumers.test.ts tests/snowflake-ui.test.ts`

- Scheduler tests cover normalized deduplication, active/queue bounds, deadlines,
  abort, late rejection, released slots, distinct outcome TTLs.
- Isolated fake SDK fixtures cover statement cancellation, connection destruction
  before and after late connect, suppression of late query execution and unchanged
  encrypted-key success. Fixtures execute as real tsx ESM and a production-style
  CJS fixture bundle, with an environment allowlist (no workspace credentials).
- Consumer tests exercise actual repair persistence suppression and genuine-result
  writes. Source guard assertions check submit/warranty 503 ordering; these are
  not full authenticated route integration tests.
- UI tests mount the actual new admin status component in jsdom, and run the
  actual shared submission error callback through a TanStack mutation observer,
  verifying retained draft/form/photo data, no success cleanup, friendly retry
  messaging, and preserved duplicate/ordinary error handling. They do not mount
  the full authenticated submission page.
- Existing real SDK loader tests load package metadata only, not credentials or
  network connections. No live Snowflake query, production mutation, dependency
  install, app restart or full application build is part of verification.

Result: all 25 focused tests passed; `git diff --check` passed. Application-wide
type checking and browser verification are left to the owning agent.