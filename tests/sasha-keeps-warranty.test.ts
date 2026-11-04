// SASHA's data is trusted as sent: the ProcID lookup never replaces the
// warranty SASHA sent (POST /vrs/authorize → createTicket → the submit
// handler). Source-level, like the submit-handler checks in ahs-prefill.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = readFileSync("server/routes.ts", "utf8");

describe("SASHA tickets keep SASHA's warranty", () => {
  it("SASHA's createTicket asks the submit handler to keep the caller's warranty", () => {
    const createTicket = routes.slice(routes.indexOf("async createTicket({ body, user }, internalOptions) {"));
    const call = createTicket.slice(0, createTicket.indexOf("const responseBody"));
    expect(call).toContain("skipAppVrsAiEnroll: true,");
    expect(call).toContain("keepCallerWarranty: true,");
  });

  it("the submit handler only uses the derived warranty when the caller's is not kept", () => {
    expect(routes).toContain("const useDerivedWarranty = !!derivedWarranty && !internalOptions?.keepCallerWarranty;");
    expect(routes).toContain("const finalWarrantyType = useDerivedWarranty ? derivedWarranty!.warrantyType : parsed.data.warrantyType;");
    expect(routes).toContain("const finalWarrantyProvider = useDerivedWarranty ? derivedWarranty!.warrantyProvider : (parsed.data.warrantyProvider || null);");
  });
});
