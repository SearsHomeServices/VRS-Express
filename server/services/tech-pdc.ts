// 2026-08-06 (Rejection & Coaching Report) — Tech PDC outbound push service.
//
// Transmits rejection + coaching records to the external Tech PDC system.
// Configured entirely via env:
//   TECH_PDC_API_URL  — https://tech-pdc.replit.app/api/external/coaching-intake
//   TECH_PDC_API_KEY  — sent as the `X-API-Key` header (per their API guide)
// When either is missing the API routes return 503 TECH_PDC_NOT_CONFIGURED
// (same gating pattern as the VRS AI bridge).
//
// Delivery status is tracked per submission in the tech_pdc_* columns:
//   techPdcStatus: null (never pushed) | 'pending' | 'sent' | 'failed'
//   techPdcSentAt / techPdcError / techPdcAttempts
// Pushes are manual (admin bulk button or per-ticket retry) — no background
// scheduler, so a failure is always visible next to its retry button.

import { storage, bumpSubmissionsDataVersion, db } from "../storage";
import { submissions, type Submission } from "@shared/schema";
import { and, eq, ne, isNull, or, sql } from "drizzle-orm";

export function isTechPdcConfigured(): boolean {
  return Boolean(process.env.TECH_PDC_API_URL && process.env.TECH_PDC_API_KEY);
}

export const TECH_PDC_NOT_CONFIGURED_MESSAGE =
  "Tech PDC integration is not configured. Set TECH_PDC_API_URL and TECH_PDC_API_KEY.";

export const TECH_PDC_ROOT_CAUSE_REQUIRED_MESSAGE =
  "Select a Root Cause before pushing to Tech PDC.";

// The rejection timestamp: prefer the stage that actually recorded the
// negative outcome (Stage-2 audit stamp when a post-approval reversal),
// falling back to Stage 1 review time, then the status-change time.
export function rejectionTimestampOf(s: Submission): Date | null {
  return s.stage2ReviewedAt || s.stage1ReviewedAt || s.statusChangedAt || null;
}

// Payload per the "Tech PDC — Universal Coaching Intake API" guide
// (attached_assets/Tech-PDC-Universal-Coaching-Intake-API-Guide_08042026):
//   POST <TECH_PDC_API_URL> with X-API-Key header.
//   surveyId is OUR identifier — Tech PDC dedupes on it per source, so
//   retries after a timeout can never create duplicate coaching records.
//   enterpriseId is roster-validated on their side; when valid it overrides
//   technicianName, when invalid the submission is rejected with HTTP 400
//   (generic message) which we surface verbatim in the Failed badge.
export function buildTechPdcPayload(s: Submission, technicianName: string | null) {
  let reasons: string[] = [];
  try {
    if (s.rejectionReasons) reasons = JSON.parse(s.rejectionReasons);
  } catch { /* keep empty */ }
  const reason = reasons.length > 0 ? reasons.join(", ") : (s.stage1RejectionReason || s.invalidReason || "");
  const parts: string[] = [];
  parts.push(`VRS Service Order ${s.serviceOrder} — video authorization ${s.ticketStatus === "invalid" ? "marked invalid" : "rejected"}.`);
  if (reason) parts.push(`Rejection reason(s): ${reason}`);
  if (s.expectedVsActual) parts.push(`Expected vs actual: ${s.expectedVsActual}`);
  if (s.coachingNotes) parts.push(`Coaching notes: ${s.coachingNotes}`);
  if (s.agentNotes) parts.push(`Agent notes: ${s.agentNotes}`);
  if (s.technicianMessage) parts.push(`Message to technician: ${s.technicianMessage}`);
  if (s.invalidInstructions) parts.push(`Instructions: ${s.invalidInstructions}`);

  const rejectedAt = rejectionTimestampOf(s);
  const enterpriseId = (s.technicianLdapId || s.racId || "").trim().toUpperCase();

  return {
    // Their roster is keyed by enterprise ID; VRS technician LDAP is that ID.
    ...(enterpriseId ? { enterpriseId } : {}),
    technicianName: technicianName || undefined,
    department: "Other",
    incidentDate: (rejectedAt || new Date()).toISOString().slice(0, 10),
    primaryCategory: "Documentation",
    severity: "Moderate",
    // Required by the live API's enum; selected per-ticket in the admin UI.
    rootCause: s.techPdcRootCause,
    incidentDescription: parts.join("\n"),
    sourceSystem: "VRS Authorization Tool",
    // Unique + stable per VRS ticket → safe idempotent retries.
    surveyId: `VRS-${s.id}`,
  };
}

export type TechPdcPushResult =
  | { ok: true }
  | { ok: false; error: string; busy?: boolean };

// Push a single submission's coaching record to Tech PDC and persist the
// delivery outcome. Never throws — all failures land in techPdcStatus=failed.
export async function pushSubmissionToTechPdc(
  submission: Submission,
  technicianName: string | null,
): Promise<TechPdcPushResult> {
  const url = process.env.TECH_PDC_API_URL;
  const apiKey = process.env.TECH_PDC_API_KEY;
  if (!url || !apiKey) {
    return { ok: false, error: TECH_PDC_NOT_CONFIGURED_MESSAGE };
  }
  if (!submission.techPdcRootCause) {
    // Don't claim/attempt — the live API requires rootCause; surface a
    // clear actionable error instead of a 400 round-trip.
    return { ok: false, error: TECH_PDC_ROOT_CAUSE_REQUIRED_MESSAGE };
  }

  // Atomic claim: only one caller may move the row into 'pending' at a time.
  // Concurrent bulk pushes / retries lose the CAS and skip, so a record can
  // never be double-sent by a race (same idea as the VRS AI dispatch claim).
  const claimed = await db
    .update(submissions)
    .set({
      techPdcStatus: "pending",
      techPdcAttempts: sql`${submissions.techPdcAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(submissions.id, submission.id),
      or(isNull(submissions.techPdcStatus), ne(submissions.techPdcStatus, "pending")),
    ))
    .returning({ id: submissions.id });
  if (claimed.length === 0) {
    return { ok: false, busy: true, error: "A Tech PDC push for this ticket is already in progress." };
  }
  // Direct db.update bypasses storage's list micro-cache stamp — bump it so
  // the 'pending' badge isn't served stale to list views.
  bumpSubmissionsDataVersion();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify(buildTechPdcPayload(submission, technicianName)),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      await storage.updateSubmission(submission.id, {
        techPdcStatus: "sent",
        techPdcSentAt: new Date(),
        techPdcError: null,
        updatedAt: new Date(),
      } as any);
      console.log(`[tech-pdc] sent submission=${submission.id} so=${submission.serviceOrder} status=${res.status}`);
      return { ok: true };
    }

    const bodyText = (await res.text().catch(() => "")).slice(0, 500);
    const error = `Tech PDC responded ${res.status}${bodyText ? `: ${bodyText}` : ""}`;
    await storage.updateSubmission(submission.id, {
      techPdcStatus: "failed",
      techPdcError: error,
      updatedAt: new Date(),
    } as any);
    console.warn(`[tech-pdc] failed submission=${submission.id} so=${submission.serviceOrder} ${error}`);
    return { ok: false, error };
  } catch (err: any) {
    const error = err?.name === "AbortError" ? "Tech PDC request timed out (15s)" : (err?.message || String(err));
    await storage.updateSubmission(submission.id, {
      techPdcStatus: "failed",
      techPdcError: error,
      updatedAt: new Date(),
    } as any);
    console.warn(`[tech-pdc] failed submission=${submission.id} so=${submission.serviceOrder} ${error}`);
    return { ok: false, error };
  }
}
