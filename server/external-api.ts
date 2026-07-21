// ============================================================================
// EXTERNAL API v1 — shared helpers (key auth, rate limiting, schemas)
// ----------------------------------------------------------------------------
// Machine-to-machine surface for non-Replit external apps. Two keys:
//   • VRS_LOOKUP_API_KEY         — READ  (legacy /nla route + all v1 GETs)
//   • VRS_EXTERNAL_WRITE_API_KEY — WRITE (create submissions, record decisions)
// The v1 write routes are thin adapters over the SAME internal handlers the
// PWA/dashboard use (see routes.ts) so every side effect — SMS, WebSocket
// broadcasts, audit stamps, optimistic locking, micro-cache bumps — stays
// identical. This module only holds the pieces that don't need the
// registerRoutes closure.
// ============================================================================
import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";

// rac_id of the seeded system account decisions are attributed to
// (see ensureExternalApiUser in server/seed.ts). Role vrs_agent with all
// divisions + nla — deliberately NOT admin, so the normal assignment checks
// in /process and /process-nla still apply.
export const EXTERNAL_API_RAC_ID = "VRS_EXTERNAL_API";

// Same timing-safe x-api-key check as the original requireExternalApiKey in
// routes.ts, generalized over the env var so read and write use separate keys.
export function makeExternalKeyMiddleware(envVarName: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = process.env[envVarName];
    if (!expected) {
      console.error(`[external-api] ${envVarName} is not set — refusing request`);
      return res.status(503).json({ error: "External API not configured", code: "NOT_CONFIGURED" });
    }
    const presented = req.header("x-api-key") ?? "";
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    let ok = false;
    if (a.length === b.length) {
      try {
        ok = timingSafeEqual(a, b);
      } catch {
        ok = false;
      }
    } else {
      // Constant-ish timing for the wrong-length case; result discarded.
      try { timingSafeEqual(b, b); } catch {}
      ok = false;
    }
    if (!ok) {
      console.warn(
        `[external-api] 401 unauthorized: ip=${req.ip} ua="${req.header("user-agent") ?? ""}" path=${req.path}`,
      );
      return res.status(401).json({ error: "Invalid or missing API key", code: "UNAUTHORIZED" });
    }
    next();
  };
}

// In-process sliding-window limiter. Single external caller per key class, so
// a global (not per-IP) window is intentional: it bounds total SMS/WS/DB cost
// regardless of how many hosts share the key. Single-VM deployment — no need
// for a shared store.
export function makeExternalRateLimiter(label: string, maxPerWindow: number, windowMs = 60_000) {
  const hits: number[] = [];
  return (_req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    while (hits.length && hits[0] <= now - windowMs) hits.shift();
    if (hits.length >= maxPerWindow) {
      return res.status(429).json({
        error: `Rate limit exceeded — max ${maxPerWindow} external ${label} requests per minute`,
        code: "RATE_LIMITED",
      });
    }
    hits.push(now);
    next();
  };
}

// Minimal res stand-in for internally invoking a handler whose response we
// need to inspect before deciding what to send (auto-claim before decision).
// The claim handler only ever calls res.status(...).json(...).
export function makeCapturedResponse() {
  const captured = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res: res as unknown as Response, captured };
}

export const SERVICE_ORDER_REGEX = /^\d{4}-\d{8}$/;

// ---------------------------------------------------------------------------
// Create-submission contract (v1) — bounded subset of the internal schema.
// Deliberately OMITTED from v1 (security):
//   • photos / photoThumbnails / videoUrls / videoUrl / voiceNoteUrl — external
//     /objects/ path injection could surface other techs' media to agents.
//   • resubmissionOf — resubmission has ownership/chain semantics an external
//     caller can't satisfy.
// The technician is identified by LDAP id and resolved server-side; the
// submission is attributed to the real tech user (SMS goes to them).
// ---------------------------------------------------------------------------
export const externalCreateSubmissionSchema = z.object({
  technicianLdapId: z.string().min(1, "technicianLdapId is required").max(50),
  serviceOrder: z.string().regex(SERVICE_ORDER_REGEX, "Service order must be in format DDDD-SSSSSSSS (e.g., 8175-12345678)"),
  applianceType: z.enum(["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other"]),
  requestType: z.enum(["authorization", "infestation_non_accessible", "parts_nla"]),
  warrantyType: z.enum(["sears_protect", "american_home_shield", "first_american"]).default("sears_protect"),
  warrantyProvider: z.string().max(100).optional(),
  issueDescription: z.string().min(1, "Issue description is required").max(2000, "Description must be 2000 characters or less"),
  estimateAmount: z.string().max(20).optional(),
  // Same JSON-string contract as the internal route: '["PART1","PART2"]' or
  // '{"nla":[...],"available":[...]}'. Content re-validated by the internal
  // handler (1-10 / ≤20 parts etc.).
  partNumbers: z.string().max(2000).optional(),
  // Optional override; defaults to the technician's phone on file.
  phone: z.string().min(10, "Phone must be at least 10 digits").max(20).optional(),
  // Mirrors the internal "Additional Request" flag (second same-day ticket on
  // a return visit). Same server-side guards apply.
  additionalRequest: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Decision contract (v1) — allowlisted subset of internal actions.
// Deferred from v1 (need capabilities/flows the system account doesn't have):
//   approve_replacement_review, b2b_approved_replacement,
//   nla_part_found_vrs_ordered, nla_escalate_to_pcard, nla_pcard_confirm,
//   nla_rfr_eligible.
// rejectedMedia is excluded — external callers have no media context.
// ---------------------------------------------------------------------------
export const EXTERNAL_AUTH_ACTIONS = [
  "approve_submission", // Stage 1 approval on two-stage AHS/First American tickets
  "approve",            // final approval (auth code / RGC path)
  "reject",
  "reject_and_close",
  "invalid",
] as const;

export const EXTERNAL_NLA_ACTIONS = [
  "nla_replacement_submitted",
  "nla_replacement_tech_initiates",
  "nla_part_found_tech_orders",
  "nla_reject",
  "nla_invalid",
] as const;

export const externalDecisionSchema = z.object({
  action: z.enum([...EXTERNAL_AUTH_ACTIONS, ...EXTERNAL_NLA_ACTIONS]),
  agentNotes: z.string().max(4000).optional(),
  technicianMessage: z.string().max(2000).optional(),
  authCode: z.string().max(50).optional(),
  rejectionReasons: z.array(z.string().max(500)).max(20).optional(),
  invalidReason: z.string().max(255).optional(),
  invalidInstructions: z.string().max(2000).optional(),
  nlaFoundPartNumber: z.string().max(100).optional(),
  nlaResolution: z.string().max(2000).optional(),
});

// Bounded projection applied to write-route responses (the internal handlers
// return the full raw row — external callers only ever see this subset; media
// paths, phoneOverride, rejectedMedia, and RGC codes are excluded).
export function projectSubmissionForExternal(s: any) {
  return {
    id: s.id,
    serviceOrder: s.serviceOrder,
    requestType: s.requestType,
    applianceType: s.applianceType,
    ticketStatus: s.ticketStatus,
    stage1Status: s.stage1Status,
    stage2Status: s.stage2Status,
    stage2Outcome: s.stage2Outcome ?? null,
    submissionApproved: s.submissionApproved ?? false,
    warrantyType: s.warrantyType,
    warrantyProvider: s.warrantyProvider ?? null,
    issueDescription: s.issueDescription,
    estimateAmount: s.estimateAmount ?? null,
    partNumbers: s.partNumbers ?? null,
    authCode: s.authCode ?? null,
    rejectionReasons: s.rejectionReasons ?? null,
    invalidReason: s.invalidReason ?? null,
    invalidInstructions: s.invalidInstructions ?? null,
    agentNotes: s.agentNotes ?? null,
    technicianMessage: s.technicianMessage ?? null,
    nlaResolution: s.nlaResolution ?? null,
    nlaFoundPartNumber: s.nlaFoundPartNumber ?? null,
    resubmissionOf: s.resubmissionOf ?? null,
    technicianId: s.technicianId,
    assignedTo: s.assignedTo ?? null,
    createdAt: s.createdAt ?? null,
    claimedAt: s.claimedAt ?? null,
    reviewedAt: s.reviewedAt ?? null,
    statusChangedAt: s.statusChangedAt ?? null,
  };
}

// Query contract for GET /api/external/v1/submissions
export const externalListQuerySchema = z.object({
  requestType: z.enum(["authorization", "infestation_non_accessible", "parts_nla"]).optional(),
  ticketStatus: z.enum(["queued", "pending", "completed", "rejected", "invalid"]).optional(),
  createdAfter: z.coerce.date().optional(),
  createdBefore: z.coerce.date().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
