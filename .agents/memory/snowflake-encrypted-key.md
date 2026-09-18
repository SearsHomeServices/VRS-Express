---
name: Snowflake private key can be an ENCRYPTED PKCS#8 PEM
description: The app's Snowflake key-pair auth supports an encrypted private key + passphrase; format traps that cause silent "Not Found" lookups.
---

# Snowflake encrypted private key + passphrase

The app authenticates to Snowflake with key-pair JWT auth (`authenticator: "SNOWFLAKE_JWT"`). `SNOWFLAKE_PRIVATE_KEY` may be an **encrypted** PKCS#8 PEM (`-----BEGIN ENCRYPTED PRIVATE KEY-----`); the passphrase lives in its own secret `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE`. The connection code decrypts it locally (`node:crypto createPrivateKey({key,passphrase}).export({type:'pkcs8',format:'pem'})`) into an unencrypted PEM before handing it to the SDK.

**Format traps that wasted time:**
- Secrets are often pasted with **spaces instead of newlines**; the key normalizer must rebuild 64-char body lines and must match ANY `BEGIN/END [A-Z0-9 ]*PRIVATE KEY` label (an `ENCRYPTED` header must NOT be re-wrapped as a plain `PRIVATE KEY`, which corrupts it).
- `error:1E08010C DECODER routines::unsupported` = the PEM couldn't be parsed (e.g. encrypted key handed to an unencrypted-only path).
- `error:1C800064 bad decrypt` = the passphrase does not match THIS key (different keypair, or wrong passphrase). The user pasting the **public** key, or a passphrase from a different keypair, are both common.
- A wrong/missing key makes `fetchProcIdForServiceOrder` store the literal string **"Not Found"** for `procId`/`clientNm` — the UI then shows "Not Found" for every ticket.

**Why:** the original "Not Found" outage was purely a credential problem (key encrypted + passphrase mismatch + missing account/username/warehouse), not app logic.

**How to apply:** distinguish SDK loading, key parsing, authentication, and query results when diagnosing a lookup. Loader verification needs no credentials; separately authorized credential checks should reuse application connection handling and a bound read-only query. Do not infer a need to deploy from an ESM loader error or automatically backfill stored results. See [runtime verification](snowflake-prod-access.md) for the eval-entrypoint trap.
