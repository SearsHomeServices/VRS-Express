import { timingSafeEqual } from "crypto";
import type { Express, Request, Response } from "express";
import {
  getVrsAuthorizeContractVersion,
  safeParseVrsAuthorizeRequest,
  verifyVrsWebhookSignature,
  vrsWebhookEventSchema,
} from "./vrs-sasha-contract";
import type { VrsAuthorizeRequest } from "./vrs-sasha-contract";
import {
  buildVrsAuthorizeEnrichmentCandidates,
  projectVrsBridgeReviewContext,
  resolveVrsPhotoUrls,
} from "./vrs-sasha-queue";
import type { VrsServiceOrderReader } from "./vrs-sasha-store";

export type ReceiveVrsIntakeResult =
  | {
      kind: "accepted";
      callId: string;
      serviceOrder: string;
      createdAt: Date;
    }
  | {
      kind: "duplicate";
      existingCallId: string;
      state: string;
    }
  | {
      kind: "unsupported_partner";
      partnerId: string;
    }
  | {
      kind: "rejected";
      status: 409 | 422;
      code: string;
      message: string;
    };

export interface VrsExpressIntake {
  receive(input: VrsAuthorizeRequest): Promise<ReceiveVrsIntakeResult>;
}

interface RegisterVrsSashaApiDependencies {
  apiKey?: string;
  intake: VrsExpressIntake;
  serviceOrders?: VrsServiceOrderReader;
  signObjectPhotoUrl?: (objectPath: string) => Promise<string>;
  now?: () => Date;
}

function authenticateVrsSashaApiKey(
  req: Request,
  res: Response,
  apiKey?: string,
): boolean {
  if (!apiKey) {
    res.status(503).json({
      error: "NOT_CONFIGURED",
      message: "VRS SASHA API key is not configured",
    });
    return false;
  }

  const presented = req.header("x-api-key") ?? "";
  const expectedBuffer = Buffer.from(apiKey);
  const presentedBuffer = Buffer.from(presented);
  const authenticated =
    expectedBuffer.length === presentedBuffer.length &&
    timingSafeEqual(expectedBuffer, presentedBuffer);

  if (!authenticated) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Invalid or missing API key",
    });
    return false;
  }

  return true;
}

export function registerVrsSashaApi(
  app: Express,
  deps: RegisterVrsSashaApiDependencies,
): void {
  app.post("/vrs/authorize", async (req, res) => {
    if (!authenticateVrsSashaApiKey(req, res, deps.apiKey)) {
      return;
    }

    const parsed = safeParseVrsAuthorizeRequest(req.body);
    if (!parsed.success) {
      const fields = Array.from(
        new Set(
          parsed.error.issues.map((issue) =>
            issue.path.length > 0 ? String(issue.path[0]) : "body",
          ),
        ),
      );
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid request body",
        fields,
      });
    }

    try {
      const result = await deps.intake.receive(parsed.data);
      if (result.kind === "duplicate") {
        return res.status(409).json({
          error: "DUPLICATE_CALL",
          message: `A call is already in progress for service order ${parsed.data.service_order}`,
          existing_call_id: result.existingCallId,
          state: "in_progress",
        });
      }

      if (result.kind === "unsupported_partner") {
        return res.status(422).json({
          error: "UNSUPPORTED_PARTNER",
          message:
            "Phase 1 VRS AI phone automation supports American Home Shield only",
          partner_id: result.partnerId,
        });
      }

      if (result.kind === "rejected") {
        return res.status(result.status).json({
          error: result.code,
          message: result.message,
        });
      }

      return res.status(202).json({
        call_id: result.callId,
        service_order: result.serviceOrder,
        state: "queued",
        created_at: result.createdAt.toISOString(),
      });
    } catch (error) {
      console.error(
        "[vrs-sasha] Failed to create Express authorization intake:",
        error instanceof Error ? error.message : String(error),
      );
      return res.status(500).json({
        error: "INTERNAL",
        message: "Unable to create VRS Express authorization intake",
      });
    }
  });

  app.get(
    "/api/integrations/vrs-ai/v1/service-orders/:serviceOrder",
    async (req, res) => {
      if (!authenticateVrsSashaApiKey(req, res, deps.apiKey)) {
        return;
      }
      if (!deps.serviceOrders) {
        return res.status(503).json({
          error: "NOT_CONFIGURED",
          message: "VRS service-order lookup is not configured",
        });
      }

      const serviceOrder = req.params.serviceOrder;
      if (!/^\d{8}$/.test(serviceOrder)) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "service_order must be 8 digits",
          fields: ["service_order"],
        });
      }

      let source;
      try {
        source = await deps.serviceOrders.getLatestByServiceOrder(
          serviceOrder,
        );
      } catch (error) {
        console.error(
          "[vrs-sasha] Failed to load service-order data:",
          error instanceof Error ? error.message : String(error),
        );
        return res.status(500).json({
          error: "INTERNAL",
          message: "Unable to load service-order data",
        });
      }
      if (!source) {
        return res.status(404).json({
          error: "SERVICE_ORDER_NOT_FOUND",
          message: `No VRS Express bridge request was found for service order ${serviceOrder}`,
        });
      }

      const requestPhotos = Array.isArray(
          source.requestPayload.appliance_photos,
        )
        ? source.requestPayload.appliance_photos.filter(
          (value): value is string => typeof value === "string",
        )
        : [];
      const submissionPhotos = buildVrsAuthorizeEnrichmentCandidates({
        submissionPhotos: source.submissionPhotos,
      }).appliancePhotos ?? [];

      let resolvedPhotos;
      try {
        resolvedPhotos = await resolveVrsPhotoUrls(
          [...requestPhotos, ...submissionPhotos],
          deps.signObjectPhotoUrl,
        );
      } catch (error) {
        console.error(
          "[vrs-sasha] Failed to generate service-order photo URLs:",
          error instanceof Error ? error.message : String(error),
        );
        return res.status(502).json({
          error: "PHOTO_URL_GENERATION_FAILED",
          message: "Unable to generate photo download URLs",
        });
      }

      const reviewContext = projectVrsBridgeReviewContext(
        source.requestPayload,
      );
      const {
        appliance_photos: _appliancePhotos,
        ...serviceOrderInfo
      } = reviewContext;
      const now = (deps.now ?? (() => new Date()))();

      return res.status(200).json({
        service_order: serviceOrder,
        call_id: source.callId,
        state: source.state,
        contract_version: getVrsAuthorizeContractVersion(
          source.requestPayload,
        ),
        service_order_info: serviceOrderInfo,
        appliance_photos: resolvedPhotos.urls,
        photo_urls_expire_at: resolvedPhotos.signedObjectPhoto
          ? new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString()
          : null,
      });
    },
  );
}

export interface VrsAiWebhookSink {
  receive(
    event: ReturnType<typeof vrsWebhookEventSchema.parse>,
  ): Promise<"processed" | "duplicate">;
}

export function registerVrsAiWebhookApi(
  app: Express,
  deps: { webhookSecret?: string; sink: VrsAiWebhookSink },
): void {
  app.post(
    "/api/integrations/vrs-ai/v1/webhook",
    async (req, res) => {
      if (!deps.webhookSecret) {
        return res.status(503).json({
          error: "NOT_CONFIGURED",
          message: "VRS AI webhook secret is not configured",
        });
      }

      const rawBody = Buffer.isBuffer(req.rawBody)
        ? req.rawBody
        : Buffer.from(JSON.stringify(req.body));
      const signature = req.header("x-vrs-signature") ?? "";
      if (
        !verifyVrsWebhookSignature(
          rawBody,
          signature,
          deps.webhookSecret,
        )
      ) {
        return res.status(401).json({
          error: "INVALID_SIGNATURE",
          message: "Invalid VRS AI webhook signature",
        });
      }

      const timestampHeader = req.header("x-vrs-timestamp") ?? "";
      const timestamp = Number(timestampHeader);
      if (
        !/^\d+$/.test(timestampHeader) ||
        !Number.isSafeInteger(timestamp) ||
        Math.abs(Date.now() - timestamp) > 5 * 60_000
      ) {
        return res.status(401).json({
          error: "TIMESTAMP_OUT_OF_WINDOW",
          message: "X-VRS-Timestamp must be within five minutes of server time",
        });
      }

      const parsed = vrsWebhookEventSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message:
            parsed.error.issues[0]?.message ?? "Invalid webhook payload",
        });
      }

      const eventIdHeader = req.header("x-vrs-event-id");
      if (!eventIdHeader || eventIdHeader !== parsed.data.eventId) {
        return res.status(400).json({
          error: "EVENT_ID_MISMATCH",
          message: "X-VRS-Event-Id does not match the webhook body",
        });
      }

      try {
        const outcome = await deps.sink.receive(parsed.data);
        return res.status(200).json({
          ok: true,
          eventId: parsed.data.eventId,
          deduped: outcome === "duplicate",
        });
      } catch (error) {
        console.error(
          "[vrs-ai-webhook] Failed to apply callback:",
          error instanceof Error ? error.message : String(error),
        );
        return res.status(500).json({
          error: "INTERNAL",
          message: "Unable to apply VRS AI webhook",
        });
      }
    },
  );
}
