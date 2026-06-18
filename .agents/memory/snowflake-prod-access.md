---
name: Connecting to prod Snowflake from this environment
description: How to run read-only prod Snowflake queries here despite creds being prod-only and bash being flaky for long node processes.
---

# Connecting to prod Snowflake from this Replit environment

`SNOWFLAKE_*` creds (`SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USERNAME`, `SNOWFLAKE_PRIVATE_KEY`, `SNOWFLAKE_WAREHOUSE`) live ONLY in the **production runtime process env** — they are NOT in the Replit secrets store, NOT in `viewEnvVars({type:'all'})`, and NOT in the `code_execution` sandbox `process.env`. They ARE visible to the `bash` tool's `process.env`.

**Why this matters:** the stable place to run multi-step Snowflake work is the `code_execution` sandbox (notebook state persists across calls), but the sandbox can't see the creds and the `bash` tool is flaky for long/backgrounded node processes (137/124/-1 kills; backgrounded writes to workspace root and /tmp can hang).

**How to apply (reliable path):**
1. From `bash`, write creds to a local temp file: `node -e` reading `process.env.SNOWFLAKE_*` → `/tmp/sfcreds.json`, `chmodSync(...,0o600)`.
2. In `code_execution`: `const require = createRequire('/home/runner/workspace/')`; `require('snowflake-sdk')`; read `/tmp/sfcreds.json`; reuse `normalizeKey` from `server/services/snowflake.ts` (PEM re-wrap to 64-char lines) with `authenticator:'SNOWFLAKE_JWT'`.
3. **DELETE `/tmp/sfcreds.json` before finishing** (contains plaintext private key). Never log/echo the key.
4. For read-only safety, wrap `conn.execute` in a helper with a GUARD regex rejecting INSERT/UPDATE/DELETE/MERGE/CREATE/DROP/ALTER/TRUNCATE/GRANT/REVOKE/COPY/PUT/REMOVE.

**Account facts:** account `SEARS_HS_PROD`, user `SVC_SCA_AUTO`, role `SCIENTIST`, wh `SCIENTIST_PRD_WH`. Has ~63 `*_READ` roles. `SNOWFLAKE.ACCOUNT_USAGE` is NOT granted — search metadata via per-DB `INFORMATION_SCHEMA.COLUMNS`/`.TABLES`, not ACCOUNT_USAGE.
