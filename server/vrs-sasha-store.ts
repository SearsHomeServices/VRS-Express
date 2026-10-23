import type { PoolClient } from "pg";
import { callbackFingerprint, VrsCallbackError } from "./vrs-callback-safety";
import { and, desc, eq, inArray, lt, gt, ne, isNull, or, sql } from "drizzle-orm";
import { submissions, vrsAiCallEvents, vrsAiCalls } from "@shared/schema";
import { db, pool } from "./storage";
import {
  VRS_APP_ORIGIN_CALLBACK_URL,
  isAppOriginVrsBridgeRecord,
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
  "reviewing",
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
  // Where the ticket came from: "sasha" (POST /vrs/authorize) or "app" (a
  // technician filed it in VRS Express, see vrs-app-enroll.ts). Derived from
  // the stored callback URL, which itself never leaves the server. Optional
  // so older fixtures without it still read as SASHA.
  origin?: VrsAiBridgeOrigin;
  reviewContext: VrsBridgeReviewContext;
}

export type VrsAiBridgeOrigin = "sasha" | "app";

export interface VrsBridgeIntakeStore {
  findActiveByServiceOrder(
    serviceOrder: string,
  ): Promise<VrsBridgeRecord | undefined>;
  findLocallyAppliedRetryableFailedV8SubmissionsByServiceOrder(
    serviceOrder: string,
  ): Promise<readonly { submissionId: number }[]>;
  createIntake(
    input: NewVrsBridgeIntake,
    options?: { supersedeClosedUndispatched?: boolean },
  ): Promise<
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
  "contractVersion" | "reviewContext" | "origin"
> & {
  requestPayload: VrsStoredAuthorizeRequest;
  // Read only to derive `origin`; never copied into the status.
  callbackUrl?: string;
};

export function projectVrsAiBridgeStatus(
  row: VrsAiBridgeStatusRow,
): VrsAiBridgeStatus {
  const { requestPayload, callbackUrl, ...status } = row;
  return {
    ...status,
    contractVersion: getVrsAuthorizeContractVersion(requestPayload),
    origin:
      callbackUrl !== undefined && isAppOriginVrsBridgeRecord({ callbackUrl })
        ? "app"
        : "sasha",
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
      callbackUrl: vrsAiCalls.callbackUrl,
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
    createdAt: row.createdAt,
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

// Reserve at most four of the shared pool connections for local callback locks.
let webhookApplicationsInFlight = 0;

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
    options?: { supersedeClosedUndispatched?: boolean },
  ): Promise<
    | { kind: "accepted"; record: VrsBridgeRecord; createdAt: Date }
    | { kind: "duplicate"; record: VrsBridgeRecord }
  > {
    return db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`vrs-express:${input.serviceOrder}`}))`,
      );
      if (options?.supersedeClosedUndispatched) {
        // A Stage 1 rejection never touches the bridge row, so a rejected
        // ticket's undispatched row would otherwise block its resubmission
        // forever. Retire only rows VRS AI never received whose ticket is
        // closed without approval.
        await transaction
          .update(vrsAiCalls)
          .set({ state: "superseded", updatedAt: new Date() })
          .where(
            and(
              eq(vrsAiCalls.serviceOrder, input.serviceOrder),
              inArray(vrsAiCalls.state, ["pending_review", "dispatch_failed"]),
              isNull(vrsAiCalls.providerCallId),
              inArray(
                vrsAiCalls.submissionId,
                transaction
                  .select({ id: submissions.id })
                  .from(submissions)
                  .where(
                    inArray(submissions.ticketStatus, [
                      "rejected",
                      "rejected_closed",
                      "invalid",
                    ]),
                  ),
              ),
            ),
          );
      }
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

  // Stage 1 AHS review (server/vrs-app-enroll.ts saveAppSubmissionVrsAiIntake):
  // the VRS manager saved the AHS details again before dispatch. Replaces the
  // stored request of an app-origin row VRS AI never received, in place, so
  // the ticket keeps one row. The predicate races markDispatching safely:
  // false once a dispatch has started or VRS AI has the call.
  async replaceUndispatchedAppIntake(
    id: number,
    replacement: Pick<NewVrsBridgeIntake, "requestPayload" | "techId" | "techPhone" | "techName">,
  ): Promise<boolean> {
    const rows = await db
      .update(vrsAiCalls)
      .set({
        requestPayload: replacement.requestPayload as Record<string, unknown>,
        techId: replacement.techId,
        techPhone: replacement.techPhone,
        techName: replacement.techName,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(vrsAiCalls.id, id),
          inArray(vrsAiCalls.state, ["pending_review", "dispatch_failed"]),
          isNull(vrsAiCalls.providerCallId),
          eq(vrsAiCalls.callbackUrl, VRS_APP_ORIGIN_CALLBACK_URL),
        ),
      )
      .returning({ id: vrsAiCalls.id });
    return rows.length === 1;
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

  async listRecentPhotoIntakes(
    since: Date,
  ): Promise<Array<{
    submissionId: number;
    appliancePhotos: string[];
    retentionExpiresAt: number;
  }>> {
    const rows = await db
      .select({
        submissionId: vrsAiCalls.submissionId,
        requestPayload: vrsAiCalls.requestPayload,
        createdAt: vrsAiCalls.createdAt,
      })
      .from(vrsAiCalls)
      .where(gt(vrsAiCalls.createdAt, since))
      .orderBy(desc(vrsAiCalls.createdAt))
      .limit(500);
    return rows
      .filter((row): row is typeof row & { submissionId: number } =>
        Number.isSafeInteger(row.submissionId),
      )
      .map((row) => {
        const payload = row.requestPayload as Partial<VrsStoredAuthorizeRequest>;
        return {
          submissionId: row.submissionId,
          retentionExpiresAt: row.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000,
          appliancePhotos: Array.isArray(payload.appliance_photos)
            ? payload.appliance_photos.filter(
              (photo): photo is string => typeof photo === "string",
            )
            : [],
        };
      })
      .filter((row) => row.appliancePhotos.length > 0);
  }

  async getStatusBySubmissionId(
    submissionId: number,
  ): Promise<VrsAiBridgeStatus | null> {
    const row = await this.statusRowLoader(submissionId);
    return row ? projectVrsAiBridgeStatus(row) : null;
  }

  async getByAnyCallId(callId:string):Promise<VrsBridgeRecord|undefined> {
    const rows=await db.select().from(vrsAiCalls).where(or(eq(vrsAiCalls.providerCallId,callId),eq(vrsAiCalls.callId,callId))).limit(2);
    if(rows.length>1)throw new VrsCallbackError("AMBIGUOUS_CALL_ID", "This identifier matches more than one bridge call.");
    return rows[0] ? toBridgeRecord(rows[0]) : undefined;
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

  async withWebhookApplicationLock<T>(id:number, work:()=>Promise<T>): Promise<T> {
    if (webhookApplicationsInFlight >= 4) throw new VrsCallbackError("CALLBACK_CAPACITY", "Callback processing is busy. Retry the same event shortly.",429);
    webhookApplicationsInFlight++;
    let client: PoolClient | undefined;
    let locked = false;
    let connectionLost = false;
    const onConnectionError = () => { connectionLost = true; };
    const key = `vrs-ai-application:${id}`;
    try {
      client = await pool.connect();
      client.on("error",onConnectionError);
      locked = Boolean((await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked",[key])).rows[0]?.locked);
      if (!locked) throw new VrsCallbackError("EVENT_IN_PROGRESS", "Another result for this call is applying. Retry the same event shortly.");
      const result=await work();
      if(connectionLost)throw new VrsCallbackError("CALLBACK_LOCK_LOST","Callback connection was interrupted; retry the same event.",503);
      return result;
    } finally {
      if (client) {
        let discard = connectionLost;
        if (locked && !connectionLost) {
          try { await client.query("SELECT pg_advisory_unlock(hashtext($1))",[key]); }
          catch { discard = true; }
        }
        client.removeListener("error",onConnectionError);
        client.release(discard);
      }
      webhookApplicationsInFlight--;
    }
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
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vrs-ai-call:${id}`}))`);
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vrs-ai-event:${event.eventId}`}))`);
      const [existing] = await transaction.select().from(vrsAiCallEvents).where(eq(vrsAiCallEvents.eventId,event.eventId)).limit(1);
      if (existing && (existing.vrsAiCallId !== id || callbackFingerprint(existing.payload) !== callbackFingerprint(event))) {
        throw new VrsCallbackError("EVENT_CONFLICT", "Event ID is already bound to a different call or payload.");
      }
      if (existing?.forwardedAt) return {kind:"duplicate" as const};
      const [call] = await transaction.select({state:vrsAiCalls.state,webhookEventId:vrsAiCalls.webhookEventId}).from(vrsAiCalls).where(eq(vrsAiCalls.id,id)).limit(1);
      if (!call) throw new VrsCallbackError("CALL_NOT_FOUND", "Callback call no longer exists.",404);
      const [latest] = call.webhookEventId
        ? await transaction.select().from(vrsAiCallEvents).where(and(eq(vrsAiCallEvents.vrsAiCallId,id),eq(vrsAiCallEvents.eventId,call.webhookEventId))).limit(1)
        : [];
      if (call.webhookEventId !== event.eventId) {
        if ((TERMINAL_VRS_AI_STATES as readonly string[]).includes(call.state)) {
          if (event.state === "requires_info") return {kind:"duplicate" as const};
          throw new VrsCallbackError("TERMINAL_RESULT_CONFLICT", "This call already has a terminal result. Review conflicting outcomes instead of applying another.");
        }
        if (latest && new Date(String(latest.payload.occurredAt)).getTime() > new Date(event.occurredAt).getTime()) {
          throw new VrsCallbackError("STALE_EVENT", "An older event cannot replace a newer call state.");
        }
      }
      const freshBefore = new Date(Date.now()-2*60_000);
      const [busy] = await transaction.select({id:vrsAiCallEvents.id}).from(vrsAiCallEvents).where(and(eq(vrsAiCallEvents.vrsAiCallId,id),ne(vrsAiCallEvents.eventId,event.eventId),eq(vrsAiCallEvents.processingState,"processing"),gt(vrsAiCallEvents.updatedAt,freshBefore))).limit(1);
      if (busy || existing && ["processing","forwarding"].includes(existing.processingState) && existing.updatedAt > freshBefore) return {kind:"in_progress" as const};
      if (!existing) {
        await transaction.insert(vrsAiCallEvents).values({vrsAiCallId:id,eventId:event.eventId,state:event.state,payload:event as Record<string,unknown>,processingState:"processing"});
      } else {
        await transaction.update(vrsAiCallEvents).set({processingState:"processing",lastError:null,updatedAt:new Date()}).where(eq(vrsAiCallEvents.id,existing.id));
      }
      return {kind:"claimed" as const,alreadyApplied:Boolean(existing?.appliedAt)};
    });
  }

  async markWebhookApplied(id:number,eventId:string,event:VrsWebhookEvent): Promise<void> {
    await db.transaction(async transaction => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vrs-ai-call:${id}`}))`);
      const [call] = await transaction.select({state:vrsAiCalls.state,webhookEventId:vrsAiCalls.webhookEventId}).from(vrsAiCalls).where(eq(vrsAiCalls.id,id)).limit(1).for("update");
      const [receipt] = await transaction.select().from(vrsAiCallEvents).where(and(eq(vrsAiCallEvents.vrsAiCallId,id),eq(vrsAiCallEvents.eventId,eventId))).limit(1);
      if (!receipt || callbackFingerprint(receipt.payload) !== callbackFingerprint(event)) throw new VrsCallbackError("EVENT_CONFLICT", "Event receipt does not match the applied result.");
      if (!call) throw new VrsCallbackError("CALL_NOT_FOUND", "Callback call no longer exists.",404);
      if (call.webhookEventId !== eventId) {
        if ((TERMINAL_VRS_AI_STATES as readonly string[]).includes(call.state)) throw new VrsCallbackError("STALE_EVENT", "A terminal result cannot be overwritten by a different event.");
        const [latest] = call.webhookEventId ? await transaction.select().from(vrsAiCallEvents).where(and(eq(vrsAiCallEvents.vrsAiCallId,id),eq(vrsAiCallEvents.eventId,call.webhookEventId))).limit(1) : [];
        if (latest && new Date(String(latest.payload.occurredAt)).getTime() > new Date(event.occurredAt).getTime()) throw new VrsCallbackError("STALE_EVENT", "An older event cannot replace a newer call state.");
      }
      await transaction.update(vrsAiCalls).set(eventResultUpdate(event)).where(eq(vrsAiCalls.id,id));
      await transaction.update(vrsAiCallEvents).set({appliedAt:new Date(),processingState:"applied",updatedAt:new Date()}).where(eq(vrsAiCallEvents.id,receipt.id));
    });
  }

  async claimWebhookForwarding(id:number,eventId:string):Promise<{kind:"claimed";claimedAt:Date}|{kind:"duplicate"|"in_progress"|"superseded"}> {
    return db.transaction(async transaction=>{
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vrs-ai-call:${id}`}))`);
      const [event]=await transaction.select().from(vrsAiCallEvents).where(and(eq(vrsAiCallEvents.vrsAiCallId,id),eq(vrsAiCallEvents.eventId,eventId))).limit(1);
      if(!event?.appliedAt)throw new VrsCallbackError("EVENT_NOT_APPLIED","This event has not been applied locally.");
      if(event.forwardedAt)return {kind:"duplicate" as const};
      if(event.processingState==="superseded")return {kind:"superseded" as const};
      const [busy]=await transaction.select({id:vrsAiCallEvents.id}).from(vrsAiCallEvents).where(and(eq(vrsAiCallEvents.vrsAiCallId,id),eq(vrsAiCallEvents.processingState,"forwarding"),gt(vrsAiCallEvents.updatedAt,new Date(Date.now()-2*60_000)))).limit(1);
      if(busy)return {kind:"in_progress" as const};
      const [call]=await transaction.select({eventId:vrsAiCalls.webhookEventId}).from(vrsAiCalls).where(eq(vrsAiCalls.id,id)).limit(1);
      if(call?.eventId && call.eventId!==eventId){
        await transaction.update(vrsAiCallEvents).set({processingState:"superseded",lastError:"A newer applied event superseded this pending delivery.",updatedAt:new Date()}).where(eq(vrsAiCallEvents.id,event.id));
        return {kind:"superseded" as const};
      }
      const claimedAt=new Date();
      await transaction.update(vrsAiCallEvents).set({processingState:"forwarding",updatedAt:claimedAt}).where(eq(vrsAiCallEvents.id,event.id));
      return {kind:"claimed" as const,claimedAt};
    });
  }

  async markWebhookForwarded(
    id: number,
    eventId: string,
    result: { delivered: boolean; attempts: number; status?: number },
    claimedAt?: Date,
  ): Promise<void> {
    const now = new Date();
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vrs-ai-call:${id}`}))`);
      const written = await transaction
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
            isNull(vrsAiCallEvents.forwardedAt),
            claimedAt ? eq(vrsAiCallEvents.updatedAt,claimedAt) : undefined,
            claimedAt ? eq(vrsAiCallEvents.processingState,"forwarding") : undefined,
            ne(vrsAiCallEvents.processingState,"superseded"),
          ),
        ).returning({id:vrsAiCallEvents.id});
      if (!written.length) return;
      await transaction
        .update(vrsAiCalls)
        .set({
          webhookAttemptCount: result.attempts,
          webhookLastStatus: result.status ?? null,
          webhookLastAttemptAt: now,
          webhookDeliveredAt: result.delivered ? now : null,
          updatedAt: now,
        })
        .where(and(eq(vrsAiCalls.id, id), eq(vrsAiCalls.webhookEventId, eventId)));
    });
  }

  async markWebhookFailed(
    id: number,
    eventId: string,
    message: string,
    claimedAt?: Date,
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
          isNull(vrsAiCallEvents.forwardedAt),
          claimedAt ? eq(vrsAiCallEvents.updatedAt,claimedAt) : undefined,
          claimedAt ? eq(vrsAiCallEvents.processingState,"forwarding") : undefined,
          ne(vrsAiCallEvents.processingState,"superseded"),
        ),
      );
  }
}

export const vrsBridgeStore = new DrizzleVrsBridgeStore();
