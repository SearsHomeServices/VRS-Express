import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and, or, desc, asc, gte, lte, sql, isNull, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  users,
  InsertUser,
  User,
  vrsAgentSpecializations,
  InsertVrsAgentSpecialization,
  VrsAgentSpecialization,
  submissions,
  InsertSubmission,
  Submission,
  smsNotifications,
  InsertSmsNotification,
  SmsNotification,
  dailyRgcCodes,
  InsertDailyRgcCode,
  DailyRgcCode,
  technicians,
  InsertTechnician,
  Technician,
  feedback,
  InsertFeedback,
  Feedback,
  submissionNotes,
  InsertSubmissionNote,
  SubmissionNote,
  TechnicianUserView,
  systemSettings,
  SystemSetting,
  intakeForms,
  InsertIntakeForm,
  IntakeForm,
  agentExternalCredentials,
  InsertAgentExternalCredential,
  AgentExternalCredential,
  communicationTemplates,
  InsertCommunicationTemplate,
  CommunicationTemplate,
  communicationTemplateVersions,
  CommunicationTemplateVersion,
} from "@shared/schema";
import { getBusinessElapsedMs } from "@shared/business-hours";

// Initialize database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create Drizzle instance
export const db = drizzle(pool);

// Export pool for cleanup
export { pool };

export interface IStorage {
  // User methods
  getUser(id: number): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByRacId(racId: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getUsers(): Promise<User[]>;
  updateUser(id: number, data: Partial<InsertUser>): Promise<User | undefined>;
  deleteUser(id: number): Promise<boolean>;

  // Specialization methods
  getSpecializations(userId: number): Promise<VrsAgentSpecialization[]>;
  setSpecializations(userId: number, divisions: string[]): Promise<void>;
  getAgentsByDivision(division: string): Promise<User[]>;

  // Submission methods
  createSubmission(submission: InsertSubmission): Promise<Submission>;
  getSubmission(id: number): Promise<Submission | undefined>;
  getSubmissions(filters?: {
    technicianId?: number;
    ticketStatus?: string;
    stage1Status?: string;
    stage2Status?: string;
    applianceType?: string;
    assignedTo?: number;
    divisionFilter?: string[];
  }): Promise<Submission[]>;
  getSubmissionsWithTechnician(filters?: {
    technicianId?: number;
    ticketStatus?: string;
    stage1Status?: string;
    stage2Status?: string;
    applianceType?: string;
    assignedTo?: number;
    requestType?: string;
    excludeRequestType?: string;
    divisionFilter?: string[];
  }, completedToday?: boolean): Promise<(Submission & { technicianName: string; technicianPhone: string | null; assignedAgentName: string | null; intakeFormCompletedAt: Date | null })[]>;
  updateSubmission(
    id: number,
    data: Partial<InsertSubmission>
  ): Promise<Submission | undefined>;
  deleteSubmission(id: number): Promise<boolean>;
  getAllSubmissions(startDate?: Date | null, endDate?: Date | null, techLdap?: string | null): Promise<Submission[]>;
  getAgentQueueCount(agentId?: number): Promise<number>;
  getDivisionQueueCount(divisions: string[]): Promise<number>;
  getCompletedTodayCount(agentId?: number): Promise<number>;
  getQueuedCount(divisions: string[]): Promise<number>;
  getQueuedCountAll(): Promise<number>;
  getOnlineAgentCount(): Promise<number>;
  getPendingCount(agentId: number): Promise<number>;

  getNlaQueuedCount(divisions?: string[]): Promise<number>;
  getNlaPendingCount(agentId: number): Promise<number>;
  getNlaCompletedTodayCount(agentId?: number, divisions?: string[]): Promise<number>;
  getNlaAnalytics(): Promise<{ today: number; week: number; month: number; allTime: number }>;

  getStage2QueueCount(agentId?: number): Promise<number>;
  getWarrantyProviderCounts(assignedTo?: number): Promise<{ warrantyProvider: string; count: number }[]>;

  getResubmissionChain(rootId: number): Promise<Submission[]>;
  getSubmissionHistory(serviceOrder: string): Promise<Submission[]>;
  hasRejectedClosedForServiceOrder(serviceOrder: string): Promise<boolean>;
  hasActiveSubmissionForServiceOrder(serviceOrder: string, technicianId: number): Promise<{ exists: boolean; status?: string }>;
  // Idempotency guard for double-submit / network-retry scenarios.
  // Returns the most recent submission by this tech for this SO# created
  // within `withinSeconds`, regardless of ticketStatus or resubmission flag.
  // The route handler treats a hit as "the original request already won —
  // return that row instead of creating a phantom duplicate."
  findRecentDuplicateSubmission(serviceOrder: string, technicianId: number, withinSeconds: number): Promise<Submission | undefined>;
  // Atomic insert-with-idempotency: serializes on advisory lock keyed by
  // (technicianId, hash(serviceOrder)), re-checks for a recent duplicate
  // inside the lock, and inserts only if no sibling request beat us to it.
  // See implementation comment for the rationale.
  createSubmissionWithIdempotency(submission: InsertSubmission, withinSeconds: number): Promise<{ submission: Submission; wasDuplicate: boolean }>;

  // SMS methods
  createSmsNotification(
    notification: InsertSmsNotification
  ): Promise<SmsNotification>;
  getSmsNotifications(submissionId: number): Promise<SmsNotification[]>;

  // RGC methods
  createDailyRgcCode(code: InsertDailyRgcCode): Promise<DailyRgcCode>;
  getDailyRgcCode(date: string): Promise<DailyRgcCode | undefined>;
  upsertDailyRgcCode(data: { code: string; validDate: string; createdBy: number | null }): Promise<DailyRgcCode>;

  // Technician methods
  getOrCreateTechUser(ldapId: string, name: string, phone: string): Promise<User>;
  /**
   * Lookup-only counterpart to getOrCreateTechUser — returns the users row
   * whose racId matches the given ldap, or undefined. Used by the Tier 2
   * identity-mismatch logger in POST /api/submissions (2026-04-28 hotfix).
   */
  getTechUserByLdapId(ldapId: string): Promise<User | undefined>;

  getTechnicianByLdapId(ldapId: string): Promise<Technician | undefined>;
  getTechnicians(activeOnly?: boolean): Promise<Technician[]>;
  upsertTechnician(data: InsertTechnician): Promise<Technician>;
  deactivateTechniciansNotIn(ldapIds: string[]): Promise<number>;
  getTechnicianSyncInfo(): Promise<{ activeCount: number; lastSyncedAt: Date | null }>;

  getAgentsWithStatus(): Promise<{ id: number; name: string; racId: string | null; agentStatus: string; divisions: string[]; updatedAt: Date | null }[]>;

  createFeedback(data: InsertFeedback): Promise<Feedback>;
  getFeedbackList(): Promise<(Feedback & { resolvedByName: string | null })[]>;
  getFeedback(id: number): Promise<Feedback | undefined>;
  updateFeedback(id: number, data: Partial<InsertFeedback>): Promise<Feedback | undefined>;

  createSubmissionNote(data: InsertSubmissionNote): Promise<SubmissionNote>;
  getSubmissionNotes(submissionId: number): Promise<(SubmissionNote & { authorName: string })[]>;

  getAnalytics(): Promise<{
    submissionsToday: number;
    submissionsThisWeek: number;
    submissionsThisMonth: number;
    totalSubmissions: number;
    approvedCount: number;
    rejectedCount: number;
    pendingCount: number;
    avgTimeToStage1Ms: number | null;
    avgTimeToAuthCodeMs: number | null;
  }>;

  getResubmissionStats(): Promise<{
    totalResubmissions: number;
    resubmissionRate: number;
    topTechnicians: { technicianId: number; techName: string; techLdap: string; totalTickets: number; resubmissions: number; rate: number }[];
  }>;

  getDistrictRollup(): Promise<{
    district: string;
    totalTickets: number;
    approved: number;
    rejected: number;
    pending: number;
    completed: number;
    avgTimeToStage1Ms: number | null;
  }[]>;

  getTechnicianUsers(): Promise<TechnicianUserView[]>;

  getSystemSetting(key: string): Promise<string | undefined>;
  setSystemSetting(key: string, value: string): Promise<void>;

  // Smartsheet "VRS Unrep Intake Form 2.0" audit rows
  createIntakeForm(data: InsertIntakeForm): Promise<IntakeForm>;
  getIntakeFormBySubmission(submissionId: number): Promise<IntakeForm | undefined>;
  // Tyler 2026-04-29 (architect-review fix): atomic create that holds a
  // SELECT ... FOR UPDATE lock on the parent submissions row across the
  // existing-check + ticket_status check + INSERT. Closes the race where
  // two concurrent /intake-form/confirm requests could both pass a naive
  // duplicate-check and both insert. Returns a discriminated result the
  // route handler maps to HTTP statuses (200/404/409).
  atomicCreateIntakeForm(data: InsertIntakeForm): Promise<
    | { ok: true; intakeForm: IntakeForm }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "not_approved"; ticketStatus: string }
    | { ok: false; reason: "duplicate"; existing: IntakeForm }
  >;
  // NOTE: getMissingIntakeForAgent removed 2026-04-26 (Tyler D2). The
  // intake_forms table is still written as audit trail, but agents are
  // no longer gated on completing it before claiming the next ticket.
  // See ADR-013.

  // Atomic ticket-claim — succeeds only if the row is still 'queued'
  claimSubmission(
    submissionId: number,
    agentId: number
  ): Promise<Submission | undefined>;

  // Encrypted per-agent credentials for external tools (e.g. calculator)
  getAgentCredential(
    userId: number,
    service: string
  ): Promise<AgentExternalCredential | undefined>;
  upsertAgentCredential(
    data: InsertAgentExternalCredential
  ): Promise<AgentExternalCredential>;
  deleteAgentCredential(userId: number, service: string): Promise<boolean>;
}

export class DatabaseStorage implements IStorage {
  // User methods
  async getUser(id: number): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db
      .select()
      .from(users)
      .where(eq(users.email, email));
    return result[0];
  }

  async getUserByRacId(racId: string): Promise<User | undefined> {
    const result = await db
      .select()
      .from(users)
      .where(sql`lower(${users.racId}) = ${racId.toLowerCase()}`);
    return result[0];
  }

  async createUser(user: InsertUser): Promise<User> {
    const result = await db.insert(users).values(user).returning();
    return result[0];
  }

  async getUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(
      sql`CASE WHEN name LIKE 'Test %' THEN 0 ELSE 1 END`,
      sql`CASE role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 WHEN 'vrs_agent' THEN 2 WHEN 'technician' THEN 3 ELSE 4 END`,
      users.name
    );
  }

  async updateUser(
    id: number,
    data: Partial<InsertUser>
  ): Promise<User | undefined> {
    const result = await db
      .update(users)
      .set(data)
      .where(eq(users.id, id))
      .returning();
    return result[0];
  }

  async deleteUser(id: number): Promise<boolean> {
    const user = await this.getUser(id);
    if (!user) return false;
    if (user.isSystemAccount) {
      throw new Error("Cannot delete system accounts");
    }

    const techSubmissions = await db.select({ id: submissions.id }).from(submissions).where(eq(submissions.technicianId, id));
    if (techSubmissions.length > 0) {
      console.warn(`[deleteUser] WARNING: Cascading delete of ${techSubmissions.length} submissions for user ${id} (${user.racId})`);
      const subIds = techSubmissions.map(s => s.id);
      await db.delete(smsNotifications).where(inArray(smsNotifications.submissionId, subIds));
      await db.delete(submissions).where(inArray(submissions.id, subIds));
    }

    await db.delete(vrsAgentSpecializations).where(eq(vrsAgentSpecializations.userId, id));
    await db.update(dailyRgcCodes).set({ createdBy: null } as any).where(eq(dailyRgcCodes.createdBy, id));
    await db.update(submissions).set({ assignedTo: null } as any).where(eq(submissions.assignedTo, id));
    await db.update(submissions).set({ stage1ReviewedBy: null } as any).where(eq(submissions.stage1ReviewedBy, id));
    await db.update(submissions).set({ stage2ReviewedBy: null } as any).where(eq(submissions.stage2ReviewedBy, id));
    await db.update(feedback).set({ resolvedBy: null } as any).where(eq(feedback.resolvedBy, id));
    await db.delete(feedback).where(eq(feedback.technicianId, id));
    const result = await db.delete(users).where(eq(users.id, id)).returning();
    console.log(`[deleteUser] Deleted user ${id} (${user.racId}, role=${user.role})`);
    return result.length > 0;
  }

  // Specialization methods
  async getSpecializations(
    userId: number
  ): Promise<VrsAgentSpecialization[]> {
    return await db
      .select()
      .from(vrsAgentSpecializations)
      .where(eq(vrsAgentSpecializations.userId, userId));
  }

  async setSpecializations(
    userId: number,
    divisions: string[]
  ): Promise<void> {
    // Delete existing specializations for the user
    await db
      .delete(vrsAgentSpecializations)
      .where(eq(vrsAgentSpecializations.userId, userId));

    // Insert new specializations
    if (divisions.length > 0) {
      const specs = divisions.map((division) => ({
        userId,
        division,
      }));
      await db.insert(vrsAgentSpecializations).values(specs);
    }
  }

  async getAgentsByDivision(division: string): Promise<User[]> {
    const result = await db
      .select({ user: users })
      .from(users)
      .leftJoin(
        vrsAgentSpecializations,
        eq(users.id, vrsAgentSpecializations.userId)
      )
      .where(
        or(
          eq(vrsAgentSpecializations.division, division),
          eq(vrsAgentSpecializations.division, "generalist")
        )
      )
      .groupBy(users.id);

    return result.map((r) => r.user);
  }

  // Submission methods
  async createSubmission(submission: InsertSubmission): Promise<Submission> {
    const result = await db
      .insert(submissions)
      .values(submission)
      .returning();
    return result[0];
  }

  // 2026-04-30 — Architect-flagged race-window close. The pre-handler call
  // to `findRecentDuplicateSubmission` catches the common sequential-retry
  // case (network drop → client retry seconds later — first row already in
  // DB). It does NOT close the concurrent-tap race where two requests both
  // pass the check before either inserts. This method does:
  //   1. Acquire a transaction-scoped advisory lock keyed on
  //      (technicianId, hash(serviceOrder)) so concurrent requests for the
  //      same (tech, SO#) pair serialize on the lock instead of racing.
  //   2. Re-check for a recent duplicate INSIDE the lock — if a sibling
  //      request inserted while we were waiting, return that row and skip
  //      our insert + downstream SMS / broadcast work.
  //   3. Otherwise insert and return the new row.
  // The transaction is short (lock + select + insert), so it does NOT hold
  // a connection across the external procId fetch — that runs before this
  // call. Auto-releases the lock at COMMIT/ROLLBACK.
  async createSubmissionWithIdempotency(
    submission: InsertSubmission,
    withinSeconds: number
  ): Promise<{ submission: Submission; wasDuplicate: boolean }> {
    return await db.transaction(async (tx) => {
      // pg_advisory_xact_lock has a two-int4 overload; combine technicianId
      // (small int4) with a hash of the SO# string (also int4). djb2-ish
      // hash, signed-int32-truncated via `| 0` so the result fits int4.
      let soHash = 0;
      const so = submission.serviceOrder;
      for (let i = 0; i < so.length; i++) {
        soHash = ((soHash << 5) - soHash + so.charCodeAt(i)) | 0;
      }
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${submission.technicianId}, ${soHash})`);

      const cutoff = new Date(Date.now() - withinSeconds * 1000);
      const dup = await tx
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.serviceOrder, so),
            eq(submissions.technicianId, submission.technicianId),
            gte(submissions.createdAt, cutoff)
          )
        )
        .orderBy(desc(submissions.createdAt))
        .limit(1);
      if (dup[0]) {
        return { submission: dup[0], wasDuplicate: true };
      }

      const [created] = await tx.insert(submissions).values(submission).returning();
      return { submission: created, wasDuplicate: false };
    });
  }

  async getSubmission(id: number): Promise<Submission | undefined> {
    const result = await db
      .select()
      .from(submissions)
      .where(eq(submissions.id, id));
    return result[0];
  }

  async getSubmissions(filters?: {
    technicianId?: number;
    ticketStatus?: string;
    stage1Status?: string;
    stage2Status?: string;
    applianceType?: string;
    assignedTo?: number;
    divisionFilter?: string[];
  }): Promise<Submission[]> {
    const conditions: ReturnType<typeof eq>[] = [];

    if (filters?.technicianId !== undefined) {
      conditions.push(eq(submissions.technicianId, filters.technicianId));
    }

    if (filters?.ticketStatus !== undefined) {
      conditions.push(eq(submissions.ticketStatus, filters.ticketStatus));
    }

    if (filters?.stage1Status !== undefined) {
      conditions.push(eq(submissions.stage1Status, filters.stage1Status));
    }

    if (filters?.stage2Status !== undefined) {
      conditions.push(eq(submissions.stage2Status, filters.stage2Status));
    }

    if (filters?.applianceType !== undefined) {
      conditions.push(eq(submissions.applianceType, filters.applianceType));
    }

    if (filters?.assignedTo !== undefined) {
      conditions.push(eq(submissions.assignedTo, filters.assignedTo));
    }

    if (filters?.divisionFilter !== undefined && filters.divisionFilter.length > 0) {
      const hasNla = filters.divisionFilter.includes("nla");
      const applianceDivisions = filters.divisionFilter.filter(d => d !== "nla" && d !== "generalist");
      if (hasNla && applianceDivisions.length > 0) {
        conditions.push(or(
          inArray(submissions.applianceType, applianceDivisions),
          eq(submissions.requestType, "parts_nla")
        ) as any);
      } else if (hasNla) {
        conditions.push(eq(submissions.requestType, "parts_nla"));
      } else {
        conditions.push(inArray(submissions.applianceType, applianceDivisions) as any);
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    return await db
      .select()
      .from(submissions)
      .where(whereClause)
      .orderBy(desc(submissions.createdAt));
  }

  async updateSubmission(
    id: number,
    data: Partial<InsertSubmission>
  ): Promise<Submission | undefined> {
    const result = await db
      .update(submissions)
      .set(data)
      .where(eq(submissions.id, id))
      .returning();
    return result[0];
  }

  async deleteSubmission(id: number): Promise<boolean> {
    await db.delete(smsNotifications).where(eq(smsNotifications.submissionId, id));
    const result = await db.delete(submissions).where(eq(submissions.id, id)).returning();
    return result.length > 0;
  }

  async getAllSubmissions(startDate?: Date | null, endDate?: Date | null, techLdap?: string | null): Promise<Submission[]> {
    const conditions = [];
    if (startDate) conditions.push(gte(submissions.createdAt, startDate));
    if (endDate) conditions.push(lte(submissions.createdAt, endDate));
    if (techLdap) conditions.push(sql`lower(${submissions.technicianLdapId}) = ${techLdap.toLowerCase()}`);

    if (conditions.length > 0) {
      return db.select().from(submissions).where(and(...conditions)).orderBy(desc(submissions.createdAt));
    }
    return db.select().from(submissions).orderBy(desc(submissions.createdAt));
  }

  async getSubmissionsWithTechnician(filters?: {
    technicianId?: number;
    ticketStatus?: string;
    stage1Status?: string;
    stage2Status?: string;
    applianceType?: string;
    assignedTo?: number;
    requestType?: string;
    excludeRequestType?: string;
    divisionFilter?: string[];
  }, completedToday?: boolean): Promise<(Submission & { technicianName: string; technicianPhone: string | null; assignedAgentName: string | null; intakeFormCompletedAt: Date | null })[]> {
    const conditions: ReturnType<typeof eq>[] = [];

    if (filters?.technicianId !== undefined) {
      conditions.push(eq(submissions.technicianId, filters.technicianId));
    }
    if (filters?.ticketStatus !== undefined) {
      conditions.push(eq(submissions.ticketStatus, filters.ticketStatus));
    }
    if (filters?.stage1Status !== undefined) {
      conditions.push(eq(submissions.stage1Status, filters.stage1Status));
    }
    if (filters?.stage2Status !== undefined) {
      conditions.push(eq(submissions.stage2Status, filters.stage2Status));
    }
    if (filters?.applianceType !== undefined) {
      conditions.push(eq(submissions.applianceType, filters.applianceType));
    }
    if (filters?.assignedTo !== undefined) {
      conditions.push(eq(submissions.assignedTo, filters.assignedTo));
    }
    if (filters?.requestType !== undefined) {
      conditions.push(eq(submissions.requestType, filters.requestType));
    }
    if (filters?.excludeRequestType !== undefined) {
      conditions.push(sql`${submissions.requestType} != ${filters.excludeRequestType}` as any);
    }
    if (filters?.divisionFilter !== undefined && filters.divisionFilter.length > 0) {
      const hasNla = filters.divisionFilter.includes("nla");
      const applianceDivisions = filters.divisionFilter.filter(d => d !== "nla" && d !== "generalist");
      const isNlaSpecificQuery = filters.requestType === "parts_nla";
      if (isNlaSpecificQuery && applianceDivisions.length > 0) {
        conditions.push(inArray(submissions.applianceType, applianceDivisions) as any);
      } else if (hasNla && applianceDivisions.length > 0 && !isNlaSpecificQuery) {
        conditions.push(or(
          inArray(submissions.applianceType, applianceDivisions),
          eq(submissions.requestType, "parts_nla")
        ) as any);
      } else if (hasNla) {
      } else if (applianceDivisions.length > 0) {
        conditions.push(inArray(submissions.applianceType, applianceDivisions) as any);
      }
    }
    if (completedToday) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      conditions.push(
        sql`${submissions.reviewedAt} >= ${today}` as any
      );
      conditions.push(
        sql`${submissions.ticketStatus} IN ('completed', 'approved', 'rejected', 'invalid')` as any
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const assignedAgent = alias(users, "assignedAgent");

    const result = await db
      .select({
        submission: submissions,
        technicianName: users.name,
        technicianPhone: users.phone,
        ldapTechName: technicians.name,
        ldapTechPhone: technicians.phone,
        assignedAgentName: assignedAgent.name,
        // Tyler 2026-04-29 (architect-review fix): surface intake-form
        // completion onto the row so the admin Ticket Overview table can
        // show the "Intake Form Complete" column without an N+1 round trip
        // per ticket. Use a correlated subquery (MAX over agent_confirmed_at)
        // instead of LEFT JOIN intake_forms so we cannot inflate the
        // submission row count if multiple intake_forms rows ever exist for
        // a single submission (the current schema has no UNIQUE on
        // submission_id). One row per submission, guaranteed.
        intakeFormCompletedAt: sql<Date | null>`(
          SELECT MAX(${intakeForms.agentConfirmedAt})
          FROM ${intakeForms}
          WHERE ${intakeForms.submissionId} = ${submissions.id}
        )`,
      })
      .from(submissions)
      .innerJoin(users, eq(submissions.technicianId, users.id))
      .leftJoin(technicians, eq(submissions.technicianLdapId, technicians.ldapId))
      .leftJoin(assignedAgent, eq(submissions.assignedTo, assignedAgent.id))
      .where(whereClause)
      .orderBy(filters?.ticketStatus === "queued" ? asc(submissions.createdAt) : desc(submissions.createdAt));

    return result.map((r) => ({
      ...r.submission,
      technicianName: r.ldapTechName || r.technicianName,
      technicianPhone: r.submission.phoneOverride || r.ldapTechPhone || r.technicianPhone,
      assignedAgentName: r.assignedAgentName,
      racId: r.submission.technicianLdapId || "",
      intakeFormCompletedAt: r.intakeFormCompletedAt,
    }));
  }

  async getCompletedTodayCount(agentId?: number): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const conditions: any[] = [
      or(
        eq(submissions.stage1Status, "approved"),
        eq(submissions.stage1Status, "rejected")
      ),
      sql`${submissions.stage1ReviewedAt} >= ${today}`,
      sql`${submissions.requestType} != 'parts_nla'`,
    ];
    if (agentId !== undefined) {
      conditions.push(eq(submissions.assignedTo, agentId));
    }
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(submissions)
      .where(and(...conditions));
    return result[0]?.count || 0;
  }

  async getAgentQueueCount(agentId?: number): Promise<number> {
    const conditions = [
      or(
        eq(submissions.stage1Status, "pending"),
        and(
          eq(submissions.stage1Status, "approved"),
          eq(submissions.stage2Status, "pending")
        )
      ),
    ];
    if (agentId !== undefined) {
      conditions.push(eq(submissions.assignedTo, agentId));
    }
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(submissions)
      .where(and(...conditions));
    return result[0]?.count || 0;
  }

  async getDivisionQueueCount(divisions: string[]): Promise<number> {
    const allDivisions = ["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other", "nla"];
    const isGeneralist = divisions.length >= allDivisions.length;

    const conditions: any[] = [
      eq(submissions.stage1Status, "pending"),
    ];

    if (!isGeneralist && divisions.length > 0) {
      conditions.push(inArray(submissions.applianceType, divisions));
    }

    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(submissions)
      .where(and(...conditions));
    return result[0]?.count || 0;
  }

  async getStage2QueueCount(agentId?: number): Promise<number> {
    const conditions = [
      eq(submissions.stage1Status, "approved"),
      eq(submissions.stage2Status, "pending"),
    ];
    if (agentId !== undefined) {
      conditions.push(eq(submissions.assignedTo, agentId));
    }
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(submissions)
      .where(and(...conditions));
    return result[0]?.count || 0;
  }

  async getQueuedCount(divisions: string[]): Promise<number> {
    const allDivisions = ["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other", "nla"];
    const isGeneralist = divisions.length >= allDivisions.length;
    const conditions: any[] = [
      eq(submissions.ticketStatus, "queued"),
      sql`${submissions.requestType} != 'parts_nla'`,
    ];
    if (!isGeneralist && divisions.length > 0) {
      const appDivisions = divisions.filter(d => d !== "nla");
      if (appDivisions.length > 0) {
        conditions.push(inArray(submissions.applianceType, appDivisions));
      }
    }
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(submissions)
      .where(and(...conditions));
    return result[0]?.count || 0;
  }

  async getQueuedCountAll(): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(submissions)
      .where(eq(submissions.ticketStatus, "queued"));
    return Number(result[0]?.count) || 0;
  }

  async getOnlineAgentCount(): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(and(
        eq(users.role, "vrs_agent"),
        eq(users.agentStatus, "online"),
        eq(users.isActive, true)
      ));
    return Number(result[0]?.count) || 0;
  }

  async getPendingCount(agentId: number): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(submissions)
      .where(and(
        eq(submissions.ticketStatus, "pending"),
        eq(submissions.assignedTo, agentId),
        sql`${submissions.requestType} != 'parts_nla'`
      ));
    return result[0]?.count || 0;
  }

  async getWarrantyProviderCounts(assignedTo?: number): Promise<{ warrantyProvider: string; count: number }[]> {
    const conditions = [
      eq(submissions.stage1Status, "approved"),
      eq(submissions.stage2Status, "pending"),
    ];
    if (assignedTo !== undefined) {
      conditions.push(eq(submissions.assignedTo, assignedTo));
    }

    const result = await db
      .select({
        warrantyProvider: sql<string>`COALESCE(${submissions.warrantyProvider}, ${submissions.warrantyType})`,
        count: sql<number>`count(*)`,
      })
      .from(submissions)
      .where(and(...conditions))
      .groupBy(sql`COALESCE(${submissions.warrantyProvider}, ${submissions.warrantyType})`);

    return result.map((r) => ({
      warrantyProvider: r.warrantyProvider,
      count: Number(r.count),
    }));
  }

  async getResubmissionChain(rootId: number): Promise<Submission[]> {
    return await db
      .select()
      .from(submissions)
      .where(eq(submissions.resubmissionOf, rootId))
      .orderBy(submissions.createdAt);
  }

  async getSubmissionHistory(serviceOrder: string): Promise<Submission[]> {
    return await db
      .select()
      .from(submissions)
      .where(eq(submissions.serviceOrder, serviceOrder))
      .orderBy(submissions.createdAt);
  }

  async hasRejectedClosedForServiceOrder(serviceOrder: string): Promise<boolean> {
    const results = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(
          eq(submissions.serviceOrder, serviceOrder),
          eq(submissions.ticketStatus, "rejected_closed")
        )
      )
      .limit(1);
    return results.length > 0;
  }

  async hasActiveSubmissionForServiceOrder(serviceOrder: string, technicianId: number): Promise<{ exists: boolean; status?: string }> {
    const activeStatuses = ["queued", "pending", "completed"];
    const results = await db
      .select({ id: submissions.id, ticketStatus: submissions.ticketStatus })
      .from(submissions)
      .where(
        and(
          eq(submissions.serviceOrder, serviceOrder),
          eq(submissions.technicianId, technicianId),
          inArray(submissions.ticketStatus, activeStatuses)
        )
      )
      .limit(1);
    if (results.length > 0) {
      return { exists: true, status: results[0].ticketStatus };
    }
    return { exists: false };
  }

  // 2026-04-30 — Tyler request: server-side idempotency for double-submit /
  // retry-after-flaky-cell scenarios. The submit button disables while in
  // flight, and `hasActiveSubmissionForServiceOrder` blocks duplicates against
  // queued/pending/completed rows for non-resubmissions. Neither protects
  // against (a) two requests racing past that check before either commits,
  // or (b) a resubmission flow accidentally being submitted twice. A 60s
  // window safely brackets both — legitimate resubmissions happen minutes or
  // hours apart, never within a minute.
  async findRecentDuplicateSubmission(serviceOrder: string, technicianId: number, withinSeconds: number): Promise<Submission | undefined> {
    const cutoff = new Date(Date.now() - withinSeconds * 1000);
    const results = await db
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.serviceOrder, serviceOrder),
          eq(submissions.technicianId, technicianId),
          gte(submissions.createdAt, cutoff)
        )
      )
      .orderBy(desc(submissions.createdAt))
      .limit(1);
    return results[0];
  }

  // SMS methods
  async createSmsNotification(
    notification: InsertSmsNotification
  ): Promise<SmsNotification> {
    const result = await db
      .insert(smsNotifications)
      .values(notification)
      .returning();
    return result[0];
  }

  async getSmsNotifications(submissionId: number): Promise<SmsNotification[]> {
    return await db
      .select()
      .from(smsNotifications)
      .where(eq(smsNotifications.submissionId, submissionId));
  }

  // RGC methods
  async createDailyRgcCode(code: InsertDailyRgcCode): Promise<DailyRgcCode> {
    const result = await db.insert(dailyRgcCodes).values(code).returning();
    return result[0];
  }

  async getDailyRgcCode(date: string): Promise<DailyRgcCode | undefined> {
    const result = await db
      .select()
      .from(dailyRgcCodes)
      .where(eq(dailyRgcCodes.validDate, date));
    return result[0];
  }

  async upsertDailyRgcCode(data: { code: string; validDate: string; createdBy: number | null }): Promise<DailyRgcCode> {
    const result = await db
      .insert(dailyRgcCodes)
      .values(data)
      .onConflictDoUpdate({
        target: dailyRgcCodes.validDate,
        set: { code: data.code, createdBy: data.createdBy },
      })
      .returning();
    return result[0];
  }

  async getOrCreateTechUser(ldapId: string, name: string, phone: string): Promise<User> {
    const existing = await db.select().from(users).where(eq(users.racId, ldapId));
    if (existing[0]) return existing[0];

    const bcrypt = await import("bcryptjs");
    const randomPassword = await bcrypt.hash(crypto.randomUUID(), 10);
    const result = await db.insert(users).values({
      email: null,
      name: name || ldapId,
      password: randomPassword,
      role: "technician",
      phone: phone || "",
      racId: ldapId,
      isActive: true,
    }).returning();
    return result[0];
  }

  async getTechUserByLdapId(ldapId: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.racId, ldapId));
    return result[0];
  }

  // Technician methods
  async getTechnicianByLdapId(ldapId: string): Promise<Technician | undefined> {
    const result = await db.select().from(technicians).where(eq(technicians.ldapId, ldapId));
    return result[0];
  }

  async getTechnicians(activeOnly?: boolean): Promise<Technician[]> {
    if (activeOnly) {
      return await db.select().from(technicians).where(eq(technicians.isActive, true));
    }
    return await db.select().from(technicians);
  }

  async upsertTechnician(data: InsertTechnician): Promise<Technician> {
    const result = await db
      .insert(technicians)
      .values(data)
      .onConflictDoUpdate({
        target: technicians.ldapId,
        set: {
          name: data.name,
          phone: data.phone,
          district: data.district,
          state: data.state,
          managerName: data.managerName,
          techUnNo: data.techUnNo,
          isActive: data.isActive,
          lastSyncedAt: data.lastSyncedAt,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  }

  async deactivateTechniciansNotIn(ldapIds: string[]): Promise<number> {
    if (ldapIds.length === 0) return 0;
    const protectedIds = ["testtech1", "tmorri1"];
    const allProtected = [...new Set([...ldapIds, ...protectedIds])];
    const result = await db
      .update(technicians)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(
        eq(technicians.isActive, true),
        sql`${technicians.ldapId} NOT IN (${sql.join(allProtected.map(id => sql`${id}`), sql`, `)})`
      ))
      .returning();
    return result.length;
  }

  async getTechnicianSyncInfo(): Promise<{ activeCount: number; lastSyncedAt: Date | null }> {
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(technicians)
      .where(eq(technicians.isActive, true));
    const lastSyncResult = await db
      .select({ lastSynced: sql<Date | null>`max(${technicians.lastSyncedAt})` })
      .from(technicians);
    return {
      activeCount: Number(countResult[0]?.count) || 0,
      lastSyncedAt: lastSyncResult[0]?.lastSynced || null,
    };
  }

  async getAgentsWithStatus(): Promise<{ id: number; name: string; racId: string | null; agentStatus: string; divisions: string[]; updatedAt: Date | null }[]> {
    const agents = await db
      .select()
      .from(users)
      .where(and(eq(users.role, "vrs_agent"), eq(users.isActive, true)))
      .orderBy(users.name);

    const result = [];
    for (const agent of agents) {
      const specs = await db
        .select()
        .from(vrsAgentSpecializations)
        .where(eq(vrsAgentSpecializations.userId, agent.id));
      result.push({
        id: agent.id,
        name: agent.name,
        racId: agent.racId,
        agentStatus: agent.agentStatus,
        divisions: specs.map(s => s.division),
        updatedAt: agent.updatedAt,
      });
    }
    return result;
  }

  async getAnalytics(): Promise<{
    submissionsToday: number;
    submissionsThisWeek: number;
    submissionsThisMonth: number;
    totalSubmissions: number;
    approvedCount: number;
    rejectedCount: number;
    pendingCount: number;
    avgTimeToStage1Ms: number | null;
    avgTimeToAuthCodeMs: number | null;
  }> {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Counts stay in SQL (cheap, no business-hours logic needed).
    const countsResult = await db
      .select({
        submissionsToday: sql<number>`count(*) filter (where ${submissions.createdAt} >= ${startOfToday})`,
        submissionsThisWeek: sql<number>`count(*) filter (where ${submissions.createdAt} >= ${sevenDaysAgo})`,
        submissionsThisMonth: sql<number>`count(*) filter (where ${submissions.createdAt} >= ${thirtyDaysAgo})`,
        totalSubmissions: sql<number>`count(*)`,
        approvedCount: sql<number>`count(*) filter (where ${submissions.stage1Status} = 'approved')`,
        rejectedCount: sql<number>`count(*) filter (where ${submissions.stage1Status} = 'rejected')`,
        pendingCount: sql<number>`count(*) filter (where ${submissions.stage1Status} = 'pending')`,
      })
      .from(submissions);

    // Tyler 2026-04-30: averages computed in JS using business-hours math
    // (8 AM-8 PM ET, weekends/holidays included), so overnight time doesn't
    // skew the headline numbers. Mirrors the row-timer logic in
    // admin-dashboard.tsx via the shared `getBusinessElapsedMs` helper.
    const timestampRows = await db
      .select({
        createdAt: submissions.createdAt,
        stage1ReviewedAt: submissions.stage1ReviewedAt,
        stage2ReviewedAt: submissions.stage2ReviewedAt,
      })
      .from(submissions)
      .where(sql`${submissions.stage1ReviewedAt} is not null`);

    let stage1Sum = 0;
    let stage1Count = 0;
    let authCodeSum = 0;
    let authCodeCount = 0;
    for (const r of timestampRows) {
      if (r.createdAt && r.stage1ReviewedAt) {
        stage1Sum += getBusinessElapsedMs(r.createdAt, r.stage1ReviewedAt);
        stage1Count++;
        if (r.stage2ReviewedAt) {
          authCodeSum += getBusinessElapsedMs(r.stage1ReviewedAt, r.stage2ReviewedAt);
          authCodeCount++;
        }
      }
    }

    const row = countsResult[0];
    return {
      submissionsToday: Number(row.submissionsToday) || 0,
      submissionsThisWeek: Number(row.submissionsThisWeek) || 0,
      submissionsThisMonth: Number(row.submissionsThisMonth) || 0,
      totalSubmissions: Number(row.totalSubmissions) || 0,
      approvedCount: Number(row.approvedCount) || 0,
      rejectedCount: Number(row.rejectedCount) || 0,
      pendingCount: Number(row.pendingCount) || 0,
      avgTimeToStage1Ms: stage1Count > 0 ? stage1Sum / stage1Count : null,
      avgTimeToAuthCodeMs: authCodeCount > 0 ? authCodeSum / authCodeCount : null,
    };
  }

  async getResubmissionStats(): Promise<{
    totalResubmissions: number;
    resubmissionRate: number;
    topTechnicians: { technicianId: number; techName: string; techLdap: string; totalTickets: number; resubmissions: number; rate: number }[];
  }> {
    const totalsResult = await db
      .select({
        total: sql<number>`count(*)`,
        resubmissions: sql<number>`count(*) filter (where ${submissions.resubmissionOf} is not null)`,
      })
      .from(submissions);

    const total = Number(totalsResult[0].total) || 0;
    const totalResubs = Number(totalsResult[0].resubmissions) || 0;

    const techRows = await db.execute(sql`
      select
        s.technician_id as "technicianId",
        max(u.name) as "techName",
        max(coalesce(s.technician_ldap_id, u.rac_id, '')) as "techLdap",
        count(*) as "totalTickets",
        count(*) filter (where s.resubmission_of is not null) as "resubmissions"
      from submissions s
      left join users u on u.id = s.technician_id
      group by s.technician_id
      having count(*) filter (where s.resubmission_of is not null) > 0
      order by count(*) filter (where s.resubmission_of is not null) desc
      limit 20
    `);

    const topTechnicians = (techRows.rows as any[]).map(r => ({
      technicianId: Number(r.technicianId),
      techName: r.techName || "Unknown",
      techLdap: r.techLdap || "",
      totalTickets: Number(r.totalTickets),
      resubmissions: Number(r.resubmissions),
      rate: Number(r.totalTickets) > 0 ? Math.round((Number(r.resubmissions) / Number(r.totalTickets)) * 100) : 0,
    }));

    return {
      totalResubmissions: totalResubs,
      resubmissionRate: total > 0 ? Math.round((totalResubs / total) * 100) : 0,
      topTechnicians,
    };
  }

  async getDistrictRollup(): Promise<{
    district: string;
    totalTickets: number;
    approved: number;
    rejected: number;
    pending: number;
    completed: number;
    avgTimeToStage1Ms: number | null;
  }[]> {
    // Counts stay in SQL.
    const countRows = await db.execute(sql`
      select
        coalesce(district_code, 'Unknown') as "district",
        count(*) as "totalTickets",
        count(*) filter (where stage1_status = 'approved') as "approved",
        count(*) filter (where stage1_status = 'rejected') as "rejected",
        count(*) filter (where stage1_status = 'pending') as "pending",
        count(*) filter (where ticket_status in ('completed', 'approved')) as "completed"
      from submissions
      group by district_code
      order by count(*) desc
    `);

    // Tyler 2026-04-30: business-hours-aware avg per district. Fetch only
    // the timestamps needed (small payload — two columns + district), group
    // in JS, average via shared `getBusinessElapsedMs` helper.
    const timestampRows = await db
      .select({
        districtCode: submissions.districtCode,
        createdAt: submissions.createdAt,
        stage1ReviewedAt: submissions.stage1ReviewedAt,
      })
      .from(submissions)
      .where(sql`${submissions.stage1ReviewedAt} is not null`);

    const sumByDistrict = new Map<string, { sum: number; count: number }>();
    for (const r of timestampRows) {
      if (!r.createdAt || !r.stage1ReviewedAt) continue;
      const key = r.districtCode || "Unknown";
      const ms = getBusinessElapsedMs(r.createdAt, r.stage1ReviewedAt);
      const cur = sumByDistrict.get(key) ?? { sum: 0, count: 0 };
      cur.sum += ms;
      cur.count += 1;
      sumByDistrict.set(key, cur);
    }

    return (countRows.rows as any[]).map(r => {
      const districtKey = r.district || "Unknown";
      const agg = sumByDistrict.get(districtKey);
      return {
        district: districtKey,
        totalTickets: Number(r.totalTickets) || 0,
        approved: Number(r.approved) || 0,
        rejected: Number(r.rejected) || 0,
        pending: Number(r.pending) || 0,
        completed: Number(r.completed) || 0,
        avgTimeToStage1Ms: agg && agg.count > 0 ? agg.sum / agg.count : null,
      };
    });
  }

  async createFeedback(data: InsertFeedback): Promise<Feedback> {
    const result = await db.insert(feedback).values(data).returning();
    return result[0];
  }

  async getFeedbackList(): Promise<(Feedback & { resolvedByName: string | null })[]> {
    const resolvedByUser = alias(users, "resolvedByUser");
    const result = await db
      .select({
        feedback: feedback,
        resolvedByName: resolvedByUser.name,
      })
      .from(feedback)
      .leftJoin(resolvedByUser, eq(feedback.resolvedBy, resolvedByUser.id))
      .orderBy(desc(feedback.createdAt));
    return result.map((r) => ({
      ...r.feedback,
      resolvedByName: r.resolvedByName,
    }));
  }

  async getFeedback(id: number): Promise<Feedback | undefined> {
    const result = await db.select().from(feedback).where(eq(feedback.id, id));
    return result[0];
  }

  async updateFeedback(id: number, data: Partial<InsertFeedback>): Promise<Feedback | undefined> {
    const result = await db
      .update(feedback)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(feedback.id, id))
      .returning();
    return result[0];
  }

  async createSubmissionNote(data: InsertSubmissionNote): Promise<SubmissionNote> {
    const [note] = await db.insert(submissionNotes).values(data).returning();
    return note;
  }

  async getSubmissionNotes(
    submissionId: number
  ): Promise<(SubmissionNote & { authorName: string })[]> {
    const rows = await db
      .select({
        id: submissionNotes.id,
        submissionId: submissionNotes.submissionId,
        authorId: submissionNotes.authorId,
        authorRole: submissionNotes.authorRole,
        body: submissionNotes.body,
        createdAt: submissionNotes.createdAt,
        authorName: users.name,
      })
      .from(submissionNotes)
      .leftJoin(users, eq(submissionNotes.authorId, users.id))
      .where(eq(submissionNotes.submissionId, submissionId))
      .orderBy(submissionNotes.createdAt);
    return rows.map((r) => ({ ...r, authorName: r.authorName ?? "Unknown" }));
  }

  async getTechnicianUsers(): Promise<TechnicianUserView[]> {
    const result = await db.execute(sql`
      SELECT
        u.id,
        u.name,
        u.rac_id AS "racId",
        u.phone,
        t.district,
        t.tech_un_no AS "techUnNo",
        t.manager_name AS "managerName",
        COUNT(s.id)::int AS "totalTickets",
        COUNT(CASE WHEN s.ticket_status IN ('queued', 'pending') THEN 1 END)::int AS "pendingCount",
        COUNT(CASE WHEN s.ticket_status IN ('completed', 'approved') THEN 1 END)::int AS "approvedCount",
        COUNT(CASE WHEN s.ticket_status = 'rejected' THEN 1 END)::int AS "rejectedCount"
      FROM users u
      LEFT JOIN technicians t ON u.rac_id = t.ldap_id
      LEFT JOIN submissions s ON u.rac_id = s.technician_ldap_id
      WHERE u.role = 'technician' AND u.is_system_account = false
      GROUP BY u.id, u.name, u.rac_id, u.phone, t.district, t.tech_un_no, t.manager_name
      ORDER BY u.name ASC
    `);
    return result.rows as TechnicianUserView[];
  }

  async getNlaQueuedCount(divisions?: string[]): Promise<number> {
    const allApplianceDivisions = ["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other"];
    const conditions: any[] = [
      eq(submissions.ticketStatus, "queued"),
      eq(submissions.requestType, "parts_nla"),
    ];
    if (divisions && divisions.length > 0) {
      const applianceDivisions = divisions.filter(d => d !== "nla" && d !== "generalist");
      const isApplianceGeneralist = applianceDivisions.length >= allApplianceDivisions.length;
      if (!isApplianceGeneralist && applianceDivisions.length > 0) {
        conditions.push(inArray(submissions.applianceType, applianceDivisions));
      }
    }
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(submissions)
      .where(and(...conditions));
    return Number(result[0]?.count) || 0;
  }

  async getNlaPendingCount(agentId: number): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(submissions)
      .where(and(
        eq(submissions.ticketStatus, "pending"),
        eq(submissions.requestType, "parts_nla"),
        eq(submissions.assignedTo, agentId)
      ));
    return Number(result[0]?.count) || 0;
  }

  async getNlaCompletedTodayCount(agentId?: number, divisions?: string[]): Promise<number> {
    const allApplianceDivisions = ["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other"];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const conditions: any[] = [
      eq(submissions.requestType, "parts_nla"),
      gte(submissions.statusChangedAt, today),
      inArray(submissions.ticketStatus, ["completed", "approved"]),
    ];
    if (agentId) {
      conditions.push(eq(submissions.reviewedBy, agentId));
    }
    if (divisions && divisions.length > 0) {
      const applianceDivisions = divisions.filter(d => d !== "nla" && d !== "generalist");
      const isApplianceGeneralist = applianceDivisions.length >= allApplianceDivisions.length;
      if (!isApplianceGeneralist && applianceDivisions.length > 0) {
        conditions.push(inArray(submissions.applianceType, applianceDivisions));
      }
    }
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(submissions)
      .where(and(...conditions));
    return Number(result[0]?.count) || 0;
  }

  async getNlaAnalytics(): Promise<{ today: number; week: number; month: number; allTime: number }> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const nlaCondition = eq(submissions.requestType, "parts_nla");

    const [allTimeResult] = await db.select({ count: sql<number>`count(*)` }).from(submissions).where(nlaCondition);
    const [todayResult] = await db.select({ count: sql<number>`count(*)` }).from(submissions).where(and(nlaCondition, gte(submissions.createdAt, todayStart)));
    const [weekResult] = await db.select({ count: sql<number>`count(*)` }).from(submissions).where(and(nlaCondition, gte(submissions.createdAt, weekStart)));
    const [monthResult] = await db.select({ count: sql<number>`count(*)` }).from(submissions).where(and(nlaCondition, gte(submissions.createdAt, monthStart)));

    return {
      today: Number(todayResult?.count) || 0,
      week: Number(weekResult?.count) || 0,
      month: Number(monthResult?.count) || 0,
      allTime: Number(allTimeResult?.count) || 0,
    };
  }

  async getSystemSetting(key: string): Promise<string | undefined> {
    const result = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
    return result[0]?.value;
  }

  async setSystemSetting(key: string, value: string): Promise<void> {
    await db.insert(systemSettings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  // ==========================================================================
  // Intake forms (Smartsheet "VRS Unrep Intake Form 2.0")
  // ==========================================================================

  async createIntakeForm(data: InsertIntakeForm): Promise<IntakeForm> {
    const [row] = await db.insert(intakeForms).values(data).returning();
    return row;
  }

  async getIntakeFormBySubmission(
    submissionId: number
  ): Promise<IntakeForm | undefined> {
    const result = await db
      .select()
      .from(intakeForms)
      .where(eq(intakeForms.submissionId, submissionId));
    return result[0];
  }

  // Tyler 2026-04-29 (architect-review fix): atomic create that holds a
  // SELECT ... FOR UPDATE row-lock on submissions across the existing-check
  // + ticket_status check + INSERT. Without a UNIQUE on
  // intake_forms.submission_id (no schema change today), this transaction
  // is the *only* thing keeping two simultaneous /intake-form/confirm
  // requests from inserting two rows for the same submission. The lock is
  // released when the tx commits/rolls back.
  async atomicCreateIntakeForm(data: InsertIntakeForm): Promise<
    | { ok: true; intakeForm: IntakeForm }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "not_approved"; ticketStatus: string }
    | { ok: false; reason: "duplicate"; existing: IntakeForm }
  > {
    return await db.transaction(async (tx) => {
      // 1. Lock the parent submissions row. Any concurrent confirm against
      //    the same submission blocks here until this tx commits.
      // Tyler 2026-04-30 (NLA parity): also pull request_type so the
      // status predicate inside the transaction can branch the same way
      // the route's pre-flight check does (NLA accepts completed |
      // rejected | rejected_closed | invalid; AUTH accepts approved |
      // completed). Without this, NLA reject/invalid confirms would
      // pre-flight-pass at the route then 409 inside the transaction.
      const lockedRows = await tx.execute(
        sql`SELECT id, ticket_status, request_type FROM submissions WHERE id = ${data.submissionId} FOR UPDATE`
      );
      const locked = (lockedRows as any).rows?.[0] ?? (lockedRows as any[])[0];
      if (!locked) {
        return { ok: false as const, reason: "not_found" as const };
      }
      const lockedRow = locked as { ticket_status: string; request_type: string };
      const lockedStatus = lockedRow.ticket_status;
      const lockedIsNla = lockedRow.request_type === "parts_nla";
      const statusOk = lockedIsNla
        ? lockedStatus === "completed" ||
          lockedStatus === "rejected" ||
          lockedStatus === "rejected_closed" ||
          lockedStatus === "invalid"
        : lockedStatus === "approved" || lockedStatus === "completed";
      if (!statusOk) {
        return {
          ok: false as const,
          reason: "not_approved" as const,
          ticketStatus: lockedStatus,
        };
      }
      // 2. Authoritative duplicate-check INSIDE the lock. The pre-flight
      //    check in the route is just for fast 409s; this is the one that
      //    actually closes the race window.
      const existingRows = await tx
        .select()
        .from(intakeForms)
        .where(eq(intakeForms.submissionId, data.submissionId));
      if (existingRows.length > 0) {
        return {
          ok: false as const,
          reason: "duplicate" as const,
          existing: existingRows[0],
        };
      }
      // 3. Insert.
      const [row] = await tx.insert(intakeForms).values(data).returning();
      return { ok: true as const, intakeForm: row };
    });
  }

  // getMissingIntakeForAgent removed 2026-04-26 (Tyler D2). See ADR-013 — the
  // 24h "intake missing" gate has been retired in favor of an auto-opened
  // intake modal post-Authorize. The intake_forms audit row is still written
  // when the agent confirms the modal, so historical audit data is preserved.

  // Atomic claim: relies on the single-statement UPDATE WHERE status='queued'
  // pattern so two concurrent agents racing for the same row will see exactly
  // one winner (Postgres MVCC). Returns undefined when the row was already
  // claimed/processed/deleted.
  async claimSubmission(
    submissionId: number,
    agentId: number
  ): Promise<Submission | undefined> {
    const now = new Date();
    const [updated] = await db
      .update(submissions)
      .set({
        ticketStatus: "pending",
        statusChangedAt: now,
        claimedAt: now,
        assignedTo: agentId,
        updatedAt: now,
      } as any)
      .where(
        and(
          eq(submissions.id, submissionId),
          eq(submissions.ticketStatus, "queued")
        )
      )
      .returning();
    return updated;
  }

  // ==========================================================================
  // Encrypted external credentials (per agent, per third-party service)
  // ==========================================================================

  async getAgentCredential(
    userId: number,
    service: string
  ): Promise<AgentExternalCredential | undefined> {
    const result = await db
      .select()
      .from(agentExternalCredentials)
      .where(
        and(
          eq(agentExternalCredentials.userId, userId),
          eq(agentExternalCredentials.service, service)
        )
      );
    return result[0];
  }

  async upsertAgentCredential(
    data: InsertAgentExternalCredential
  ): Promise<AgentExternalCredential> {
    const [row] = await db
      .insert(agentExternalCredentials)
      .values(data)
      .onConflictDoUpdate({
        target: [agentExternalCredentials.userId, agentExternalCredentials.service],
        set: {
          usernameHint: data.usernameHint,
          usernameCipher: data.usernameCipher,
          passwordCipher: data.passwordCipher,
          iv: data.iv,
          authTag: data.authTag,
          scryptSalt: data.scryptSalt,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async deleteAgentCredential(
    userId: number,
    service: string
  ): Promise<boolean> {
    const result = await db
      .delete(agentExternalCredentials)
      .where(
        and(
          eq(agentExternalCredentials.userId, userId),
          eq(agentExternalCredentials.service, service)
        )
      )
      .returning();
    return result.length > 0;
  }

  // ==========================================================================
  // Communication templates (Tyler 2026-04-29 — admin-editable SMS templates).
  // The schema (communication_templates / _versions / _send_audit) was added
  // in a prior session; this is the storage layer that wires it up.
  // ==========================================================================

  async getCommunicationTemplate(
    channel: "sms" | "email" | "push",
    actionKey: string
  ): Promise<CommunicationTemplate | undefined> {
    const result = await db
      .select()
      .from(communicationTemplates)
      .where(
        and(
          eq(communicationTemplates.channel, channel),
          eq(communicationTemplates.actionKey, actionKey),
          eq(communicationTemplates.isActive, true)
        )
      );
    return result[0];
  }

  async listCommunicationTemplates(
    channel?: "sms" | "email" | "push"
  ): Promise<CommunicationTemplate[]> {
    if (channel) {
      return await db
        .select()
        .from(communicationTemplates)
        .where(eq(communicationTemplates.channel, channel))
        .orderBy(asc(communicationTemplates.actionKey));
    }
    return await db
      .select()
      .from(communicationTemplates)
      .orderBy(asc(communicationTemplates.channel), asc(communicationTemplates.actionKey));
  }

  // Used by `seedDefaultCommunicationTemplates` to populate templates on boot:
  //   - If no row exists for (channel, action_key): insert.
  //   - If a row exists but is still in pristine default state (isDefault=true
  //     AND currentVersion=1, i.e. never edited by an admin): overwrite the
  //     body / variables / title to match the latest seed. This lets us repair
  //     stale rows from earlier prototyping that used a different placeholder
  //     syntax or variable names without breaking the live SMS pipeline.
  //   - Otherwise: leave the row untouched. The moment an admin saves an edit,
  //     `updateCommunicationTemplate` flips isDefault=false and bumps the
  //     version, so subsequent seeds will never overwrite their work.
  async upsertDefaultCommunicationTemplate(
    input: InsertCommunicationTemplate
  ): Promise<CommunicationTemplate> {
    const [existing] = await db
      .select()
      .from(communicationTemplates)
      .where(
        and(
          eq(communicationTemplates.channel, input.channel),
          eq(communicationTemplates.actionKey, input.actionKey)
        )
      );
    if (!existing) {
      const [row] = await db.insert(communicationTemplates).values(input).returning();
      return row;
    }
    if (existing.isDefault && existing.currentVersion === 1) {
      // Stale orphan version rows from prior prototyping can collide with the
      // version snapshot the next admin edit will write. Clear them when we
      // refresh the body so the first real edit produces a clean v1→v2 jump.
      return await db.transaction(async (tx) => {
        await tx.delete(communicationTemplateVersions).where(eq(communicationTemplateVersions.templateId, existing.id));
        const [row] = await tx
          .update(communicationTemplates)
          .set({
            body: input.body,
            variables: input.variables ?? existing.variables,
            title: input.title ?? existing.title,
            subject: input.subject ?? existing.subject,
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(communicationTemplates.id, existing.id))
          .returning();
        return row;
      });
    }
    return existing;
  }

  // Save a new body for a template. Atomically: snapshot the current row to
  // the versions table, bump currentVersion, mark isDefault=false, set
  // updatedBy/updatedAt. The version snapshot lets admins answer "who
  // changed what when, and why?" via the optional editReason field.
  async updateCommunicationTemplate(
    id: number,
    body: string,
    editedBy: number,
    editReason?: string | null
  ): Promise<CommunicationTemplate | undefined> {
    return await db.transaction(async (tx) => {
      // SELECT ... FOR UPDATE: take a row-level lock so two concurrent admin
      // edits serialize on the row instead of racing on the (template_id,
      // version) unique constraint and 500'ing one editor.
      const [current] = await tx
        .select()
        .from(communicationTemplates)
        .where(eq(communicationTemplates.id, id))
        .for("update");
      if (!current) return undefined;

      // Snapshot the OUTGOING row into the versions table at the version it
      // was when saved (so the new version number = current.currentVersion + 1).
      await tx.insert(communicationTemplateVersions).values({
        templateId: id,
        version: current.currentVersion,
        subject: current.subject,
        title: current.title,
        body: current.body,
        variables: current.variables,
        editedBy,
        editReason: editReason ?? null,
      });

      const [updated] = await tx
        .update(communicationTemplates)
        .set({
          body,
          isDefault: false,
          currentVersion: current.currentVersion + 1,
          updatedBy: editedBy,
          updatedAt: new Date(),
        })
        .where(eq(communicationTemplates.id, id))
        .returning();
      return updated;
    });
  }

  async getCommunicationTemplateVersions(
    templateId: number
  ): Promise<CommunicationTemplateVersion[]> {
    return await db
      .select()
      .from(communicationTemplateVersions)
      .where(eq(communicationTemplateVersions.templateId, templateId))
      .orderBy(desc(communicationTemplateVersions.version));
  }
}

export const storage = new DatabaseStorage();
