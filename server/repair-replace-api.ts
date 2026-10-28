// Repair / replace calculator endpoints for Sears Protect tickets
// (shared/repair-replace.ts):
//   GET  /api/submissions/:id/repair-replace/prefill  what the service order fills
//   POST /api/submissions/:id/repair-replace/note     re-run the check on the
//        server and save its summary as a staff-only ticket note
// The calculator itself runs in the browser (pure shared code); the server
// recomputes before saving so the note never carries a client's numbers as
// a result. Nothing here authorizes or buys a replacement.
//
// Staff only, on the ticket's assigned agent (or an admin). No customer data
// is read or returned; logs carry the ticket id and statuses.
import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import type { Submission } from "@shared/schema";
import {
  evaluateFrc,
  evaluateLegacy,
  rrSummaryText,
  type RrInput,
  type RrPrefillResponse,
} from "@shared/repair-replace";
import { parseStoredTechApplianceDetails } from "@shared/tech-appliance-details";
import type { AuthenticatedRequest } from "./middleware/auth";
import type { RepairReplaceTicketInput } from "./repair-replace-prefill";

export const REPAIR_REPLACE_ROLES = ["vrs_agent", "admin", "super_admin"] as const;
// submission_notes.body limit (POST /api/submissions/:id/notes).
const NOTE_MAX = 2000;

export interface RepairReplaceApiDeps {
  authenticateToken: RequestHandler;
  requireRole: (...roles: string[]) => RequestHandler;
  isEnabled(): boolean;
  getSubmission(id: number): Promise<Submission | undefined>;
  // The submitting technician's account; companyName is set for 1099
  // provider accounts (shared/provider1099.ts).
  getUser(id: number): Promise<{ role: string; companyName?: string | null } | undefined>;
  // loadRepairReplacePrefill with the Snowflake and HSSOM lookups (or null
  // when off); bounded and never rejects.
  loadPrefill(serviceOrder: string, ticket: RepairReplaceTicketInput): Promise<RrPrefillResponse>;
  createNote(note: {
    submissionId: number;
    authorId: number;
    authorRole: string;
    visibility: "staff_only";
    body: string;
  }): Promise<unknown>;
}

const scalar = z.union([z.string().max(120), z.number().finite(), z.boolean(), z.null()]).optional();
const partSchema = z.object({ cost: scalar, sell_price: scalar, quantity: scalar }).strict();
export const repairReplaceInputSchema = z.object({
  appliance_type: scalar,
  age_years: scalar,
  replacement_cost: scalar,
  component: scalar,
  parts_cost: scalar,
  labor_cost: scalar,
  trip_cost: scalar,
  visit_number: scalar,
  unresolved: scalar,
  failed_attempt_count: scalar,
  other_service_orders_12mo: scalar,
  same_part_or_system_repeat: scalar,
  technician_confident: scalar,
  parts_available: scalar,
  backorder_days: scalar,
  contract_spend: scalar,
  calculator_type: scalar,
  proc_id: scalar,
  parts: z.array(partSchema).max(20).nullable().optional(),
  servicer_type: scalar,
  repair_hours: scalar,
  labor_category: scalar,
  tax_rate: scalar,
  include_tax: z.boolean().nullable().optional(),
  age_band: scalar,
}).strict();

export const repairReplaceNoteSchema = z.object({
  model: z.enum(["frc", "legacy"]),
  input: repairReplaceInputSchema,
  // The legacy comparison run next to a Forward Repair Cost check.
  legacyInput: repairReplaceInputSchema.optional(),
}).strict();

async function loadTicket(deps: RepairReplaceApiDeps, req: Request, res: Response) {
  if (!deps.isEnabled()) {
    res.status(404).json({ ok: false, error: "The repair / replace calculator is not enabled" });
    return null;
  }
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
  if (submission.warrantyType !== "sears_protect") {
    res.status(400).json({ ok: false, error: "The repair / replace calculator applies to Sears Protect tickets" });
    return null;
  }
  return { submission, user };
}

export function registerRepairReplaceApi(app: Express, deps: RepairReplaceApiDeps): void {
  const guard = [deps.authenticateToken, deps.requireRole(...REPAIR_REPLACE_ROLES)];

  app.get("/api/submissions/:id/repair-replace/prefill", ...guard, async (req, res) => {
    try {
      const ticket = await loadTicket(deps, req, res);
      if (!ticket) return;
      const technician = ticket.submission.technicianId
        ? await deps.getUser(ticket.submission.technicianId).catch(() => undefined)
        : undefined;
      const prefill = await deps.loadPrefill(ticket.submission.serviceOrder, {
        ticketApplianceKind: ticket.submission.applianceKind ?? null,
        techDetails: parseStoredTechApplianceDetails(ticket.submission.techApplianceDetails),
        servicerType: technician?.role === "technician" ? (technician.companyName?.trim() ? "1099" : "Sears Tech") : null,
      });
      console.info(`[repair-replace] prefill submission=${ticket.submission.id} status=${prefill.status} fields=${Object.keys(prefill.fields).join(",") || "none"}`);
      res.json(prefill);
    } catch (error) {
      console.error(`[repair-replace] prefill failed: ${String((error as any)?.message ?? error).slice(0, 200)}`);
      res.status(500).json({ ok: false, error: "Failed to look up the service order" });
    }
  });

  app.post("/api/submissions/:id/repair-replace/note", ...guard, async (req, res) => {
    try {
      const ticket = await loadTicket(deps, req, res);
      if (!ticket) return;
      const parsed = repairReplaceNoteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: "Invalid calculator input", details: parsed.error.flatten() });
        return;
      }
      const { model, input, legacyInput } = parsed.data;
      const result = model === "legacy" ? evaluateLegacy(input as RrInput) : evaluateFrc(input as RrInput);
      const legacy = model === "frc" && legacyInput ? evaluateLegacy(legacyInput as RrInput) : null;
      let body = rrSummaryText(result, ticket.submission.serviceOrder, legacy);
      if (body.length > NOTE_MAX) body = `${body.slice(0, NOTE_MAX - 1)}…`;
      await deps.createNote({
        submissionId: ticket.submission.id,
        authorId: ticket.user.id,
        authorRole: ticket.user.role,
        visibility: "staff_only",
        body,
      });
      console.info(`[repair-replace] note submission=${ticket.submission.id} model=${model} route=${result.route}`);
      res.status(201).json({ ok: true, result, legacy });
    } catch (error) {
      console.error(`[repair-replace] note failed: ${String((error as any)?.message ?? error).slice(0, 200)}`);
      res.status(500).json({ ok: false, error: "Failed to save the calculator result" });
    }
  });
}
