import fs from "node:fs";
import ts from "typescript";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { deriveWarrantyFromProcId, type WarrantyLookupResponse } from "../shared/warranty";
import { resolveServiceOrderProduct } from "../server/services/wom-work-order";

// Execute the actual route registration with hermetic auth/Snowflake doubles.
// No DB or ticket fixture is supplied: first-time orders must work without one.
const source = fs.readFileSync("server/routes.ts", "utf8");
const start = source.indexOf('  app.get(["/api/tech/lookup-warranty"');
const end = source.indexOf('  app.post("/api/admin/backfill-proc-ids"', start);
if (start < 0 || end < 0) throw new Error("Warranty route boundaries not found");
const routeJs = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness() {
  const lookup = vi.fn().mockResolvedValue({
    status: "FOUND", procId: "private-proc", clientNm: "American Home Shield",
  });
  // Appliance type (HS_SP_CD -> division); not found unless a test says so.
  const applianceLookup = vi.fn().mockResolvedValue({ status: "not_found" });
  // WOM product category; unavailable (flag off) unless a test says so.
  const womLookup = vi.fn().mockResolvedValue({ status: "unavailable" });
  const app = express();
  const authenticateToken = (req: any, res: any, next: any) => {
    if (!req.headers["x-test-role"]) return res.status(401).json({ error: "Unauthorized" });
    req.user = { id: 1, ldapId: "fixture", role: req.headers["x-test-role"] };
    next();
  };
  const requireRole = (...roles: string[]) => (req: any, res: any, next: any) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Forbidden" });
  new Function(
    "app", "authenticateToken", "requireRole", "fetchProcIdForServiceOrder",
    "fetchServiceOrderApplianceType", "lookupWomProductCategory", "resolveServiceOrderProduct",
    "deriveWarrantyFromProcId", "warrantyLookupLog", "WARRANTY_LOOKUP_WINDOW_MS",
    "WARRANTY_LOOKUP_MAX_PER_WINDOW", routeJs,
  )(app, authenticateToken, requireRole, lookup, applianceLookup, womLookup, resolveServiceOrderProduct,
    deriveWarrantyFromProcId, new Map(), 3600000, 2);
  return { app, lookup, applianceLookup, womLookup };
}

const so = "1234-12345678";
const url = `/api/tech/lookup-warranty?serviceOrder=${so}`;

describe("technician pre-submission warranty lookup", () => {
  it.each(["technician", "flexed_technician"])("allows %s with no prior ticket and returns only classification", async role => {
    const { app, lookup } = harness();
    const res = await request(app).get(url).set("x-test-role", role);
    expect(res.status).toBe(200);
    expect(lookup).toHaveBeenCalledWith(so);
    expect(res.body).toEqual({
      serviceOrder: so,
      derived: deriveWarrantyFromProcId("private-proc", "American Home Shield"),
    });
    expect(res.body.derived?.warrantyType).toBe("american_home_shield");
    expect(JSON.stringify(res.body)).not.toContain("private-proc");
    expect(res.body).not.toHaveProperty("clientNm");
  });

  it("supports older open forms using the service order in the path", async () => {
    const { app, lookup } = harness();
    const res = await request(app).get(`/api/tech/lookup-warranty/${so}`).set("x-test-role", "technician");
    expect(res.status).toBe(200);
    expect(lookup).toHaveBeenCalledWith(so);
  });

  it.each(["", "admin", "agent", "provider"])("rejects unauthorized role %s before Snowflake", async role => {
    const { app, lookup, applianceLookup } = harness();
    const res = await request(app).get(url).set("x-test-role", role);
    expect(res.status).toBe(role ? 403 : 401);
    expect(lookup).not.toHaveBeenCalled();
    expect(applianceLookup).not.toHaveBeenCalled();
  });

  it("rejects malformed service orders before Snowflake", async () => {
    const { app, lookup, applianceLookup } = harness();
    expect((await request(app).get("/api/tech/lookup-warranty?serviceOrder=bad").set("x-test-role", "technician")).status).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
    expect(applianceLookup).not.toHaveBeenCalled();
  });

  it("shares rate limits across both URL formats", async () => {
    const { app, lookup, applianceLookup } = harness();
    await request(app).get(url).set("x-test-role", "technician");
    await request(app).get(`/api/tech/lookup-warranty/${so}`).set("x-test-role", "technician");
    expect((await request(app).get(url).set("x-test-role", "technician")).status).toBe(429);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(applianceLookup).toHaveBeenCalledTimes(2);
  });

  it("preserves manual selection for a successful unclassified lookup", async () => {
    const { app, lookup } = harness();
    lookup.mockResolvedValue({ status: "NOT_FOUND", procId: null, clientNm: null });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ serviceOrder: so, derived: null });
  });

  it("does not treat a Snowflake outage as an unclassified warranty", async () => {
    const { app, lookup } = harness();
    lookup.mockResolvedValue({ status: "LOOKUP_UNAVAILABLE" });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.body.code).toBe("LOOKUP_UNAVAILABLE");
  });

  it("fails explicitly on unexpected errors without exposing internals", async () => {
    const { app, lookup } = harness();
    lookup.mockRejectedValue(new Error("internal detail"));
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Lookup failed" });
  });

  it("adds the appliance type to a known warranty and at the top level", async () => {
    const { app, applianceLookup } = harness();
    applianceLookup.mockResolvedValue({ status: "found", applianceType: "laundry", product: "Washer", serviceUnit: "0001234" });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.status).toBe(200);
    expect(applianceLookup).toHaveBeenCalledWith(so);
    expect(res.body).toEqual({
      serviceOrder: so,
      derived: { ...deriveWarrantyFromProcId("private-proc", "American Home Shield"), applianceType: "laundry" },
      applianceType: "laundry",
      serviceOrderProduct: { text: "Washer", source: "snowflake" },
    });
  });

  it("returns the appliance type when the warranty is unknown, keeping derived null for older forms", async () => {
    const { app, lookup, applianceLookup } = harness();
    lookup.mockResolvedValue({ status: "FOUND", procId: "UNRECOGNIZED", clientNm: "Some Retailer" });
    applianceLookup.mockResolvedValue({ status: "found", applianceType: "hvac", product: "HVAC", serviceUnit: "0001234" });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.status).toBe(200);
    // Older forms treat any non-null derived as a locked warranty.
    expect(res.body).toEqual({
      serviceOrder: so, derived: null, applianceType: "hvac",
      serviceOrderProduct: { text: "HVAC", source: "snowflake" },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/UNRECOGNIZED|Some Retailer/);
  });

  it.each([
    ["found without a mapped type", async () => ({ status: "found" })],
    ["not found", async () => ({ status: "not_found" })],
    ["unavailable", async () => ({ status: "unavailable" })],
    ["rejecting", async () => { throw new Error("appliance statement failed"); }],
  ])("leaves the warranty answer unchanged when the appliance lookup is %s", async (_label, impl) => {
    const { app, applianceLookup } = harness();
    applianceLookup.mockImplementation(impl);
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      serviceOrder: so,
      derived: deriveWarrantyFromProcId("private-proc", "American Home Shield"),
    });
    expect(res.body.derived).not.toHaveProperty("applianceType");
  });

  it("still answers 503 on a ProcID outage even when the appliance type is known", async () => {
    const { app, lookup, applianceLookup } = harness();
    lookup.mockResolvedValue({ status: "LOOKUP_UNAVAILABLE" });
    applianceLookup.mockResolvedValue({ status: "found", applianceType: "laundry" });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.status).toBe(503);
    expect(res.body).not.toHaveProperty("applianceType");
    expect(res.body).not.toHaveProperty("serviceOrderProduct");
  });

  it("uses an explicit query URL without changing the global query client", () => {
    const form = fs.readFileSync("client/src/pages/tech-submit.tsx", "utf8");
    expect(form).toContain("/api/tech/lookup-warranty?serviceOrder=${encodeURIComponent(watchedServiceOrder)}");
    expect(form).toContain("enabled: isValidSo && !isProvider1099");
  });
});

describe("technician warranty lookup: the service order's product (WOM, else Snowflake)", () => {
  const AHS = deriveWarrantyFromProcId("private-proc", "American Home Shield");

  it("prefers the WOM Product Category and maps the type from it", async () => {
    const { app, applianceLookup, womLookup } = harness();
    womLookup.mockResolvedValue({ status: "found", productCategory: "WASHERDD - WASHER, DIRECT DRIVE" });
    applianceLookup.mockResolvedValue({ status: "found", applianceType: "refrigeration", product: "Refrigerator", serviceUnit: "0001234" });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.status).toBe(200);
    // WOM is asked under the padded district: unit and 8-digit SO.
    expect(womLookup).toHaveBeenCalledWith("1234", "12345678");
    const expected: WarrantyLookupResponse = {
      serviceOrder: so,
      derived: { ...AHS!, applianceType: "laundry" },
      applianceType: "laundry",
      serviceOrderProduct: { text: "WASHERDD - WASHER, DIRECT DRIVE", source: "wom" },
    };
    expect(res.body).toEqual(expected);
  });

  it.each([
    ["unavailable", { status: "unavailable" }],
    ["not found", { status: "not_found" }],
    ["found without a category", { status: "found" }],
  ])("falls back to Snowflake HS_SP_CD when WOM is %s", async (_label, wom) => {
    const { app, applianceLookup, womLookup } = harness();
    womLookup.mockResolvedValue(wom);
    applianceLookup.mockResolvedValue({ status: "found", applianceType: "laundry", product: "Washer", serviceUnit: "0001234" });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.body).toEqual({
      serviceOrder: so,
      derived: { ...AHS, applianceType: "laundry" },
      applianceType: "laundry",
      serviceOrderProduct: { text: "Washer", source: "snowflake" },
    });
  });

  it("asks WOM again under the unit Snowflake resolved when the district has no order", async () => {
    const { app, applianceLookup, womLookup } = harness();
    applianceLookup.mockResolvedValue({ status: "found", applianceType: "laundry", product: "Washer", serviceUnit: "0008366" });
    womLookup.mockImplementation(async (unit: string) => unit === "0008366"
      ? { status: "found", productCategory: "DRYERE - DRYER, ELECTRIC" }
      : { status: "not_found" });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(womLookup.mock.calls).toEqual([["1234", "12345678"], ["0008366", "12345678"]]);
    expect(res.body.serviceOrderProduct).toEqual({ text: "DRYERE - DRYER, ELECTRIC", source: "wom" });
    expect(res.body.applianceType).toBe("laundry");
  });

  it("omits both when neither source knows the product", async () => {
    const { app, womLookup } = harness();
    womLookup.mockResolvedValue({ status: "not_found" });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.body).toEqual({ serviceOrder: so, derived: AHS });
  });

  it("keeps derived null for older forms when only the product is known", async () => {
    const { app, lookup, womLookup } = harness();
    lookup.mockResolvedValue({ status: "NOT_FOUND", procId: "Not Found", clientNm: "Not Found" });
    womLookup.mockResolvedValue({ status: "found", productCategory: "RANGEGAS - RANGE, GAS" });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.body).toEqual({
      serviceOrder: so,
      derived: null,
      applianceType: "cooking",
      serviceOrderProduct: { text: "RANGEGAS - RANGE, GAS", source: "wom" },
    });
  });

  it("a WOM failure never changes the warranty answer", async () => {
    const { app, womLookup } = harness();
    womLookup.mockRejectedValue(new Error("wom exploded"));
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ serviceOrder: so, derived: AHS });
  });

  it("a slow WOM falls back to Snowflake inside the WOM budget", async () => {
    const previous = process.env.WOM_TIMEOUT_MS;
    process.env.WOM_TIMEOUT_MS = "50";
    try {
      const { app, applianceLookup, womLookup } = harness();
      womLookup.mockImplementation(() => new Promise(() => {}));
      applianceLookup.mockResolvedValue({ status: "found", applianceType: "hvac", product: "HVAC", serviceUnit: "0001234" });
      const started = Date.now();
      const res = await request(app).get(url).set("x-test-role", "technician");
      expect(Date.now() - started).toBeLessThan(2000);
      expect(res.body.serviceOrderProduct).toEqual({ text: "HVAC", source: "snowflake" });
    } finally {
      if (previous === undefined) delete process.env.WOM_TIMEOUT_MS;
      else process.env.WOM_TIMEOUT_MS = previous;
    }
  });
});
