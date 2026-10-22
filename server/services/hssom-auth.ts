// HSSOMAuthService bearer token client.
//
// Same token flow as ai-agent-mcp HSSOMAuthClient (src/agent_tools/clients/
// auth.py) and the VRS Express HSSOM Send Message handoff (§12), so both
// callers can share one cached token:
//
//   encodedSecret = Base64(clientSecret)
//   basic         = Base64(clientCode + ":" + encodedSecret)
//   GET HSSOM_AUTH_URL   Authorization: Basic <basic>, clientid, userid?
//
// The response carries `token`, `access_token` or `jwt`, and `tokenLife` in
// seconds (default 90 min). Tokens refresh 5 min early, concurrent refreshes
// share one request, and callers invalidate on HTTP 401. Errors and logs
// never contain the secret, the Basic credential or the token.

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
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_TOKEN_TTL_MS;
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
    };
    if (config.userId) headers.userid = config.userId;
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
      const token = tokenFrom(body);
      if (!token) throw new HssomAuthError("HSSOM auth response had no token", res.status);
      const ttlMs = ttlMsFrom(body);
      cached = { token, identity, refreshAt: now() + ttlMs - Math.min(REFRESH_EARLY_MS, ttlMs / 2) };
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
      // A credential or endpoint change must not reuse the old token.
      const identity = `${config.authUrl}\n${config.clientCode}\n${config.clientId}`;
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
