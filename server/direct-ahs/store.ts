import { createHash, randomUUID } from "crypto";
import type { Pool, PoolClient } from "pg";
import { normalizeIhPhone, prepareDirectAhsWomNotes, type DirectAhsPayload, type DirectAhsResult, type DirectAhsState } from "../../shared/direct-ahs";
import { DirectAhsError } from "./contract";

export interface DirectAhsActor { id: number; role: string }
export interface DirectAhsRow {
  id: string; submission_id: number; reviewer_id: number; state: DirectAhsState;
  payload: DirectAhsPayload; call_id: string | null; decision: DirectAhsResult["decision"] | null;
  sms: DirectAhsResult["sms"] | null; wom_notes: unknown; error: string | null;
  last_sequence: number; created_at: Date; updated_at: Date;
}
type Ticket = Record<string, any>;
const staff = (actor: DirectAhsActor) => ["admin", "super_admin", "vrs_agent"].includes(actor.role);
export function directAhsEligibility(ticket: Ticket, actor: DirectAhsActor): string | null {
  if (!staff(actor)) return "Only VRS staff may approve a request";
  if (ticket.bridge_linked) return "Sasha-linked tickets cannot use direct AHS";
  if (ticket.warranty_type !== "american_home_shield" || ticket.request_type !== "authorization") return "Only AHS repair authorization tickets are supported";
  if (ticket.ticket_status !== "pending") return "Claim the ticket before sending it";
  if (ticket.assigned_to !== actor.id) return "The ticket must be assigned to you";
  if (ticket.submission_approved) return "This ticket has already passed submission approval";
  return null;
}
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function publicDirectAhsRow(row: DirectAhsRow | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    state: row.state === "dispatching" && Date.now() - new Date(row.updated_at).getTime() > 30000 ? "dispatch_unknown" : row.state,
    error: row.error, decision: row.decision, sms: row.sms, womNotes: row.wom_notes,
  };
}
export class DirectAhsStore {
  constructor(private pool: Pool, private changed: (submissionId: number, reviewerId: number) => void = () => {}) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private async ticket(client: Pick<PoolClient, "query">, id: number, lock = false): Promise<Ticket> {
    const result = await client.query(`SELECT s.*, u.name AS tech_name, u.rac_id AS tech_rac_id,
      EXISTS(SELECT 1 FROM vrs_ai_calls b WHERE b.submission_id=s.id) AS bridge_linked
      FROM submissions s JOIN users u ON u.id=s.technician_id WHERE s.id=$1 ${lock ? "FOR UPDATE OF s" : ""}`, [id]);
    if (!result.rows[0]) throw new DirectAhsError(404, "Ticket not found");
    return result.rows[0];
  }
  private authorize(ticket: Ticket, actor: DirectAhsActor, row?: DirectAhsRow) {
    if (!staff(actor) || (actor.role === "vrs_agent" && ticket.assigned_to !== actor.id && row?.reviewer_id !== actor.id)) {
      throw new DirectAhsError(403, "You do not have access to this ticket");
    }
  }
  async get(id: number, actor: DirectAhsActor) {
    const ticket = await this.ticket(this.pool, id);
    const row: DirectAhsRow | undefined = (await this.pool.query("SELECT * FROM direct_ahs_workflows WHERE submission_id=$1", [id])).rows[0];
    this.authorize(ticket, actor, row);
    const reason = row ? "This ticket is managed by the direct AHS workflow" : directAhsEligibility(ticket, actor);
    return { eligible: !reason, reason, workflow: publicDirectAhsRow(row) };
  }

  async enroll(id: number, actor: DirectAhsActor, notes: string, callbackUrl: string, media: (ticket: Ticket) => Promise<Pick<DirectAhsPayload, "photoUrls" | "videoUrl" | "voiceNoteUrl">>) {
    const row = await this.transaction(async client => {
      const ticket = await this.ticket(client, id, true);
      const existing: DirectAhsRow | undefined = (await client.query("SELECT * FROM direct_ahs_workflows WHERE submission_id=$1", [id])).rows[0];
      this.authorize(ticket, actor, existing);
      if (existing) throw new DirectAhsError(409, "This ticket already has an AI request; use its status or same-request retry");
      const reason = directAhsEligibility(ticket, actor);
      if (reason) throw new DirectAhsError(409, reason);
      const phone = normalizeIhPhone(ticket.phone_override || ticket.phone || "");
      const techId = ticket.technician_ldap_id || ticket.tech_rac_id;
      if (!phone || !techId || !/^(?:\d{8}|\d{12}|\d{4}-\d{8})$/.test(ticket.service_order) || !ticket.issue_description?.trim()) {
        throw new DirectAhsError(422, "A valid technician phone, technician ID, service order and diagnosis are required");
      }
      let parts: unknown;
      try { parts = ticket.part_numbers ? JSON.parse(ticket.part_numbers) : []; } catch { throw new DirectAhsError(422, "Part numbers must be a valid list"); }
      if (!Array.isArray(parts) || parts.some(p => typeof p !== "string")) throw new DirectAhsError(422, "Part numbers must be a valid list");
      const payload: DirectAhsPayload = {
        version: 1, source: "vrs_express_direct_ahs", requestId: randomUUID(), submissionId: id,
        serviceOrder: ticket.service_order, warranty: "american_home_shield",
        technician: { id: techId, phone, name: ticket.tech_name },
        applianceType: ticket.appliance_type, diagnosis: ticket.issue_description,
        estimateAmount: ticket.estimate_amount, partNumbers: parts,
        ...await media(ticket),
        review: { reviewerId: actor.id, notes, approvedAt: new Date().toISOString() }, callbackUrl,
        instructions: { smsOwner: "vrs_ai", includeDecisionCodeInSms: true, womWrite: false },
      };
      await client.query("SELECT set_config('app.direct_ahs_write','on',true)");
      const record = (await client.query(`INSERT INTO direct_ahs_workflows(id,submission_id,reviewer_id,state,payload)
        VALUES($1,$2,$3,'dispatching',$4) RETURNING *`, [payload.requestId, id, actor.id, payload])).rows[0] as DirectAhsRow;
      // Human approval is NOT AHS authorization. Keep stage1Status pending
      // until an actual final result, preserving existing overall-outcome metrics.
      await client.query(`UPDATE submissions SET submission_approved=true,submission_approved_at=now(),
        agent_notes=concat_ws(E'\\n\\n',nullif(agent_notes,''),$2::text), updated_at=now()
        WHERE id=$1`, [id, `Direct AHS human review — ${notes}`]);
      return record;
    });
    this.notify(row);
    return row;
  }
  async claimRetry(id: number, actor: DirectAhsActor) {
    return this.transaction(async client => {
      const ticket = await this.ticket(client, id, true);
      const row: DirectAhsRow | undefined = (await client.query("SELECT * FROM direct_ahs_workflows WHERE submission_id=$1 FOR UPDATE", [id])).rows[0];
      this.authorize(ticket, actor, row);
      if (!row || row.reviewer_id !== actor.id) throw new DirectAhsError(403, "Only the original reviewer may retry this request");
      if (row.state !== "dispatch_unknown" && !(row.state === "dispatching" && Date.now() - new Date(row.updated_at).getTime() > 30000)) {
        throw new DirectAhsError(409, "Only an unacknowledged request can be retried");
      }
      return (await client.query("UPDATE direct_ahs_workflows SET state='dispatching',error=null,updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0] as DirectAhsRow;
    });
  }
  async acknowledged(row: DirectAhsRow, callId: string) {
    // A fast callback may already have finalized the request. Never downgrade it.
    await this.pool.query(`UPDATE direct_ahs_workflows SET state='awaiting_result',call_id=$2,error=null,updated_at=now()
      WHERE id=$1 AND state='dispatching' AND (call_id IS NULL OR call_id=$2)`, [row.id, callId]);
    this.notify(row);
  }
  async ambiguous(row: DirectAhsRow) {
    await this.pool.query(`UPDATE direct_ahs_workflows SET state='dispatch_unknown',
      error='AI acknowledgment not confirmed. Retry the same request; do not start another authorization.',updated_at=now()
      WHERE id=$1 AND state='dispatching'`, [row.id]);
    this.notify(row);
  }
  async apply(event: DirectAhsResult) {
    const applied = await this.transaction(async client => {
      // Consistent lock order: submission first, workflow second.
      const ticket = await this.ticket(client, event.submissionId, true);
      const row: DirectAhsRow | undefined = (await client.query("SELECT * FROM direct_ahs_workflows WHERE id=$1 FOR UPDATE", [event.requestId])).rows[0];
      if (!row || row.submission_id !== event.submissionId || ticket.bridge_linked) throw new DirectAhsError(409, "Request/ticket binding mismatch");
      if (row.payload.serviceOrder !== event.serviceOrder || row.payload.technician.id.toLowerCase() !== event.technicianId.toLowerCase() ||
          (row.call_id && row.call_id !== event.callId) ||
          (event.sms && event.sms.recipient !== row.payload.technician.phone)) throw new DirectAhsError(409, "Result identity or SMS recipient mismatch");
      const fingerprint = createHash("sha256").update(canonical(event)).digest("hex");
      const prior = (await client.query("SELECT fingerprint FROM direct_ahs_events WHERE request_id=$1 AND event_id=$2", [row.id, event.eventId])).rows[0];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new DirectAhsError(409, "Event ID was reused with different data");
        return { row, duplicate: true };
      }
      const usedSequence = (await client.query("SELECT 1 FROM direct_ahs_events WHERE request_id=$1 AND sequence=$2", [row.id, event.sequence])).rowCount;
      if (usedSequence) throw new DirectAhsError(409, "Sequence already used by another event");
      if (row.decision && event.sequence > row.last_sequence &&
          (!event.decision || canonical(row.decision) !== canonical(event.decision))) {
        throw new DirectAhsError(409, "The recorded AHS decision cannot be changed");
      }
      await client.query("INSERT INTO direct_ahs_events(request_id,event_id,sequence,fingerprint,payload) VALUES($1,$2,$3,$4,$5)",
        [row.id, event.eventId, event.sequence, fingerprint, event]);
      if (event.sequence <= row.last_sequence) return { row, duplicate: true };
      if (row.state === "completed") {
        if (event.sms && ["sent", "delivered"].includes(event.sms.status) &&
            (event.sms.providerMessageId !== row.sms?.providerMessageId || event.sms.body !== row.sms?.body)) {
          throw new DirectAhsError(409, "SMS identity changed after ticket closure");
        }
        // A later provider delivery receipt can upgrade sent -> delivered,
        // never reopen a closed ticket or resend a text.
        if (event.sms?.status === "delivered" && row.sms?.status !== "delivered") {
          const updated = (await client.query(`UPDATE direct_ahs_workflows SET sms=$2,wom_notes=$3,
            last_sequence=$4,updated_at=now() WHERE id=$1 RETURNING *`,
            [row.id, event.sms, prepareDirectAhsWomNotes(row.payload, event), event.sequence])).rows[0];
          return { row: updated as DirectAhsRow, duplicate: false };
        }
        await client.query("UPDATE direct_ahs_workflows SET last_sequence=$2 WHERE id=$1", [row.id, event.sequence]);
        return { row, duplicate: true };
      }
      if (ticket.ticket_status !== "pending" || ticket.service_order !== row.payload.serviceOrder ||
          ticket.assigned_to !== row.reviewer_id) throw new DirectAhsError(409, "Ticket changed while AI was processing");
      const complete = !!event.decision && !!event.sms && ["sent", "delivered"].includes(event.sms.status);
      const state: DirectAhsState = event.outcome === "failed" ? "failed" : complete ? "completed" : "awaiting_sms";
      const womNotes = prepareDirectAhsWomNotes(row.payload, event);
      const error = event.outcome === "failed" ? event.failureReason : event.sms?.status === "failed" ? event.sms.reason || "AI must retry the technician SMS" : null;
      const next: DirectAhsRow = (await client.query(`UPDATE direct_ahs_workflows
        SET state=$2,call_id=$3,decision=$4,sms=$5,wom_notes=$6,error=$7,last_sequence=$8,updated_at=now()
        WHERE id=$1 RETURNING *`, [row.id, state, event.callId, event.decision ?? null, event.sms ?? null, womNotes, error, event.sequence])).rows[0];
      if (complete && event.decision) {
        const approved = event.decision.state === "approved";
        const note = `AHS ${event.decision.state.toUpperCase()} — Code: ${event.decision.code}\n${event.decision.notes}\nTechnician SMS: ${event.sms!.status} (VRS AI)\nWOM: prepared only; not written.`;
        await client.query("SELECT set_config('app.direct_ahs_write','on',true)");
        await client.query(`UPDATE submissions SET ticket_status=$2,stage1_status=$3,stage1_reviewed_by=$4,
          stage1_reviewed_at=now(),stage2_status=$5,stage2_outcome=$6,stage2_reviewed_by=$4,stage2_reviewed_at=now(),
          reviewed_by=$4,reviewed_at=now(),auth_code=$7,stage1_rejection_reason=$8,
          agent_notes=concat_ws(E'\\n\\n',nullif(agent_notes,''),$9::text),technician_message=$10,
          status_changed_at=now(),updated_at=now() WHERE id=$1`,
          [row.submission_id, approved ? "completed" : "rejected_closed", approved ? "approved" : "rejected",
            row.reviewer_id, approved ? "approved" : "pending", approved ? "approved" : "rejected_closed",
            approved ? event.decision.code : null, approved ? null : `AHS denial ${event.decision.code}: ${event.decision.notes}`,
            note, `AHS ${event.decision.state}: ${event.decision.code}. ${event.decision.notes}`]);
      }
      return { row: next, duplicate: false };
    });
    this.notify(applied.row);
    return { workflow: publicDirectAhsRow(applied.row), duplicate: applied.duplicate };
  }
  private notify(row: DirectAhsRow) {
    // Broadcast errors must never undo or disguise a committed result.
    try { this.changed(row.submission_id, row.reviewer_id); } catch { /* periodic UI refresh recovers */ }
  }
}
