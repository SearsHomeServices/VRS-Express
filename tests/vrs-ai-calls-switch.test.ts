import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isVrsAiAppEnrollEnabled, isVrsAiCallsEnabled } from "../server/featureFlags";
import { decideVrsStageOneBridge } from "../server/vrs-stage-one-bridge";
import type { VrsBridgeRecord } from "../server/vrs-sasha-queue";

// ElevenLabs API ended 2026-11-05: VRS AI calls are off unless
// VRS_AI_CALLS_ENABLED is exactly "true". Off, every AHS / First American
// ticket (SASHA ones included) takes the manual Stage 1 → Stage 2 flow.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("VRS_AI_CALLS_ENABLED", () => {
  it.each([undefined, "", "false", "TRUE", "1", " true"])("is off for %j", (value) => {
    vi.stubEnv("VRS_AI_CALLS_ENABLED", value as string);
    expect(isVrsAiCallsEnabled()).toBe(false);
  });

  it("is on only for the exact value \"true\"", () => {
    vi.stubEnv("VRS_AI_CALLS_ENABLED", "true");
    expect(isVrsAiCallsEnabled()).toBe(true);
  });

  it("turns technician-ticket enrollment off even when its own flag is on", () => {
    vi.stubEnv("VRS_AI_APP_ENROLL_ENABLED", "true");
    vi.stubEnv("VRS_AI_CALLS_ENABLED", "false");
    expect(isVrsAiAppEnrollEnabled()).toBe(false);
    vi.stubEnv("VRS_AI_CALLS_ENABLED", "true");
    expect(isVrsAiAppEnrollEnabled()).toBe(true);
  });
});

describe("Stage 1 approval while VRS AI calls are off", () => {
  const bridgeRecord: VrsBridgeRecord = {
    id: 7,
    submissionId: 42,
    callId: "vrs_call_off",
    providerCallId: null,
    state: "pending_review",
    requestPayload: {} as VrsBridgeRecord["requestPayload"],
  };

  function boundary(isCallsEnabled?: () => boolean) {
    const store = {
      getBySubmissionId: vi.fn(async () => bridgeRecord),
      markDispatching: vi.fn(),
      markAccepted: vi.fn(),
      markDispatchFailed: vi.fn(),
    };
    const authorize = vi.fn();
    const dispatch = vi.fn(async () => ({ kind: "accepted" as const }) as never);
    const resolveConfig = vi.fn(() => ({
      baseUrl: "https://vrs-ai.example.test/",
      apiKey: "k",
      callbackUrl: "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
      callbackSecret: "express-to-vrs-ai-test-secret",
    }));
    return {
      store, authorize, dispatch, resolveConfig,
      options: {
        submissionId: 42,
        store,
        resolveConfig,
        createClient: () => ({ authorize }),
        dispatch,
        isCallsEnabled,
      },
    };
  }

  it("treats a bridge ticket as manual: no lookup, no config, no dispatch", async () => {
    const b = boundary(() => false);
    await expect(decideVrsStageOneBridge(b.options)).resolves.toEqual({ kind: "not_applicable" });
    expect(b.store.getBySubmissionId).not.toHaveBeenCalled();
    expect(b.resolveConfig).not.toHaveBeenCalled();
    expect(b.dispatch).not.toHaveBeenCalled();
    expect(b.authorize).not.toHaveBeenCalled();
    expect(b.store.markDispatching).not.toHaveBeenCalled();
  });

  it("still dispatches a bridge ticket while calls are on", async () => {
    const b = boundary(() => true);
    await decideVrsStageOneBridge(b.options);
    expect(b.dispatch).toHaveBeenCalledTimes(1);
  });

  it("wires the switch into the Stage 1 route gate and /api/config", () => {
    const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const gate = routes.slice(routes.indexOf("await runVrsStageOneRouteGate("));
    expect(gate.slice(0, gate.indexOf("}, (bridgeError) =>"))).toContain(
      "isCallsEnabled: isVrsAiCallsEnabled,",
    );
    expect(routes).toContain("vrsAiCallsEnabled: isVrsAiCallsEnabled(),");
  });
});
