import { createServer } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submission: undefined as Record<string, any> | undefined,
  getSubmission: vi.fn(),
  getSmsNotifications: vi.fn(),
  getSubmissionHistory: vi.fn(),
  getUser: vi.fn(),
  getBridgeStatus: vi.fn(),
}));

vi.mock("../server/storage", () => ({
  storage: {
    getSubmission: mocks.getSubmission,
    getSmsNotifications: mocks.getSmsNotifications,
    getSubmissionHistory: mocks.getSubmissionHistory,
    getUser: mocks.getUser,
  },
  pool: { query: vi.fn(), connect: vi.fn() },
  db: { execute: vi.fn(), transaction: vi.fn() },
  getSubmissionsDataVersion: vi.fn(() => 0),
}));

vi.mock("../server/seed", () => ({
  seedDatabase: vi.fn(async () => undefined),
}));

vi.mock("../server/replit_integrations/object_storage", () => ({
  registerObjectStorageRoutes: vi.fn(),
}));

vi.mock("../server/replit_integrations/object_storage/objectStorage", () => ({
  ObjectStorageService: class {},
}));

vi.mock("../server/vrs-bridge-photo-storage", () => ({
  VRS_BRIDGE_PHOTO_RETENTION_MS: 1,
  VrsBridgePhotoStorage: class {
    get = vi.fn();
    save = vi.fn();
  },
}));

vi.mock("../server/vrs-sasha-store", () => ({
  vrsBridgeStore: {
    getStatusBySubmissionId: mocks.getBridgeStatus,
  },
}));

vi.mock("../server/websocket", () => ({
  broadcastToDivisionAgents: vi.fn(),
  broadcastToNlaDivisionAgents: vi.fn(),
  broadcastToAdmins: vi.fn(),
  broadcastToAllAgents: vi.fn(),
  broadcastToAgent: vi.fn(),
  broadcastToTechnicians: vi.fn(),
  updateClientStatus: vi.fn(),
  updateClientDivisions: vi.fn(),
  getWarrantyLabel: vi.fn(),
  getDivisionLabel: vi.fn(),
  getLiveSessionCount: vi.fn(() => 0),
  forceDisconnectUser: vi.fn(),
}));

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  SESSION_SECRET: process.env.SESSION_SECRET,
  VRS_BRIDGE_PHOTO_PROXY_ENABLED: process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED,
};

function token(id: number, role: string): string {
  return jwt.sign(
    { id, email: `${role}@example.test`, name: role, role },
    process.env.SESSION_SECRET!,
  );
}

function getAudit(app: express.Express, role: string, id = 41) {
  const userId = role === "admin" ? 101 : role === "super_admin" ? 102 : 103;
  return request(app)
    .get(`/api/admin/submissions/${id}/audit`)
    .set("Authorization", `Bearer ${token(userId, role)}`);
}

describe("registered admin submission audit endpoint", () => {
  let app: express.Express;

  beforeAll(async () => {
    process.env.SESSION_SECRET = "vrs-admin-audit-test-secret";
    const { registerRoutes } = await import("../server/routes");
    app = express();
    app.use(express.json());
    await registerRoutes(createServer(app), app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "development";
    process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED = "true";

    mocks.submission = {
      id: 41,
      technicianId: 201,
      assignedTo: null,
      reviewedBy: null,
      stage1ReviewedBy: null,
      stage2ReviewedBy: null,
      serviceOrder: "0001-12345678",
      applianceType: "refrigeration",
      requestType: "authorization",
      ticketStatus: "pending",
      photos: JSON.stringify({
        issue: ["/objects/.private/legacy-issue.jpg"],
        estimate: ["/objects/.private/techhub-estimate.jpg"],
      }),
      photoThumbnails: JSON.stringify({
        "/objects/.private/techhub-estimate.jpg": "/objects/.private/techhub-thumb.jpg",
      }),
      videoUrl: "/objects/.private/legacy-video.mp4",
      voiceNoteUrl: "/objects/.private/legacy-note.webm",
      rejectedMedia: JSON.stringify(["/objects/.private/rejected.jpg"]),
      createdAt: new Date("2026-09-18T12:00:00.000Z"),
      updatedAt: new Date("2026-09-18T12:05:00.000Z"),
      statusChangedAt: null,
    };
    mocks.getSubmission.mockImplementation(async () => mocks.submission);
    mocks.getSmsNotifications.mockResolvedValue([]);
    mocks.getSubmissionHistory.mockResolvedValue([mocks.submission]);
    mocks.getUser.mockImplementation(async (id: number) => {
      const roles: Record<number, string> = {
        101: "admin",
        102: "super_admin",
        103: "vrs_agent",
      };
      if (roles[id]) return { id, name: roles[id], role: roles[id], isActive: true };
      if (id === 201) return { id, name: "Test Technician", role: "technician", isActive: true };
      return undefined;
    });
    mocks.getBridgeStatus.mockResolvedValue({
      callId: "call-41",
      contractVersion: "v9",
      state: "pending_review",
      providerCallId: "provider-call-41",
      dispatchError: null,
      failureReason: null,
      retryable: null,
      dispatchedAt: null,
      reviewContext: {
        appliance_photos: [
          "https://sasha-dev.stage.nextgen.shs.com/private/a.jpg?signature=secret-a",
          "https://sasha-dev.stage.nextgen.shs.com/private/b.jpg?signature=secret-b",
        ],
      },
    });
  });

  afterAll(() => {
    if (originalEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv.NODE_ENV;
    if (originalEnv.SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalEnv.SESSION_SECRET;
    if (originalEnv.VRS_BRIDGE_PHOTO_PROXY_ENABLED === undefined) {
      delete process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED;
    } else {
      process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED =
        originalEnv.VRS_BRIDGE_PHOTO_PROXY_ENABLED;
    }
  });

  it("includes only same-origin VRS AI photo paths in development and preserves legacy attachments", async () => {
    const response = await getAudit(app, "admin");

    expect(response.status).toBe(200);
    expect(response.body.vrsAi.reviewContext.appliance_photos).toEqual([
      "/api/submissions/41/vrs-ai-photos/0",
      "/api/submissions/41/vrs-ai-photos/1",
    ]);
    expect(JSON.stringify(response.body)).not.toContain("signature");
    expect(JSON.stringify(response.body)).not.toContain("sasha-dev.stage.nextgen.shs.com");
    expect(response.body.submission).toMatchObject({
      photos: mocks.submission!.photos,
      photoThumbnails: mocks.submission!.photoThumbnails,
      videoUrl: mocks.submission!.videoUrl,
      voiceNoteUrl: mocks.submission!.voiceNoteUrl,
      rejectedMedia: mocks.submission!.rejectedMedia,
    });
    expect(mocks.getBridgeStatus).toHaveBeenCalledOnce();
    expect(mocks.getBridgeStatus).toHaveBeenCalledWith(41);
  });

  it("omits VRS AI and never queries the bridge store when disabled", async () => {
    process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED = "false";
    const disabled = await getAudit(app, "admin");

    expect(disabled.status).toBe(200);
    expect(disabled.body).not.toHaveProperty("vrsAi");
    expect(mocks.getBridgeStatus).not.toHaveBeenCalled();
  });

  it("includes VRS AI in production when explicitly enabled", async () => {
    process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED = "true";
    process.env.NODE_ENV = "production";
    const production = await getAudit(app, "super_admin");

    expect(production.status).toBe(200);
    expect(production.body).toHaveProperty("vrsAi");
    expect(mocks.getBridgeStatus).toHaveBeenCalledWith(41);
  });

  it("returns a manual/null-status ticket without inventing bridge status", async () => {
    mocks.submission = {
      ...mocks.submission!,
      requestType: "manual",
      ticketStatus: null,
    };
    mocks.getBridgeStatus.mockResolvedValue(null);

    const response = await getAudit(app, "admin");

    expect(response.status).toBe(200);
    expect(response.body.submission).toMatchObject({
      requestType: "manual",
      ticketStatus: null,
      photos: mocks.submission.photos,
      photoThumbnails: mocks.submission.photoThumbnails,
    });
    expect(response.body.vrsAi).toBeNull();
  });

  it("allows admin roles but rejects other authenticated roles before submission access", async () => {
    const admin = await getAudit(app, "admin");
    const superAdmin = await getAudit(app, "super_admin");
    const readsBeforeDeniedRequest = mocks.getSubmission.mock.calls.length;
    const denied = await getAudit(app, "vrs_agent");

    expect(admin.status).toBe(200);
    expect(superAdmin.status).toBe(200);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: "Access denied" });
    expect(mocks.getSubmission).toHaveBeenCalledTimes(readsBeforeDeniedRequest);
  });

  it("returns 404 for a missing submission without querying related persistence", async () => {
    mocks.getSubmission.mockResolvedValueOnce(undefined);

    const response = await getAudit(app, "admin", 999);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Submission not found" });
    expect(mocks.getSmsNotifications).not.toHaveBeenCalled();
    expect(mocks.getSubmissionHistory).not.toHaveBeenCalled();
    expect(mocks.getBridgeStatus).not.toHaveBeenCalled();
  });
});