import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getEmailConfigurationStatus,
  sendEmail,
} from "../server/services/email";

const ENVIRONMENT_KEYS = [
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
] as const;

const emailOptions = {
  to: ["owner@example.com"],
  subject: "Test summary",
  html: "<p>Test summary</p>",
  text: "Test summary",
};

function providerResponse(
  status: number,
  headers: Record<string, string> = {},
) {
  return {
    status,
    headers: new Headers(headers),
    text: vi.fn(async () => "provider body must never be read"),
  };
}

let previousEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  previousEnvironment = Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  for (const key of ENVIRONMENT_KEYS) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

describe("SendGrid email service", () => {
  it("reports only HTTP 202 as provider acceptance and captures x-message-id", async () => {
    process.env.SENDGRID_API_KEY = "test-key";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      providerResponse(202, { "x-message-id": "sg-message-123" }) as Response,
    );

    const result = await sendEmail(emailOptions);

    expect(result).toEqual({
      sent: true,
      status: 202,
      messageId: "sg-message-123",
      retryable: false,
      ambiguous: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("marks a timeout ambiguous and never recommends an automatic resend", async () => {
    process.env.SENDGRID_API_KEY = "test-key";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_url, init) => {
      await new Promise<void>((resolve) => {
        init?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });

    const result = await sendEmail({ ...emailOptions, timeoutMs: 5 });

    expect(result).toMatchObject({
      sent: false,
      retryable: false,
      ambiguous: true,
    });
    expect(result.reason).toContain("unknown");
  });

  it("marks a network failure ambiguous and does not expose the error", async () => {
    process.env.SENDGRID_API_KEY = "test-key";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(
      new Error("network failure with secret provider details"),
    );

    const result = await sendEmail(emailOptions);

    expect(result).toMatchObject({
      sent: false,
      retryable: false,
      ambiguous: true,
    });
    expect(result.reason).not.toContain("secret provider details");
  });

  it("marks 429 retryable and honors a bounded Retry-After", async () => {
    process.env.SENDGRID_API_KEY = "test-key";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      providerResponse(429, { "retry-after": "12" }) as Response,
    );

    const result = await sendEmail(emailOptions);

    expect(result).toMatchObject({
      sent: false,
      status: 429,
      retryable: true,
      ambiguous: false,
      retryAfterMs: 12_000,
    });
  });

  it("marks 5xx retryable, clamps an excessive Retry-After, and never reads the body", async () => {
    process.env.SENDGRID_API_KEY = "test-key";
    const fetchMock = vi.mocked(fetch);
    const response = providerResponse(503, { "retry-after": "999999999" });
    fetchMock.mockResolvedValue(response as Response);

    const result = await sendEmail(emailOptions);

    expect(result).toMatchObject({
      sent: false,
      status: 503,
      retryable: true,
      ambiguous: false,
    });
    expect(result.retryAfterMs).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(response.text).not.toHaveBeenCalled();
  });

  it("fails safely without a key and does not call the provider", async () => {
    const fetchMock = vi.mocked(fetch);

    const result = await sendEmail(emailOptions);

    expect(result).toMatchObject({
      sent: false,
      retryable: false,
      ambiguous: false,
    });
    expect(result.reason).not.toContain("test-key");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getEmailConfigurationStatus()).toMatchObject({
      configured: false,
      apiKeyPresent: false,
      fromEmailValid: true,
    });
  });

  it("rejects an invalid recipient list rather than silently dropping an address", async () => {
    process.env.SENDGRID_API_KEY = "test-key";
    const fetchMock = vi.mocked(fetch);

    const result = await sendEmail({
      ...emailOptions,
      to: ["owner@example.com", "not-an-email"],
    });

    expect(result).toMatchObject({
      sent: false,
      retryable: false,
      ambiguous: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid sender and reply-to configuration", async () => {
    process.env.SENDGRID_API_KEY = "test-key";
    const fetchMock = vi.mocked(fetch);

    process.env.SENDGRID_FROM_EMAIL = "invalid sender";
    const invalidFrom = await sendEmail(emailOptions);
    expect(invalidFrom.sent).toBe(false);

    delete process.env.SENDGRID_FROM_EMAIL;
    const invalidReplyTo = await sendEmail({
      ...emailOptions,
      replyTo: "invalid reply-to",
    });
    expect(invalidReplyTo.sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes dry-run an explicit non-send even when SendGrid is not configured", async () => {
    const fetchMock = vi.mocked(fetch);

    const result = await sendEmail({ ...emailOptions, dryRun: true });

    expect(result).toEqual({
      sent: false,
      reason: "dryRun",
      retryable: false,
      ambiguous: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not validate or expose inputs during a dry-run", async () => {
    const fetchMock = vi.mocked(fetch);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.SENDGRID_FROM_EMAIL = "not-an-email";

    const invalidSender = await sendEmail({
      ...emailOptions,
      to: ["not-a-recipient"],
      dryRun: true,
    });

    expect(invalidSender).toEqual({
      sent: false,
      reason: "dryRun",
      retryable: false,
      ambiguous: false,
    });
    expect(log).toHaveBeenCalledWith("[email] DRY RUN — no provider request made.");
    expect(log.mock.calls.flat().join(" ")).not.toContain("not-a-recipient");
    expect(log.mock.calls.flat().join(" ")).not.toContain("not-an-email");
    expect(fetchMock).not.toHaveBeenCalled();
    log.mockRestore();
  });
});