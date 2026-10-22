// Technician-submitted AHS tickets → VRS AI bridge enrollment.
//
// SASHA-originated AHS calls get a vrs_ai_calls row at intake
// (vrs-sasha-intake.ts), which is what routes Stage 1 approval through
// "Approve & Send to VRS AI". Technicians also post AHS calls straight into
// VRS Express (POST /api/submissions); those tickets never touched SASHA and
// previously had no bridge row, so they could never reach VRS AI. This
// module gives them the same durable row at creation.
//
// Nothing is sent to VRS AI here. Dispatch still happens only when a human
// agent approves Stage 1, exactly like a SASHA ticket.
//
// The payload is built from the AHS details the technician entered on the
// form (submissions.ahs_details, shared/ahs-details.ts). A ticket without
// them is not enrolled and keeps the manual Stage 1 flow. Part quantity and
// failure reason have no contract field: quantity goes into the part
// description (with the price multiplied out) and failure reasons into the
// technician comments. Photos are attached at dispatch by the existing
// enrichment step.
//
// Most AHS fields are optional on the tech form. A value the tech left
// blank (and the server could not fill from the service order) is sent as
// "" (appliance_age is omitted), never "N/A": VRS AI reads "" as unknown
// and confirms it with AHS, but would speak "N/A" aloud. The payload is
// validated with the app-origin V9 rules (safeParseVrsAppOriginOutboundRequest).
import type { Submission } from "@shared/schema";
import {
  ahsApplianceKind,
  ahsPartLineTotal,
  ahsPartsTotal,
  parseStoredAhsDetails,
} from "@shared/ahs-details";
import {
  safeParseVrsAppOriginOutboundRequest,
  type VrsAuthorizeV9AppOriginRequest,
} from "./vrs-sasha-contract";
import {
  VRS_APP_ORIGIN_CALLBACK_URL,
  type VrsStoredAuthorizeRequest,
} from "./vrs-sasha-queue";
import type { NewVrsBridgeIntake, VrsBridgeIntakeStore } from "./vrs-sasha-store";

export const APP_ORIGIN_VRS_COMMENT =
  "Submitted directly in VRS Express by the technician (not via SASHA).";

// Only used to prove the stored payload will pass dispatch revalidation; the
// real Express webhook URL and secret are substituted at dispatch time.
const VALIDATION_CALLBACK_URL =
  "https://vrs-express.invalid/api/integrations/vrs-ai/v1/webhook";
const VALIDATION_CALLBACK_SECRET = "app-enroll-validation-only";

export type AppVrsAiEnrollSubmission = Pick<
  Submission,
  | "id"
  | "serviceOrder"
  | "districtCode"
  | "requestType"
  | "warrantyType"
  | "ticketStatus"
  | "issueDescription"
  | "phone"
  | "phoneOverride"
  | "technicianLdapId"
  | "ahsDetails"
  | "createdAt"
>;

export interface AppVrsAiEnrollTechnician {
  name?: string | null;
  racId?: string | null;
}

export function toE164UsPhone(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function isAppVrsAiEnrollEligible(
  submission: Pick<AppVrsAiEnrollSubmission, "warrantyType" | "requestType" | "ticketStatus">,
): boolean {
  return (
    submission.warrantyType === "american_home_shield" &&
    submission.requestType === "authorization" &&
    submission.ticketStatus === "queued"
  );
}

export type AppVrsAiPayloadResult =
  | {
      ok: true;
      payload: VrsStoredAuthorizeRequest;
      serviceOrder: string;
      techId: string;
      techPhone: string;
      techName: string;
    }
  | { ok: false; reason: string };

export function buildAppVrsAuthorizePayload(
  submission: AppVrsAiEnrollSubmission,
  technician: AppVrsAiEnrollTechnician,
): AppVrsAiPayloadResult {
  const serviceOrder = /^(?:\d{4}-)?(\d{8})$/.exec(submission.serviceOrder)?.[1];
  if (!serviceOrder) {
    return { ok: false, reason: `service order ${submission.serviceOrder} has no 8-digit order number` };
  }
  const techId = (submission.technicianLdapId || technician.racId || "").trim();
  if (!techId || techId.length > 50) {
    return { ok: false, reason: "ticket has no usable technician id" };
  }
  const details = parseStoredAhsDetails(submission.ahsDetails);
  if (!details) {
    return { ok: false, reason: "AHS details were not entered" };
  }

  const techName = (technician.name ?? "").trim().slice(0, 255);
  const description = submission.issueDescription.trim() || "Authorization review requested";
  const district = submission.districtCode && /^\d{4}$/.test(submission.districtCode)
    ? submission.districtCode
    : "N/A";
  const occurredAt = (submission.createdAt ?? new Date()).toISOString();

  const customerAddress = details.customerAddress ?? "";
  const contractNumber = details.contractNumber ?? "";
  const payload: VrsAuthorizeV9AppOriginRequest = {
    service_order: serviceOrder,
    tech_id: techId,
    tech_phone: toE164UsPhone(submission.phoneOverride || submission.phone) ?? "N/A",
    tech_name: techName,
    reason_for_call: "authorization",
    callback_url: VALIDATION_CALLBACK_URL,
    callback_secret: VALIDATION_CALLBACK_SECRET,
    parts: details.parts.map((part) => ({
      part_id: part.partNumber,
      part_description: part.quantity > 1
        ? `${part.description} (qty ${part.quantity})`
        : part.description,
      sell_price: ahsPartLineTotal(part),
      part_function: part.partFunction ?? "",
    })),
    customer_name: details.customerName ?? "",
    customer_address: customerAddress,
    service_address: customerAddress,
    brand: details.brand ?? "",
    model_number: details.modelNumber ?? "",
    serial_number: details.serialNumber ?? "",
    appliance_type: ahsApplianceKind(details.applianceKind)?.label ?? details.applianceKind,
    ...(details.applianceAge === undefined ? {} : { appliance_age: details.applianceAge }),
    labor_amount: details.laborAmount,
    tax_amount: details.taxAmount,
    part_price: ahsPartsTotal(details),
    appliance_location: details.applianceLocation,
    failure_cause: details.failureCause,
    tech_recommendation: details.techRecommendation,
    repair_replace_rationale: description,
    appliance_grade: details.applianceGrade ?? "",
    partner_id: "ahs",
    appliance_photos: [],
    comments: [
      {
        tech_id: techId,
        work_item: "failure_diagnosis",
        text: description.slice(0, 2_000),
        timestamp: occurredAt,
      },
      ...details.parts.flatMap((part) => part.failureReason
        ? [{
          tech_id: techId,
          work_item: "failure_diagnosis" as const,
          text: `Part ${part.partNumber} (qty ${part.quantity}) failure reason: ${part.failureReason}`,
          timestamp: occurredAt,
        }]
        : []),
      {
        tech_id: techId,
        work_item: "other",
        text: APP_ORIGIN_VRS_COMMENT,
        timestamp: occurredAt,
      },
    ],
    appliance_color: details.applianceColor ?? "",
    contract_number: contractNumber,
    // Derived from the appliance age the tech entered, else the HSSOM
    // purchase year the server stored; "" when unknown.
    purchase_year:
      details.applianceAge === undefined
        ? details.purchaseYear ?? ""
        : (submission.createdAt ?? new Date()).getUTCFullYear() - details.applianceAge,
    symptom: description,
    cta_no: contractNumber,
    district_number: district,
  };

  const checked = safeParseVrsAppOriginOutboundRequest(payload);
  if (!checked.success || checked.version !== "v9") {
    const fields = checked.success
      ? "contract version"
      : checked.error.issues.map((issue) => issue.path.join(".") || "body").join(", ");
    return { ok: false, reason: `payload failed V9 validation: ${fields}` };
  }

  const { callback_secret: _secret, ...stored } = payload;
  return {
    ok: true,
    // Stored with the bridge's general payload type; dispatch revalidates
    // app-origin rows with the same app-origin rules used here.
    payload: {
      ...stored,
      callback_url: VRS_APP_ORIGIN_CALLBACK_URL,
    } as unknown as VrsStoredAuthorizeRequest,
    serviceOrder,
    techId,
    techPhone: (submission.phoneOverride || submission.phone || "").slice(0, 20),
    techName,
  };
}

export type AppVrsAiEnrollResult =
  | { kind: "enrolled"; callId: string }
  | { kind: "skipped"; reason: string }
  | { kind: "duplicate"; existingCallId: string; state: string }
  | { kind: "failed"; message: string };

export interface AppVrsAiEnrollDeps {
  store: Pick<VrsBridgeIntakeStore, "createIntake">;
  generateCallId(): string;
}

// Never throws: enrollment must not fail ticket creation. A ticket that
// isn't enrolled simply keeps the legacy manual Stage 1 flow.
export async function enrollAppSubmissionInVrsAi(
  deps: AppVrsAiEnrollDeps,
  submission: AppVrsAiEnrollSubmission,
  technician: AppVrsAiEnrollTechnician,
): Promise<AppVrsAiEnrollResult> {
  try {
    if (!isAppVrsAiEnrollEligible(submission)) {
      return { kind: "skipped", reason: "not a queued AHS authorization ticket" };
    }
    const built = buildAppVrsAuthorizePayload(submission, technician);
    if (!built.ok) return { kind: "skipped", reason: built.reason };

    const intake: NewVrsBridgeIntake = {
      submissionId: submission.id,
      callId: deps.generateCallId(),
      serviceOrder: built.serviceOrder,
      techId: built.techId,
      techPhone: built.techPhone,
      techName: built.techName,
      requestPayload: built.payload,
      callbackUrl: VRS_APP_ORIGIN_CALLBACK_URL,
      callbackSecretCipher: "",
      callbackSecretIv: "",
      callbackSecretAuthTag: "",
      callbackSecretSalt: "",
    };
    const stored = await deps.store.createIntake(intake, {
      supersedeClosedUndispatched: true,
    });
    if (stored.kind === "duplicate") {
      return {
        kind: "duplicate",
        existingCallId: stored.record.callId,
        state: stored.record.state,
      };
    }
    return { kind: "enrolled", callId: stored.record.callId };
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
