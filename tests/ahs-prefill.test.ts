import fs from "node:fs";
import ts from "typescript";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AHS_PREFILL_APPLIANCE_SQL,
  AHS_PREFILL_CORE_SQL,
  createAhsPrefillLookup,
  type AhsPrefillLookupResult,
  type AhsPrefillQuery,
} from "../server/services/snowflake-lookup";
import {
  applyAhsServiceOrderPrefill,
  boundedAhsPrefillLookup,
  isAhsOrder,
  keepPrefilledFromPrevious,
  toAhsPrefillResponse,
  withoutPrefilledFields,
} from "../server/ahs-prefill";
import { isAhsServiceOrderPrefillEnabled } from "../server/featureFlags";
import { ahsDetailsSchema, parseStoredAhsDetails, type AhsDetails } from "../shared/ahs-details";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.AHS_SERVICE_ORDER_PREFILL_ENABLED;
});

// Values a test must never see in logs or browser responses.
const SECRET_CONTRACT = "AHS-DISPATCH-551200";
const SECRET_PARTNER = "AHS-PARTNER-77";
const SECRET_CLIENT = "American Home Shield";

const coreRow = { BRAND: " Whirlpool ", PARTNER_ID: SECRET_PARTNER, CLIENT_NAME: SECRET_CLIENT };
const applianceRow = {
  SERVICE_CONTRACT_ID: ` ${SECRET_CONTRACT}/0003 `,
  MODEL_NUMBER: "WTW5000DW1",
  SERIAL_NUMBER: " C31290822 ",
};

const ok = (rows: any[]): PromiseSettledResult<any[]> => ({ status: "fulfilled", value: rows });
const failed = (message: string): PromiseSettledResult<any[]> => ({ status: "rejected", reason: new Error(message) });

function mockQuery(results: PromiseSettledResult<any[]>[] = [ok([coreRow]), ok([applianceRow])]) {
  return vi.fn<AhsPrefillQuery>(async () => results);
}

const found: AhsPrefillLookupResult = {
  status: "found",
  serviceContractId: `${SECRET_CONTRACT}/0003`,
  brand: "Whirlpool",
  modelNumber: "WTW5000DW1",
  serialNumber: "C31290822",
  partnerId: SECRET_PARTNER,
  clientName: SECRET_CLIENT,
};

const details: AhsDetails = {
  contractNumber: "",
  customerName: "Maria Gonzalez",
  customerAddress: "742 Evergreen Terrace, Hagerstown, MD 21740",
  applianceKind: "washer",
  brand: "",
  modelNumber: "",
  serialNumber: "",
  applianceAge: 4,
  applianceLocation: "Laundry room",
  applianceGrade: "mid",
  applianceColor: "White",
  failureCause: "normal-wear",
  laborAmount: 120,
  taxAmount: 15.6,
  parts: [{
    partNumber: "WPW10503278",
    quantity: 1,
    description: "Electronic control board",
    unitPrice: 245,
    partFunction: "Controls wash cycle timing",
    failureReason: "Relay failed",
  }],
};

describe("Snowflake AHS service-order lookup", () => {
  it("filters on the padded unit and the service order in both statements", async () => {
    const query = mockQuery();
    const lookup = createAhsPrefillLookup(query);
    await lookup("8175", "12345678");
    const [statements] = query.mock.calls[0];
    expect(statements.map((s) => s.binds)).toEqual([["8175", "12345678"], ["8175", "12345678"]]);
    for (const sql of [AHS_PREFILL_CORE_SQL, AHS_PREFILL_APPLIANCE_SQL]) {
      expect(sql).toContain("FROM PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL");
      expect(sql).toContain("WHERE SVC_UN_NO = LPAD(?, 7, '0') AND SO_NO = ? LIMIT 1");
    }
    expect(statements.map((s) => s.sqlText)).toEqual([AHS_PREFILL_CORE_SQL, AHS_PREFILL_APPLIANCE_SQL]);
    // LPAD(?, 7, '0') turns district 8175 into unit 0008175.
    expect("8175".padStart(7, "0")).toBe("0008175");
  });

  it("keeps the unverified columns out of the confirmed statement", () => {
    expect(AHS_PREFILL_CORE_SQL).toBe(
      "SELECT MFG_BND_NM AS BRAND, CMB_THD_PTY_ID AS PARTNER_ID, CLIENT_NM AS CLIENT_NAME " +
      "FROM PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL WHERE SVC_UN_NO = LPAD(?, 7, '0') AND SO_NO = ? LIMIT 1",
    );
    expect(AHS_PREFILL_APPLIANCE_SQL).toBe(
      "SELECT CTA_NO AS SERVICE_CONTRACT_ID, PSV_ITM_MDL_NO AS MODEL_NUMBER, PSV_MDS_SRL_NO AS SERIAL_NUMBER " +
      "FROM PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL WHERE SVC_UN_NO = LPAD(?, 7, '0') AND SO_NO = ? LIMIT 1",
    );
  });

  it.each([["817", "12345678"], ["8175", "1234567"], ["81a5", "12345678"], ["8175", "8175-12345678"], ["", ""]])(
    "rejects district %j / SO %j before querying", async (district, so) => {
      const query = mockQuery();
      expect(await createAhsPrefillLookup(query)(district, so)).toEqual({ status: "not_found" });
      expect(query).not.toHaveBeenCalled();
    });

  it("trims values and treats blanks as missing", async () => {
    const query = mockQuery([ok([{ ...coreRow, CLIENT_NAME: "   " }]), ok([{ ...applianceRow, SERIAL_NUMBER: "" }])]);
    expect(await createAhsPrefillLookup(query)("8175", "12345678")).toEqual({
      status: "found",
      serviceContractId: `${SECRET_CONTRACT}/0003`,
      brand: "Whirlpool",
      modelNumber: "WTW5000DW1",
      serialNumber: undefined,
      partnerId: SECRET_PARTNER,
      clientName: undefined,
    });
  });

  it("still returns brand when the unverified statement fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = mockQuery([ok([coreRow]), failed("SQL compilation error: invalid identifier 'CTA_NO'")]);
    const result = await createAhsPrefillLookup(query)("8175", "12345678");
    expect(result).toMatchObject({ status: "found", brand: "Whirlpool", partnerId: SECRET_PARTNER });
    expect(result).not.toHaveProperty("modelNumber");
    expect(result).not.toHaveProperty("serviceContractId");
    expect(warn.mock.calls.flat().join(" ")).toContain("invalid identifier 'CTA_NO'");
  });

  it("maps no row to not_found and an outage to unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await createAhsPrefillLookup(mockQuery([ok([]), ok([])]))("8175", "12345678")).toEqual({ status: "not_found" });
    expect(await createAhsPrefillLookup(mockQuery([failed("auth"), ok([applianceRow])]))("8175", "12345678"))
      .toEqual({ status: "unavailable" });
    const connectFails = vi.fn<AhsPrefillQuery>(async () => { throw new Error("connect failed"); });
    expect(await createAhsPrefillLookup(connectFails)("8175", "12345678")).toEqual({ status: "unavailable" });
  });

  it("never logs returned values", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await createAhsPrefillLookup(mockQuery())("8175", "12345678");
    await createAhsPrefillLookup(mockQuery([ok([coreRow]), failed("invalid identifier 'PSV_ITM_MDL_NO'")]))("8175", "12345679");
    const logged = spies.flatMap((spy) => spy.mock.calls.flat()).join(" ");
    for (const value of ["Whirlpool", "WTW5000DW1", "C31290822", SECRET_CONTRACT, SECRET_PARTNER, SECRET_CLIENT]) {
      expect(logged).not.toContain(value);
    }
  });

  it("coalesces concurrent lookups and keys the cache by district and SO", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const query = vi.fn<AhsPrefillQuery>(async () => { await gate; return [ok([coreRow]), ok([applianceRow])]; });
    const lookup = createAhsPrefillLookup(query);
    const first = lookup("8175", "12345678");
    expect(lookup(" 8175 ", "12345678")).toBe(first);
    const otherUnit = lookup("8176", "12345678");
    release();
    await Promise.all([first, otherUnit]);
    await lookup("8175", "12345678");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("caches found ~6h, not_found ~2min and unavailable a few seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const byKey: Record<string, PromiseSettledResult<any[]>[]> = {
      "11111111": [ok([coreRow]), ok([applianceRow])],
      "22222222": [ok([]), ok([])],
      "33333333": [failed("warehouse down"), failed("warehouse down")],
    };
    const query = vi.fn<AhsPrefillQuery>(async (statements) => byKey[statements[0].binds[1]]);
    const lookup = createAhsPrefillLookup(query);
    const calls = async (so: string) => { await lookup("8175", so); return query.mock.calls.length; };
    for (const so of Object.keys(byKey)) await lookup("8175", so);
    expect(query).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(await calls("33333333")).toBe(3); // unavailable still cached at 4s
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await calls("33333333")).toBe(4);

    await vi.advanceTimersByTimeAsync(115_000);
    expect(await calls("22222222")).toBe(5); // not_found expired after 2 min
    expect(await calls("11111111")).toBe(5);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(await calls("11111111")).toBe(6);
  });

  it("gives up after its 5s deadline and aborts the statements", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const query = vi.fn<AhsPrefillQuery>((_statements, s) => { signal = s; return new Promise(() => {}); });
    const pending = createAhsPrefillLookup(query)("8175", "12345678");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({ status: "unavailable" });
    expect(signal.aborted).toBe(true);
  });
});

describe("AHS prefill rules", () => {
  it("fills blank fields with the dispatch number taken before the '/'", () => {
    const next = applyAhsServiceOrderPrefill(details, found);
    expect(next).toMatchObject({
      contractNumber: SECRET_CONTRACT,
      brand: "Whirlpool",
      modelNumber: "WTW5000DW1",
      serialNumber: "C31290822",
      prefilledFields: ["contractNumber", "brand", "modelNumber", "serialNumber"],
    });
    expect(details.brand).toBe(""); // input not mutated
    // What gets stored still parses as valid details (parsing may add
    // schema defaults such as techRecommendation).
    expect(parseStoredAhsDetails(JSON.stringify(next))).toMatchObject(next);
  });

  it("never overwrites a value the tech entered", () => {
    const next = applyAhsServiceOrderPrefill(
      { ...details, contractNumber: "TECH-1", modelNumber: "TECH-MODEL", serialNumber: "   " },
      found,
    );
    expect(next.contractNumber).toBe("TECH-1");
    expect(next.modelNumber).toBe("TECH-MODEL");
    expect(next.serialNumber).toBe("C31290822");
    expect(next.prefilledFields).toEqual(["brand", "serialNumber"]);
  });

  it("handles undefined fields once the form makes them optional", () => {
    const optional = { contractNumber: undefined, brand: undefined, modelNumber: "M1" } as {
      contractNumber?: string; brand?: string; modelNumber?: string; serialNumber?: string;
    };
    const next = applyAhsServiceOrderPrefill(optional, { status: "found", brand: "GE" });
    expect(next).toEqual({ contractNumber: undefined, brand: "GE", modelNumber: "M1", prefilledFields: ["brand"] });
  });

  it("lists only fields actually filled and drops client-sent prefilledFields", () => {
    const forged = { ...details, brand: "Tech brand", prefilledFields: ["brand", "modelNumber"] as AhsDetails["prefilledFields"] };
    const brandOnly = applyAhsServiceOrderPrefill(forged, { status: "found", brand: "Whirlpool" });
    expect(brandOnly.brand).toBe("Tech brand");
    expect(brandOnly).not.toHaveProperty("prefilledFields");
    expect(applyAhsServiceOrderPrefill(forged, { status: "not_found" })).not.toHaveProperty("prefilledFields");
    expect(applyAhsServiceOrderPrefill(forged, { status: "unavailable" })).toEqual(withoutPrefilledFields(forged));
    expect(withoutPrefilledFields(forged)).not.toHaveProperty("prefilledFields");
  });

  it("skips a contract ID with no dispatch part and values the schema would reject", () => {
    const next = applyAhsServiceOrderPrefill(details, {
      status: "found", serviceContractId: " /0003", brand: "B".repeat(101), modelNumber: "M1",
    });
    expect(next.contractNumber).toBe("");
    expect(next.brand).toBe("");
    expect(next.prefilledFields).toEqual(["modelNumber"]);
    expect(ahsDetailsSchema.safeParse({ ...next, contractNumber: "X", brand: "B", serialNumber: "S" }).success).toBe(true);
  });

  it("keeps provenance for unchanged previously prefilled values on resubmit", () => {
    const previous = applyAhsServiceOrderPrefill(details, found);
    const resent = { ...withoutPrefilledFields(previous), modelNumber: "CHANGED-BY-TECH" };
    expect(keepPrefilledFromPrevious(resent, previous).prefilledFields).toEqual(["contractNumber", "brand", "serialNumber"]);
    expect(keepPrefilledFromPrevious(resent, { ...previous, prefilledFields: undefined })).not.toHaveProperty("prefilledFields");
    expect(keepPrefilledFromPrevious({ ...resent, prefilledFields: ["modelNumber"] }, null).prefilledFields).toEqual(["modelNumber"]);
  });

  it("recognizes AHS orders with the shared warranty derivation", () => {
    expect(isAhsOrder(found)).toBe(true);
    expect(isAhsOrder({ status: "found", partnerId: "AHS123" })).toBe(true);
    expect(isAhsOrder({ status: "found", partnerId: "SPHW1", clientName: "Sears Home Warranty" })).toBe(false);
    expect(isAhsOrder({ status: "found", brand: "Whirlpool" })).toBe(false);
    expect(isAhsOrder({ status: "not_found" })).toBe(false);
    expect(isAhsOrder(null)).toBe(false);
  });

  it("builds a browser response without contract, partner or client values", () => {
    const response = toAhsPrefillResponse(found);
    expect(response).toEqual({
      status: "found",
      appliance: { brand: "Whirlpool", modelNumber: "WTW5000DW1", serialNumber: "C31290822" },
      hasDispatchNumber: true,
    });
    const json = JSON.stringify(response);
    for (const value of [SECRET_CONTRACT, SECRET_PARTNER, SECRET_CLIENT, "0003"]) expect(json).not.toContain(value);
    expect(toAhsPrefillResponse({ status: "found", partnerId: "AHS1", brand: "GE" }))
      .toEqual({ status: "found", appliance: { brand: "GE" }, hasDispatchNumber: false });
    expect(toAhsPrefillResponse({ ...found, partnerId: "SPHW1", clientName: "Sears Protect" })).toEqual({ status: "not_found" });
    expect(toAhsPrefillResponse({ status: "not_found" })).toEqual({ status: "not_found" });
    expect(toAhsPrefillResponse({ status: "unavailable" })).toEqual({ status: "unavailable" });
  });

  it("bounds the submit-path lookup and never rejects", async () => {
    const lookup = vi.fn(async () => found);
    expect(await boundedAhsPrefillLookup(" 8175-12345678 ", lookup)).toBe(found);
    expect(lookup).toHaveBeenCalledWith("8175", "12345678");
    expect(await boundedAhsPrefillLookup("8175-1234", lookup)).toEqual({ status: "not_found" });
    expect(await boundedAhsPrefillLookup("8175-12345678", async () => { throw new Error("boom"); }))
      .toEqual({ status: "unavailable" });
    vi.useFakeTimers();
    const hung = boundedAhsPrefillLookup("8175-12345678", () => new Promise(() => {}), 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await hung).toEqual({ status: "unavailable" });
  });

  it.each([["true", true], ["TRUE", false], ["1", false], [" true", false], [undefined, false]])(
    "flag value %j → %s", (value, expected) => {
      if (value === undefined) delete process.env.AHS_SERVICE_ORDER_PREFILL_ENABLED;
      else process.env.AHS_SERVICE_ORDER_PREFILL_ENABLED = value;
      expect(isAhsServiceOrderPrefillEnabled()).toBe(expected);
    });
});

// Execute the real route registration with hermetic auth/Snowflake doubles,
// like tests/tech-warranty-lookup.test.ts.
const routes = fs.readFileSync("server/routes.ts", "utf8");
const start = routes.indexOf('  app.get("/api/tech/ahs-prefill"');
const end = routes.indexOf('  app.get(["/api/tech/lookup-warranty"', start);
if (start < 0 || end < 0) throw new Error("AHS prefill route boundaries not found");
const routeJs = ts.transpileModule(routes.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(options: { enabled?: boolean; result?: AhsPrefillLookupResult | Error } = {}) {
  const { enabled = true, result = found } = options;
  const lookup = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const app = express();
  const authenticateToken = (req: any, res: any, next: any) => {
    if (!req.headers["x-test-role"]) return res.status(401).json({ error: "Unauthorized" });
    req.user = { id: 1, ldapId: "fixture", role: req.headers["x-test-role"] };
    next();
  };
  const requireRole = (...roles: string[]) => (req: any, res: any, next: any) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Forbidden" });
  new Function(
    "app", "authenticateToken", "requireRole", "isAhsServiceOrderPrefillEnabled",
    "ahsPrefillLookupLog", "AHS_PREFILL_WINDOW_MS", "AHS_PREFILL_MAX_PER_WINDOW",
    "toAhsPrefillResponse", "boundedAhsPrefillLookup", "fetchAhsServiceOrderPrefill", routeJs,
  )(app, authenticateToken, requireRole, () => enabled, new Map(), 3600000, 2,
    toAhsPrefillResponse, boundedAhsPrefillLookup, lookup);
  return { app, lookup };
}

const url = "/api/tech/ahs-prefill?district=8175&serviceOrder=12345678";

describe("GET /api/tech/ahs-prefill", () => {
  it.each(["technician", "flexed_technician"])("returns only appliance fields to %s", async (role) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { app, lookup } = harness();
    const res = await request(app).get(url).set("x-test-role", role);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(lookup).toHaveBeenCalledWith("8175", "12345678");
    expect(res.body).toEqual({
      status: "found",
      appliance: { brand: "Whirlpool", modelNumber: "WTW5000DW1", serialNumber: "C31290822" },
      hasDispatchNumber: true,
    });
    for (const value of [SECRET_CONTRACT, SECRET_PARTNER, SECRET_CLIENT]) expect(res.text).not.toContain(value);
  });

  it("answers not_found for an order that is not AHS", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { app } = harness({ result: { ...found, partnerId: "SPHW1", clientName: "Sears Home Warranty" } });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.body).toEqual({ status: "not_found" });
  });

  it("is disabled without touching Snowflake when the flag is off", async () => {
    const { app, lookup } = harness({ enabled: false });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "unavailable" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["", "admin", "vrs_agent", "provider_1099"])("rejects role %j before Snowflake", async (role) => {
    const { app, lookup } = harness();
    const req = request(app).get(url);
    const res = await (role ? req.set("x-test-role", role) : req);
    expect(res.status).toBe(role ? 403 : 401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "district=817&serviceOrder=12345678",
    "district=8175&serviceOrder=1234567",
    "district=8175&serviceOrder=8175-12345678",
    "serviceOrder=12345678",
  ])("rejects malformed input %s before Snowflake", async (query) => {
    const { app, lookup } = harness();
    const res = await request(app).get(`/api/tech/ahs-prefill?${query}`).set("x-test-role", "technician");
    expect(res.status).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rate-limits per user", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, lookup } = harness();
    await request(app).get(url).set("x-test-role", "technician");
    await request(app).get(url).set("x-test-role", "technician");
    expect((await request(app).get(url).set("x-test-role", "technician")).status).toBe(429);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("degrades to unavailable on outages and unexpected errors", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const result of [{ status: "unavailable" } as const, new Error("internal detail")]) {
      const { app } = harness({ result });
      const res = await request(app).get(url).set("x-test-role", "technician");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "unavailable" });
    }
  });
});

describe("POST /api/submissions prefill wiring", () => {
  const handler = routes.slice(
    routes.indexOf("const createSubmissionHandler = async"),
    routes.indexOf("const submission = idempResult.submission!;"),
  );

  it("discards client provenance and applies the prefill before the details are stored", () => {
    expect(handler).toContain("withoutPrefilledFields(parsed.data.ahsDetails)");
    const lookupAt = handler.indexOf("boundedAhsPrefillLookup(parsed.data.serviceOrder, fetchAhsServiceOrderPrefill)");
    const applyAt = handler.indexOf("applyAhsServiceOrderPrefill(ahsDetails, prefill)");
    const storeAt = handler.indexOf("ahsDetails: ahsDetails ? JSON.stringify(ahsDetails) : null");
    expect(lookupAt).toBeGreaterThan(0);
    expect(lookupAt).toBeLessThan(handler.indexOf("await fetchProcIdForServiceOrder(parsed.data.serviceOrder)"));
    expect(applyAt).toBeGreaterThan(lookupAt);
    expect(storeAt).toBeGreaterThan(applyAt);
    expect(handler).toMatch(/ahsDetails && isAhsServiceOrderPrefillEnabled\(\)/);
    expect(handler).toMatch(/finalWarrantyType === "american_home_shield" && isAhsOrder\(prefill\)/);
  });
});
