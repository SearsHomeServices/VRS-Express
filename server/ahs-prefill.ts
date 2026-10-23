// AHS service-order prefill (shared/ahs-prefill.ts): pure helpers for the
// AHS draft (shared/ahs-review.ts). POST /api/submissions builds the draft
// the VRS manager completes at Stage 1; PATCH /api/submissions/:id/ahs-details
// and its refresh route (server/ahs-review-api.ts) merge provenance and refill
// blanks. The lookups themselves are fetchAhsServiceOrderPrefill in
// server/services/snowflake.ts (appliance, dispatch number and the parts on
// the order) and lookupHssomOrder in server/services/hssom-order-lookup.ts
// (customer name and address, plus appliance fields Snowflake may lack).
import {
  AHS_PREFILL_FIELDS,
  dispatchNumberFromServiceContractId,
  type AhsPrefillField,
} from "@shared/ahs-prefill";
import type { AhsDetails, AhsDetailsDraft, AhsPartDraft } from "@shared/ahs-details";
import { ahsGradeFromTechGrade, type TechApplianceDetails } from "@shared/tech-appliance-details";
import { deriveWarrantyFromProcId } from "@shared/warranty";
import type { AhsPrefillLookupResult, AhsServiceOrderPart } from "./services/snowflake-lookup";
import type { HssomOrderLookupResult } from "./services/hssom-order-lookup";

// The single-value fields; "parts" marks the whole parts list.
type AhsPrefillTextField = Exclude<AhsPrefillField, "parts">;
export const AHS_PREFILL_TEXT_FIELDS = AHS_PREFILL_FIELDS.filter(
  (field): field is AhsPrefillTextField => field !== "parts",
);

// ahsDetailsSchema's max length per field. A longer value is left for the
// VRS manager: storing it would make the whole stored draft fail to parse.
const AHS_PREFILL_MAX_LENGTH: Record<AhsPrefillTextField, number> = {
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

// Works with drafts, complete details and the older stored shapes.
type PrefillableDetails = { [K in AhsPrefillTextField]?: string | null } & {
  prefilledFields?: AhsPrefillField[];
  applianceAge?: number | null;
  purchaseYear?: number;
};

// What the two sources may fill, already trimmed and within the schema limits.
export type AhsPrefillValues = Partial<Record<AhsPrefillTextField, string>> & {
  purchaseYear?: number;
  parts?: AhsServiceOrderPart[];
};

export interface AhsPrefillSources {
  snowflake: AhsPrefillLookupResult;
  hssom: HssomOrderLookupResult;
}

type PrefillOutcome = { status: "found"; values: AhsPrefillValues } | typeof NOT_FOUND | typeof UNAVAILABLE;

function usable(field: AhsPrefillTextField, value: string | undefined): string | undefined {
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
// Customer name and address come from HSSOM only, the parts from Snowflake
// only. Does not decide whether the order is AHS (see applyAhsSubmitPrefill).
export function mergeAhsPrefillSources(
  snowflake: AhsPrefillLookupResult,
  hssom: HssomOrderLookupResult,
  now = new Date(),
): AhsPrefillValues {
  const sf = snowflake.status === "found" ? snowflake : undefined;
  const hs = hssom.status === "found" ? hssom : undefined;
  const either = (field: AhsPrefillTextField, a: string | undefined, b: string | undefined) =>
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
    parts: sf?.parts?.length ? sf.parts.map((part) => ({ ...part })) : undefined,
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

// Server-only fields; drop whatever a client sent. prefilledFields and
// purchaseYear are set only by the server (fillAhsDraft, mergeSavedAhsProvenance)
// and purchaseYear is read by server/vrs-app-enroll.ts.
export function withoutServerOnlyFields<T extends PrefillableDetails>(details: T): T {
  const { purchaseYear: _ignored, ...rest } = withoutPrefilledFields(details);
  return rest as T;
}

// prefilledFields is server-only provenance; drop whatever a client sent.
export function withoutPrefilledFields<T extends PrefillableDetails>(details: T): T {
  const { prefilledFields: _ignored, ...rest } = details;
  return rest as T;
}

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

// A part line holding only what the technician entered (part function, from
// applyTechApplianceDetails): no part number, description, quantity or price.
function isTechOnlyPart(part: AhsPartDraft): boolean {
  return (
    !part.partNumber?.trim() &&
    !part.description?.trim() &&
    part.quantity === undefined &&
    part.unitPrice === undefined
  );
}

// Fills only blank fields of the draft; a value already there always wins.
// The draft's own prefilledFields are kept (they only ever name values the
// server filled), plus the fields filled here and fields whose value already
// equals the service-order value; omitted when none. Parts are filled only
// when the draft has none, or only the technician's partial part 1 (its part
// function is kept on the filled part 1). purchaseYear is set only while the
// appliance age is blank; no age is ever derived from it.
export function fillAhsDraft(draft: AhsDetailsDraft, values: AhsPrefillValues): AhsDetailsDraft {
  const next: AhsDetailsDraft = { ...draft };
  const marked = new Set<AhsPrefillField>(draft.prefilledFields ?? []);
  for (const field of AHS_PREFILL_TEXT_FIELDS) {
    const value = values[field];
    if (!value) continue;
    if (!next[field]?.trim()) {
      next[field] = value;
      marked.add(field);
    } else if (sameText(next[field], value)) {
      marked.add(field);
    }
  }
  if (values.parts?.length && (next.parts ?? []).every(isTechOnlyPart)) {
    const techLines = next.parts ?? [];
    next.parts = values.parts.map((part, index) => ({ ...techLines[index], ...part }));
    marked.add("parts");
  }
  if (values.purchaseYear !== undefined && next.applianceAge == null && next.purchaseYear === undefined) {
    next.purchaseYear = values.purchaseYear;
  }
  const prefilledFields = AHS_PREFILL_FIELDS.filter((field) => marked.has(field));
  if (prefilledFields.length) next.prefilledFields = prefilledFields;
  else delete next.prefilledFields;
  return next;
}

// Merges both sources (mergeAhsPrefillSources) into the draft. The caller
// decides the order is AHS (isAhsOrder) before calling this.
export function applyAhsServiceOrderPrefill(
  draft: AhsDetailsDraft,
  snowflake: AhsPrefillLookupResult,
  hssom: HssomOrderLookupResult = UNAVAILABLE,
): AhsDetailsDraft {
  return fillAhsDraft(draft, mergeAhsPrefillSources(snowflake, hssom));
}

// The AHS draft (POST /api/submissions, and the Stage 1 refresh): fills the
// draft only for an AHS ticket. The ticket's final warranty must be AHS, and
// then either the Snowflake row is AHS, or (no Snowflake row) the
// ProcID-derived warranty itself is AHS; a tech-selected warranty alone never
// lets HSSOM fill. Otherwise the draft comes back unchanged (an empty draft
// stays {}).
export function applyAhsSubmitPrefill(
  draft: AhsDetailsDraft,
  sources: AhsPrefillSources,
  warranty: { finalWarrantyType: string | null | undefined; derivedWarrantyType: string | null | undefined },
): AhsDetailsDraft {
  if (warranty.finalWarrantyType !== "american_home_shield") return draft;
  const outcome = prefillOutcome(
    sources.snowflake,
    sources.hssom,
    warranty.derivedWarrantyType === "american_home_shield",
  );
  return outcome.status === "found" ? fillAhsDraft(draft, outcome.values) : draft;
}

// The appliance details the technician entered (shared/tech-appliance-details.ts)
// on the AHS draft: grade (Low/Medium/High → entry/mid/top), color and part
// 1's function, as a partial part 1 when the draft has no parts (the VRS
// manager completes it; a later refresh may still fill the parts around it).
// Tech-entered, so never named in prefilledFields. A value already in the
// draft wins (a resubmission carries the previous ticket's details, possibly
// corrected by the VRS manager) unless the technician changed it from what
// they sent on that previous ticket (previous).
export function applyTechApplianceDetails(
  draft: AhsDetailsDraft,
  tech: TechApplianceDetails,
  previous?: TechApplianceDetails | null,
): AhsDetailsDraft {
  const changed = (field: keyof TechApplianceDetails) => !!previous && !sameText(previous[field], tech[field]);
  const next: AhsDetailsDraft = { ...draft };
  if (!next.applianceGrade || changed("applianceGrade")) {
    next.applianceGrade = ahsGradeFromTechGrade(tech.applianceGrade);
  }
  if (!next.applianceColor?.trim() || changed("applianceColor")) {
    next.applianceColor = tech.applianceColor;
  }
  const parts = next.parts?.length ? next.parts.map((part) => ({ ...part })) : [{}];
  if (!parts[0].partFunction?.trim() || changed("partFunction")) {
    parts[0].partFunction = tech.partFunction;
  }
  next.parts = parts;
  return next;
}

// Names (never values) of what the server filled, for logging.
export function prefilledFieldNames(details: PrefillableDetails): string[] {
  return [
    ...(details.prefilledFields ?? []),
    ...(details.purchaseYear === undefined ? [] : ["purchaseYear"]),
  ];
}

// The draft as the starting point for a resubmission: the previous ticket's
// stored details (draft or complete) with the server's provenance kept.
export function draftFromPrevious(previous: AhsDetailsDraft | null | undefined): AhsDetailsDraft {
  return previous ? { ...previous } : {};
}

function samePartsAsServer(saved: AhsPartDraft[] | undefined, server: AhsPartDraft[] | undefined): boolean {
  if (!saved?.length || !server?.length || saved.length !== server.length) return false;
  return server.every((filled, index) => {
    const part = saved[index];
    return (
      sameText(part.partNumber, filled.partNumber) &&
      (filled.description === undefined || sameText(part.description, filled.description)) &&
      (filled.quantity === undefined || part.quantity === filled.quantity) &&
      (filled.unitPrice === undefined || part.unitPrice === filled.unitPrice)
    );
  });
}

// PATCH /api/submissions/:id/ahs-details: what the VRS manager saved, with
// the draft's provenance kept only for fields whose saved value still equals
// the value the server filled (trimmed, case-insensitive; for parts, every
// value the server filled on every line). Client-sent prefilledFields and
// purchaseYear are dropped; the draft's purchaseYear carries forward while
// the appliance age is still blank.
export function mergeSavedAhsProvenance(saved: AhsDetails, draft: AhsDetailsDraft | null | undefined): AhsDetails {
  const next = withoutServerOnlyFields(saved);
  const kept = (draft?.prefilledFields ?? []).filter((field) => {
    if (field === "parts") return samePartsAsServer(next.parts, draft?.parts);
    if (!AHS_PREFILL_TEXT_FIELDS.includes(field)) return false;
    return !!next[field]?.trim() && sameText(next[field], draft?.[field]);
  });
  const prefilledFields = AHS_PREFILL_FIELDS.filter((field) => kept.includes(field));
  if (prefilledFields.length) next.prefilledFields = prefilledFields;
  if (next.applianceAge === undefined && draft?.purchaseYear !== undefined) {
    next.purchaseYear = draft.purchaseYear;
  }
  return next;
}

// Customer PII and the AHS dispatch number never go back to a technician's
// browser, not even on their own ticket: the server fills them and the VRS
// manager completes them at Stage 1. Technician-facing submission responses
// drop these keys from the stored ahs_details JSON, whoever entered them.
const TECHNICIAN_HIDDEN_AHS_FIELDS = ["contractNumber", "customerName", "customerAddress"] as const;

export function redactAhsCustomerForTechnician(raw: string | null | undefined): string | null | undefined {
  if (!raw) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
  const details = parsed as Record<string, unknown>;
  const redact = TECHNICIAN_HIDDEN_AHS_FIELDS.filter((field) => field in details);
  if (!redact.length) return raw;
  for (const field of redact) delete details[field];
  return JSON.stringify(details);
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

// Lookup for a "DDDD-SSSSSSSS" service order (submit path and the Stage 1
// refresh), for either source. Never rejects and settles within timeoutMs, so it can never
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
