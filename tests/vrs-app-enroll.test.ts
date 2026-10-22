import { describe, expect, it, vi } from "vitest";
import {
  APP_ORIGIN_VRS_COMMENT,
  buildAppVrsAuthorizePayload,
  enrollAppSubmissionInVrsAi,
  toE164UsPhone,
  type AppVrsAiEnrollSubmission,
} from "../server/vrs-app-enroll";
import {
  buildVrsAuthorizeEnrichmentCandidates,
  dispatchVrsAiForSubmission,
  processVrsAiWebhookEvent,
} from "../server/vrs-sasha-queue";
import {
  getVrsAuthorizeContractVersion,
  safeParseVrsAppOriginOutboundRequest,
  safeParseVrsAuthorizeRequest,
  safeParseVrsOutboundSourceRequest,
  sendVrsAuthorizeRequest,
  type VrsWebhookEvent,
} from "../server/vrs-sasha-contract";
import type { AhsDetails } from "../shared/ahs-details";

const EXPRESS_WEBHOOK =
  "https://vrs-express.example/api/integrations/vrs-ai/v1/webhook";
const SASHA_WEBHOOK =
  "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook";

const ahsDetails: AhsDetails = {
  contractNumber: "AHS-778812",
  customerName: "Maria Gonzalez",
  customerAddress: "742 Evergreen Terrace, Hagerstown, MD 21740",
  applianceKind: "washer",
  brand: "Whirlpool",
  modelNumber: "WTW5000DW1",
  serialNumber: "C31290822",
  applianceAge: 4,
  applianceLocation: "Laundry room",
  applianceGrade: "mid",
  applianceColor: "White",
  failureCause: "normal-wear",
  techRecommendation: "repair",
  laborAmount: 120,
  taxAmount: 15.6,
  parts: [
    {
      partNumber: "WPW10503278",
      quantity: 1,
      description: "Electronic control board",
      unitPrice: 245,
      partFunction: "Controls wash cycle timing and motor speed",
      failureReason: "Relay failed; board shows error F3E1",
    },
    {
      partNumber: "W10820048",
      quantity: 2,
      description: "Drain pump clip",
      unitPrice: 4.25,
      partFunction: "Holds the drain pump in place",
      failureReason: "Cracked",
    },
  ],
};

const appTicket: AppVrsAiEnrollSubmission = {
  id: 501,
  serviceOrder: "8175-13538277",
  districtCode: "8175",
  requestType: "authorization",
  warrantyType: "american_home_shield",
  ticketStatus: "queued",
  issueDescription: "Washer will not spin; control board failed diagnostic.",
  phone: "(214) 555-0199",
  phoneOverride: null,
  technicianLdapId: "crivera",
  ahsDetails: JSON.stringify(ahsDetails),
  createdAt: new Date("2026-10-08T14:00:00.000Z"),
};

const technician = { name: "Carlos Rivera", racId: "crivera" };

// What the trimmed form stores when the tech fills only the required inputs
// and the service-order lookup found nothing.
const minimalAhsDetails: AhsDetails = {
  applianceKind: "washer",
  applianceLocation: "Laundry room",
  failureCause: "normal-wear",
  techRecommendation: "repair",
  laborAmount: 120,
  taxAmount: 0,
  parts: [{
    partNumber: "WPW10503278",
    quantity: 1,
    description: "Electronic control board",
    unitPrice: 245,
  }],
};
const minimalTicket: AppVrsAiEnrollSubmission = {
  ...appTicket,
  ahsDetails: JSON.stringify(minimalAhsDetails),
};

function fetchAccepting(callId = "vrs_ai_777") {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ call_id: callId, state: "queued" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
  );
}

function dispatchStore(requestPayload: unknown, callbackUrl: string) {
  return {
    getBySubmissionId: vi.fn().mockResolvedValue({
      id: 79,
      submissionId: 503,
      callId: "vrs_call_503",
      state: "pending_review",
      requestPayload,
      callbackUrl,
    }),
    markDispatching: vi.fn().mockResolvedValue(true),
    markAccepted: vi.fn().mockResolvedValue(undefined),
    markDispatchFailed: vi.fn().mockResolvedValue(undefined),
  };
}

function createdIntake(callId = "vrs_call_app_1") {
  return {
    kind: "accepted" as const,
    record: {
      id: 77,
      submissionId: appTicket.id,
      callId,
      state: "pending_review",
      requestPayload: {} as any,
    },
    createdAt: new Date(),
  };
}

describe("technician AHS ticket → VRS AI bridge enrollment", () => {
  it("builds a V9 payload that passes dispatch validation once a callback is supplied", () => {
    const built = buildAppVrsAuthorizePayload(appTicket, technician);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(getVrsAuthorizeContractVersion(built.payload)).toBe("v9");
    expect(built.payload).not.toHaveProperty("callback_secret");
    expect(built.payload.callback_url).toBe("");
    expect(built.payload).toMatchObject({
      service_order: "13538277",
      tech_id: "crivera",
      tech_phone: "+12145550199",
      tech_name: "Carlos Rivera",
      partner_id: "ahs",
      district_number: "8175",
      contract_number: "AHS-778812",
      cta_no: "AHS-778812",
      customer_name: "Maria Gonzalez",
      customer_address: "742 Evergreen Terrace, Hagerstown, MD 21740",
      service_address: "742 Evergreen Terrace, Hagerstown, MD 21740",
      brand: "Whirlpool",
      model_number: "WTW5000DW1",
      serial_number: "C31290822",
      appliance_type: "Washer",
      appliance_age: 4,
      appliance_location: "Laundry room",
      appliance_grade: "mid",
      appliance_color: "White",
      failure_cause: "normal-wear",
      labor_amount: 120,
      tax_amount: 15.6,
      part_price: 253.5,
      tech_recommendation: "repair",
      purchase_year: "N/A",
      symptom: appTicket.issueDescription,
      appliance_photos: [],
    });
    expect(built.payload.parts).toEqual([
      {
        part_id: "WPW10503278",
        part_description: "Electronic control board",
        sell_price: 245,
        part_function: "Controls wash cycle timing and motor speed",
      },
      {
        part_id: "W10820048",
        part_description: "Drain pump clip (qty 2)",
        sell_price: 8.5,
        part_function: "Holds the drain pump in place",
      },
    ]);
    const commentTexts = built.payload.comments?.map((c) => c.text);
    expect(commentTexts).toEqual([
      appTicket.issueDescription,
      "Part WPW10503278 (qty 1) failure reason: Relay failed; board shows error F3E1",
      "Part W10820048 (qty 2) failure reason: Cracked",
      APP_ORIGIN_VRS_COMMENT,
    ]);
    expect(built.serviceOrder).toBe("13538277");

    const outbound = safeParseVrsOutboundSourceRequest({
      ...built.payload,
      callback_url: EXPRESS_WEBHOOK,
      callback_secret: "express-ai-webhook-secret",
    });
    expect(outbound.success).toBe(true);
  });

  it.each([
    ["Sears Protect", { warrantyType: "sears_protect" }],
    ["First American", { warrantyType: "first_american" }],
    ["NLA parts", { requestType: "parts_nla" }],
    ["already claimed", { ticketStatus: "pending" }],
  ])("skips %s tickets without touching the store", async (_label, override) => {
    const store = { createIntake: vi.fn() };
    const result = await enrollAppSubmissionInVrsAi(
      { store, generateCallId: () => "vrs_call_x" },
      { ...appTicket, ...override },
      technician,
    );
    expect(result.kind).toBe("skipped");
    expect(store.createIntake).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["unreadable", "{not json"],
    ["incomplete", JSON.stringify({ ...ahsDetails, applianceLocation: "" })],
  ])("never enrolls an AHS ticket whose details are %s", async (_label, stored) => {
    const store = { createIntake: vi.fn() };
    const result = await enrollAppSubmissionInVrsAi(
      { store, generateCallId: () => "vrs_call_x" },
      { ...appTicket, ahsDetails: stored },
      technician,
    );
    expect(result).toEqual({ kind: "skipped", reason: "AHS details were not entered" });
    expect(store.createIntake).not.toHaveBeenCalled();
  });

  it("skips a ticket without a usable service order or technician id", () => {
    expect(
      buildAppVrsAuthorizePayload({ ...appTicket, serviceOrder: "8175-1234" }, technician),
    ).toMatchObject({ ok: false });
    expect(
      buildAppVrsAuthorizePayload(
        { ...appTicket, technicianLdapId: null },
        { name: "No Id", racId: null },
      ),
    ).toMatchObject({ ok: false });
  });

  it("normalizes US phone numbers to E.164 and falls back to N/A", () => {
    expect(toE164UsPhone("(214) 555-0199")).toBe("+12145550199");
    expect(toE164UsPhone("1-214-555-0199")).toBe("+12145550199");
    expect(toE164UsPhone("+12145550199")).toBe("+12145550199");
    expect(toE164UsPhone("555-0199")).toBeNull();
    expect(
      buildAppVrsAuthorizePayload({ ...appTicket, phone: "unknown" }, technician),
    ).toMatchObject({ ok: true, payload: { tech_phone: "N/A" } });
  });

  it("stores an app-origin row with no upstream callback and supersedes closed undispatched rows", async () => {
    const store = { createIntake: vi.fn().mockResolvedValue(createdIntake()) };
    const result = await enrollAppSubmissionInVrsAi(
      { store, generateCallId: () => "vrs_call_app_1" },
      appTicket,
      technician,
    );

    expect(result).toEqual({ kind: "enrolled", callId: "vrs_call_app_1" });
    expect(store.createIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: 501,
        callId: "vrs_call_app_1",
        serviceOrder: "13538277",
        techId: "crivera",
        techName: "Carlos Rivera",
        callbackUrl: "",
        callbackSecretCipher: "",
      }),
      { supersedeClosedUndispatched: true },
    );
  });

  it("reports an active bridge call for the same order as a duplicate", async () => {
    const store = {
      createIntake: vi.fn().mockResolvedValue({
        kind: "duplicate",
        record: { callId: "vrs_call_sasha", state: "queued" },
      }),
    };
    expect(
      await enrollAppSubmissionInVrsAi(
        { store, generateCallId: () => "vrs_call_app_2" },
        appTicket,
        technician,
      ),
    ).toEqual({ kind: "duplicate", existingCallId: "vrs_call_sasha", state: "queued" });
  });

  it("never throws when the store fails", async () => {
    const store = { createIntake: vi.fn().mockRejectedValue(new Error("db down")) };
    expect(
      await enrollAppSubmissionInVrsAi(
        { store, generateCallId: () => "vrs_call_app_3" },
        appTicket,
        technician,
      ),
    ).toEqual({ kind: "failed", message: "db down" });
  });

  it("dispatches an app-origin row with the Express callback and signed technician photos", async () => {
    const built = buildAppVrsAuthorizePayload(appTicket, technician);
    if (!built.ok) throw new Error(built.reason);

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ call_id: "vrs_ai_777", state: "queued" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    const store = {
      getBySubmissionId: vi.fn().mockResolvedValue({
        id: 77,
        submissionId: 501,
        callId: "vrs_call_app_1",
        state: "pending_review",
        requestPayload: built.payload,
        callbackUrl: "",
      }),
      markDispatching: vi.fn().mockResolvedValue(true),
      markAccepted: vi.fn().mockResolvedValue(undefined),
      markDispatchFailed: vi.fn().mockResolvedValue(undefined),
    };

    const result = await dispatchVrsAiForSubmission({
      submissionId: 501,
      store,
      client: {
        authorize: ({ payload, appOrigin }) =>
          sendVrsAuthorizeRequest({
            baseUrl: "https://vrs-ai.example",
            apiKey: "vrs-ai-key",
            callbackUrl: EXPRESS_WEBHOOK,
            callbackSecret: "express-ai-webhook-secret",
            payload,
            appOrigin,
            fetchImpl,
          }),
      },
      callbackUrl: EXPRESS_WEBHOOK,
      callbackSecret: "express-ai-webhook-secret",
      enrichment: buildVrsAuthorizeEnrichmentCandidates({
        submissionPhone: "(214) 555-0199",
        technicianName: "Carlos Rivera",
        submissionPhotos: JSON.stringify({
          estimate: ["/objects/uploads/estimate.jpg"],
          issue: ["/objects/uploads/issue.jpg"],
        }),
      }),
      signObjectPhotoUrl: async (path) =>
        `https://storage.example/bucket${path.slice("/objects".length)}?X-Goog-Signature=abc`,
    });

    expect(store.markDispatchFailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "accepted", providerCallId: "vrs_ai_777" });
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(sent.callback_url).toBe(EXPRESS_WEBHOOK);
    expect(sent.callback_secret).toBe("express-ai-webhook-secret");
    expect(sent.cta_no).toBe("AHS-778812");
    expect(sent.parts).toHaveLength(2);
    expect(sent.appliance_photos).toEqual([
      "https://storage.example/bucket/uploads/estimate.jpg?X-Goog-Signature=abc",
      "https://storage.example/bucket/uploads/issue.jpg?X-Goog-Signature=abc",
    ]);
  });

  it("still requires the SASHA callback pin on SASHA-origin rows at dispatch", async () => {
    const built = buildAppVrsAuthorizePayload(appTicket, technician);
    if (!built.ok) throw new Error(built.reason);
    const store = {
      getBySubmissionId: vi.fn().mockResolvedValue({
        id: 78,
        submissionId: 502,
        callId: "vrs_call_sasha_1",
        state: "pending_review",
        requestPayload: { ...built.payload, callback_url: EXPRESS_WEBHOOK },
        callbackUrl: "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
      }),
      markDispatching: vi.fn().mockResolvedValue(true),
      markAccepted: vi.fn(),
      markDispatchFailed: vi.fn().mockResolvedValue(undefined),
    };
    const client = { authorize: vi.fn() };

    const result = await dispatchVrsAiForSubmission({
      submissionId: 502,
      store,
      client,
      callbackUrl: EXPRESS_WEBHOOK,
      callbackSecret: "express-ai-webhook-secret",
    });

    expect(result).toMatchObject({ kind: "failed" });
    expect(client.authorize).not.toHaveBeenCalled();
  });

  it("applies a result for an app-origin row without forwarding to SASHA", async () => {
    const event: VrsWebhookEvent = {
      version: 1,
      eventId: "evt_app_1",
      callId: "vrs_ai_777",
      soNo: "13538277",
      occurredAt: "2026-10-08T15:00:00Z",
      state: "approved",
      authNumber: "AHS-123",
      authorizedAmount: 312.4,
    };
    const store = {
      getByProviderCallId: vi.fn().mockResolvedValue({
        id: 77,
        submissionId: 501,
        callId: "vrs_call_app_1",
        providerCallId: "vrs_ai_777",
        state: "queued",
        requestPayload: { service_order: "13538277" },
        callbackUrl: "",
        callbackSecretCipher: "",
        callbackSecretIv: "",
        callbackSecretAuthTag: "",
        callbackSecretSalt: "",
      }),
      beginWebhookEvent: vi.fn().mockResolvedValue({ kind: "claimed", alreadyApplied: false }),
      markWebhookApplied: vi.fn().mockResolvedValue(undefined),
      markWebhookForwarded: vi.fn().mockResolvedValue(undefined),
      markWebhookFailed: vi.fn().mockResolvedValue(undefined),
    };
    const applyResult = vi.fn().mockResolvedValue(undefined);
    const forward = vi.fn();
    const decryptCallbackSecret = vi.fn();

    const outcome = await processVrsAiWebhookEvent({
      event,
      store,
      decryptCallbackSecret,
      applyResult,
      forward,
    });

    expect(outcome).toBe("processed");
    expect(applyResult).toHaveBeenCalledWith(501, event);
    expect(forward).not.toHaveBeenCalled();
    expect(decryptCallbackSecret).not.toHaveBeenCalled();
    expect(store.markWebhookForwarded).toHaveBeenCalledWith(
      77,
      "evt_app_1",
      { delivered: true, attempts: 0 },
    );
    expect(store.markWebhookFailed).not.toHaveBeenCalled();
  });
});

describe("trimmed AHS form → VRS AI payload", () => {
  it("sends blanks as \"\" (never N/A) and omits an unknown appliance age", () => {
    const built = buildAppVrsAuthorizePayload(minimalTicket, technician);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const payload = built.payload as Record<string, any>;
    expect(payload).toMatchObject({
      customer_name: "",
      customer_address: "",
      service_address: "",
      brand: "",
      model_number: "",
      serial_number: "",
      appliance_grade: "",
      appliance_color: "",
      contract_number: "",
      cta_no: "",
      tax_amount: 0,
      part_price: 245,
      tech_recommendation: "repair",
    });
    expect(payload).not.toHaveProperty("appliance_age");
    expect(payload.parts).toEqual([{
      part_id: "WPW10503278",
      part_description: "Electronic control board",
      sell_price: 245,
      part_function: "",
    }]);
    // No failure-reason comment for a part without one.
    expect(payload.comments.map((c: any) => c.text)).toEqual([
      appTicket.issueDescription,
      APP_ORIGIN_VRS_COMMENT,
    ]);
    // purchase_year is the only N/A left: the V9 type has no blank for it.
    const naFields = Object.entries(payload)
      .filter(([, value]) => value === "N/A")
      .map(([key]) => key);
    expect(naFields).toEqual(["purchase_year"]);
  });

  it("maps the tech's repair-or-replace choice", () => {
    const built = buildAppVrsAuthorizePayload(
      { ...minimalTicket, ahsDetails: JSON.stringify({ ...minimalAhsDetails, techRecommendation: "replace" }) },
      technician,
    );
    expect(built).toMatchObject({ ok: true, payload: { tech_recommendation: "replace" } });
  });

  it("maps a ticket stored in the old shape (no recommendation) as a repair", () => {
    const { techRecommendation: _r, ...oldShape } = ahsDetails;
    const built = buildAppVrsAuthorizePayload(
      { ...appTicket, ahsDetails: JSON.stringify(oldShape) },
      technician,
    );
    expect(built).toMatchObject({
      ok: true,
      payload: { tech_recommendation: "repair", appliance_age: 4, brand: "Whirlpool" },
    });
  });

  it("dispatches a minimal app-origin row to VRS AI with the blanks intact", async () => {
    const built = buildAppVrsAuthorizePayload(minimalTicket, technician);
    if (!built.ok) throw new Error(built.reason);
    const fetchImpl = fetchAccepting();
    const store = dispatchStore(built.payload, "");

    const result = await dispatchVrsAiForSubmission({
      submissionId: 503,
      store,
      client: {
        authorize: ({ payload, appOrigin }) =>
          sendVrsAuthorizeRequest({
            baseUrl: "https://vrs-ai.example",
            apiKey: "vrs-ai-key",
            callbackUrl: EXPRESS_WEBHOOK,
            callbackSecret: "express-ai-webhook-secret",
            payload,
            appOrigin,
            fetchImpl,
          }),
      },
      callbackUrl: EXPRESS_WEBHOOK,
      callbackSecret: "express-ai-webhook-secret",
    });

    expect(store.markDispatchFailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "accepted", providerCallId: "vrs_ai_777" });
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(sent).toMatchObject({ brand: "", appliance_grade: "", cta_no: "", callback_url: EXPRESS_WEBHOOK });
    expect(sent).not.toHaveProperty("appliance_age");
  });

  it("still requires VRS AI's hard fields on app-origin payloads", () => {
    const built = buildAppVrsAuthorizePayload(minimalTicket, technician);
    if (!built.ok) throw new Error(built.reason);
    const outbound = { ...built.payload, callback_url: EXPRESS_WEBHOOK, callback_secret: "express-ai-webhook-secret" };
    expect(safeParseVrsAppOriginOutboundRequest(outbound).success).toBe(true);
    for (const broken of [
      { ...outbound, parts: [] },
      { ...outbound, tech_id: " " },
      { ...outbound, service_order: "123" },
      { ...outbound, callback_url: "http://insecure.example/webhook" },
      { ...outbound, cta_no: "AHS-1" },
      { ...outbound, appliance_grade: "deluxe" },
      { ...outbound, surprise_field: "x" },
    ]) {
      expect(safeParseVrsAppOriginOutboundRequest(broken).success).toBe(false);
    }
  });

  describe("SASHA strictness is unchanged", () => {
    const blankPayload = () => {
      const built = buildAppVrsAuthorizePayload(minimalTicket, technician);
      if (!built.ok) throw new Error(built.reason);
      return built.payload;
    };
    const blankFields = [
      "customer_address",
      "service_address",
      "brand",
      "model_number",
      "serial_number",
      "appliance_age",
      "appliance_grade",
      "appliance_color",
      "contract_number",
      "cta_no",
    ];

    it("rejects the blanks on the SASHA inbound /vrs/authorize schema", () => {
      const result = safeParseVrsAuthorizeRequest({
        ...blankPayload(),
        callback_url: SASHA_WEBHOOK,
        callback_secret: "sasha-callback-secret-0001",
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      const paths = new Set(result.error.issues.map((issue) => issue.path.join(".")));
      for (const field of blankFields) expect(paths).toContain(field);
    });

    it("rejects the blanks on the general outbound parse and in sendVrsAuthorizeRequest", async () => {
      const outbound = { ...blankPayload(), callback_url: EXPRESS_WEBHOOK, callback_secret: "express-ai-webhook-secret" };
      expect(safeParseVrsOutboundSourceRequest(outbound).success).toBe(false);
      const fetchImpl = fetchAccepting();
      await expect(sendVrsAuthorizeRequest({
        baseUrl: "https://vrs-ai.example",
        apiKey: "vrs-ai-key",
        callbackUrl: EXPRESS_WEBHOOK,
        callbackSecret: "express-ai-webhook-secret",
        payload: outbound as any,
        fetchImpl,
      })).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("fails a SASHA-origin row with the same blanks at dispatch, and passes it when complete", async () => {
      const blankStore = dispatchStore({ ...blankPayload(), callback_url: SASHA_WEBHOOK }, SASHA_WEBHOOK);
      const client = { authorize: vi.fn().mockResolvedValue({ kind: "accepted", callId: "x", state: "queued", duplicate: false }) };
      const failed = await dispatchVrsAiForSubmission({
        submissionId: 503,
        store: blankStore,
        client,
        callbackUrl: EXPRESS_WEBHOOK,
        callbackSecret: "express-ai-webhook-secret",
      });
      expect(failed).toMatchObject({ kind: "failed" });
      expect((failed as { message: string }).message).toContain("brand");
      expect(client.authorize).not.toHaveBeenCalled();

      const full = buildAppVrsAuthorizePayload(appTicket, technician);
      if (!full.ok) throw new Error(full.reason);
      const fullStore = dispatchStore({ ...full.payload, callback_url: SASHA_WEBHOOK }, SASHA_WEBHOOK);
      const accepted = await dispatchVrsAiForSubmission({
        submissionId: 503,
        store: fullStore,
        client,
        callbackUrl: EXPRESS_WEBHOOK,
        callbackSecret: "express-ai-webhook-secret",
      });
      expect(accepted).toMatchObject({ kind: "accepted" });
      // SASHA rows never ask the client for the relaxed app-origin rules.
      expect(client.authorize.mock.calls[0][0]).not.toHaveProperty("appOrigin");
    });
  });
});
