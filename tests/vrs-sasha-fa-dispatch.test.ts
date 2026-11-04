import { describe, expect, it, vi } from "vitest";
import * as bridgeModule from "../server/vrs-sasha-queue";
import {
  validV5AuthorizePayload,
  validV8AuthorizePayload,
} from "./fixtures/vrs-authorize-payloads";

// VRS AI matches partner_id by exact registry key and falls back to AHS for
// anything else, so every SASHA spelling leaves VRS Express as exactly "AHS" or
// "FIRST_AMERICAN", and Sears Protect / Assurant are never sent.

function fakeStore(requestPayload: Record<string, unknown>) {
  return {
    getBySubmissionId: vi.fn().mockResolvedValue({
      id: 21,
      submissionId: 61,
      callId: "vrs_call_partner",
      providerCallId: null,
      state: "pending_review",
      requestPayload,
    }),
    markDispatching: vi.fn().mockResolvedValue(true),
    markAccepted: vi.fn().mockResolvedValue(undefined),
    markDispatchFailed: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeClient() {
  return {
    authorize: vi.fn().mockResolvedValue({
      kind: "accepted" as const,
      callId: "vrs_ai_call_partner",
      state: "queued",
      duplicate: false,
    }),
  };
}

async function dispatchStored(requestPayload: Record<string, unknown>) {
  const store = fakeStore(requestPayload);
  const client = fakeClient();
  const result = await bridgeModule.dispatchVrsAiForSubmission({
    submissionId: 61,
    store,
    client,
    callbackUrl:
      "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
    callbackSecret: "express-to-vrs-ai-test-secret",
  });
  expect(result).toMatchObject({ kind: "accepted" });
  return client.authorize.mock.calls[0]?.[0].payload;
}

function storedV8(partnerId: string) {
  const { callback_secret: _callbackSecret, ...storedPayload } = {
    ...validV8AuthorizePayload,
    partner_id: partnerId,
  };
  return storedPayload;
}

describe("VRS AI dispatch partner_id", () => {
  it.each(["FA", "fa", "First American", "FIRST_AMERICAN"])(
    "sends stored First American partner_id %j as FIRST_AMERICAN",
    async (partnerId) => {
      const sent = await dispatchStored(storedV8(partnerId));
      expect(sent.partner_id).toBe("FIRST_AMERICAN");
    },
  );

  it.each(["ahs", "American Home Shield", "N/A", "61380", "AHS"])(
    "sends stored AHS partner_id %j as AHS",
    async (partnerId) => {
      const sent = await dispatchStored(storedV8(partnerId));
      expect(sent.partner_id).toBe("AHS");
    },
  );

  it("sends SASHA's First American client id 20730 as FIRST_AMERICAN", async () => {
    const sent = await dispatchStored(storedV8("20730"));
    expect(sent.partner_id).toBe("FIRST_AMERICAN");
  });

  it("sends a V5 payload without partner_id as AHS", async () => {
    const {
      callback_secret: _callbackSecret,
      partner_id: _partnerId,
      ...storedPayload
    } = validV5AuthorizePayload;
    const sent = await dispatchStored(storedPayload);
    expect(sent.partner_id).toBe("AHS");
  });

  it.each(["90550", "61481", "SEARS_PROTECT", "ASSURANT"])(
    "never calls VRS AI for partner_id %j",
    async (partnerId) => {
      const store = fakeStore(storedV8(partnerId));
      const client = fakeClient();
      const result = await bridgeModule.dispatchVrsAiForSubmission({
        submissionId: 61,
        store,
        client,
        callbackUrl:
          "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
        callbackSecret: "express-to-vrs-ai-test-secret",
      });
      expect(result).toMatchObject({ kind: "failed" });
      expect(client.authorize).not.toHaveBeenCalled();
      expect(store.markDispatchFailed).toHaveBeenCalled();
    },
  );

  it("does not mutate the stored record payload", async () => {
    const storedPayload = storedV8("FA");
    const snapshot = structuredClone(storedPayload);
    const sent = await dispatchStored(storedPayload);
    expect(sent.partner_id).toBe("FIRST_AMERICAN");
    expect(storedPayload).toEqual(snapshot);
    expect(storedPayload.partner_id).toBe("FA");
  });
});
