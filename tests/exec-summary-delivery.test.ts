import { describe, expect, it, vi } from "vitest";
import {
  PostgresExecSummaryDeliveryStore,
  boundedRetryDelayMs,
} from "../server/services/exec-summary-delivery";
import {
  execSummaryDeliveryPlan,
  execSummaryScheduleKey,
  isExecSummaryDue,
} from "../server/services/weekly-exec-summary";

// A deliberately tiny pg mock: provider calls are vi.fn values, never fetches.
// It exercises the store's claim/finalize decisions without a database.
class DeliveryPoolMock {
  delivery: any | null;
  attempts: any[] = [];
  private locked = false;
  private waiters: Array<() => void> = [];
  constructor(withDelivery = true) {
    this.delivery = withDelivery ? {
      id: 1, report_id: 44, state: "pending", attempt_count: 0,
      payload: { to: ["owner@example.com"], subject: "Weekly", html: "<p>x</p>", text: "x" },
      lease_until: null, lease_token: null, next_attempt_at: null,
      accepted_at: null, provider_message_id: null, last_status: null,
      last_error: null, updated_at: new Date(),
    } : null;
  }
  async connect() {
    const session = { ownsLock: false };
    return {
      query: async (query: string, params: any[] = []) => {
        const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
        if (normalized.includes("from exec_summary_deliveries") && normalized.includes("for update")) {
          while (this.locked) await new Promise<void>((resolve) => this.waiters.push(resolve));
          this.locked = true;
          session.ownsLock = true;
        }
        const result = await this.query(query, params);
        if ((normalized === "commit" || normalized === "rollback") && session.ownsLock) {
          this.locked = false;
          session.ownsLock = false;
          this.waiters.shift()?.();
        }
        return result;
      },
      release() {},
    };
  }
  async query(query: string, params: any[] = []) {
    const q = query.replace(/\s+/g, " ").trim().toLowerCase();
    if (["begin", "commit", "rollback"].includes(q) || q.startsWith("set local")) return { rows: [], rowCount: 0 };
    if (q.startsWith("select 1 from exec_summary_deliveries where schedule_key")) return {
      rows: this.delivery?.schedule_key === params[0] ? [{ "?column?": 1 }] : [],
      rowCount: this.delivery?.schedule_key === params[0] ? 1 : 0,
    };
    if (q.startsWith("select * from exec_summary_deliveries")) return {
      rows: this.delivery?.report_id === params[0] ? [this.delivery] : [], rowCount: this.delivery?.report_id === params[0] ? 1 : 0,
    };
    if (q.startsWith("insert into exec_summary_deliveries")) {
      this.delivery = {
        id: 1, report_id: params[0], schedule_key: params[1], payload: JSON.parse(params[2]),
        state: "pending", attempt_count: 0, lease_until: null, lease_token: null,
        next_attempt_at: new Date(), accepted_at: null, provider_message_id: null,
        last_status: null, last_error: null, updated_at: new Date(),
      };
      return { rows: [this.delivery], rowCount: 1 };
    }
    if (q.startsWith("select * from exec_summary_delivery_attempts where request_key")) {
      const row = this.attempts.find((a) => a.request_key === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (q.startsWith("select * from exec_summary_delivery_attempts where delivery_id")) {
      return { rows: this.attempts.filter((a) => a.delivery_id === params[0]), rowCount: this.attempts.length };
    }
    if (q.startsWith("insert into exec_summary_delivery_attempts")) {
      const row = {
        id: this.attempts.length + 1, delivery_id: params[0], attempt_number: params[1],
        request_key: params[2], state: "sending", attempted_at: new Date(), completed_at: null,
      };
      this.attempts.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (q.startsWith("update exec_summary_deliveries set state='sending'")) {
      Object.assign(this.delivery, {
        state: "sending", attempt_count: params[2], lease_token: params[1],
        lease_until: new Date(Date.now() + Number(params[3])), next_attempt_at: null,
      });
      return { rows: [this.delivery], rowCount: 1 };
    }
    if (q.startsWith("update exec_summary_deliveries set state='ambiguous'")) {
      Object.assign(this.delivery, { state: "ambiguous", lease_token: null, lease_until: null, last_error: params[1] });
      return { rows: [this.delivery], rowCount: 1 };
    }
    if (q.startsWith("update exec_summary_delivery_attempts set state='ambiguous'")) {
      const row = this.attempts.find((a) => a.delivery_id === params[0] && a.attempt_number === params[2]);
      if (row) Object.assign(row, { state: "ambiguous", ambiguous: true, reason: params[1], completed_at: new Date() });
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (q.startsWith("update exec_summary_deliveries set state=$3")) {
      if (this.delivery.lease_token !== params[1]) return { rows: [], rowCount: 0 };
      Object.assign(this.delivery, {
        state: params[2], lease_token: null, lease_until: null, next_attempt_at: params[3],
        provider_message_id: params[4] ?? this.delivery.provider_message_id,
        last_status: params[5], last_error: params[6],
        accepted_at: params[2] === "accepted" ? new Date() : this.delivery.accepted_at,
      });
      return { rows: [this.delivery], rowCount: 1 };
    }
    if (q.startsWith("update exec_summary_delivery_attempts set state=$2")) {
      const row = this.attempts.find((a) => a.id === params[0]);
      Object.assign(row, { state: params[1], provider_message_id: params[2], provider_status: params[3], reason: params[4] });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected mock SQL: ${query}`);
  }
}

describe("executive summary durable delivery", () => {
  it("deduplicates a repeated click request key without a second provider call", async () => {
    const pool = new DeliveryPoolMock();
    const store = new PostgresExecSummaryDeliveryStore(pool as any);
    const provider = vi.fn().mockResolvedValue({ sent: true, status: 202, messageId: "sg-1" });
    const first = await store.deliver(44, { requestKey: "click-1" }, provider);
    const replay = await store.deliver(44, { requestKey: "click-1" }, provider);
    expect(first.action).toBe("accepted");
    expect(replay.action).toBe("deduped");
    expect(provider).toHaveBeenCalledTimes(1);
    expect(first.delivery?.deliveryConfirmed).toBe(false);
  });

  it("lets a generated-only report acquire its first durable send from its saved payload", async () => {
    const pool = new DeliveryPoolMock(false);
    const store = new PostgresExecSummaryDeliveryStore(pool as any);
    expect(await store.getStatus(44)).toBeNull(); // generate-only/dry-run: no intent
    await store.create(44, {
      to: ["owner@example.com"], subject: "saved report", html: "<p>saved</p>", text: "saved",
    });
    const provider = vi.fn().mockResolvedValue({ sent: true, status: 202 });
    const result = await store.deliver(44, { requestKey: "first-real-send" }, provider);
    expect(result.action).toBe("accepted");
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ subject: "saved report", text: "saved" }));
  });

  it("does not let generate-only/dry-run state consume a scheduled ET-week key", async () => {
    const pool = new DeliveryPoolMock(false);
    const store = new PostgresExecSummaryDeliveryStore(pool as any);
    const key = "2026-09-14";
    // No store.create call represents both generate-only and dry-run.
    expect(await store.hasSchedule(key)).toBe(false);
    await store.create(44, {
      to: ["owner@example.com"], subject: "scheduled snapshot", html: "<p>x</p>", text: "x",
    }, key);
    expect(await store.hasSchedule(key)).toBe(true);
  });

  it("orchestrates generate-only and dry-run without recipient/provider delivery work", () => {
    const afterWednesday = new Date("2026-09-16T20:01:00.000Z");
    const generatedOnly = execSummaryDeliveryPlan({ send: false }, afterWednesday);
    const dryRun = execSummaryDeliveryPlan({ dryRun: true }, afterWednesday);
    const dryRunScheduled = execSummaryDeliveryPlan({ dryRun: true, scheduleKey: "2026-09-14" }, afterWednesday);
    const scheduled = execSummaryDeliveryPlan({ send: true }, afterWednesday);
    expect(generatedOnly).toMatchObject({ createDelivery: false, deliveryKey: undefined });
    expect(dryRun).toMatchObject({
      createDelivery: false, deliveryKey: undefined, dryRunDiagnostic: "dryRun",
    });
    expect(dryRunScheduled.deliveryKey).toBeUndefined();
    // The immediately-following live scheduled path is therefore still free
    // to claim this ET week; it is not suppressed by either prior operation.
    expect(scheduled).toMatchObject({ createDelivery: true, deliveryKey: "2026-09-14" });
  });

  it("uses a shared weekly key for live runs due after Wednesday, manual key before it", () => {
    const beforeWednesday = new Date("2026-09-16T19:59:00.000Z");
    const afterWednesday = new Date("2026-09-16T20:01:00.000Z");
    expect(execSummaryDeliveryPlan({ send: true }, beforeWednesday).deliveryKey).toBe("m:2026-09-16");
    expect(execSummaryDeliveryPlan({ send: true }, afterWednesday).deliveryKey).toBe("2026-09-14");
    expect(execSummaryDeliveryPlan({ send: true, scheduleKey: "2026-09-14" }, afterWednesday).deliveryKey)
      .toBe("2026-09-14");
  });

  it("allows only one mocked provider submission for concurrent clicks", async () => {
    const pool = new DeliveryPoolMock();
    const store = new PostgresExecSummaryDeliveryStore(pool as any);
    const provider = vi.fn().mockResolvedValue({ sent: true, status: 202 });
    const [one, two] = await Promise.all([
      store.deliver(44, { requestKey: "concurrent-a" }, provider),
      store.deliver(44, { requestKey: "concurrent-b" }, provider),
    ]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect([one.action, two.action]).toContain("in_progress");
  });

  it("reclaims a pending durable row after restart and sends its persisted envelope", async () => {
    const pool = new DeliveryPoolMock();
    pool.delivery.next_attempt_at = new Date(Date.now() - 1);
    const provider = vi.fn().mockResolvedValue({ sent: true, status: 202 });
    const result = await new PostgresExecSummaryDeliveryStore(pool as any).deliver(
      44, { requestKey: "restart-pending", automatic: true }, provider,
    );
    expect(result.action).toBe("accepted");
    expect(provider).toHaveBeenCalledWith(pool.delivery.payload);
  });

  it("schedules bounded retry for mocked provider 429/5xx outcomes", async () => {
    expect(boundedRetryDelayMs(1, 10)).toBe(60_000);
    expect(boundedRetryDelayMs(99, 9_999_999_999)).toBe(60 * 60_000);
    const pool = new DeliveryPoolMock();
    const store = new PostgresExecSummaryDeliveryStore(pool as any);
    const outcome = await store.deliver(44, { requestKey: "429" }, async () => ({
      sent: false, status: 429, reason: "rate limited", retryable: true, retryAfterMs: 120_000,
    }));
    expect(outcome.action).toBe("retry_scheduled");
    expect(outcome.delivery?.state).toBe("failed");
    expect(outcome.delivery?.nextAttemptAt).toBeTruthy();
  });

  it("stops automatic provider retries after five accepted-safe failures", async () => {
    const pool = new DeliveryPoolMock();
    const store = new PostgresExecSummaryDeliveryStore(pool as any);
    const provider = vi.fn().mockResolvedValue({
      sent: false, status: 503, reason: "temporary service failure", retryable: true,
    });
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await store.deliver(44, {
        requestKey: `automatic-5xx-${attempt}`, automatic: true,
      }, provider);
      expect(["retry_scheduled", "failed"]).toContain(result.action);
      // Simulate the durable retry poll reaching its persisted due time.
      if (pool.delivery) pool.delivery.next_attempt_at = new Date(Date.now() - 1);
    }
    const exhausted = await store.deliver(44, {
      requestKey: "automatic-5xx-6", automatic: true,
    }, provider);
    expect(exhausted.action).toBe("exhausted");
    expect(provider).toHaveBeenCalledTimes(5);
  });

  it("requires an explicit resend after accepted/ambiguous results and dedups its stable key", async () => {
    const pool = new DeliveryPoolMock();
    const store = new PostgresExecSummaryDeliveryStore(pool as any);
    const provider = vi.fn().mockResolvedValue({ sent: true, status: 202 });
    await store.deliver(44, { requestKey: "accepted-original" }, provider);
    expect((await store.deliver(44, { requestKey: "plain-retry" }, provider)).action).toBe("accepted");
    expect((await store.deliver(44, { resend: true, requestKey: "intentional-resend" }, provider)).action).toBe("accepted");
    expect((await store.deliver(44, { resend: true, requestKey: "intentional-resend" }, provider)).action).toBe("deduped");
    expect(provider).toHaveBeenCalledTimes(2);

    pool.delivery!.state = "ambiguous";
    const ambiguousResend = await store.deliver(44, {
      resend: true, requestKey: "ambiguous-reviewed-resend",
    }, provider);
    expect(ambiguousResend.action).toBe("accepted");
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it("marks an expired in-flight lease ambiguous on restart, without provider resend", async () => {
    const pool = new DeliveryPoolMock();
    pool.delivery.state = "sending";
    pool.delivery.attempt_count = 1;
    pool.delivery.lease_until = new Date(Date.now() - 1);
    pool.attempts.push({ id: 1, delivery_id: 1, attempt_number: 1, request_key: "before-restart", state: "sending" });
    const provider = vi.fn();
    const result = await new PostgresExecSummaryDeliveryStore(pool as any)
      .deliver(44, { requestKey: "after-restart" }, provider);
    expect(result.action).toBe("review_required");
    expect(provider).not.toHaveBeenCalled();
    expect(result.delivery?.state).toBe("ambiguous");
  });

  it("treats Sunday ET as catch-up due for the same Monday reporting week", () => {
    // Sunday Sept 20, 2026 at 4 PM ET (20:00Z while daylight saving is active).
    const sundayEt = new Date("2026-09-20T20:00:00.000Z");
    expect(isExecSummaryDue(sundayEt)).toBe(true);
    expect(execSummaryScheduleKey(sundayEt)).toBe("2026-09-14");
  });

  it("marks a missed Wednesday startup due with the correct ET-week key", () => {
    // Wednesday Sept 16, 2026 at 4:01 PM ET.
    const afterWednesdayTarget = new Date("2026-09-16T20:01:00.000Z");
    expect(isExecSummaryDue(afterWednesdayTarget)).toBe(true);
    expect(execSummaryScheduleKey(afterWednesdayTarget)).toBe("2026-09-14");
  });
});