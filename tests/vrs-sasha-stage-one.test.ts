import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  decideVrsStageOneBridge,
  resolveVrsAiBridgeActivation,
  resolveVrsStageOneBridgeConfig,
  runVrsStageOneRouteGate,
  type VrsStageOneBridgeOptions,
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

describe("VRS Stage 1 bridge boundary", () => {
  it("uses the existing contract API key for outbound dispatch only in development", () => {
    expect(resolveVrsStageOneBridgeConfig({
      NODE_ENV: "development",
      VRS_AI_BASE_URL: "https://vrs-ai.example.test",
      VRS_SASHA_API_KEY: "existing-contract-key",
      VRS_AI_WEBHOOK_SECRET: "callback-secret-long-enough",
      VRS_EXPRESS_PUBLIC_URL: "https://vrs-express.example.test",
    })).toEqual({
      baseUrl: "https://vrs-ai.example.test",
      apiKey: "existing-contract-key",
      callbackUrl:
        "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
      callbackSecret: "callback-secret-long-enough",
    });

    expect(resolveVrsStageOneBridgeConfig({
      NODE_ENV: "production",
      VRS_AI_PRODUCTION_ENABLED: "true",
      VRS_AI_BASE_URL: "https://vrs-ai.example.test",
      VRS_SASHA_API_KEY: "development-only-key",
      VRS_AI_WEBHOOK_SECRET: "callback-secret-long-enough",
      VRS_EXPRESS_PUBLIC_URL: "https://vrs-express.example.test",
    })).toBeUndefined();
  });

  it("requires an explicit production activation setting", () => {
    const env = {
      NODE_ENV: "production",
      VRS_AI_BASE_URL: "https://vrs-ai.example.test",
      VRS_AI_API_KEY: "outbound-key",
      VRS_AI_WEBHOOK_SECRET: "callback-secret-long-enough",
      VRS_EXPRESS_PUBLIC_URL: "https://vrs-express.example.test",
    };

    expect(resolveVrsAiBridgeActivation(env)).toMatchObject({
      kind: "disabled",
      code: "VRS_AI_BRIDGE_DISABLED",
    });
    expect(resolveVrsStageOneBridgeConfig(env)).toBeUndefined();
  });

  it("rejects explicitly enabled production with incomplete or invalid settings", () => {
    expect(resolveVrsAiBridgeActivation({
      NODE_ENV: "production",
      VRS_AI_PRODUCTION_ENABLED: "true",
      VRS_AI_BASE_URL: "http://vrs-ai.example.test",
      VRS_AI_API_KEY: "outbound-key",
      VRS_AI_WEBHOOK_SECRET: "callback-secret-long-enough",
      VRS_EXPRESS_PUBLIC_URL: "https://vrs-express.example.test",
    })).toMatchObject({
      kind: "invalid",
      code: "VRS_AI_BRIDGE_NOT_CONFIGURED",
    });
  });

  it.each([
    [
      "a too-short callback secret",
      {
        VRS_AI_WEBHOOK_SECRET: "too-short",
      },
    ],
    [
      "a callback URL on a different origin",
      {
        VRS_AI_WEBHOOK_SECRET: "callback-secret-long-enough",
        VRS_AI_CALLBACK_URL:
          "https://other.example.test/api/integrations/vrs-ai/v1/webhook",
      },
    ],
  ])("rejects production with %s", (_case, overrides) => {
    expect(resolveVrsAiBridgeActivation({
      NODE_ENV: "production",
      VRS_AI_PRODUCTION_ENABLED: "true",
      VRS_AI_BASE_URL: "https://vrs-ai.example.test",
      VRS_AI_API_KEY: "outbound-key",
      VRS_AI_WEBHOOK_SECRET: "callback-secret-long-enough",
      VRS_EXPRESS_PUBLIC_URL: "https://vrs-express.example.test",
      ...overrides,
    })).toMatchObject({
      kind: "invalid",
      code: "VRS_AI_BRIDGE_NOT_CONFIGURED",
    });
  });

  it("activates production only when the deliberate gate and all settings are valid", () => {
    expect(resolveVrsAiBridgeActivation({
      NODE_ENV: "production",
      VRS_AI_PRODUCTION_ENABLED: "true",
      VRS_AI_BASE_URL: "https://vrs-ai.example.test",
      VRS_AI_API_KEY: "outbound-key",
      VRS_AI_WEBHOOK_SECRET: "callback-secret-long-enough",
      VRS_EXPRESS_PUBLIC_URL: "https://vrs-express.example.test",
    })).toEqual({
      kind: "active",
      config: {
        baseUrl: "https://vrs-ai.example.test",
        apiKey: "outbound-key",
        callbackUrl:
          "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
        callbackSecret: "callback-secret-long-enough",
      },
    });
  });

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

  it("returns a 503 when bridge configuration is missing", async () => {
    const boundary = makeBoundary({ bridge: bridgeRecord });

    const result = await decideVrsStageOneBridge(boundary.options);

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
  });

  it("finishes dispatch before returning an accepted decision", async () => {
    const events: string[] = [];
    const boundary = makeBoundary({
      bridge: bridgeRecord,
      config: configuredBridge,
      events,
    });
    const result = await decideVrsStageOneBridge(boundary.options);

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
    ]);
  });

  it("forwards the private object photo signer only through the bridge dispatch boundary", async () => {
    const boundary = makeBoundary({
      bridge: bridgeRecord,
      config: configuredBridge,
    });
    const signObjectPhotoUrl = vi.fn(async () =>
      "https://storage.googleapis.com/example/signed-photo",
    );
    boundary.options.signObjectPhotoUrl = signObjectPhotoUrl;

    await decideVrsStageOneBridge(boundary.options);

    expect(boundary.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ signObjectPhotoUrl }),
    );
  });

  it("returns accepted for an already-dispatched bridge", async () => {
    const boundary = makeBoundary({
      bridge: bridgeRecord,
      config: configuredBridge,
      dispatchResult: {
        kind: "already_dispatched",
        providerCallId: "vrs_ai_call_existing",
        state: "queued",
      },
    });
    const result = await decideVrsStageOneBridge(boundary.options);

    expect(result).toEqual({
      kind: "accepted",
      dispatch: {
        kind: "already_dispatched",
        providerCallId: "vrs_ai_call_existing",
        state: "queued",
      },
    });
  });

  it("maps a busy dispatch to 409", async () => {
    const boundary = makeBoundary({
      bridge: bridgeRecord,
      config: configuredBridge,
      dispatchResult: { kind: "busy" },
    });
    const result = await decideVrsStageOneBridge(boundary.options);

    expect(result).toEqual({
      kind: "http_error",
      status: 409,
      code: "VRS_AI_DISPATCH_IN_PROGRESS",
      message:
        "This ticket is already being sent to VRS AI. Wait a moment and refresh.",
    });
  });

  it.each([
    [429, 429],
    [503, 502],
    [undefined, 502],
  ] as const)(
    "maps failed dispatch status %s to HTTP %s",
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
      const result = await decideVrsStageOneBridge(boundary.options);

      expect(result).toEqual({
        kind: "http_error",
        status: expectedStatus,
        code: "VRS_AI_DISPATCH_FAILED",
        message: "VRS AI dispatch failed",
      });
    },
  );

  it("forwards an HTTP error through the production route gate and stops continuation", async () => {
    const boundary = makeBoundary({ bridge: bridgeRecord });
    const respond = vi.fn();

    const result = await runVrsStageOneRouteGate(
      boundary.options,
      respond,
    );

    expect(result).toBe("responded");
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({
      kind: "http_error",
      status: 503,
      code: "VRS_AI_NOT_CONFIGURED",
      message:
        "VRS AI bridge is not configured. Set VRS_AI_BASE_URL, VRS_AI_API_KEY, VRS_AI_WEBHOOK_SECRET, and VRS_AI_CALLBACK_URL (or VRS_EXPRESS_PUBLIC_URL).",
    });
  });

  it.each([
    ["manual", makeBoundary({})],
    [
      "accepted",
      makeBoundary({ bridge: bridgeRecord, config: configuredBridge }),
    ],
  ])("lets the %s outcome continue through the production route gate", async (_kind, boundary) => {
    const respond = vi.fn();

    const result = await runVrsStageOneRouteGate(
      boundary.options,
      respond,
    );

    expect(result).toBe("continue");
    expect(respond).not.toHaveBeenCalled();
  });

  it("wires the production route gate and early return before all Stage 1 mutation", () => {
    const source = readFileSync(
      new URL("../server/routes.ts", import.meta.url),
      "utf8",
    );
    const handlerStart = source.indexOf(
      "const processSubmissionHandler = async",
    );
    const handlerEnd = source.indexOf(
      'app.patch("/api/submissions/:id/process"',
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);

    const approvalGateStart = handler.indexOf(
      'if (action === "approve_submission") {',
    );
    const gateIndex = handler.indexOf("await runVrsStageOneRouteGate(");
    const earlyReturnIndex = handler.indexOf(
      'if (stageOneGate === "responded")',
    );
    const updateDataIndex = handler.indexOf(
      "const updateData: Record<string, unknown>",
    );
    const stageOneApprovalIndex = handler.indexOf(
      'updateData.stage1Status = "approved"',
    );

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(approvalGateStart).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThan(approvalGateStart);
    expect(handler.slice(approvalGateStart, gateIndex)).toMatch(
      /if \(action === "approve_submission"\) \{\s*const stageOneGate = $/,
    );
    expect(earlyReturnIndex).toBeGreaterThan(gateIndex);
    expect(handler.slice(earlyReturnIndex, updateDataIndex).trimEnd()).toMatch(
      /if \(stageOneGate === "responded"\) \{\s*return;\s*\}\s*\}$/,
    );
    expect(updateDataIndex).toBeGreaterThan(earlyReturnIndex);
    expect(stageOneApprovalIndex).toBeGreaterThan(updateDataIndex);
  });
});
