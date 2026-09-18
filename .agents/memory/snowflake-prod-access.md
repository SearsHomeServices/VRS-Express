---
name: Snowflake runtime verification
description: Avoid misleading eval probes and historical assumptions about credential availability.
---

# Snowflake runtime verification

Check SDK loading through a real ESM file entrypoint and a production-style CJS bundle, not only `tsx -e`.

**Why:** an earlier successful eval probe was incorrectly treated as evidence that the development server could load the SDK. Eval and file entrypoints can expose different module globals, masking `require is not defined`.

**How to apply:** use credential-free loader checks first, then inspect the development workflow's startup probe after a restart. A successful SDK load does not prove authentication or query permissions.

Do not assume credentials are production-only or available identically across tools. Never copy credentials into temporary files or another runtime.

**Why:** historical notes contradicted each other as environment availability changed; copying secrets is unnecessary for loader verification.

**How to apply:** use the environment-secrets and integrations skills for credential operations. Live queries require separate authorization and should use the application's existing connection handling.

Snowflake ACCOUNT_USAGE access was not granted during prior metadata investigations.

**Why:** account-wide catalog queries failed even though application-table reads worked.

**How to apply:** prefer per-database INFORMATION_SCHEMA for read-only metadata exploration, verifying current permissions rather than assuming account-wide access.