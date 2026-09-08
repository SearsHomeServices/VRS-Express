import { timingSafeEqual } from "crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";

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
// It does NOT write the event ledger and does NOT forward anything to SASHA.
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
export interface VrsAiCallResultCandidate {
  submissionId: number;
  serviceOrder: string;
  ticketStatus: string;
  authCode: string | null;
  technicianLdapId: string | null;
  createdAt: Date | null;
  // True when this ticket was reached through the bridge row for the call id
  // (vrs_ai_calls.provider_call_id / call_id). That link is authoritative and
  // wins over every service-order heuristic below.
  linkedByCallId?: boolean;
}

export type CloseVrsAiTicketOutcome =
  | { kind: "closed"; ticketStatus: string; authCode: string | null }
  | { kind: "failed"; status: number; message: string };

export interface VrsAiCallResultDependencies {
  apiKey?: string;
  loadTicketCandidates(input: {
    callId: string;
    soNo: string;
    techId: string;
  }): Promise<readonly VrsAiCallResultCandidate[]>;
  closeTicket(input: {
    ticket: VrsAiCallResultCandidate;
    result: VrsAiCallResult;
  }): Promise<CloseVrsAiTicketOutcome>;
}

function normalizeTechId(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Pick the Express ticket a call result belongs to.
 *
 * 1. A bridge-linked ticket (matched on the call id) always wins.
 * 2. `techId` narrows the service-order matches when it matches at least one
 *    of them. It is a hint, not a hard filter — roster casing/format can drift
 *    between VRS AI and the Express roster, and dropping every candidate over
 *    that would strand a legitimate close.
 * 3. Prefer a `pending` ticket, since that is the only closable state.
 * 4. Otherwise return the newest candidate so the caller can report the real
 *    reason it is not closable (already completed, still queued, ...).
 */
export function selectVrsAiCallResultTicket(
  candidates: readonly VrsAiCallResultCandidate[],
  techId: string,
): VrsAiCallResultCandidate | undefined {
  if (candidates.length === 0) return undefined;

  const linked = candidates.find((candidate) => candidate.linkedByCallId);
  if (linked) return linked;

  const wantedTech = normalizeTechId(techId);
  const techMatches = candidates.filter(
    (candidate) => normalizeTechId(candidate.technicianLdapId) === wantedTech,
  );
  const pool = techMatches.length > 0 ? techMatches : candidates;

  const newestFirst = [...pool].sort(
    (left, right) =>
      (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0),
  );

  return (
    newestFirst.find((candidate) => candidate.ticketStatus === "pending") ??
    newestFirst[0]
  );
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

    let candidates: readonly VrsAiCallResultCandidate[];
    try {
      candidates = await deps.loadTicketCandidates({
        callId: result.callId,
        soNo: result.soNo,
        techId: result.techId,
      });
    } catch (error) {
      console.error(
        "[vrs-ai-call-result] Failed to load ticket candidates:",
        error instanceof Error ? error.message : String(error),
      );
      return res.status(500).json({
        error: "INTERNAL",
        message: "Unable to load the ticket for this call result",
      });
    }

    const ticket = selectVrsAiCallResultTicket(candidates, result.techId);
    if (!ticket) {
      return res.status(404).json({
        error: "TICKET_NOT_FOUND",
        message: `No VRS Express ticket was found for service order ${result.soNo}`,
        call_id: result.callId,
        event_id: result.eventId,
      });
    }

    // Idempotent replay: this exact approval already closed the ticket. A
    // retry from VRS AI must not re-approve or re-text the technician.
    const alreadyClosed =
      ticket.ticketStatus === "completed" &&
      ticket.authCode === result.authNumber;
    if (alreadyClosed) {
      return res.status(200).json({
        ok: true,
        closed: false,
        deduped: true,
        submission_id: ticket.submissionId,
        service_order: ticket.serviceOrder,
        ticket_status: ticket.ticketStatus,
        auth_number: result.authNumber,
        call_id: result.callId,
        event_id: result.eventId,
      });
    }

    // `pending` is the only state the ticket process path will close. Anything
    // else is reported as-is rather than forced.
    if (ticket.ticketStatus !== "pending") {
      return res.status(409).json({
        error: "TICKET_NOT_CLOSABLE",
        message: `Ticket ${ticket.submissionId} for service order ${ticket.serviceOrder} is "${ticket.ticketStatus}", not "pending", so it cannot be closed by this call result.`,
        submission_id: ticket.submissionId,
        ticket_status: ticket.ticketStatus,
        call_id: result.callId,
        event_id: result.eventId,
      });
    }

    let outcome: CloseVrsAiTicketOutcome;
    try {
      outcome = await deps.closeTicket({ ticket, result });
    } catch (error) {
      console.error(
        "[vrs-ai-call-result] Failed to close ticket:",
        error instanceof Error ? error.message : String(error),
      );
      return res.status(500).json({
        error: "INTERNAL",
        message: "Unable to close the ticket for this call result",
      });
    }

    if (outcome.kind === "failed") {
      return res.status(outcome.status).json({
        error: "TICKET_CLOSE_FAILED",
        message: outcome.message,
        submission_id: ticket.submissionId,
        call_id: result.callId,
        event_id: result.eventId,
      });
    }

    return res.status(200).json({
      ok: true,
      closed: true,
      deduped: false,
      submission_id: ticket.submissionId,
      service_order: ticket.serviceOrder,
      ticket_status: outcome.ticketStatus,
      auth_number: outcome.authCode,
      call_id: result.callId,
      event_id: result.eventId,
    });
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
    `Part ${result.partId} — ${result.partDescription}.`,
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
