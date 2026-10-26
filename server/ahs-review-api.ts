// Stage 1 AHS review endpoints (contract: shared/ahs-review.ts).
//
// At submit the server stores what the service-order lookups found as a
// draft in submissions.ahs_details (POST /api/submissions, server/ahs-prefill.ts).
// The VRS manager completes it here:
//   PATCH /api/submissions/:id/ahs-details          validate, store, enroll
//   POST  /api/submissions/:id/ahs-details/refresh  re-run the lookups, fill blanks
// Enrollment creates the VRS AI bridge row (or replaces the payload of the
// ticket's undispatched one, server/vrs-app-enroll.ts); the existing
// "Approve & Send to VRS AI" Stage 1 action then dispatches it.
//
// Staff only. Responses carry the details (customer PII included) to the VRS
// manager; logs, notes and broadcasts carry ids and statuses, never values.
import type { Express, Request, RequestHandler, Response } from "express";
import type { Submission } from "@shared/schema";
import {
  ahsDetailsSchema,
  ahsGrandTotal,
  parseStoredAhsDetailsDraft,
  type AhsDetailsDraft,
} from "@shared/ahs-details";
import type { AhsReviewRefreshResponse, AhsReviewSaveResponse } from "@shared/ahs-review";
import { deriveWarrantyFromProcId } from "@shared/warranty";
import type { AuthenticatedRequest } from "./middleware/auth";
import {
  applyAhsSubmitPrefill,
  applySubmissionApplianceKind,
  mergeSavedAhsProvenance,
  prefilledFieldNames,
  type AhsPrefillSources,
} from "./ahs-prefill";
import {
  isAppVrsAiEnrollEligible,
  isUndispatchedVrsBridgeRecord,
  saveAppSubmissionVrsAiIntake,
  type AppVrsAiEnrollResult,
  type AppVrsAiIntakeSaveDeps,
} from "./vrs-app-enroll";
import { isAppOriginVrsBridgeRecord } from "./vrs-sasha-queue";

export const AHS_REVIEW_ROLES = ["vrs_agent", "admin", "super_admin"] as const;

export interface AhsReviewApiDeps {
  authenticateToken: RequestHandler;
  requireRole: (...roles: string[]) => RequestHandler;
  getSubmission(id: number): Promise<Submission | undefined>;
  // storage.updateSubmissionIfStatus: undefined when the ticket moved on or
  // (for a vrs_agent) was reassigned in the meantime.
  updateSubmissionIfStatus(
    id: number,
    expectedStatuses: string[],
    data: Partial<Submission>,
    expectedAssignedTo?: number,
  ): Promise<Submission | undefined>;
  getUser(id: number): Promise<{ name?: string | null; racId?: string | null } | undefined>;
  bridge: AppVrsAiIntakeSaveDeps;
  isEnrollEnabled(): boolean;
  // lookupAhsPrefillSources with the submit path's sources and flags;
  // bounded (~5s) and never rejects.
  lookupSources(serviceOrder: string): Promise<AhsPrefillSources>;
  createNote(note: {
    submissionId: number;
    authorId: number;
    authorRole: string;
    visibility: "staff_only";
    body: string;
  }): Promise<unknown>;
  // The ticket_updated event other Stage 1 edits send (admins only; no PII).
  broadcastTicketUpdated(submission: Submission): void;
}

type ReviewableTicket = { submission: Submission; user: NonNullable<AuthenticatedRequest["user"]> };

// The Stage 1 process route's access rules plus the AHS review conditions.
// Responds and returns null when the ticket can't be reviewed.
async function loadReviewableTicket(
  deps: AhsReviewApiDeps,
  req: Request,
  res: Response,
): Promise<ReviewableTicket | null> {
  const user = (req as AuthenticatedRequest).user!;
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || String(id) !== String(req.params.id)) {
    res.status(400).json({ ok: false, error: "Invalid submission ID" });
    return null;
  }
  const submission = await deps.getSubmission(id);
  if (!submission) {
    res.status(404).json({ ok: false, error: "Submission not found" });
    return null;
  }
  if (submission.assignedTo !== user.id && user.role !== "admin" && user.role !== "super_admin") {
    res.status(403).json({ ok: false, error: "This ticket is not assigned to you" });
    return null;
  }
  if (submission.requestType !== "authorization" || submission.warrantyType !== "american_home_shield") {
    res.status(400).json({ ok: false, error: "AHS details apply only to American Home Shield authorization tickets" });
    return null;
  }
  if (submission.ticketStatus !== "pending") {
    res.status(409).json({ ok: false, error: "Ticket must be in pending status to edit its AHS details" });
    return null;
  }
  if (submission.stage1Status !== "pending" || submission.submissionApproved) {
    res.status(409).json({ ok: false, error: "Stage 1 has already been decided for this ticket" });
    return null;
  }
  const bridge = await deps.bridge.store.getBySubmissionId(submission.id);
  if (bridge && !isAppOriginVrsBridgeRecord(bridge)) {
    res.status(409).json({ ok: false, error: "This ticket's VRS AI request came from SASHA and can't be edited here" });
    return null;
  }
  if (bridge && !isUndispatchedVrsBridgeRecord(bridge)) {
    res.status(409).json({ ok: false, error: "This ticket has already been sent to VRS AI" });
    return null;
  }
  return { submission, user };
}

function enrollSkipReason(result: AppVrsAiEnrollResult): string | undefined {
  switch (result.kind) {
    case "enrolled":
    case "replaced":
      return undefined;
    case "skipped":
      return result.reason;
    case "duplicate":
      return result.state === "dispatching"
        ? "This ticket is being sent to VRS AI"
        : "An active VRS AI call already exists for this service order";
    case "failed":
      return "VRS AI enrollment failed; save again to retry";
  }
}

// Writes the details back while the ticket is still pending (and, for a
// vrs_agent, still theirs). Undefined when that race was lost.
function storeDetails(
  deps: AhsReviewApiDeps,
  ticket: ReviewableTicket,
  data: Partial<Submission>,
): Promise<Submission | undefined> {
  return deps.updateSubmissionIfStatus(
    ticket.submission.id,
    ["pending"],
    { ...data, updatedAt: new Date() },
    ticket.user.role === "vrs_agent" ? ticket.user.id : undefined,
  );
}

async function enroll(deps: AhsReviewApiDeps, submission: Submission): Promise<AppVrsAiEnrollResult> {
  if (!deps.isEnrollEnabled()) return { kind: "skipped", reason: "VRS AI enrollment is turned off" };
  const technician = await deps.getUser(submission.technicianId);
  return saveAppSubmissionVrsAiIntake(deps.bridge, submission, technician ?? {});
}

function logEnrollment(submission: Submission, result: AppVrsAiEnrollResult): void {
  const prefix = `[ahs-review] submission=${submission.id} SO=${submission.serviceOrder}`;
  if (result.kind === "enrolled" || result.kind === "replaced") {
    console.log(`${prefix} ${result.kind} call=${result.callId}`);
  } else if (result.kind === "failed") {
    console.error(`${prefix} enrollment failed: ${result.message}`);
  } else if (result.kind === "duplicate") {
    console.warn(`${prefix} not enrolled: bridge call ${result.existingCallId} (${result.state})`);
  } else {
    console.warn(`${prefix} not enrolled: ${result.reason}`);
  }
}

const STALE_TICKET = {
  ok: false as const,
  error: "This ticket was already moved or reassigned. Please refresh and try again.",
};

export function registerAhsReviewApi(app: Express, deps: AhsReviewApiDeps): void {
  const guard = [deps.authenticateToken, deps.requireRole(...AHS_REVIEW_ROLES)];

  app.patch("/api/submissions/:id/ahs-details", ...guard, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const ticket = await loadReviewableTicket(deps, req, res);
      if (!ticket) return;

      // prefilledFields and purchaseYear are server-only; drop them before
      // validating so a stale client's values can neither fail nor stick.
      const sent = req.body?.ahsDetails;
      const parsed = ahsDetailsSchema.safeParse(
        sent && typeof sent === "object" && !Array.isArray(sent)
          ? { ...sent, prefilledFields: undefined, purchaseYear: undefined }
          : sent,
      );
      if (!parsed.success) {
        const body: AhsReviewSaveResponse = {
          ok: false,
          error: parsed.error.issues[0]?.message ?? "Invalid AHS details",
          issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        };
        return res.status(400).json(body);
      }

      const draft = parseStoredAhsDetailsDraft(ticket.submission.ahsDetails);
      const details = mergeSavedAhsProvenance(parsed.data, draft);
      // Agents see the total and part numbers in the usual places, as SASHA
      // tickets and the old tech-entered details did.
      const updated = await storeDetails(deps, ticket, {
        ahsDetails: JSON.stringify(details),
        estimateAmount: ahsGrandTotal(details).toFixed(2),
        partNumbers: JSON.stringify(details.parts.map((part) => part.partNumber)),
      });
      if (!updated) return res.status(409).json(STALE_TICKET);

      const result = await enroll(deps, updated);
      logEnrollment(updated, result);
      console.log(
        `[ahs-review] submission=${updated.id} details saved by user=${ticket.user.id} ` +
        `prefilled=${prefilledFieldNames(details).join(",") || "none"}`,
      );

      try {
        await deps.createNote({
          submissionId: updated.id,
          authorId: ticket.user.id,
          authorRole: ticket.user.role,
          visibility: "staff_only",
          body: `AHS details updated by ${ticket.user.name}`,
        });
      } catch (noteError) {
        console.error(`[ahs-review] audit note failed for submission ${updated.id}:`, noteError);
      }
      try {
        deps.broadcastTicketUpdated(updated);
      } catch (broadcastError) {
        console.error(`[ahs-review] broadcast failed for submission ${updated.id}:`, broadcastError);
      }

      const enrolled = result.kind === "enrolled" || result.kind === "replaced";
      const body: AhsReviewSaveResponse = {
        ok: true,
        ahsDetails: details,
        enrolled,
        ...(enrolled ? {} : { enrollSkipReason: enrollSkipReason(result) }),
      };
      return res.status(200).json(body);
    } catch (error) {
      console.error("[ahs-review] save error:", error instanceof Error ? error.message : String(error));
      return res.status(500).json({ ok: false, error: "Failed to save AHS details" });
    }
  });

  app.post("/api/submissions/:id/ahs-details/refresh", ...guard, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const ticket = await loadReviewableTicket(deps, req, res);
      if (!ticket) return;
      const { submission } = ticket;

      const stored: AhsDetailsDraft = parseStoredAhsDetailsDraft(submission.ahsDetails) ?? {};
      const sources = await deps.lookupSources(submission.serviceOrder);
      const refreshed = applySubmissionApplianceKind(
        applyAhsSubmitPrefill(stored, sources, {
          finalWarrantyType: submission.warrantyType,
          derivedWarrantyType: deriveWarrantyFromProcId(submission.procId, submission.clientNm)?.warrantyType,
        }),
        submission.applianceKind,
      );
      console.log(
        `[ahs-review] refresh submission=${submission.id} SO=${submission.serviceOrder} ` +
        `snowflake=${sources.snowflake.status} hssom=${sources.hssom.status} ` +
        `prefilled=${prefilledFieldNames(refreshed).join(",") || "none"}`,
      );

      if (JSON.stringify(refreshed) !== JSON.stringify(stored) || !submission.ahsDetails) {
        const updated = await storeDetails(deps, ticket, { ahsDetails: JSON.stringify(refreshed) });
        if (!updated) return res.status(409).json(STALE_TICKET);
        // Keep an already-enrolled ticket's undispatched payload in step with
        // what is stored (filling blanks keeps complete details complete).
        if (isAppVrsAiEnrollEligible(updated) && await deps.bridge.store.getBySubmissionId(updated.id)) {
          logEnrollment(updated, await enroll(deps, updated));
        }
        try {
          deps.broadcastTicketUpdated(updated);
        } catch (broadcastError) {
          console.error(`[ahs-review] broadcast failed for submission ${updated.id}:`, broadcastError);
        }
      }

      const body: AhsReviewRefreshResponse = {
        ok: true,
        ahsDetails: refreshed,
        snowflake: sources.snowflake.status,
        hssom: sources.hssom.status,
      };
      return res.status(200).json(body);
    } catch (error) {
      console.error("[ahs-review] refresh error:", error instanceof Error ? error.message : String(error));
      return res.status(500).json({ ok: false, error: "Failed to refresh AHS details" });
    }
  });
}
