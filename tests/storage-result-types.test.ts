import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const pool = { on: vi.fn() };
  const db = { execute: vi.fn(), transaction: vi.fn(), select: vi.fn() };
  return { pool, db, Pool: vi.fn(function () { return pool; }), drizzle: vi.fn(() => db) };
});

vi.mock("pg", () => ({ Pool: mocks.Pool }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: mocks.drizzle }));

const { DatabaseStorage } = await import("../server/storage");

describe("DatabaseStorage result handling", () => {
  const storage = new DatabaseStorage();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches display names with one narrow query and deduplicated user IDs", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const rows = [{ id: 7, name: "Technician" }, { id: 9, name: "Reviewer" }];
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn(() => ({ where }));
    mocks.db.select.mockReturnValue({ from });
    await expect(storage.getUserDisplayNames([7, 9, 7])).resolves.toEqual(rows);
    expect(mocks.db.select).toHaveBeenCalledTimes(1);
    expect(Object.keys(mocks.db.select.mock.calls[0][0])).toEqual(["id", "name"]);
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0]).params).toEqual([7, 9]);
  });

  it("skips empty display-name lookups", async () => {
    await expect(storage.getUserDisplayNames([])).resolves.toEqual([]);
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("does not hide display-name query failures", async () => {
    const error = new Error("lookup failed");
    mocks.db.select.mockReturnValue({ from: () => ({ where: () => Promise.reject(error) }) });
    await expect(storage.getUserDisplayNames([7])).rejects.toBe(error);
  });

  it("returns node-postgres rows from getTechnicianUsers", async () => {
    const rows = [
      {
        id: 7,
        name: "Alex Technician",
        racId: "RAC-7",
        phone: "555-0107",
        district: "West",
        techUnNo: "UN-7",
        managerName: "Manager",
        role: "technician",
        totalTickets: 3,
        pendingCount: 1,
        approvedCount: 2,
        rejectedCount: 0,
      },
    ];
    mocks.db.execute.mockResolvedValueOnce({ rows });

    await expect(storage.getTechnicianUsers()).resolves.toBe(rows);
    expect(mocks.db.execute).toHaveBeenCalledTimes(1);
  });

  it("propagates getTechnicianUsers database errors", async () => {
    const error = new Error("query failed");
    mocks.db.execute.mockRejectedValueOnce(error);

    await expect(storage.getTechnicianUsers()).rejects.toBe(error);
  });

  describe("atomicCreateIntakeForm", () => {
    const data = {
      submissionId: 42,
      agentId: 9,
      payload: { answer: "yes" },
      smartsheetUrlSubmitted: null,
    };
    const runTransaction = (lockedRows: unknown[], existingRows: unknown[] = [], inserted?: unknown) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({ rows: lockedRows }),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(existingRows),
          })),
        })),
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([inserted]),
          })),
        })),
      };
      mocks.db.transaction.mockImplementationOnce(async (callback: (transaction: typeof tx) => unknown) => callback(tx));
      return tx;
    };

    it("returns not_found when the lock query has no row", async () => {
      const tx = runTransaction([]);

      await expect(storage.atomicCreateIntakeForm(data)).resolves.toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(tx.select).not.toHaveBeenCalled();
    });

    it("returns not_approved for a non-terminal locked ticket", async () => {
      const tx = runTransaction([{ id: 42, ticket_status: "pending", request_type: "authorization" }]);

      await expect(storage.atomicCreateIntakeForm(data)).resolves.toEqual({
        ok: false,
        reason: "not_approved",
        ticketStatus: "pending",
      });
      expect(tx.select).not.toHaveBeenCalled();
    });

    it("returns duplicate when an intake row exists inside the lock", async () => {
      const existing = { id: 11, ...data, payload: { answer: "already filed" } };
      const tx = runTransaction(
        [{ id: 42, ticket_status: "completed", request_type: "authorization" }],
        [existing],
      );

      await expect(storage.atomicCreateIntakeForm(data)).resolves.toEqual({
        ok: false,
        reason: "duplicate",
        existing,
      });
      expect(tx.insert).not.toHaveBeenCalled();
    });

    it("inserts and returns the intake row for a terminal ticket", async () => {
      const intakeForm = { id: 12, ...data };
      const tx = runTransaction(
        [{ id: 42, ticket_status: "rejected", request_type: "authorization" }],
        [],
        intakeForm,
      );

      await expect(storage.atomicCreateIntakeForm(data)).resolves.toEqual({
        ok: true,
        intakeForm,
      });
      expect(tx.insert).toHaveBeenCalledTimes(1);
    });

    it("propagates transaction errors", async () => {
      const error = new Error("transaction failed");
      mocks.db.transaction.mockRejectedValueOnce(error);

      await expect(storage.atomicCreateIntakeForm(data)).rejects.toBe(error);
    });
  });
});