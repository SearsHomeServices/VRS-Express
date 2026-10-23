// Stage 1 AHS review endpoints (server/ahs-review-api.ts, contract in
// shared/ahs-review.ts), run through the real route registration with
// hermetic auth, storage, bridge-store and lookup doubles.
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAhsReviewApi, type AhsReviewApiDeps } from "../server/ahs-review-api";
import type { AhsPrefillSources } from "../server/ahs-prefill";
import { safeParseVrsAppOriginOutboundRequest } from "../server/vrs-sasha-contract";
import type { AhsDetails, AhsDetailsDraft } from "../shared/ahs-details";

afterEach(() => {
  vi.restoreAllMocks();
});

const SECRET_NAME = "Rosalind Featherstonehaugh";
const SECRET_ADDRESS = "1209 Quillfeather Lane, Frederick, MD 21701";
const SECRET_CONTRACT = "AHS-DISPATCH-551200";

const AGENT = { id: 7, name: "Vera Agent", role: "vrs_agent" };
const OTHER_AGENT = { id: 8, name: "Other Agent", role: "vrs_agent" };
const ADMIN = { id: 1, name: "Ada Admin", role: "admin" };
const SUPER = { id: 2, name: "Sam Super", role: "super_admin" };
const TECH = { id: 40, name: "Carlos Rivera", role: "technician" };

// What POST /api/submissions stored: the server-filled draft.
const draft: AhsDetailsDraft = {
  contractNumber: SECRET_CONTRACT,
  brand: "Whirlpool",
  modelNumber: "WTW5000DW1",
  customerName: SECRET_NAME,
  customerAddress: SECRET_ADDRESS,
  parts: [{ partNumber: "WPW10503278", description: "Electronic control board", quantity: 1 }],
  purchaseYear: 2019,
  prefilledFields: ["contractNumber", "brand", "modelNumber", "customerName", "customerAddress", "parts"],
};

// What the VRS manager saves: the draft completed, model corrected.
const completed: AhsDetails = {
  contractNumber: SECRET_CONTRACT,
  customerName: SECRET_NAME,
  customerAddress: SECRET_ADDRESS,
  applianceKind: "washer",
  brand: "whirlpool",
  modelNumber: "WTW5000DW2",
  applianceLocation: "Laundry room",
  failureCause: "normal-wear",
  techRecommendation: "repair",
  laborAmount: 120,
  taxAmount: 15.6,
  parts: [
    { partNumber: "WPW10503278", description: "Electronic control board", quantity: 1, unitPrice: 245 },
    { partNumber: "W10820048", description: "Drain pump clip", quantity: 2, unitPrice: 4.25 },
  ],
};

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    serviceOrder: "8175-13538277",
    districtCode: "8175",
    requestType: "authorization",
    warrantyType: "american_home_shield",
    ticketStatus: "pending",
    stage1Status: "pending",
    submissionApproved: false,
    assignedTo: AGENT.id,
    technicianId: TECH.id,
    technicianLdapId: "crivera",
    issueDescription: "Washer will not spin; control board failed diagnostic.",
    phone: "(214) 555-0199",
    phoneOverride: null,
    procId: "AHS123",
    clientNm: "American Home Shield",
    estimateAmount: null,
    partNumbers: null,
    ahsDetails: JSON.stringify(draft),
    createdAt: new Date("2026-10-08T14:00:00.000Z"),
    ...overrides,
  } as any;
}

const unavailable: AhsPrefillSources = { snowflake: { status: "unavailable" }, hssom: { status: "unavailable" } };

function harness(options: {
  submission?: any;
  bridgeRow?: any;
  enrollEnabled?: boolean;
  sources?: AhsPrefillSources;
  updateLoses?: boolean;
} = {}) {
  const rows = new Map<number, any>();
  const submission = options.submission === undefined ? ticket() : options.submission;
  if (submission) rows.set(submission.id, submission);
  let bridgeRow = options.bridgeRow;

  const store = {
    getBySubmissionId: vi.fn(async () => bridgeRow),
    createIntake: vi.fn(async (input: any) => {
      bridgeRow = { id: 90, ...input, state: "pending_review", providerCallId: null };
      return { kind: "accepted" as const, record: bridgeRow, createdAt: new Date() };
    }),
    replaceUndispatchedAppIntake: vi.fn(async (_id: number, replacement: any) => {
      bridgeRow = { ...bridgeRow, ...replacement };
      return true;
    }),
  };
  const deps = {
    authenticateToken: (req: any, res: any, next: any) => {
      const header = req.headers["x-test-user"];
      if (!header) return res.status(401).json({ error: "Unauthorized" });
      req.user = JSON.parse(String(header));
      next();
    },
    requireRole: (...roles: string[]) => (req: any, res: any, next: any) =>
      req.user.role === "super_admin" || roles.includes(req.user.role)
        ? next()
        : res.status(403).json({ error: "Access denied" }),
    getSubmission: vi.fn(async (id: number) => rows.get(id)),
    updateSubmissionIfStatus: vi.fn(async (id: number, statuses: string[], data: any, expectedAssignedTo?: number) => {
      const row = rows.get(id);
      if (options.updateLoses || !row || !statuses.includes(row.ticketStatus)) return undefined;
      if (expectedAssignedTo !== undefined && row.assignedTo !== expectedAssignedTo) return undefined;
      const next = { ...row, ...data };
      rows.set(id, next);
      return next;
    }),
    getUser: vi.fn(async () => ({ name: "Carlos Rivera", racId: "crivera" })),
    bridge: { store, generateCallId: () => "vrs_call_app_1" },
    isEnrollEnabled: () => options.enrollEnabled ?? true,
    lookupSources: vi.fn(async () => options.sources ?? unavailable),
    createNote: vi.fn(async () => ({})),
    broadcastTicketUpdated: vi.fn(),
  } satisfies AhsReviewApiDeps;
  const app = express();
  app.use(express.json());
  registerAhsReviewApi(app, deps);
  return { app, deps, store, rows, bridge: () => bridgeRow };
}

const as = (user: object) => ({ "x-test-user": JSON.stringify(user) });
const save = (app: express.Express, user: object, body: unknown, id = 501) =>
  request(app).patch(`/api/submissions/${id}/ahs-details`).set(as(user)).send(body as object);
const refresh = (app: express.Express, user: object, id = 501) =>
  request(app).post(`/api/submissions/${id}/ahs-details/refresh`).set(as(user));

function quietLogs() {
  return (["log", "info", "warn", "error"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
}

describe("PATCH /api/submissions/:id/ahs-details — access", () => {
  it("rejects unauthenticated callers and technicians", async () => {
    const { app, deps } = harness();
    expect((await request(app).patch("/api/submissions/501/ahs-details").send({ ahsDetails: completed })).status).toBe(401);
    expect((await save(app, TECH, { ahsDetails: completed })).status).toBe(403);
    expect(deps.getSubmission).not.toHaveBeenCalled();
  });

  it("lets only the assigned vrs_agent, an admin or a super_admin save", async () => {
    quietLogs();
    const other = harness();
    const res = await save(other.app, OTHER_AGENT, { ahsDetails: completed });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: "This ticket is not assigned to you" });
    expect(other.deps.updateSubmissionIfStatus).not.toHaveBeenCalled();

    for (const user of [AGENT, ADMIN, SUPER]) {
      const { app, deps } = harness();
      const ok = await save(app, user, { ahsDetails: completed });
      expect(ok.status).toBe(200);
      // A vrs_agent's write is pinned to their assignment; admins bypass it.
      expect(deps.updateSubmissionIfStatus.mock.calls[0][3]).toBe(user.role === "vrs_agent" ? AGENT.id : undefined);
    }
  });

  it.each([
    ["a Sears ticket", { warrantyType: "sears_protect" }, 400],
    ["a First American ticket", { warrantyType: "first_american" }, 400],
    ["an NLA ticket", { requestType: "parts_nla" }, 400],
    ["a queued ticket", { ticketStatus: "queued" }, 409],
    ["a completed ticket", { ticketStatus: "completed" }, 409],
    ["an approved Stage 1", { stage1Status: "approved", submissionApproved: true }, 409],
    ["a rejected Stage 1", { stage1Status: "rejected" }, 409],
  ])("refuses %s", async (_label, overrides, status) => {
    const { app, deps, store } = harness({ submission: ticket(overrides) });
    const res = await save(app, ADMIN, { ahsDetails: completed });
    expect(res.status).toBe(status);
    expect(res.body.ok).toBe(false);
    expect(deps.updateSubmissionIfStatus).not.toHaveBeenCalled();
    expect(store.createIntake).not.toHaveBeenCalled();
  });

  it.each([
    ["dispatched", { id: 90, callId: "c", state: "queued", providerCallId: "vrs_ai_1", callbackUrl: "" }],
    ["being dispatched", { id: 90, callId: "c", state: "dispatching", providerCallId: null, callbackUrl: "" }],
    ["from SASHA", { id: 90, callId: "c", state: "pending_review", providerCallId: null, callbackUrl: "https://sasha.example/webhook" }],
  ])("refuses a ticket whose VRS AI row is %s", async (_label, bridgeRow) => {
    const { app, deps, store } = harness({ bridgeRow });
    const res = await save(app, ADMIN, { ahsDetails: completed });
    expect(res.status).toBe(409);
    expect(deps.updateSubmissionIfStatus).not.toHaveBeenCalled();
    expect(store.replaceUndispatchedAppIntake).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing ticket and 400 for a bad id", async () => {
    const { app } = harness({ submission: null });
    expect((await save(app, ADMIN, { ahsDetails: completed })).status).toBe(404);
    expect((await save(app, ADMIN, { ahsDetails: completed }, "12abc" as any)).status).toBe(400);
  });
});

describe("PATCH /api/submissions/:id/ahs-details — save and enroll", () => {
  it("validates against the full schema and returns field-level issues", async () => {
    const { app, deps } = harness();
    const res = await save(app, AGENT, { ahsDetails: { ...completed, applianceLocation: "", parts: [] } });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.issues).toEqual(expect.arrayContaining([
      { path: ["applianceLocation"], message: "Appliance location is required" },
      { path: ["parts"], message: "Add at least one part" },
    ]));
    expect(deps.updateSubmissionIfStatus).not.toHaveBeenCalled();

    const missing = await save(app, AGENT, {});
    expect(missing.status).toBe(400);
    expect(missing.body.issues.length).toBeGreaterThan(0);
  });

  it("stores the details with merged provenance, totals and part numbers, and enrolls", async () => {
    quietLogs();
    const { app, deps, store, rows } = harness();
    const forged = { ...completed, prefilledFields: ["serialNumber", "not-a-field"], purchaseYear: 1999 };
    const res = await save(app, AGENT, { ahsDetails: forged });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.enrolled).toBe(true);
    expect(res.body).not.toHaveProperty("enrollSkipReason");
    // modelNumber changed; brand differs only in case; parts unchanged where
    // the server filled them (the manager added prices and a second line → not kept).
    expect(res.body.ahsDetails.prefilledFields).toEqual(["contractNumber", "brand", "customerName", "customerAddress"]);
    // Client-sent purchaseYear dropped; the draft's year carries (age blank).
    expect(res.body.ahsDetails.purchaseYear).toBe(2019);

    const [, statuses, data] = deps.updateSubmissionIfStatus.mock.calls[0];
    expect(statuses).toEqual(["pending"]);
    expect(data.estimateAmount).toBe("389.10"); // 245 + 2×4.25 + 120 + 15.6
    expect(data.partNumbers).toBe(JSON.stringify(["WPW10503278", "W10820048"]));
    expect(JSON.parse(data.ahsDetails)).toEqual(res.body.ahsDetails);
    expect(rows.get(501).ahsDetails).toBe(data.ahsDetails);

    // The bridge row carries a valid V9 app-origin payload.
    expect(store.createIntake).toHaveBeenCalledTimes(1);
    const [intake, createOptions] = store.createIntake.mock.calls[0];
    expect(createOptions).toEqual({ supersedeClosedUndispatched: true });
    expect(intake).toMatchObject({ submissionId: 501, serviceOrder: "13538277", callbackUrl: "", techId: "crivera" });
    const outbound = safeParseVrsAppOriginOutboundRequest({
      ...intake.requestPayload,
      callback_url: "https://vrs-express.example/api/integrations/vrs-ai/v1/webhook",
      callback_secret: "express-ai-webhook-secret",
    });
    expect(outbound).toMatchObject({ success: true, version: "v9" });
    expect(intake.requestPayload).toMatchObject({
      contract_number: SECRET_CONTRACT,
      customer_name: SECRET_NAME,
      model_number: "WTW5000DW2",
      labor_amount: 120,
      part_price: 253.5,
      purchase_year: 2019,
    });
  });

  it("keeps parts provenance when the manager only completed what the order lacked", async () => {
    quietLogs();
    const { app } = harness();
    const res = await save(app, AGENT, { ahsDetails: { ...completed, parts: [completed.parts[0]] } });
    expect(res.body.ahsDetails.prefilledFields).toContain("parts");
  });

  it("replaces the payload of the ticket's undispatched row on a second save", async () => {
    quietLogs();
    const bridgeRow = { id: 90, submissionId: 501, callId: "vrs_call_app_1", state: "pending_review", providerCallId: null, callbackUrl: "" };
    const { app, store } = harness({ bridgeRow });
    const res = await save(app, AGENT, { ahsDetails: { ...completed, laborAmount: 150 } });
    expect(res.body).toMatchObject({ ok: true, enrolled: true });
    expect(store.createIntake).not.toHaveBeenCalled();
    const [id, replacement] = store.replaceUndispatchedAppIntake.mock.calls[0];
    expect(id).toBe(90);
    expect(replacement.requestPayload).toMatchObject({ labor_amount: 150 });
  });

  it("saves but does not enroll while app enrollment is off, or when another call holds the order", async () => {
    quietLogs();
    const off = harness({ enrollEnabled: false });
    const res = await save(off.app, AGENT, { ahsDetails: completed });
    expect(res.body).toMatchObject({ ok: true, enrolled: false, enrollSkipReason: "VRS AI enrollment is turned off" });
    expect(off.store.createIntake).not.toHaveBeenCalled();
    expect(off.deps.updateSubmissionIfStatus).toHaveBeenCalled();

    const busy = harness();
    busy.store.createIntake.mockResolvedValueOnce({
      kind: "duplicate",
      record: { callId: "vrs_call_sasha", state: "queued" },
    } as any);
    const dup = await save(busy.app, AGENT, { ahsDetails: completed });
    expect(dup.body).toMatchObject({
      ok: true,
      enrolled: false,
      enrollSkipReason: "An active VRS AI call already exists for this service order",
    });

    const failing = harness();
    failing.store.createIntake.mockRejectedValueOnce(new Error("db down"));
    const failed = await save(failing.app, AGENT, { ahsDetails: completed });
    expect(failed.body).toMatchObject({ ok: true, enrolled: false });
    expect(failed.text).not.toContain("db down");
  });

  it("answers 409 when the ticket moved or was reassigned before the write", async () => {
    const { app, store } = harness({ updateLoses: true });
    const res = await save(app, AGENT, { ahsDetails: completed });
    expect(res.status).toBe(409);
    expect(store.createIntake).not.toHaveBeenCalled();
  });

  it("adds an audit note and broadcasts the update, with no PII in either or in logs", async () => {
    const spies = quietLogs();
    const { app, deps } = harness();
    await save(app, AGENT, { ahsDetails: completed });
    expect(deps.createNote).toHaveBeenCalledWith({
      submissionId: 501,
      authorId: AGENT.id,
      authorRole: "vrs_agent",
      visibility: "staff_only",
      body: "AHS details updated by Vera Agent",
    });
    expect(deps.broadcastTicketUpdated).toHaveBeenCalledTimes(1);
    const logged = spies.flatMap((spy) => spy.mock.calls.flat()).map(String).join(" ");
    for (const value of [SECRET_NAME, SECRET_ADDRESS, SECRET_CONTRACT, "Featherstonehaugh"]) {
      expect(logged).not.toContain(value);
      expect(JSON.stringify(deps.createNote.mock.calls)).not.toContain(value);
    }
  });

  it("still answers when the audit note or broadcast fails", async () => {
    quietLogs();
    const { app, deps } = harness();
    deps.createNote.mockRejectedValueOnce(new Error("notes down"));
    deps.broadcastTicketUpdated.mockImplementationOnce(() => { throw new Error("ws down"); });
    const res = await save(app, AGENT, { ahsDetails: completed });
    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(true);
  });
});

describe("POST /api/submissions/:id/ahs-details/refresh", () => {
  const sources: AhsPrefillSources = {
    snowflake: {
      status: "found",
      partnerId: "AHS123",
      clientName: "American Home Shield",
      brand: "Maytag",
      modelNumber: "SO-MODEL",
      serialNumber: "SO-SERIAL",
      parts: [{ partNumber: "SO-PART", quantity: 1 }],
    },
    hssom: { status: "found", customerName: "HSSOM Name", customerAddress: SECRET_ADDRESS },
  };

  it("has the same access rules", async () => {
    const other = harness({ sources });
    expect((await refresh(other.app, OTHER_AGENT)).status).toBe(403);
    expect((await refresh(other.app, TECH)).status).toBe(403);
    const decided = harness({ sources, submission: ticket({ stage1Status: "approved", submissionApproved: true }) });
    expect((await refresh(decided.app, ADMIN)).status).toBe(409);
    const sears = harness({ sources, submission: ticket({ warrantyType: "sears_protect" }) });
    expect((await refresh(sears.app, ADMIN)).status).toBe(400);
    for (const h of [other, decided, sears]) expect(h.deps.lookupSources).not.toHaveBeenCalled();
  });

  it("fills only blank fields of the stored draft and stores it", async () => {
    quietLogs();
    const stored: AhsDetailsDraft = { brand: "Whirlpool", customerName: "Typed By Manager", laborAmount: 80, prefilledFields: ["brand"] };
    const { app, deps, rows } = harness({ sources, submission: ticket({ ahsDetails: JSON.stringify(stored) }) });
    const res = await refresh(app, AGENT);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, snowflake: "found", hssom: "found" });
    expect(res.body.ahsDetails).toEqual({
      brand: "Whirlpool",
      customerName: "Typed By Manager",
      laborAmount: 80,
      modelNumber: "SO-MODEL",
      serialNumber: "SO-SERIAL",
      customerAddress: SECRET_ADDRESS,
      parts: [{ partNumber: "SO-PART", quantity: 1 }],
      prefilledFields: ["brand", "modelNumber", "serialNumber", "customerAddress", "parts"],
    });
    expect(deps.lookupSources).toHaveBeenCalledWith("8175-13538277");
    expect(JSON.parse(rows.get(501).ahsDetails)).toEqual(res.body.ahsDetails);
    expect(deps.broadcastTicketUpdated).toHaveBeenCalledTimes(1);
  });

  it("returns the stored draft unchanged when the lookups find nothing", async () => {
    quietLogs();
    const { app, deps } = harness({ sources: unavailable });
    const res = await refresh(app, AGENT);
    expect(res.body).toEqual({ ok: true, ahsDetails: draft, snowflake: "unavailable", hssom: "unavailable" });
    expect(deps.updateSubmissionIfStatus).not.toHaveBeenCalled();
  });

  it("decides an HSSOM-only find by the ticket's stored ProcID", async () => {
    quietLogs();
    const hssomOnly: AhsPrefillSources = { snowflake: { status: "unavailable" }, hssom: sources.hssom };
    const ahs = await refresh(harness({ sources: hssomOnly, submission: ticket({ ahsDetails: "{}" }) }).app, AGENT);
    expect(ahs.body.ahsDetails).toMatchObject({ customerName: "HSSOM Name" });
    const unknown = await refresh(
      harness({ sources: hssomOnly, submission: ticket({ ahsDetails: "{}", procId: "Not Found", clientNm: "Not Found" }) }).app,
      AGENT,
    );
    expect(unknown.body.ahsDetails).toEqual({});
  });

  it("keeps an enrolled ticket's undispatched payload in step", async () => {
    quietLogs();
    const complete = { ...completed, serialNumber: undefined, prefilledFields: ["contractNumber"] };
    const bridgeRow = { id: 90, submissionId: 501, callId: "vrs_call_app_1", state: "pending_review", providerCallId: null, callbackUrl: "" };
    const { app, store } = harness({ sources, bridgeRow, submission: ticket({ ahsDetails: JSON.stringify(complete) }) });
    const res = await refresh(app, AGENT);
    expect(res.body.ahsDetails.serialNumber).toBe("SO-SERIAL");
    expect(res.body.ahsDetails.parts).toEqual(completed.parts); // parts present → not filled
    expect(store.replaceUndispatchedAppIntake).toHaveBeenCalledTimes(1);
    expect(store.replaceUndispatchedAppIntake.mock.calls[0][1].requestPayload).toMatchObject({ serial_number: "SO-SERIAL" });
  });
});
