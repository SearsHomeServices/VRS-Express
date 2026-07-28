import { randomUUID } from "crypto";
import type {
  EnqueueVrsAiCallResult,
  VrsAiCallQueue,
} from "./vrs-sasha-api";
import type { VrsAuthorizeRequest } from "./vrs-sasha-contract";
import { encryptVrsCallbackSecret } from "./vrs-sasha-secret";

export interface NewVrsAiCallRecord {
  callId: string;
  serviceOrder: string;
  techId: string;
  techPhone: string;
  techName: string;
  state: string;
  requestPayload: Omit<VrsAuthorizeRequest, "callback_secret">;
  callbackUrl: string;
  callbackSecretCipher: string;
  callbackSecretIv: string;
  callbackSecretAuthTag: string;
  callbackSecretSalt: string;
  createdAt: Date;
}

export interface VrsAiCallTransaction {
  lockServiceOrder(serviceOrder: string): Promise<void>;
  findActiveByServiceOrder(
    serviceOrder: string,
  ): Promise<{ callId: string; state: string } | undefined>;
  getTechCallTimesSince(techId: string, since: Date): Promise<Date[]>;
  countActiveCalls(): Promise<number>;
  insert(record: NewVrsAiCallRecord): Promise<void>;
}

export interface VrsAiCallDatabase {
  transaction<T>(
    work: (transaction: VrsAiCallTransaction) => Promise<T>,
  ): Promise<T>;
}

export class DurableVrsAiCallQueue implements VrsAiCallQueue {
  constructor(
    private readonly database: VrsAiCallDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createCallId: () => string = () =>
      `vrs_call_${randomUUID()}`,
  ) {}

  async enqueue(
    input: VrsAuthorizeRequest,
  ): Promise<EnqueueVrsAiCallResult> {
    const now = this.now();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1_000);

    return this.database.transaction(async (transaction) => {
      await transaction.lockServiceOrder(input.service_order);

      const existing = await transaction.findActiveByServiceOrder(
        input.service_order,
      );
      if (existing) {
        return {
          kind: "duplicate",
          existingCallId: existing.callId,
          // V5 normalizes every non-terminal duplicate to "in_progress" so
          // SASHA can reattach without coupling to VRS internal queue states.
          state: "in_progress",
        };
      }

      const techCallTimes = await transaction.getTechCallTimesSince(
        input.tech_id,
        oneHourAgo,
      );
      if (techCallTimes.length >= 10) {
        const oldestCall = techCallTimes.reduce((oldest, candidate) =>
          candidate < oldest ? candidate : oldest,
        );
        return {
          kind: "rate_limited",
          scope: "tech",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              (oldestCall.getTime() + 60 * 60 * 1_000 - now.getTime()) /
                1_000,
            ),
          ),
        };
      }

      if ((await transaction.countActiveCalls()) >= 100) {
        return {
          kind: "rate_limited",
          scope: "global",
          retryAfterSeconds: 60,
        };
      }

      const encryptedSecret = encryptVrsCallbackSecret(input.callback_secret);
      const { callback_secret: _callbackSecret, ...requestPayload } = input;
      const callId = this.createCallId();
      await transaction.insert({
        callId,
        serviceOrder: input.service_order,
        techId: input.tech_id,
        techPhone: input.tech_phone,
        techName: input.tech_name,
        state: "queued",
        requestPayload,
        callbackUrl: input.callback_url,
        callbackSecretCipher: encryptedSecret.cipher,
        callbackSecretIv: encryptedSecret.iv,
        callbackSecretAuthTag: encryptedSecret.authTag,
        callbackSecretSalt: encryptedSecret.salt,
        createdAt: now,
      });

      return {
        kind: "queued",
        callId,
        serviceOrder: input.service_order,
        state: "queued",
        createdAt: now,
      };
    });
  }
}
