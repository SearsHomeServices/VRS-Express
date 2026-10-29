// Service-order prefill for the repair / replace calculator
// (shared/repair-replace.ts), ported from ai-agent-vrs
// src/core/repair_replace/prefill.py. The mapping is pure: pass the service
// order's row, TechHub rows and part lines, get a contract the manager can
// always finish by hand. A failed lookup stays a failed lookup: it is not
// "parts unavailable", not a failed attempt and not history.
//
// Sources, and only these (each checked against live orders in the Python
// handoff, 2026-10-27):
//   MDS_CD -> appliance_type, only washer / refrigerator / dishwasher / range
//   AP_PCHS_DATE, else the HSSOM purchase date, else SL_DT, to today -> age_years
//   TechHub (NPSXTFS) deLabor, latest submission, summed when positive -> labor_cost
//   TechHub deTripCharge, latest submission, when positive -> trip_cost
//   TechHub applianceAssessment repair confidence 4-5 / 1-2 -> technician_confident
//   NPSXTPN selling prices of lines not cancelled, voided or returned -> parts_cost
//   NPSXTPN: a line installed or fulfilled -> parts_available = true (never false)
// VRS Express adds (2026-10-28):
//   NPSXTPN type 'L' lines (labor coded as a part) -> labor_cost when TechHub
//     and WOM have none; they are not counted as parts
//   WOM work order (server/services/wom-repair-facts.ts) -> visit_number,
//     unresolved, failed_attempt_count; labor_cost and trip_cost after TechHub
//   CC_LAB_NET -> trip_cost, last (it equals the trip charge on ~94% of orders)
//   same model + serial in the last 365 days (REPAIR_REPLACE_HISTORY_SQL) ->
//     other_service_orders_12mo (not cancelled), same_part_or_system_repeat
//     (true when an installed part number repeats; false only with no other order)
//   the technician's account (1099 provider company or not) -> servicer_type
// The HSSOM Order Lookup (SOM, server/services/hssom-order-lookup.ts
// repairFactsFromOrder), ahead of TechHub and Snowflake (2026-10-29):
//   parts[] price x quantity, lines not cancelled, voided or returned -> parts_cost
//   jobCodes[].chargeAmount, summed, without service-call codes -> labor_cost
//   estimate.tripCharge -> trip_cost; estimate.partsTaxPerc -> tax_rate
//   serviceInfo.attemptCount -> visit_number
//   providerId (W2 = Sears employed) -> servicer_type, ahead of the account
// VRS Express adds what the technician entered on the ticket
// (submissions.appliance_kind and tech_appliance_details):
//   the appliance they picked -> appliance_type, when MDS_CD is not one of the four
//   the age they entered (asked the customer) -> age_years, ahead of every date
//   their grade (Low / Medium / High) and appliance -> appliance_reference,
//     the legacy catalog row, where the grade names exactly one
//
// Not used, on purpose: CC_LAB_NET (equals the trip charge on ~94% of
// orders, not labor), JOB_CD_DS (the billed job code, not the failed
// component; surfaced as a warning), totNumVisits, N_ATP, SO_STS_CD.
//
// Nothing here is customer data. Logs carry the service order and statuses.
import {
  RR_PREFILL_FIELDS,
  cents,
  money,
  normalizeRrAppliance,
  roundHalfUp,
  rrNumber,
  type RrAppliance,
  type RrPrefillField,
  type RrPrefillFieldName,
  type RrPrefillResponse,
} from "@shared/repair-replace";
import { techApplianceGradeLabel, type TechApplianceDetails } from "@shared/tech-appliance-details";
import type { HssomRepairFacts } from "./services/hssom-order-lookup";

// A located row is "found" only when every one of these was filled.
export const RR_AUTHORITATIVE_FIELDS: RrPrefillFieldName[] = ["appliance_type", "age_years", "labor_cost"];
const MANUAL = "Unmapped fields stay blank so they can be entered manually.";
const LOOKUP_FAILED = [
  "Service-order lookup is unavailable. Enter the visit manually.",
  "A failed lookup is not parts-unavailable and is not a failed attempt.",
];

type Row = Record<string, unknown>;

// Mirrors WomRepairFacts (server/services/wom-repair-facts.ts).
export interface RrWomFacts {
  visitNumber?: number;
  unresolved?: boolean;
  failedAttemptCount?: number;
  tripCharge?: number;
  laborTotal?: number;
  laborLineCount?: number;
  observedAt?: string;
}

export interface RrPrefillInput {
  serviceOrder: string;
  // The service order's FULLDETAIL row; null when there is none.
  row: Row | null;
  // NPSXTFS rows (CRT_TS, UDF_FLD_NM, UDF_FLD_VAL_TX); null when that
  // statement failed or did not run.
  techhub?: Row[] | null;
  // NPSXTPN rows (SVC_PRT_STS_CD, SVC_PRT_QT, PRT_SEL_PRC_AM); same.
  parts?: Row[] | null;
  unavailable?: boolean;
  // submissions.appliance_kind, the technician's pick.
  ticketApplianceKind?: string | null;
  // submissions.tech_appliance_details (grade, age in years).
  techDetails?: TechApplianceDetails | null;
  // The HSSOM Order Lookup's purchase date (YYYY-MM-DD), when it had one.
  hssomPurchaseDate?: string | null;
  // What the HSSOM Order Lookup says about the repair (numbers and codes).
  hssom?: HssomRepairFacts | null;
  // REPAIR_REPLACE_HISTORY_SQL rows; null when that statement failed.
  history?: Row[] | null;
  // What the WOM work order proves (server/services/wom-repair-facts.ts).
  wom?: RrWomFacts | null;
  // The submitting technician's account: "1099" for a 1099 provider company.
  servicerType?: "Sears Tech" | "1099" | null;
  // Reference date for age (YYYY-MM-DD); defaults to today (UTC).
  asOf?: string;
}

function contract(
  serviceOrder: string,
  status: RrPrefillResponse["status"],
  fields: RrPrefillResponse["fields"],
  warnings: string[],
): RrPrefillResponse {
  return {
    service_order: serviceOrder,
    status,
    manual_fallback: true,
    fields,
    missing_fields: RR_PREFILL_FIELDS.filter((name) => !(name in fields)),
    warnings: [...warnings],
  };
}

// Column lookup that ignores case (the SDK returns upper case; fixtures may not).
function cell(row: Row, column: string): unknown {
  const target = column.toLowerCase();
  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function present(value: unknown): boolean {
  if (value == null || typeof value === "boolean") return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

function short(value: unknown): string {
  const text = String(value).trim().replace(/\n/g, " ");
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function fold(value: unknown): string {
  if (!present(value)) return "";
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const CANONICAL = new Set<string>(["washer", "refrigerator", "dishwasher", "range"]);
const EXACT_ALIASES = new Set([
  "washer", "refrigerator", "dishwasher", "range", "fridge", "icebox",
  "clothes washer", "washing machine", "dish washer", "stove", "oven range",
]);

// MDS_CD -> one of the four, or undefined. Live codes are compact (WASHERFL,
// REFRIGBF, DISHWASHBI, RANGEEG, OVENBI), sometimes prefixed (LWRANGE) or
// suffixed (OVENBI1YR5). Range hoods (RANGEHOOD, RANGEHOD, RANGEHBLW),
// oven/microwave combos and cooktops are left unmapped: the policy prices a
// full range only.
export function applianceFromMds(value: unknown): RrAppliance | undefined {
  const folded = fold(value);
  if (!folded) return undefined;
  if (EXACT_ALIASES.has(folded)) {
    const canonical = normalizeRrAppliance(folded);
    if (canonical && CANONICAL.has(canonical)) return canonical as RrAppliance;
  }
  if (folded.includes("range hood") || (folded.includes("microwave") && folded.includes("range"))) return undefined;
  if (folded.includes("dishwasher") || folded.includes("dish washer")) return "dishwasher";
  if (folded.includes("refrigerator") || folded.includes("fridge") || folded.includes("icebox")) return "refrigerator";
  const compact = folded.replace(/ /g, "");
  if (compact.startsWith("dishwash")) return "dishwasher";
  if (compact.startsWith("refrig")) return "refrigerator";
  if (compact.startsWith("washer")) return "washer";
  if (compact.includes("rangeh")) return undefined;
  if (compact.includes("cooktop")) return undefined;
  if (compact.includes("mwave") || (compact.includes("oven") && compact.includes("mw"))) return undefined;
  if (compact.includes("oven") || compact.includes("range")) return "range";
  const words = new Set(folded.split(" "));
  if ((words.has("range") || words.has("stove")) && !words.has("hood")) return "range";
  if (words.has("washer") && !words.has("dish")) return "washer";
  return undefined;
}

// The ticket's appliance kind (shared/appliance-types.ts) when it is one of
// the four exactly; oven_combo, cooktop and the rest are not guessed.
function applianceFromTicketKind(kind: string | null | undefined): RrAppliance | undefined {
  return kind === "washer" || kind === "refrigerator" || kind === "dishwasher" || kind === "range" ? kind : undefined;
}

function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0, 10);
}

// A date column as YYYY-MM-DD, or undefined when unreadable. The SDK
// returns DATE as a Date at UTC midnight.
function asDate(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(text);
  if (match) return isoDate(+match[1], +match[2], +match[3]);
  match = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(text) ?? /^(\d{2})-(\d{2})-(\d{4})/.exec(text);
  if (match) return isoDate(+match[3], +match[1], +match[2]);
  match = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(text);
  if (match) return isoDate(+match[1], +match[2], +match[3]);
  return undefined;
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function ageFromDate(
  start: string,
  source: "snowflake" | "hssom",
  label: string,
  fields: RrPrefillResponse["fields"],
  warnings: string[],
  asOf: string,
): void {
  const days = dayNumber(asOf) - dayNumber(start);
  if (days < 0) {
    warnings.push(`${label} is after the lookup date, so age was not filled.`);
    return;
  }
  fields.age_years = {
    value: roundHalfUp(days / 365.25, 2).toFixed(2),
    source,
    source_field: `${label} relative to the lookup date`,
    observed_at: asOf,
  };
}

function mapAge(
  row: Row,
  fields: RrPrefillResponse["fields"],
  warnings: string[],
  asOf: string,
  hssomPurchaseDate: string | undefined,
): void {
  const purchaseRaw = cell(row, "AP_PCHS_DATE");
  const saleRaw = cell(row, "SL_DT");
  const purchase = present(purchaseRaw) ? asDate(purchaseRaw) : undefined;
  const sale = present(saleRaw) ? asDate(saleRaw) : undefined;
  if (present(purchaseRaw) && !purchase) {
    warnings.push("AP_PCHS_DATE could not be read, so age was not filled.");
    return;
  }
  if (purchase) return ageFromDate(purchase, "snowflake", "AP_PCHS_DATE", fields, warnings, asOf);
  if (hssomPurchaseDate) return ageFromDate(hssomPurchaseDate, "hssom", "HSSOM purchase date", fields, warnings, asOf);
  if (present(saleRaw) && !sale) {
    warnings.push("SL_DT could not be read, so age was not filled.");
    return;
  }
  if (sale) ageFromDate(sale, "snowflake", "SL_DT", fields, warnings, asOf);
}

function asTimestamp(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime();
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    // A timestamp without a zone is read as UTC so it compares the same everywhere.
    const parsed = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function observedAt(value: unknown, at: number): string {
  return typeof value === "string" ? value.trim() : new Date(at).toISOString();
}

// Distinct values of one TechHub field from its latest submission. TechHub
// writes some lines twice in one submission; earlier submissions are
// replaced, not added to.
function latestSubmission(techhub: Row[], name: string): { at?: string; values: string[] } {
  const stamped: Array<{ at: number; raw: unknown; value: string }> = [];
  for (const row of techhub) {
    if (!row || typeof row !== "object" || String(cell(row, "UDF_FLD_NM") ?? "") !== name) continue;
    const value = cell(row, "UDF_FLD_VAL_TX");
    const raw = cell(row, "CRT_TS");
    const at = asTimestamp(raw);
    if (at === undefined || !present(value)) continue;
    stamped.push({ at, raw, value: String(value).trim() });
  }
  if (!stamped.length) return { values: [] };
  const latest = Math.max(...stamped.map((item) => item.at));
  const values: string[] = [];
  let raw: unknown;
  for (const item of stamped) {
    if (item.at !== latest) continue;
    raw ??= item.raw;
    if (!values.includes(item.value)) values.push(item.value);
  }
  return { at: observedAt(raw, latest), values };
}

function mapLabor(techhub: Row[], fields: RrPrefillResponse["fields"], warnings: string[]): void {
  const { at, values } = latestSubmission(techhub, "deLabor");
  if (!values.length) return;
  let total = 0;
  for (const line of values) {
    // "84100~CC~344.95": job code, coverage, amount.
    const amount = rrNumber(line.split("~")[2]);
    if (amount == null || amount < 0) {
      warnings.push("A TechHub deLabor line could not be read, so labor_cost was not filled.");
      return;
    }
    total += amount;
  }
  if (cents(total) <= 0) {
    warnings.push("The technician's labor estimate is $0.00 to the customer (covered), so labor_cost was not filled.");
    return;
  }
  fields.labor_cost = {
    value: money(total),
    source: "snowflake",
    source_field: `TechHub deLabor estimate (${values.length} line${values.length === 1 ? "" : "s"})`,
    observed_at: at,
  };
}

function mapTrip(techhub: Row[], fields: RrPrefillResponse["fields"], warnings: string[]): void {
  const { at, values } = latestSubmission(techhub, "deTripCharge");
  if (!values.length) return;
  if (values.length > 1) {
    warnings.push("TechHub has more than one trip charge on the latest estimate, so trip_cost was not filled.");
    return;
  }
  // "CC~139.00": coverage, amount.
  const amount = rrNumber(values[0].split("~")[1]);
  if (amount == null || cents(amount) <= 0) {
    warnings.push("The TechHub trip charge was not a positive amount, so trip_cost was not filled.");
    return;
  }
  fields.trip_cost = { value: money(amount), source: "snowflake", source_field: "TechHub deTripCharge", observed_at: at };
}

function mapConfidence(techhub: Row[], fields: RrPrefillResponse["fields"], warnings: string[]): void {
  const { at, values } = latestSubmission(techhub, "applianceAssessment");
  if (!values.length) return;
  // "4~4~Well Maintained": condition 1-5, repair confidence 1-5, issue tags.
  // Condition is not market grade and is not used.
  const scoreText = values[0].split("~")[1];
  const score = scoreText !== undefined && /^\s*[+-]?\d+\s*$/.test(scoreText) ? Number(scoreText) : undefined;
  if (score === undefined || score < 1 || score > 5) {
    warnings.push("The TechHub appliance assessment could not be read, so technician_confident was not filled.");
    return;
  }
  if (score === 3) {
    warnings.push("The technician rated repair confidence 3 of 5 (Medium), so technician_confident was left for them to answer.");
    return;
  }
  fields.technician_confident = {
    value: score >= 4,
    source: "snowflake",
    source_field: `TechHub applianceAssessment repair confidence ${score} of 5`,
    observed_at: at,
  };
}

const INACTIVE_PART_STATUSES = new Set(["X", "V", "R"]); // cancelled, voided, returned
const RECEIVED_PART_STATUSES = new Set(["I", "F"]); // installed, fulfilled

function partStatus(row: Row): string {
  return String(cell(row, "SVC_PRT_STS_CD") ?? "").trim().toUpperCase();
}

function partType(row: Row): string {
  return String(cell(row, "SVC_PRT_TYP_CD") ?? "").trim().toUpperCase();
}

// Labor coded as a part (type 'L'), summed; undefined when there is none or
// a line is unreadable.
function laborLines(parts: Row[], warnings: string[]): { total: number; count: number } | undefined {
  const lines = parts.filter((row) => row && typeof row === "object"
    && !INACTIVE_PART_STATUSES.has(partStatus(row)) && partType(row) === "L");
  if (!lines.length) return undefined;
  let total = 0;
  for (const row of lines) {
    const price = rrNumber(cell(row, "PRT_SEL_PRC_AM"));
    const quantity = rrNumber(cell(row, "SVC_PRT_QT"));
    if (price == null || price < 0 || (quantity != null && quantity > 1)) {
      warnings.push("A labor line on the parts table could not be read, so it was not used for labor_cost.");
      return undefined;
    }
    total += price;
  }
  return { total, count: lines.length };
}

function mapParts(parts: Row[], fields: RrPrefillResponse["fields"], warnings: string[]): void {
  const active = parts.filter((row) => row && typeof row === "object"
    && !INACTIVE_PART_STATUSES.has(partStatus(row)) && partType(row) !== "L");
  if (!active.length) return;
  // Only ever true, from a line that arrived. "On order" (O) is not
  // evidence parts are unavailable; false would fire a hard stop.
  if (fields.parts_available) {
    // SOM already said so.
  } else if (active.some((row) => RECEIVED_PART_STATUSES.has(partStatus(row)))) {
    fields.parts_available = {
      value: true,
      source: "snowflake",
      source_field: "NPSXTPN part status (installed or fulfilled)",
    };
  } else {
    const onOrder = active.filter((row) => partStatus(row) === "O").length;
    if (onOrder) {
      warnings.push(
        `${onOrder} part line${onOrder === 1 ? " is" : "s are"} on order but none has arrived yet. That is not evidence `
        + "parts are unavailable, so parts_available was not filled.",
      );
    }
  }
  let total = 0;
  for (const row of active) {
    const quantityRaw = cell(row, "SVC_PRT_QT");
    const quantity = rrNumber(quantityRaw);
    if ((present(quantityRaw) && quantity == null) || (quantity != null && quantity > 1)) {
      // Above 1 was never observed live, so per-unit versus per-line price
      // is unknown; an unreadable quantity is treated the same.
      warnings.push("A part line has a quantity above 1, so parts_cost was not filled.");
      return;
    }
    const price = rrNumber(cell(row, "PRT_SEL_PRC_AM"));
    if (price == null || price < 0) {
      warnings.push("A part line has no readable selling price, so parts_cost was not filled.");
      return;
    }
    total += price;
  }
  if (cents(total) <= 0) return;
  fields.parts_cost = {
    value: money(total),
    source: "snowflake",
    source_field: `NPSXTPN selling price (${active.length} part line${active.length === 1 ? "" : "s"})`,
  };
}

// Job codes that are the service call itself, not repair labor: on QA
// orders "Service Completed" (90300) carried exactly the trip charge.
const SERVICE_CALL_JOB = /service (call|completed)|trip charge|diagnos/i;

function jobLabel(line: HssomRepairFacts["jobCodes"][number]): string {
  return [line.jobCode, line.description].filter(Boolean).join(" ") || "job code";
}

// SOM first: the live order, ahead of TechHub and the warehouse copy.
function mapHssom(som: HssomRepairFacts | null | undefined, fields: RrPrefillResponse["fields"], warnings: string[]): void {
  if (!som) return;
  const field = (value: string | boolean, sourceField: string): RrPrefillField => ({ value, source: "hssom", source_field: sourceField });

  const active = som.parts.filter((line) => !INACTIVE_PART_STATUSES.has(line.status ?? ""));
  if (active.length) {
    let total = 0;
    let readable = true;
    for (const line of active) {
      const quantity = line.quantity ?? 1;
      if (line.price == null || line.price < 0 || !Number.isFinite(quantity) || quantity < 0) {
        readable = false;
        break;
      }
      total += line.price * quantity;
    }
    if (!readable) warnings.push("A SOM part line has no readable price or quantity, so parts_cost was not taken from SOM.");
    else if (cents(total) > 0) {
      fields.parts_cost = field(money(total), `SOM parts, price x quantity (${active.length} line${active.length === 1 ? "" : "s"})`);
    }
    if (active.some((line) => RECEIVED_PART_STATUSES.has(line.status ?? ""))) {
      fields.parts_available = field(true, "SOM part status (installed or fulfilled)");
    }
  }

  const charged = som.jobCodes.filter((line) => line.chargeAmount != null);
  const serviceCall = charged.filter((line) => SERVICE_CALL_JOB.test(line.description ?? ""));
  const repair = charged.filter((line) => !serviceCall.includes(line));
  if (serviceCall.length) {
    warnings.push(`SOM job code${serviceCall.length === 1 ? "" : "s"} ${serviceCall.map(jobLabel).join(", ")} ${serviceCall.length === 1 ? "is" : "are"} the service call, not repair labor, so ${serviceCall.length === 1 ? "it was" : "they were"} left out of labor_cost.`);
  }
  if (repair.length) {
    const total = repair.reduce((sum, line) => sum + (line.chargeAmount as number), 0);
    const detail = repair.map((line) => `${jobLabel(line)} $${money(line.chargeAmount as number)}`).join("; ");
    if (cents(total) > 0) fields.labor_cost = field(money(total), `SOM job codes: ${detail}`.slice(0, 200));
    else warnings.push(`SOM job codes (${detail}) charge $0.00 to the customer (covered), so labor_cost was not taken from SOM.`.slice(0, 300));
  }

  if (som.tripCharge != null && cents(som.tripCharge) > 0) fields.trip_cost = field(money(som.tripCharge), "SOM trip charge");
  if (som.partsTaxRate != null && som.partsTaxRate >= 0 && som.partsTaxRate < 1) {
    fields.tax_rate = field(String(roundHalfUp(som.partsTaxRate, 4)), "SOM parts tax rate");
  }
  if (som.attemptCount != null && Number.isInteger(som.attemptCount) && som.attemptCount >= 1) {
    fields.visit_number = field(String(som.attemptCount), "SOM attempt count on this order (check whether today's visit is in it)");
  }
  if (som.providerId) {
    const sears = som.providerId === "W2";
    fields.servicer_type = field(sears ? "Sears Tech" : "1099", sears ? "SOM provider W2 (Sears technician)" : `SOM provider ${som.providerId} (not W2)`);
  }
}

// WOM: visits on this order; labor and trip only where TechHub had none.
function mapWom(wom: RrWomFacts | null, fields: RrPrefillResponse["fields"]): void {
  if (!wom) return;
  const at = wom.observedAt;
  const field = (value: string | boolean, sourceField: string): RrPrefillField =>
    ({ value, source: "wom", source_field: sourceField, ...(at ? { observed_at: at } : {}) });
  if (!fields.visit_number && Number.isInteger(wom.visitNumber) && wom.visitNumber! >= 1) {
    fields.visit_number = field(String(wom.visitNumber), "WOM work order visits (not cancelled)");
  }
  if (typeof wom.unresolved === "boolean") {
    fields.unresolved = field(wom.unresolved, "WOM status of the previous visit");
  }
  if (Number.isInteger(wom.failedAttemptCount) && wom.failedAttemptCount! >= 0) {
    fields.failed_attempt_count = field(String(wom.failedAttemptCount), "WOM earlier visits marked Incomplete");
  }
  if (!fields.labor_cost && typeof wom.laborTotal === "number" && cents(wom.laborTotal) > 0) {
    const count = wom.laborLineCount ?? 0;
    fields.labor_cost = field(money(wom.laborTotal), `WOM labor job codes${count ? ` (${count} line${count === 1 ? "" : "s"})` : ""}`);
  }
  if (!fields.trip_cost && typeof wom.tripCharge === "number" && cents(wom.tripCharge) > 0) {
    fields.trip_cost = field(money(wom.tripCharge), "WOM trip charge");
  }
}

function mapTripFallback(row: Row, fields: RrPrefillResponse["fields"]): void {
  const amount = rrNumber(cell(row, "CC_LAB_NET"));
  if (amount == null || cents(amount) <= 0) return;
  fields.trip_cost = {
    value: money(amount),
    source: "snowflake",
    source_field: "CC_LAB_NET (matches the trip charge on most orders; confirm)",
  };
}

const CANCELLED_ORDER_STATUS = "CA";

function mapHistory(history: Row[], fields: RrPrefillResponse["fields"], warnings: string[]): void {
  const anchor = history[0];
  if (!anchor) return;
  const usable = cell(anchor, "SERIAL_USABLE");
  if (usable !== true && String(usable).toLowerCase() !== "true") {
    warnings.push("The model or serial on the service order is missing or a placeholder, so the 12-month history was not filled.");
    return;
  }
  const others = new Map<string, number>();
  for (const row of history) {
    const so = cell(row, "H_SO");
    if (!present(so)) continue;
    if (String(cell(row, "H_STATUS") ?? "").trim().toUpperCase() === CANCELLED_ORDER_STATUS) continue;
    const key = `${cell(row, "SERVICE_UNIT")}-${String(so).trim()}`;
    others.set(key, Math.max(others.get(key) ?? 0, rrNumber(cell(row, "SAME_PART_LINES")) ?? 0));
  }
  const count = others.size;
  const capped = history.length >= 60;
  fields.other_service_orders_12mo = {
    value: String(count),
    source: "snowflake",
    source_field: `Other service orders on the same model and serial in the last 12 months${capped ? " (at least)" : ""}`,
  };
  const repeats = [...others.values()].filter((lines) => lines > 0).length;
  if (repeats > 0) {
    fields.same_part_or_system_repeat = {
      value: true,
      source: "snowflake",
      source_field: `A part on this order was installed on ${repeats} earlier order${repeats === 1 ? "" : "s"} for this appliance`,
    };
  } else if (count === 0) {
    fields.same_part_or_system_repeat = {
      value: false,
      source: "snowflake",
      source_field: "No other service order on this appliance in the last 12 months",
    };
  } else {
    warnings.push("Earlier orders on this appliance installed different part numbers. Check whether it is the same system.");
  }
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildRepairReplacePrefill(input: RrPrefillInput): RrPrefillResponse {
  const order = (input.serviceOrder || "").trim();
  if (input.unavailable || (input.row != null && typeof input.row !== "object")) {
    return withTicket(contract(order, "unavailable", {}, LOOKUP_FAILED), input);
  }
  if (input.row == null) {
    return withTicket(
      contract(order, "not_found", {}, ["No service-order row was found. Enter the visit manually."]),
      input,
    );
  }
  const row = input.row;
  const fields: RrPrefillResponse["fields"] = {};
  const warnings = [MANUAL];

  const mds = cell(row, "MDS_CD");
  if (present(mds)) {
    const appliance = applianceFromMds(mds);
    if (appliance) fields.appliance_type = { value: appliance, source: "snowflake", source_field: "MDS_CD" };
    else warnings.push(`MDS_CD '${short(mds)}' is not a washing machine, refrigerator, dishwasher, or stove/oven.`);
  }
  mapAge(row, fields, warnings, input.asOf ?? todayUtc(), input.hssomPurchaseDate ?? undefined);
  const jobCode = cell(row, "JOB_CD_DS");
  if (present(jobCode)) {
    warnings.push(`Billed job code is '${short(jobCode)}'. That is not necessarily the failed component, so component was not filled.`);
  }
  mapHssom(input.hssom, fields, warnings);
  if (!fields.labor_cost) mapLabor(input.techhub ?? [], fields, warnings);
  if (!fields.trip_cost) mapTrip(input.techhub ?? [], fields, warnings);
  mapConfidence(input.techhub ?? [], fields, warnings);
  if (!fields.parts_cost) mapParts(input.parts ?? [], fields, warnings);
  mapWom(input.wom ?? null, fields);
  if (!fields.labor_cost) {
    const lines = laborLines(input.parts ?? [], warnings);
    if (lines && cents(lines.total) > 0) {
      fields.labor_cost = {
        value: money(lines.total),
        source: "snowflake",
        source_field: `NPSXTPN labor lines (${lines.count} line${lines.count === 1 ? "" : "s"}, type L)`,
      };
    }
  }
  if (!fields.trip_cost) mapTripFallback(row, fields);
  if (input.history) mapHistory(input.history, fields, warnings);

  const result = withTicket(contract(order, "partial", fields, warnings), input);
  result.status = RR_AUTHORITATIVE_FIELDS.every((name) => name in result.fields) ? "found" : "partial";
  return result;
}

// The legacy catalog row (APPLIANCE_REPLACEMENT) for the technician's grade
// and appliance. Only where the grade names one row: Medium is a tier of its
// own for refrigerators only, and a washer needs top or front load.
const GRADE_REFERENCES: Record<string, { low?: string; medium?: string; high?: string }> = {
  refrigerator: { low: "Refrigerator Basic", medium: "Refrigerator Mid Level", high: "Refrigerator High End" },
  dishwasher: { low: "Dishwasher Basic", high: "Dishwasher High End" },
  range: { low: "Range Basic", high: "Range High End" },
  cooktop: { low: "Cook Top Basic", high: "Cooktop High End" },
  dryer: { low: "Dryer Basic", high: "Dryer High End" },
  upright_freezer: { low: "Freezer Basic", high: "Freezer High End" },
  chest_freezer: { low: "Freezer Basic", high: "Freezer High End" },
  trash_compactor: { low: "Compactor", medium: "Compactor", high: "Compactor" },
  free_standing_ice_maker: { low: "Ice Maker Free Standing", medium: "Ice Maker Free Standing", high: "Ice Maker Free Standing" },
};

// Big enough that it is not a rounding or "about N years" difference.
const AGE_DISAGREEMENT_YEARS = 2;

// What the technician entered on the ticket: the appliance (when the service
// order's code did not give one), the age (ahead of any date; a date that
// disagrees is a warning) and the catalog row for their grade. Also the
// HSSOM purchase date when there was no service-order row.
function withTicket(result: RrPrefillResponse, input: RrPrefillInput): RrPrefillResponse {
  const fields = { ...result.fields };
  const warnings = [...result.warnings];
  const kind = input.ticketApplianceKind;
  const appliance = applianceFromTicketKind(kind);
  if (!fields.appliance_type && appliance) {
    fields.appliance_type = { value: appliance, source: "ticket", source_field: "Appliance the technician picked" };
  }
  if (input.row == null) {
    mapHssom(input.hssom, fields, warnings);
    mapWom(input.wom ?? null, fields);
  }
  if (!fields.age_years && input.row == null && input.hssomPurchaseDate) {
    ageFromDate(input.hssomPurchaseDate, "hssom", "HSSOM purchase date", fields, warnings, input.asOf ?? todayUtc());
  }
  const tech = input.techDetails;
  const techAge = tech?.applianceAgeYears;
  if (typeof techAge === "number" && Number.isInteger(techAge) && techAge >= 0) {
    const dated = fields.age_years;
    const datedAge = dated ? Number(dated.value) : NaN;
    if (Number.isFinite(datedAge) && Math.abs(datedAge - techAge) >= AGE_DISAGREEMENT_YEARS) {
      warnings.push(
        `The technician entered ${techAge} year${techAge === 1 ? "" : "s"}; ${dated!.source_field.replace(/ relative to the lookup date$/, "")} gives ${dated!.value}. Age uses the technician's.`,
      );
    }
    fields.age_years = { value: String(techAge), source: "ticket", source_field: "Age the technician entered (from the customer)" };
  }
  if (!fields.servicer_type && (input.servicerType === "Sears Tech" || input.servicerType === "1099")) {
    fields.servicer_type = {
      value: input.servicerType,
      source: "ticket",
      source_field: input.servicerType === "1099" ? "Technician's account (1099 provider company)" : "Technician's account (Sears technician)",
    };
  }
  const grade = tech?.applianceGrade;
  if (grade && kind) {
    const reference = GRADE_REFERENCES[kind]?.[grade];
    const gradeLabel = techApplianceGradeLabel(grade) ?? grade;
    if (reference) {
      fields.appliance_reference = {
        value: reference,
        source: "ticket",
        source_field: `Technician's grade (${gradeLabel}) and appliance`,
      };
    } else if (kind === "washer") {
      warnings.push(`The technician graded the washer ${gradeLabel}. Pick the top or front load reference.`);
    } else if (GRADE_REFERENCES[kind]) {
      warnings.push(`The technician graded the appliance ${gradeLabel}, which has no single reference. Pick Basic or High End.`);
    }
  }
  return {
    ...result,
    fields,
    warnings,
    missing_fields: RR_PREFILL_FIELDS.filter((name) => !(name in fields)),
  };
}

// ---------------------------------------------------------------------------
// Lookup orchestration
// ---------------------------------------------------------------------------

export type RepairReplaceSnowflakeResult =
  | { status: "found"; row: Row; techhub: Row[] | null; parts: Row[] | null; history?: Row[] | null }
  | { status: "not_found" }
  | { status: "unavailable" };

// The HSSOM Order Lookup, reduced to the purchase date and the repair facts
// (no customer data). Bounded and never rejects
// (server/services/hssom-order-lookup.ts).
export type RepairReplaceHssomLookup = (
  district: string,
  so: string,
) => Promise<
  | { status: "found"; purchaseDate?: string; repair?: HssomRepairFacts }
  | { status: "not_found" }
  | { status: "unavailable" }
>;

export interface RepairReplaceTicketInput {
  ticketApplianceKind?: string | null;
  techDetails?: TechApplianceDetails | null;
  servicerType?: "Sears Tech" | "1099" | null;
}

// The WOM work-order facts (createWomRepairFactsLookup). Bounded and never
// rejects; unavailable when WOM is not configured.
export type RepairReplaceWomLookup = (
  district: string,
  so: string,
) => Promise<{ status: "found"; facts: RrWomFacts; warnings: string[] } | { status: "not_found" } | { status: "unavailable" }>;

export async function loadRepairReplacePrefill(
  serviceOrder: string,
  ticket: RepairReplaceTicketInput,
  lookup: ((district: string, so: string) => Promise<RepairReplaceSnowflakeResult>) | null,
  hssomLookup: RepairReplaceHssomLookup | null = null,
  womLookup: RepairReplaceWomLookup | null = null,
): Promise<RrPrefillResponse> {
  const { ticketApplianceKind, techDetails, servicerType } = ticket;
  const match = /^(\d{4})-(\d{8})$/.exec((serviceOrder || "").trim());
  if (!lookup || !match) {
    const result = buildRepairReplacePrefill({ serviceOrder, row: null, unavailable: true, ticketApplianceKind, techDetails, servicerType });
    if (!lookup) result.warnings = ["The service-order lookup is off here. Enter the visit manually.", ...result.warnings.slice(LOOKUP_FAILED.length)];
    return result;
  }
  // HSSOM alongside Snowflake.
  const hssomPromise = hssomLookup
    ? hssomLookup(match[1], match[2]).catch(() => ({ status: "unavailable" as const }))
    : Promise.resolve(null);
  const womPromise = womLookup
    ? womLookup(match[1], match[2]).catch(() => ({ status: "unavailable" as const }))
    : Promise.resolve(null);
  let found: RepairReplaceSnowflakeResult;
  try {
    found = await lookup(match[1], match[2]);
  } catch {
    found = { status: "unavailable" };
  }
  const hssom = await hssomPromise;
  const hssomPurchaseDate = hssom?.status === "found" ? hssom.purchaseDate ?? null : null;
  const hssomFacts = hssom?.status === "found" ? hssom.repair ?? null : null;
  const womResult = await womPromise;
  const wom = womResult?.status === "found" ? womResult.facts : null;
  const womWarnings = womResult?.status === "found" ? womResult.warnings : [];
  const shared = { serviceOrder, ticketApplianceKind, techDetails, servicerType, hssomPurchaseDate, hssom: hssomFacts, wom };
  if (found.status !== "found") {
    const result = buildRepairReplacePrefill({ ...shared, row: null, unavailable: found.status === "unavailable" });
    result.warnings.push(...womWarnings);
    return result;
  }
  const result = buildRepairReplacePrefill({
    ...shared, row: found.row, techhub: found.techhub, parts: found.parts, history: found.history ?? null,
  });
  result.warnings.push(...womWarnings);
  if (found.techhub == null) result.warnings.push("TechHub lookup failed, so labor, trip, and confidence were not filled.");
  if (found.parts == null) result.warnings.push("Parts lookup failed, so parts_cost was not filled.");
  if (found.history === null) result.warnings.push("The 12-month history lookup failed, so it was not filled.");
  return result;
}
