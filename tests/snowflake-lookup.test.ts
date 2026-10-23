import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROC_ID_FALLBACK_SQL,
  PROC_ID_SQL,
  createProcLookup,
  procLookupKey,
  type LookupStatementQuery,
} from "../server/services/snowflake-lookup";

afterEach(() => vi.useRealTimers());

describe("Snowflake lookup safeguards", () => {
  it("deduplicates normalized keys and bounds admission", async () => {
    let complete!: (rows: any[]) => void;
    const query = vi.fn(() => new Promise<any[]>(resolve => { complete = resolve; }));
    const lookup = createProcLookup(query, { concurrency: 1, queueLimit: 1 });
    const first = lookup(" 0001-12345678 ");
    expect(lookup("1-12345678")).toBe(first);
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = vi.fn<LookupStatementQuery>(async ({ binds: [key] }) => {
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
    // "error" fails the ordered statement and then its fallback: 2 calls.
    expect(query).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(11);
    await lookup("error");
    expect(query).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(40);
    await lookup("empty");
    expect(query).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(50);
    await lookup("found");
    expect(query).toHaveBeenCalledTimes(8);
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

describe("ProcID statement", () => {
  const TABLE = "PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL";

  it("prefers the district's order, then the most recent one", () => {
    expect(PROC_ID_SQL).toBe(
      `SELECT CMB_THD_PTY_ID, CLIENT_NM FROM ${TABLE} WHERE SO_NO = ? ` +
      "ORDER BY CASE WHEN SVC_UN_NO = LPAD(?, 7, '0') THEN 0 ELSE 1 END, SO_CRT_DT DESC NULLS LAST LIMIT 1",
    );
    // The statement before the ordering, unchanged.
    expect(PROC_ID_FALLBACK_SQL).toBe(`SELECT CMB_THD_PTY_ID, CLIENT_NM FROM ${TABLE} WHERE SO_NO = ? LIMIT 1`);
  });

  it("splits the district from the SO", () => {
    expect(procLookupKey(" 7995-11075199 ")).toEqual({ district: "0007995", serviceOrder: "11075199" });
    expect(procLookupKey("0008366-11075199")).toEqual({ district: "0008366", serviceOrder: "11075199" });
    expect(procLookupKey("11075199")).toEqual({ district: null, serviceOrder: "11075199" });
    expect(procLookupKey("ABCD-11075199")).toEqual({ district: null, serviceOrder: "11075199" });
  });

  it("binds the SO and the district, and caches by both", async () => {
    const query = vi.fn<LookupStatementQuery>(async () => [{ CMB_THD_PTY_ID: "AHS-1", CLIENT_NM: "AHS" }]);
    const lookup = createProcLookup(query);
    expect(await lookup("7995-11075199")).toEqual({ status: "FOUND", procId: "AHS-1", clientNm: "AHS" });
    expect(query.mock.calls[0][0]).toEqual({ sqlText: PROC_ID_SQL, binds: ["11075199", "0007995"] });
    await lookup("7995-11075199");
    await lookup("0007995-11075199"); // the same padded district
    expect(query).toHaveBeenCalledTimes(1);
    // The same SO under another district is its own lookup.
    await lookup("8366-11075199");
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0].binds).toEqual(["11075199", "0008366"]);
    // A bare SO: no district (NULL never matches), so the most recent order.
    await lookup("11075199");
    expect(query.mock.calls[2][0]).toEqual({ sqlText: PROC_ID_SQL, binds: ["11075199", null] });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("falls back to the unordered statement when the ordered one fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = vi.fn<LookupStatementQuery>(async ({ sqlText }) => {
      if (sqlText === PROC_ID_SQL) throw new Error("SQL compilation error: invalid identifier 'SO_CRT_DT'");
      return [{ CMB_THD_PTY_ID: "AHS-1", CLIENT_NM: "AHS" }];
    });
    const lookup = createProcLookup(query);
    expect(await lookup("7995-11075199")).toEqual({ status: "FOUND", procId: "AHS-1", clientNm: "AHS" });
    expect(query.mock.calls.map(([statement]) => statement)).toEqual([
      { sqlText: PROC_ID_SQL, binds: ["11075199", "0007995"] },
      { sqlText: PROC_ID_FALLBACK_SQL, binds: ["11075199"] },
    ]);
    // Both statements run under the same lookup (one connection in the driver).
    expect(query.mock.calls[0][1]).toBe(query.mock.calls[1][1]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/\[proc-id\] SO=11075199 .*invalid identifier 'SO_CRT_DT'/);
    vi.restoreAllMocks();
  });

  it("is unavailable when the fallback fails too, and never falls back after the deadline", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn<LookupStatementQuery>(async () => { throw new Error("warehouse suspended"); });
    expect(await createProcLookup(failing)("7995-11075199")).toEqual({ status: "LOOKUP_UNAVAILABLE", retryable: true });
    expect(failing).toHaveBeenCalledTimes(2);

    vi.useFakeTimers();
    const rejects: Array<(error: Error) => void> = [];
    const hung = vi.fn<LookupStatementQuery>(() => new Promise<any[]>((_resolve, reject) => rejects.push(reject)));
    const pending = createProcLookup(hung, { deadlineMs: 20 })("7995-11075199");
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual({ status: "LOOKUP_UNAVAILABLE", retryable: true });
    rejects[0](new Error("statement cancelled"));
    await vi.advanceTimersByTimeAsync(1);
    expect(hung).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
