/**
 * Read-only projections used by the VRS AI Pilot tracking view.
 *
 * A row belongs to the pilot only when it has a real bridge call id.  Other
 * submission fields (request type, ticket status, or AI-enhanced description)
 * are not pilot markers and must not pull ordinary tickets into the view.
 */
export type VrsAiPilotLink = {
  callId?: string | null;
};

export const VRS_AI_PILOT_ROLES = ["vrs_agent", "admin", "super_admin"] as const;
export const VRS_AI_PILOT_DIVISION_COUNT = 8;

/**
 * Ticket outcomes that are closed in the Pilot projection.  These mirror the
 * terminal outcomes already written by the existing agent process flow; the
 * Pilot closed-review surface must never treat a closed row as pending work.
 */
export const VRS_AI_PILOT_CLOSED_STATUSES = [
  "completed",
  "rejected",
  "rejected_closed",
  "invalid",
] as const;

export type VrsAiPilotClosedStatus = (typeof VRS_AI_PILOT_CLOSED_STATUSES)[number];

export function isVrsAiPilotClosedStatus(
  status: string | null | undefined,
): status is VrsAiPilotClosedStatus {
  return typeof status === "string" &&
    (VRS_AI_PILOT_CLOSED_STATUSES as readonly string[]).includes(status);
}

export function canUseVrsAiPilot(role: string | null | undefined): boolean {
  return typeof role === "string" &&
    (VRS_AI_PILOT_ROLES as readonly string[]).includes(role);
}

export type VrsAiPilotAgentScopeRow = {
  assignedTo?: number | null;
  reviewedBy?: number | null;
  ticketStatus?: string | null;
  requestType?: string | null;
  applianceType?: string | null;
};

/**
 * Pure equivalent of the server-side VRS-agent pilot scope. SQL applies the
 * same branches in storage.ts; keeping this projection independently testable
 * protects assignment/reviewer access and queued specialization boundaries.
 */
export function agentCanSeeVrsAiPilotRow(
  row: VrsAiPilotAgentScopeRow,
  agentId: number,
  divisions: readonly string[],
): boolean {
  if (row.assignedTo === agentId || row.reviewedBy === agentId) return true;
  if (row.ticketStatus !== "queued") return false;
  if (divisions.length >= VRS_AI_PILOT_DIVISION_COUNT) return true;
  return row.requestType === "parts_nla"
    ? divisions.includes("nla")
    : typeof row.applianceType === "string" && divisions.includes(row.applianceType);
}

export function hasVrsAiBridgeLink(
  row: { vrsAi?: VrsAiPilotLink | null } | null | undefined,
): boolean {
  return typeof row?.vrsAi?.callId === "string" && row.vrsAi.callId.trim().length > 0;
}

export function filterVrsAiPilotRows<T extends { vrsAi?: VrsAiPilotLink | null }>(
  rows: readonly T[],
): T[] {
  return rows.filter(hasVrsAiBridgeLink);
}
