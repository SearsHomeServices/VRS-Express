import express, { type Express } from "express";
import { createServer, type Server } from "http";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { storage, db } from "./storage";
import { registerObjectStorageRoutes } from "./replit_integrations/object_storage";
import { authenticateToken, requireRole, type AuthenticatedRequest } from "./middleware/auth";
import type { User, Technician } from "@shared/schema";
import { deriveWarrantyFromProcId } from "@shared/warranty";
import { INTAKE_FORM_GO_LIVE_UTC } from "@shared/intake-form-config";
import * as fs from "fs";
import * as path from "path";
import { createWriteStream, createReadStream } from "fs";
import { unlink } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import { fetchTechniciansFromSnowflake, fetchProcIdForServiceOrder } from "./services/snowflake";
import { seedDatabase } from "./seed";
import {
  sendSms,
  sendSmsMessage,
  buildStage1RejectedMessage,
  buildStage1InvalidMessage,
  buildAuthCodeMessage,
  buildNlaApprovalMessage,
  buildRejectAndCloseMessage,
  buildSubmissionReceivedMessage,
  // Tyler 2026-04-29 (Communication Templates): inline SMS strings extracted
  // into named builders so admins can edit them through the new admin page.
  buildResubmissionClaimMessage,
  buildStandardClaimMessage,
  buildTwoStageClaimMessage,
  buildSubmissionApprovedMessage,
  buildNlaInvalidMessage,
  // Tyler 2026-04-29 (NLA second-stage): inline NLA-resolution SMS strings
  // extracted into named builders so admins can edit them through the
  // Communication Templates page like every other tech-facing message.
  buildNlaReplacementSubmittedMessage,
  buildNlaReplacementTechInitiatesMessage,
  buildNlaPartFoundVrsOrderedMessage,
  buildNlaPartFoundTechOrdersMessage,
  buildNlaRfrEligibleMessage,
  buildNlaPcardConfirmedGenericMessage,
  buildNlaRejectedMessage,
} from "./sms";
import { enhanceDescription, checkRateLimit } from "./services/openai";
import { queryServiceOrder, sendFollowup } from "./services/shsai";
import { ObjectStorageService } from "./replit_integrations/object_storage/objectStorage";
import { broadcastToDivisionAgents, broadcastToNlaDivisionAgents, broadcastToAdmins, broadcastToAgent, broadcastToTechnicians, updateClientStatus, updateClientDivisions, getWarrantyLabel, getDivisionLabel } from "./websocket";

const execFileAsync = promisify(execFile);

const JWT_SECRET = process.env.SESSION_SECRET!;

const registerSchema = z.object({
  email: z.string().email().optional().or(z.literal("")),
  password: z.string().min(6),
  name: z.string().min(1),
  role: z.enum(["technician", "vrs_agent", "admin", "super_admin"]),
  phone: z.string().optional(),
  racId: z.string().regex(/^[a-zA-Z]+[a-zA-Z0-9]*$/, "LDAP ID must be letters and numbers only (e.g., MTHOMA2)").optional().or(z.literal("")),
});

const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

function sanitizeUser(user: User): Omit<User, "password"> {
  const { password, ...sanitized } = user;
  return sanitized;
}

function signToken(user: User): string {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

const ALL_DIVISIONS = ["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other", "nla"];

async function broadcastVrsAvailability() {
  const onlineAgents = await storage.getOnlineAgentCount();
  const queuedTickets = await storage.getQueuedCountAll();
  broadcastToTechnicians({
    type: 'vrs_availability',
    payload: { onlineAgents, queuedTickets }
  });
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  await seedDatabase();

  registerObjectStorageRoutes(app);

  app.post("/api/auth/register", async (req, res) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }
      const { email, password, name, role, phone, racId } = parsed.data;

      if (role !== "technician") {
        return res.status(403).json({ error: "Only technician self-registration is allowed" });
      }

      if (racId) {
        const existingByRacId = await storage.getUserByRacId(racId);
        if (existingByRacId) {
          return res.status(409).json({ error: "LDAP ID already exists" });
        }
      }

      const hashedPassword = await bcryptjs.hash(password, 10);
      const user = await storage.createUser({
        email: email || null,
        password: hashedPassword,
        name,
        role,
        phone: phone || null,
        racId: racId || null,
      });

      return res.status(201).json({ user: sanitizeUser(user), token: signToken(user) });
    } catch (error) {
      console.error("Registration error:", error);
      return res.status(500).json({ error: "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }
      const { identifier, password } = parsed.data;

      let user = await storage.getUserByRacId(identifier);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const passwordMatch = await bcryptjs.compare(password, user.password);
      if (!passwordMatch) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      if (!user.isActive) {
        return res.status(403).json({ error: "Account is deactivated" });
      }

      return res.status(200).json({ user: sanitizeUser(user), token: signToken(user) });
    } catch (error) {
      console.error("Login error:", error);
      return res.status(500).json({ error: "Login failed" });
    }
  });

  // ========================================================================
  // FORGOT / RESET PASSWORD (PUBLIC - no auth required)
  // ========================================================================

  const forgotPasswordSchema = z.object({
    identifier: z.string().min(1),
  });

  app.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const parsed = forgotPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const genericMessage = "If your LDAP ID is on file and has a phone number, you will receive a reset code via SMS.";

      const user = await storage.getUserByRacId(parsed.data.identifier);
      if (!user || !user.phone) {
        return res.status(200).json({ message: genericMessage });
      }

      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const hashedCode = await bcryptjs.hash(code, 10);
      const expires = new Date(Date.now() + 15 * 60 * 1000);

      await storage.updateUser(user.id, {
        passwordResetToken: hashedCode,
        passwordResetExpires: expires,
      } as any);

      const smsBody = `VRS Password Reset - Your reset code is: ${code}. This code expires in 15 minutes.`;
      try {
        await sendSmsMessage(user.phone, smsBody);
      } catch (smsErr: any) {
        console.error("Forgot password SMS error:", smsErr.message);
      }

      return res.status(200).json({ message: genericMessage });
    } catch (error) {
      console.error("Forgot password error:", error);
      return res.status(500).json({ error: "An error occurred" });
    }
  });

  const resetPasswordSchema = z.object({
    identifier: z.string().min(1),
    code: z.string().min(1),
    newPassword: z.string().min(8).regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*]).{8,}$/,
      "Password must contain at least 8 characters, 1 uppercase, 1 lowercase, 1 number, and 1 special character (!@#$%^&*)"
    ),
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const user = await storage.getUserByRacId(parsed.data.identifier);
      if (!user) {
        return res.status(400).json({ error: "Invalid or expired reset code" });
      }

      if (!user.passwordResetToken || !user.passwordResetExpires) {
        return res.status(400).json({ error: "Invalid or expired reset code" });
      }

      if (new Date() > new Date(user.passwordResetExpires)) {
        return res.status(400).json({ error: "Invalid or expired reset code" });
      }

      const codeMatch = await bcryptjs.compare(parsed.data.code, user.passwordResetToken);
      if (!codeMatch) {
        return res.status(400).json({ error: "Invalid or expired reset code" });
      }

      const hashedPassword = await bcryptjs.hash(parsed.data.newPassword, 10);
      await storage.updateUser(user.id, {
        password: hashedPassword,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        passwordResetToken: null,
        passwordResetExpires: null,
      } as any);

      return res.status(200).json({ message: "Password updated successfully" });
    } catch (error) {
      console.error("Reset password error:", error);
      return res.status(500).json({ error: "An error occurred" });
    }
  });

  const changePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*]).{8,}$/,
      "Password must contain at least 8 characters, 1 uppercase, 1 lowercase, 1 number, and 1 special character (!@#$%^&*)"
    ),
  });

  app.post("/api/auth/change-password", authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const user = await storage.getUser(authReq.user.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const passwordMatch = await bcryptjs.compare(parsed.data.currentPassword, user.password);
      if (!passwordMatch) {
        return res.status(400).json({ error: "Current password is incorrect" });
      }

      const hashedPassword = await bcryptjs.hash(parsed.data.newPassword, 10);
      const updated = await storage.updateUser(user.id, {
        password: hashedPassword,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
      } as any);

      if (!updated) {
        return res.status(500).json({ error: "Failed to update password" });
      }

      return res.status(200).json({ user: sanitizeUser(updated) });
    } catch (error) {
      console.error("Change password error:", error);
      return res.status(500).json({ error: "Failed to change password" });
    }
  });

  const techLoginSchema = z.object({
    ldapId: z.string().min(1, "LDAP ID is required").regex(/^[a-z][a-z0-9]*$/i, "Invalid LDAP ID format"),
  });

  app.post("/api/auth/tech-login", async (req, res) => {
    try {
      const parsed = techLoginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const ldapId = parsed.data.ldapId.toLowerCase().trim();
      const technician = await storage.getTechnicianByLdapId(ldapId);

      if (!technician) {
        return res.status(404).json({ error: "ID not found. Please contact your manager." });
      }

      if (!technician.isActive) {
        return res.status(403).json({ error: "Account is inactive. Please contact your manager." });
      }

      const techUser = await storage.getOrCreateTechUser(
        technician.ldapId,
        technician.name || ldapId,
        technician.phone || ""
      );

      const token = jwt.sign(
        {
          id: techUser.id,
          email: techUser.email,
          name: technician.name || ldapId,
          role: "technician",
          ldapId: technician.ldapId,
          isTechnician: true,
        },
        JWT_SECRET,
        { expiresIn: "7d" }
      );

      const safeUser = {
        id: techUser.id,
        email: techUser.email,
        name: technician.name || ldapId,
        role: "technician" as const,
        phone: technician.phone,
        racId: technician.ldapId,
        isActive: technician.isActive,
        firstLogin: true,
        lastSeenVersion: null,
        lastRgcCodeEntry: null,
        createdAt: technician.createdAt,
        updatedAt: technician.updatedAt,
        district: technician.district,
        ldapId: technician.ldapId,
      };

      return res.status(200).json({ user: safeUser, token, technician });
    } catch (error) {
      console.error("Tech login error:", error);
      return res.status(500).json({ error: "Login failed" });
    }
  });

  app.get("/api/auth/me", authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user) {
        return res.status(401).json({ error: "No user found" });
      }

      if (authReq.user.isTechnician && authReq.user.ldapId) {
        const technician = await storage.getTechnicianByLdapId(authReq.user.ldapId);
        if (!technician || !technician.isActive) {
          return res.status(404).json({ error: "Technician not found or inactive" });
        }
        const safeUser = {
          id: authReq.user.id,
          email: null,
          name: technician.name || technician.ldapId,
          role: "technician",
          phone: technician.phone,
          racId: technician.ldapId,
          isActive: technician.isActive,
          firstLogin: true,
          lastSeenVersion: null,
          lastRgcCodeEntry: null,
          createdAt: technician.createdAt,
          updatedAt: technician.updatedAt,
          district: technician.district,
          ldapId: technician.ldapId,
        };
        return res.status(200).json({ user: safeUser });
      }

      const user = await storage.getUser(authReq.user.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      return res.status(200).json({ user: sanitizeUser(user) });
    } catch (error) {
      console.error("Get user error:", error);
      return res.status(500).json({ error: "Failed to get user" });
    }
  });

  app.patch("/api/tech/update-phone", authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user?.isTechnician || !authReq.user?.ldapId) {
        return res.status(403).json({ error: "Only technicians can update phone" });
      }
      const schema = z.object({ phone: z.string().min(7, "Valid phone number required") });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }
      return res.status(200).json({ phone: parsed.data.phone });
    } catch (error) {
      console.error("Tech update phone error:", error);
      return res.status(500).json({ error: "Failed to update phone" });
    }
  });

  const updateMeSchema = z.object({
    firstLogin: z.boolean().optional(),
    lastSeenVersion: z.string().optional(),
  });

  app.patch("/api/users/me", authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const parsed = updateMeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const updated = await storage.updateUser(authReq.user.id, parsed.data);
      if (!updated) {
        return res.status(404).json({ error: "User not found" });
      }

      return res.status(200).json({ user: sanitizeUser(updated) });
    } catch (error) {
      console.error("Update me error:", error);
      return res.status(500).json({ error: "Failed to update user" });
    }
  });

  // ========================================================================
  // AI ENHANCEMENT ROUTES
  // ========================================================================

  app.post("/api/ai/enhance-description", authenticateToken, requireRole("technician"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const schema = z.object({
        description: z.string().min(20, "Description must be at least 20 characters").max(2000),
        applianceType: z.string().min(1),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      if (!checkRateLimit(authReq.user!.id)) {
        return res.status(429).json({ error: "Rate limit exceeded. You can use AI enhancement 5 times per hour." });
      }

      const enhanced = await enhanceDescription(parsed.data.description, parsed.data.applianceType);
      return res.status(200).json({ enhanced, original: parsed.data.description });
    } catch (error: any) {
      console.error("AI enhance error:", error);
      return res.status(500).json({ error: "AI enhancement unavailable. You can still submit your original description." });
    }
  });

  // ========================================================================
  // SUBMISSION ROUTES
  // ========================================================================

  const createSubmissionSchema = z.object({
    serviceOrder: z.string().regex(/^\d{4}-\d{8}$/, "Service order must be in format DDDD-SSSSSSSS (e.g., 8175-12345678)"),
    applianceType: z.enum(["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other"]),
    requestType: z.enum(["authorization", "infestation_non_accessible", "parts_nla"]),
    warrantyType: z.enum(["sears_protect", "american_home_shield", "first_american"]).default("sears_protect"),
    warrantyProvider: z.string().optional(),
    issueDescription: z.string().min(1, "Issue description is required").max(2000, "Description must be 2000 characters or less"),
    originalDescription: z.string().optional(),
    aiEnhanced: z.boolean().optional(),
    estimateAmount: z.string().optional(),
    partNumbers: z.string().optional(),
    photos: z.string().optional(),
    // Tyler 2026-04-30: multi-video. Clients send `videoUrls` (array of
    // up to 3 object-storage paths). The legacy `videoUrl` single-string
    // field is kept for backward compatibility with any in-flight client
    // build that hasn't picked up the new payload shape yet. Storage
    // serializes whichever is provided into the existing `video_url`
    // varchar(500) column as a JSON string (or single string for legacy).
    // No DB schema change needed — same JSON-in-text pattern the `photos`
    // field already uses.
    videoUrls: z.array(z.string()).max(3).optional(),
    videoUrl: z.string().optional(),
    voiceNoteUrl: z.string().optional(),
    phone: z.string().min(1, "Phone number is required"),
    appealNotes: z.string().optional(),
    resubmissionOf: z.number().optional(),
  });

  app.post("/api/submissions", authenticateToken, requireRole("technician"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const parsed = createSubmissionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const user = await storage.getUser(authReq.user!.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // 2026-04-30 — Tyler request: server-side idempotency guard.
      // A tech reported receiving the "submission received" SMS twice. The
      // most likely root cause is a flaky-cell retry: client tap → POST in
      // flight → connection drops → client retries → second row created →
      // second SMS fired. The submit button disables while pending, but a
      // dropped response defeats that gate. Resolve idempotently rather
      // than 4xx: if this exact (tech, SO#) pair was just submitted within
      // 60s, return the existing row so the client sees "submitted" and
      // we don't fire a duplicate SMS or burn a resubmission slot.
      const recentDup = await storage.findRecentDuplicateSubmission(parsed.data.serviceOrder, user.id, 60);
      if (recentDup) {
        // createdAt is `Date | null` in the schema (defaulted server-side),
        // so guard for the null case before doing time math.
        const createdMs = recentDup.createdAt ? new Date(recentDup.createdAt).getTime() : Date.now();
        const ageSec = Math.round((Date.now() - createdMs) / 1000);
        console.warn(
          `[idempotency] POST /api/submissions: returning existing submission ${recentDup.id} ` +
          `for tech=${user.id} SO=${parsed.data.serviceOrder} (age=${ageSec}s). Suppressed duplicate insert + SMS.`
        );
        // Architect-flagged: the success path below returns `{ submission }`,
        // not the raw row, and the tech-submit / tech-resubmit clients
        // dereference `data.submission.id` / `.serviceOrder`. Match that
        // shape exactly so the idempotent-hit path doesn't crash the client.
        return res.status(200).json({ submission: recentDup });
      }

      // Tier 2 (2026-04-28 hotfix): identity-mismatch detection.
      // Logs only — no behavior change. If the JWT-bound user.id disagrees
      // with the users row resolved by JWT-bound ldapId, the request is
      // being made under a session that has been inherited across two
      // different techs somehow (mechanism still under investigation;
      // district-pool theory was ruled out by Tyler 2026-04-28). Tier 1
      // client-side defenses block the actual cross-user submission; this
      // log surfaces the underlying mechanism in prod logs.
      if (authReq.user?.ldapId) {
        try {
          const userByLdap = await storage.getTechUserByLdapId(authReq.user.ldapId);
          if (userByLdap && userByLdap.id !== authReq.user.id) {
            console.warn(
              `[identity-mismatch] POST /api/submissions: JWT id=${authReq.user.id} != users.id=${userByLdap.id} ` +
              `for ldapId=${authReq.user.ldapId}. Submission body SO=${parsed.data.serviceOrder}`,
            );
          }
        } catch (e) {
          console.warn(
            "[identity-mismatch] check failed:",
            e instanceof Error ? e.message : String(e),
          );
        }
      }

      if (parsed.data.requestType === "parts_nla") {
        if (!parsed.data.partNumbers) {
          return res.status(400).json({ error: "Part numbers are required for NLA Parts requests" });
        }
        try {
          const parts = JSON.parse(parsed.data.partNumbers);
          if (Array.isArray(parts)) {
            if (parts.length === 0 || parts.length > 10 || !parts.every((p: any) => typeof p === "string" && p.trim().length > 0)) {
              return res.status(400).json({ error: "Please provide 1-10 valid part numbers" });
            }
          } else if (parts && typeof parts === "object" && (parts.nla || parts.available)) {
            const nlaParts = Array.isArray(parts.nla) ? parts.nla : [];
            const availParts = Array.isArray(parts.available) ? parts.available : [];
            const totalParts = nlaParts.length + availParts.length;
            if (totalParts === 0) {
              return res.status(400).json({ error: "At least one part number is required" });
            }
            if (totalParts > 20) {
              return res.status(400).json({ error: "Maximum 20 total part numbers allowed" });
            }
            const allValid = [...nlaParts, ...availParts].every((p: any) => typeof p === "string" && p.trim().length > 0);
            if (!allValid) {
              return res.status(400).json({ error: "All part numbers must be non-empty strings" });
            }
          } else {
            return res.status(400).json({ error: "Invalid part numbers format" });
          }
        } catch {
          return res.status(400).json({ error: "Invalid part numbers format" });
        }
      }

      const isClosed = await storage.hasRejectedClosedForServiceOrder(parsed.data.serviceOrder);
      if (isClosed) {
        return res.status(400).json({ error: "This service order has been permanently closed and cannot accept new submissions. The repair was determined to not be covered under warranty. Please offer the customer a cash call estimate instead." });
      }

      if (!parsed.data.resubmissionOf) {
        const activeCheck = await storage.hasActiveSubmissionForServiceOrder(parsed.data.serviceOrder, user.id);
        if (activeCheck.exists) {
          const statusLabels: Record<string, string> = {
            queued: "in the queue waiting for an agent",
            pending: "currently being reviewed by an agent",
            completed: "already approved",
          };
          const statusMsg = statusLabels[activeCheck.status || ""] || "already active";
          return res.status(409).json({ error: `You already have a submission for SO# ${parsed.data.serviceOrder} that is ${statusMsg}. Duplicate submissions are not allowed.` });
        }
      }

      if (parsed.data.resubmissionOf) {
        const originalSub = await storage.getSubmission(parsed.data.resubmissionOf);
        if (!originalSub) {
          return res.status(400).json({ error: "Original submission not found" });
        }
        if (originalSub.technicianId !== user.id) {
          return res.status(403).json({ error: "You can only resubmit your own tickets" });
        }
        if (originalSub.serviceOrder !== parsed.data.serviceOrder) {
          return res.status(400).json({ error: "Service order must match the original submission" });
        }
        if (originalSub.ticketStatus === "invalid" || originalSub.stage1Status === "invalid") {
          return res.status(400).json({ error: "Invalid submissions cannot be resubmitted" });
        }
        if (originalSub.ticketStatus === "rejected_closed") {
          return res.status(400).json({ error: "This submission has been permanently closed and cannot be resubmitted. The repair was determined to not be covered under warranty." });
        }
        const MAX_RESUBMISSIONS = 3;
        let rootId = parsed.data.resubmissionOf;
        if (originalSub.resubmissionOf) {
          rootId = originalSub.resubmissionOf;
        }
        const chain = await storage.getResubmissionChain(rootId);
        const validResubmissions = chain.filter(s => s.ticketStatus !== "invalid" && s.stage1Status !== "invalid");
        if (validResubmissions.length >= MAX_RESUBMISSIONS) {
          return res.status(400).json({ error: `Maximum ${MAX_RESUBMISSIONS} resubmissions reached. Please call VRS directly for assistance.` });
        }
      }

      let originalAgent: number | null = null;
      if (parsed.data.resubmissionOf) {
        const origSub = await storage.getSubmission(parsed.data.resubmissionOf);
        if (origSub) {
          originalAgent = origSub.reviewedBy || origSub.stage1ReviewedBy || null;
          if (originalAgent) {
            const agentUser = await storage.getUser(originalAgent);
            if (!agentUser || agentUser.role === "technician" || !agentUser.isActive) {
              originalAgent = null;
            } else if (agentUser.agentStatus === "offline") {
              console.log(`[resubmission] Original agent ${agentUser.ldapId} (id=${originalAgent}) is offline — routing to queue instead`);
              originalAgent = null;
            }
          }
        }
      }


      const procIdResult = await fetchProcIdForServiceOrder(parsed.data.serviceOrder);

      const derivedWarranty = deriveWarrantyFromProcId(procIdResult.procId, procIdResult.clientNm);
      const finalWarrantyType = derivedWarranty ? derivedWarranty.warrantyType : parsed.data.warrantyType;
      const finalWarrantyProvider = derivedWarranty ? derivedWarranty.warrantyProvider : (parsed.data.warrantyProvider || null);
      if (derivedWarranty && derivedWarranty.warrantyType !== parsed.data.warrantyType) {
        console.log(`[warranty-derive] SO ${parsed.data.serviceOrder}: tech selected ${parsed.data.warrantyType}, derived ${derivedWarranty.warrantyType} from ${derivedWarranty.source} (procId=${procIdResult.procId}, clientNm=${procIdResult.clientNm})`);
      }

      // Architect-flagged race-window close. The pre-handler call to
      // `findRecentDuplicateSubmission` (above, line ~543) catches the common
      // sequential-retry case fast and avoids the procId fetch for known
      // dupes. This atomic insert serializes concurrent (tech, SO#) requests
      // on a transaction-scoped advisory lock and re-checks for a recent
      // duplicate inside the lock — closing the small remaining window where
      // two near-simultaneous requests both pass the pre-check before either
      // commits. On race-hit, returns the existing row; we then short-circuit
      // SMS / broadcast / Smartsheet so the duplicate-text incident cannot
      // recur from concurrency either.
      const idempResult = await storage.createSubmissionWithIdempotency({
        technicianId: user.id,
        racId: user.racId || "",
        technicianLdapId: authReq.user?.ldapId || null,
        phoneOverride: req.body.phoneOverride || null,
        phone: parsed.data.phone,
        serviceOrder: parsed.data.serviceOrder,
        districtCode: parsed.data.serviceOrder.split("-")[0],
        applianceType: parsed.data.applianceType,
        requestType: parsed.data.requestType,
        warrantyType: finalWarrantyType,
        warrantyProvider: finalWarrantyProvider,
        issueDescription: parsed.data.issueDescription,
        originalDescription: (parsed.data.aiEnhanced && parsed.data.originalDescription) ? parsed.data.originalDescription : null,
        aiEnhanced: (parsed.data.aiEnhanced && parsed.data.originalDescription) ? true : false,
        estimateAmount: parsed.data.estimateAmount || null,
        partNumbers: parsed.data.partNumbers || null,
        photos: parsed.data.photos || null,
        // Tyler 2026-04-30: multi-video serialization. If the client sent
        // `videoUrls` AT ALL (even empty), it is authoritative — empty
        // array → null (not "[]") so existing "no video" reads stay
        // byte-identical to historical rows. Only when `videoUrls` is
        // truly absent (legacy clients) do we fall back to the single
        // `videoUrl` string. This avoids a footgun where a client
        // explicitly clears videos via `videoUrls: []` but still has a
        // stale `videoUrl` field set in the same payload.
        videoUrl: (() => {
          const arr = parsed.data.videoUrls;
          if (Array.isArray(arr)) {
            const cleaned = arr.filter((u) => typeof u === "string" && u.trim().length > 0);
            if (cleaned.length === 0) return null;
            const encoded = JSON.stringify(cleaned);
            // varchar(500) defensive guard. Under current object-storage
            // path format (~80 chars each) 3 URLs land near ~260 chars
            // including JSON overhead, but if the storage layer ever
            // returns full signed URLs this protects us from a DB error.
            if (encoded.length > 500) {
              throw new Error("Combined video URLs exceed storage limit (500 chars).");
            }
            return encoded;
          }
          const legacy = parsed.data.videoUrl || null;
          if (legacy && legacy.length > 500) {
            throw new Error("Video URL exceeds storage limit (500 chars).");
          }
          return legacy;
        })(),
        voiceNoteUrl: parsed.data.voiceNoteUrl || null,
        assignedTo: originalAgent,
        claimedAt: originalAgent ? new Date() : null,
        ticketStatus: originalAgent ? "pending" : "queued",
        statusChangedAt: new Date(),
        stage1Status: "pending",
        stage2Status: "pending",
        stage1ReviewedBy: null,
        stage1ReviewedAt: null,
        stage1RejectionReason: null,
        stage2ReviewedBy: null,
        stage2ReviewedAt: null,
        authCode: null,
        rgcCode: null,
        appealNotes: parsed.data.appealNotes || null,
        resubmissionOf: parsed.data.resubmissionOf || null,
        procId: procIdResult.procId,
        clientNm: procIdResult.clientNm,
      }, 60);
      const submission = idempResult.submission;
      if (idempResult.wasDuplicate) {
        console.warn(
          `[idempotency-tx] Race detected — returning existing submission ${submission.id} ` +
          `for tech=${user.id} SO=${parsed.data.serviceOrder}. Skipping SMS / broadcast / Smartsheet.`
        );
        return res.status(200).json({ submission });
      }

      const submissionReceivedPhone = submission.phoneOverride || submission.phone;
      if (submissionReceivedPhone) {
        const body = await buildSubmissionReceivedMessage(
          submission.serviceOrder,
          submission.warrantyType,
          submission.requestType,
        );
        sendSms(submission.id, submissionReceivedPhone, "submission_received", body).catch((err) => {
          console.error("[SMS] submission_received failed:", err);
        });
      }

      if (originalAgent) {
        broadcastToAgent(originalAgent, {
          type: "resubmission_received",
          payload: {
            submissionId: submission.id,
            serviceOrder: submission.serviceOrder,
            applianceType: parsed.data.applianceType,
            applianceLabel: getDivisionLabel(parsed.data.applianceType),
            warrantyLabel: getWarrantyLabel(parsed.data.warrantyType),
            message: "A technician has resubmitted a ticket you previously reviewed.",
          },
        });

        const resubmitClaimMsg = await buildResubmissionClaimMessage(submission.serviceOrder);
        const resubmitSmsPhone = submission.phoneOverride || submission.phone;
        sendSms(submission.id, resubmitSmsPhone, "ticket_claimed", resubmitClaimMsg).catch(err => {
          console.error("Failed to send resubmission claim SMS:", err);
        });
      } else {
        if (parsed.data.requestType === "parts_nla") {
          broadcastToNlaDivisionAgents(parsed.data.applianceType, {
            type: "new_ticket",
            payload: {
              submissionId: submission.id,
              serviceOrder: submission.serviceOrder,
              applianceType: parsed.data.applianceType,
              applianceLabel: getDivisionLabel(parsed.data.applianceType),
              warrantyLabel: getWarrantyLabel(parsed.data.warrantyType),
              requestType: parsed.data.requestType,
            },
          });
        } else {
          broadcastToDivisionAgents(parsed.data.applianceType, {
            type: "new_ticket",
            payload: {
              submissionId: submission.id,
              serviceOrder: submission.serviceOrder,
              applianceType: parsed.data.applianceType,
              applianceLabel: getDivisionLabel(parsed.data.applianceType),
              warrantyLabel: getWarrantyLabel(parsed.data.warrantyType),
              requestType: parsed.data.requestType,
            },
          });
        }
      }

      await broadcastVrsAvailability();

      return res.status(201).json({ submission });
    } catch (error) {
      console.error("Create submission error:", error);
      return res.status(500).json({ error: "Failed to create submission" });
    }
  });

  app.get("/api/submissions", authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const user = authReq.user!;

      let filters: {
        technicianId?: number;
        ticketStatus?: string;
        stage1Status?: string;
        stage2Status?: string;
        assignedTo?: number;
        applianceType?: string;
        requestType?: string;
        excludeRequestType?: string;
        divisionFilter?: string[];
      } = {};

      if (user.role === "technician") {
        filters.technicianId = user.id;
      } else if (user.role === "vrs_agent") {
        const isCompletedToday = req.query.completedToday === "true";
        const ticketStatusFilter = req.query.ticketStatus as string | undefined;

        if (ticketStatusFilter === "queued" && !isCompletedToday) {
          const specs = await storage.getSpecializations(user.id);
          const divisions = specs.map(s => s.division);
          if (divisions.length === 0) {
            return res.status(200).json({ submissions: [] });
          }
          const isGeneralist = divisions.length >= ALL_DIVISIONS.length;
          if (!isGeneralist) {
            filters.divisionFilter = divisions;
          }
        } else if (ticketStatusFilter === "pending") {
          filters.assignedTo = user.id;
        } else if (isCompletedToday) {
          filters.assignedTo = user.id;
        } else {
          filters.assignedTo = user.id;
        }
      }

      if (req.query.ticketStatus) {
        filters.ticketStatus = req.query.ticketStatus as string;
      }
      if (req.query.stage1Status) {
        filters.stage1Status = req.query.stage1Status as string;
      }
      if (req.query.stage2Status) {
        filters.stage2Status = req.query.stage2Status as string;
      }
      if (req.query.applianceType) {
        filters.applianceType = req.query.applianceType as string;
      }
      if (req.query.requestType) {
        filters.requestType = req.query.requestType as string;
      }
      if (req.query.excludeRequestType) {
        filters.excludeRequestType = req.query.excludeRequestType as string;
      }

      const completedToday = req.query.completedToday === "true";

      if (user.role === "vrs_agent" || user.role === "admin" || user.role === "super_admin") {
        let result = await storage.getSubmissionsWithTechnician(filters, completedToday);

        const search = req.query.search as string | undefined;
        if (search && result.length > 0) {
          const searchTerm = search.toLowerCase();
          result = result.filter(sub => 
            sub.serviceOrder.toLowerCase().includes(searchTerm) ||
            sub.serviceOrder.replace(/^(\d{4})-/, '').includes(searchTerm) ||
            sub.racId.toLowerCase().includes(searchTerm)
          );
        }

        return res.status(200).json({ submissions: result });
      }

      let techResult = await storage.getSubmissions(filters);

      const techSearch = req.query.search as string | undefined;
      if (techSearch && techResult.length > 0) {
        const searchTerm = techSearch.toLowerCase();
        techResult = techResult.filter(sub => 
          sub.serviceOrder.toLowerCase().includes(searchTerm) ||
          sub.serviceOrder.replace(/^(\d{4})-/, '').includes(searchTerm) ||
          sub.serviceOrder.toLowerCase().includes(searchTerm)
        );
      }

      return res.status(200).json({ submissions: techResult });
    } catch (error) {
      console.error("Get submissions error:", error);
      return res.status(500).json({ error: "Failed to get submissions" });
    }
  });

  app.get("/api/submissions/:id", authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid submission ID" });
      }

      const submission = await storage.getSubmission(id);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const user = authReq.user!;
      if (user.role === "technician" && submission.technicianId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (user.role === "vrs_agent") {
        const isAssignedToAgent = submission.assignedTo === user.id;
        const isQueued = submission.ticketStatus === "queued";
        if (!isAssignedToAgent && !isQueued) {
          return res.status(403).json({ error: "Access denied" });
        }
        if (isQueued) {
          const specs = await storage.getSpecializations(user.id);
          const divisions = specs.map(s => s.division);
          const isGeneralist = divisions.length >= ALL_DIVISIONS.length;
          const isNlaTicket = submission.requestType === "parts_nla";
          if (!isGeneralist && !(isNlaTicket ? divisions.includes("nla") : divisions.includes(submission.applianceType))) {
            return res.status(403).json({ error: "Access denied" });
          }
        }
      }

      return res.status(200).json({ submission });
    } catch (error) {
      console.error("Get submission error:", error);
      return res.status(500).json({ error: "Failed to get submission" });
    }
  });

  // ========================================================================
  // SUBMISSION HISTORY (for message thread view)
  // ========================================================================

  app.get("/api/submissions/:id/history", authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid submission ID" });
      }

      const submission = await storage.getSubmission(id);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const user = authReq.user!;
      if (user.role === "technician" && submission.technicianId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      const allRelated = await storage.getSubmissionHistory(submission.serviceOrder);
      const rootId = submission.resubmissionOf || submission.id;
      const chain = allRelated.filter(s => s.id === rootId || s.resubmissionOf === rootId);
      chain.sort((a, b) => new Date(a.createdAt!).getTime() - new Date(b.createdAt!).getTime());

      const reviewerIds = new Set<number>();
      chain.forEach(s => {
        if (s.stage1ReviewedBy) reviewerIds.add(s.stage1ReviewedBy);
        if (s.stage2ReviewedBy) reviewerIds.add(s.stage2ReviewedBy);
      });

      const reviewerNames: Record<number, string> = {};
      for (const rid of reviewerIds) {
        const u = await storage.getUser(rid);
        if (u) reviewerNames[rid] = u.name;
      }

      const techUser = await storage.getUser(submission.technicianId);
      const techName = techUser?.name || "Technician";

      const resubmissionCount = chain.filter(s => s.resubmissionOf != null && s.stage1Status !== "invalid").length;
      const maxResubmissions = 3;

      return res.status(200).json({
        history: chain,
        reviewerNames,
        technicianName: techName,
        resubmissionCount,
        maxResubmissions,
      });
    } catch (error) {
      console.error("Submission history error:", error);
      return res.status(500).json({ error: "Failed to get submission history" });
    }
  });

  // ========================================================================
  // SUBMISSION NOTES — post-submission follow-up notes
  // ========================================================================

  app.post(
    "/api/submissions/:id/notes",
    authenticateToken,
    async (req, res) => {
      try {
        const id = parseInt(req.params.id as string);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid submission ID" });
        const sub = await storage.getSubmission(id);
        if (!sub) return res.status(404).json({ error: "Submission not found" });

        const user = (req as any).user;
        if (user.role === "technician" && sub.technicianId !== user.id) {
          return res.status(403).json({ error: "Not your submission" });
        }

        const noteSchema = z.object({
          body: z.string().min(1, "Note cannot be empty").max(2000, "Note must be 2000 characters or less"),
        });
        const parsed = noteSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid note", details: parsed.error.flatten() });
        }

        const note = await storage.createSubmissionNote({
          submissionId: id,
          authorId: user.id,
          authorRole: user.role,
          body: parsed.data.body,
        });
        return res.status(201).json({ note });
      } catch (error) {
        console.error("Create submission note error:", error);
        return res.status(500).json({ error: "Failed to add note" });
      }
    }
  );

  app.get(
    "/api/submissions/:id/notes",
    authenticateToken,
    async (req, res) => {
      try {
        const id = parseInt(req.params.id as string);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid submission ID" });
        const sub = await storage.getSubmission(id);
        if (!sub) return res.status(404).json({ error: "Submission not found" });
        const user = (req as any).user;
        if (user.role === "technician" && sub.technicianId !== user.id) {
          return res.status(403).json({ error: "Access denied" });
        }
        const notes = await storage.getSubmissionNotes(id);
        return res.status(200).json({ notes });
      } catch (error) {
        console.error("Get submission notes error:", error);
        return res.status(500).json({ error: "Failed to get notes" });
      }
    }
  );

  // ========================================================================
  // ADMIN AUDIT TRAIL — Full timeline for a submission
  // ========================================================================

  app.get("/api/admin/submissions/:id/audit", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid submission ID" });

      const submission = await storage.getSubmission(id);
      if (!submission) return res.status(404).json({ error: "Submission not found" });

      const smsLogs = await storage.getSmsNotifications(id);

      const userIds = new Set<number>();
      if (submission.technicianId) userIds.add(submission.technicianId);
      if (submission.assignedTo) userIds.add(submission.assignedTo);
      if (submission.reviewedBy) userIds.add(submission.reviewedBy);
      if (submission.stage1ReviewedBy) userIds.add(submission.stage1ReviewedBy);
      if (submission.stage2ReviewedBy) userIds.add(submission.stage2ReviewedBy);

      const userNames: Record<number, string> = {};
      for (const uid of userIds) {
        const u = await storage.getUser(uid);
        if (u) userNames[uid] = u.name;
      }

      function safeIso(val: any): string {
        if (!val) return new Date().toISOString();
        try {
          const d = val instanceof Date ? val : new Date(val);
          if (isNaN(d.getTime())) return new Date().toISOString();
          return d.toISOString();
        } catch { return new Date().toISOString(); }
      }

      const timeline: { timestamp: string; event: string; actor: string; detail?: string }[] = [];

      timeline.push({
        timestamp: safeIso(submission.createdAt),
        event: "Submitted",
        actor: userNames[submission.technicianId] || "Technician",
        detail: `SO# ${submission.serviceOrder} — ${submission.applianceType}`,
      });

      const claimSms = smsLogs.find(s => s.messageType === "ticket_claimed");
      if (claimSms) {
        const claimAgent = submission.assignedTo
          ? userNames[submission.assignedTo]
          : (submission.reviewedBy ? userNames[submission.reviewedBy] : null)
            || (submission.stage1ReviewedBy ? userNames[submission.stage1ReviewedBy] : null);
        timeline.push({
          timestamp: safeIso(claimSms.sentAt),
          event: "Claimed by Agent",
          actor: claimAgent || "Agent",
        });
      }

      if (submission.reassignmentNotes) {
        const reassignAgent = submission.assignedTo ? userNames[submission.assignedTo] : null;
        timeline.push({
          timestamp: safeIso(submission.updatedAt),
          event: "Reassigned",
          actor: "Admin",
          detail: `${submission.reassignmentNotes}${reassignAgent ? ` → ${reassignAgent}` : ""}`,
        });
      }

      if (submission.submissionApproved && submission.submissionApprovedAt) {
        timeline.push({
          timestamp: safeIso(submission.submissionApprovedAt),
          event: "Submission Approved",
          actor: userNames[submission.stage1ReviewedBy!] || userNames[submission.reviewedBy!] || "Agent",
          detail: "Submission reviewed and approved; pending authorization code",
        });
      }

      if (submission.ticketStatus === "completed" && submission.reviewedAt) {
        timeline.push({
          timestamp: safeIso(submission.reviewedAt),
          event: "Approved & Auth Code Issued",
          actor: userNames[submission.reviewedBy!] || userNames[submission.stage2ReviewedBy!] || "Agent",
          detail: submission.authCode ? `Auth Code: ${submission.authCode}` : undefined,
        });
      }

      if (submission.ticketStatus === "rejected" && submission.reviewedAt) {
        timeline.push({
          timestamp: safeIso(submission.reviewedAt),
          event: "Rejected",
          actor: userNames[submission.reviewedBy!] || userNames[submission.stage1ReviewedBy!] || "Agent",
          detail: submission.stage1RejectionReason || undefined,
        });
      }

      if (submission.ticketStatus === "rejected_closed" && submission.reviewedAt) {
        timeline.push({
          timestamp: safeIso(submission.reviewedAt),
          event: "Rejected & Closed",
          actor: userNames[submission.reviewedBy!] || userNames[submission.stage1ReviewedBy!] || "Agent",
          detail: submission.stage1RejectionReason || "Not covered under warranty",
        });
      }

      if (submission.ticketStatus === "invalid" && submission.reviewedAt) {
        timeline.push({
          timestamp: safeIso(submission.reviewedAt),
          event: "Marked Invalid",
          actor: userNames[submission.reviewedBy!] || userNames[submission.stage1ReviewedBy!] || "Agent",
          detail: submission.invalidReason || undefined,
        });
      }

      if (submission.statusChangedAt && submission.statusChangedAt !== submission.createdAt) {
        timeline.push({
          timestamp: safeIso(submission.statusChangedAt),
          event: `Status → ${submission.ticketStatus === "completed" ? "Approved" : submission.ticketStatus === "rejected" ? "Rejected" : submission.ticketStatus === "rejected_closed" ? "Closed" : submission.ticketStatus === "invalid" ? "Invalid" : submission.ticketStatus === "pending" ? "Pending" : submission.ticketStatus}`,
          actor: "System",
        });
      }

      smsLogs.forEach(sms => {
        const typeLabels: Record<string, string> = {
          ticket_claimed: "Claim SMS Sent",
          submission_approved: "Approval SMS Sent",
          ticket_approved: "Auth Code SMS Sent",
          ticket_rejected: "Rejection SMS Sent",
          ticket_rejected_closed: "Reject & Close SMS Sent",
          ticket_invalid: "Invalid SMS Sent",
          auth_code_sent: "Auth Code SMS Sent",
        };
        timeline.push({
          timestamp: safeIso(sms.sentAt),
          event: typeLabels[sms.messageType] || `SMS: ${sms.messageType}`,
          actor: "System",
          detail: `To: ${sms.recipientPhone}`,
        });
      });

      timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      const deduped = timeline.filter((entry, i, arr) => {
        if (i === 0) return true;
        return !(entry.event === arr[i - 1].event && entry.timestamp === arr[i - 1].timestamp);
      });

      return res.status(200).json({
        submission,
        timeline: deduped,
        userNames,
        smsLogs,
      });
    } catch (error) {
      console.error("Admin audit trail error:", error);
      return res.status(500).json({ error: "Failed to get audit trail" });
    }
  });

  // ========================================================================
  // TICKET CLAIM ROUTE — Agent claims a queued ticket
  // ========================================================================

  app.patch("/api/submissions/:id/claim", authenticateToken, requireRole("vrs_agent", "admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid submission ID" });
      }

      const submission = await storage.getSubmission(id);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      if (submission.ticketStatus !== "queued") {
        return res.status(400).json({ error: "Ticket is no longer available — it may have been claimed by another agent" });
      }

      // -----------------------------------------------------------------
      // 24h intake-form claim gate REMOVED 2026-04-26 (Tyler D2). The
      // intake_forms audit row is still written when the agent confirms
      // the modal post-Authorize, but agents are NEVER blocked from
      // claiming a new ticket. See ADR-013. The atomic UPDATE-WHERE
      // pattern below still provides race protection between concurrent
      // agents for the same row — only the gate logic was stripped.
      // -----------------------------------------------------------------

      if (authReq.user!.role === "vrs_agent") {
        const specs = await storage.getSpecializations(authReq.user!.id);
        const divisions = specs.map(s => s.division);
        
        const isGeneralist = divisions.length >= ALL_DIVISIONS.length;
        const isNlaTicket = submission.requestType === "parts_nla";
        if (isNlaTicket) {
          if (!divisions.includes("nla")) {
            return res.status(403).json({ error: "You don't have the NLA specialization for this ticket" });
          }
          const agentApplianceDivisions = divisions.filter(d => d !== "nla" && d !== "generalist");
          const isApplianceGeneralist = agentApplianceDivisions.length >= ALL_DIVISIONS.filter(d => d !== "nla").length;
          if (!isApplianceGeneralist && !agentApplianceDivisions.includes(submission.applianceType)) {
            return res.status(403).json({ error: `You don't have the ${submission.applianceType} division to handle this NLA ticket` });
          }
        } else if (!isGeneralist && !divisions.includes(submission.applianceType)) {
          return res.status(403).json({ error: "You don't have the division specialization for this ticket" });
        }
      }

      if (submission.nlaEscalatedBy) {
        const claimingUser = await storage.getUser(authReq.user!.id);
        if (!claimingUser?.canOrderParts) {
          return res.status(403).json({ error: "This ticket requires a P-card holder. It has been pre-researched and is ready for parts ordering." });
        }
      }

      // Atomic claim — succeeds only if the row is still 'queued' at update
      // time, so two concurrent agents racing for the same row both go through
      // the auth checks but only one wins the UPDATE.
      const updated = await storage.claimSubmission(id, authReq.user!.id);
      if (!updated) {
        return res.status(409).json({
          error: "Ticket was just claimed by another agent — refresh the queue",
          code: "ALREADY_CLAIMED",
        });
      }

      if (authReq.user!.role === "vrs_agent" && authReq.user!.agentStatus !== "working") {
        await storage.updateUser(authReq.user!.id, { agentStatus: "working", updatedAt: new Date() } as any);
        updateClientStatus(authReq.user!.id, "working");
        broadcastToAdmins({
          type: "agent_status_changed",
          payload: { userId: authReq.user!.id, name: authReq.user!.name, status: "working" },
        });
        broadcastToAgent(authReq.user!.id, {
          type: "own_status_changed",
          payload: { status: "working" },
        });
      }

      if (submission.requestType === "parts_nla") {
        broadcastToNlaDivisionAgents(submission.applianceType, {
          type: "ticket_claimed",
          payload: { submissionId: id, serviceOrder: submission.serviceOrder },
        }, authReq.user!.id);
      } else {
        broadcastToDivisionAgents(submission.applianceType, {
          type: "ticket_claimed",
          payload: { submissionId: id, serviceOrder: submission.serviceOrder },
        }, authReq.user!.id);
      }

      const warrantyCompany = (submission.warrantyProvider || submission.warrantyType || "").toLowerCase();
      const isTwoStage = ["american home shield", "ahs", "first american"].some(w => warrantyCompany.includes(w));
      const isNla = submission.requestType === "parts_nla";

      // 2026-04-28 (Tyler pilot-feedback Task A, stopgap):
      // Suppress the "stand by / DO NOT LEAVE THE SITE" claim SMS for NLA
      // tickets entirely. The new submission-received SMS already tells
      // the NLA tech to reschedule the call and move on; sending a second
      // SMS minutes later that says "stand by, do not leave" actively
      // contradicts that guidance and was a source of the pilot
      // confusion. NLA techs receive the sourcing-decision SMS later
      // (buildNlaApprovalMessage) when the parts team has an answer; no
      // intermediate claim notification adds value for the NLA flow.
      // Two-stage and standard claim SMS unchanged.
      if (!isNla) {
        const claimSmsMessage = isTwoStage
          ? await buildTwoStageClaimMessage(submission.serviceOrder)
          : await buildStandardClaimMessage(submission.serviceOrder);

        const claimSmsPhone = submission.phoneOverride || submission.phone;
        sendSms(submission.id, claimSmsPhone, "ticket_claimed", claimSmsMessage).catch(err => {
          console.error("Failed to send claim SMS:", err);
        });
      }

      return res.status(200).json({ submission: updated });
    } catch (error) {
      console.error("Claim ticket error:", error);
      return res.status(500).json({ error: "Failed to claim ticket" });
    }
  });

  // ========================================================================
  // UNIFIED TICKET PROCESS ROUTE — Approve / Reject / Invalid
  // ========================================================================

  const processActionSchema = z.object({
    action: z.enum(["approve", "reject", "reject_and_close", "invalid", "approve_submission"]),
    rejectionReasons: z.array(z.string()).optional(),
    rejectedMedia: z.object({
      photos: z.array(z.object({ url: z.string(), reason: z.string() })).optional(),
      video: z.object({ rejected: z.boolean(), reason: z.string().optional() }).optional(),
      voiceNote: z.object({ rejected: z.boolean(), reason: z.string().optional() }).optional(),
    }).optional(),
    agentNotes: z.string().optional(),
    technicianMessage: z.string().optional(),
    authCode: z.string().optional(),
    invalidReason: z.string().optional(),
    invalidInstructions: z.string().optional(),
  });

  app.patch("/api/submissions/:id/process", authenticateToken, requireRole("vrs_agent", "admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid submission ID" });
      }

      const parsed = processActionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const submission = await storage.getSubmission(id);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      if (submission.ticketStatus !== "pending") {
        return res.status(400).json({ error: "Ticket must be in pending status to process" });
      }

      if (submission.assignedTo !== authReq.user!.id && authReq.user!.role !== "admin" && authReq.user!.role !== "super_admin") {
        return res.status(403).json({ error: "This ticket is not assigned to you" });
      }

      const { action, rejectionReasons, rejectedMedia, agentNotes, technicianMessage, invalidReason, invalidInstructions } = parsed.data;
      let { authCode } = parsed.data;

      if (submission.submissionApproved && (action === "reject" || action === "reject_and_close" || action === "invalid" || action === "approve_submission")) {
        return res.status(400).json({ error: "Submission has already been approved. Only authorization (approve) is allowed at this stage." });
      }

      if (action === "invalid" && !invalidReason) {
        return res.status(400).json({ error: "Invalid reason is required" });
      }

      const updateData: Record<string, unknown> = {
        reviewedBy: authReq.user!.id,
        reviewedAt: new Date(),
        agentNotes: agentNotes || null,
        updatedAt: new Date(),
      };

      let smsMessage: string;
      let smsType: string;

      if (action === "approve_submission") {
        updateData.submissionApproved = true;
        updateData.submissionApprovedAt = new Date();
        updateData.stage1Status = "approved";
        updateData.stage1ReviewedBy = authReq.user!.id;
        updateData.stage1ReviewedAt = new Date();
        updateData.technicianMessage = technicianMessage || null;

        smsMessage = await buildSubmissionApprovedMessage(submission.serviceOrder, technicianMessage);
        smsType = "submission_approved";

        const updated = await storage.updateSubmission(id, updateData as any);
        const approveSmsPhone = submission.phoneOverride || submission.phone;
        await sendSms(submission.id, approveSmsPhone, smsType, smsMessage);

        return res.status(200).json({ submission: updated });
      }

      if (action === "approve") {
        const needsRgcCode = submission.requestType === "authorization" || submission.requestType === "parts_nla";
        let rgcCode: string | null = null;

        if (needsRgcCode) {
          const todayStr = new Date().toISOString().slice(0, 10);
          const todayRgcCode = await storage.getDailyRgcCode(todayStr);
          if (!todayRgcCode) {
            return res.status(400).json({ error: "No RGC code has been set for today. Please contact an administrator." });
          }
          rgcCode = todayRgcCode.code;

          if (submission.requestType === "parts_nla") {
            authCode = rgcCode;
          } else {
            const warrantyCompany = (submission.warrantyProvider || submission.warrantyType || "").toLowerCase();
            const needsExternalAuth = ["american home shield", "ahs", "first american"].some(w => warrantyCompany.includes(w));

            if (needsExternalAuth) {
              if (!authCode || !authCode.trim()) {
                return res.status(400).json({ error: "External authorization code is required for this warranty provider" });
              }
            } else {
              authCode = rgcCode;
            }
          }
        }

        updateData.ticketStatus = "completed";
        updateData.statusChangedAt = new Date();
        updateData.authCode = authCode || null;
        updateData.rgcCode = rgcCode;
        updateData.stage1Status = "approved";
        updateData.stage1ReviewedBy = authReq.user!.id;
        updateData.stage1ReviewedAt = new Date();
        updateData.stage2Status = "approved";
        updateData.stage2Outcome = "approved";
        updateData.stage2ReviewedBy = authReq.user!.id;
        updateData.stage2ReviewedAt = new Date();

        const approvalNotes = technicianMessage || (submission as any).technicianMessage || null;
        updateData.technicianMessage = approvalNotes;

        if (submission.requestType === "parts_nla") {
          smsMessage = await buildNlaApprovalMessage(submission.serviceOrder, rgcCode, approvalNotes ?? undefined);
        } else {
          const authDisplay = authCode || rgcCode || "";
          smsMessage = await buildAuthCodeMessage(submission.serviceOrder, authDisplay, rgcCode, approvalNotes ?? undefined);
        }
        smsType = "ticket_approved";

      } else if (action === "reject") {
        updateData.ticketStatus = "rejected";
        updateData.statusChangedAt = new Date();
        updateData.assignedTo = null;
        updateData.stage1Status = "rejected";
        updateData.stage1ReviewedBy = authReq.user!.id;
        updateData.stage1ReviewedAt = new Date();
        updateData.rejectionReasons = rejectionReasons ? JSON.stringify(rejectionReasons) : null;
        updateData.rejectedMedia = rejectedMedia ? JSON.stringify(rejectedMedia) : null;
        updateData.technicianMessage = technicianMessage || null;
        updateData.stage1RejectionReason = rejectionReasons?.join(", ") || "More information needed";

        const host = req.get("host") || "";
        const protocol = req.get("x-forwarded-proto") || req.protocol || "https";
        const resubmitLink = `${protocol}://${host}/tech/resubmit/${submission.id}`;

        const rejectionParts: string[] = [];
        if (rejectionReasons && rejectionReasons.length > 0) {
          rejectionParts.push(rejectionReasons.join(", "));
        }
        if (rejectedMedia) {
          const mediaIssues: string[] = [];
          if (rejectedMedia.photos && rejectedMedia.photos.length > 0) {
            mediaIssues.push(`${rejectedMedia.photos.length} photo(s) rejected`);
          }
          if (rejectedMedia.video?.rejected) {
            mediaIssues.push("Video rejected" + (rejectedMedia.video.reason ? `: ${rejectedMedia.video.reason}` : ""));
          }
          if (rejectedMedia.voiceNote?.rejected) {
            mediaIssues.push("Voice note rejected" + (rejectedMedia.voiceNote.reason ? `: ${rejectedMedia.voiceNote.reason}` : ""));
          }
          if (mediaIssues.length > 0) rejectionParts.push(mediaIssues.join("; "));
        }
        const reasonText = rejectionParts.length > 0 ? rejectionParts.join(". ") : "More information needed";
        const fullMessage = technicianMessage ? `${reasonText}\n\nFeedback from VRS — Action required: ${technicianMessage}` : reasonText;
        smsMessage = await buildStage1RejectedMessage(submission.serviceOrder, fullMessage, resubmitLink);
        smsType = "ticket_rejected";

      } else if (action === "reject_and_close") {
        updateData.ticketStatus = "rejected_closed";
        updateData.statusChangedAt = new Date();
        updateData.assignedTo = null;
        updateData.stage1Status = "rejected";
        updateData.stage1ReviewedBy = authReq.user!.id;
        updateData.stage1ReviewedAt = new Date();
        updateData.stage2Status = "not_applicable";
        updateData.rejectionReasons = rejectionReasons ? JSON.stringify(rejectionReasons) : null;
        updateData.technicianMessage = technicianMessage || null;
        updateData.stage1RejectionReason = rejectionReasons?.join(", ") || "Not covered under warranty";

        const reasonText = rejectionReasons && rejectionReasons.length > 0
          ? rejectionReasons.join(", ")
          : "Not covered under warranty";
        const fullMsg = technicianMessage ? `${reasonText}\n\nFeedback from VRS: ${technicianMessage}` : reasonText;
        smsMessage = await buildRejectAndCloseMessage(submission.serviceOrder, fullMsg, submission.warrantyType);
        smsType = "ticket_rejected_closed";

      } else {
        updateData.ticketStatus = "invalid";
        updateData.statusChangedAt = new Date();
        updateData.stage1Status = "invalid";
        updateData.stage1ReviewedBy = authReq.user!.id;
        updateData.stage1ReviewedAt = new Date();
        updateData.stage2Status = "not_applicable";
        updateData.invalidReason = invalidReason;
        updateData.invalidInstructions = invalidInstructions || null;

        smsMessage = await buildStage1InvalidMessage(submission.serviceOrder, invalidReason || "", invalidInstructions);
        smsType = "ticket_invalid";
      }

      const updated = await storage.updateSubmission(id, updateData as any);

      const reviewSmsPhone = submission.phoneOverride || submission.phone;
      await sendSms(submission.id, reviewSmsPhone, smsType, smsMessage);

      if (authReq.user!.role === "vrs_agent") {
        await storage.updateUser(authReq.user!.id, { agentStatus: "online", updatedAt: new Date() } as any);
        updateClientStatus(authReq.user!.id, "online");
        broadcastToAdmins({
          type: "agent_status_changed",
          payload: { userId: authReq.user!.id, name: authReq.user!.name, status: "online" },
        });
        broadcastToAgent(authReq.user!.id, {
          type: "own_status_changed",
          payload: { status: "online" },
        });
        await broadcastVrsAvailability();
      }

      if (action === "reject") {
        if (submission.requestType === "parts_nla") {
          broadcastToNlaDivisionAgents(submission.applianceType, {
            type: "ticket_queued",
            payload: {
              submissionId: id,
              serviceOrder: submission.serviceOrder,
              applianceType: submission.applianceType,
              applianceLabel: getDivisionLabel(submission.applianceType),
              warrantyLabel: getWarrantyLabel(submission.warrantyType),
            },
          });
        } else {
          broadcastToDivisionAgents(submission.applianceType, {
            type: "ticket_queued",
            payload: {
              submissionId: id,
              serviceOrder: submission.serviceOrder,
              applianceType: submission.applianceType,
              applianceLabel: getDivisionLabel(submission.applianceType),
              warrantyLabel: getWarrantyLabel(submission.warrantyType),
            },
          });
        }
      }

      await broadcastVrsAvailability();

      return res.status(200).json({ submission: updated });
    } catch (error) {
      console.error("Process ticket error:", error);
      return res.status(500).json({ error: "Failed to process ticket" });
    }
  });

  // ========================================================================
  // NLA TICKET PROCESS ROUTE — NLA-specific resolution actions
  // ========================================================================

  const nlaProcessActionSchema = z.object({
    action: z.enum([
      "nla_replacement_submitted",
      "nla_replacement_tech_initiates",
      "nla_part_found_vrs_ordered",
      "nla_part_found_tech_orders",
      "nla_escalate_to_pcard",
      "nla_pcard_confirm",
      "nla_reject",
      "nla_invalid",
      "nla_rfr_eligible",
    ]),
    agentNotes: z.string().optional(),
    technicianMessage: z.string().optional(),
    nlaFoundPartNumber: z.string().optional(),
    nlaResolution: z.string().optional(),
    rejectionReasons: z.array(z.string()).optional(),
    invalidReason: z.string().optional(),
    invalidInstructions: z.string().optional(),
  });

  app.patch("/api/submissions/:id/process-nla", authenticateToken, requireRole("vrs_agent", "admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid submission ID" });

      const parsed = nlaProcessActionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

      const submission = await storage.getSubmission(id);
      if (!submission) return res.status(404).json({ error: "Submission not found" });

      if (submission.requestType !== "parts_nla") {
        return res.status(400).json({ error: "This route is only for NLA tickets" });
      }

      if (submission.ticketStatus !== "pending") {
        return res.status(400).json({ error: "Ticket must be in pending status" });
      }

      if (submission.assignedTo !== authReq.user!.id && authReq.user!.role !== "admin" && authReq.user!.role !== "super_admin") {
        return res.status(403).json({ error: "This ticket is not assigned to you" });
      }

      const { action, agentNotes, technicianMessage, nlaFoundPartNumber, nlaResolution, rejectionReasons, invalidReason, invalidInstructions } = parsed.data;

      if (!technicianMessage || !technicianMessage.trim()) {
        if (action === "nla_pcard_confirm" && submission.technicianMessage) {
        } else {
          return res.status(400).json({ error: "Instructions for technician are required for all NLA resolutions" });
        }
      }

      const currentUser = await storage.getUser(authReq.user!.id);

      const nlaApprovalActions = ["nla_replacement_submitted", "nla_replacement_tech_initiates", "nla_part_found_vrs_ordered", "nla_part_found_tech_orders", "nla_pcard_confirm", "nla_escalate_pcard", "nla_rfr_eligible"];
      let rgcCode: string | null = null;

      if (nlaApprovalActions.includes(action)) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const todayRgcCode = await storage.getDailyRgcCode(todayStr);
        if (!todayRgcCode) {
          return res.status(400).json({ error: "No RGC code has been set for today. Please contact an administrator." });
        }
        rgcCode = todayRgcCode.code;
      }

      const updateData: Record<string, unknown> = {
        agentNotes: agentNotes || null,
        updatedAt: new Date(),
      };

      let smsMessage: string = "";
      let smsType: string = "";
      let shouldSendSms = true;

      if (action === "nla_replacement_submitted") {
        updateData.ticketStatus = "completed";
        updateData.statusChangedAt = new Date();
        updateData.reviewedBy = authReq.user!.id;
        updateData.reviewedAt = new Date();
        updateData.nlaResolution = "replacement_submitted";
        updateData.technicianMessage = technicianMessage || null;
        updateData.rgcCode = rgcCode;

        // Tyler 2026-04-29: was inline string; now flows through the
        // editable Communication Templates table (actionKey:
        // nla_replacement_submitted). Builder falls back to the
        // byte-identical hardcoded copy if the template is missing.
        smsMessage = await buildNlaReplacementSubmittedMessage(
          submission.serviceOrder,
          rgcCode!,
          technicianMessage,
        );
        smsType = "nla_replacement_submitted";

      } else if (action === "nla_replacement_tech_initiates") {
        updateData.ticketStatus = "completed";
        updateData.statusChangedAt = new Date();
        updateData.reviewedBy = authReq.user!.id;
        updateData.reviewedAt = new Date();
        updateData.nlaResolution = "replacement_tech_initiates";
        updateData.technicianMessage = technicianMessage || null;
        updateData.rgcCode = rgcCode;

        // Tyler 2026-04-29: actionKey nla_replacement_tech_initiates.
        smsMessage = await buildNlaReplacementTechInitiatesMessage(
          submission.serviceOrder,
          rgcCode!,
          technicianMessage,
        );
        smsType = "nla_replacement_tech_initiates";

      } else if (action === "nla_part_found_vrs_ordered") {
        if (!currentUser?.canOrderParts) {
          return res.status(403).json({ error: "You do not have a P-card. Use 'Escalate to P-Card Agent' instead." });
        }
        updateData.ticketStatus = "completed";
        updateData.statusChangedAt = new Date();
        updateData.reviewedBy = authReq.user!.id;
        updateData.reviewedAt = new Date();
        updateData.nlaResolution = "part_found_vrs_ordered";
        updateData.technicianMessage = technicianMessage || null;
        updateData.rgcCode = rgcCode;

        // Tyler 2026-04-29: actionKey nla_part_found_vrs_ordered.
        // fromPcardConfirm=false → builder uses "Instructions:" prefix on
        // the technician message block (matches the historical inline
        // string for this branch).
        smsMessage = await buildNlaPartFoundVrsOrderedMessage(
          submission.serviceOrder,
          rgcCode!,
          technicianMessage,
          false,
        );
        smsType = "nla_part_ordered_vrs";

      } else if (action === "nla_part_found_tech_orders") {
        if (!nlaFoundPartNumber || !nlaFoundPartNumber.trim()) {
          return res.status(400).json({ error: "Part number is required when the technician needs to order" });
        }
        updateData.ticketStatus = "completed";
        updateData.statusChangedAt = new Date();
        updateData.reviewedBy = authReq.user!.id;
        updateData.reviewedAt = new Date();
        updateData.nlaResolution = "part_found_tech_orders";
        updateData.nlaFoundPartNumber = nlaFoundPartNumber.trim().toUpperCase();
        updateData.technicianMessage = technicianMessage || null;
        updateData.rgcCode = rgcCode;

        // Tyler 2026-04-29: actionKey nla_part_found_tech_orders.
        // fromPcardConfirm=false → builder uses
        // "Feedback from VRS — Action required:" prefix (matches the
        // historical inline string for this branch).
        smsMessage = await buildNlaPartFoundTechOrdersMessage(
          submission.serviceOrder,
          rgcCode!,
          nlaFoundPartNumber.trim().toUpperCase(),
          technicianMessage,
          false,
        );
        smsType = "nla_part_tech_orders";

      } else if (action === "nla_rfr_eligible") {
        updateData.ticketStatus = "completed";
        updateData.statusChangedAt = new Date();
        updateData.reviewedBy = authReq.user!.id;
        updateData.reviewedAt = new Date();
        updateData.nlaResolution = "rfr_eligible";
        updateData.technicianMessage = technicianMessage || null;
        updateData.rgcCode = rgcCode;

        // Tyler 2026-04-29: actionKey nla_rfr_eligible.
        smsMessage = await buildNlaRfrEligibleMessage(
          submission.serviceOrder,
          rgcCode!,
          technicianMessage,
        );
        smsType = "nla_rfr_eligible";

      } else if (action === "nla_escalate_to_pcard") {
        if (currentUser?.canOrderParts) {
          return res.status(400).json({ error: "P-card agents should process orders directly, not escalate" });
        }
        if (!nlaResolution) {
          return res.status(400).json({ error: "Resolution type is required for escalation" });
        }
        updateData.nlaResolution = nlaResolution;
        updateData.nlaFoundPartNumber = nlaFoundPartNumber?.trim().toUpperCase() || null;
        updateData.nlaEscalatedBy = authReq.user!.id;
        updateData.technicianMessage = technicianMessage || null;
        updateData.reassignmentNotes = `Researched by ${currentUser?.name || "agent"}. Ready for P-card order.`;
        updateData.assignedTo = null;
        updateData.ticketStatus = "queued";
        updateData.statusChangedAt = new Date();

        shouldSendSms = false;

        broadcastToNlaDivisionAgents(submission.applianceType, {
          type: "nla_escalated",
          payload: {
            submissionId: submission.id,
            serviceOrder: submission.serviceOrder,
            escalatedBy: currentUser?.name || "Agent",
            resolution: nlaResolution,
          },
        });

      } else if (action === "nla_pcard_confirm") {
        if (!currentUser?.canOrderParts) {
          return res.status(403).json({ error: "Only P-card agents can confirm escalated orders" });
        }
        if (!submission.nlaEscalatedBy) {
          return res.status(400).json({ error: "This ticket has not been escalated for P-card confirmation" });
        }
        const resolution = submission.nlaResolution || nlaResolution;
        updateData.ticketStatus = "completed";
        updateData.statusChangedAt = new Date();
        updateData.reviewedBy = authReq.user!.id;
        updateData.reviewedAt = new Date();
        updateData.nlaResolution = resolution;
        updateData.rgcCode = rgcCode;
        if (technicianMessage) updateData.technicianMessage = technicianMessage;

        // Tyler 2026-04-29: nla_pcard_confirm reuses the same template
        // bodies as the direct-fulfillment branches above, but with
        // fromPcardConfirm=true so the tech-message prefix becomes
        // "Feedback from VRS:" (matches the prior inline string).
        // The agent-message precedence is `technicianMessage ?? submission.technicianMessage`
        // — original (just-submitted) value wins, but if absent we fall
        // back to whatever the researcher noted during escalation.
        const effectiveTechMsg = technicianMessage || submission.technicianMessage || null;
        if (resolution === "part_found_vrs_ordered") {
          smsMessage = await buildNlaPartFoundVrsOrderedMessage(
            submission.serviceOrder,
            rgcCode!,
            effectiveTechMsg,
            true,
          );
        } else if (resolution === "part_found_tech_orders") {
          const partNum = submission.nlaFoundPartNumber || nlaFoundPartNumber || "";
          smsMessage = await buildNlaPartFoundTechOrdersMessage(
            submission.serviceOrder,
            rgcCode!,
            partNum,
            effectiveTechMsg,
            true,
          );
        } else {
          smsMessage = await buildNlaPcardConfirmedGenericMessage(
            submission.serviceOrder,
            rgcCode!,
            effectiveTechMsg,
          );
        }
        smsType = "nla_pcard_confirmed";

      } else if (action === "nla_reject") {
        updateData.ticketStatus = "rejected";
        updateData.statusChangedAt = new Date();
        updateData.reviewedBy = authReq.user!.id;
        updateData.reviewedAt = new Date();
        updateData.assignedTo = null;
        updateData.rejectionReasons = rejectionReasons ? JSON.stringify(rejectionReasons) : null;
        updateData.technicianMessage = technicianMessage || null;

        const host = req.get("host") || "";
        const protocol = req.get("x-forwarded-proto") || req.protocol || "https";
        const resubmitLink = `${protocol}://${host}/tech/resubmit/${submission.id}`;
        const reasonText = rejectionReasons?.join(", ") || "More information needed";

        // Tyler 2026-04-29: actionKey nla_rejected.
        smsMessage = await buildNlaRejectedMessage(
          submission.serviceOrder,
          reasonText,
          resubmitLink,
          technicianMessage,
        );
        smsType = "nla_rejected";

        broadcastToNlaDivisionAgents(submission.applianceType, {
          type: "ticket_released",
          payload: { submissionId: submission.id },
        });

      } else if (action === "nla_invalid") {
        if (!invalidReason) return res.status(400).json({ error: "Invalid reason is required" });
        updateData.ticketStatus = "invalid";
        updateData.statusChangedAt = new Date();
        updateData.reviewedBy = authReq.user!.id;
        updateData.reviewedAt = new Date();
        updateData.invalidReason = invalidReason;
        updateData.invalidInstructions = invalidInstructions || null;

        smsMessage = await buildNlaInvalidMessage(submission.serviceOrder, invalidReason, invalidInstructions);
        smsType = "nla_invalid";

      } else {
        return res.status(400).json({ error: "Invalid action" });
      }

      const updated = await storage.updateSubmission(id, updateData as any);

      if (shouldSendSms && smsMessage) {
        const smsPhone = submission.phoneOverride || submission.phone;
        await sendSms(submission.id, smsPhone, smsType, smsMessage);
      }

      if (authReq.user!.role === "vrs_agent") {
        await storage.updateUser(authReq.user!.id, { agentStatus: "online", updatedAt: new Date() } as any);
        updateClientStatus(authReq.user!.id, "online");
        broadcastToAdmins({
          type: "agent_status_changed",
          payload: { userId: authReq.user!.id, name: authReq.user!.name, status: "online" },
        });
        broadcastToAgent(authReq.user!.id, {
          type: "own_status_changed",
          payload: { status: "online" },
        });
      }

      broadcastToAdmins({
        type: "ticket_updated",
        payload: { submissionId: id, ticketStatus: updated?.ticketStatus },
      });
      await broadcastVrsAvailability();

      return res.status(200).json({ submission: updated });
    } catch (error) {
      console.error("NLA process error:", error);
      return res.status(500).json({ error: "Failed to process NLA ticket" });
    }
  });

  // ========================================================================
  // AGENT STATS ROUTE
  // ========================================================================

  app.get("/api/agent/stats", authenticateToken, requireRole("vrs_agent", "admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userRole = authReq.user!.role;

      if (userRole === "vrs_agent") {
        const specs = await storage.getSpecializations(authReq.user!.id);
        const divisions = specs.map(s => s.division);
        const queueCount = await storage.getQueuedCount(divisions);
        const pendingCount = await storage.getPendingCount(authReq.user!.id);
        const completedToday = await storage.getCompletedTodayCount(authReq.user!.id);

        let nlaQueueCount = 0;
        let nlaPendingCount = 0;
        let nlaCompletedToday = 0;
        if (divisions.includes("nla")) {
          nlaQueueCount = await storage.getNlaQueuedCount(divisions);
          nlaPendingCount = await storage.getNlaPendingCount(authReq.user!.id);
          nlaCompletedToday = await storage.getNlaCompletedTodayCount(authReq.user!.id, divisions);
        }

        return res.status(200).json({ queueCount, pendingCount, completedToday, nlaQueueCount, nlaPendingCount, nlaCompletedToday });
      }

      const queueCount = await storage.getQueuedCount(ALL_DIVISIONS);
      const completedToday = await storage.getCompletedTodayCount();
      const nlaQueueCount = await storage.getNlaQueuedCount();
      const nlaCompletedToday = await storage.getNlaCompletedTodayCount();

      return res.status(200).json({ queueCount, pendingCount: 0, completedToday, nlaQueueCount, nlaPendingCount: 0, nlaCompletedToday });
    } catch (error) {
      console.error("Agent stats error:", error);
      return res.status(500).json({ error: "Failed to get agent stats" });
    }
  });

  app.get("/api/vrs-availability", authenticateToken, async (_req, res) => {
    try {
      const onlineAgents = await storage.getOnlineAgentCount();
      const queuedTickets = await storage.getQueuedCountAll();
      return res.status(200).json({ onlineAgents, queuedTickets });
    } catch (error) {
      console.error("VRS availability error:", error);
      return res.status(500).json({ error: "Failed to get VRS availability" });
    }
  });

  // ========================================================================
  // AGENT STATUS ROUTES
  // ========================================================================

  app.patch("/api/agent/status", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const statusSchema = z.object({ status: z.enum(["online", "offline"]) });
      const parsed = statusSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Status must be 'online' or 'offline'" });
      }

      if (parsed.data.status === "offline") {
        const pendingCount = await storage.getPendingCount(authReq.user!.id);
        if (pendingCount > 0) {
          return res.status(400).json({ error: "You have an open ticket. Complete it or ask an admin to reassign it before going unavailable.", hasPendingTicket: true });
        }
      }

      const updated = await storage.updateUser(authReq.user!.id, { agentStatus: parsed.data.status, updatedAt: new Date() } as any);
      updateClientStatus(authReq.user!.id, parsed.data.status);
      broadcastToAdmins({
        type: "agent_status_changed",
        payload: { userId: authReq.user!.id, name: authReq.user!.name, status: parsed.data.status },
      });
      broadcastToAgent(authReq.user!.id, {
        type: "own_status_changed",
        payload: { status: parsed.data.status },
      });
      await broadcastVrsAvailability();

      if (parsed.data.status === "online") {
        const specs = await storage.getSpecializations(authReq.user!.id);
        const divisions = specs.map(s => s.division);
        
        const isGeneralist = divisions.length >= ALL_DIVISIONS.length;

        const allSubmissions = await storage.getSubmissions({});
        const queuedTickets = (allSubmissions as any[]).filter((s: any) => {
          if (s.ticketStatus !== "queued") return false;
          if (isGeneralist) return true;
          if (s.requestType === "parts_nla") return divisions.includes("nla");
          return divisions.includes(s.applianceType);
        });

        if (queuedTickets.length > 0) {
          for (const ticket of queuedTickets) {
            broadcastToAgent(authReq.user!.id, {
              type: "pending_tickets",
              payload: {
                submissionId: ticket.id,
                serviceOrder: ticket.serviceOrder,
                applianceType: ticket.applianceType,
                applianceLabel: getDivisionLabel(ticket.applianceType),
                warrantyLabel: getWarrantyLabel(ticket.warrantyType),
              },
            });
          }
        }
      }

      return res.status(200).json({ agentStatus: updated?.agentStatus });
    } catch (error) {
      console.error("Agent status error:", error);
      return res.status(500).json({ error: "Failed to update status" });
    }
  });

  app.patch("/api/admin/users/:id/status", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid user ID" });
      const statusSchema = z.object({ status: z.enum(["online", "working", "offline"]) });
      const parsed = statusSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid status value" });
      }
      const user = await storage.getUser(id);
      if (!user || user.role !== "vrs_agent") {
        return res.status(400).json({ error: "User is not a VRS agent" });
      }
      const updated = await storage.updateUser(id, { agentStatus: parsed.data.status } as any);
      updateClientStatus(id, parsed.data.status);
      broadcastToAdmins({
        type: "agent_status_changed",
        payload: { userId: id, name: user.name, status: parsed.data.status },
      });
      broadcastToAgent(id, {
        type: "own_status_changed",
        payload: { status: parsed.data.status },
      });
      await broadcastVrsAvailability();
      return res.status(200).json({ agentStatus: updated?.agentStatus });
    } catch (error) {
      console.error("Admin set agent status error:", error);
      return res.status(500).json({ error: "Failed to update agent status" });
    }
  });

  app.get("/api/admin/agent-status", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const agents = await storage.getAgentsWithStatus();
      return res.status(200).json({ agents });
    } catch (error) {
      console.error("Agent status list error:", error);
      return res.status(500).json({ error: "Failed to get agent status" });
    }
  });

  app.delete("/api/submissions/:id", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid submission ID" });

      const submission = await storage.getSubmission(id);
      if (!submission) return res.status(404).json({ message: "Submission not found" });

      const deleted = await storage.deleteSubmission(id);
      if (!deleted) return res.status(500).json({ message: "Failed to delete submission" });

      res.json({ message: "Submission deleted" });
    } catch (error) {
      console.error("Delete submission error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.patch("/api/submissions/:id/reassign", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid submission ID" });
      }

      const bodySchema = z.object({
        agentId: z.number().optional(),
        notes: z.string().optional(),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const submission = await storage.getSubmission(id);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      if (submission.ticketStatus !== "pending" && submission.ticketStatus !== "queued") {
        return res.status(400).json({ error: "Can only reassign queued or pending tickets" });
      }

      if (parsed.data.agentId) {
        const agent = await storage.getUser(parsed.data.agentId);
        if (!agent || (agent.role !== "vrs_agent" && agent.role !== "admin" && agent.role !== "super_admin")) {
          return res.status(400).json({ error: "Invalid agent" });
        }
        if (!agent.isActive) {
          return res.status(400).json({ error: "Cannot assign to an inactive user" });
        }

        const updated = await storage.updateSubmission(id, {
          assignedTo: parsed.data.agentId,
          ticketStatus: "pending",
          statusChangedAt: new Date(),
          reassignmentNotes: parsed.data.notes || null,
          updatedAt: new Date(),
        } as any);

        broadcastToAgent(parsed.data.agentId, {
          type: "ticket_assigned",
          payload: {
            submissionId: updated.id,
            serviceOrder: updated.serviceOrder,
            message: `A ticket has been assigned to you by an admin.`,
          },
        });

        return res.status(200).json({ submission: updated });
      }

      const updated = await storage.updateSubmission(id, {
        ticketStatus: "queued",
        statusChangedAt: new Date(),
        assignedTo: null,
        reassignmentNotes: parsed.data.notes || null,
        updatedAt: new Date(),
      } as any);

      if (updated.requestType === "parts_nla") {
        broadcastToNlaDivisionAgents(updated.applianceType, {
          type: "ticket_queued",
          payload: {
            submissionId: updated.id,
            serviceOrder: updated.serviceOrder,
            applianceType: updated.applianceType,
            applianceLabel: getDivisionLabel(updated.applianceType),
            warrantyLabel: getWarrantyLabel(updated.warrantyType),
          },
        });
      } else {
        broadcastToDivisionAgents(updated.applianceType, {
          type: "ticket_queued",
          payload: {
            submissionId: updated.id,
            serviceOrder: updated.serviceOrder,
            applianceType: updated.applianceType,
            applianceLabel: getDivisionLabel(updated.applianceType),
            warrantyLabel: getWarrantyLabel(updated.warrantyType),
          },
        });
      }

      return res.status(200).json({ submission: updated });
    } catch (error) {
      console.error("Reassign submission error:", error);
      return res.status(500).json({ error: "Failed to reassign submission" });
    }
  });

  // ========================================================================
  // SEND TO NLA QUEUE — Agent sends a VRS ticket to the NLA queue
  // ========================================================================

  app.post("/api/submissions/:id/send-to-nla", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid submission ID" });
      }

      const VALID_DIVISIONS = ["refrigeration", "laundry", "cooking", "dishwasher", "microwave", "hvac", "all_other"];

      const bodySchema = z.object({
        notes: z.string().optional(),
        division: z.string().optional(),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      if (parsed.data.division && !VALID_DIVISIONS.includes(parsed.data.division)) {
        return res.status(400).json({ error: "Invalid division" });
      }

      const submission = await storage.getSubmission(id);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      if (submission.requestType === "parts_nla") {
        return res.status(400).json({ error: "Ticket is already in the NLA queue" });
      }

      if (submission.ticketStatus !== "pending") {
        return res.status(400).json({ error: "Can only send claimed (pending) tickets to NLA" });
      }

      const isAdmin = authReq.user.role === "admin" || authReq.user.role === "super_admin";
      if (!isAdmin && submission.assignedTo !== authReq.user.id) {
        return res.status(403).json({ error: "You can only send your own claimed tickets to NLA" });
      }

      const targetDivision = parsed.data.division || submission.applianceType;

      const updated = await storage.updateSubmission(id, {
        requestType: "parts_nla",
        applianceType: targetDivision,
        ticketStatus: "queued",
        assignedTo: null,
        reassignmentNotes: parsed.data.notes || `Sent to NLA queue by ${authReq.user.name}`,
        statusChangedAt: new Date(),
        updatedAt: new Date(),
      } as any);

      broadcastToNlaDivisionAgents(updated.applianceType, {
        type: "ticket_queued",
        payload: {
          submissionId: updated.id,
          serviceOrder: updated.serviceOrder,
          applianceType: updated.applianceType,
          applianceLabel: getDivisionLabel(updated.applianceType),
          warrantyLabel: getWarrantyLabel(updated.warrantyType),
        },
      });

      return res.status(200).json({ submission: updated });
    } catch (error) {
      console.error("Send to NLA error:", error);
      return res.status(500).json({ error: "Failed to send ticket to NLA queue" });
    }
  });

  // ========================================================================
  // DIVISION CORRECTION ROUTE — Agent corrects ticket's appliance type
  // ========================================================================

  app.patch("/api/submissions/:id/correct-division", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid submission ID" });
      }

      const bodySchema = z.object({
        newDivision: z.enum(["refrigeration", "laundry", "cooking", "dishwasher", "microwave", "hvac", "all_other"]),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid division" });
      }

      const submission = await storage.getSubmission(id);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      if (submission.ticketStatus !== "pending") {
        return res.status(400).json({ error: "Can only correct division on pending tickets" });
      }

      if (authReq.user!.role === "vrs_agent" && submission.assignedTo !== authReq.user!.id) {
        return res.status(403).json({ error: "You can only correct division on your own tickets" });
      }

      const oldDivision = submission.applianceType;
      const newDivision = parsed.data.newDivision;

      if (oldDivision === newDivision) {
        return res.status(400).json({ error: "New division is the same as current" });
      }

      const DIVISION_LABELS: Record<string, string> = {
        refrigeration: "Refrigeration", laundry: "Laundry", cooking: "Cooking",
        dishwasher: "Dishwasher / Compactor", microwave: "Microwave", hvac: "HVAC", all_other: "All Other",
      };
      const correctionNote = `Division corrected from ${DIVISION_LABELS[oldDivision] || oldDivision} to ${DIVISION_LABELS[newDivision] || newDivision} by ${authReq.user!.name}`;

      const existingNotes = submission.agentNotes ? submission.agentNotes + "\n" + correctionNote : correctionNote;

      let agentHasNewDivision = false;
      if (authReq.user!.role === "vrs_agent") {
        const specs = await storage.getSpecializations(authReq.user!.id);
        const divisions = specs.map(s => s.division);
        
        const isGeneralist = divisions.length >= ALL_DIVISIONS.length;
        agentHasNewDivision = isGeneralist || divisions.includes(newDivision);
      } else {
        agentHasNewDivision = true;
      }

      if (agentHasNewDivision) {
        const updated = await storage.updateSubmission(id, {
          applianceType: newDivision,
          agentNotes: existingNotes,
          updatedAt: new Date(),
        } as any);
        return res.status(200).json({ submission: updated, agentKeepsTicket: true });
      } else {
        const updated = await storage.updateSubmission(id, {
          applianceType: newDivision,
          ticketStatus: "queued",
          statusChangedAt: new Date(),
          assignedTo: null,
          agentNotes: existingNotes,
          updatedAt: new Date(),
        } as any);

        await storage.updateUser(authReq.user!.id, { agentStatus: "online", updatedAt: new Date() } as any);
        updateClientStatus(authReq.user!.id, "online");

        broadcastToAdmins({
          type: "agent_status_changed",
          payload: { userId: authReq.user!.id, name: authReq.user!.name, status: "online" },
        });
        broadcastToAgent(authReq.user!.id, {
          type: "own_status_changed",
          payload: { status: "online" },
        });

        broadcastToDivisionAgents(newDivision, {
          type: "ticket_queued",
          payload: {
            submissionId: id,
            serviceOrder: submission.serviceOrder,
            applianceType: newDivision,
            applianceLabel: getDivisionLabel(newDivision),
            warrantyLabel: getWarrantyLabel(submission.warrantyType),
          },
        });

        return res.status(200).json({ submission: updated, agentKeepsTicket: false });
      }
    } catch (error) {
      console.error("Correct division error:", error);
      return res.status(500).json({ error: "Failed to correct division" });
    }
  });

  // ========================================================================
  // WARRANTY PROVIDER COUNTS
  // ========================================================================

  app.get("/api/agent/warranty-counts", authenticateToken, requireRole("vrs_agent", "admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const assignedTo = req.query.allQueue === "true" ? undefined : authReq.user!.id;
      const counts = await storage.getWarrantyProviderCounts(assignedTo);
      return res.status(200).json({ counts });
    } catch (error) {
      console.error("Warranty counts error:", error);
      return res.status(500).json({ error: "Failed to get warranty counts" });
    }
  });

  // ========================================================================
  // ADMIN RGC CODE ROUTES
  // ========================================================================

  const rgcCodeSchema = z.object({
    code: z.string().regex(/^\d{5}$/, "Must be exactly 5 digits"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  });

  app.post("/api/admin/rgc-code", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const parsed = rgcCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const fullCode = `RGC${parsed.data.code}`;
      const result = await storage.upsertDailyRgcCode({
        code: fullCode,
        validDate: parsed.data.date,
        createdBy: authReq.user!.id,
      });

      return res.status(200).json({ rgcCode: result });
    } catch (error) {
      console.error("Admin set RGC code error:", error);
      return res.status(500).json({ error: "Failed to set RGC code" });
    }
  });

  app.get("/api/admin/rgc-code", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
      const rgcCode = await storage.getDailyRgcCode(date);

      if (rgcCode) {
        const user = rgcCode.createdBy ? await storage.getUser(rgcCode.createdBy) : null;
        return res.status(200).json({ rgcCode, createdByName: user?.name });
      }

      return res.status(200).json({ rgcCode: null });
    } catch (error) {
      console.error("Admin get RGC code error:", error);
      return res.status(500).json({ error: "Failed to get RGC code" });
    }
  });

  // ========================================================================
  // AGENT RGC ROUTES
  // ========================================================================

  const verifyRgcSchema = z.object({
    code: z.string().regex(/^\d{5}$/, "Must be exactly 5 digits"),
  });

  app.post("/api/agent/verify-rgc", authenticateToken, requireRole("vrs_agent", "admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const parsed = verifyRgcSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const fullCode = "RGC" + parsed.data.code;
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayCode = await storage.getDailyRgcCode(todayStr);

      if (!todayCode) {
        return res.status(400).json({ error: "No RGC code has been set for today. Please contact an administrator." });
      }

      if (todayCode.code !== fullCode) {
        return res.status(400).json({ error: "Code does not match today's RGC. Please verify with your admin." });
      }

      await storage.updateUser(authReq.user!.id, { lastRgcCodeEntry: todayStr } as any);
      return res.status(200).json({ success: true, code: todayCode.code });
    } catch (error) {
      console.error("Verify RGC error:", error);
      return res.status(500).json({ error: "Failed to verify RGC code" });
    }
  });

  app.get("/api/agent/rgc-status", authenticateToken, requireRole("vrs_agent", "admin"), async (req, res) => {
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayCode = await storage.getDailyRgcCode(todayStr);

      if (!todayCode) {
        return res.status(200).json({ needsEntry: false, missingCode: true, code: null });
      }

      return res.status(200).json({ needsEntry: false, missingCode: false, code: todayCode.code });
    } catch (error) {
      console.error("RGC status error:", error);
      return res.status(500).json({ error: "Failed to get RGC status" });
    }
  });

  // ========================================================================
  // ADMIN ROUTES
  // ========================================================================

  app.post("/api/admin/users", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }
      const { email, password, name, role, phone, racId } = parsed.data;

      if (racId) {
        const existingByRacId = await storage.getUserByRacId(racId);
        if (existingByRacId) {
          return res.status(409).json({ error: "LDAP ID already exists" });
        }
      }

      const hashedPassword = await bcryptjs.hash(password, 10);
      const user = await storage.createUser({
        email: email || null,
        password: hashedPassword,
        name,
        role,
        phone: phone || null,
        racId: racId || null,
      });

      if (role === "admin" || role === "super_admin") {
        await storage.setSpecializations(user.id, ALL_DIVISIONS);
      }

      return res.status(201).json({ user: sanitizeUser(user) });
    } catch (error) {
      console.error("Admin create user error:", error);
      return res.status(500).json({ error: "Failed to create user" });
    }
  });

  app.get("/api/admin/users", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const users = await storage.getUsers();
      const sanitizedUsers = users.map(sanitizeUser).filter(u => !u.isSystemAccount && u.role !== 'technician');
      return res.status(200).json({ users: sanitizedUsers });
    } catch (error) {
      console.error("Admin get users error:", error);
      return res.status(500).json({ error: "Failed to get users" });
    }
  });

  app.get("/api/admin/technician-users", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const technicians = await storage.getTechnicianUsers();
      return res.status(200).json({ technicians });
    } catch (error) {
      console.error("Admin get technician users error:", error);
      return res.status(500).json({ error: "Failed to get technician users" });
    }
  });

  const updateUserSchema = z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional().nullable(),
    phone: z.string().optional().nullable(),
    racId: z.string().regex(/^[a-zA-Z]+[a-zA-Z0-9]*$/, "LDAP ID must be letters and numbers only (e.g., MTHOMA2)").optional().nullable().or(z.literal("")),
    role: z.enum(["technician", "vrs_agent", "admin", "super_admin"]).optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(6).optional(),
    resetPassword: z.boolean().optional(),
    canOrderParts: z.boolean().optional(),
  });

  app.patch("/api/admin/users/:id", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      const parsed = updateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.isSystemAccount) {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.user || authReq.user.role !== "super_admin") {
          return res.status(403).json({ error: "System accounts cannot be modified" });
        }
        if (parsed.data.role !== undefined || parsed.data.isActive === false) {
          return res.status(403).json({ error: "Cannot change role or deactivate system accounts" });
        }
      }

      const updateData: Record<string, unknown> = {};
      
      if (parsed.data.name !== undefined) {
        updateData.name = parsed.data.name;
      }
      if (parsed.data.email !== undefined) {
        updateData.email = parsed.data.email;
      }
      if (parsed.data.phone !== undefined) {
        updateData.phone = parsed.data.phone;
      }
      if (parsed.data.racId !== undefined) {
        updateData.racId = parsed.data.racId;
      }
      if (parsed.data.role !== undefined) {
        updateData.role = parsed.data.role;
      }
      if (parsed.data.isActive !== undefined) {
        updateData.isActive = parsed.data.isActive;
      }
      if (parsed.data.password !== undefined) {
        const hashedPassword = await bcryptjs.hash(parsed.data.password, 10);
        updateData.password = hashedPassword;
      }
      if (parsed.data.canOrderParts !== undefined) {
        updateData.canOrderParts = parsed.data.canOrderParts;
      }
      if (parsed.data.resetPassword === true) {
        const authReq = req as AuthenticatedRequest;
        if (authReq.user?.role === "admin" && user.role !== "vrs_agent" && user.role !== "technician") {
          return res.status(403).json({ error: "Admins can only reset passwords for agents and technicians" });
        }
        const hashedPassword = await bcryptjs.hash("VRS2026!", 10);
        updateData.password = hashedPassword;
        updateData.mustChangePassword = true;
        updateData.passwordChangedAt = null;
      }

      const updatedUser = await storage.updateUser(id, updateData as any);
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }

      if (parsed.data.role && (parsed.data.role === "admin" || parsed.data.role === "super_admin")) {
        await storage.setSpecializations(id, ALL_DIVISIONS);
      }

      return res.status(200).json({ user: sanitizeUser(updatedUser) });
    } catch (error) {
      console.error("Admin update user error:", error);
      return res.status(500).json({ error: "Failed to update user" });
    }
  });

  app.delete("/api/admin/users/:id", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      if (id === authReq.user!.id) {
        return res.status(403).json({ error: "Cannot delete your own account" });
      }

      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.isSystemAccount) {
        return res.status(403).json({ error: "System accounts cannot be deleted" });
      }

      if (user.role === "super_admin") {
        return res.status(403).json({ error: "Super admin accounts cannot be deleted" });
      }

      if (authReq.user?.role === "admin" && user.role !== "vrs_agent" && user.role !== "technician") {
        return res.status(403).json({ error: "Admins can only delete agents and technicians" });
      }

      await storage.deleteUser(id);
      return res.status(200).json({ message: "User deleted successfully" });
    } catch (error) {
      console.error("Admin delete user error:", error);
      return res.status(500).json({ error: "Failed to delete user" });
    }
  });

  app.get("/api/agent/specializations", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (authReq.user!.role === "admin" || authReq.user!.role === "super_admin") {
        return res.status(200).json({ divisions: ALL_DIVISIONS });
      }
      const specializations = await storage.getSpecializations(authReq.user!.id);
      const divisions = specializations.map(s => s.division);
      return res.status(200).json({ divisions });
    } catch (error) {
      console.error("Agent get own specializations error:", error);
      return res.status(500).json({ error: "Failed to get specializations" });
    }
  });

  app.patch("/api/agent/specializations", authenticateToken, requireRole("vrs_agent"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const parsed = setSpecializationsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }
      if (parsed.data.divisions.length === 0) {
        return res.status(400).json({ error: "You must select at least one division" });
      }
      await storage.setSpecializations(authReq.user!.id, parsed.data.divisions);
      updateClientDivisions(authReq.user!.id, parsed.data.divisions);
      return res.status(200).json({ success: true, divisions: parsed.data.divisions });
    } catch (error) {
      console.error("Agent set own specializations error:", error);
      return res.status(500).json({ error: "Failed to set specializations" });
    }
  });

  app.get("/api/admin/users/:id/specializations", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const specializations = await storage.getSpecializations(id);
      return res.status(200).json({ specializations });
    } catch (error) {
      console.error("Admin get specializations error:", error);
      return res.status(500).json({ error: "Failed to get specializations" });
    }
  });

  const setSpecializationsSchema = z.object({
    divisions: z.array(z.enum(["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other", "nla"])),
  });

  app.patch("/api/admin/users/:id/specializations", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      const parsed = setSpecializationsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      await storage.setSpecializations(id, parsed.data.divisions);
      updateClientDivisions(id, parsed.data.divisions);
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("Admin set specializations error:", error);
      return res.status(500).json({ error: "Failed to set specializations" });
    }
  });

  // ==========================================================================
  // Tyler 2026-04-29 — Admin Communication Templates
  // Read + edit + version-history routes that back the new admin page. The
  // SMS render layer (server/sms.ts) reads these rows at send time, falling
  // back to the hardcoded copy if the row is missing or render errors out.
  // ==========================================================================
  app.get("/api/admin/communication-templates", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const channelParam = typeof req.query.channel === "string" ? req.query.channel : undefined;
      const channel = channelParam === "sms" || channelParam === "email" || channelParam === "push" ? channelParam : undefined;
      const rows = await storage.listCommunicationTemplates(channel);
      return res.status(200).json(rows);
    } catch (error) {
      console.error("List communication templates error:", error);
      return res.status(500).json({ error: "Failed to list communication templates" });
    }
  });

  app.get("/api/admin/communication-templates/:id/versions", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid template id" });
      const versions = await storage.getCommunicationTemplateVersions(id);
      return res.status(200).json(versions);
    } catch (error) {
      console.error("Communication template versions error:", error);
      return res.status(500).json({ error: "Failed to get template versions" });
    }
  });

  app.patch("/api/admin/communication-templates/:id", authenticateToken, requireRole("admin", "super_admin"), async (req: AuthenticatedRequest, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid template id" });

      const { body, editReason } = req.body ?? {};
      if (typeof body !== "string" || body.trim().length === 0) {
        return res.status(400).json({ error: "body is required" });
      }
      if (body.length > 4000) {
        return res.status(400).json({ error: "body is too long (max 4000 chars)" });
      }
      const reason = typeof editReason === "string" && editReason.trim().length > 0
        ? editReason.trim().slice(0, 500)
        : null;

      const editorId = req.user!.id;
      const updated = await storage.updateCommunicationTemplate(id, body, editorId, reason);
      if (!updated) return res.status(404).json({ error: "Template not found" });
      return res.status(200).json(updated);
    } catch (error) {
      console.error("Update communication template error:", error);
      return res.status(500).json({ error: "Failed to update communication template" });
    }
  });

  app.get("/api/admin/analytics", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const analytics = await storage.getAnalytics();
      return res.status(200).json(analytics);
    } catch (error) {
      console.error("Admin analytics error:", error);
      return res.status(500).json({ error: "Failed to get analytics" });
    }
  });

  app.get("/api/admin/analytics/resubmissions", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const stats = await storage.getResubmissionStats();
      return res.status(200).json(stats);
    } catch (error) {
      console.error("Resubmission stats error:", error);
      return res.status(500).json({ error: "Failed to get resubmission stats" });
    }
  });

  app.get("/api/admin/analytics/districts", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const rollup = await storage.getDistrictRollup();
      return res.status(200).json(rollup);
    } catch (error) {
      console.error("District rollup error:", error);
      return res.status(500).json({ error: "Failed to get district rollup" });
    }
  });

  // ========================================================================
  // CSV EXPORT ROUTE (Admin)
  // ========================================================================

  app.get("/api/admin/export-csv", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const range = (req.query.range as string) || "all";
      const customStart = req.query.startDate as string | undefined;
      const customEnd = req.query.endDate as string | undefined;
      const techLdap = req.query.techLdap as string | undefined;
      const now = new Date();
      let startDate: Date | null = null;
      let endDate: Date | null = null;

      if (customStart) {
        startDate = new Date(customStart);
        if (customEnd) {
          const end = new Date(customEnd);
          end.setHours(23, 59, 59, 999);
          endDate = end;
        }
      } else if (range === "today") {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      } else if (range === "week") {
        const day = now.getDay();
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
      } else if (range === "month") {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      }

      const allSubmissions = await storage.getAllSubmissions(startDate, endDate, techLdap || null);

      const userCache: Record<number, string> = {};
      const getUserName = async (userId: number | null): Promise<string> => {
        if (!userId) return "";
        if (userCache[userId]) return userCache[userId];
        const u = await storage.getUser(userId);
        userCache[userId] = u?.name || "";
        return userCache[userId];
      };

      const headers = [
        "ID", "Service Order", "Technician LDAP", "Technician Name", "Phone",
        "District", "Appliance Type", "Request Type", "Warranty Type", "Warranty Provider",
        "Issue Description", "Estimate Amount",
        "Ticket Status", "Reviewed By", "Reviewed At", "Rejection Reasons",
        "Auth Code", "RGC Code", "Assigned To", "Claimed At",
        "Created At", "Updated At"
      ];

      const escCsv = (val: any): string => {
        if (val === null || val === undefined) return "";
        let str = String(val);
        if (/^[=+\-@\t\r]/.test(str)) {
          str = "'" + str;
        }
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const rows: string[] = [headers.join(",")];

      for (const s of allSubmissions) {
        const techName = await getUserName(s.technicianId);
        const reviewerName = await getUserName(s.reviewedBy);
        const assignedName = await getUserName(s.assignedTo);

        let rejReasons = "";
        if (s.rejectionReasons) {
          try { rejReasons = JSON.parse(s.rejectionReasons).join("; "); } catch { rejReasons = s.rejectionReasons; }
        }

        rows.push([
          s.id,
          escCsv(s.serviceOrder),
          escCsv(s.technicianLdapId || s.racId),
          escCsv(techName),
          escCsv(s.phone),
          escCsv(s.districtCode),
          escCsv(s.applianceType),
          escCsv(s.requestType),
          escCsv(s.warrantyType),
          escCsv(s.warrantyProvider),
          escCsv(s.issueDescription),
          escCsv(s.estimateAmount),
          escCsv(s.ticketStatus),
          escCsv(reviewerName),
          s.reviewedAt ? new Date(s.reviewedAt).toISOString() : "",
          escCsv(rejReasons),
          escCsv(s.authCode),
          escCsv(s.rgcCode),
          escCsv(assignedName),
          s.claimedAt ? new Date(s.claimedAt).toISOString() : "",
          s.createdAt ? new Date(s.createdAt).toISOString() : "",
          s.updatedAt ? new Date(s.updatedAt).toISOString() : "",
        ].join(","));
      }

      const csv = rows.join("\n");
      let rangeLabel = customStart ? `${customStart}${customEnd ? '_to_' + customEnd : ''}` : range === "today" ? "today" : range === "week" ? "this-week" : range === "month" ? "this-month" : "all-time";
      if (techLdap) rangeLabel += `-tech-${techLdap}`;
      const filename = `vrs-tickets-${rangeLabel}-${now.toISOString().slice(0, 10)}.csv`;

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.status(200).send(csv);
    } catch (error) {
      console.error("CSV export error:", error);
      return res.status(500).json({ error: "Failed to export CSV" });
    }
  });

  app.get("/api/admin/nla-analytics", authenticateToken, requireRole("admin"), async (_req, res) => {
    try {
      const analytics = await storage.getNlaAnalytics();
      return res.json(analytics);
    } catch (error) {
      console.error("NLA analytics error:", error);
      return res.status(500).json({ error: "Failed to fetch NLA analytics" });
    }
  });

  app.get("/api/admin/export-xlsx", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const ExcelJS = (await import("exceljs")).default;
      const FINAL_STATUSES = new Set(["completed", "approved", "rejected", "rejected_closed", "invalid"]);
      const formatDuration = (startVal: Date | string | null | undefined, endVal: Date | string | null | undefined): string => {
        if (!startVal) return "";
        const start = new Date(startVal as any);
        const end = endVal ? new Date(endVal as any) : new Date();
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return "";
        const diffMs = end.getTime() - start.getTime();
        if (diffMs < 0) return "";
        const totalMinutes = Math.floor(diffMs / 60000);
        if (totalMinutes < 1) return "< 1m";
        const days = Math.floor(totalMinutes / 1440);
        const hours = Math.floor((totalMinutes % 1440) / 60);
        const minutes = totalMinutes % 60;
        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${minutes}m`;
        return `${minutes}m`;
      };
      const computeTimings = (s: any) => {
        const queueWait = s.claimedAt
          ? formatDuration(s.createdAt, s.claimedAt)
          : s.ticketStatus === "queued"
            ? formatDuration(s.createdAt, null)
            : formatDuration(s.createdAt, s.statusChangedAt);
        const handleTime = s.claimedAt
          ? (s.ticketStatus === "pending"
              ? formatDuration(s.claimedAt, null)
              : formatDuration(s.claimedAt, s.statusChangedAt))
          : "";
        const totalTime = FINAL_STATUSES.has(s.ticketStatus)
          ? formatDuration(s.createdAt, s.statusChangedAt)
          : formatDuration(s.createdAt, null);
        return { queueWait, handleTime, totalTime };
      };
      const range = (req.query.range as string) || "all";
      const customStart = req.query.startDate as string | undefined;
      const customEnd = req.query.endDate as string | undefined;
      const techLdap = req.query.techLdap as string | undefined;
      const now = new Date();
      let startDate: Date | null = null;
      let endDate: Date | null = null;

      if (customStart) {
        startDate = new Date(customStart);
        if (customEnd) {
          const end = new Date(customEnd);
          end.setHours(23, 59, 59, 999);
          endDate = end;
        }
      } else if (range === "today") {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      } else if (range === "week") {
        const day = now.getDay();
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
      } else if (range === "month") {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      }

      const allSubmissions = await storage.getAllSubmissions(startDate, endDate, techLdap || null);

      const userCache: Record<number, string> = {};
      const getUserName = async (userId: number | null): Promise<string> => {
        if (!userId) return "";
        if (userCache[userId]) return userCache[userId];
        const u = await storage.getUser(userId);
        userCache[userId] = u?.name || "";
        return userCache[userId];
      };

      const authTickets = allSubmissions.filter(s => s.requestType !== "parts_nla");
      const nlaTickets = allSubmissions.filter(s => s.requestType === "parts_nla");

      const workbook = new ExcelJS.Workbook();

      const authHeaders = [
        "ID", "Service Order", "Technician LDAP", "Technician Name", "Phone",
        "District", "Appliance Type", "Request Type", "Warranty Type", "Warranty Provider",
        "Issue Description", "Estimate Amount",
        "Ticket Status", "Reviewed By", "Reviewed At", "Rejection Reasons",
        "Auth Code", "RGC Code", "Assigned To", "Claimed At",
        "Created At", "Updated At",
        "Queue Wait", "Handle Time", "Total Time"
      ];

      const authSheet = workbook.addWorksheet("Authorization Tickets");
      authSheet.addRow(authHeaders);
      const authHeaderRow = authSheet.getRow(1);
      authHeaderRow.font = { bold: true };
      authHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
      authHeaderRow.font = { bold: true, color: { argb: "FFFFFFFF" } };

      for (const s of authTickets) {
        const techName = await getUserName(s.technicianId);
        const reviewerName = await getUserName(s.reviewedBy);
        const assignedName = await getUserName(s.assignedTo);
        let rejReasons = "";
        if (s.rejectionReasons) {
          try { rejReasons = JSON.parse(s.rejectionReasons).join("; "); } catch { rejReasons = s.rejectionReasons; }
        }
        const t = computeTimings(s);
        authSheet.addRow([
          s.id, s.serviceOrder, s.technicianLdapId || s.racId, techName, s.phone,
          s.districtCode, s.applianceType, s.requestType, s.warrantyType, s.warrantyProvider,
          s.issueDescription, s.estimateAmount,
          s.ticketStatus, reviewerName, s.reviewedAt ? new Date(s.reviewedAt).toISOString() : "",
          rejReasons, s.authCode, s.rgcCode, assignedName,
          s.claimedAt ? new Date(s.claimedAt).toISOString() : "",
          s.createdAt ? new Date(s.createdAt).toISOString() : "",
          s.updatedAt ? new Date(s.updatedAt).toISOString() : "",
          t.queueWait, t.handleTime, t.totalTime,
        ]);
      }

      authHeaders.forEach((_h, i) => {
        const col = authSheet.getColumn(i + 1);
        col.width = 18;
      });

      const nlaResolutionLabel = (r: string | null) => {
        if (!r) return "";
        const map: Record<string, string> = {
          replacement_submitted: "Replacement Submitted",
          replacement_tech_initiates: "Replacement Approved (Tech Initiates)",
          part_found_vrs_ordered: "Part Ordered by VRS",
          part_found_tech_orders: "Tech Orders Part",
        };
        return map[r] || r;
      };

      const nlaHeaders = [
        "ID", "Service Order", "Technician LDAP", "Technician Name", "Phone",
        "District", "Appliance Type", "Part Numbers",
        "Issue Description",
        "Ticket Status", "NLA Resolution", "Found Part Number",
        "Reviewed By", "Reviewed At", "Rejection Reasons",
        "Assigned To", "Claimed At", "Created At", "Updated At",
        "Queue Wait", "Handle Time", "Total Time"
      ];

      const nlaSheet = workbook.addWorksheet("NLA Parts Tickets");
      nlaSheet.addRow(nlaHeaders);
      const nlaHeaderRow = nlaSheet.getRow(1);
      nlaHeaderRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
      nlaHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFED7D31" } };

      for (const s of nlaTickets) {
        const techName = await getUserName(s.technicianId);
        const reviewerName = await getUserName(s.reviewedBy);
        const assignedName = await getUserName(s.assignedTo);
        let rejReasons = "";
        if (s.rejectionReasons) {
          try { rejReasons = JSON.parse(s.rejectionReasons).join("; "); } catch { rejReasons = s.rejectionReasons; }
        }
        let partNumbers = "";
        if ((s as any).partNumbers) {
          try {
            const parsed = typeof (s as any).partNumbers === "string" ? JSON.parse((s as any).partNumbers) : (s as any).partNumbers;
            if (Array.isArray(parsed)) {
              partNumbers = parsed.join(", ");
            } else if (parsed && typeof parsed === "object" && (parsed.nla || parsed.available)) {
              const nlaParts = Array.isArray(parsed.nla) ? parsed.nla : [];
              const availParts = Array.isArray(parsed.available) ? parsed.available : [];
              const segments: string[] = [];
              if (nlaParts.length > 0) segments.push("NLA: " + nlaParts.join(", "));
              if (availParts.length > 0) segments.push("Available: " + availParts.join(", "));
              partNumbers = segments.join(" | ");
            } else {
              partNumbers = String(parsed);
            }
          } catch { partNumbers = String((s as any).partNumbers); }
        }
        const t = computeTimings(s);
        nlaSheet.addRow([
          s.id, s.serviceOrder, s.technicianLdapId || s.racId, techName, s.phone,
          s.districtCode, s.applianceType, partNumbers,
          s.issueDescription,
          s.ticketStatus, nlaResolutionLabel(s.nlaResolution), s.nlaFoundPartNumber || "",
          reviewerName, s.reviewedAt ? new Date(s.reviewedAt).toISOString() : "",
          rejReasons, assignedName,
          s.claimedAt ? new Date(s.claimedAt).toISOString() : "",
          s.createdAt ? new Date(s.createdAt).toISOString() : "",
          s.updatedAt ? new Date(s.updatedAt).toISOString() : "",
          t.queueWait, t.handleTime, t.totalTime,
        ]);
      }

      nlaHeaders.forEach((_h, i) => {
        const col = nlaSheet.getColumn(i + 1);
        col.width = 18;
      });

      let rangeLabel = customStart ? `${customStart}${customEnd ? '_to_' + customEnd : ''}` : range === "today" ? "today" : range === "week" ? "this-week" : range === "month" ? "this-month" : "all-time";
      if (techLdap) rangeLabel += `-tech-${techLdap}`;
      const filename = `vrs-tickets-${rangeLabel}-${now.toISOString().slice(0, 10)}.xlsx`;

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      console.error("XLSX export error:", error);
      return res.status(500).json({ error: "Failed to export XLSX" });
    }
  });

  // ========================================================================
  // TECHNICIAN SYNC ROUTES (Admin)
  // ========================================================================

  app.post("/api/admin/sync-technicians", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const snowflakeData = await fetchTechniciansFromSnowflake();

      let added = 0;
      let updated = 0;
      const syncedLdapIds: string[] = [];

      for (const tech of snowflakeData) {
        const existing = await storage.getTechnicianByLdapId(tech.ldapId);
        await storage.upsertTechnician({
          ldapId: tech.ldapId,
          name: tech.name,
          phone: tech.phone,
          district: tech.district,
          state: tech.state,
          managerName: tech.managerName,
          techUnNo: tech.techUnNo,
          isActive: true,
          lastSyncedAt: new Date(),
        });
        syncedLdapIds.push(tech.ldapId);
        if (existing) {
          updated++;
        } else {
          added++;
        }
      }

      const deactivated = await storage.deactivateTechniciansNotIn(syncedLdapIds);

      return res.status(200).json({
        synced: snowflakeData.length,
        added,
        updated,
        deactivated,
      });
    } catch (error: any) {
      console.error("Snowflake sync error:", error);
      return res.status(500).json({ error: `Sync failed: ${error.message || "Unknown error"}` });
    }
  });

  app.get("/api/tech/lookup-warranty", authenticateToken, async (req, res) => {
    try {
      const so = String(req.query.serviceOrder || "").trim();
      if (!/^\d{4}-\d{8}$/.test(so)) {
        return res.status(400).json({ error: "Invalid service order format" });
      }
      const result = await fetchProcIdForServiceOrder(so);
      const derived = deriveWarrantyFromProcId(result.procId, result.clientNm);
      res.json({
        serviceOrder: so,
        procId: result.procId,
        clientNm: result.clientNm,
        derived,
      });
    } catch (err) {
      console.error("lookup-warranty error:", err);
      res.status(500).json({ error: "Lookup failed" });
    }
  });

  app.post("/api/admin/backfill-proc-ids", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const allSubs = await storage.getAllSubmissions();
      const missing = allSubs.filter(s => !s.procId || !s.clientNm || s.procId === "Not Found" || s.clientNm === "Not Found");

      let updated = 0;
      let failed = 0;

      for (const sub of missing) {
        try {
          const result = await fetchProcIdForServiceOrder(sub.serviceOrder);
          if (result.procId !== "Not Found" || result.clientNm !== "Not Found") {
            await storage.updateSubmission(sub.id, {
              procId: result.procId,
              clientNm: result.clientNm,
            } as any);
            updated++;
          } else {
            await storage.updateSubmission(sub.id, {
              procId: result.procId,
              clientNm: result.clientNm,
            } as any);
            failed++;
          }
        } catch (err) {
          console.error(`Backfill failed for submission ${sub.id}:`, err);
          failed++;
        }
      }

      return res.status(200).json({
        total: allSubs.length,
        needingBackfill: missing.length,
        updated,
        notFound: failed,
      });
    } catch (error: any) {
      console.error("ProcID backfill error:", error);
      return res.status(500).json({ error: `Backfill failed: ${error.message || "Unknown error"}` });
    }
  });

  app.get("/api/admin/technician-metrics", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const info = await storage.getTechnicianSyncInfo();
      return res.status(200).json(info);
    } catch (error) {
      console.error("Technician metrics error:", error);
      return res.status(500).json({ error: "Failed to get technician metrics" });
    }
  });

  app.post("/api/admin/import-users", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const csvPath = path.join(process.cwd(), "attached_assets", "VRS_Auth_Replit_Name_List(Names)_1771470188669.csv");
      const csvContent = fs.readFileSync(csvPath, "utf-8");
      const lines = csvContent.split("\n").filter((line) => line.trim());
      const header = lines[0];
      const dataLines = lines.slice(1);

      let imported = 0;
      let skipped = 0;
      const defaultPassword = await bcryptjs.hash("VRS2026!", 10);

      for (const line of dataLines) {
        const parts = line.split(",");
        if (parts.length < 4) continue;

        const firstName = parts[0].trim();
        const lastName = parts[1].trim();
        const ldapId = parts[2].trim();
        const roleStr = parts[3].trim();

        if (!firstName || !lastName || !ldapId || !roleStr) continue;

        const racId = ldapId;
        const existing = await storage.getUserByRacId(racId);
        if (existing) {
          skipped++;
          continue;
        }

        const name = `${firstName} ${lastName}`;
        const role = roleStr === "Admin" ? "admin" : "vrs_agent";

        const newUser = await storage.createUser({
          email: null,
          password: defaultPassword,
          name,
          role,
          phone: null,
          racId,
          isActive: true,
          firstLogin: true,
          mustChangePassword: true,
        });
        if (role === "admin" || role === "super_admin") {
          await storage.setSpecializations(newUser.id, ALL_DIVISIONS);
        }
        imported++;
      }

      return res.status(200).json({ imported, skipped });
    } catch (error) {
      console.error("CSV import error:", error);
      return res.status(500).json({ error: "Failed to import users" });
    }
  });

  app.post("/api/shsai/query", authenticateToken, requireRole("vrs_agent"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const parsed = z.object({ serviceOrder: z.string().min(1) }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Service order is required" });
      }
      const { serviceOrder } = parsed.data;
      const user = await storage.getUser(authReq.user!.id);
      const agentUserId = user?.racId || authReq.user!.email || authReq.user!.name;
      const result = await queryServiceOrder(agentUserId, serviceOrder);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error("SHSAI query error:", error);
      return res.status(500).json({ success: false, error: "Failed to query SHSAI" });
    }
  });

  app.post("/api/shsai/followup", authenticateToken, requireRole("vrs_agent"), async (req, res) => {
    try {
      const parsed = z.object({
        sessionId: z.string().min(1),
        trackId: z.string().min(1),
        threadId: z.string().min(1),
        deviceInfo: z.string().min(1),
        message: z.string().min(1),
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Session info and message are required" });
      }
      const { sessionId, trackId, threadId, deviceInfo, message } = parsed.data;
      const content = await sendFollowup({ sessionId, trackId, threadId, deviceInfo }, message);
      return res.json({ success: true, data: { content } });
    } catch (error) {
      console.error("SHSAI followup error:", error);
      return res.status(500).json({ success: false, error: "Failed to send follow-up" });
    }
  });

  // ========================================================================
  // FEEDBACK ROUTES
  // ========================================================================

  app.post("/api/feedback", authenticateToken, requireRole("technician"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const user = authReq.user!;

      const feedbackSchema = z.object({
        feedbackType: z.enum(["issue", "improvement", "general"]),
        priority: z.enum(["low", "medium", "high"]),
        description: z.string().min(1, "Description is required").max(2000),
        attachmentUrl: z.string().optional().nullable(),
      });

      const parsed = feedbackSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const fb = await storage.createFeedback({
        technicianId: user.id,
        technicianName: user.name,
        technicianRacId: user.ldapId || "",
        feedbackType: parsed.data.feedbackType,
        priority: parsed.data.priority,
        description: parsed.data.description,
        attachmentUrl: parsed.data.attachmentUrl || null,
        status: "new",
        adminNotes: null,
        resolvedBy: null,
        resolvedAt: null,
      });

      return res.status(201).json({ feedback: fb });
    } catch (error) {
      console.error("Create feedback error:", error);
      return res.status(500).json({ error: "Failed to submit feedback" });
    }
  });

  app.get("/api/feedback", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const list = await storage.getFeedbackList();
      return res.status(200).json({ feedback: list });
    } catch (error) {
      console.error("Get feedback error:", error);
      return res.status(500).json({ error: "Failed to get feedback" });
    }
  });

  app.patch("/api/feedback/:id", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid feedback ID" });

      const updateSchema = z.object({
        status: z.enum(["new", "in_progress", "resolved", "dismissed"]).optional(),
        adminNotes: z.string().optional().nullable(),
      });

      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input" });
      }

      const updates: any = { ...parsed.data };
      if (parsed.data.status === "resolved") {
        updates.resolvedBy = authReq.user!.id;
        updates.resolvedAt = new Date();
      }

      const updated = await storage.updateFeedback(id, updates);
      if (!updated) return res.status(404).json({ error: "Feedback not found" });

      return res.status(200).json({ feedback: updated });
    } catch (error) {
      console.error("Update feedback error:", error);
      return res.status(500).json({ error: "Failed to update feedback" });
    }
  });

  // ========================================================================
  // VIDEO CONVERSION ROUTE
  // ========================================================================

  const convertMediaSchema = z.object({
    objectPath: z.string().min(1),
  });

  app.post("/api/uploads/convert-audio", authenticateToken, requireRole("technician"), async (req, res) => {
    const parsed = convertMediaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "objectPath is required" });
    }

    const { objectPath } = parsed.data;
    const objectStorageService = new ObjectStorageService();
    const inputPath = `/tmp/audio-input-${randomUUID()}`;
    const outputPath = `/tmp/audio-output-${randomUUID()}.mp3`;

    try {
      const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
      const readStream = objectFile.createReadStream();
      const writeStream = createWriteStream(inputPath);
      await pipeline(readStream, writeStream);

      await execFileAsync("ffmpeg", [
        "-i", inputPath,
        "-codec:a", "libmp3lame",
        "-qscale:a", "4",
        "-y",
        outputPath,
      ], { timeout: 60000 });

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const newObjectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      const fileBuffer = fs.readFileSync(outputPath);
      const uploadRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": "audio/mpeg" },
        body: fileBuffer,
      });

      if (!uploadRes.ok) {
        throw new Error(`Upload failed with status ${uploadRes.status}`);
      }

      try { await unlink(inputPath); } catch {}
      try { await unlink(outputPath); } catch {}

      return res.status(200).json({ objectPath: newObjectPath, converted: true });
    } catch (error: any) {
      console.error("Audio conversion error:", error);
      try { await unlink(inputPath); } catch {}
      try { await unlink(outputPath); } catch {}
      return res.status(200).json({ objectPath, converted: false, error: error.message || "Conversion failed" });
    }
  });

  app.post("/api/uploads/convert-video", authenticateToken, requireRole("technician"), async (req, res) => {
    const parsed = convertMediaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "objectPath is required" });
    }

    const { objectPath } = parsed.data;
    const objectStorageService = new ObjectStorageService();
    const inputPath = `/tmp/video-input-${randomUUID()}`;
    const outputPath = `/tmp/video-output-${randomUUID()}.mp4`;

    try {
      const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
      const readStream = objectFile.createReadStream();
      const writeStream = createWriteStream(inputPath);
      await pipeline(readStream, writeStream);

      await execFileAsync("ffmpeg", [
        "-i", inputPath,
        "-c:v", "libx264",
        "-c:a", "aac",
        "-movflags", "+faststart",
        "-preset", "fast",
        "-crf", "23",
        outputPath,
      ], { timeout: 120000 });

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const newObjectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      const fileBuffer = fs.readFileSync(outputPath);
      const uploadRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4" },
        body: fileBuffer,
      });

      if (!uploadRes.ok) {
        throw new Error(`Upload failed with status ${uploadRes.status}`);
      }

      try { await unlink(inputPath); } catch {}
      try { await unlink(outputPath); } catch {}

      return res.status(200).json({ objectPath: newObjectPath, converted: true });
    } catch (error: any) {
      console.error("Video conversion error:", error);
      try { await unlink(inputPath); } catch {}
      try { await unlink(outputPath); } catch {}
      return res.status(200).json({ objectPath, converted: false, error: error.message || "Conversion failed" });
    }
  });


  const VALID_TONES = ["chime", "bell", "pulse", "cascade", "alert"];

  app.get("/api/settings/notification-tone", authenticateToken, async (req: any, res) => {
    try {
      const user = await storage.getUser(req.user.id);
      if (!user) return res.status(404).json({ error: "User not found" });
      res.json({
        tone: user.notificationTone && VALID_TONES.includes(user.notificationTone) ? user.notificationTone : "chime",
        volume: user.notificationVolume ? parseFloat(user.notificationVolume) : 0.5,
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  app.put("/api/settings/notification-tone", authenticateToken, async (req: any, res) => {
    try {
      const { tone, volume } = req.body;
      const updates: Record<string, any> = {};
      if (tone !== undefined) {
        if (!VALID_TONES.includes(tone)) {
          return res.status(400).json({ error: "Invalid tone" });
        }
        updates.notificationTone = tone;
      }
      if (volume !== undefined) {
        const v = Math.max(0, Math.min(1, parseFloat(volume)));
        if (isNaN(v)) return res.status(400).json({ error: "Invalid volume" });
        updates.notificationVolume = String(v);
      }
      if (Object.keys(updates).length > 0) {
        await storage.updateUser(req.user.id, updates);
      }
      const user = await storage.getUser(req.user.id);
      res.json({
        tone: user?.notificationTone || "chime",
        volume: user?.notificationVolume ? parseFloat(user.notificationVolume) : 0.5,
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  // ==========================================================================
  // INTAKE FORM ROUTES — preview pre-filled URL + record submission
  // ==========================================================================
  // These back the IntakeFormTab (third tab in the agent right-side panel,
  // formerly the IntakeFormReviewModal popup — migrated 2026-04-27, see
  // COMMITS.md). The server-side allow-list (server/services/smartsheet.ts
  // ALLOWED_COLUMN_LABELS) is the security boundary — bogus payload keys
  // are silently dropped.

  const intakeFormPayloadSchema = z.object({
    payload: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    smartsheetUrlSubmitted: z.string().url().optional(),
  });

  type LoadOwnedResult =
    | { ok: true; submission: Awaited<ReturnType<typeof storage.getSubmission>> & {} }
    | { ok: false; status: number; error: string };

  async function loadOwnedSubmission(req: AuthenticatedRequest, id: number): Promise<LoadOwnedResult> {
    const submission = await storage.getSubmission(id);
    if (!submission) return { ok: false, status: 404, error: "Submission not found" };
    const isAdmin = req.user!.role === "admin" || req.user!.role === "super_admin";
    if (!isAdmin && submission.assignedTo !== req.user!.id && submission.reviewedBy !== req.user!.id) {
      return { ok: false, status: 403, error: "You don't have access to this submission" };
    }
    return { ok: true, submission };
  }

  // Stage 3 visibility — single source of truth for whether a given submission
  // currently requires the agent to fill the Smartsheet intake form. Used by
  // the agent dashboard to decide whether to render the Stage 3 fallback card
  // (the auto-opened modal post-Authorize is the primary path; this card is
  // the re-open path if the agent dismisses the modal). Per-submission only —
  // the per-agent "intake missing" rollup endpoint was retired 2026-04-26
  // along with the 24h claim gate (Tyler D2, ADR-013).
  //
  // required = true  → render Stage 3 (post-Authorize, no intake row yet)
  // required = false → either not yet authorized, NLA, or already recorded
  //                    (`reason` explains which)
  app.get(
    "/api/submissions/:id/intake-form-status",
    authenticateToken,
    requireRole("vrs_agent", "admin"),
    async (req, res) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const id = parseInt(req.params.id as string);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid submission ID" });

        const owned = await loadOwnedSubmission(authReq, id);
        if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

        const sub = owned.submission;
        const isNla = sub.requestType === "parts_nla";

        // Tyler 2026-04-30 (architect-flagged ordering fix during NLA parity
        // work): existing-row check now runs FIRST. Previously a downstream
        // gate (no_auth_code or not_approved) could short-circuit before
        // this check, which meant a confirmed intake row would still
        // report `recorded:false` and the green banner would never render.
        // The bug was masked on AUTH because AUTH always has both
        // ticketStatus=completed AND authCode by the time confirm is
        // possible — but NLA has no authCode, so the no_auth_code branch
        // would have hidden recorded:true forever. Moving this up is a
        // strict improvement for both branches.
        const existing = await storage.getIntakeFormBySubmission(id);
        if (existing) {
          return res.status(200).json({
            required: false,
            recorded: true,
            reason: "already_recorded",
            intakeForm: existing,
          });
        }

        // Tyler 2026-04-30: NLA parts tickets must fill out the
        // (NLA-specific) Smartsheet intake form just like AUTH tickets.
        // Branch the "is intake required" rules by requestType:
        //
        //   NLA: required when ticketStatus is any post-processing terminal
        //        state set by /process-nla — completed (most success
        //        actions), rejected (nla_reject), invalid (nla_invalid).
        //        NLA tickets do NOT have authCode, so the authCode gate
        //        does not apply. queued (nla_escalate_to_pcard) hands
        //        the ticket off to a P-Card agent and stays not_approved
        //        from the original agent's perspective; the receiving
        //        P-Card agent will see required:true after their own
        //        nla_pcard_confirm sets ticketStatus=completed.
        //
        //   AUTH/Infestation: unchanged behavior — requires both
        //        ticketStatus in {approved, completed} AND a non-empty
        //        authCode. Tyler 2026-04-28 (intake-tab disappearance
        //        bug): the Authorize handler writes ticketStatus
        //        ="completed" — NOT "approved" (schema enum has both;
        //        no code path actually writes "approved"). The "approved"
        //        branch is kept for forward-compat.
        if (isNla) {
          const nlaTerminal =
            sub.ticketStatus === "completed" ||
            sub.ticketStatus === "rejected" ||
            sub.ticketStatus === "rejected_closed" ||
            sub.ticketStatus === "invalid";
          if (!nlaTerminal) {
            return res.status(200).json({ required: false, recorded: false, reason: "not_approved" });
          }
          return res.status(200).json({ required: true, recorded: false });
        }

        if (sub.ticketStatus !== "approved" && sub.ticketStatus !== "completed") {
          return res.status(200).json({ required: false, recorded: false, reason: "not_approved" });
        }
        if (!sub.authCode) {
          return res.status(200).json({ required: false, recorded: false, reason: "no_auth_code" });
        }
        return res.status(200).json({ required: true, recorded: false });
      } catch (error) {
        console.error("Intake form status error:", error);
        return res.status(500).json({ error: "Failed to load intake form status" });
      }
    }
  );

  app.post(
    "/api/submissions/:id/intake-form/preview",
    authenticateToken,
    requireRole("vrs_agent", "admin"),
    async (req, res) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const id = parseInt(req.params.id as string);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid submission ID" });

        const parsed = intakeFormPayloadSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

        const owned = await loadOwnedSubmission(authReq, id);
        if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

        // Tyler 2026-04-29 (data-mapping correction): "IH Unit Number" on the
        // Smartsheet form maps to the District on the ticket itself
        // (`submissions.district_code`), NOT the technician's `tech_un_no`.
        // The previous LDAP-join lookup was sourcing the wrong value. The
        // district code is already on the submission row — no extra DB call,
        // no fallback path needed (a ticket without a district code is a
        // data-quality issue upstream, not something we paper over here).
        const ihUnitNumber: string | null = owned.submission.districtCode ?? null;

        // Tyler 2026-04-26 (post-audit): "VRS Tech ID" Smartsheet column is
        // now sourced from the authenticated agent's racId (LDAP-shaped),
        // not the field tech's LDAP id. One small storage lookup per
        // request — additive, bounded. Wrapped in try/catch so a transient
        // DB hiccup degrades to the technicianLdapId fallback inside
        // buildIntakeFormUrl rather than 500-ing the whole intake flow.
        let authUserRacId: string | null = null;
        try {
          const agent = await storage.getUser(authReq.user!.id);
          authUserRacId = agent?.racId ?? null;
        } catch (lookupErr) {
          console.warn("Intake preview agent racId lookup failed; falling back to technicianLdapId:", lookupErr);
        }

        const { buildIntakeFormUrl } = await import("./services/smartsheet");
        const result = buildIntakeFormUrl({
          submission: { ...owned.submission, ihUnitNumber },
          payload: parsed.data.payload,
          authUserRacId,
        });
        return res.status(200).json(result);
      } catch (error) {
        console.error("Intake form preview error:", error);
        return res.status(500).json({ error: "Failed to build intake form URL" });
      }
    }
  );

  app.post(
    "/api/submissions/:id/intake-form/confirm",
    authenticateToken,
    requireRole("vrs_agent", "admin"),
    async (req, res) => {
      // Tyler 2026-04-28 (Tyler reproduced "Could not record intake / Failed
      // to record intake form" red toast in production after the always-on
      // tab change shipped). The original handler only had a single
      // catch-all that emitted "Intake form confirm error: <stack>" with no
      // breadcrumb of WHICH step (parse, ownership, existing-check, ih-unit
      // lookup, racId lookup, smartsheet builder, DB insert) blew up. The
      // 500 response body says "Failed to record intake form" verbatim so
      // we never knew what to fix.
      //
      // Below we tag every step with `op=...` so a grep of the workflow
      // log instantly tells us where the failure landed. The log lines are
      // also intentionally consumable by the vitest+supertest harness in
      // tests/intake-confirm.test.ts so a regression at any step shows up
      // as a precise assertion failure rather than a generic 500.
      const authReq = req as AuthenticatedRequest;
      const reqId = `intake-confirm:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const tag = (op: string) => `[intake-confirm reqId=${reqId} userId=${authReq.user?.id ?? "?"} subId=${req.params.id} op=${op}]`;
      // Tyler 2026-04-28 (Part B — fixture broadening): dump the FULL
      // request body on EVERY confirm attempt (not just failures) so any
      // future production failure can be reproduced byte-for-byte by the
      // vitest+supertest harness. Auth tokens are in the Authorization
      // header (not the body) so this does NOT leak credentials. The
      // intake_forms.payload column already stores this same data as the
      // permanent audit trail — logging it adds no new sensitive surface.
      try {
        console.log(
          `${tag("entry")} body=${JSON.stringify(req.body).slice(0, 4000)} ua=${(req.headers["user-agent"] ?? "").toString().slice(0, 80)}`
        );
      } catch (logErr) {
        console.warn(`${tag("entry")} body=<unserializable> err=${(logErr as Error)?.message}`);
      }
      try {
        const id = parseInt(req.params.id as string);
        if (isNaN(id)) {
          console.warn(`${tag("parse-id")} status=fail reason=NaN raw=${JSON.stringify(req.params.id)}`);
          return res.status(400).json({ error: "Invalid submission ID" });
        }

        const parsed = intakeFormPayloadSchema.safeParse(req.body);
        if (!parsed.success) {
          console.warn(`${tag("zod-parse")} status=fail err=${parsed.error.errors[0].message} bodyKeys=${JSON.stringify(Object.keys(req.body ?? {}))}`);
          return res.status(400).json({ error: parsed.error.errors[0].message });
        }

        const owned = await loadOwnedSubmission(authReq, id);
        if (!owned.ok) {
          console.warn(`${tag("ownership")} status=fail httpStatus=${owned.status} err=${owned.error}`);
          return res.status(owned.status).json({ error: owned.error });
        }

        // Tyler 2026-04-29 (defense-in-depth gate + race-window fix per
        // architect review): the UI's IntakeFormTab already hides the "I
        // submitted Smartsheet" button until the status endpoint reports
        // required=true (which itself requires ticket_status in
        // {approved, completed}). But a buggy or scripted client could POST
        // here directly. We also have to defend against TWO concurrent
        // confirm requests both passing the duplicate-check before either
        // INSERT lands — without a UNIQUE constraint on
        // intake_forms.submission_id (no schema change allowed today), a
        // naive check-then-insert would race.
        //
        // The pre-flight check below stays outside the transaction so the
        // 409 fast-path doesn't wait on a row lock — but the AUTHORITATIVE
        // existing-check happens inside the transaction below, after a
        // SELECT ... FOR UPDATE on the submissions row serializes any
        // concurrent confirms.
        const preExisting = await storage.getIntakeFormBySubmission(id);
        if (preExisting) {
          console.warn(`${tag("existing-check")} status=duplicate existingId=${preExisting.id} agentId=${preExisting.agentId}`);
          return res.status(409).json({
            error: "Intake form already recorded for this submission",
            code: "ALREADY_RECORDED",
            intakeForm: preExisting,
          });
        }

        // Tyler 2026-04-30: Intake form workflow goes live at 8:00 AM
        // Eastern on May 1, 2026 (when the first technician of the day
        // logs in). Tickets created before this cutoff pre-date the
        // workflow and were handled through a separate prior intake
        // form process. They must NOT accept new intake form submissions
        // here. Cutoff lives in shared/intake-form-config.ts so the
        // admin dashboard column and this gate stay in lockstep.
        const createdAtMs = owned.submission.createdAt
          ? new Date(owned.submission.createdAt as unknown as string).getTime()
          : 0;
        if (createdAtMs < INTAKE_FORM_GO_LIVE_UTC.getTime()) {
          console.warn(`${tag("pre-go-live")} status=fail createdAt=${owned.submission.createdAt} cutoff=${INTAKE_FORM_GO_LIVE_UTC.toISOString()}`);
          return res.status(409).json({
            error: "This ticket pre-dates the intake form workflow — it was handled through the prior process and does not require a new intake form here.",
            code: "PRE_GO_LIVE",
          });
        }

        // Tyler 2026-04-30 (NLA parity): the original AUTH-only check
        // accepted only `approved|completed`. NLA actions can resolve to
        // `completed` (most success actions), `rejected` (nla_reject), or
        // `invalid` (nla_invalid) — and Tyler's design (see
        // processMutation.onSuccess comment) is "agent fills out intake
        // form for every terminal outcome". Branch by requestType so AUTH
        // behavior is unchanged but NLA can confirm intake on any
        // terminal status. `pending` (pre-action) and `queued`
        // (escalated to P-Card — handed off) remain blocked.
        const status = owned.submission.ticketStatus;
        const isNla = owned.submission.requestType === "parts_nla";
        const statusOkForConfirm = isNla
          ? status === "completed" ||
            status === "rejected" ||
            status === "rejected_closed" ||
            status === "invalid"
          : status === "approved" || status === "completed";
        if (!statusOkForConfirm) {
          console.warn(`${tag("not-approved")} status=fail ticketStatus=${status} isNla=${isNla}`);
          return res.status(409).json({
            error: "This ticket has not been processed yet — finish reviewing it before recording the intake form.",
            code: "NOT_APPROVED",
          });
        }

        // Tyler 2026-04-29 (data-mapping correction — see preview route): IH
        // Unit Number is the District on the ticket, not the technician's
        // tech_un_no. Read straight from the submission row — no DB call,
        // so the previous `op=ih-unit-lookup` breadcrumb is no longer
        // reachable (one fewer step that can fail silently).
        const ihUnitNumber: string | null = owned.submission.districtCode ?? null;

        // Tyler 2026-04-26 (post-audit): mirror the preview route so the
        // recorded URL's "VRS Tech ID" comes from the same agent racId
        // lookup the agent saw in the iframe. Same try/catch fallback as
        // the preview route.
        let authUserRacId: string | null = null;
        try {
          const agent = await storage.getUser(authReq.user!.id);
          authUserRacId = agent?.racId ?? null;
        } catch (lookupErr) {
          console.warn(`${tag("racid-lookup")} status=warn err=${(lookupErr as Error)?.message}`);
        }

        let built;
        try {
          const { buildIntakeFormUrl } = await import("./services/smartsheet");
          built = buildIntakeFormUrl({
            submission: { ...owned.submission, ihUnitNumber },
            payload: parsed.data.payload,
            authUserRacId,
          });
        } catch (buildErr) {
          console.error(`${tag("build-url")} status=fail err=${(buildErr as Error)?.message} stack=${(buildErr as Error)?.stack}`);
          return res.status(500).json({ error: "Failed to record intake form", code: "BUILD_URL_ERROR" });
        }

        // Branch is informational only — folded into the payload blob so we
        // can audit which branch the agent saw without adding a column.
        const payloadWithBranch = {
          ...parsed.data.payload,
          __branch: built.branch,
        };

        // Tyler 2026-04-29 (architect-review fix): use the atomic storage
        // method that holds a SELECT ... FOR UPDATE row lock on submissions
        // across the existing-check + status re-check + INSERT. Closes the
        // race window where two simultaneous confirms could both pass the
        // pre-flight check and both insert. The pre-flight checks above
        // (preExisting, status) stay so the common case still gets fast
        // 409s without contending on the row lock.
        let txResult;
        try {
          txResult = await storage.atomicCreateIntakeForm({
            submissionId: id,
            agentId: authReq.user!.id,
            payload: payloadWithBranch as Record<string, string | number>,
            smartsheetUrlSubmitted: parsed.data.smartsheetUrlSubmitted ?? built.url,
          } as any);
        } catch (insertErr) {
          // Tyler 2026-04-28: most likely candidate for the production
          // failure. Emit the full pg error code/detail so we can tell FK
          // violation (23503) from check (23514) from anything else.
          const e = insertErr as any;
          console.error(`${tag("db-insert")} status=fail code=${e?.code} detail=${e?.detail} constraint=${e?.constraint} msg=${e?.message}`);
          return res.status(500).json({ error: "Failed to record intake form", code: "DB_INSERT_ERROR" });
        }

        if (!txResult.ok) {
          if (txResult.reason === "not_found") {
            console.warn(`${tag("tx-not-found")} status=fail`);
            return res.status(404).json({ error: "Submission not found", code: "NOT_FOUND" });
          }
          if (txResult.reason === "not_approved") {
            // Status changed between pre-flight and lock acquisition (e.g.
            // an admin un-approved the ticket). Same 409 the pre-flight
            // returns, just from inside the tx.
            console.warn(`${tag("tx-not-approved")} status=fail ticketStatus=${txResult.ticketStatus}`);
            return res.status(409).json({
              error: "This ticket has not been processed yet — finish reviewing it before recording the intake form.",
              code: "NOT_APPROVED",
            });
          }
          // duplicate — racing confirm beat us inside the lock
          console.warn(`${tag("tx-duplicate")} status=duplicate existingId=${txResult.existing.id}`);
          return res.status(409).json({
            error: "Intake form already recorded for this submission",
            code: "ALREADY_RECORDED",
            intakeForm: txResult.existing,
          });
        }

        const created = txResult.intakeForm;
        console.log(`${tag("ok")} status=success intakeFormId=${created.id} branch=${built.branch}`);
        return res.status(200).json({ intakeForm: created });
      } catch (error) {
        // Last-resort catch — any branch above that throws despite its own
        // try/catch (or a bug we missed) lands here. Log enough context to
        // diagnose without leaking sensitive payload data.
        const e = error as any;
        console.error(`${tag("unhandled")} status=fail name=${e?.name} msg=${e?.message} code=${e?.code} stack=${e?.stack}`);
        return res.status(500).json({ error: "Failed to record intake form", code: "UNHANDLED" });
      }
    }
  );

  // ==========================================================================
  // AGENT EXTERNAL CREDENTIALS — currently scoped to "calculator"
  // ==========================================================================
  // Cleartext is encrypted server-side via server/services/crypto.ts. We never
  // log cleartext. The /reveal endpoint returns it once over HTTPS so the
  // client can postMessage it into the calculator iframe.

  const CALC_SERVICE = "calculator" as const;

  const calcCredentialSchema = z.object({
    username: z.string().min(1).max(200),
    password: z.string().min(1).max(500),
  });

  function maskUsername(username: string): string {
    if (username.length <= 2) return username;
    if (username.length <= 4) return username[0] + "***" + username[username.length - 1];
    return username.slice(0, 2) + "***" + username.slice(-2);
  }

  app.get(
    "/api/agent/credentials/calculator",
    authenticateToken,
    requireRole("vrs_agent", "admin"),
    async (req, res) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const cred = await storage.getAgentCredential(authReq.user!.id, CALC_SERVICE);
        if (!cred) return res.status(200).json({ exists: false });
        return res.status(200).json({ exists: true, usernameHint: cred.usernameHint });
      } catch (error) {
        console.error("Get calculator credential error:", error);
        return res.status(500).json({ error: "Failed to load credential status" });
      }
    }
  );

  app.post(
    "/api/agent/credentials/calculator",
    authenticateToken,
    requireRole("vrs_agent", "admin"),
    async (req, res) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const parsed = calcCredentialSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

        const { encryptCredential } = await import("./services/crypto");
        const enc = encryptCredential(parsed.data.username, parsed.data.password);
        const usernameHint = maskUsername(parsed.data.username);

        await storage.upsertAgentCredential({
          userId: authReq.user!.id,
          service: CALC_SERVICE,
          usernameHint,
          usernameCipher: enc.usernameCipher,
          passwordCipher: enc.passwordCipher,
          iv: enc.iv,
          authTag: enc.authTag,
          scryptSalt: enc.scryptSalt,
        } as any);

        return res.status(200).json({ ok: true, usernameHint });
      } catch (error) {
        console.error("Save calculator credential error:", error);
        return res.status(500).json({ error: "Failed to save calculator credentials" });
      }
    }
  );

  app.delete(
    "/api/agent/credentials/calculator",
    authenticateToken,
    requireRole("vrs_agent", "admin"),
    async (req, res) => {
      try {
        const authReq = req as AuthenticatedRequest;
        await storage.deleteAgentCredential(authReq.user!.id, CALC_SERVICE);
        return res.status(200).json({ ok: true });
      } catch (error) {
        console.error("Delete calculator credential error:", error);
        return res.status(500).json({ error: "Failed to delete calculator credentials" });
      }
    }
  );

  app.post(
    "/api/agent/credentials/calculator/reveal",
    authenticateToken,
    requireRole("vrs_agent", "admin"),
    async (req, res) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const cred = await storage.getAgentCredential(authReq.user!.id, CALC_SERVICE);
        if (!cred) return res.status(200).json({ exists: false });

        const { decryptCredential } = await import("./services/crypto");
        const { username, password } = decryptCredential({
          usernameCipher: cred.usernameCipher,
          passwordCipher: cred.passwordCipher,
          iv: cred.iv,
          authTag: cred.authTag,
          scryptSalt: cred.scryptSalt,
        });
        return res.status(200).json({
          exists: true,
          username,
          password,
          usernameHint: cred.usernameHint,
        });
      } catch (error) {
        console.error("Reveal calculator credential error:", error);
        return res.status(500).json({ error: "Failed to decrypt credentials" });
      }
    }
  );

  // ==========================================================================
  // AGENT INTAKE STATUS — endpoint REMOVED 2026-04-26 (Tyler D2). The 24h
  // claim gate has been retired in favor of an auto-opened intake modal
  // post-Authorize. Per-submission status (used by the Stage 3 fallback
  // card) lives at GET /api/submissions/:id/intake-form-status above.
  // See ADR-013.
  // ==========================================================================

  return httpServer;
}
