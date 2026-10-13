import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
export const directAhsReviewSchema = z.object({ reviewNotes: text(4000) }).strict();
export const directAhsDecisionSchema = z.object({
  state: z.enum(["approved", "denied"]),
  code: text(50),
  notes: text(12000),
  authorizedAmount: z.number().finite().nonnegative().max(1000000).multipleOf(0.01).optional(),
}).strict();
export const directAhsSmsSchema = z.object({
  status: z.enum(["pending", "sent", "delivered", "failed"]),
  recipient: z.string().regex(/^\+[1-9]\d{7,14}$/),
  providerMessageId: text(200).optional(),
  body: text(2000).optional(),
  reason: text(1000).optional(),
}).strict().superRefine((sms, ctx) => {
  if (["sent", "delivered"].includes(sms.status) && (!sms.providerMessageId || !sms.body)) {
    ctx.addIssue({ code: "custom", message: "SMS providerMessageId and body are required for sent/delivered", path: ["providerMessageId"] });
  }
});
export const directAhsResultSchema = z.object({
  version: z.literal(1),
  source: z.literal("vrs_express_direct_ahs"),
  requestId: z.string().uuid(),
  submissionId: z.number().int().positive(),
  eventId: text(100),
  sequence: z.number().int().positive().max(2147483647),
  callId: text(100),
  serviceOrder: z.string().regex(/^(?:\d{8}|\d{12}|\d{4}-\d{8})$/),
  technicianId: text(50),
  occurredAt: z.string().datetime({ offset: true }),
  outcome: z.enum(["decision", "failed"]),
  decision: directAhsDecisionSchema.optional(),
  sms: directAhsSmsSchema.optional(),
  failureReason: text(2000).optional(),
}).strict().superRefine((event, ctx) => {
  if (event.outcome === "decision" && (!event.decision || !event.sms || event.failureReason)) {
    ctx.addIssue({ code: "custom", message: "Decision events require decision and SMS, and cannot include failureReason" });
  }
  if (event.outcome === "failed" && (!event.failureReason || event.decision || event.sms)) {
    ctx.addIssue({ code: "custom", message: "Failure events require failureReason only" });
  }
  if (event.decision && event.sms && ["sent", "delivered"].includes(event.sms.status) && !event.sms.body?.includes(event.decision.code)) {
    ctx.addIssue({ code: "custom", message: "The sent SMS must contain the AHS decision code", path: ["sms", "body"] });
  }
});
export type DirectAhsResult = z.infer<typeof directAhsResultSchema>;
export type DirectAhsDecision = z.infer<typeof directAhsDecisionSchema>;
export type DirectAhsSms = z.infer<typeof directAhsSmsSchema>;
export type DirectAhsState = "dispatching" | "awaiting_result" | "dispatch_unknown" | "awaiting_sms" | "failed" | "completed";
export interface DirectAhsPayload {
  version: 1;
  source: "vrs_express_direct_ahs";
  requestId: string;
  submissionId: number;
  serviceOrder: string;
  warranty: "american_home_shield";
  technician: { id: string; phone: string; name: string };
  applianceType: string;
  diagnosis: string;
  estimateAmount: string | null;
  partNumbers: string[];
  photoUrls: string[];
  videoUrl: string | null;
  voiceNoteUrl: string | null;
  review: { reviewerId: number; notes: string; approvedAt: string };
  callbackUrl: string;
  instructions: { smsOwner: "vrs_ai"; includeDecisionCodeInSms: true; womWrite: false };
}

export function normalizeIhPhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

/** WOM-ready data only. There is deliberately no WOM client or write action. */
export function prepareDirectAhsWomNotes(payload: DirectAhsPayload, event: DirectAhsResult) {
  return {
    version: 1, source: payload.source, requestId: payload.requestId,
    submissionId: payload.submissionId, serviceOrder: payload.serviceOrder,
    technicianId: payload.technician.id, reviewerId: payload.review.reviewerId,
    reviewNotes: payload.review.notes, callId: event.callId,
    decision: event.decision ?? null, sms: event.sms ?? null,
    occurredAt: event.occurredAt, womWriteStatus: "not_requested",
  };
}
