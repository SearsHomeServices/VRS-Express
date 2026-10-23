// POST /api/submissions with the technician's appliance details
// (shared/tech-appliance-details.ts), run through the real route
// registration with hermetic storage, ProcID / service-order lookup, SMS and
// WebSocket doubles.
import { createServer } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TechApplianceDetails } from "../shared/tech-appliance-details";

const mocks = vi.hoisted(() => ({
  previous: undefined as Record<string, any> | undefined,
  createSubmissionWithIdempotency: vi.fn(),
  getSubmission: vi.fn(),
  fetchProcIdForServiceOrder: vi.fn(),
  fetchAhsServiceOrderPrefill: vi.fn(),
  lookupHssomOrder: vi.fn(),
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

const ENV_KEYS = [
  "SESSION_SECRET",
  "TECH_APPLIANCE_DETAILS_ENABLED",
  "VRS_AI_APP_ENROLL_ENABLED",
  "AHS_SERVICE_ORDER_PREFILL_ENABLED",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const TECH_ID = 40;
const tech: TechApplianceDetails = {
  applianceGrade: "high",
  applianceColor: "Black Stainless Steel",
  partFunction: "Controls wash cycle timing",
};

const PROC = {
  american_home_shield: { procId: "AHS123", clientNm: "American Home Shield" },
  first_american: { procId: "FA123", clientNm: "First American" },
  sears_protect: { procId: "SPHW1", clientNm: "Sears Protect" },
} as const;

function body(overrides: Record<string, unknown> = {}) {
  return {
    serviceOrder: "8175-13538277",
    applianceType: "laundry",
    requestType: "authorization",
    warrantyType: "american_home_shield",
    issueDescription: "Washer will not spin; control board failed diagnostic.",
    phone: "(214) 555-0199",
    techApplianceDetails: tech,
    ...overrides,
  };
}

let app: express.Express;
const token = () =>
  jwt.sign({ id: TECH_ID, email: "tech@example.test", name: "Carlos", role: "technician" }, process.env.SESSION_SECRET!);
const submit = (payload: unknown) =>
  request(app).post("/api/submissions").set("Authorization", `Bearer ${token()}`).send(payload as object);
// What the handler asked storage to insert.
const inserted = () => mocks.createSubmissionWithIdempotency.mock.calls.at(-1)![0];

beforeAll(async () => {
  process.env.SESSION_SECRET = "tech-appliance-details-test-secret";
  const { registerRoutes } = await import("../server/routes");
  app = express();
  app.use(express.json());
  await registerRoutes(createServer(app), app);
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of ["log", "info", "warn"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  process.env.TECH_APPLIANCE_DETAILS_ENABLED = "true";
  process.env.VRS_AI_APP_ENROLL_ENABLED = "true";
  process.env.AHS_SERVICE_ORDER_PREFILL_ENABLED = "true";
  mocks.previous = undefined;
  mocks.getSubmission.mockImplementation(async () => mocks.previous);
  mocks.fetchProcIdForServiceOrder.mockResolvedValue({ status: "FOUND", ...PROC.american_home_shield });
  mocks.fetchAhsServiceOrderPrefill.mockResolvedValue({ status: "unavailable" });
  mocks.lookupHssomOrder.mockResolvedValue({ status: "unavailable" });
  mocks.createSubmissionWithIdempotency.mockImplementation(async (row: Record<string, unknown>) => ({
    submission: { id: 900, ...row },
    wasDuplicate: false,
  }));
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("POST /api/submissions — techApplianceDetails", () => {
  it("stores it for an AHS authorization ticket and returns it to the technician", async () => {
    const res = await submit(body());
    expect(res.status).toBe(201);
    expect(JSON.parse(inserted().techApplianceDetails)).toEqual(tech);
    // Not PII: the technician's own response carries it untouched.
    expect(JSON.parse(res.body.submission.techApplianceDetails)).toEqual(tech);
  });

  it("stores it for a First American authorization ticket (no AHS draft)", async () => {
    mocks.fetchProcIdForServiceOrder.mockResolvedValue({ status: "FOUND", ...PROC.first_american });
    const res = await submit(body({ warrantyType: "first_american" }));
    expect(res.status).toBe(201);
    expect(inserted().warrantyType).toBe("first_american");
    expect(JSON.parse(inserted().techApplianceDetails)).toEqual(tech);
    expect(inserted().ahsDetails).toBeNull();
  });

  it("follows the server-derived warranty, not the tech's choice", async () => {
    // Tech picked Sears Protect, the ProcID says First American: kept.
    mocks.fetchProcIdForServiceOrder.mockResolvedValue({ status: "FOUND", ...PROC.first_american });
    await submit(body({ warrantyType: "sears_protect" }));
    expect(JSON.parse(inserted().techApplianceDetails)).toEqual(tech);
  });

  it("drops it silently for Sears Protect, even when the tech picked AHS", async () => {
    mocks.fetchProcIdForServiceOrder.mockResolvedValue({ status: "FOUND", ...PROC.sears_protect });
    const res = await submit(body());
    expect(res.status).toBe(201);
    expect(inserted().warrantyType).toBe("sears_protect");
    expect(inserted().techApplianceDetails).toBeNull();
    expect(inserted().ahsDetails).toBeNull();
  });

  it("drops it silently for a non-authorization request", async () => {
    const res = await submit(body({ requestType: "infestation_non_accessible" }));
    expect(res.status).toBe(201);
    expect(inserted().techApplianceDetails).toBeNull();
    expect(inserted().ahsDetails).toBeNull();
  });

  it("drops it silently while TECH_APPLIANCE_DETAILS_ENABLED is off, and leaves the draft alone", async () => {
    process.env.TECH_APPLIANCE_DETAILS_ENABLED = "false";
    const res = await submit(body());
    expect(res.status).toBe(201);
    expect(inserted().techApplianceDetails).toBeNull();
    expect(JSON.parse(inserted().ahsDetails)).toEqual({});
  });

  it.each([
    [{ ...tech, applianceGrade: "premium" }, "Select the appliance grade"],
    [{ ...tech, applianceColor: "Red" }, "Select the appliance color"],
    [{ ...tech, partFunction: "   " }, "Part function is required"],
    [{ ...tech, partFunction: "x".repeat(201) }, "Part function must be 200 characters or less"],
    [{ applianceGrade: "low", applianceColor: "White" }, "Part function is required"],
    ["low", "Expected object, received string"],
  ])("answers 400 with the first message when it is invalid (%#)", async (sent, message) => {
    const res = await submit(body({ techApplianceDetails: sent }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: message });
    expect(mocks.createSubmissionWithIdempotency).not.toHaveBeenCalled();
  });

  it("is not required: absent or null still submits", async () => {
    for (const payload of [body({ techApplianceDetails: undefined }), body({ techApplianceDetails: null })]) {
      const res = await submit(payload);
      expect(res.status).toBe(201);
      expect(inserted().techApplianceDetails).toBeNull();
      expect(JSON.parse(inserted().ahsDetails)).toEqual({});
    }
  });

  it("stores trimmed values", async () => {
    await submit(body({ techApplianceDetails: { ...tech, partFunction: "  Drains the tub  " } }));
    expect(JSON.parse(inserted().techApplianceDetails).partFunction).toBe("Drains the tub");
  });
});

describe("POST /api/submissions — AHS draft gets the tech values", () => {
  it("maps the grade, sets the color and a partial part 1 when the lookups found nothing", async () => {
    await submit(body());
    const draft = JSON.parse(inserted().ahsDetails);
    expect(draft).toEqual({
      applianceGrade: "top",
      applianceColor: "Black Stainless Steel",
      parts: [{ partFunction: "Controls wash cycle timing" }],
    });
    expect(draft).not.toHaveProperty("prefilledFields");
  });

  it("still gets them when the lookups fail", async () => {
    mocks.fetchAhsServiceOrderPrefill.mockRejectedValue(new Error("snowflake down"));
    mocks.lookupHssomOrder.mockRejectedValue(new Error("hssom down"));
    await submit(body());
    expect(JSON.parse(inserted().ahsDetails)).toMatchObject({
      applianceGrade: "top",
      applianceColor: "Black Stainless Steel",
      parts: [{ partFunction: "Controls wash cycle timing" }],
    });
  });

  it("sets part 1's function on the parts from the service order, outside prefilledFields", async () => {
    mocks.fetchAhsServiceOrderPrefill.mockResolvedValue({
      status: "found",
      ...PROC.american_home_shield,
      partnerId: "AHS123",
      clientName: "American Home Shield",
      brand: "Whirlpool",
      parts: [
        { partNumber: "WPW10503278", description: "Electronic control board", quantity: 1, unitPrice: 245 },
        { partNumber: "W10820048", quantity: 2 },
      ],
    });
    await submit(body());
    const draft = JSON.parse(inserted().ahsDetails);
    expect(draft.parts).toEqual([
      {
        partNumber: "WPW10503278",
        description: "Electronic control board",
        quantity: 1,
        unitPrice: 245,
        partFunction: "Controls wash cycle timing",
      },
      { partNumber: "W10820048", quantity: 2 },
    ]);
    expect(draft).toMatchObject({ applianceGrade: "top", applianceColor: "Black Stainless Steel", brand: "Whirlpool" });
    expect(draft.prefilledFields).toEqual(["brand", "parts"]);
  });

  it("a resubmission stores what's sent and keeps the manager's correction the tech didn't change", async () => {
    mocks.previous = {
      id: 800,
      technicianId: TECH_ID,
      serviceOrder: "8175-13538277",
      ticketStatus: "rejected",
      ahsDetails: JSON.stringify({ applianceGrade: "mid", applianceColor: "White", parts: [{ partFunction: "Pump" }] }),
      techApplianceDetails: JSON.stringify(tech),
    };
    const sent = { ...tech, applianceColor: "Bisque" };
    const res = await submit(body({ resubmissionOf: 800, techApplianceDetails: sent }));
    expect(res.status).toBe(201);
    expect(JSON.parse(inserted().techApplianceDetails)).toEqual(sent);
    expect(JSON.parse(inserted().ahsDetails)).toEqual({
      applianceGrade: "mid", // manager's correction; the tech sent the same grade as before
      applianceColor: "Bisque", // the tech changed it
      parts: [{ partFunction: "Pump" }],
    });
  });
});
