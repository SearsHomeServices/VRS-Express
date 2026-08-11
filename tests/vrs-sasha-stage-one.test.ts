import { describe, expect, it, vi } from "vitest";
import {
  decideVrsStageOneBridge,
  type VrsStageOneBridgeOptions,
  type VrsStageOneBridgeResult,
} from "../server/vrs-stage-one-bridge";
import type { DispatchVrsAiResult, VrsBridgeRecord } from "../server/vrs-sasha-queue";

const bridgeRecord: VrsBridgeRecord = {
  id: 7,
  submissionId: 42,
  callId: "vrs_call_stage_one",
  providerCallId: null,
  state: "pending_review",
  requestPayload: {} as VrsBridgeRecord["requestPayload"],
};

const configuredBridge = {
  baseUrl: "https://vrs-ai.example.test",
  apiKey: "express-to-ai-test-key",
  callbackUrl:
    "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
  callbackSecret: "express-ai-callback-test-secret",
};

function makeBoundary(overrides: {
  bridge?: VrsBridgeRecord;
  config?: typeof configuredBridge;
  dispatchResult?: DispatchVrsAiResult;
  events?: string[];
}) {
  const events = overrides.events ?? [];
  const store = {
    getBySubmissionId: vi.fn(async () => {
      events.push("bridge_lookup");
      return overrides.bridge;
    }),
    markDispatching: vi.fn(),
    markAccepted: vi.fn(),
    markDispatchFailed: vi.fn(),
  };
  const resolveConfig = vi.fn(() => {
    events.push("config");
    return overrides.config;
  });
  const client = { authorize: vi.fn() };
  const createClient = vi.fn(() => {
    events.push("client");
    return client;
  });
  const dispatch = vi.fn(async () => {
    events.push("dispatch");
    return overrides.dispatchResult ?? {
      kind: "accepted" as const,
      providerCallId: "vrs_ai_call_stage_one",
      state: "queued",
      duplicate: false,
    };
  });
  const options: VrsStageOneBridgeOptions = {
    submissionId: 42,
    store,
    resolveConfig,
    createClient,
    dispatch,
  };

  return {
    events,
    store,
    resolveConfig,
    createClient,
    client,
    dispatch,
    options,
  };
}

async function runStageOneBoundary(
  options: VrsStageOneBridgeOptions,
  legacyStageOne: () => Promise<void>,
): Promise<VrsStageOneBridgeResult> {
  const result = await decideVrsStageOneBridge(options);
  if (result.kind === "not_applicable" || result.kind === "accepted") {
    await legacyStageOne();
  }
  return result;
}

describe("VRS Stage 1 bridge boundary", () => {
  it("returns not_applicable before reading config or constructing a client for a manual ticket", async () => {
    const boundary = makeBoundary({});

    const result = await decideVrsStageOneBridge(boundary.options);

    expect(result).toEqual({ kind: "not_applicable" });
    expect(boundary.events).toEqual(["bridge_lookup"]);
    expect(boundary.resolveConfig).not.toHaveBeenCalled();
    expect(boundary.createClient).not.toHaveBeenCalled();
    expect(boundary.dispatch).not.toHaveBeenCalled();
    expect(boundary.client.authorize).not.toHaveBeenCalled();
  });

  it("returns a 503 without legacy Stage 1 mutation when bridge configuration is missing", async () => {
    const boundary = makeBoundary({ bridge: bridgeRecord });
    const legacyStageOne = vi.fn();

    const result = await runStageOneBoundary(
      boundary.options,
      legacyStageOne,
    );

    expect(result).toEqual({
      kind: "http_error",
      status: 503,
      code: "VRS_AI_NOT_CONFIGURED",
      message:
        "VRS AI bridge is not configured. Set VRS_AI_BASE_URL, VRS_AI_API_KEY, VRS_AI_WEBHOOK_SECRET, and VRS_AI_CALLBACK_URL (or VRS_EXPRESS_PUBLIC_URL).",
    });
    expect(boundary.events).toEqual(["bridge_lookup", "config"]);
    expect(boundary.createClient).not.toHaveBeenCalled();
    expect(boundary.dispatch).not.toHaveBeenCalled();
    expect(legacyStageOne).not.toHaveBeenCalled();
  });

  it("dispatches before allowing the legacy Stage 1 update and SMS exactly once", async () => {
    const events: string[] = [];
    const boundary = makeBoundary({
      bridge: bridgeRecord,
      config: configuredBridge,
      events,
    });
    const legacyStageOne = vi.fn(async () => {
      events.push("legacy_stage_one_update_and_sms");
    });

    const result = await runStageOneBoundary(
      boundary.options,
      legacyStageOne,
    );

    expect(result).toEqual({
      kind: "accepted",
      dispatch: {
        kind: "accepted",
        providerCallId: "vrs_ai_call_stage_one",
        state: "queued",
        duplicate: false,
      },
    });
    expect(events).toEqual([
      "bridge_lookup",
      "config",
      "client",
      "dispatch",
      "legacy_stage_one_update_and_sms",
    ]);
    expect(legacyStageOne).toHaveBeenCalledTimes(1);
  });

  it("allows an already-dispatched bridge through the legacy Stage 1 mutation exactly once", async () => {
    const boundary = makeBoundary({
      bridge: bridgeRecord,
      config: configuredBridge,
      dispatchResult: {
        kind: "already_dispatched",
        providerCallId: "vrs_ai_call_existing",
        state: "queued",
      },
    });
    const legacyStageOne = vi.fn(async () => undefined);

    const result = await runStageOneBoundary(
      boundary.options,
      legacyStageOne,
    );

    expect(result).toEqual({
      kind: "accepted",
      dispatch: {
        kind: "already_dispatched",
        providerCallId: "vrs_ai_call_existing",
        state: "queued",
      },
    });
    expect(legacyStageOne).toHaveBeenCalledTimes(1);
  });

  it("maps a busy dispatch to 409 and leaves Stage 1 unapproved", async () => {
    const boundary = makeBoundary({
      bridge: bridgeRecord,
      config: configuredBridge,
      dispatchResult: { kind: "busy" },
    });
    const legacyStageOne = vi.fn();

    const result = await runStageOneBoundary(
      boundary.options,
      legacyStageOne,
    );

    expect(result).toEqual({
      kind: "http_error",
      status: 409,
      code: "VRS_AI_DISPATCH_IN_PROGRESS",
      message:
        "This ticket is already being sent to VRS AI. Wait a moment and refresh.",
    });
    expect(legacyStageOne).not.toHaveBeenCalled();
  });

  it.each([
    [429, 429],
    [503, 502],
    [undefined, 502],
  ] as const)(
    "maps failed dispatch status %s to HTTP %s and leaves Stage 1 unapproved",
    async (dispatchStatus, expectedStatus) => {
      const boundary = makeBoundary({
        bridge: bridgeRecord,
        config: configuredBridge,
        dispatchResult: {
          kind: "failed",
          status: dispatchStatus,
          message: "VRS AI dispatch failed",
        },
      });
      const legacyStageOne = vi.fn();

      const result = await runStageOneBoundary(
        boundary.options,
        legacyStageOne,
      );

      expect(result).toEqual({
        kind: "http_error",
        status: expectedStatus,
        code: "VRS_AI_DISPATCH_FAILED",
        message: "VRS AI dispatch failed",
      });
      expect(legacyStageOne).not.toHaveBeenCalled();
    },
  );
});
