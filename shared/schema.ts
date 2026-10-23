// ============================================================================
// ⚠️  SCHEMA SAFETY RULES — READ BEFORE EDITING
// ============================================================================
// 1. NEVER change a column's type (e.g., serial → varchar, text → integer).
//    This generates destructive ALTER TABLE statements that DROP and recreate columns.
// 2. NEVER rename a column. Drizzle treats renames as DROP + ADD, losing all data.
// 3. NEVER remove a column without explicit approval. Add columns freely; removing
//    requires verifying no code references the column and data is expendable.
// 4. NEVER change primary key types. All tables use `serial("id").primaryKey()`.
// 5. Adding new columns with defaults or nullable is always safe.
// 6. Adding new tables is always safe.
// 7. Run `npm run db:push` to sync. It will prompt for confirmation on destructive
//    changes because strict mode is enabled in drizzle.config.ts.
// ============================================================================

import { sql } from "drizzle-orm";
import { pgTable, serial, text, varchar, integer, timestamp, date, unique, uniqueIndex, index, boolean, jsonb, pgEnum, foreignKey, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ============================================================================
// USERS TABLE
// ============================================================================
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }),
  password: varchar("password", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  role: text("role").notNull(), // 'technician', 'vrs_agent', 'admin', 'super_admin', 'provider_1099'
  phone: varchar("phone", { length: 20 }),
  racId: varchar("rac_id", { length: 50 }),
  // 1099 provider portal: the provider's assigned "1099 Company Name" (chosen
  // from shared/provider1099.ts). Null for every non-provider account. Shown
  // read-only to the provider in place of the RAC ID field.
  companyName: varchar("company_name", { length: 120 }),
  isActive: boolean("is_active").notNull().default(true),
  firstLogin: boolean("first_login").notNull().default(true),
  lastSeenVersion: varchar("last_seen_version", { length: 50 }),
  lastRgcCodeEntry: date("last_rgc_code_entry"),
  mustChangePassword: boolean("must_change_password").notNull().default(true),
  passwordChangedAt: timestamp("password_changed_at"),
  isSystemAccount: boolean("is_system_account").notNull().default(false),
  passwordResetToken: varchar("password_reset_token", { length: 100 }),
  passwordResetExpires: timestamp("password_reset_expires"),
  agentStatus: text("agent_status").notNull().default("offline"),
  autoOfflinedAt: timestamp("auto_offlined_at"),
  canOrderParts: boolean("can_order_parts").notNull().default(false),
  notificationTone: varchar("notification_tone", { length: 50 }).notNull().default("chime"),
  notificationVolume: varchar("notification_volume", { length: 10 }).notNull().default("0.5"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
}, (table) => ({
  // Tyler 2026-05-12 — runtime-created in seed.ts ensurePerformanceIndexes().
  // Declared here so drizzle-kit push doesn't try to drop them on schema sync.
  racIdIdx: index("idx_users_rac_id").on(table.racId),
}));

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// ============================================================================
// VRS AGENT SPECIALIZATIONS TABLE
// ============================================================================
export const vrsAgentSpecializations = pgTable(
  "vrs_agent_specializations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    division: text("division").notNull(), // 'cooking', 'dishwasher', 'microwave', 'laundry', 'refrigeration', 'hvac', 'all_other', 'generalist'
  },
  (table) => ({
    uniqueUserDivision: unique().on(table.userId, table.division),
  })
);

export const insertVrsAgentSpecializationSchema = createInsertSchema(
  vrsAgentSpecializations
).omit({
  id: true,
});

export type InsertVrsAgentSpecialization = z.infer<
  typeof insertVrsAgentSpecializationSchema
>;
export type VrsAgentSpecialization =
  typeof vrsAgentSpecializations.$inferSelect;

// ============================================================================
// SUBMISSIONS TABLE
// ============================================================================
// Valid rootCause values accepted by the Tech PDC coaching-intake API
// (live enum from its 400 validation response, 2026-08-07 — supersedes the
// outdated list in the attached PDF guide). Shared so the admin UI dropdown
// and the server payload/validation can never drift apart.
export const TECH_PDC_ROOT_CAUSES = [
  "LACK_OF_KNOWLEDGE",
  "LACK_OF_TRAINING",
  "PROCESS_CONFUSION",
  "SYSTEM_ISSUE",
  "TIME_PRESSURE",
  "NEGLIGENCE",
  "INTENTIONAL_MISCONDUCT",
  "MISCOMMUNICATION",
  "WORKLOAD_ROUTING_ISSUE",
  "RETURN_SAMSARA_CAMERA",
  "RETURN_PHONE",
  "RETURN_OTHER_ASSET",
] as const;
export type TechPdcRootCause = (typeof TECH_PDC_ROOT_CAUSES)[number];

export const submissions = pgTable("submissions", {
  id: serial("id").primaryKey(),
  technicianId: integer("technician_id")
    .notNull()
    .references(() => users.id),
  racId: varchar("rac_id", { length: 50 }).notNull(),
  phone: varchar("phone", { length: 20 }).notNull(),
  serviceOrder: varchar("service_order", { length: 13 }).notNull(),
  districtCode: varchar("district_code", { length: 4 }),
  applianceType: text("appliance_type").notNull(), // 'cooking', 'dishwasher', 'microwave', 'laundry', 'refrigeration', 'hvac', 'all_other'
  requestType: text("request_type").notNull(), // 'authorization', 'infestation_non_accessible', 'parts_nla'
  warrantyType: text("warranty_type").notNull().default("sears_protect"), // 'sears_protect', 'b2b'
  warrantyProvider: varchar("warranty_provider", { length: 100 }),
  issueDescription: text("issue_description").notNull(),
  originalDescription: text("original_description"),
  aiEnhanced: boolean("ai_enhanced").notNull().default(false),
  estimateAmount: text("estimate_amount"), // stored as text, parsed as decimal in application
  partNumbers: text("part_numbers"), // JSON string array, e.g. '["WPW10321304","W10321304"]'
  photos: text("photos"), // JSON string of photo URLs array
  // Tyler 2026-07-08 — client-generated thumbnails for fast first paint in
  // ticket photo grids. JSON map { fullPhotoPath: thumbPath } (map, not a
  // parallel array, so it survives both photos formats and partial thumb
  // failures). Full paths remain the identity everywhere (lightbox,
  // rejection, rejected_media) — only the grid <img src> swaps to the thumb.
  // Migrated idempotently in seed.ts (ensurePhotoThumbnailsColumn).
  photoThumbnails: text("photo_thumbnails"),
  videoUrl: varchar("video_url", { length: 500 }),
  voiceNoteUrl: varchar("voice_note_url", { length: 500 }),
  technicianLdapId: varchar("technician_ldap_id", { length: 50 }),
  phoneOverride: varchar("phone_override", { length: 20 }),
  ticketStatus: text("ticket_status").notNull().default("queued"), // 'queued', 'pending', 'approved', 'rejected', 'invalid', 'completed'
  stage1Status: text("stage1_status").notNull().default("pending"),
  stage1ReviewedBy: integer("stage1_reviewed_by").references(() => users.id),
  stage1ReviewedAt: timestamp("stage1_reviewed_at"),
  stage1RejectionReason: text("stage1_rejection_reason"),
  invalidReason: varchar("invalid_reason", { length: 255 }),
  invalidInstructions: text("invalid_instructions"),
  stage2Status: text("stage2_status").notNull().default("pending"),
  stage2ReviewedBy: integer("stage2_reviewed_by").references(() => users.id),
  stage2ReviewedAt: timestamp("stage2_reviewed_at"),
  stage2Outcome: text("stage2_outcome"),
  declineReason: varchar("decline_reason", { length: 255 }),
  declineInstructions: text("decline_instructions"),
  submissionApproved: boolean("submission_approved").notNull().default(false),
  submissionApprovedAt: timestamp("submission_approved_at"),
  authCode: varchar("auth_code", { length: 50 }),
  rgcCode: varchar("rgc_code", { length: 50 }),
  assignedTo: integer("assigned_to").references(() => users.id),
  claimedAt: timestamp("claimed_at"),
  nlaResolution: text("nla_resolution"),
  nlaFoundPartNumber: varchar("nla_found_part_number", { length: 100 }),
  nlaEscalatedBy: integer("nla_escalated_by").references(() => users.id),
  // Stable queue-wait stop for the researched-needs-order handoff. Written
  // atomically by nla_escalate_to_pcard and preserved through P-card claims.
  nlaReadyForOrderAt: timestamp("nla_ready_for_order_at"),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  agentNotes: text("agent_notes"),
  technicianMessage: text("technician_message"),
  rejectionReasons: text("rejection_reasons"),
  rejectedMedia: text("rejected_media"),
  // 2026-08-06 (Rejection & Coaching Report) — coaching capture on rejections.
  // expectedVsActual: agent's description of expected vs. actual technician
  // behavior; coachingNotes: editable coaching guidance (agents at reject
  // time, agents/admins later via PATCH /api/submissions/:id/coaching).
  // Migrated idempotently in seed.ts (ensureCoachingColumns).
  expectedVsActual: text("expected_vs_actual"),
  coachingNotes: text("coaching_notes"),
  // Tech PDC delivery tracking for coaching pushes. techPdcStatus:
  // null (never pushed) | 'pending' | 'sent' | 'failed'.
  // (valid values in TECH_PDC_ROOT_CAUSES below)
  // Root cause selected by the agent/admin — required by the Tech PDC
  // intake API (its live enum, discovered 2026-08-07; the PDF guide's list
  // was outdated). See TECH_PDC_ROOT_CAUSES.
  techPdcRootCause: text("tech_pdc_root_cause"),
  techPdcStatus: text("tech_pdc_status"),
  techPdcSentAt: timestamp("tech_pdc_sent_at"),
  techPdcError: text("tech_pdc_error"),
  techPdcAttempts: integer("tech_pdc_attempts").notNull().default(0),
  reassignmentNotes: text("reassignment_notes"),
  appealNotes: text("appeal_notes"),
  resubmissionOf: integer("resubmission_of"),
  procId: varchar("proc_id", { length: 50 }),
  clientNm: varchar("client_nm", { length: 150 }),
  // 2026-10-16 — AHS authorization details for VRS AI (contract, customer,
  // appliance, failure cause, amounts, parts). JSON matching
  // shared/ahs-details.ts ahsDetailsSchema; null for every other ticket.
  // Migrated idempotently in seed.ts (ensureAhsDetailsColumn).
  ahsDetails: text("ahs_details"),
  // 2026-10-23 — appliance grade, color and part function the technician
  // enters on AHS / First American authorization tickets. JSON matching
  // shared/tech-appliance-details.ts; null for every other ticket.
  // Migrated idempotently in seed.ts (ensureTechApplianceDetailsColumn).
  techApplianceDetails: text("tech_appliance_details"),
  // Tyler 2026-05-20 (afternoon) — Replacement Review outcome. Set true when
  // a standard /process action of `approve_replacement_review` is used so VRS
  // can flag tickets where the warranty company is taking over replacement.
  // Ticket is still ticketStatus="completed" so existing completed-list
  // plumbing works; this is the admin/analytics discriminator. See replit.md
  // "Replacement Review" section. Migrated idempotently in seed.ts.
  replacementReviewRecommended: boolean("replacement_review_recommended").notNull().default(false),
  // Task #12 — B2B Approved Replacement outcome. Set true when a standard
  // /process action of `b2b_approved_replacement` is used on an AHS / First
  // American (two-stage) ticket at the Stage 2 authorization step. Distinct
  // from `replacementReviewRecommended` (Sears Protect Replacement Review) so
  // reporting can tell the two replacement outcomes apart. No auth/RGC code is
  // issued for this outcome. Migrated idempotently in seed.ts.
  b2bApprovedReplacement: boolean("b2b_approved_replacement").notNull().default(false),
  statusChangedAt: timestamp("status_changed_at").default(sql`now()`),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
}, (table) => ({
  // Tyler 2026-05-12 — runtime-created in seed.ts ensurePerformanceIndexes()
  // (CREATE INDEX CONCURRENTLY). Declared here so drizzle-kit push doesn't
  // try to drop them on schema sync. Order/columns must match the runtime
  // CREATE INDEX statements exactly.
  statusRequestIdx: index("idx_submissions_status_request").on(table.ticketStatus, table.requestType),
  assignedStatusIdx: index("idx_submissions_assigned_status").on(table.assignedTo, table.ticketStatus),
  serviceOrderIdx: index("idx_submissions_service_order").on(table.serviceOrder),
  technicianCreatedIdx: index("idx_submissions_technician_created").on(table.technicianId, sql`created_at DESC`),
  createdAtIdx: index("idx_submissions_created_at").on(table.createdAt),
  // Tyler 2026-06-17 (perf — Task #26): runtime-created in seed.ts
  // ensurePerformanceIndexes(). Declared here so drizzle-kit push doesn't try
  // to drop them on schema sync. Order/columns must match the CREATE INDEX
  // statements exactly.
  applianceTypeIdx: index("idx_submissions_appliance_type").on(table.applianceType),
  stage1ReviewedAtIdx: index("idx_submissions_stage1_reviewed_at").on(table.stage1ReviewedAt),
  stage2ReviewedAtIdx: index("idx_submissions_stage2_reviewed_at").on(table.stage2ReviewedAt),
  reviewedAtIdx: index("idx_submissions_reviewed_at").on(table.reviewedAt),
  reviewedByIdx: index("idx_submissions_reviewed_by").on(table.reviewedBy),
}));

export const insertSubmissionSchema = createInsertSchema(submissions).omit({
  id: true,
  statusChangedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
export type Submission = typeof submissions.$inferSelect;

// Slim row shape returned by GET /api/submissions for agent/admin/super_admin
// list views (Tyler 2026-05-06, perf — Task #4 dashboard payload slim-down).
//
// Heavy text/JSON columns are deliberately omitted because the list table
// never reads them — they only matter inside the detail panel, which already
// drills via GET /api/submissions/:id for a full row. Excluded here:
//   photos, agentNotes, partNumbers, technicianMessage,
//   issueDescription, originalDescription,
//   rejectionReasons, rejectedMedia, reassignmentNotes, appealNotes,
//   invalidInstructions, declineInstructions, stage1RejectionReason,
//   nlaFoundPartNumber,
//   videoUrl, voiceNoteUrl.
//
// At ~500-1500 visible rows per agent in production this cuts the payload
// roughly 5-10x without changing schema or removing data.
export type SubmissionListItem = Pick<Submission,
  | "id" | "technicianId" | "racId" | "serviceOrder" | "districtCode" | "phone"
  | "applianceType" | "requestType" | "warrantyType" | "warrantyProvider"
  | "aiEnhanced" | "estimateAmount"
  | "ticketStatus" | "stage1Status" | "stage2Status"
  | "stage1ReviewedAt" | "stage1ReviewedBy"
  | "stage2ReviewedAt" | "stage2ReviewedBy" | "stage2Outcome"
  | "submissionApproved" | "submissionApprovedAt"
  | "assignedTo" | "claimedAt" | "reviewedBy" | "reviewedAt"
  | "statusChangedAt" | "createdAt" | "updatedAt"
  | "authCode" | "rgcCode"
  | "phoneOverride" | "technicianLdapId"
  | "resubmissionOf" | "nlaResolution" | "nlaEscalatedBy" | "nlaReadyForOrderAt"
  | "procId" | "clientNm"
  | "replacementReviewRecommended" | "b2bApprovedReplacement"
  | "invalidReason" | "declineReason"
  // Tyler 2026-05-07 (prod fire — VRS rejecting tickets as "no photos"):
  // photos/videoUrl/voiceNoteUrl are URL-only metadata strings (a few
  // hundred bytes per ticket — actual media bytes live in object storage)
  // and are required up-front so the detail panel can render media even
  // before the heavy /api/submissions/:id detail fetch resolves. Removing
  // them in the original Task #4 slim-down created a render window where
  // "No photos attached" showed for ~50–300 ms, prompting fast agents to
  // wrongly reject tickets that did contain photos. Putting them back here
  // closes that window without re-introducing the heavy columns
  // (agentNotes / auditTrail / rejectedMedia / partNumbers / etc.).
  | "photos" | "videoUrl" | "voiceNoteUrl"
  // Tyler 2026-07-08 — thumbnails ride with photos for the same reason:
  // the detail panel renders media from the slim row before the heavy
  // detail fetch resolves, and the grid needs the thumb map at that moment.
  | "photoThumbnails"
  // Task #43 (Tech PDC at a glance) — the admin Ticket Overview shows a
  // per-row Tech PDC status badge + missing-coaching-notes marker for
  // negative-outcome rows, and a filter over these. techPdcStatus /
  // techPdcSentAt are tiny; coachingNotes is text but only populated on
  // rejection paths (bounded 5000 chars, rare rows), so payload impact
  // is negligible.
  | "techPdcStatus" | "techPdcSentAt" | "coachingNotes"
  // Task #44 (row-level Tech PDC push) — the inline Push button in the
  // Ticket Overview needs to know whether a root cause is set to decide
  // eligibility client-side. Tiny enum-like text column.
  | "techPdcRootCause"
>;

export type SubmissionListVrsAiStatus = {
  callId: string | null;
  state: string | null;
  providerCallId: string | null;
  dispatchError: string | null;
  failureReason: string | null;
  retryable: boolean | null;
  dispatchedAt: Date | null;
  completedAt: Date | null;
};

export type SubmissionListItemWithTech = SubmissionListItem & {
  technicianName: string;
  technicianPhone: string | null;
  assignedAgentName: string | null;
  workedAgentSearchTerms?: string[];
  intakeFormCompletedAt: Date | null;
  /** Present only when the row is linked to a VRS AI bridge call. */
  vrsAi?: SubmissionListVrsAiStatus | null;
};

// ============================================================================
// SUBMISSION NOTES TABLE (technician follow-up notes after submission)
// ============================================================================
export const submissionNotes = pgTable("submission_notes", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id")
    .notNull()
    .references(() => submissions.id, { onDelete: "cascade" }),
  authorId: integer("author_id")
    .notNull()
    .references(() => users.id),
  authorRole: text("author_role").notNull(), // 'technician', 'vrs_agent', 'admin'
  // NULL preserves the historical shared audience. New writes explicitly use
  // shared or staff_only; existing rows are never silently reclassified.
  visibility: text("visibility"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").default(sql`now()`),
}, (table) => ({
  // Tyler 2026-06-23 (perf): runtime-created in seed.ts ensurePerformanceIndexes().
  // Backs getSubmissionNotes (filters by submission_id on every detail-view open).
  // Declared here so drizzle-kit push doesn't try to drop it on schema sync.
  submissionIdIdx: index("idx_submission_notes_submission_id").on(table.submissionId),
}));

export const insertSubmissionNoteSchema = createInsertSchema(submissionNotes).omit({
  id: true,
  createdAt: true,
});

export type InsertSubmissionNote = z.infer<typeof insertSubmissionNoteSchema>;
export type SubmissionNote = typeof submissionNotes.$inferSelect;

// ============================================================================
// SMS NOTIFICATIONS TABLE
// ============================================================================
export const smsNotifications = pgTable("sms_notifications", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id")
    .notNull()
    .references(() => submissions.id),
  recipientPhone: varchar("recipient_phone", { length: 20 }).notNull(),
  messageType: text("message_type").notNull(), // 'stage1_approved', 'stage1_rejected', 'auth_code_sent'
  messageBody: text("message_body").notNull(),
  twilioSid: varchar("twilio_sid", { length: 100 }),
  sentAt: timestamp("sent_at").default(sql`now()`),
}, (table) => ({
  // Tyler 2026-06-23 (perf): runtime-created in seed.ts ensurePerformanceIndexes().
  // Backs reads + cascade deletes that filter sms_notifications by submission_id.
  // Declared here so drizzle-kit push doesn't try to drop it on schema sync.
  submissionIdIdx: index("idx_sms_notifications_submission_id").on(table.submissionId),
}));

export const insertSmsNotificationSchema = createInsertSchema(
  smsNotifications
).omit({
  id: true,
  sentAt: true,
});

export type InsertSmsNotification = z.infer<typeof insertSmsNotificationSchema>;
export type SmsNotification = typeof smsNotifications.$inferSelect;

// ============================================================================
// DAILY RGC CODES TABLE
// ============================================================================
export const dailyRgcCodes = pgTable(
  "daily_rgc_codes",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 50 }).notNull(),
    validDate: date("valid_date").notNull().unique(),
    createdBy: integer("created_by").references(() => users.id),
    createdAt: timestamp("created_at").default(sql`now()`),
  }
);

export const insertDailyRgcCodeSchema = createInsertSchema(dailyRgcCodes).omit({
  id: true,
  createdAt: true,
});

export type InsertDailyRgcCode = z.infer<typeof insertDailyRgcCodeSchema>;
export type DailyRgcCode = typeof dailyRgcCodes.$inferSelect;

// ============================================================================
// TECHNICIANS TABLE (Synced from Snowflake)
// ============================================================================
export const technicians = pgTable("technicians", {
  id: serial("id").primaryKey(),
  ldapId: varchar("ldap_id", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  phone: varchar("phone", { length: 20 }),
  district: varchar("district", { length: 10 }),
  state: varchar("state", { length: 2 }),
  managerName: varchar("manager_name", { length: 255 }),
  techUnNo: varchar("tech_un_no", { length: 50 }),
  isActive: boolean("is_active").notNull().default(true),
  lastSyncedAt: timestamp("last_synced_at"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
});

export const insertTechnicianSchema = createInsertSchema(technicians).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTechnician = z.infer<typeof insertTechnicianSchema>;
export type Technician = typeof technicians.$inferSelect;

// ============================================================================
// FEEDBACK TABLE
// ============================================================================
export const feedback = pgTable("feedback", {
  id: serial("id").primaryKey(),
  technicianId: integer("technician_id").references(() => users.id),
  technicianName: varchar("technician_name", { length: 255 }).notNull(),
  technicianRacId: varchar("technician_rac_id", { length: 50 }).notNull(),
  feedbackType: text("feedback_type").notNull(),
  priority: text("priority").notNull().default("medium"),
  description: text("description").notNull(),
  attachmentUrl: varchar("attachment_url", { length: 500 }),
  status: text("status").notNull().default("new"),
  adminNotes: text("admin_notes"),
  resolvedBy: integer("resolved_by").references(() => users.id),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
});

export const insertFeedbackSchema = createInsertSchema(feedback).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertFeedback = z.infer<typeof insertFeedbackSchema>;
export type Feedback = typeof feedback.$inferSelect;

// ============================================================================
// SYSTEM SETTINGS TABLE
// ============================================================================
export const systemSettings = pgTable("system_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").default(sql`now()`),
});

export type SystemSetting = typeof systemSettings.$inferSelect;

// ============================================================================
// SYSTEM HEALTH LOG (2026-05-11 — regression watch for shipped fixes)
// ============================================================================
// Persistent audit trail of regression-check findings. The
// /api/admin/health/regression-check endpoint runs a set of named checks
// (one per shipped fix area) and:
//   - opens a new row when a problem is first detected for an entity
//   - touches lastSeenAt while the problem is still present
//   - sets clearedAt when the problem is no longer detected
// Lets the agent (and humans) look back at when bugs occurred and what
// cleared them, even between manual checks.
// 2026-08-12 — persisted weekly reports (e.g. Wednesday IH tech no-login
// report). Generated by a scheduler, downloadable from the admin dashboard.
export const weeklyReports = pgTable(
  "weekly_reports",
  {
    id: serial("id").primaryKey(),
    reportType: varchar("report_type", { length: 64 }).notNull(),
    generatedAt: timestamp("generated_at").notNull().defaultNow(),
    // Small JSON summary (counts etc.) surfaced in notifications/UI.
    summary: jsonb("summary").notNull(),
    // The full report body as CSV, served as a download. Retention is
    // bounded (last 26 per type) since rows contain tech names/phones.
    csv: text("csv").notNull(),
  },
  (table) => ({
    typeGeneratedIdx: index("weekly_reports_type_generated_idx").on(table.reportType, table.generatedAt.desc()),
  }),
);
export type WeeklyReport = typeof weeklyReports.$inferSelect;

export const execSummaryDeliveries = pgTable(
  "exec_summary_deliveries",
  {
    id: serial("id").primaryKey(),
    // Do not cascade: report + delivery history are an audit record. Executive
    // reports are intentionally excluded from the generic 26-report pruning.
    reportId: integer("report_id").notNull().references(() => weeklyReports.id),
    // Scheduled runs use an ET-week key (for example 2026-09-14); manual
    // runs leave this null so previews/generate-only cannot consume a run.
    scheduleKey: varchar("schedule_key", { length: 16 }),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    payload: jsonb("payload").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reportUnique: uniqueIndex("exec_summary_deliveries_report_uidx").on(table.reportId),
    scheduleUnique: uniqueIndex("exec_summary_deliveries_schedule_uidx")
      .on(table.scheduleKey).where(sql`schedule_key IS NOT NULL`),
    retryIdx: index("exec_summary_deliveries_retry_idx").on(table.state, table.nextAttemptAt),
  }),
);
export const systemHealthLog = pgTable(
  "system_health_log",
  {
    id: serial("id").primaryKey(),
    checkName: varchar("check_name", { length: 64 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull(),
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    entityId: integer("entity_id").notNull(),
    finding: jsonb("finding").notNull(),
    detectedAt: timestamp("detected_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    clearedAt: timestamp("cleared_at"),
    // 2026-05-12 — manual clear audit. Set when an admin marks an incident
    // resolved by hand from the System Health view (vs auto-clear when the
    // check no longer matches). Null for auto-cleared rows.
    clearedBy: integer("cleared_by").references(() => users.id, { onDelete: "set null" }),
    clearReason: text("clear_reason"),
  },
  (table) => ({
    // Partial unique index — at most one OPEN incident per (check, entity).
    // Concurrent inserts collide and the loser is retried as a touch.
    uniqueOpen: uniqueIndex("system_health_log_unique_open_idx")
      .on(table.checkName, table.entityType, table.entityId)
      .where(sql`cleared_at IS NULL`),
  })
);

export const insertSystemHealthLogSchema = createInsertSchema(systemHealthLog).omit({
  id: true,
  detectedAt: true,
  lastSeenAt: true,
  clearedAt: true,
});

export type InsertSystemHealthLog = z.infer<typeof insertSystemHealthLogSchema>;
export type SystemHealthLog = typeof systemHealthLog.$inferSelect;

// Tyler 2026-05-20 (afternoon) — agent activity log. Append-only audit of
// every auto-offline / status-change event so we can confirm the new
// screen-inactivity feature is firing for the right reasons (and so VRS
// can investigate future "I got bumped offline" reports without guessing).
// Event types:
//   auto_offline_fired               — POST /api/agent/auto-offline succeeded (client idle 30 min)
//   auto_offline_skipped_pending     — skipped due to pending ticket
//   auto_offline_skipped_not_online  — skipped because agent was already offline
//   auto_offline_ack                 — agent dismissed inactivity modal (stay offline)
//   status_toggle_self               — PATCH /api/agent/status by agent
//   status_toggle_admin              — PATCH /api/admin/users/:id/status by admin
//   presence_stale_cleanup           — server WS-disconnect 60-min fallback fired
//   presence_stale_skipped_pending   — fallback skipped due to pending ticket
// `details` carries event-specific context: prior/next status, pending counts,
// source (request IP, user-agent snippet), admin actor id, etc.
export const agentActivityLog = pgTable(
  "agent_activity_log",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 48 }).notNull(),
    details: jsonb("details"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    byUser: index("agent_activity_log_user_idx").on(table.userId, table.createdAt),
    byEvent: index("agent_activity_log_event_idx").on(table.eventType, table.createdAt),
  })
);

export const insertAgentActivityLogSchema = createInsertSchema(agentActivityLog).omit({
  id: true,
  createdAt: true,
});
export type InsertAgentActivityLog = z.infer<typeof insertAgentActivityLogSchema>;
export type AgentActivityLog = typeof agentActivityLog.$inferSelect;

// ============================================================================
// INTAKE FORMS TABLE (Smartsheet "VRS Unrep Intake Form 2.0" submission audit)
// ============================================================================
// One row per submission once the agent has confirmed they completed the
// Smartsheet intake form. The presence of this row releases the claim gate
// for that agent. Server-built pre-fill URL is captured for audit.
export const intakeForms = pgTable("intake_forms", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id")
    .notNull()
    .references(() => submissions.id, { onDelete: "cascade" }),
  agentId: integer("agent_id")
    .notNull()
    .references(() => users.id),
  payload: jsonb("payload").notNull(), // canonical form data, keyed by Smartsheet column label
  smartsheetUrlSubmitted: text("smartsheet_url_submitted"), // the pre-filled URL the agent reviewed
  agentConfirmedAt: timestamp("agent_confirmed_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  // Tyler 2026-06-23 (perf): runtime-created in seed.ts ensurePerformanceIndexes().
  // Backs the submission list view's per-row correlated subquery
  // (MAX(agent_confirmed_at) WHERE submission_id = s.id). Declared here so
  // drizzle-kit push doesn't try to drop it on schema sync.
  submissionIdIdx: index("idx_intake_forms_submission_id").on(table.submissionId),
}));

export const insertIntakeFormSchema = createInsertSchema(intakeForms).omit({
  id: true,
  agentConfirmedAt: true,
  createdAt: true,
});

export type InsertIntakeForm = z.infer<typeof insertIntakeFormSchema>;
export type IntakeForm = typeof intakeForms.$inferSelect;

// ============================================================================
// COMMUNICATION TEMPLATES (Task B Phase B — admin-editable SMS/Email/Push copy)
// ============================================================================
// Source-of-truth tables for the Communication Settings module. Replaces the
// hard-coded SMS strings currently scattered across server/sms.ts and the
// inline string literals in server/routes.ts (~25 distinct copy variants
// across 18 sendSms call sites).
//
// Phase B = SMS only at the call sites. Email and Push are pre-staged in the
// schema (channel enum + nullable subject/title columns) so the admin UI can
// render section structure for all three channels from day one without a
// future migration. Actual Email/Push wiring is Phase D scope.
//
// Branchy templates (e.g. warranty cash-call vs no-cash-call wording in
// ticket_rejected_closed) are split into multiple action_keys with a dotted
// sub-key (e.g. "ticket_rejected_closed.cash_call",
// "ticket_rejected_closed.no_cash_call") rather than embedding {{#if}}
// conditionals in the template body. Branch-selection logic stays in code
// per Tyler's design decision; admins edit each branch's text independently.
//
// Excluded from these tables: password-reset SMS (security-critical, lives
// in code with a NOT-IN-TEMPLATES marker comment).

// Channel discriminator for templates and audit rows. Email and Push are
// declared in the enum from the start so adding rows for those channels in
// Phase D is a pure data-migration, not a schema change.
export const communicationChannelEnum = pgEnum("communication_channel", ["sms", "email", "push"]);

// One row per (channel, action_key) combination. The "current" template the
// render layer reads at send time. UNIQUE(channel, action_key) prevents
// duplicate active templates for the same call site.
export const communicationTemplates = pgTable("communication_templates", {
  id: serial("id").primaryKey(),
  channel: communicationChannelEnum("channel").notNull(),
  actionKey: text("action_key").notNull(), // e.g. "submission_received.parts_nla"
  // SMS uses body only. Email uses subject+body. Push uses title+body.
  // All three nullable for cross-channel uniformity; render layer asserts
  // the right combination per channel.
  subject: text("subject"),
  title: text("title"),
  body: text("body").notNull(),
  // Variable contract: array of { name, required, sample } objects so the
  // admin UI can render the "available variables" panel and the preview
  // form can validate that all required vars are supplied.
  variables: jsonb("variables").notNull().default(sql`'[]'::jsonb`),
  // Provenance markers
  isDefault: boolean("is_default").notNull().default(true), // false once an admin has overridden
  isActive: boolean("is_active").notNull().default(true),    // soft-disable a template without deleting
  currentVersion: integer("current_version").notNull().default(1),
  updatedBy: integer("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
}, (table) => ({
  channelActionUnique: unique("communication_templates_channel_action_unique").on(table.channel, table.actionKey),
}));

export const insertCommunicationTemplateSchema = createInsertSchema(communicationTemplates).omit({
  id: true,
  updatedAt: true,
});
export type InsertCommunicationTemplate = z.infer<typeof insertCommunicationTemplateSchema>;
export type CommunicationTemplate = typeof communicationTemplates.$inferSelect;

// Full version history. Insert-only — every save snapshots the prior current
// row here so admins can answer "who changed what when, and why?" with the
// optional editReason field.
export const communicationTemplateVersions = pgTable("communication_template_versions", {
  id: serial("id").primaryKey(),
  // FK is declared in the table-extras callback below with an EXPLICIT name
  // because drizzle's auto-generated name
  // (`..._template_id_communication_templates_id_fk`) is 67 chars and exceeds
  // PostgreSQL's 63-char identifier limit. PG silently truncates, leaving the
  // dev DB constraint named `..._communication_templ` while drizzle-kit thinks
  // the name should be the full version — that drift generates a DROP+ADD on
  // every deploy, which the deploy validator (correctly) refuses to ship.
  // Pinning the name here aligns drizzle-kit's view with PG reality. The DB
  // structure (column type, FK relationship, ON DELETE CASCADE) is unchanged.
  templateId: integer("template_id").notNull(),
  version: integer("version").notNull(),
  subject: text("subject"),
  title: text("title"),
  body: text("body").notNull(),
  variables: jsonb("variables").notNull(),
  editedBy: integer("edited_by").references(() => users.id),
  editedAt: timestamp("edited_at").default(sql`now()`).notNull(),
  editReason: text("edit_reason"),
}, (table) => ({
  templateVersionUnique: unique("communication_template_versions_template_version_unique").on(table.templateId, table.version),
  templateIdFk: foreignKey({
    columns: [table.templateId],
    foreignColumns: [communicationTemplates.id],
    name: "communication_template_versions_template_id_communication_templ",
  }).onDelete("cascade"),
}));

export const insertCommunicationTemplateVersionSchema = createInsertSchema(communicationTemplateVersions).omit({
  id: true,
  editedAt: true,
});
export type InsertCommunicationTemplateVersion = z.infer<typeof insertCommunicationTemplateVersionSchema>;
export type CommunicationTemplateVersion = typeof communicationTemplateVersions.$inferSelect;

// Per-send audit. Every render call (preview OR live send) writes a row
// recording exactly which template_version produced the rendered copy. Lets
// us answer "what message went out on SO X at time Y?" forever.
//
// Existing sms_notifications table stays unchanged for backward compatibility
// — during the cutover, every templated send writes both rows (legacy +
// audit). Once the cutover is complete and verified, sms_notifications can
// be deprecated as a future cleanup; not in scope for Phase B/C.
export const communicationSendAudit = pgTable("communication_send_audit", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").references(() => submissions.id),
  channel: communicationChannelEnum("channel").notNull(),
  actionKey: text("action_key").notNull(),
  // Same situation as communication_template_versions — drizzle's intended
  // FK name (`..._template_id_communication_templates_id_fk`) is 66 chars,
  // PG truncated to `..._communication_templates_id`. Pinning the name here
  // to match the dev DB reality so drizzle-kit stops issuing a DROP+ADD on
  // every deploy. Default ON DELETE NO ACTION is unchanged (no .onDelete()).
  templateId: integer("template_id"),
  templateVersion: integer("template_version").notNull(),
  renderedBody: text("rendered_body").notNull(),
  renderedSubject: text("rendered_subject"),
  renderedTitle: text("rendered_title"),
  recipient: text("recipient").notNull(),
  sendStatus: text("send_status").notNull(), // 'preview' | 'sent' | 'failed'
  providerId: text("provider_id"),            // twilio_sid / sendgrid_msg_id / fcm_id
  sentAt: timestamp("sent_at").default(sql`now()`).notNull(),
}, (table) => ({
  templateIdFk: foreignKey({
    columns: [table.templateId],
    foreignColumns: [communicationTemplates.id],
    name: "communication_send_audit_template_id_communication_templates_id",
  }),
}));

export const insertCommunicationSendAuditSchema = createInsertSchema(communicationSendAudit).omit({
  id: true,
  sentAt: true,
});
export type InsertCommunicationSendAudit = z.infer<typeof insertCommunicationSendAuditSchema>;
export type CommunicationSendAudit = typeof communicationSendAudit.$inferSelect;

// ============================================================================
// AGENT EXTERNAL CREDENTIALS TABLE (encrypted creds for third-party tools)
// ============================================================================
// Stores per-agent encrypted credentials for external tools the agent uses
// from inside VRS (currently: Streamlit Repair/Replace Calculator at
// repairreplacecalculator.replit.app).
//
// Encryption: AES-256-GCM. Key derived from SESSION_SECRET via scrypt with the
// per-row scryptSalt. Server stores ONLY ciphertext + iv + authTag + scryptSalt.
// Cleartext is never logged or written to disk. See server/services/crypto.ts.
//
// On retrieval the server decrypts and returns the cleartext to the agent's
// browser over HTTPS for the brief moment of postMessage injection into the
// calculator iframe. The agent explicitly consents to this at credential-save
// time. usernameHint is stored in the clear so the UI can show "saved as <user>"
// without revealing the password.
export const agentExternalCredentials = pgTable(
  "agent_external_credentials",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    service: text("service").notNull(), // 'calculator'
    usernameHint: text("username_hint").notNull(), // cleartext username — used as UI label only
    usernameCipher: text("username_cipher").notNull(), // base64 ciphertext of username
    passwordCipher: text("password_cipher").notNull(), // base64 ciphertext of password
    iv: text("iv").notNull(), // base64 12-byte AES-GCM IV
    authTag: text("auth_tag").notNull(), // base64 16-byte AES-GCM auth tag
    scryptSalt: text("scrypt_salt").notNull(), // base64 16-byte per-row salt
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserService: unique().on(table.userId, table.service),
  })
);

export const insertAgentExternalCredentialSchema = createInsertSchema(
  agentExternalCredentials
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAgentExternalCredential = z.infer<
  typeof insertAgentExternalCredentialSchema
>;
export type AgentExternalCredential =
  typeof agentExternalCredentials.$inferSelect;

// ============================================================================
// VRS EXPRESS ↔ VRS AI AUTHORIZATION BRIDGE
// ============================================================================
// Tracks a SASHA/Tech Hub request from Express intake through human approval,
// outbound VRS AI dispatch, AI result application, and the callback forwarded
// back to SASHA. callback_secret is never stored in request_payload or in
// cleartext; the callbackSecret* columns contain AES-256-GCM material.
// Explicit DEV migration: scripts/bridge-photo-reliability-dev.sql (no startup DDL).
export const vrsBridgePhotoCaptures = pgTable("vrs_bridge_photo_captures", {
  submissionId: integer("submission_id").primaryKey().references(() => submissions.id, { onDelete: "cascade" }),
  intakeAt: timestamp("intake_at", { withTimezone: true }).notNull(),
  retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }).notNull(),
  state: text("state").notNull().default("pending"),
  expectedCount: integer("expected_count").notNull(),
  capturedCount: integer("captured_count").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  due: index("vrs_bridge_photo_captures_due_idx").on(table.nextAttemptAt)
    .where(sql`${table.state} IN ('pending','retry')`),
}));

export const vrsAiCalls = pgTable(
  "vrs_ai_calls",
  {
    id: serial("id").primaryKey(),
    submissionId: integer("submission_id").references(() => submissions.id, {
      onDelete: "cascade",
    }),
    callId: varchar("call_id", { length: 100 }).notNull(),
    providerCallId: varchar("provider_call_id", { length: 100 }),
    serviceOrder: varchar("service_order", { length: 20 }).notNull(),
    techId: varchar("tech_id", { length: 50 }).notNull(),
    techPhone: varchar("tech_phone", { length: 20 }).notNull(),
    techName: varchar("tech_name", { length: 255 }).notNull(),
    state: text("state").notNull().default("pending_review"),
    dispatchError: text("dispatch_error"),
    dispatchAttemptedAt: timestamp("dispatch_attempted_at"),
    dispatchedAt: timestamp("dispatched_at"),
    requestPayload: jsonb("request_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    callbackUrl: text("callback_url").notNull(),
    callbackSecretCipher: text("callback_secret_cipher").notNull(),
    callbackSecretIv: text("callback_secret_iv").notNull(),
    callbackSecretAuthTag: text("callback_secret_auth_tag").notNull(),
    callbackSecretSalt: text("callback_secret_salt").notNull(),
    ctaNo: varchar("cta_no", { length: 100 }),
    authNumber: varchar("auth_number", { length: 100 }),
    authorizedAmount: varchar("authorized_amount", { length: 30 }),
    requestedAmount: varchar("requested_amount", { length: 30 }),
    denyReason: text("deny_reason"),
    failureReason: varchar("failure_reason", { length: 100 }),
    retryable: boolean("retryable"),
    durationSec: integer("duration_sec"),
    recordingUrl: text("recording_url"),
    webhookEventId: varchar("webhook_event_id", { length: 100 }),
    webhookAttemptCount: integer("webhook_attempt_count")
      .notNull()
      .default(0),
    webhookLastStatus: integer("webhook_last_status"),
    webhookLastAttemptAt: timestamp("webhook_last_attempt_at"),
    webhookDeliveredAt: timestamp("webhook_delivered_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    callIdUnique: uniqueIndex("vrs_ai_calls_call_id_uidx").on(table.callId),
    submissionIdUnique: uniqueIndex("vrs_ai_calls_submission_id_uidx").on(
      table.submissionId,
    ),
    providerCallIdUnique: uniqueIndex(
      "vrs_ai_calls_provider_call_id_uidx",
    ).on(table.providerCallId),
    serviceOrderStateIdx: index("vrs_ai_calls_so_state_idx").on(
      table.serviceOrder,
      table.state,
    ),
    techCreatedIdx: index("vrs_ai_calls_tech_created_idx").on(
      table.techId,
      table.createdAt,
    ),
    stateCreatedIdx: index("vrs_ai_calls_state_created_idx").on(
      table.state,
      table.createdAt,
    ),
  }),
);

export const insertVrsAiCallSchema = createInsertSchema(vrsAiCalls).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertVrsAiCall = z.infer<typeof insertVrsAiCallSchema>;
export type VrsAiCall = typeof vrsAiCalls.$inferSelect;

// Event-level ledger. A single AI call can emit `requires_info` before a
// terminal outcome, so deduplication cannot safely live on one call-row
// event-id column. `appliedAt` and `forwardedAt` let webhook retries resume
// forwarding without repeating the existing ticket/SMS side effects.
export const vrsAiCallEvents = pgTable(
  "vrs_ai_call_events",
  {
    id: serial("id").primaryKey(),
    vrsAiCallId: integer("vrs_ai_call_id")
      .notNull()
      .references(() => vrsAiCalls.id, { onDelete: "cascade" }),
    eventId: varchar("event_id", { length: 100 }).notNull(),
    state: text("state").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    processingState: text("processing_state")
      .notNull()
      .default("processing"),
    appliedAt: timestamp("applied_at"),
    forwardedAt: timestamp("forwarded_at"),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    deliveryStatus: integer("delivery_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    eventIdUnique: uniqueIndex("vrs_ai_call_events_event_id_uidx").on(
      table.eventId,
    ),
    callCreatedIdx: index("vrs_ai_call_events_call_created_idx").on(
      table.vrsAiCallId,
      table.createdAt,
    ),
  }),
);

export const insertVrsAiCallEventSchema = createInsertSchema(
  vrsAiCallEvents,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertVrsAiCallEvent = z.infer<
  typeof insertVrsAiCallEventSchema
>;
export type VrsAiCallEvent = typeof vrsAiCallEvents.$inferSelect;

// Additive callback receipts. No existing table/column is changed. Startup
// creation is isolated and best effort; callback handlers fail closed if absent.
export const vrsAiDirectResults = pgTable("vrs_ai_direct_results", {
  id: serial("id").primaryKey(),
  eventId: varchar("event_id", {length:100}).notNull().unique("vrs_ai_direct_results_event_id_key"),
  callId: varchar("call_id", {length:100}).notNull().unique("vrs_ai_direct_results_call_id_key"),
  payloadHash: varchar("payload_hash", {length:64}).notNull(),
  payload: jsonb("payload").notNull(),
  submissionId: integer("submission_id"),
  processingState: text("processing_state").notNull().default("processing"),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", {withTimezone:true}),
  response: jsonb("response"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", {withTimezone:true}).notNull().defaultNow(),
});
export const vrsAiNotificationRetries = pgTable("vrs_ai_notification_retries", {
  id: serial("id").primaryKey(),
  notificationId: integer("notification_id").notNull().unique("vrs_ai_notification_retries_notification_id_key"),
  actorId: integer("actor_id").notNull(),
  state: text("state").notNull().default("processing"),
  result: jsonb("result"),
  createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", {withTimezone:true}).notNull().defaultNow(),
});

// ============================================================================
// TECHNICIAN USER VIEW (for admin Field Technicians tab)
// ============================================================================
export interface TechnicianUserView {
  id: number;
  name: string;
  racId: string | null;
  phone: string | null;
  district: string | null;
  techUnNo: string | null;
  managerName: string | null;
  role: string;
  totalTickets: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
}

export type ExecSummaryDelivery = typeof execSummaryDeliveries.$inferSelect;

export const execSummaryDeliveryAttempts = pgTable(
  "exec_summary_delivery_attempts",
  {
    id: serial("id").primaryKey(),
    deliveryId: integer("delivery_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    // A caller-supplied key makes a double-click/replayed HTTP request an
    // audit lookup rather than a second provider submission.
    requestKey: varchar("request_key", { length: 200 }).notNull(),
    state: varchar("state", { length: 24 }).notNull().default("sending"),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    providerStatus: integer("provider_status"),
    reason: text("reason"),
    retryable: boolean("retryable"),
    ambiguous: boolean("ambiguous").notNull().default(false),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    requestUnique: uniqueIndex("exec_summary_delivery_attempts_request_uidx").on(table.requestKey),
    deliveryAttemptUnique: unique("exec_summary_delivery_attempts_delivery_attempt_unique").on(table.deliveryId, table.attemptNumber),
    deliveryHistoryIdx: index("exec_summary_delivery_attempts_delivery_idx").on(table.deliveryId, table.attemptedAt.desc()),
    // Pin the short name; Drizzle's generated FK name exceeds PostgreSQL's
    // 63-character identifier limit and otherwise causes migration drift.
    deliveryFk: foreignKey({
      columns: [table.deliveryId],
      foreignColumns: [execSummaryDeliveries.id],
      name: "exec_summary_attempt_delivery_fk",
    }).onDelete("cascade"),
  }),
);

export type ExecSummaryDeliveryAttempt = typeof execSummaryDeliveryAttempts.$inferSelect;
