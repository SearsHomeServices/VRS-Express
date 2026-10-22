// Stage 1 reviewer view of submissions.ahs_details (shared/ahs-details.ts).
//
// The reviewer must see whatever the technician sent, even when the stored
// JSON no longer matches today's strict form schema (fields made optional,
// new keys such as techRecommendation, older rows). So this reads the JSON
// leniently instead of through ahsDetailsSchema: every field is optional and
// junk values read as "not provided". Display only; nothing here is sent
// anywhere, and nothing here logs (the JSON carries customer name/address).
import {
  AHS_APPLIANCE_GRADES,
  AHS_FAILURE_CAUSES,
  ahsApplianceKind,
  roundCents,
} from "@shared/ahs-details";
import { AHS_PREFILL_FIELDS, type AhsPrefillField } from "@shared/ahs-prefill";

export type AhsTechRecommendation = "repair" | "replace";

export interface AhsReviewPart {
  partNumber?: string;
  quantity?: number;
  description?: string;
  unitPrice?: number;
  partFunction?: string;
  failureReason?: string;
}

export interface AhsReviewDetails {
  contractNumber?: string;
  customerName?: string;
  customerAddress?: string;
  applianceKind?: string;
  brand?: string;
  modelNumber?: string;
  serialNumber?: string;
  applianceAge?: number;
  applianceLocation?: string;
  applianceGrade?: string;
  applianceColor?: string;
  failureCause?: string;
  techRecommendation?: AhsTechRecommendation;
  laborAmount?: number;
  taxAmount?: number;
  parts: AhsReviewPart[];
  prefilledFields: AhsPrefillField[];
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[$,\s]/g, "");
  if (cleaned === "") return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAhsDetailsForReview(
  raw: string | null | undefined,
): AhsReviewDetails | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const recommendation = text(parsed.techRecommendation)?.toLowerCase();
  // Known names only (AHS_PREFILL_FIELDS, which includes customerName and
  // customerAddress); anything else is dropped.
  const prefilled = Array.isArray(parsed.prefilledFields)
    ? AHS_PREFILL_FIELDS.filter((field) =>
        (parsed as { prefilledFields: unknown[] }).prefilledFields.includes(field),
      )
    : [];

  return {
    contractNumber: text(parsed.contractNumber),
    customerName: text(parsed.customerName),
    customerAddress: text(parsed.customerAddress),
    applianceKind: text(parsed.applianceKind),
    brand: text(parsed.brand),
    modelNumber: text(parsed.modelNumber),
    serialNumber: text(parsed.serialNumber),
    applianceAge: num(parsed.applianceAge),
    applianceLocation: text(parsed.applianceLocation),
    applianceGrade: text(parsed.applianceGrade),
    applianceColor: text(parsed.applianceColor),
    failureCause: text(parsed.failureCause),
    techRecommendation:
      recommendation === "repair" || recommendation === "replace"
        ? recommendation
        : undefined,
    laborAmount: num(parsed.laborAmount),
    taxAmount: num(parsed.taxAmount),
    parts: Array.isArray(parsed.parts)
      ? parsed.parts.filter(isRecord).map((part) => ({
          partNumber: text(part.partNumber),
          quantity: num(part.quantity),
          description: text(part.description),
          unitPrice: num(part.unitPrice),
          partFunction: text(part.partFunction),
          failureReason: text(part.failureReason),
        }))
      : [],
    prefilledFields: prefilled,
  };
}

export function ahsApplianceKindLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return ahsApplianceKind(value)?.label ?? value;
}

export function ahsGradeLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return AHS_APPLIANCE_GRADES.find((grade) => grade.value === value)?.label ?? value;
}

export function ahsFailureCauseLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return AHS_FAILURE_CAUSES.find((cause) => cause.value === value)?.label ?? value;
}

export function ahsRecommendationLabel(
  value: AhsTechRecommendation | undefined,
): string | undefined {
  if (value === "repair") return "Repair";
  if (value === "replace") return "Replace";
  return undefined;
}

export function formatAhsMoney(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `$${value.toFixed(2)}`;
}

export function ahsReviewPartLineTotal(part: AhsReviewPart): number | undefined {
  if (part.unitPrice === undefined) return undefined;
  return roundCents((part.quantity ?? 1) * part.unitPrice);
}

// Undefined when any part has no price, so the reviewer never sees a total
// that silently treats a blank as $0.
export function ahsReviewPartsTotal(details: AhsReviewDetails): number | undefined {
  if (details.parts.length === 0) return undefined;
  let sum = 0;
  for (const part of details.parts) {
    const line = ahsReviewPartLineTotal(part);
    if (line === undefined) return undefined;
    sum += line;
  }
  return roundCents(sum);
}

export function ahsReviewGrandTotal(details: AhsReviewDetails): number | undefined {
  const parts = ahsReviewPartsTotal(details);
  if (
    parts === undefined ||
    details.laborAmount === undefined ||
    details.taxAmount === undefined
  ) {
    return undefined;
  }
  return roundCents(parts + details.laborAmount + details.taxAmount);
}
