import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AHS_PREFILL_APPLIANCE_SQL,
  AHS_PREFILL_CORE_SQL,
  AHS_PREFILL_PARTS_SQL,
  AHS_PREFILL_PARTS_TIMEOUT_MS,
  createAhsPrefillLookup,
  mapAhsServiceOrderParts,
  type AhsPrefillLookupResult,
  type AhsPrefillQuery,
} from "../server/services/snowflake-lookup";
import {
  applyAhsServiceOrderPrefill,
  applyAhsSubmitPrefill,
  applyTechApplianceDetails,
  boundedAhsPrefillLookup,
  draftFromPrevious,
  fillAhsDraft,
  isAhsOrder,
  lookupAhsPrefillSources,
  mergeAhsPrefillSources,
  mergeSavedAhsProvenance,
  prefilledFieldNames,
  redactAhsCustomerForTechnician,
  withoutPrefilledFields,
  withoutServerOnlyFields,
  type AhsPrefillSources,
} from "../server/ahs-prefill";
import { lookupHssomOrder, type HssomOrderLookupResult } from "../server/services/hssom-order-lookup";
import { isAhsServiceOrderPrefillEnabled } from "../server/featureFlags";
import { AHS_PREFILL_FIELDS } from "../shared/ahs-prefill";
import type { TechApplianceDetails } from "../shared/tech-appliance-details";
import {
  ahsDetailsDraftSchema,
  ahsDetailsSchema,
  parseStoredAhsDetails,
  parseStoredAhsDetailsDraft,
  type AhsDetails,
  type AhsDetailsDraft,
} from "../shared/ahs-details";

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

const partRows = [
  { PART_NUMBER: " WPW10503278 ", DESCRIPTION: " Electronic control board ", QUANTITY: 1, ORDERED_QUANTITY: 1, UNIT_PRICE: "245.00", STATUS: "I" },
  { PART_NUMBER: "W10820048", DESCRIPTION: "Drain pump clip", QUANTITY: 0, ORDERED_QUANTITY: 2, UNIT_PRICE: 4.255, STATUS: "O" },
];

function mockQuery(results: PromiseSettledResult<any[]>[] = [ok([coreRow]), ok([applianceRow]), ok([])]) {
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
  it("filters on the padded unit and the service order in every statement", async () => {
    const query = mockQuery();
    const lookup = createAhsPrefillLookup(query);
    await lookup("8175", "12345678");
    const [statements] = query.mock.calls[0];
    expect(statements.map((s) => s.binds)).toEqual([["8175", "12345678"], ["8175", "12345678"], ["8175", "12345678"]]);
    for (const sql of [AHS_PREFILL_CORE_SQL, AHS_PREFILL_APPLIANCE_SQL]) {
      expect(sql).toContain("FROM PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL");
      expect(sql).toContain("WHERE SVC_UN_NO = LPAD(?, 7, '0') AND SO_NO = ? LIMIT 1");
    }
    expect(statements.map((s) => s.sqlText)).toEqual([AHS_PREFILL_CORE_SQL, AHS_PREFILL_APPLIANCE_SQL, AHS_PREFILL_PARTS_SQL]);
    // Only the parts statement carries its own (shorter) timeout.
    expect(statements.map((s) => s.timeoutMs)).toEqual([undefined, undefined, AHS_PREFILL_PARTS_TIMEOUT_MS]);
    expect(AHS_PREFILL_PARTS_TIMEOUT_MS).toBeLessThan(5000);
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

  it("lists the fields filled and keeps the draft's own server provenance", () => {
    const typed = { ...details, brand: "Typed brand" };
    const brandOnly = applyAhsServiceOrderPrefill(typed, { status: "found", brand: "Whirlpool" });
    expect(brandOnly.brand).toBe("Typed brand");
    expect(brandOnly).not.toHaveProperty("prefilledFields");
    // A stored draft's provenance only ever names server-filled values, so a
    // refresh keeps it (and adds what it fills).
    const stored = { ...details, modelNumber: "M1", prefilledFields: ["modelNumber"] as AhsDetails["prefilledFields"] };
    expect(applyAhsServiceOrderPrefill(stored, { status: "found", brand: "Whirlpool" }).prefilledFields)
      .toEqual(["brand", "modelNumber"]);
    expect(applyAhsServiceOrderPrefill(stored, { status: "unavailable" })).toEqual(stored);
    expect(withoutPrefilledFields(stored)).not.toHaveProperty("prefilledFields");
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

  it("recognizes AHS orders with the shared warranty derivation", () => {
    expect(isAhsOrder(found)).toBe(true);
    expect(isAhsOrder({ status: "found", partnerId: "AHS123" })).toBe(true);
    expect(isAhsOrder({ status: "found", partnerId: "SPHW1", clientName: "Sears Home Warranty" })).toBe(false);
    expect(isAhsOrder({ status: "found", brand: "Whirlpool" })).toBe(false);
    expect(isAhsOrder({ status: "not_found" })).toBe(false);
    expect(isAhsOrder(null)).toBe(false);
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

});







describe("Snowflake parts on the order (NPSXTPN)", () => {
  it("queries the DB2 parts table by padded unit and order, in sequence", () => {
    expect(AHS_PREFILL_PARTS_SQL).toBe(
      "SELECT SVC_PRT_NO AS PART_NUMBER, PRT_DS AS DESCRIPTION, SVC_PRT_QT AS QUANTITY, PRT_ORD_QT AS ORDERED_QUANTITY, " +
      "PRT_SEL_PRC_AM AS UNIT_PRICE, SVC_PRT_STS_CD AS STATUS " +
      "FROM PRD_DB2.HS_DW_TBLS.NPSXTPN WHERE SVC_UN_NO = LPAD(?,7,'0') AND SO_NO = ? ORDER BY PRT_SEQ_NO LIMIT 50",
    );
  });

  it("maps part number, description, quantity and unit price", async () => {
    const query = mockQuery([ok([coreRow]), ok([applianceRow]), ok(partRows)]);
    const result = await createAhsPrefillLookup(query)("8175", "12345678");
    expect(result).toMatchObject({
      status: "found",
      brand: "Whirlpool",
      parts: [
        { partNumber: "WPW10503278", description: "Electronic control board", quantity: 1, unitPrice: 245 },
        // SVC_PRT_QT 0 falls back to the ordered quantity; price rounded to cents.
        { partNumber: "W10820048", description: "Drain pump clip", quantity: 2, unitPrice: 4.26 },
      ],
    });
  });

  it("drops cancelled, voided and numberless lines, caps at 10, quantity at least 1", () => {
    const rows = [
      { PART_NUMBER: "X1", STATUS: "X" },
      { PART_NUMBER: "V1", STATUS: "v" },
      { PART_NUMBER: "  ", STATUS: "I" },
      { PART_NUMBER: "P".repeat(101) },
      { PART_NUMBER: "NOPRICE", QUANTITY: null, ORDERED_QUANTITY: null, UNIT_PRICE: null, DESCRIPTION: " " },
      { PART_NUMBER: "BADPRICE", QUANTITY: "3", UNIT_PRICE: "n/a" },
      { PART_NUMBER: "NEGATIVE", UNIT_PRICE: -5, QUANTITY: 500 },
      ...Array.from({ length: 12 }, (_, index) => ({ PART_NUMBER: `P${index}`, QUANTITY: 1, UNIT_PRICE: 10 })),
    ];
    const parts = mapAhsServiceOrderParts(rows);
    expect(parts).toHaveLength(10);
    expect(parts.slice(0, 3)).toEqual([
      { partNumber: "NOPRICE", quantity: 1 },
      { partNumber: "BADPRICE", quantity: 3 },
      { partNumber: "NEGATIVE", quantity: 99 },
    ]);
    expect(parts.map((part) => part.partNumber)).not.toContain("X1");
    expect(parts.map((part) => part.partNumber)).not.toContain("V1");
    // Every mapped part fits the draft schema.
    expect(ahsDetailsDraftSchema.safeParse({ parts }).success).toBe(true);
  });

  it("keeps every other value when the parts statement fails or times out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await createAhsPrefillLookup(
      mockQuery([ok([coreRow]), ok([applianceRow]), failed("statement timed out after 2500ms")]),
    )("8175", "12345678");
    expect(result).toMatchObject({
      status: "found",
      brand: "Whirlpool",
      modelNumber: "WTW5000DW1",
      serviceContractId: `${SECRET_CONTRACT}/0003`,
    });
    expect(result).not.toHaveProperty("parts");
    expect(warn.mock.calls.flat().join(" ")).toContain("parts statement failed");
    // No live parts is just no parts.
    const none = await createAhsPrefillLookup(mockQuery([ok([coreRow]), ok([applianceRow]), ok([{ PART_NUMBER: "X", STATUS: "X" }])]))(
      "8175", "12345679",
    );
    expect(none).toMatchObject({ status: "found" });
    expect(none).not.toHaveProperty("parts");
  });

  it("never logs part values", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await createAhsPrefillLookup(mockQuery([ok([coreRow]), ok([applianceRow]), ok(partRows)]))("8175", "12345678");
    await createAhsPrefillLookup(mockQuery([ok([coreRow]), ok([applianceRow]), failed("invalid identifier 'PRT_DS'")]))("8175", "12345679");
    const logged = spies.flatMap((spy) => spy.mock.calls.flat()).join(" ");
    for (const value of ["WPW10503278", "Electronic control board", "245", "W10820048"]) expect(logged).not.toContain(value);
  });

  it("the real driver cancels a slow parts statement on its own timer", () => {
    const source = fs.readFileSync("server/services/snowflake.ts", "utf8");
    const driver = source.slice(source.indexOf("export const fetchAhsServiceOrderPrefill"));
    expect(driver).toContain("statements.map(({ sqlText, binds, timeoutMs })");
    expect(driver).toMatch(/if \(timeoutMs\) \{\s+timer = setTimeout\(\(\) => \{\s+cancel\(\);\s+reject\(/);
    expect(driver).toContain("Promise.allSettled(");
  });
});

describe("AHS draft built at submit", () => {
  const foundWithParts: AhsPrefillLookupResult = {
    ...found,
    parts: [
      { partNumber: "WPW10503278", description: "Electronic control board", quantity: 1, unitPrice: 245 },
      { partNumber: "W10820048", quantity: 2 },
    ],
  };

  it("names parts in the shared provenance list", () => {
    expect(AHS_PREFILL_FIELDS).toContain("parts");
    expect(ahsDetailsSchema.shape.prefilledFields.safeParse(["parts"]).success).toBe(true);
  });

  it("fills an empty draft and names exactly what was filled", () => {
    const draft = applyAhsSubmitPrefill({}, sources(foundWithParts, hssomFound), ahsWarranty);
    expect(draft).toEqual({
      contractNumber: SECRET_CONTRACT,
      brand: "Whirlpool",
      modelNumber: "WTW5000DW1",
      serialNumber: "C31290822",
      customerName: SECRET_NAME,
      customerAddress: SECRET_ADDRESS,
      parts: foundWithParts.parts,
      purchaseYear: 2019,
      prefilledFields: [
        "contractNumber", "brand", "modelNumber", "serialNumber", "customerName", "customerAddress", "parts",
      ],
    });
    // Stored JSON reads back as a draft, not as complete details.
    expect(parseStoredAhsDetailsDraft(JSON.stringify(draft))).toEqual(draft);
    expect(parseStoredAhsDetails(JSON.stringify(draft))).toBeNull();
  });

  it("is an empty draft when the lookups found nothing or failed", () => {
    for (const lookups of [
      sources({ status: "unavailable" }, { status: "unavailable" }),
      sources({ status: "not_found" }, { status: "not_found" }),
    ]) {
      const draft = applyAhsSubmitPrefill({}, lookups, ahsWarranty);
      expect(draft).toEqual({});
      expect(parseStoredAhsDetailsDraft(JSON.stringify(draft))).toEqual({});
    }
  });

  it("fills parts only when the draft has none", () => {
    const withParts: AhsDetailsDraft = { parts: [{ partNumber: "TYPED-1", quantity: 1 }] };
    const kept = fillAhsDraft(withParts, { parts: [{ partNumber: "SO-1", quantity: 2 }] });
    expect(kept.parts).toEqual([{ partNumber: "TYPED-1", quantity: 1 }]);
    expect(kept).not.toHaveProperty("prefilledFields");
    const filled = fillAhsDraft({ parts: [] }, { parts: [{ partNumber: "SO-1", quantity: 2 }] });
    expect(filled).toEqual({ parts: [{ partNumber: "SO-1", quantity: 2 }], prefilledFields: ["parts"] });
  });

  it("starts a resubmission from the previous ticket's details", () => {
    const previous = mergeSavedAhsProvenance(
      { ...details, brand: "Whirlpool" },
      { brand: "Whirlpool", prefilledFields: ["brand"] },
    );
    const draft = applyAhsSubmitPrefill(draftFromPrevious(previous), sources(foundWithParts, { status: "unavailable" }), ahsWarranty);
    expect(draft.parts).toEqual(details.parts); // the previous parts win
    expect(draft.laborAmount).toBe(details.laborAmount);
    expect(draft.prefilledFields).toEqual(["contractNumber", "brand", "modelNumber", "serialNumber"]);
    expect(draftFromPrevious(null)).toEqual({});
  });
});

describe("Tech appliance details on the AHS draft (applyTechApplianceDetails)", () => {
  const tech: TechApplianceDetails = {
    applianceGrade: "medium",
    applianceColor: "Black Stainless Steel",
    partFunction: "Controls wash cycle timing",
  };
  const foundWithParts: AhsPrefillLookupResult = {
    ...found,
    parts: [
      { partNumber: "WPW10503278", description: "Electronic control board", quantity: 1, unitPrice: 245 },
      { partNumber: "W10820048", quantity: 2 },
    ],
  };

  it("maps the grade, sets the color and part 1's function on an empty draft", () => {
    for (const [grade, ahsGrade] of [["low", "entry"], ["medium", "mid"], ["high", "top"]] as const) {
      expect(applyTechApplianceDetails({}, { ...tech, applianceGrade: grade }).applianceGrade).toBe(ahsGrade);
    }
    // Lookups off or failed: the draft still gets the three values, part 1 partial.
    const empty = applyAhsSubmitPrefill({}, sources({ status: "unavailable" }, { status: "unavailable" }), ahsWarranty);
    const draft = applyTechApplianceDetails(empty, tech);
    expect(draft).toEqual({
      applianceGrade: "mid",
      applianceColor: "Black Stainless Steel",
      parts: [{ partFunction: "Controls wash cycle timing" }],
    });
    // The partial part is a valid stored draft; not yet complete details.
    expect(parseStoredAhsDetailsDraft(JSON.stringify(draft))).toEqual(draft);
    expect(parseStoredAhsDetails(JSON.stringify(draft))).toBeNull();
  });

  it("sets part 1's function on the parts the lookup filled, never in prefilledFields", () => {
    const prefilled = applyAhsSubmitPrefill({}, sources(foundWithParts, hssomFound), ahsWarranty);
    const draft = applyTechApplianceDetails(prefilled, tech);
    expect(draft.parts).toEqual([
      { ...foundWithParts.parts![0], partFunction: "Controls wash cycle timing" },
      foundWithParts.parts![1],
    ]);
    expect(draft.applianceGrade).toBe("mid");
    expect(draft.applianceColor).toBe("Black Stainless Steel");
    expect(draft.prefilledFields).toEqual(prefilled.prefilledFields);
    for (const field of ["applianceGrade", "applianceColor", "partFunction"]) {
      expect(draft.prefilledFields).not.toContain(field);
      expect(prefilledFieldNames(draft)).not.toContain(field);
    }
    expect(parseStoredAhsDetailsDraft(JSON.stringify(draft))).toEqual(draft);
    // Doesn't mutate its input.
    expect(prefilled.parts![0]).not.toHaveProperty("partFunction");
  });

  it("sets part 1's function only when blank", () => {
    const typed: AhsDetailsDraft = { parts: [{ partNumber: "P1", partFunction: "Typed by manager" }] };
    expect(applyTechApplianceDetails(typed, tech).parts).toEqual(typed.parts);
    const blank: AhsDetailsDraft = { parts: [{ partNumber: "P1", partFunction: "  " }] };
    expect(applyTechApplianceDetails(blank, tech).parts).toEqual([{ partNumber: "P1", partFunction: tech.partFunction }]);
  });

  it("on a resubmission keeps the previous ticket's values unless the tech changed them", () => {
    const previousDraft: AhsDetailsDraft = {
      applianceGrade: "top", // the VRS manager corrected it
      applianceColor: "White",
      parts: [{ partNumber: "P1", partFunction: "Corrected function" }],
    };
    expect(applyTechApplianceDetails(previousDraft, tech, tech)).toEqual(previousDraft);
    const changed = applyTechApplianceDetails(previousDraft, { ...tech, applianceColor: "Bisque" }, tech);
    expect(changed).toEqual({ ...previousDraft, applianceColor: "Bisque" });
    // Grade and part function changed; the color is what the tech sent last time.
    const twoChanged = applyTechApplianceDetails(previousDraft, tech, {
      applianceGrade: "high",
      applianceColor: "Black Stainless Steel",
      partFunction: "Old",
    });
    expect(twoChanged).toEqual({
      applianceGrade: "mid",
      applianceColor: "White",
      parts: [{ partNumber: "P1", partFunction: tech.partFunction }],
    });
  });

  it("refresh fills parts around the tech's partial part 1 and keeps the tech's values", () => {
    const stored = applyTechApplianceDetails({}, tech);
    const refreshed = applyAhsSubmitPrefill(stored, sources(foundWithParts, hssomFound), ahsWarranty);
    expect(refreshed.applianceGrade).toBe("mid");
    expect(refreshed.applianceColor).toBe("Black Stainless Steel");
    expect(refreshed.parts).toEqual([
      { ...foundWithParts.parts![0], partFunction: "Controls wash cycle timing" },
      foundWithParts.parts![1],
    ]);
    expect(refreshed.prefilledFields).toContain("parts");
    for (const field of ["applianceGrade", "applianceColor", "partFunction"]) {
      expect(refreshed.prefilledFields).not.toContain(field);
    }
    // Refreshing again changes nothing; a real part 1 is never replaced.
    expect(applyAhsSubmitPrefill(refreshed, sources(foundWithParts, hssomFound), ahsWarranty)).toEqual(refreshed);
    // A tech value already in the draft is never overwritten, whatever the lookups return.
    const withTyped = { ...stored, parts: [{ partNumber: "TYPED", partFunction: "Mine" }] };
    expect(fillAhsDraft(withTyped, { parts: [{ partNumber: "SO", quantity: 1 }] }).parts).toEqual(withTyped.parts);
  });

  it("a Stage 1 save keeps the tech values the manager left unchanged", () => {
    const drafted = applyTechApplianceDetails(
      applyAhsSubmitPrefill({}, sources(foundWithParts, hssomFound), ahsWarranty),
      tech,
    );
    const saved: AhsDetails = {
      ...details,
      applianceGrade: drafted.applianceGrade,
      applianceColor: drafted.applianceColor,
      parts: [{ ...details.parts[0], partFunction: drafted.parts![0].partFunction }],
    };
    const merged = mergeSavedAhsProvenance(saved, drafted);
    expect(merged).toMatchObject({
      applianceGrade: "mid",
      applianceColor: "Black Stainless Steel",
      parts: [{ partFunction: "Controls wash cycle timing" }],
    });
    for (const field of ["applianceGrade", "applianceColor", "partFunction"]) {
      expect(merged.prefilledFields ?? []).not.toContain(field);
    }
  });
});

describe("Stage 1 save provenance (mergeSavedAhsProvenance)", () => {
  const draft: AhsDetailsDraft = {
    contractNumber: SECRET_CONTRACT,
    brand: "Whirlpool",
    modelNumber: "WTW5000DW1",
    customerName: SECRET_NAME,
    parts: [{ partNumber: "WPW10503278", description: "Electronic control board", quantity: 1 }],
    purchaseYear: 2019,
    prefilledFields: ["contractNumber", "brand", "modelNumber", "customerName", "parts"],
  };
  const saved: AhsDetails = {
    ...details,
    contractNumber: ` ${SECRET_CONTRACT.toLowerCase()} `,
    brand: "WHIRLPOOL",
    modelNumber: "CHANGED-MODEL",
    customerName: "",
    applianceAge: undefined,
    parts: [{ partNumber: "wpw10503278", description: "Electronic control board", quantity: 1, unitPrice: 245 }],
  };

  it("keeps a field only while the saved value equals the server's (trimmed, any case)", () => {
    const merged = mergeSavedAhsProvenance(saved, draft);
    // modelNumber changed, customerName cleared; parts kept: the manager only
    // added the price the order didn't have.
    expect(merged.prefilledFields).toEqual(["contractNumber", "brand", "parts"]);
  });

  it("drops parts provenance once a server-filled part value changes", () => {
    const changedQty = { ...saved, parts: [{ ...saved.parts[0], quantity: 2 }] };
    expect(mergeSavedAhsProvenance(changedQty, draft).prefilledFields).not.toContain("parts");
    const extraLine = { ...saved, parts: [...saved.parts, { partNumber: "NEW", quantity: 1, description: "New", unitPrice: 1 }] };
    expect(mergeSavedAhsProvenance(extraLine, draft).prefilledFields).not.toContain("parts");
  });

  it("strips client-sent provenance and purchaseYear; carries the draft's year while the age is blank", () => {
    const forged = { ...saved, prefilledFields: ["serialNumber"], purchaseYear: 1999 } as AhsDetails;
    const merged = mergeSavedAhsProvenance(forged, draft);
    expect(merged.prefilledFields).not.toContain("serialNumber");
    expect(merged.purchaseYear).toBe(2019);
    expect(mergeSavedAhsProvenance({ ...forged, applianceAge: 3 }, draft)).not.toHaveProperty("purchaseYear");
    const noDraft = mergeSavedAhsProvenance(forged, null);
    expect(noDraft).not.toHaveProperty("prefilledFields");
    expect(noDraft).not.toHaveProperty("purchaseYear");
    // The stored result still parses as complete details.
    expect(parseStoredAhsDetails(JSON.stringify(merged))).toMatchObject({ prefilledFields: merged.prefilledFields });
  });
});

describe("AHS customer PII never reaches a technician's browser", () => {
  it("drops the dispatch number, customer name and address whoever entered them", () => {
    const stored = JSON.stringify({
      contractNumber: SECRET_CONTRACT,
      customerName: SECRET_NAME,
      customerAddress: SECRET_ADDRESS,
      brand: "Whirlpool",
      prefilledFields: ["brand"],
    });
    const redacted = JSON.parse(redactAhsCustomerForTechnician(stored)!);
    expect(redacted).toEqual({ brand: "Whirlpool", prefilledFields: ["brand"] });
    const nothing = JSON.stringify({ brand: "Whirlpool" });
    expect(redactAhsCustomerForTechnician(nothing)).toBe(nothing);
    expect(redactAhsCustomerForTechnician("{}")).toBe("{}");
    expect(redactAhsCustomerForTechnician(null)).toBeNull();
    expect(redactAhsCustomerForTechnician("not json")).toBe("not json");
  });

  it("every technician-facing submission response goes through redactSubmissionForRole", () => {
    expect(routes).not.toMatch(/json\([^)]*redactWarrantyForProvider\(/);
    expect(routes.match(/redactSubmissionForRole\(user\.role,/g)?.length).toBeGreaterThanOrEqual(6);
    const helper = routes.slice(routes.indexOf("function redactSubmissionForRole"));
    expect(helper).toContain('["technician", "flexed_technician", "provider_1099"]');
    expect(helper).toContain("redactAhsCustomerForTechnician(row.ahsDetails)");
    expect(routes).toContain("json({ submission: redactSubmissionForRole(user.role, updated), added: totalAdded })");
  });
});

const routes = fs.readFileSync("server/routes.ts", "utf8");

describe("POST /api/submissions stores a draft", () => {
  const handler = routes.slice(
    routes.indexOf("const createSubmissionHandler = async"),
    routes.indexOf('  app.post(\n    "/api/submissions",'),
  );
  const schema = routes.slice(
    routes.indexOf("const createSubmissionSchema = z.object({"),
    routes.indexOf("const createSubmissionHandler = async"),
  );

  it("ignores a client-sent ahsDetails and keeps the tech's division", () => {
    expect(schema).not.toMatch(/^\s+ahsDetails:/m);
    expect(handler).not.toContain("parsed.data.ahsDetails");
    expect(handler).not.toContain("ahsDivisionFor");
    expect(handler).not.toMatch(/parsed\.data\.applianceType\s*=/);
    expect(handler).toContain("applianceType: parsed.data.applianceType,");
  });

  it("builds the draft from the lookups for AHS authorization tickets while enrollment is on", () => {
    expect(handler).toMatch(
      /const wantsAhsDraft =\s+isVrsAiAppEnrollEnabled\(\) &&\s+parsed\.data\.requestType === "authorization" &&\s+!internalOptions\?\.skipAppVrsAiEnroll;/,
    );
    expect(handler).toContain("snowflake: isAhsServiceOrderPrefillEnabled() ? fetchAhsServiceOrderPrefill : null");
    expect(handler).toContain("hssom: lookupHssomOrder");
    const earlyAt = handler.indexOf("const earlyAhsPrefillLookup = wantsAhsDraft");
    const procAt = handler.indexOf("await fetchProcIdForServiceOrder(parsed.data.serviceOrder)");
    const draftAt = handler.indexOf('if (wantsAhsDraft && finalWarrantyType === "american_home_shield") {');
    const applyAt = handler.indexOf("applyAhsSubmitPrefill(draftFromPrevious(previousAhsDraft), sources, {");
    const storeAt = handler.indexOf("ahsDetails: ahsDraft ? JSON.stringify(ahsDraft) : null,");
    expect(earlyAt).toBeGreaterThan(0);
    expect(earlyAt).toBeLessThan(procAt);
    expect(draftAt).toBeGreaterThan(procAt);
    expect(applyAt).toBeGreaterThan(draftAt);
    expect(storeAt).toBeGreaterThan(applyAt);
    expect(handler.slice(draftAt, applyAt)).toContain("await (earlyAhsPrefillLookup ?? startAhsPrefillLookup())");
    expect(handler).toMatch(/finalWarrantyType,\s+derivedWarrantyType: derivedWarranty\?\.warrantyType/);
  });

  it("stores the draft whatever the lookups returned (they never reject)", () => {
    // The draft is assigned unconditionally inside the AHS branch: an empty
    // lookup leaves {} (see "is an empty draft when the lookups found nothing").
    const branch = handler.slice(handler.indexOf('if (wantsAhsDraft && finalWarrantyType === "american_home_shield") {'));
    expect(branch.slice(0, branch.indexOf("console.log("))).not.toMatch(/if \(sources\./);
  });

  it("creates no VRS AI bridge row at submit", () => {
    expect(handler).not.toContain("enrollAppSubmissionInVrsAi");
    expect(handler).not.toContain("saveAppSubmissionVrsAiIntake");
    expect(handler).not.toContain("createIntake");
    expect(routes).not.toContain("enrollAppSubmissionInVrsAi");
    // SASHA intake still opts out of the app path and creates its own row.
    expect(routes).toMatch(/await createSubmissionHandler\(internalRequest, capturedRes, \{\s+\.\.\.internalOptions,\s+skipAppVrsAiEnroll: true,/);
  });

  it("logs source statuses and field names, never values", () => {
    const logAt = handler.indexOf("`[ahs-prefill] submit SO=");
    const log = handler.slice(logAt, handler.indexOf(");", logAt));
    expect(log).toContain("prefilledFieldNames(ahsDraft)");
    expect(log).not.toMatch(/ahsDraft\.(customerName|customerAddress|contractNumber|brand|modelNumber|serialNumber|purchaseYear|parts)/);
    expect(log).not.toMatch(/sources\.(snowflake|hssom)\.(?!status)/);
  });

  it("removes the technician prefill endpoint and keeps the config flags", () => {
    expect(routes).not.toContain('"/api/tech/ahs-prefill"');
    expect(routes).not.toContain("ahsPrefillLookupLog");
    expect(routes).toContain("ahsServiceOrderPrefill: isAhsServiceOrderPrefillEnabled(),");
    expect(routes).toContain("ahsHssomCustomerPrefill: isAhsHssomCustomerPrefillEnabled(),");
  });

  it("registers the Stage 1 review API with the submit path's lookups", () => {
    const wiring = routes.slice(routes.indexOf("registerAhsReviewApi(app, {"));
    const block = wiring.slice(0, wiring.indexOf("\n  });\n"));
    expect(block).toContain("isEnrollEnabled: isVrsAiAppEnrollEnabled,");
    expect(block).toContain("snowflake: isAhsServiceOrderPrefillEnabled() ? fetchAhsServiceOrderPrefill : null,");
    expect(block).toContain("store: vrsBridgeStore,");
    expect(block).toContain("broadcastToAdmins({");
    expect(block).not.toContain("broadcastToTechnicians");
  });
});
