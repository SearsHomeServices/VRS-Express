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

const nonblankText = (field: string, max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, `${field} is required`);

const nonblankString = (field: string) =>
  z
    .string()
    .refine((value) => value.trim().length > 0, `${field} is required`);

const money = z
  .number()
  .finite()
  .nonnegative()
  .max(1_000_000)
  .multipleOf(0.01, "USD amounts must have at most two decimal places");

const vrsV5PartSchema = z
  .object({
    part_id: requiredText("part_id", 100),
    part_description: requiredText("part_description", 500),
    sell_price: money,
    part_function: requiredText("part_function", 200),
  })
  .strict();

const vrsV5CommentSchema = z
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

const vrsAuthorizeV5RequestShape = {
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
    parts: z.array(vrsV5PartSchema).min(1),
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
    comments: z.array(vrsV5CommentSchema).max(20).optional(),
};

const vrsAuthorizeV5ShapeSchema = z.object(vrsAuthorizeV5RequestShape);

export const vrsAuthorizeV5RequestSchema = vrsAuthorizeV5ShapeSchema
  .passthrough()
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (!(key in vrsAuthorizeV5RequestShape)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Unrecognized field: ${key}`,
        });
      }
    }
  });

// Keep the original export bound to V5 until callers move to the explicit
// version-aware parser. This preserves the existing V5 route behavior.
export const vrsAuthorizeRequestSchema = vrsAuthorizeV5RequestSchema;

const vrsV8PartSchema = z
  .object({
    part_id: nonblankText("part_id", 100),
    part_description: nonblankText("part_description", 500),
    sell_price: money,
    part_function: z.string().max(200),
  })
  .strict();

const vrsV8CommentSchema = z
  .object({
    tech_id: nonblankText("comments[].tech_id", 50),
    work_item: z.enum([
      "failure_diagnosis",
      "tech_recommendation",
      "appliance_features",
      "customer_history",
      "tech_observation",
      "other",
    ]),
    text: nonblankText("comments[].text", 2_000),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();

const vrsAuthorizeV8RequestShape = {
  service_order: z.string().regex(/^\d{8}$/, "service_order must be 8 digits"),
  tech_id: nonblankText("tech_id", 50),
  tech_phone: z.union([
    z.string().regex(/^\+[1-9]\d{7,14}$/, "tech_phone must use E.164 format"),
    z.literal("N/A"),
  ]),
  tech_name: z.string().max(255),
  reason_for_call: z.literal("authorization"),
  callback_url: z
    .string()
    .url()
    .refine(
      isAllowedVrsCallbackUrl,
      "callback_url must be a confirmed SASHA webhook URL",
    ),
  callback_secret: z.string().min(16).max(512),
  parts: z.array(vrsV8PartSchema).min(1),
  customer_name: z.string().max(255),
  customer_address: nonblankText("customer_address", 1_000),
  service_address: nonblankText("service_address", 1_000),
  brand: nonblankText("brand", 100),
  model_number: nonblankText("model_number", 100),
  serial_number: nonblankText("serial_number", 100),
  appliance_type: nonblankText("appliance_type", 100),
  appliance_age: z.number().finite().nonnegative().max(100),
  labor_amount: money,
  tax_amount: money,
  part_price: money,
  appliance_location: nonblankText("appliance_location", 100),
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
  repair_replace_rationale: z.string(),
  appliance_grade: z.enum(["entry", "mid", "top", "N/A"]),
  partner_id: nonblankText("partner_id", 50),
  appliance_photos: z.array(z.string().url()).max(10),
  comments: z.array(vrsV8CommentSchema).max(20),
  appliance_color: nonblankText("appliance_color", 40),
  contract_number: nonblankString("contract_number"),
  purchase_year: z.union([
    z.number().int().positive(),
    z.literal("TBD"),
    z.literal("N/A"),
  ]),
  symptom: nonblankString("symptom"),
};

export const vrsAuthorizeV8RequestSchema = z
  .object(vrsAuthorizeV8RequestShape)
  .strict();

const vrsAuthorizeV9RequestShape = {
  ...vrsAuthorizeV8RequestShape,
  cta_no: nonblankString("cta_no"),
  district_number: z.union([
    z.string().regex(/^\d{4}$/, "district_number must be 4 digits"),
    z.literal("N/A"),
  ]),
};

export const vrsAuthorizeV9RequestSchema = z
  .object(vrsAuthorizeV9RequestShape)
  .strict()
  .superRefine((value, context) => {
    if (value.cta_no !== value.contract_number) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cta_no"],
        message: "cta_no must match contract_number",
      });
    }
  });

export const VRS_V8_ONLY_KEYS = [
  "appliance_color",
  "contract_number",
  "purchase_year",
  "symptom",
] as const;

export const VRS_V9_ONLY_KEYS = ["cta_no", "district_number"] as const;

export type VrsAuthorizeContractVersion = "v5" | "v8" | "v9";
export type VrsAuthorizeV5Request = z.infer<typeof vrsAuthorizeV5ShapeSchema>;
export type VrsAuthorizeV8Request = z.infer<typeof vrsAuthorizeV8RequestSchema>;
export type VrsAuthorizeV9Request = z.infer<typeof vrsAuthorizeV9RequestSchema>;
export type VrsAuthorizeRequest =
  | VrsAuthorizeV5Request
  | VrsAuthorizeV8Request
  | VrsAuthorizeV9Request;

export function getVrsAuthorizeContractVersion(
  input: unknown,
): VrsAuthorizeContractVersion {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "v5";
  }

  if (
    VRS_V9_ONLY_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(input, key)
    )
  ) {
    return "v9";
  }

  return VRS_V8_ONLY_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(input, key)
  ) ? "v8" : "v5";
}

export function safeParseVrsAuthorizeRequest(input: unknown):
  | {
      success: true;
      version: VrsAuthorizeContractVersion;
      data: VrsAuthorizeRequest;
    }
  | {
      success: false;
      version: VrsAuthorizeContractVersion;
      error: z.ZodError;
    } {
  const version = getVrsAuthorizeContractVersion(input);
  const parsed = version === "v9"
    ? vrsAuthorizeV9RequestSchema.safeParse(input)
    : version === "v8"
      ? vrsAuthorizeV8RequestSchema.safeParse(input)
      : vrsAuthorizeV5RequestSchema.safeParse(input);

  return parsed.success
    ? { success: true, version, data: parsed.data }
    : { success: false, version, error: parsed.error };
}

const cleanHttpsUrl = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}, "callback_url must be a clean HTTPS URL");

const vrsV5OutboundSourceRequestShape = {
  ...vrsAuthorizeV5RequestShape,
  // The inbound schema above deliberately pins this to SASHA. Once Express
  // owns the callback, retries may already contain the Express URL, so the
  // outbound client validates the trusted replacement separately below.
  callback_url: cleanHttpsUrl,
};

const vrsAuthorizeV5OutboundSourceSchema = z
  .object(vrsV5OutboundSourceRequestShape)
  .passthrough()
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (!(key in vrsV5OutboundSourceRequestShape)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Unrecognized field: ${key}`,
        });
      }
    }
  });

const vrsAuthorizeV8OutboundSourceSchema = z
  .object({
    ...vrsAuthorizeV8RequestShape,
    callback_url: cleanHttpsUrl,
  })
  .strict();

const vrsAuthorizeV9OutboundSourceSchema = z
  .object({
    ...vrsAuthorizeV9RequestShape,
    callback_url: cleanHttpsUrl,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cta_no !== value.contract_number) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cta_no"],
        message: "cta_no must match contract_number",
      });
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
      partId: requiredText("partId", 100).optional(),
      techId: requiredText("techId", 50).optional(),
      partDescription: requiredText("partDescription", 2_000).optional(),
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

export function normalizeVrsProviderState(state: unknown): string {
  const active = ["queued","dialing","connected","awaiting_decision","requires_info","in_progress","reviewing"];
  return typeof state === "string" && active.includes(state) ? state : "queued";
}

export async function sendVrsAuthorizeRequest(options: {
  baseUrl: string;
  apiKey: string;
  callbackUrl: string;
  callbackSecret: string;
  payload: VrsAuthorizeRequest;
  fetchImpl?: typeof fetch;
}): Promise<VrsAiAuthorizeResult> {
  const sourceVersion = getVrsAuthorizeContractVersion(options.payload);
  const sourcePayload = sourceVersion === "v9"
    ? vrsAuthorizeV9OutboundSourceSchema.parse(options.payload)
    : sourceVersion === "v8"
      ? vrsAuthorizeV8OutboundSourceSchema.parse(options.payload)
      : vrsAuthorizeV5OutboundSourceSchema.parse(options.payload);
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
        state: normalizeVrsProviderState(body.state),
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
        state: normalizeVrsProviderState(body.state),
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
        const body = await response.text();
        // Preserve the documented empty-200 legacy acknowledgment. Explicit
        // HTML, error bodies and conflicting event IDs are never receipts.
        let acknowledged = !body.trim() && !response.headers.get("content-type")?.includes("text/html");
        if (body.trim()) {
          try {
            const ack = JSON.parse(body);
            acknowledged = Boolean(ack && typeof ack === "object" && !Array.isArray(ack) && !ack.error && ack.ok !== false &&
              (ack.eventId === undefined || ack.eventId === event.eventId) &&
              (ack.event_id === undefined || ack.event_id === event.eventId));
          } catch { acknowledged = false; }
        }
        return { delivered: acknowledged, attempts: attempt, status: response.status };
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
