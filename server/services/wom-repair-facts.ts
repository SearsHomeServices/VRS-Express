// WOM (ServicePower Work Order Management) facts for the repair / replace
// calculator (server/repair-replace-prefill.ts): the visit number, whether
// the previous visit left the repair unresolved, failed attempts, the trip
// charge and the labor job-code prices of one service order.
//
// Same request, config and token handling as the tech form's product lookup
// (server/services/wom-work-order.ts): GET {WOM_WORK_ORDER_URL}?TenantId=..&
// OrderNum=<unit7>-<so8>. Field reference: ai-agent-mcp
// docs/BUILD-WORK-ORDER-HISTORY-TOOL.md §4 (WorkItems[] one per visit,
// WorkItemId "-01"/"-02", WorkItemStatus, isCancelled; Extensions.
// TripChargeAmount; LabourJobCodes[] "job code, description, charge code,
// warranty, price"). The LabourJobCodes price key is NOT verified on a live
// payload, so several spellings are tried; workOrderShape() lets the
// diagnostic (scripts/diagnostics/ahs-prefill-check.mts) show the real keys.
//
// Runs whenever readWomWorkOrderConfig() has a config; it is not gated by
// WOM_PRODUCT_LOOKUP_ENABLED (the tech form's flag).
//
// The record carries the customer's name, phone, email and address
// (WorkItems[].Location[].Contacts) and free-text notes. Nothing from it
// leaves this module except the numbers and booleans below. Logs carry the
// order, status, HTTP status, a fixed reason word and the duration only.

import { getHssomBearerToken, invalidateHssomBearerToken } from "./hssom-auth";
import {
  buildWomOrderNum,
  readWomWorkOrderConfig,
  womHeaders,
  womRecordMatchesOrder,
  womRequestUrl,
  type WomWorkOrderConfig,
} from "./wom-work-order";

export interface WomRepairFacts {
  visitNumber?: number;
  unresolved?: boolean;
  failedAttemptCount?: number;
  tripCharge?: number;
  laborTotal?: number;
  laborLineCount?: number;
  observedAt?: string;
}

export type WomRepairFactsResult =
  | { status: "found"; facts: WomRepairFacts; warnings: string[] }
  | { status: "not_found" }
  | { status: "unavailable" };

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function amount(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return undefined;
  return Number(text);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

interface Visit {
  index: number;
  suffix?: number;
  status?: string;
}

function visitSuffix(workItemId: unknown): number | undefined {
  if (typeof workItemId !== "string" && typeof workItemId !== "number") return undefined;
  const match = /-(\d{1,3})$/.exec(String(workItemId).trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  return value > 0 ? value : undefined;
}

function statusOf(item: Json): string | undefined {
  const raw = item.WorkItemStatus;
  const text = typeof raw === "string" ? raw : obj(raw) && typeof obj(raw)!.Id === "string" ? (obj(raw)!.Id as string) : undefined;
  const cleaned = text?.trim().toLowerCase();
  return cleaned ? cleaned : undefined;
}

const isIncomplete = (status: string | undefined) => status === "incomplete";
const isComplete = (status: string | undefined) => status === "complete" || status === "completed";

function visitsOf(record: Json): Visit[] {
  if (!Array.isArray(record.WorkItems)) return [];
  const visits: Visit[] = [];
  record.WorkItems.forEach((raw, index) => {
    const item = obj(raw);
    if (!item) return;
    if (item.isCancelled === true || item.IsCancelled === true) return;
    visits.push({ index, suffix: visitSuffix(item.WorkItemId), status: statusOf(item) });
  });
  if (visits.length > 1 && visits.every((visit) => visit.suffix !== undefined)) {
    visits.sort((a, b) => a.suffix! - b.suffix! || a.index - b.index);
  }
  return visits;
}

function mapVisits(record: Json, facts: WomRepairFacts): void {
  const visits = visitsOf(record);
  if (!visits.length) return;
  const suffixesReadable = visits.every((visit) => visit.suffix !== undefined);
  const latest = visits[visits.length - 1];
  facts.visitNumber = suffixesReadable ? latest.suffix! : visits.length;
  if (visits.length < 2) return;
  const previous = visits[visits.length - 2];
  if (isIncomplete(previous.status)) facts.unresolved = true;
  else if (isComplete(previous.status)) facts.unresolved = false;
  const earlier = visits.slice(0, -1);
  if (earlier.every((visit) => visit.status !== undefined)) {
    facts.failedAttemptCount = earlier.filter((visit) => isIncomplete(visit.status)).length;
  }
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const LABOR_PRICE_KEYS = ["Price", "price", "Amount", "amount", "ChargeAmount", "LaborPrice", "UnitPrice"] as const;

function laborPrice(line: Json): number | undefined {
  for (const key of LABOR_PRICE_KEYS) {
    const value = amount(line[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function mapLabor(record: Json, facts: WomRepairFacts, warnings: string[]): void {
  if (!Array.isArray(record.LabourJobCodes) || !record.LabourJobCodes.length) return;
  let total = 0;
  for (const raw of record.LabourJobCodes) {
    const line = obj(raw);
    const price = line ? laborPrice(line) : undefined;
    if (price === undefined || price < 0) {
      warnings.push("A WOM labor line has no readable price, so labor was not filled.");
      return;
    }
    total += price;
  }
  facts.laborLineCount = record.LabourJobCodes.length;
  if (round2(total) <= 0) {
    warnings.push("The WOM labor job codes total $0.00 to the customer (covered), so labor was not filled.");
    return;
  }
  facts.laborTotal = round2(total);
}

function mapTrip(record: Json, facts: WomRepairFacts): void {
  const trip = amount(obj(record.Extensions)?.TripChargeAmount);
  if (trip !== undefined && round2(trip) > 0) facts.tripCharge = round2(trip);
}

// Pure; never throws. Warnings are fixed sentences without record values.
export function repairFactsFromWorkOrder(record: unknown): { facts: WomRepairFacts; warnings: string[] } {
  const facts: WomRepairFacts = {};
  const warnings: string[] = [];
  const root = obj(record);
  if (!root) return { facts, warnings };
  try {
    mapVisits(root, facts);
    mapTrip(root, facts);
    mapLabor(root, facts, warnings);
  } catch {
    return { facts: {}, warnings: ["The WOM work order could not be read."] };
  }
  return { facts, warnings };
}

// ---------------------------------------------------------------------------
// Shape (diagnostic): key paths and types, never values
// ---------------------------------------------------------------------------

const SHAPE_MAX_PATHS = 150;
const SKIPPED_KEY = /^(location|contacts?|notes?|customer.*|.*card.*|email.*|phone.*|address.*|.*name)$/i;

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function workOrderShape(record: unknown, roots?: readonly string[]): string[] {
  const paths = new Set<string>();
  const visit = (value: unknown, path: string, depth: number) => {
    if (paths.size >= SHAPE_MAX_PATHS || depth > 6) return;
    if (Array.isArray(value)) {
      if (!value.length) { paths.add(`${path}[]:empty`); return; }
      for (const item of value.slice(0, 5)) visit(item, `${path}[]`, depth + 1);
      return;
    }
    const json = obj(value);
    if (!json) {
      if (path) paths.add(`${path}:${typeName(value)}`);
      return;
    }
    for (const [key, child] of Object.entries(json)) {
      if (SKIPPED_KEY.test(key)) continue;
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  const root = obj(record);
  if (!root) return [];
  if (roots) {
    for (const key of roots) if (key in root && !SKIPPED_KEY.test(key)) visit(root[key], key, 0);
  } else {
    visit(root, "", 0);
  }
  return [...paths].slice(0, SHAPE_MAX_PATHS);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface WomRepairFactsLookupOptions {
  config?: () => WomWorkOrderConfig | null;
  getHssomToken?: () => Promise<string>;
  invalidateHssomToken?: (token: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  foundTtlMs?: number;
  cacheSize?: number;
  // For the diagnostic: called with the matching record (never logged).
  onRecord?: (record: unknown) => void;
}

type Outcome = { result: WomRepairFactsResult; httpStatus?: number; reason?: string };

class Aborted extends Error {}

export function createWomRepairFactsLookup(options: WomRepairFactsLookupOptions = {}) {
  const readConfig = options.config ?? (() => readWomWorkOrderConfig());
  const getHssomToken = options.getHssomToken ?? getHssomBearerToken;
  const invalidateHssomToken = options.invalidateHssomToken ?? invalidateHssomBearerToken;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const { foundTtlMs = 5 * 60 * 1000, cacheSize = 500 } = options;
  const cache = new Map<string, { result: WomRepairFactsResult; expires: number }>();
  const pending = new Map<string, Promise<WomRepairFactsResult>>();

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
    const root = obj(body);
    if (!root || !Array.isArray(root.data)) return { result: { status: "unavailable" }, httpStatus: res.status, reason: "unexpected_body" };
    const record = obj(root.data[0]);
    if (!record) return { result: { status: "not_found" }, httpStatus: res.status };
    if (!womRecordMatchesOrder(record.OrderNum, orderNum)) {
      return { result: { status: "not_found" }, httpStatus: res.status, reason: "order_mismatch" };
    }
    try { options.onRecord?.(record); } catch { /* diagnostic hook only */ }
    const { facts, warnings } = repairFactsFromWorkOrder(record);
    return { result: { status: "found", facts: { ...facts, observedAt: new Date(now()).toISOString() }, warnings }, httpStatus: res.status };
  }

  async function fetchOrder(orderNum: string, config: WomWorkOrderConfig, signal: AbortSignal): Promise<Outcome> {
    const url = womRequestUrl(config, orderNum);
    if (config.staticToken) {
      const outcome = await requestOnce(url, config.staticToken, orderNum, signal);
      return outcome === "unauthorized" ? { result: { status: "unavailable" }, httpStatus: 401, reason: "unauthorized" } : outcome;
    }
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

  const copy = (result: WomRepairFactsResult): WomRepairFactsResult =>
    result.status === "found" ? { status: "found", facts: { ...result.facts }, warnings: [...result.warnings] } : { ...result };

  // Never rejects. district: 1-7 digits (padded); so8: 8 digits.
  return async function lookup(district: string, so8: string): Promise<WomRepairFactsResult> {
    const orderNum = buildWomOrderNum(district, so8);
    if (!orderNum) return { status: "not_found" };
    let config: WomWorkOrderConfig | null;
    try { config = readConfig(); } catch { config = null; }
    if (!config) return { status: "unavailable" };

    const hit = cache.get(orderNum);
    if (hit && hit.expires > now()) return copy(hit.result);
    if (hit) cache.delete(orderNum);
    const existing = pending.get(orderNum);
    if (existing) return existing.then(copy);

    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const work = fetchOrder(orderNum, config, controller.signal)
      .catch((): Outcome => ({ result: { status: "unavailable" }, reason: "error" }))
      .then(({ result, httpStatus, reason }) => {
        if (result.status === "found" && foundTtlMs > 0) {
          cache.set(orderNum, { result, expires: now() + foundTtlMs });
          while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
        }
        const [unit, so] = orderNum.split("-");
        const http = httpStatus === undefined ? "" : ` http=${httpStatus}`;
        const why = reason ? ` reason=${reason}` : "";
        const line = `[repair-replace-wom] SO=${unit.replace(/^0+(?=\d{4})/, "")}-${so} status=${result.status}${http}${why} ms=${now() - started}`;
        if (result.status === "unavailable") console.warn(line);
        else console.log(line);
        return result;
      })
      .finally(() => {
        clearTimeout(timer);
        pending.delete(orderNum);
      });
    pending.set(orderNum, work);
    return work.then(copy);
  };
}

const defaultLookup = createWomRepairFactsLookup();

export function lookupWomRepairFacts(district: string, so8: string): Promise<WomRepairFactsResult> {
  return defaultLookup(district, so8);
}
