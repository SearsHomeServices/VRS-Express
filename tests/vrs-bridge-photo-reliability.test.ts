import { describe, expect, it, vi } from "vitest";
import { BridgePhotoReliability, photoCaptureState, SOURCE_WINDOW_MS } from "../server/vrs-bridge-photo-reliability";
import { VRS_BRIDGE_PHOTO_RETENTION_MS } from "../server/vrs-bridge-photo-storage";

describe("persistent photo recovery", () => {
  it("warns the batch before reads and isolates a failed ticket while other tickets retry", async () => {
    const origin = Date.now() - 90 * 60 * 1000;
    const deadline = origin + VRS_BRIDGE_PHOTO_RETENTION_MS;
    const rows = [1, 2, 3, 4].map(submission_id => ({
      submission_id, intake_at: new Date(origin), retention_expires_at: new Date(deadline),
      captured_count: 0, expected_count: 1, photos: ["source"],
    }));
    const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith("SELECT p.") ? rows : [],
    }));
    const alert = vi.fn().mockRejectedValueOnce(new Error("one incident unavailable")).mockResolvedValue(undefined);
    const service = new BridgePhotoReliability({ query } as any, {} as any, alert);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const attempted: number[] = [];
    const capture = vi.spyOn(service, "capture").mockImplementation(async (id) => {
      // All warnings, including the failed notification, precede media work.
      expect(alert).toHaveBeenCalledTimes(4);
      attempted.push(id);
      if (id === 1) throw new Error("one ticket unavailable");
      if (id === 2) await blocked;
      return { captured: 1, failures: 0 };
    });
    const pass = service.recover();
    await vi.waitFor(() => expect(attempted).toContain(4));
    expect(alert.mock.calls.map(call => call[1])).toEqual([1, 2, 3, 4]);
    expect(query.mock.calls.some(([sql]) => sql.includes("SET next_attempt_at"))).toBe(true);
    release();
    await pass;
    capture.mockResolvedValue({ captured: 1, failures: 0 });
    await service.recover();
    expect(capture.mock.calls.filter(call => call[0] === 1)).toHaveLength(2);
  });

  it("bounds recovery media work to three tickets", async () => {
    const rows = [1, 2, 3, 4].map(submission_id => ({
      submission_id, intake_at: new Date(), retention_expires_at: new Date(Date.now() + VRS_BRIDGE_PHOTO_RETENTION_MS),
      photos: ["source"],
    }));
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT p.") ? rows : [] }));
    const service = new BridgePhotoReliability({ query } as any, {} as any, vi.fn());
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let active = 0;
    let peak = 0;
    const capture = vi.spyOn(service, "capture").mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await blocked;
      active--;
      return { captured: 1, failures: 0 };
    });
    const pass = service.recover();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(3));
    release();
    await pass;
    expect(capture).toHaveBeenCalledTimes(4);
    expect(peak).toBe(3);
  });

  it("marks incomplete copies terminal at source expiry but preserves verified copies", () => {
    expect(photoCaptureState(0, 1, 0, SOURCE_WINDOW_MS - 1)).toBe("retry");
    expect(photoCaptureState(0, 1, 0, SOURCE_WINDOW_MS)).toBe("failed");
    expect(photoCaptureState(1, 1, 0, SOURCE_WINDOW_MS)).toBe("captured");
  });

  it("retries failure, alerts before expiry, and preserves the original retention deadline", async () => {
    const origin = Date.now() - 90 * 60 * 1000;
    const deadline = origin + VRS_BRIDGE_PHOTO_RETENTION_MS;
    const row = { intake_at: new Date(origin), retention_expires_at: new Date(deadline) };
    const query = vi.fn(async () => ({ rows: [row] }));
    const capture = vi.fn().mockResolvedValueOnce({ captured: 0, failures: 1 })
      .mockResolvedValueOnce({ captured: 1, failures: 0 });
    const alert = vi.fn();
    const service = new BridgePhotoReliability({ query } as any, { capture } as any, alert);
    await service.capture(12, ["https://source.invalid/photo"], deadline + 1000);
    expect(capture.mock.calls[0][4]).toBe(deadline);
    expect(alert.mock.calls[0][0]).toBe("bridge_photo_capture_at_risk");
    await service.capture(12, ["https://source.invalid/photo"], deadline + 2000);
    expect(query.mock.calls.some((call: any) => call[1]?.[1] === "captured")).toBe(true);
  });

  it("does not fetch expired sources and produces an actionable terminal alert", async () => {
    const origin = Date.now() - SOURCE_WINDOW_MS - 1000;
    const deadline = origin + VRS_BRIDGE_PHOTO_RETENTION_MS;
    const query = vi.fn(async () => ({ rows: [{ intake_at: new Date(origin), retention_expires_at: new Date(deadline) }] }));
    const capture = vi.fn(async (_id, _urls, fetchImage) => {
      await expect(fetchImage("https://source.invalid/photo")).rejects.toThrow("PHOTO_SOURCE_WINDOW_EXPIRED");
      return { captured: 0, failures: 1 };
    });
    const alert = vi.fn();
    await new BridgePhotoReliability({ query } as any, { capture } as any, alert)
      .capture(12, ["https://source.invalid/photo"], deadline);
    expect(alert.mock.calls[0][0]).toBe("bridge_photo_capture_failed");
    expect(JSON.stringify(alert.mock.calls)).not.toContain("source.invalid");
  });
});