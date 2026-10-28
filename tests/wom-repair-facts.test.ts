// WOM work-order facts for the repair / replace calculator
// (server/services/wom-repair-facts.ts): pure extraction, the key-path shape
// for the diagnostic, and the bounded lookup. Fixture customer values are
// fake and must never appear in facts, warnings, shape or logs.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWomRepairFactsLookup,
  repairFactsFromWorkOrder,
  workOrderShape,
} from "../server/services/wom-repair-facts";

const FAKE_NAME = "Jane Testcustomer";
const FAKE_PHONE = "5550001234";

function workItem(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    WorkItemId: id,
    WorkItemStatus: status,
    isCancelled: false,
    Location: [{ Contacts: [{ Name: FAKE_NAME, Phone: FAKE_PHONE }] }],
    Notes: [{ Text: `Called ${FAKE_NAME}` }],
    ...extra,
  };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    OrderNum: "0007108-14335276",
    OrderStatus: "Open",
    Extensions: { ServiceUnitNumber: "0007108", TripChargeAmount: 139 },
    WorkItems: [workItem("W1-01", "Incomplete"), workItem("W1-02", "Scheduled")],
    LabourJobCodes: [{ JobCode: "84100", Price: 344.95 }, { JobCode: "84200", Price: "99.00" }],
    ...overrides,
  };
}

describe("repairFactsFromWorkOrder", () => {
  it("reads the visit, unresolved, failed attempts, trip and labor", () => {
    expect(repairFactsFromWorkOrder(record())).toEqual({
      facts: { visitNumber: 2, unresolved: true, failedAttemptCount: 1, tripCharge: 139, laborTotal: 443.95, laborLineCount: 2 },
      warnings: [],
    });
  });

  it("orders visits by the WorkItemId suffix and skips cancelled ones", () => {
    const { facts } = repairFactsFromWorkOrder(record({
      WorkItems: [
        workItem("W1-03", "Scheduled"),
        workItem("W1-01", "Complete"),
        workItem("W1-02", "Incomplete", { isCancelled: true }),
        workItem("W1-04", "Scheduled", { IsCancelled: true }),
      ],
    }));
    expect(facts).toMatchObject({ visitNumber: 3, unresolved: false, failedAttemptCount: 0 });
  });

  it("leaves unresolved and attempts out for a single visit or unknown statuses", () => {
    const single = repairFactsFromWorkOrder(record({ WorkItems: [workItem("W1-01", "Onsite")] })).facts;
    expect(single).toEqual(expect.objectContaining({ visitNumber: 1 }));
    expect(single).not.toHaveProperty("unresolved");
    expect(single).not.toHaveProperty("failedAttemptCount");
    const unknown = repairFactsFromWorkOrder(record({
      WorkItems: [{ WorkItemId: "W1-01" }, workItem("W1-02", "Scheduled")],
    })).facts;
    expect(unknown).toEqual(expect.objectContaining({ visitNumber: 2 }));
    expect(unknown).not.toHaveProperty("unresolved");
    expect(unknown).not.toHaveProperty("failedAttemptCount");
    const noSuffix = repairFactsFromWorkOrder(record({
      WorkItems: [workItem("A", "Incomplete"), workItem("B", "Scheduled")],
    })).facts;
    expect(noSuffix).toMatchObject({ visitNumber: 2, unresolved: true });
  });

  it("reads a trip charge sent as text and ignores a zero one", () => {
    expect(repairFactsFromWorkOrder(record({ Extensions: { TripChargeAmount: "$139.00" } })).facts.tripCharge).toBe(139);
    expect(repairFactsFromWorkOrder(record({ Extensions: { TripChargeAmount: 0 } })).facts).not.toHaveProperty("tripCharge");
  });

  it.each([["price"], ["Amount"], ["amount"], ["ChargeAmount"], ["LaborPrice"], ["UnitPrice"]])("reads labor from %s", (key) => {
    const { facts } = repairFactsFromWorkOrder(record({ LabourJobCodes: [{ [key]: "120.50" }] }));
    expect(facts).toMatchObject({ laborTotal: 120.5, laborLineCount: 1 });
  });

  it("leaves labor out when a line has no readable price, or the total is $0", () => {
    const unreadable = repairFactsFromWorkOrder(record({ LabourJobCodes: [{ Price: 10 }, { JobCode: "1" }] }));
    expect(unreadable.facts).not.toHaveProperty("laborTotal");
    expect(unreadable.warnings).toEqual(["A WOM labor line has no readable price, so labor was not filled."]);
    const covered = repairFactsFromWorkOrder(record({ LabourJobCodes: [{ Price: 0 }] }));
    expect(covered.facts).not.toHaveProperty("laborTotal");
    expect(covered.warnings).toEqual(["The WOM labor job codes total $0.00 to the customer (covered), so labor was not filled."]);
  });

  it("never throws on junk", () => {
    for (const junk of [null, "x", 3, [], { WorkItems: "x", LabourJobCodes: {}, Extensions: [] }]) {
      expect(() => repairFactsFromWorkOrder(junk)).not.toThrow();
    }
  });
});

describe("workOrderShape", () => {
  it("lists key paths and types, never values or customer subtrees", () => {
    const shape = workOrderShape(record({ CustomerName: FAKE_NAME, Payments: [{ Amount: 5, CardNumber: "4111" }] }));
    expect(shape).toContain("Extensions.TripChargeAmount:number");
    expect(shape).toContain("LabourJobCodes[].Price:number");
    expect(shape).toContain("WorkItems[].WorkItemStatus:string");
    expect(shape).toContain("Payments[].Amount:number");
    const text = shape.join("\n");
    for (const forbidden of [FAKE_NAME, FAKE_PHONE, "Contacts", "Location", "Notes", "CustomerName", "Card", "344.95", "139"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("can be limited to some roots", () => {
    const shape = workOrderShape(record(), ["Extensions"]);
    expect(shape.every((path) => path.startsWith("Extensions."))).toBe(true);
  });
});

describe("createWomRepairFactsLookup", () => {
  const CONFIG = { url: "https://wom.example.test/work-orders", tenantId: "T1", timeoutMs: 1000 };
  afterEach(() => vi.restoreAllMocks());

  function quiet() {
    return [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("answers unavailable without a request when there is no config", async () => {
    const fetchMock = vi.fn();
    const lookup = createWomRepairFactsLookup({ config: () => null, fetch: fetchMock as any });
    expect(await lookup("7108", "14335276")).toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds the order, sends the composite order number, and logs no values", async () => {
    const spies = quiet();
    const fetchMock = vi.fn(async () => json({ total: 1, data: [record()] }));
    const lookup = createWomRepairFactsLookup({ config: () => ({ ...CONFIG, staticToken: "STATIC" }), fetch: fetchMock as any });
    const result = await lookup("7108", "14335276");
    expect(result).toMatchObject({ status: "found", facts: { visitNumber: 2, laborTotal: 443.95, tripCharge: 139 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("OrderNum=0007108-14335276");
    expect(url).toContain("TenantId=T1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer STATIC");
    const logged = spies.flatMap((spy) => spy.mock.calls.flat()).join(" ");
    expect(logged).toContain("[repair-replace-wom] SO=7108-14335276 status=found http=200");
    for (const forbidden of [FAKE_NAME, FAKE_PHONE, "STATIC", "443.95", "139"]) expect(logged).not.toContain(forbidden);
    await lookup("7108", "14335276");
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
  });

  it("answers not_found for an empty envelope or another unit's order", async () => {
    quiet();
    const empty = createWomRepairFactsLookup({ config: () => ({ ...CONFIG, staticToken: "S" }), fetch: (async () => json({ total: 0, data: [] })) as any });
    expect(await empty("7108", "14335276")).toEqual({ status: "not_found" });
    const other = createWomRepairFactsLookup({
      config: () => ({ ...CONFIG, staticToken: "S" }),
      fetch: (async () => json({ data: [record({ OrderNum: "0008175-14335276" })] })) as any,
    });
    expect(await other("7108", "14335276")).toEqual({ status: "not_found" });
  });

  it("retries once with a fresh HSSOM token after a 401", async () => {
    quiet();
    const tokens = ["OLD", "NEW"];
    const invalidate = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization === "Bearer OLD" ? new Response("", { status: 401 }) : json({ data: [record()] }));
    const lookup = createWomRepairFactsLookup({
      config: () => CONFIG,
      getHssomToken: async () => tokens.shift()!,
      invalidateHssomToken: invalidate,
      fetch: fetchMock as any,
    });
    expect((await lookup("7108", "14335276")).status).toBe("found");
    expect(invalidate).toHaveBeenCalledWith("OLD");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers unavailable on 403, a static-token 401, a bad body or a thrown fetch", async () => {
    quiet();
    const cases: Array<() => Promise<Response>> = [
      async () => new Response("", { status: 403 }),
      async () => new Response("", { status: 401 }),
      async () => json({ unexpected: true }),
      async () => { throw new Error("down"); },
    ];
    for (const respond of cases) {
      const lookup = createWomRepairFactsLookup({ config: () => ({ ...CONFIG, staticToken: "S" }), fetch: respond as any });
      expect(await lookup("7108", "14335276")).toEqual({ status: "unavailable" });
    }
  });
});
