import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHssomTokenClient,
  hssomTokenAllows,
  hssomTokenGrants,
  type HssomAuthConfig,
} from "../server/services/hssom-auth";

// Synthetic values only; no network. fetch is always a mock.
const SECRET = "s3cr3t-Value!";
const AUTH_URL = "https://auth.hssom.test/HSSOMAuthService/services/auth/token";
const BODY_LEAK = "LEAKY-RESPONSE-MESSAGE-TEXT";

const authConfig: HssomAuthConfig = {
  authUrl: AUTH_URL, clientCode: "VRSXCODE", clientSecret: SECRET, clientId: "VRSX", userId: "VRSXUSER", timeoutMs: 5000,
};

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

// Unsigned synthetic JWT: header.payload.fake-signature.
function jwt(payload: unknown): string {
  return `${b64url({ alg: "RS512", typ: "JWT" })}.${b64url(payload)}.c2lnbmF0dXJl`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function success(token: string, tokenLife: unknown = 5400) {
  return { correlationId: "corr-1", responseCode: "00", responseMessage: "SUCCESS", messages: [], token, tokenLife };
}

let logs: unknown[][];
beforeEach(() => {
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args); });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HSSOM auth responseCode", () => {
  it('accepts responseCode "00"', async () => {
    const token = jwt({ sub: "VRSX" });
    const fetchMock = vi.fn(async () => json(200, success(token)));
    const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getToken()).resolves.toBe(token);
  });

  it.each(["08", "12"])('rejects responseCode "%s" without leaking body text', async (code) => {
    const fetchMock = vi.fn(async () => json(200, {
      correlationId: "corr-x", responseCode: code, responseMessage: `${BODY_LEAK} ${SECRET}`, messages: [BODY_LEAK],
      token: jwt({ sub: "should-not-be-used" }),
    }));
    const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock as unknown as typeof fetch });
    const err = await client.getToken().then(() => null, (e: Error) => e);
    expect(err).toMatchObject({ name: "HssomAuthError", message: `HSSOM auth rejected: responseCode ${code}`, httpStatus: 200 });
    const text = `${err!.message} ${JSON.stringify(logs)}`;
    for (const value of [BODY_LEAK, SECRET, "corr-x", "should-not-be-used"]) expect(text).not.toContain(value);
  });

  it("never echoes a long or odd responseCode", async () => {
    const fetchMock = vi.fn(async () => json(200, { responseCode: `99 ${BODY_LEAK}`, token: "x.y.z" }));
    const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock as unknown as typeof fetch });
    const err = await client.getToken().then(() => null, (e: Error) => e);
    expect(err!.message).toBe("HSSOM auth rejected: responseCode ??");
  });
});

describe("HSSOM auth cache TTL", () => {
  it("caps a huge tokenLife at 5400 s (refresh 5 min early)", async () => {
    let clock = 1_000_000;
    const fetchMock = vi.fn(async () => json(200, success("opaque-token", 999999999)));
    const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock as unknown as typeof fetch, now: () => clock });
    await client.getToken();
    clock += 85 * 60 * 1000 - 1;
    await client.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock += 2;
    await client.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([-5, 0, "abc", null])("ignores invalid tokenLife %s and uses the 90 min default", async (life) => {
    let clock = 0;
    const fetchMock = vi.fn(async () => json(200, success("opaque-token", life)));
    const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock as unknown as typeof fetch, now: () => clock });
    await client.getToken();
    clock = 85 * 60 * 1000 - 1;
    await client.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock = 85 * 60 * 1000 + 1;
    await client.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the JWT exp when it is earlier than tokenLife", async () => {
    let clock = 1_700_000_000_000;
    // exp 20 min out, tokenLife 90 min: refresh at exp - 5 min = 15 min.
    const token = jwt({ sub: "VRSX", exp: clock / 1000 + 20 * 60 });
    const fetchMock = vi.fn(async () => json(200, success(token, 5400)));
    const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock as unknown as typeof fetch, now: () => clock });
    await client.getToken();
    clock += 15 * 60 * 1000 - 1;
    await client.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock += 2;
    await client.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps tokenLife when the JWT exp is later", async () => {
    let clock = 1_700_000_000_000;
    const token = jwt({ exp: clock / 1000 + 10 * 3600 });
    const fetchMock = vi.fn(async () => json(200, success(token, 3600)));
    const client = createHssomTokenClient({ config: () => authConfig, fetch: fetchMock as unknown as typeof fetch, now: () => clock });
    await client.getToken();
    clock += 55 * 60 * 1000 + 1;
    await client.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("HSSOM auth cache identity", () => {
  it("fetches a new token after the secret rotates or userid changes", async () => {
    let config: HssomAuthConfig = authConfig;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, success("token-a")))
      .mockResolvedValueOnce(json(200, success("token-b")))
      .mockResolvedValueOnce(json(200, success("token-c")));
    const client = createHssomTokenClient({ config: () => config, fetch: fetchMock });
    expect(await client.getToken()).toBe("token-a");
    expect(await client.getToken()).toBe("token-a");
    config = { ...authConfig, clientSecret: "rotated-secret" };
    expect(await client.getToken()).toBe("token-b");
    config = { ...config, userId: "OTHERUSER" };
    expect(await client.getToken()).toBe("token-c");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(logs)).not.toContain("rotated-secret");
  });

  it("userid defaults to clientid", async () => {
    const fetchMock = vi.fn(async () => json(200, success("token-a")));
    const client = createHssomTokenClient({ config: () => ({ ...authConfig, userId: undefined }), fetch: fetchMock as unknown as typeof fetch });
    await client.getToken();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ clientid: "VRSX", userid: "VRSX" });
  });
});

describe("HSSOM token diagnostics (not authorization)", () => {
  const exp = 1_900_000_000;
  const token = jwt({
    sub: "VRSX",
    exp,
    auth: {
      components: [
        {
          name: "SOMService",
          sessionLife: 5400,
          uris: [
            { uri: "[POST] /v1/api/serviceorder/message", role: "WRITE" },
            { uri: "/v1/api/serviceorder/**", role: "READ" },
            { uri: 42, role: "BAD" },
            "not-an-object",
          ],
          users: ["VRSX"],
        },
        { name: "Other", uris: "nope" },
        null,
      ],
    },
  });

  it("parses components/uris with method prefixes and /** patterns", () => {
    const summary = hssomTokenGrants(token);
    expect(summary).toEqual({
      sub: "VRSX",
      exp,
      grants: [
        { component: "SOMService", method: "POST", pattern: "/v1/api/serviceorder/message", role: "WRITE" },
        { component: "SOMService", pattern: "/v1/api/serviceorder/**", role: "READ" },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain(token);
  });

  it("matches methods and /** prefixes", () => {
    expect(hssomTokenAllows(token, "POST", "/v1/api/serviceorder/message")).toBe(true);
    expect(hssomTokenAllows(token, "get", "/v1/api/serviceorder/0008175-13717195")).toBe(true);
    expect(hssomTokenAllows(token, "GET", "/v1/api/serviceorder")).toBe(true);
    expect(hssomTokenAllows(token, "GET", "/v1/api/serviceorder/a/b?x=1")).toBe(true);
    expect(hssomTokenAllows(token, "GET", "/v1/api/serviceorders")).toBe(false);
    expect(hssomTokenAllows(token, "DELETE", "/v1/api/other")).toBe(false);
    expect(hssomTokenAllows(jwt({ auth: { components: [{ name: "X", uris: [{ uri: "[GET] /a", role: "R" }] }] } }), "POST", "/a")).toBe(false);
  });

  it("returns empty grants when claims are missing", () => {
    expect(hssomTokenGrants(jwt({ sub: 7 }))).toEqual({ grants: [] });
    expect(hssomTokenGrants(jwt({ auth: { components: {} } }))).toEqual({ grants: [] });
  });

  it.each([
    "",
    "not-a-jwt",
    "a.b",
    "a.b.c.d",
    `${b64url({})}.!!!.sig`,
    `${b64url({})}.${Buffer.from("not json").toString("base64url")}.sig`,
    `${b64url({})}.${b64url([1, 2])}.sig`,
    `${b64url({})}.${b64url("str")}.sig`,
    `${b64url({})}.${b64url(null)}.sig`,
  ])("malformed token %# returns null", (bad) => {
    expect(hssomTokenGrants(bad)).toBeNull();
    expect(hssomTokenAllows(bad, "GET", "/v1/api/serviceorder/x")).toBe(false);
  });

  it("tolerates non-string input", () => {
    expect(hssomTokenGrants(undefined as unknown as string)).toBeNull();
  });
});
