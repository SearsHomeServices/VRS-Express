import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../server/vrs-sasha-api";
import * as contractModule from "../server/vrs-sasha-contract";
import {
  decryptVrsCallbackSecret,
  encryptVrsCallbackSecret,
} from "../server/vrs-sasha-secret";
import {
  signedTinaPhotoUrl,
  validV5AuthorizePayload,
  validV8AuthorizePayload,
} from "./fixtures/vrs-authorize-payloads";

const validPayload = validV5AuthorizePayload;

type IntakeResult =
  | {
      kind: "accepted";
      callId: string;
      serviceOrder: string;
      createdAt: Date;
    }
  | {
      kind: "duplicate";
      existingCallId: string;
      state: string;
    }
  | {
      kind: "unsupported_partner";
      partnerId: string;
    }
  | {
      kind: "rejected";
      status: 409 | 422;
      code: string;
      message: string;
    };

class FakeIntake {
  public received: unknown;

  constructor(private readonly result: IntakeResult) {}

  async receive(input: unknown): Promise<IntakeResult> {
    this.received = input;
    return this.result;
  }
}

class FakeServiceOrders {
  constructor(
    private readonly source?: {
      callId: string;
      state: string;
      requestPayload: Record<string, unknown>;
      submissionPhotos: string | null;
    },
  ) {}

  async getLatestByServiceOrder(serviceOrder: string) {
    return serviceOrder === "13538277" ? this.source : undefined;
  }
}

function makeIntakeApp(
  intake: FakeIntake,
  serviceOrderOptions?: {
    source?: ConstructorParameters<typeof FakeServiceOrders>[0];
    signObjectPhotoUrl?: (objectPath: string) => Promise<string>;
    now?: () => Date;
    activation?: ReturnType<
      typeof import("../server/vrs-stage-one-bridge").resolveVrsAiBridgeActivation
    >;
  },
) {
  const app = express();
  app.use(express.json());
  (apiModule.registerVrsSashaApi as any)(app, {
    apiKey: "test-vrs-api-key",
    intake,
    resolveBridgeActivation: serviceOrderOptions?.activation
      ? () => serviceOrderOptions.activation!
      : undefined,
    serviceOrders: new FakeServiceOrders(serviceOrderOptions?.source),
    signObjectPhotoUrl: serviceOrderOptions?.signObjectPhotoUrl,
    now: serviceOrderOptions?.now,
  });
  return app;
}

function makeUnconfiguredIntakeApp(intake: FakeIntake) {
  const app = express();
  app.use(express.json());
  (apiModule.registerVrsSashaApi as any)(app, { intake });
  return app;
}

function makeWebhookApp(
  sink: { receive(event: unknown): Promise<"processed" | "duplicate"> },
  webhookSecret = "express-ai-webhook-secret",
) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        req.rawBody = buffer;
      },
    }),
  );
  const register = (apiModule as any).registerVrsAiWebhookApi;
  if (typeof register === "function") {
    register(app, { webhookSecret, sink });
  }
  return app;
}

describe("VRS Express bridge — V5 contract boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SESSION_SECRET;
    delete process.env.VRS_BRIDGE_ENCRYPTION_KEY;
  });

  it("accepts the V5 payload and rejects renamed V4 aliases", () => {
    expect(
      contractModule.vrsAuthorizeRequestSchema.safeParse(validPayload).success,
    ).toBe(true);

    const v4Payload = {
      ...validPayload,
      appliance_grade: undefined,
      appliance_photos: undefined,
      end_level: "mid",
      diagnostic_photos: ["https://srdm.example.com/legacy.jpg"],
    };
    const parsed =
      contractModule.vrsAuthorizeRequestSchema.safeParse(v4Payload);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path[0])).toEqual(
        expect.arrayContaining(["end_level", "diagnostic_photos"]),
      );
    }
  });

  it("rejects upstream callback URLs outside the confirmed SASHA hosts", () => {
    expect(
      contractModule.vrsAuthorizeRequestSchema.safeParse({
        ...validPayload,
        callback_url: "https://attacker.example/webhook",
      }).success,
    ).toBe(false);

    expect(
      contractModule.vrsAuthorizeRequestSchema.safeParse({
        ...validPayload,
        callback_url:
          "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook?forward=attacker",
      }).success,
    ).toBe(false);
  });

  it("queues the request for VRS Express human review without admitting an AI call", async () => {
    const intake = new FakeIntake({
      kind: "accepted",
      callId: "vrs_call_bridge_123",
      serviceOrder: "13538277",
      createdAt: new Date("2026-07-24T17:01:52.000Z"),
    });

    const response = await request(makeIntakeApp(intake))
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send(validPayload);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      call_id: "vrs_call_bridge_123",
      service_order: "13538277",
      state: "queued",
      created_at: "2026-07-24T17:01:52.000Z",
    });
    expect(intake.received).toEqual(validPayload);
  });

  it("passes an authenticated V8 payload to intake unchanged", async () => {
    const intake = new FakeIntake({
      kind: "accepted",
      callId: "vrs_call_bridge_v8",
      serviceOrder: "13538277",
      createdAt: new Date("2026-08-11T18:00:00.000Z"),
    });

    const response = await request(makeIntakeApp(intake))
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send(validV8AuthorizePayload);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      call_id: "vrs_call_bridge_v8",
      service_order: "13538277",
      state: "queued",
      created_at: "2026-08-11T18:00:00.000Z",
    });
    expect(intake.received).toEqual(validV8AuthorizePayload);
  });

  it("returns 401 before parsing a malformed body with a wrong API key", async () => {
    const intake = new FakeIntake({
      kind: "accepted",
      callId: "must-not-run",
      serviceOrder: "13538277",
      createdAt: new Date(),
    });

    const response = await request(makeIntakeApp(intake))
      .post("/vrs/authorize")
      .set("X-API-Key", "wrong-key")
      .send({ appliance_color: "stainless steel" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: "UNAUTHORIZED",
      message: "Invalid or missing API key",
    });
    expect(intake.received).toBeUndefined();
  });

  it("returns 503 before parsing a malformed body when the API key is not configured", async () => {
    const intake = new FakeIntake({
      kind: "accepted",
      callId: "must-not-run",
      serviceOrder: "13538277",
      createdAt: new Date(),
    });

    const response = await request(makeUnconfiguredIntakeApp(intake))
      .post("/vrs/authorize")
      .send({ appliance_color: "stainless steel" });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "NOT_CONFIGURED",
      message: "VRS SASHA API key is not configured",
    });
    expect(intake.received).toBeUndefined();
  });

  it.each([
    [
      "disabled",
      {
        kind: "disabled" as const,
        code: "VRS_AI_BRIDGE_DISABLED" as const,
        message: "VRS AI bridge intake is disabled in production.",
      },
    ],
    [
      "incompletely configured",
      {
        kind: "invalid" as const,
        code: "VRS_AI_BRIDGE_NOT_CONFIGURED" as const,
        message: "VRS AI bridge intake configuration is incomplete.",
      },
    ],
  ])(
    "fails closed before parsing or creating intake when production automation is %s",
    async (_state, activation) => {
      const intake = new FakeIntake({
        kind: "accepted",
        callId: "must-not-run",
        serviceOrder: "13538277",
        createdAt: new Date(),
      });

      const response = await request(makeIntakeApp(intake, { activation }))
        .post("/vrs/authorize")
        .set("X-API-Key", "test-vrs-api-key")
        .send({ malformed: true });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: activation.code,
        message: activation.message,
      });
      expect(intake.received).toBeUndefined();
    },
  );

  it("accepts intake when production automation is fully enabled", async () => {
    const intake = new FakeIntake({
      kind: "accepted",
      callId: "vrs_call_bridge_enabled",
      serviceOrder: "13538277",
      createdAt: new Date("2026-08-27T12:00:00.000Z"),
    });
    const activation = {
      kind: "active" as const,
      config: {
        baseUrl: "https://vrs-ai.example.test",
        apiKey: "outbound-key",
        callbackUrl:
          "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
        callbackSecret: "callback-secret",
      },
    };

    const response = await request(makeIntakeApp(intake, { activation }))
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send(validPayload);

    expect(response.status).toBe(202);
    expect(intake.received).toEqual(validPayload);
  });

  it("returns V8 validation fields for an authenticated partial V8 request", async () => {
    const intake = new FakeIntake({
      kind: "accepted",
      callId: "must-not-run",
      serviceOrder: "13538277",
      createdAt: new Date(),
    });
    const { contract_number: _contractNumber, purchase_year: _purchaseYear, symptom: _symptom, ...partialV8 } =
      validV8AuthorizePayload;

    const response = await request(makeIntakeApp(intake))
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send(partialV8);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(response.body.fields).toEqual(
      expect.arrayContaining(["contract_number", "purchase_year", "symptom"]),
    );
    expect(intake.received).toBeUndefined();
  });

  it("returns sanitized service-order data with directly retrievable photo URLs", async () => {
    const intake = new FakeIntake({
      kind: "accepted",
      callId: "must-not-run",
      serviceOrder: "13538277",
      createdAt: new Date(),
    });
    const signedObjectPhoto =
      "https://storage.googleapis.com/vrs-dev/photo.jpg?X-Goog-Expires=86400&X-Goog-Signature=test";
    const source = {
      callId: "vrs_call_bridge_v8",
      state: "pending_review",
      requestPayload: {
        ...validV8AuthorizePayload,
        callback_secret: "must-never-be-returned",
      },
      submissionPhotos: JSON.stringify([
        "/objects/uploads/diagnostic-photo.jpg",
        signedTinaPhotoUrl,
        "/objects/uploads/diagnostic-photo.jpg",
      ]),
    };
    const {
      callback_url: _callbackUrl,
      callback_secret: _callbackSecret,
      appliance_photos: _appliancePhotos,
      ...serviceOrderInfo
    } = validV8AuthorizePayload;

    const response = await request(makeIntakeApp(intake, {
      source,
      signObjectPhotoUrl: async (objectPath) => {
        expect(objectPath).toBe("/objects/uploads/diagnostic-photo.jpg");
        return signedObjectPhoto;
      },
      now: () => new Date("2026-08-13T17:30:00.000Z"),
    }))
      .get("/api/integrations/vrs-ai/v1/service-orders/13538277")
      .set("X-API-Key", "test-vrs-api-key");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      service_order: "13538277",
      call_id: "vrs_call_bridge_v8",
      state: "pending_review",
      contract_version: "v8",
      service_order_info: serviceOrderInfo,
      appliance_photos: [signedTinaPhotoUrl, signedObjectPhoto],
      photo_urls_expire_at: "2026-08-14T17:30:00.000Z",
    });
    expect(JSON.stringify(response.body)).not.toContain("callback_");
  });

  it("authenticates service-order photo lookup with the existing Express API key", async () => {
    const intake = new FakeIntake({
      kind: "accepted",
      callId: "must-not-run",
      serviceOrder: "13538277",
      createdAt: new Date(),
    });
    const response = await request(makeIntakeApp(intake))
      .get("/api/integrations/vrs-ai/v1/service-orders/13538277")
      .set("X-API-Key", "wrong-key");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: "UNAUTHORIZED",
      message: "Invalid or missing API key",
    });
  });

  it.each([
    ["1353-8277", 400, "VALIDATION_ERROR"],
    ["99999999", 404, "SERVICE_ORDER_NOT_FOUND"],
  ])(
    "rejects unavailable service-order lookup %s with %i",
    async (serviceOrder, status, error) => {
      const intake = new FakeIntake({
        kind: "accepted",
        callId: "must-not-run",
        serviceOrder: "13538277",
        createdAt: new Date(),
      });
      const response = await request(makeIntakeApp(intake))
        .get(`/api/integrations/vrs-ai/v1/service-orders/${serviceOrder}`)
        .set("X-API-Key", "test-vrs-api-key");

      expect(response.status).toBe(status);
      expect(response.body.error).toBe(error);
    },
  );

  it("fails closed when an Express object photo cannot be signed", async () => {
    const intake = new FakeIntake({
      kind: "accepted",
      callId: "must-not-run",
      serviceOrder: "13538277",
      createdAt: new Date(),
    });
    const response = await request(makeIntakeApp(intake, {
      source: {
        callId: "vrs_call_bridge_v8",
        state: "pending_review",
        requestPayload: validV8AuthorizePayload,
        submissionPhotos: JSON.stringify(["/objects/uploads/photo.jpg"]),
      },
      signObjectPhotoUrl: async () => {
        throw new Error("object storage unavailable");
      },
    }))
      .get("/api/integrations/vrs-ai/v1/service-orders/13538277")
      .set("X-API-Key", "test-vrs-api-key");

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: "PHOTO_URL_GENERATION_FAILED",
      message: "Unable to generate photo download URLs",
    });
  });

  it("returns the existing bridge call for a duplicate service order", async () => {
    const intake = new FakeIntake({
      kind: "duplicate",
      existingCallId: "vrs_call_bridge_existing",
      state: "pending_review",
    });

    const response = await request(makeIntakeApp(intake))
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send(validPayload);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "DUPLICATE_CALL",
      message:
        "A call is already in progress for service order 13538277",
      existing_call_id: "vrs_call_bridge_existing",
      state: "in_progress",
    });
  });

  it("keeps V8 duplicate responses identical to V5 and excludes secrets", async () => {
    const intake = new FakeIntake({
      kind: "duplicate",
      existingCallId: "vrs_call_bridge_existing",
      state: "pending_review",
    });

    const response = await request(makeIntakeApp(intake))
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send(validV8AuthorizePayload);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "DUPLICATE_CALL",
      message:
        "A call is already in progress for service order 13538277",
      existing_call_id: "vrs_call_bridge_existing",
      state: "in_progress",
    });
    expect(JSON.stringify(response.body)).not.toContain(
      validV8AuthorizePayload.callback_secret,
    );
    expect(JSON.stringify(response.body)).not.toContain("provider_call_id");
  });

  it("rejects First American at the AHS-only Phase 1 bridge gate", async () => {
    const intake = new FakeIntake({
      kind: "unsupported_partner",
      partnerId: "first_american",
    });

    const response = await request(makeIntakeApp(intake))
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send({ ...validPayload, partner_id: "first_american" });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "UNSUPPORTED_PARTNER",
      message:
        "Phase 1 VRS AI phone automation supports American Home Shield only",
      partner_id: "first_american",
    });
  });

  it("returns actionable technician-context errors from VRS Express intake", async () => {
    const intake = new FakeIntake({
      kind: "rejected",
      status: 422,
      code: "UNKNOWN_TECHNICIAN",
      message: "Unknown technician LDAP id: 0123456",
    });

    const response = await request(makeIntakeApp(intake))
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send(validPayload);

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "UNKNOWN_TECHNICIAN",
      message: "Unknown technician LDAP id: 0123456",
    });
  });

  it("rejects a bad API key before creating a VRS Express intake", async () => {
    const intake = new FakeIntake({
      kind: "accepted",
      callId: "must-not-run",
      serviceOrder: "13538277",
      createdAt: new Date(),
    });

    const response = await request(makeIntakeApp(intake))
      .post("/vrs/authorize")
      .set("X-API-Key", "wrong-key")
      .send(validPayload);

    expect(response.status).toBe(401);
    expect(intake.received).toBeUndefined();
  });

  it("sends the approved Express payload to the configured VRS AI endpoint", async () => {
    const send = (contractModule as any).sendVrsAuthorizeRequest;
    expect(typeof send).toBe("function");

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          call_id: "vrs_ai_call_456",
          service_order: "13538277",
          state: "queued",
          created_at: "2026-07-24T17:20:00Z",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await send({
      baseUrl: "https://vrs-dev.stage.nextgen.shs.com",
      apiKey: "vrs-ai-key",
      callbackUrl:
        "https://vrs-express.example/api/integrations/vrs-ai/v1/webhook",
      callbackSecret: "express-ai-webhook-secret",
      payload: validPayload,
      fetchImpl,
    });

    expect(result).toEqual({
      kind: "accepted",
      callId: "vrs_ai_call_456",
      state: "queued",
      duplicate: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://vrs-dev.stage.nextgen.shs.com/vrs/authorize",
    );
    expect(new Headers(calls[0].init?.headers).get("X-API-Key")).toBe(
      "vrs-ai-key",
    );
    const sentBody = JSON.parse(String(calls[0].init?.body));
    expect(sentBody.callback_url).toBe(
      "https://vrs-express.example/api/integrations/vrs-ai/v1/webhook",
    );
    expect(sentBody.callback_secret).toBe("express-ai-webhook-secret");
    expect(sentBody.service_order).toBe("13538277");
  });

  it("accepts the Express callback on a retry payload while keeping the inbound SASHA allowlist separate", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          call_id: "vrs_ai_call_retry",
          state: "queued",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      contractModule.sendVrsAuthorizeRequest({
        baseUrl: "https://vrs-dev.stage.nextgen.shs.com",
        apiKey: "vrs-ai-key",
        callbackUrl:
          "https://vrs-express.example/api/integrations/vrs-ai/v1/webhook",
        callbackSecret: "express-ai-webhook-secret",
        payload: {
          ...validPayload,
          callback_url:
            "https://vrs-express.example/api/integrations/vrs-ai/v1/webhook",
          callback_secret: "express-ai-webhook-secret",
        },
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      kind: "accepted",
      callId: "vrs_ai_call_retry",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses an outbound callback URL that is not the Express webhook route", async () => {
    await expect(
      contractModule.sendVrsAuthorizeRequest({
        baseUrl: "https://vrs-dev.stage.nextgen.shs.com",
        apiKey: "vrs-ai-key",
        callbackUrl: "https://vrs-express.example/unrelated-webhook",
        callbackSecret: "express-ai-webhook-secret",
        payload: validPayload,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow("callback URL");
  });

  it("verifies the AI callback HMAC against the exact raw request bytes", () => {
    const rawBody =
      '{"version":1,"eventId":"evt_001","callId":"vrs_ai_call_456"}';
    const signature = contractModule.createVrsWebhookSignature(
      rawBody,
      "express-ai-webhook-secret",
    );
    const verify = (contractModule as any).verifyVrsWebhookSignature;

    expect(typeof verify).toBe("function");
    expect(
      verify(rawBody, signature, "express-ai-webhook-secret"),
    ).toBe(true);
    expect(
      verify(`${rawBody} `, signature, "express-ai-webhook-secret"),
    ).toBe(false);
  });

  it("accepts a signed VRS AI callback once and acknowledges a replay", async () => {
    const event = {
      version: 1,
      eventId: "evt_001",
      callId: "vrs_ai_call_456",
      soNo: "13538277",
      occurredAt: "2026-07-24T17:24:00Z",
      state: "approved",
      authNumber: "AHS-001",
      authorizedAmount: 365.6,
    };
    const rawBody = JSON.stringify(event);
    const signature = contractModule.createVrsWebhookSignature(
      rawBody,
      "express-ai-webhook-secret",
    );
    const sink = {
      receive: vi
        .fn()
        .mockResolvedValueOnce("processed")
        .mockResolvedValueOnce("duplicate"),
    };
    const app = makeWebhookApp(sink);
    const timestamp = String(Date.now());

    const first = await request(app)
      .post("/api/integrations/vrs-ai/v1/webhook")
      .set("Content-Type", "application/json")
      .set("X-VRS-Signature", signature)
      .set("X-VRS-Event-Id", "evt_001")
      .set("X-VRS-Timestamp", timestamp)
      .send(rawBody);
    const replay = await request(app)
      .post("/api/integrations/vrs-ai/v1/webhook")
      .set("Content-Type", "application/json")
      .set("X-VRS-Signature", signature)
      .set("X-VRS-Event-Id", "evt_001")
      .set("X-VRS-Timestamp", timestamp)
      .send(rawBody);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      ok: true,
      eventId: "evt_001",
      deduped: false,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      ok: true,
      eventId: "evt_001",
      deduped: true,
    });
    expect(sink.receive).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid VRS AI callback signature before applying it", async () => {
    const sink = { receive: vi.fn() };
    const response = await request(makeWebhookApp(sink))
      .post("/api/integrations/vrs-ai/v1/webhook")
      .set("Content-Type", "application/json")
      .set("X-VRS-Signature", "sha256=bad")
      .set("X-VRS-Event-Id", "evt_001")
      .set("X-VRS-Timestamp", String(Date.now()))
      .send({
        version: 1,
        eventId: "evt_001",
        callId: "vrs_ai_call_456",
        soNo: "13538277",
        occurredAt: "2026-07-24T17:24:00Z",
        state: "approved",
        authNumber: "AHS-001",
        authorizedAmount: 365.6,
      });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("INVALID_SIGNATURE");
    expect(sink.receive).not.toHaveBeenCalled();
  });

  it("rejects a signed callback outside the five-minute replay window", async () => {
    const event = {
      version: 1,
      eventId: "evt_old",
      callId: "vrs_ai_call_456",
      soNo: "13538277",
      occurredAt: "2026-07-24T17:24:00Z",
      state: "failed",
      reason: "timeout",
      retryable: true,
    };
    const rawBody = JSON.stringify(event);
    const sink = { receive: vi.fn() };
    const response = await request(makeWebhookApp(sink))
      .post("/api/integrations/vrs-ai/v1/webhook")
      .set("Content-Type", "application/json")
      .set(
        "X-VRS-Signature",
        contractModule.createVrsWebhookSignature(
          rawBody,
          "express-ai-webhook-secret",
        ),
      )
      .set("X-VRS-Event-Id", "evt_old")
      .set("X-VRS-Timestamp", String(Date.now() - 5 * 60_000 - 1))
      .send(rawBody);

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("TIMESTAMP_OUT_OF_WINDOW");
    expect(sink.receive).not.toHaveBeenCalled();
  });

  it("requires the event id header and keeps it equal to the signed body", async () => {
    const event = {
      version: 1,
      eventId: "evt_missing_header",
      callId: "vrs_ai_call_456",
      soNo: "13538277",
      occurredAt: "2026-07-24T17:24:00Z",
      state: "failed",
      reason: "timeout",
      retryable: true,
    };
    const rawBody = JSON.stringify(event);
    const sink = { receive: vi.fn() };
    const response = await request(makeWebhookApp(sink))
      .post("/api/integrations/vrs-ai/v1/webhook")
      .set("Content-Type", "application/json")
      .set(
        "X-VRS-Signature",
        contractModule.createVrsWebhookSignature(
          rawBody,
          "express-ai-webhook-secret",
        ),
      )
      .set("X-VRS-Timestamp", String(Date.now()))
      .send(rawBody);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("EVENT_ID_MISMATCH");
    expect(sink.receive).not.toHaveBeenCalled();
  });

  it("keeps upstream SASHA callback secrets encrypted at rest", () => {
    process.env.VRS_BRIDGE_ENCRYPTION_KEY =
      "unit-test-bridge-key-that-is-long-enough";
    const encrypted = encryptVrsCallbackSecret(
      "sasha-callback-secret-value",
    );

    expect(JSON.stringify(encrypted)).not.toContain(
      "sasha-callback-secret-value",
    );
    expect(decryptVrsCallbackSecret(encrypted)).toBe(
      "sasha-callback-secret-value",
    );
  });

  it("does not couple callback-secret encryption to the JWT session secret", () => {
    process.env.SESSION_SECRET =
      "unit-test-session-secret-that-is-long-enough";
    expect(() =>
      encryptVrsCallbackSecret("sasha-callback-secret-value"),
    ).toThrow("VRS_BRIDGE_ENCRYPTION_KEY");
  });
});
