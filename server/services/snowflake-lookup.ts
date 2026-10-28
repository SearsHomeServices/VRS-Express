import { divisionFromServiceOrderProduct, type ApplianceDivision } from "../../shared/appliance-division";

export type ProcIdResult =
  | { status: "FOUND" | "NOT_FOUND"; procId: string; clientNm: string }
  | { status: "LOOKUP_UNAVAILABLE"; retryable: true };

export function normalizeServiceOrder(raw: string): string {
  const value = raw.trim();
  return (value.includes("-") ? value.split("-")[1] : value).trim();
}

/** Do not persist an outage as missing data, including partially-known records. */
export async function applyProcIdRepair(
  result: ProcIdResult,
  update: (fields: { procId: string; clientNm: string }) => Promise<unknown>,
): Promise<ProcIdResult["status"]> {
  if (result.status !== "LOOKUP_UNAVAILABLE") {
    await update({ procId: result.procId, clientNm: result.clientNm });
  }
  return result.status;
}

type LookupOptions = { concurrency?: number; queueLimit?: number; deadlineMs?: number;
  positiveMs?: number; negativeMs?: number; unavailableMs?: number; cacheSize?: number };

/**
 * Process-local bounded admission, including time spent waiting for a slot.
 * Concurrent calls for one key share a single query; every result is cached
 * for the TTL `ttlFor` picks. `run` errors and the deadline yield `unavailable`.
 */
function createBoundedLookup<R>(
  unavailable: () => R,
  ttlFor: (result: R, ttl: { positiveMs: number; negativeMs: number; unavailableMs: number }) => number,
  options: LookupOptions,
) {
  const { concurrency = 4, queueLimit = 32, deadlineMs = 15000,
    positiveMs = 21600000, negativeMs = 120000, unavailableMs = 5000, cacheSize = 5000 } = options;
  const cache = new Map<string, { result: R; expires: number }>();
  const pending = new Map<string, Promise<R>>();
  const queue: Array<() => void> = [];
  let active = 0;
  return (key: string, run: (signal: AbortSignal) => Promise<R>): Promise<R> => {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.result);
    cache.delete(key);
    const existing = pending.get(key);
    if (existing) return existing;
    // Overload is transient, not a negative lookup, and does not grow the cache.
    if (active >= concurrency && queue.length >= queueLimit) return Promise.resolve(unavailable());
    const controller = new AbortController();
    let start: () => void;
    const work = new Promise<R>((resolve) => {
      let finished = false;
      let started = false;
      const finish = (result: R) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        controller.abort(); // release underlying statement and socket on every exit
        if (started) active--;
        else {
          const index = queue.indexOf(start);
          if (index >= 0) queue.splice(index, 1);
        }
        cache.set(key, { result, expires: Date.now() + ttlFor(result, { positiveMs, negativeMs, unavailableMs }) });
        while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
        resolve(result);
        if (active < concurrency) queue.shift()?.();
      };
      const timer = setTimeout(() => finish(unavailable()), deadlineMs);
      start = () => {
        started = true;
        active++;
        // Attach both handlers immediately; late completions cannot mutate cache.
        Promise.resolve().then(() => run(controller.signal)).then(finish, () => finish(unavailable()));
      };
      if (active < concurrency) start();
      else queue.push(start);
    });
    pending.set(key, work);
    void work.then(() => pending.delete(key));
    return work;
  };
}

// A positional statement for a lookup driver. A null bind is SQL NULL.
export interface LookupStatement {
  sqlText: string;
  binds: Array<string | null>;
}

// Runs one statement. Statements run for one lookup (the same signal) share
// a connection (server/services/snowflake.ts).
export type LookupStatementQuery = (statement: LookupStatement, signal: AbortSignal) => Promise<any[]>;

const SERVICE_ORDER_TABLE = "PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL";

// The district's row first, then the most recently created order. Service
// order numbers are reused across units (see "Service unit resolution"
// below); SO_CRT_DT is the order's create date (ai-agent-mcp
// service_order_tools.py filters this table on it). Binds: [serviceOrder,
// district].
const SO_MATCH_DISTRICT_THEN_RECENT =
  "WHERE SO_NO = ? ORDER BY CASE WHEN SVC_UN_NO = LPAD(?, 7, '0') THEN 0 ELSE 1 END, SO_CRT_DT DESC NULLS LAST LIMIT 1";

// ProcID / client name, district's order first, else the most recent one.
// Binds: [serviceOrder, district or null].
export const PROC_ID_SQL =
  `SELECT CMB_THD_PTY_ID, CLIENT_NM FROM ${SERVICE_ORDER_TABLE} ${SO_MATCH_DISTRICT_THEN_RECENT}`;
// The statement before the ordering, run only when PROC_ID_SQL fails (e.g.
// a column name the live schema rejects), so warranty detection and submit
// never depend on SO_CRT_DT. Binds: [serviceOrder].
export const PROC_ID_FALLBACK_SQL =
  `SELECT CMB_THD_PTY_ID, CLIENT_NM FROM ${SERVICE_ORDER_TABLE} WHERE SO_NO = ? LIMIT 1`;

// "DDDD-SSSSSSSS" -> the district before the "-" (1-7 digits) or null, and
// the SO after it (normalizeServiceOrder); a bare SO has no district.
export function procLookupKey(raw: string): { district: string | null; serviceOrder: string } {
  const value = String(raw ?? "").trim();
  const district = value.includes("-") ? value.split("-")[0].trim() : "";
  return {
    district: /^\d{1,7}$/.test(district) ? district.padStart(7, "0") : null,
    serviceOrder: normalizeServiceOrder(value),
  };
}

// Runs `statement`; if it fails (not the deadline), logs the message and
// runs `fallback` on the same lookup's connection instead.
async function withFallbackStatement(
  query: LookupStatementQuery,
  statement: LookupStatement,
  fallback: LookupStatement,
  signal: AbortSignal,
  label: string,
): Promise<{ rows: any[]; fallback: boolean }> {
  try {
    return { rows: await query(statement, signal), fallback: false };
  } catch (err) {
    if (signal.aborted) throw err;
    // The error message only (a column name or SQL error); never row values.
    const message = String((err as any)?.message ?? err).slice(0, 200);
    console.warn(`${label} ordered statement failed, retrying the unordered statement: ${message}`);
    return { rows: await query(fallback, signal), fallback: true };
  }
}

/**
 * ProcID / client name for a service order (warranty classification).
 * "DDDD-SSSSSSSS" prefers the district's order among SOs reused across
 * units, else the most recent; a bare SO takes the most recent. Cached by
 * district and SO.
 */
export function createProcLookup(query: LookupStatementQuery, options: LookupOptions = {}) {
  const lookup = createBoundedLookup<ProcIdResult>(
    () => ({ status: "LOOKUP_UNAVAILABLE", retryable: true }),
    (result, ttl) => result.status === "FOUND" ? ttl.positiveMs
      : result.status === "NOT_FOUND" ? ttl.negativeMs : ttl.unavailableMs,
    options,
  );
  return (raw: string): Promise<ProcIdResult> => {
    const { district, serviceOrder } = procLookupKey(raw);
    const key = district ? `${district}-${serviceOrder}` : serviceOrder;
    return lookup(key, async (signal): Promise<ProcIdResult> => {
      const { rows } = await withFallbackStatement(
        query,
        { sqlText: PROC_ID_SQL, binds: [serviceOrder, district] },
        { sqlText: PROC_ID_FALLBACK_SQL, binds: [serviceOrder] },
        signal,
        `[proc-id] SO=${serviceOrder}`,
      );
      return rows.length ? {
        status: "FOUND",
        procId: String(rows[0].CMB_THD_PTY_ID ?? "").trim() || "Not Found",
        clientNm: String(rows[0].CLIENT_NM ?? "").trim() || "Not Found",
      } : { status: "NOT_FOUND", procId: "Not Found", clientNm: "Not Found" };
    });
  };
}

// ===========================================================================
// Service unit resolution (AHS prefill and the appliance type)
// ===========================================================================
//
// Service order numbers are reused across units, and the district the tech
// types is not always the unit the order lives under: a tech in district
// 7995 can work SO 11075199 that lives under unit 0008366 (ServicePower
// "0008366-11075199"). So the statements match on SO_NO and resolve the unit
// from the rows (the AHS prefill, which returns customer-related data):
//   1. the row under the tech's padded district ("7995" -> "0007995") wins;
//   2. else, if every row for the SO is under one unit, that unit wins;
//   3. else the order is ambiguous (several units, none the district) and the
//      lookup answers not_found rather than return another unit's data.
// The appliance type (non-PII) relaxes 3: its statement orders by
// SO_CRT_DT too and takes the most recent order (pickApplianceServiceUnit).
// One statement does it: the ORDER BY puts the district's row first, and the
// window COUNT(DISTINCT SVC_UN_NO) OVER () is computed over every row the
// WHERE matched (before LIMIT 1), so one row tells both the chosen unit and
// how many units the SO spans. Rows for one SO are few; no second statement.

// Binds: [serviceOrder, district].
const SO_MATCH_PREFER_DISTRICT =
  "WHERE SO_NO = ? ORDER BY CASE WHEN SVC_UN_NO = LPAD(?, 7, '0') THEN 0 ELSE 1 END LIMIT 1";

// The resolved unit and how many units the SO spans.
const SERVICE_UNIT_SELECT = "SVC_UN_NO AS SERVICE_UNIT, COUNT(DISTINCT SVC_UN_NO) OVER () AS UNIT_COUNT";

// SVC_UN_NO as a 7-digit unit ("8366" or "0008366" -> "0008366"), or
// undefined when it is not one.
export function normalizeServiceUnit(value: unknown): string | undefined {
  const unit = value == null ? "" : String(value).trim();
  return /^\d{1,7}$/.test(unit) ? unit.padStart(7, "0") : undefined;
}

// The unit an order resolves to from its first row (SERVICE_UNIT,
// UNIT_COUNT; see SO_MATCH_PREFER_DISTRICT), or undefined when it is
// ambiguous or the row has no usable unit.
export function resolveServiceUnit(row: any, district: string): string | undefined {
  const unit = normalizeServiceUnit(row?.SERVICE_UNIT);
  if (!unit) return undefined;
  if (unit === district.padStart(7, "0")) return unit;
  return Number(row?.UNIT_COUNT) === 1 ? unit : undefined;
}

// ===========================================================================
// AHS service-order prefill (shared/ahs-prefill.ts)
// ===========================================================================
//
// Every statement matches the order by SO_NO and resolves the unit as
// above. The core statement decides the unit; the appliance and parts
// statements resolve it the same way in SQL so all three still run in
// parallel under the 5s deadline, and their rows are kept only when their
// unit equals the core statement's.
//
// Columns NOT yet verified against the live schema live in
// AHS_PREFILL_UNVERIFIED_COLUMNS and run as their own statement: one wrong
// identifier fails a whole Snowflake statement, and the brand and partner
// columns must still come back when it does. Change a column name there
// only; the aliases keep the row mapping below unchanged.

// In use elsewhere against this table.
export const AHS_PREFILL_CONFIRMED_COLUMNS = {
  BRAND: "MFG_BND_NM",
  PARTNER_ID: "CMB_THD_PTY_ID", // what deriveWarrantyFromProcId reads at submit today
  CLIENT_NAME: "CLIENT_NM",
} as const;

// Present and holding values on a live AHS order (2026-10-26,
// scripts/diagnostics/ahs-prefill-check.mts on 4766-14268083: CTA_NO shape
// 99999999/9999999, model and serial filled). Still their own statement so a
// failure here never costs the brand, partner and parts.
export const AHS_PREFILL_UNVERIFIED_COLUMNS = {
  SERVICE_CONTRACT_ID: "CTA_NO", // AHS dispatch number is the part before "/"
  MODEL_NUMBER: "PSV_ITM_MDL_NO",
  SERIAL_NUMBER: "PSV_MDS_SRL_NO",
} as const;

function columnList(columns: Record<string, string>): string {
  return Object.entries(columns).map(([alias, column]) => `${column} AS ${alias}`).join(", ");
}

// Binds: [serviceOrder, district].
export const AHS_PREFILL_CORE_SQL =
  `SELECT ${SERVICE_UNIT_SELECT}, ${columnList(AHS_PREFILL_CONFIRMED_COLUMNS)} ` +
  `FROM ${SERVICE_ORDER_TABLE} ${SO_MATCH_PREFER_DISTRICT}`;
// Binds: [serviceOrder, district].
export const AHS_PREFILL_APPLIANCE_SQL =
  `SELECT SVC_UN_NO AS SERVICE_UNIT, ${columnList(AHS_PREFILL_UNVERIFIED_COLUMNS)} ` +
  `FROM ${SERVICE_ORDER_TABLE} ${SO_MATCH_PREFER_DISTRICT}`;

// The parts on the order, one row per part line, from the DB2 parts table
// (columns confirmed in ai-agent-mcp order_parts_tools.py / order_part.py).
// Its own statement so a failure here never loses the other values.
export const AHS_PREFILL_PARTS_COLUMNS = {
  PART_NUMBER: "SVC_PRT_NO",
  DESCRIPTION: "PRT_DS",
  QUANTITY: "SVC_PRT_QT",
  ORDERED_QUANTITY: "PRT_ORD_QT",
  UNIT_PRICE: "PRT_SEL_PRC_AM", // selling price per unit
  STATUS: "SVC_PRT_STS_CD", // 'X' cancelled, 'V' voided
} as const;

// Enough rows to find 10 live parts after cancelled/voided lines are dropped.
const AHS_PREFILL_PARTS_ROW_LIMIT = 50;
export const AHS_PREFILL_MAX_PARTS = 10;

// NPSXTPN filtered on SVC_UN_NO = <the resolved unit> AND SO_NO = ?. The
// unit comes from the same resolution as the core statement (a scalar
// subquery on the service order table), so the statement need not wait for
// the core row; each part row carries its unit and only rows under the core
// statement's resolved unit are kept. Binds: [serviceOrder, serviceOrder,
// district].
export const AHS_PREFILL_PARTS_SQL =
  `SELECT SVC_UN_NO AS SERVICE_UNIT, ${columnList(AHS_PREFILL_PARTS_COLUMNS)} ` +
  "FROM PRD_DB2.HS_DW_TBLS.NPSXTPN WHERE SO_NO = ? AND SVC_UN_NO = " +
  `(SELECT SVC_UN_NO FROM ${SERVICE_ORDER_TABLE} ${SO_MATCH_PREFER_DISTRICT}) ` +
  `ORDER BY PRT_SEQ_NO LIMIT ${AHS_PREFILL_PARTS_ROW_LIMIT}`;

// Under the lookup's 5s deadline, so a slow parts statement is cancelled
// while the other statements can still answer.
export const AHS_PREFILL_PARTS_TIMEOUT_MS = 2500;

// ahsPartSchema limits (shared/ahs-details.ts); a value outside them is left
// for the VRS manager rather than stored and failing the draft parse.
const AHS_PART_NUMBER_MAX = 100;
const AHS_PART_DESCRIPTION_MAX = 480;
const AHS_PART_MAX_QUANTITY = 99;
const AHS_PART_MAX_PRICE = 1_000_000;

export interface AhsServiceOrderPart {
  partNumber: string;
  description?: string;
  quantity: number;
  unitPrice?: number;
}

export interface AhsServiceOrderPrefill {
  serviceContractId?: string;
  brand?: string;
  modelNumber?: string;
  serialNumber?: string;
  partnerId?: string;
  clientName?: string;
  // The resolved SVC_UN_NO (e.g. "0008366"), which may differ from the
  // tech's district; the HSSOM order ID uses it (server/ahs-prefill.ts).
  // Never stored on the draft or logged.
  serviceUnit?: string;
  // Absent when the parts statement failed or the order has no live parts.
  parts?: AhsServiceOrderPart[];
}

export type AhsPrefillLookupResult =
  | ({ status: "found" } & AhsServiceOrderPrefill)
  | { status: "not_found" }
  | { status: "unavailable" };

export interface AhsPrefillStatement {
  sqlText: string;
  // Positional; see each statement's comment for the order.
  binds: string[];
  // Cancels and rejects just this statement after this long.
  timeoutMs?: number;
}

// Runs the statements on one connection. Each entry settles on its own so a
// failing statement does not discard the others; a connection failure throws.
export type AhsPrefillQuery = (
  statements: AhsPrefillStatement[],
  signal: AbortSignal,
) => Promise<PromiseSettledResult<any[]>[]>;

function text(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === "" ? undefined : trimmed;
}

function amount(value: unknown): number | undefined {
  if (value == null || (typeof value === "string" && value.trim() === "")) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

// NPSXTPN rows → draft parts: live lines only (not cancelled or voided), at
// most 10, quantity at least 1 (SVC_PRT_QT, else PRT_ORD_QT), and the unit
// sell price when there is one.
export function mapAhsServiceOrderParts(rows: any[]): AhsServiceOrderPart[] {
  const parts: AhsServiceOrderPart[] = [];
  for (const row of rows) {
    if (parts.length >= AHS_PREFILL_MAX_PARTS) break;
    const status = text(row?.STATUS)?.toUpperCase();
    if (status === "X" || status === "V") continue;
    const partNumber = text(row?.PART_NUMBER);
    if (!partNumber || partNumber.length > AHS_PART_NUMBER_MAX) continue;
    const used = Math.trunc(amount(row?.QUANTITY) ?? 0);
    const ordered = Math.trunc(amount(row?.ORDERED_QUANTITY) ?? 0);
    const quantity = Math.min(AHS_PART_MAX_QUANTITY, Math.max(1, used > 0 ? used : ordered));
    const part: AhsServiceOrderPart = { partNumber, quantity };
    const description = text(row?.DESCRIPTION);
    if (description && description.length <= AHS_PART_DESCRIPTION_MAX) part.description = description;
    const price = amount(row?.UNIT_PRICE);
    if (price !== undefined && price >= 0 && price * quantity <= AHS_PART_MAX_PRICE) {
      part.unitPrice = Math.round(price * 100) / 100;
    }
    parts.push(part);
  }
  return parts;
}

export function createAhsPrefillLookup(query: AhsPrefillQuery, options: LookupOptions = {}) {
  const lookup = createBoundedLookup<AhsPrefillLookupResult>(
    () => ({ status: "unavailable" }),
    (result, ttl) => result.status === "found" ? ttl.positiveMs
      : result.status === "not_found" ? ttl.negativeMs : ttl.unavailableMs,
    { deadlineMs: 5000, ...options },
  );
  return (district: string, serviceOrder: string): Promise<AhsPrefillLookupResult> => {
    const unit = String(district ?? "").trim();
    const so = String(serviceOrder ?? "").trim();
    // Never query with input the form could not have produced.
    if (!/^\d{4}$/.test(unit) || !/^\d{8}$/.test(so)) return Promise.resolve({ status: "not_found" });
    return lookup(`${unit}-${so}`, async (signal) => {
      const [core, appliance, parts] = await query([
        { sqlText: AHS_PREFILL_CORE_SQL, binds: [so, unit] },
        { sqlText: AHS_PREFILL_APPLIANCE_SQL, binds: [so, unit] },
        { sqlText: AHS_PREFILL_PARTS_SQL, binds: [so, so, unit], timeoutMs: AHS_PREFILL_PARTS_TIMEOUT_MS },
      ], signal);
      // Never log returned values (the resolved unit included): service order and status only.
      if (core.status === "rejected") {
        console.warn(`[ahs-prefill] SO=${unit}-${so} status=unavailable (core statement failed)`);
        return { status: "unavailable" };
      }
      const row = core.value[0];
      if (!row) return { status: "not_found" };
      const serviceUnit = resolveServiceUnit(row, unit);
      if (!serviceUnit) {
        console.warn(`[ahs-prefill] SO=${unit}-${so} status=not_found (order under several units, none the district)`);
        return { status: "not_found" };
      }
      if (serviceUnit !== unit.padStart(7, "0")) {
        console.info(`[ahs-prefill] SO=${unit}-${so} order is under another unit than the district; using that unit`);
      }
      const found: AhsPrefillLookupResult = {
        status: "found",
        brand: text(row.BRAND),
        partnerId: text(row.PARTNER_ID),
        clientName: text(row.CLIENT_NAME),
        serviceUnit,
      };
      if (appliance.status === "rejected") {
        // Most likely a column-name mismatch; the message names the column.
        const message = String((appliance.reason as any)?.message ?? appliance.reason).slice(0, 200);
        console.warn(`[ahs-prefill] SO=${unit}-${so} appliance statement failed, brand only: ${message}`);
      } else {
        const extra = appliance.value[0];
        if (extra && normalizeServiceUnit(extra.SERVICE_UNIT) === serviceUnit) {
          found.serviceContractId = text(extra.SERVICE_CONTRACT_ID);
          found.modelNumber = text(extra.MODEL_NUMBER);
          found.serialNumber = text(extra.SERIAL_NUMBER);
        }
      }
      if (parts?.status === "fulfilled") {
        const mapped = mapAhsServiceOrderParts(
          parts.value.filter((part) => normalizeServiceUnit(part?.SERVICE_UNIT) === serviceUnit),
        );
        if (mapped.length) found.parts = mapped;
      } else if (parts?.status === "rejected") {
        // Message only (a column or timeout); never the returned values.
        const message = String((parts.reason as any)?.message ?? parts.reason).slice(0, 200);
        console.warn(`[ahs-prefill] SO=${unit}-${so} parts statement failed, no parts: ${message}`);
      }
      return found;
    });
  };
}

// ===========================================================================
// Appliance type from the service order (GET /api/tech/lookup-warranty)
// ===========================================================================
//
// HS_SP_CD (the product code, e.g. "Washer", "HVAC"; confirmed in use by
// ai-agent-mcp service_order_tools.py) mapped to the tech form's appliance
// type by divisionFromServiceOrderProduct. Its own statement and its own
// bounded lookup, never part of the ProcID statement: a failure here can
// never touch warranty detection or submit. The unit: the district's order,
// else the most recent order even when the SO spans several units (the
// product is not PII; the AHS prefill stays strict). The raw HS_SP_CD value
// (non-PII) leaves this module as `product`, the fallback the tech form shows under Appliance Type when WOM has no
// product category (server/services/wom-work-order.ts), with the resolved
// unit the WOM lookup uses. Neither is ever logged.

// Binds: [serviceOrder, district]. The district's order, else the most
// recent one; UNIT_COUNT is for the log only.
export const SERVICE_ORDER_APPLIANCE_SQL =
  `SELECT ${SERVICE_UNIT_SELECT}, HS_SP_CD AS PRODUCT FROM ${SERVICE_ORDER_TABLE} ${SO_MATCH_DISTRICT_THEN_RECENT}`;
// The statement before the SO_CRT_DT ordering, run only when
// SERVICE_ORDER_APPLIANCE_SQL fails; its row is arbitrary among several
// units, so it keeps the strict rule (resolveServiceUnit). Binds:
// [serviceOrder, district].
export const SERVICE_ORDER_APPLIANCE_FALLBACK_SQL =
  `SELECT ${SERVICE_UNIT_SELECT}, HS_SP_CD AS PRODUCT FROM ${SERVICE_ORDER_TABLE} ${SO_MATCH_PREFER_DISTRICT}`;

export type ApplianceUnitPick = "district" | "single" | "recent";

// The unit of SERVICE_ORDER_APPLIANCE_SQL's row and why it won: the
// district's, the SO's only unit, or the most recent of several. Undefined
// when the row has no usable unit.
export function pickApplianceServiceUnit(
  row: any,
  district: string,
): { serviceUnit: string; pick: ApplianceUnitPick } | undefined {
  const serviceUnit = normalizeServiceUnit(row?.SERVICE_UNIT);
  if (!serviceUnit) return undefined;
  if (serviceUnit === district.padStart(7, "0")) return { serviceUnit, pick: "district" };
  return { serviceUnit, pick: Number(row?.UNIT_COUNT) === 1 ? "single" : "recent" };
}

export type ServiceOrderApplianceResult =
  // applianceType is absent when the product does not map to a division;
  // product (the raw HS_SP_CD, trimmed) when it is blank. serviceUnit is the
  // resolved SVC_UN_NO, e.g. "0008366".
  | { status: "found"; applianceType?: ApplianceDivision; product?: string; serviceUnit?: string }
  | { status: "not_found" }
  | { status: "unavailable" };

export type ServiceOrderApplianceQuery = LookupStatementQuery;

// For a "DDDD-SSSSSSSS" service order. Never rejects; bounded by the
// lookup's deadline (the same default as the ProcID lookup), coalesced and
// cached like the others.
export function createServiceOrderApplianceLookup(query: ServiceOrderApplianceQuery, options: LookupOptions = {}) {
  const lookup = createBoundedLookup<ServiceOrderApplianceResult>(
    () => ({ status: "unavailable" }),
    (result, ttl) => result.status === "found" ? ttl.positiveMs
      : result.status === "not_found" ? ttl.negativeMs : ttl.unavailableMs,
    options,
  );
  return (serviceOrder: string): Promise<ServiceOrderApplianceResult> => {
    const match = /^(\d{4})-(\d{8})$/.exec(String(serviceOrder ?? "").trim());
    // Never query with input the form could not have produced.
    if (!match) return Promise.resolve({ status: "not_found" });
    const [, district, so] = match;
    return lookup(`${district}-${so}`, async (signal) => {
      let result: ServiceOrderApplianceResult;
      let units = 0;
      let pick: ApplianceUnitPick | "none" = "none";
      try {
        const { rows, fallback } = await withFallbackStatement(
          query,
          { sqlText: SERVICE_ORDER_APPLIANCE_SQL, binds: [so, district] },
          { sqlText: SERVICE_ORDER_APPLIANCE_FALLBACK_SQL, binds: [so, district] },
          signal,
          `[appliance-type] SO=${district}-${so}`,
        );
        const row = rows[0];
        units = Number(row?.UNIT_COUNT) || 0;
        const picked = row ? pickApplianceServiceUnit(row, district) : undefined;
        // The unordered fallback's row is arbitrary: strict rule there.
        const chosen = picked && !(fallback && picked.pick === "recent") ? picked : undefined;
        if (!chosen) {
          result = { status: "not_found" };
        } else {
          pick = chosen.pick;
          const product = text(row.PRODUCT);
          const applianceType = divisionFromServiceOrderProduct(product);
          result = {
            status: "found",
            ...(applianceType ? { applianceType } : {}),
            ...(product ? { product } : {}),
            serviceUnit: chosen.serviceUnit,
          };
        }
      } catch {
        result = { status: "unavailable" };
      }
      // The SO, the unit count, the pick and the division only; never
      // HS_SP_CD's value or the unit.
      const division = result.status === "found" ? result.applianceType ?? "unknown" : "none";
      console.info(`[appliance-type] SO=${district}-${so} status=${result.status} units=${units} pick=${pick} division=${division}`);
      return result;
    });
  };
}

// ===========================================================================
// Repair / replace calculator prefill (server/repair-replace-prefill.ts)
// ===========================================================================
//
// Three statements on one connection, each settling on its own, with the
// unit resolved as for the AHS prefill (district first, else the order's
// only unit). Columns from the ai-agent-vrs calculator handoff (2026-10-27),
// where each was read on live orders with role ANALYST_BUSINESS2; VRS
// Express runs without a role, so scripts/diagnostics/ahs-prefill-check.mts
// checks they answer here too. A failing TechHub or parts statement only
// loses its own fields.

// Binds: [serviceOrder, district].
export const REPAIR_REPLACE_ORDER_SQL =
  `SELECT ${SERVICE_UNIT_SELECT}, MDS_CD, AP_PCHS_DATE, SL_DT, JOB_CD_DS ` +
  `FROM ${SERVICE_ORDER_TABLE} ${SO_MATCH_PREFER_DISTRICT}`;

export const REPAIR_REPLACE_TECHHUB_FIELDS = ["applianceAssessment", "deLabor", "deTripCharge"] as const;

// TechHub form values (the table behind ai-agent-mcp ApplianceAssessmentTools).
// Binds: [serviceOrder, serviceOrder, district].
export const REPAIR_REPLACE_TECHHUB_SQL =
  "SELECT SVC_UN_NO AS SERVICE_UNIT, CRT_TS, UDF_FLD_NM, UDF_FLD_VAL_TX FROM PRD_DB2.HS_DW_VIEWS.NPSXTFS " +
  `WHERE SO_NO = ? AND SVC_UN_NO = (SELECT SVC_UN_NO FROM ${SERVICE_ORDER_TABLE} ${SO_MATCH_PREFER_DISTRICT}) ` +
  `AND UDF_FLD_NM IN (${REPAIR_REPLACE_TECHHUB_FIELDS.map((name) => `'${name}'`).join(", ")}) ` +
  "ORDER BY CRT_TS DESC LIMIT 200";

// Part lines with status, quantity and selling price. Binds: [serviceOrder,
// serviceOrder, district].
export const REPAIR_REPLACE_PARTS_SQL =
  "SELECT SVC_UN_NO AS SERVICE_UNIT, SVC_PRT_STS_CD, SVC_PRT_QT, PRT_SEL_PRC_AM FROM PRD_DB2.HS_DW_TBLS.NPSXTPN " +
  `WHERE SO_NO = ? AND SVC_UN_NO = (SELECT SVC_UN_NO FROM ${SERVICE_ORDER_TABLE} ${SO_MATCH_PREFER_DISTRICT}) ` +
  "ORDER BY PRT_SEQ_NO LIMIT 100";

export const REPAIR_REPLACE_SECONDARY_TIMEOUT_MS = 6000;

export type RepairReplaceLookupResult =
  | { status: "found"; row: Record<string, unknown>; techhub: Record<string, unknown>[] | null; parts: Record<string, unknown>[] | null }
  | { status: "not_found" }
  | { status: "unavailable" };

export function createRepairReplaceLookup(query: AhsPrefillQuery, options: LookupOptions = {}) {
  const lookup = createBoundedLookup<RepairReplaceLookupResult>(
    () => ({ status: "unavailable" }),
    (result, ttl) => result.status === "found" ? ttl.positiveMs
      : result.status === "not_found" ? ttl.negativeMs : ttl.unavailableMs,
    // Estimates change during the day: keep a found order for 5 minutes.
    { deadlineMs: 8000, positiveMs: 300000, ...options },
  );
  return (district: string, serviceOrder: string): Promise<RepairReplaceLookupResult> => {
    const unit = String(district ?? "").trim();
    const so = String(serviceOrder ?? "").trim();
    if (!/^\d{4}$/.test(unit) || !/^\d{8}$/.test(so)) return Promise.resolve({ status: "not_found" });
    return lookup(`${unit}-${so}`, async (signal) => {
      const [order, techhub, parts] = await query([
        { sqlText: REPAIR_REPLACE_ORDER_SQL, binds: [so, unit] },
        { sqlText: REPAIR_REPLACE_TECHHUB_SQL, binds: [so, so, unit], timeoutMs: REPAIR_REPLACE_SECONDARY_TIMEOUT_MS },
        { sqlText: REPAIR_REPLACE_PARTS_SQL, binds: [so, so, unit], timeoutMs: REPAIR_REPLACE_SECONDARY_TIMEOUT_MS },
      ], signal);
      // Service order and statuses only; never values.
      const failure = (settled: PromiseSettledResult<any[]>) =>
        settled.status === "rejected" ? String((settled.reason as any)?.message ?? settled.reason).split("\n")[0].slice(0, 200) : "";
      if (order.status === "rejected") {
        console.warn(`[repair-replace] SO=${unit}-${so} status=unavailable (order statement failed: ${failure(order)})`);
        return { status: "unavailable" };
      }
      const row = order.value[0];
      if (!row) return { status: "not_found" };
      const serviceUnit = resolveServiceUnit(row, unit);
      if (!serviceUnit) {
        console.warn(`[repair-replace] SO=${unit}-${so} status=not_found (order under several units, none the district)`);
        return { status: "not_found" };
      }
      const underUnit = (settled: PromiseSettledResult<any[]>, name: string) => {
        if (settled.status === "rejected") {
          console.warn(`[repair-replace] SO=${unit}-${so} ${name} statement failed: ${failure(settled)}`);
          return null;
        }
        return settled.value.filter((item) => normalizeServiceUnit(item?.SERVICE_UNIT) === serviceUnit);
      };
      const result: RepairReplaceLookupResult = {
        status: "found",
        row,
        techhub: underUnit(techhub, "techhub"),
        parts: underUnit(parts, "parts"),
      };
      console.info(`[repair-replace] SO=${unit}-${so} status=found techhub_rows=${result.techhub?.length ?? "failed"} part_rows=${result.parts?.length ?? "failed"}`);
      return result;
    });
  };
}
