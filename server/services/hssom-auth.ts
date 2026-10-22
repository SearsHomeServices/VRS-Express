// HSSOMAuthService bearer token client.
//
// Same token flow as ai-agent-mcp HSSOMAuthClient (src/agent_tools/clients/
// auth.py) and the VRS Express HSSOM Send Message handoff (§12), so both
// callers can share one cached token:
//
//   encodedSecret = Base64(clientSecret)
//   basic         = Base64(clientCode + ":" + encodedSecret)
//   GET HSSOM_AUTH_URL   Authorization: Basic <basic>, clientid, userid
//
// userid is "Client ID or freeform text" per the SOM set-up doc, so it falls
// back to the client ID when HSSOM_USER_ID is unset.
//
// The response carries `token`, `access_token` or `jwt`, `tokenLife` in
// seconds (default and cap 90 min) and `responseCode` ("00" = success; any
// other code is a rejection even on HTTP 200). The cache expiry is also
// clamped to the JWT `exp` claim when that is earlier. Tokens refresh 5 min
// early, concurrent refreshes share one request, and callers invalidate on
// HTTP 401. Errors and logs never contain the secret, the Basic credential,
// the token or response body text.

import { createHash } from "node:crypto";

export interface HssomAuthConfig {
  authUrl: string;
  clientCode: string;
  clientSecret: string;
  clientId: string;
  userId?: string;
  timeoutMs: number;
}

export class HssomAuthError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "HssomAuthError";
  }
}

export const HSSOM_DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TOKEN_TTL_MS = 90 * 60 * 1000;
// Documented tokenLife is 5400 s; never cache longer even if told to.
const MAX_TOKEN_TTL_MS = 5400 * 1000;
const REFRESH_EARLY_MS = 5 * 60 * 1000;

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function isHttpsUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function hssomTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = envValue(env, "HSSOM_TIMEOUT_MS");
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return value > 0 ? value : HSSOM_DEFAULT_TIMEOUT_MS;
}

// Null when any required value is missing or the URL is not https. No URL
// defaults: every environment configures its own.
export function readHssomAuthConfig(env: NodeJS.ProcessEnv = process.env): HssomAuthConfig | null {
  const authUrl = envValue(env, "HSSOM_AUTH_URL");
  const clientCode = envValue(env, "HSSOM_CLIENT_CODE");
  const clientSecret = envValue(env, "HSSOM_CLIENT_SECRET");
  const clientId = envValue(env, "HSSOM_CLIENT_ID");
  if (!isHttpsUrl(authUrl) || !clientCode || !clientSecret || !clientId) return null;
  return { authUrl, clientCode, clientSecret, clientId, userId: envValue(env, "HSSOM_USER_ID"), timeoutMs: hssomTimeoutMs(env) };
}

// Nested Base64: the password half of the Basic credential is itself Base64.
export function hssomBasicCredential(clientCode: string, clientSecret: string): string {
  const encodedSecret = Buffer.from(clientSecret, "utf8").toString("base64");
  return Buffer.from(`${clientCode}:${encodedSecret}`, "utf8").toString("base64");
}

function tokenFrom(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["token", "access_token", "jwt"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function ttlMsFrom(body: unknown): number {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).tokenLife : undefined;
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_TOKEN_TTL_MS) : DEFAULT_TOKEN_TTL_MS;
}

// Only a short code-like value is ever echoed: never responseMessage or body text.
function rejectedResponseCode(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("responseCode" in body)) return null;
  const raw = (body as Record<string, unknown>).responseCode;
  if (raw === undefined || raw === null) return null;
  const code = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (code === "00") return null;
  return /^[A-Za-z0-9]{1,4}$/.test(code) ? code : "??";
}

// Decodes a JWT payload locally. NO signature check: diagnostics only.
function jwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function jwtExpMs(token: string): number | null {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

function secretFingerprint(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 12);
}

export interface HssomTokenGrant {
  component: string;
  method?: string;
  pattern: string;
  role: string;
}

export interface HssomTokenGrantSummary {
  sub?: string;
  exp?: number;
  grants: HssomTokenGrant[];
}

const METHOD_PREFIX = /^\[([A-Za-z]+)\]\s*(.*)$/;

// DIAGNOSTIC ONLY, for logs and a future health check. This is NOT
// authorization: the token signature is not verified, so the claims are
// whatever the bytes say. HSSOM itself enforces access. Never returns or
// logs the token. Null for anything that is not a JWT with a JSON payload.
export function hssomTokenGrants(token: string): HssomTokenGrantSummary | null {
  const payload = jwtPayload(token);
  if (!payload) return null;
  const summary: HssomTokenGrantSummary = { grants: [] };
  if (typeof payload.sub === "string") summary.sub = payload.sub;
  if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) summary.exp = payload.exp;
  const auth = payload.auth;
  const components = auth && typeof auth === "object" ? (auth as Record<string, unknown>).components : undefined;
  if (!Array.isArray(components)) return summary;
  for (const component of components) {
    if (!component || typeof component !== "object") continue;
    const { name, uris } = component as Record<string, unknown>;
    if (!Array.isArray(uris)) continue;
    for (const entry of uris) {
      if (!entry || typeof entry !== "object") continue;
      const { uri, role } = entry as Record<string, unknown>;
      if (typeof uri !== "string" || !uri.trim()) continue;
      const match = METHOD_PREFIX.exec(uri.trim());
      const grant: HssomTokenGrant = {
        component: typeof name === "string" ? name : "",
        pattern: (match ? match[2] : uri).trim(),
        role: typeof role === "string" ? role : "",
      };
      if (match) grant.method = match[1].toUpperCase();
      if (grant.pattern) summary.grants.push(grant);
    }
  }
  return summary;
}

function patternMatches(pattern: string, path: string): boolean {
  if (pattern === "/**") return path.startsWith("/");
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === pattern;
}

// DIAGNOSTIC ONLY: whether the (unverified) token claims a grant for this
// method and path. NOT an authorization decision; see hssomTokenGrants.
// Grants without a method prefix match any method; "/**" matches the prefix
// and everything below it. Query strings and trailing slashes are ignored.
export function hssomTokenAllows(token: string, method: string, path: string): boolean {
  const summary = hssomTokenGrants(token);
  if (!summary) return false;
  const wantMethod = method.trim().toUpperCase();
  const normalize = (p: string) => {
    const bare = p.split(/[?#]/, 1)[0];
    return bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
  };
  const wantPath = normalize(path.trim());
  if (!wantPath.startsWith("/")) return false;
  return summary.grants.some((grant) =>
    (!grant.method || grant.method === wantMethod) && patternMatches(normalize(grant.pattern), wantPath));
}

export interface HssomTokenClientOptions {
  config?: () => HssomAuthConfig | null;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface HssomTokenClient {
  getToken(): Promise<string>;
  // With a token, only drops the cache when it still holds that token, so a
  // late 401 cannot discard a token another caller just refreshed.
  invalidate(token?: string): void;
}

export function createHssomTokenClient(options: HssomTokenClientOptions = {}): HssomTokenClient {
  const readConfig = options.config ?? (() => readHssomAuthConfig());
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  let cached: { token: string; refreshAt: number; identity: string } | null = null;
  let inflight: { promise: Promise<string>; identity: string } | null = null;

  async function requestToken(config: HssomAuthConfig, identity: string): Promise<string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Basic ${hssomBasicCredential(config.clientCode, config.clientSecret)}`,
      clientid: config.clientId,
      userid: config.userId ?? config.clientId,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const started = now();
    try {
      let res: Response;
      try {
        res = await doFetch(config.authUrl, { method: "GET", headers, signal: controller.signal });
      } catch {
        throw new HssomAuthError(controller.signal.aborted ? "HSSOM auth request timed out" : "HSSOM auth request failed");
      }
      if (!res.ok) throw new HssomAuthError(`HSSOM auth failed: HTTP ${res.status}`, res.status);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new HssomAuthError("HSSOM auth response was not JSON", res.status);
      }
      const rejected = rejectedResponseCode(body);
      if (rejected) throw new HssomAuthError(`HSSOM auth rejected: responseCode ${rejected}`, res.status);
      const token = tokenFrom(body);
      if (!token) throw new HssomAuthError("HSSOM auth response had no token", res.status);
      const issuedAt = now();
      let ttlMs = ttlMsFrom(body);
      const expMs = jwtExpMs(token);
      if (expMs !== null && expMs < issuedAt + ttlMs) ttlMs = Math.max(0, expMs - issuedAt);
      cached = { token, identity, refreshAt: issuedAt + ttlMs - Math.min(REFRESH_EARLY_MS, ttlMs / 2) };
      console.log(`[hssom-auth] token refreshed ttl_s=${Math.round(ttlMs / 1000)} ms=${now() - started}`);
      return token;
    } catch (err) {
      const status = err instanceof HssomAuthError && err.httpStatus ? ` http=${err.httpStatus}` : "";
      console.warn(`[hssom-auth] token request failed${status} ms=${now() - started}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getToken(): Promise<string> {
      const config = readConfig();
      if (!config) return Promise.reject(new HssomAuthError("HSSOM auth is not configured"));
      // A credential, endpoint or userid change must not reuse the old token.
      // The secret enters only as a short sha256 fingerprint.
      const identity = [
        config.authUrl, config.clientCode, config.clientId, config.userId ?? config.clientId,
        secretFingerprint(config.clientSecret),
      ].join("\n");
      if (cached && cached.identity === identity && now() < cached.refreshAt) return Promise.resolve(cached.token);
      if (inflight && inflight.identity === identity) return inflight.promise;
      const promise = requestToken(config, identity).finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
      inflight = { promise, identity };
      return promise;
    },
    invalidate(token?: string): void {
      if (!cached) return;
      if (token === undefined || cached.token === token) cached = null;
    },
  };
}

const defaultTokenClient = createHssomTokenClient();

export function getHssomBearerToken(): Promise<string> {
  return defaultTokenClient.getToken();
}

export function invalidateHssomBearerToken(token?: string): void {
  defaultTokenClient.invalidate(token);
}
