// Appliance type from the service order (HS_SP_CD -> division) for
// GET /api/tech/lookup-warranty and submit (the fallback when WOM has no
// product category): server/services/snowflake-lookup.ts
// createServiceOrderApplianceLookup. Hermetic: Snowflake is a double.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SERVICE_ORDER_APPLIANCE_SQL,
  createServiceOrderApplianceLookup,
  type ServiceOrderApplianceQuery,
} from "../server/services/snowflake-lookup";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const row = (product: unknown, unit = "0008175", count = 1) => ({ SERVICE_UNIT: unit, UNIT_COUNT: count, PRODUCT: product });
const queryReturning = (rows: any[]) => vi.fn<ServiceOrderApplianceQuery>(async () => rows);

describe("appliance type statement", () => {
  it("is its own statement on HS_SP_CD, matched by SO with the district preferred", async () => {
    expect(SERVICE_ORDER_APPLIANCE_SQL).toBe(
      "SELECT SVC_UN_NO AS SERVICE_UNIT, COUNT(DISTINCT SVC_UN_NO) OVER () AS UNIT_COUNT, HS_SP_CD AS PRODUCT " +
      "FROM PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL " +
      "WHERE SO_NO = ? ORDER BY CASE WHEN SVC_UN_NO = LPAD(?, 7, '0') THEN 0 ELSE 1 END LIMIT 1",
    );
    vi.spyOn(console, "info").mockImplementation(() => {});
    const query = queryReturning([row("Washer")]);
    await createServiceOrderApplianceLookup(query)("8175-12345678");
    expect(query.mock.calls[0][0]).toEqual({ sqlText: SERVICE_ORDER_APPLIANCE_SQL, binds: ["12345678", "8175"] });
  });

  it("never touches the ProcID statement", () => {
    const source = fs.readFileSync("server/services/snowflake.ts", "utf8");
    expect(source).toContain(
      "sqlText: `SELECT CMB_THD_PTY_ID, CLIENT_NM FROM PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL WHERE SO_NO = ? LIMIT 1`",
    );
    const start = source.indexOf("export const fetchProcIdForServiceOrder");
    const procDriver = source.slice(start, source.indexOf("deadlineMs", start));
    expect(procDriver).not.toContain("HS_SP_CD");
    expect(procDriver).not.toContain("SERVICE_ORDER_APPLIANCE_SQL");
  });
});

describe("appliance type lookup", () => {
  it.each([
    ["Washer", "laundry", "Washer"],
    ["HVAC", "hvac", "HVAC"],
    [" refrigerator ", "refrigeration", "refrigerator"],
    ["MICROWAVE HOOD COMBO", "microwave", "MICROWAVE HOOD COMBO"],
  ])("maps %j to %s and returns the trimmed raw product", async (product, division, raw) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await createServiceOrderApplianceLookup(queryReturning([row(product)]))("8175-12345678"))
      .toEqual({ status: "found", applianceType: division, product: raw, serviceUnit: "0008175" });
  });

  it("leaves the type absent when the product is unknown, and the product too when blank", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const unknown = await createServiceOrderApplianceLookup(queryReturning([row("ZZTOP")]))("8175-12345678");
    expect(unknown).toEqual({ status: "found", product: "ZZTOP", serviceUnit: "0008175" });
    for (const product of ["", "   ", null]) {
      const result = await createServiceOrderApplianceLookup(queryReturning([row(product)]))("8175-12345678");
      expect(result).toEqual({ status: "found", serviceUnit: "0008175" });
      expect(result).not.toHaveProperty("applianceType");
      expect(result).not.toHaveProperty("product");
    }
  });

  it("returns the raw HS_SP_CD (non-PII) but never logs it or the unit; logs the SO and division only", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const lookup = createServiceOrderApplianceLookup(queryReturning([row("WASHERDD - WASHER, DIRECT DRIVE")]));
    const result = await lookup("8175-12345678");
    expect(result).toEqual({
      status: "found", applianceType: "laundry", product: "WASHERDD - WASHER, DIRECT DRIVE", serviceUnit: "0008175",
    });
    const logged = spies.flatMap((spy) => spy.mock.calls.flat()).join(" ");
    expect(logged).toContain("SO=8175-12345678");
    expect(logged).toContain("division=laundry");
    expect(logged).not.toMatch(/WASHERDD|DIRECT DRIVE|0008175/);
  });

  it("resolves the unit like the AHS prefill", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    // District differs, one unit: that unit's product (7995 -> 0008366).
    // The resolved unit comes back for the WOM lookup.
    expect(await createServiceOrderApplianceLookup(queryReturning([row("Washer", "0008366", 1)]))("7995-11075199"))
      .toEqual({ status: "found", applianceType: "laundry", product: "Washer", serviceUnit: "0008366" });
    // District matches among several units.
    expect(await createServiceOrderApplianceLookup(queryReturning([row("HVAC", "0007995", 3)]))("7995-11075199"))
      .toEqual({ status: "found", applianceType: "hvac", product: "HVAC", serviceUnit: "0007995" });
    // Several units, none the district: ambiguous.
    expect(await createServiceOrderApplianceLookup(queryReturning([row("Washer", "0008366", 2)]))("7995-11075199"))
      .toEqual({ status: "not_found" });
    expect(await createServiceOrderApplianceLookup(queryReturning([]))("7995-11075199")).toEqual({ status: "not_found" });
  });

  it("rejects malformed service orders before querying", async () => {
    const query = queryReturning([row("Washer")]);
    for (const so of ["", "12345678", "817-12345678", "8175-1234567", "8175-12345678; DROP"]) {
      expect(await createServiceOrderApplianceLookup(query)(so)).toEqual({ status: "not_found" });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("never rejects: a statement failure or the deadline is unavailable", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const failing = vi.fn<ServiceOrderApplianceQuery>(async () => { throw new Error("invalid identifier 'HS_SP_CD'"); });
    expect(await createServiceOrderApplianceLookup(failing)("8175-12345678")).toEqual({ status: "unavailable" });

    vi.useFakeTimers();
    let signal!: AbortSignal;
    const hung = vi.fn<ServiceOrderApplianceQuery>((_statement, s) => { signal = s; return new Promise(() => {}); });
    const pending = createServiceOrderApplianceLookup(hung)("8175-12345678");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ status: "unavailable" });
    expect(signal.aborted).toBe(true);
  });

  it("coalesces and caches by district and SO", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const query = queryReturning([row("Washer")]);
    const lookup = createServiceOrderApplianceLookup(query);
    const first = lookup("8175-12345678");
    expect(lookup(" 8175-12345678 ")).toBe(first);
    await first;
    await lookup("8175-12345678");
    await lookup("8176-12345678");
    expect(query).toHaveBeenCalledTimes(2);
  });
});
