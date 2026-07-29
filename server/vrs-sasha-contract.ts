import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";

export const VRS_SASHA_CALLBACK_HOSTS = new Set([
  "sasha.prod.nextgen.shs.com",
  "sasha-dev.stage.nextgen.shs.com",
]);

export function isAllowedVrsCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      VRS_SASHA_CALLBACK_HOSTS.has(url.hostname) &&
      url.pathname === "/sasha/api/vrs/webhook" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

const requiredText = (field: string, max: number) =>
  z.string().trim().min(1, `${field} is required`).max(max);

const money = z
  .number()
  .finite()
  .nonnegative()
  .max(1_000_000)
  .multipleOf(0.01, "USD amounts must have at most two decimal places");

const vrsPartSchema = z
  .object({
    part_id: requiredText("part_id", 100),
    part_description: requiredText("part_description", 500),
    sell_price: money,
    part_function: requiredText("part_function", 200),
  })
  .strict();

const vrsCommentSchema = z
  .object({
    tech_id: requiredText("comments[].tech_id", 50),
    work_item: z.enum([
      "failure_diagnosis",
      "tech_recommendation",
      "appliance_features",
      "customer_history",
      "tech_observation",
      "other",
    ]),
    text: requiredText("comments[].text", 2_000),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();

const vrsAuthorizeRequestShape = {
    service_order: z.string().regex(/^\d{8}$/, "service_order must be 8 digits"),
    tech_id: requiredText("tech_id", 50),
    tech_phone: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, "tech_phone must use E.164 format"),
    tech_name: requiredText("tech_name", 255),
    reason_for_call: z.literal("authorization"),
    callback_url: z
      .string()
      .url()
      .refine(
        isAllowedVrsCallbackUrl,
        "callback_url must be a confirmed SASHA webhook URL",
      ),
    callback_secret: z.string().min(16).max(512),
    parts: z.array(vrsPartSchema).min(1),
    customer_name: requiredText("customer_name", 255),
    customer_address: requiredText("customer_address", 1_000),
    service_address: requiredText("service_address", 1_000),
    brand: requiredText("brand", 100),
    model_number: requiredText("model_number", 100),
    serial_number: requiredText("serial_number", 100),
    appliance_type: requiredText("appliance_type", 100),
    appliance_age: z.number().finite().nonnegative().max(100),
    labor_amount: money,
    tax_amount: money,
    part_price: money,
    appliance_location: requiredText("appliance_location", 100),
    failure_cause: z.enum([
      "normal-wear",
      "power-surge",
      "impact",
      "installation-error",
      "abuse",
      "age",
      "other",
    ]),
    tech_recommendation: z.enum(["repair", "replace"]),
    repair_replace_rationale: z
      .string()
      .trim()
      .min(1, "repair_replace_rationale is required"),
    appliance_grade: z.enum(["entry", "mid", "top"]).optional(),
    partner_id: requiredText("partner_id", 50).optional(),
    appliance_photos: z.array(z.string().url()).max(10).optional(),
    comments: z.array(vrsCommentSchema).max(20).optional(),
};

export const vrsAuthorizeRequestSchema = z
  .object(vrsAuthorizeRequestShape)
  .passthrough()
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (!(key in vrsAuthorizeRequestShape)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Unrecognized field: ${key}`,
        });
      }
    }
  });

export type VrsAuthorizeRequest = z.infer<typeof vrsAuthorizeRequestSchema>;

const vrsOutboundSourceRequestShape = {
  ...vrsAuthorizeRequestShape,
  // The inbound schema above deliberately pins this to SASHA. Once Express
  // owns the callback, retries may already contain the Express URL, so the
  // outbound client validates the trusted replacement separately below.
  callback_url: z.string().url(),
};

const vrsOutboundSourceRequestSchema = z
  .object(vrsOutboundSourceRequestShape)
  .passthrough()
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (!(key in vrsOutboundSourceRequestShape)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Unrecognized field: ${key}`,
        });
      }
    }
  });

export function isValidVrsExpressCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === "/api/integrations/vrs-ai/v1/webhook" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

const webhookEnvelope = {
  version: z.literal(1),
  eventId: requiredText("eventId", 100),
  callId: requiredText("callId", 100),
  soNo: z.string().regex(/^\d{8}$/),
  occurredAt: z.string().datetime({ offset: true }),
};

const terminalRecordingFields = {
  durationSec: z.number().int().nonnegative().optional(),
  recordingUrl: z.string().url().optional(),
};

export const vrsWebhookEventSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...webhookEnvelope,
      state: z.literal("approved"),
      authNumber: requiredText("authNumber", 100),
      authorizedAmount: money,
      ...terminalRecordingFields,
    })
    .strict(),
  z
    .object({
      ...webhookEnvelope,
      state: z.literal("denied"),
      denyReason: requiredText("denyReason", 2_000),
      ...terminalRecordingFields,
    })
    .strict(),
  z
    .object({
      ...webhookEnvelope,
      state: z.literal("partial"),
      authNumber: requiredText("authNumber", 100),
      authorizedAmount: money,
      requestedAmount: money,
      denyReason: requiredText("denyReason", 2_000).optional(),
      ...terminalRecordingFields,
    })
    .strict(),
  z
    .object({
      ...webhookEnvelope,
      state: z.literal("failed"),
      reason: z.enum([
        "busy",
        "no_answer",
        "ivr_error",
        "agent_error",
        "timeout",
        "aborted",
      ]),
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...webhookEnvelope,
      state: z.literal("requires_info"),
      question: requiredText("question", 2_000),
      field: requiredText("field", 100),
      urgency: z.enum(["soft", "hard"]),
    })
    .strict(),
]);

export type VrsWebhookEvent = z.infer<typeof vrsWebhookEventSchema>;

export function createVrsWebhookSignature(
  rawBody: string,
  secret: string,
): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifyVrsWebhookSignature(
  rawBody: string | Buffer,
  presentedSignature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(
    createVrsWebhookSignature(
      typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"),
      secret,
    ),
  );
  const presented = Buffer.from(presentedSignature);
  return (
    expected.length === presented.length &&
    timingSafeEqual(expected, presented)
  );
}

export type VrsAiAuthorizeResult =
  | {
      kind: "accepted";
      callId: string;
      state: string;
      duplicate: boolean;
    }
  | {
      kind: "rate_limited";
      retryAfterSeconds: number;
      message: string;
    }
  | {
      kind: "failed";
      status?: number;
      message: string;
    };

export async function sendVrsAuthorizeRequest(options: {
  baseUrl: string;
  apiKey: string;
  callbackUrl: string;
  callbackSecret: string;
  payload: VrsAuthorizeRequest;
  fetchImpl?: typeof fetch;
}): Promise<VrsAiAuthorizeResult> {
  const sourcePayload = vrsOutboundSourceRequestSchema.parse(options.payload);
  const baseUrl = new URL(options.baseUrl);
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error("VRS AI base URL must be a clean HTTPS origin");
  }

  const callbackUrl = new URL(options.callbackUrl);
  if (
    !isValidVrsExpressCallbackUrl(callbackUrl.toString())
  ) {
    throw new Error(
      "VRS Express callback URL must be the clean HTTPS VRS AI webhook route",
    );
  }

  const outboundPayload: VrsAuthorizeRequest = {
    ...sourcePayload,
    callback_url: callbackUrl.toString(),
    callback_secret: options.callbackSecret,
  };
  const endpoint = new URL("/vrs/authorize", baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": options.apiKey,
      },
      body: JSON.stringify(outboundPayload),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response
      .json()
      .catch(() => ({} as Record<string, unknown>)) as Record<
      string,
      unknown
    >;

    if (response.status === 202) {
      if (typeof body.call_id !== "string" || !body.call_id) {
        return {
          kind: "failed",
          status: response.status,
          message: "VRS AI returned 202 without call_id",
        };
      }
      return {
        kind: "accepted",
        callId: body.call_id,
        state: typeof body.state === "string" ? body.state : "queued",
        duplicate: false,
      };
    }

    if (response.status === 409) {
      if (
        typeof body.existing_call_id !== "string" ||
        !body.existing_call_id
      ) {
        return {
          kind: "failed",
          status: response.status,
          message: "VRS AI returned 409 without existing_call_id",
        };
      }
      return {
        kind: "accepted",
        callId: body.existing_call_id,
        state: typeof body.state === "string" ? body.state : "in_progress",
        duplicate: true,
      };
    }

    if (response.status === 429) {
      return {
        kind: "rate_limited",
        retryAfterSeconds:
          typeof body.retry_after_seconds === "number"
            ? body.retry_after_seconds
            : 60,
        message:
          typeof body.message === "string"
            ? body.message
            : "VRS AI rate limit reached",
      };
    }

    return {
      kind: "failed",
      status: response.status,
      message:
        typeof body.message === "string"
          ? body.message
          : `VRS AI request failed with HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function deliverVrsWebhook(options: {
  callbackUrl: string;
  callbackSecret: string;
  event: VrsWebhookEvent;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<{
  delivered: boolean;
  attempts: number;
  status?: number;
}> {
  if (!isAllowedVrsCallbackUrl(options.callbackUrl)) {
    throw new Error("Refusing webhook delivery to an unapproved callback URL");
  }

  const event = vrsWebhookEventSchema.parse(options.event);
  const rawBody = JSON.stringify(event);
  const signature = createVrsWebhookSignature(
    rawBody,
    options.callbackSecret,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const retryableStatuses = new Set([500, 502, 503]);
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(options.callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VRS-Signature": signature,
          "X-VRS-Event-Id": event.eventId,
          "X-VRS-Timestamp": String(now()),
        },
        body: rawBody,
        signal: AbortSignal.timeout(15_000),
      });

      if (response.status === 200) {
        return { delivered: true, attempts: attempt, status: response.status };
      }

      if (!retryableStatuses.has(response.status) || attempt === maxAttempts) {
        return {
          delivered: false,
          attempts: attempt,
          status: response.status,
        };
      }
    } catch {
      if (attempt === maxAttempts) {
        return { delivered: false, attempts: attempt };
      }
    }

    await sleep(1_000 * 2 ** (attempt - 1));
  }

  return { delivered: false, attempts: maxAttempts };
}
