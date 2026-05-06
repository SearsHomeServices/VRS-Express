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
import { pgTable, serial, text, varchar, integer, timestamp, date, unique, boolean, jsonb, pgEnum, foreignKey } from "drizzle-orm/pg-core";
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
  role: text("role").notNull(), // 'technician', 'vrs_agent', 'admin', 'super_admin'
  phone: varchar("phone", { length: 20 }),
  racId: varchar("rac_id", { length: 50 }),
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
  canOrderParts: boolean("can_order_parts").notNull().default(false),
  notificationTone: varchar("notification_tone", { length: 50 }).notNull().default("chime"),
  notificationVolume: varchar("notification_volume", { length: 10 }).notNull().default("0.5"),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
});

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
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  agentNotes: text("agent_notes"),
  technicianMessage: text("technician_message"),
  rejectionReasons: text("rejection_reasons"),
  rejectedMedia: text("rejected_media"),
  reassignmentNotes: text("reassignment_notes"),
  appealNotes: text("appeal_notes"),
  resubmissionOf: integer("resubmission_of"),
  procId: varchar("proc_id", { length: 50 }),
  clientNm: varchar("client_nm", { length: 150 }),
  statusChangedAt: timestamp("status_changed_at").default(sql`now()`),
  createdAt: timestamp("created_at").default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
});

export const insertSubmissionSchema = createInsertSchema(submissions).omit({
  id: true,
  statusChangedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
export type Submission = typeof submissions.$inferSelect;

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
  body: text("body").notNull(),
  createdAt: timestamp("created_at").default(sql`now()`),
});

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
});

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
});

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
  totalTickets: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
}
