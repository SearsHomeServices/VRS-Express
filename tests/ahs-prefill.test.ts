import fs from "node:fs";
import ts from "typescript";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AHS_PREFILL_APPLIANCE_SQL,
  AHS_PREFILL_CORE_SQL,
  createAhsPrefillLookup,
  type AhsPrefillLookupResult,
  type AhsPrefillQuery,
  type ProcIdResult,
} from "../server/services/snowflake-lookup";
import {
  applyAhsServiceOrderPrefill,
  applyAhsSubmitPrefill,
  boundedAhsPrefillLookup,
  boundedServerDerivedAhs,
  isAhsOrder,
  keepPrefilledFromPrevious,
  lookupAhsPrefillSources,
  mergeAhsPrefillSources,
  needsServerDerivedAhs,
  prefilledFieldNames,
  redactServerPrefilledCustomer,
  restoreRedactedCustomerFromPrevious,
  toAhsPrefillResponse,
  withoutPrefilledFields,
  withoutServerOnlyFields,
  type AhsPrefillSources,
} from "../server/ahs-prefill";
import { lookupHssomOrder, type HssomOrderLookupResult } from "../server/services/hssom-order-lookup";
import { isAhsServiceOrderPrefillEnabled } from "../server/featureFlags";
import { ahsDetailsSchema, parseStoredAhsDetails, type AhsDetails } from "../shared/ahs-details";

vi.mock("../server/services/hssom-order-lookup", () => ({
  lookupHssomOrder: vi.fn(),
}));
const hssomLookup = vi.mocked(lookupHssomOrder);

beforeEach(() => {
  hssomLookup.mockReset();
  hssomLookup.mockResolvedValue({ status: "unavailable" });
});

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
      hasCustomer: false,
    });
    const json = JSON.stringify(response);
    for (const value of [SECRET_CONTRACT, SECRET_PARTNER, SECRET_CLIENT, "0003"]) expect(json).not.toContain(value);
    expect(toAhsPrefillResponse({ status: "found", partnerId: "AHS1", brand: "GE" }))
      .toEqual({ status: "found", appliance: { brand: "GE" }, hasDispatchNumber: false, hasCustomer: false });
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

// HSSOM Order Lookup values a test must never see in a browser response or log.
const SECRET_NAME = "Rosalind Featherstonehaugh";
const SECRET_ADDRESS = "1209 Quillfeather Lane, Frederick, MD 21701";
const SECRET_HSSOM_CONTRACT = "HSSOM-DISPATCH-880044";

const hssomFound: HssomOrderLookupResult = {
  status: "found",
  customerName: ` ${SECRET_NAME} `,
  customerAddress: SECRET_ADDRESS,
  serviceContractId: `${SECRET_HSSOM_CONTRACT}/0007`,
  brand: "Maytag",
  modelNumber: "MVW6230HW",
  serialNumber: "HS-SERIAL-1",
  purchaseDate: "2019-06-14",
};

const blankDetails: AhsDetails = {
  ...details,
  customerName: undefined,
  customerAddress: undefined,
  applianceAge: undefined,
};

const ahsWarranty = { finalWarrantyType: "american_home_shield", derivedWarrantyType: "american_home_shield" };
const sources = (
  snowflake: AhsPrefillLookupResult,
  hssom: HssomOrderLookupResult,
): AhsPrefillSources => ({ snowflake, hssom });

// The server-filled part of the details, and the same part after the stored
// JSON goes through parseStoredAhsDetails (null if the details stop parsing).
const prefillPart = (d: Partial<AhsDetails>) => ({
  contractNumber: d.contractNumber || undefined,
  brand: d.brand || undefined,
  modelNumber: d.modelNumber || undefined,
  serialNumber: d.serialNumber || undefined,
  customerName: d.customerName,
  customerAddress: d.customerAddress,
  purchaseYear: d.purchaseYear,
  prefilledFields: d.prefilledFields,
});
const storedPrefill = (d: AhsDetails) => {
  const stored = parseStoredAhsDetails(JSON.stringify(d));
  return stored && prefillPart(stored);
};

describe("HSSOM customer prefill merge", () => {
  it("takes Snowflake first for dispatch/appliance fields and fills gaps from HSSOM", () => {
    const values = mergeAhsPrefillSources(
      { status: "found", serviceContractId: `${SECRET_CONTRACT}/0003`, brand: "Whirlpool", partnerId: "AHS1" },
      hssomFound,
      new Date("2026-10-22T00:00:00Z"),
    );
    expect(values).toEqual({
      contractNumber: SECRET_CONTRACT,
      brand: "Whirlpool",
      modelNumber: "MVW6230HW",
      serialNumber: "HS-SERIAL-1",
      customerName: SECRET_NAME,
      customerAddress: SECRET_ADDRESS,
      purchaseYear: 2019,
    });
  });

  it("uses the HSSOM contract's part before '/' when Snowflake has none", () => {
    expect(mergeAhsPrefillSources({ status: "found", brand: "GE" }, hssomFound).contractNumber).toBe(SECRET_HSSOM_CONTRACT);
    expect(mergeAhsPrefillSources({ status: "unavailable" }, hssomFound).contractNumber).toBe(SECRET_HSSOM_CONTRACT);
    expect(mergeAhsPrefillSources({ status: "found", serviceContractId: " /0003" }, hssomFound).contractNumber)
      .toBe(SECRET_HSSOM_CONTRACT);
  });

  it("takes customer fields from HSSOM only", () => {
    // Even if a Snowflake row ever carried customer columns, they are ignored.
    const snowflakeWithCustomer = { ...found, customerName: "From Snowflake", customerAddress: "Snowflake St" } as AhsPrefillLookupResult;
    for (const hssom of [{ status: "unavailable" }, { status: "not_found" }] as HssomOrderLookupResult[]) {
      const values = mergeAhsPrefillSources(snowflakeWithCustomer, hssom);
      expect(values).not.toHaveProperty("customerName");
      expect(values).not.toHaveProperty("customerAddress");
    }
    expect(mergeAhsPrefillSources(snowflakeWithCustomer, hssomFound)).toMatchObject({
      customerName: SECRET_NAME, customerAddress: SECRET_ADDRESS,
    });
  });

  it("skips values over the schema's max lengths and what is stored still parses", () => {
    const long = mergeAhsPrefillSources({ status: "unavailable" }, {
      status: "found",
      customerName: "N".repeat(256),
      customerAddress: "A".repeat(1_001),
      brand: "B".repeat(101),
      modelNumber: "M1",
    });
    expect(long).toEqual({ modelNumber: "M1" });
    const atLimit = mergeAhsPrefillSources({ status: "unavailable" }, {
      status: "found", customerName: "N".repeat(255), customerAddress: "A".repeat(1_000),
    });
    expect(atLimit).toEqual({ customerName: "N".repeat(255), customerAddress: "A".repeat(1_000) });
    const next = applyAhsSubmitPrefill(blankDetails, sources({ status: "unavailable" }, {
      status: "found", customerName: "N".repeat(255), customerAddress: "A".repeat(1_000), purchaseDate: "2019-06-14",
    }), ahsWarranty);
    expect(next.prefilledFields).toEqual(["customerName", "customerAddress"]);
    expect(storedPrefill(next)).toEqual(prefillPart(next));
  });

  it("fills every blank field and lists exactly those in prefilledFields", () => {
    const next = applyAhsSubmitPrefill(blankDetails, sources(found, hssomFound), ahsWarranty);
    expect(next).toMatchObject({
      contractNumber: SECRET_CONTRACT,
      brand: "Whirlpool",
      modelNumber: "WTW5000DW1",
      serialNumber: "C31290822",
      customerName: SECRET_NAME,
      customerAddress: SECRET_ADDRESS,
      purchaseYear: 2019,
    });
    expect(next.prefilledFields).toEqual([
      "contractNumber", "brand", "modelNumber", "serialNumber", "customerName", "customerAddress",
    ]);
    expect(next.applianceAge).toBeUndefined();
    expect(storedPrefill(next)).toEqual(prefillPart(next));
  });

  it("never overwrites a value the tech entered, from either source", () => {
    const next = applyAhsSubmitPrefill(
      { ...blankDetails, customerName: "Tech Typed Name", contractNumber: "TECH-1", serialNumber: "TECH-SERIAL" },
      sources({ status: "found", brand: "Whirlpool", partnerId: "AHS1" }, hssomFound),
      ahsWarranty,
    );
    expect(next).toMatchObject({
      customerName: "Tech Typed Name",
      contractNumber: "TECH-1",
      serialNumber: "TECH-SERIAL",
      brand: "Whirlpool",
      modelNumber: "MVW6230HW",
      customerAddress: SECRET_ADDRESS,
    });
    expect(next.prefilledFields).toEqual(["brand", "modelNumber", "customerAddress"]);
  });

  it("fills Snowflake fields only when HSSOM is unavailable", () => {
    const next = applyAhsSubmitPrefill(blankDetails, sources(found, { status: "unavailable" }), ahsWarranty);
    expect(next.prefilledFields).toEqual(["contractNumber", "brand", "modelNumber", "serialNumber"]);
    expect(next.customerName).toBeUndefined();
    expect(next.customerAddress).toBeUndefined();
    expect(next).not.toHaveProperty("purchaseYear");
  });

  it("applies neither source when the Snowflake row is not AHS", () => {
    const sears = { ...found, partnerId: "SPHW1", clientName: "Sears Home Warranty" };
    expect(applyAhsSubmitPrefill(blankDetails, sources(sears, hssomFound), ahsWarranty)).toEqual(blankDetails);
  });

  it("fills from HSSOM alone when Snowflake has no row and the server-derived warranty is AHS", () => {
    for (const snowflake of [{ status: "unavailable" }, { status: "not_found" }] as AhsPrefillLookupResult[]) {
      const next = applyAhsSubmitPrefill(blankDetails, sources(snowflake, hssomFound), ahsWarranty);
      expect(next).toMatchObject({
        contractNumber: SECRET_HSSOM_CONTRACT,
        brand: "Maytag",
        modelNumber: "MVW6230HW",
        serialNumber: "HS-SERIAL-1",
        customerName: SECRET_NAME,
        customerAddress: SECRET_ADDRESS,
      });
      expect(next.prefilledFields).toHaveLength(6);
    }
  });

  it("does not fill from HSSOM alone unless the server derived AHS", () => {
    const hssomOnly = sources({ status: "unavailable" }, hssomFound);
    // Derived Sears / First American, or no derivation (tech-selected AHS).
    expect(applyAhsSubmitPrefill(blankDetails, hssomOnly, { finalWarrantyType: "sears_protect", derivedWarrantyType: "sears_protect" }))
      .toEqual(blankDetails);
    expect(applyAhsSubmitPrefill(blankDetails, hssomOnly, { finalWarrantyType: "first_american", derivedWarrantyType: "first_american" }))
      .toEqual(blankDetails);
    expect(applyAhsSubmitPrefill(blankDetails, hssomOnly, { finalWarrantyType: "american_home_shield", derivedWarrantyType: undefined }))
      .toEqual(blankDetails);
    // Not AHS at submit means no fill even with an AHS Snowflake row.
    expect(applyAhsSubmitPrefill(blankDetails, sources(found, hssomFound), { finalWarrantyType: "sears_protect", derivedWarrantyType: "sears_protect" }))
      .toEqual(blankDetails);
  });

  it("passes the HSSOM purchase year through only when the tech left the age blank", () => {
    const withAge = applyAhsSubmitPrefill({ ...blankDetails, applianceAge: 4 }, sources(found, hssomFound), ahsWarranty);
    expect(withAge).not.toHaveProperty("purchaseYear");
    expect(withAge.applianceAge).toBe(4);
    const blankAge = applyAhsSubmitPrefill(blankDetails, sources(found, hssomFound), ahsWarranty);
    expect(blankAge.purchaseYear).toBe(2019);
    expect(blankAge.applianceAge).toBeUndefined(); // never an invented age
    for (const purchaseDate of ["not a date", "1899-01-01", `${new Date().getUTCFullYear() + 1}-01-01`, ""]) {
      expect(mergeAhsPrefillSources(found, { ...hssomFound, purchaseDate })).not.toHaveProperty("purchaseYear");
    }
  });

  it("discards client-sent purchaseYear and prefilledFields", () => {
    const forged = { ...details, purchaseYear: 1999, prefilledFields: ["customerName"] as AhsDetails["prefilledFields"] };
    const cleaned = withoutServerOnlyFields(forged);
    expect(cleaned).not.toHaveProperty("purchaseYear");
    expect(cleaned).not.toHaveProperty("prefilledFields");
    expect(ahsDetailsSchema.safeParse({ ...details, purchaseYear: 2019 }).success).toBe(true);
    expect(ahsDetailsSchema.safeParse({ ...details, purchaseYear: 1800 }).success).toBe(false);
  });

  it("keeps customer-field provenance on resubmit when unchanged", () => {
    const previous = applyAhsSubmitPrefill(blankDetails, sources(found, hssomFound), ahsWarranty);
    const resent = { ...withoutServerOnlyFields(previous), customerAddress: "Changed by tech" };
    expect(keepPrefilledFromPrevious(resent, previous).prefilledFields).toEqual([
      "contractNumber", "brand", "modelNumber", "serialNumber", "customerName",
    ]);
  });

  it("logs field names only", () => {
    const next = applyAhsSubmitPrefill(blankDetails, sources(found, hssomFound), ahsWarranty);
    const names = prefilledFieldNames(next);
    expect(names).toEqual([
      "contractNumber", "brand", "modelNumber", "serialNumber", "customerName", "customerAddress", "purchaseYear",
    ]);
    const logged = names.join(",");
    for (const value of [SECRET_NAME, SECRET_ADDRESS, SECRET_CONTRACT, "2019", "Whirlpool"]) expect(logged).not.toContain(value);
    expect(prefilledFieldNames(blankDetails)).toEqual([]);
  });
});

describe("HSSOM lookup bounds", () => {
  it("looks up both sources in parallel and never rejects", async () => {
    hssomLookup.mockResolvedValue(hssomFound);
    const snowflake = vi.fn(async () => found);
    expect(await lookupAhsPrefillSources("8175-12345678", { snowflake, hssom: lookupHssomOrder }))
      .toEqual({ snowflake: found, hssom: hssomFound });
    expect(hssomLookup).toHaveBeenCalledWith("8175", "12345678");

    hssomLookup.mockRejectedValue(new Error("HSSOM 500"));
    expect(await lookupAhsPrefillSources("8175-12345678", { snowflake: null, hssom: lookupHssomOrder }))
      .toEqual({ snowflake: { status: "unavailable" }, hssom: { status: "unavailable" } });
  });

  it("settles within ~5s when either lookup hangs, so submit is never blocked", async () => {
    vi.useFakeTimers();
    hssomLookup.mockImplementation(() => new Promise(() => {}));
    const fast = lookupAhsPrefillSources("8175-12345678", { snowflake: async () => found, hssom: lookupHssomOrder });
    const bothHung = lookupAhsPrefillSources("8175-12345678", {
      snowflake: () => new Promise(() => {}), hssom: lookupHssomOrder,
    });
    let settled = false;
    void bothHung.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await fast).toEqual({ snowflake: found, hssom: { status: "unavailable" } });
    expect(await bothHung).toEqual({ snowflake: { status: "unavailable" }, hssom: { status: "unavailable" } });
    // A timed-out HSSOM lookup leaves the Snowflake fill intact.
    const next = applyAhsSubmitPrefill(blankDetails, await fast, ahsWarranty);
    expect(next.prefilledFields).toEqual(["contractNumber", "brand", "modelNumber", "serialNumber"]);
  });

  it("derives AHS from the ProcID lookup, unknown when unavailable or slow", async () => {
    const procId = (result: ProcIdResult) => async () => result;
    expect(await boundedServerDerivedAhs("8175-12345678", procId({ status: "FOUND", procId: "AHS1", clientNm: SECRET_CLIENT }))).toBe(true);
    expect(await boundedServerDerivedAhs("8175-12345678", procId({ status: "FOUND", procId: "SPHW1", clientNm: "Sears Home Warranty" }))).toBe(false);
    expect(await boundedServerDerivedAhs("8175-12345678", procId({ status: "NOT_FOUND", procId: "Not Found", clientNm: "Not Found" }))).toBe(false);
    expect(await boundedServerDerivedAhs("8175-12345678", procId({ status: "LOOKUP_UNAVAILABLE", retryable: true }))).toBeUndefined();
    expect(await boundedServerDerivedAhs("8175-12345678", async () => { throw new Error("boom"); })).toBeUndefined();
    vi.useFakeTimers();
    const hung = boundedServerDerivedAhs("8175-12345678", () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await hung).toBeUndefined();
  });

  it("needs the ProcID derivation only for an HSSOM-only find", () => {
    expect(needsServerDerivedAhs(sources({ status: "unavailable" }, hssomFound))).toBe(true);
    expect(needsServerDerivedAhs(sources({ status: "not_found" }, hssomFound))).toBe(true);
    expect(needsServerDerivedAhs(sources(found, hssomFound))).toBe(false);
    expect(needsServerDerivedAhs(sources({ status: "unavailable" }, { status: "not_found" }))).toBe(false);
  });
});

describe("AHS prefill browser response with HSSOM", () => {
  it("sets hasCustomer only when HSSOM found both a name and an address", () => {
    expect(toAhsPrefillResponse(found, hssomFound)).toMatchObject({ status: "found", hasCustomer: true });
    for (const hssom of [
      { status: "found", customerName: SECRET_NAME },
      { status: "found", customerAddress: SECRET_ADDRESS },
      { status: "found", customerName: "   ", customerAddress: SECRET_ADDRESS },
      { status: "found", customerName: "N".repeat(256), customerAddress: SECRET_ADDRESS },
      { status: "not_found" },
      { status: "unavailable" },
    ] as HssomOrderLookupResult[]) {
      expect(toAhsPrefillResponse(found, hssom)).toMatchObject({ status: "found", hasCustomer: false });
    }
  });

  it("takes appliance fields from either source, Snowflake first", () => {
    expect(toAhsPrefillResponse({ status: "found", partnerId: "AHS1", brand: "GE" }, hssomFound)).toEqual({
      status: "found",
      appliance: { brand: "GE", modelNumber: "MVW6230HW", serialNumber: "HS-SERIAL-1" },
      hasDispatchNumber: true,
      hasCustomer: true,
    });
  });

  it("decides an HSSOM-only find by the server's derivation", () => {
    for (const snowflake of [{ status: "unavailable" }, { status: "not_found" }] as AhsPrefillLookupResult[]) {
      expect(toAhsPrefillResponse(snowflake, hssomFound, true)).toMatchObject({
        status: "found", appliance: { brand: "Maytag" }, hasDispatchNumber: true, hasCustomer: true,
      });
      expect(toAhsPrefillResponse(snowflake, hssomFound, false)).toEqual({ status: "not_found" });
      expect(toAhsPrefillResponse(snowflake, hssomFound, undefined)).toEqual({ status: "unavailable" });
    }
    const sears = { ...found, partnerId: "SPHW1", clientName: "Sears Home Warranty" };
    expect(toAhsPrefillResponse(sears, hssomFound, true)).toEqual({ status: "not_found" });
    expect(toAhsPrefillResponse({ status: "unavailable" }, { status: "not_found" })).toEqual({ status: "unavailable" });
    expect(toAhsPrefillResponse({ status: "not_found" }, { status: "unavailable" })).toEqual({ status: "not_found" });
  });

  it("never includes customer, contract or dispatch values", () => {
    for (const response of [
      toAhsPrefillResponse(found, hssomFound),
      toAhsPrefillResponse({ status: "unavailable" }, hssomFound, true),
    ]) {
      const json = JSON.stringify(response);
      for (const value of [SECRET_NAME, SECRET_ADDRESS, SECRET_CONTRACT, SECRET_HSSOM_CONTRACT, "/0003", "/0007", "2019", SECRET_PARTNER, SECRET_CLIENT]) {
        expect(json).not.toContain(value);
      }
    }
  });
});

// Execute the real route registration with hermetic auth/Snowflake/HSSOM
// doubles, like tests/tech-warranty-lookup.test.ts.
const routes = fs.readFileSync("server/routes.ts", "utf8");
const start = routes.indexOf('  app.get("/api/tech/ahs-prefill"');
const end = routes.indexOf('  app.get(["/api/tech/lookup-warranty"', start);
if (start < 0 || end < 0) throw new Error("AHS prefill route boundaries not found");
const routeJs = ts.transpileModule(routes.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(options: {
  enabled?: boolean;
  result?: AhsPrefillLookupResult | Error;
  hssom?: HssomOrderLookupResult;
  procId?: ProcIdResult;
} = {}) {
  const {
    enabled = true,
    result = found,
    hssom = { status: "unavailable" },
    procId = { status: "FOUND", procId: SECRET_PARTNER, clientNm: SECRET_CLIENT },
  } = options;
  const lookup = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  hssomLookup.mockResolvedValue(hssom);
  const fetchProcId = vi.fn(async () => procId);
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
    "toAhsPrefillResponse", "lookupAhsPrefillSources", "needsServerDerivedAhs", "boundedServerDerivedAhs",
    "fetchAhsServiceOrderPrefill", "lookupHssomOrder", "fetchProcIdForServiceOrder", routeJs,
  )(app, authenticateToken, requireRole, () => enabled, new Map(), 3600000, 2,
    toAhsPrefillResponse, lookupAhsPrefillSources, needsServerDerivedAhs, boundedServerDerivedAhs,
    lookup, lookupHssomOrder, fetchProcId);
  return { app, lookup, fetchProcId };
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
    expect(hssomLookup).toHaveBeenCalledWith("8175", "12345678");
    expect(res.body).toEqual({
      status: "found",
      appliance: { brand: "Whirlpool", modelNumber: "WTW5000DW1", serialNumber: "C31290822" },
      hasDispatchNumber: true,
      hasCustomer: false,
    });
    for (const value of [SECRET_CONTRACT, SECRET_PARTNER, SECRET_CLIENT]) expect(res.text).not.toContain(value);
  });

  it("never returns customer, contract or dispatch values and logs none", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { app, fetchProcId } = harness({ hssom: hssomFound });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.body).toEqual({
      status: "found",
      appliance: { brand: "Whirlpool", modelNumber: "WTW5000DW1", serialNumber: "C31290822" },
      hasDispatchNumber: true,
      hasCustomer: true,
    });
    expect(fetchProcId).not.toHaveBeenCalled(); // the Snowflake row decided AHS
    const serialized = JSON.stringify(res.body) + res.text + JSON.stringify(res.headers) + info.mock.calls.flat().join(" ");
    for (const value of [
      SECRET_NAME, SECRET_ADDRESS, "Quillfeather", "Featherstonehaugh",
      SECRET_CONTRACT, SECRET_HSSOM_CONTRACT, "/0003", "/0007", SECRET_PARTNER, SECRET_CLIENT,
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("answers found with hasCustomer false when HSSOM is unavailable", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { app } = harness({ hssom: { status: "unavailable" } });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.body).toMatchObject({ status: "found", hasDispatchNumber: true, hasCustomer: false });
  });

  it("uses the ProcID derivation when HSSOM found the order and Snowflake is unavailable", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const ahs = harness({ result: { status: "unavailable" }, hssom: hssomFound });
    const res = await request(ahs.app).get(url).set("x-test-role", "technician");
    expect(ahs.fetchProcId).toHaveBeenCalledWith("8175-12345678");
    expect(res.body).toEqual({
      status: "found",
      appliance: { brand: "Maytag", modelNumber: "MVW6230HW", serialNumber: "HS-SERIAL-1" },
      hasDispatchNumber: true,
      hasCustomer: true,
    });
    for (const value of [SECRET_NAME, SECRET_ADDRESS, SECRET_HSSOM_CONTRACT]) expect(res.text).not.toContain(value);

    const sears = harness({
      result: { status: "unavailable" },
      hssom: hssomFound,
      procId: { status: "FOUND", procId: "SPHW1", clientNm: "Sears Home Warranty" },
    });
    expect((await request(sears.app).get(url).set("x-test-role", "technician")).body).toEqual({ status: "not_found" });

    const down = harness({ result: { status: "unavailable" }, hssom: hssomFound, procId: { status: "LOOKUP_UNAVAILABLE", retryable: true } });
    expect((await request(down.app).get(url).set("x-test-role", "technician")).body).toEqual({ status: "unavailable" });
  });

  it("answers not_found for an order that is not AHS", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { app, fetchProcId } = harness({
      result: { ...found, partnerId: "SPHW1", clientName: "Sears Home Warranty" },
      hssom: hssomFound,
    });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.body).toEqual({ status: "not_found" });
    expect(fetchProcId).not.toHaveBeenCalled();
  });

  it("skips the Snowflake prefill when its flag is off", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { app, lookup } = harness({ enabled: false });
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "unavailable" });
    expect(lookup).not.toHaveBeenCalled();

    // HSSOM still answers behind its own flag, with AHS from the ProcID derivation.
    const hssomOnly = harness({ enabled: false, hssom: hssomFound });
    const found2 = await request(hssomOnly.app).get(url).set("x-test-role", "technician");
    expect(found2.body).toMatchObject({ status: "found", hasCustomer: true });
    expect(hssomOnly.lookup).not.toHaveBeenCalled();
  });

  it.each(["", "admin", "vrs_agent", "provider_1099"])("rejects role %j before Snowflake", async (role) => {
    const { app, lookup } = harness();
    const req = request(app).get(url);
    const res = await (role ? req.set("x-test-role", role) : req);
    expect(res.status).toBe(role ? 403 : 401);
    expect(lookup).not.toHaveBeenCalled();
    expect(hssomLookup).not.toHaveBeenCalled();
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
    expect(hssomLookup).not.toHaveBeenCalled();
  });

  it("rate-limits per user", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, lookup } = harness();
    await request(app).get(url).set("x-test-role", "technician");
    await request(app).get(url).set("x-test-role", "technician");
    expect((await request(app).get(url).set("x-test-role", "technician")).status).toBe(429);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(hssomLookup).toHaveBeenCalledTimes(2);
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
    const { app } = harness();
    hssomLookup.mockRejectedValue(new Error("HSSOM down"));
    const res = await request(app).get(url).set("x-test-role", "technician");
    expect(res.body).toMatchObject({ status: "found", hasCustomer: false });
  });
});

describe("POST /api/submissions prefill wiring", () => {
  const handler = routes.slice(
    routes.indexOf("const createSubmissionHandler = async"),
    routes.indexOf("const submission = idempResult.submission!;"),
  );

  it("discards client server-only fields and applies the prefill before the details are stored", () => {
    expect(handler).toContain("withoutServerOnlyFields(parsed.data.ahsDetails)");
    const lookupAt = handler.indexOf("lookupAhsPrefillSources(parsed.data.serviceOrder, {");
    const applyAt = handler.indexOf("applyAhsSubmitPrefill(ahsDetails, sources, {");
    const storeAt = handler.indexOf("ahsDetails: ahsDetails ? JSON.stringify(ahsDetails) : null");
    expect(lookupAt).toBeGreaterThan(0);
    expect(lookupAt).toBeLessThan(handler.indexOf("await fetchProcIdForServiceOrder(parsed.data.serviceOrder)"));
    expect(applyAt).toBeGreaterThan(lookupAt);
    expect(storeAt).toBeGreaterThan(applyAt);
    expect(handler).toContain("snowflake: isAhsServiceOrderPrefillEnabled() ? fetchAhsServiceOrderPrefill : null");
    expect(handler).toContain("hssom: lookupHssomOrder");
    expect(handler).toMatch(/finalWarrantyType,\s+derivedWarrantyType: derivedWarranty\?\.warrantyType/);
    const keepAt = handler.indexOf("keepPrefilledFromPrevious(ahsDetails, previousAhsDetails)");
    expect(keepAt).toBeGreaterThan(applyAt);
    expect(keepAt).toBeLessThan(storeAt);
  });

  it("logs source statuses and field names, never values", () => {
    const logAt = handler.indexOf("`[ahs-prefill] submit SO=");
    const log = handler.slice(logAt, handler.indexOf(");", logAt));
    expect(log).toContain("prefilledFieldNames(ahsDetails)");
    expect(log).not.toMatch(/ahsDetails\.(customerName|customerAddress|contractNumber|brand|modelNumber|serialNumber|purchaseYear)/);
    expect(log).not.toMatch(/sources\.(snowflake|hssom)\.(?!status)/);
  });
});

describe("server-filled customer PII never reaches a technician's browser", () => {
  const stored = JSON.stringify({
    customerName: "Maria Gonzalez",
    customerAddress: "742 Evergreen Terrace, Hagerstown, MD 21740",
    brand: "Whirlpool",
    prefilledFields: ["brand", "customerName", "customerAddress"],
  });

  it("drops customer fields the server filled, keeps everything else", () => {
    const redacted = JSON.parse(redactServerPrefilledCustomer(stored)!);
    expect(redacted).not.toHaveProperty("customerName");
    expect(redacted).not.toHaveProperty("customerAddress");
    expect(redacted.brand).toBe("Whirlpool");
    expect(redacted.prefilledFields).toEqual(["brand", "customerName", "customerAddress"]);
  });

  it("leaves customer values the tech typed, and passes through junk unchanged", () => {
    const typed = JSON.stringify({ customerName: "Typed By Tech", prefilledFields: ["brand"] });
    expect(redactServerPrefilledCustomer(typed)).toBe(typed);
    expect(redactServerPrefilledCustomer(null)).toBeNull();
    expect(redactServerPrefilledCustomer("not json")).toBe("not json");
  });

  it("restores the previous server-filled values on a resubmission that came back blank", () => {
    const previous = JSON.parse(stored);
    const resent = { brand: "Whirlpool" } as Record<string, any>;
    const restored = restoreRedactedCustomerFromPrevious(resent, previous);
    expect(restored.customerName).toBe("Maria Gonzalez");
    expect(restored.customerAddress).toBe("742 Evergreen Terrace, Hagerstown, MD 21740");
    expect(keepPrefilledFromPrevious(restored as any, previous).prefilledFields).toEqual(
      expect.arrayContaining(["customerName", "customerAddress"]),
    );
    // A tech-typed replacement wins and is not overwritten.
    expect(restoreRedactedCustomerFromPrevious({ customerName: "New" } as any, previous).customerName).toBe("New");
    // Nothing is restored from fields the tech originally typed.
    expect(restoreRedactedCustomerFromPrevious({} as any, { customerName: "X" } as any)).toEqual({});
  });

  it("every technician-facing submission response goes through redactSubmissionForRole", () => {
    const routes = fs.readFileSync("server/routes.ts", "utf8");
    expect(routes).not.toMatch(/json\([^)]*redactWarrantyForProvider\(/);
    expect(routes.match(/redactSubmissionForRole\(user\.role,/g)?.length).toBeGreaterThanOrEqual(6);
    const helper = routes.slice(routes.indexOf("function redactSubmissionForRole"));
    expect(helper).toContain('["technician", "flexed_technician", "provider_1099"]');
    expect(helper).toContain("redactServerPrefilledCustomer(row.ahsDetails)");
    const handler = routes.slice(routes.indexOf("restoreRedactedCustomerFromPrevious(ahsDetails, previousAhsDetails)"));
    expect(handler.indexOf("keepPrefilledFromPrevious(ahsDetails, previousAhsDetails)")).toBeGreaterThan(0);
  });
});
