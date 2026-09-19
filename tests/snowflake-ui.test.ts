// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnowflakeBackfillStatus } from "../client/src/components/snowflake-backfill-status";
import { createSubmissionErrorHandler } from "../client/src/lib/submission-error-handler";

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("Snowflake consumer UI", () => {
  it("mounts unavailable and failed-update counters with retry guidance", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => root.render(createElement(SnowflakeBackfillStatus, {
        result: { total: 10, needingBackfill: 8, updated: 3, notFound: 2,
          unavailable: 2, failedUpdates: 1, retryable: true },
      })));
      expect(container.querySelector('[data-testid="text-backfill-unavailable"]')?.textContent).toBe("2");
      expect(container.querySelector('[data-testid="text-backfill-failed-updates"]')?.textContent).toBe("1");
      expect(container.textContent).toContain("Unavailable:");
      expect(container.textContent).toContain("Failed Updates:");
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Run backfill again to retry");
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it("runs submission failure without success cleanup or losing draft/photos", async () => {
    const form = { serviceOrder: "1234-12345678", issueDescription: "Saved description" };
    const photos = ["/objects/uploaded-photo"];
    const draft = JSON.stringify({ form, photos });
    localStorage.setItem("draft", draft);
    const toast = vi.fn();
    const openAdditionalPrompt = vi.fn();
    const successCleanup = vi.fn(() => {
      localStorage.removeItem("draft");
      photos.length = 0;
      form.issueDescription = "";
    });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const error = Object.assign(new Error("lookup error"), {
      status: 503, body: { code: "LOOKUP_UNAVAILABLE", retryable: true },
    });
    const observer = new MutationObserver(client, {
      mutationFn: async () => { throw error; },
      onSuccess: successCleanup,
      onError: createSubmissionErrorHandler({
        toast, openAdditionalPrompt, friendlyMessage: error => error.message,
      }),
    });
    await expect(observer.mutate()).rejects.toBe(error);
    expect(observer.getCurrentResult().isError).toBe(true);
    expect(observer.getCurrentResult().isPending).toBe(false);
    expect(successCleanup).not.toHaveBeenCalled();
    expect(openAdditionalPrompt).not.toHaveBeenCalled();
    expect(localStorage.getItem("draft")).toBe(draft);
    expect(photos).toEqual(["/objects/uploaded-photo"]);
    expect(form.issueDescription).toBe("Saved description");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Service Order Lookup Unavailable",
      description: expect.stringContaining("tap Submit again"),
    }));
    client.clear();
  });

  it("preserves duplicate confirmation and other friendly errors", () => {
    const toast = vi.fn();
    const openAdditionalPrompt = vi.fn();
    const handler = createSubmissionErrorHandler({
      toast, openAdditionalPrompt, friendlyMessage: () => "Friendly existing error",
    });
    handler(Object.assign(new Error("duplicate"), { status: 409, body: { canRequestAdditional: true } }));
    expect(openAdditionalPrompt).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
    handler(new Error("network"));
    expect(toast).toHaveBeenCalledWith({
      title: "Submission Failed", description: "Friendly existing error", variant: "destructive",
    });
  });
});