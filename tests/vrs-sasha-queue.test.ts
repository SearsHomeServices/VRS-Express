import { afterEach, describe, expect, it } from "vitest";
import type { VrsAuthorizeRequest } from "../server/vrs-sasha-contract";
import {
  DurableVrsAiCallQueue,
  type NewVrsAiCallRecord,
  type VrsAiCallDatabase,
  type VrsAiCallTransaction,
} from "../server/vrs-sasha-queue";

const requestPayload: VrsAuthorizeRequest = {
  service_order: "13538277",
  tech_id: "0123456",
  tech_phone: "+12145550199",
  tech_name: "Carlos Rivera",
  reason_for_call: "authorization",
  callback_url:
    "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
  callback_secret: "sasha-test-secret-with-at-least-32-characters",
  parts: [
    {
      part_id: "WPW10503278",
      part_description: "Electronic Control Board",
      sell_price: 245,
      part_function: "Controls wash cycle timing and motor speed.",
    },
  ],
  customer_name: "Maria Gonzalez",
  customer_address: "742 Evergreen Terrace, Hagerstown, MD 21740",
  service_address: "742 Evergreen Terrace, Hagerstown, MD 21740",
  brand: "Whirlpool",
  model_number: "WTW5000DW1",
  serial_number: "C31290822",
  appliance_type: "Washer",
  appliance_age: 4,
  labor_amount: 120,
  tax_amount: 15.6,
  part_price: 245,
  appliance_location: "laundry room",
  failure_cause: "normal-wear",
  tech_recommendation: "repair",
  repair_replace_rationale:
    "Board failure is isolated and repair is within the coverage threshold.",
};

class FakeTransaction implements VrsAiCallTransaction {
  lockedServiceOrder?: string;
  activeCall?: { callId: string; state: string };
  techCallTimes: Date[] = [];
  activeCallCount = 0;
  inserted?: NewVrsAiCallRecord;

  async lockServiceOrder(serviceOrder: string): Promise<void> {
    this.lockedServiceOrder = serviceOrder;
  }

  async findActiveByServiceOrder(): Promise<
    { callId: string; state: string } | undefined
  > {
    return this.activeCall;
  }

  async getTechCallTimesSince(): Promise<Date[]> {
    return this.techCallTimes;
  }

  async countActiveCalls(): Promise<number> {
    return this.activeCallCount;
  }

  async insert(record: NewVrsAiCallRecord): Promise<void> {
    this.inserted = record;
  }
}

class FakeDatabase implements VrsAiCallDatabase {
  constructor(readonly tx: FakeTransaction) {}

  async transaction<T>(
    work: (transaction: VrsAiCallTransaction) => Promise<T>,
  ): Promise<T> {
    return work(this.tx);
  }
}

describe("durable VRS AI call queue", () => {
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("locks the service order and returns the existing active call", async () => {
    process.env.SESSION_SECRET = "queue-test-session-secret";
    const tx = new FakeTransaction();
    tx.activeCall = {
      callId: "vrs_call_existing",
      state: "queued",
    };
    const queue = new DurableVrsAiCallQueue(new FakeDatabase(tx));

    const result = await queue.enqueue(requestPayload);

    expect(tx.lockedServiceOrder).toBe("13538277");
    expect(result).toEqual({
      kind: "duplicate",
      existingCallId: "vrs_call_existing",
      state: "in_progress",
    });
    expect(tx.inserted).toBeUndefined();
  });

  it("enforces ten requests per tech in a rolling hour", async () => {
    process.env.SESSION_SECRET = "queue-test-session-secret";
    const now = new Date("2026-05-13T19:30:00.000Z");
    const tx = new FakeTransaction();
    tx.techCallTimes = Array.from(
      { length: 10 },
      (_, index) => new Date(now.getTime() - (30 - index) * 60_000),
    );
    const queue = new DurableVrsAiCallQueue(
      new FakeDatabase(tx),
      () => now,
    );

    const result = await queue.enqueue(requestPayload);

    expect(result).toEqual({
      kind: "rate_limited",
      scope: "tech",
      retryAfterSeconds: 1800,
    });
    expect(tx.inserted).toBeUndefined();
  });

  it("enforces the global 100-active-call cap", async () => {
    process.env.SESSION_SECRET = "queue-test-session-secret";
    const tx = new FakeTransaction();
    tx.activeCallCount = 100;
    const queue = new DurableVrsAiCallQueue(new FakeDatabase(tx));

    const result = await queue.enqueue(requestPayload);

    expect(result).toEqual({
      kind: "rate_limited",
      scope: "global",
      retryAfterSeconds: 60,
    });
    expect(tx.inserted).toBeUndefined();
  });

  it("persists a sanitized payload and encrypted callback secret", async () => {
    process.env.SESSION_SECRET = "queue-test-session-secret";
    const now = new Date("2026-05-13T19:30:00.000Z");
    const tx = new FakeTransaction();
    const queue = new DurableVrsAiCallQueue(
      new FakeDatabase(tx),
      () => now,
      () => "vrs_call_abc123",
    );

    const result = await queue.enqueue(requestPayload);

    expect(result).toEqual({
      kind: "queued",
      callId: "vrs_call_abc123",
      serviceOrder: "13538277",
      state: "queued",
      createdAt: now,
    });
    expect(tx.inserted).toMatchObject({
      callId: "vrs_call_abc123",
      serviceOrder: "13538277",
      techId: "0123456",
      callbackUrl:
        "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
      state: "queued",
      createdAt: now,
    });
    expect(tx.inserted?.requestPayload).not.toHaveProperty("callback_secret");
    expect(JSON.stringify(tx.inserted)).not.toContain(
      requestPayload.callback_secret,
    );
    expect(tx.inserted?.callbackSecretCipher).toBeTruthy();
  });
});
