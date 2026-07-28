import type {
  VrsAiAuthorizeResult,
  VrsAuthorizeRequest,
  VrsWebhookEvent,
} from "./vrs-sasha-contract";

export type VrsExpressApplianceDivision =
  | "cooking"
  | "dishwasher"
  | "microwave"
  | "laundry"
  | "refrigeration"
  | "hvac"
  | "all_other";

export function mapVrsApplianceType(
  applianceType: string,
): VrsExpressApplianceDivision {
  const value = applianceType.toLowerCase();
  if (/dishwasher/.test(value)) return "dishwasher";
  if (/(washer|dryer|laundry)/.test(value)) return "laundry";
  if (/(refrigerator|fridge|freezer|ice maker)/.test(value)) {
    return "refrigeration";
  }
  if (/microwave/.test(value)) return "microwave";
  if (/(range|oven|cooktop|stove)/.test(value)) return "cooking";
  if (/(air conditioner|furnace|heat pump|hvac)/.test(value)) return "hvac";
  return "all_other";
}

export function mapVrsPayloadToSubmission(
  payload: VrsAuthorizeRequest,
  districtCode: string,
) {
  if (!/^\d{4}$/.test(districtCode)) {
    throw new Error("Technician district must be exactly four digits");
  }

  return {
    serviceOrder: `${districtCode}-${payload.service_order}`,
    applianceType: mapVrsApplianceType(payload.appliance_type),
    requestType: "authorization" as const,
    warrantyType: "american_home_shield" as const,
    warrantyProvider: "American Home Shield",
    issueDescription: payload.repair_replace_rationale,
    estimateAmount: (
      payload.labor_amount +
      payload.tax_amount +
      payload.part_price
    ).toFixed(2),
    partNumbers: JSON.stringify(payload.parts.map((part) => part.part_id)),
    phone: payload.tech_phone,
  };
}

export type VrsBridgeReviewContext = Omit<
  VrsAuthorizeRequest,
  "callback_url" | "callback_secret"
>;

export function projectVrsBridgeReviewContext(
  payload:
    | VrsAuthorizeRequest
    | Omit<VrsAuthorizeRequest, "callback_secret">,
): VrsBridgeReviewContext {
  const {
    callback_url: _callbackUrl,
    ...reviewContext
  } = payload;
  const {
    callback_secret: _callbackSecret,
    ...safeReviewContext
  } = reviewContext as VrsAuthorizeRequest;
  return safeReviewContext;
}

export interface VrsBridgeRecord {
  id: number;
  submissionId: number;
  callId: string;
  providerCallId?: string | null;
  state: string;
  dispatchError?: string | null;
  dispatchedAt?: Date | null;
  requestPayload: Omit<VrsAuthorizeRequest, "callback_secret">;
  callbackUrl?: string;
  callbackSecretCipher?: string;
  callbackSecretIv?: string;
  callbackSecretAuthTag?: string;
  callbackSecretSalt?: string;
  webhookEventId?: string | null;
}

export interface VrsBridgeStore {
  getBySubmissionId(submissionId: number): Promise<VrsBridgeRecord | undefined>;
  getByProviderCallId(
    providerCallId: string,
  ): Promise<VrsBridgeRecord | undefined>;
  markDispatching(id: number): Promise<boolean>;
  markAccepted(
    id: number,
    providerCallId: string,
    state: string,
  ): Promise<void>;
  markDispatchFailed(id: number, message: string): Promise<void>;
  beginWebhookEvent(
    id: number,
    event: VrsWebhookEvent,
  ): Promise<
    | { kind: "claimed"; alreadyApplied: boolean }
    | { kind: "duplicate" }
    | { kind: "in_progress" }
  >;
  markWebhookApplied(
    id: number,
    eventId: string,
    event: VrsWebhookEvent,
  ): Promise<void>;
  markWebhookForwarded(
    id: number,
    eventId: string,
    result: { delivered: boolean; attempts: number; status?: number },
  ): Promise<void>;
  markWebhookFailed(
    id: number,
    eventId: string,
    message: string,
  ): Promise<void>;
}

export interface VrsAiClient {
  authorize(options: {
    payload: VrsAuthorizeRequest;
  }): Promise<VrsAiAuthorizeResult>;
}

export type DispatchVrsAiResult =
  | { kind: "not_applicable" }
  | {
      kind: "already_dispatched";
      providerCallId: string;
      state: string;
    }
  | {
      kind: "accepted";
      providerCallId: string;
      state: string;
      duplicate: boolean;
    }
  | {
      kind: "failed";
      status?: number;
      message: string;
    }
  | { kind: "busy" };

export async function dispatchVrsAiForSubmission(options: {
  submissionId: number;
  store: Pick<
    VrsBridgeStore,
    | "getBySubmissionId"
    | "markDispatching"
    | "markAccepted"
    | "markDispatchFailed"
  >;
  client: VrsAiClient;
  callbackUrl: string;
  callbackSecret: string;
}): Promise<DispatchVrsAiResult> {
  const record = await options.store.getBySubmissionId(options.submissionId);
  if (!record) return { kind: "not_applicable" };

  if (record.providerCallId) {
    return {
      kind: "already_dispatched",
      providerCallId: record.providerCallId,
      state: record.state,
    };
  }

  if (!(await options.store.markDispatching(record.id))) {
    return { kind: "busy" };
  }

  const payload = {
    ...record.requestPayload,
    callback_url: options.callbackUrl,
    callback_secret: options.callbackSecret,
  } as VrsAuthorizeRequest;
  let result: VrsAiAuthorizeResult;
  try {
    result = await options.client.authorize({ payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await options.store.markDispatchFailed(record.id, message);
    return { kind: "failed", message };
  }

  if (result.kind === "accepted") {
    await options.store.markAccepted(
      record.id,
      result.callId,
      result.state,
    );
    return {
      kind: "accepted",
      providerCallId: result.callId,
      state: result.state,
      duplicate: result.duplicate,
    };
  }

  const failure =
    result.kind === "rate_limited"
      ? {
          kind: "failed" as const,
          status: 429,
          message: result.message,
        }
      : result;
  await options.store.markDispatchFailed(record.id, failure.message);
  return failure;
}

export type VrsAiSubmissionDecision =
  | {
      kind: "process";
      body: {
        action: "approve" | "reject";
        authCode?: string;
        rejectionReasons?: string[];
        agentNotes: string;
        technicianMessage?: string;
      };
    }
  | { kind: "status_only" };

export function mapVrsAiWebhookToSubmissionDecision(
  event: VrsWebhookEvent,
): VrsAiSubmissionDecision {
  if (event.state === "approved") {
    return {
      kind: "process",
      body: {
        action: "approve",
        authCode: event.authNumber,
        agentNotes: `VRS AI approved $${event.authorizedAmount.toFixed(2)} (event ${event.eventId}).`,
      },
    };
  }

  if (event.state === "partial") {
    const detail = `AHS partially authorized $${event.authorizedAmount.toFixed(2)} of $${event.requestedAmount.toFixed(2)}.${event.denyReason ? ` ${event.denyReason}` : ""}`;
    return {
      kind: "process",
      body: {
        action: "approve",
        authCode: event.authNumber,
        agentNotes: `VRS AI partial approval (event ${event.eventId}): ${detail}`,
        technicianMessage: detail,
      },
    };
  }

  if (event.state === "denied") {
    return {
      kind: "process",
      body: {
        action: "reject",
        rejectionReasons: [event.denyReason],
        agentNotes: `VRS AI denial (event ${event.eventId}).`,
      },
    };
  }

  return { kind: "status_only" };
}

export async function processVrsAiWebhookEvent(options: {
  event: VrsWebhookEvent;
  store: Pick<
    VrsBridgeStore,
    | "getByProviderCallId"
    | "beginWebhookEvent"
    | "markWebhookApplied"
    | "markWebhookForwarded"
    | "markWebhookFailed"
  >;
  decryptCallbackSecret(encrypted: {
    cipher: string;
    iv: string;
    authTag: string;
    salt: string;
  }): string;
  applyResult(
    submissionId: number,
    event: VrsWebhookEvent,
  ): Promise<void>;
  forward(options: {
    callbackUrl: string;
    callbackSecret: string;
    event: VrsWebhookEvent;
  }): Promise<{ delivered: boolean; attempts: number; status?: number }>;
}): Promise<"processed" | "duplicate"> {
  const record = await options.store.getByProviderCallId(
    options.event.callId,
  );
  if (!record) {
    throw new Error(`Unknown VRS AI call id: ${options.event.callId}`);
  }
  if (
    record.requestPayload?.service_order &&
    record.requestPayload.service_order !== options.event.soNo
  ) {
    throw new Error(
      `VRS AI callback service order ${options.event.soNo} does not match bridge request ${record.requestPayload.service_order}`,
    );
  }

  const claim = await options.store.beginWebhookEvent(
    record.id,
    options.event,
  );
  if (claim.kind === "duplicate") {
    return "duplicate";
  }
  if (claim.kind === "in_progress") {
    throw new Error(`VRS AI event ${options.event.eventId} is already processing`);
  }

  try {
    if (!claim.alreadyApplied) {
      await options.applyResult(record.submissionId, options.event);
      await options.store.markWebhookApplied(
        record.id,
        options.event.eventId,
        options.event,
      );
    }

    const callbackSecret = options.decryptCallbackSecret({
      cipher: record.callbackSecretCipher ?? "",
      iv: record.callbackSecretIv ?? "",
      authTag: record.callbackSecretAuthTag ?? "",
      salt: record.callbackSecretSalt ?? "",
    });
    const delivery = await options.forward({
      callbackUrl: record.callbackUrl ?? "",
      callbackSecret,
      event: {
        ...options.event,
        callId: record.callId,
      },
    });
    await options.store.markWebhookForwarded(
      record.id,
      options.event.eventId,
      delivery,
    );
    if (!delivery.delivered) {
      throw new Error("Unable to forward VRS AI result to SASHA");
    }
    return "processed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await options.store.markWebhookFailed(
      record.id,
      options.event.eventId,
      message,
    );
    throw error;
  }
}
