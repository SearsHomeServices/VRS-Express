// WOM (ServicePower Work Order Management) work-order client: the service
// order's Product Category for the tech form's Appliance Type.
//
// Same request as ai-agent-mcp WorkOrderClient.get_order
// (src/agent_tools/clients/work_order_client.py) and the build doc
// docs/BUILD-WORK-ORDER-HISTORY-TOOL.md §1:
//
//   GET {WOM_WORK_ORDER_URL}?TenantId={WOM_TENANT_ID}&OrderNum=<unit7>-<so8>
//   Authorization: Bearer <token>
//   Accept: application/json
//
// Response envelope { total, limit, skip, data: [record] }; an empty data
// array (HTTP 200) means no such order (doc §5), as does a 404.
//
// Env (no URL or tenant defaults; every environment configures its own):
//   WOM_WORK_ORDER_URL  required, https only. Documented values (doc §1):
//     PROD https://hssom-api-gateway.shs-core.com/v1/api/sb/proxy/serviceOrder/api/v1/work-orders
//     QA   https://hssom-api-gateway-qa.shs-core.com/v1/api/sb/proxy/serviceOrder/api/v1/work-orders
//   WOM_TENANT_ID       required. Documented values: PROD XBrNUYNs0W, QA mZCWZ1-sQB.
//   WOM_BEARER_TOKEN    optional static WOM token (ai-agent-mcp
//     WORK_ORDER_BEARER_TOKEN_* / WOM_PROD_TOKEN). When unset, the HSSOM
//     gateway token from HSSOMAuthService (server/services/hssom-auth.ts) is
//     used; that needs a token with the serviceOrder proxy URI grant.
//   WOM_TIMEOUT_MS      optional, default 4000: bounds the whole lookup
//     (token, request, the one 401 retry).
// Off unless WOM_PRODUCT_LOOKUP_ENABLED is "true" (isWomProductLookupEnabled).
//
// Logs only the order ID, status, HTTP status, a fixed reason word and the
// duration. NEVER the body (customer name, phone and address are in it), the
// token or the product value.

import { divisionFromServiceOrderProduct, type ApplianceDivision } from "../../shared/appliance-division";
import type { ServiceOrderProduct } from "../../shared/warranty";
import { isWomProductLookupEnabled } from "../featureFlags";
import { getHssomBearerToken, invalidateHssomBearerToken, isHttpsUrl, readHssomAuthConfig } from "./hssom-auth";
import type { ServiceOrderApplianceResult } from "./snowflake-lookup";

export type WomProductLookupResult =
  | { status: "found"; productCategory?: string }
  | { status: "not_found" }
  | { status: "unavailable" };

export const WOM_DEFAULT_TIMEOUT_MS = 4000;

export interface WomWorkOrderConfig {
  url: string;
  tenantId: string;
  // WOM_BEARER_TOKEN; absent means the HSSOM gateway token.
  staticToken?: string;
  timeoutMs: number;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function womTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = envValue(env, "WOM_TIMEOUT_MS");
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return value > 0 ? value : WOM_DEFAULT_TIMEOUT_MS;
}

// Null when the URL (https) or tenant is missing, or there is no way to get
// a token (no WOM_BEARER_TOKEN and no HSSOM auth configuration).
export function readWomWorkOrderConfig(env: NodeJS.ProcessEnv = process.env): WomWorkOrderConfig | null {
  const url = envValue(env, "WOM_WORK_ORDER_URL");
  const tenantId = envValue(env, "WOM_TENANT_ID");
  if (!isHttpsUrl(url) || !tenantId) return null;
  const staticToken = envValue(env, "WOM_BEARER_TOKEN");
  if (!staticToken && !readHssomAuthConfig(env)) return null;
  return { url, tenantId, ...(staticToken ? { staticToken } : {}), timeoutMs: womTimeoutMs(env) };
}

// "<unit padded to 7>-<8-digit SO>", e.g. 0008175-13717195 (WorkOrderTools.
// build_order_num). A bare SO returns zero rows. Null for anything else.
export function buildWomOrderNum(serviceUnit: string, so8: string): string | null {
  const unit = String(serviceUnit ?? "").trim();
  const so = String(so8 ?? "").trim();
  if (!/^\d{1,7}$/.test(unit) || !/^\d{8}$/.test(so)) return null;
  return `${unit.padStart(7, "0")}-${so}`;
}

export function womRequestUrl(config: Pick<WomWorkOrderConfig, "url" | "tenantId">, orderNum: string): string {
  const url = new URL(config.url);
  url.searchParams.set("TenantId", config.tenantId);
  url.searchParams.set("OrderNum", orderNum);
  return url.toString();
}

// The headers WorkOrderClient._get_headers sends.
export function womHeaders(token: string): Record<string, string> {
  return { Accept: "application/json", Authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// Product category parsing
// ---------------------------------------------------------------------------
//
// Where the record keeps the product: WorkItems[].Products[] (ai-agent-mcp
// JobConstraints.from_wom_work_item reads WorkItems[0].Products[0] for Mfg,
// ModelNum, SerialNum and WarrantyType; doc §4 lists Products[] as "Mfg,
// Type, ModelNum, SerialNum, warranty"), then a top-level Products[] if one
// exists.
//
// Which field is the ServicePower UI's "Product Category" (e.g. "WASHERDD -
// WASHER, DIRECT DRIVE") is NOT verified against a live payload: no sample
// work-order JSON exists in ai-agent-mcp or the optimizer. Products[].Type is
// the only product-kind field the reference documents, so it is read first.
// The candidates, in priority order (the first field with a value on any
// product wins, products in order):
//   1. Type             string, or { Id, Description | Name | Label | Value }
//   2. ProductCategory  same shapes
//   3. ProductType      same shapes
//   4. Category         same shapes
//   5. ProductCode / ProductCd + ProductDescription | Description
//   6. MerchandiseCode / MerchCode + MerchandiseDescription | Description
// A code and a description render as "CODE - DESCRIPTION", the way the UI
// shows it. WarrantyType in the same object is a dict {"Id": ...} or a
// string (job_constraints.py), hence both shapes.

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

const MAX_CATEGORY_LENGTH = 120;

function clean(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
  const text = raw?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_CATEGORY_LENGTH) : undefined;
}

function codeAndDescription(code: string | undefined, description: string | undefined): string | undefined {
  if (code && description) {
    if (description.toUpperCase().startsWith(code.toUpperCase())) return description;
    return `${code} - ${description}`.slice(0, MAX_CATEGORY_LENGTH);
  }
  return code ?? description;
}

// A string, or an object with an Id and a description-like field.
function categoryValue(value: unknown): string | undefined {
  const direct = clean(value);
  if (direct) return direct;
  const record = obj(value);
  if (!record) return undefined;
  const code = clean(record.Id ?? record.Code ?? record.id ?? record.code);
  const description = clean(record.Description ?? record.Name ?? record.Label ?? record.Value ?? record.description ?? record.name);
  return codeAndDescription(code, description);
}

const CATEGORY_FIELDS: Array<(product: Json) => string | undefined> = [
  (p) => categoryValue(p.Type),
  (p) => categoryValue(p.ProductCategory),
  (p) => categoryValue(p.ProductType),
  (p) => categoryValue(p.Category),
  (p) => {
    const code = clean(p.ProductCode ?? p.ProductCd);
    return code ? codeAndDescription(code, clean(p.ProductDescription ?? p.Description)) : undefined;
  },
  (p) => {
    const code = clean(p.MerchandiseCode ?? p.MerchCode);
    return code ? codeAndDescription(code, clean(p.MerchandiseDescription ?? p.Description)) : undefined;
  },
];

function productsOf(record: Json): Json[] {
  const products: Json[] = [];
  const add = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const product = obj(item);
      if (product) products.push(product);
    }
  };
  if (Array.isArray(record.WorkItems)) for (const item of record.WorkItems) add(obj(item)?.Products);
  add(record.Products);
  return products;
}

export function productCategoryFromWorkOrderRecord(record: unknown): string | undefined {
  const root = obj(record);
  if (!root) return undefined;
  const products = productsOf(root);
  for (const field of CATEGORY_FIELDS) {
    for (const product of products) {
      const value = field(product);
      if (value) return value;
    }
  }
  return undefined;
}

// The record's OrderNum, when it is a composite ID, must be the order asked
// for: SO numbers are reused across units.
function sameOrder(recordOrderNum: unknown, orderNum: string): boolean {
  const value = clean(recordOrderNum);
  const match = value ? /^(\d{1,7})-(\d{8})$/.exec(value) : null;
  if (!match) return true;
  const [unit, so] = orderNum.split("-");
  return Number(match[1]) === Number(unit) && match[2] === so;
}

// 200 bodies. Anything that is not the documented envelope is unavailable.
export function classifyWomWorkOrderBody(body: unknown, orderNum: string): WomProductLookupResult & { reason?: string } {
  const root = obj(body);
  if (!root || !Array.isArray(root.data)) return { status: "unavailable", reason: "unexpected_body" };
  const record = obj(root.data[0]);
  if (!record) return { status: "not_found" };
  if (!sameOrder(record.OrderNum, orderNum)) return { status: "not_found", reason: "order_mismatch" };
  const productCategory = productCategoryFromWorkOrderRecord(record);
  return productCategory ? { status: "found", productCategory } : { status: "found" };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface WomWorkOrderLookupOptions {
  enabled?: () => boolean;
  config?: () => WomWorkOrderConfig | null;
  // HSSOM gateway token; used only when the config has no static token.
  getHssomToken?: () => Promise<string>;
  invalidateHssomToken?: (token: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  foundTtlMs?: number;
  notFoundTtlMs?: number;
  cacheSize?: number;
}

type Outcome = { result: WomProductLookupResult; httpStatus?: number; reason?: string };

class Aborted extends Error {}

export function createWomWorkOrderLookup(options: WomWorkOrderLookupOptions = {}) {
  const enabled = options.enabled ?? isWomProductLookupEnabled;
  const readConfig = options.config ?? (() => readWomWorkOrderConfig());
  const getHssomToken = options.getHssomToken ?? getHssomBearerToken;
  const invalidateHssomToken = options.invalidateHssomToken ?? invalidateHssomBearerToken;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const { foundTtlMs = 6 * 60 * 60 * 1000, notFoundTtlMs = 2 * 60 * 1000, cacheSize = 1000 } = options;

  // Map iteration order is insertion order: re-inserting on a hit makes the
  // first key the least recently used.
  const cache = new Map<string, { result: WomProductLookupResult; expires: number }>();
  const pending = new Map<string, Promise<WomProductLookupResult>>();

  function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new Aborted());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Aborted());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
        (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
      );
    });
  }

  async function requestOnce(url: string, token: string, orderNum: string, signal: AbortSignal): Promise<Outcome | "unauthorized"> {
    let res: Response;
    try {
      res = await doFetch(url, { method: "GET", headers: womHeaders(token), signal });
    } catch {
      return { result: { status: "unavailable" }, reason: signal.aborted ? "timeout" : "network" };
    }
    if (res.status === 401) return "unauthorized";
    if (res.status === 403) return { result: { status: "unavailable" }, httpStatus: 403, reason: "forbidden" };
    if (res.status === 404) return { result: { status: "not_found" }, httpStatus: 404 };
    if (!res.ok) return { result: { status: "unavailable" }, httpStatus: res.status };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { result: { status: "unavailable" }, httpStatus: res.status, reason: signal.aborted ? "timeout" : "bad_json" };
    }
    const { reason, ...result } = classifyWomWorkOrderBody(body, orderNum);
    return { result, httpStatus: res.status, reason };
  }

  async function fetchOrder(orderNum: string, config: WomWorkOrderConfig, signal: AbortSignal): Promise<Outcome> {
    const url = womRequestUrl(config, orderNum);
    if (config.staticToken) {
      const outcome = await requestOnce(url, config.staticToken, orderNum, signal);
      // A static token cannot be refreshed: a 401 is an outage.
      return outcome === "unauthorized" ? { result: { status: "unavailable" }, httpStatus: 401, reason: "unauthorized" } : outcome;
    }
    // HSSOM token: one retry with a fresh token after a 401.
    for (let attempt = 0; attempt < 2; attempt++) {
      let token: string;
      try {
        token = await untilAborted(getHssomToken(), signal);
      } catch (err) {
        return { result: { status: "unavailable" }, reason: err instanceof Aborted ? "timeout" : "auth" };
      }
      const outcome = await requestOnce(url, token, orderNum, signal);
      if (outcome !== "unauthorized") return outcome;
      invalidateHssomToken(token);
    }
    return { result: { status: "unavailable" }, httpStatus: 401, reason: "unauthorized" };
  }

  function remember(orderNum: string, result: WomProductLookupResult): void {
    const ttl = result.status === "found" ? foundTtlMs : result.status === "not_found" ? notFoundTtlMs : 0;
    if (ttl <= 0) return;
    cache.delete(orderNum);
    cache.set(orderNum, { result, expires: now() + ttl });
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
  }

  // Never rejects. serviceUnit: 1-7 digits (padded); so8: 8 digits.
  return async function lookup(serviceUnit: string, so8: string): Promise<WomProductLookupResult> {
    if (!enabled()) return { status: "unavailable" };
    const orderNum = buildWomOrderNum(serviceUnit, so8);
    if (!orderNum) return { status: "not_found" };
    const config = readConfig();
    if (!config) return { status: "unavailable" };

    const hit = cache.get(orderNum);
    if (hit && hit.expires > now()) {
      cache.delete(orderNum);
      cache.set(orderNum, hit);
      return { ...hit.result };
    }
    if (hit) cache.delete(orderNum);
    const existing = pending.get(orderNum);
    if (existing) return existing.then((result) => ({ ...result }));

    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const work = fetchOrder(orderNum, config, controller.signal)
      .catch((): Outcome => ({ result: { status: "unavailable" }, reason: "error" }))
      .then(({ result, httpStatus, reason }) => {
        remember(orderNum, result);
        const http = httpStatus === undefined ? "" : ` http=${httpStatus}`;
        const why = reason ? ` reason=${reason}` : "";
        const line = `[wom-lookup] order=${orderNum} status=${result.status}${http}${why} ms=${now() - started}`;
        if (result.status === "unavailable") console.warn(line);
        else console.log(line);
        return result;
      })
      .finally(() => {
        clearTimeout(timer);
        pending.delete(orderNum);
      });
    pending.set(orderNum, work);
    return work.then((result) => ({ ...result }));
  };
}

const defaultLookup = createWomWorkOrderLookup();

export function lookupWomProductCategory(serviceUnit: string, so8: string): Promise<WomProductLookupResult> {
  return defaultLookup(serviceUnit, so8);
}

// ---------------------------------------------------------------------------
// The service order's product: WOM first, Snowflake HS_SP_CD as the fallback
// (GET /api/tech/lookup-warranty and POST /api/submissions)
// ---------------------------------------------------------------------------

export interface ResolvedServiceOrderProduct {
  serviceOrderProduct?: ServiceOrderProduct;
  applianceType?: ApplianceDivision;
}

export interface ResolveServiceOrderProductDeps {
  // fetchServiceOrderApplianceType: never rejects, bounded by its own deadline.
  snowflake: (serviceOrder: string) => Promise<ServiceOrderApplianceResult>;
  wom: (serviceUnit: string, so8: string) => Promise<WomProductLookupResult>;
  // Bounds the WOM side, both WOM calls included. Default WOM_TIMEOUT_MS.
  womBudgetMs?: number;
}

// For a "DDDD-SSSSSSSS" service order. Never rejects.
//
// WOM is asked under the tech's padded district at once, in parallel with
// Snowflake: a WOM order under the district is the one Snowflake's unit
// resolution would pick too (the district's row wins; snowflake-lookup.ts).
// Only when WOM has no order there and Snowflake resolved the SO to another
// unit is WOM asked again under that unit, inside the same budget.
//   WOM category      -> { text, source: "wom" },  type from the category
//   else HS_SP_CD     -> { text, source: "snowflake" }, type from HS_SP_CD
//   else              -> neither
// The type always comes from the text shown, never mixed across sources.
export async function resolveServiceOrderProduct(
  serviceOrder: string,
  deps: ResolveServiceOrderProductDeps,
): Promise<ResolvedServiceOrderProduct> {
  const match = /^(\d{4})-(\d{8})$/.exec(String(serviceOrder ?? "").trim());
  if (!match) return {};
  const [, district, so8] = match;
  const unavailable = { status: "unavailable" as const };

  const snowflakePromise: Promise<ServiceOrderApplianceResult> = Promise.resolve()
    .then(() => deps.snowflake(`${district}-${so8}`))
    .catch(() => unavailable);

  const askWom = (unit: string): Promise<WomProductLookupResult> =>
    Promise.resolve().then(() => deps.wom(unit, so8)).catch(() => unavailable);

  const womPromise = (async (): Promise<WomProductLookupResult> => {
    const first = await askWom(district);
    if (first.status !== "not_found") return first;
    const snowflake = await snowflakePromise;
    const resolvedUnit = snowflake.status === "found" ? snowflake.serviceUnit : undefined;
    if (resolvedUnit && resolvedUnit !== district.padStart(7, "0")) return askWom(resolvedUnit);
    return first;
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<WomProductLookupResult>((resolve) => {
    timer = setTimeout(() => resolve(unavailable), deps.womBudgetMs ?? womTimeoutMs());
  });
  const wom = await Promise.race([womPromise, budget]).finally(() => clearTimeout(timer));

  let resolved: ResolvedServiceOrderProduct = {};
  let snowflakeStatus = "skipped";
  if (wom.status === "found" && wom.productCategory) {
    const applianceType = divisionFromServiceOrderProduct(wom.productCategory);
    resolved = { serviceOrderProduct: { text: wom.productCategory, source: "wom" }, ...(applianceType ? { applianceType } : {}) };
  } else {
    const snowflake = await snowflakePromise;
    snowflakeStatus = snowflake.status;
    if (snowflake.status === "found") {
      resolved = {
        ...(snowflake.product ? { serviceOrderProduct: { text: snowflake.product, source: "snowflake" as const } } : {}),
        ...(snowflake.applianceType ? { applianceType: snowflake.applianceType } : {}),
      };
    }
  }
  // Statuses and the division only; never the product text.
  console.info(
    `[service-order-product] SO=${district}-${so8} source=${resolved.serviceOrderProduct?.source ?? "none"} ` +
    `wom=${wom.status} snowflake=${snowflakeStatus} division=${resolved.applianceType ?? "none"}`,
  );
  return resolved;
}
