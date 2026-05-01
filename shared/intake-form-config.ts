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
  | "awaiting"        // post-cutoff, ticket approved/completed, no form yet
  | "not_applicable"  // parts_nla OR ticket created before INTAKE_FORM_GO_LIVE_UTC
  | "not_ready";      // post-cutoff but ticket not yet approved/completed

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
// That contradicted the server, which (see routes.ts:3857-3866 and
// routes.ts:4044-4058) REQUIRES an intake form on every terminal NLA
// outcome (`completed | rejected | rejected_closed | invalid`). Result:
// the admin dashboard "Intake Form Complete" column rendered "N/A" for
// every NLA ticket — including terminal ones with no intake form on
// file — so agents had no signal that a form was outstanding.
//
// Order of checks (matters):
//   1. intakeFormCompletedAt     → completed (wins over everything)
//   2. pre-cutoff (createdAt < INTAKE_FORM_GO_LIVE_UTC) → not_applicable
//        (grandfathered; pre-existed the workflow, handled separately)
//   3. NLA branch — mirrors server gate:
//        terminal (completed|rejected|rejected_closed|invalid) → awaiting
//        non-terminal (pending|queued|...)                     → not_ready
//   4. AUTH/Infestation branch (unchanged):
//        approved|completed → awaiting
//        anything else      → not_ready
//
// The AUTH branch intentionally does NOT check `authCode` here even
// though the server's status endpoint does — the dashboard column is
// surfacing "do we still owe an intake form?", and an AUTH ticket
// without an authCode is itself a separate data-quality flag handled
// in another column. Keeping authCode out of scope here mirrors the
// pre-existing client behavior and avoids cross-column coupling.
export function deriveIntakeFormStatus(input: IntakeFormStatusInput): IntakeFormStatus {
  if (input.intakeFormCompletedAt) return "completed";

  const createdAt = input.createdAt ? new Date(input.createdAt as string).getTime() : 0;
  if (!createdAt || createdAt < INTAKE_FORM_GO_LIVE_UTC.getTime()) {
    return "not_applicable";
  }

  if (input.requestType === "parts_nla") {
    const status = input.ticketStatus;
    const nlaTerminal =
      status === "completed" ||
      status === "rejected" ||
      status === "rejected_closed" ||
      status === "invalid";
    return nlaTerminal ? "awaiting" : "not_ready";
  }

  if (input.ticketStatus === "approved" || input.ticketStatus === "completed") {
    return "awaiting";
  }
  return "not_ready";
}
