// HSSOM Order Lookup client (customer name and address for a service order).
//
// The exported HssomOrderLookupResult and lookupHssomOrder are the contract
// with server/ahs-prefill.ts; keep the names and shape.
//
// Same service the scheduling optimizer calls through HssomLookupClient in
// gateway mode (src/clients/hssom_lookup_client.py): GET
// {HSSOM_ORDER_LOOKUP_URL}/{orderId} with the HSSOM bearer token
// (server/services/hssom-auth.ts) plus the Order Lookup headers (see
// lookupHeaders below).
//
// HSSOM_ORDER_LOOKUP_URL is required and has no default. Examples:
//   PROD (known good): https://hssom-api-gateway.shs-core.com/v1/api/HSSOMOrderLookupService/services/domi/orders
//     (optimizer .env.example HSSOM_LOOKUP_URL_PROD_OPEN; HTTP 200 recorded
//     in its troubleshooting notes, Part 20)
//   QA (UNVERIFIED, inferred from the QA gateway host used by HSSOM auth,
//     create, reschedule and message):
//     https://hssom-api-gateway-qa.stage.nextgen.shs.com/v1/api/HSSOMOrderLookupService/services/domi/orders
//
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
      // What the order says about the repair, for the repair / replace
      // calculator. Amounts, codes and counts only: no customer data.
      repairFacts?: HssomRepairFacts;
    }
  | { status: "not_found" }
  | { status: "unavailable" };

// Order Lookup Full V2 (HSSOMOrderLookupService spec V0.13, section 7),
// paths confirmed on a live PROD order (7108-14201974, 2026-10-29) and QA
// orders: serviceOrder.estimate.{tripCharge, partsTaxPerc, laborTaxPerc},
// jobCodes[].{jobCode, description, chargeCode, chargeAmount,
// coverage.coverageCode}, parts[].{price, quantity, status},
// serviceInfo.attemptCount, previousAttempts[], providerId (W2 = Sears).
export interface HssomJobCode {
  jobCode?: string;
  description?: string;
  chargeCode?: string;
  chargeAmount?: number;
  coverageCode?: string;
}

export interface HssomPartLine {
  price?: number;
  quantity?: number;
  status?: string;
}

export interface HssomRepairFacts {
  tripCharge?: number;
  partsTaxRate?: number;
  laborTaxRate?: number;
  attemptCount?: number;
  previousAttemptCount?: number;
  providerId?: string;
  jobCodes: HssomJobCode[];
  parts: HssomPartLine[];
}

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
// from_hssom_response, src/agent_tools/data_service/models/customer_details.py;
// the optimizer's copy, src/data_service/models/customer_details.py:203-289,
// reads the same paths: serviceOrder wrapper, customer.name, customer.address,
// merchandise.brand.brandName / modelNumber / serialNumber / purchaseDate,
// thirdParty.contractNumber)
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

// A finite number from a JSON number or numeric string.
function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const raw = text(value);
  if (!raw || !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) return undefined;
  return Number(raw);
}

// A JSON array, or one object where a list has a single entry.
function list(value: unknown): Json[] {
  if (Array.isArray(value)) return value.map(obj).filter((item): item is Json => !!item);
  const single = obj(value);
  return single ? [single] : [];
}

export function repairFactsFromOrder(order: Json): HssomRepairFacts {
  const estimate = obj(order.estimate);
  const serviceInfo = obj(order.serviceInfo);
  const facts: HssomRepairFacts = {
    tripCharge: num(estimate?.tripCharge),
    partsTaxRate: num(estimate?.partsTaxPerc),
    laborTaxRate: num(estimate?.laborTaxPerc),
    attemptCount: num(serviceInfo?.attemptCount),
    previousAttemptCount: Array.isArray(order.previousAttempts) || obj(order.previousAttempts)
      ? list(order.previousAttempts).length : undefined,
    providerId: text(order.providerId)?.toUpperCase(),
    jobCodes: list(order.jobCodes).map((line) => ({
      jobCode: text(line.jobCode),
      description: text(line.description ?? line.Description),
      chargeCode: text(line.chargeCode),
      chargeAmount: num(line.chargeAmount),
      coverageCode: text(obj(line.coverage)?.coverageCode),
    })),
    parts: list(order.parts).map((line) => ({
      price: num(line.price),
      quantity: num(line.quantity),
      status: text(line.status)?.toUpperCase(),
    })),
  };
  for (const key of Object.keys(facts) as Array<keyof HssomRepairFacts>) {
    if (facts[key] === undefined) delete facts[key];
  }
  return facts;
}

function nonEmptyRepairFacts(facts: HssomRepairFacts): HssomRepairFacts | undefined {
  const { jobCodes, parts, ...rest } = facts;
  return jobCodes.length || parts.length || Object.keys(rest).length ? facts : undefined;
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
    repairFacts: nonEmptyRepairFacts(repairFactsFromOrder(order)),
  };
  for (const key of Object.keys(result) as Array<keyof FoundResult>) {
    if (result[key] === undefined) delete result[key];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// Order Lookup "clientid" value. Lookup and CreateOrder use different
// headers: CreateOrder takes clientId: WBOT, Lookup takes clientid: TABS with
// servicename: IHSOLookup and serviceversion: 1.0. With the wrong client
// header the gateway still answers 200 but drops latitude/longitude from
// customer.address (optimizer commit 39047f9, verified against the prod
// gateway 2026-04-30). The optimizer has since added AIAG as its preferred
// value with TABS as the fallback (commit 264bffe); TABS is the value
// verified to return the full address. HSSOM_CLIENT_ID is the auth-service
// client ID and is not sent here unless HSSOM_LOOKUP_CLIENT_ID is set to it.
export const DEFAULT_HSSOM_LOOKUP_CLIENT_ID = "TABS";

export interface HssomOrderLookupConfig {
  lookupUrl: string;
  // Sent as the Order Lookup "clientid" header (HSSOM_LOOKUP_CLIENT_ID).
  lookupClientId: string;
  timeoutMs: number;
}

// Null when the lookup URL or any HSSOM auth value is missing.
export function readHssomOrderLookupConfig(env: NodeJS.ProcessEnv = process.env): HssomOrderLookupConfig | null {
  const lookupUrl = env.HSSOM_ORDER_LOOKUP_URL?.trim();
  const auth = readHssomAuthConfig(env);
  if (!isHttpsUrl(lookupUrl) || !auth) return null;
  return {
    lookupUrl: lookupUrl.replace(/\/+$/, ""),
    lookupClientId: env.HSSOM_LOOKUP_CLIENT_ID?.trim() || DEFAULT_HSSOM_LOOKUP_CLIENT_ID,
    timeoutMs: hssomTimeoutMs(env),
  };
}

// Headers the optimizer's fixed gateway mode sends (_get_headers in
// src/clients/hssom_lookup_client.py): the Lookup headers, Accept,
// Content-Type and the bearer token. Cache-Control is VPN mode only.
export function lookupHeaders(config: Pick<HssomOrderLookupConfig, "lookupClientId">, token: string): Record<string, string> {
  return {
    servicename: "IHSOLookup",
    serviceversion: "1.0",
    clientid: config.lookupClientId,
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
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
          headers: lookupHeaders(config, token),
          signal: controller.signal,
        });
      } catch {
        return { result: { status: "unavailable" }, reason: controller.signal.aborted ? "timeout" : "network" };
      }
      if (res.status === 401) return "unauthorized";
      if (res.status === 403) return { result: { status: "unavailable" }, httpStatus: 403, reason: "forbidden" };
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
        // 403 usually means the bearer token is valid but not granted the
        // Order Lookup service; say so without logging the token.
        const hint = httpStatus === 403 ? " hint=token may lack OrderLookup grant" : "";
        const line = `[hssom-lookup] order=${orderId} status=${result.status}${http}${why} ms=${now() - started}${hint}`;
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
