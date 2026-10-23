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

/** ProcID / client name for a service order (warranty classification). */
export function createProcLookup(
  query: (key: string, signal: AbortSignal) => Promise<any[]>,
  options: LookupOptions = {},
) {
  const lookup = createBoundedLookup<ProcIdResult>(
    () => ({ status: "LOOKUP_UNAVAILABLE", retryable: true }),
    (result, ttl) => result.status === "FOUND" ? ttl.positiveMs
      : result.status === "NOT_FOUND" ? ttl.negativeMs : ttl.unavailableMs,
    options,
  );
  return (raw: string): Promise<ProcIdResult> => {
    const key = normalizeServiceOrder(raw);
    return lookup(key, signal => query(key, signal).then((rows): ProcIdResult => rows.length ? {
      status: "FOUND",
      procId: String(rows[0].CMB_THD_PTY_ID ?? "").trim() || "Not Found",
      clientNm: String(rows[0].CLIENT_NM ?? "").trim() || "Not Found",
    } : { status: "NOT_FOUND", procId: "Not Found", clientNm: "Not Found" }));
  };
}

// ===========================================================================
// AHS service-order prefill (shared/ahs-prefill.ts)
// ===========================================================================
//
// Service order numbers are reused across units, so every statement filters
// on the unit as well: district "8175" -> SVC_UN_NO "0008175".
//
// Columns NOT yet verified against the live schema live in
// AHS_PREFILL_UNVERIFIED_COLUMNS and run as their own statement: one wrong
// identifier fails a whole Snowflake statement, and the brand and partner
// columns must still come back when it does. Change a column name there
// only; the aliases keep the row mapping below unchanged.

const AHS_PREFILL_TABLE = "PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL";
const AHS_PREFILL_WHERE = "WHERE SVC_UN_NO = LPAD(?, 7, '0') AND SO_NO = ? LIMIT 1";

// In use elsewhere against this table.
export const AHS_PREFILL_CONFIRMED_COLUMNS = {
  BRAND: "MFG_BND_NM",
  PARTNER_ID: "CMB_THD_PTY_ID", // what deriveWarrantyFromProcId reads at submit today
  CLIENT_NAME: "CLIENT_NM",
} as const;

// VERIFY against INFORMATION_SCHEMA.COLUMNS before enabling the flag.
// Alternatives seen elsewhere: MDL_NO / SRL_NO.
export const AHS_PREFILL_UNVERIFIED_COLUMNS = {
  SERVICE_CONTRACT_ID: "CTA_NO", // AHS dispatch number is the part before "/"
  MODEL_NUMBER: "PSV_ITM_MDL_NO",
  SERIAL_NUMBER: "PSV_MDS_SRL_NO",
} as const;

function selectFrom(columns: Record<string, string>): string {
  const list = Object.entries(columns).map(([alias, column]) => `${column} AS ${alias}`).join(", ");
  return `SELECT ${list} FROM ${AHS_PREFILL_TABLE} ${AHS_PREFILL_WHERE}`;
}

export const AHS_PREFILL_CORE_SQL = selectFrom(AHS_PREFILL_CONFIRMED_COLUMNS);
export const AHS_PREFILL_APPLIANCE_SQL = selectFrom(AHS_PREFILL_UNVERIFIED_COLUMNS);

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

export const AHS_PREFILL_PARTS_SQL =
  `SELECT ${Object.entries(AHS_PREFILL_PARTS_COLUMNS).map(([alias, column]) => `${column} AS ${alias}`).join(", ")} ` +
  "FROM PRD_DB2.HS_DW_TBLS.NPSXTPN WHERE SVC_UN_NO = LPAD(?,7,'0') AND SO_NO = ? " +
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
  // Absent when the parts statement failed or the order has no live parts.
  parts?: AhsServiceOrderPart[];
}

export type AhsPrefillLookupResult =
  | ({ status: "found" } & AhsServiceOrderPrefill)
  | { status: "not_found" }
  | { status: "unavailable" };

export interface AhsPrefillStatement {
  sqlText: string;
  binds: [district: string, serviceOrder: string];
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
        { sqlText: AHS_PREFILL_CORE_SQL, binds: [unit, so] },
        { sqlText: AHS_PREFILL_APPLIANCE_SQL, binds: [unit, so] },
        { sqlText: AHS_PREFILL_PARTS_SQL, binds: [unit, so], timeoutMs: AHS_PREFILL_PARTS_TIMEOUT_MS },
      ], signal);
      // Never log returned values: service order and status only.
      if (core.status === "rejected") {
        console.warn(`[ahs-prefill] SO=${unit}-${so} status=unavailable (core statement failed)`);
        return { status: "unavailable" };
      }
      const row = core.value[0];
      if (!row) return { status: "not_found" };
      const found: AhsPrefillLookupResult = {
        status: "found",
        brand: text(row.BRAND),
        partnerId: text(row.PARTNER_ID),
        clientName: text(row.CLIENT_NAME),
      };
      if (appliance.status === "rejected") {
        // Most likely a column-name mismatch; the message names the column.
        const message = String((appliance.reason as any)?.message ?? appliance.reason).slice(0, 200);
        console.warn(`[ahs-prefill] SO=${unit}-${so} appliance statement failed, brand only: ${message}`);
      } else {
        const extra = appliance.value[0];
        found.serviceContractId = text(extra?.SERVICE_CONTRACT_ID);
        found.modelNumber = text(extra?.MODEL_NUMBER);
        found.serialNumber = text(extra?.SERIAL_NUMBER);
      }
      if (parts?.status === "fulfilled") {
        const mapped = mapAhsServiceOrderParts(parts.value);
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
