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
//   AP_PCHS_DATE, else SL_DT, to today -> age_years
//   TechHub (NPSXTFS) deLabor, latest submission, summed when positive -> labor_cost
//   TechHub deTripCharge, latest submission, when positive -> trip_cost
//   TechHub applianceAssessment repair confidence 4-5 / 1-2 -> technician_confident
//   NPSXTPN selling prices of lines not cancelled, voided or returned -> parts_cost
//   NPSXTPN: a line installed or fulfilled -> parts_available = true (never false)
// VRS Express adds one fallback: the appliance the technician picked on the
// ticket, when the service order's code is not one of the four.
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

// A located row is "found" only when every one of these was filled.
export const RR_AUTHORITATIVE_FIELDS: RrPrefillFieldName[] = ["appliance_type", "age_years", "labor_cost"];
const MANUAL = "Unmapped fields stay blank so they can be entered manually.";
const LOOKUP_FAILED = [
  "Service-order lookup is unavailable. Enter the visit manually.",
  "A failed lookup is not parts-unavailable and is not a failed attempt.",
];

type Row = Record<string, unknown>;

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

function mapAge(row: Row, fields: RrPrefillResponse["fields"], warnings: string[], asOf: string): void {
  const purchaseRaw = cell(row, "AP_PCHS_DATE");
  const saleRaw = cell(row, "SL_DT");
  const purchase = present(purchaseRaw) ? asDate(purchaseRaw) : undefined;
  const sale = present(saleRaw) ? asDate(saleRaw) : undefined;
  if (present(purchaseRaw) && !purchase) {
    warnings.push("AP_PCHS_DATE could not be read, so age was not filled.");
    return;
  }
  if (!purchase && present(saleRaw) && !sale) {
    warnings.push("SL_DT could not be read, so age was not filled.");
    return;
  }
  const start = purchase ?? sale;
  const source = purchase ? "AP_PCHS_DATE" : "SL_DT";
  if (!start) return;
  const days = dayNumber(asOf) - dayNumber(start);
  if (days < 0) {
    warnings.push(`${source} is after the lookup date, so age was not filled.`);
    return;
  }
  fields.age_years = {
    value: roundHalfUp(days / 365.25, 2).toFixed(2),
    source: "snowflake",
    source_field: `${source} relative to the lookup date`,
    observed_at: asOf,
  };
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

function mapParts(parts: Row[], fields: RrPrefillResponse["fields"], warnings: string[]): void {
  const active = parts.filter((row) => row && typeof row === "object" && !INACTIVE_PART_STATUSES.has(partStatus(row)));
  if (!active.length) return;
  // Only ever true, from a line that arrived. "On order" (O) is not
  // evidence parts are unavailable; false would fire a hard stop.
  if (active.some((row) => RECEIVED_PART_STATUSES.has(partStatus(row)))) {
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

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildRepairReplacePrefill(input: RrPrefillInput): RrPrefillResponse {
  const order = (input.serviceOrder || "").trim();
  if (input.unavailable || (input.row != null && typeof input.row !== "object")) {
    return withTicketAppliance(contract(order, "unavailable", {}, LOOKUP_FAILED), input.ticketApplianceKind);
  }
  if (input.row == null) {
    return withTicketAppliance(
      contract(order, "not_found", {}, ["No service-order row was found. Enter the visit manually."]),
      input.ticketApplianceKind,
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
  mapAge(row, fields, warnings, input.asOf ?? todayUtc());
  const jobCode = cell(row, "JOB_CD_DS");
  if (present(jobCode)) {
    warnings.push(`Billed job code is '${short(jobCode)}'. That is not necessarily the failed component, so component was not filled.`);
  }
  mapLabor(input.techhub ?? [], fields, warnings);
  mapTrip(input.techhub ?? [], fields, warnings);
  mapConfidence(input.techhub ?? [], fields, warnings);
  mapParts(input.parts ?? [], fields, warnings);

  const result = withTicketAppliance(contract(order, "partial", fields, warnings), input.ticketApplianceKind);
  result.status = RR_AUTHORITATIVE_FIELDS.every((name) => name in result.fields) ? "found" : "partial";
  return result;
}

// Fills appliance_type from the ticket when the service order did not.
function withTicketAppliance(result: RrPrefillResponse, kind: string | null | undefined): RrPrefillResponse {
  const appliance = applianceFromTicketKind(kind);
  if (result.fields.appliance_type || !appliance) return result;
  const fields = { ...result.fields, appliance_type: { value: appliance, source: "ticket", source_field: "Appliance the technician picked" } as RrPrefillField };
  return { ...result, fields, missing_fields: result.missing_fields.filter((name) => name !== "appliance_type") };
}

// ---------------------------------------------------------------------------
// Lookup orchestration
// ---------------------------------------------------------------------------

export type RepairReplaceSnowflakeResult =
  | { status: "found"; row: Row; techhub: Row[] | null; parts: Row[] | null }
  | { status: "not_found" }
  | { status: "unavailable" };

export async function loadRepairReplacePrefill(
  serviceOrder: string,
  ticketApplianceKind: string | null | undefined,
  lookup: ((district: string, so: string) => Promise<RepairReplaceSnowflakeResult>) | null,
): Promise<RrPrefillResponse> {
  const match = /^(\d{4})-(\d{8})$/.exec((serviceOrder || "").trim());
  if (!lookup || !match) {
    const result = buildRepairReplacePrefill({ serviceOrder, row: null, unavailable: true, ticketApplianceKind });
    if (!lookup) result.warnings = ["The service-order lookup is off here. Enter the visit manually."];
    return result;
  }
  let found: RepairReplaceSnowflakeResult;
  try {
    found = await lookup(match[1], match[2]);
  } catch {
    found = { status: "unavailable" };
  }
  if (found.status !== "found") {
    return buildRepairReplacePrefill({
      serviceOrder, row: null, unavailable: found.status === "unavailable", ticketApplianceKind,
    });
  }
  const result = buildRepairReplacePrefill({
    serviceOrder, row: found.row, techhub: found.techhub, parts: found.parts, ticketApplianceKind,
  });
  if (found.techhub == null) result.warnings.push("TechHub lookup failed, so labor, trip, and confidence were not filled.");
  if (found.parts == null) result.warnings.push("Parts lookup failed, so parts_cost was not filled.");
  return result;
}
