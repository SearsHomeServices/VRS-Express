// Technician-submitted AHS tickets → VRS AI bridge enrollment.
//
// SASHA-originated AHS calls get a vrs_ai_calls row at intake
// (vrs-sasha-intake.ts), which is what routes Stage 1 approval through
// "Approve & Send to VRS AI". Technicians also post AHS calls straight into
// VRS Express (POST /api/submissions, or the external v1 API); those tickets
// never touched SASHA and previously had no bridge row, so they could never
// reach VRS AI. This module gives them the same durable row at creation.
//
// Nothing is sent to VRS AI here. Dispatch still happens only when a human
// agent approves Stage 1, exactly like a SASHA ticket.
//
// The app form captures far less than the VRS AI contract: no customer,
// address, model/serial, parts, or price breakdown (those live in the
// technician's model/serial-tag and TechHub-estimate photos). The payload
// uses the V9 contract's own placeholders where it has them ("N/A", "",
// "TBD") and zero amounts otherwise, and says so in a comment for VRS AI.
// Photos are attached at dispatch by the existing enrichment step.
import type { Submission } from "@shared/schema";
import {
  safeParseVrsOutboundSourceRequest,
  type VrsAuthorizeV9Request,
} from "./vrs-sasha-contract";
import {
  VRS_APP_ORIGIN_CALLBACK_URL,
  type VrsStoredAuthorizeRequest,
} from "./vrs-sasha-queue";
import type { NewVrsBridgeIntake, VrsBridgeIntakeStore } from "./vrs-sasha-store";

const APPLIANCE_LABELS: Record<string, string> = {
  cooking: "Cooking",
  dishwasher: "Dishwasher",
  microwave: "Microwave",
  laundry: "Laundry",
  refrigeration: "Refrigeration",
  hvac: "HVAC",
  all_other: "Other appliance",
};

export const APP_ORIGIN_VRS_COMMENT =
  "Submitted directly in VRS Express by the technician (not via SASHA). " +
  "Customer, model/serial, parts and pricing were not entered as fields; " +
  "use the attached model/serial tag and TechHub estimate photos, or look up " +
  "the service order.";

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
  | "applianceType"
  | "requestType"
  | "warrantyType"
  | "ticketStatus"
  | "issueDescription"
  | "phone"
  | "phoneOverride"
  | "technicianLdapId"
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
  const techName = (technician.name ?? "").trim().slice(0, 255);
  const description = submission.issueDescription.trim() || "Authorization review requested";
  const district = submission.districtCode && /^\d{4}$/.test(submission.districtCode)
    ? submission.districtCode
    : "N/A";
  const occurredAt = (submission.createdAt ?? new Date()).toISOString();

  const payload: VrsAuthorizeV9Request = {
    service_order: serviceOrder,
    tech_id: techId,
    tech_phone: toE164UsPhone(submission.phoneOverride || submission.phone) ?? "N/A",
    tech_name: techName,
    reason_for_call: "authorization",
    callback_url: VALIDATION_CALLBACK_URL,
    callback_secret: VALIDATION_CALLBACK_SECRET,
    parts: [
      {
        part_id: "N/A",
        part_description: "Not entered in VRS Express; see TechHub estimate photo",
        sell_price: 0,
        part_function: "",
      },
    ],
    customer_name: "",
    customer_address: "N/A",
    service_address: "N/A",
    brand: "N/A",
    model_number: "N/A",
    serial_number: "N/A",
    appliance_type: APPLIANCE_LABELS[submission.applianceType] ?? "Other appliance",
    appliance_age: 0,
    labor_amount: 0,
    tax_amount: 0,
    part_price: 0,
    appliance_location: "N/A",
    failure_cause: "other",
    tech_recommendation: "repair",
    repair_replace_rationale: description,
    appliance_grade: "N/A",
    partner_id: "ahs",
    appliance_photos: [],
    comments: [
      {
        tech_id: techId,
        work_item: "failure_diagnosis",
        text: description.slice(0, 2_000),
        timestamp: occurredAt,
      },
      {
        tech_id: techId,
        work_item: "other",
        text: APP_ORIGIN_VRS_COMMENT,
        timestamp: occurredAt,
      },
    ],
    appliance_color: "N/A",
    contract_number: "N/A",
    purchase_year: "N/A",
    symptom: description,
    cta_no: "N/A",
    district_number: district,
  };

  const checked = safeParseVrsOutboundSourceRequest(payload);
  if (!checked.success || checked.version !== "v9") {
    const fields = checked.success
      ? "contract version"
      : checked.error.issues.map((issue) => issue.path.join(".") || "body").join(", ");
    return { ok: false, reason: `payload failed V9 validation: ${fields}` };
  }

  const { callback_secret: _secret, ...stored } = payload;
  return {
    ok: true,
    payload: { ...stored, callback_url: VRS_APP_ORIGIN_CALLBACK_URL },
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
