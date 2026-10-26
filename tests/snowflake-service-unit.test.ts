// Service unit resolution for the AHS prefill (server/services/snowflake-lookup.ts)
// and the HSSOM order ID (server/ahs-prefill.ts lookupAhsPrefillSources).
// The real case: the tech typed district 7995, the order lives under unit
// 0008366 (ServicePower "0008366-11075199"). Hermetic: Snowflake and HSSOM
// are doubles.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAhsPrefillLookup,
  normalizeServiceUnit,
  resolveServiceUnit,
  type AhsPrefillLookupResult,
  type AhsPrefillQuery,
} from "../server/services/snowflake-lookup";
import { hssomDistrictFromServiceUnit, lookupAhsPrefillSources } from "../server/ahs-prefill";
import { buildHssomOrderId, type HssomOrderLookupResult } from "../server/services/hssom-order-lookup";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ok = (rows: any[]): PromiseSettledResult<any[]> => ({ status: "fulfilled", value: rows });

const SECRET_BRAND = "Whirlpool";
const SECRET_MODEL = "WTW5000DW1";
const SECRET_PART = "WPW10503278";

function rowsFor(unit: string, unitCount: number) {
  return [
    ok([{ SERVICE_UNIT: unit, UNIT_COUNT: unitCount, BRAND: SECRET_BRAND, PARTNER_ID: "AHS-1", CLIENT_NAME: "American Home Shield" }]),
    ok([{ SERVICE_UNIT: unit, PART_NUMBER: SECRET_PART, QUANTITY: 1, UNIT_PRICE: 10, STATUS: "I" }]),
  ];
}

describe("resolveServiceUnit", () => {
  it("prefers the district, else a single unit, else nothing", () => {
    expect(resolveServiceUnit({ SERVICE_UNIT: "0008175", UNIT_COUNT: 3 }, "8175")).toBe("0008175");
    expect(resolveServiceUnit({ SERVICE_UNIT: "0008366", UNIT_COUNT: 1 }, "7995")).toBe("0008366");
    expect(resolveServiceUnit({ SERVICE_UNIT: "0008366", UNIT_COUNT: "1" }, "7995")).toBe("0008366");
    expect(resolveServiceUnit({ SERVICE_UNIT: "0008366", UNIT_COUNT: 2 }, "7995")).toBeUndefined();
    expect(resolveServiceUnit({ SERVICE_UNIT: null, UNIT_COUNT: 0 }, "7995")).toBeUndefined();
    expect(resolveServiceUnit({ SERVICE_UNIT: "ABC", UNIT_COUNT: 1 }, "7995")).toBeUndefined();
    expect(resolveServiceUnit(undefined, "7995")).toBeUndefined();
  });

  it("normalizes units to 7 digits", () => {
    expect(normalizeServiceUnit(" 0008366 ")).toBe("0008366");
    expect(normalizeServiceUnit("8366")).toBe("0008366");
    expect(normalizeServiceUnit(8366)).toBe("0008366");
    expect(normalizeServiceUnit("12345678")).toBeUndefined();
    expect(normalizeServiceUnit("")).toBeUndefined();
  });
});

describe("AHS prefill resolves the unit from the service order", () => {
  it("district matches: uses that unit", async () => {
    const query = vi.fn<AhsPrefillQuery>(async () => rowsFor("0008175", 2));
    const result = await createAhsPrefillLookup(query)("8175", "12345678");
    expect(result).toMatchObject({
      status: "found", serviceUnit: "0008175", brand: SECRET_BRAND,
      parts: [{ partNumber: SECRET_PART, quantity: 1, unitPrice: 10 }],
    });
  });

  it("district differs but the order has one unit: uses that unit (7995 -> 0008366)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const query = vi.fn<AhsPrefillQuery>(async () => rowsFor("0008366", 1));
    const result = await createAhsPrefillLookup(query)("7995", "11075199");
    expect(result).toMatchObject({
      status: "found", serviceUnit: "0008366", brand: SECRET_BRAND,
      parts: [{ partNumber: SECRET_PART }],
    });
    // Every statement matched by SO; the district only orders the rows.
    const [statements] = query.mock.calls[0];
    expect(statements.map((s) => s.binds)).toEqual([
      ["11075199", "7995"], ["11075199", "11075199", "7995"],
    ]);
  });

  it("several units and none the district: not_found, nothing returned or logged", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const query = vi.fn<AhsPrefillQuery>(async () => rowsFor("0008366", 2));
    expect(await createAhsPrefillLookup(query)("7995", "11075199")).toEqual({ status: "not_found" });
    const logged = spies.flatMap((spy) => spy.mock.calls.flat()).join(" ");
    expect(logged).toContain("SO=7995-11075199");
    for (const value of ["0008366", SECRET_BRAND, SECRET_MODEL, SECRET_PART]) expect(logged).not.toContain(value);
  });

  it("parts rows under another unit than the resolved one are dropped", async () => {
    const query = vi.fn<AhsPrefillQuery>(async () => [
      ok([{ SERVICE_UNIT: "0008175", UNIT_COUNT: 2, BRAND: SECRET_BRAND, PARTNER_ID: "AHS-1", CLIENT_NAME: "AHS" }]),
      ok([
        { SERVICE_UNIT: "0009999", PART_NUMBER: "OTHER-UNIT", QUANTITY: 1 },
        { SERVICE_UNIT: " 0008175 ", PART_NUMBER: SECRET_PART, QUANTITY: 1 },
      ]),
    ]);
    const result = await createAhsPrefillLookup(query)("8175", "12345678");
    expect(result).toMatchObject({ status: "found", serviceUnit: "0008175", parts: [{ partNumber: SECRET_PART }] });
    expect(result).toEqual({
      status: "found", serviceUnit: "0008175", brand: SECRET_BRAND, partnerId: "AHS-1", clientName: "AHS",
      parts: [{ partNumber: SECRET_PART, quantity: 1 }],
    });
  });
});

describe("HSSOM order ID uses the resolved unit", () => {
  const sfFound = (serviceUnit?: string): AhsPrefillLookupResult => ({
    status: "found", brand: SECRET_BRAND, partnerId: "AHS-1", clientName: "American Home Shield", serviceUnit,
  });
  const customerAt = (district: string): HssomOrderLookupResult =>
    ({ status: "found", customerName: `customer of ${district}` });

  it("asks HSSOM for <resolved unit>-<SO> when Snowflake found the order under another unit", async () => {
    const hssom = vi.fn(async (district: string) => customerAt(district));
    const sources = await lookupAhsPrefillSources("7995-11075199", { snowflake: async () => sfFound("0008366"), hssom });
    expect(sources.hssom).toEqual(customerAt("8366"));
    expect(hssom).toHaveBeenLastCalledWith("8366", "11075199");
    expect(buildHssomOrderId("8366", "11075199")).toBe("0008366-11075199");
  });

  it("uses the district's answer when the order is under the district", async () => {
    const hssom = vi.fn(async (district: string) => customerAt(district));
    const sources = await lookupAhsPrefillSources("8175-12345678", { snowflake: async () => sfFound("0008175"), hssom });
    expect(sources.hssom).toEqual(customerAt("8175"));
    expect(hssom).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["off", null],
    ["unavailable", async () => ({ status: "unavailable" }) as AhsPrefillLookupResult],
    ["not_found (ambiguous)", async () => ({ status: "not_found" }) as AhsPrefillLookupResult],
  ])("falls back to the padded district when Snowflake is %s", async (_label, snowflake) => {
    const hssom = vi.fn(async (district: string) => customerAt(district));
    const sources = await lookupAhsPrefillSources("7995-11075199", { snowflake, hssom });
    expect(sources.hssom).toEqual(customerAt("7995"));
    expect(hssom).toHaveBeenCalledTimes(1);
    expect(hssom).toHaveBeenCalledWith("7995", "11075199");
  });

  it("never uses the district's answer for an order under another unit", async () => {
    const hssom = vi.fn(async (district: string) => customerAt(district));
    // No 4-digit form for HSSOM: no HSSOM values rather than the district's order.
    const wide = await lookupAhsPrefillSources("7995-11075199", { snowflake: async () => sfFound("0012345"), hssom });
    expect(wide.hssom).toEqual({ status: "not_found" });
    expect(hssomDistrictFromServiceUnit("0012345")).toBeUndefined();
    expect(hssomDistrictFromServiceUnit("0008366")).toBe("8366");
  });

  it("stays bounded and never rejects when the second HSSOM call hangs or fails", async () => {
    vi.useFakeTimers();
    const hssom = vi.fn((district: string) => district === "8366"
      ? new Promise<HssomOrderLookupResult>(() => {})
      : Promise.resolve(customerAt(district)));
    const pending = lookupAhsPrefillSources("7995-11075199", { snowflake: async () => sfFound("0008366"), hssom }, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ snowflake: sfFound("0008366"), hssom: { status: "unavailable" } });

    vi.useRealTimers();
    const failing = vi.fn(async (district: string) => {
      if (district === "8366") throw new Error("HSSOM 500");
      return customerAt(district);
    });
    expect((await lookupAhsPrefillSources("7995-11075199", { snowflake: async () => sfFound("0008366"), hssom: failing })).hssom)
      .toEqual({ status: "unavailable" });
  });
});
