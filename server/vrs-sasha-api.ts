import { timingSafeEqual } from "crypto";
import type { Express } from "express";
import {
  verifyVrsWebhookSignature,
  vrsAuthorizeRequestSchema,
  vrsWebhookEventSchema,
} from "./vrs-sasha-contract";

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
  receive(
    input: ReturnType<typeof vrsAuthorizeRequestSchema.parse>,
  ): Promise<ReceiveVrsIntakeResult>;
}

export function registerVrsSashaApi(
  app: Express,
  deps: { apiKey?: string; intake: VrsExpressIntake },
): void {
  app.post("/vrs/authorize", async (req, res) => {
    if (!deps.apiKey) {
      return res.status(503).json({
        error: "NOT_CONFIGURED",
        message: "VRS SASHA API key is not configured",
      });
    }

    const presented = req.header("x-api-key") ?? "";
    const expectedBuffer = Buffer.from(deps.apiKey);
    const presentedBuffer = Buffer.from(presented);
    const authenticated =
      expectedBuffer.length === presentedBuffer.length &&
      timingSafeEqual(expectedBuffer, presentedBuffer);

    if (!authenticated) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Invalid or missing API key",
      });
    }

    const parsed = vrsAuthorizeRequestSchema.safeParse(req.body);
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
