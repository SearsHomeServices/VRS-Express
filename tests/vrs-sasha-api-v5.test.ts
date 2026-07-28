import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVrsWebhookSignature,
  deliverVrsWebhook,
  type VrsWebhookEvent,
  vrsAuthorizeRequestSchema,
} from "../server/vrs-sasha-contract";
import {
  registerVrsSashaApi,
  type EnqueueVrsAiCallResult,
  type VrsAiCallQueue,
} from "../server/vrs-sasha-api";
import {
  decryptVrsCallbackSecret,
  encryptVrsCallbackSecret,
} from "../server/vrs-sasha-secret";

const validPayload = {
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
  appliance_grade: "mid",
  partner_id: "ahs",
  appliance_photos: ["https://srdm.example.com/photo_1.jpg"],
  comments: [
    {
      tech_id: "0123456",
      work_item: "failure_diagnosis",
      text: "Diagnostic code F7E1.",
      timestamp: "2026-05-12T13:55:00Z",
    },
  ],
};

class FakeQueue implements VrsAiCallQueue {
  public received: unknown;

  constructor(private readonly result: EnqueueVrsAiCallResult) {}

  async enqueue(input: unknown): Promise<EnqueueVrsAiCallResult> {
    this.received = input;
    return this.result;
  }
}

function makeApp(queue: VrsAiCallQueue, apiKey = "test-vrs-api-key") {
  const app = express();
  app.use(express.json());
  registerVrsSashaApi(app, { apiKey, queue });
  return app;
}

describe("VRS ↔ SASHA API Contract V5", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SESSION_SECRET;
  });

  it("accepts the V5 payload and rejects renamed V4 aliases", () => {
    expect(vrsAuthorizeRequestSchema.safeParse(validPayload).success).toBe(true);

    const v4Payload = {
      ...validPayload,
      appliance_grade: undefined,
      appliance_photos: undefined,
      end_level: "mid",
      diagnostic_photos: ["https://srdm.example.com/legacy.jpg"],
    };
    const parsed = vrsAuthorizeRequestSchema.safeParse(v4Payload);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path[0])).toEqual(
        expect.arrayContaining(["end_level", "diagnostic_photos"]),
      );
    }

    expect(
      vrsAuthorizeRequestSchema.safeParse({
        ...validPayload,
        labor_amount: 120.001,
      }).success,
    ).toBe(false);
  });

  it("rejects callback URLs outside the two confirmed SASHA hosts", () => {
    const parsed = vrsAuthorizeRequestSchema.safeParse({
      ...validPayload,
      callback_url: "https://attacker.example/webhook",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toEqual(["callback_url"]);
    }

    expect(
      vrsAuthorizeRequestSchema.safeParse({
        ...validPayload,
        callback_url:
          "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook?forward=attacker",
      }).success,
    ).toBe(false);
  });

  it("returns the contract 202 envelope when a call is durably queued", async () => {
    const queue = new FakeQueue({
      kind: "queued",
      callId: "vrs_call_abc123",
      serviceOrder: "13538277",
      state: "queued",
      createdAt: new Date("2026-05-13T19:30:00.000Z"),
    });

    const response = await request(makeApp(queue))
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send(validPayload);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      call_id: "vrs_call_abc123",
      service_order: "13538277",
      state: "queued",
      created_at: "2026-05-13T19:30:00.000Z",
    });
    expect(queue.received).toMatchObject({
      service_order: "13538277",
      tech_id: "0123456",
    });
  });

  it("returns 409 with the existing active call", async () => {
    const queue = new FakeQueue({
      kind: "duplicate",
      existingCallId: "vrs_call_existing",
      state: "in_progress",
    });

    const response = await request(makeApp(queue))
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send(validPayload);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "DUPLICATE_CALL",
      message:
        "A call is already in progress for service order 13538277",
      existing_call_id: "vrs_call_existing",
      state: "in_progress",
    });
  });

  it("returns the contract rate-limit response for the per-tech cap", async () => {
    const queue = new FakeQueue({
      kind: "rate_limited",
      scope: "tech",
      retryAfterSeconds: 1800,
    });

    const response = await request(makeApp(queue))
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send(validPayload);

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      error: "RATE_LIMITED",
      message: "Tech 0123456 has exceeded 10 calls/hour",
      retry_after_seconds: 1800,
    });
  });

  it("rejects a bad API key before enqueueing", async () => {
    const queue = new FakeQueue({
      kind: "queued",
      callId: "must-not-run",
      serviceOrder: "13538277",
      state: "queued",
      createdAt: new Date(),
    });

    const response = await request(makeApp(queue))
      .post("/vrs/authorize")
      .set("X-API-Key", "wrong-key")
      .send(validPayload);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: "UNAUTHORIZED",
      message: "Invalid or missing API key",
    });
    expect(queue.received).toBeUndefined();
  });

  it("returns field names for invalid request bodies", async () => {
    const queue = new FakeQueue({
      kind: "queued",
      callId: "must-not-run",
      serviceOrder: "13538277",
      state: "queued",
      createdAt: new Date(),
    });

    const response = await request(makeApp(queue))
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send({ ...validPayload, parts: [] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(response.body.fields).toContain("parts");
    expect(queue.received).toBeUndefined();
  });

  it("matches the standard HMAC-SHA256 test vector", () => {
    expect(
      createVrsWebhookSignature(
        "The quick brown fox jumps over the lazy dog",
        "key",
      ),
    ).toBe(
      "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("retries only retryable webhook failures and reuses the event id", async () => {
    const statuses = [503, 502, 200];
    const sent: Array<{ body: string; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sent.push({
        body: String(init?.body),
        headers: new Headers(init?.headers),
      });
      return new Response("{}", { status: statuses.shift() ?? 500 });
    });
    const event: VrsWebhookEvent = {
      version: 1,
      eventId: "evt_001",
      callId: "vrs_abc",
      soNo: "13538277",
      occurredAt: "2026-05-13T19:42:00Z",
      state: "approved",
      authNumber: "AHS-001",
      authorizedAmount: 365.6,
    };

    const result = await deliverVrsWebhook({
      callbackUrl: "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
      callbackSecret: "callback-secret",
      event,
      fetchImpl,
      sleep: async () => undefined,
      now: () => 1_768_000_000_000,
    });

    expect(result).toEqual({ delivered: true, attempts: 3, status: 200 });
    expect(sent).toHaveLength(3);
    expect(
      sent.map((requestAttempt) =>
        requestAttempt.headers.get("X-VRS-Event-Id"),
      ),
    ).toEqual(["evt_001", "evt_001", "evt_001"]);
    expect(new Set(sent.map((requestAttempt) => requestAttempt.body)).size).toBe(
      1,
    );
  });

  it("does not retry a webhook 400 response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 400 }),
    );
    const event: VrsWebhookEvent = {
      version: 1,
      eventId: "evt_bad",
      callId: "vrs_bad",
      soNo: "13538277",
      occurredAt: "2026-05-13T19:42:00Z",
      state: "failed",
      reason: "agent_error",
      retryable: false,
    };

    const result = await deliverVrsWebhook({
      callbackUrl: "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
      callbackSecret: "callback-secret",
      event,
      fetchImpl,
      sleep: async () => undefined,
    });

    expect(result).toEqual({ delivered: false, attempts: 1, status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("encrypts callback secrets at rest and detects tampering", () => {
    process.env.SESSION_SECRET =
      "unit-test-session-secret-that-is-long-enough";
    const encrypted = encryptVrsCallbackSecret(
      "sasha-callback-secret-value",
    );

    expect(JSON.stringify(encrypted)).not.toContain(
      "sasha-callback-secret-value",
    );
    expect(decryptVrsCallbackSecret(encrypted)).toBe(
      "sasha-callback-secret-value",
    );
    expect(() =>
      decryptVrsCallbackSecret({
        ...encrypted,
        cipher: `${encrypted.cipher.slice(0, -2)}AA`,
      }),
    ).toThrow();
  });
});
