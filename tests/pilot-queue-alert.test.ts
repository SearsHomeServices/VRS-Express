// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  user: { id: 1, role: "admin" },
  waiting: { data: { submissions: [] as { id: number }[] }, isFetchedAfterMount: true, isError: false },
  working: { data: { submissions: [] as { id: number }[] }, isError: false },
  play: vi.fn(), load: vi.fn(), invalidate: vi.fn(),
  handlers: new Map<string, () => void>(),
  subscribe: vi.fn(),
}));
vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => options.queryKey[0].includes("ticketStatus=queued") ? mocks.waiting : mocks.working,
}));
vi.mock("../client/src/lib/queryClient", () => ({
  JITTERED_POLL_INTERVAL_MS: 60000, queryClient: { invalidateQueries: mocks.invalidate },
}));
vi.mock("../client/src/lib/websocket", () => ({
  loadNotificationSettings: mocks.load, playPilotNewTicketAlert: mocks.play,
  useWebSocket: () => ({ subscribe: mocks.subscribe }),
}));
import { PilotQueueAlert } from "../client/src/components/pilot-queue-alert";
let root: Root;
let host: HTMLDivElement;
async function render() { await act(async () => { root.render(createElement(PilotQueueAlert)); }); }
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.user = { id: 1, role: "admin" };
  mocks.waiting = { data: { submissions: [{ id: 1 }] }, isFetchedAfterMount: true, isError: false };
  mocks.working = { data: { submissions: [{ id: 2 }] }, isError: false };
  mocks.handlers.clear();
  mocks.subscribe.mockImplementation((event, handler) => {
    mocks.handlers.set(event, handler);
    return () => mocks.handlers.delete(event);
  });
  mocks.load.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
describe("always-mounted Pilot pending alert", () => {
  it("shows queued plus in-progress count, flashes and starts silently", async () => {
    await render();
    expect(host.textContent).toBe("2 pending");
    expect(host.querySelector(".pilot-pending-alert")).not.toBeNull();
    expect(mocks.play).not.toHaveBeenCalled();
  });
  it("sounds for new IDs even if total count stays the same; does not repeat or sound on removals", async () => {
    await render();
    mocks.waiting.data = { submissions: [{ id: 3 }] };
    await render();
    expect(mocks.play).toHaveBeenCalledTimes(1);
    await render();
    mocks.waiting.data = { submissions: [] };
    await render();
    mocks.waiting.data = { submissions: [{ id: 3 }] };
    await render();
    expect(mocks.play).toHaveBeenCalledTimes(1);
  });
  it("batches simultaneous arrivals into one alert", async () => {
    await render();
    mocks.waiting.data = { submissions: [{ id: 1 }, { id: 3 }, { id: 4 }] };
    await render();
    expect(mocks.play).toHaveBeenCalledTimes(1);
  });
  it("stops flashing at zero", async () => {
    mocks.waiting.data = { submissions: [] };
    mocks.working.data = { submissions: [] };
    await render();
    expect(host.textContent).toBe("0 pending");
    expect(host.querySelector(".pilot-pending-alert")).toBeNull();
  });
  it("shows failures rather than a misleading current count and resumes on recovery", async () => {
    await render();
    mocks.waiting.isError = true;
    await render();
    expect(host.textContent).toBe("!");
    expect(host.querySelector(".pilot-pending-alert")).toBeNull();
    mocks.waiting.isError = false;
    await render();
    expect(host.textContent).toBe("2 pending");
  });
  it("does not use default sound when saved notification settings fail", async () => {
    mocks.load.mockRejectedValue(new Error("offline"));
    await render();
    mocks.waiting.data = { submissions: [{ id: 3 }] };
    await render();
    expect(mocks.play).not.toHaveBeenCalled();
  });
  it("coalesces websocket refreshes for both status queries", async () => {
    vi.useFakeTimers();
    await render();
    mocks.handlers.get("new_ticket")!();
    mocks.handlers.get("ticket_updated")!();
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(mocks.invalidate).toHaveBeenCalledTimes(2);
  });
  it("hides the alert from technician roles", async () => {
    mocks.user.role = "technician";
    await render();
    expect(host.textContent).toBe("");
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
});
