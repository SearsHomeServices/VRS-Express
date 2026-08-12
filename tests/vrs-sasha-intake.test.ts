import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  createVrsSashaIntake,
  type VrsSashaIntakeDependencies,
} from "../server/vrs-sasha-intake";
import {
  V8_RETRY_REARM_EVENT_KIND,
  decideLockedVrsBridgeIntake,
  isCurrentVrsWebhookProvider,
  type VrsBridgeIntakeDecisionInput,
  type VrsBridgeIntakeDecisionStore,
  type VrsLockedBridgeAttempt,
  type VrsLockedSubmission,
  type VrsRearmTerminalEvent,
} from "../server/vrs-sasha-store";
import {
  dispatchVrsAiForSubmission,
  processVrsAiWebhookEvent,
} from "../server/vrs-sasha-queue";
import { registerVrsSashaApi } from "../server/vrs-sasha-api";
import {
  validV5AuthorizePayload,
  validV8AuthorizePayload,
} from "./fixtures/vrs-authorize-payloads";

const oldCreatedAt = new Date("2026-08-10T12:00:00.000Z");
const rearmedAt = new Date("2026-08-11T21:15:00.000Z");

function storedV8() {
  const { callback_secret: _secret, ...payload } = validV8AuthorizePayload;
  return payload;
}

function makeAttempt(
  overrides: Partial<VrsLockedBridgeAttempt> = {},
): VrsLockedBridgeAttempt {
  return {
    id: 91,
    submissionId: 42,
    callId: "vrs_call_old",
    providerCallId: "vrs_ai_old",
    serviceOrder: "13538277",
    techId: "0123456",
    state: "failed",
    requestPayload: storedV8(),
    retryable: true,
    ctaNo: "CTA-OLD",
    authNumber: "AUTH-OLD",
    authorizedAmount: "300.00",
    requestedAmount: "400.00",
    denyReason: "old denial",
    failureReason: "provider timeout",
    durationSec: 83,
    recordingUrl: "https://recordings.example.test/old",
    webhookEventId: "evt_old_failed",
    webhookAttemptCount: 3,
    webhookLastStatus: 200,
    webhookLastAttemptAt: new Date("2026-08-10T12:08:00.000Z"),
    webhookDeliveredAt: new Date("2026-08-10T12:08:01.000Z"),
    dispatchError: "stale dispatch error",
    dispatchAttemptedAt: new Date("2026-08-10T12:01:00.000Z"),
    dispatchedAt: new Date("2026-08-10T12:02:00.000Z"),
    completedAt: new Date("2026-08-10T12:07:00.000Z"),
    createdAt: oldCreatedAt,
    ...overrides,
  };
}

function makeSubmission(
  overrides: Partial<VrsLockedSubmission> = {},
): VrsLockedSubmission {
  return {
    id: 42,
    ticketStatus: "pending",
    stage1Status: "approved",
    submissionApproved: true,
    assignedTo: 77,
    stage1ReviewedBy: 77,
    stage1ReviewedAt: new Date("2026-08-10T12:01:30.000Z"),
    stage1RejectionReason: null,
    createdAt: oldCreatedAt,
    ...overrides,
  };
}

function makeTerminalEvent(
  overrides: Partial<VrsRearmTerminalEvent> = {},
): VrsRearmTerminalEvent {
  return {
    eventId: "evt_old_failed",
    state: "failed",
    payload: {
      version: 1,
      eventId: "evt_old_failed",
      callId: "vrs_ai_old",
      soNo: "13538277",
      occurredAt: "2026-08-10T12:07:00.000Z",
      state: "failed",
      reason: "provider timeout",
      retryable: true,
    },
    processingState: "completed",
    appliedAt: new Date("2026-08-10T12:07:01.000Z"),
    forwardedAt: new Date("2026-08-10T12:08:01.000Z"),
    deliveryAttempts: 3,
    deliveryStatus: 200,
    ...overrides,
  };
}

function makeDecisionInput(
  overrides: Partial<VrsBridgeIntakeDecisionInput> = {},
): VrsBridgeIntakeDecisionInput {
  return {
    callId: "vrs_call_new",
    serviceOrder: "13538277",
    techId: "0123456",
    techPhone: "+12145550199",
    techName: "Carlos Rivera",
    requestPayload: storedV8(),
    callbackUrl:
      "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
    callbackSecretCipher: "new-cipher",
    callbackSecretIv: "new-iv",
    callbackSecretAuthTag: "new-tag",
    callbackSecretSalt: "new-salt",
    submissionProjection: {
      applianceType: "laundry",
      issueDescription: "New drain symptom",
      estimateAmount: "512.34",
      partNumbers: '["NEW-PART"]',
      phone: "+19845550111",
    },
    ...overrides,
  };
}

function makeLockedStore(options: {
  attempt?: VrsLockedBridgeAttempt;
  submission?: VrsLockedSubmission;
  terminalEvent?: VrsRearmTerminalEvent;
  blockingWebhookEvents?: boolean;
} = {}) {
  let attempt = options.attempt;
  let submission = options.submission;
  let terminalEvent = options.terminalEvent;
  const snapshots: Array<Record<string, unknown>> = [];
  const callUpdates: Array<Record<string, unknown>> = [];
  const submissionUpdates: Array<Record<string, unknown>> = [];
  const freshRows: Array<Record<string, unknown>> = [];
  let lock = Promise.resolve();

  const runExclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = lock;
    let release!: () => void;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  const store: VrsBridgeIntakeDecisionStore = {
    findActiveByServiceOrder: async () =>
      attempt && [
        "pending_review",
        "dispatching",
        "dispatch_failed",
        "queued",
        "dialing",
        "connected",
        "awaiting_decision",
        "requires_info",
        "in_progress",
      ].includes(attempt.state)
        ? {
            id: attempt.id,
            submissionId: attempt.submissionId!,
            callId: attempt.callId,
            providerCallId: attempt.providerCallId,
            state: attempt.state,
            requestPayload: attempt.requestPayload,
          }
        : undefined,
    decideExistingOrRearm: (input) =>
      runExclusive(() =>
        decideLockedVrsBridgeIntake({
          input,
          now: () => rearmedAt,
          loadLatestAttempt: async () => attempt,
          loadLinkedSubmission: async () => submission,
          loadTerminalEvent: async () => terminalEvent,
          hasBlockingWebhookEvents: async () =>
            options.blockingWebhookEvents ?? false,
          insertRearmSnapshot: async (_attemptId, snapshot) => {
            snapshots.push(snapshot);
          },
          updateAttempt: async (_id, update) => {
            callUpdates.push(update);
            attempt = {
              ...attempt!,
              ...update,
            } as VrsLockedBridgeAttempt;
          },
          updateSubmission: async (_id, update) => {
            submissionUpdates.push(update);
            submission = {
              ...submission!,
              ...update,
            } as VrsLockedSubmission;
          },
        }),
      ),
    createIntake: (freshInput) =>
      runExclusive(async () => {
        if (
          attempt &&
          [
            "pending_review",
            "dispatching",
            "dispatch_failed",
            "queued",
            "dialing",
            "connected",
            "awaiting_decision",
            "requires_info",
            "in_progress",
          ].includes(attempt.state)
        ) {
          return {
            kind: "duplicate" as const,
            record: {
              id: attempt.id,
              submissionId: attempt.submissionId!,
              callId: attempt.callId,
              providerCallId: attempt.providerCallId,
              state: attempt.state,
              requestPayload: attempt.requestPayload,
            },
          };
        }
        const submissionId = freshInput.submissionId;
            const row = {
              ...freshInput,
              id: 91,
              submissionId,
              state: "pending_review",
              providerCallId: null,
              createdAt: rearmedAt,
            };
            freshRows.push(row);
            attempt = row as VrsLockedBridgeAttempt;
            return {
              kind: "accepted" as const,
              record: {
                id: 91,
                submissionId,
                callId: freshInput.callId,
                state: "pending_review",
                requestPayload: freshInput.requestPayload,
              },
              createdAt: rearmedAt,
            };
      }),
  };

  return {
    store,
    snapshots,
    callUpdates,
    submissionUpdates,
    freshRows,
    getAttempt: () => attempt,
    getSubmission: () => submission,
  };
}

function makeIntakeHarness(options: {
  attempt?: VrsLockedBridgeAttempt;
  submission?: VrsLockedSubmission;
  terminalEvent?: VrsRearmTerminalEvent;
  blockingWebhookEvents?: boolean;
  callIds?: string[];
} = {}) {
  const locked = makeLockedStore(options);
  let ticketCount = 0;
  let submissionSmsCount = 0;
  const rearmNotifications: unknown[] = [];
  const versionBumps: number[] = [];
  const callIds = [...(options.callIds ?? ["vrs_call_new"] )];
  const deps: VrsSashaIntakeDependencies = {
    store: locked.store,
    resolveTechnician: vi.fn().mockResolvedValue({
      ldapId: "0123456",
      name: "Directory Carlos",
      phone: "+19845550111",
      district: "1353",
      isActive: true,
    }),
    resolveTechUser: vi.fn().mockResolvedValue({
      id: 501,
      email: "carlos@example.test",
      name: "Directory Carlos",
      role: "technician",
      racId: "0123456",
      phone: "+19845550111",
    }),
    encryptCallbackSecret: vi.fn().mockImplementation((secret: string) => ({
      cipher: `encrypted:${secret.length}`,
      iv: "new-iv",
      authTag: "new-tag",
      salt: "new-salt",
    })),
    generateCallId: vi.fn(() => callIds.shift() ?? "vrs_call_fallback"),
    createTicket: vi.fn().mockImplementation(async () => {
      ticketCount++;
      submissionSmsCount++;
      return { kind: "created" as const, submissionId: 42 };
    }),
    bumpSubmissionsDataVersion: vi.fn(() => {
      versionBumps.push(1);
    }),
    notifyRearmed: vi.fn(async (notification) => {
      rearmNotifications.push(notification);
    }),
    logPostCommitError: vi.fn(),
  };
  return {
    ...locked,
    deps,
    intake: createVrsSashaIntake(deps),
    getTicketCount: () => ticketCount,
    getSubmissionSmsCount: () => submissionSmsCount,
    rearmNotifications,
    versionBumps,
  };
}

describe("VRS SASHA intake and V8 retry rearm", () => {
  it.each([
    ["V5", validV5AuthorizePayload],
    ["V8", validV8AuthorizePayload],
  ])("returns the current duplicate for an active %s attempt before ticket creation", async (_version, payload) => {
    const harness = makeIntakeHarness({
      attempt: makeAttempt({ state: "pending_review", callId: "vrs_call_active" }),
      submission: makeSubmission(),
      terminalEvent: makeTerminalEvent(),
    });

    await expect(harness.intake.receive(payload)).resolves.toEqual({
      kind: "duplicate",
      existingCallId: "vrs_call_active",
      state: "pending_review",
    });
    expect(harness.getTicketCount()).toBe(0);
    expect(harness.snapshots).toHaveLength(0);
    expect(harness.deps.resolveTechnician).not.toHaveBeenCalled();
    expect(harness.deps.resolveTechUser).not.toHaveBeenCalled();
    expect(harness.deps.encryptCallbackSecret).not.toHaveBeenCalled();
    expect(harness.deps.generateCallId).not.toHaveBeenCalled();
    expect(harness.deps.createTicket).not.toHaveBeenCalled();
  });

  it.each([
    ["incoming V5", storedV8(), validV5AuthorizePayload],
    [
      "stored V5",
      (() => {
        const { callback_secret: _secret, ...payload } =
          validV5AuthorizePayload;
        return payload;
      })(),
      validV8AuthorizePayload,
    ],
  ])("keeps %s duplicate-only at a terminal attempt", async (_label, priorPayload, incomingPayload) => {
    const harness = makeIntakeHarness({
      attempt: makeAttempt({ requestPayload: priorPayload }),
      submission: makeSubmission(),
      terminalEvent: makeTerminalEvent(),
    });

    const result = await harness.intake.receive(incomingPayload);

    expect(result).toMatchObject({
      kind: "duplicate",
      existingCallId: "vrs_call_old",
    });
    expect(harness.getTicketCount()).toBe(0);
    expect(harness.callUpdates).toHaveLength(0);
  });

  it("blocks rearm while any other callback event is in progress or unforwarded", async () => {
    const harness = makeIntakeHarness({
      attempt: makeAttempt(),
      submission: makeSubmission(),
      terminalEvent: makeTerminalEvent(),
      blockingWebhookEvents: true,
    });

    await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
      .toMatchObject({ kind: "duplicate" });
    expect(harness.snapshots).toHaveLength(0);
    expect(harness.callUpdates).toHaveLength(0);
  });

  it("creates exactly one normal ticket and one bridge row for fresh intake", async () => {
    const harness = makeIntakeHarness({});

    const result = await harness.intake.receive(validV8AuthorizePayload);

    expect(result).toEqual({
      kind: "accepted",
      callId: "vrs_call_new",
      serviceOrder: "13538277",
      createdAt: rearmedAt,
    });
    expect(harness.getTicketCount()).toBe(1);
    expect(harness.getSubmissionSmsCount()).toBe(1);
    expect(harness.freshRows).toHaveLength(1);
    expect(harness.freshRows[0]).not.toHaveProperty("callback_secret");
    expect(harness.freshRows[0].requestPayload).not.toHaveProperty(
      "callback_secret",
    );
  });

  it("commits the existing/rearm decision before fresh ticket creation and final bridge insert", async () => {
    const harness = makeIntakeHarness({});
    const order: string[] = [];
    harness.deps.store = {
      findActiveByServiceOrder: vi.fn().mockResolvedValue(undefined),
      decideExistingOrRearm: vi.fn(async () => {
        order.push("decision_committed");
        return { kind: "none" as const };
      }),
      createIntake: vi.fn(async (input) => {
        order.push("bridge_inserted");
        return {
          kind: "accepted" as const,
          record: {
            id: 91,
            submissionId: input.submissionId,
            callId: input.callId,
            state: "pending_review",
            requestPayload: input.requestPayload,
          },
          createdAt: rearmedAt,
        };
      }),
    } as any;
    harness.deps.createTicket = vi.fn(async () => {
      order.push("ticket_created");
      return { kind: "created" as const, submissionId: 42 };
    });
    harness.intake = createVrsSashaIntake(harness.deps);

    await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
      .toMatchObject({ kind: "accepted", callId: "vrs_call_new" });
    expect(order).toEqual([
      "decision_committed",
      "ticket_created",
      "bridge_inserted",
    ]);
  });

  it("rearms an eligible V8 attempt with the same row and ticket, complete resets, immutable snapshot, and no receipt SMS", async () => {
    const harness = makeIntakeHarness({
      attempt: makeAttempt(),
      submission: makeSubmission(),
      terminalEvent: makeTerminalEvent(),
    });
    const replacement = {
      ...validV8AuthorizePayload,
      tech_phone: "N/A" as const,
      symptom: "New drain symptom",
      repair_replace_rationale: "",
      parts: [{
        ...validV8AuthorizePayload.parts[0],
        part_id: "NEW-PART",
        sell_price: 377.34,
      }],
      labor_amount: 120,
      tax_amount: 15,
      part_price: 377.34,
      callback_secret: "replacement-secret-with-at-least-32-characters",
    };

    const result = await harness.intake.receive(replacement);

    expect(result).toEqual({
      kind: "accepted",
      callId: "vrs_call_new",
      serviceOrder: "13538277",
      createdAt: rearmedAt,
    });
    expect(harness.getTicketCount()).toBe(0);
    expect(harness.getSubmissionSmsCount()).toBe(0);
    expect(harness.freshRows).toHaveLength(0);
    expect(harness.snapshots).toHaveLength(1);
    expect(harness.snapshots[0]).toMatchObject({
      kind: V8_RETRY_REARM_EVENT_KIND,
      service_order: "13538277",
      prior_public_call_id: "vrs_call_old",
      prior_provider_call_id: "vrs_ai_old",
      prior_state: "failed",
      prior_result: {
        failure_reason: "provider timeout",
        retryable: true,
        recording_url: "https://recordings.example.test/old",
      },
      prior_delivery: {
        webhook_event_id: "evt_old_failed",
        delivered_at: "2026-08-10T12:08:01.000Z",
        terminal_event_processing_state: "completed",
        terminal_event_forwarded_at: "2026-08-10T12:08:01.000Z",
      },
      prior_stage1: {
        status: "approved",
        reviewed_by: 77,
        reviewed_at: "2026-08-10T12:01:30.000Z",
      },
      replacement_public_call_id: "vrs_call_new",
      rearmed_at: rearmedAt.toISOString(),
    });
    expect(harness.callUpdates).toEqual([expect.objectContaining({
      callId: "vrs_call_new",
      providerCallId: null,
      state: "pending_review",
      callbackSecretCipher: `encrypted:${replacement.callback_secret.length}`,
      callbackSecretIv: "new-iv",
      callbackSecretAuthTag: "new-tag",
      callbackSecretSalt: "new-salt",
      dispatchError: null,
      dispatchAttemptedAt: null,
      dispatchedAt: null,
      ctaNo: null,
      authNumber: null,
      authorizedAmount: null,
      requestedAmount: null,
      denyReason: null,
      failureReason: null,
      retryable: null,
      durationSec: null,
      recordingUrl: null,
      webhookEventId: null,
      webhookAttemptCount: 0,
      webhookLastStatus: null,
      webhookLastAttemptAt: null,
      webhookDeliveredAt: null,
      completedAt: null,
      updatedAt: rearmedAt,
    })]);
    expect(harness.callUpdates[0].requestPayload).not.toHaveProperty(
      "callback_secret",
    );
    expect(harness.getAttempt()).toMatchObject({
      id: 91,
      submissionId: 42,
      createdAt: oldCreatedAt,
      callId: "vrs_call_new",
    });
    expect(harness.submissionUpdates).toEqual([expect.objectContaining({
      ticketStatus: "queued",
      assignedTo: null,
      claimedAt: null,
      submissionApproved: false,
      submissionApprovedAt: null,
      stage1Status: "pending",
      stage1ReviewedBy: null,
      stage1ReviewedAt: null,
      stage1RejectionReason: null,
      reviewedBy: null,
      reviewedAt: null,
      agentNotes: null,
      technicianMessage: null,
      stage2Status: "pending",
      stage2ReviewedBy: null,
      stage2ReviewedAt: null,
      stage2Outcome: null,
      authCode: null,
      rgcCode: null,
      invalidReason: null,
      invalidInstructions: null,
      declineReason: null,
      declineInstructions: null,
      rejectionReasons: null,
      rejectedMedia: null,
      applianceType: "laundry",
      issueDescription: "New drain symptom",
      estimateAmount: "512.34",
      partNumbers: '["NEW-PART"]',
      phone: "+19845550111",
      statusChangedAt: rearmedAt,
      updatedAt: rearmedAt,
    })]);
    expect(harness.getSubmission()).toMatchObject({
      id: 42,
      createdAt: oldCreatedAt,
      ticketStatus: "queued",
    });
    expect(harness.versionBumps).toHaveLength(1);
    expect(harness.rearmNotifications).toEqual([expect.objectContaining({
      submissionId: 42,
      previousAssignee: 77,
      applianceType: "laundry",
    })]);
  });

  it.each([
    ["dispatch_failed", true],
    ["pending_review", true],
    ["approved", true],
    ["partial", true],
    ["denied", true],
    ["failed", false],
  ])("does not intake-rearm prior state %s with retryable=%s", async (state, retryable) => {
    const harness = makeIntakeHarness({
      attempt: makeAttempt({ state, retryable }),
      submission: makeSubmission(),
      terminalEvent: makeTerminalEvent(),
    });

    const result = await harness.intake.receive(validV8AuthorizePayload);

    expect(result).toMatchObject({ kind: "duplicate" });
    expect(harness.snapshots).toHaveLength(0);
    expect(harness.callUpdates).toHaveLength(0);
    expect(harness.getTicketCount()).toBe(0);
  });

  it.each([
    ["completed ticket", { ticketStatus: "completed" }],
    ["Stage 1 pending", { stage1Status: "pending" }],
    ["approval flag false", { submissionApproved: false }],
  ])("rejects rearm when the linked submission is inconsistent: %s", async (_label, patch) => {
    const harness = makeIntakeHarness({
      attempt: makeAttempt(),
      submission: makeSubmission(patch),
      terminalEvent: makeTerminalEvent(),
    });

    await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
      .toMatchObject({ kind: "duplicate" });
    expect(harness.callUpdates).toHaveLength(0);
  });

  it("rejects rearm when the technician differs from the original attempt", async () => {
    const harness = makeIntakeHarness({
      attempt: makeAttempt({ techId: "0765432" }),
      submission: makeSubmission(),
      terminalEvent: makeTerminalEvent(),
    });

    await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
      .toMatchObject({ kind: "duplicate" });
    expect(harness.snapshots).toHaveLength(0);
  });

  it.each([
    ["still applying", makeTerminalEvent({ processingState: "applied", forwardedAt: null })],
    ["forward failed", makeTerminalEvent({ processingState: "forward_failed", forwardedAt: null })],
    ["call delivery missing", makeTerminalEvent()],
  ])("rejects rearm while the prior terminal callback is not fully forwarded: %s", async (label, terminalEvent) => {
    const attempt = label === "call delivery missing"
      ? makeAttempt({ webhookDeliveredAt: null })
      : makeAttempt();
    const harness = makeIntakeHarness({
      attempt,
      submission: makeSubmission(),
      terminalEvent,
    });

    await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
      .toMatchObject({ kind: "duplicate" });
    expect(harness.callUpdates).toHaveLength(0);
  });

  it("serializes two rearm attempts into one winner, one duplicate, one snapshot, and one notification", async () => {
    const harness = makeIntakeHarness({
      attempt: makeAttempt(),
      submission: makeSubmission(),
      terminalEvent: makeTerminalEvent(),
      callIds: ["vrs_call_winner", "vrs_call_loser"],
    });

    const results = await Promise.all([
      harness.intake.receive(validV8AuthorizePayload),
      harness.intake.receive(validV8AuthorizePayload),
    ]);

    expect(results.filter((result) => result.kind === "accepted")).toEqual([
      expect.objectContaining({ callId: "vrs_call_winner" }),
    ]);
    expect(results.filter((result) => result.kind === "duplicate")).toEqual([
      expect.objectContaining({ existingCallId: "vrs_call_winner" }),
    ]);
    expect(harness.snapshots).toHaveLength(1);
    expect(harness.rearmNotifications).toHaveLength(1);
    expect(harness.getTicketCount()).toBe(0);
  });

  it("returns API 202 for the rearm winner and 409 with that new public id for the concurrent loser", async () => {
    const harness = makeIntakeHarness({
      attempt: makeAttempt(),
      submission: makeSubmission(),
      terminalEvent: makeTerminalEvent(),
      callIds: ["vrs_call_first", "vrs_call_second"],
    });
    const app = express();
    app.use(express.json());
    registerVrsSashaApi(app, {
      apiKey: "test-key",
      intake: harness.intake,
    });

    const responses = await Promise.all([
      request(app).post("/vrs/authorize").set("X-API-Key", "test-key")
        .send(validV8AuthorizePayload),
      request(app).post("/vrs/authorize").set("X-API-Key", "test-key")
        .send(validV8AuthorizePayload),
    ]);
    const accepted = responses.find((response) => response.status === 202)!;
    const duplicate = responses.find((response) => response.status === 409)!;

    expect(accepted.body).toMatchObject({
      service_order: "13538277",
      state: "queued",
      created_at: rearmedAt.toISOString(),
    });
    expect(duplicate.body).toEqual({
      error: "DUPLICATE_CALL",
      message:
        "A call is already in progress for service order 13538277",
      existing_call_id: accepted.body.call_id,
      state: "in_progress",
    });
    expect(accepted.body.call_id).toMatch(/^vrs_call_(first|second)$/);
    expect(JSON.stringify(responses.map((response) => response.body)))
      .not.toContain("vrs_ai_old");
    expect(JSON.stringify(responses.map((response) => response.body)))
      .not.toContain(validV8AuthorizePayload.callback_secret);
  });

  it("keeps committed rearm 202 semantics when post-commit notification fails", async () => {
    const harness = makeIntakeHarness({
      attempt: makeAttempt(),
      submission: makeSubmission(),
      terminalEvent: makeTerminalEvent(),
    });
    harness.deps.notifyRearmed = vi.fn().mockRejectedValue(
      new Error("websocket unavailable"),
    );
    harness.intake = createVrsSashaIntake(harness.deps);

    await expect(harness.intake.receive(validV8AuthorizePayload)).resolves
      .toMatchObject({ kind: "accepted", callId: "vrs_call_new" });
    expect(harness.deps.logPostCommitError).toHaveBeenCalledOnce();
  });

  it("keeps dispatch_failed as a Stage 1 resend using the same Express public call id", async () => {
    const store = {
      getBySubmissionId: vi.fn().mockResolvedValue({
        id: 91,
        submissionId: 42,
        callId: "vrs_call_same",
        providerCallId: null,
        state: "dispatch_failed",
        requestPayload: storedV8(),
      }),
      markDispatching: vi.fn().mockResolvedValue(true),
      markAccepted: vi.fn().mockResolvedValue(undefined),
      markDispatchFailed: vi.fn(),
    };

    const result = await dispatchVrsAiForSubmission({
      submissionId: 42,
      store,
      client: {
        authorize: vi.fn().mockResolvedValue({
          kind: "accepted",
          callId: "vrs_ai_resend",
          state: "queued",
          duplicate: false,
        }),
      },
      callbackUrl: "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
      callbackSecret: "bridge-secret",
    });

    expect(result).toMatchObject({
      kind: "accepted",
      providerCallId: "vrs_ai_resend",
    });
    expect(store.markAccepted).toHaveBeenCalledWith(91, "vrs_ai_resend", "queued");
    expect(store.getBySubmissionId.mock.results[0].value).toBeDefined();
  });
});

describe("superseded V8 callbacks", () => {
  const oldEvent = {
    version: 1 as const,
    eventId: "evt_late_old",
    callId: "vrs_ai_old",
    soNo: "13538277",
    occurredAt: "2026-08-11T21:20:00.000Z",
    state: "failed" as const,
    reason: "late retry",
    retryable: true,
  };

  it("acknowledges the exact superseded provider/SO pair before every callback side effect", async () => {
    const store = {
      getByProviderCallId: vi.fn().mockResolvedValue(undefined),
      hasSupersededProviderCall: vi.fn().mockResolvedValue(true),
      beginWebhookEvent: vi.fn(),
      markWebhookApplied: vi.fn(),
      markWebhookForwarded: vi.fn(),
      markWebhookFailed: vi.fn(),
    };
    const decryptCallbackSecret = vi.fn();
    const applyResult = vi.fn();
    const forward = vi.fn();

    await expect(processVrsAiWebhookEvent({
      event: oldEvent,
      store,
      decryptCallbackSecret,
      applyResult,
      forward,
    })).resolves.toBe("duplicate");

    expect(store.hasSupersededProviderCall).toHaveBeenCalledWith(
      "vrs_ai_old",
      "13538277",
    );
    expect(store.beginWebhookEvent).not.toHaveBeenCalled();
    expect(decryptCallbackSecret).not.toHaveBeenCalled();
    expect(applyResult).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
    expect(store.markWebhookApplied).not.toHaveBeenCalled();
    expect(store.markWebhookForwarded).not.toHaveBeenCalled();
    expect(store.markWebhookFailed).not.toHaveBeenCalled();
  });

  it("dedupes a callback that resolved the old row before rearm but begins after its provider id was cleared", async () => {
    let currentProviderCallId: string | null = "vrs_ai_old";
    const record = {
      id: 91,
      submissionId: 42,
      callId: "vrs_call_old",
      providerCallId: "vrs_ai_old",
      state: "failed",
      requestPayload: storedV8(),
    };
    const store = {
      getByProviderCallId: vi.fn(async () => {
        currentProviderCallId = null;
        return record;
      }),
      beginWebhookEvent: vi.fn(async (_id: number, event: typeof oldEvent) =>
        isCurrentVrsWebhookProvider(
          currentProviderCallId,
          event.callId,
        )
          ? { kind: "claimed" as const, alreadyApplied: false }
          : { kind: "duplicate" as const }),
      markWebhookApplied: vi.fn(),
      markWebhookForwarded: vi.fn(),
      markWebhookFailed: vi.fn(),
    };
    const applyResult = vi.fn();
    const forward = vi.fn();

    await expect(processVrsAiWebhookEvent({
      event: oldEvent,
      store,
      decryptCallbackSecret: vi.fn(),
      applyResult,
      forward,
    })).resolves.toBe("duplicate");
    expect(store.beginWebhookEvent).toHaveBeenCalledOnce();
    expect(applyResult).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong service order", { ...oldEvent, soNo: "99999999" }],
    ["unknown provider", { ...oldEvent, callId: "vrs_ai_unknown" }],
  ])("preserves an error for a %s callback", async (_label, event) => {
    const store = {
      getByProviderCallId: vi.fn().mockResolvedValue(undefined),
      hasSupersededProviderCall: vi.fn().mockResolvedValue(false),
    };

    await expect(processVrsAiWebhookEvent({
      event,
      store: store as any,
      decryptCallbackSecret: vi.fn(),
      applyResult: vi.fn(),
      forward: vi.fn(),
    })).rejects.toThrow("Unknown VRS AI call id");
  });

  it("leaves current callback processing and replay dedupe unchanged", async () => {
    const currentRecord = {
      id: 91,
      submissionId: 42,
      callId: "vrs_call_current",
      providerCallId: "vrs_ai_current",
      state: "queued",
      requestPayload: storedV8(),
      callbackUrl:
        "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
      callbackSecretCipher: "cipher",
      callbackSecretIv: "iv",
      callbackSecretAuthTag: "tag",
      callbackSecretSalt: "salt",
    };
    const event = { ...oldEvent, callId: "vrs_ai_current", eventId: "evt_current" };
    const store = {
      getByProviderCallId: vi.fn().mockResolvedValue(currentRecord),
      hasSupersededProviderCall: vi.fn(),
      beginWebhookEvent: vi.fn()
        .mockResolvedValueOnce({ kind: "claimed", alreadyApplied: false })
        .mockResolvedValueOnce({ kind: "duplicate" }),
      markWebhookApplied: vi.fn().mockResolvedValue(undefined),
      markWebhookForwarded: vi.fn().mockResolvedValue(undefined),
      markWebhookFailed: vi.fn(),
    };
    const applyResult = vi.fn().mockResolvedValue(undefined);
    const forward = vi.fn().mockResolvedValue({
      delivered: true,
      attempts: 1,
      status: 200,
    });

    await expect(processVrsAiWebhookEvent({
      event,
      store,
      decryptCallbackSecret: vi.fn().mockReturnValue("secret"),
      applyResult,
      forward,
    })).resolves.toBe("processed");
    await expect(processVrsAiWebhookEvent({
      event,
      store,
      decryptCallbackSecret: vi.fn(),
      applyResult,
      forward,
    })).resolves.toBe("duplicate");

    expect(store.hasSupersededProviderCall).not.toHaveBeenCalled();
    expect(applyResult).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledTimes(1);
  });
});
