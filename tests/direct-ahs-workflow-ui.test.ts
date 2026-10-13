// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectAhsWorkflow, type DirectAhsStatus } from "../client/src/components/direct-ahs-workflow";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: mocks.request,
  friendlyApiErrorMessage: (error: Error) => error.message,
}));

let client: QueryClient;
let root: Root;
let container: HTMLDivElement;
let snapshot: DirectAhsStatus;
let statusRead: ReturnType<typeof vi.fn>;
let onWorkflowState: ReturnType<typeof vi.fn>;
const key = ["/api/submissions", 44, "direct-ahs"];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  snapshot = { eligible: true, enabled: true, reason: null, workflow: null };
  statusRead = vi.fn(async () => snapshot);
  onWorkflowState = vi.fn();
  client = new QueryClient({ defaultOptions: { queries: { queryFn: statusRead, retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.request.mockReset();
  mocks.request.mockResolvedValue({ ok: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client },
      createElement(DirectAhsWorkflow, { submissionId: 44, onWorkflowState })));
  });
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
  });
}

async function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(button => button.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

function workflow(state: NonNullable<DirectAhsStatus["workflow"]>["state"]): NonNullable<DirectAhsStatus["workflow"]> {
  return { id: "same-request-id", state, error: null, decision: null, sms: null, womNotes: null };
}

describe("Isolated direct AHS workflow", () => {
  it("requires review notes and a centered confirmation before dispatch", async () => {
    await mount();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-direct-ahs-dispatch"]')?.disabled).toBe(true);
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Repair reviewed; estimate confirmed.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickButton("Approve and Send to VRS AI");
    expect(mocks.request).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.className).toContain("top-[50%]");
    const confirm = Array.from(dialog.querySelectorAll("button")).find(button => button.textContent === "Approve and Send to VRS AI")!;
    snapshot = { ...snapshot, workflow: workflow("awaiting_result") };
    await act(async () => confirm.click());
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith("POST", "/api/submissions/44/direct-ahs", { reviewNotes: "Repair reviewed; estimate confirmed." });
  });

  it.each(["failed", "dispatching", "awaiting_result", "dispatch_unknown", "awaiting_sms", "completed"] as const)(
    "locks legacy processing for an existing %s record, even when disabled", async (state) => {
      snapshot = { ...snapshot, enabled: false, reason: "AI-side integration pending.", workflow: workflow(state) };
      await mount();
      expect(onWorkflowState).toHaveBeenLastCalledWith({ submissionId: 44, ownsTicket: true, checking: false });
      expect(container.textContent).toContain("Normal processing is locked");
      expect(container.querySelector('[data-testid="button-direct-ahs-dispatch"]')).toBeNull();
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );

  it("reports unavailable status and prevents blind dispatch", async () => {
    statusRead.mockRejectedValue(new Error("Fixture unavailable"));
    await mount();
    expect(container.textContent).toContain("Direct AHS status unavailable");
    expect(container.querySelector('[data-testid="button-direct-ahs-dispatch"]')).toBeNull();
    expect(onWorkflowState).toHaveBeenLastCalledWith({ submissionId: 44, ownsTicket: false, checking: true });
    statusRead.mockResolvedValue(snapshot);
    await clickButton("Refresh status");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("retries dispatch_unknown through the same-request endpoint without a body", async () => {
    snapshot.workflow = workflow("dispatch_unknown");
    await mount();
    await clickButton("Retry same AI request");
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("reuses the same request ID");
    const dialog = document.querySelector('[role="alertdialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll("button")).find(button => button.textContent === "Retry same AI request")!;
    snapshot.workflow = workflow("awaiting_result");
    await act(async () => confirm.click());
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith("POST", "/api/submissions/44/direct-ahs/retry", undefined);
  });

  it("keeps failed SMS open and offers no SMS resend or authorization retry", async () => {
    snapshot.workflow = { ...workflow("awaiting_sms"), sms: { status: "failed", reason: "Carrier unavailable" } };
    await mount();
    expect(container.textContent).toContain("Ticket remains open");
    expect(container.textContent).toContain("retry SMS only, not the authorization");
    expect(container.textContent).toContain("Carrier unavailable");
    expect(container.querySelector("button")).toBeNull();
  });

  it.each(["approved", "denied"] as const)("shows completed %s decision and unwritten WOM notes", async (state) => {
    snapshot.workflow = { ...workflow("completed"), decision: { state, code: "AHS-48371", notes: "Repair estimate assessed." }, womNotes: { summary: "Repair assessment" }, sms: { status: "delivered" } };
    await mount();
    expect(container.textContent).toContain(state === "approved" ? "Approval code" : "Denial code");
    expect(container.textContent).toContain("AHS-48371");
    expect(container.textContent).toContain("Repair estimate assessed.");
    expect(container.textContent).toContain("have not been written to WOM");
    expect(container.textContent).toContain("Repair assessment");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("leaves legacy processing available for disabled/no-record workflow", async () => {
    snapshot.enabled = false;
    snapshot.reason = "AI-side integration pending.";
    await mount();
    expect(onWorkflowState).toHaveBeenLastCalledWith({ submissionId: 44, ownsTicket: false, checking: false });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-direct-ahs-dispatch"]')?.disabled).toBe(true);
    expect(client.getQueryData(key)).toEqual(snapshot);
  });

  it("disables both confirmation actions while dispatch is pending", async () => {
    let resolve!: () => void;
    mocks.request.mockReturnValue(new Promise<void>(done => { resolve = done; }));
    await mount();
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Reviewed repair.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickButton("Approve and Send to VRS AI");
    const dialog = document.querySelector('[role="alertdialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll("button")).find(button => button.textContent === "Approve and Send to VRS AI")!;
    await act(async () => confirm.click());
    expect(Array.from(dialog.querySelectorAll("button")).every(button => button.disabled)).toBe(true);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(onWorkflowState).toHaveBeenLastCalledWith({ submissionId: 44, ownsTicket: true, checking: false });
    snapshot.workflow = workflow("dispatching");
    await act(async () => resolve());
  });

  it("polls unresolved records every ten seconds, stopping at completed", async () => {
    snapshot.workflow = workflow("failed");
    await mount();
    const query = client.getQueryCache().find({ queryKey: key })!;
    const interval = (query.options as { refetchInterval?: unknown }).refetchInterval as (currentQuery: typeof query) => number | false;
    expect(interval(query)).toBe(10_000);
    await act(async () => client.setQueryData(key, { ...snapshot, workflow: workflow("completed") }));
    expect(interval(query)).toBe(false);
  });
});
