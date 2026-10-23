import assert from "node:assert/strict";
import Module from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { probeSnowflakeSDK, fetchProcIdForServiceOrder } from "../../server/services/snowflake";

// Executed in isolated processes, never with workspace credentials. Hook Node's
// CJS loader (not Vitest mocks) so the real ESM/createRequire path is exercised.
const mode = process.argv[2];
const nodeModule = Module as unknown as {
  _load: (id: string, ...args: unknown[]) => any;
  _cache: Record<string, unknown>;
};
assert.equal(
  Object.keys(nodeModule._cache).some((key) => key.includes("/snowflake-sdk/")),
  false,
  "importing the service must not eagerly load the SDK",
);
const originalLoad = nodeModule._load;
let sdkLoads = 0;
let metadataLoads = 0;
let destroys = 0;
let cancels = 0;
let executes = 0;
let expectedPrivateKey: string;
const sdk = {
  createConnection(options: Record<string, unknown>) {
    assert.equal(options.authenticator, "SNOWFLAKE_JWT");
    assert.equal(options.privateKey, expectedPrivateKey);
    assert.equal(options.database, "PRD_TPMS");
    assert.equal(options.schema, "HSTECH");
    return {
      connect(callback: (error: null, connection: unknown) => void) {
        if (mode === "late-connect") {
          setTimeout(() => callback(null, this), 80);
          return;
        }
        callback(null, this);
      },
      execute(options: { sqlText: string; binds: string[]; complete: Function }) {
        executes++;
        if (executes === 1) {
          // District first ("000000" padded), then the most recent order.
          assert.match(options.sqlText, /ORDER BY CASE WHEN SVC_UN_NO = LPAD\(\?, 7, '0'\) THEN 0 ELSE 1 END, SO_CRT_DT DESC NULLS LAST LIMIT 1$/);
          assert.deepEqual(options.binds, ["123456", "0000000"]);
        } else {
          // The unordered fallback, only after the ordered statement failed.
          assert.equal(mode, "ordered-fails");
          assert.match(options.sqlText, /WHERE SO_NO = \? LIMIT 1$/);
          assert.deepEqual(options.binds, ["123456"]);
        }
        if (mode === "ordered-fails" && executes === 1) {
          options.complete(new Error("SQL compilation error: invalid identifier 'SO_CRT_DT'"), null, undefined);
          return { cancel(callback: Function) { cancels++; callback(null); } };
        }
        if (mode === "query-timeout") {
          return { cancel(callback: Function) { cancels++; callback(null); } };
        }
        options.complete(null, null, [{ CMB_THD_PTY_ID: " test-proc ", CLIENT_NM: " test-client " }]);
        return { cancel(callback: Function) { cancels++; callback(null); } };
      },
      destroy(callback: Function) {
        destroys++;
        callback(null);
      },
    };
  },
};

nodeModule._load = function (id, ...args) {
  if (id === "snowflake-sdk") {
    sdkLoads++;
    if (mode === "failure" && sdkLoads === 1) {
      throw Object.assign(new Error("synthetic SDK load failure"), { code: "MODULE_NOT_FOUND" });
    }
    if (mode !== "real") return sdk;
  }
  if (id === "snowflake-sdk/package.json") {
    metadataLoads++;
    if (mode === "metadata-missing") throw new Error("synthetic metadata unavailable");
    if (mode !== "real") return { version: "test-version" };
  }
  return originalLoad.call(this, id, ...args);
};

try {
  const first = probeSnowflakeSDK();
  if (mode === "failure") {
    assert.equal(first.ok, false);
    assert.equal(first.errorCode, "MODULE_NOT_FOUND");
    assert.match(first.error!, /snowflake-sdk is not available.*synthetic SDK load failure/);
    assert.match(first.errorStack!, /synthetic SDK load failure/);
    assert.ok(first.errorStack!.split(" | ").length <= 5);
    // A failed attempt must not poison the cache; the next call retries.
    assert.deepEqual(probeSnowflakeSDK(), { ok: true, version: "test-version" });
  } else if (mode === "real") {
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.match(first.version!, /^\d+\.\d+\.\d+/);
  } else if (mode === "metadata-missing") {
    assert.deepEqual(first, { ok: true, version: undefined });
  } else {
    assert.deepEqual(first, { ok: true, version: "test-version" });
    assert.equal(metadataLoads, 1, "version lookup uses the compatible loader too");
  }
  probeSnowflakeSDK();
  assert.equal(sdkLoads, mode === "failure" ? 2 : 1, "successful SDK loads are cached");

  if (["encrypted-key", "ordered-fails", "late-connect", "query-timeout"].includes(mode)) {
    // Synthetic ephemeral key, not a real credential; no SDK/network connection.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expectedPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.SNOWFLAKE_PRIVATE_KEY = privateKey.export({
      type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "test-only",
    }).toString().replace(/\n/g, " ");
    process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE = "test-only";
    if (mode === "ordered-fails") {
      const warn = console.warn;
      console.warn = () => {};
      try {
        assert.deepEqual(await fetchProcIdForServiceOrder("000000-123456"), {
          status: "FOUND", procId: "test-proc", clientNm: "test-client",
        });
      } finally {
        console.warn = warn;
      }
      assert.equal(executes, 2, "the fallback statement ran after the ordered one failed");
      assert.equal(destroys, 1, "both statements share one connection, released once");
    } else if (mode !== "encrypted-key") {
      assert.deepEqual(await fetchProcIdForServiceOrder("000000-123456"), {
        status: "LOOKUP_UNAVAILABLE", retryable: true,
      });
      assert.ok(destroys >= 1, "deadline destroys even before connect callback");
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(executes, mode === "late-connect" ? 0 : 1);
      assert.equal(cancels, mode === "query-timeout" ? 1 : 0);
      if (mode === "late-connect") assert.ok(destroys >= 2, "late connect destroyed again");
    } else {
      assert.deepEqual(await fetchProcIdForServiceOrder("000000-123456"), {
      status: "FOUND", procId: "test-proc", clientNm: "test-client",
      });
      assert.equal(destroys, 1, "lookup still releases its connection");
      assert.equal(executes, 1, "no fallback when the ordered statement succeeds");
    }
    assert.equal(sdkLoads, 1, "lookups reuse the probed SDK");
  }
  console.log("snowflake-loader: passed");
} finally {
  nodeModule._load = originalLoad;
}