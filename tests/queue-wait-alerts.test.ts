// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BUSINESS_HOURS_CONFIG } from "../shared/business-hours";
import { isQueueWaitOverdue, useQueueWaitAlerts, type QueueAlertTicket } from "../client/src/hooks/use-queue-wait-alerts";

const audio = vi.hoisted(() => ({
  loadNotificationSettings: vi.fn().mockResolvedValue({ tone: "chime", volume: 0.5 }),
  playNotificationDing: vi.fn(),
  playPilotQueueChime: vi.fn(),
  getNotificationVolume: vi.fn().mockReturnValue(0.5),
}));
vi.mock("../client/src/lib/websocket", () => audio);

const start = Date.parse("2026-10-01T14:00:00Z");
const ticket: QueueAlertTicket = { id: 1, ticketStatus: "queued", createdAt: new Date(start), requestType: "authorization" };
const config = DEFAULT_BUSINESS_HOURS_CONFIG;

beforeEach(() => {
  sessionStorage.clear();
  audio.getNotificationVolume.mockReturnValue(0.5);
  audio.loadNotificationSettings.mockResolvedValue({ tone: "chime", volume: 0.5 });
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("five-minute queue alerts", () => {
  it("starts at exactly five business minutes", () => {
    expect(isQueueWaitOverdue(ticket, start + 299999, config)).toBe(false);
    expect(isQueueWaitOverdue(ticket, start + 300000, config)).toBe(true);
  });

  it.each([
    { ticketStatus: "pending" },
    { ticketStatus: "completed" },
    { claimedAt: new Date(start) },
    { nlaReadyForOrderAt: new Date(start) },
    { requestType: "parts_nla", nlaEscalatedBy: 42 },
    { createdAt: "bad-date" },
  ])("excludes stopped waits and invalid dates: %j", (override) => {
    expect(isQueueWaitOverdue({ ...ticket, ...override }, start + 600000, config)).toBe(false);
  });

  it("does not count overnight hours", () => {
    expect(isQueueWaitOverdue({ ...ticket, createdAt: "2026-10-01T02:00:00Z" },
      Date.parse("2026-10-01T10:00:00Z"), config)).toBe(false);
  });

  it("applies the HVAC rather than standard Saturday schedule", () => {
    const saturday = Date.parse("2026-10-03T14:00:00Z");
    expect(isQueueWaitOverdue({ ...ticket, applianceType: "hvac", createdAt: new Date(saturday) }, saturday + 300000, config)).toBe(false);
    expect(isQueueWaitOverdue({ ...ticket, createdAt: new Date(saturday) }, saturday + 300000, config)).toBe(true);
  });

  it("does not replay on remount, reload-like mounts, or unmute; isolates users", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start + 300000);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    function Harness({ sessionKey }: { sessionKey: string }) {
      useQueueWaitAlerts([ticket], config, { sessionKey });
      return null;
    }
    const mount = async (key: string) => {
      const root = createRoot(document.createElement("div"));
      await act(async () => root.render(createElement(Harness, { sessionKey: key })));
      await act(async () => root.unmount());
    };
    audio.getNotificationVolume.mockReturnValue(0);
    await mount("user-a");
    expect(audio.playNotificationDing).not.toHaveBeenCalled();
    audio.getNotificationVolume.mockReturnValue(0.5);
    await mount("user-a");
    expect(audio.playNotificationDing).not.toHaveBeenCalled();
    await mount("user-b");
    expect(audio.playNotificationDing).toHaveBeenCalledTimes(1);
    // jsdom dispatches sessionStorage events via zero-delay timers.
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for confirmed business hours and retries failed notification settings safely", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start + 300000);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    audio.loadNotificationSettings.mockRejectedValueOnce(new Error("offline"));
    function Harness({ enabled }: { enabled: boolean }) {
      useQueueWaitAlerts([ticket], config, { enabled });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(createElement(Harness, { enabled: false })));
      await act(async () => { vi.advanceTimersByTime(30000); });
      expect(audio.loadNotificationSettings).toHaveBeenCalledWith({ requireSuccess: true });
      expect(audio.playNotificationDing).not.toHaveBeenCalled();
      await act(async () => root.render(createElement(Harness, { enabled: true })));
      expect(audio.playNotificationDing).toHaveBeenCalledTimes(1);
    } finally { await act(async () => root.unmount()); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[0, false], [0.5, false], [0, true], [0.5, true]] as const)("updates without refetch, deduplicates, stops on claim, volume %s, pilot %s", async (volume, pilot) => {
    audio.getNotificationVolume.mockReturnValue(volume);
    vi.useFakeTimers();
    vi.setSystemTime(start + 299000);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    function Harness({ tickets }: { tickets: QueueAlertTicket[] }) {
      const now = useQueueWaitAlerts(tickets, config, { pilot });
      return createElement("div", { "data-overdue": isQueueWaitOverdue(tickets[0], now, config) }, String(now));
    }
    const tickets = [ticket, { ...ticket, id: 2 }];
    try {
      await act(async () => root.render(createElement(Harness, { tickets })));
      expect(container.firstElementChild?.getAttribute("data-overdue")).toBe("false");
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(container.firstElementChild?.getAttribute("data-overdue")).toBe("true");
      expect(audio.playNotificationDing).toHaveBeenCalledTimes(volume > 0 && !pilot ? 1 : 0);
      expect(audio.playPilotQueueChime).toHaveBeenCalledTimes(volume > 0 && pilot ? 1 : 0);
      await act(async () => { vi.advanceTimersByTime(10000); });
      await act(async () => root.render(createElement(Harness, { tickets: [...tickets] })));
      expect(audio.playNotificationDing).toHaveBeenCalledTimes(volume > 0 && !pilot ? 1 : 0);
      expect(audio.playPilotQueueChime).toHaveBeenCalledTimes(volume > 0 && pilot ? 1 : 0);
      await act(async () => root.render(createElement(Harness, {
        tickets: [{ ...ticket, ticketStatus: "pending", claimedAt: new Date() }],
      })));
      expect(container.firstElementChild?.getAttribute("data-overdue")).toBe("false");
    } finally {
      await act(async () => root.unmount());
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});