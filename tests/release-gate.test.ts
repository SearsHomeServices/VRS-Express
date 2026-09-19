import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runReleaseChecks } from "../script/release-checks";
import criticalConfig from "../vitest.critical.config";

describe("release safeguards", () => {
  it("requires both type checking and critical workflows in order", () => {
    const run = vi.fn();
    runReleaseChecks(run);
    expect(run.mock.calls).toEqual([["check"], ["test:critical"]]);
  });

  it.each(["check", "test:critical"])("blocks release if %s fails", (failed) => {
    const calls: string[] = [];
    expect(() => runReleaseChecks((script) => {
      calls.push(script);
      if (script === failed) throw new Error("expected failure");
    })).toThrow("expected failure");
    expect(calls).toEqual(failed === "check" ? ["check"] : ["check", "test:critical"]);
  });

  it("keeps the configured publish and direct build paths behind the gate", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts.build).toBe("tsx script/build.ts");
    expect(pkg.scripts["test:critical"]).toBe("vitest run --config vitest.critical.config.ts");
    expect(readFileSync(".replit", "utf8")).toMatch(/build\s*=\s*\["npm",\s*"run",\s*"build"\]/);
    const build = readFileSync("script/build.ts", "utf8");
    expect(build.indexOf("runReleaseChecks();")).toBeGreaterThan(0);
    expect(build.indexOf("runReleaseChecks();")).toBeLessThan(build.indexOf('await rm("dist"'));
  });

  it("does not inherit the unrestricted live integration test glob", () => {
    expect(criticalConfig.test?.include).not.toContain("tests/**/*.test.ts");
    expect(criticalConfig.test?.include).toContain("tests/release-gate.test.ts");
    expect(criticalConfig.test?.include).toContain("tests/snowflake-*.test.ts");
    expect(criticalConfig.test?.include).toContain("tests/vrs-bridge-photo-*.test.ts");
    // Coaching export parity intentionally targets a running authenticated app.
    expect(criticalConfig.test?.include).not.toContain("tests/tech-pdc-export-parity.test.ts");
  });
});