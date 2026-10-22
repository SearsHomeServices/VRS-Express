// AHS service-order prefill (shared/ahs-prefill.ts): pure helpers shared by
// GET /api/tech/ahs-prefill and POST /api/submissions. The lookups
// themselves are fetchAhsServiceOrderPrefill in server/services/snowflake.ts
// (appliance + dispatch number) and lookupHssomOrder in
// server/services/hssom-order-lookup.ts (customer name and address, plus
// appliance fields Snowflake may lack).
import {
  AHS_PREFILL_FIELDS,
  dispatchNumberFromServiceContractId,
  type AhsPrefillField,
  type AhsPrefillResponse,
} from "@shared/ahs-prefill";
import { deriveWarrantyFromProcId } from "@shared/warranty";
import type { AhsPrefillLookupResult, ProcIdResult } from "./services/snowflake-lookup";
import type { HssomOrderLookupResult } from "./services/hssom-order-lookup";

// ahsDetailsSchema's max length per field. A longer value is left for the
// tech: storing it would make the whole stored details fail
// parseStoredAhsDetails later.
const AHS_PREFILL_MAX_LENGTH: Record<AhsPrefillField, number> = {
  contractNumber: 100,
  brand: 100,
  modelNumber: 100,
  serialNumber: 100,
  customerName: 255,
  customerAddress: 1_000,
};

// ahsDetailsSchema's purchaseYear floor.
const AHS_MIN_PURCHASE_YEAR = 1900;

// Outer bound on top of each lookup's own deadline (which also covers queueing).
export const AHS_PREFILL_SUBMIT_TIMEOUT_MS = 5000;

const UNAVAILABLE = { status: "unavailable" } as const;
const NOT_FOUND = { status: "not_found" } as const;

// Works with today's optional fields ("" / undefined) and the older required ones.
type PrefillableDetails = { [K in AhsPrefillField]?: string | null } & {
  prefilledFields?: AhsPrefillField[];
  applianceAge?: number | null;
  purchaseYear?: number;
};

// What the two sources may fill, already trimmed and within the schema limits.
export type AhsPrefillValues = Partial<Record<AhsPrefillField, string>> & { purchaseYear?: number };

export interface AhsPrefillSources {
  snowflake: AhsPrefillLookupResult;
  hssom: HssomOrderLookupResult;
}

type PrefillOutcome = { status: "found"; values: AhsPrefillValues } | typeof NOT_FOUND | typeof UNAVAILABLE;

function usable(field: AhsPrefillField, value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= AHS_PREFILL_MAX_LENGTH[field] ? trimmed : undefined;
}

// "YYYY-MM-DD..." → year, only when it is a plausible past year.
function purchaseYearFrom(raw: string | undefined, now: Date): number | undefined {
  const match = /^(\d{4})-\d{2}-\d{2}/.exec(raw?.trim() ?? "");
  if (!match) return undefined;
  const year = Number(match[1]);
  return year >= AHS_MIN_PURCHASE_YEAR && year <= now.getUTCFullYear() ? year : undefined;
}

// Merges the two lookups field by field. Snowflake wins for the dispatch
// number and the appliance fields; HSSOM fills only what Snowflake lacks.
// Customer name and address come from HSSOM only. Does not decide whether
// the order is AHS (see applyAhsSubmitPrefill / toAhsPrefillResponse).
export function mergeAhsPrefillSources(
  snowflake: AhsPrefillLookupResult,
  hssom: HssomOrderLookupResult,
  now = new Date(),
): AhsPrefillValues {
  const sf = snowflake.status === "found" ? snowflake : undefined;
  const hs = hssom.status === "found" ? hssom : undefined;
  const either = (field: AhsPrefillField, a: string | undefined, b: string | undefined) =>
    usable(field, a) ?? usable(field, b);
  const values: AhsPrefillValues = {
    contractNumber: either(
      "contractNumber",
      dispatchNumberFromServiceContractId(sf?.serviceContractId),
      dispatchNumberFromServiceContractId(hs?.serviceContractId),
    ),
    brand: either("brand", sf?.brand, hs?.brand),
    modelNumber: either("modelNumber", sf?.modelNumber, hs?.modelNumber),
    serialNumber: either("serialNumber", sf?.serialNumber, hs?.serialNumber),
    customerName: usable("customerName", hs?.customerName),
    customerAddress: usable("customerAddress", hs?.customerAddress),
    purchaseYear: purchaseYearFrom(hs?.purchaseDate, now),
  };
  for (const key of Object.keys(values) as (keyof AhsPrefillValues)[]) {
    if (values[key] === undefined) delete values[key];
  }
  return values;
}

// Same classification POST /api/submissions applies to the ProcID lookup.
export function isAhsOrder(lookup: AhsPrefillLookupResult | null | undefined): boolean {
  if (lookup?.status !== "found") return false;
  return deriveWarrantyFromProcId(lookup.partnerId, lookup.clientName)?.warrantyType === "american_home_shield";
}

// Whether the order is AHS and what may fill it. A Snowflake row decides on
// its own: not AHS there means neither source fills anything. HSSOM carries
// no warranty data, so without a Snowflake row its values count only when
// hssomOnlyAhs (the server's ProcID derivation) says AHS; undefined means
// that derivation is unknown.
function prefillOutcome(
  snowflake: AhsPrefillLookupResult,
  hssom: HssomOrderLookupResult,
  hssomOnlyAhs: boolean | undefined,
): PrefillOutcome {
  if (snowflake.status === "found") {
    return isAhsOrder(snowflake) ? { status: "found", values: mergeAhsPrefillSources(snowflake, hssom) } : NOT_FOUND;
  }
  if (hssom.status === "found") {
    if (hssomOnlyAhs === true) return { status: "found", values: mergeAhsPrefillSources(snowflake, hssom) };
    return hssomOnlyAhs === false ? NOT_FOUND : UNAVAILABLE;
  }
  return snowflake.status === "unavailable" ? UNAVAILABLE : NOT_FOUND;
}

// Server-only fields; drop whatever a client sent. purchaseYear is set only
// from HSSOM (applyAhsSubmitPrefill) and read by server/vrs-app-enroll.ts.
export function withoutServerOnlyFields<T extends PrefillableDetails>(details: T): T {
  const { purchaseYear: _ignored, ...rest } = withoutPrefilledFields(details);
  return rest as T;
}

// prefilledFields is server-only provenance; drop whatever a client sent.
export function withoutPrefilledFields<T extends PrefillableDetails>(details: T): T {
  const { prefilledFields: _ignored, ...rest } = details;
  return rest as T;
}

// Fills only blank AHS_PREFILL_FIELDS; a value the tech entered always wins.
// prefilledFields lists exactly the fields filled here (omitted when none).
// purchaseYear is passed through only when the tech left the appliance age
// blank; no age is ever derived from it.
function applyPrefillValues<T extends PrefillableDetails>(details: T, values: AhsPrefillValues): T {
  const next: PrefillableDetails = withoutPrefilledFields(details);
  const filled: AhsPrefillField[] = [];
  for (const field of AHS_PREFILL_FIELDS) {
    const value = values[field];
    if (value && !next[field]?.trim()) {
      next[field] = value;
      filled.push(field);
    }
  }
  if (filled.length) next.prefilledFields = filled;
  if (values.purchaseYear !== undefined && next.applianceAge == null && next.purchaseYear === undefined) {
    next.purchaseYear = values.purchaseYear;
  }
  return next as T;
}

// Merges both sources (mergeAhsPrefillSources) into the details. The caller
// decides the order is AHS (isAhsOrder) before calling this.
export function applyAhsServiceOrderPrefill<T extends PrefillableDetails>(
  details: T,
  snowflake: AhsPrefillLookupResult,
  hssom: HssomOrderLookupResult = UNAVAILABLE,
): T {
  return applyPrefillValues(details, mergeAhsPrefillSources(snowflake, hssom));
}

// POST /api/submissions: fills the details only for an AHS ticket. The
// ticket's final warranty must be AHS, and then either the Snowflake row is
// AHS, or (no Snowflake row) the ProcID-derived warranty itself is AHS; a
// tech-selected warranty alone never lets HSSOM fill. Otherwise the details
// come back unchanged.
export function applyAhsSubmitPrefill<T extends PrefillableDetails>(
  details: T,
  sources: AhsPrefillSources,
  warranty: { finalWarrantyType: string | null | undefined; derivedWarrantyType: string | null | undefined },
): T {
  if (warranty.finalWarrantyType !== "american_home_shield") return details;
  const outcome = prefillOutcome(
    sources.snowflake,
    sources.hssom,
    warranty.derivedWarrantyType === "american_home_shield",
  );
  return outcome.status === "found" ? applyPrefillValues(details, outcome.values) : details;
}

// Names (never values) of what the server filled, for logging.
export function prefilledFieldNames(details: PrefillableDetails): string[] {
  return [
    ...(details.prefilledFields ?? []),
    ...(details.purchaseYear === undefined ? [] : ["purchaseYear"]),
  ];
}

// A resubmission carries the previous ticket's values back from the form, so
// they are no longer blank and would lose their provenance. Keep a field
// marked when the previous ticket had it prefilled and the value is unchanged.
export function keepPrefilledFromPrevious<T extends PrefillableDetails>(
  details: T,
  previous: PrefillableDetails | null | undefined,
): T {
  const kept = (previous?.prefilledFields ?? []).filter((field) =>
    AHS_PREFILL_FIELDS.includes(field) &&
    !!details[field]?.trim() &&
    details[field]?.trim() === previous?.[field]?.trim(),
  );
  const merged = AHS_PREFILL_FIELDS.filter((field) =>
    details.prefilledFields?.includes(field) || kept.includes(field),
  );
  return merged.length ? { ...details, prefilledFields: merged } : withoutPrefilledFields(details);
}

// GET /api/tech/ahs-prefill needs the ProcID derivation only when HSSOM found
// the order and Snowflake has no row to decide AHS by.
export function needsServerDerivedAhs(sources: AhsPrefillSources): boolean {
  return sources.snowflake.status !== "found" && sources.hssom.status === "found";
}

// What the browser may see: non-PII appliance fields (either source,
// Snowflake first), whether a dispatch number exists and whether the server
// will fill customer name and address. Never the contract/dispatch value,
// the customer's name or address, partner or client name.
export function toAhsPrefillResponse(
  snowflake: AhsPrefillLookupResult,
  hssom: HssomOrderLookupResult = UNAVAILABLE,
  hssomOnlyAhs?: boolean,
): AhsPrefillResponse {
  const outcome = prefillOutcome(snowflake, hssom, hssomOnlyAhs);
  if (outcome.status !== "found") return outcome;
  const { values } = outcome;
  const appliance: { brand?: string; modelNumber?: string; serialNumber?: string } = {};
  if (values.brand) appliance.brand = values.brand;
  if (values.modelNumber) appliance.modelNumber = values.modelNumber;
  if (values.serialNumber) appliance.serialNumber = values.serialNumber;
  return {
    status: "found",
    appliance,
    hasDispatchNumber: !!values.contractNumber,
    hasCustomer: !!(values.customerName && values.customerAddress),
  };
}

// Resolves with work's result, or fallback on rejection or after timeoutMs.
function settleWithin<T>(work: () => Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  const settled = Promise.resolve().then(work).catch(() => fallback);
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

// Lookup for a "DDDD-SSSSSSSS" service order (endpoint and submit path), for
// either source. Never rejects and settles within timeoutMs, so it can never
// block or fail a submission.
export function boundedAhsPrefillLookup<T extends AhsPrefillLookupResult | HssomOrderLookupResult>(
  serviceOrder: string,
  lookup: (district: string, serviceOrder: string) => Promise<T>,
  timeoutMs = AHS_PREFILL_SUBMIT_TIMEOUT_MS,
): Promise<T> {
  const match = /^(\d{4})-(\d{8})$/.exec(serviceOrder.trim());
  if (!match) return Promise.resolve(NOT_FOUND as T);
  return settleWithin(() => lookup(match[1], match[2]), UNAVAILABLE as T, timeoutMs);
}

// Both sources in parallel; snowflake null (its flag is off) counts as
// unavailable. Never rejects and settles within timeoutMs.
export async function lookupAhsPrefillSources(
  serviceOrder: string,
  lookups: {
    snowflake: ((district: string, serviceOrder: string) => Promise<AhsPrefillLookupResult>) | null;
    hssom: (district: string, serviceOrder: string) => Promise<HssomOrderLookupResult>;
  },
  timeoutMs = AHS_PREFILL_SUBMIT_TIMEOUT_MS,
): Promise<AhsPrefillSources> {
  const [snowflake, hssom] = await Promise.all([
    lookups.snowflake
      ? boundedAhsPrefillLookup(serviceOrder, lookups.snowflake, timeoutMs)
      : Promise.resolve<AhsPrefillLookupResult>(UNAVAILABLE),
    boundedAhsPrefillLookup(serviceOrder, lookups.hssom, timeoutMs),
  ]);
  return { snowflake, hssom };
}

// The submit path's ProcID warranty derivation for GET /api/tech/ahs-prefill:
// true/false when known, undefined when the lookup is unavailable or slow.
export function boundedServerDerivedAhs(
  serviceOrder: string,
  fetchProcId: (serviceOrder: string) => Promise<ProcIdResult>,
  timeoutMs = AHS_PREFILL_SUBMIT_TIMEOUT_MS,
): Promise<boolean | undefined> {
  return settleWithin(async () => {
    const result = await fetchProcId(serviceOrder);
    if (result.status === "LOOKUP_UNAVAILABLE") return undefined;
    return deriveWarrantyFromProcId(result.procId, result.clientNm)?.warrantyType === "american_home_shield";
  }, undefined, timeoutMs);
}
