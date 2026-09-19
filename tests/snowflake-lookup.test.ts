import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcLookup } from "../server/services/snowflake-lookup";

afterEach(() => vi.useRealTimers());

describe("Snowflake lookup safeguards", () => {
  it("deduplicates normalized keys and bounds admission", async () => {
    let complete!: (rows: any[]) => void;
    const query = vi.fn(() => new Promise<any[]>(resolve => { complete = resolve; }));
    const lookup = createProcLookup(query, { concurrency: 1, queueLimit: 1 });
    const first = lookup(" 000001-123456 ");
    expect(lookup("123456")).toBe(first);
    const queued = lookup("222222");
    expect(await lookup("333333")).toEqual({ status: "LOOKUP_UNAVAILABLE", retryable: true });
    expect(query).toHaveBeenCalledTimes(1);
    complete([]);
    expect((await first).status).toBe("NOT_FOUND");
    await Promise.resolve();
    complete([{ CMB_THD_PTY_ID: " A ", CLIENT_NM: " B " }]);
    expect(await queued).toEqual({ status: "FOUND", procId: "A", clientNm: "B" });
  });

  it("deadlines abort active work, expire queued work, and ignore late rejection", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const rejects: Array<(error: Error) => void> = [];
    const query = vi.fn((_key, signal) => {
      signals.push(signal);
      return new Promise<any[]>((_resolve, reject) => rejects.push(reject));
    });
    const lookup = createProcLookup(query, { concurrency: 1, deadlineMs: 20 });
    const active = lookup("111111");
    const waiting = lookup("222222");
    await vi.advanceTimersByTimeAsync(20);
    expect((await active).status).toBe("LOOKUP_UNAVAILABLE");
    expect((await waiting).status).toBe("LOOKUP_UNAVAILABLE");
    expect(signals.every(signal => signal.aborted)).toBe(true);
    rejects.forEach(reject => reject(new Error("late SDK error")));
    await Promise.resolve();
    const next = lookup("333333");
    await vi.advanceTimersByTimeAsync(20);
    expect((await next).status).toBe("LOOKUP_UNAVAILABLE");
  });

  it("caches found, genuine empty and errors with separate bounded TTLs", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async (key) => {
      if (key === "error") throw new Error("auth failed");
      return key === "empty" ? [] : [{ CMB_THD_PTY_ID: null }];
    });
    const lookup = createProcLookup(query, {
      positiveMs: 100, negativeMs: 50, unavailableMs: 10, cacheSize: 3,
    });
    for (const key of ["found", "empty", "error"]) await lookup(key);
    expect(await lookup("found")).toMatchObject({ status: "FOUND" });
    expect(await lookup("empty")).toMatchObject({ status: "NOT_FOUND" });
    expect(await lookup("error")).toEqual({ status: "LOOKUP_UNAVAILABLE", retryable: true });
    expect(query).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(11);
    await lookup("error");
    expect(query).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(40);
    await lookup("empty");
    expect(query).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(50);
    await lookup("found");
    expect(query).toHaveBeenCalledTimes(6);
  });

  it("evicts entries at the configured cache bound", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => []);
    const lookup = createProcLookup(query, { cacheSize: 2 });
    await lookup("111111");
    await lookup("222222");
    await lookup("333333");
    await lookup("111111");
    expect(query).toHaveBeenCalledTimes(4);
  });
});