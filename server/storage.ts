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
  SubmissionListItemWithTech,
  agentExternalCredentials,
  InsertAgentExternalCredential,
  AgentExternalCredential,
  communicationTemplates,
  InsertCommunicationTemplate,
  CommunicationTemplate,
  communicationTemplateVersions,
  CommunicationTemplateVersion,
  systemHealthLog,
  InsertSystemHealthLog,
  SystemHealthLog,
  agentActivityLog,
  InsertAgentActivityLog,
  AgentActivityLog,
} from "@shared/schema";
import { isTerminalTicketStatusForIntake } from "@shared/intake-form-config";
import { normalizeLdapId } from "@shared/ldap";
import { getCachedProfile as getCachedBusinessHoursProfile } from "./business-hours-config";

// External lookup payload row (used by API-key-protected
// GET /api/external/service-order/:so/nla). Kept here so the IStorage
// interface stays the single source of truth for callers.
export type NlaLookupRow = {
  id: number;
  serviceOrder: string;
  applianceType: string;
  requestType: string;
  ticketStatus: string;
  technician: { id: number; name: string; racId: string | null; phone: string | null };
  agent: { id: number; name: string } | null;
  escalatedBy: { id: number; name: string } | null;
  nlaResolution: string | null;
  nlaFoundPartNumber: string | null;
  partNumbers: string | null;
  technicianMessage: string | null;
  agentNotes: string | null;
  createdAt: Date | null;
  claimedAt: Date | null;
  statusChangedAt: Date | null;
};

// Initialize database connection.
// IMPORTANT: pg's default pool max is 10. Under production daytime load (~40
// concurrent agents polling /api/submissions, /api/agent/stats, /api/admin/users
// every few seconds), 10 connections saturate and — with no acquisition timeout —
// requests queue indefinitely, the event loop backs up, latency climbs to 5-18s,
// queries fail, and the process HANGS. On a Reserved VM a hung (not exited)
// process is never auto-restarted, so it serves 502 until a manual redeploy.
// The timeouts below convert saturation into fast per-request failures (graceful
// degradation) instead of a whole-process hang; statement_timeout releases any
// connection stuck on a runaway query.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
});

// Prevent unhandled 'error' events on idle clients from crashing the process.
// Postgres can terminate idle connections (maintenance, admin command, autosuspend);
// pg emits an 'error' event on the affected idle client, and without a listener
// Node treats it as an unhandled error and exits. The pool removes the broken
// client automatically and creates a fresh one on the next query.
pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle PostgreSQL client:", err.message);
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
    reviewedBy?: number;
    requestType?: string;
    excludeRequestType?: string;
    divisionFilter?: string[];
  }, completedToday?: boolean): Promise<(Submission & { technicianName: string; technicianPhone: string | null; assignedAgentName: string | null; intakeFormCompletedAt: Date | null })[]>;
  // Tyler 2026-05-06 (perf — Task #4 dashboard payload slim-down):
  // Slim sibling of getSubmissionsWithTechnician. Selects only the columns
  // the dashboard list table actually renders (see SubmissionListItem in
  // shared/schema.ts for the explicit kept-column list). Heavy text/JSON
  // columns (photos, agentNotes, partNumbers, technicianMessage,
  // issueDescription, originalDescription, rejectionReasons, rejectedMedia,
  // reassignmentNotes, appealNotes, invalidInstructions,
  // declineInstructions, stage1RejectionReason, nlaResolution,
  // nlaFoundPartNumber, videoUrl, voiceNoteUrl) are deliberately omitted
  // because the list never reads them — the detail panel drills via
  // GET /api/submissions/:id for a full row.
  //
  // Honors the same filter shape as getSubmissionsWithTechnician PLUS:
  //  - completedSince: when set, applies (reviewedAt >= since AND
  //    ticketStatus IN ('completed','approved','rejected','invalid')).
  //    Used by the agent Completed tab's last-30-days default + selector.
  //  - createdAfter: when set, applies (createdAt >= createdAfter).
  //    Used by the admin Ticket Overview last-30-days default + selector.
  // The legacy completedToday flag remains supported and is internally
  // equivalent to completedSince=todayMidnight.
  getSubmissionsListView(filters?: {
    technicianId?: number;
    ticketStatus?: string;
    stage1Status?: string;
    stage2Status?: string;
    applianceType?: string;
    assignedTo?: number;
    reviewedBy?: number;
    requestType?: string;
    excludeRequestType?: string;
    divisionFilter?: string[];
    completedSince?: Date;
    createdAfter?: Date;
  }, completedToday?: boolean): Promise<SubmissionListItemWithTech[]>;
  updateSubmission(
    id: number,
    data: Partial<InsertSubmission>
  ): Promise<Submission | undefined>;
  // Tyler 2026-05-01: optimistic-lock variant for the agent process routes.
  // Updates the row only when its current ticketStatus matches one of the
  // expected values. Returns undefined when no row was updated (i.e. the
  // ticket was already moved by another agent or process). Callers MUST
  // treat undefined as a 409 Conflict, not a 404.
  // Tyler 2026-05-11: optional `expectedAssignedTo` parameter closes a
  // TOCTOU window where an admin reassigns a still-pending ticket from
  // agent A to agent B between A's getSubmission read and A's UPDATE.
  // The status-only guard let A win the write. Passing the read-time
  // assignee lifts the assignment check INTO the UPDATE predicate so
  // a stale assignee gets undefined and the route returns 409.
  // `null` is allowed and means "must still be unassigned" (resubmits).
  updateSubmissionIfStatus(
    id: number,
    expectedStatuses: string[],
    data: Partial<InsertSubmission>,
    expectedAssignedTo?: number | null
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
  getReplacementReviewAnalytics(): Promise<{ today: number; week: number; month: number; allTime: number }>;
  getB2bReplacementAnalytics(): Promise<{ today: number; week: number; month: number; allTime: number }>;

  getStage2QueueCount(agentId?: number): Promise<number>;
  getWarrantyProviderCounts(assignedTo?: number): Promise<{ warrantyProvider: string; count: number }[]>;

  getResubmissionChain(rootId: number): Promise<Submission[]>;
  getSubmissionHistory(serviceOrder: string): Promise<Submission[]>;
  hasRejectedClosedForServiceOrder(serviceOrder: string): Promise<boolean>;
  hasActiveSubmissionForServiceOrder(serviceOrder: string, callerTechnicianId?: number, statuses?: string[]): Promise<{ exists: boolean; status?: string; technicianId?: number; sameTech?: boolean }>;
  getNlaSubmissionsByServiceOrder(serviceOrder: string): Promise<NlaLookupRow[]>;
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
  createSubmissionWithIdempotency(submission: InsertSubmission, withinSeconds: number, options?: { additionalRequest?: boolean }): Promise<{ submission?: Submission; wasDuplicate: boolean; blockedByOther?: boolean; blockingTechnicianId?: number; blockingStatus?: string }>;

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
    otherStatusCounts: Record<string, number>;
    avgTimeToStage1Ms: number | null;
    avgTimeToAuthCodeMs: number | null;
  }>;

  getResubmissionStats(): Promise<{
    totalResubmissions: number;
    resubmissionRate: number;
    topTechnicians: { technicianId: number; techName: string; techLdap: string; totalTickets: number; resubmissions: number; rate: number }[];
  }>;

  getCoachingDuplicateSubmissions(days: number): Promise<{
    technicianId: number;
    techName: string;
    techLdap: string;
    serviceOrder: string;
    previousId: number;
    previousStatus: string;
    previousAt: string;
    newTickets: { id: number; status: string; at: string; minutesAfter: number }[];
    newCount: number;
    minutesBetween: number;
    latestNewAt: string;
  }[]>;

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

  // System health regression watch (2026-05-11)
  findOpenHealthIncident(
    checkName: string,
    entityType: string,
    entityId: number
  ): Promise<SystemHealthLog | undefined>;
  openHealthIncident(data: InsertSystemHealthLog): Promise<SystemHealthLog>;
  touchHealthIncident(id: number): Promise<void>;
  clearHealthIncident(id: number, clearedBy?: number, clearReason?: string): Promise<void>;
  listHealthIncidents(opts: {
    openOnly?: boolean;
    checkName?: string;
    limit?: number;
  }): Promise<SystemHealthLog[]>;
  listOpenHealthIncidentsByCheck(checkName: string): Promise<SystemHealthLog[]>;

  // Agent activity log (2026-05-20)
  logAgentActivity(data: InsertAgentActivityLog): Promise<AgentActivityLog>;
  getRecentAgentActivity(opts: {
    userId?: number;
    eventType?: string;
    since?: Date;
    limit?: number;
  }): Promise<(AgentActivityLog & { userName?: string })[]>;
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
    withinSeconds: number,
    options?: { additionalRequest?: boolean }
  ): Promise<{ submission?: Submission; wasDuplicate: boolean; blockedByOther?: boolean; blockingTechnicianId?: number; blockingStatus?: string }> {
    return await db.transaction(async (tx) => {
      // Tyler 2026-05-27 — SO-scoped advisory lock (previously was
      // (technicianId, soHash), which let two DIFFERENT techs race past
      // each other's pre-checks and both insert pending rows for the
      // same SO# on the same day — VRS report on Eric Green
      // 7435-13748939 and Veaceslav Versigora 8206-13757917). Now we
      // lock on (NAMESPACE, soHash) so EVERY concurrent submitter of
      // the same SO# serializes through this transaction.
      const SO_LOCK_NAMESPACE = 0x53484F4D | 0; // 'SHOM' truncated to int4
      let soHash = 0;
      const so = submission.serviceOrder;
      for (let i = 0; i < so.length; i++) {
        soHash = ((soHash << 5) - soHash + so.charCodeAt(i)) | 0;
      }
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SO_LOCK_NAMESPACE}, ${soHash})`);

      // 1) Same-day parallel-ticket conflict. The status set that counts as
      // a conflict depends on the kind of submission:
      //   - normal new submission → queued/pending/completed (one ticket per
      //     SO per calendar day; the long-standing rule).
      //   - resubmission OR explicit Additional Request → ACTIVE only
      //     (queued/pending). Resubmissions used to be SKIPPED entirely here,
      //     which let a resubmission be created while a fresh ticket for the
      //     same SO was already queued/being-worked — the same-day duplicate
      //     (prod case SO 7088-13792068: rejected → fresh ticket active →
      //     resubmission, both worked & approved). Additional Requests are the
      //     deliberate same-day second ticket and must still serialize against
      //     any still-active ticket here too. Completed/rejected prior tickets
      //     are "resolved" and intentionally do NOT block these two paths.
      // Mirrors the route-level rules in hasActiveSubmissionForServiceOrder.
      // Same-tech hit here means the route-level pre-check lost a race against
      // a sibling request from the SAME tech — treat that as idempotent replay
      // and return the existing row. Different-tech hit means another tech beat
      // us to this SO# today — return blockedByOther so the route can convert
      // to a 409 (we deliberately don't surface another tech's row to this tech).
      const isResubOrAdditional = !!submission.resubmissionOf || !!options?.additionalRequest;
      {
        // Tyler 2026-05-27 (premortem) — must compare "same calendar day"
        // in America/New_York, not the server's UTC. VRS techs operate on
        // Eastern Time, 8am-8pm ET. See matching comment in
        // hasActiveSubmissionForServiceOrder below. Pre-filter widely
        // (last 36h covers any ET day across DST gaps) then do the exact
        // Eastern-day comparison in SQL.
        const activeStatuses = isResubOrAdditional
          ? ["queued", "pending"]
          : ["queued", "pending", "completed"];
        const wideCutoff = new Date(Date.now() - 36 * 60 * 60 * 1000);
        const conflict = await tx
          .select()
          .from(submissions)
          .where(
            and(
              eq(submissions.serviceOrder, so),
              inArray(submissions.ticketStatus, activeStatuses),
              gte(submissions.createdAt, wideCutoff),
              // Tyler 2026-05-27 (architect catch) — `submissions.created_at`
              // is `timestamp WITHOUT time zone`. Postgres semantics:
              // `(ts_no_tz AT TIME ZONE 'America/New_York')` interprets the
              // value as Eastern-local and returns timestamptz — WRONG
              // direction (we store UTC-naive). Must first attach UTC, then
              // convert to Eastern. Verified: '2026-05-27 03:00' raw →
              // naive form = '2026-05-27' (wrong), correct form = '2026-05-26'.
              sql`((${submissions.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York')::date = (NOW() AT TIME ZONE 'America/New_York')::date`,
            )
          )
          .orderBy(desc(submissions.createdAt))
          .limit(1);
        if (conflict[0]) {
          const c = conflict[0];
          if (c.technicianId === submission.technicianId) {
            return { submission: c, wasDuplicate: true };
          }
          return {
            wasDuplicate: true,
            blockedByOther: true,
            blockingTechnicianId: c.technicianId ?? undefined,
            blockingStatus: c.ticketStatus,
          };
        }
      }

      // 2) Per-tech short-window replay window. Catches the
      // network-drop-then-client-retry case for any submission
      // (including resubmissions) within `withinSeconds`.
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

  // Tyler 2026-05-01: optimistic-lock variant. The /process and
  // /process-nla routes previously read the row, validated its status,
  // then issued an unconditional UPDATE BY ID — leaving a window where
  // two near-simultaneous actions could both pass validation and
  // overwrite each other (duplicate SMS, last-writer-wins state). This
  // variant pushes the status check INTO the UPDATE predicate so a
  // losing concurrent writer gets back undefined and the route can
  // return 409 Conflict cleanly.
  async updateSubmissionIfStatus(
    id: number,
    expectedStatuses: string[],
    data: Partial<InsertSubmission>,
    expectedAssignedTo?: number | null
  ): Promise<Submission | undefined> {
    if (!expectedStatuses || expectedStatuses.length === 0) {
      // Defensive: caller must supply at least one expected status. We
      // refuse to silently degrade to an unconditional update.
      throw new Error("updateSubmissionIfStatus requires at least one expectedStatus");
    }
    const predicates = [
      eq(submissions.id, id),
      inArray(submissions.ticketStatus, expectedStatuses),
    ];
    // Tyler 2026-05-11: optional assignee guard. `undefined` means "do
    // not check"; `null` means "must still be unassigned"; a number
    // means "must still be assigned to this user". This is the second
    // half of the two-agents-on-one-ticket fix — without it an admin
    // reassign mid-process let the original assignee still win the
    // UPDATE because the status alone hadn't moved.
    if (expectedAssignedTo !== undefined) {
      if (expectedAssignedTo === null) {
        predicates.push(sql`${submissions.assignedTo} IS NULL`);
      } else {
        predicates.push(eq(submissions.assignedTo, expectedAssignedTo));
      }
    }
    const result = await db
      .update(submissions)
      .set(data)
      .where(and(...predicates))
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
    // Tyler 2026-05-02: agent's "Completed today" tab needs to see tickets
    // they REJECTED — but reject paths null `assignedTo` (routes.ts:1547,
    // :1585, :1971), so filtering by assignedTo dropped every rejection.
    // `reviewedBy` is set on every /process and /process-nla action and
    // is the auditable "who actioned this" column. Caller picks one.
    reviewedBy?: number;
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
    if (filters?.reviewedBy !== undefined) {
      conditions.push(eq(submissions.reviewedBy, filters.reviewedBy));
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

  // Tyler 2026-05-06 (perf — Task #4 dashboard payload slim-down):
  // See the IStorage interface comment above the matching signature for
  // the design rationale and the explicit kept-vs-dropped column list.
  // This method mirrors getSubmissionsWithTechnician's filter handling
  // exactly except that it (a) explicit-selects only slim columns from
  // the submissions table, and (b) supports two new date params:
  // completedSince (reviewedAt window for the agent Completed tab) and
  // createdAfter (createdAt window for the admin Ticket Overview).
  async getSubmissionsListView(filters?: {
    technicianId?: number;
    ticketStatus?: string;
    stage1Status?: string;
    stage2Status?: string;
    applianceType?: string;
    assignedTo?: number;
    reviewedBy?: number;
    requestType?: string;
    excludeRequestType?: string;
    divisionFilter?: string[];
    completedSince?: Date;
    createdAfter?: Date;
  }, completedToday?: boolean): Promise<SubmissionListItemWithTech[]> {
    const conditions: any[] = [];

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
    if (filters?.reviewedBy !== undefined) {
      conditions.push(eq(submissions.reviewedBy, filters.reviewedBy));
    }
    if (filters?.requestType !== undefined) {
      conditions.push(eq(submissions.requestType, filters.requestType));
    }
    if (filters?.excludeRequestType !== undefined) {
      conditions.push(sql`${submissions.requestType} != ${filters.excludeRequestType}`);
    }
    if (filters?.divisionFilter !== undefined && filters.divisionFilter.length > 0) {
      const hasNla = filters.divisionFilter.includes("nla");
      const applianceDivisions = filters.divisionFilter.filter(d => d !== "nla" && d !== "generalist");
      const isNlaSpecificQuery = filters.requestType === "parts_nla";
      if (isNlaSpecificQuery && applianceDivisions.length > 0) {
        conditions.push(inArray(submissions.applianceType, applianceDivisions));
      } else if (hasNla && applianceDivisions.length > 0 && !isNlaSpecificQuery) {
        conditions.push(or(
          inArray(submissions.applianceType, applianceDivisions),
          eq(submissions.requestType, "parts_nla")
        ));
      } else if (hasNla) {
        // generalist over all divisions including NLA — no extra filter
      } else if (applianceDivisions.length > 0) {
        conditions.push(inArray(submissions.applianceType, applianceDivisions));
      }
    }

    // Completed-window filtering: legacy completedToday flag is internally
    // equivalent to completedSince=todayMidnight. completedSince takes
    // precedence if both are passed (route layer never sets both).
    if (completedToday) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      conditions.push(sql`${submissions.reviewedAt} >= ${today}`);
      conditions.push(sql`${submissions.ticketStatus} IN ('completed', 'approved', 'rejected', 'invalid')`);
    } else if (filters?.completedSince) {
      conditions.push(sql`${submissions.reviewedAt} >= ${filters.completedSince}`);
      conditions.push(sql`${submissions.ticketStatus} IN ('completed', 'approved', 'rejected', 'invalid')`);
    }

    if (filters?.createdAfter) {
      conditions.push(gte(submissions.createdAt, filters.createdAfter));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const assignedAgent = alias(users, "assignedAgent");

    const result = await db
      .select({
        // Slim submissions columns — explicit, no spread of submissions.*.
        // See the IStorage interface comment above for the complete dropped-
        // column list and rationale.
        s: {
          id: submissions.id,
          technicianId: submissions.technicianId,
          racId: submissions.racId,
          serviceOrder: submissions.serviceOrder,
          districtCode: submissions.districtCode,
          phone: submissions.phone,
          applianceType: submissions.applianceType,
          requestType: submissions.requestType,
          warrantyType: submissions.warrantyType,
          warrantyProvider: submissions.warrantyProvider,
          aiEnhanced: submissions.aiEnhanced,
          estimateAmount: submissions.estimateAmount,
          ticketStatus: submissions.ticketStatus,
          stage1Status: submissions.stage1Status,
          stage1ReviewedBy: submissions.stage1ReviewedBy,
          stage1ReviewedAt: submissions.stage1ReviewedAt,
          stage2Status: submissions.stage2Status,
          stage2ReviewedBy: submissions.stage2ReviewedBy,
          stage2ReviewedAt: submissions.stage2ReviewedAt,
          stage2Outcome: submissions.stage2Outcome,
          submissionApproved: submissions.submissionApproved,
          submissionApprovedAt: submissions.submissionApprovedAt,
          assignedTo: submissions.assignedTo,
          claimedAt: submissions.claimedAt,
          reviewedBy: submissions.reviewedBy,
          reviewedAt: submissions.reviewedAt,
          statusChangedAt: submissions.statusChangedAt,
          createdAt: submissions.createdAt,
          updatedAt: submissions.updatedAt,
          authCode: submissions.authCode,
          rgcCode: submissions.rgcCode,
          phoneOverride: submissions.phoneOverride,
          technicianLdapId: submissions.technicianLdapId,
          resubmissionOf: submissions.resubmissionOf,
          nlaEscalatedBy: submissions.nlaEscalatedBy,
          procId: submissions.procId,
          clientNm: submissions.clientNm,
          invalidReason: submissions.invalidReason,
          declineReason: submissions.declineReason,
          replacementReviewRecommended: submissions.replacementReviewRecommended,
          b2bApprovedReplacement: submissions.b2bApprovedReplacement,
          // Tyler 2026-05-07 (prod fire — VRS rejecting tickets as "no
          // photos"): URL-only media metadata. See SubmissionListItem
          // comment in shared/schema.ts for the full rationale. These are
          // small string columns and don't reintroduce the Task #4 payload
          // bloat from agentNotes/auditTrail/rejectedMedia.
          photos: submissions.photos,
          videoUrl: submissions.videoUrl,
          voiceNoteUrl: submissions.voiceNoteUrl,
        },
        technicianName: users.name,
        technicianPhone: users.phone,
        ldapTechName: technicians.name,
        ldapTechPhone: technicians.phone,
        assignedAgentName: assignedAgent.name,
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
      ...r.s,
      technicianName: r.ldapTechName || r.technicianName,
      technicianPhone: r.s.phoneOverride || r.ldapTechPhone || r.technicianPhone,
      assignedAgentName: r.assignedAgentName,
      racId: r.s.technicianLdapId || "",
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
      // Tyler 2026-05-02: was `assignedTo`, which is cleared on every reject
      // (see /process reject + reject_and_close paths). The tile silently
      // under-reported by exactly the number of rejections each agent did.
      // `reviewedBy` is the auditable column and is set on every action, so
      // the tile now matches the Completed-today list (which also filters
      // by reviewedBy after this same change).
      conditions.push(eq(submissions.reviewedBy, agentId));
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
    return Number(result[0]?.count) || 0;
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

  async hasActiveSubmissionForServiceOrder(serviceOrder: string, callerTechnicianId?: number, statuses?: string[]): Promise<{ exists: boolean; status?: string; technicianId?: number; sameTech?: boolean }> {
    // Tyler 2026-05-06 (regression report): `"completed"` was previously in
    // this list, which blocked a tech from submitting a fresh ticket on the
    // same SO# any time after the prior one was approved — even days later.
    // Real-world failure mode: tech finishes a job Monday (completed), needs
    // a follow-up auth on Friday for the same SO# (parts came in, second
    // visit, related issue), gets a 409 "already approved." Approved tickets
    // are closed business — they should not gate future submissions on the
    // same SO#. Only truly in-flight work (queued waiting for an agent, or
    // pending under active review) needs to block to prevent dupe-text.
    //
    // Tyler 2026-05-09 (VRS report — techs blocked on day-2 visits): even
    // the `queued`/`pending` block was over-broad. Real-world failure mode:
    // tech submits SO# X late on day 1, the agent doesn't get to it before
    // shift-end and the ticket sits in the queue overnight. Day 2, tech
    // returns to the same job needing a fresh authorization (e.g. customer
    // approved a different repair path, parts arrived, separate issue) and
    // gets a 409 "you already have a submission in the queue." Per VRS:
    // if the prior submission is from a DIFFERENT calendar day, allow the
    // new one — the tech is on a separate visit. We still block same-day
    // duplicates because that's what the gate is actually for (preventing
    // double-tap and dupe SMS on the same visit). Combined with the 60s
    // `findRecentDuplicateSubmission` idempotency window above, this gives
    // us: < 60s = silent idempotent return; same calendar day = explicit
    // 409; different calendar day = pass through.
    //
    // Tyler 2026-05-27 (VRS report — two techs working same SO): the
    // technicianId filter let two different techs (or the same tech under
    // two LDAP-resolved user rows) both submit the same SO# within the
    // same day and both end up pending against different agents at the
    // same time (Eric Green SO# 7435-13748939 claimed by Zorn Jones AND
    // Tony Higginbotham; Veaceslav Versigora SO# 8206-13757917 claimed by
    // Jeff Van Ness AND John Santana). Per VRS: one ticket per service
    // order per calendar day, period — regardless of which tech submits.
    // The only way to get a second same-day ticket for the same SO# is the
    // resubmission path (originalSub.ticketStatus === "rejected"), which is
    // handled in the `resubmissionOf` branch and bypasses this check.
    // `completed` is included so a same-day approved ticket also blocks
    // (otherwise a tech could submit, get approved, then submit again and
    // burn a second auth slot the same day). Rejected / invalid / and the
    // dedicated `rejected_closed` path are intentionally NOT blockers —
    // rejected requires the resubmit flow, invalid means the prior never
    // counted, and rejected_closed is handled by hasRejectedClosedForServiceOrder.
    //
    // The `statuses` param lets callers narrow what counts as "active". The
    // resubmission and Additional Request paths pass ["queued","pending"]
    // (ACTIVE only) so a same-day completed/rejected ticket does NOT block
    // them — only a still-in-flight ticket does. New submissions use the
    // default queued/pending/completed set.
    const activeStatuses = statuses ?? ["queued", "pending", "completed"];
    const results = await db
      .select({ id: submissions.id, ticketStatus: submissions.ticketStatus, createdAt: submissions.createdAt, technicianId: submissions.technicianId })
      .from(submissions)
      .where(
        and(
          eq(submissions.serviceOrder, serviceOrder),
          inArray(submissions.ticketStatus, activeStatuses)
        )
      )
      .orderBy(desc(submissions.createdAt))
      .limit(1);
    if (results.length === 0) {
      return { exists: false };
    }
    const prior = results[0];
    if (!prior.createdAt) {
      // Defensive: if we somehow have an active row with no createdAt,
      // fall back to blocking. Better a false positive than another
      // double-pending incident.
      return { exists: true, status: prior.ticketStatus, technicianId: prior.technicianId, sameTech: callerTechnicianId !== undefined && prior.technicianId === callerTechnicianId };
    }
    // Tyler 2026-05-27 (premortem) — server runs UTC but VRS techs run
    // 8am–8pm Eastern Time. JS `getFullYear/getMonth/getDate` reads the
    // host TZ (UTC here), so e.g. a tech submitting at 7pm ET (11pm UTC)
    // and another at 8pm ET same day (12am UTC next day) would appear on
    // different "days" and the second would slip past — re-opening the
    // exact Eric Green / Veaceslav Versigora bug class for the ~4h after
    // midnight UTC (8pm ET shift overlap). Compare in America/New_York.
    const now = new Date();
    const priorCreated = new Date(prior.createdAt);
    const tzDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const sameCalendarDay = tzDay(priorCreated) === tzDay(now);
    if (sameCalendarDay) {
      return { exists: true, status: prior.ticketStatus, technicianId: prior.technicianId, sameTech: callerTechnicianId !== undefined && prior.technicianId === callerTechnicianId };
    }
    return { exists: false };
  }

  async getNlaSubmissionsByServiceOrder(serviceOrder: string): Promise<NlaLookupRow[]> {
    // External NLA-lookup endpoint backing query. Returns every NLA submission
    // (`request_type = 'parts_nla'`) for the SO, newest first, with joined
    // technician + assigned-agent + escalated-by user names. Includes all
    // statuses (queued, pending, completed, rejected, invalid) — the consumer
    // wants to know whether a tech ever went through the VRS NLA flow, not
    // just live tickets. Caller is authenticated by API key, not by user JWT.
    const tech = alias(users, "tech");
    const agent = alias(users, "agent");
    const escalator = alias(users, "escalator");
    const rows = await db
      .select({
        id: submissions.id,
        serviceOrder: submissions.serviceOrder,
        applianceType: submissions.applianceType,
        requestType: submissions.requestType,
        ticketStatus: submissions.ticketStatus,
        techId: tech.id,
        techName: tech.name,
        techRacId: tech.racId,
        techPhone: tech.phone,
        agentId: agent.id,
        agentName: agent.name,
        escalatorId: escalator.id,
        escalatorName: escalator.name,
        nlaResolution: submissions.nlaResolution,
        nlaFoundPartNumber: submissions.nlaFoundPartNumber,
        partNumbers: submissions.partNumbers,
        technicianMessage: submissions.technicianMessage,
        agentNotes: submissions.agentNotes,
        createdAt: submissions.createdAt,
        claimedAt: submissions.claimedAt,
        statusChangedAt: submissions.statusChangedAt,
      })
      .from(submissions)
      .leftJoin(tech, eq(tech.id, submissions.technicianId))
      .leftJoin(agent, eq(agent.id, submissions.assignedTo))
      .leftJoin(escalator, eq(escalator.id, submissions.nlaEscalatedBy))
      .where(
        and(
          eq(submissions.serviceOrder, serviceOrder),
          eq(submissions.requestType, "parts_nla"),
        ),
      )
      .orderBy(desc(submissions.createdAt));
    return rows.map((r) => ({
      id: r.id,
      serviceOrder: r.serviceOrder,
      applianceType: r.applianceType,
      requestType: r.requestType,
      ticketStatus: r.ticketStatus,
      technician: {
        id: r.techId ?? 0,
        name: r.techName ?? "unknown",
        racId: r.techRacId ?? null,
        phone: r.techPhone ?? null,
      },
      agent: r.agentId ? { id: r.agentId, name: r.agentName ?? "unknown" } : null,
      escalatedBy: r.escalatorId ? { id: r.escalatorId, name: r.escalatorName ?? "unknown" } : null,
      nlaResolution: r.nlaResolution,
      nlaFoundPartNumber: r.nlaFoundPartNumber,
      partNumbers: r.partNumbers,
      technicianMessage: r.technicianMessage,
      agentNotes: r.agentNotes,
      createdAt: r.createdAt,
      claimedAt: r.claimedAt,
      statusChangedAt: r.statusChangedAt,
    }));
  }

  // 2026-04-30 — Tyler request: server-side idempotency for double-submit /
  // retry-after-flaky-cell scenarios. The submit button disables while in
  // flight, and `hasActiveSubmissionForServiceOrder` blocks duplicates against
  // queued/pending rows for non-resubmissions (completed status was removed
  // 2026-05-06 — see that method for the regression context). Neither protects
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
    const normalized = normalizeLdapId(ldapId);
    const result = await db
      .select()
      .from(technicians)
      .where(sql`lower(${technicians.ldapId}) = ${normalized}`);
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

  // Tyler 2026-06-17 (perf — Task #26): translate the admin-configured business-
  // hours profile into SQL literals so the per-row business-elapsed math can run
  // in Postgres instead of fetching every reviewed row into Node. DayKey →
  // ISODOW (Mon=1..Sun=7) mirrors getBusinessElapsedMs's getDay()-based weekday
  // matching. The dows array is built from validated integers only, so it is
  // safe to inline via sql.raw.
  private businessHoursSqlParams(profile: { open: string; close: string; openDays: string[] }): { open: string; close: string; dowsLiteral: string } {
    const dowMap: Record<string, number> = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dows = Array.from(
      new Set(profile.openDays.map(d => dowMap[d]).filter((n): n is number => typeof n === "number")),
    ).sort((a, b) => a - b);
    return { open: profile.open, close: profile.close, dowsLiteral: `ARRAY[${dows.join(",")}]::int[]` };
  }

  async getAgentsWithStatus(): Promise<{ id: number; name: string; racId: string | null; agentStatus: string; divisions: string[]; updatedAt: Date | null }[]> {
    // Tyler 2026-06-17 (perf — Task #26): single joined+aggregated query
    // replaces the prior N+1 (one specializations SELECT per agent). divisions
    // are aggregated ORDER BY id to preserve the prior PK-order array shape.
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        racId: users.racId,
        agentStatus: users.agentStatus,
        updatedAt: users.updatedAt,
        divisions: sql<string[]>`coalesce(array_agg(${vrsAgentSpecializations.division} order by ${vrsAgentSpecializations.id}) filter (where ${vrsAgentSpecializations.division} is not null), '{}')`,
      })
      .from(users)
      .leftJoin(vrsAgentSpecializations, eq(vrsAgentSpecializations.userId, users.id))
      .where(and(eq(users.role, "vrs_agent"), eq(users.isActive, true)))
      .groupBy(users.id, users.name, users.racId, users.agentStatus, users.updatedAt)
      .orderBy(users.name);

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      racId: r.racId,
      agentStatus: r.agentStatus,
      divisions: (r.divisions as string[]) ?? [],
      updatedAt: r.updatedAt,
    }));
  }

  async getAnalytics(): Promise<{
    submissionsToday: number;
    submissionsThisWeek: number;
    submissionsThisMonth: number;
    totalSubmissions: number;
    approvedCount: number;
    rejectedCount: number;
    pendingCount: number;
    otherStatusCounts: Record<string, number>;
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
    // Tyler perf: counts, other-status breakdown, and the business-hours
    // averages are three independent read-only queries. Run them concurrently
    // (Promise.all) instead of as three sequential round-trips — output is
    // identical, only the wall-clock latency drops.
    const defaultProfile = getCachedBusinessHoursProfile("default");
    const bh = this.businessHoursSqlParams(defaultProfile);
    const countsPromise = db
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

    // Tyler 2026-05-15 — surface every stage1Status that isn't approved/
    // rejected/pending so the Approval Rate card can render a row per
    // remaining bucket (Invalid, Not Reviewed/null, etc.) and the displayed
    // %s actually add up. Keeps the canonical 3 numerators unchanged.
    const otherStatusPromise = db
      .select({
        status: sql<string | null>`${submissions.stage1Status}`,
        count: sql<number>`count(*)`,
      })
      .from(submissions)
      .where(sql`${submissions.stage1Status} is null or ${submissions.stage1Status} not in ('approved', 'rejected', 'pending')`)
      .groupBy(submissions.stage1Status);

    // Tyler 2026-04-30: averages are business-hours aware so overnight time
    // doesn't skew the headline numbers. Mirrors the row-timer logic in
    // admin-dashboard.tsx via the shared `getBusinessElapsedMs` helper, using
    // the admin-configured default profile (system_settings.vrs_business_hours).
    // Tyler 2026-06-17 (perf — Task #26): the per-row business-elapsed math now
    // runs in SQL (date_trunc + generate_series over ET days, DST-correct via
    // AT TIME ZONE) instead of streaming every reviewed row into Node. Verified
    // bit-equivalent to the JS loop (ms-truncated to match Date parsing, then
    // floored to seconds by formatDuration on display). HVAC tickets remain
    // aggregated under the default profile, matching the prior behavior.
    const avgPromise = db.execute(sql`
      WITH params AS (
        SELECT ${bh.open}::time AS open_t, ${bh.close}::time AS close_t, ${sql.raw(bh.dowsLiteral)} AS open_dows
      ),
      s1_base AS (
        SELECT id,
          date_trunc('milliseconds', created_at AT TIME ZONE 'UTC') AS s,
          date_trunc('milliseconds', stage1_reviewed_at AT TIME ZONE 'UTC') AS e
        FROM submissions
        WHERE stage1_reviewed_at IS NOT NULL AND created_at IS NOT NULL
      ),
      s1_pr AS (
        SELECT b.id, COALESCE(ROUND(SUM(
          CASE WHEN g.d IS NULL THEN 0
               WHEN EXTRACT(ISODOW FROM g.d)::int = ANY(p.open_dows)
               THEN GREATEST(0, EXTRACT(EPOCH FROM (
                 LEAST(b.e, ((g.d::date + p.close_t) AT TIME ZONE 'America/New_York'))
                 - GREATEST(b.s, ((g.d::date + p.open_t) AT TIME ZONE 'America/New_York'))
               )))
               ELSE 0 END
        ) * 1000), 0)::bigint AS ms
        FROM s1_base b
        CROSS JOIN params p
        LEFT JOIN LATERAL generate_series(
          date_trunc('day', b.s AT TIME ZONE 'America/New_York'),
          date_trunc('day', b.e AT TIME ZONE 'America/New_York'),
          interval '1 day'
        ) AS g(d) ON true
        GROUP BY b.id
      ),
      s2_base AS (
        SELECT id,
          date_trunc('milliseconds', stage1_reviewed_at AT TIME ZONE 'UTC') AS s,
          date_trunc('milliseconds', stage2_reviewed_at AT TIME ZONE 'UTC') AS e
        FROM submissions
        WHERE stage2_reviewed_at IS NOT NULL AND stage1_reviewed_at IS NOT NULL AND created_at IS NOT NULL
      ),
      s2_pr AS (
        SELECT b.id, COALESCE(ROUND(SUM(
          CASE WHEN g.d IS NULL THEN 0
               WHEN EXTRACT(ISODOW FROM g.d)::int = ANY(p.open_dows)
               THEN GREATEST(0, EXTRACT(EPOCH FROM (
                 LEAST(b.e, ((g.d::date + p.close_t) AT TIME ZONE 'America/New_York'))
                 - GREATEST(b.s, ((g.d::date + p.open_t) AT TIME ZONE 'America/New_York'))
               )))
               ELSE 0 END
        ) * 1000), 0)::bigint AS ms
        FROM s2_base b
        CROSS JOIN params p
        LEFT JOIN LATERAL generate_series(
          date_trunc('day', b.s AT TIME ZONE 'America/New_York'),
          date_trunc('day', b.e AT TIME ZONE 'America/New_York'),
          interval '1 day'
        ) AS g(d) ON true
        GROUP BY b.id
      )
      SELECT (SELECT AVG(ms) FROM s1_pr) AS avg_stage1_ms,
             (SELECT AVG(ms) FROM s2_pr) AS avg_authcode_ms
    `);

    const [countsResult, otherStatusRows, avgResult] = await Promise.all([
      countsPromise,
      otherStatusPromise,
      avgPromise,
    ]);

    const otherStatusCounts: Record<string, number> = {};
    for (const r of otherStatusRows) {
      const key = r.status === null || r.status === "" ? "not_reviewed" : r.status;
      otherStatusCounts[key] = Number(r.count) || 0;
    }

    const avgRow = (avgResult.rows[0] ?? {}) as { avg_stage1_ms: string | null; avg_authcode_ms: string | null };
    const avgTimeToStage1Ms = avgRow.avg_stage1_ms != null ? Number(avgRow.avg_stage1_ms) : null;
    const avgTimeToAuthCodeMs = avgRow.avg_authcode_ms != null ? Number(avgRow.avg_authcode_ms) : null;

    const row = countsResult[0];
    return {
      submissionsToday: Number(row.submissionsToday) || 0,
      submissionsThisWeek: Number(row.submissionsThisWeek) || 0,
      submissionsThisMonth: Number(row.submissionsThisMonth) || 0,
      totalSubmissions: Number(row.totalSubmissions) || 0,
      approvedCount: Number(row.approvedCount) || 0,
      rejectedCount: Number(row.rejectedCount) || 0,
      pendingCount: Number(row.pendingCount) || 0,
      otherStatusCounts,
      avgTimeToStage1Ms,
      avgTimeToAuthCodeMs,
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

  async getCoachingDuplicateSubmissions(days: number): Promise<{
    technicianId: number;
    techName: string;
    techLdap: string;
    serviceOrder: string;
    previousId: number;
    previousStatus: string;
    previousAt: string;
    newTickets: { id: number; status: string; at: string; minutesAfter: number }[];
    newCount: number;
    minutesBetween: number;
    latestNewAt: string;
  }[]> {
    // Coaching opportunity = tech submitted a brand-new ticket
    // (resubmission_of IS NULL) for a (tech, SO) pair AFTER a prior
    // rejected/invalid ticket on the same SO — instead of using the
    // proper resubmit-after-rejection flow. The 60s idempotency guard
    // at the insert path means anything past that window is a real user
    // choice, not a system retry.
    //
    // We attribute every offending new ticket to the MOST RECENT prior
    // rejection on the same (tech, SO) via a LATERAL lookup, then group
    // by that rejection so a single coaching event surfaces ALL the
    // duplicate new tickets it spawned (some techs file 2+ new tickets
    // after one rejection). Bounded by the days param.
    const safeDays = Math.min(Math.max(Math.floor(days) || 30, 1), 365);
    const rows = await db.execute(sql`
      WITH new_tickets AS (
        SELECT
          s.id,
          s.technician_id,
          s.service_order,
          s.ticket_status,
          s.created_at
        FROM submissions s
        WHERE s.resubmission_of IS NULL
          AND s.created_at > NOW() - (${safeDays}::int * INTERVAL '1 day')
      ),
      with_prev AS (
        SELECT
          n.id            AS new_id,
          n.ticket_status AS new_status,
          n.created_at    AS new_at,
          n.technician_id,
          n.service_order,
          p.id            AS prev_id,
          p.ticket_status AS prev_status,
          p.created_at    AS prev_at
        FROM new_tickets n
        CROSS JOIN LATERAL (
          SELECT s2.id, s2.ticket_status, s2.created_at
          FROM submissions s2
          WHERE s2.technician_id = n.technician_id
            AND s2.service_order = n.service_order
            AND s2.created_at < n.created_at
            AND s2.ticket_status IN ('rejected','rejected_closed','invalid')
          ORDER BY s2.created_at DESC
          LIMIT 1
        ) p
      )
      SELECT
        wp.technician_id              AS "technicianId",
        COALESCE(u.name, t.name, '')  AS "techName",
        COALESCE(u.rac_id, t.ldap_id, '') AS "techLdap",
        wp.service_order              AS "serviceOrder",
        wp.prev_id                    AS "previousId",
        MAX(wp.prev_status)           AS "previousStatus",
        MAX(wp.prev_at)               AS "previousAt",
        jsonb_agg(jsonb_build_object(
          'id',           wp.new_id,
          'status',       wp.new_status,
          'at',           wp.new_at,
          'minutesAfter', ROUND(EXTRACT(EPOCH FROM (wp.new_at - wp.prev_at)) / 60.0)::int
        ) ORDER BY wp.new_at)         AS "newTickets",
        COUNT(*)::int                 AS "newCount",
        MIN(ROUND(EXTRACT(EPOCH FROM (wp.new_at - wp.prev_at)) / 60.0)::int) AS "minutesBetween",
        MAX(wp.new_at)                AS "latestNewAt"
      FROM with_prev wp
      LEFT JOIN users u ON u.id = wp.technician_id
      LEFT JOIN technicians t ON t.ldap_id = u.rac_id
      GROUP BY wp.technician_id, wp.service_order, wp.prev_id, u.name, t.name, u.rac_id, t.ldap_id
      ORDER BY MAX(wp.new_at) DESC
      LIMIT 500;
    `);
    return rows.rows as any;
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
    // Counts stay in SQL. Tyler perf: the count rollup and the business-hours
    // average rollup are independent read-only queries — run them concurrently
    // instead of sequentially. Output is unchanged.
    const districtProfile = getCachedBusinessHoursProfile("default");
    const bh = this.businessHoursSqlParams(districtProfile);
    const countRowsPromise = db.execute(sql`
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

    // Tyler 2026-04-30: business-hours-aware avg per district, using the
    // admin-configured default profile. Tyler 2026-06-17 (perf — Task #26):
    // the per-row business-elapsed math + grouping now runs in SQL instead of
    // streaming every reviewed row into Node. Districts merge null AND '' into
    // "Unknown" (COALESCE(NULLIF(...))) to match the prior `r.districtCode ||
    // "Unknown"` keying exactly. Verified equivalent to the JS loop.
    const avgRowsPromise = db.execute(sql`
      WITH params AS (
        SELECT ${bh.open}::time AS open_t, ${bh.close}::time AS close_t, ${sql.raw(bh.dowsLiteral)} AS open_dows
      ),
      d_base AS (
        SELECT id, district_code,
          date_trunc('milliseconds', created_at AT TIME ZONE 'UTC') AS s,
          date_trunc('milliseconds', stage1_reviewed_at AT TIME ZONE 'UTC') AS e
        FROM submissions
        WHERE stage1_reviewed_at IS NOT NULL AND created_at IS NOT NULL
      ),
      d_pr AS (
        SELECT b.id, COALESCE(NULLIF(b.district_code, ''), 'Unknown') AS district,
          COALESCE(ROUND(SUM(
            CASE WHEN g.d IS NULL THEN 0
                 WHEN EXTRACT(ISODOW FROM g.d)::int = ANY(p.open_dows)
                 THEN GREATEST(0, EXTRACT(EPOCH FROM (
                   LEAST(b.e, ((g.d::date + p.close_t) AT TIME ZONE 'America/New_York'))
                   - GREATEST(b.s, ((g.d::date + p.open_t) AT TIME ZONE 'America/New_York'))
                 )))
                 ELSE 0 END
          ) * 1000), 0)::bigint AS ms
        FROM d_base b
        CROSS JOIN params p
        LEFT JOIN LATERAL generate_series(
          date_trunc('day', b.s AT TIME ZONE 'America/New_York'),
          date_trunc('day', b.e AT TIME ZONE 'America/New_York'),
          interval '1 day'
        ) AS g(d) ON true
        GROUP BY b.id, b.district_code
      )
      SELECT district, AVG(ms) AS avg_ms FROM d_pr GROUP BY district
    `);

    const [countRows, avgRows] = await Promise.all([countRowsPromise, avgRowsPromise]);

    const avgByDistrict = new Map<string, number>();
    for (const r of avgRows.rows as any[]) {
      if (r.avg_ms != null) avgByDistrict.set(r.district, Number(r.avg_ms));
    }

    return (countRows.rows as any[]).map(r => {
      const districtKey = r.district || "Unknown";
      return {
        district: districtKey,
        totalTickets: Number(r.totalTickets) || 0,
        approved: Number(r.approved) || 0,
        rejected: Number(r.rejected) || 0,
        pending: Number(r.pending) || 0,
        completed: Number(r.completed) || 0,
        avgTimeToStage1Ms: avgByDistrict.has(districtKey) ? avgByDistrict.get(districtKey)! : null,
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
        u.role AS "role",
        COUNT(s.id)::int AS "totalTickets",
        COUNT(CASE WHEN s.ticket_status IN ('queued', 'pending') THEN 1 END)::int AS "pendingCount",
        COUNT(CASE WHEN s.ticket_status IN ('completed', 'approved') THEN 1 END)::int AS "approvedCount",
        COUNT(CASE WHEN s.ticket_status = 'rejected' THEN 1 END)::int AS "rejectedCount"
      FROM users u
      LEFT JOIN technicians t ON u.rac_id = t.ldap_id
      LEFT JOIN submissions s ON u.rac_id = s.technician_ldap_id
      WHERE (u.role = 'technician' OR (u.role = 'vrs_agent' AND t.ldap_id IS NOT NULL)) AND u.is_system_account = false
      GROUP BY u.id, u.name, u.rac_id, u.phone, t.district, t.tech_un_no, t.manager_name, u.role
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

  // Tyler 2026-05-20 (afternoon) — Replacement Review analytics. Mirrors
  // getNlaAnalytics shape so the admin card and queryClient cache key
  // patterns stay identical. Counts every ticket flagged
  // `replacement_review_recommended` regardless of requestType (defensive —
  // the /process route currently only allows authorization tickets, but the
  // analytics shouldn't silently undercount if that ever changes).
  async getReplacementReviewAnalytics(): Promise<{ today: number; week: number; month: number; allTime: number }> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const flagCondition = eq(submissions.replacementReviewRecommended, true);

    const [allTimeResult] = await db.select({ count: sql<number>`count(*)` }).from(submissions).where(flagCondition);
    const [todayResult] = await db.select({ count: sql<number>`count(*)` }).from(submissions).where(and(flagCondition, gte(submissions.statusChangedAt, todayStart)));
    const [weekResult] = await db.select({ count: sql<number>`count(*)` }).from(submissions).where(and(flagCondition, gte(submissions.statusChangedAt, weekStart)));
    const [monthResult] = await db.select({ count: sql<number>`count(*)` }).from(submissions).where(and(flagCondition, gte(submissions.statusChangedAt, monthStart)));

    return {
      today: Number(todayResult?.count) || 0,
      week: Number(weekResult?.count) || 0,
      month: Number(monthResult?.count) || 0,
      allTime: Number(allTimeResult?.count) || 0,
    };
  }

  // Task #12 — B2B Approved Replacement analytics. Same shape/pattern as
  // getReplacementReviewAnalytics but counts tickets flagged
  // `b2b_approved_replacement` so the admin card can track this outcome
  // separately from Sears Protect Replacement Review.
  async getB2bReplacementAnalytics(): Promise<{ today: number; week: number; month: number; allTime: number }> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const flagCondition = eq(submissions.b2bApprovedReplacement, true);

    const [allTimeResult] = await db.select({ count: sql<number>`count(*)` }).from(submissions).where(flagCondition);
    const [todayResult] = await db.select({ count: sql<number>`count(*)` }).from(submissions).where(and(flagCondition, gte(submissions.statusChangedAt, todayStart)));
    const [weekResult] = await db.select({ count: sql<number>`count(*)` }).from(submissions).where(and(flagCondition, gte(submissions.statusChangedAt, weekStart)));
    const [monthResult] = await db.select({ count: sql<number>`count(*)` }).from(submissions).where(and(flagCondition, gte(submissions.statusChangedAt, monthStart)));

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
      // Tyler 2026-05-01 (P1 fix — sub 566): collapsed the AUTH/NLA branch
      // here onto the shared isTerminalTicketStatusForIntake predicate so
      // the in-transaction re-check matches the route pre-flight gate
      // exactly. Without this, AUTH-rejected confirms would tx-409 here
      // even after the route-level gate was relaxed. NLA never writes
      // "approved" so its accepted set is naturally a subset.
      if (!isTerminalTicketStatusForIntake(lockedStatus)) {
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

  // ==========================================================================
  // SYSTEM HEALTH REGRESSION WATCH (2026-05-11)
  // ==========================================================================
  async findOpenHealthIncident(
    checkName: string,
    entityType: string,
    entityId: number
  ): Promise<SystemHealthLog | undefined> {
    const [row] = await db
      .select()
      .from(systemHealthLog)
      .where(
        and(
          eq(systemHealthLog.checkName, checkName),
          eq(systemHealthLog.entityType, entityType),
          eq(systemHealthLog.entityId, entityId),
          isNull(systemHealthLog.clearedAt)
        )
      )
      .limit(1);
    return row;
  }

  async openHealthIncident(
    data: InsertSystemHealthLog
  ): Promise<SystemHealthLog> {
    // Race-safe: a partial unique index on (check_name, entity_type,
    // entity_id) WHERE cleared_at IS NULL guarantees at most one open
    // incident per (check, entity). On conflict the loser falls back to
    // touching the existing open row.
    const inserted = await db
      .insert(systemHealthLog)
      .values(data)
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) return inserted[0];
    const existing = await this.findOpenHealthIncident(
      data.checkName,
      data.entityType,
      data.entityId
    );
    if (!existing) {
      throw new Error(
        `openHealthIncident: insert conflicted but no open incident found for ${data.checkName}/${data.entityType}:${data.entityId}`
      );
    }
    await this.touchHealthIncident(existing.id);
    return existing;
  }

  async touchHealthIncident(id: number): Promise<void> {
    await db
      .update(systemHealthLog)
      .set({ lastSeenAt: new Date() })
      .where(eq(systemHealthLog.id, id));
  }

  async clearHealthIncident(id: number, clearedBy?: number, clearReason?: string): Promise<void> {
    await db
      .update(systemHealthLog)
      .set({
        clearedAt: new Date(),
        clearedBy: clearedBy ?? null,
        clearReason: clearReason ?? null,
      })
      .where(eq(systemHealthLog.id, id));
  }

  async listHealthIncidents(opts: {
    openOnly?: boolean;
    checkName?: string;
    limit?: number;
  }): Promise<SystemHealthLog[]> {
    const conds = [];
    if (opts.openOnly) conds.push(isNull(systemHealthLog.clearedAt));
    if (opts.checkName) conds.push(eq(systemHealthLog.checkName, opts.checkName));
    let q = db.select().from(systemHealthLog).$dynamic();
    if (conds.length) q = q.where(and(...conds));
    return await q
      .orderBy(desc(systemHealthLog.detectedAt))
      .limit(opts.limit ?? 200);
  }

  async listOpenHealthIncidentsByCheck(
    checkName: string
  ): Promise<SystemHealthLog[]> {
    return await db
      .select()
      .from(systemHealthLog)
      .where(
        and(
          eq(systemHealthLog.checkName, checkName),
          isNull(systemHealthLog.clearedAt)
        )
      );
  }

  // ==========================================================================
  // AGENT ACTIVITY LOG (2026-05-20)
  // Append-only audit of every auto-offline / status-change event. Used by
  // /api/admin/agent-activity to confirm the screen-inactivity feature is
  // firing for the right reasons. Logging is best-effort — a failed insert
  // must never break the underlying status change, so callers wrap us in
  // try/catch and swallow errors.
  // ==========================================================================
  async logAgentActivity(data: InsertAgentActivityLog): Promise<AgentActivityLog> {
    const [row] = await db.insert(agentActivityLog).values(data).returning();
    return row;
  }

  async getRecentAgentActivity(opts: {
    userId?: number;
    eventType?: string;
    since?: Date;
    limit?: number;
  }): Promise<(AgentActivityLog & { userName?: string })[]> {
    const conds = [];
    if (opts.userId) conds.push(eq(agentActivityLog.userId, opts.userId));
    if (opts.eventType) conds.push(eq(agentActivityLog.eventType, opts.eventType));
    if (opts.since) conds.push(sql`${agentActivityLog.createdAt} >= ${opts.since}`);
    const rows = await db
      .select({
        id: agentActivityLog.id,
        userId: agentActivityLog.userId,
        eventType: agentActivityLog.eventType,
        details: agentActivityLog.details,
        createdAt: agentActivityLog.createdAt,
        userName: users.name,
      })
      .from(agentActivityLog)
      .leftJoin(users, eq(agentActivityLog.userId, users.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(agentActivityLog.createdAt))
      .limit(Math.min(opts.limit ?? 200, 1000));
    return rows as any;
  }
}

export const storage = new DatabaseStorage();
