import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = path.join(root, "tests/fixtures/snowflake-loader.mts");
let buildDir: string;
let otherCwd: string;

beforeAll(async () => {
  // Keep the bundle inside the project so Node resolves the installed SDK,
  // just like dist/index.cjs, but execute from a different cwd.
  buildDir = await mkdtemp(path.join(root, ".snowflake-loader-test-"));
  otherCwd = await mkdtemp(path.join(tmpdir(), "snowflake-loader-cwd-"));
  const source = await readFile(fixture, "utf8");
  // Production CJS cannot contain top-level await. The static service import
  // stays top-level, with the test runner in an async function.
  const split = source.indexOf("// Executed in isolated processes");
  await build({
    stdin: {
      contents: source.slice(0, split) + "\n(async () => {\n" + source.slice(split) +
        "\n})().catch(error => { console.error(error); process.exitCode = 1; });",
      resolveDir: path.dirname(fixture),
      loader: "ts",
    },
    platform: "node",
    bundle: true,
    format: "cjs",
    minify: true,
    external: ["snowflake-sdk"],
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: path.join(buildDir, "index.cjs"),
    // import.meta is deliberately on the ESM-only side of the __filename guard.
    logOverride: { "empty-import-meta": "silent" },
  });
});

afterAll(async () => {
  if (buildDir) await rm(buildDir, { recursive: true, force: true });
  if (otherCwd) await rm(otherCwd, { recursive: true, force: true });
});

describe.each(["tsx ESM", "production CJS"])("Snowflake lazy loader in %s", (runtime) => {
  it.each(["real", "cached", "failure", "metadata-missing", "encrypted-key", "late-connect", "query-timeout"])("%s", async (mode) => {
    const args = runtime === "tsx ESM"
      ? ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), fixture, mode]
      : [path.join(buildDir, "index.cjs"), mode];
    const { stdout } = await exec(process.execPath, args, {
      cwd: otherCwd,
      // Explicit allowlist: no Snowflake credentials or other app secrets.
      env: { PATH: process.env.PATH, NODE_ENV: runtime === "tsx ESM" ? "development" : "production", SNOWFLAKE_OP_TIMEOUT_MS: "25" },
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
    expect(stdout).toContain("snowflake-loader: passed");
  });
});