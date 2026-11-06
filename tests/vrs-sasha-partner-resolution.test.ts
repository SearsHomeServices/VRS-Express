import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { resolveSashaPartner, vrsAiWarrantyFromPartnerId } from "../shared/warranty";
import { registerVrsSashaApi } from "../server/vrs-sasha-api";
import {
  createVrsSashaIntake,
  type VrsSashaIntakeDependencies,
} from "../server/vrs-sasha-intake";
import type { VrsBridgeIntakeStore } from "../server/vrs-sasha-store";
import type { VrsAuthorizeRequest } from "../server/vrs-sasha-contract";
import {
  dispatchVrsAiForSubmission,
  mapVrsPayloadToSubmission,
} from "../server/vrs-sasha-queue";
import {
  validV5AuthorizePayload,
  validV8AuthorizePayload,
  validV9AuthorizePayload,
} from "./fixtures/vrs-authorize-payloads";

// Strict SASHA partner resolution (V11 §5; 2026-11-06): VRS Express never
// defaults to American Home Shield and always knows from the payload which
// partner VRS AI will call. The same resolver runs at intake (422
// UNSUPPORTED_PARTNER), at ticket mapping and at dispatch.

const PLACEHOLDERS = ["", "   ", "N/A", " n/a ", "NA", "na", "TBD", "tbd", "NONE", "none", "NULL", "null", "UNKNOWN", "Unknown"];

const ahsIds = { b2b_client_id: "2276", proc_id: "AHS000" };
const faIds = { b2b_client_id: "2151", proc_id: "FAA01A" };

describe("rule 1: partner_id without a value is always unsupported", () => {
  it.each([undefined, null, ...PLACEHOLDERS])("partner_id %j alone", (partnerId) => {
    expect(resolveSashaPartner({ partner_id: partnerId })).toEqual({
      ok: false,
      reason: "partner_id is missing or a placeholder",
    });
  });

  it.each([undefined, "N/A", "TBD", "none", "  "])("partner_id %j even with valid ids", (partnerId) => {
    expect(resolveSashaPartner({ partner_id: partnerId, ...ahsIds })).toMatchObject({ ok: false });
    expect(resolveSashaPartner({ partner_id: partnerId, ...faIds })).toMatchObject({ ok: false });
  });
});

describe("rule 2: V11 ids decide when either key is present", () => {
  it.each([
    ["2276", "AHS000", "american_home_shield"],
    ["2276", "AHZ000", "american_home_shield"],
    ["2276", "AHT300", "american_home_shield"],
    ["2276", "ahs000", "american_home_shield"],
    [2276, "AHZ000", "american_home_shield"],
    [" 2276 ", " AHS000 ", "american_home_shield"],
    ["2151", "FAA01A", "first_american"],
    ["2151", "FAA03A", "first_american"],
    [2151, "FAA02R", "first_american"],
  ] as const)("b2b_client_id %j / proc_id %j → %s", (b2b, proc, warrantyType) => {
    // A partner_id naming no known partner is ignored: the ids decide.
    expect(resolveSashaPartner({ partner_id: "Some Client Co", b2b_client_id: b2b, proc_id: proc })).toEqual({
      ok: true,
      warrantyType,
      source: "b2b_client_id",
    });
  });

  it("routes on b2b_client_id with SASHA's matching display names", () => {
    expect(resolveSashaPartner({ partner_id: "American Home Shield", ...ahsIds })).toEqual({
      ok: true, warrantyType: "american_home_shield", source: "b2b_client_id",
    });
    expect(resolveSashaPartner({ partner_id: "First American Home Buyers", ...faIds })).toEqual({
      ok: true, warrantyType: "first_american", source: "b2b_client_id",
    });
  });

  it.each([undefined, null, ...PLACEHOLDERS])("b2b_client_id %j is refused", (b2b) => {
    expect(resolveSashaPartner({ partner_id: "American Home Shield", b2b_client_id: b2b, proc_id: "AHS000" }))
      .toEqual({ ok: false, reason: "b2b_client_id is missing or a placeholder" });
  });

  it.each([undefined, null, ...PLACEHOLDERS])("proc_id %j is refused", (proc) => {
    expect(resolveSashaPartner({ partner_id: "American Home Shield", b2b_client_id: "2276", proc_id: proc }))
      .toEqual({ ok: false, reason: "proc_id is missing or a placeholder" });
  });

  it.each(["2318", "2172", "61380", "20730", "9999", 2318])(
    "b2b_client_id %j is not a client VRS AI calls",
    (b2b) => {
      expect(resolveSashaPartner({ partner_id: "Assurant - PA", b2b_client_id: b2b, proc_id: "FWSMP1" }))
        .toEqual({ ok: false, reason: `b2b_client_id ${b2b} is not a client VRS AI calls` });
      // Even a known partner name cannot rescue an unsupported client.
      expect(resolveSashaPartner({ partner_id: "AHS", b2b_client_id: b2b, proc_id: "AHS000" }))
        .toMatchObject({ ok: false });
    },
  );

  it.each([
    ["2276", "FAA01A"],
    ["2276", "AHX000"],
    ["2276", "AH"],
    ["2276", "FWSMP1"],
    ["2276", "SP2010"],
    ["2151", "AHS000"],
    ["2151", "FAB01"],
    ["2151", "FA"],
    ["2151", "FWSM20"],
    ["2151", "SPRC00"],
  ])("b2b_client_id %s refuses proc_id %s (not one of its plans)", (b2b, proc) => {
    expect(resolveSashaPartner({ partner_id: "Some Client Co", b2b_client_id: b2b, proc_id: proc }))
      .toEqual({ ok: false, reason: `proc_id ${proc} is not a plan of b2b_client_id ${b2b}` });
  });

  it.each([
    ["American Home Shield", faIds],
    ["ahs", faIds],
    ["First American", ahsIds],
    ["FIRST_AMERICAN", ahsIds],
    ["First American Home Buyers", ahsIds],
  ] as const)("partner_id %j contradicting the ids is refused", (partnerId, ids) => {
    expect(resolveSashaPartner({ partner_id: partnerId, ...ids })).toEqual({
      ok: false,
      reason: `partner_id ${partnerId} contradicts b2b_client_id ${ids.b2b_client_id}`,
    });
  });

  it("refuses when only one of the two keys is present", () => {
    expect(resolveSashaPartner({ partner_id: "AHS", b2b_client_id: "2276" })).toMatchObject({ ok: false });
    expect(resolveSashaPartner({ partner_id: "AHS", proc_id: "AHS000" })).toMatchObject({ ok: false });
  });
});

describe("rule 3: without ids, the partner_id name decides", () => {
  it.each(["ahs", "AHS", "American Home Shield", "american-home-shield", "  AHS  "])(
    "%j → AHS",
    (partnerId) => {
      expect(resolveSashaPartner({ partner_id: partnerId })).toEqual({
        ok: true, warrantyType: "american_home_shield", source: "partner_id",
      });
    },
  );

  it.each(["FA", "fa", "First American", "FIRST_AMERICAN", "First American Home Buyers", "first-american"])(
    "%j → First American",
    (partnerId) => {
      expect(resolveSashaPartner({ partner_id: partnerId })).toEqual({
        ok: true, warrantyType: "first_american", source: "partner_id",
      });
    },
  );

  // 61380 / 20730 / "N/A" / missing were AHS or FA aliases before 2026-11-06.
  it.each(["61380", "20730", "90550", "61481", "Assurant - PA", "Sears, Roebuck & Co.", "SPHW", "SEARS_PROTECT"])(
    "%j is unsupported",
    (partnerId) => {
      expect(resolveSashaPartner({ partner_id: partnerId })).toEqual({
        ok: false,
        reason: `partner_id ${partnerId} is not a partner VRS AI calls`,
      });
    },
  );

  it("vrsAiWarrantyFromPartnerId no longer defaults to AHS", () => {
    for (const value of [undefined, null, "", "N/A", "61380", "20730"]) {
      expect(vrsAiWarrantyFromPartnerId(value)).toBeNull();
    }
  });
});

// --- intake: 422 UNSUPPORTED_PARTNER before any ticket work ---

function makeIntakeApp() {
  const store = {
    findActiveByServiceOrder: vi.fn(async () => undefined),
    createIntake: vi.fn(async (input: { submissionId: number; callId: string; requestPayload: unknown }) => ({
      kind: "accepted" as const,
      record: {
        id: 91,
        submissionId: input.submissionId,
        callId: input.callId,
        providerCallId: null,
        state: "pending_review",
        requestPayload: input.requestPayload,
      },
      createdAt: new Date("2026-11-06T15:00:00.000Z"),
    })),
    findLocallyAppliedRetryableFailedV8SubmissionsByServiceOrder: vi.fn(async () => []),
  } as unknown as VrsBridgeIntakeStore;
  const ticketBodies: Array<Record<string, unknown>> = [];
  const deps: VrsSashaIntakeDependencies = {
    store,
    resolveTechnician: vi.fn(async () => ({
      ldapId: "0123456",
      name: "Test Technician",
      phone: "+19845550111",
      district: "1353",
      isActive: true,
    })),
    resolveTechUser: vi.fn(async () => ({
      id: 501,
      email: "tech@example.test",
      name: "Test Technician",
      role: "technician",
      racId: "0123456",
      phone: "+19845550111",
    })),
    encryptCallbackSecret: vi.fn(() => ({ cipher: "c", iv: "i", authTag: "t", salt: "s" })),
    generateCallId: vi.fn(() => "vrs_call_strict"),
    createTicket: vi.fn(async ({ body }) => {
      ticketBodies.push(body as Record<string, unknown>);
      return { kind: "created" as const, submissionId: 42 };
    }),
  };
  const app = express();
  app.use(express.json());
  (registerVrsSashaApi as any)(app, {
    apiKey: "test-vrs-api-key",
    intake: createVrsSashaIntake(deps),
    serviceOrders: { getLatestByServiceOrder: async () => undefined },
  });
  const post = (body: Record<string, unknown>) =>
    request(app).post("/vrs/authorize").set("X-API-Key", "test-vrs-api-key").send(body);
  return { post, deps, ticketBodies };
}

const MESSAGE = "VRS AI phone automation supports American Home Shield and First American only";

describe("intake (POST /vrs/authorize)", () => {
  it.each([
    ["V9 partner_id N/A", { ...validV9AuthorizePayload, partner_id: "N/A" }, "partner_id is missing or a placeholder"],
    ["V9 partner_id TBD with valid ids", { ...validV9AuthorizePayload, partner_id: "TBD", ...ahsIds }, "partner_id is missing or a placeholder"],
    ["V9 proc_id N/A", { ...validV9AuthorizePayload, b2b_client_id: "2276", proc_id: "N/A" }, "proc_id is missing or a placeholder"],
    ["V9 proc_id none", { ...validV9AuthorizePayload, b2b_client_id: "2276", proc_id: "none" }, "proc_id is missing or a placeholder"],
    ["V9 b2b_client_id null", { ...validV9AuthorizePayload, b2b_client_id: null, proc_id: "AHS000" }, "b2b_client_id is missing or a placeholder"],
    ["V9 Assurant ids", { ...validV9AuthorizePayload, partner_id: "Assurant - PA", b2b_client_id: "2318", proc_id: "FWSMP1" }, "b2b_client_id 2318 is not a client VRS AI calls"],
    ["V9 FA client with FAB01 plan", { ...validV9AuthorizePayload, partner_id: "First American Home Buyers", b2b_client_id: "2151", proc_id: "FAB01" }, "proc_id FAB01 is not a plan of b2b_client_id 2151"],
    ["V9 AHS name with FA ids", { ...validV9AuthorizePayload, ...faIds }, "partner_id American Home Shield contradicts b2b_client_id 2151"],
    ["V8 partner_id 61380", { ...validV8AuthorizePayload, partner_id: "61380" }, "partner_id 61380 is not a partner VRS AI calls"],
  ])("%s → 422 with the reason", async (_label, body, reason) => {
    const { post, deps, ticketBodies } = makeIntakeApp();
    const response = await post(body);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      error: "UNSUPPORTED_PARTNER",
      message: `${MESSAGE} (${reason})`,
    });
    expect(deps.store.findActiveByServiceOrder).not.toHaveBeenCalled();
    expect(deps.resolveTechnician).not.toHaveBeenCalled();
    expect(deps.createTicket).not.toHaveBeenCalled();
    expect(ticketBodies).toHaveLength(0);
  });

  it("echoes b2b_client_id as a string on a 422", async () => {
    const { post } = makeIntakeApp();
    const response = await post({ ...validV9AuthorizePayload, partner_id: "Sears, Roebuck & Co.", b2b_client_id: 2172, proc_id: "SP2010" });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ partner_id: "Sears, Roebuck & Co.", b2b_client_id: "2172" });
  });

  it("refuses a V5 payload without partner_id (was AHS)", async () => {
    const { post, deps } = makeIntakeApp();
    const { partner_id: _partnerId, ...v5 } = validV5AuthorizePayload as Record<string, unknown>;
    const response = await post(v5);
    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "UNSUPPORTED_PARTNER",
      message: `${MESSAGE} (partner_id is missing or a placeholder)`,
      partner_id: "unknown",
    });
    expect(deps.createTicket).not.toHaveBeenCalled();
  });

  it.each([
    ["AHS ids", { ...validV9AuthorizePayload, ...ahsIds }, "american_home_shield"],
    ["FA ids, numeric client id", { ...validV9AuthorizePayload, partner_id: "First American Home Buyers", b2b_client_id: 2151, proc_id: "FAA01R" }, "first_american"],
    ["FA ids, unknown display name", { ...validV9AuthorizePayload, partner_id: "FAHB Inc", ...faIds }, "first_american"],
    ["no ids, FA name", { ...validV8AuthorizePayload, partner_id: "FA" }, "first_american"],
  ] as const)("accepts %s and creates a %s ticket", async (_label, body, warrantyType) => {
    const { post, ticketBodies } = makeIntakeApp();
    const response = await post(body);
    expect(response.status).toBe(202);
    expect(ticketBodies).toHaveLength(1);
    expect(ticketBodies[0]).toMatchObject({ warrantyType });
  });
});

describe("mapVrsPayloadToSubmission", () => {
  it("takes the warranty from b2b_client_id", () => {
    const mapped = mapVrsPayloadToSubmission(
      { ...validV9AuthorizePayload, partner_id: "FAHB Inc", ...faIds } as VrsAuthorizeRequest,
      "1353",
    );
    expect(mapped).toMatchObject({ warrantyType: "first_american", warrantyProvider: "First American" });
  });

  it.each([
    { ...validV9AuthorizePayload, partner_id: "N/A" },
    { ...validV9AuthorizePayload, b2b_client_id: "2276", proc_id: "TBD" },
    { ...validV9AuthorizePayload, ...faIds },
  ])("throws instead of defaulting to AHS (%#)", (payload) => {
    expect(() => mapVrsPayloadToSubmission(payload as VrsAuthorizeRequest, "1353"))
      .toThrow(/^Unsupported VRS partner: /);
  });
});

// --- dispatch: the same resolver, no call for an unsupported partner ---

function stored(payload: Record<string, unknown>) {
  const { callback_secret: _secret, ...rest } = payload;
  return rest;
}

async function dispatch(requestPayload: Record<string, unknown>) {
  const store = {
    getBySubmissionId: vi.fn().mockResolvedValue({
      id: 41,
      submissionId: 81,
      callId: "vrs_call_strict",
      providerCallId: null,
      state: "pending_review",
      requestPayload,
    }),
    markDispatching: vi.fn().mockResolvedValue(true),
    markAccepted: vi.fn().mockResolvedValue(undefined),
    markDispatchFailed: vi.fn().mockResolvedValue(undefined),
  };
  const client = {
    authorize: vi.fn().mockResolvedValue({
      kind: "accepted",
      callId: "vrs_ai_call_strict",
      state: "queued",
      duplicate: false,
    }),
  };
  const result = await dispatchVrsAiForSubmission({
    submissionId: 81,
    store,
    client,
    callbackUrl: "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
    callbackSecret: "express-to-vrs-ai-test-secret-32-characters",
  } as Parameters<typeof dispatchVrsAiForSubmission>[0]);
  return {
    result,
    store,
    client,
    sent: client.authorize.mock.calls[0]?.[0].payload as Record<string, unknown> | undefined,
  };
}

describe("dispatch", () => {
  it.each([
    ["pre-V11 row with partner_id N/A", stored({ ...validV8AuthorizePayload, partner_id: "N/A" }), "partner_id is missing or a placeholder"],
    ["V5 row without partner_id", (() => { const { partner_id: _p, ...rest } = stored(validV5AuthorizePayload); return rest; })(), "partner_id is missing or a placeholder"],
    ["V9 row with N/A ids", stored({ ...validV9AuthorizePayload, b2b_client_id: "N/A", proc_id: "N/A" }), "b2b_client_id is missing or a placeholder"],
    ["V9 row with unknown proc_id", stored({ ...validV9AuthorizePayload, b2b_client_id: "2276", proc_id: "UNKNOWN" }), "proc_id is missing or a placeholder"],
    ["V9 row with FAB01 plan", stored({ ...validV9AuthorizePayload, partner_id: "FA", b2b_client_id: "2151", proc_id: "FAB01" }), "proc_id FAB01 is not a plan of b2b_client_id 2151"],
  ])("%s fails without calling VRS AI", async (_label, payload, reason) => {
    const { result, client, store } = await dispatch(payload);
    expect(result).toEqual({ kind: "failed", message: `Not sent to VRS AI: ${reason}` });
    expect(client.authorize).not.toHaveBeenCalled();
    expect(store.markDispatchFailed).toHaveBeenCalledWith(41, `Not sent to VRS AI: ${reason}`);
  });

  it("sends the registry key from b2b_client_id and passes the ids through as strings", async () => {
    const { sent } = await dispatch(
      stored({ ...validV9AuthorizePayload, partner_id: "First American Home Buyers", b2b_client_id: 2151, proc_id: "FAA02B" }),
    );
    expect(sent).toMatchObject({ partner_id: "FIRST_AMERICAN", b2b_client_id: "2151", proc_id: "FAA02B" });
  });

  it.each([
    ["AHS", "AHS"],
    ["FIRST_AMERICAN", "FIRST_AMERICAN"],
  ])("still dispatches an app-origin style row with partner_id %s and no ids", async (partnerId, key) => {
    const { sent, client } = await dispatch(stored({ ...validV9AuthorizePayload, partner_id: partnerId }));
    expect(client.authorize).toHaveBeenCalledTimes(1);
    expect(sent).toMatchObject({ partner_id: key, b2b_client_id: "", proc_id: "" });
  });
});
