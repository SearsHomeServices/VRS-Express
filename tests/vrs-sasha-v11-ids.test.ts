import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import * as apiModule from "../server/vrs-sasha-api";
import {
  safeParseVrsAuthorizeRequest,
  sendVrsAuthorizeRequest,
  type VrsAuthorizeRequest,
} from "../server/vrs-sasha-contract";
import {
  dispatchVrsAiForSubmission,
  projectVrsBridgeIntake,
  sashaV11IdsForVrsAi,
} from "../server/vrs-sasha-queue";
import {
  validV8AuthorizePayload,
  validV9AuthorizePayload,
} from "./fixtures/vrs-authorize-payloads";

// V11 (SASHA SHSAI-3374): VRS Express accepts b2b_client_id and proc_id,
// keeps them on the ticket and forwards them to VRS AI as strings ("" when
// omitted). VRS Express also routes on them (resolveSashaPartner,
// tests/vrs-sasha-partner-resolution.test.ts) and refuses placeholder or
// unsupported ids before any call; VRS AI's own 422 UNSUPPORTED_PARTNER is
// still handled.

const v11Payload = {
  ...validV9AuthorizePayload,
  partner_id: "First American Home Buyers",
  b2b_client_id: "2151",
  proc_id: "FAA00001",
};

const callbackUrl =
  "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook";
const callbackSecret = "express-to-vrs-ai-test-secret-32-characters";

function storedFrom(payload: Record<string, unknown>) {
  const { callback_secret: _secret, ...stored } = payload;
  return stored;
}

function fakeStore(requestPayload: Record<string, unknown>) {
  return {
    getBySubmissionId: vi.fn().mockResolvedValue({
      id: 31,
      submissionId: 71,
      callId: "vrs_call_v11",
      providerCallId: null,
      state: "pending_review",
      requestPayload,
    }),
    markDispatching: vi.fn().mockResolvedValue(true),
    markAccepted: vi.fn().mockResolvedValue(undefined),
    markDispatchFailed: vi.fn().mockResolvedValue(undefined),
  };
}

async function dispatchStored(
  requestPayload: Record<string, unknown>,
  authorizeResult: unknown = {
    kind: "accepted",
    callId: "vrs_ai_call_v11",
    state: "queued",
    duplicate: false,
  },
) {
  const store = fakeStore(requestPayload);
  const client = { authorize: vi.fn().mockResolvedValue(authorizeResult) };
  const result = await dispatchVrsAiForSubmission({
    submissionId: 71,
    store,
    client,
    callbackUrl,
    callbackSecret,
  } as Parameters<typeof dispatchVrsAiForSubmission>[0]);
  return {
    result,
    store,
    client,
    sent: client.authorize.mock.calls[0]?.[0].payload as
      | Record<string, unknown>
      | undefined,
  };
}

describe("V11 ids inbound", () => {
  it("accepts b2b_client_id and proc_id on V9 and keeps them as sent", () => {
    const parsed = safeParseVrsAuthorizeRequest(v11Payload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.version).toBe("v9");
    expect(parsed.success && parsed.data).toMatchObject({
      b2b_client_id: "2151",
      proc_id: "FAA00001",
    });
  });

  it.each([
    [2276, "AHZ000"],
    [null, null],
    ["N/A", "N/A"],
    ["", ""],
  ])("accepts b2b_client_id %j / proc_id %j without a 400", (b2b, proc) => {
    const parsed = safeParseVrsAuthorizeRequest({
      ...validV9AuthorizePayload,
      b2b_client_id: b2b,
      proc_id: proc,
    });
    expect(parsed.success).toBe(true);
  });

  it("still accepts a V9 payload without the ids", () => {
    expect(safeParseVrsAuthorizeRequest(validV9AuthorizePayload).success).toBe(
      true,
    );
  });

  it("answers 202 (not 400) at POST /vrs/authorize and hands the ids to intake", async () => {
    const intake = {
      received: undefined as unknown,
      async receive(input: unknown) {
        this.received = input;
        return {
          kind: "accepted" as const,
          callId: "vrs_call_v11",
          serviceOrder: validV9AuthorizePayload.service_order,
          createdAt: new Date("2026-11-06T15:00:00.000Z"),
        };
      },
    };
    const app = express();
    app.use(express.json());
    (apiModule.registerVrsSashaApi as any)(app, {
      apiKey: "test-vrs-api-key",
      intake,
      serviceOrders: { getLatestByServiceOrder: async () => undefined },
    });

    const response = await request(app)
      .post("/vrs/authorize")
      .set("X-API-Key", "test-vrs-api-key")
      .send(v11Payload);

    expect(response.status).toBe(202);
    expect(intake.received).toMatchObject({
      b2b_client_id: "2151",
      proc_id: "FAA00001",
    });
  });

  it("keeps the ids on the stored ticket payload", () => {
    const parsed = safeParseVrsAuthorizeRequest(v11Payload);
    if (!parsed.success) throw parsed.error;
    const { requestPayload } = projectVrsBridgeIntake(parsed.data, "8206");
    expect(requestPayload).toMatchObject({
      b2b_client_id: "2151",
      proc_id: "FAA00001",
    });
    expect(requestPayload).not.toHaveProperty("callback_secret");
  });
});

describe("V11 ids outbound to VRS AI", () => {
  it("forwards both ids verbatim as strings", async () => {
    const { sent } = await dispatchStored(storedFrom(v11Payload));
    expect(sent).toMatchObject({ b2b_client_id: "2151", proc_id: "FAA00001" });
  });

  it("stringifies a numeric id SASHA sent", async () => {
    const { sent } = await dispatchStored(
      storedFrom({ ...validV9AuthorizePayload, b2b_client_id: 2276, proc_id: "AHZ000" }),
    );
    expect(sent?.b2b_client_id).toBe("2276");
    expect(sent?.proc_id).toBe("AHZ000");
  });

  it('sends "" for both when SASHA omitted them', async () => {
    const omitted = await dispatchStored(storedFrom(validV9AuthorizePayload));
    expect(omitted.sent).toMatchObject({ b2b_client_id: "", proc_id: "" });
  });

  // Was pass-through until 2026-11-06: null / "N/A" ids now mean no partner
  // VRS AI calls, so the dispatch fails without calling VRS AI.
  it.each([
    [null, null],
    ["N/A", "N/A"],
  ])("refuses b2b_client_id %j / proc_id %j without calling VRS AI", async (b2b, proc) => {
    const { result, client, store } = await dispatchStored(
      storedFrom({ ...validV9AuthorizePayload, b2b_client_id: b2b, proc_id: proc }),
    );
    expect(result).toMatchObject({ kind: "failed" });
    expect(client.authorize).not.toHaveBeenCalled();
    expect(store.markDispatchFailed).toHaveBeenCalledWith(
      31,
      "Not sent to VRS AI: b2b_client_id is missing or a placeholder",
    );
  });

  it("sends the VRS AI registry key as partner_id with the ids unchanged", async () => {
    const { sent } = await dispatchStored(
      storedFrom({ ...v11Payload, partner_id: "FA" }),
    );
    expect(sent?.partner_id).toBe("FIRST_AMERICAN");
    expect(sent?.b2b_client_id).toBe("2151");
  });

  it("does not add the ids to older (V8) payloads", async () => {
    const { sent } = await dispatchStored(storedFrom(validV8AuthorizePayload));
    expect(sent).not.toHaveProperty("b2b_client_id");
    expect(sent).not.toHaveProperty("proc_id");
  });

  it("puts both ids in the HTTP body posted to /vrs/authorize", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ call_id: "vrs_ai_call_v11", state: "queued" }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await expect(
      sendVrsAuthorizeRequest({
        baseUrl: "https://vrs-dev.stage.nextgen.shs.com",
        apiKey: "test-api-key",
        callbackUrl,
        callbackSecret,
        payload: {
          ...v11Payload,
          ...sashaV11IdsForVrsAi(v11Payload),
        } as VrsAuthorizeRequest,
        fetchImpl,
      }),
    ).resolves.toMatchObject({ kind: "accepted" });

    expect(url).toBe("https://vrs-dev.stage.nextgen.shs.com/vrs/authorize");
    expect(body).toMatchObject({ b2b_client_id: "2151", proc_id: "FAA00001" });
  });
});

describe("VRS AI 422 UNSUPPORTED_PARTNER", () => {
  const unsupportedBody = {
    error: "UNSUPPORTED_PARTNER",
    message:
      "Partner not supported. Only AHS and First American are callable; no call placed.",
    service_order: validV9AuthorizePayload.service_order,
  };

  it("comes back as a failed result carrying VRS AI's message", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(unsupportedBody), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof fetch;

    await expect(
      sendVrsAuthorizeRequest({
        baseUrl: "https://vrs-dev.stage.nextgen.shs.com",
        apiKey: "test-api-key",
        callbackUrl,
        callbackSecret,
        payload: {
          ...validV9AuthorizePayload,
          b2b_client_id: "2318",
          proc_id: "",
        } as VrsAuthorizeRequest,
        fetchImpl,
      }),
    ).resolves.toEqual({
      kind: "failed",
      status: 422,
      message: unsupportedBody.message,
    });
  });

  it("marks the dispatch failed with that message and does not retry", async () => {
    const failed = {
      kind: "failed",
      status: 422,
      message: unsupportedBody.message,
    };
    // VRS Express accepts these ids; VRS AI refusing them anyway is still
    // recorded as a failure.
    const { result, store, client } = await dispatchStored(
      storedFrom(v11Payload),
      failed,
    );
    expect(result).toEqual(failed);
    expect(client.authorize).toHaveBeenCalledTimes(1);
    expect(store.markDispatchFailed).toHaveBeenCalledWith(
      31,
      unsupportedBody.message,
    );
    expect(store.markAccepted).not.toHaveBeenCalled();
  });
});
