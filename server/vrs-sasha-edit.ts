// Stage 1 corrections to a SASHA request
// (PATCH /api/submissions/:id/vrs-ai-request, server/ahs-review-api.ts).
//
// SASHA's data is trusted as sent: nothing here fills, derives or reformats a
// value. The VRS agent, the one human step before VRS AI, may correct a value
// they disagree with. Only the fields they changed are replaced; everything
// else stays exactly as SASHA sent it. Only fields SASHA sent can be changed
// (nothing is added), and the result must pass the same contract check
// dispatch applies (dispatchVrsAiForSubmission revalidation).
import {
  getVrsAuthorizeContractVersion,
  safeParseVrsAuthorizeRequest,
} from "./vrs-sasha-contract";
import type { VrsStoredAuthorizeRequest } from "./vrs-sasha-queue";

// What VRS AI reads to the partner on the call. Not editable: service order,
// technician, partner, callback and photos. cta_no is the same number as
// contract_number (the V9 contract requires them equal), so it follows a
// contract_number correction instead of being edited on its own.
export const SASHA_EDITABLE_TEXT_FIELDS = [
  "contract_number", "customer_name", "customer_address", "service_address",
  "brand", "model_number", "serial_number", "appliance_type", "appliance_location",
  "appliance_grade", "appliance_color", "failure_cause", "tech_recommendation",
  "repair_replace_rationale", "symptom",
] as const;
export const SASHA_EDITABLE_NUMBER_FIELDS = ["appliance_age", "labor_amount", "tax_amount", "part_price"] as const;
export const SASHA_EDITABLE_PART_TEXT_FIELDS = ["part_id", "part_description", "part_function"] as const;
export const SASHA_EDITABLE_PART_NUMBER_FIELDS = ["sell_price"] as const;

export interface SashaRequestEdits {
  fields?: Record<string, unknown>;
  // index: the part's position in SASHA's parts list.
  parts?: Array<{ index: unknown } & Record<string, unknown>>;
}

export type SashaEditResult =
  | { ok: true; payload: VrsStoredAuthorizeRequest; changed: string[] }
  | { ok: false; error: string };

type Kind = "text" | "number";

function kindOf(name: string, text: readonly string[], number: readonly string[]): Kind | undefined {
  if (text.includes(name)) return "text";
  if (number.includes(name)) return "number";
  return undefined;
}

// The value to store, or an error. Text is kept as typed apart from the
// surrounding spaces the form adds; numbers must be finite and not negative.
function checked(name: string, kind: Kind, value: unknown): { value: string | number } | { error: string } {
  if (kind === "text") {
    return typeof value === "string" ? { value: value.trim() } : { error: `${name} must be text` };
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { value }
    : { error: `${name} must be a number of 0 or more` };
}

export function applySashaRequestEdits(stored: VrsStoredAuthorizeRequest, edits: SashaRequestEdits): SashaEditResult {
  const payload = structuredClone(stored) as unknown as Record<string, unknown>;
  const changed: string[] = [];

  for (const [name, raw] of Object.entries(edits.fields ?? {})) {
    const kind = kindOf(name, SASHA_EDITABLE_TEXT_FIELDS, SASHA_EDITABLE_NUMBER_FIELDS);
    if (!kind) return { ok: false, error: `${name} can't be changed here` };
    if (!(name in payload)) return { ok: false, error: `${name} was not in SASHA's request, so it can't be added` };
    const next = checked(name, kind, raw);
    if ("error" in next) return { ok: false, error: next.error };
    if (payload[name] === next.value) continue;
    payload[name] = next.value;
    changed.push(name);
  }

  const original = stored as unknown as Record<string, unknown>;
  if (changed.includes("contract_number") && "cta_no" in payload && original.cta_no === original.contract_number) {
    payload.cta_no = payload.contract_number;
    changed.push("cta_no");
  }

  const parts = Array.isArray(payload.parts) ? (payload.parts as Record<string, unknown>[]) : [];
  for (const edit of edits.parts ?? []) {
    const index = edit.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= parts.length) {
      return { ok: false, error: "A part edit points at a part SASHA did not send" };
    }
    for (const [name, raw] of Object.entries(edit)) {
      if (name === "index") continue;
      const label = `parts[${index}].${name}`;
      const kind = kindOf(name, SASHA_EDITABLE_PART_TEXT_FIELDS, SASHA_EDITABLE_PART_NUMBER_FIELDS);
      if (!kind) return { ok: false, error: `${label} can't be changed here` };
      if (!(name in parts[index])) return { ok: false, error: `${label} was not in SASHA's request, so it can't be added` };
      const next = checked(label, kind, raw);
      if ("error" in next) return { ok: false, error: next.error };
      if (parts[index][name] === next.value) continue;
      parts[index][name] = next.value;
      changed.push(label);
    }
  }

  if (!changed.length) return { ok: true, payload: stored, changed };
  // The check dispatch runs on the stored request (secret redacted there too).
  const result = safeParseVrsAuthorizeRequest({ ...payload, callback_secret: "stored-callback-secret-redacted" });
  if (!result.success || result.version !== getVrsAuthorizeContractVersion(stored as never)) {
    const fields = result.success
      ? "contract version"
      : result.error.issues.map((issue) => issue.path.join(".") || "body").join(", ");
    return { ok: false, error: `The corrected request is not valid for VRS AI: ${fields}` };
  }
  return { ok: true, payload: payload as unknown as VrsStoredAuthorizeRequest, changed };
}
