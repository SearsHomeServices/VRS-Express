// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BUSINESS_HOURS_CONFIG } from "../shared/business-hours";
import { isQueueWaitOverdue, useQueueWaitAlerts, type QueueAlertTicket } from "../client/src/hooks/use-queue-wait-alerts";

const audio = vi.hoisted(() => ({
  loadNotificationSettings: vi.fn().mockResolvedValue({ tone: "chime", volume: 0.5 }),
  playNotificationDing: vi.fn(),
  getNotificationVolume: vi.fn().mockReturnValue(0.5),
}));
vi.mock("../client/src/lib/websocket", () => audio);

const start = Date.parse("2026-10-01T14:00:00Z");
const ticket: QueueAlertTicket = { id: 1, ticketStatus: "queued", createdAt: new Date(start), requestType: "authorization" };
const config = DEFAULT_BUSINESS_HOURS_CONFIG;

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

  it.each([0, 0.5])("updates without a refetch, deduplicates, stops on claim, and honors volume %s", async (volume) => {
    audio.getNotificationVolume.mockReturnValue(volume);
    vi.useFakeTimers();
    vi.setSystemTime(start + 299000);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    function Harness({ tickets }: { tickets: QueueAlertTicket[] }) {
      const now = useQueueWaitAlerts(tickets, config);
      return createElement("div", { "data-overdue": isQueueWaitOverdue(tickets[0], now, config) }, String(now));
    }
    const tickets = [ticket, { ...ticket, id: 2 }];
    try {
      await act(async () => root.render(createElement(Harness, { tickets })));
      expect(container.firstElementChild?.getAttribute("data-overdue")).toBe("false");
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(container.firstElementChild?.getAttribute("data-overdue")).toBe("true");
      expect(audio.playNotificationDing).toHaveBeenCalledTimes(volume > 0 ? 1 : 0);
      await act(async () => { vi.advanceTimersByTime(10000); });
      await act(async () => root.render(createElement(Harness, { tickets: [...tickets] })));
      expect(audio.playNotificationDing).toHaveBeenCalledTimes(volume > 0 ? 1 : 0);
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