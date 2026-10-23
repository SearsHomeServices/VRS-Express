// Stage 1 reviewer view of submissions.ahs_details (shared/ahs-details.ts).
//
// The stored JSON is either a draft the server built from the service-order
// lookups (AhsDetailsDraft, possibly `{}`), details the VRS manager saved at
// Stage 1, or an older ticket the technician filled in. The reviewer must see
// whatever is there, even when it no longer matches today's strict schema
// (fields made optional, new keys such as techRecommendation, older rows,
// partial drafts). So this reads the JSON leniently instead of through
// ahsDetailsSchema: every field is optional and junk values read as "not
// provided". Nothing here is sent anywhere, and nothing here logs (the JSON
// carries customer name/address).
import {
  AHS_APPLIANCE_GRADES,
  AHS_FAILURE_CAUSES,
  ahsApplianceKind,
  roundCents,
} from "@shared/ahs-details";
import { AHS_PREFILL_FIELDS, type AhsPrefillField } from "@shared/ahs-prefill";
import type { VrsAiBridgeStatus } from "@/lib/vrsAiBridge";

export type AhsTechRecommendation = "repair" | "replace";

// What prefilledFields may name. "parts" means the server filled the part
// lines from the service order too.
export type AhsReviewProvenanceField = AhsPrefillField | "parts";
export const AHS_REVIEW_PROVENANCE_FIELDS: readonly AhsReviewProvenanceField[] = Array.from(
  new Set<AhsReviewProvenanceField>([...AHS_PREFILL_FIELDS, "parts"]),
);

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
  prefilledFields: AhsReviewProvenanceField[];
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
  // customerAddress, plus "parts"); anything else is dropped.
  const prefilled = Array.isArray(parsed.prefilledFields)
    ? AHS_REVIEW_PROVENANCE_FIELDS.filter((field) =>
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

// ---------------------------------------------------------------------------
// Stage 1 editor (PATCH /api/submissions/:id/ahs-details, shared/ahs-review.ts)
// ---------------------------------------------------------------------------

export interface AhsEditableTicket {
  requestType?: string | null;
  warrantyType?: string | null;
  ticketStatus?: string | null;
  stage1Status?: string | null;
  submissionApproved?: boolean | null;
}

// Bridge states VRS AI has not received yet. The server replaces such a row
// when the manager saves again.
const UNDISPATCHED_BRIDGE_STATES = ["pending_review", "dispatch_failed"];

// Whether the VRS manager may still complete or correct the AHS details: an
// AHS authorization ticket, claimed and at Stage 1 (not yet decided), whose
// VRS AI request (if one exists) was never dispatched. The server enforces
// the same conditions; this only decides which view to show. The feature
// flag (vrsAiAppEnrollEnabled) is checked by the caller.
export function isAhsDetailsEditable(
  ticket: AhsEditableTicket | null | undefined,
  bridge: Pick<VrsAiBridgeStatus, "state" | "providerCallId" | "dispatchedAt"> | null | undefined,
): boolean {
  if (!ticket) return false;
  if (ticket.requestType !== "authorization") return false;
  if (ticket.warrantyType !== "american_home_shield") return false;
  if (ticket.ticketStatus !== "pending") return false;
  if ((ticket.stage1Status ?? "pending") !== "pending") return false;
  if (ticket.submissionApproved) return false;
  if (!bridge) return true;
  return (
    UNDISPATCHED_BRIDGE_STATES.includes(bridge.state) &&
    !bridge.providerCallId &&
    !bridge.dispatchedAt
  );
}

// Field names of the editor's form, under its "ahsDetails" root.
export const AHS_REVIEW_FORM_FIELDS = [
  "contractNumber",
  "customerName",
  "customerAddress",
  "applianceKind",
  "brand",
  "modelNumber",
  "serialNumber",
  "applianceAge",
  "applianceLocation",
  "applianceGrade",
  "applianceColor",
  "failureCause",
  "techRecommendation",
  "laborAmount",
  "taxAmount",
] as const;
export type AhsReviewFormField = (typeof AHS_REVIEW_FORM_FIELDS)[number];

export const AHS_REVIEW_PART_FIELDS = [
  "partNumber",
  "quantity",
  "description",
  "unitPrice",
  "partFunction",
  "failureReason",
] as const;

// A zod issue path (client or server; with or without the leading
// "ahsDetails" of the request body) → the editor form field that shows it.
// Array-level part messages ("Add at least one part", the parts total) go to
// "ahsDetails.parts.root", like react-hook-form's resolver puts them. Null
// when no input matches; the editor lists those messages above Save.
export function ahsIssueFieldName(path: readonly (string | number)[]): string | null {
  const rest = path[0] === "ahsDetails" ? path.slice(1) : path;
  const [head, index, key] = rest;
  if (rest.length === 1 && (AHS_REVIEW_FORM_FIELDS as readonly unknown[]).includes(head)) {
    return `ahsDetails.${head}`;
  }
  if (head !== "parts") return null;
  if (rest.length === 1) return "ahsDetails.parts.root";
  const row = typeof index === "number" ? index : Number(index);
  if (!Number.isInteger(row) || row < 0) return null;
  if (rest.length === 3 && (AHS_REVIEW_PART_FIELDS as readonly unknown[]).includes(key)) {
    return `ahsDetails.parts.${row}.${key}`;
  }
  return null;
}

export interface AhsIssue {
  path: (string | number)[];
  message: string;
}

// Splits issues into per-field messages (first message per field wins) and
// the rest.
export function groupAhsIssues(issues: readonly AhsIssue[] | null | undefined): {
  fields: Record<string, string>;
  general: string[];
} {
  const fields: Record<string, string> = {};
  const general: string[] = [];
  for (const issue of issues ?? []) {
    if (!issue || typeof issue.message !== "string") continue;
    const name = Array.isArray(issue.path) ? ahsIssueFieldName(issue.path) : null;
    if (name) {
      if (!(name in fields)) fields[name] = issue.message;
    } else if (!general.includes(issue.message)) {
      general.push(issue.message);
    }
  }
  return { fields, general };
}
