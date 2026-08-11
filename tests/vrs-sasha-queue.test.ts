import { describe, expect, it, vi } from "vitest";
import * as bridgeModule from "../server/vrs-sasha-queue";
import type {
  VrsAuthorizeRequest,
  VrsWebhookEvent,
} from "../server/vrs-sasha-contract";
import {
  signedTinaPhotoUrl,
  validV5AuthorizePayload,
  validV8AuthorizePayload,
} from "./fixtures/vrs-authorize-payloads";

type EnrichForDispatch = (
  payload: VrsAuthorizeRequest,
  enrichment: {
    techPhone?: string | null;
    techName?: string | null;
    appliancePhotos?: string[] | null;
  },
) => VrsAuthorizeRequest;

const candidateBridgeModule = bridgeModule as typeof bridgeModule & {
  enrichVrsAuthorizeForDispatch?: EnrichForDispatch;
};

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
  partner_id: "ahs",
};

describe("VRS Express bridge orchestration", () => {
  it("maps the SASHA payload into the existing VRS Express ticket shape", () => {
    const map = (bridgeModule as any).mapVrsPayloadToSubmission;
    expect(typeof map).toBe("function");

    expect(map(requestPayload, "8175")).toEqual({
      serviceOrder: "8175-13538277",
      applianceType: "laundry",
      requestType: "authorization",
      warrantyType: "american_home_shield",
      warrantyProvider: "American Home Shield",
      issueDescription:
        "Board failure is isolated and repair is within the coverage threshold.",
      estimateAmount: "380.60",
      partNumbers: '["WPW10503278"]',
      phone: "+12145550199",
    });
  });

  it("uses the resolved phone operationally without mutating the durable V8 wire payload", () => {
    const payload: VrsAuthorizeRequest = {
      ...validV8AuthorizePayload,
      tech_phone: "N/A",
      tech_name: "",
      repair_replace_rationale: "",
      symptom: "Washer will not drain",
    };
    const wireSnapshot = structuredClone(payload);

    const submission = bridgeModule.mapVrsPayloadToSubmission(
      payload,
      "8175",
      { technicianPhone: "+17045550125" },
    );

    expect(submission.phone).toBe("+17045550125");
    expect(submission.phone).not.toBe("N/A");
    expect(submission.issueDescription).toBe("Washer will not drain");
    expect(payload).toEqual(wireSnapshot);
    expect(payload.tech_phone).toBe("N/A");
  });

  it.each([
    {
      label: "real symptom",
      payload: {
        ...validV8AuthorizePayload,
        repair_replace_rationale: "",
        symptom: "Washer stops during drain",
        comments: [{
          tech_id: "0123456",
          work_item: "tech_observation" as const,
          text: "Water remains in the basket",
          timestamp: "2026-08-11T12:00:00Z",
        }],
        failure_cause: "normal-wear" as const,
      },
      expected: "Washer stops during drain",
    },
    {
      label: "structured comment",
      payload: {
        ...validV8AuthorizePayload,
        repair_replace_rationale: "",
        symptom: "N/A",
        comments: [{
          tech_id: "0123456",
          work_item: "tech_observation" as const,
          text: "Water remains in the basket",
          timestamp: "2026-08-11T12:00:00Z",
        }],
        failure_cause: "normal-wear" as const,
      },
      expected: "Water remains in the basket",
    },
    {
      label: "specific failure cause",
      payload: {
        ...validV8AuthorizePayload,
        repair_replace_rationale: "",
        symptom: "N/A",
        comments: [],
        failure_cause: "normal-wear" as const,
      },
      expected: "normal-wear",
    },
    {
      label: "neutral fallback",
      payload: {
        ...validV8AuthorizePayload,
        repair_replace_rationale: "",
        symptom: "N/A",
        comments: [],
        failure_cause: "other" as const,
      },
      expected: "Authorization review requested",
    },
  ])("uses the $label for a blank V8 rationale", ({ payload, expected }) => {
    expect(
      bridgeModule.mapVrsPayloadToSubmission(payload, "8175").issueDescription,
    ).toBe(expected);
  });

  it("projects the human review context without callback credentials or routing", () => {
    const context = bridgeModule.projectVrsBridgeReviewContext(requestPayload);

    expect(context).toMatchObject({
      customer_name: "Maria Gonzalez",
      service_address: "742 Evergreen Terrace, Hagerstown, MD 21740",
      brand: "Whirlpool",
      model_number: "WTW5000DW1",
      serial_number: "C31290822",
      appliance_type: "Washer",
      failure_cause: "normal-wear",
      tech_recommendation: "repair",
      repair_replace_rationale:
        "Board failure is isolated and repair is within the coverage threshold.",
    });
    expect(context.parts).toHaveLength(1);
    expect(JSON.stringify(context)).not.toContain("callback_url");
    expect(JSON.stringify(context)).not.toContain("callback_secret");
  });

  it("projects every V8 review field while removing both callback fields", () => {
    const context = bridgeModule.projectVrsBridgeReviewContext(
      validV8AuthorizePayload,
    );
    const {
      callback_url: _callbackUrl,
      callback_secret: _callbackSecret,
      ...expected
    } = validV8AuthorizePayload;

    expect(context).toEqual(expected);
    expect(Object.keys(context)).toEqual(Object.keys(expected));
    expect(context).not.toHaveProperty("callback_url");
    expect(context).not.toHaveProperty("callback_secret");
  });

  it("fills only eligible V8 placeholders from valid same-field candidates", () => {
    const enrich = candidateBridgeModule.enrichVrsAuthorizeForDispatch;
    expect(typeof enrich).toBe("function");
    if (!enrich) return;
    const payload: VrsAuthorizeRequest = {
      ...validV8AuthorizePayload,
      tech_phone: "N/A",
      tech_name: "",
      appliance_photos: [],
    };
    const wireSnapshot = structuredClone(payload);

    const enriched = enrich(payload, {
      techPhone: "+17045550125",
      techName: "Resolved Technician",
      appliancePhotos: [
        "http://cdn.example.test/insecure.jpg",
        "/objects/session-auth/photo.jpg",
        "https://vrs-express.example.test/objects/session-auth/photo.jpg",
        "https://vrs-express.example.test/objects/uploads/private.jpg",
        "https://cdn.example.test/authorized.jpg",
      ],
    });

    expect(enriched).toEqual({
      ...payload,
      tech_phone: "+17045550125",
      tech_name: "Resolved Technician",
      appliance_photos: ["https://cdn.example.test/authorized.jpg"],
    });
    expect(Object.keys(enriched)).toEqual(Object.keys(payload));
    expect(enriched).not.toHaveProperty("cta_no");
    expect(payload).toEqual(wireSnapshot);
  });

  it("leaves V5 and populated V8 business values byte-for-byte unchanged", () => {
    const enrich = candidateBridgeModule.enrichVrsAuthorizeForDispatch;
    expect(typeof enrich).toBe("function");
    if (!enrich) return;
    const v5 = structuredClone(validV5AuthorizePayload);
    const populatedV8 = structuredClone(validV8AuthorizePayload);

    expect(enrich(v5, {
      techPhone: "+17045550125",
      techName: "Different Technician",
      appliancePhotos: ["https://cdn.example.test/different.jpg"],
    })).toEqual(v5);
    expect(enrich(populatedV8, {
      techPhone: "+17045550125",
      techName: "Different Technician",
      appliancePhotos: ["https://cdn.example.test/different.jpg"],
    })).toEqual(populatedV8);
    expect(enrich(v5, {})).not.toHaveProperty("cta_no");
    expect(enrich(populatedV8, {})).not.toHaveProperty("cta_no");
  });

  it("ignores invalid placeholder candidates instead of breaking a valid V8 payload", () => {
    const enrich = candidateBridgeModule.enrichVrsAuthorizeForDispatch;
    expect(typeof enrich).toBe("function");
    if (!enrich) return;
    const payload: VrsAuthorizeRequest = {
      ...validV8AuthorizePayload,
      tech_phone: "N/A",
      tech_name: "",
      appliance_photos: [],
    };

    expect(enrich(payload, {
      techPhone: "704-555-0125",
      techName: "X".repeat(256),
      appliancePhotos: ["http://cdn.example.test/insecure.jpg"],
    })).toEqual(payload);
  });

  it("maps common appliance names to the VRS Express routing divisions", () => {
    const map = (bridgeModule as any).mapVrsApplianceType;
    expect(typeof map).toBe("function");

    expect(map("Washer")).toBe("laundry");
    expect(map("French Door Refrigerator")).toBe("refrigeration");
    expect(map("Wall Oven")).toBe("cooking");
    expect(map("Dishwasher")).toBe("dishwasher");
    expect(map("Over-the-range microwave")).toBe("microwave");
    expect(map("Central Air Conditioner")).toBe("hvac");
    expect(map("Garbage Disposal")).toBe("all_other");
  });

  it("dispatches only a pending bridge record and replaces callback ownership", async () => {
    const dispatch = (bridgeModule as any).dispatchVrsAiForSubmission;
    expect(typeof dispatch).toBe("function");

    const record = {
      id: 9,
      submissionId: 42,
      callId: "vrs_call_bridge_123",
      providerCallId: null,
      state: "pending_review",
      requestPayload: {
        ...requestPayload,
        callback_secret: undefined,
      },
    };
    const store = {
      getBySubmissionId: vi.fn().mockResolvedValue(record),
      markDispatching: vi.fn().mockResolvedValue(true),
      markAccepted: vi.fn().mockResolvedValue(undefined),
      markDispatchFailed: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      authorize: vi.fn().mockResolvedValue({
        kind: "accepted",
        callId: "vrs_ai_call_456",
        state: "queued",
        duplicate: false,
      }),
    };

    const result = await dispatch({
      submissionId: 42,
      store,
      client,
      callbackUrl:
        "https://vrs-express.example/api/integrations/vrs-ai/v1/webhook",
      callbackSecret: "express-ai-webhook-secret",
    });

    expect(result).toEqual({
      kind: "accepted",
      providerCallId: "vrs_ai_call_456",
      state: "queued",
      duplicate: false,
    });
    expect(store.markDispatching).toHaveBeenCalledWith(9);
    expect(client.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          service_order: "13538277",
          callback_url:
            "https://vrs-express.example/api/integrations/vrs-ai/v1/webhook",
          callback_secret: "express-ai-webhook-secret",
        }),
      }),
    );
    expect(store.markAccepted).toHaveBeenCalledWith(
      9,
      "vrs_ai_call_456",
      "queued",
    );
  });

  it("dispatches V5 with exactly its received key set and no V8 additions", async () => {
    const { callback_secret: _callbackSecret, ...storedPayload } =
      validV5AuthorizePayload;
    const client = {
      authorize: vi.fn().mockResolvedValue({
        kind: "accepted" as const,
        callId: "vrs_ai_call_v5",
        state: "queued",
        duplicate: false,
      }),
    };
    const store = {
      getBySubmissionId: vi.fn().mockResolvedValue({
        id: 10,
        submissionId: 50,
        callId: "vrs_call_v5",
        state: "pending_review",
        requestPayload: storedPayload,
      }),
      markDispatching: vi.fn().mockResolvedValue(true),
      markAccepted: vi.fn().mockResolvedValue(undefined),
      markDispatchFailed: vi.fn().mockResolvedValue(undefined),
    };

    await bridgeModule.dispatchVrsAiForSubmission({
      submissionId: 50,
      store,
      client,
      callbackUrl:
        "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
      callbackSecret: "express-to-vrs-ai-test-secret",
      enrichment: {
        techPhone: "+17045550125",
        techName: "Different Technician",
        appliancePhotos: ["https://cdn.example.test/different.jpg"],
      },
    });

    const sent = client.authorize.mock.calls[0]?.[0].payload;
    expect(Object.keys(sent).sort()).toEqual(
      Object.keys(validV5AuthorizePayload).sort(),
    );
    expect(sent).not.toHaveProperty("appliance_color");
    expect(sent).not.toHaveProperty("contract_number");
    expect(sent).not.toHaveProperty("purchase_year");
    expect(sent).not.toHaveProperty("symptom");
    expect(sent).not.toHaveProperty("cta_no");
  });

  it("dispatches V8 with the same key set and preserves a signed TINA URL byte-for-byte", async () => {
    const { callback_secret: _callbackSecret, ...storedPayload } = {
      ...validV8AuthorizePayload,
      tech_phone: "N/A" as const,
      tech_name: "",
      appliance_photos: [signedTinaPhotoUrl],
    };
    const client = {
      authorize: vi.fn().mockResolvedValue({
        kind: "accepted" as const,
        callId: "vrs_ai_call_v8",
        state: "queued",
        duplicate: false,
      }),
    };
    const store = {
      getBySubmissionId: vi.fn().mockResolvedValue({
        id: 11,
        submissionId: 51,
        callId: "vrs_call_v8",
        state: "pending_review",
        requestPayload: storedPayload,
      }),
      markDispatching: vi.fn().mockResolvedValue(true),
      markAccepted: vi.fn().mockResolvedValue(undefined),
      markDispatchFailed: vi.fn().mockResolvedValue(undefined),
    };

    await bridgeModule.dispatchVrsAiForSubmission({
      submissionId: 51,
      store,
      client,
      callbackUrl:
        "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
      callbackSecret: "express-to-vrs-ai-test-secret",
      enrichment: {
        techPhone: "+17045550125",
        techName: "Resolved Technician",
        appliancePhotos: ["https://cdn.example.test/unused.jpg"],
      },
    });

    const sent = client.authorize.mock.calls[0]?.[0].payload;
    expect(Object.keys(sent).sort()).toEqual(
      Object.keys(validV8AuthorizePayload).sort(),
    );
    expect(sent.tech_phone).toBe("+17045550125");
    expect(sent.tech_name).toBe("Resolved Technician");
    expect(sent.appliance_photos).toEqual([signedTinaPhotoUrl]);
    expect(sent.appliance_photos[0]).toBe(signedTinaPhotoUrl);
    expect(sent).not.toHaveProperty("cta_no");
  });

  it("rejects a stored payload that no longer validates as its original version before client dispatch", async () => {
    const { callback_secret: _callbackSecret, contract_number: _contract, ...invalidStoredPayload } =
      validV8AuthorizePayload;
    const client = {
      authorize: vi.fn().mockResolvedValue({
        kind: "accepted" as const,
        callId: "must_not_dispatch",
        state: "queued",
        duplicate: false,
      }),
    };
    const store = {
      getBySubmissionId: vi.fn().mockResolvedValue({
        id: 12,
        submissionId: 52,
        callId: "vrs_call_invalid_v8",
        state: "pending_review",
        requestPayload: invalidStoredPayload,
      }),
      markDispatching: vi.fn().mockResolvedValue(true),
      markAccepted: vi.fn(),
      markDispatchFailed: vi.fn().mockResolvedValue(undefined),
    };

    const result = await bridgeModule.dispatchVrsAiForSubmission({
      submissionId: 52,
      store,
      client,
      callbackUrl:
        "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
      callbackSecret: "express-to-vrs-ai-test-secret",
      enrichment: {},
    });

    expect(result).toMatchObject({ kind: "failed" });
    expect(client.authorize).not.toHaveBeenCalled();
    expect(store.markDispatchFailed).toHaveBeenCalledWith(
      12,
      expect.stringContaining("contract_number"),
    );
  });

  it("does not dispatch a manual ticket or an already-dispatched bridge twice", async () => {
    const dispatch = (bridgeModule as any).dispatchVrsAiForSubmission;
    expect(typeof dispatch).toBe("function");

    const client = { authorize: vi.fn() };
    const noBridgeStore = {
      getBySubmissionId: vi.fn().mockResolvedValue(undefined),
    };
    expect(
      await dispatch({
        submissionId: 41,
        store: noBridgeStore,
        client,
        callbackUrl: "https://vrs-express.example/webhook",
        callbackSecret: "secret",
      }),
    ).toEqual({ kind: "not_applicable" });

    const acceptedStore = {
      getBySubmissionId: vi.fn().mockResolvedValue({
        id: 9,
        submissionId: 42,
        providerCallId: "vrs_ai_call_456",
        state: "queued",
        requestPayload,
      }),
    };
    expect(
      await dispatch({
        submissionId: 42,
        store: acceptedStore,
        client,
        callbackUrl: "https://vrs-express.example/webhook",
        callbackSecret: "secret",
      }),
    ).toEqual({
      kind: "already_dispatched",
      providerCallId: "vrs_ai_call_456",
      state: "queued",
    });
    expect(client.authorize).not.toHaveBeenCalled();
  });

  it("marks a failed AI dispatch so the human can retry safely", async () => {
    const dispatch = (bridgeModule as any).dispatchVrsAiForSubmission;
    expect(typeof dispatch).toBe("function");

    const store = {
      getBySubmissionId: vi.fn().mockResolvedValue({
        id: 9,
        submissionId: 42,
        state: "pending_review",
        requestPayload,
      }),
      markDispatching: vi.fn().mockResolvedValue(true),
      markAccepted: vi.fn(),
      markDispatchFailed: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      authorize: vi.fn().mockResolvedValue({
        kind: "failed",
        status: 503,
        message: "VRS AI unavailable",
      }),
    };

    const result = await dispatch({
      submissionId: 42,
      store,
      client,
      callbackUrl: "https://vrs-express.example/webhook",
      callbackSecret: "secret",
    });

    expect(result).toEqual({
      kind: "failed",
      status: 503,
      message: "VRS AI unavailable",
    });
    expect(store.markDispatchFailed).toHaveBeenCalledWith(
      9,
      "VRS AI unavailable",
    );
    expect(store.markAccepted).not.toHaveBeenCalled();
  });

  it("turns a thrown client/configuration error into a retryable dispatch failure", async () => {
    const store = {
      getBySubmissionId: vi.fn().mockResolvedValue({
        id: 9,
        submissionId: 42,
        state: "pending_review",
        requestPayload,
      }),
      markDispatching: vi.fn().mockResolvedValue(true),
      markAccepted: vi.fn(),
      markDispatchFailed: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      bridgeModule.dispatchVrsAiForSubmission({
        submissionId: 42,
        store,
        client: {
          authorize: vi.fn().mockRejectedValue(new Error("Bad VRS AI URL")),
        },
        callbackUrl: "https://vrs-express.example/webhook",
        callbackSecret: "secret",
      }),
    ).resolves.toEqual({
      kind: "failed",
      message: "Bad VRS AI URL",
    });
    expect(store.markDispatchFailed).toHaveBeenCalledWith(
      9,
      "Bad VRS AI URL",
    );
  });

  it("applies an AI result once and forwards the bridge call id to SASHA", async () => {
    const process = (bridgeModule as any).processVrsAiWebhookEvent;
    expect(typeof process).toBe("function");

    const event: VrsWebhookEvent = {
      version: 1,
      eventId: "evt_001",
      callId: "vrs_ai_call_456",
      soNo: "13538277",
      occurredAt: "2026-07-24T17:24:00Z",
      state: "approved",
      authNumber: "AHS-001",
      authorizedAmount: 365.6,
    };
    const record = {
      id: 9,
      submissionId: 42,
      callId: "vrs_call_bridge_123",
      providerCallId: "vrs_ai_call_456",
      callbackUrl:
        "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
      callbackSecretCipher: "cipher",
      callbackSecretIv: "iv",
      callbackSecretAuthTag: "tag",
      callbackSecretSalt: "salt",
      webhookEventId: null,
      state: "queued",
    };
    const store = {
      getByProviderCallId: vi.fn().mockResolvedValue(record),
      beginWebhookEvent: vi.fn().mockResolvedValue({
        kind: "claimed",
        alreadyApplied: false,
      }),
      markWebhookApplied: vi.fn().mockResolvedValue(undefined),
      markWebhookForwarded: vi.fn().mockResolvedValue(undefined),
      markWebhookFailed: vi.fn().mockResolvedValue(undefined),
    };
    const applyResult = vi.fn().mockResolvedValue(undefined);
    const forward = vi.fn().mockResolvedValue({
      delivered: true,
      attempts: 1,
      status: 200,
    });

    const result = await process({
      event,
      store,
      decryptCallbackSecret: vi.fn().mockReturnValue("sasha-secret"),
      applyResult,
      forward,
    });

    expect(result).toBe("processed");
    expect(applyResult).toHaveBeenCalledWith(42, event);
    expect(store.markWebhookApplied).toHaveBeenCalledWith(9, "evt_001", event);
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: record.callbackUrl,
        callbackSecret: "sasha-secret",
        event: { ...event, callId: "vrs_call_bridge_123" },
      }),
    );
    expect(store.markWebhookForwarded).toHaveBeenCalledWith(
      9,
      "evt_001",
      expect.objectContaining({
        delivered: true,
        attempts: 1,
        status: 200,
      }),
    );
  });

  it("acknowledges a duplicate AI event without repeating ticket or SMS effects", async () => {
    const process = (bridgeModule as any).processVrsAiWebhookEvent;
    expect(typeof process).toBe("function");

    const event: VrsWebhookEvent = {
      version: 1,
      eventId: "evt_001",
      callId: "vrs_ai_call_456",
      soNo: "13538277",
      occurredAt: "2026-07-24T17:24:00Z",
      state: "failed",
      reason: "timeout",
      retryable: true,
    };
    const store = {
      getByProviderCallId: vi.fn().mockResolvedValue({ id: 9 }),
      beginWebhookEvent: vi.fn().mockResolvedValue({ kind: "duplicate" }),
    };
    const applyResult = vi.fn();
    const forward = vi.fn();

    expect(
      await process({
        event,
        store,
        decryptCallbackSecret: vi.fn(),
        applyResult,
        forward,
      }),
    ).toBe("duplicate");
    expect(applyResult).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("rejects a callback whose service order does not match the dispatched request", async () => {
    const event: VrsWebhookEvent = {
      version: 1,
      eventId: "evt_wrong_so",
      callId: "vrs_ai_call_456",
      soNo: "99999999",
      occurredAt: "2026-07-24T17:24:00Z",
      state: "failed",
      reason: "timeout",
      retryable: true,
    };
    const store = {
      getByProviderCallId: vi.fn().mockResolvedValue({
        id: 9,
        submissionId: 42,
        requestPayload,
      }),
      beginWebhookEvent: vi.fn(),
    };

    await expect(
      bridgeModule.processVrsAiWebhookEvent({
        event,
        store: store as any,
        decryptCallbackSecret: vi.fn(),
        applyResult: vi.fn(),
        forward: vi.fn(),
      }),
    ).rejects.toThrow("does not match");
    expect(store.beginWebhookEvent).not.toHaveBeenCalled();
  });

  it("retries only upstream forwarding when a persisted event was already applied", async () => {
    const event: VrsWebhookEvent = {
      version: 1,
      eventId: "evt_retry",
      callId: "vrs_ai_call_456",
      soNo: "13538277",
      occurredAt: "2026-07-24T17:24:00Z",
      state: "approved",
      authNumber: "AHS-001",
      authorizedAmount: 365.6,
    };
    const record = {
      id: 9,
      submissionId: 42,
      callId: "vrs_call_bridge_123",
      callbackUrl:
        "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
      callbackSecretCipher: "cipher",
      callbackSecretIv: "iv",
      callbackSecretAuthTag: "tag",
      callbackSecretSalt: "salt",
    };
    const store = {
      getByProviderCallId: vi.fn().mockResolvedValue(record),
      beginWebhookEvent: vi.fn().mockResolvedValue({
        kind: "claimed",
        alreadyApplied: true,
      }),
      markWebhookApplied: vi.fn(),
      markWebhookForwarded: vi.fn().mockResolvedValue(undefined),
      markWebhookFailed: vi.fn(),
    };
    const applyResult = vi.fn();
    const forward = vi.fn().mockResolvedValue({
      delivered: true,
      attempts: 1,
      status: 200,
    });

    await bridgeModule.processVrsAiWebhookEvent({
      event,
      store,
      decryptCallbackSecret: vi.fn().mockReturnValue("sasha-secret"),
      applyResult,
      forward,
    });

    expect(applyResult).not.toHaveBeenCalled();
    expect(store.markWebhookApplied).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("keeps an undelivered upstream callback retryable without reapplying the result", async () => {
    const event: VrsWebhookEvent = {
      version: 1,
      eventId: "evt_forward_failure",
      callId: "vrs_ai_call_456",
      soNo: "13538277",
      occurredAt: "2026-07-24T17:24:00Z",
      state: "denied",
      denyReason: "Coverage limit exceeded",
    };
    const store = {
      getByProviderCallId: vi.fn().mockResolvedValue({
        id: 9,
        submissionId: 42,
        callId: "vrs_call_bridge_123",
        callbackUrl:
          "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
        callbackSecretCipher: "cipher",
        callbackSecretIv: "iv",
        callbackSecretAuthTag: "tag",
        callbackSecretSalt: "salt",
      }),
      beginWebhookEvent: vi.fn().mockResolvedValue({
        kind: "claimed",
        alreadyApplied: false,
      }),
      markWebhookApplied: vi.fn().mockResolvedValue(undefined),
      markWebhookForwarded: vi.fn().mockResolvedValue(undefined),
      markWebhookFailed: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      bridgeModule.processVrsAiWebhookEvent({
        event,
        store,
        decryptCallbackSecret: vi.fn().mockReturnValue("sasha-secret"),
        applyResult: vi.fn().mockResolvedValue(undefined),
        forward: vi.fn().mockResolvedValue({
          delivered: false,
          attempts: 5,
          status: 503,
        }),
      }),
    ).rejects.toThrow("Unable to forward VRS AI result to SASHA");
    expect(store.markWebhookFailed).toHaveBeenCalledWith(
      9,
      "evt_forward_failure",
      "Unable to forward VRS AI result to SASHA",
    );
  });

  it("maps terminal AI outcomes into the existing ticket/SMS actions", () => {
    expect(
      bridgeModule.mapVrsAiWebhookToSubmissionDecision({
        version: 1,
        eventId: "evt_approved",
        callId: "vrs_ai_call_1",
        soNo: "13538277",
        occurredAt: "2026-07-24T17:24:00Z",
        state: "approved",
        authNumber: "AHS-001",
        authorizedAmount: 365.6,
      }),
    ).toMatchObject({
      kind: "process",
      body: { action: "approve", authCode: "AHS-001" },
    });

    expect(
      bridgeModule.mapVrsAiWebhookToSubmissionDecision({
        version: 1,
        eventId: "evt_denied",
        callId: "vrs_ai_call_2",
        soNo: "13538277",
        occurredAt: "2026-07-24T17:24:00Z",
        state: "denied",
        denyReason: "Coverage limit exceeded",
      }),
    ).toMatchObject({
      kind: "process",
      body: {
        action: "reject",
        rejectionReasons: ["Coverage limit exceeded"],
      },
    });

    expect(
      bridgeModule.mapVrsAiWebhookToSubmissionDecision({
        version: 1,
        eventId: "evt_info",
        callId: "vrs_ai_call_3",
        soNo: "13538277",
        occurredAt: "2026-07-24T17:24:00Z",
        state: "requires_info",
        question: "Confirm the serial number",
        field: "serial_number",
        urgency: "hard",
      }),
    ).toEqual({ kind: "status_only" });
  });
});
