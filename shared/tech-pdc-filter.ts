// =============================================================================
// Tech PDC table-filter predicate — SINGLE SOURCE OF TRUTH for the client.
// =============================================================================
// Task #45 — the Tech PDC filter exists in two places that must agree:
//   1. The admin Ticket Overview table filter (client/src/pages/
//      admin-dashboard.tsx) — imports THIS module.
//   2. The server-side `pdc` param in getCoachingRecords (server/routes.ts),
//      used by the coaching CSV/XLSX export and the bulk Tech PDC push.
//
// The server intentionally keeps its own copy (it filters DB rows inside a
// larger query pipeline). The parity test
// (tests/tech-pdc-export-parity.test.ts) seeds tickets across every PDC
// state and asserts the export row set matches this predicate for each
// filter value — so any drift between the two definitions fails CI instead
// of silently shipping an export that doesn't match the visible table.
//
// Semantics (must stay in lockstep with getCoachingRecords):
//   sent          techPdcStatus === "sent"
//   not_sent      techPdcStatus is null/undefined/"" (falsy — never pushed)
//   pending       techPdcStatus === "pending"
//   failed        techPdcStatus === "failed"
//   missing_notes coachingNotes is null/empty/whitespace-only
//   all           no PDC narrowing
// Any non-"all" value first limits to negative-outcome rows (the only ones
// that carry PDC state).
// =============================================================================

export const TECH_PDC_FILTER_VALUES = [
  "all",
  "sent",
  "not_sent",
  "pending",
  "failed",
  "missing_notes",
] as const;
export type TechPdcFilterValue = (typeof TECH_PDC_FILTER_VALUES)[number];

/** Negative-outcome ticket statuses — the only rows with Tech PDC state. */
export const NEGATIVE_TICKET_STATUSES: readonly string[] = [
  "rejected",
  "rejected_closed",
  "invalid",
];

export interface TechPdcFilterableRow {
  ticketStatus: string;
  techPdcStatus?: string | null;
  coachingNotes?: string | null;
}

/**
 * Returns true when a ticket row passes the Tech PDC dropdown filter.
 * Mirrors the server-side `pdc` narrowing in getCoachingRecords.
 */
export function matchesTechPdcFilter(
  row: TechPdcFilterableRow,
  pdc: TechPdcFilterValue,
): boolean {
  if (pdc === "all") return true;
  if (!NEGATIVE_TICKET_STATUSES.includes(row.ticketStatus)) {
    return false;
  }
  switch (pdc) {
    case "sent":
      return row.techPdcStatus === "sent";
    case "not_sent":
      return !row.techPdcStatus;
    case "pending":
      return row.techPdcStatus === "pending";
    case "failed":
      return row.techPdcStatus === "failed";
    case "missing_notes":
      return !(row.coachingNotes || "").trim();
    default:
      return true;
  }
}
