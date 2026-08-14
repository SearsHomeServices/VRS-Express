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
  type VrsAuthorizeContractVersion,
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
  contractVersion: VrsAuthorizeContractVersion;
  state: string;
  providerCallId: string | null;
  dispatchError: string | null;
  failureReason: string | null;
  retryable: boolean | null;
  dispatchedAt: Date | null;
  reviewContext: VrsBridgeReviewContext;
}

export interface VrsBridgeIntakeStore {
  findActiveByServiceOrder(
    serviceOrder: string,
  ): Promise<VrsBridgeRecord | undefined>;
  findLocallyAppliedRetryableFailedV8SubmissionsByServiceOrder(
    serviceOrder: string,
  ): Promise<readonly { submissionId: number }[]>;
  createIntake(input: NewVrsBridgeIntake): Promise<
    | { kind: "accepted"; record: VrsBridgeRecord; createdAt: Date }
    | { kind: "duplicate"; record: VrsBridgeRecord }
  >;
}

export interface VrsServiceOrderSource {
  callId: string;
  state: string;
  requestPayload: VrsStoredAuthorizeRequest;
  submissionPhotos: string | null;
}

export interface VrsServiceOrderReader {
  getLatestByServiceOrder(
    serviceOrder: string,
  ): Promise<VrsServiceOrderSource | undefined>;
}

export interface VrsRetryableFailedV8Candidate {
  submissionId: number | null;
  state: string;
  retryable: boolean | null;
  requestPayload: unknown;
  webhookEventId: string | null;
  eventId: string | null;
  eventState: string | null;
  eventAppliedAt: Date | null;
}

function isLocallyAppliedRetryableFailedV8Candidate(
  row: VrsRetryableFailedV8Candidate | undefined,
): row is VrsRetryableFailedV8Candidate & { submissionId: number } {
  return (
    row?.submissionId !== null &&
    row?.submissionId !== undefined &&
    row.state === "failed" &&
    row.retryable === true &&
    row.webhookEventId !== null &&
    row.eventId === row.webhookEventId &&
    row.eventState === "failed" &&
    row.eventAppliedAt !== null &&
    getVrsAuthorizeContractVersion(row.requestPayload) !== "v5"
  );
}

export function selectLocallyAppliedRetryableFailedV8SubmissionIds(
  rows: readonly VrsRetryableFailedV8Candidate[],
): readonly number[] {
  // Locally applied is the terminal durability boundary. Do not require
  // forwardedAt: the existing callback-forward ledger retries independently,
  // and this fresh V8 request never mutates the prior attempt.
  if (!isLocallyAppliedRetryableFailedV8Candidate(rows[0])) return [];

  return rows
    .filter(isLocallyAppliedRetryableFailedV8Candidate)
    .map((row) => row.submissionId);
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
  implements VrsBridgeStore, VrsBridgeIntakeStore, VrsServiceOrderReader {
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

  async getLatestByServiceOrder(
    serviceOrder: string,
  ): Promise<VrsServiceOrderSource | undefined> {
    const [row] = await db
      .select({
        callId: vrsAiCalls.callId,
        state: vrsAiCalls.state,
        requestPayload: vrsAiCalls.requestPayload,
        submissionPhotos: submissions.photos,
      })
      .from(vrsAiCalls)
      .leftJoin(submissions, eq(submissions.id, vrsAiCalls.submissionId))
      .where(eq(vrsAiCalls.serviceOrder, serviceOrder))
      .orderBy(desc(vrsAiCalls.createdAt), desc(vrsAiCalls.id))
      .limit(1);

    return row
      ? {
          ...row,
          requestPayload: row.requestPayload as VrsStoredAuthorizeRequest,
        }
      : undefined;
  }

  async findLocallyAppliedRetryableFailedV8SubmissionsByServiceOrder(
    serviceOrder: string,
  ): Promise<readonly { submissionId: number }[]> {
    const rows = await db
      .select({
        id: vrsAiCalls.id,
        submissionId: vrsAiCalls.submissionId,
        state: vrsAiCalls.state,
        retryable: vrsAiCalls.retryable,
        requestPayload: vrsAiCalls.requestPayload,
        webhookEventId: vrsAiCalls.webhookEventId,
        eventId: vrsAiCallEvents.eventId,
        eventState: vrsAiCallEvents.state,
        eventAppliedAt: vrsAiCallEvents.appliedAt,
      })
      .from(vrsAiCalls)
      .leftJoin(
        vrsAiCallEvents,
        and(
          eq(vrsAiCallEvents.vrsAiCallId, vrsAiCalls.id),
          eq(vrsAiCallEvents.eventId, vrsAiCalls.webhookEventId),
        ),
      )
      .where(eq(vrsAiCalls.serviceOrder, serviceOrder))
      .orderBy(desc(vrsAiCalls.createdAt), desc(vrsAiCalls.id));

    // The immediate V8 retry applies only after the newest bridge attempt is
    // a durable retryable V8 failure. Earlier eligible failures are returned
    // too, so their still-pending legacy tickets do not block a later retry.
    return selectLocallyAppliedRetryableFailedV8SubmissionIds(rows).map(
      (submissionId) => ({ submissionId }),
    );
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
      const [existing] = await transaction
        .select()
        .from(vrsAiCallEvents)
        .where(eq(vrsAiCallEvents.eventId, event.eventId))
        .limit(1);

      if (!existing) {
        const [call] = await transaction
          .select({ state: vrsAiCalls.state })
          .from(vrsAiCalls)
          .where(eq(vrsAiCalls.id, id))
          .limit(1);
        if (
          call &&
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

export const vrsBridgeStore = new DrizzleVrsBridgeStore();
