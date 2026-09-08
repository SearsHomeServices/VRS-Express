import { timingSafeEqual } from "crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { bareCallbackOrder, normalizeCallbackTech, validateAutomatedApproval, VrsCallbackError, type AutomatedApprovalTicket } from "./vrs-callback-safety";
import type { DirectResultReceipts, DirectResultBinding, DirectResultResponse } from "./vrs-direct-result-store";

// ============================================================================
// VRS AI CALL RESULT — close an Express ticket from a VRS AI call outcome
// ============================================================================
// POST /api/integrations/vrs-ai/v1/call-result
//
// This is a DIRECT close route, deliberately separate from the signed partner
// webhook at POST /api/integrations/vrs-ai/v1/webhook:
//
//   • /webhook is the documented V5/V8/V9 partner contract. It is HMAC-signed,
//     strict (unknown keys are rejected), writes the vrs_ai_call_events ledger,
//     and forwards the signed result upstream to SASHA. Leave it alone.
//   • This route accepts the richer call-result payload VRS AI emits for a
//     completed approval — the same approved-event envelope PLUS the part and
//     technician fields (partId, partDescription, techId) — resolves the
//     corresponding Express ticket, and closes it.
//
// It writes a separate direct-result receipt and does NOT forward anything to SASHA.
// Use /webhook when the upstream partner hop is required.
//
// Auth is the same X-API-Key VRS AI already presents on inbound authorize and
// on the service-order lookup route (VRS_SASHA_API_KEY). No new secret.
// ============================================================================

const requiredText = (field: string, max: number) =>
  z.string().trim().min(1, `${field} is required`).max(max);

// Mirrors the `money` rule in vrs-sasha-contract.ts. Kept local so this module
// stays free of DB/contract coupling and can be unit-tested standalone; if the
// contract's money rule changes, change it here too.
const money = z
  .number()
  .finite()
  .nonnegative()
  .max(1_000_000)
  .multipleOf(0.01, "USD amounts must have at most two decimal places");

export const vrsAiCallResultSchema = z
  .object({
    version: z.literal(1),
    eventId: requiredText("eventId", 100),
    callId: requiredText("callId", 100),
    submissionId: z.number().int().positive().optional(),
    soNo: z.string().regex(/^\d{8}$/, "soNo must be 8 digits"),
    occurredAt: z.string().datetime({ offset: true }),
    state: z.literal("approved"),
    authNumber: requiredText("authNumber", 100),
    authorizedAmount: money,
    partId: requiredText("partId", 100),
    techId: requiredText("techId", 50),
    partDescription: requiredText("partDescription", 500),
    durationSec: z.number().int().nonnegative().optional(),
    recordingUrl: z.string().url().optional(),
  })
  .strict();

export type VrsAiCallResult = z.infer<typeof vrsAiCallResultSchema>;

// One Express ticket that could correspond to an incoming call result.
export interface VrsAiCallResultCandidate extends AutomatedApprovalTicket {
  submissionId: number;
  serviceOrder: string;
  ticketStatus: string;
  authCode: string | null;
  agentNotes?: string | null;
  technicianLdapId: string | null;
  createdAt: Date | null;
  // True when this ticket was reached through the bridge row for the call id
  // (vrs_ai_calls.provider_call_id / call_id). That link is authoritative and
  // wins over every service-order heuristic below.
  linkedByCallId?: boolean;
}

export type CloseVrsAiTicketOutcome =
  | { kind: "closed"; ticketStatus: string; authCode: string | null; notification?: {status: "accepted" | "failed" | "unknown"; message?: string; notificationId?: number} }
  | { kind: "failed"; status: number; message: string };

export interface VrsAiCallResultDependencies {
  apiKey?: string;
  enabled?: () => boolean;
  receipts: DirectResultReceipts;
  loadTicketCandidates(input: {
    callId: string;
    soNo: string;
    techId: string;
    boundSubmissionId?: number;
  }): Promise<readonly VrsAiCallResultCandidate[]>;
  closeTicket(input: {
    ticket: VrsAiCallResultCandidate;
    result: VrsAiCallResult;
  }): Promise<CloseVrsAiTicketOutcome>;
}

function normalizeTechId(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Only an exact, unique identity can choose a ticket; never guess by status or age. */
export function selectVrsAiCallResultTicket(
  candidates: readonly VrsAiCallResultCandidate[], techId: string, soNo?: string,
): VrsAiCallResultCandidate | undefined {
  if (!candidates.length) return undefined;
  const linked = candidates.filter(candidate => candidate.linkedByCallId);
  if (linked.length > 1) throw new VrsCallbackError("AMBIGUOUS_TICKET", "More than one ticket is linked to this call.");
  if (linked.length) {
    if (soNo && bareCallbackOrder(linked[0].serviceOrder) !== soNo) throw new VrsCallbackError("CALL_ORDER_MISMATCH", "The call does not belong to the supplied order.");
    if (normalizeCallbackTech(linked[0].technicianLdapId) !== normalizeCallbackTech(techId)) throw new VrsCallbackError("TECHNICIAN_MISMATCH", "The call does not belong to the supplied technician.");
    return linked[0];
  }
  const matching = candidates.filter(candidate =>
    normalizeCallbackTech(candidate.technicianLdapId) === normalizeCallbackTech(techId) &&
    (!soNo || bareCallbackOrder(candidate.serviceOrder) === soNo));
  if (!matching.length) throw new VrsCallbackError("TECHNICIAN_MISMATCH", "No ticket matches this order and technician.");
  if (matching.length !== 1) throw new VrsCallbackError("AMBIGUOUS_TICKET", "Multiple tickets match. Supply submissionId or a correctly linked call; no ticket was changed.");
  return matching[0];
}

function authenticateVrsAiCallResultApiKey(
  req: Request,
  res: Response,
  apiKey?: string,
): boolean {
  if (!apiKey) {
    res.status(503).json({
      error: "NOT_CONFIGURED",
      message: "VRS AI call-result API key is not configured",
    });
    return false;
  }

  const presented = req.header("x-api-key") ?? "";
  const expectedBuffer = Buffer.from(apiKey);
  const presentedBuffer = Buffer.from(presented);
  const authenticated =
    expectedBuffer.length === presentedBuffer.length &&
    timingSafeEqual(expectedBuffer, presentedBuffer);

  if (!authenticated) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Invalid or missing API key",
    });
    return false;
  }

  return true;
}

export function registerVrsAiCallResultApi(
  app: Express,
  deps: VrsAiCallResultDependencies,
): void {
  app.get("/api/integrations/vrs-ai/v1/call-results/:eventId", async (req,res) => {
    if (!authenticateVrsAiCallResultApiKey(req,res,deps.apiKey)) return;
    const eventId=String(req.params.eventId);
    if (!eventId || eventId.length>100) return res.status(400).json({error:"INVALID_EVENT_ID"});
    try {
      if (!deps.receipts?.getStatus) return res.status(503).json({error:"RECEIPTS_NOT_READY"});
      const receipt=await deps.receipts.getStatus(eventId);
      return receipt ? res.json(receipt) : res.status(404).json({error:"EVENT_NOT_FOUND"});
    } catch { return res.status(503).json({error:"RECEIPTS_NOT_READY"}); }
  });
  app.post("/api/integrations/vrs-ai/v1/call-result", async (req, res) => {
    if (!authenticateVrsAiCallResultApiKey(req, res, deps.apiKey)) {
      return;
    }

    const parsed = vrsAiCallResultSchema.safeParse(req.body);
    if (!parsed.success) {
      // Name the offending keys so a partner can fix the payload from the
      // response alone. A strict-mode rejection reports the unrecognized keys
      // on the object root rather than on a path, so pull them out explicitly
      // instead of collapsing the whole thing to "body".
      const fields = Array.from(
        new Set(
          parsed.error.issues.flatMap((issue) =>
            issue.code === z.ZodIssueCode.unrecognized_keys
              ? issue.keys.map(String)
              : [issue.path.length > 0 ? String(issue.path[0]) : "body"],
          ),
        ),
      );
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid request body",
        fields,
      });
    }

    const result = parsed.data;
    if (deps.enabled && !deps.enabled()) return res.status(503).json({error:"CALL_RESULT_DISABLED",message:"Direct call results are paused. Retry the same event after activation."});
    try {
      if (!deps.receipts) throw new VrsCallbackError("RECEIPTS_NOT_READY", "Durable callback receipts are not configured.", 503);
      const response = await deps.receipts.execute(result, async (binding: DirectResultBinding): Promise<DirectResultResponse> => {
        const candidates = await deps.loadTicketCandidates({callId:result.callId,soNo:result.soNo,techId:result.techId,boundSubmissionId:binding.submissionId ?? result.submissionId});
        const ticket = selectVrsAiCallResultTicket(candidates, result.techId, result.soNo);
        if (!ticket) return {status:404,body:{error:"TICKET_NOT_FOUND",message:`No ticket matches service order ${result.soNo} and the callback identity.`,call_id:result.callId,event_id:result.eventId}};
        validateAutomatedApproval(ticket, result);
        const alreadyBound = binding.submissionId === ticket.submissionId;
        if (binding.submissionId !== null && !alreadyBound) throw new VrsCallbackError("TICKET_BINDING_CONFLICT", "This event is bound to another ticket.");
        const responseBody = (closed: boolean, authCode: string | null, notification?: unknown) => ({ok:true,closed,deduped:!closed,submission_id:ticket.submissionId,service_order:ticket.serviceOrder,ticket_status:"completed",auth_number:authCode,call_id:result.callId,event_id:result.eventId,...(notification?{notification}:{})});
        if (ticket.ticketStatus === "completed" && alreadyBound && ticket.authCode === result.authNumber && ticket.agentNotes?.includes(buildVrsAiCallResultAgentNotes(result))) {
          return {status:200,body:responseBody(false,ticket.authCode,{status:"unknown",message:"Ticket was already applied; notification was not repeated."})};
        }
        if (ticket.ticketStatus !== "pending") return {status:409,body:{error:"TICKET_NOT_CLOSABLE",message:`Ticket ${ticket.submissionId} is ${ticket.ticketStatus}; no approval was applied.`,submission_id:ticket.submissionId,ticket_status:ticket.ticketStatus,call_id:result.callId,event_id:result.eventId}};
        await binding.bind(ticket.submissionId);
        const outcome = await deps.closeTicket({ticket,result});
        if (outcome.kind === "failed") return {status:outcome.status,body:{error:"TICKET_CLOSE_FAILED",message:outcome.message,submission_id:ticket.submissionId,call_id:result.callId,event_id:result.eventId}};
        if (outcome.ticketStatus !== "completed" || outcome.authCode !== result.authNumber) throw new VrsCallbackError("UNEXPECTED_CLOSE_RESULT", "Ticket outcome does not match this authorization; operator review is required.");
        return {status:200,body:responseBody(true,outcome.authCode,outcome.notification)};
      });
      return res.status(response.status).json(response.body);
    } catch (error) {
      if (error instanceof VrsCallbackError) return res.status(error.status).json({error:error.code,message:error.message,event_id:result.eventId,call_id:result.callId});
      console.error("[vrs-ai-call-result] Callback failed:",error instanceof Error?error.message:String(error));
      return res.status(500).json({error:"INTERNAL",message:"Unable to apply the call result. Retry the same event unchanged."});
    }
  });
}

/**
 * Audit line written to the ticket's agent notes. Carries the fields that have
 * no column of their own (part id/description, tech id, duration, recording)
 * so the approval is fully reconstructable from the ticket alone.
 */
export function buildVrsAiCallResultAgentNotes(
  result: VrsAiCallResult,
): string {
  const parts = [
    `VRS AI approved $${result.authorizedAmount.toFixed(2)} (auth ${result.authNumber}, event ${result.eventId}, call ${result.callId}).`,
    `Part ${result.partId}: ${result.partDescription}.`,
    `Tech ${result.techId}.`,
  ];
  if (typeof result.durationSec === "number") {
    parts.push(`Call duration ${result.durationSec}s.`);
  }
  if (result.recordingUrl) {
    parts.push(`Recording: ${result.recordingUrl}`);
  }
  return parts.join(" ");
}
