import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHssomTokenClient,
  hssomBasicCredential,
  readHssomAuthConfig,
  type HssomAuthConfig,
} from "../server/services/hssom-auth";
import {
  buildHssomOrderId,
  classifyHssomOrderBody,
  createHssomOrderLookup,
  formatCustomerAddress,
  formatCustomerName,
  lookupHeaders,
  lookupHssomOrder,
  readHssomOrderLookupConfig,
  toIsoDate,
  type HssomOrderLookupConfig,
} from "../server/services/hssom-order-lookup";
import { isAhsHssomCustomerPrefillEnabled } from "../server/featureFlags";

// Values that must never reach a log line.
const SECRET = "s3cr3t-Value!";
const CLIENT_CODE = "VRSXCODE";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.TOKEN-ONE";
const TOKEN_2 = "eyJhbGciOiJIUzI1NiJ9.TOKEN-TWO";
const FIRST = "HELEN";
const LAST = "SANFORD";
const STREET = "12 ELM ST";

const AUTH_URL = "https://auth.hssom.test/HSSOMAuthService/services/auth/token";
const LOOKUP_URL = "https://gateway.hssom.test/orders";

const ENV_KEYS = [
  "AHS_HSSOM_CUSTOMER_PREFILL_ENABLED", "HSSOM_ORDER_LOOKUP_URL", "HSSOM_AUTH_URL", "HSSOM_CLIENT_CODE",
  "HSSOM_CLIENT_SECRET", "HSSOM_CLIENT_ID", "HSSOM_USER_ID", "HSSOM_TIMEOUT_MS", "HSSOM_LOOKUP_CLIENT_ID",
];

const authConfig: HssomAuthConfig = {
  authUrl: AUTH_URL, clientCode: CLIENT_CODE, clientSecret: SECRET, clientId: "VRSX", userId: "VRSXUSER", timeoutMs: 5000,
};
const lookupConfig: HssomOrderLookupConfig = { lookupUrl: LOOKUP_URL, lookupClientId: "TABS", timeoutMs: 5000 };

// Order Lookup headers (optimizer commit 39047f9): clientid TABS, not the
// auth client ID and not CreateOrder's clientId WBOT.
const lookupHeadersFor = (token: string, clientid = "TABS") => ({
  servicename: "IHSOLookup",
  serviceversion: "1.0",
  clientid,
  Accept: "application/json",
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
});

const orderBody = {
  serviceOrder: {
    customer: {
      name: { firstName: ` ${FIRST} `, lastName: LAST },
      address: { addressLine1: STREET, addressLine2: " ", city: "STAMFORD", state: "CT", zipCode: "06902" },
    },
    merchandise: {
      brand: { brandName: " Whirlpool " },
      modelNumber: "WTW5000DW1",
      serialNumber: " C31290822 ",
      purchaseDate: "2021-03-15T00:00:00",
    },
    thirdParty: { contractNumber: " 551200/0003 " },
  },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let logs: unknown[][];
beforeEach(() => {
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args); });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

function expectCleanLogs() {
  const text = JSON.stringify(logs);
  for (const value of [SECRET, CLIENT_CODE, TOKEN, TOKEN_2, FIRST, LAST, STREET, "Helen", "STAMFORD", "551200", "Whirlpool",
    Buffer.from(SECRET).toString("base64"), hssomBasicCredential(CLIENT_CODE, SECRET)]) {
    expect(text).not.toContain(value);
  }
}

function lookupWith(fetchMock: ReturnType<typeof vi.fn>, extra: Parameters<typeof createHssomOrderLookup>[0] = {}) {
  let tokenCalls = 0;
  const invalidated: string[] = [];
  const lookup = createHssomOrderLookup({
    enabled: () => true,
    config: () => lookupConfig,
    getToken: async () => (tokenCalls++ === 0 ? TOKEN : TOKEN_2),
    invalidateToken: (token) => { invalidated.push(token); },
    fetch: fetchMock as unknown as typeof fetch,
    ...extra,
  });
  return { lookup, invalidated, tokenCalls: () => tokenCalls };
}

describe("HSSOM auth", () => {
  it("nests Base64: Basic Base64(code:Base64(secret))", () => {
    const basic = hssomBasicCredential(CLIENT_CODE, SECRET);
    const decoded = Buffer.from(basic, "base64").toString("utf8");
    expect(decoded).toBe(`${CLIENT_CODE}:${Buffer.from(SECRET).toString("base64")}`);
    expect(hssomBasicCredential("abc", "xyz")).toBe(Buffer.from("abc:eHl6").toString("base64"));
  });

  it("sends GET with Basic auth, Accept, clientid and userid", async () => {
    const fetchMock = vi.fn(async () => json(200, { token: TOKEN, tokenLife: 5400 }));
    const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getToken()).resolves.toBe(TOKEN);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(AUTH_URL);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: `Basic ${hssomBasicCredential(CLIENT_CODE, SECRET)}`,
      clientid: "VRSX",
      userid: "VRSXUSER",
    });
    expectCleanLogs();
  });

  it("defaults userid to clientid when not configured and accepts access_token or jwt", async () => {
    for (const body of [{ access_token: TOKEN }, { jwt: TOKEN }]) {
      const fetchMock = vi.fn(async () => json(200, body));
      const client = createHssomTokenClient({ config: () => ({ ...authConfig, userId: undefined }), fetch: fetchMock as unknown as typeof fetch });
      await expect(client.getToken()).resolves.toBe(TOKEN);
      const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect(init.headers).toMatchObject({ clientid: "VRSX", userid: "VRSX" });
    }
  });

  it("caches the token and refreshes 5 minutes before tokenLife ends", async () => {
    let clock = 1_000_000;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { token: TOKEN, tokenLife: 3600 }))
      .mockResolvedValueOnce(json(200, { token: TOKEN_2, tokenLife: 3600 }));
    const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock, now: () => clock });
    expect(await client.getToken()).toBe(TOKEN);
    clock += 54 * 60 * 1000;
    expect(await client.getToken()).toBe(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock += 1 * 60 * 1000 + 1;
    expect(await client.getToken()).toBe(TOKEN_2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("defaults to 90 minutes when tokenLife is missing", async () => {
    let clock = 0;
    const fetchMock = vi.fn(async () => json(200, { token: TOKEN }));
    const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock as unknown as typeof fetch, now: () => clock });
    await client.getToken();
    clock = 84 * 60 * 1000;
    await client.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock = 85 * 60 * 1000 + 1;
    await client.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes into one request", async () => {
    let release!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock as unknown as typeof fetch });
    const all = Promise.all([client.getToken(), client.getToken(), client.getToken()]);
    release(json(200, { token: TOKEN }));
    expect(await all).toEqual([TOKEN, TOKEN, TOKEN]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidate drops only the token it names", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { token: TOKEN }))
      .mockResolvedValueOnce(json(200, { token: TOKEN_2 }));
    const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock });
    await client.getToken();
    client.invalidate("some-other-token");
    expect(await client.getToken()).toBe(TOKEN);
    client.invalidate(TOKEN);
    expect(await client.getToken()).toBe(TOKEN_2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("errors carry no secret, credential or response body", async () => {
    const cases = [
      vi.fn(async () => new Response(`bad secret ${SECRET} ${TOKEN}`, { status: 401 })),
      vi.fn(async () => json(200, { message: `no token for ${CLIENT_CODE}` })),
      vi.fn(async () => { throw new Error(`connect failed ${SECRET}`); }),
    ];
    for (const fetchMock of cases) {
      const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock as unknown as typeof fetch });
      const err = await client.getToken().then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      for (const value of [SECRET, TOKEN, CLIENT_CODE, hssomBasicCredential(CLIENT_CODE, SECRET)]) {
        expect(err!.message).not.toContain(value);
      }
    }
    expectCleanLogs();
  });

  it("reads config from the handoff env names, https only, no defaults", () => {
    expect(readHssomAuthConfig({})).toBeNull();
    const env = { HSSOM_AUTH_URL: AUTH_URL, HSSOM_CLIENT_CODE: CLIENT_CODE, HSSOM_CLIENT_SECRET: SECRET, HSSOM_CLIENT_ID: "VRSX" };
    expect(readHssomAuthConfig(env)).toEqual({ ...authConfig, userId: undefined });
    expect(readHssomAuthConfig({ ...env, HSSOM_AUTH_URL: "http://auth.hssom.test/x" })).toBeNull();
    expect(readHssomAuthConfig({ ...env, HSSOM_CLIENT_ID: " " })).toBeNull();
    expect(readHssomAuthConfig({ ...env, HSSOM_TIMEOUT_MS: "2500", HSSOM_USER_ID: "U1" })).toMatchObject({ timeoutMs: 2500, userId: "U1" });
  });
});

describe("order ID and formatting", () => {
  it("pads the district to 7 and validates inputs", () => {
    expect(buildHssomOrderId("8175", "13717195")).toBe("0008175-13717195");
    expect(buildHssomOrderId(" 8175 ", " 13717195 ")).toBe("0008175-13717195");
    for (const [d, so] of [["817", "13717195"], ["08175", "13717195"], ["8175", "1371719"], ["8175", "137171950"], ["81a5", "13717195"], ["8175", "1371-195"]]) {
      expect(buildHssomOrderId(d, so)).toBeNull();
    }
  });

  it("title-cases ALL CAPS names only", () => {
    expect(formatCustomerName(" HELEN ", "SANFORD")).toBe("Helen Sanford");
    expect(formatCustomerName("MARY-JO", "O'BRIEN")).toBe("Mary-Jo O'Brien");
    expect(formatCustomerName("Helen", "McDonald")).toBe("Helen McDonald");
    expect(formatCustomerName("helen", "sanford")).toBe("helen sanford");
    expect(formatCustomerName(undefined, " ", "JANE DOE")).toBe("Jane Doe");
    expect(formatCustomerName(" ", undefined)).toBeUndefined();
  });

  it("formats the address on one line, with line2 when present", () => {
    expect(formatCustomerAddress({ addressLine1: " 12 Elm St ", city: "Stamford", state: "CT", zipCode: "06902" }))
      .toBe("12 Elm St, Stamford, CT 06902");
    expect(formatCustomerAddress({ addressLine1: "12 Elm St", addressLine2: "Apt 4", city: "Stamford", state: "CT", zipCode: 6902 }))
      .toBe("12 Elm St, Apt 4, Stamford, CT 6902");
    expect(formatCustomerAddress({ addressLine1: "", city: " ", state: "CT" })).toBe("CT");
    expect(formatCustomerAddress({})).toBeUndefined();
    expect(formatCustomerAddress(undefined)).toBeUndefined();
  });

  it("normalizes purchase dates to YYYY-MM-DD", () => {
    expect(toIsoDate("2021-03-15")).toBe("2021-03-15");
    expect(toIsoDate("2021-03-15T00:00:00.000Z")).toBe("2021-03-15");
    expect(toIsoDate("03/15/2021")).toBe("2021-03-15");
    expect(toIsoDate("20210315")).toBe("2021-03-15");
    for (const bad of ["2021-02-30", "0001-01-01", "1900-01-01", "March 2021", "", null, 42]) {
      expect(toIsoDate(bad)).toBeUndefined();
    }
  });

  it("maps the serviceOrder wrapper and an unwrapped body", () => {
    const expected = {
      status: "found",
      customerName: "Helen Sanford",
      customerAddress: "12 ELM ST, STAMFORD, CT 06902",
      serviceContractId: "551200/0003",
      brand: "Whirlpool",
      modelNumber: "WTW5000DW1",
      serialNumber: "C31290822",
      purchaseDate: "2021-03-15",
    };
    expect(classifyHssomOrderBody(orderBody)).toEqual(expected);
    expect(classifyHssomOrderBody(orderBody.serviceOrder)).toEqual(expected);
    // brand may also be a plain string.
    expect(classifyHssomOrderBody({ merchandise: { brand: "GE" } })).toEqual({ status: "found", brand: "GE" });
  });

  it("drops blank fields and classifies no-data and odd bodies", () => {
    expect(classifyHssomOrderBody({ customer: { name: { firstName: " " } }, thirdParty: { contractNumber: "" } }))
      .toEqual({ status: "found" });
    expect(classifyHssomOrderBody({ responseCode: "02", responseMessage: "No data found" })).toEqual({ status: "not_found" });
    expect(classifyHssomOrderBody({ serviceOrder: { ResponseCode: "02" } })).toEqual({ status: "not_found" });
    expect(classifyHssomOrderBody({ responseCode: "12" })).toEqual({ status: "unavailable" });
    expect(classifyHssomOrderBody([])).toEqual({ status: "unavailable" });
    expect(classifyHssomOrderBody(null)).toEqual({ status: "unavailable" });
  });
});

describe("lookup classification", () => {
  it("found: GET {base}/{orderId} with bearer and Order Lookup headers", async () => {
    const fetchMock = vi.fn(async () => json(200, orderBody));
    const { lookup } = lookupWith(fetchMock);
    const result = await lookup("8175", "13717195");
    expect(result).toMatchObject({ status: "found", customerName: "Helen Sanford", serviceContractId: "551200/0003" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${LOOKUP_URL}/0008175-13717195`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(lookupHeadersFor(TOKEN));
    expect(init.headers).not.toHaveProperty("clientId");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(logs.some((args) => String(args[0]).includes("order=0008175-13717195 status=found http=200"))).toBe(true);
    expectCleanLogs();
  });

  it("not_found on 404 and on the no-data response code", async () => {
    expect(await lookupWith(vi.fn(async () => json(404, { message: "Order not found" }))).lookup("8175", "13717195"))
      .toEqual({ status: "not_found" });
    expect(await lookupWith(vi.fn(async () => json(200, { responseCode: "02" }))).lookup("8175", "13717195"))
      .toEqual({ status: "not_found" });
  });

  it("401: invalidates the token and retries once with a fresh one", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(401, { error: "expired" }))
      .mockResolvedValueOnce(json(200, orderBody));
    const { lookup, invalidated } = lookupWith(fetchMock);
    expect((await lookup("8175", "13717195")).status).toBe("found");
    expect(invalidated).toEqual([TOKEN]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toEqual(lookupHeadersFor(TOKEN_2));
    expectCleanLogs();
  });

  it("401 twice: unavailable after exactly one retry", async () => {
    const fetchMock = vi.fn(async () => json(401, {}));
    const { lookup, invalidated } = lookupWith(fetchMock);
    expect(await lookup("8175", "13717195")).toEqual({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(invalidated).toEqual([TOKEN, TOKEN_2]);
    expect(logs.some((args) => String(args[0]).includes("status=unavailable http=401"))).toBe(true);
  });

  it("403: unavailable, no retry, one-line grant hint without token or body", async () => {
    const fetchMock = vi.fn(async () => json(403, { message: `forbidden for ${TOKEN} ${FIRST}` }));
    const { lookup, invalidated } = lookupWith(fetchMock);
    expect(await lookup("8175", "13717195")).toEqual({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invalidated).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(String(logs[0][0])).toMatch(
      /^\[hssom-lookup\] order=0008175-13717195 status=unavailable http=403 reason=forbidden ms=\d+ hint=token may lack OrderLookup grant$/,
    );
    expectCleanLogs();
  });

  it("unavailable on 5xx, other 4xx, network error, bad JSON and auth failure", async () => {
    const responses = [
      vi.fn(async () => json(503, { detail: `${FIRST} ${LAST}` })),
      vi.fn(async () => json(400, {})),
      vi.fn(async () => { throw new TypeError("fetch failed"); }),
      vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })),
    ];
    for (const fetchMock of responses) {
      expect(await lookupWith(fetchMock).lookup("8175", "13717195")).toEqual({ status: "unavailable" });
    }
    const fetchMock = vi.fn();
    const lookup = createHssomOrderLookup({
      enabled: () => true, config: () => lookupConfig, fetch: fetchMock,
      getToken: async () => { throw new Error("HSSOM auth failed: HTTP 500"); }, invalidateToken: () => {},
    });
    expect(await lookup("8175", "13717195")).toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    expectCleanLogs();
  });

  it("unavailable when the request exceeds HSSOM_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal!;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const { lookup } = lookupWith(fetchMock, { config: () => ({ ...lookupConfig, timeoutMs: 1234 }) });
    const pending = lookup("8175", "13717195");
    await vi.advanceTimersByTimeAsync(1233);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: "unavailable" });
    expect(logs.some((args) => String(args[0]).includes("reason=timeout"))).toBe(true);
  });

  it("invalid inputs never call the network", async () => {
    const fetchMock = vi.fn();
    const { lookup, tokenCalls } = lookupWith(fetchMock);
    expect(await lookup("817", "13717195")).toEqual({ status: "not_found" });
    expect(await lookup("8175", "ABC")).toEqual({ status: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenCalls()).toBe(0);
  });
});

describe("lookup headers and config", () => {
  const baseEnv = {
    HSSOM_ORDER_LOOKUP_URL: LOOKUP_URL, HSSOM_AUTH_URL: AUTH_URL, HSSOM_CLIENT_CODE: CLIENT_CODE,
    HSSOM_CLIENT_SECRET: SECRET, HSSOM_CLIENT_ID: "VRSX",
  };

  it("clientid defaults to TABS, not the auth HSSOM_CLIENT_ID", () => {
    expect(readHssomOrderLookupConfig(baseEnv)).toEqual({ lookupUrl: LOOKUP_URL, lookupClientId: "TABS", timeoutMs: 5000 });
    expect(readHssomOrderLookupConfig({ ...baseEnv, HSSOM_LOOKUP_CLIENT_ID: "  " })?.lookupClientId).toBe("TABS");
  });

  it("HSSOM_LOOKUP_CLIENT_ID overrides clientid, including setting it to the auth client ID", () => {
    expect(readHssomOrderLookupConfig({ ...baseEnv, HSSOM_LOOKUP_CLIENT_ID: " AIAG " })?.lookupClientId).toBe("AIAG");
    expect(readHssomOrderLookupConfig({ ...baseEnv, HSSOM_LOOKUP_CLIENT_ID: "VRSX" })?.lookupClientId).toBe("VRSX");
  });

  it("HSSOM_ORDER_LOOKUP_URL stays required: no URL default", () => {
    const { HSSOM_ORDER_LOOKUP_URL: _url, ...noUrl } = baseEnv;
    expect(readHssomOrderLookupConfig(noUrl)).toBeNull();
    expect(readHssomOrderLookupConfig({ ...noUrl, HSSOM_LOOKUP_CLIENT_ID: "TABS" })).toBeNull();
  });

  it("sends the overridden clientid on the wire", async () => {
    const fetchMock = vi.fn(async () => json(200, orderBody));
    const { lookup } = lookupWith(fetchMock, { config: () => ({ ...lookupConfig, lookupClientId: "AIAG" }) });
    await lookup("8175", "13717195");
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual(lookupHeadersFor(TOKEN, "AIAG"));
  });

  it("lookupHeaders builds exactly the gateway-mode header set", () => {
    expect(lookupHeaders({ lookupClientId: "TABS" }, TOKEN)).toEqual(lookupHeadersFor(TOKEN));
  });
});

describe("gating", () => {
  it("flag is on only for the exact value true", () => {
    expect(isAhsHssomCustomerPrefillEnabled()).toBe(false);
    for (const value of ["TRUE", "1", " true", "yes"]) {
      process.env.AHS_HSSOM_CUSTOMER_PREFILL_ENABLED = value;
      expect(isAhsHssomCustomerPrefillEnabled()).toBe(false);
    }
    process.env.AHS_HSSOM_CUSTOMER_PREFILL_ENABLED = "true";
    expect(isAhsHssomCustomerPrefillEnabled()).toBe(true);
  });

  it("flag off or missing env: unavailable with no fetch", async () => {
    const fetchMock = vi.fn(async () => json(200, orderBody));
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      HSSOM_ORDER_LOOKUP_URL: LOOKUP_URL, HSSOM_AUTH_URL: AUTH_URL, HSSOM_CLIENT_CODE: CLIENT_CODE,
      HSSOM_CLIENT_SECRET: SECRET, HSSOM_CLIENT_ID: "VRSX",
    };
    Object.assign(process.env, env);
    expect(await lookupHssomOrder("8175", "13717195")).toEqual({ status: "unavailable" });

    process.env.AHS_HSSOM_CUSTOMER_PREFILL_ENABLED = "true";
    for (const key of Object.keys(env)) {
      const saved = process.env[key];
      delete process.env[key];
      expect(await lookupHssomOrder("8175", "13717195")).toEqual({ status: "unavailable" });
      process.env[key] = saved;
    }
    process.env.HSSOM_ORDER_LOOKUP_URL = "http://gateway.hssom.test/orders";
    expect(await lookupHssomOrder("8175", "13717195")).toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    expectCleanLogs();
  });

  it("end to end through the default clients when enabled", async () => {
    const fetchMock = vi.fn(async (url: string) => (url === AUTH_URL ? json(200, { token: TOKEN, tokenLife: 5400 }) : json(200, orderBody)));
    vi.stubGlobal("fetch", fetchMock);
    Object.assign(process.env, {
      AHS_HSSOM_CUSTOMER_PREFILL_ENABLED: "true", HSSOM_ORDER_LOOKUP_URL: `${LOOKUP_URL}/`, HSSOM_AUTH_URL: AUTH_URL,
      HSSOM_CLIENT_CODE: CLIENT_CODE, HSSOM_CLIENT_SECRET: SECRET, HSSOM_CLIENT_ID: "VRSX",
    });
    expect(readHssomOrderLookupConfig()).toEqual({ lookupUrl: LOOKUP_URL, lookupClientId: "TABS", timeoutMs: 5000 });
    expect(await lookupHssomOrder("7670", "13393180")).toMatchObject({ status: "found", customerName: "Helen Sanford" });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([AUTH_URL, `${LOOKUP_URL}/0007670-13393180`]);
    // The auth call carries HSSOM_CLIENT_ID; the lookup call carries clientid TABS.
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][1].headers).toMatchObject({ clientid: "VRSX" });
    expect(calls[1][1].headers).toEqual(lookupHeadersFor(TOKEN));
    expectCleanLogs();
  });
});

describe("cache", () => {
  it("found is cached for 30 minutes", async () => {
    let clock = 0;
    const fetchMock = vi.fn(async () => json(200, orderBody));
    const { lookup } = lookupWith(fetchMock, { now: () => clock });
    await lookup("8175", "13717195");
    clock = 30 * 60 * 1000 - 1;
    await lookup("8175", "13717195");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock = 30 * 60 * 1000;
    await lookup("8175", "13717195");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("not_found is cached for 2 minutes", async () => {
    let clock = 0;
    const fetchMock = vi.fn(async () => json(404, {}));
    const { lookup } = lookupWith(fetchMock, { now: () => clock });
    await lookup("8175", "13717195");
    clock = 2 * 60 * 1000 - 1;
    await lookup("8175", "13717195");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock = 2 * 60 * 1000;
    await lookup("8175", "13717195");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("unavailable is not cached", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(502, {}))
      .mockResolvedValueOnce(json(200, orderBody));
    const { lookup } = lookupWith(fetchMock);
    expect((await lookup("8175", "13717195")).status).toBe("unavailable");
    expect((await lookup("8175", "13717195")).status).toBe("found");
  });

  it("coalesces concurrent lookups for one order", async () => {
    let release!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const { lookup } = lookupWith(fetchMock);
    const all = Promise.all([lookup("8175", "13717195"), lookup("8175", "13717195")]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release(json(200, orderBody));
    const [a, b] = await all;
    expect(a.status).toBe("found");
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is bounded with LRU eviction", async () => {
    const fetchMock = vi.fn(async () => json(200, orderBody));
    const { lookup } = lookupWith(fetchMock, { cacheSize: 2 });
    await lookup("0001", "00000001");
    await lookup("0002", "00000002");
    await lookup("0001", "00000001"); // touch: 0002 is now least recently used
    await lookup("0003", "00000003"); // evicts 0002
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await lookup("0001", "00000001");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await lookup("0002", "00000002");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns copies, so callers cannot change the cached result", async () => {
    const { lookup } = lookupWith(vi.fn(async () => json(200, orderBody)));
    const first = await lookup("8175", "13717195");
    (first as { customerName?: string }).customerName = "changed";
    expect(await lookup("8175", "13717195")).toMatchObject({ customerName: "Helen Sanford" });
  });
});
