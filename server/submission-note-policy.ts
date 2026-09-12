export const STAFF_NOTE_ROLES = new Set(["vrs_agent", "admin", "super_admin"]);
export const OWNER_NOTE_ROLES = new Set(["technician", "provider_1099"]);
export const TERMINAL_TICKET_STATUSES = new Set([
  "completed",
  "approved",
  "rejected",
  "rejected_closed",
  "invalid",
]);

export type NoteVisibility = "shared" | "staff_only";

export function isTerminalTicketStatus(status: string): boolean {
  return TERMINAL_TICKET_STATUSES.has(status);
}

export function noteVisibilityForPost(role: string, ticketStatus: string): NoteVisibility | null {
  if (STAFF_NOTE_ROLES.has(role)) {
    return isTerminalTicketStatus(ticketStatus) ? "staff_only" : "shared";
  }
  if (OWNER_NOTE_ROLES.has(role)) {
    return isTerminalTicketStatus(ticketStatus) ? null : "shared";
  }
  return null;
}

export function canReadNote(role: string, visibility: string | null): boolean {
  if (STAFF_NOTE_ROLES.has(role)) return true;
  if (OWNER_NOTE_ROLES.has(role)) return visibility !== "staff_only";
  return false;
}

export function canAccessTicketNotes(input: {
  role: string;
  userId: number;
  technicianId: number;
  ticketStatus: string;
  requestType: string;
  applianceType: string;
  divisions?: string[];
  allDivisionCount: number;
}): boolean {
  const { role, userId, technicianId, ticketStatus } = input;
  if (!STAFF_NOTE_ROLES.has(role) && !OWNER_NOTE_ROLES.has(role)) return false;
  if (OWNER_NOTE_ROLES.has(role)) return technicianId === userId;
  if (role !== "vrs_agent" || ticketStatus !== "queued") return true;
  const divisions = input.divisions ?? [];
  if (divisions.length >= input.allDivisionCount) return true;
  const requiredDivision = input.requestType === "parts_nla" ? "nla" : input.applianceType;
  return divisions.includes(requiredDivision);
}