import { timingSafeEqual } from "crypto";
import type { Express } from "express";
import {
  vrsAuthorizeRequestSchema,
  type VrsAuthorizeRequest,
} from "./vrs-sasha-contract";

export type EnqueueVrsAiCallResult =
  | {
      kind: "queued";
      callId: string;
      serviceOrder: string;
      state: "queued";
      createdAt: Date;
    }
  | {
      kind: "duplicate";
      existingCallId: string;
      state: string;
    }
  | {
      kind: "rate_limited";
      scope: "tech" | "global";
      retryAfterSeconds: number;
    };

export interface VrsAiCallQueue {
  enqueue(input: VrsAuthorizeRequest): Promise<EnqueueVrsAiCallResult>;
}

export function registerVrsSashaApi(
  app: Express,
  deps: { apiKey?: string; queue: VrsAiCallQueue },
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
      const result = await deps.queue.enqueue(parsed.data);
      if (result.kind === "duplicate") {
        return res.status(409).json({
          error: "DUPLICATE_CALL",
          message: `A call is already in progress for service order ${parsed.data.service_order}`,
          existing_call_id: result.existingCallId,
          state: result.state,
        });
      }

      if (result.kind === "rate_limited") {
        const message =
          result.scope === "tech"
            ? `Tech ${parsed.data.tech_id} has exceeded 10 calls/hour`
            : "VRS has reached the 100 concurrent active call limit";
        return res.status(429).json({
          error: "RATE_LIMITED",
          message,
          retry_after_seconds: result.retryAfterSeconds,
        });
      }

      return res.status(202).json({
        call_id: result.callId,
        service_order: result.serviceOrder,
        state: result.state,
        created_at: result.createdAt.toISOString(),
      });
    } catch (error) {
      console.error(
        "[vrs-sasha] Failed to queue authorization call:",
        error instanceof Error ? error.message : String(error),
      );
      return res.status(500).json({
        error: "INTERNAL",
        message: "Unable to queue authorization call",
      });
    }
  });
}
