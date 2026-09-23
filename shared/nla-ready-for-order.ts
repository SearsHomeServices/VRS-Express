export type NlaReadyForOrderState = {
  requestType?: string | null;
  ticketStatus?: string | null;
  nlaResolution?: string | null;
  nlaEscalatedBy?: number | null;
  nlaReadyForOrderAt?: Date | string | null;
};

export type QueueWaitState = NlaReadyForOrderState & {
  claimedAt?: Date | string | null;
  statusChangedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  createdAt?: Date | string | null;
};

const READY_FOR_ORDER_STATUSES = new Set(["queued", "pending"]);
const ORDER_RESOLUTIONS = new Set([
  "part_found_vrs_ordered",
  "part_found_tech_orders",
]);

/**
 * Canonical NLA P-card handoff. The timestamp is written only by the
 * nla_escalate_to_pcard transition; the other fields protect the UI from
 * retained handoff metadata after an order is placed or the ticket is closed.
 */
export function isNlaReadyForOrder(ticket: NlaReadyForOrderState): boolean {
  return ticket.requestType === "parts_nla"
    && READY_FOR_ORDER_STATUSES.has(ticket.ticketStatus || "")
    && (
      // Legacy and current canonical handoffs: only the escalation transition
      // writes this marker. Do not require the new timestamp because Publish
      // migrates schema, not existing production data.
      ticket.nlaEscalatedBy != null
      // Forward-compatible worked/order state if an importer records the
      // persisted handoff timestamp without a local user as escalator.
      || (
        ticket.nlaReadyForOrderAt != null
        && ORDER_RESOLUTIONS.has(ticket.nlaResolution || "")
      )
    );
}

/**
 * Stable end of queue wait. A researched NLA handoff stops at the persisted
 * handoff time even after a P-card claim/reassignment overwrites claimedAt.
 * Ordinary tickets stop at their first/current claim under existing semantics.
 */
export function getQueueWaitEnd(
  ticket: QueueWaitState,
  now: Date = new Date(),
): Date | string | null {
  if (ticket.nlaReadyForOrderAt != null) return ticket.nlaReadyForOrderAt;
  // Before the new timestamp is materialized, the existing escalation marker
  // identifies a researched handoff and claimedAt is its stable best fallback.
  if (ticket.claimedAt != null) return ticket.claimedAt;
  if (ticket.requestType === "parts_nla" && ticket.nlaEscalatedBy != null) {
    return ticket.statusChangedAt ?? ticket.updatedAt ?? ticket.createdAt ?? null;
  }
  if (ticket.ticketStatus === "queued") return now;
  return ticket.statusChangedAt ?? now;
}