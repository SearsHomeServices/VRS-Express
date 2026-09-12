import { randomUUID } from "crypto";
import type { Pool } from "pg";

/**
 * A persisted, provider-independent email envelope.  This is intentionally
 * complete: retries must send the original report, not a newly computed one.
 */
export type ExecSummaryDeliveryPayload = {
  to: string[];
  subject: string;
  html: string;
  text: string;
};

export type ProviderEmailResult = {
  sent: boolean;
  status?: number;
  reason?: string;
  messageId?: string;
  retryable?: boolean;
  /** A timeout may have reached the provider; automatic resend is unsafe. */
  ambiguous?: boolean;
  retryAfterMs?: number;
};

export type DeliveryState =
  | "pending"
  | "sending"
  | "accepted"
  | "failed"
  | "ambiguous";

export const EXEC_SUMMARY_DELIVERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS exec_summary_deliveries (
  id SERIAL PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES weekly_reports(id),
  schedule_key VARCHAR(16),
  state VARCHAR(24) NOT NULL DEFAULT 'pending',
  payload JSONB NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  provider_message_id VARCHAR(255),
  last_status INTEGER,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS exec_summary_deliveries_report_uidx
  ON exec_summary_deliveries(report_id);
CREATE UNIQUE INDEX IF NOT EXISTS exec_summary_deliveries_schedule_uidx
  ON exec_summary_deliveries(schedule_key) WHERE schedule_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS exec_summary_deliveries_retry_idx
  ON exec_summary_deliveries(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS exec_summary_delivery_attempts (
  id SERIAL PRIMARY KEY,
  delivery_id INTEGER NOT NULL CONSTRAINT exec_summary_attempt_delivery_fk
    REFERENCES exec_summary_deliveries(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  request_key VARCHAR(200) NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'sending',
  provider_message_id VARCHAR(255),
  provider_status INTEGER,
  reason TEXT,
  retryable BOOLEAN,
  ambiguous BOOLEAN NOT NULL DEFAULT FALSE,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS exec_summary_delivery_attempts_request_uidx
  ON exec_summary_delivery_attempts(request_key);
CREATE UNIQUE INDEX IF NOT EXISTS exec_summary_delivery_attempts_delivery_attempt_unique
  ON exec_summary_delivery_attempts(delivery_id, attempt_number);
CREATE INDEX IF NOT EXISTS exec_summary_delivery_attempts_delivery_idx
  ON exec_summary_delivery_attempts(delivery_id, attempted_at DESC);
`;

export async function ensureExecSummaryDeliverySchema(pool: Pool): Promise<void> {
  // pg permits multiple DDL statements in one simple query.  Keep this
  // idempotent migration awaited: a scheduler must never query a table that
  // a fresh development database has not created yet.
  await pool.query(EXEC_SUMMARY_DELIVERY_SCHEMA_SQL);
}

export const MAX_AUTOMATIC_ATTEMPTS = 5;
const LEASE_MS = 2 * 60_000;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

export function boundedRetryDelayMs(attemptNumber: number, retryAfterMs?: number): number {
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attemptNumber - 1));
  const providerDelay = Number.isFinite(retryAfterMs) ? Math.max(0, Number(retryAfterMs)) : 0;
  // Respect a provider's 429 instruction but do not allow corrupt/hostile
  // values to turn a durable queue into a years-long invisible wait.
  return Math.min(MAX_BACKOFF_MS, Math.max(exponential, providerDelay));
}

type ClaimedAttempt = {
  kind: "claimed";
  delivery: any;
  attempt: any;
  token: string;
};
type ClaimResult = ClaimedAttempt | {
  kind: "deduped" | "in_progress" | "accepted" | "review_required" | "not_due" | "exhausted" | "not_found";
  delivery?: any;
  attempt?: any;
};

function publicDelivery(row: any, attempts: any[] = []) {
  if (!row) return null;
  return {
    id: Number(row.id),
    reportId: Number(row.report_id),
    scheduleKey: row.schedule_key,
    state: row.state as DeliveryState,
    // Accepted only means SendGrid accepted the request.  Delivery remains
    // unconfirmed unless a future webhook integration records it.
    acceptanceStatus: row.state === "accepted" ? "accepted" : "not_accepted",
    deliveryStatus: "unconfirmed",
    deliveryConfirmed: false,
    acceptedAt: row.accepted_at,
    providerMessageId: row.provider_message_id,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: row.next_attempt_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    leaseUntil: row.lease_until,
    updatedAt: row.updated_at,
    attempts: attempts.map((attempt) => ({
      id: Number(attempt.id),
      attemptNumber: Number(attempt.attempt_number),
      requestKey: attempt.request_key,
      state: attempt.state,
      providerMessageId: attempt.provider_message_id,
      providerStatus: attempt.provider_status,
      reason: attempt.reason,
      retryable: attempt.retryable,
      ambiguous: Boolean(attempt.ambiguous),
      attemptedAt: attempt.attempted_at,
      completedAt: attempt.completed_at,
    })),
  };
}

export class PostgresExecSummaryDeliveryStore {
  constructor(private readonly pool: Pool) {}

  async getStatus(reportId: number) {
    const delivery = (await this.pool.query(
      "SELECT * FROM exec_summary_deliveries WHERE report_id=$1", [reportId],
    )).rows[0];
    if (!delivery) return null;
    const attempts = (await this.pool.query(
      "SELECT * FROM exec_summary_delivery_attempts WHERE delivery_id=$1 ORDER BY attempted_at DESC, id DESC",
      [delivery.id],
    )).rows;
    return publicDelivery(delivery, attempts);
  }

  async listDueReportIds(limit = 25): Promise<number[]> {
    const result = await this.pool.query(
      `SELECT report_id FROM exec_summary_deliveries
       WHERE (
         state IN ('pending','failed') AND next_attempt_at <= now() AND attempt_count < $1
       ) OR (
         state='sending' AND lease_until <= now()
       )
       ORDER BY next_attempt_at ASC NULLS FIRST LIMIT $2`,
      [MAX_AUTOMATIC_ATTEMPTS, limit],
    );
    return result.rows.map((row) => Number(row.report_id));
  }

  async create(reportId: number, payload: ExecSummaryDeliveryPayload, scheduleKey?: string) {
    const result = await this.pool.query(
      `INSERT INTO exec_summary_deliveries (report_id, schedule_key, payload, next_attempt_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (report_id) DO NOTHING RETURNING *`,
      [reportId, scheduleKey ?? null, JSON.stringify(payload)],
    );
    return result.rows[0] ?? null;
  }

  async hasSchedule(scheduleKey: string): Promise<boolean> {
    return ((await this.pool.query(
      "SELECT 1 FROM exec_summary_deliveries WHERE schedule_key=$1", [scheduleKey],
    )).rowCount ?? 0) > 0;
  }

  private async claim(reportId: number, requestKey: string, resend: boolean, automatic: boolean): Promise<ClaimResult> {
    const token = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '3s'");
      const delivery = (await client.query(
        "SELECT * FROM exec_summary_deliveries WHERE report_id=$1 FOR UPDATE", [reportId],
      )).rows[0];
      if (!delivery) {
        await client.query("COMMIT");
        return { kind: "not_found" };
      }
      // A process can die after beginning an HTTP request.  Once its lease
      // expires we still cannot infer whether SendGrid accepted that request;
      // turn it into a visible ambiguity rather than automatically duplicating
      // the email.  Only an explicit `resend:true` may proceed from here.
      if (
        delivery.state === "sending" &&
        delivery.lease_until &&
        new Date(delivery.lease_until).getTime() <= Date.now()
      ) {
        const reason = "A prior sending lease expired; provider acceptance is unknown. Review provider history before an intentional resend.";
        await client.query(
          `UPDATE exec_summary_deliveries
           SET state='ambiguous',lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,
               last_error=$2,updated_at=now() WHERE id=$1`,
          [delivery.id, reason],
        );
        await client.query(
          `UPDATE exec_summary_delivery_attempts
           SET state='ambiguous',ambiguous=TRUE,reason=$2,completed_at=now()
           WHERE delivery_id=$1 AND attempt_number=$3 AND state='sending'`,
          [delivery.id, reason, delivery.attempt_count],
        );
        if (!resend) {
          await client.query("COMMIT");
          return { kind: "review_required" };
        }
      }
      const duplicate = (await client.query(
        "SELECT * FROM exec_summary_delivery_attempts WHERE request_key=$1", [requestKey],
      )).rows[0];
      if (duplicate) {
        await client.query("COMMIT");
        return { kind: "deduped", delivery, attempt: duplicate };
      }
      if (delivery.lease_until && new Date(delivery.lease_until).getTime() > Date.now()) {
        await client.query("COMMIT");
        return { kind: "in_progress", delivery };
      }
      if (delivery.state === "accepted" && !resend) {
        await client.query("COMMIT");
        return { kind: "accepted", delivery };
      }
      // A timeout has no safe answer.  The requester must deliberately choose
      // resend, which creates a separately auditable intentional duplicate.
      if (delivery.state === "ambiguous" && !resend) {
        await client.query("COMMIT");
        return { kind: "review_required", delivery };
      }
      if (automatic && Number(delivery.attempt_count) >= MAX_AUTOMATIC_ATTEMPTS) {
        await client.query("COMMIT");
        return { kind: "exhausted", delivery };
      }
      if (automatic && delivery.next_attempt_at && new Date(delivery.next_attempt_at).getTime() > Date.now()) {
        await client.query("COMMIT");
        return { kind: "not_due", delivery };
      }
      const attemptNumber = Number(delivery.attempt_count) + 1;
      const attempt = (await client.query(
        `INSERT INTO exec_summary_delivery_attempts (delivery_id,attempt_number,request_key,state)
         VALUES ($1,$2,$3,'sending') RETURNING *`,
        [delivery.id, attemptNumber, requestKey],
      )).rows[0];
      const claimed = (await client.query(
        `UPDATE exec_summary_deliveries
         SET state='sending',attempt_count=$3,lease_token=$2,
             lease_until=now() + ($4 * interval '1 millisecond'),
             next_attempt_at=NULL,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [delivery.id, token, attemptNumber, LEASE_MS],
      )).rows[0];
      await client.query("COMMIT");
      return { kind: "claimed", delivery: claimed, attempt, token };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async deliver(
    reportId: number,
    options: { resend?: boolean; requestKey: string; automatic?: boolean },
    send: (payload: ExecSummaryDeliveryPayload) => Promise<ProviderEmailResult>,
  ) {
    const claim = await this.claim(reportId, options.requestKey, Boolean(options.resend), Boolean(options.automatic));
    if (claim.kind !== "claimed") {
      return { action: claim.kind, delivery: await this.getStatus(reportId) };
    }

    let result: ProviderEmailResult;
    try {
      result = await send(claim.delivery.payload as ExecSummaryDeliveryPayload);
    } catch {
      // An exception after the HTTP request begins is ambiguous by definition.
      // Do not persist arbitrary thrown text: HTTP libraries and provider
      // clients can include authorization/request details in their messages.
      result = {
        sent: false,
        ambiguous: true,
        reason: "Provider request outcome is unknown; review provider history before an intentional resend.",
      };
    }

    const accepted = result.sent === true;
    // Be conservative while preserving compatibility with the pre-Task-57
    // email result shape: a transport result with no HTTP status is unknown
    // unless it is one of the local validations that definitively made no
    // request.  New email.ts explicitly supplies `ambiguous`.
    const definitelyNotSubmitted = /no valid recipient|api_key is not set|dryrun/i.test(result.reason || "");
    const ambiguous = !accepted && (
      result.ambiguous === true ||
      (!result.status && result.retryable !== false && !definitelyNotSubmitted)
    );
    const retryable = !accepted && !ambiguous && (
      result.retryable === true ||
      result.retryable === undefined && (result.status === 429 || (result.status ?? 0) >= 500)
    );
    const attemptNumber = Number(claim.attempt.attempt_number);
    const automaticRetry = retryable && attemptNumber < MAX_AUTOMATIC_ATTEMPTS;
    const nextAttemptAt = automaticRetry
      ? new Date(Date.now() + boundedRetryDelayMs(attemptNumber, result.retryAfterMs))
      : null;
    const state: DeliveryState = accepted ? "accepted" : ambiguous ? "ambiguous" : "failed";
    const reason = result.reason?.slice(0, 2000) || (accepted ? null : "Provider did not accept the message.");

    // A recovered expired lease gets a fresh token.  Never overwrite a newer
    // worker's finalization if an old process wakes up late.
    // Finalize the delivery and its attempt in one transaction.  A crash
    // between these rows would otherwise falsely leave an accepted attempt
    // displayed as "sending" in the audit ledger.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const complete = await client.query(
        `UPDATE exec_summary_deliveries
         SET state=$3, lease_token=NULL, lease_until=NULL, next_attempt_at=$4,
             accepted_at=CASE WHEN $3='accepted' THEN now() ELSE accepted_at END,
             provider_message_id=COALESCE($5, provider_message_id),
             last_status=$6,last_error=$7,updated_at=now()
         WHERE id=$1 AND lease_token=$2 RETURNING *`,
        [claim.delivery.id, claim.token, state, nextAttemptAt, result.messageId ?? null, result.status ?? null, reason],
      );
      if (complete.rowCount === 1) {
        await client.query(
        `UPDATE exec_summary_delivery_attempts
         SET state=$2,provider_message_id=$3,provider_status=$4,reason=$5,
             retryable=$6,ambiguous=$7,completed_at=now()
         WHERE id=$1`,
          [claim.attempt.id, state, result.messageId ?? null, result.status ?? null, reason, retryable, ambiguous],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return {
      action: accepted ? "accepted" : ambiguous ? "ambiguous" : automaticRetry ? "retry_scheduled" : "failed",
      provider: result,
      delivery: await this.getStatus(reportId),
    };
  }
}