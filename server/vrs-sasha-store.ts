import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { submissions, vrsAiCallEvents, vrsAiCalls } from "@shared/schema";
import { db } from "./storage";
import {
  projectVrsBridgeReviewContext,
  type VrsBridgeRecord,
  type VrsBridgeReviewContext,
  type VrsBridgeStore,
  type VrsStoredAuthorizeRequest,
} from "./vrs-sasha-queue";
import {
  getVrsAuthorizeContractVersion,
  type VrsWebhookEvent,
} from "./vrs-sasha-contract";

export const ACTIVE_VRS_BRIDGE_STATES = [
  "pending_review",
  "dispatching",
  "dispatch_failed",
  "queued",
  "dialing",
  "connected",
  "awaiting_decision",
  "requires_info",
  "in_progress",
] as const;

const TERMINAL_VRS_AI_STATES = [
  "approved",
  "partial",
  "denied",
  "failed",
] as const;

export interface NewVrsBridgeIntake {
  submissionId: number;
  callId: string;
  serviceOrder: string;
  techId: string;
  techPhone: string;
  techName: string;
  requestPayload: VrsStoredAuthorizeRequest;
  callbackUrl: string;
  callbackSecretCipher: string;
  callbackSecretIv: string;
  callbackSecretAuthTag: string;
  callbackSecretSalt: string;
}

export interface VrsAiBridgeStatus {
  callId: string;
  contractVersion: "v5" | "v8";
  state: string;
  providerCallId: string | null;
  dispatchError: string | null;
  failureReason: string | null;
  retryable: boolean | null;
  dispatchedAt: Date | null;
  reviewContext: VrsBridgeReviewContext;
}

export const V8_RETRY_REARM_EVENT_KIND = "v8_retry_rearm" as const;

export interface VrsBridgeSubmissionProjection {
  applianceType: string;
  issueDescription: string;
  estimateAmount: string;
  partNumbers: string;
  phone: string;
}

export interface VrsBridgeIntakeDecisionInput
  extends Omit<NewVrsBridgeIntake, "submissionId"> {
  submissionProjection: VrsBridgeSubmissionProjection;
}

export interface VrsLockedBridgeAttempt {
  id: number;
  submissionId: number | null;
  callId: string;
  providerCallId: string | null;
  serviceOrder: string;
  techId: string;
  state: string;
  requestPayload: VrsStoredAuthorizeRequest;
  retryable: boolean | null;
  ctaNo: string | null;
  authNumber: string | null;
  authorizedAmount: string | null;
  requestedAmount: string | null;
  denyReason: string | null;
  failureReason: string | null;
  durationSec: number | null;
  recordingUrl: string | null;
  webhookEventId: string | null;
  webhookAttemptCount: number;
  webhookLastStatus: number | null;
  webhookLastAttemptAt: Date | null;
  webhookDeliveredAt: Date | null;
  dispatchError: string | null;
  dispatchAttemptedAt: Date | null;
  dispatchedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface VrsLockedSubmission {
  id: number;
  ticketStatus: string;
  stage1Status: string;
  submissionApproved: boolean;
  assignedTo: number | null;
  reassignmentNotes: string | null;
  stage1ReviewedBy: number | null;
  stage1ReviewedAt: Date | null;
  stage1RejectionReason: string | null;
  createdAt: Date | null;
}

export interface VrsRearmTerminalEvent {
  eventId: string;
  state: string;
  payload: Record<string, unknown>;
  processingState: string;
  appliedAt: Date | null;
  forwardedAt: Date | null;
  deliveryAttempts: number;
  deliveryStatus: number | null;
}

export interface VrsRetryRearmSnapshot {
  kind: typeof V8_RETRY_REARM_EVENT_KIND;
  service_order: string;
  prior_public_call_id: string;
  prior_provider_call_id: string;
  prior_state: string;
  prior_result: {
    cta_no: string | null;
    auth_number: string | null;
    authorized_amount: string | null;
    requested_amount: string | null;
    deny_reason: string | null;
    failure_reason: string | null;
    retryable: boolean | null;
    duration_sec: number | null;
    recording_url: string | null;
    completed_at: string | null;
  };
  prior_delivery: {
    webhook_event_id: string | null;
    attempt_count: number;
    last_status: number | null;
    last_attempt_at: string | null;
    delivered_at: string | null;
    terminal_event_id: string;
    terminal_event_processing_state: string;
    terminal_event_applied_at: string | null;
    terminal_event_forwarded_at: string | null;
    terminal_event_delivery_attempts: number;
    terminal_event_delivery_status: number | null;
  };
  prior_stage1: {
    status: string;
    reviewed_by: number | null;
    reviewed_at: string | null;
    rejection_reason: string | null;
  };
  prior_assignment: {
    assigned_to: number | null;
    reassignment_notes: string | null;
  };
  replacement_public_call_id: string;
  rearmed_at: string;
}

export type VrsFreshSubmissionResult =
  | { kind: "created"; submissionId: number }
  | {
      kind: "rejected";
      status: 409 | 422;
      code: string;
      message: string;
    };

export type VrsBridgeIntakeDecision =
  | { kind: "none" }
  | {
      kind: "rearmed";
      record: Pick<VrsBridgeRecord, "id" | "submissionId" | "callId" | "state">;
      rearmedAt: Date;
      previousAssignee: number | null;
      submissionProjection: VrsBridgeSubmissionProjection;
    }
  | { kind: "duplicate"; record: VrsBridgeRecord };

export interface VrsBridgeIntakeDecisionStore {
  findActiveByServiceOrder(
    serviceOrder: string,
  ): Promise<VrsBridgeRecord | undefined>;
  decideExistingOrRearm(
    input: VrsBridgeIntakeDecisionInput,
  ): Promise<VrsBridgeIntakeDecision>;
  createIntake(input: NewVrsBridgeIntake): Promise<
    | { kind: "accepted"; record: VrsBridgeRecord; createdAt: Date }
    | { kind: "duplicate"; record: VrsBridgeRecord }
  >;
}

export interface LockedVrsBridgeIntakeOptions {
  input: VrsBridgeIntakeDecisionInput;
  now(): Date;
  loadLatestAttempt(): Promise<VrsLockedBridgeAttempt | undefined>;
  loadLinkedSubmission(
    submissionId: number,
  ): Promise<VrsLockedSubmission | undefined>;
  loadTerminalEvent(
    attempt: VrsLockedBridgeAttempt,
  ): Promise<VrsRearmTerminalEvent | undefined>;
  hasBlockingWebhookEvents(
    attempt: VrsLockedBridgeAttempt,
  ): Promise<boolean>;
  insertRearmSnapshot(
    attemptId: number,
    snapshot: VrsRetryRearmSnapshot,
  ): Promise<void>;
  updateAttempt(id: number, update: Record<string, unknown>): Promise<void>;
  updateSubmission(id: number, update: Record<string, unknown>): Promise<void>;
}

const toIso = (value: Date | null): string | null =>
  value ? value.toISOString() : null;

export function buildVrsRetryRearmSnapshot(options: {
  attempt: VrsLockedBridgeAttempt;
  submission: VrsLockedSubmission;
  terminalEvent: VrsRearmTerminalEvent;
  replacementCallId: string;
  rearmedAt: Date;
}): VrsRetryRearmSnapshot {
  const { attempt, submission, terminalEvent, replacementCallId, rearmedAt } =
    options;
  return {
    kind: V8_RETRY_REARM_EVENT_KIND,
    service_order: attempt.serviceOrder,
    prior_public_call_id: attempt.callId,
    prior_provider_call_id: attempt.providerCallId!,
    prior_state: attempt.state,
    prior_result: {
      cta_no: attempt.ctaNo,
      auth_number: attempt.authNumber,
      authorized_amount: attempt.authorizedAmount,
      requested_amount: attempt.requestedAmount,
      deny_reason: attempt.denyReason,
      failure_reason: attempt.failureReason,
      retryable: attempt.retryable,
      duration_sec: attempt.durationSec,
      recording_url: attempt.recordingUrl,
      completed_at: toIso(attempt.completedAt),
    },
    prior_delivery: {
      webhook_event_id: attempt.webhookEventId,
      attempt_count: attempt.webhookAttemptCount,
      last_status: attempt.webhookLastStatus,
      last_attempt_at: toIso(attempt.webhookLastAttemptAt),
      delivered_at: toIso(attempt.webhookDeliveredAt),
      terminal_event_id: terminalEvent.eventId,
      terminal_event_processing_state: terminalEvent.processingState,
      terminal_event_applied_at: toIso(terminalEvent.appliedAt),
      terminal_event_forwarded_at: toIso(terminalEvent.forwardedAt),
      terminal_event_delivery_attempts: terminalEvent.deliveryAttempts,
      terminal_event_delivery_status: terminalEvent.deliveryStatus,
    },
    prior_stage1: {
      status: submission.stage1Status,
      reviewed_by: submission.stage1ReviewedBy,
      reviewed_at: toIso(submission.stage1ReviewedAt),
      rejection_reason: submission.stage1RejectionReason,
    },
    prior_assignment: {
      assigned_to: submission.assignedTo,
      reassignment_notes: submission.reassignmentNotes,
    },
    replacement_public_call_id: replacementCallId,
    rearmed_at: rearmedAt.toISOString(),
  };
}

function isFullyForwardedTerminalFailure(
  attempt: VrsLockedBridgeAttempt,
  terminalEvent: VrsRearmTerminalEvent | undefined,
): terminalEvent is VrsRearmTerminalEvent {
  if (
    !terminalEvent ||
    !attempt.providerCallId ||
    !attempt.webhookDeliveredAt ||
    terminalEvent.state !== "failed" ||
    terminalEvent.processingState !== "completed" ||
    !terminalEvent.appliedAt ||
    !terminalEvent.forwardedAt
  ) {
    return false;
  }
  return terminalEvent.eventId === attempt.webhookEventId &&
    terminalEvent.payload.eventId === terminalEvent.eventId &&
    terminalEvent.payload.callId === attempt.providerCallId &&
    terminalEvent.payload.soNo === attempt.serviceOrder &&
    terminalEvent.payload.state === terminalEvent.state &&
    terminalEvent.payload.state === "failed" &&
    terminalEvent.payload.retryable === true;
}

function toDecisionRecord(attempt: VrsLockedBridgeAttempt): VrsBridgeRecord {
  return {
    id: attempt.id,
    submissionId: attempt.submissionId!,
    callId: attempt.callId,
    providerCallId: attempt.providerCallId,
    state: attempt.state,
    dispatchError: attempt.dispatchError,
    dispatchedAt: attempt.dispatchedAt,
    requestPayload: attempt.requestPayload,
    webhookEventId: attempt.webhookEventId,
  };
}

export async function decideLockedVrsBridgeIntake(
  options: LockedVrsBridgeIntakeOptions,
): Promise<VrsBridgeIntakeDecision> {
  const existing = await options.loadLatestAttempt();
  if (!existing) {
    return { kind: "none" };
  }

  const duplicate = (): VrsBridgeIntakeDecision => ({
    kind: "duplicate",
    record: toDecisionRecord(existing),
  });
  if (
    getVrsAuthorizeContractVersion(options.input.requestPayload) !== "v8" ||
    getVrsAuthorizeContractVersion(existing.requestPayload) !== "v8" ||
    existing.state !== "failed" ||
    existing.retryable !== true ||
    existing.techId !== options.input.techId ||
    existing.submissionId === null ||
    !existing.providerCallId ||
    !existing.webhookDeliveredAt
  ) {
    return duplicate();
  }

  const submission = await options.loadLinkedSubmission(existing.submissionId);
  if (
    !submission ||
    submission.ticketStatus !== "pending" ||
    submission.stage1Status !== "approved" ||
    submission.submissionApproved !== true
  ) {
    return duplicate();
  }
  const terminalEvent = await options.loadTerminalEvent(existing);
  if (
    await options.hasBlockingWebhookEvents(existing) ||
    !isFullyForwardedTerminalFailure(existing, terminalEvent)
  ) {
    return duplicate();
  }

  const now = options.now();
  await options.insertRearmSnapshot(
    existing.id,
    buildVrsRetryRearmSnapshot({
      attempt: existing,
      submission,
      terminalEvent,
      replacementCallId: options.input.callId,
      rearmedAt: now,
    }),
  );
  await options.updateAttempt(existing.id, {
    callId: options.input.callId,
    providerCallId: null,
    techPhone: options.input.techPhone,
    techName: options.input.techName,
    state: "pending_review",
    requestPayload: options.input.requestPayload as Record<string, unknown>,
    callbackUrl: options.input.callbackUrl,
    callbackSecretCipher: options.input.callbackSecretCipher,
    callbackSecretIv: options.input.callbackSecretIv,
    callbackSecretAuthTag: options.input.callbackSecretAuthTag,
    callbackSecretSalt: options.input.callbackSecretSalt,
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
    updatedAt: now,
  });
  await options.updateSubmission(submission.id, {
    ticketStatus: "queued",
    assignedTo: null,
    reassignmentNotes: null,
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
    ...options.input.submissionProjection,
    statusChangedAt: now,
    updatedAt: now,
  });
  return {
    kind: "rearmed",
    record: {
      id: existing.id,
      submissionId: submission.id,
      callId: options.input.callId,
      state: "pending_review",
    },
    rearmedAt: now,
    previousAssignee: submission.assignedTo,
    submissionProjection: options.input.submissionProjection,
  };
}

export type VrsAiBridgeStatusRow = Omit<
  VrsAiBridgeStatus,
  "contractVersion" | "reviewContext"
> & {
  requestPayload: VrsStoredAuthorizeRequest;
};

export function projectVrsAiBridgeStatus(
  row: VrsAiBridgeStatusRow,
): VrsAiBridgeStatus {
  const { requestPayload, ...status } = row;
  return {
    ...status,
    contractVersion: getVrsAuthorizeContractVersion(requestPayload),
    reviewContext: projectVrsBridgeReviewContext(requestPayload),
  };
}

export type VrsAiBridgeStatusRowLoader = (
  submissionId: number,
) => Promise<VrsAiBridgeStatusRow | undefined>;

async function loadVrsAiBridgeStatusRow(
  submissionId: number,
): Promise<VrsAiBridgeStatusRow | undefined> {
  const [row] = await db
    .select({
      callId: vrsAiCalls.callId,
      state: vrsAiCalls.state,
      providerCallId: vrsAiCalls.providerCallId,
      dispatchError: vrsAiCalls.dispatchError,
      failureReason: vrsAiCalls.failureReason,
      retryable: vrsAiCalls.retryable,
      dispatchedAt: vrsAiCalls.dispatchedAt,
      requestPayload: vrsAiCalls.requestPayload,
    })
    .from(vrsAiCalls)
    .where(eq(vrsAiCalls.submissionId, submissionId))
    .limit(1);
  return row
    ? {
        ...row,
        requestPayload: row.requestPayload as VrsStoredAuthorizeRequest,
      }
    : undefined;
}

function toBridgeRecord(row: typeof vrsAiCalls.$inferSelect): VrsBridgeRecord {
  return {
    id: row.id,
    submissionId: row.submissionId!,
    callId: row.callId,
    providerCallId: row.providerCallId,
    state: row.state,
    dispatchError: row.dispatchError,
    dispatchedAt: row.dispatchedAt,
    requestPayload: row.requestPayload as VrsStoredAuthorizeRequest,
    callbackUrl: row.callbackUrl,
    callbackSecretCipher: row.callbackSecretCipher,
    callbackSecretIv: row.callbackSecretIv,
    callbackSecretAuthTag: row.callbackSecretAuthTag,
    callbackSecretSalt: row.callbackSecretSalt,
    webhookEventId: row.webhookEventId,
  };
}

function eventResultUpdate(event: VrsWebhookEvent) {
  const isTerminal =
    event.state === "approved" ||
    event.state === "denied" ||
    event.state === "partial" ||
    event.state === "failed";
  return {
    state: event.state,
    authNumber:
      event.state === "approved" || event.state === "partial"
        ? event.authNumber
        : null,
    authorizedAmount:
      event.state === "approved" || event.state === "partial"
        ? event.authorizedAmount.toFixed(2)
        : null,
    requestedAmount:
      event.state === "partial" ? event.requestedAmount.toFixed(2) : null,
    denyReason:
      event.state === "denied" || event.state === "partial"
        ? event.denyReason ?? null
        : null,
    failureReason: event.state === "failed" ? event.reason : null,
    retryable: event.state === "failed" ? event.retryable : null,
    durationSec:
      "durationSec" in event ? event.durationSec ?? null : null,
    recordingUrl:
      "recordingUrl" in event ? event.recordingUrl ?? null : null,
    webhookEventId: event.eventId,
    completedAt: isTerminal ? new Date() : null,
    updatedAt: new Date(),
  };
}

export class DrizzleVrsBridgeStore
  implements VrsBridgeStore, VrsBridgeIntakeDecisionStore {
  private readonly statusRowLoader: VrsAiBridgeStatusRowLoader;

  constructor(statusRowLoader?: VrsAiBridgeStatusRowLoader) {
    this.statusRowLoader = statusRowLoader ?? loadVrsAiBridgeStatusRow;
  }

  async findActiveByServiceOrder(
    serviceOrder: string,
  ): Promise<VrsBridgeRecord | undefined> {
    const [row] = await db
      .select()
      .from(vrsAiCalls)
      .where(
        and(
          eq(vrsAiCalls.serviceOrder, serviceOrder),
          inArray(vrsAiCalls.state, [...ACTIVE_VRS_BRIDGE_STATES]),
        ),
      )
      .limit(1);
    return row ? toBridgeRecord(row) : undefined;
  }

  async decideExistingOrRearm(
    input: VrsBridgeIntakeDecisionInput,
  ): Promise<VrsBridgeIntakeDecision> {
    return db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`vrs-express:${input.serviceOrder}`}))`,
      );

      return decideLockedVrsBridgeIntake({
        input,
        now: () => new Date(),
        async loadLatestAttempt() {
          const [row] = await transaction
            .select()
            .from(vrsAiCalls)
            .where(eq(vrsAiCalls.serviceOrder, input.serviceOrder))
            .orderBy(desc(vrsAiCalls.createdAt), desc(vrsAiCalls.id))
            .limit(1)
            .for("update");
          return row
            ? {
                ...row,
                requestPayload:
                  row.requestPayload as VrsStoredAuthorizeRequest,
              }
            : undefined;
        },
        async loadLinkedSubmission(submissionId) {
          const [row] = await transaction
            .select({
              id: submissions.id,
              ticketStatus: submissions.ticketStatus,
              stage1Status: submissions.stage1Status,
              submissionApproved: submissions.submissionApproved,
              assignedTo: submissions.assignedTo,
              reassignmentNotes: submissions.reassignmentNotes,
              stage1ReviewedBy: submissions.stage1ReviewedBy,
              stage1ReviewedAt: submissions.stage1ReviewedAt,
              stage1RejectionReason: submissions.stage1RejectionReason,
              createdAt: submissions.createdAt,
            })
            .from(submissions)
            .where(eq(submissions.id, submissionId))
            .limit(1)
            .for("update");
          return row;
        },
        async loadTerminalEvent(attempt) {
          if (!attempt.webhookEventId) return undefined;
          const [row] = await transaction
            .select({
              eventId: vrsAiCallEvents.eventId,
              state: vrsAiCallEvents.state,
              payload: vrsAiCallEvents.payload,
              processingState: vrsAiCallEvents.processingState,
              appliedAt: vrsAiCallEvents.appliedAt,
              forwardedAt: vrsAiCallEvents.forwardedAt,
              deliveryAttempts: vrsAiCallEvents.deliveryAttempts,
              deliveryStatus: vrsAiCallEvents.deliveryStatus,
            })
            .from(vrsAiCallEvents)
            .where(
              and(
                eq(vrsAiCallEvents.vrsAiCallId, attempt.id),
                eq(vrsAiCallEvents.eventId, attempt.webhookEventId),
              ),
            )
            .limit(1)
            .for("update");
          return row
            ? { ...row, payload: row.payload as Record<string, unknown> }
            : undefined;
        },
        async hasBlockingWebhookEvents(attempt) {
          const rows = await transaction
            .select({
              processingState: vrsAiCallEvents.processingState,
              forwardedAt: vrsAiCallEvents.forwardedAt,
            })
            .from(vrsAiCallEvents)
            .where(eq(vrsAiCallEvents.vrsAiCallId, attempt.id))
            .for("update");
          return rows.some(
            (row) =>
              row.processingState !== "completed" || !row.forwardedAt,
          );
        },
        async insertRearmSnapshot(attemptId, snapshot) {
          await transaction.insert(vrsAiCallEvents).values({
            vrsAiCallId: attemptId,
            eventId: `rearm:${snapshot.replacement_public_call_id}`,
            state: V8_RETRY_REARM_EVENT_KIND,
            payload: snapshot as unknown as Record<string, unknown>,
            processingState: "completed",
            appliedAt: new Date(snapshot.rearmed_at),
            forwardedAt: new Date(snapshot.rearmed_at),
            deliveryAttempts: 0,
          });
        },
        async updateAttempt(id, update) {
          await transaction
            .update(vrsAiCalls)
            .set(update as any)
            .where(eq(vrsAiCalls.id, id));
        },
        async updateSubmission(id, update) {
          await transaction
            .update(submissions)
            .set(update as any)
            .where(eq(submissions.id, id));
        },
      });
    });
  }

  async createIntake(
    input: NewVrsBridgeIntake,
  ): Promise<
    | { kind: "accepted"; record: VrsBridgeRecord; createdAt: Date }
    | { kind: "duplicate"; record: VrsBridgeRecord }
  > {
    return db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`vrs-express:${input.serviceOrder}`}))`,
      );
      const [existing] = await transaction
        .select()
        .from(vrsAiCalls)
        .where(
          and(
            eq(vrsAiCalls.serviceOrder, input.serviceOrder),
            inArray(vrsAiCalls.state, [...ACTIVE_VRS_BRIDGE_STATES]),
          ),
        )
        .limit(1);
      if (existing) {
        return { kind: "duplicate" as const, record: toBridgeRecord(existing) };
      }

      const [created] = await transaction
        .insert(vrsAiCalls)
        .values({
          ...input,
          state: "pending_review",
          requestPayload: input.requestPayload as Record<string, unknown>,
        })
        .returning();
      return {
        kind: "accepted" as const,
        record: toBridgeRecord(created),
        createdAt: created.createdAt,
      };
    });
  }

  async getBySubmissionId(
    submissionId: number,
  ): Promise<VrsBridgeRecord | undefined> {
    const [row] = await db
      .select()
      .from(vrsAiCalls)
      .where(eq(vrsAiCalls.submissionId, submissionId))
      .limit(1);
    return row ? toBridgeRecord(row) : undefined;
  }

  async getStatusBySubmissionId(
    submissionId: number,
  ): Promise<VrsAiBridgeStatus | null> {
    const row = await this.statusRowLoader(submissionId);
    return row ? projectVrsAiBridgeStatus(row) : null;
  }

  async getByProviderCallId(
    providerCallId: string,
  ): Promise<VrsBridgeRecord | undefined> {
    const [row] = await db
      .select()
      .from(vrsAiCalls)
      .where(eq(vrsAiCalls.providerCallId, providerCallId))
      .limit(1);
    return row ? toBridgeRecord(row) : undefined;
  }

  async hasSupersededProviderCall(
    providerCallId: string,
    serviceOrder: string,
  ): Promise<boolean> {
    const [row] = await db
      .select({ id: vrsAiCallEvents.id })
      .from(vrsAiCallEvents)
      .where(
        and(
          eq(vrsAiCallEvents.state, V8_RETRY_REARM_EVENT_KIND),
          sql`${vrsAiCallEvents.payload} ->> 'kind' = ${V8_RETRY_REARM_EVENT_KIND}`,
          sql`${vrsAiCallEvents.payload} ->> 'prior_provider_call_id' = ${providerCallId}`,
          sql`${vrsAiCallEvents.payload} ->> 'service_order' = ${serviceOrder}`,
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async markDispatching(id: number): Promise<boolean> {
    const staleBefore = new Date(Date.now() - 2 * 60_000);
    const rows = await db
      .update(vrsAiCalls)
      .set({
        state: "dispatching",
        dispatchError: null,
        dispatchAttemptedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(vrsAiCalls.id, id),
          or(
            inArray(vrsAiCalls.state, ["pending_review", "dispatch_failed"]),
            and(
              eq(vrsAiCalls.state, "dispatching"),
              lt(vrsAiCalls.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning({ id: vrsAiCalls.id });
    return rows.length === 1;
  }

  async markAccepted(
    id: number,
    providerCallId: string,
    state: string,
  ): Promise<void> {
    await db
      .update(vrsAiCalls)
      .set({
        providerCallId,
        state,
        dispatchError: null,
        dispatchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(vrsAiCalls.id, id));
  }

  async markDispatchFailed(id: number, message: string): Promise<void> {
    await db
      .update(vrsAiCalls)
      .set({
        state: "dispatch_failed",
        dispatchError: message.slice(0, 2_000),
        updatedAt: new Date(),
      })
      .where(eq(vrsAiCalls.id, id));
  }

  async beginWebhookEvent(
    id: number,
    event: VrsWebhookEvent,
  ): Promise<
    | { kind: "claimed"; alreadyApplied: boolean }
    | { kind: "duplicate" }
    | { kind: "in_progress" }
  > {
    return db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`vrs-ai-event:${event.eventId}`}))`,
      );
      const [call] = await transaction
        .select({
          state: vrsAiCalls.state,
          providerCallId: vrsAiCalls.providerCallId,
        })
        .from(vrsAiCalls)
        .where(eq(vrsAiCalls.id, id))
        .limit(1)
        .for("update");
      if (
        !call ||
        !isCurrentVrsWebhookProvider(call.providerCallId, event.callId)
      ) {
        return { kind: "duplicate" as const };
      }
      const [existing] = await transaction
        .select()
        .from(vrsAiCallEvents)
        .where(eq(vrsAiCallEvents.eventId, event.eventId))
        .limit(1);

      if (!existing) {
        if (
          (TERMINAL_VRS_AI_STATES as readonly string[]).includes(call.state)
        ) {
          return { kind: "duplicate" as const };
        }
        await transaction.insert(vrsAiCallEvents).values({
          vrsAiCallId: id,
          eventId: event.eventId,
          state: event.state,
          payload: event as Record<string, unknown>,
          processingState: "processing",
        });
        return {
          kind: "claimed" as const,
          alreadyApplied: false,
        };
      }
      if (existing.forwardedAt) return { kind: "duplicate" as const };

      const processingIsFresh =
        existing.processingState === "processing" &&
        existing.updatedAt.getTime() > Date.now() - 2 * 60_000;
      if (processingIsFresh) return { kind: "in_progress" as const };

      await transaction
        .update(vrsAiCallEvents)
        .set({
          processingState: "processing",
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(vrsAiCallEvents.id, existing.id));
      return {
        kind: "claimed" as const,
        alreadyApplied: Boolean(existing.appliedAt),
      };
    });
  }

  async markWebhookApplied(
    id: number,
    eventId: string,
    event: VrsWebhookEvent,
  ): Promise<void> {
    await db.transaction(async (transaction) => {
      await transaction
        .update(vrsAiCalls)
        .set(eventResultUpdate(event))
        .where(eq(vrsAiCalls.id, id));
      await transaction
        .update(vrsAiCallEvents)
        .set({
          appliedAt: new Date(),
          processingState: "applied",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(vrsAiCallEvents.vrsAiCallId, id),
            eq(vrsAiCallEvents.eventId, eventId),
          ),
        );
    });
  }

  async markWebhookForwarded(
    id: number,
    eventId: string,
    result: { delivered: boolean; attempts: number; status?: number },
  ): Promise<void> {
    const now = new Date();
    await db.transaction(async (transaction) => {
      // Every path that touches both rows locks the call first. Rearm uses the
      // same call -> event order, preventing callback-forward/rearm deadlocks.
      await transaction
        .update(vrsAiCalls)
        .set({
          webhookAttemptCount: result.attempts,
          webhookLastStatus: result.status ?? null,
          webhookLastAttemptAt: now,
          webhookDeliveredAt: result.delivered ? now : null,
          updatedAt: now,
        })
        .where(eq(vrsAiCalls.id, id));
      await transaction
        .update(vrsAiCallEvents)
        .set({
          processingState: result.delivered ? "completed" : "forward_failed",
          forwardedAt: result.delivered ? now : null,
          deliveryAttempts: result.attempts,
          deliveryStatus: result.status ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(vrsAiCallEvents.vrsAiCallId, id),
            eq(vrsAiCallEvents.eventId, eventId),
          ),
        );
    });
  }

  async markWebhookFailed(
    id: number,
    eventId: string,
    message: string,
  ): Promise<void> {
    await db
      .update(vrsAiCallEvents)
      .set({
        processingState: "failed",
        lastError: message.slice(0, 2_000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(vrsAiCallEvents.vrsAiCallId, id),
          eq(vrsAiCallEvents.eventId, eventId),
        ),
      );
  }
}

export function isCurrentVrsWebhookProvider(
  currentProviderCallId: string | null | undefined,
  eventCallId: string,
): boolean {
  return typeof currentProviderCallId === "string" &&
    currentProviderCallId === eventCallId;
}

export const vrsBridgeStore = new DrizzleVrsBridgeStore();
