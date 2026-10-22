// AHS service-order prefill (shared/ahs-prefill.ts): pure helpers shared by
// GET /api/tech/ahs-prefill and POST /api/submissions. The Snowflake lookup
// itself is fetchAhsServiceOrderPrefill in server/services/snowflake.ts.
import {
  AHS_PREFILL_FIELDS,
  dispatchNumberFromServiceContractId,
  type AhsPrefillField,
  type AhsPrefillResponse,
} from "@shared/ahs-prefill";
import { deriveWarrantyFromProcId } from "@shared/warranty";
import type { AhsPrefillLookupResult } from "./services/snowflake-lookup";

// ahsDetailsSchema caps each of these fields at 100 characters. A longer
// Snowflake value is left for the tech: storing it would make the whole
// stored details fail parseStoredAhsDetails later.
const AHS_PREFILL_MAX_LENGTH = 100;

// Outer bound on top of the lookup's own deadline (which also covers queueing).
export const AHS_PREFILL_SUBMIT_TIMEOUT_MS = 5000;

// Works with today's required fields and with optional ones ("" / undefined).
type PrefillableDetails = { [K in AhsPrefillField]?: string | null } & {
  prefilledFields?: AhsPrefillField[];
};

function usable(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= AHS_PREFILL_MAX_LENGTH ? trimmed : undefined;
}

function prefillValues(lookup: AhsPrefillLookupResult): Partial<Record<AhsPrefillField, string>> {
  if (lookup.status !== "found") return {};
  return {
    contractNumber: usable(dispatchNumberFromServiceContractId(lookup.serviceContractId)),
    brand: usable(lookup.brand),
    modelNumber: usable(lookup.modelNumber),
    serialNumber: usable(lookup.serialNumber),
  };
}

// Same classification POST /api/submissions applies to the ProcID lookup.
export function isAhsOrder(lookup: AhsPrefillLookupResult | null | undefined): boolean {
  if (lookup?.status !== "found") return false;
  return deriveWarrantyFromProcId(lookup.partnerId, lookup.clientName)?.warrantyType === "american_home_shield";
}

// prefilledFields is server-only provenance; drop whatever a client sent.
export function withoutPrefilledFields<T extends PrefillableDetails>(details: T): T {
  const { prefilledFields: _ignored, ...rest } = details;
  return rest as T;
}

// Fills only blank AHS_PREFILL_FIELDS; a value the tech entered always wins.
// prefilledFields lists exactly the fields filled here (omitted when none).
// The caller decides the order is AHS (isAhsOrder) before calling this.
export function applyAhsServiceOrderPrefill<T extends PrefillableDetails>(
  details: T,
  lookup: AhsPrefillLookupResult,
): T {
  const next: PrefillableDetails = withoutPrefilledFields(details);
  const values = prefillValues(lookup);
  const filled: AhsPrefillField[] = [];
  for (const field of AHS_PREFILL_FIELDS) {
    const value = values[field];
    if (value && !next[field]?.trim()) {
      next[field] = value;
      filled.push(field);
    }
  }
  if (filled.length) next.prefilledFields = filled;
  return next as T;
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

// What the browser may see: non-PII appliance fields and whether a dispatch
// number exists. Never the contract/dispatch value, partner or client name.
export function toAhsPrefillResponse(lookup: AhsPrefillLookupResult): AhsPrefillResponse {
  if (lookup.status === "unavailable") return { status: "unavailable" };
  if (!isAhsOrder(lookup)) return { status: "not_found" };
  const values = prefillValues(lookup);
  const appliance: { brand?: string; modelNumber?: string; serialNumber?: string } = {};
  if (values.brand) appliance.brand = values.brand;
  if (values.modelNumber) appliance.modelNumber = values.modelNumber;
  if (values.serialNumber) appliance.serialNumber = values.serialNumber;
  return { status: "found", appliance, hasDispatchNumber: !!values.contractNumber };
}

// Lookup for a "DDDD-SSSSSSSS" service order (endpoint and submit path).
// Never rejects and settles within timeoutMs, so it can never block or fail
// a submission.
export function boundedAhsPrefillLookup(
  serviceOrder: string,
  lookup: (district: string, serviceOrder: string) => Promise<AhsPrefillLookupResult>,
  timeoutMs = AHS_PREFILL_SUBMIT_TIMEOUT_MS,
): Promise<AhsPrefillLookupResult> {
  const match = /^(\d{4})-(\d{8})$/.exec(serviceOrder.trim());
  if (!match) return Promise.resolve({ status: "not_found" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AhsPrefillLookupResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "unavailable" }), timeoutMs);
  });
  const work = Promise.resolve()
    .then(() => lookup(match[1], match[2]))
    .catch((): AhsPrefillLookupResult => ({ status: "unavailable" }));
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
