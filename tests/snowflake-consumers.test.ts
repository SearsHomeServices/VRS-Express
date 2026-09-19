import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { applyProcIdRepair } from "../server/services/snowflake-lookup";

describe("Snowflake consumers", () => {
  it("never overwrites existing classifications during unavailable repair", async () => {
    const record = { procId: "known", clientNm: "Not Found", warrantyType: "sears_protect" };
    const update = vi.fn(async fields => Object.assign(record, fields));
    expect(await applyProcIdRepair({ status: "LOOKUP_UNAVAILABLE", retryable: true }, update))
      .toBe("LOOKUP_UNAVAILABLE");
    expect(update).not.toHaveBeenCalled();
    expect(record.procId).toBe("known");
    expect(record.warrantyType).toBe("sears_protect");
  });

  it.each(["FOUND", "NOT_FOUND"] as const)("persists a genuine %s result", async status => {
    const update = vi.fn(async () => {});
    const fields = status === "FOUND" ? { procId: "known", clientNm: "client" }
      : { procId: "Not Found", clientNm: "Not Found" };
    expect(await applyProcIdRepair({ status, ...fields }, update)).toBe(status);
    expect(update).toHaveBeenCalledExactlyOnceWith(fields);
  });

  it("guards submit and warranty derivation with retryable 503 before using lookup fields", () => {
    const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    for (const variable of ["procIdResult", "result"]) {
      expect(routes).toMatch(new RegExp(
        `if \\(${variable}\\.status === "LOOKUP_UNAVAILABLE"\\) \\{[\\s\\S]*?status\\(503\\)[\\s\\S]*?retryable: true,[\\s\\S]*?\\}\\);\\s*\\}\\s*const (?:derivedWarranty|derived) = deriveWarrantyFromProcId\\(${variable}\\.procId`,
      ));
    }
  });
});