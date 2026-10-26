// Appliance type from the service order (HS_SP_CD -> division) for
// GET /api/tech/lookup-warranty and submit (the fallback when WOM has no
// product category): server/services/snowflake-lookup.ts
// createServiceOrderApplianceLookup. Hermetic: Snowflake is a double.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AHS_PREFILL_CORE_SQL,
  AHS_PREFILL_PARTS_SQL,
  PROC_ID_SQL,
  SERVICE_ORDER_APPLIANCE_FALLBACK_SQL,
  SERVICE_ORDER_APPLIANCE_SQL,
  createProcLookup,
  createServiceOrderApplianceLookup,
  pickApplianceServiceUnit,
  type ServiceOrderApplianceQuery,
} from "../server/services/snowflake-lookup";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const row = (product: unknown, unit = "0008175", count = 1) => ({ SERVICE_UNIT: unit, UNIT_COUNT: count, PRODUCT: product });
const queryReturning = (rows: any[]) => vi.fn<ServiceOrderApplianceQuery>(async () => rows);

describe("appliance type statement", () => {
  it("is its own statement on HS_SP_CD, matched by SO, the district's order first, then the most recent", async () => {
    expect(SERVICE_ORDER_APPLIANCE_SQL).toBe(
      "SELECT SVC_UN_NO AS SERVICE_UNIT, COUNT(DISTINCT SVC_UN_NO) OVER () AS UNIT_COUNT, HS_SP_CD AS PRODUCT " +
      "FROM PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL " +
      "WHERE SO_NO = ? ORDER BY CASE WHEN SVC_UN_NO = LPAD(?, 7, '0') THEN 0 ELSE 1 END, SO_CRT_DT DESC NULLS LAST LIMIT 1",
    );
    // The statement before the SO_CRT_DT ordering, kept as the fallback.
    expect(SERVICE_ORDER_APPLIANCE_FALLBACK_SQL).toBe(
      "SELECT SVC_UN_NO AS SERVICE_UNIT, COUNT(DISTINCT SVC_UN_NO) OVER () AS UNIT_COUNT, HS_SP_CD AS PRODUCT " +
      "FROM PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL " +
      "WHERE SO_NO = ? ORDER BY CASE WHEN SVC_UN_NO = LPAD(?, 7, '0') THEN 0 ELSE 1 END LIMIT 1",
    );
    vi.spyOn(console, "info").mockImplementation(() => {});
    const query = queryReturning([row("Washer")]);
    await createServiceOrderApplianceLookup(query)("8175-12345678");
    expect(query.mock.calls[0][0]).toEqual({ sqlText: SERVICE_ORDER_APPLIANCE_SQL, binds: ["12345678", "8175"] });
  });

  it("never touches the ProcID statement", async () => {
    expect(PROC_ID_SQL).not.toContain("HS_SP_CD");
    const query = vi.fn<ServiceOrderApplianceQuery>(async () => [{ CMB_THD_PTY_ID: "AHS-1", CLIENT_NM: "AHS" }]);
    await createProcLookup(query)("8175-12345678");
    expect(query.mock.calls.map(([statement]) => statement.sqlText)).toEqual([PROC_ID_SQL]);
    const source = fs.readFileSync("server/services/snowflake.ts", "utf8");
    const start = source.indexOf("export const fetchProcIdForServiceOrder");
    const procDriver = source.slice(start, source.indexOf(";", start));
    expect(procDriver).not.toContain("HS_SP_CD");
    expect(procDriver).not.toContain("SERVICE_ORDER_APPLIANCE_SQL");
  });

  it("has the ProcID lookup's deadline", () => {
    const source = fs.readFileSync("server/services/snowflake.ts", "utf8");
    expect(source).toContain(
      "const SERVICE_ORDER_LOOKUP_DEADLINE_MS = Math.max(1, Math.min(SNOWFLAKE_OP_TIMEOUT_MS, 60000));",
    );
    const driverOptions = (name: string) => {
      const start = source.indexOf(`export const ${name}`);
      return source.slice(start, source.indexOf(";", start));
    };
    expect(driverOptions("fetchProcIdForServiceOrder")).toContain("{ deadlineMs: SERVICE_ORDER_LOOKUP_DEADLINE_MS }");
    expect(driverOptions("fetchServiceOrderApplianceType")).toContain("{ deadlineMs: SERVICE_ORDER_LOOKUP_DEADLINE_MS }");
  });

  it("leaves the AHS prefill statements strict (no SO_CRT_DT ordering)", () => {
    for (const sql of [AHS_PREFILL_CORE_SQL, AHS_PREFILL_PARTS_SQL]) {
      expect(sql).not.toContain("SO_CRT_DT");
      expect(sql).toContain("ORDER BY CASE WHEN SVC_UN_NO = LPAD(?, 7, '0') THEN 0 ELSE 1 END LIMIT 1");
    }
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

  it("picks the district's unit, else the only unit, else the most recent order's unit", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const logged = () => info.mock.calls.flat().join(" ");
    // District matches among several units.
    expect(await createServiceOrderApplianceLookup(queryReturning([row("HVAC", "0007995", 3)]))("7995-11075199"))
      .toEqual({ status: "found", applianceType: "hvac", product: "HVAC", serviceUnit: "0007995" });
    expect(logged()).toContain("SO=7995-11075199 status=found units=3 pick=district division=hvac");
    // District differs, one unit: that unit's product (7995 -> 0008366).
    // The resolved unit comes back for the WOM lookup.
    expect(await createServiceOrderApplianceLookup(queryReturning([row("Washer", "0008366", 1)]))("7995-11075199"))
      .toEqual({ status: "found", applianceType: "laundry", product: "Washer", serviceUnit: "0008366" });
    expect(logged()).toContain("units=1 pick=single division=laundry");
    // Several units, none the district: the most recent order's row (the
    // statement's ORDER BY puts it first), no longer not_found. The DEV case:
    // 7995-11075199 lives under 0008366 among other units.
    const product = "WASHERDD - WASHER, DIRECT DRIVE";
    expect(await createServiceOrderApplianceLookup(queryReturning([row(product, "0008366", 2)]))("7995-11075199"))
      .toEqual({ status: "found", applianceType: "laundry", product, serviceUnit: "0008366" });
    expect(logged()).toContain("units=2 pick=recent division=laundry");
    expect(logged()).not.toMatch(/0008366|WASHERDD/);
    expect(await createServiceOrderApplianceLookup(queryReturning([]))("7995-11075199")).toEqual({ status: "not_found" });
    expect(logged()).toContain("status=not_found units=0 pick=none division=none");
  });

  it("pickApplianceServiceUnit", () => {
    expect(pickApplianceServiceUnit({ SERVICE_UNIT: "0007995", UNIT_COUNT: 3 }, "7995")).toEqual({ serviceUnit: "0007995", pick: "district" });
    expect(pickApplianceServiceUnit({ SERVICE_UNIT: "8366", UNIT_COUNT: "1" }, "7995")).toEqual({ serviceUnit: "0008366", pick: "single" });
    expect(pickApplianceServiceUnit({ SERVICE_UNIT: "0008366", UNIT_COUNT: 4 }, "7995")).toEqual({ serviceUnit: "0008366", pick: "recent" });
    expect(pickApplianceServiceUnit({ SERVICE_UNIT: "ABC", UNIT_COUNT: 1 }, "7995")).toBeUndefined();
    expect(pickApplianceServiceUnit({ SERVICE_UNIT: null }, "7995")).toBeUndefined();
  });

  it("falls back to the unordered statement, with the strict rule, when the ordered one fails", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failingOrdered = (rows: any[]) => vi.fn<ServiceOrderApplianceQuery>(async ({ sqlText }) => {
      if (sqlText === SERVICE_ORDER_APPLIANCE_SQL) throw new Error("SQL compilation error: invalid identifier 'SO_CRT_DT'");
      return rows;
    });
    const query = failingOrdered([row("Washer", "0008366", 1)]);
    expect(await createServiceOrderApplianceLookup(query)("7995-11075199"))
      .toEqual({ status: "found", applianceType: "laundry", product: "Washer", serviceUnit: "0008366" });
    expect(query.mock.calls.map(([statement]) => statement)).toEqual([
      { sqlText: SERVICE_ORDER_APPLIANCE_SQL, binds: ["11075199", "7995"] },
      { sqlText: SERVICE_ORDER_APPLIANCE_FALLBACK_SQL, binds: ["11075199", "7995"] },
    ]);
    expect(warn.mock.calls.flat().join(" ")).toContain("[appliance-type] SO=7995-11075199 ordered statement failed");
    // Without the date ordering the row is arbitrary among several units.
    expect(await createServiceOrderApplianceLookup(failingOrdered([row("Washer", "0008366", 2)]))("7995-11075199"))
      .toEqual({ status: "not_found" });
    expect(await createServiceOrderApplianceLookup(failingOrdered([row("HVAC", "0007995", 2)]))("7995-11075199"))
      .toEqual({ status: "found", applianceType: "hvac", product: "HVAC", serviceUnit: "0007995" });
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn<ServiceOrderApplianceQuery>(async () => { throw new Error("invalid identifier 'HS_SP_CD'"); });
    expect(await createServiceOrderApplianceLookup(failing)("8175-12345678")).toEqual({ status: "unavailable" });
    expect(failing).toHaveBeenCalledTimes(2); // the ordered statement, then the fallback

    // The default deadline is the ProcID lookup's default (15s), no longer 5s.
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const hung = vi.fn<ServiceOrderApplianceQuery>((_statement, s) => { signal = s; return new Promise(() => {}); });
    const pending = createServiceOrderApplianceLookup(hung)("8175-12345678");
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
    let procSettled = false;
    void createProcLookup(vi.fn<ServiceOrderApplianceQuery>(() => new Promise(() => {})))("8175-12345678")
      .then(() => { procSettled = true; });
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toEqual({ status: "unavailable" });
    expect(signal.aborted).toBe(true);
    expect(hung).toHaveBeenCalledTimes(1); // no fallback after the deadline
    await vi.advanceTimersByTimeAsync(5000);
    expect(procSettled).toBe(true);
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
