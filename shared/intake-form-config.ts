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
// Order of checks matters: completion wins over everything; parts_nla wins
// over the cutoff (NLA tickets never use intake forms regardless of date);
// the cutoff then grandfathers everything older than INTAKE_FORM_GO_LIVE_UTC.
export function deriveIntakeFormStatus(input: IntakeFormStatusInput): IntakeFormStatus {
  if (input.intakeFormCompletedAt) return "completed";
  if (input.requestType === "parts_nla") return "not_applicable";

  const createdAt = input.createdAt ? new Date(input.createdAt as string).getTime() : 0;
  if (!createdAt || createdAt < INTAKE_FORM_GO_LIVE_UTC.getTime()) {
    return "not_applicable";
  }

  if (input.ticketStatus === "approved" || input.ticketStatus === "completed") {
    return "awaiting";
  }
  return "not_ready";
}
