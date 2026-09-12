import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  createExecSummaryGenerateHandler,
  createExecSummaryHistoryHandler,
  createExecSummarySendHandler,
} from "../server/routes";

describe("executive summary admin mutation routes", () => {
  it("keeps generate-only separate from sending the generated report", async () => {
    const generated = { id: 42, generatedAt: new Date("2026-09-16T20:00:00.000Z"), summary: { submissions: 3 } };
    const generateAndSendExecSummary = vi.fn(async (options: { send?: boolean }) => {
      expect(options.send).toBe(false);
      return { report: generated, email: null, delivery: null };
    });
    const retryExecSummaryDelivery = vi.fn(async (reportId: number, options: { resend: boolean; requestKey: string }) => ({
      action: "accepted",
      delivery: {
        reportId,
        state: "accepted",
        attemptCount: 1,
        providerMessageId: "provider-42",
        requestKey: options.requestKey,
      },
    }));
    const app = express();
    app.use(express.json());
    app.post(
      "/run",
      createExecSummaryGenerateHandler({ generateAndSendExecSummary }),
    );
    app.post(
      "/send",
      createExecSummarySendHandler({
        getLatestExecSummaries: async () => [generated],
        retryExecSummaryDelivery,
      }),
    );

    const generatedResponse = await request(app)
      .post("/run")
      .send({ send: false });
    expect(generatedResponse.status).toBe(200);
    expect(generatedResponse.body).toMatchObject({
      report: { id: 42 },
      delivery: null,
    });
    expect(retryExecSummaryDelivery).not.toHaveBeenCalled();

    const sentResponse = await request(app)
      .post("/send")
      .send({ requestKey: "generate-then-send", resend: false });
    expect(sentResponse.status).toBe(200);
    expect(sentResponse.body).toMatchObject({
      reportId: 42,
      action: "accepted",
      delivery: { state: "accepted", providerMessageId: "provider-42" },
    });
    expect(retryExecSummaryDelivery).toHaveBeenCalledWith(42, {
      resend: false,
      requestKey: "generate-then-send",
    });
  });

  it("passes one explicit resend key through concurrent requests for deduplication", async () => {
    const calls: string[] = [];
    const inFlight = new Map<string, Promise<{ action: string; delivery: { state: string } }>>();
    const retryExecSummaryDelivery = vi.fn(async (_reportId: number, options: { resend: boolean; requestKey: string }) => {
      expect(options.resend).toBe(true);
      const previous = inFlight.get(options.requestKey);
      if (previous) return { action: "deduped", delivery: await previous.then(() => ({ state: "accepted" })) };
      const providerAttempt = (async () => {
        calls.push(options.requestKey);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { action: "accepted", delivery: { state: "accepted" } };
      })();
      inFlight.set(options.requestKey, providerAttempt);
      const result = await providerAttempt;
      return result;
    });
    const app = express();
    app.use(express.json());
    app.post(
      "/send",
      createExecSummarySendHandler({
        getLatestExecSummaries: async () => [{ id: 42 }],
        retryExecSummaryDelivery,
      }),
    );

    const [one, two] = await Promise.all([
      request(app).post("/send").send({ reportId: 42, resend: true, requestKey: "explicit-resend-key" }),
      request(app).post("/send").send({ reportId: 42, resend: true, requestKey: "explicit-resend-key" }),
    ]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(calls).toEqual(["explicit-resend-key"]);
    expect([one.body.action, two.body.action].sort()).toEqual(["accepted", "deduped"]);
  });

  it.each(["unreadable", "malformed", "empty"])("keeps report history available when recipient configuration is %s", async (kind) => {
    const app = express();
    app.get(
      "/history",
      createExecSummaryHistoryHandler({
        getLatestExecSummaries: async () => [{
          id: 42,
          generatedAt: new Date("2026-09-16T20:00:00.000Z"),
          delivery: { state: "accepted", attemptCount: 1 },
        }],
        getExecSummaryRecipients: async () => {
          if (kind === "malformed") return ["owner@example.com", "broken"];
          if (kind === "empty") return [];
          throw new Error("recipient setting is malformed");
        },
        getEmailConfigurationStatus: () => ({
          configured: true,
          apiKeyPresent: true,
          fromEmail: "notifications@example.com",
          fromEmailValid: true,
          issues: [],
        }),
        isEmailConfigured: () => true,
        resolveFromAddress: () => ({ email: "notifications@example.com", name: "VRS Express" }),
      }),
    );

    const response = await request(app).get("/history");
    expect(response.status).toBe(200);
    expect(response.body.reports).toHaveLength(1);
    expect(response.body.recipients).toEqual([]);
    expect(response.body.emailConfigured).toBe(false);
    expect(response.body.emailConfiguration).toMatchObject({
      configured: false,
      issues: expect.arrayContaining(["invalid_recipient"]),
    });
    expect(JSON.stringify(response.body)).not.toContain("malformed");
  });
});