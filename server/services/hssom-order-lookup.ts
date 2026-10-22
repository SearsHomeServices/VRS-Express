// HSSOM Order Lookup client (customer name and address for a service order).
//
// The exported HssomOrderLookupResult and lookupHssomOrder are the contract
// with server/ahs-prefill.ts; keep the names and shape.
//
// Same service ai-agent-mcp calls through CustomerTools.
// get_customer_details_by_order in gateway mode (HssomLookupClient with
// use_gateway=True): GET {HSSOM_ORDER_LOOKUP_URL}/{orderId} with the HSSOM
// bearer token (server/services/hssom-auth.ts) and a clientId header.
// Disabled unless AHS_HSSOM_CUSTOMER_PREFILL_ENABLED is exactly "true" and
// the HSSOM URLs and credentials are configured. Logs only the order ID,
// status, HTTP status and duration: never customer values, tokens or bodies.

import { isAhsHssomCustomerPrefillEnabled } from "../featureFlags";
import {
  getHssomBearerToken,
  hssomTimeoutMs,
  invalidateHssomBearerToken,
  isHttpsUrl,
  readHssomAuthConfig,
} from "./hssom-auth";

export type HssomOrderLookupResult =
  | {
      status: "found";
      customerName?: string;
      // One line: "street, city, ST zip".
      customerAddress?: string;
      // Raw thirdParty.contractNumber; AHS dispatch number is the part
      // before "/" (dispatchNumberFromServiceContractId). Unverified.
      serviceContractId?: string;
      brand?: string;
      modelNumber?: string;
      serialNumber?: string;
      // ISO date (YYYY-MM-DD) when HSSOM has one.
      purchaseDate?: string;
    }
  | { status: "not_found" }
  | { status: "unavailable" };

type FoundResult = Extract<HssomOrderLookupResult, { status: "found" }>;

// HSSOM ResponseCode for "no data found" (Send Message spec, handoff §13).
// Not confirmed for the Order Lookup service, which answers 404 in Python.
const HSSOM_NO_DATA_CODE = "02";

// district: 4 digits; bareServiceOrder: 8 digits. The HSSOM order ID is
// "<district padded to 7>-<service order>", e.g. 0008175-13717195.
export function buildHssomOrderId(district: string, bareServiceOrder: string): string | null {
  const unit = district.trim();
  const so = bareServiceOrder.trim();
  if (!/^\d{4}$/.test(unit) || !/^\d{8}$/.test(so)) return null;
  return `${unit.padStart(7, "0")}-${so}`;
}

// ---------------------------------------------------------------------------
// Response normalization (paths from ai-agent-mcp CustomerDetails.
// from_hssom_response, src/agent_tools/data_service/models/customer_details.py)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function text(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
  const cleaned = raw?.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned : undefined;
}

// Title-case only names HSSOM stores in ALL CAPS; mixed case is kept as typed.
export function formatCustomerName(first?: string, last?: string, full?: string): string | undefined {
  const name = [text(first), text(last)].filter(Boolean).join(" ") || text(full);
  if (!name) return undefined;
  if (/[a-z]/.test(name) || !/[A-Z]/.test(name)) return name;
  return name.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

export function formatCustomerAddress(address: Json | undefined): string | undefined {
  if (!address) return undefined;
  const street = [text(address.addressLine1), text(address.addressLine2)].filter(Boolean).join(", ");
  const stateZip = [text(address.state), text(address.zipCode)].filter(Boolean).join(" ");
  const line = [street, text(address.city), stateZip].filter(Boolean).join(", ");
  return line || undefined;
}

function validIsoDate(y: number, m: number, d: number): string | undefined {
  // Years outside this window are placeholder values (0001-01-01, 1900-01-01).
  if (y <= 1900 || y > 2100) return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return date.toISOString().slice(0, 10);
}

// Accepts YYYY-MM-DD (optionally with a time), MM/DD/YYYY and YYYYMMDD.
export function toIsoDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(raw);
  if (m) return validIsoDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (m) return validIsoDate(+m[3], +m[1], +m[2]);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (m) return validIsoDate(+m[1], +m[2], +m[3]);
  return undefined;
}

function responseCode(...sources: Array<Json | undefined>): string | undefined {
  for (const source of sources) {
    const code = text(source?.responseCode ?? source?.ResponseCode);
    if (code) return code;
  }
  return undefined;
}

// 200 bodies: "found" only when the order sections are present.
export function classifyHssomOrderBody(body: unknown): HssomOrderLookupResult {
  const root = obj(body);
  if (!root) return { status: "unavailable" };
  // customer_details.py:203, response.get("serviceOrder", response)
  const order = obj(root.serviceOrder) ?? root;
  if (responseCode(root, order) === HSSOM_NO_DATA_CODE) return { status: "not_found" };
  const customer = obj(order.customer);
  const merchandise = obj(order.merchandise);
  const thirdParty = obj(order.thirdParty);
  if (!customer && !merchandise && !thirdParty) return { status: "unavailable" };

  const name = obj(customer?.name);
  const brandValue = merchandise?.brand;
  const result: FoundResult = {
    status: "found",
    customerName: formatCustomerName(name?.firstName as string, name?.lastName as string, name?.fullName as string),
    customerAddress: formatCustomerAddress(obj(customer?.address)),
    serviceContractId: text(thirdParty?.contractNumber),
    brand: text(obj(brandValue)?.brandName ?? brandValue),
    modelNumber: text(merchandise?.modelNumber),
    serialNumber: text(merchandise?.serialNumber),
    purchaseDate: toIsoDate(merchandise?.purchaseDate),
  };
  for (const key of Object.keys(result) as Array<keyof FoundResult>) {
    if (result[key] === undefined) delete result[key];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface HssomOrderLookupConfig {
  lookupUrl: string;
  clientId: string;
  timeoutMs: number;
}

// Null when the lookup URL or any HSSOM auth value is missing.
export function readHssomOrderLookupConfig(env: NodeJS.ProcessEnv = process.env): HssomOrderLookupConfig | null {
  const lookupUrl = env.HSSOM_ORDER_LOOKUP_URL?.trim();
  const auth = readHssomAuthConfig(env);
  if (!isHttpsUrl(lookupUrl) || !auth) return null;
  return { lookupUrl: lookupUrl.replace(/\/+$/, ""), clientId: auth.clientId, timeoutMs: hssomTimeoutMs(env) };
}

export interface HssomOrderLookupOptions {
  enabled?: () => boolean;
  config?: () => HssomOrderLookupConfig | null;
  getToken?: () => Promise<string>;
  invalidateToken?: (token: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  foundTtlMs?: number;
  notFoundTtlMs?: number;
  cacheSize?: number;
}

type Outcome = { result: HssomOrderLookupResult; httpStatus?: number; reason?: string };

export function createHssomOrderLookup(options: HssomOrderLookupOptions = {}) {
  const enabled = options.enabled ?? isAhsHssomCustomerPrefillEnabled;
  const readConfig = options.config ?? (() => readHssomOrderLookupConfig());
  const getToken = options.getToken ?? getHssomBearerToken;
  const invalidateToken = options.invalidateToken ?? invalidateHssomBearerToken;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const { foundTtlMs = 30 * 60 * 1000, notFoundTtlMs = 2 * 60 * 1000, cacheSize = 500 } = options;

  // Map iteration order is insertion order: re-inserting on a hit makes the
  // first key the least recently used.
  const cache = new Map<string, { result: HssomOrderLookupResult; expires: number }>();
  const pending = new Map<string, Promise<HssomOrderLookupResult>>();

  async function requestOnce(url: string, config: HssomOrderLookupConfig, token: string): Promise<Outcome | "unauthorized"> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            clientId: config.clientId,
          },
          signal: controller.signal,
        });
      } catch {
        return { result: { status: "unavailable" }, reason: controller.signal.aborted ? "timeout" : "network" };
      }
      if (res.status === 401) return "unauthorized";
      if (res.status === 404) return { result: { status: "not_found" }, httpStatus: 404 };
      if (!res.ok) return { result: { status: "unavailable" }, httpStatus: res.status };
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { result: { status: "unavailable" }, httpStatus: res.status, reason: controller.signal.aborted ? "timeout" : "bad_json" };
      }
      const result = classifyHssomOrderBody(body);
      return { result, httpStatus: res.status, reason: result.status === "unavailable" ? "unexpected_body" : undefined };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchOrder(orderId: string, config: HssomOrderLookupConfig): Promise<Outcome> {
    const url = `${config.lookupUrl}/${encodeURIComponent(orderId)}`;
    // One retry with a fresh token after a 401; a second 401 is an outage.
    for (let attempt = 0; attempt < 2; attempt++) {
      let token: string;
      try {
        token = await getToken();
      } catch {
        return { result: { status: "unavailable" }, reason: "auth" };
      }
      const outcome = await requestOnce(url, config, token);
      if (outcome !== "unauthorized") return outcome;
      invalidateToken(token);
    }
    return { result: { status: "unavailable" }, httpStatus: 401 };
  }

  function remember(orderId: string, result: HssomOrderLookupResult): void {
    const ttl = result.status === "found" ? foundTtlMs : result.status === "not_found" ? notFoundTtlMs : 0;
    if (ttl <= 0) return;
    cache.delete(orderId);
    cache.set(orderId, { result, expires: now() + ttl });
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
  }

  return async function lookup(district: string, bareServiceOrder: string): Promise<HssomOrderLookupResult> {
    if (!enabled()) return { status: "unavailable" };
    const orderId = buildHssomOrderId(district, bareServiceOrder);
    if (!orderId) return { status: "not_found" };
    const config = readConfig();
    if (!config) {
      console.warn(`[hssom-lookup] order=${orderId} status=unavailable reason=not_configured`);
      return { status: "unavailable" };
    }

    const hit = cache.get(orderId);
    if (hit && hit.expires > now()) {
      cache.delete(orderId);
      cache.set(orderId, hit);
      return { ...hit.result };
    }
    if (hit) cache.delete(orderId);
    const existing = pending.get(orderId);
    if (existing) return existing;

    const started = now();
    const work = fetchOrder(orderId, config)
      .catch((): Outcome => ({ result: { status: "unavailable" }, reason: "error" }))
      .then(({ result, httpStatus, reason }) => {
        remember(orderId, result);
        const http = httpStatus === undefined ? "" : ` http=${httpStatus}`;
        const why = reason ? ` reason=${reason}` : "";
        const line = `[hssom-lookup] order=${orderId} status=${result.status}${http}${why} ms=${now() - started}`;
        if (result.status === "unavailable") console.warn(line);
        else console.log(line);
        return { ...result };
      })
      .finally(() => pending.delete(orderId));
    pending.set(orderId, work);
    return work;
  };
}

const defaultLookup = createHssomOrderLookup();

export async function lookupHssomOrder(
  district: string,
  bareServiceOrder: string,
): Promise<HssomOrderLookupResult> {
  return defaultLookup(district, bareServiceOrder);
}
