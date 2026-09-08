import { createHash } from "crypto";

export class VrsCallbackError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
  }
}

export function callbackFingerprint(value: unknown): string {
  const canonical = (input: any): any => Array.isArray(input)
    ? input.map(canonical)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])]))
      : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export const normalizeCallbackTech = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();
export const bareCallbackOrder = (value: string) => /^(?:\d{4}-)?(\d{8})$/.exec(value)?.[1];

export interface AutomatedApprovalTicket {
  serviceOrder: string;
  technicianLdapId?: string | null;
  requestType?: string;
  submissionApproved?: boolean | null;
  stage1Status?: string | null;
  warrantyProvider?: string | null;
  warrantyType?: string | null;
  partNumbers?: string | null;
  createdAt?: Date | null;
}

export function validateAutomatedApproval(
  ticket: AutomatedApprovalTicket,
  result?: { soNo: string; techId?: string; partId?: string; occurredAt: string },
): void {
  if (result && bareCallbackOrder(ticket.serviceOrder) !== result.soNo) {
    throw new VrsCallbackError("CALL_ORDER_MISMATCH", "The call and ticket must belong to the supplied service order.");
  }
  if (result?.techId && normalizeCallbackTech(ticket.technicianLdapId) !== normalizeCallbackTech(result.techId)) {
    throw new VrsCallbackError("TECHNICIAN_MISMATCH", "The result technician does not match the ticket technician.");
  }
  if (ticket.requestType !== "authorization") {
    throw new VrsCallbackError("WRONG_WORKFLOW", "Automated authorization results cannot process NLA or other ticket workflows.");
  }
  const warranty = (ticket.warrantyProvider || ticket.warrantyType || "").toLowerCase().replace(/_/g, " ");
  if (!["american home shield", "ahs", "first american"].some(name => warranty.includes(name))) {
    throw new VrsCallbackError("WRONG_WARRANTY", "This ticket does not use the external authorization workflow.");
  }
  if (ticket.submissionApproved !== true && ticket.stage1Status !== "approved") {
    throw new VrsCallbackError("HUMAN_REVIEW_REQUIRED", "A human must approve Stage 1 before an automated result can close this ticket.");
  }
  if (result && ticket.createdAt && new Date(result.occurredAt).getTime() < ticket.createdAt.getTime()) {
    throw new VrsCallbackError("RESULT_PREDATES_TICKET", "The call result predates the selected ticket.");
  }
  if (result?.partId && ticket.partNumbers) {
    let parts: unknown;
    try { parts = JSON.parse(ticket.partNumbers); }
    catch { throw new VrsCallbackError("PART_CONTEXT_INVALID", "Ticket part data must be reviewed before applying this result."); }
    const list = Array.isArray(parts) ? parts : parts && typeof parts === "object" &&
      (Array.isArray((parts as any).nla) || Array.isArray((parts as any).available))
      ? [...((parts as any).nla ?? []), ...((parts as any).available ?? [])] : null;
    if (!list || list.some(part => typeof part !== "string")) throw new VrsCallbackError("PART_CONTEXT_INVALID", "Ticket part data must be reviewed before applying this result.");
    if (list.length && !list.some(part =>
      part.trim().toUpperCase() === result.partId!.trim().toUpperCase())) {
      throw new VrsCallbackError("PART_MISMATCH", "The result part is not listed on this ticket.");
    }
  }
}

// Only trusted server-created requests receive this context. A public JSON body
// cannot opt into automation privileges or bypass the normal agent workflow.
export interface AutomatedCallbackContext {
  event: { eventId: string; soNo: string; occurredAt: string; techId?: string; partId?: string };
  notification?: { status: "accepted" | "failed" | "unknown"; message?: string; notificationId?: number };
}
export const automatedCallbackContexts = new WeakMap<object, AutomatedCallbackContext>();
