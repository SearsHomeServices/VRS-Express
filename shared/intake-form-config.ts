// Tyler 2026-04-30: Intake form workflow configuration.
//
// The intake form workflow goes live at 8:00 AM Eastern on May 1, 2026 —
// the moment the first technician of the day logs in. Tickets created
// before this cutoff pre-date the workflow and were already handled
// through a separate (pre-existing) intake form process. They must NOT
// surface as "Awaiting agent" in the admin dashboard column and must NOT
// accept new intake form submissions via the API.
//
// 8:00 AM EDT (UTC-4 — DST is active in May) on May 1, 2026 = 12:00 UTC
// on the same calendar day.
export const INTAKE_FORM_GO_LIVE_UTC = new Date("2026-05-01T12:00:00Z");

export type IntakeFormStatus =
  | "completed"       // intake form already filed (agentConfirmedAt present)
  | "awaiting"        // post-cutoff, ticket reached a terminal outcome, no form yet
  | "not_applicable"  // parts_nla OR ticket created before INTAKE_FORM_GO_LIVE_UTC
  | "not_ready";      // post-cutoff but ticket not yet reached a terminal outcome

// Tyler 2026-05-01 (P1 fix — sub 566 / SO 8380-13677352, plus 5 other
// AUTH-rejected tickets stuck today): centralize the "is this ticket in
// a terminal outcome that requires an intake form" predicate so the
// route pre-flight gate (routes.ts confirm), the in-transaction re-check
// (storage.ts atomicCreateIntakeForm), the GET status endpoint
// (routes.ts /intake-form-status), and the admin dashboard column
// (deriveIntakeFormStatus below) cannot drift again.
//
// What "terminal" means per branch (single set, both branches now match):
//   AUTH/Infestation:  approved | completed | rejected | rejected_closed | invalid
//   NLA:                          completed | rejected | rejected_closed | invalid
//                                 (NLA never writes "approved")
//
// The AUTH branch USED to accept only {approved, completed}, which
// pre-dated the rejected/rejected_closed/invalid AUTH actions added in
// the AUTH process route. Net effect of that drift: agents could submit
// the Smartsheet intake form for an AUTH-rejected ticket (the
// IntakeFormTab iframe always loads — the early-exit gate was removed
// 2026-04-28 per Tyler) but the /confirm POST then 409'd, leaving
// real form data in Smartsheet with no matching intake_forms audit row.
// "queued" (NLA escalation to P-Card) and "pending" (pre-action) stay
// non-terminal — those are hand-offs / unprocessed.
export const TERMINAL_TICKET_STATUSES_FOR_INTAKE = [
  "approved",
  "completed",
  "rejected",
  "rejected_closed",
  "invalid",
] as const;

export function isTerminalTicketStatusForIntake(
  ticketStatus: string | null | undefined
): boolean {
  if (!ticketStatus) return false;
  return (TERMINAL_TICKET_STATUSES_FOR_INTAKE as readonly string[]).includes(
    ticketStatus
  );
}

export interface IntakeFormStatusInput {
  createdAt: Date | string | null | undefined;
  ticketStatus: string | null | undefined;
  requestType: string | null | undefined;
  intakeFormCompletedAt: Date | string | null | undefined;
}

// Single source of truth for status derivation. Used by both the server
// (routes.ts confirm-intake gate) and the client (admin dashboard column).
//
// Tyler 2026-05-01 (architect-flagged drift): the original helper short-
// circuited on `requestType === "parts_nla"` and returned "not_applicable".
// That contradicted the server, which REQUIRES an intake form on every
// terminal NLA outcome. Result: the admin dashboard "Intake Form
// Complete" column rendered "N/A" for every NLA ticket — including
// terminal ones with no intake form on file — so agents had no signal
// that a form was outstanding.
//
// Tyler 2026-05-01 (P1 fix — sub 566): same drift on the AUTH side. The
// AUTH branch only treated {approved, completed} as awaiting. AUTH-
// rejected, AUTH-rejected_closed and AUTH-invalid (all real terminal
// outcomes the AUTH process route writes) were misreported as
// "not_ready". Now both branches share the single
// `isTerminalTicketStatusForIntake` predicate (NLA never writes
// "approved" so its set is naturally a subset).
//
// Order of checks (matters):
//   1. intakeFormCompletedAt              → completed (wins over everything)
//   2. pre-cutoff createdAt               → not_applicable
//        (grandfathered; pre-existed the workflow, handled separately)
//   3. terminal ticket status             → awaiting
//   4. anything else                      → not_ready
//
// The AUTH branch intentionally does NOT check `authCode` here even
// though the server's status endpoint does for approved/completed —
// the dashboard column is surfacing "do we still owe an intake form?",
// and an AUTH ticket without an authCode is a separate data-quality
// flag handled in another column. Keeping authCode out of scope here
// mirrors the pre-existing client behavior and avoids cross-column
// coupling.
export function deriveIntakeFormStatus(input: IntakeFormStatusInput): IntakeFormStatus {
  if (input.intakeFormCompletedAt) return "completed";

  const createdAt = input.createdAt ? new Date(input.createdAt as string).getTime() : 0;
  if (!createdAt || createdAt < INTAKE_FORM_GO_LIVE_UTC.getTime()) {
    return "not_applicable";
  }

  return isTerminalTicketStatusForIntake(input.ticketStatus) ? "awaiting" : "not_ready";
}
