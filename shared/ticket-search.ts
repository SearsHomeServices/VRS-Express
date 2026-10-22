/** Shared by ticket overview, server list search, and coaching exports. */
export function matchesTicketSearch(row: {
  serviceOrder?: string | null;
  racId?: string | null;
  technicianLdapId?: string | null;
  technicianName?: string | null;
  assignedAgentName?: string | null;
  workedAgentSearchTerms?: string[] | null;
}, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [
    row.serviceOrder, row.racId, row.technicianLdapId,
    row.technicianName, row.assignedAgentName,
    ...(row.workedAgentSearchTerms ?? []),
  ].some(value => value?.toLowerCase().includes(query));
}

export function ticketAgentIds(row: {
  assignedTo?: number | null;
  reviewedBy?: number | null;
  stage1ReviewedBy?: number | null;
  stage2ReviewedBy?: number | null;
  nlaEscalatedBy?: number | null;
}): number[] {
  return [...new Set([
    row.assignedTo, row.reviewedBy, row.stage1ReviewedBy,
    row.stage2ReviewedBy, row.nlaEscalatedBy,
  ].filter((id): id is number => id != null))];
}
