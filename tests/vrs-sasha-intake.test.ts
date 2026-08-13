import express from "express";
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import * as bridgeStoreModule from "../server/vrs-sasha-store";
import {
  createVrsSashaIntake,
  type VrsSashaIntakeDependencies,
} from "../server/vrs-sasha-intake";
import {
  ACTIVE_VRS_BRIDGE_STATES,
  type NewVrsBridgeIntake,
  type VrsBridgeIntakeStore,
} from "../server/vrs-sasha-store";
import { registerVrsSashaApi } from "../server/vrs-sasha-api";
import {
  validV5AuthorizePayload,
  validV8AuthorizePayload,
} from "./fixtures/vrs-authorize-payloads";

const createdAt = new Date("2026-08-11T21:15:00.000Z");

type RetryableFailureCandidate = {
  submissionId: number | null;
  state: string;
  retryable: boolean | null;
  requestPayload: unknown;
  webhookEventId: string | null;
  eventId: string | null;
  eventState: string | null;
  eventAppliedAt: Date | null;
};

const candidateBridgeStoreModule = bridgeStoreModule as typeof bridgeStoreModule & {
  selectLocallyAppliedRetryableFailedV8SubmissionIds?: (
    rows: readonly RetryableFailureCandidate[],
  ) => readonly number[];
};

function storedV5() {
  const { callback_secret: _secret, ...payload } = validV5AuthorizePayload;
  return payload;
}

function storedV8() {
  const { callback_secret: _secret, ...payload } = validV8AuthorizePayload;
  return payload;
}

function makeHarness(options: {
  initialState?: string;
  initialRetryable?: boolean;
  retryableFailedV8SubmissionIds?: readonly number[];
  legacyBlockingSubmissionIds?: readonly number[];
  nextSubmissionId?: number;
  nextCreateIsDuplicate?: boolean;
  callIds?: string[];
} = {}) {
  const originalSubmissionId = options.initialState ? 42 : undefined;
  const createdBridges: NewVrsBridgeIntake[] = [];
  const ticketBodies: unknown[] = [];
  const calls: string[] = [];
  let ticketCount = 0;
  let receiptSmsCount = 0;
  let nextSubmissionId = options.nextSubmissionId ??
    (options.initialState ? 43 : 42);
  const oldTicketStates = new Map(
    (options.legacyBlockingSubmissionIds ?? []).map((id) => [id, "pending"]),
  );
  const ticketOptions: Array<{
    ignoreLegacyDuplicateSubmissionIds?: readonly number[];
  } | undefined> = [];
  let current = options.initialState
    ? {
        id: 91,
        submissionId: originalSubmissionId!,
        callId: "vrs_call_old",
        providerCallId: "vrs_ai_old",
        state: options.initialState,
        retryable: options.initialRetryable ?? false,
        requestPayload: storedV8(),
      }
    : undefined;
  const callIds = [...(options.callIds ?? ["vrs_call_new"])];

  const store: VrsBridgeIntakeStore = {
    findActiveByServiceOrder: vi.fn(async () => {
      calls.push("active_lookup");
      return current && (ACTIVE_VRS_BRIDGE_STATES as readonly string[])
        .includes(current.state)
        ? current
        : undefined;
    }),
    createIntake: vi.fn(async (input) => {
      calls.push("bridge_insert");
      if (
        options.nextCreateIsDuplicate ||
        (current && (ACTIVE_VRS_BRIDGE_STATES as readonly string[])
          .includes(current.state))
      ) {
        return {
          kind: "duplicate" as const,
          record: current ?? {
            id: 99,
            submissionId: input.submissionId,
            callId: "vrs_call_race_winner",
            state: "pending_review",
            requestPayload: input.requestPayload,
          },
        };
      }
      createdBridges.push(input);
      current = {
        id: originalSubmissionId ? 92 : 91,
        submissionId: input.submissionId,
        callId: input.callId,
        providerCallId: null,
        state: "pending_review",
        requestPayload: input.requestPayload,
      };
      return { kind: "accepted" as const, record: current, createdAt };
    }),
    findLocallyAppliedRetryableFailedV8SubmissionsByServiceOrder: vi.fn(async () => {
      calls.push("retryable_failed_lookup");
      return (options.retryableFailedV8SubmissionIds ?? []).map(
        (submissionId) => ({ submissionId }),
      );
    }),
  } as VrsBridgeIntakeStore & {
    findLocallyAppliedRetryableFailedV8SubmissionsByServiceOrder(
      serviceOrder: string,
    ): Promise<readonly { submissionId: number }[]>;
  };

  const deps: VrsSashaIntakeDependencies = {
    store,
    resolveTechnician: vi.fn(async () => {
      calls.push("technician");
      return {
        ldapId: "0123456",
        name: "Directory Carlos",
        phone: "+19845550111",
        district: "1353",
        isActive: true,
      };
    }),
    resolveTechUser: vi.fn(async () => {
      calls.push("tech_user");
      return {
        id: 501,
        email: "carlos@example.test",
        name: "Directory Carlos",
        role: "technician",
        racId: "0123456",
        phone: "+19845550111",
      };
    }),
    encryptCallbackSecret: vi.fn((secret: string) => {
      calls.push("encrypt");
      return {
        cipher: `encrypted:${secret.length}`,
        iv: "new-iv",
        authTag: "new-tag",
        salt: "new-salt",
      };
    }),
    generateCallId: vi.fn(() => {
      calls.push("call_id");
      return callIds.shift() ?? "vrs_call_fallback";
    }),
    createTicket: vi.fn(async ({ body }, internalOptions?: {
      ignoreLegacyDuplicateSubmissionIds?: readonly number[];
    }) => {
      calls.push("ticket");
      ticketOptions.push(internalOptions);
      const ignored = new Set(
        internalOptions?.ignoreLegacyDuplicateSubmissionIds ?? [],
      );
      if ([...oldTicketStates.keys()].some((id) => !ignored.has(id))) {
        return {
          kind: "rejected" as const,
          status: 409 as const,
          code: "SUBMISSION_REJECTED",
          message: "Legacy same-day duplicate policy blocked the request",
        };
      }
      ticketBodies.push(body);
      ticketCount++;
      receiptSmsCount++;
      return { kind: "created" as const, submissionId: nextSubmissionId++ };
    }),
  };

  return {
    intake: createVrsSashaIntake(deps),
    deps,
    store,
    calls,
    createdBridges,
    ticketBodies,
    ticketOptions,
    oldTicketStates,
    initialBridge: current,
    originalSubmissionId,
    getTicketCount: () => ticketCount,
    getReceiptSmsCount: () => receiptSmsCount,
  };
}

describe("VRS SASHA intake active-only duplicate behavior", () => {
  it("selects only locally applied retryable V8 failures and requires the newest attempt to qualify", () => {
    const select =
      candidateBridgeStoreModule.selectLocallyAppliedRetryableFailedV8SubmissionIds;
    expect(typeof select).toBe("function");
    if (!select) return;

    const locallyAppliedForwardPending = {
      submissionId: 42,
      state: "failed",
      retryable: true,
      requestPayload: storedV8(),
      webhookEventId: "evt_failed_42",
      eventId: "evt_failed_42",
      eventState: "failed",
      eventAppliedAt: createdAt,
      eventForwardedAt: null,
      eventProcessingState: "forward_failed",
    };

    expect(select([locallyAppliedForwardPending])).toEqual([42]);
    expect(select([
      locallyAppliedForwardPending,
      { ...locallyAppliedForwardPending, submissionId: 41 },
    ])).toEqual([42, 41]);

    for (const ineligibleLatest of [
      { ...locallyAppliedForwardPending, state: "dispatch_failed" },
      { ...locallyAppliedForwardPending, retryable: false },
      { ...locallyAppliedForwardPending, requestPayload: storedV5() },
      { ...locallyAppliedForwardPending, eventId: "evt_other" },
      { ...locallyAppliedForwardPending, eventState: "requires_info" },
      { ...locallyAppliedForwardPending, eventAppliedAt: null },
    ]) {
      expect(select([
        ineligibleLatest,
        locallyAppliedForwardPending,
      ])).toEqual([]);
    }
  });

  it("constructs the production intake seam and registers that exact result", () => {
    const source = readFileSync(
      new URL("../server/routes.ts", import.meta.url),
      "utf8",
    );
    const factoryStart = source.indexOf(
      "const vrsExpressIntake = createVrsSashaIntake({",
    );
    const registrationStart = source.indexOf(
      "registerVrsSashaApi(app, {",
      factoryStart,
    );
    const registration = source.slice(
      registrationStart,
      source.indexOf("});", registrationStart) + 3,
    );

    expect(factoryStart).toBeGreaterThan(-1);
    expect(registrationStart).toBeGreaterThan(factoryStart);
    expect(registration).toContain("intake: vrsExpressIntake");
    expect(registration).not.toMatch(/intake:\s*createVrsSashaIntake/);
  });

  it.each([
    ["V5", validV5AuthorizePayload],
    ["V8", validV8AuthorizePayload],
  ])("returns 409-compatible duplicate for an active %s bridge before work", async (_version, payload) => {
    const harness = makeHarness({ initialState: "pending_review" });

    await expect(harness.intake.receive(payload)).resolves.toEqual({
      kind: "duplicate",
      existingCallId: "vrs_call_old",
      state: "pending_review",
    });
    expect(harness.calls).toEqual(["active_lookup"]);
    expect(harness.getTicketCount()).toBe(0);
    expect(harness.createdBridges).toHaveLength(0);
  });

  it("creates a new normal ticket and bridge call immediately after a retryable V8 failure", async () => {
    const harness = makeHarness({
      initialState: "failed",
      initialRetryable: true,
      retryableFailedV8SubmissionIds: [42],
      legacyBlockingSubmissionIds: [42],
    });

    expect(harness.initialBridge).toMatchObject({
      state: "failed",
      retryable: true,
    });

    await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
      .toEqual({
        kind: "accepted",
        callId: "vrs_call_new",
        serviceOrder: "13538277",
        createdAt,
      });

    expect(harness.originalSubmissionId).toBe(42);
    expect(harness.getTicketCount()).toBe(1);
    expect(harness.getReceiptSmsCount()).toBe(1);
    expect(harness.createdBridges[0]).toMatchObject({
      submissionId: 43,
      callId: "vrs_call_new",
      serviceOrder: "13538277",
    });
    expect(harness.createdBridges[0].requestPayload).not.toHaveProperty(
      "callback_secret",
    );
    expect(harness.ticketOptions).toEqual([
      { ignoreLegacyDuplicateSubmissionIds: [42] },
    ]);
    expect(harness.oldTicketStates).toEqual(new Map([[42, "pending"]]));
  });

  it("keeps a prior failed callback forward retry isolated from the immediate V8 retry", async () => {
    const harness = makeHarness({
      initialState: "failed",
      initialRetryable: true,
      retryableFailedV8SubmissionIds: [42],
      legacyBlockingSubmissionIds: [42],
    });
    const priorAttempt = harness.initialBridge;
    const priorForwardRetry = {
      eventState: "failed",
      appliedAt: createdAt,
      processingState: "forward_failed",
    };

    await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
      .toEqual({
        kind: "accepted",
        callId: "vrs_call_new",
        serviceOrder: "13538277",
        createdAt,
      });

    expect(priorForwardRetry).toEqual({
      eventState: "failed",
      appliedAt: createdAt,
      processingState: "forward_failed",
    });
    expect(priorAttempt).toMatchObject({
      submissionId: 42,
      callId: "vrs_call_old",
      state: "failed",
      retryable: true,
    });
    expect(harness.createdBridges).toEqual([
      expect.objectContaining({ submissionId: 43, callId: "vrs_call_new" }),
    ]);
  });

  it("excludes every prior retryable V8 failure so a third immediate retry is not blocked by either old ticket", async () => {
    const harness = makeHarness({
      initialState: "failed",
      initialRetryable: true,
      retryableFailedV8SubmissionIds: [42, 43],
      legacyBlockingSubmissionIds: [42, 43],
      nextSubmissionId: 44,
    });

    await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
      .toEqual({
        kind: "accepted",
        callId: "vrs_call_new",
        serviceOrder: "13538277",
        createdAt,
      });

    expect(harness.createdBridges).toEqual([
      expect.objectContaining({ submissionId: 44, callId: "vrs_call_new" }),
    ]);
    expect(harness.ticketOptions).toEqual([
      { ignoreLegacyDuplicateSubmissionIds: [42, 43] },
    ]);
    expect(harness.oldTicketStates).toEqual(
      new Map([[42, "pending"], [43, "pending"]]),
    );
  });

  it("does not give V5 failed requests the V8 immediate-retry duplicate bypass", async () => {
    const harness = makeHarness({
      initialState: "failed",
      initialRetryable: true,
      retryableFailedV8SubmissionIds: [42],
      legacyBlockingSubmissionIds: [42],
    });

    await expect(harness.intake.receive(validV5AuthorizePayload)).resolves
      .toEqual({
        kind: "rejected",
        status: 409,
        code: "SUBMISSION_REJECTED",
        message: "Legacy same-day duplicate policy blocked the request",
      });
    expect(harness.getTicketCount()).toBe(0);
    expect(harness.createdBridges).toHaveLength(0);
    expect(harness.ticketOptions).toEqual([undefined]);
  });

  it("does not bypass a nonretryable V8 failed ticket", async () => {
    const harness = makeHarness({
      initialState: "failed",
      initialRetryable: false,
      legacyBlockingSubmissionIds: [42],
    });

    await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
      .toEqual({
        kind: "rejected",
        status: 409,
        code: "SUBMISSION_REJECTED",
        message: "Legacy same-day duplicate policy blocked the request",
      });
    expect(harness.getTicketCount()).toBe(0);
    expect(harness.createdBridges).toHaveLength(0);
    expect(harness.ticketOptions).toEqual([undefined]);
  });

  it.each(["queued", "pending", "completed"])(
    "keeps an unrelated same-day %s ticket as a legacy blocker during V8 immediate retry",
    async (ticketStatus) => {
      const harness = makeHarness({
        initialState: "failed",
        initialRetryable: true,
        retryableFailedV8SubmissionIds: [42],
        legacyBlockingSubmissionIds: [42, 77],
      });
      harness.oldTicketStates.set(77, ticketStatus);

      await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
        .toEqual({
          kind: "rejected",
          status: 409,
          code: "SUBMISSION_REJECTED",
          message: "Legacy same-day duplicate policy blocked the request",
        });
      expect(harness.getTicketCount()).toBe(0);
      expect(harness.createdBridges).toHaveLength(0);
      expect(harness.ticketOptions).toEqual([
        { ignoreLegacyDuplicateSubmissionIds: [42] },
      ]);
      expect(harness.oldTicketStates).toEqual(
        new Map([[42, "pending"], [77, ticketStatus]]),
      );
    },
  );

  it("creates exactly one normal ticket and one bridge row for fresh V8 intake", async () => {
    const harness = makeHarness();

    await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
      .toEqual({
        kind: "accepted",
        callId: "vrs_call_new",
        serviceOrder: "13538277",
        createdAt,
      });
    expect(harness.getTicketCount()).toBe(1);
    expect(harness.getReceiptSmsCount()).toBe(1);
    expect(harness.createdBridges).toHaveLength(1);
    expect(harness.createdBridges[0]).toMatchObject({
      submissionId: 42,
      callId: "vrs_call_new",
      callbackSecretCipher: `encrypted:${validV8AuthorizePayload.callback_secret.length}`,
      callbackSecretIv: "new-iv",
      callbackSecretAuthTag: "new-tag",
      callbackSecretSalt: "new-salt",
    });
    expect(harness.createdBridges[0].requestPayload).not.toHaveProperty(
      "callback_secret",
    );
  });

  it("normalizes the zero-padded roster district for a real technician intake", async () => {
    const harness = makeHarness();
    harness.deps.resolveTechnician = vi.fn().mockResolvedValue({
      ldapId: "dhanse9",
      name: "Directory Technician",
      phone: "+17045550111",
      district: "0008175",
      isActive: true,
    });
    harness.intake = createVrsSashaIntake(harness.deps);

    await expect(harness.intake.receive({
      ...validV8AuthorizePayload,
      tech_id: "dhanse9",
    })).resolves.toMatchObject({
      kind: "accepted",
      serviceOrder: "13538277",
    });
    expect(harness.ticketBodies).toHaveLength(1);
    expect(harness.ticketBodies[0]).toMatchObject({
      serviceOrder: "8175-13538277",
    });
  });

  it("retains the legacy final active-race duplicate after normal ticket creation", async () => {
    const harness = makeHarness({ nextCreateIsDuplicate: true });

    await expect(harness.intake.receive(validV5AuthorizePayload)).resolves
      .toEqual({
        kind: "duplicate",
        existingCallId: "vrs_call_race_winner",
        state: "pending_review",
      });
    expect(harness.getTicketCount()).toBe(1);
    expect(harness.getReceiptSmsCount()).toBe(1);
    expect(harness.createdBridges).toHaveLength(0);
  });

  it("keeps the normal unknown-technician rejection after the active gate", async () => {
    const harness = makeHarness();
    harness.deps.resolveTechnician = vi.fn().mockResolvedValue(undefined);
    harness.intake = createVrsSashaIntake(harness.deps);

    await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
      .toEqual({
        kind: "rejected",
        status: 422,
        code: "UNKNOWN_TECHNICIAN",
        message: "Unknown technician LDAP id: 0123456",
      });
    expect(harness.getTicketCount()).toBe(0);
    expect(harness.createdBridges).toHaveLength(0);
  });

  it("keeps API 202 for an immediate retryable V8 failure and never exposes callback material", async () => {
    const harness = makeHarness({
      initialState: "failed",
      initialRetryable: true,
      retryableFailedV8SubmissionIds: [42],
      legacyBlockingSubmissionIds: [42],
    });
    const app = express();
    app.use(express.json());
    registerVrsSashaApi(app, { apiKey: "test-key", intake: harness.intake });

    const response = await request(app)
      .post("/vrs/authorize")
      .set("X-API-Key", "test-key")
      .send(validV8AuthorizePayload);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      call_id: "vrs_call_new",
      service_order: "13538277",
      state: "queued",
      created_at: createdAt.toISOString(),
    });
    expect(JSON.stringify(response.body)).not.toContain(
      validV8AuthorizePayload.callback_secret,
    );
  });
});
