// Repair / replace calculator for Sears Protect tickets (Sears Protect Home
// Warranty, Sears Home Warranty, Sears PA / Cinch: warrantyType
// "sears_protect").
//
// Ported from the ai-agent-vrs Python package src/core/repair_replace
// (branch repair-replace-calculator, commit 7fddd80, handoff 2026-10-27),
// which itself recodes the Streamlit calculator VRS Express iframes
// (repairreplacecalculator.replit.app). Two engines, one result shape:
//
//   - "legacy": the Streamlit formulas. Standard and PA 2.0 compare this
//     visit's parts + labor with a replacement value (repair only when the
//     total is strictly lower); the First American and American Home Shield
//     estimators return an estimate. A proc ID containing "Sears Protect Home
//     Warranty" caps replacement at $3,500.
//   - "frc": Forward Repair Cost. Current repair cost plus the expected cost
//     of the next repair, against a share of the replacement cost, plus five
//     hard stops. Policy "illustrative-v1" is NOT approved: its thresholds
//     and multipliers are placeholders from a leadership note.
//
// Neither engine authorizes a replacement (authorizesReplacement is always
// false): "replacement_review" means a person reviews it. Missing inputs stay
// missing (a hard stop is "unknown", never "not_fired"); nothing is treated
// as zero. Pure: no I/O, safe on the client and the server.
//
// Deliberate differences from the Python:
//   - Money is a JS number rounded half-up to cents at each step the Python
//     rounds (cents()), and comparisons are in whole cents.
//   - A non-numeric, non-finite or negative number, and a yes/no answer that
//     is not true/false/"yes"/"no", count as missing instead of raising or
//     being read as truthy.
//   - Two hard-stop sentences read better: "No major component is
//     involved." and "1 service order in 12 months". Routes, amounts and
//     rules are unchanged.

export const RR_APPLIANCES = ["refrigerator", "washer", "dishwasher", "range"] as const;
export type RrAppliance = (typeof RR_APPLIANCES)[number];
export const RR_APPLIANCE_LABELS: Record<RrAppliance, string> = {
  refrigerator: "Refrigerator",
  washer: "Washing machine",
  dishwasher: "Dishwasher",
  range: "Stove/oven",
};

export const RR_MAJOR_COMPONENTS = ["compressor", "transmission", "control board", "sealed system"] as const;
// What the form sends when the tech or manager says no major component is involved.
export const RR_NOT_MAJOR_COMPONENT = "not a major component";

export type RrModel = "frc" | "legacy";
export type RrRoute = "continue_authorization" | "replacement_review" | "manual_review_incomplete";
export type RrHardStopStatus = "fired" | "not_fired" | "unknown";

// Every field the form can send. Strings or numbers for amounts; blank,
// null and absent are all "missing".
export interface RrInput {
  // Forward Repair Cost
  appliance_type?: string | null;
  age_years?: number | string | null;
  replacement_cost?: number | string | null;
  component?: string | null;
  parts_cost?: number | string | null;
  labor_cost?: number | string | null;
  trip_cost?: number | string | null;
  visit_number?: number | string | null;
  unresolved?: boolean | string | null;
  failed_attempt_count?: number | string | null;
  other_service_orders_12mo?: number | string | null;
  same_part_or_system_repeat?: boolean | string | null;
  technician_confident?: boolean | string | null;
  parts_available?: boolean | string | null;
  backorder_days?: number | string | null;
  contract_spend?: number | string | null;
  repeat_probability_override?: number | string | null;
  // Legacy
  calculator_type?: string | null;
  proc_id?: string | null;
  parts?: RrLegacyPart[] | null;
  servicer_type?: string | null;
  repair_hours?: number | string | null;
  labor_category?: string | null;
  tax_rate?: number | string | null;
  include_tax?: boolean | null;
  age_band?: string | null;
  parts_discount_percent?: number | string | null;
  minor_labor_rate?: number | string | null;
  major_labor_rate?: number | string | null;
}

export interface RrLegacyPart {
  cost?: number | string | null;
  sell_price?: number | string | null;
  quantity?: number | string | null;
}

export interface RrHardStop {
  rule: string;
  status: RrHardStopStatus;
  detail: string;
}

export interface RrFactor {
  name: string;
  factor: string;
  applied: boolean;
  reason: string;
}

export interface RrProbability {
  life_used: string | null;
  expected_life_years?: string;
  band: string | null;
  base: string | null;
  raw: string;
  capped: string;
  cap: string;
  override: boolean;
}

export interface RrCosts {
  parts: string | null;
  labor: string | null;
  trip: string | null;
  tax: string;
  current_repair: string | null;
  expected_future: string | null;
  forward_repair: string | null;
  replacement: string | null;
  comparison?: string | null;
  valuation?: string | null;
  threshold_rate: string | null;
  threshold_amount: string | null;
  frc_ratio: string | null;
}

export interface RrResult {
  model: RrModel;
  policy_version: string;
  policy_status: string;
  route: RrRoute;
  // frc: "repair" | "replace" | "unavailable"; legacy: "REPAIR" | "REPLACE" |
  // "unavailable" | "<calculator> - <Minor|Major> Repair" for an estimate.
  economic_outcome: string;
  outcome_kind: string;
  review_required: boolean;
  review_reasons: string[];
  hard_stops: RrHardStop[];
  missing_inputs: string[];
  warnings: string[];
  factors: RrFactor[];
  costs: RrCosts;
  probability: RrProbability | null;
  explanation: string;
  authorizes_replacement: false;
  // Legacy only.
  part_lines?: Array<{ unit_cost: string | null; quantity: string; line_total: string | null }>;
  labor_method?: string | null;
  calculator_type?: string;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

// A finite number, or null for null / blank / boolean / unreadable.
export function rrNumber(value: unknown): number | null {
  if (value == null || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || !NUMBER_TEXT.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nonNegative(value: unknown): number | null {
  const parsed = rrNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

// Whole count >= 0 (Python int()), or null.
function count(value: unknown): number | null {
  const parsed = nonNegative(value);
  return parsed == null ? null : Math.trunc(parsed);
}

// Round half away from zero (Python ROUND_HALF_UP) to `places` decimals.
// toPrecision(15) first so 0.1 + 0.2 style noise does not decide a tie.
export function roundHalfUp(value: number, places: number): number {
  const sign = value < 0 ? -1 : 1;
  const abs = Number(Math.abs(value).toPrecision(15));
  const shifted = String(abs).includes("e") ? abs * 10 ** places : Number(`${abs}e${places}`);
  return (sign * Math.round(shifted)) / 10 ** places;
}

export function cents(value: number): number {
  return roundHalfUp(value, 2);
}

// Whole cents, for comparisons.
function centsInt(value: number): number {
  return Math.round(cents(value) * 100);
}

export function money(value: number): string {
  return cents(value).toFixed(2);
}

function rate(value: number): string {
  return roundHalfUp(value, 6).toFixed(6);
}

// A multiplier as Python prints a Decimal product: no trailing zeros.
function factorText(value: number): string {
  return String(roundHalfUp(value, 10));
}

// yes/no: true, false or null.
export function rrBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "yes") return true;
    if (lowered === "false" || lowered === "no") return false;
  }
  return null;
}

function blank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

// ---------------------------------------------------------------------------
// Forward Repair Cost policy
// ---------------------------------------------------------------------------

export interface FrcPolicy {
  version: string;
  status: "illustrative" | "approved";
  threshold: number;
  thresholdText: string;
  probabilityCap: number;
  probabilityCapText: string;
  // [name, base rate, base rate as printed]. Boundaries: under 50% is
  // < 0.50; 50-80% includes both ends; over 80% is > 0.80.
  bands: { under50: [number, string]; between50And80: [number, string]; over80: [number, string] };
  failedAttemptMultiplier: number;
  otherSoMultiplier: number;
  otherSoMinimum: number;
  samePartMultiplier: number;
  uncertainMultiplier: number;
  expectedLifeYears: Record<RrAppliance, number>;
  averageRepairEventCost: Record<RrAppliance, number>;
  majorComponents: ReadonlySet<string>;
  majorComponentMinAgeYears: number;
  backorderDayLimit: number;
  contractSpendRatio: number;
  contractSpendRatioText: string;
  // "2+ other SOs" excludes the current SO; "3+ SOs within 12 months" counts
  // it, so the hard stop fires at other_count >= 2.
  hardStopOtherSoMinimum: number;
}

export const ILLUSTRATIVE_POLICY: FrcPolicy = {
  version: "illustrative-v1",
  status: "illustrative",
  threshold: 0.7,
  thresholdText: "0.70",
  probabilityCap: 0.95,
  probabilityCapText: "0.95",
  // Point values inside the leadership note's ranges; over 80% uses the
  // example's 50%.
  bands: { under50: [0.125, "0.125"], between50And80: [0.3, "0.30"], over80: [0.5, "0.50"] },
  failedAttemptMultiplier: 1.5,
  otherSoMultiplier: 1.4,
  otherSoMinimum: 2,
  samePartMultiplier: 1.3,
  uncertainMultiplier: 1.2,
  expectedLifeYears: { refrigerator: 13, washer: 11, dishwasher: 10, range: 15 },
  averageRepairEventCost: { washer: 375, refrigerator: 450, dishwasher: 300, range: 350 },
  majorComponents: new Set([
    "compressor", "transmission", "control board", "control_board", "sealed system", "sealed_system",
  ]),
  // Placeholders until approved: component age ("past" = older than), the
  // backorder-day limit ("beyond" = strictly greater) and the contract-spend
  // guardrail.
  majorComponentMinAgeYears: 8,
  backorderDayLimit: 14,
  contractSpendRatio: 0.8,
  contractSpendRatioText: "0.80",
  hardStopOtherSoMinimum: 2,
};

export function rrPolicyNote(policy: FrcPolicy = ILLUSTRATIVE_POLICY): string {
  return policy.status === "approved"
    ? "Approved policy."
    : "Illustrative values are for tests and explicit comparison. They do not authorize production routing.";
}

// "Washing machine" -> "washer", "Stove/oven" -> "range"; anything else
// lowercased with "-" and "/" as spaces.
export function normalizeRrAppliance(name: string | null | undefined): string | null {
  if (name == null) return null;
  const key = name.trim().toLowerCase().replace(/[-/]/g, " ").split(/\s+/).filter(Boolean).join(" ");
  const aliases: Record<string, string> = {
    fridge: "refrigerator",
    icebox: "refrigerator",
    "clothes washer": "washer",
    "washing machine": "washer",
    "dish washer": "dishwasher",
    stove: "range",
    oven: "range",
    "stove oven": "range",
    "oven range": "range",
  };
  return aliases[key] ?? key;
}

function isRrAppliance(key: string | null): key is RrAppliance {
  return key != null && (RR_APPLIANCES as readonly string[]).includes(key);
}

function bandFor(lifeUsed: number, policy: FrcPolicy): [string, number, string] {
  if (lifeUsed > 0.8) return ["over_80", ...policy.bands.over80];
  if (lifeUsed >= 0.5) return ["between_50_and_80", ...policy.bands.between50And80];
  return ["under_50", ...policy.bands.under50];
}

// ---------------------------------------------------------------------------
// Forward Repair Cost
// ---------------------------------------------------------------------------

function hardStop(rule: string, status: RrHardStopStatus, detail: string): RrHardStop {
  return { rule, status, detail };
}

// A number as the form sent it ("11.50" stays "11.50"), as Python prints a Decimal.
function asTyped(raw: unknown, value: number): string {
  return typeof raw === "string" ? raw.trim() : String(value);
}

export function evaluateFrc(data: RrInput, policy: FrcPolicy = ILLUSTRATIVE_POLICY): RrResult {
  const missing: string[] = [];
  const warnings: string[] = [];
  const factors: RrFactor[] = [];

  const parts = nonNegative(data.parts_cost);
  const labor = nonNegative(data.labor_cost);
  const trip = nonNegative(data.trip_cost);
  const replacement = nonNegative(data.replacement_cost);
  const age = nonNegative(data.age_years);
  const contractSpend = nonNegative(data.contract_spend);

  const applianceRaw = typeof data.appliance_type === "string" ? data.appliance_type.trim() : "";
  const applianceKey = applianceRaw ? normalizeRrAppliance(applianceRaw) : null;
  const expectedLife = isRrAppliance(applianceKey) ? policy.expectedLifeYears[applianceKey] : null;
  if (!applianceRaw) {
    missing.push("appliance_type");
  } else if (expectedLife == null) {
    missing.push("expected_life");
    warnings.push(`No expected life is configured for '${applianceRaw}' in ${policy.version}.`);
  }

  for (const [name, value] of [
    ["parts_cost", parts], ["labor_cost", labor], ["trip_cost", trip],
    ["age_years", age], ["replacement_cost", replacement],
  ] as const) {
    if (value == null) missing.push(name);
  }

  const visitNumber = count(data.visit_number);
  const unresolved = rrBool(data.unresolved);
  const failedAttempts = count(data.failed_attempt_count);
  const otherSos = count(data.other_service_orders_12mo);
  const samePart = rrBool(data.same_part_or_system_repeat);
  const confident = rrBool(data.technician_confident);
  const componentRaw = typeof data.component === "string" && data.component.trim() ? data.component.trim() : null;
  const partsAvailable = rrBool(data.parts_available);
  const backorderDays = count(data.backorder_days);

  for (const [name, value] of [
    ["visit_number", visitNumber], ["unresolved", unresolved], ["failed_attempt_count", failedAttempts],
    ["other_service_orders_12mo", otherSos], ["same_part_or_system_repeat", samePart],
    ["technician_confident", confident], ["component", componentRaw], ["parts_available", partsAvailable],
    ["backorder_days", backorderDays], ["contract_spend", contractSpend],
  ] as const) {
    if (value == null) missing.push(name);
  }

  const hardStops: RrHardStop[] = [];

  if (visitNumber == null || unresolved == null) {
    hardStops.push(hardStop("third_unresolved_trip", "unknown", "Visit number and resolution status are both required."));
  } else if (visitNumber >= 3 && unresolved) {
    hardStops.push(hardStop("third_unresolved_trip", "fired", `Visit ${visitNumber} on this service order is unresolved.`));
  } else {
    hardStops.push(hardStop("third_unresolved_trip", "not_fired", "This is not an unresolved third-or-later trip."));
  }

  if (otherSos == null) {
    hardStops.push(hardStop("service_orders_12_months", "unknown",
      "Other service-order count was not supplied. It is not treated as zero."));
  } else if (otherSos >= policy.hardStopOtherSoMinimum) {
    hardStops.push(hardStop("service_orders_12_months", "fired",
      `${otherSos + 1} service orders in 12 months, counting this one (${otherSos} other).`));
  } else {
    hardStops.push(hardStop("service_orders_12_months", "not_fired",
      `${otherSos + 1} service ${otherSos === 0 ? "order" : "orders"} in 12 months, counting this one.`));
  }

  const component = componentRaw ? normalizeRrAppliance(componentRaw) ?? "" : "";
  const isMajor = policy.majorComponents.has(component)
    || policy.majorComponents.has(component.replace(/ /g, "_"))
    || policy.majorComponents.has(component.replace(/_/g, " "));
  if (!componentRaw) {
    hardStops.push(hardStop("major_component_age", "unknown",
      "Component was not supplied, so this rule was not treated as clear."));
  } else if (component === RR_NOT_MAJOR_COMPONENT) {
    hardStops.push(hardStop("major_component_age", "not_fired", "No major component is involved."));
  } else if (!isMajor) {
    hardStops.push(hardStop("major_component_age", "not_fired", `${componentRaw} is not a configured major component.`));
  } else if (age == null) {
    hardStops.push(hardStop("major_component_age", "unknown", "Major component is present, but age was not supplied."));
  } else if (age > policy.majorComponentMinAgeYears) {
    hardStops.push(hardStop("major_component_age", "fired",
      `${componentRaw} at ${asTyped(data.age_years, age)} years is past ${policy.majorComponentMinAgeYears} years.`));
  } else {
    hardStops.push(hardStop("major_component_age", "not_fired",
      `${componentRaw} is not past ${policy.majorComponentMinAgeYears} years.`));
  }

  if (partsAvailable == null && backorderDays == null) {
    hardStops.push(hardStop("parts_unavailable_or_backordered", "unknown",
      "Availability was not supplied. A failed lookup is not treated as unavailable."));
  } else if (partsAvailable === false) {
    hardStops.push(hardStop("parts_unavailable_or_backordered", "fired", "Parts were explicitly marked unavailable."));
  } else if (backorderDays == null) {
    hardStops.push(hardStop("parts_unavailable_or_backordered", "unknown", "Backorder days were not supplied."));
  } else if (backorderDays > policy.backorderDayLimit) {
    hardStops.push(hardStop("parts_unavailable_or_backordered", "fired",
      `Backorder of ${backorderDays} days is beyond ${policy.backorderDayLimit} days.`));
  } else {
    hardStops.push(hardStop("parts_unavailable_or_backordered", "not_fired",
      `Backorder of ${backorderDays} days is within ${policy.backorderDayLimit} days.`));
  }

  if (contractSpend == null || replacement == null) {
    hardStops.push(hardStop("contract_spend", "unknown", "Contract spend and replacement cost are both required."));
  } else {
    const limit = cents(replacement * policy.contractSpendRatio);
    if (centsInt(contractSpend) >= centsInt(limit)) {
      hardStops.push(hardStop("contract_spend", "fired",
        `Contract spend ${money(contractSpend)} is at least ${money(limit)} (${policy.contractSpendRatioText} of replacement).`));
    } else {
      hardStops.push(hardStop("contract_spend", "not_fired",
        `Contract spend ${money(contractSpend)} is under ${money(limit)}.`));
    }
  }

  let probability: RrProbability | null = null;
  const costs: RrCosts = {
    parts: parts != null ? money(parts) : null,
    labor: labor != null ? money(labor) : null,
    trip: trip != null ? money(trip) : null,
    tax: "0.00",
    current_repair: null,
    expected_future: null,
    forward_repair: null,
    replacement: replacement != null ? money(replacement) : null,
    threshold_rate: policy.thresholdText,
    threshold_amount: null,
    frc_ratio: null,
  };

  let ready = [parts, labor, trip, age, replacement, expectedLife].every((value) => value != null)
    && !["failed_attempt_count", "other_service_orders_12mo", "same_part_or_system_repeat",
      "technician_confident", "appliance_type", "expected_life"].some((name) => missing.includes(name));
  const averageCost = isRrAppliance(applianceKey) ? policy.averageRepairEventCost[applianceKey] : null;
  if (averageCost == null) ready = false;

  const override = nonNegative(data.repeat_probability_override);
  let economicReplace: boolean | null = null;
  if (ready || override != null) {
    const current = parts != null && labor != null && trip != null ? cents(parts + labor + trip) : null;
    if (current != null) costs.current_repair = money(current);
    let capped: number | null = null;
    if (override != null) {
      capped = Math.min(policy.probabilityCap, override);
      warnings.push(
        "repeat_probability_override was supplied, so history multipliers were not applied. The general rule is "
        + `×${policy.failedAttemptMultiplier} compounded per failed attempt, which is not the attachment example's ×1.6.`,
      );
      probability = {
        life_used: null, band: null, base: null,
        raw: rate(override), capped: rate(capped), cap: policy.probabilityCapText, override: true,
      };
    } else {
      // ready: every value below is present.
      const lifeUsed = age! / expectedLife!;
      const [bandName, base, baseText] = bandFor(lifeUsed, policy);
      let raw = base;
      factors.push({ name: "base_rate", factor: baseText, applied: true, reason: `${bandName} at ${rate(lifeUsed)} of expected life` });
      const attemptFactor = policy.failedAttemptMultiplier ** failedAttempts!;
      raw *= attemptFactor;
      factors.push({
        name: "failed_attempts", factor: factorText(attemptFactor), applied: failedAttempts! > 0,
        reason: `${failedAttempts} failed attempt(s), compounded at ×${policy.failedAttemptMultiplier} each`,
      });
      const otherApplied = otherSos! >= policy.otherSoMinimum;
      const otherFactor = otherApplied ? policy.otherSoMultiplier : 1;
      raw *= otherFactor;
      factors.push({
        name: "other_service_orders", factor: factorText(otherFactor), applied: otherApplied,
        reason: `${otherSos} other service orders in 12 months; ×${policy.otherSoMultiplier} from ${policy.otherSoMinimum} upward`,
      });
      const sameFactor = samePart ? policy.samePartMultiplier : 1;
      raw *= sameFactor;
      factors.push({
        name: "same_part_or_system", factor: factorText(sameFactor), applied: !!samePart,
        reason: samePart ? "Same part or system is failing again" : "Not a repeat of the same part or system",
      });
      const uncertain = confident === false;
      const uncertainFactor = uncertain ? policy.uncertainMultiplier : 1;
      raw *= uncertainFactor;
      factors.push({
        name: "technician_confidence", factor: factorText(uncertainFactor), applied: uncertain,
        reason: uncertain ? "Technician is not confident in the root cause" : "Technician is confident in the root cause",
      });
      capped = Math.min(policy.probabilityCap, raw);
      probability = {
        life_used: rate(lifeUsed), expected_life_years: String(expectedLife), band: bandName, base: baseText,
        raw: rate(raw), capped: rate(capped), cap: policy.probabilityCapText, override: false,
      };
    }
    if (current != null && capped != null && averageCost != null && replacement != null) {
      const future = cents(capped * averageCost);
      const frc = cents(current + future);
      const thresholdAmount = cents(replacement * policy.threshold);
      costs.expected_future = money(future);
      costs.forward_repair = money(frc);
      costs.threshold_amount = money(thresholdAmount);
      if (centsInt(replacement) !== 0) costs.frc_ratio = rate(frc / replacement);
      economicReplace = centsInt(frc) >= centsInt(thresholdAmount);
    }
  }

  const fired = hardStops.filter((item) => item.status === "fired");
  const unknown = hardStops.filter((item) => item.status === "unknown");
  const reviewReasons = fired.map((item) => item.detail);
  if (economicReplace === true) {
    reviewReasons.push(
      `Forward repair cost ${costs.forward_repair} is at least ${costs.threshold_amount} (${policy.thresholdText} of replacement).`,
    );
  }

  let route: RrRoute;
  let economicOutcome: string;
  let reviewRequired: boolean;
  if (fired.length || economicReplace === true) {
    route = "replacement_review";
    economicOutcome = economicReplace === true ? "replace" : economicReplace === false ? "repair" : "unavailable";
    reviewRequired = true;
  } else if (unknown.length || economicReplace == null) {
    route = "manual_review_incomplete";
    economicOutcome = "unavailable";
    reviewRequired = true;
    if (unknown.length) reviewReasons.push("One or more hard stops could not be evaluated.");
    if (economicReplace == null) reviewReasons.push("Forward repair cost could not be completed from the supplied inputs.");
  } else {
    route = "continue_authorization";
    economicOutcome = "repair";
    reviewRequired = false;
  }

  return {
    model: "frc",
    policy_version: policy.version,
    policy_status: policy.status,
    route,
    economic_outcome: economicOutcome,
    outcome_kind: economicOutcome === "repair" || economicOutcome === "replace" ? "economic" : "incomplete",
    review_required: reviewRequired,
    review_reasons: reviewReasons,
    hard_stops: hardStops,
    missing_inputs: missing,
    warnings,
    factors,
    costs,
    probability,
    explanation: explainFrc(route, costs, probability, fired, missing, policy),
    authorizes_replacement: false,
  };
}

const ROUTE_SENTENCES: Record<RrRoute, string> = {
  continue_authorization: "The completed check says continue authorization.",
  replacement_review: "This routes to replacement review. It does not purchase or authorize a replacement.",
  manual_review_incomplete: "The decision is incomplete and needs a person.",
};

function explainFrc(
  route: RrRoute,
  costs: RrCosts,
  probability: RrProbability | null,
  fired: RrHardStop[],
  missing: string[],
  policy: FrcPolicy,
): string {
  const parts = [`Policy ${policy.version} (${policy.status}).`];
  if (costs.current_repair) {
    parts.push(`Current repair cost is ${costs.current_repair} (parts ${costs.parts}, labor ${costs.labor}, trip ${costs.trip}).`);
  }
  if (probability && costs.expected_future) {
    parts.push(`Repeat probability ${probability.capped} times the average event gives expected future repair cost ${costs.expected_future}.`);
  }
  if (costs.forward_repair) parts.push(`Forward repair cost is ${costs.forward_repair} against ${costs.threshold_amount}.`);
  if (fired.length) parts.push("Hard stops: " + fired.map((item) => item.detail).join("; "));
  if (missing.length && route === "manual_review_incomplete") parts.push("Missing: " + missing.join(", ") + ".");
  parts.push(ROUTE_SENTENCES[route]);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Legacy (Streamlit) formulas
// ---------------------------------------------------------------------------

export const SEARS_TECH_HOURLY = 32;
export const SEARS_TECH_FEE = 27;
export const CONTRACTOR_LABOR: Record<string, number> = {
  "Standard Repair": 55,
  Major: 80,
  "Sealed System": 105,
};
export const RR_SERVICER_TYPES = ["Sears Tech", "1099"] as const;
export const RR_ESTIMATOR_CATEGORIES = ["Minor", "Major"] as const;
export const SHW_MARKER = "Sears Protect Home Warranty";
export const SHW_CAP = 3500;

export const PA20_VALUATION: Record<string, number> = {
  "0 - 2 years": 1.0,
  "3 years": 0.8,
  "4 years": 0.74,
  "5 years": 0.68,
  "6 years": 0.62,
  "7 years": 0.5,
  "8 years": 0.44,
  "9 - 11 years": 0.4,
  "12 - 14 years": 0.3,
  "15+ years": 0.2,
};
export const PA20_AGE_BANDS = Object.keys(PA20_VALUATION);
const PA20_VALUATION_TEXT: Record<string, string> = {
  "0 - 2 years": "1.00", "3 years": "0.80", "4 years": "0.74", "5 years": "0.68", "6 years": "0.62",
  "7 years": "0.50", "8 years": "0.44", "9 - 11 years": "0.40", "12 - 14 years": "0.30", "15+ years": "0.20",
};

interface CalculatorSettings {
  parts_discount_percent: number;
  minor_labor_rate: number;
  major_labor_rate: number;
  include_tax: boolean;
  kind: "binary" | "estimate";
}

export const CALCULATOR_DEFAULTS: Record<string, CalculatorSettings> = {
  Standard: { parts_discount_percent: 0, minor_labor_rate: 0, major_labor_rate: 0, include_tax: false, kind: "binary" },
  "PA 2.0": { parts_discount_percent: 0, minor_labor_rate: 0, major_labor_rate: 0, include_tax: false, kind: "binary" },
  "First American Parts Estimation": {
    parts_discount_percent: 25, minor_labor_rate: 135, major_labor_rate: 325, include_tax: true, kind: "estimate",
  },
  "American Homeshield Parts Estimator": {
    parts_discount_percent: 30, minor_labor_rate: 120, major_labor_rate: 275, include_tax: true, kind: "estimate",
  },
};
export const RR_CALCULATOR_TYPES = Object.keys(CALCULATOR_DEFAULTS);

// Seed replacement costs from the Streamlit appliance table. null means no
// benchmark.
export const APPLIANCE_REPLACEMENT: Record<string, number | null> = {
  "Treadmill/Exercise Bike": 929,
  "Power Tools": 691,
  GDO: 345,
  HVAC: null,
  "Mini-Split": null,
  "Built In Ovens Basic": 1604,
  "Built In Ovens High End": 2644,
  "Built In Ovens W/MWAVE": 1852,
  "Built In Oven Luxury Brand": 5300,
  Compactor: 573,
  "Cook Top Basic": 860,
  "Cooktop High End": 1380,
  "Cooktop Luxury Brand": 2575,
  "Dishwasher Basic": 667,
  "Dishwasher High End": 934,
  "Dishwasher Luxury Brand": 2675,
  "OTR Microwave High End": 667,
  "OTR Microwave Basic": 479,
  "Range Basic": 828,
  "Range High End": 1467,
  "Range Luxury Brand": 5050,
  "Range Hood": 460,
  "Range Hood Luxury Brand": 3975,
  "Dryer Basic": 568,
  "Dryer High End": 834,
  "Washer (Top Load) Basic": 520,
  "Washer (Top Load) High End": 704,
  "Washer (Front Load) Basic": 594,
  "Washer (Front Load) High End": 819,
  "Laundry Center Basic": 855,
  "Laundry Center High End": 1253,
  Dehumidifier: 350,
  "Window A/C 5k BTU": 349,
  "Window A/C 8k BTU": 479,
  "Window A/C 12k BTU": 639,
  "Window A/C 18k BTU": 720,
  "Window A/C 24k BTU": 1030,
  "Water Heater": 1415,
  "Water Softener": 732,
  "Freezer Basic": 531,
  "Freezer High End": 800,
  "Ice Maker Free Standing": 1853,
  "Ref - Built In": 10000,
  "Refrigerator Compact": 439,
  "Refrigerator Basic": 913,
  "Refrigerator Mid Level": 1441,
  "Refrigerator High End": 2276,
  "TV 27-43": 299,
  "TV 50-65": 375,
  "TV 75-85": 569,
  GRILLS: 674,
  Tractor: 1762,
  Pumps: 506,
};

export function legacyCalculatorKind(name: string | null | undefined): "binary" | "estimate" {
  return CALCULATOR_DEFAULTS[name || "Standard"]?.kind ?? "binary";
}

function legacySettings(data: RrInput): CalculatorSettings {
  const name = data.calculator_type || "Standard";
  const base: CalculatorSettings = {
    ...(CALCULATOR_DEFAULTS[name] ?? {
      parts_discount_percent: 0, minor_labor_rate: 0, major_labor_rate: 0, include_tax: false, kind: "binary",
    }),
  };
  for (const key of ["parts_discount_percent", "minor_labor_rate", "major_labor_rate"] as const) {
    const override = rrNumber(data[key]);
    if (override != null) base[key] = override;
  }
  if (data.include_tax != null) base.include_tax = !!data.include_tax;
  if (name !== "Standard" && name !== "PA 2.0" && base.minor_labor_rate > 0 && base.major_labor_rate > 0) {
    base.kind = "estimate";
  }
  return base;
}

function unitCost(part: RrLegacyPart, discount: number, warnings: string[]): number | null {
  const cost = rrNumber(part.cost);
  const sell = rrNumber(part.sell_price);
  if (discount > 0) {
    const noSell = sell == null || sell === 0;
    const price = noSell ? cost : sell;
    if (price == null) return null;
    if (noSell) warnings.push("Discounted part had no sell price; cost was used.");
    return cents(price * (1 - discount / 100));
  }
  if (cost == null) return sell;
  return cents(cost);
}

export function evaluateLegacy(data: RrInput): RrResult {
  const missing: string[] = [];
  const warnings: string[] = [];
  const settings = legacySettings(data);
  const calculatorType = data.calculator_type || "Standard";

  // Parts.
  let partsTotal: number | null = 0;
  const lines: NonNullable<RrResult["part_lines"]> = [];
  for (const part of data.parts ?? []) {
    let qty = rrNumber(part?.quantity);
    if (qty == null) {
      qty = 1;
      warnings.push("A part quantity was missing and defaulted to 1.");
    }
    const unit = unitCost(part ?? {}, settings.parts_discount_percent, warnings);
    if (unit == null) {
      partsTotal = null;
      lines.push({ unit_cost: null, quantity: String(qty), line_total: null });
      continue;
    }
    const lineTotal = cents(unit * qty);
    if (partsTotal != null) partsTotal = cents(partsTotal + lineTotal);
    lines.push({ unit_cost: money(unit), quantity: String(qty), line_total: money(lineTotal) });
  }
  if (partsTotal == null) missing.push("part_price");

  // Labor. An entered amount (the order's job-code charges from SOM, or
  // typed) wins over the servicer / hours / category formulas.
  let labor: number | null = null;
  let laborMethod: string | null = null;
  const category = data.labor_category || "";
  const enteredLabor = rrNumber(data.labor_cost);
  if (enteredLabor != null) {
    labor = cents(enteredLabor);
    laborMethod = "entered";
  } else if (settings.kind === "estimate") {
    if (category !== "Minor" && category !== "Major") missing.push("labor_category");
    else {
      labor = cents(category === "Minor" ? settings.minor_labor_rate : settings.major_labor_rate);
      laborMethod = "fixed";
    }
  } else if (data.servicer_type === "Sears Tech") {
    const hours = rrNumber(data.repair_hours);
    if (hours == null) missing.push("repair_hours");
    else {
      labor = cents(hours * SEARS_TECH_HOURLY + SEARS_TECH_FEE);
      laborMethod = "sears_tech";
    }
  } else if (data.servicer_type === "1099") {
    const amount = CONTRACTOR_LABOR[category];
    if (amount == null) missing.push("labor_category");
    else {
      labor = cents(amount);
      laborMethod = "contractor_1099";
    }
  } else {
    missing.push("servicer_type");
  }

  // Tax. The estimators tax parts and labor at one rate. Standard and PA 2.0
  // tax parts only, and only when a rate is given: the rate on file is the
  // order's parts tax rate (SOM estimate.partsTaxPerc).
  let tax = 0;
  const taxRate = rrNumber(data.tax_rate);
  if (settings.include_tax) {
    if (taxRate == null) warnings.push("No sales-tax rate was supplied. Tax was not applied.");
    else if (partsTotal != null && labor != null) tax = cents((partsTotal + labor) * taxRate);
  } else if (settings.kind === "binary" && taxRate != null && taxRate > 0 && partsTotal != null) {
    tax = cents(partsTotal * taxRate);
  }

  const total = partsTotal != null && labor != null ? cents(partsTotal + labor + tax) : null;

  // Replacement reference.
  const explicit = rrNumber(data.replacement_cost);
  const appliance = data.appliance_type ?? "";
  const catalog = Object.prototype.hasOwnProperty.call(APPLIANCE_REPLACEMENT, appliance) ? APPLIANCE_REPLACEMENT[appliance] : null;
  let replacement = explicit ?? catalog;
  let capApplied = false;
  if ((data.proc_id || "").includes(SHW_MARKER)) {
    if (replacement == null || replacement > SHW_CAP) {
      replacement = SHW_CAP;
      capApplied = true;
    }
  }

  let valuation: number | null = 1;
  let valuationText: string | null = "1";
  let comparison: number | null = replacement;
  const ageBand = data.age_band || "";
  if (calculatorType === "PA 2.0") {
    if (!ageBand) {
      missing.push("age_band");
      valuation = null;
      valuationText = null;
      comparison = null;
    } else if (!(ageBand in PA20_VALUATION)) {
      missing.push("age_band");
      warnings.push(`Unrecognized PA 2.0 age band '${ageBand}'.`);
      valuation = null;
      valuationText = null;
      comparison = null;
    } else if (replacement != null) {
      valuation = PA20_VALUATION[ageBand];
      valuationText = PA20_VALUATION_TEXT[ageBand];
      comparison = cents(replacement * valuation);
    }
  }

  let route: RrRoute;
  let economic: string;
  let outcomeKind: string;
  let reviewRequired: boolean;
  let reasons: string[];
  if (settings.kind === "estimate" && total != null && !missing.includes("labor_category")) {
    route = "continue_authorization";
    economic = `${calculatorType} - ${data.labor_category} Repair`;
    outcomeKind = "estimate";
    reviewRequired = false;
    reasons = [];
  } else if (missing.length || total == null) {
    route = "manual_review_incomplete";
    economic = "unavailable";
    outcomeKind = "incomplete";
    reviewRequired = true;
    reasons = ["Legacy calculation is missing inputs: " + missing.join(", ")];
  } else if (calculatorType === "PA 2.0" && comparison == null) {
    route = "manual_review_incomplete";
    economic = "unavailable";
    outcomeKind = "no_comparison";
    reviewRequired = true;
    reasons = ["PA 2.0 has no comparison value."];
  } else if (calculatorType !== "PA 2.0" && settings.kind === "binary" && comparison == null) {
    route = "manual_review_incomplete";
    economic = "unavailable";
    outcomeKind = "no_comparison";
    reviewRequired = true;
    reasons = ["No replacement reference is available, so there is no repair/replace decision."];
  } else if (comparison != null && centsInt(total) < centsInt(comparison)) {
    route = "continue_authorization";
    economic = "REPAIR";
    outcomeKind = "binary";
    reviewRequired = false;
    reasons = [];
  } else {
    route = "replacement_review";
    economic = "REPLACE";
    outcomeKind = "binary";
    reviewRequired = true;
    reasons = ["Repair total is not strictly below the comparison value."];
  }

  if (capApplied) warnings.push("Sears Protect Home Warranty replacement cap of $3,500 was applied.");

  const costs: RrCosts = {
    parts: partsTotal != null ? money(partsTotal) : null,
    labor: labor != null ? money(labor) : null,
    trip: "0.00",
    tax: money(tax),
    current_repair: total != null ? money(total) : null,
    expected_future: null,
    forward_repair: null,
    replacement: replacement != null ? money(replacement) : null,
    comparison: comparison != null ? money(comparison) : null,
    valuation: valuationText,
    threshold_rate: null,
    threshold_amount: null,
    frc_ratio: null,
  };
  return {
    model: "legacy",
    policy_version: "legacy-streamlit-v1",
    policy_status: "extracted",
    route,
    economic_outcome: economic,
    outcome_kind: outcomeKind,
    review_required: reviewRequired,
    review_reasons: reasons,
    hard_stops: [],
    missing_inputs: missing,
    warnings,
    factors: [],
    costs,
    probability: null,
    part_lines: lines,
    labor_method: laborMethod,
    calculator_type: calculatorType,
    explanation:
      `Legacy ${calculatorType} using labor method ${laborMethod || "unresolved"}. `
      + `Total ${costs.current_repair || "unavailable"}; comparison ${costs.comparison || "unavailable"}. `
      + `Outcome ${economic}.`,
    authorizes_replacement: false,
  };
}

export function evaluateRepairReplace(input: RrInput, model: RrModel): RrResult {
  return model === "legacy" ? evaluateLegacy(input) : evaluateFrc(input);
}

// ---------------------------------------------------------------------------
// Labels and the plain-text summary (copied into notes)
// ---------------------------------------------------------------------------

export const RR_FIELD_LABELS: Record<string, string> = {
  appliance_type: "Appliance",
  expected_life: "Appliance expected life",
  average_repair_event_cost: "Average repair cost for this appliance",
  age_years: "Age in years",
  replacement_cost: "Replacement cost",
  component: "Component",
  parts_cost: "Parts cost",
  labor_cost: "Labor cost",
  trip_cost: "Trip charge",
  visit_number: "Visit number",
  unresolved: "Unresolved status",
  failed_attempt_count: "Failed attempts",
  other_service_orders_12mo: "Other service orders",
  same_part_or_system_repeat: "Same part or system",
  contract_spend: "Contract spend",
  technician_confident: "Technician confidence",
  parts_available: "Parts availability",
  backorder_days: "Backorder days",
  part_price: "Parts cost",
  labor_category: "Labor category",
  repair_hours: "Repair hours",
  servicer_type: "Servicer",
  age_band: "PA 2.0 age band",
  tax_rate: "Tax rate",
  sell_price: "Sell price",
};

export const RR_RULE_LABELS: Record<string, string> = {
  third_unresolved_trip: "Third unresolved trip",
  service_orders_12_months: "Service orders in 12 months",
  major_component_age: "Major component age",
  parts_unavailable_or_backordered: "Parts unavailable or backordered",
  contract_spend: "Contract spend",
};

export function rrRouteTitle(route: RrRoute | string | undefined): string {
  if (route === "continue_authorization") return "Continue this repair";
  if (route === "replacement_review") return "Replacement review";
  if (route === "manual_review_incomplete") return "Need more information";
  return route || "No result";
}

function dollars(value: string | null | undefined): string | null {
  return value ? `$${value}` : null;
}

// Plain text for the clipboard and the staff-only ticket note. No customer
// data: service order, amounts, rules and policy only.
export function rrSummaryText(result: RrResult, serviceOrder: string, legacy?: RrResult | null): string {
  const lines = [
    "Repair / Replace calculator",
    `Service order: ${serviceOrder || "none"}`,
    `Recommendation: ${rrRouteTitle(result.route)}${result.model === "frc" ? " (Forward Repair Cost)" : " (legacy formulas)"}`,
    "Nothing was purchased or authorized by this check.",
    "",
    result.explanation,
  ];
  if (result.review_reasons.length) {
    lines.push("", "Review reasons:", ...result.review_reasons.map((item) => `- ${item}`));
  }
  const costRows: Array<[string, string | null | undefined]> = [
    ["Current repair", result.costs.current_repair],
    ["Forward repair", result.costs.forward_repair],
    ["Threshold", result.costs.threshold_amount],
    ["Comparison", result.costs.comparison],
  ];
  for (const [label, value] of costRows) {
    const shown = dollars(value);
    if (shown) lines.push(`${label}: ${shown}`);
  }
  if (result.missing_inputs.length) {
    lines.push(`Open checks: ${result.missing_inputs.map((key) => RR_FIELD_LABELS[key] || key).join(", ")}`);
  }
  if (legacy && legacy !== result) {
    lines.push("", `Legacy comparison (${legacy.calculator_type}): ${rrRouteTitle(legacy.route)}, outcome ${legacy.economic_outcome}.`);
    lines.push(legacy.explanation);
  }
  lines.push("", `Policy: ${result.policy_version} (${result.policy_status})`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Service-order prefill (GET /api/submissions/:id/repair-replace/prefill)
// ---------------------------------------------------------------------------

// The fields the form can fill from a lookup; everything else is entered by
// hand. Order is the form's.
export const RR_PREFILL_FIELDS = [
  "appliance_type", "age_years", "labor_cost", "component", "parts_cost", "trip_cost",
  "replacement_cost", "visit_number", "unresolved", "failed_attempt_count",
  "other_service_orders_12mo", "same_part_or_system_repeat", "technician_confident",
  "parts_available", "backorder_days", "contract_spend",
  // VRS Express: the legacy catalog row (APPLIANCE_REPLACEMENT key) and
  // the legacy servicer ("Sears Tech" / "1099").
  "appliance_reference", "servicer_type",
  // The order's parts tax rate (SOM estimate.partsTaxPerc).
  "tax_rate",
  // The parts' total customer sell price (SOM parts[].price, line totals);
  // the discounted estimators price parts from it.
  "sell_price",
] as const;
export type RrPrefillFieldName = (typeof RR_PREFILL_FIELDS)[number];

export interface RrPrefillField {
  value: string | boolean;
  // "snowflake": the service order (FULLDETAIL, TechHub NPSXTFS, parts
  // NPSXTPN). "hssom": the HSSOM (SOM) Order Lookup (parts, job codes, trip,
  // tax, attempts, provider, purchase date). "wom": the
  // WOM work order (visits, labor, trip). "ticket": what the technician
  // entered on this ticket, or their account.
  source: "snowflake" | "hssom" | "wom" | "ticket";
  source_field: string;
  observed_at?: string;
}

export interface RrPrefillResponse {
  service_order: string;
  // found: appliance, age and labor all filled. partial: something less.
  // not_found / unavailable: the lookup found nothing / failed (or is off).
  status: "found" | "partial" | "not_found" | "unavailable";
  manual_fallback: true;
  fields: Partial<Record<RrPrefillFieldName, RrPrefillField>>;
  missing_fields: RrPrefillFieldName[];
  warnings: string[];
}
