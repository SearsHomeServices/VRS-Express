// VRS no longer handles NLA parts (shared/nla-policy.ts): POST
// /api/submissions refuses a new "parts_nla" ticket, and an NLA
// resubmission, with 400 and the TechHub instruction, before anything is
// looked up or stored. Runs the real route registration with hermetic
// storage, lookup, SMS and WebSocket doubles (same harness as
// tests/tech-appliance-details-submit.test.ts).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NLA_NO_LONGER_HANDLED_HEADING, NLA_SUBMISSION_REJECTED_ERROR } from "../shared/nla-policy";

const mocks = vi.hoisted(() => ({
  previous: undefined as Record<string, any> | undefined,
  createSubmissionWithIdempotency: vi.fn(),
  getSubmission: vi.fn(),
  fetchProcIdForServiceOrder: vi.fn(),
  fetchAhsServiceOrderPrefill: vi.fn(),
  lookupHssomOrder: vi.fn(),
  fetchServiceOrderApplianceType: vi.fn(),
  lookupWomProductCategory: vi.fn(),
  updateSubmission: vi.fn(),
}));

vi.mock("../server/storage", () => ({
  storage: {
    getUser: vi.fn(async (id: number) => ({ id, name: "Carlos Rivera", role: "technician", isActive: true, racId: "crivera" })),
    getTechUserByLdapId: vi.fn(async () => undefined),
    findRecentDuplicateSubmission: vi.fn(async () => undefined),
    hasRejectedClosedForServiceOrder: vi.fn(async () => false),
    hasActiveSubmissionForServiceOrder: vi.fn(async () => ({ exists: false })),
    getSubmission: mocks.getSubmission,
    getResubmissionChain: vi.fn(async () => []),
    createSubmissionWithIdempotency: mocks.createSubmissionWithIdempotency,
    updateSubmission: mocks.updateSubmission,
    getOnlineAgentCount: vi.fn(async () => 0),
    getQueuedCountAll: vi.fn(async () => 0),
  },
  pool: { query: vi.fn(), connect: vi.fn() },
  db: { execute: vi.fn(), transaction: vi.fn() },
  getSubmissionsDataVersion: vi.fn(() => 0),
}));

vi.mock("../server/services/snowflake", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/snowflake")>()),
  fetchProcIdForServiceOrder: mocks.fetchProcIdForServiceOrder,
  fetchAhsServiceOrderPrefill: mocks.fetchAhsServiceOrderPrefill,
  fetchServiceOrderApplianceType: mocks.fetchServiceOrderApplianceType,
}));

vi.mock("../server/services/wom-work-order", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/wom-work-order")>()),
  lookupWomProductCategory: mocks.lookupWomProductCategory,
}));

vi.mock("../server/services/hssom-order-lookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/hssom-order-lookup")>()),
  lookupHssomOrder: mocks.lookupHssomOrder,
}));

vi.mock("../server/sms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/sms")>()),
  sendSms: vi.fn(async () => undefined),
  buildSubmissionReceivedMessage: vi.fn(async () => "received"),
}));

vi.mock("../server/seed", () => ({ seedDatabase: vi.fn(async () => undefined) }));
vi.mock("../server/replit_integrations/object_storage", () => ({ registerObjectStorageRoutes: vi.fn() }));
vi.mock("../server/replit_integrations/object_storage/objectStorage", () => ({ ObjectStorageService: class {} }));
vi.mock("../server/vrs-bridge-photo-storage", () => ({
  VRS_BRIDGE_PHOTO_RETENTION_MS: 1,
  VrsBridgePhotoStorage: class {
    get = vi.fn();
    save = vi.fn();
  },
}));
vi.mock("../server/vrs-sasha-store", () => ({ vrsBridgeStore: {} }));
vi.mock("../server/websocket", () => ({
  broadcastToDivisionAgents: vi.fn(),
  broadcastToNlaDivisionAgents: vi.fn(),
  broadcastToAdmins: vi.fn(),
  broadcastToAllAgents: vi.fn(),
  broadcastToAgent: vi.fn(),
  broadcastToTechnicians: vi.fn(),
  updateClientStatus: vi.fn(),
  updateClientDivisions: vi.fn(),
  getWarrantyLabel: vi.fn(() => "Warranty"),
  getDivisionLabel: vi.fn(() => "Division"),
  getLiveSessionCount: vi.fn(() => 0),
  forceDisconnectUser: vi.fn(),
}));

const ENV_KEYS = ["SESSION_SECRET", "TECH_APPLIANCE_DETAILS_ENABLED", "VRS_AI_APP_ENROLL_ENABLED"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const TECH_ID = 41;

function body(overrides: Record<string, unknown> = {}) {
  return {
    serviceOrder: "8175-13538277",
    applianceType: "laundry",
    applianceKind: "washer",
    requestType: "parts_nla",
    warrantyType: "sears_protect",
    issueDescription: "Washer control board is NLA in TechHub; needed to finish the repair.",
    phone: "(214) 555-0199",
    partNumbers: JSON.stringify({ nla: ["W10321304"], available: [] }),
    photos: JSON.stringify({ estimate: ["/objects/estimate-1"], issue: ["/objects/issue-1"] }),
    ...overrides,
  };
}

let app: express.Express;
const token = () =>
  jwt.sign({ id: TECH_ID, email: "tech@example.test", name: "Carlos", role: "technician" }, process.env.SESSION_SECRET!);
const submit = (payload: unknown) =>
  request(app).post("/api/submissions").set("Authorization", `Bearer ${token()}`).send(payload as object);

beforeAll(async () => {
  process.env.SESSION_SECRET = "nla-not-handled-test-secret";
  const { registerRoutes } = await import("../server/routes");
  app = express();
  app.use(express.json());
  await registerRoutes(createServer(app), app);
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of ["log", "info", "warn"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  process.env.TECH_APPLIANCE_DETAILS_ENABLED = "false";
  process.env.VRS_AI_APP_ENROLL_ENABLED = "false";
  mocks.previous = undefined;
  mocks.getSubmission.mockImplementation(async () => mocks.previous);
  mocks.fetchProcIdForServiceOrder.mockResolvedValue({ status: "FOUND", procId: "SPHW1", clientNm: "Sears Protect" });
  mocks.fetchAhsServiceOrderPrefill.mockResolvedValue({ status: "unavailable" });
  mocks.lookupHssomOrder.mockResolvedValue({ status: "unavailable" });
  mocks.fetchServiceOrderApplianceType.mockResolvedValue({ status: "not_found" });
  mocks.lookupWomProductCategory.mockResolvedValue({ status: "unavailable" });
  mocks.updateSubmission.mockResolvedValue(undefined);
  mocks.createSubmissionWithIdempotency.mockImplementation(async (row: Record<string, unknown>) => ({
    submission: { id: 901, ...row },
    wasDuplicate: false,
  }));
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("POST /api/submissions — NLA parts are no longer handled by VRS", () => {
  it("rejects a new parts_nla ticket with 400 and the TechHub instruction, storing nothing", async () => {
    const res = await submit(body());
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: NLA_SUBMISSION_REJECTED_ERROR, code: "NLA_NOT_HANDLED" });
    expect(res.body.error.startsWith(NLA_NO_LONGER_HANDLED_HEADING)).toBe(true);
    expect(res.body.error).toContain('"Needed for Repair"');
    expect(res.body.error).toContain("TH 2.0 prompts for SOM team research");
    expect(res.body.error).toContain("do not close the order until research is complete");
    expect(mocks.createSubmissionWithIdempotency).not.toHaveBeenCalled();
    expect(mocks.fetchProcIdForServiceOrder).not.toHaveBeenCalled();
    expect(mocks.getSubmission).not.toHaveBeenCalled();
  });

  it.each(["sears_protect", "american_home_shield", "first_american"])("rejects it for %s too", async (warrantyType) => {
    const res = await submit(body({ warrantyType }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NLA_NOT_HANDLED");
    expect(mocks.createSubmissionWithIdempotency).not.toHaveBeenCalled();
  });

  it("rejects an NLA resubmission of an existing rejected NLA ticket", async () => {
    mocks.previous = { id: 77, technicianId: TECH_ID, serviceOrder: "8175-13538277", requestType: "parts_nla", ticketStatus: "rejected" };
    const res = await submit(body({ resubmissionOf: 77, appealNotes: "Added part photos" }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NLA_NOT_HANDLED");
    expect(mocks.createSubmissionWithIdempotency).not.toHaveBeenCalled();
  });

  it("rejects a parts_nla ticket with no part numbers the same way (not the old part-number error)", async () => {
    const res = await submit(body({ partNumbers: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(NLA_SUBMISSION_REJECTED_ERROR);
  });

  it("still accepts an authorization ticket for the same service order", async () => {
    const res = await submit(body({ requestType: "authorization", partNumbers: undefined }));
    expect(res.status).toBe(201);
    expect(mocks.createSubmissionWithIdempotency).toHaveBeenCalledTimes(1);
    expect(mocks.createSubmissionWithIdempotency.mock.calls[0][0].requestType).toBe("authorization");
  });
});

describe("agents can still finish existing NLA tickets", () => {
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");

  it("keeps the NLA processing routes", () => {
    expect(routes).toContain('"/api/submissions/:id/process-nla"');
    expect(routes).toContain('"/api/submissions/:id/send-to-nla"');
  });

  it("refuses NLA only in the create handler", () => {
    expect(routes.match(/isNlaRequestType\(/g)).toHaveLength(1);
    const handler = routes.slice(routes.indexOf("const createSubmissionHandler = async ("));
    const check = handler.indexOf("if (isNlaRequestType(parsed.data.requestType))");
    expect(check).toBeGreaterThan(0);
    // Right after the body is parsed, before any lookup or storage call.
    expect(check).toBeLessThan(handler.indexOf("await storage."));
  });
});
