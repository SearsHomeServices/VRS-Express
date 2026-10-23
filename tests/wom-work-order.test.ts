// WOM (ServicePower) work-order product category: server/services/
// wom-work-order.ts. Hermetic: fetch, the HSSOM token and Snowflake are
// doubles; no network.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WOM_DEFAULT_TIMEOUT_MS,
  buildWomOrderNum,
  classifyWomWorkOrderBody,
  createWomWorkOrderLookup,
  productCategoryFromWorkOrderRecord,
  readWomWorkOrderConfig,
  resolveServiceOrderProduct,
  womRequestUrl,
  type WomWorkOrderConfig,
  type WomWorkOrderLookupOptions,
} from "../server/services/wom-work-order";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const URL_PROD = "https://wom.example.test/v1/api/sb/proxy/serviceOrder/api/v1/work-orders";
const ORDER = "0008175-13717195";
const CATEGORY = "WASHERDD - WASHER, DIRECT DRIVE";
const PII = { name: "Jane Customer", phone: "2145550199", street: "626 W Elm St" };

const HSSOM_ENV = {
  HSSOM_AUTH_URL: "https://auth.example.test/token",
  HSSOM_CLIENT_CODE: "code",
  HSSOM_CLIENT_SECRET: "secret",
  HSSOM_CLIENT_ID: "client",
};

// A record shaped like doc §4 of ai-agent-mcp BUILD-WORK-ORDER-HISTORY-TOOL.md,
// with customer PII in Location[] so the log assertions mean something.
function record(products: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return {
    OrderNum: ORDER,
    OrderStatus: "AT",
    WorkItems: [{
      WorkItemId: `${ORDER}-01`,
      Products: products,
      Location: [{ Name: PII.name, Phone: PII.phone, Address: { AddrLine1: PII.street } }],
    }],
    ...extra,
  };
}
const envelope = (...data: unknown[]) => ({ total: data.length, limit: 10, skip: 0, data });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function quiet() {
  return (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
}

function setup(overrides: Partial<WomWorkOrderLookupOptions> & { config?: () => WomWorkOrderConfig | null } = {}) {
  const fetchMock = vi.fn<typeof fetch>(async () => json(envelope(record([{ Mfg: "WHIRLPOOL", Type: CATEGORY }]))));
  const getHssomToken = vi.fn(async () => "hssom-token-1");
  const invalidateHssomToken = vi.fn();
  const lookup = createWomWorkOrderLookup({
    enabled: () => true,
    config: () => ({ url: URL_PROD, tenantId: "TENANT", timeoutMs: 4000 }),
    getHssomToken,
    invalidateHssomToken,
    fetch: fetchMock,
    ...overrides,
  });
  return { lookup, fetchMock, getHssomToken, invalidateHssomToken };
}

describe("config", () => {
  it("needs an https URL, a tenant and a way to get a token", () => {
    const base = { WOM_WORK_ORDER_URL: URL_PROD, WOM_TENANT_ID: "TENANT", WOM_BEARER_TOKEN: "static" };
    expect(readWomWorkOrderConfig(base)).toEqual({ url: URL_PROD, tenantId: "TENANT", staticToken: "static", timeoutMs: WOM_DEFAULT_TIMEOUT_MS });
    expect(readWomWorkOrderConfig({ ...base, WOM_WORK_ORDER_URL: undefined })).toBeNull();
    expect(readWomWorkOrderConfig({ ...base, WOM_WORK_ORDER_URL: "http://wom.example.test/work-orders" })).toBeNull();
    expect(readWomWorkOrderConfig({ ...base, WOM_TENANT_ID: " " })).toBeNull();
    // No static token: the HSSOM gateway token, when HSSOM auth is configured.
    expect(readWomWorkOrderConfig({ ...base, WOM_BEARER_TOKEN: "" })).toBeNull();
    expect(readWomWorkOrderConfig({ ...base, WOM_BEARER_TOKEN: "", ...HSSOM_ENV }))
      .toEqual({ url: URL_PROD, tenantId: "TENANT", timeoutMs: WOM_DEFAULT_TIMEOUT_MS });
    expect(readWomWorkOrderConfig({ ...base, WOM_TIMEOUT_MS: "1500" })?.timeoutMs).toBe(1500);
    expect(readWomWorkOrderConfig({ ...base, WOM_TIMEOUT_MS: "soon" })?.timeoutMs).toBe(4000);
  });

  it("builds the composite order number and the reference request URL", () => {
    expect(buildWomOrderNum("8175", "13717195")).toBe(ORDER);
    expect(buildWomOrderNum("0008366", "11075199")).toBe("0008366-11075199");
    for (const [unit, so] of [["", "13717195"], ["81755555", "13717195"], ["8175", "1371719"], ["8175", "13717195; x"]]) {
      expect(buildWomOrderNum(unit, so)).toBeNull();
    }
    expect(womRequestUrl({ url: URL_PROD, tenantId: "XBrNUYNs0W" }, ORDER))
      .toBe(`${URL_PROD}?TenantId=XBrNUYNs0W&OrderNum=${ORDER}`);
  });
});

describe("product category parsing", () => {
  it("reads WorkItems[].Products[].Type, as a string or a code/description object", () => {
    expect(productCategoryFromWorkOrderRecord(record([{ Type: CATEGORY }]))).toBe(CATEGORY);
    expect(productCategoryFromWorkOrderRecord(record([{ Type: { Id: "WASHERDD", Description: "WASHER, DIRECT DRIVE" } }]))).toBe(CATEGORY);
    expect(productCategoryFromWorkOrderRecord(record([{ Type: { Id: "WASHERDD" } }]))).toBe("WASHERDD");
    expect(productCategoryFromWorkOrderRecord(record([{ Type: { Id: "WASHERDD", Name: CATEGORY } }]))).toBe(CATEGORY);
    expect(productCategoryFromWorkOrderRecord(record([{ Type: "  WASHERDD   -  WASHER ,\nDIRECT DRIVE " }])))
      .toBe("WASHERDD - WASHER , DIRECT DRIVE");
  });

  it("follows the documented priority order: Type, ProductCategory, ProductType, Category, ProductCode, MerchandiseCode", () => {
    const all = {
      Type: "T", ProductCategory: "PC", ProductType: "PT", Category: "C",
      ProductCode: "PCODE", MerchCode: "MCODE", Description: "DESC",
    };
    const drop = (...keys: string[]) => Object.fromEntries(Object.entries(all).filter(([k]) => !keys.includes(k)));
    expect(productCategoryFromWorkOrderRecord(record([all]))).toBe("T");
    expect(productCategoryFromWorkOrderRecord(record([drop("Type")]))).toBe("PC");
    expect(productCategoryFromWorkOrderRecord(record([drop("Type", "ProductCategory")]))).toBe("PT");
    expect(productCategoryFromWorkOrderRecord(record([drop("Type", "ProductCategory", "ProductType")]))).toBe("C");
    expect(productCategoryFromWorkOrderRecord(record([drop("Type", "ProductCategory", "ProductType", "Category")]))).toBe("PCODE - DESC");
    expect(productCategoryFromWorkOrderRecord(record([drop("Type", "ProductCategory", "ProductType", "Category", "ProductCode")]))).toBe("MCODE - DESC");
    // A description alone is not a category.
    expect(productCategoryFromWorkOrderRecord(record([{ Mfg: "LG", Description: "DESC" }]))).toBeUndefined();
    expect(productCategoryFromWorkOrderRecord(record([{ MerchandiseCode: "WASHTOP1YR4", MerchandiseDescription: "WASHER-TOP LOADING" }])))
      .toBe("WASHTOP1YR4 - WASHER-TOP LOADING");
  });

  it("a higher-priority field on any product beats a lower one on the first", () => {
    const rec = {
      OrderNum: ORDER,
      WorkItems: [{ Products: [{ ProductCategory: "FIRST VISIT CATEGORY" }] }, { Products: [{ Type: CATEGORY }] }],
    };
    expect(productCategoryFromWorkOrderRecord(rec)).toBe(CATEGORY);
    // Top-level Products[] is read after the work items.
    expect(productCategoryFromWorkOrderRecord({ WorkItems: [], Products: [{ Type: "TOP LEVEL" }] })).toBe("TOP LEVEL");
    expect(productCategoryFromWorkOrderRecord({ WorkItems: [{ Products: [] }] })).toBeUndefined();
  });

  it("classifies the envelope", () => {
    expect(classifyWomWorkOrderBody(envelope(record([{ Type: CATEGORY }])), ORDER)).toEqual({ status: "found", productCategory: CATEGORY });
    expect(classifyWomWorkOrderBody(envelope(record([{ Mfg: "LG" }])), ORDER)).toEqual({ status: "found" });
    // Empty data on HTTP 200 is "not found", not an error (doc §5).
    expect(classifyWomWorkOrderBody({ total: 0, data: [] }, ORDER)).toEqual({ status: "not_found" });
    expect(classifyWomWorkOrderBody({ error: "x" }, ORDER)).toMatchObject({ status: "unavailable" });
    expect(classifyWomWorkOrderBody("nope", ORDER)).toMatchObject({ status: "unavailable" });
    // Another unit's order is never used.
    expect(classifyWomWorkOrderBody(envelope({ ...record([{ Type: CATEGORY }]), OrderNum: "0008366-13717195" }), ORDER))
      .toMatchObject({ status: "not_found" });
    expect(classifyWomWorkOrderBody(envelope({ ...record([{ Type: CATEGORY }]), OrderNum: "8175-13717195" }), ORDER))
      .toEqual({ status: "found", productCategory: CATEGORY });
  });
});

describe("request and auth", () => {
  it("sends the reference GET with Accept and the HSSOM bearer token when no static token is set", async () => {
    quiet();
    const { lookup, fetchMock, getHssomToken } = setup();
    expect(await lookup("8175", "13717195")).toEqual({ status: "found", productCategory: CATEGORY });
    expect(getHssomToken).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(`${URL_PROD}?TenantId=TENANT&OrderNum=${ORDER}`);
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ Accept: "application/json", Authorization: "Bearer hssom-token-1" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses WOM_BEARER_TOKEN when set, and never asks HSSOM", async () => {
    quiet();
    const { lookup, fetchMock, getHssomToken } = setup({
      config: () => ({ url: URL_PROD, tenantId: "TENANT", staticToken: "static-wom", timeoutMs: 4000 }),
    });
    expect(await lookup("8175", "13717195")).toMatchObject({ status: "found" });
    expect(getHssomToken).not.toHaveBeenCalled();
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer static-wom");
  });

  it("a static token 401 is unavailable without a retry", async () => {
    quiet();
    const { lookup, fetchMock, invalidateHssomToken } = setup({
      config: () => ({ url: URL_PROD, tenantId: "TENANT", staticToken: "static-wom", timeoutMs: 4000 }),
    });
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    expect(await lookup("8175", "13717195")).toEqual({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invalidateHssomToken).not.toHaveBeenCalled();
  });

  it("an HSSOM token 401 invalidates that token and retries once with a fresh one", async () => {
    quiet();
    const { lookup, fetchMock, getHssomToken, invalidateHssomToken } = setup();
    getHssomToken.mockResolvedValueOnce("stale").mockResolvedValueOnce("fresh");
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(json(envelope(record([{ Type: CATEGORY }]))));
    expect(await lookup("8175", "13717195")).toEqual({ status: "found", productCategory: CATEGORY });
    expect(invalidateHssomToken).toHaveBeenCalledWith("stale");
    expect(fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).Authorization))
      .toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("a second 401 is unavailable; so is a token failure", async () => {
    quiet();
    const twice = setup();
    twice.fetchMock.mockImplementation(async () => new Response("", { status: 401 }));
    expect(await twice.lookup("8175", "13717195")).toEqual({ status: "unavailable" });
    expect(twice.fetchMock).toHaveBeenCalledTimes(2);
    expect(twice.invalidateHssomToken).toHaveBeenCalledTimes(2);

    const noToken = setup();
    noToken.getHssomToken.mockRejectedValue(new Error("HSSOM auth failed: HTTP 500"));
    expect(await noToken.lookup("8175", "13717195")).toEqual({ status: "unavailable" });
    expect(noToken.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [404, { status: "not_found" }],
    [403, { status: "unavailable" }],
    [500, { status: "unavailable" }],
  ])("HTTP %i is %j", async (status, expected) => {
    quiet();
    const { lookup, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response("<html>err</html>", { status }));
    expect(await lookup("8175", "13717195")).toEqual(expected);
  });

  it("bad JSON and network errors are unavailable", async () => {
    quiet();
    const bad = setup();
    bad.fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));
    expect(await bad.lookup("8175", "13717195")).toEqual({ status: "unavailable" });
    const down = setup();
    down.fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await down.lookup("8175", "13717195")).toEqual({ status: "unavailable" });
  });
});

describe("gating", () => {
  it("makes no call while the flag is off or the config is missing", async () => {
    const off = setup({ enabled: () => false });
    expect(await off.lookup("8175", "13717195")).toEqual({ status: "unavailable" });
    const unconfigured = setup({ config: () => null });
    expect(await unconfigured.lookup("8175", "13717195")).toEqual({ status: "unavailable" });
    for (const { fetchMock, getHssomToken } of [off, unconfigured]) {
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getHssomToken).not.toHaveBeenCalled();
    }
  });

  it("the default lookup reads WOM_PRODUCT_LOOKUP_ENABLED and the env vars", async () => {
    const keys = ["WOM_PRODUCT_LOOKUP_ENABLED", "WOM_WORK_ORDER_URL", "WOM_TENANT_ID", "WOM_BEARER_TOKEN"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const fetchMock = vi.fn<typeof fetch>(async () => json(envelope()));
    try {
      const lookup = createWomWorkOrderLookup({ fetch: fetchMock });
      process.env.WOM_PRODUCT_LOOKUP_ENABLED = "false";
      process.env.WOM_WORK_ORDER_URL = URL_PROD;
      process.env.WOM_TENANT_ID = "TENANT";
      process.env.WOM_BEARER_TOKEN = "static";
      expect(await lookup("8175", "13717195")).toEqual({ status: "unavailable" });
      process.env.WOM_PRODUCT_LOOKUP_ENABLED = "true";
      delete process.env.WOM_TENANT_ID;
      expect(await lookup("8175", "13717195")).toEqual({ status: "unavailable" });
      expect(fetchMock).not.toHaveBeenCalled();
      process.env.WOM_TENANT_ID = "TENANT";
      quiet();
      expect(await lookup("8175", "13717195")).toEqual({ status: "not_found" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("rejects malformed input before any call", async () => {
    const { lookup, fetchMock } = setup();
    expect(await lookup("", "13717195")).toEqual({ status: "not_found" });
    expect(await lookup("8175", "137")).toEqual({ status: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("timeout, cache and coalescing", () => {
  it("aborts a hung request at the timeout", async () => {
    quiet();
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const { lookup } = setup({
      config: () => ({ url: URL_PROD, tenantId: "TENANT", timeoutMs: 4000 }),
      fetch: vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })),
    });
    const pending = lookup("8175", "13717195");
    await vi.advanceTimersByTimeAsync(3999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: "unavailable" });
    expect(signal?.aborted).toBe(true);
  });

  it("the timeout also covers a hung HSSOM token request", async () => {
    quiet();
    vi.useFakeTimers();
    const { lookup, fetchMock } = setup({ getHssomToken: () => new Promise(() => {}) });
    const pending = lookup("8175", "13717195");
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches found for 6 h and not_found for 2 min; never caches unavailable", async () => {
    quiet();
    let clock = 1_000_000;
    const { lookup, fetchMock } = setup({ now: () => clock });
    await lookup("8175", "13717195");
    clock += 6 * 60 * 60 * 1000 - 1;
    expect(await lookup("8175", "13717195")).toEqual({ status: "found", productCategory: CATEGORY });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock += 1;
    await lookup("8175", "13717195");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockImplementation(async () => json(envelope()));
    await lookup("8175", "22222222");
    clock += 2 * 60 * 1000 - 1;
    expect(await lookup("8175", "22222222")).toEqual({ status: "not_found" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    clock += 1;
    await lookup("8175", "22222222");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    await lookup("8175", "33333333");
    await lookup("8175", "33333333");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("is a bounded LRU", async () => {
    quiet();
    const { lookup, fetchMock } = setup({ cacheSize: 2 });
    await lookup("8175", "11111111");
    await lookup("8175", "22222222");
    await lookup("8175", "11111111"); // hit: 1 is now most recent
    await lookup("8175", "33333333"); // evicts 2
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await lookup("8175", "11111111");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await lookup("8175", "22222222");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("coalesces concurrent lookups of one order; padded and bare units are one order", async () => {
    quiet();
    const { lookup, fetchMock, getHssomToken } = setup();
    const results = await Promise.all([lookup("8175", "13717195"), lookup("0008175", "13717195"), lookup("8175", "13717195")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getHssomToken).toHaveBeenCalledTimes(1);
    expect(results).toEqual([1, 2, 3].map(() => ({ status: "found", productCategory: CATEGORY })));
    // Callers get copies: mutating one never touches the cache.
    (results[0] as any).productCategory = "changed";
    expect(await lookup("8175", "13717195")).toEqual({ status: "found", productCategory: CATEGORY });
  });
});

describe("logging", () => {
  it("logs the order, status, HTTP status and ms only: never the body, the category or the token", async () => {
    const spies = quiet();
    const { lookup, fetchMock } = setup({
      config: () => ({ url: URL_PROD, tenantId: "TENANT", staticToken: "static-wom-secret", timeoutMs: 4000 }),
    });
    await lookup("8175", "13717195");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: `bad ${PII.name}` }), { status: 500 }));
    await lookup("8175", "22222222");
    const logged = spies.flatMap((spy) => spy.mock.calls.flat()).map(String).join("\n");
    expect(logged).toMatch(new RegExp(`\\[wom-lookup\\] order=${ORDER} status=found http=200 ms=\\d+`));
    expect(logged).toMatch(/order=0008175-22222222 status=unavailable http=500 ms=\d+/);
    for (const secret of [PII.name, PII.phone, PII.street, "WASHERDD", "DIRECT DRIVE", "static-wom-secret", "TENANT"]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("resolveServiceOrderProduct", () => {
  const sfFound = { status: "found" as const, applianceType: "refrigeration" as const, product: "Refrigerator", serviceUnit: "0008175" };

  it("does not wait for Snowflake once WOM has the category", async () => {
    quiet();
    const snowflake = vi.fn(() => new Promise<never>(() => {}));
    const wom = vi.fn(async () => ({ status: "found" as const, productCategory: CATEGORY }));
    expect(await resolveServiceOrderProduct("8175-13717195", { snowflake, wom, womBudgetMs: 100 })).toEqual({
      serviceOrderProduct: { text: CATEGORY, source: "wom" },
      applianceType: "laundry",
    });
  });

  it("keeps the WOM text even when it maps to no division", async () => {
    quiet();
    const wom = vi.fn(async () => ({ status: "found" as const, productCategory: "ZZTOP - SOMETHING" }));
    expect(await resolveServiceOrderProduct("8175-13717195", { snowflake: async () => sfFound, wom })).toEqual({
      serviceOrderProduct: { text: "ZZTOP - SOMETHING", source: "wom" },
    });
  });

  it("does not ask WOM again when Snowflake resolved the district itself", async () => {
    quiet();
    const wom = vi.fn(async () => ({ status: "not_found" as const }));
    const result = await resolveServiceOrderProduct("8175-13717195", { snowflake: async () => sfFound, wom });
    expect(wom).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ serviceOrderProduct: { text: "Refrigerator", source: "snowflake" }, applianceType: "refrigeration" });
  });

  it("bounds a slow WOM and falls back to Snowflake", async () => {
    quiet();
    vi.useFakeTimers();
    const pending = resolveServiceOrderProduct("8175-13717195", {
      snowflake: async () => sfFound,
      wom: () => new Promise(() => {}),
      womBudgetMs: 4000,
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect((await pending).serviceOrderProduct).toEqual({ text: "Refrigerator", source: "snowflake" });
  });

  it("answers nothing for bad input, failures on both sides, or neither found; never rejects", async () => {
    quiet();
    const snowflake = vi.fn(async () => ({ status: "not_found" as const }));
    const wom = vi.fn(async () => ({ status: "not_found" as const }));
    expect(await resolveServiceOrderProduct("13717195", { snowflake, wom })).toEqual({});
    expect(snowflake).not.toHaveBeenCalled();
    expect(wom).not.toHaveBeenCalled();
    expect(await resolveServiceOrderProduct("8175-13717195", { snowflake, wom })).toEqual({});
    expect(await resolveServiceOrderProduct("8175-13717195", {
      snowflake: () => { throw new Error("sf"); },
      wom: async () => { throw new Error("wom"); },
    })).toEqual({});
  });

  it("never logs the product text", async () => {
    const spies = quiet();
    await resolveServiceOrderProduct("8175-13717195", {
      snowflake: async () => sfFound,
      wom: async () => ({ status: "found", productCategory: CATEGORY }),
    });
    const logged = spies.flatMap((spy) => spy.mock.calls.flat()).map(String).join("\n");
    expect(logged).toContain("SO=8175-13717195 source=wom");
    expect(logged).not.toMatch(/WASHERDD|DIRECT DRIVE|Refrigerator/);
  });
});
