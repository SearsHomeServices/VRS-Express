import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, storage } from "../server/storage";
import { submissionNotes, submissions, users } from "../shared/schema";

const serviceOrders = ["9998-58000001", "9998-58000002"];
let technicianId: number;
let adminId: number;
let openSubmissionId: number;
let raceSubmissionId: number;

beforeAll(async () => {
  const userRows = await db.select().from(users);
  const technician = userRows.find((user) => user.racId === "testtech1");
  const admin = userRows.find((user) => user.role === "admin" || user.role === "super_admin");
  if (!technician || !admin) throw new Error("Required seeded technician/admin users were not found");
  technicianId = technician.id;
  adminId = admin.id;

  await db.delete(submissions).where(inArray(submissions.serviceOrder, serviceOrders));
  const inserted = await db.insert(submissions).values(serviceOrders.map((serviceOrder) => ({
    technicianId,
    racId: "testtech1",
    phone: "5550001111",
    serviceOrder,
    applianceType: "laundry",
    requestType: "authorization",
    issueDescription: "Submission note concurrency fixture",
    ticketStatus: "pending",
    stage1Status: "pending",
  } as any))).returning();
  [openSubmissionId, raceSubmissionId] = inserted.map((row) => row.id);
});

afterAll(async () => {
  await db.delete(submissions).where(inArray(submissions.serviceOrder, serviceOrders));
});

describe("submission note persistence policy", () => {
  it("keeps simultaneous appends and filters staff-only notes from owner reads", async () => {
    const results = await Promise.all(["first", "second"].map((body) =>
      storage.atomicCreateSubmissionNote({
        submissionId: openSubmissionId,
        authorId: adminId,
        authorRole: "admin",
        body,
        allDivisionCount: 8,
      }),
    ));
    expect(results.every((result) => result.ok)).toBe(true);

    await db.update(submissions)
      .set({ ticketStatus: "completed", statusChangedAt: new Date() })
      .where(eq(submissions.id, openSubmissionId));
    const staffResult = await storage.atomicCreateSubmissionNote({
      submissionId: openSubmissionId,
      authorId: adminId,
      authorRole: "admin",
      body: "staff only",
      allDivisionCount: 8,
    });
    expect(staffResult.ok).toBe(true);

    // NULL simulates a pre-migration historical row and must remain shared.
    await db.insert(submissionNotes).values({
      submissionId: openSubmissionId,
      authorId: technicianId,
      authorRole: "technician",
      visibility: null,
      body: "legacy shared",
    });

    const staffView = await storage.getSubmissionNotes(openSubmissionId, true);
    const ownerView = await storage.getSubmissionNotes(openSubmissionId, false);
    expect(staffView.map((note) => note.body)).toEqual(expect.arrayContaining([
      "first", "second", "staff only", "legacy shared",
    ]));
    expect(ownerView.map((note) => note.body)).toEqual(expect.arrayContaining([
      "first", "second", "legacy shared",
    ]));
    expect(ownerView.map((note) => note.body)).not.toContain("staff only");
  });

  it("rechecks status under a row lock before an owner append", async () => {
    let blockedPost!: Promise<Awaited<ReturnType<typeof storage.atomicCreateSubmissionNote>>>;
    await db.transaction(async (tx) => {
      await tx.update(submissions)
        .set({ ticketStatus: "completed", statusChangedAt: new Date() })
        .where(eq(submissions.id, raceSubmissionId));
      blockedPost = storage.atomicCreateSubmissionNote({
        submissionId: raceSubmissionId,
        authorId: technicianId,
        authorRole: "technician",
        body: "must not become shared",
        allDivisionCount: 8,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(await blockedPost).toEqual({ ok: false, reason: "closed_to_owner" });
    expect(await storage.getSubmissionNotes(raceSubmissionId, true)).toHaveLength(0);
  });
});