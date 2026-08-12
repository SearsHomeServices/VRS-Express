import type {
  VrsAiAuthorizeResult,
  VrsAuthorizeRequest,
  VrsAuthorizeV8Request,
  VrsWebhookEvent,
} from "./vrs-sasha-contract";
import {
  getVrsAuthorizeContractVersion,
  safeParseVrsAuthorizeRequest,
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
  operational?: VrsSubmissionOperationalValues,
): {
  serviceOrder: string;
  applianceType: VrsExpressApplianceDivision;
  requestType: "authorization";
  warrantyType: "american_home_shield";
  warrantyProvider: "American Home Shield";
  issueDescription: string;
  estimateAmount: string;
  partNumbers: string;
  phone: string;
} {
  if (!/^\d{4}$/.test(districtCode)) {
    throw new Error("Technician district must be exactly four digits");
  }

  const rationale = payload.repair_replace_rationale.trim();
  const symptom = "symptom" in payload ? payload.symptom.trim() : "";
  const comment = payload.comments
    ?.find((entry) => entry.text.trim().length > 0)
    ?.text.trim() ?? "";
  const issueDescription = rationale ||
    (symptom && symptom !== "N/A" ? symptom : "") ||
    comment ||
    (payload.failure_cause !== "other" ? payload.failure_cause : "") ||
    "Authorization review requested";
  const resolvedPhone = operational?.technicianPhone?.trim();
  const phone = payload.tech_phone === "N/A"
    ? resolvedPhone && resolvedPhone !== "N/A"
      ? resolvedPhone
      : ""
    : payload.tech_phone;

  return {
    serviceOrder: `${districtCode}-${payload.service_order}`,
    applianceType: mapVrsApplianceType(payload.appliance_type),
    requestType: "authorization" as const,
    warrantyType: "american_home_shield" as const,
    warrantyProvider: "American Home Shield",
    issueDescription,
    estimateAmount: (
      payload.labor_amount +
      payload.tax_amount +
      payload.part_price
    ).toFixed(2),
    partNumbers: JSON.stringify(payload.parts.map((part) => part.part_id)),
    phone,
  };
}

export interface VrsSubmissionOperationalValues {
  technicianPhone?: string | null;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<keyof T, K>>
  : never;

export type VrsStoredAuthorizeRequest = DistributiveOmit<
  VrsAuthorizeRequest,
  "callback_secret"
>;

export type VrsBridgeReviewContext = DistributiveOmit<
  VrsAuthorizeRequest,
  "callback_url" | "callback_secret"
>;

export function projectVrsBridgeIntake(
  payload: VrsAuthorizeRequest,
  districtCode: string,
  operational?: VrsSubmissionOperationalValues,
): {
  operationalPhone: string;
  requestPayload: VrsStoredAuthorizeRequest;
  submissionBody: ReturnType<typeof mapVrsPayloadToSubmission>;
} {
  const submissionBody = mapVrsPayloadToSubmission(
    payload,
    districtCode,
    operational,
  );
  const { callback_secret: _callbackSecret, ...requestPayload } = payload;
  return {
    operationalPhone: submissionBody.phone,
    requestPayload: requestPayload as VrsStoredAuthorizeRequest,
    submissionBody,
  };
}

export function projectVrsBridgeReviewContext(
  payload:
    | VrsAuthorizeRequest
    | VrsStoredAuthorizeRequest,
): VrsBridgeReviewContext {
  const {
    callback_url: _callbackUrl,
    ...reviewContext
  } = payload;
  const {
    callback_secret: _callbackSecret,
    ...safeReviewContext
  } = reviewContext as VrsAuthorizeRequest;
  return safeReviewContext as VrsBridgeReviewContext;
}

export interface VrsAuthorizeEnrichment {
  techPhone?: string | null;
  techName?: string | null;
  appliancePhotos?: string[] | null;
}

export function buildVrsAuthorizeEnrichmentCandidates(input: {
  submissionPhone?: string | null;
  technicianName?: string | null;
  submissionPhotos?: string | null;
}): VrsAuthorizeEnrichment {
  let appliancePhotos: string[] = [];
  if (input.submissionPhotos) {
    try {
      const parsed = JSON.parse(input.submissionPhotos) as unknown;
      if (Array.isArray(parsed)) {
        appliancePhotos = parsed.filter(
          (value): value is string => typeof value === "string",
        );
      } else if (parsed && typeof parsed === "object") {
        appliancePhotos = Object.values(parsed)
          .flatMap((value) => Array.isArray(value) ? value : [])
          .filter((value): value is string => typeof value === "string");
      }
    } catch {
      appliancePhotos = [];
    }
  }
  return {
    techPhone: input.submissionPhone,
    techName: input.technicianName,
    appliancePhotos,
  };
}

const E164_PHONE = /^\+[1-9]\d{7,14}$/;

function isDispatchablePhotoUrl(value: string): boolean {
  if (value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname.length > 0 &&
      url.hash === "" &&
      url.pathname !== "/objects" &&
      !url.pathname.startsWith("/objects/");
  } catch {
    return false;
  }
}

export function enrichVrsAuthorizeForDispatch(
  payload: VrsAuthorizeRequest,
  enrichment: VrsAuthorizeEnrichment,
): VrsAuthorizeRequest {
  if (getVrsAuthorizeContractVersion(payload) === "v5") return payload;

  const enriched = { ...payload } as VrsAuthorizeV8Request;
  if (
    enriched.tech_phone === "N/A" &&
    typeof enrichment.techPhone === "string" &&
    E164_PHONE.test(enrichment.techPhone)
  ) {
    enriched.tech_phone = enrichment.techPhone;
  }
  if (
    enriched.tech_name === "" &&
    typeof enrichment.techName === "string" &&
    enrichment.techName.trim().length > 0 &&
    enrichment.techName.length <= 255
  ) {
    enriched.tech_name = enrichment.techName;
  }
  if (
    enriched.appliance_photos.length === 0 &&
    Array.isArray(enrichment.appliancePhotos)
  ) {
    enriched.appliance_photos = enrichment.appliancePhotos
      .filter(isDispatchablePhotoUrl)
      .slice(0, 10);
  }

  return enriched;
}

export interface VrsBridgeRecord {
  id: number;
  submissionId: number;
  callId: string;
  providerCallId?: string | null;
  state: string;
  dispatchError?: string | null;
  dispatchedAt?: Date | null;
  requestPayload: VrsStoredAuthorizeRequest;
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
  enrichment?: VrsAuthorizeEnrichment;
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

  let result: VrsAiAuthorizeResult;
  try {
    const sourcePayload = {
      ...record.requestPayload,
      callback_secret: "stored-callback-secret-redacted",
    } as VrsAuthorizeRequest;
    const sourceVersion = getVrsAuthorizeContractVersion(sourcePayload);
    const enrichedPayload = enrichVrsAuthorizeForDispatch(
      sourcePayload,
      options.enrichment ?? {},
    );
    const revalidated = safeParseVrsAuthorizeRequest(enrichedPayload);
    if (!revalidated.success || revalidated.version !== sourceVersion) {
      const fields = revalidated.success
        ? "contract version"
        : revalidated.error.issues
          .map((issue) => issue.path.join(".") || "body")
          .join(", ");
      throw new Error(
        `Stored VRS ${sourceVersion.toUpperCase()} payload failed revalidation: ${fields}`,
      );
    }
    const payload = {
      ...enrichedPayload,
      callback_url: options.callbackUrl,
      callback_secret: options.callbackSecret,
    } as VrsAuthorizeRequest;
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
