import { applianceKindSchema, applianceSelectionMatches } from "@shared/appliance-types";
import { retryVrsApprovalNotification } from "./vrs-notification-retry";
import { matchesTicketSearch, ticketAgentIds } from "@shared/ticket-search";
import { releaseProcessedTicketAgent } from "./agent-availability";
import { PostgresDirectResultReceipts } from "./vrs-direct-result-store";
import { automatedCallbackContexts, validateAutomatedApproval, VrsCallbackError } from "./vrs-callback-safety";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "http";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import {
  storage,
  pool,
  db,
  getSubmissionsDataVersion,
} from "./storage";
import { sql, eq, and } from "drizzle-orm";
import { registerObjectStorageRoutes } from "./replit_integrations/object_storage";
import { authenticateToken, requireRole, invalidateUserStatusCache, type AuthenticatedRequest } from "./middleware/auth";
import {
  makeExternalKeyMiddleware,
  makeExternalRateLimiter,
  makeCapturedResponse,
  projectSubmissionForExternal,
  externalCreateSubmissionSchema,
  externalDecisionSchema,
  externalListQuerySchema,
  EXTERNAL_AUTH_ACTIONS,
  EXTERNAL_NLA_ACTIONS,
  EXTERNAL_API_RAC_ID,
  SERVICE_ORDER_REGEX,
} from "./external-api";
import { EXTERNAL_API_DOCS_HTML } from "./external-api-docs";
import { getQueueWaitEnd } from "@shared/nla-ready-for-order";
import {
  registerVrsAiWebhookApi,
  registerVrsSashaApi,
} from "./vrs-sasha-api";
import { createVrsSashaIntake } from "./vrs-sasha-intake";
import {
  buildVrsAiCallResultAgentNotes,
  registerVrsAiCallResultApi,
  type VrsAiCallResultCandidate,
} from "./vrs-ai-call-result";
import { vrsBridgeStore } from "./vrs-sasha-store";
import { registerAhsReviewApi } from "./ahs-review-api";
import {
  buildVrsAuthorizeEnrichmentCandidates,
  dispatchVrsAiForSubmission,
  mapVrsAiWebhookToSubmissionDecision,
  buildVrsAiWebhookAgentNotes,
  processVrsAiWebhookEvent,
} from "./vrs-sasha-queue";
import {
  deliverVrsWebhook,
  sendVrsAuthorizeRequest,
  type VrsWebhookEvent,
} from "./vrs-sasha-contract";
import {
  decryptVrsCallbackSecret,
  encryptVrsCallbackSecret,
} from "./vrs-sasha-secret";
import {
  resolveVrsStageOneBridgeConfig,
  runVrsStageOneRouteGate,
} from "./vrs-stage-one-bridge";
import { verifyUploadOwnership } from "./lib/uploadTokens";
import { issueMediaToken, issueTechHubPhotoToken, verifyTechHubPhotoToken } from "./lib/mediaTokens";
import { timingSafeEqual } from "crypto";
import type { User, Technician } from "@shared/schema";
import { submissions, TECH_PDC_ROOT_CAUSES } from "@shared/schema";
import { deriveWarrantyFromProcId, type WarrantyLookupResponse } from "@shared/warranty";
import {
  parseStoredAhsDetailsDraft,
  type AhsDetailsDraft,
} from "@shared/ahs-details";
import { isValidProvider1099Company } from "@shared/provider1099";
import {
  parseStoredTechApplianceDetails,
  techApplianceDetailsApply,
  techApplianceDetailsSchema,
  type TechApplianceDetails,
} from "@shared/tech-appliance-details";
import {
  is1099PortalEnabled,
  isTechHubPhotosEnabled,
  isVrsBridgePhotoProxyEnabled,
  isVrsAiAppEnrollEnabled,
  isAhsServiceOrderPrefillEnabled,
  isAhsHssomCustomerPrefillEnabled,
  isTechApplianceDetailsEnabled,
} from "./featureFlags";
import {
  registerVrsBridgePhotoProxy,
  browserBridgeStatus,
  fetchAllowedImage,
  isAllowedPhotoUrl,
} from "./vrs-bridge-photo-proxy";
import {
  VrsBridgePhotoStorage,
  VRS_BRIDGE_PHOTO_RETENTION_MS,
} from "./vrs-bridge-photo-storage";
import { canUseVrsAiPilot } from "@shared/vrs-ai-pilot";
import {
  GLOBAL_REPORT_PILOT_SCOPE_ERROR,
  requestsVrsAiPilotScope,
} from "./vrs-ai-pilot-scope";
import {
  STAFF_NOTE_ROLES,
  canAccessTicketNotes,
} from "./submission-note-policy";
import { fetchTechHubPartsPhotosForServiceOrder, TECHHUB_ALLOWED_HOSTS } from "./services/snowflake";
import { normalizeLdapId } from "@shared/ldap";
import {
  INTAKE_FORM_GO_LIVE_UTC,
  isTerminalTicketStatusForIntake,
} from "@shared/intake-form-config";
import { getEtDateString } from "@shared/business-hours";
import * as fs from "fs";
import * as path from "path";
import { createWriteStream, createReadStream } from "fs";
import { unlink } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { fetchAhsServiceOrderPrefill, fetchProcIdForServiceOrder, fetchServiceOrderApplianceType } from "./services/snowflake";
import { lookupWomProductCategory, resolveServiceOrderProduct, type ResolvedServiceOrderProduct } from "./services/wom-work-order";
import {
  applyAhsSubmitPrefill,
  applyTechApplianceDetails,
  draftFromPrevious,
  redactAhsCustomerForTechnician,
  lookupAhsPrefillSources,
  prefilledFieldNames,
} from "./ahs-prefill";
import { lookupHssomOrder } from "./services/hssom-order-lookup";
import { applyProcIdRepair } from "./services/snowflake-lookup";
import { runTechnicianSync } from "./services/tech-sync";
import { isTechPdcConfigured, pushSubmissionToTechPdc, rejectionTimestampOf, TECH_PDC_NOT_CONFIGURED_MESSAGE } from "./services/tech-pdc";
import { seedDatabase } from "./seed";
import {
  loadConfig as loadBusinessHoursConfig,
  saveConfig as saveBusinessHoursConfig,
  getCachedConfig as getCachedBusinessHoursConfig,
  isLoaded as businessHoursIsLoaded,
} from "./business-hours-config";
import { ALL_DAYS as BUSINESS_HOURS_ALL_DAYS } from "@shared/business-hours";
import {
  sendSms,
  sendSmsMessage,
  buildStage1RejectedMessage,
  buildStage1InvalidMessage,
  buildAuthCodeMessage,
  buildReplacementReviewMessage,
  buildB2bReplacementMessage,
  buildNlaApprovalMessage,
  buildRejectAndCloseMessage,
  buildSubmissionReceivedMessage,
  // Tyler 2026-04-29 (Communication Templates): inline SMS strings extracted
  // into named builders so admins can edit them through the new admin page.
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
import { broadcastToDivisionAgents, broadcastToNlaDivisionAgents, broadcastToAdmins, broadcastToAllAgents, broadcastToAgent, broadcastToTechnicians, updateClientStatus, updateClientDivisions, getWarrantyLabel, getDivisionLabel, getLiveSessionCount, forceDisconnectUser } from "./websocket";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Warranty lookup rate limiter — secondary defense-in-depth cap on
// Snowflake traffic from the /api/tech/lookup-warranty endpoint.
// Primary authorization is an ownership check (existing submission).
// This rate limit caps requests even for owned orders to prevent abuse.
// Keyed by user ID; tracks timestamps of lookups within the rolling window.
// ---------------------------------------------------------------------------
const WARRANTY_LOOKUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const WARRANTY_LOOKUP_MAX_PER_WINDOW = 20;
const warrantyLookupLog = new Map<number, number[]>(); // userId -> timestamps

// POST /api/submissions waits at most this long, at the insert, for the
// service order's product lookup it started alongside the ProcID lookup.
const SERVICE_ORDER_PRODUCT_SUBMIT_GRACE_MS = 250;

// ---------------------------------------------------------------------------
// Video conversion helpers (Task: fix admin video playback for failed iPhone
// conversions).
//
// iPhone HEVC/H.265 .mov files (often fragmented MOV with spatial-audio
// tracks, and frequently 10-bit HDR) were failing BOTH ffmpeg passes in
// production. ffmpeg itself pointed at the cause: it could not probe the
// stream with the default "analyzeduration (0) and probesize (5000000)".
// When both passes failed the route stored the ORIGINAL unplayable .mov,
// which Chrome/Edge on Windows cannot decode — that is the "agents can't
// watch some videos" bug.
//
// The hardening below:
//   - large -analyzeduration / -probesize BEFORE -i so ffmpeg can fully
//     probe fragmented/HEVC MOV files
//   - -fflags +genpts to rebuild missing timestamps on fragmented MOV
//   - -pix_fmt yuv420p so 10-bit HEVC HDR is downconverted to 8-bit H.264
//     High@4.0-compatible output that desktop browsers can actually decode
//     (without this, libx264 keeps 10-bit -> High 10 profile -> unplayable)
//   - keeps the audio-stripped retry as a last resort
// ---------------------------------------------------------------------------
const VIDEO_PROBE_FLAGS = [
  "-analyzeduration", "200M",
  "-probesize", "200M",
  "-fflags", "+genpts",
];

// ---------------------------------------------------------------------------
// Tyler 2026-07-07 (perf) — ffmpeg concurrency control.
//
// Prod logs showed convert-video calls taking 60-95s of CPU each, and
// conversions from DIFFERENT technicians overlapping. Each overlap saturated
// the Reserved VM's CPU and dragged every other request (normally 40-150ms)
// up to 1-2.5s for the duration. Two controls fix that:
//
//   1. A global FIFO queue so only ONE ffmpeg transcode runs at a time.
//      A queued request waits for the in-flight one, so a technician's
//      upload may take longer during bursts, but the API stays fast for
//      everyone else. Queue wait + depth are logged for observability.
//   2. Every ffmpeg process is launched through `nice -n 19` so that even
//      the single running transcode yields CPU to the API under load.
//
// The per-technician ownership guard on the routes is unchanged; this is a
// cross-user cap. ffprobe (metadata-only, sub-second) is NOT queued.
// ---------------------------------------------------------------------------
let ffmpegChain: Promise<void> = Promise.resolve();
let ffmpegQueueDepth = 0;

// Backpressure: refuse new conversion requests (BEFORE downloading the
// source file to /tmp) once this many jobs are queued/running. At 60-95s
// per video job, 5 jobs ≈ up to ~8 minutes of wait — beyond that, waiting
// requests would outlive client/proxy HTTP timeouts and half-downloaded
// temp files would pile up on disk. Normal traffic (2-3 overlapping at
// worst today) never hits this; it is a saturation safety valve.
const FFMPEG_MAX_QUEUE = parseInt(process.env.FFMPEG_MAX_QUEUE || "5", 10);

function ffmpegQueueSaturated(): boolean {
  return Number.isFinite(FFMPEG_MAX_QUEUE)
    && FFMPEG_MAX_QUEUE > 0
    && ffmpegQueueDepth >= FFMPEG_MAX_QUEUE;
}

function runFfmpegQueued<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const position = ffmpegQueueDepth;
  ffmpegQueueDepth++;
  const enqueuedAt = Date.now();
  if (position > 0) {
    console.log(`ffmpeg queue: ${label} waiting behind ${position} job(s)`);
  }
  const result = ffmpegChain.then(() => {
    const waitedMs = Date.now() - enqueuedAt;
    if (waitedMs > 1000) {
      console.log(`ffmpeg queue: ${label} starting after ${Math.round(waitedMs / 1000)}s wait`);
    }
    return fn();
  });
  // The chain must never reject, or one failed conversion would wedge the
  // queue for every subsequent caller.
  ffmpegChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result.finally(() => {
    ffmpegQueueDepth--;
  });
}

// Launch ffmpeg at the lowest CPU priority. `nice` is part of coreutils and
// present in both the dev and production Nix images (verified 2026-07-07).
function execFfmpegLowPriority(
  args: string[],
  options: { timeout: number },
): ReturnType<typeof execFileAsync> {
  return execFileAsync("nice", ["-n", "19", "ffmpeg", ...args], options);
}

type VideoConversionResult =
  | { ok: true; mode: "primary" | "audio_stripped" }
  | { ok: false; mode: "failed"; primaryError?: string; fallbackError?: string };

async function convertVideoToPlayableMp4(
  inputPath: string,
  outputPath: string,
): Promise<VideoConversionResult> {
  // Both passes run as ONE queued unit so a fallback retry can't be
  // interleaved with another user's conversion.
  return runFfmpegQueued("video-convert", async () => {
    // Primary pass: keep the first video + first audio stream, transcode to
    // browser-friendly H.264/AAC with an 8-bit pixel format.
    try {
      await execFfmpegLowPriority([
        ...VIDEO_PROBE_FLAGS,
        "-i", inputPath,
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-ignore_unknown",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-ac", "2",
        "-movflags", "+faststart",
        "-preset", "fast",
        "-crf", "23",
        "-y",
        outputPath,
      ], { timeout: 180000 });
      return { ok: true, mode: "primary" } as const;
    } catch (firstErr: any) {
      const primaryError = firstErr?.message || String(firstErr);
      console.warn("Video conversion: first pass failed, retrying without audio:", primaryError);
      // Last-resort fallback: drop audio entirely (e.g. the only audio track is
      // Apple spatial-audio / apac that ffmpeg 6.1.1 cannot decode).
      try {
        await execFfmpegLowPriority([
          ...VIDEO_PROBE_FLAGS,
          "-i", inputPath,
          "-map", "0:v:0",
          "-an",
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          "-movflags", "+faststart",
          "-preset", "fast",
          "-crf", "23",
          "-y",
          outputPath,
        ], { timeout: 180000 });
        return { ok: true, mode: "audio_stripped" } as const;
      } catch (secondErr: any) {
        const fallbackError = secondErr?.message || String(secondErr);
        return { ok: false, mode: "failed", primaryError, fallbackError } as const;
      }
    }
  });
}

// Probe the first video stream's codec + pixel format. Used by the one-time
// recovery endpoint to decide whether an already-stored video needs to be
// re-encoded (anything that isn't 8-bit H.264 is treated as suspect).
async function probeVideoStream(
  inputPath: string,
): Promise<{ codec?: string; pixFmt?: string }> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,pix_fmt",
      "-of", "json",
      inputPath,
    ], { timeout: 60000 });
    const parsed = JSON.parse(stdout);
    const stream = parsed?.streams?.[0] || {};
    return { codec: stream.codec_name, pixFmt: stream.pix_fmt };
  } catch {
    return {};
  }
}

// A video is "browser playable" only if it is 8-bit H.264. HEVC/H.265,
// 10-bit pixel formats (yuv420p10le etc.), and anything we can't probe are
// considered unplayable on the Windows Chrome/Edge desktops VRS staff use.
function isBrowserPlayableVideo(codec?: string, pixFmt?: string): boolean {
  if (codec !== "h264") return false;
  if (pixFmt && pixFmt.includes("10")) return false;
  return true;
}

// Lightweight server-side mirror of client/src/lib/videoUrls.ts. The
// submissions.video_url column holds either a single legacy URL string or a
// JSON-encoded array of object-storage paths.
function parseVideoUrlsServer(value: string | null | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
      }
    } catch {
      // fall through to legacy single-URL handling
    }
  }
  return [trimmed];
}

function serializeVideoUrlsServer(urls: string[]): string | null {
  const cleaned = urls.filter((u) => typeof u === "string" && u.trim().length > 0);
  if (cleaned.length === 0) return null;
  return JSON.stringify(cleaned);
}

const JWT_SECRET = process.env.SESSION_SECRET!;

const registerSchema = z.object({
  email: z.string().email().optional().or(z.literal("")),
  password: z.string().min(6),
  name: z.string().min(1),
  role: z.enum(["technician", "vrs_agent", "admin", "super_admin", "provider_1099"]),
  phone: z.string().optional(),
  racId: z.string().regex(/^[a-zA-Z]+[a-zA-Z0-9]*$/, "LDAP ID / username must be letters and numbers only (e.g., MTHOMA2)").optional().or(z.literal("")),
  companyName: z.string().max(120).optional().nullable().or(z.literal("")),
});

const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

// Tyler 2026-05-01 — Validation schema for PUT /api/business-hours.
// Mirrors `BusinessHoursConfig` in shared/business-hours.ts. Times are
// HH:MM 24h, close > open, openDays must be a non-empty subset of the
// canonical day set. Same shape applies to both `default` and `hvac`
// profiles so admins can't accidentally narrow the data shape per category.
const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}
const businessHoursProfileSchema = z
  .object({
    open: z.string().regex(HHMM_RE, "Open time must be HH:MM (24h)"),
    close: z.string().regex(HHMM_RE, "Close time must be HH:MM (24h)"),
    openDays: z
      .array(z.enum(BUSINESS_HOURS_ALL_DAYS as unknown as [string, ...string[]]))
      .min(1, "Pick at least one open day"),
  })
  .refine(
    (p) => hhmmToMinutes(p.close) > hhmmToMinutes(p.open),
    { message: "Close time must be after open time", path: ["close"] },
  );
const businessHoursConfigSchema = z.object({
  default: businessHoursProfileSchema,
  hvac: businessHoursProfileSchema,
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

// Tyler 2026-05-20 (afternoon) — best-effort write to agent_activity_log.
// Logging must NEVER break the underlying status change, so any failure is
// logged to the server console and swallowed.
async function safeLogActivity(userId: number, eventType: string, details?: Record<string, any>) {
  try {
    await storage.logAgentActivity({ userId, eventType, details: details ?? null } as any);
  } catch (err) {
    console.error(`[activity-log] failed to write ${eventType} for user ${userId}:`, err);
  }
}

// Tyler 2026-05-26 — multi-tab idle-vote tally. Per-user map of
// tabId → vote-expires-at. Each tab posts independently to
// /api/agent/auto-offline; we only demote once every live WS session
// has voted within IDLE_VOTE_TTL_MS. In-memory is fine — votes are
// strictly transient and a server restart just forces another idle
// cycle (≤30 min) before demotion, which is acceptable.
const IDLE_VOTE_TTL_MS = 35 * 60 * 1000;
const idleVotes = new Map<number, Map<string, number>>();
function recordIdleVote(userId: number, tabId: string): { votes: number } {
  const now = Date.now();
  let userVotes = idleVotes.get(userId);
  if (!userVotes) {
    userVotes = new Map();
    idleVotes.set(userId, userVotes);
  }
  for (const [t, exp] of Array.from(userVotes.entries())) {
    if (exp < now) userVotes.delete(t);
  }
  userVotes.set(tabId, now + IDLE_VOTE_TTL_MS);
  return { votes: userVotes.size };
}
function clearIdleVotes(userId: number) {
  idleVotes.delete(userId);
}
function clearIdleVoteForTab(userId: number, tabId: string) {
  const userVotes = idleVotes.get(userId);
  if (!userVotes) return;
  userVotes.delete(tabId);
  if (userVotes.size === 0) idleVotes.delete(userId);
}

// Tyler 2026-05-26 — telemetry write-amplification guard. During a
// broad outage every connected client can churn its WS in a tight
// loop (capped at 30s backoff). Without dedup that's a write per
// client every 30s into agent_activity_log. We coalesce repeated
// events from the same (user, event) inside a short window.
const TELEMETRY_DEDUP_MS = 30 * 1000;
const telemetryLastSeen = new Map<string, number>();
function shouldEmitTelemetry(userId: number, event: string): boolean {
  const key = `${userId}:${event}`;
  const now = Date.now();
  const last = telemetryLastSeen.get(key) ?? 0;
  if (now - last < TELEMETRY_DEDUP_MS) return false;
  telemetryLastSeen.set(key, now);
  if (telemetryLastSeen.size > 5000) {
    for (const [k, t] of Array.from(telemetryLastSeen.entries())) {
      if (now - t > TELEMETRY_DEDUP_MS * 4) telemetryLastSeen.delete(k);
    }
  }
  return true;
}

async function broadcastVrsAvailability() {
  const onlineAgents = await storage.getOnlineAgentCount();
  const queuedTickets = await storage.getQueuedCountAll();
  broadcastToTechnicians({
    type: 'vrs_availability',
    payload: { onlineAgents, queuedTickets }
  });
}

// 1099 provider portal: providers must NEVER see internal warranty details.
// The UI hides them, but the raw API payload must be redacted server-side too.
// Strips warrantyType/warrantyProvider from any submission-shaped object (or
// array of them) before it is returned to a provider_1099-authenticated client.
function redactWarrantyForProvider<T extends Record<string, any>>(role: string, payload: T): T {
  if (role !== "provider_1099" || payload == null) return payload;
  const strip = (row: any) => {
    if (row && typeof row === "object") {
      const { warrantyType, warrantyProvider, ...rest } = row;
      return rest;
    }
    return row;
  };
  return (Array.isArray(payload) ? payload.map(strip) : strip(payload)) as T;
}

// Technician-facing submission payloads: warranty redaction for 1099
// providers, plus the AHS customer PII and dispatch number stripped for every
// technician role (server/ahs-prefill.ts redactAhsCustomerForTechnician).
// techApplianceDetails (grade, color, part function) is not PII and passes
// through untouched.
function redactSubmissionForRole<T extends Record<string, any>>(role: string, payload: T): T {
  const redacted = redactWarrantyForProvider(role, payload);
  if (!["technician", "flexed_technician", "provider_1099"].includes(role) || redacted == null) return redacted;
  const strip = (row: any) =>
    row && typeof row === "object" && typeof row.ahsDetails === "string"
      ? { ...row, ahsDetails: redactAhsCustomerForTechnician(row.ahsDetails) }
      : row;
  return (Array.isArray(redacted) ? redacted.map(strip) : strip(redacted)) as T;
}

type ExecSummaryRouteServices = {
  getLatestExecSummaries: (limit?: number) => Promise<Array<{ id: number }>>;
  retryExecSummaryDelivery: (
    reportId: number,
    options: { resend: boolean; requestKey: string },
  ) => Promise<{ action?: string; delivery?: unknown }>;
  generateAndSendExecSummary: (options: {
    send?: boolean;
    dryRun?: boolean;
    skipIfGeneratedToday?: boolean;
  }) => Promise<{
    report: { id: number; generatedAt: Date | string; summary: unknown } | null;
    email: unknown;
    delivery?: unknown;
    skipped?: string;
  }>;
};
export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await seedDatabase();

  registerObjectStorageRoutes(app);
  const vrsObjectStorageService = new ObjectStorageService();
  const vrsBridgePhotoStorage = new VrsBridgePhotoStorage(vrsObjectStorageService);

  // Tyler 2026-05-12 — lightweight liveness + readiness probe. Returns 200 only
  // if the DB ping completes inside 2s. Used by external uptime monitoring
  // (Replit Scheduled Deployment / UptimeRobot / cron) so a hard-down VM gets
  // a page instead of being discovered by a tech failing to log in. Unauth'd
  // intentionally — the response body carries nothing sensitive.
  // ============================================================================
  // EXTERNAL API (API-KEY AUTH) — for cross-app lookups, e.g. another Replit
  // app asking "did this SO go through the VRS NLA flow?"
  // ----------------------------------------------------------------------------
  // Authentication: every request must carry `x-api-key: <secret>` matching the
  // `VRS_LOOKUP_API_KEY` environment secret. We deliberately do NOT route
  // through `authenticateToken` — these calls are machine-to-machine, no JWT.
  // The key is compared with `timingSafeEqual` over normalized buffers to
  // avoid a length-based timing oracle, and we log the source IP + UA on any
  // 401 for audit. Rotate by replacing the secret in Replit Secrets; clients
  // pick up the new value on their next request (no restart needed on the
  // caller side as long as they read the env per-request).
  // ============================================================================
  const requireExternalApiKey = (req: Request, res: Response, next: NextFunction) => {
    const expected = process.env.VRS_LOOKUP_API_KEY;
    if (!expected) {
      console.error("[external-api] VRS_LOOKUP_API_KEY is not set — refusing all external requests");
      return res.status(503).json({ error: "External API not configured" });
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
      // Still run the compare against a same-length buffer to keep timing
      // roughly constant — result is discarded.
      try { timingSafeEqual(b, b); } catch {}
      ok = false;
    }
    if (!ok) {
      console.warn(
        `[external-api] 401 unauthorized: ip=${req.ip} ua="${req.header("user-agent") ?? ""}" path=${req.path}`,
      );
      return res.status(401).json({ error: "Invalid or missing API key" });
    }
    next();
  };

  app.get("/api/external/service-order/:so/nla", requireExternalApiKey, async (req, res) => {
    const soParam = req.params.so;
    if (typeof soParam !== "string" || !/^\d{4}-\d{8}$/.test(soParam)) {
      return res.status(400).json({
        error: "Service order must be in format DDDD-SSSSSSSS (e.g., 8175-12345678)",
      });
    }
    const so = soParam;
    try {
      const rows = await storage.getNlaSubmissionsByServiceOrder(so);
      return res.json({
        serviceOrder: so,
        followedNlaProcess: rows.length > 0,
        nlaSubmissionCount: rows.length,
        submissions: rows,
      });
    } catch (err) {
      console.error(`[external-api] GET /api/external/service-order/${so}/nla failed:`, err);
      return res.status(500).json({ error: "Lookup failed" });
    }
  });

  app.get("/api/healthz", async (_req, res) => {
    const start = Date.now();
    let dbOk = false;
    let dbMs: number | null = null;
    let pingTimer: NodeJS.Timeout | undefined;
    try {
      const pingStart = Date.now();
      await Promise.race([
        db.execute(sql`SELECT 1`),
        new Promise((_, reject) => {
          pingTimer = setTimeout(() => reject(new Error("db ping >2s")), 2000);
        }),
      ]);
      dbMs = Date.now() - pingStart;
      dbOk = true;
    } catch {
      dbOk = false;
    } finally {
      if (pingTimer) clearTimeout(pingTimer);
    }
    const mem = process.memoryUsage();
    const body = {
      ok: dbOk,
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      dbMs,
      checkMs: Date.now() - start,
    };
    res.status(dbOk ? 200 : 503).json(body);
  });

  // Self-registration is disabled. Technicians authenticate passwordlessly at
  // POST /api/auth/tech-login, which verifies the LDAP ID against the managed
  // technicians directory before issuing a token.
  app.post("/api/auth/register", (_req, res) => {
    return res.status(403).json({ error: "Self-registration is not available. Technicians sign in via LDAP ID." });
  });

  // Public runtime config — lets the client hide feature-flagged affordances
  // (e.g. the 1099 provider portal) without a rebuild.
  app.get("/api/config", (_req, res) => {
    res.json({
      portal1099Enabled: is1099PortalEnabled(),
      techHubPhotosEnabled: isTechHubPhotosEnabled(),
      vrsBridgePhotoProxyEnabled: isVrsBridgePhotoProxyEnabled(),
      vrsAiAppEnrollEnabled: isVrsAiAppEnrollEnabled(),
      ahsServiceOrderPrefill: isAhsServiceOrderPrefillEnabled(),
      ahsHssomCustomerPrefill: isAhsHssomCustomerPrefillEnabled(),
      techApplianceDetailsEnabled: isTechApplianceDetailsEnabled(),
    });
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

      // 1099 provider portal is feature-flagged. When disabled, provider
      // accounts cannot authenticate (this gates every downstream provider
      // route since no provider token can be issued).
      if (user.role === "provider_1099" && !is1099PortalEnabled()) {
        return res.status(403).json({ error: "Invalid credentials" });
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

  // Simple in-memory rate limiter for tech-login to mitigate brute-force
  // enumeration of LDAP IDs. Keyed by IP: max 10 attempts per 15 minutes.
  const techLoginAttempts = new Map<string, { count: number; windowStart: number }>();
  const TECH_LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const TECH_LOGIN_MAX_ATTEMPTS = 10;

  function checkTechLoginRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = techLoginAttempts.get(ip);
    if (!entry || now - entry.windowStart > TECH_LOGIN_WINDOW_MS) {
      techLoginAttempts.set(ip, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    if (entry.count > TECH_LOGIN_MAX_ATTEMPTS) {
      return false;
    }
    return true;
  }

  const techLoginSchema = z.object({
    ldapId: z.string().min(1, "LDAP ID is required"),
  });

  // Passwordless technician login: submit LDAP ID → issue JWT directly.
  // (SMS OTP verification is temporarily disabled per request.)
  app.post("/api/auth/tech-login", async (req, res) => {
    try {
      const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      if (!checkTechLoginRateLimit(clientIp)) {
        return res.status(429).json({ error: "Too many login attempts. Please try again in 15 minutes." });
      }

      const parsed = techLoginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const ldapId = normalizeLdapId(parsed.data.ldapId);
      if (!/^[a-z][a-z0-9]*$/.test(ldapId)) {
        return res.status(400).json({ error: "Invalid LDAP ID format" });
      }
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
    } catch (error: unknown) {
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
    applianceKind: applianceKindSchema.nullish(),
    requestType: z.enum(["authorization", "infestation_non_accessible", "parts_nla"]),
    warrantyType: z.enum(["sears_protect", "american_home_shield", "first_american"]).default("sears_protect"),
    warrantyProvider: z.string().optional(),
    issueDescription: z.string().min(1, "Issue description is required").max(2000, "Description must be 2000 characters or less"),
    originalDescription: z.string().optional(),
    aiEnhanced: z.boolean().optional(),
    estimateAmount: z.string().optional(),
    partNumbers: z.string().optional(),
    photos: z.string().optional(),
    // Tyler 2026-07-08 — client-generated photo thumbnails. JSON map of
    // { fullPhotoPath: thumbPath } where both sides are /objects/ paths.
    // Thumbs are best-effort: a missing/partial map is fine (UI falls back
    // to the full image). Validated as a parseable object of /objects/
    // string pairs so junk can't land in the column — same trust bar as
    // `photos` (paths are not ownership-verified at submit; access is
    // enforced at read time by the media-token route).
    photoThumbnails: z.string().optional().refine((val) => {
      if (!val) return true;
      try {
        const parsed = JSON.parse(val);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
        return Object.entries(parsed).every(
          ([k, v]) => typeof k === "string" && k.startsWith("/objects/")
            && typeof v === "string" && v.startsWith("/objects/"),
        );
      } catch {
        return false;
      }
    }, "photoThumbnails must be a JSON object mapping /objects/ paths to /objects/ paths"),
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
    // Task — explicit "Additional Request" flag. When true, the tech has
    // deliberately confirmed (via the Additional Request confirmation dialog)
    // that they want a second same-day ticket for this service order on a
    // return visit. This relaxes the normal same-day duplicate block for
    // RESOLVED prior tickets, but still refuses while any ticket for the SO
    // is currently ACTIVE and never overrides the permanent rejected_closed
    // block. Transient request flag only — not persisted as a column.
    additionalRequest: z.boolean().optional(),
    // No ahsDetails: the technician no longer enters AHS details. An older
    // cached client may still send them; zod strips the unknown key, so they
    // can neither fail the submission nor be stored. The server builds the
    // draft itself (below) and the VRS manager completes it at Stage 1
    // (server/ahs-review-api.ts).
    // Appliance grade, color and part function (shared/tech-appliance-details.ts),
    // sent by the tech form on AHS / First American authorization tickets.
    // Optional here (older cached clients don't send it; the form enforces
    // it); null counts as absent. Kept below only while
    // TECH_APPLIANCE_DETAILS_ENABLED is on and the server-derived warranty
    // and request type call for it; otherwise dropped silently.
    techApplianceDetails: techApplianceDetailsSchema.nullish(),
  }).refine(applianceSelectionMatches, {
    message: "Appliance selection does not match its routing category",
    path: ["applianceKind"],
  });

  // 2026-05-11 — Field tech (Mike, AHS, SO 8420-13676372) reported a
  // "Submission Failed" toast whose body was Replit's edge-proxy HTML
  // 403 page. The corresponding POST /api/submissions never appeared in
  // the deployment logs, suggesting the request was rejected before
  // Express. This pre-route middleware logs every POST /api/submissions
  // entry (auth header presence, content-length, user-agent) so that if
  // it happens again we can confirm whether the request actually
  // reached our app and rule the edge layer in or out.
  app.post("/api/submissions", (req, _res, next) => {
    const auth = req.headers["authorization"];
    const cl = req.headers["content-length"] || "-";
    const ua = (req.headers["user-agent"] || "-").toString().slice(0, 80);
    console.log(
      `[submit-entry] POST /api/submissions reached Express ` +
        `auth=${auth ? "present" : "MISSING"} content-length=${cl} ua="${ua}"`,
    );
    next();
  });

  // Named handler (2026-07-21): also invoked by the external v1 API adapter
  // (POST /api/external/v1/submissions) with an impersonated technician user.
  // Body must stay byte-identical to the original inline handler — every side
  // effect (Snowflake lookup, SMS, WS broadcast, micro-cache bump) is shared.
  const createSubmissionHandler = async (
    req: Request,
    res: Response,
    internalOptions?: {
      ignoreLegacyDuplicateSubmissionIds?: readonly number[];
      // SASHA intake creates its own bridge row right after this handler.
      skipAppVrsAiEnroll?: boolean;
    },
  ) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const parsed = createSubmissionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }
      // AHS draft (shared/ahs-review.ts): for an authorization ticket whose
      // final warranty is AHS, the server stores what the service-order
      // lookups found and the VRS manager completes it at Stage 1. Only while
      // VRS_AI_APP_ENROLL_ENABLED is on; SASHA intake brings its own VRS AI
      // request. applianceType (the division) stays the tech's choice.
      const wantsAhsDraft =
        isVrsAiAppEnrollEnabled() &&
        parsed.data.requestType === "authorization" &&
        !internalOptions?.skipAppVrsAiEnroll;

      const user = await storage.getUser(authReq.user!.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // 1099 provider portal restriction: providers handle non-Sears
      // (AHS / First American) warranty work only and never NLA. NLA Parts
      // requests are not available to providers — reject server-side even if
      // the (hidden-in-UI) option somehow slipped through.
      const isProvider1099 = user.role === "provider_1099";
      // This option is private to the bridge intake closure below. It is never
      // parsed from a public request body and excludes only durable prior V8
      // retryable-failure ticket IDs from legacy same-day duplicate checks.
      const excludedLegacyDuplicateSubmissionIds =
        internalOptions?.ignoreLegacyDuplicateSubmissionIds ?? [];
      if (isProvider1099 && !is1099PortalEnabled()) {
        return res.status(403).json({ error: "The 1099 Provider Portal is not enabled in this environment." });
      }
      if (isProvider1099 && parsed.data.requestType === "parts_nla") {
        return res.status(400).json({ error: "NLA Parts requests are not available through the 1099 provider portal." });
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
      const recentDup = await storage.findRecentDuplicateSubmission(
        parsed.data.serviceOrder,
        user.id,
        60,
        { excludeSubmissionIds: excludedLegacyDuplicateSubmissionIds },
      );
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
        return res.status(200).json({ submission: redactSubmissionForRole(user.role, recentDup) });
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

      // Task — explicit "Additional Request" flag. When the tech has
      // deliberately confirmed they want a second same-day ticket for this
      // SO (return visit / separate authorization), this is true. It relaxes
      // the normal same-day duplicate block for RESOLVED prior tickets, but
      // never overrides the permanent rejected_closed block above and still
      // refuses while any ticket for the SO is currently ACTIVE.
      const isAdditionalRequest = parsed.data.additionalRequest === true;

      if (!parsed.data.resubmissionOf) {
        if (isAdditionalRequest) {
          // Explicit Additional Request: allowed ONLY when nothing is
          // currently active (queued / being reviewed / approved awaiting
          // auth code). Completed & rejected prior tickets are "resolved" and
          // intentionally do NOT block here — that is the whole purpose of
          // this path. The rejected_closed permanent block above still applies.
          const activeCheck = await storage.hasActiveSubmissionForServiceOrder(
            parsed.data.serviceOrder,
            user.id,
            ["queued", "pending"],
          );
          if (activeCheck.exists) {
            const statusLabels: Record<string, string> = {
              queued: "in the queue waiting for an agent",
              pending: "currently being reviewed by an agent",
            };
            const statusMsg = statusLabels[activeCheck.status || ""] || "still active";
            const whoMsg = activeCheck.sameTech
              ? "You already have a submission"
              : "Another technician already has a submission";
            console.warn(
              `[additional-request-block] POST /api/submissions: tech=${user.id} blocked on SO=${parsed.data.serviceOrder} ` +
              `(existing tech=${activeCheck.technicianId} status=${activeCheck.status} sameTech=${activeCheck.sameTech})`
            );
            return res.status(409).json({
              error: `${whoMsg} for SO# ${parsed.data.serviceOrder} that is ${statusMsg}. An Additional Request can only be created once the current ticket is fully resolved.`,
            });
          }
        } else {
          // Normal new submission — unchanged. One ticket per service order
          // per calendar day (queued / pending / completed all block).
          // Tyler 2026-05-27 — pass callerTechnicianId so the error message
          // can distinguish "you already submitted this" from "another tech
          // already submitted this same SO today". Per VRS: one ticket per
          // service order per calendar day regardless of which tech submits.
          const activeCheck = await storage.hasActiveSubmissionForServiceOrder(
            parsed.data.serviceOrder,
            user.id,
            undefined,
            { excludeSubmissionIds: excludedLegacyDuplicateSubmissionIds },
          );
          if (activeCheck.exists) {
            const statusLabels: Record<string, string> = {
              queued: "in the queue waiting for an agent",
              pending: "currently being reviewed by an agent",
              completed: "already approved today",
            };
            const statusMsg = statusLabels[activeCheck.status || ""] || "already active";
            const whoMsg = activeCheck.sameTech
              ? "You already have a submission"
              : "Another technician already has a submission";
            console.warn(
              `[duplicate-block] POST /api/submissions: tech=${user.id} blocked on SO=${parsed.data.serviceOrder} ` +
              `(existing tech=${activeCheck.technicianId} status=${activeCheck.status} sameTech=${activeCheck.sameTech})`
            );
            // canRequestAdditional tells the client whether the explicit
            // Additional Request path can clear this block. Only a RESOLVED
            // prior ticket qualifies — here that's a same-day completed one
            // (rejected isn't in this block's status set; it uses Resubmit).
            // An active queued/pending ticket must be waited out instead.
            return res.status(409).json({
              error: `${whoMsg} for SO# ${parsed.data.serviceOrder} that is ${statusMsg}. Only one ticket per service order per day is allowed. If the prior ticket was rejected, use the Resubmit flow on that ticket.`,
              canRequestAdditional: activeCheck.status === "completed",
            });
          }
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
        // Tyler 2026-05-20 (afternoon) — Replacement Review is terminal in
        // this app. The warranty company handles the replacement process
        // externally; resubmitting here would be confusing and re-open a
        // ticket VRS already handed off. If the tech needs further action
        // they call VRS or submit a brand-new ticket.
        if ((originalSub as any).replacementReviewRecommended) {
          return res.status(400).json({ error: "This ticket was placed into Replacement Review and cannot be resubmitted. The warranty company is handling the replacement. If you need further help, contact VRS or submit a new ticket." });
        }
        // Task #12 — B2B Approved Replacement is terminal for the same reason
        // as Replacement Review: the warranty company is handling the
        // replacement externally, so re-opening this ticket would be confusing.
        if ((originalSub as any).b2bApprovedReplacement) {
          return res.status(400).json({ error: "This ticket was finalized as a B2B Approved Replacement and cannot be resubmitted. The warranty company is handling the replacement. If you need further help, contact VRS or submit a new ticket." });
        }
        // Tyler 2026-05-27 — Enforce the stated invariant: the resubmit
        // path is the ONLY same-day-same-SO exception, and it exists
        // solely for rejected tickets. Without this guard a tech could
        // pass `resubmissionOf` pointing at their own queued/pending/
        // completed ticket and bypass the cross-tech same-day block
        // (both pre-check and tx conflict check skip when
        // resubmissionOf is set). Architect-flagged 2026-05-27.
        if (originalSub.ticketStatus !== "rejected") {
          return res.status(400).json({
            error: `Only rejected tickets can be resubmitted (this one is "${originalSub.ticketStatus}"). If your prior ticket was not rejected, wait for the current ticket to be reviewed or contact VRS.`,
          });
        }
        // Task — close the same-day duplicate gap on the resubmission path.
        // Refuse the resubmission if any ticket for this SO is currently
        // ACTIVE (queued / being reviewed / approved awaiting auth). The
        // original being resubmitted is rejected (vetted just above) so it is
        // never in the active set; this catches the case where a fresh
        // submission for the same SO became active in parallel — the prod
        // duplicate SO 7088-13792068 (rejected → fresh ticket active →
        // resubmission, both worked & approved). Mirrors the atomic re-check
        // inside createSubmissionWithIdempotency for the race window.
        const resubActive = await storage.hasActiveSubmissionForServiceOrder(
          parsed.data.serviceOrder,
          user.id,
          ["queued", "pending"],
        );
        if (resubActive.exists) {
          const statusLabels: Record<string, string> = {
            queued: "in the queue waiting for an agent",
            pending: "currently being reviewed by an agent",
          };
          const statusMsg = statusLabels[resubActive.status || ""] || "still active";
          const whoMsg = resubActive.sameTech
            ? "You already have a submission"
            : "Another technician already has a submission";
          console.warn(
            `[resubmit-duplicate-block] POST /api/submissions: tech=${user.id} blocked resubmission on SO=${parsed.data.serviceOrder} ` +
            `(existing tech=${resubActive.technicianId} status=${resubActive.status} sameTech=${resubActive.sameTech})`
          );
          return res.status(409).json({
            error: `${whoMsg} for SO# ${parsed.data.serviceOrder} that is ${statusMsg}. Only one ticket per service order can be active at a time — wait for it to be reviewed before resubmitting.`,
          });
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

      // 2026-05-06 (VRS team request): resubmissions ALWAYS go to the queue.
      // Previously, a resubmission auto-assigned back to the original
      // reviewing agent if their `agentStatus` was anything other than
      // "offline" (i.e. "online" or "working"). VRS reported this caused
      // resubmissions to land on busy agents already mid-ticket — example:
      // ticket #13670462 was reassigned to Brandon while he was working a
      // different ticket, slowing it down. The queue model lets ANY available
      // agent pick up a resubmission, which routes it to whoever is free
      // first instead of pinning to the prior reviewer. We still notify the
      // original reviewing agent informationally below (so they see "your
      // tech resubmitted" in their UI) but the ticket itself is unassigned.
      let originalAgent: number | null = null; // assignment intentionally disabled
      let priorReviewer: number | null = null; // for informational notification only
      let previousAhsDraft: AhsDetailsDraft | null = null;
      let previousTechApplianceDetails: TechApplianceDetails | null = null;
      if (parsed.data.resubmissionOf) {
        const origSub = await storage.getSubmission(parsed.data.resubmissionOf);
        if (origSub) {
          priorReviewer = origSub.reviewedBy || origSub.stage1ReviewedBy || null;
          previousAhsDraft = parseStoredAhsDetailsDraft(origSub.ahsDetails);
          previousTechApplianceDetails = parseStoredTechApplianceDetails(origSub.techApplianceDetails);
        }
      }

      // AHS service-order prefill (server/ahs-prefill.ts): Snowflake and the
      // HSSOM Order Lookup. Each settles within ~5s and never rejects, so they
      // can never block or fail the submission. (HSSOM is asked a second time,
      // another ~5s at most, when Snowflake finds the order under a unit other
      // than the typed district; lookupAhsPrefillSources.) lookupHssomOrder answers
      // unavailable while its own flag is off. Started alongside the ProcID
      // lookup when the tech picked AHS; otherwise only once the ProcID
      // derivation says AHS (below).
      const startAhsPrefillLookup = () => lookupAhsPrefillSources(parsed.data.serviceOrder, {
        snowflake: isAhsServiceOrderPrefillEnabled() ? fetchAhsServiceOrderPrefill : null,
        hssom: lookupHssomOrder,
      });
      const earlyAhsPrefillLookup = wantsAhsDraft && parsed.data.warrantyType === "american_home_shield"
        ? startAhsPrefillLookup()
        : null;

      // The service order's product (WOM Product Category, else Snowflake
      // HS_SP_CD; resolveServiceOrderProduct), looked up here on the server:
      // nothing the client sends is used. Started alongside the ProcID lookup
      // and given at most SERVICE_ORDER_PRODUCT_SUBMIT_GRACE_MS more at the
      // insert (after a form lookup every source is cached, so it is already
      // there): settled, it is stored with the row; still pending, the row is
      // patched once it settles. It never rejects (the catch is a backstop),
      // so it cannot block or fail a submit.
      let settledServiceOrderProduct: ResolvedServiceOrderProduct | undefined;
      const serviceOrderProductLookup = Promise.resolve()
        .then(() => resolveServiceOrderProduct(parsed.data.serviceOrder, {
          snowflake: fetchServiceOrderApplianceType,
          wom: lookupWomProductCategory,
        }))
        .catch((): ResolvedServiceOrderProduct => ({}))
        .then((value) => {
          settledServiceOrderProduct = value;
          return value;
        });

      const procIdResult = await fetchProcIdForServiceOrder(parsed.data.serviceOrder);
      if (procIdResult.status === "LOOKUP_UNAVAILABLE") {
        return res.status(503).set("Retry-After", "5").json({
          error: "Service order lookup temporarily unavailable. Please try again.",
          code: "LOOKUP_UNAVAILABLE", retryable: true,
        });
      }

      const derivedWarranty = deriveWarrantyFromProcId(procIdResult.procId, procIdResult.clientNm);

      // 1099 provider portal: warranty is ALWAYS derived server-side for
      // providers (they never see or pick it). Providers may only submit
      // non-Sears (AHS / First American) calls, so we require a successful
      // non-Sears derivation. Sears-family (sears_protect) calls and service
      // orders we cannot positively classify are rejected with a generic
      // message — this both excludes Sears-family work and guarantees no
      // warranty detail leaks back to the provider.
      if (isProvider1099) {
        if (!derivedWarranty || derivedWarranty.warrantyType === "sears_protect") {
          return res.status(400).json({ error: "This service order isn't eligible for submission through the 1099 provider portal. Please verify the service order number." });
        }
      }

      const finalWarrantyType = derivedWarranty ? derivedWarranty.warrantyType : parsed.data.warrantyType;
      const finalWarrantyProvider = derivedWarranty ? derivedWarranty.warrantyProvider : (parsed.data.warrantyProvider || null);
      if (derivedWarranty && derivedWarranty.warrantyType !== parsed.data.warrantyType) {
        console.log(`[warranty-derive] SO ${parsed.data.serviceOrder}: tech selected ${parsed.data.warrantyType}, derived ${derivedWarranty.warrantyType} from ${derivedWarranty.source} (procId=${procIdResult.procId}, clientNm=${procIdResult.clientNm})`);
      }

      // Tech appliance details: kept only for the server-derived warranty.
      const sentTechApplianceDetails = parsed.data.techApplianceDetails ?? null;
      const techApplianceDetails =
        sentTechApplianceDetails &&
        isTechApplianceDetailsEnabled() &&
        techApplianceDetailsApply(finalWarrantyType, parsed.data.requestType)
          ? sentTechApplianceDetails
          : null;
      if (sentTechApplianceDetails && !techApplianceDetails) {
        console.log(
          `[tech-appliance-details] SO=${parsed.data.serviceOrder} dropped ` +
          `(enabled=${isTechApplianceDetailsEnabled()} warranty=${finalWarrantyType} request=${parsed.data.requestType})`,
        );
      }

      // The draft: dispatch number, brand / model / serial, customer name and
      // address, the parts on the order (and purchaseYear when the age is
      // blank). A resubmission starts from the previous ticket's details;
      // lookups fill only blanks. Then the tech's appliance grade, color and
      // part 1's function (whatever the lookups returned). Stored even when
      // nothing was found ({}), so the VRS manager gets the editor. Logs
      // field names, never values.
      let ahsDraft: AhsDetailsDraft | null = null;
      if (wantsAhsDraft && finalWarrantyType === "american_home_shield") {
        const sources = await (earlyAhsPrefillLookup ?? startAhsPrefillLookup());
        ahsDraft = applyAhsSubmitPrefill(draftFromPrevious(previousAhsDraft), sources, {
          finalWarrantyType,
          derivedWarrantyType: derivedWarranty?.warrantyType,
        });
        if (techApplianceDetails) {
          ahsDraft = applyTechApplianceDetails(ahsDraft, techApplianceDetails, previousTechApplianceDetails);
        }
        console.log(
          `[ahs-prefill] submit SO=${parsed.data.serviceOrder} snowflake=${sources.snowflake.status} ` +
          `hssom=${sources.hssom.status} filled=${prefilledFieldNames(ahsDraft).join(",") || "none"} ` +
          `tech=${techApplianceDetails ? "applianceGrade,applianceColor,partFunction" : "none"}`,
        );
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
      if (settledServiceOrderProduct === undefined) {
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          serviceOrderProductLookup,
          new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, SERVICE_ORDER_PRODUCT_SUBMIT_GRACE_MS); }),
        ]);
        clearTimeout(graceTimer);
      }
      const idempResult = await storage.createSubmissionWithIdempotency({
        technicianId: user.id,
        racId: user.racId || "",
        technicianLdapId: authReq.user?.ldapId || null,
        phoneOverride: req.body.phoneOverride || null,
        phone: parsed.data.phone,
        serviceOrder: parsed.data.serviceOrder,
        districtCode: parsed.data.serviceOrder.split("-")[0],
        applianceType: parsed.data.applianceType,
        applianceKind: parsed.data.applianceKind ?? null,
        requestType: parsed.data.requestType,
        warrantyType: finalWarrantyType,
        warrantyProvider: finalWarrantyProvider,
        issueDescription: parsed.data.issueDescription,
        originalDescription: (parsed.data.aiEnhanced && parsed.data.originalDescription) ? parsed.data.originalDescription : null,
        aiEnhanced: (parsed.data.aiEnhanced && parsed.data.originalDescription) ? true : false,
        // AHS tickets fill these from their details once the VRS manager
        // saves them at Stage 1 (server/ahs-review-api.ts).
        estimateAmount: parsed.data.estimateAmount || null,
        partNumbers: parsed.data.partNumbers || null,
        ahsDetails: ahsDraft ? JSON.stringify(ahsDraft) : null,
        techApplianceDetails: techApplianceDetails ? JSON.stringify(techApplianceDetails) : null,
        serviceOrderProduct: settledServiceOrderProduct?.serviceOrderProduct
          ? JSON.stringify(settledServiceOrderProduct.serviceOrderProduct)
          : null,
        photos: parsed.data.photos || null,
        photoThumbnails: parsed.data.photoThumbnails || null,
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
      }, 60, {
        additionalRequest: isAdditionalRequest,
        excludeSubmissionIds: excludedLegacyDuplicateSubmissionIds,
      });
      // Tyler 2026-05-27 — inside-tx cross-tech race-loser path. The
      // pre-check at line ~796 catches sequential dupes; this fires only
      // when a sibling request from another tech beat us through the
      // pre-check before either committed. Return 409 with the same
      // copy as the pre-check so the tech sees a consistent message.
      if (idempResult.blockedByOther) {
        console.warn(
          `[duplicate-block-tx] POST /api/submissions: race-loss tech=${user.id} SO=${parsed.data.serviceOrder} ` +
          `(winning tech=${idempResult.blockingTechnicianId} status=${idempResult.blockingStatus})`
        );
        const statusLabels: Record<string, string> = {
          queued: "in the queue waiting for an agent",
          pending: "currently being reviewed by an agent",
          completed: "already approved today",
        };
        const statusMsg = statusLabels[idempResult.blockingStatus || ""] || "already active";
        return res.status(409).json({
          error: `Another technician already has a submission for SO# ${parsed.data.serviceOrder} that is ${statusMsg}. Only one ticket per service order per day is allowed. If the prior ticket was rejected, use the Resubmit flow on that ticket.`,
        });
      }
      const submission = idempResult.submission!;
      if (idempResult.wasDuplicate) {
        console.warn(
          `[idempotency-tx] Race detected — returning existing submission ${submission.id} ` +
          `for tech=${user.id} SO=${parsed.data.serviceOrder}. Skipping SMS / broadcast / Smartsheet.`
        );
        return res.status(200).json({ submission: redactSubmissionForRole(user.role, submission) });
      }

      // Still looking the product up at insert: store it when it settles.
      // Logs the ticket ID and the error message only.
      if (settledServiceOrderProduct === undefined) {
        const submissionId = submission.id;
        void serviceOrderProductLookup
          .then(({ serviceOrderProduct }) => serviceOrderProduct
            ? storage.updateSubmission(submissionId, { serviceOrderProduct: JSON.stringify(serviceOrderProduct) })
            : undefined)
          .catch((err) => {
            console.warn(`[service-order-product] submission=${submissionId} late store failed: ${err instanceof Error ? err.message : String(err)}`);
          });
      }

      // No VRS AI bridge row at submit: a technician-posted AHS ticket is
      // enrolled once the VRS manager saves the completed AHS details at
      // Stage 1 (PATCH /api/submissions/:id/ahs-details).

      const submissionReceivedPhone = submission.phoneOverride || submission.phone;
      if (submissionReceivedPhone) {
        const body = await buildSubmissionReceivedMessage(
          submission.serviceOrder,
          submission.warrantyType,
          submission.requestType,
          submission.applianceType,
        );
        sendSms(submission.id, submissionReceivedPhone, "submission_received", body).catch((err) => {
          console.error("[SMS] submission_received failed:", err);
        });
      }

      // 2026-05-06: resubmissions now always land in the queue (see
      // originalAgent comment above). Send the informational notification
      // to the prior reviewer so they still see the resubmission appear in
      // their UI, mirror to admins for analytics/overview invalidation, and
      // ALSO broadcast as a new queued ticket to the division (or NLA
      // division) agents so the queue gets picked up promptly. No
      // resubmission-claim SMS — the tech gets one when an agent actually
      // claims the ticket from the queue (same as a fresh submission), not
      // at submit-time.
      if (priorReviewer) {
        const resubmissionEvent = {
          type: "resubmission_received" as const,
          payload: {
            submissionId: submission.id,
            serviceOrder: submission.serviceOrder,
            applianceType: parsed.data.applianceType,
            applianceLabel: getDivisionLabel(parsed.data.applianceType),
            warrantyLabel: getWarrantyLabel(parsed.data.warrantyType),
            message: "A technician has resubmitted a ticket you previously reviewed. It is in the queue for any agent to claim.",
          },
        };
        broadcastToAgent(priorReviewer, resubmissionEvent);
        broadcastToAdmins(resubmissionEvent);
      }
      {
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

      return res.status(201).json({ submission: redactSubmissionForRole(user.role, submission) });
    } catch (error) {
      console.error("Create submission error:", error);
      return res.status(500).json({ error: "Failed to create submission" });
    }
  };

  app.post(
    "/api/submissions",
    authenticateToken,
    requireRole("technician", "provider_1099"),
    (req, res) => createSubmissionHandler(req, res),
  );

  // SASHA/Tech Hub intake for the VRS Express → VRS AI bridge. The V5
  // request is first converted into the normal VRS Express ticket so every
  // existing queue, SMS, duplicate, and audit behavior remains in one place.
  // No AI call is made here; a human agent performs that handoff at Stage 1.
  const vrsExpressIntake = createVrsSashaIntake({
    store: vrsBridgeStore,
    resolveTechnician: (techId) => storage.getTechnicianByLdapId(techId),
    resolveTechUser: (ldapId, name, phone) =>
      storage.getOrCreateTechUser(ldapId, name, phone),
    encryptCallbackSecret: encryptVrsCallbackSecret,
    generateCallId: () => `vrs_call_${randomUUID()}`,
    async createTicket({ body, user }, internalOptions) {
      const internalRequest = { body } as Request;
      (internalRequest as AuthenticatedRequest).user = {
        id: user.id,
        email: user.email ?? "",
        name: user.name,
        role: user.role,
        ldapId: user.racId ?? undefined,
        isTechnician: true,
      };
      const { res: capturedRes, captured } = makeCapturedResponse();
      await createSubmissionHandler(internalRequest, capturedRes, {
        ...internalOptions,
        skipAppVrsAiEnroll: true,
      });
      const responseBody = captured.body as any;
      if (captured.statusCode === 201 && responseBody?.submission?.id) {
        return {
          kind: "created" as const,
          submissionId: responseBody.submission.id as number,
        };
      }
      const message = typeof responseBody?.error === "string"
        ? responseBody.error
        : "VRS Express could not create the authorization ticket";
      return {
        kind: "rejected" as const,
        status: captured.statusCode === 200 || captured.statusCode === 409
          ? 409 as const
          : 422 as const,
        code: captured.statusCode === 200
          ? "SUBMISSION_ALREADY_EXISTS"
          : "SUBMISSION_REJECTED",
        message,
      };
    },
    capturePhotos: isVrsBridgePhotoProxyEnabled()
      ? (submissionId, photoUrls, retentionExpiresAt) =>
        bridgePhotoReliability.capture(
          submissionId,
          photoUrls,
          retentionExpiresAt!,
        )
      : undefined,
  });

  registerVrsSashaApi(app, {
    apiKey: process.env.VRS_SASHA_API_KEY,
    intake: vrsExpressIntake,
    serviceOrders: vrsBridgeStore,
    signObjectPhotoUrl: (objectPath) =>
      vrsObjectStorageService.getObjectEntityReadURL(
        objectPath,
        24 * 60 * 60,
      ),
  });

  // Tyler 2026-07-08 (perf) — 2s micro-cache for the STAFF branch of
  // GET /api/submissions. Agent/admin dashboards poll this endpoint and
  // WS events trigger refetch bursts from every connected staff client at
  // once; identical queries inside a 2s window now serve one DB read.
  //   • Staff branch ONLY — the tech/provider branch below runs
  //     redactWarrantyForProvider and is scoped per-technician; it is never
  //     cached (a shared cache there could leak unredacted rows).
  //   • Key = canonical resolved filters (incl. agent-derived assignedTo /
  //     reviewedBy / divisionFilter) + role class + completedToday + search,
  //     computed BEFORE the admin default-window injection (that value is
  //     time-derived and would change every request).
  //   • Freshness = TTL AND a data-version stamp (see
  //     bumpSubmissionsDataVersion in storage.ts): any submissions/intake
  //     write invalidates instantly, so the worst case is a 2s-stale list
  //     for reads racing a write in another process — which doesn't exist
  //     on this single-VM deployment.
  const submissionsListCache = new Map<
    string,
    { expiresAt: number; version: number; body: string }
  >();
  const SUBMISSIONS_LIST_CACHE_TTL_MS = 2000;

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
        // Tyler 2026-05-02: see storage.ts comment — needed so the agent's
        // Completed-today view surfaces tickets they REJECTED (which null
        // assignedTo).
        reviewedBy?: number;
        applianceType?: string;
        requestType?: string;
        excludeRequestType?: string;
        divisionFilter?: string[];
        // Tyler 2026-05-06 (perf — Task #4): Completed-tab last-N-days
        // window (reviewedAt cutoff). createdAfter is the createdAt cutoff
        // used by the admin Ticket Overview's last-N-days default.
        completedSince?: Date;
        createdAfter?: Date;
        // Tyler 2026-06-27 (scalability) — hard row cap for the admin all-time
        // Ticket Overview (set below). Agent views leave it unset.
        limit?: number;
        // Narrow, read-only filter for the approved VRS AI Pilot tracking tab.
        vrsAiOnly?: boolean;
        // Ordinary staff lists leave bridge-linked tickets to the Pilot tab.
        excludeVrsAiLinked?: boolean;
        // Existing VRS-agent detail authorization applied across all ticket
        // statuses for the pilot tab (queue division, assignment, reviewer).
        pilotAgentId?: number;
        pilotDivisions?: string[];
      } = {};

      const vrsAiOnly = req.query.vrsAiOnly === "true";
      const canUsePilot = canUseVrsAiPilot(user.role);

      if (user.role === "technician" || user.role === "provider_1099") {
        if (vrsAiOnly && !canUsePilot) {
          // Pilot tracking is a staff-only view. Keep technician/provider
          // ownership behavior unchanged for the ordinary list endpoint.
          return res.status(403).json({ error: "VRS AI Pilot tracking is not available for this role" });
        }
        // 1099 providers see only their own (company) submissions — same
        // ownership scoping as a field technician.
        filters.technicianId = user.id;
      } else if (user.role === "vrs_agent") {
        if (vrsAiOnly) {
          const specs = await storage.getSpecializations(user.id);
          const divisions = specs.map(s => s.division);
          if (divisions.length === 0) {
            return res.status(200).json({ submissions: [] });
          }
          filters.vrsAiOnly = true;
          filters.pilotAgentId = user.id;
          // Keep the full specialization list for the storage predicate.
          // A generalist therefore carries all appliance divisions (including
          // NLA), while an un-specialized agent returned above gets no rows.
          filters.pilotDivisions = divisions;
        } else {
          const isCompletedToday = req.query.completedToday === "true";
          // Tyler 2026-05-06 (Task #4): the agent Completed tabs now pass
          // completedSince=<iso> (last-N-days window) instead of completedToday.
          // Both signals mean "this is the Completed view" and must take the
          // reviewedBy branch — see comment below for why assignedTo is wrong.
          const isCompletedView = isCompletedToday || !!req.query.completedSince;
          const ticketStatusFilter = req.query.ticketStatus as string | undefined;

          if (ticketStatusFilter === "queued" && !isCompletedView) {
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
          } else if (isCompletedView) {
            // Tyler 2026-05-02: was `assignedTo = user.id`, but reject paths
            // null `assignedTo` (routes.ts /process: ~1547, ~1585; /process-nla:
            // ~1971), so every rejected ticket disappeared from the agent's
            // Completed tab. `reviewedBy` is the auditable column and is set on
            // every action via the base updateData (~1450) and every NLA branch.
            // Tyler 2026-05-06 (Task #4): same reasoning applies to the new
            // completedSince window — the user wants every ticket THEY processed
            // in the window, including rejected/invalid ones whose assignedTo
            // was nulled.
            filters.reviewedBy = user.id;
          } else {
            filters.assignedTo = user.id;
          }
        }
      } else if (
        vrsAiOnly &&
        (user.role === "admin" || user.role === "super_admin")
      ) {
        // Admin and super-admin retain their established all-submission
        // authorization; the bridge-only predicate is the sole new scope.
        filters.vrsAiOnly = true;
      } else if (vrsAiOnly && !canUsePilot) {
        return res.status(403).json({ error: "VRS AI Pilot tracking is not available for this role" });
      }

      // Bridge-linked tickets are work items only in the dedicated Pilot
      // projection. Keep the ordinary agent/admin queue, my-tickets,
      // completed, NLA, and admin overview lists legacy-only. Technician and
      // provider ownership paths above intentionally use getSubmissions()
      // instead and are not affected.
      if (!vrsAiOnly && (
        user.role === "vrs_agent" ||
        user.role === "admin" ||
        user.role === "super_admin"
      )) {
        filters.excludeVrsAiLinked = true;
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
      // Tyler 2026-05-06 (Task #4): completedSince + createdAfter date
      // windows. Both expect ISO 8601 strings; invalid values are silently
      // ignored so a bad query param can never 500 the dashboard.
      if (req.query.completedSince) {
        const d = new Date(req.query.completedSince as string);
        if (!isNaN(d.getTime())) filters.completedSince = d;
      }
      if (req.query.createdAfter) {
        const d = new Date(req.query.createdAfter as string);
        if (!isNaN(d.getTime())) filters.createdAfter = d;
      }

      const completedToday = req.query.completedToday === "true";

      if (user.role === "vrs_agent" || user.role === "admin" || user.role === "super_admin") {
        // Micro-cache lookup (see comment above the route). Key is computed
        // BEFORE the admin default-window injection below; the injected
        // createdAfter is derived from Date.now() and differs every request,
        // but within the 2s TTL the drift is immaterial.
        const cacheKey = JSON.stringify({
          roleClass: user.role === "vrs_agent" ? "agent" : "admin",
          ticketStatus: filters.ticketStatus ?? null,
          stage1Status: filters.stage1Status ?? null,
          stage2Status: filters.stage2Status ?? null,
          assignedTo: filters.assignedTo ?? null,
          reviewedBy: filters.reviewedBy ?? null,
          pilotAgentId: filters.pilotAgentId ?? null,
          pilotDivisions: filters.pilotDivisions
            ? [...filters.pilotDivisions].sort()
            : null,
          applianceType: filters.applianceType ?? null,
          requestType: filters.requestType ?? null,
          excludeRequestType: filters.excludeRequestType ?? null,
          divisionFilter: filters.divisionFilter
            ? [...filters.divisionFilter].sort()
            : null,
          completedSince: filters.completedSince?.toISOString() ?? null,
          createdAfter: filters.createdAfter?.toISOString() ?? null,
          completedToday,
          vrsAiOnly: filters.vrsAiOnly ?? false,
          excludeVrsAiLinked: filters.excludeVrsAiLinked ?? false,
          search: ((req.query.search as string) || "").toLowerCase(),
        });
        // Version captured BEFORE the DB read: a write that lands during
        // the read bumps the stamp and invalidates this entry immediately.
        const versionAtRead = getSubmissionsDataVersion();
        const cachedEntry = submissionsListCache.get(cacheKey);
        if (
          cachedEntry &&
          cachedEntry.expiresAt > Date.now() &&
          cachedEntry.version === versionAtRead
        ) {
          return res.status(200).type("application/json").send(cachedEntry.body);
        }

        // Tyler 2026-06-27 (scalability) — bound the admin Ticket Overview.
        // Agents are always scoped by assignment/division/status above, so
        // their queries are naturally small. Admin/super_admin, however, can
        // request an all-time list (the dashboard's "all" window option sends
        // no createdAfter), which would scan and serialize the entire
        // submissions table and only worsens as data grows. When no explicit
        // createdAfter window is supplied, impose (a) a generous absolute time
        // floor and (b) a hard row cap. Both honor the list's active ORDER BY:
        // the standard overview is createdAt DESC, so the cap keeps the most
        // recent rows; a queued FIFO/ASC view would keep the front of the queue.
        // Both bounds sit far above current volume, so observable behavior is
        // unchanged today; they only engage at large scale. Tunable via env for ops.
        if (
          (user.role === "admin" || user.role === "super_admin") &&
          !filters.vrsAiOnly
        ) {
          if (!filters.createdAfter) {
            const windowDays = parseInt(
              process.env.ADMIN_SUBMISSIONS_DEFAULT_WINDOW_DAYS || "1095",
              10,
            );
            if (Number.isFinite(windowDays) && windowDays > 0) {
              filters.createdAfter = new Date(
                Date.now() - windowDays * 24 * 60 * 60 * 1000,
              );
            }
          }
          const maxRows = parseInt(
            process.env.ADMIN_SUBMISSIONS_MAX_ROWS || "10000",
            10,
          );
          if (Number.isFinite(maxRows) && maxRows > 0) {
            filters.limit = maxRows;
          }
        }

        // Tyler 2026-05-06 (Task #4 perf): switched from
        // getSubmissionsWithTechnician to getSubmissionsListView. The slim
        // method drops every heavy text/JSON column the list table never
        // reads (~5-10x payload reduction) and adds support for the
        // completedSince + createdAfter windows. The detail panel still
        // drills via GET /api/submissions/:id for full-row data.
        let result = await storage.getSubmissionsListView(filters, completedToday);

        // Shared search includes recorded reviewers after assignment clears.
        // The dashboard supplies the selected created-date lower bound.
        const search = req.query.search as string | undefined;
        if (search && result.length > 0) {
          result = result.filter(sub => matchesTicketSearch(sub, search));
        }

        const body = JSON.stringify({ submissions: result });
        // Bounded: distinct staff filter combos are few (queue/pending/
        // completed per agent + admin windows); clear-all on overflow is a
        // cheap, safe pressure valve.
        if (submissionsListCache.size > 300) submissionsListCache.clear();
        submissionsListCache.set(cacheKey, {
          expiresAt: Date.now() + SUBMISSIONS_LIST_CACHE_TTL_MS,
          version: versionAtRead,
          body,
        });
        return res.status(200).type("application/json").send(body);
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

      return res.status(200).json({ submissions: redactSubmissionForRole(user.role, techResult) });
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
      if ((user.role === "technician" || user.role === "provider_1099") && submission.technicianId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (user.role === "vrs_agent") {
        const isAssignedToAgent = submission.assignedTo === user.id;
        const isQueued = submission.ticketStatus === "queued";
        // Tyler 2026-05-06 (Task #4): also allow access when the agent
        // is the reviewer of record (reviewedBy). The agent Completed
        // tab lists every ticket THIS agent processed, including those
        // whose assignedTo was nulled by reject/invalid paths (see the
        // reviewedBy filter logic in the list route ~L961). Without this
        // grant, the new full-row fetch from the detail panel would 403
        // on every Completed-tab ticket and the panel would render with
        // undefined heavy fields (since the slim list omits them).
        const isReviewer = submission.reviewedBy === user.id;
        if (!isAssignedToAgent && !isQueued && !isReviewer) {
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

      const vrsAi =
        user.role === "technician" || user.role === "provider_1099"
          ? null
          : await vrsBridgeStore.getStatusBySubmissionId(submission.id);
      return res.status(200).json({
        submission: redactSubmissionForRole(user.role, submission),
        vrsAi: browserBridgeStatus(
          vrsAi,
          submission.id,
          isVrsBridgePhotoProxyEnabled(),
        ),
      });
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
      if ((user.role === "technician" || user.role === "provider_1099") && submission.technicianId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }
      // Tyler 2026-05-09 (architect review of Hamed's "show agentNotes to
      // other agents" change): /history previously only blocked non-owner
      // technicians and had NO assignment/division check for vrs_agent.
      // Any authenticated agent could enumerate IDs and read full chains
      // including agentNotes. Now that we deliberately surface agentNotes
      // to agents in the UI (resubmission Previous Rejection card and
      // P-card pickup), this gap becomes more sensitive. Mirror the
      // gating from GET /api/submissions/:id (lines ~1055-1078).
      if (user.role === "vrs_agent") {
        const isAssignedToAgent = submission.assignedTo === user.id;
        const isQueued = submission.ticketStatus === "queued";
        const isReviewer = submission.reviewedBy === user.id;
        if (!isAssignedToAgent && !isQueued && !isReviewer) {
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

      const allRelated = await storage.getSubmissionHistory(submission.serviceOrder);
      const rootId = submission.resubmissionOf || submission.id;
      const chain = allRelated.filter(s => s.id === rootId || s.resubmissionOf === rootId);
      chain.sort((a, b) => new Date(a.createdAt!).getTime() - new Date(b.createdAt!).getTime());

      const reviewerIds = new Set<number>();
      chain.forEach(s => {
        if (s.stage1ReviewedBy) reviewerIds.add(s.stage1ReviewedBy);
        if (s.stage2ReviewedBy) reviewerIds.add(s.stage2ReviewedBy);
      });

      // Display names only, in one query after authorization. No full user
      // records or per-reviewer pool connections are needed for this response.
      const reviewerIdList = [...reviewerIds];
      const nameRows = await storage.getUserDisplayNames([submission.technicianId, ...reviewerIdList]);
      const namesById = new Map(nameRows.map(row => [row.id, row.name]));
      const reviewerNames: Record<number, string> = {};
      reviewerIdList.forEach(rid => {
        if (namesById.has(rid)) reviewerNames[rid] = namesById.get(rid)!;
      });
      const techName = namesById.get(submission.technicianId) || "Technician";

      const resubmissionCount = chain.filter(s => s.resubmissionOf != null && s.stage1Status !== "invalid").length;
      const maxResubmissions = 3;

      return res.status(200).json({
        history: redactSubmissionForRole(user.role, chain),
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

  const authorizeSubmissionNotes = async (user: any, sub: any): Promise<string | null> => {
    let divisions: string[] | undefined;
    if (user.role === "vrs_agent" && sub.ticketStatus === "queued") {
      const specs = await storage.getSpecializations(user.id);
      divisions = specs.map((s: any) => s.division);
    }
    return canAccessTicketNotes({
      role: user.role,
      userId: user.id,
      technicianId: sub.technicianId,
      ticketStatus: sub.ticketStatus,
      requestType: sub.requestType,
      applianceType: sub.applianceType,
      divisions,
      allDivisionCount: ALL_DIVISIONS.length,
    }) ? null : "Access denied";
  };

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
        const accessError = await authorizeSubmissionNotes(user, sub);
        if (accessError) return res.status(403).json({ error: accessError });
        const noteSchema = z.object({
          body: z.string().min(1, "Note cannot be empty").max(2000, "Note must be 2000 characters or less"),
        });
        const parsed = noteSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid note", details: parsed.error.flatten() });
        }

        let divisions: string[] | undefined;
        if (user.role === "vrs_agent") {
          divisions = (await storage.getSpecializations(user.id)).map((s: any) => s.division);
        }
        const result = await storage.atomicCreateSubmissionNote({
          submissionId: id,
          authorId: user.id,
          authorRole: user.role,
          body: parsed.data.body,
          divisions,
          allDivisionCount: ALL_DIVISIONS.length,
        });
        if (!result.ok) {
          if (result.reason === "not_found") return res.status(404).json({ error: "Submission not found" });
          if (result.reason === "closed_to_owner") {
            return res.status(403).json({ error: "Only admin-panel users can add notes after a ticket is closed" });
          }
          return res.status(403).json({ error: "Access denied" });
        }
        return res.status(201).json({ note: result.note });
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
        const accessError = await authorizeSubmissionNotes(user, sub);
        if (accessError) return res.status(403).json({ error: accessError });
        const notes = await storage.getSubmissionNotes(id, STAFF_NOTE_ROLES.has(user.role));
        return res.status(200).json({ notes });
      } catch (error) {
        console.error("Get submission notes error:", error);
        return res.status(500).json({ error: "Failed to get notes" });
      }
    }
  );

  // ========================================================================
  // ADD PHOTOS TO AN OPEN SUBMISSION — tech appends photos before close
  // ========================================================================
  // Technicians (and 1099 providers) can add photos to their OWN submission
  // while the ticket is still open (queued or pending). Closed states
  // (completed / rejected / invalid) are refused — rejected tickets keep
  // the existing resubmission flow. Photos are APPEND-ONLY: existing paths
  // are never removed or reordered, so rejectedMedia references, thumbnail
  // identity, and prior-media audit views stay intact. Uses the
  // optimistic-lock update (status pushed into the UPDATE predicate) so a
  // concurrent agent decision can't be raced.
  app.post("/api/submissions/:id/photos", authenticateToken, requireRole("technician", "provider_1099"), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid submission ID" });
      const sub = await storage.getSubmission(id);
      if (!sub) return res.status(404).json({ error: "Submission not found" });

      const user = (req as any).user;
      if (sub.technicianId !== user.id) {
        return res.status(403).json({ error: "Not your submission" });
      }
      if (sub.ticketStatus !== "queued" && sub.ticketStatus !== "pending") {
        return res.status(409).json({ error: "Photos can only be added while the ticket is still under review" });
      }

      const objectPath = z.string().min(10).max(500).startsWith("/objects/");
      const addPhotosSchema = z.object({
        issuePhotos: z.array(objectPath).max(15).optional(),
        estimatePhotos: z.array(objectPath).max(5).optional(),
        // Add-videos-while-open (2026-07-27): same append-only semantics as
        // photos. Paths must already be uploaded (and converted to playable
        // MP4 client-side via /api/uploads/convert-video when needed).
        videos: z.array(objectPath).max(3).optional(),
        // Voice note (2026-07-27): single-slot column — can only be added
        // when the ticket doesn't already have one (no schema change).
        voiceNote: objectPath.optional(),
        // Same shape + trust bar as the submit-time photoThumbnails field:
        // JSON map of { fullPath: thumbPath }, both /objects/ paths. Paths
        // are not ownership-verified here; access is enforced at read time
        // by the media-token route (same as submit).
        photoThumbnails: z.record(z.string(), z.string()).optional().refine((m) => {
          if (!m) return true;
          return Object.entries(m).every(
            ([k, v]) => k.startsWith("/objects/") && v.startsWith("/objects/"),
          );
        }, "photoThumbnails must map /objects/ paths to /objects/ paths"),
      }).refine(
        (b) => (b.issuePhotos?.length || 0) + (b.estimatePhotos?.length || 0) + (b.videos?.length || 0) + (b.voiceNote ? 1 : 0) > 0,
        "At least one photo, video, or voice note is required",
      );
      const parsed = addPhotosSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid photos payload", details: parsed.error.flatten() });
      }
      const newIssue = parsed.data.issuePhotos || [];
      const newEstimate = parsed.data.estimatePhotos || [];
      const newVideos = parsed.data.videos || [];
      const newVoiceNote = parsed.data.voiceNote || null;

      // Merge into the existing photos JSON. New format is
      // { issue: [], estimate: [] }; legacy rows store a bare array — we
      // convert array -> { issue: array } on first append (agent UI then
      // labels them "Issue Photos" instead of the generic "Photos").
      //
      // Concurrency (architect fix): read-merge-write is racy — two
      // simultaneous appends could both merge from the same stale value
      // and the later write would drop the earlier photos. The UPDATE is
      // a compare-and-swap on the prior `photos` value; on conflict we
      // re-read and retry (up to 3 attempts).
      let updated: any;
      let totalAdded = 0;
      let addedIssueCount = 0;
      let addedEstimateCount = 0;
      let addedVideoCount = 0;
      let addedVoiceNote = false;
      let cur: any = sub;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (cur.ticketStatus !== "queued" && cur.ticketStatus !== "pending") {
          return res.status(409).json({ error: "Ticket was just processed — photos can no longer be added" });
        }
        let existing: any = null;
        try { existing = cur.photos ? JSON.parse(cur.photos) : null; } catch { existing = null; }
        let issueArr: string[] = [];
        let estimateArr: string[] = [];
        if (Array.isArray(existing)) {
          issueArr = existing.filter((p: any) => typeof p === "string");
        } else if (existing && typeof existing === "object") {
          issueArr = Array.isArray(existing.issue) ? existing.issue.filter((p: any) => typeof p === "string") : [];
          estimateArr = Array.isArray(existing.estimate) ? existing.estimate.filter((p: any) => typeof p === "string") : [];
        }
        const already = new Set([...issueArr, ...estimateArr]);
        const addedIssue = newIssue.filter((p) => !already.has(p));
        addedIssue.forEach((p) => already.add(p));
        const addedEstimate = newEstimate.filter((p) => !already.has(p));

        // Video merge — append-only into the videoUrl JSON array (same
        // legacy-single-string-compatible format as tech-submit).
        const videoArr = parseVideoUrlsServer(cur.videoUrl);
        const videoSet = new Set(videoArr);
        const addedVideos = newVideos.filter((v) => !videoSet.has(v));

        // Voice note — single-slot column: only attachable when the ticket
        // doesn't already have one (same limit as first submission).
        if (newVoiceNote && cur.voiceNoteUrl && cur.voiceNoteUrl !== newVoiceNote) {
          return res.status(400).json({ error: "This ticket already has a voice note" });
        }
        const addingVoiceNote = !!(newVoiceNote && !cur.voiceNoteUrl);
        totalAdded = addedIssue.length + addedEstimate.length + addedVideos.length + (addingVoiceNote ? 1 : 0);
        addedIssueCount = addedIssue.length;
        addedEstimateCount = addedEstimate.length;
        addedVideoCount = addedVideos.length;
        addedVoiceNote = addingVoiceNote;
        if (totalAdded === 0) {
          return res.status(400).json({ error: "All attachments are already on this submission" });
        }
        if (issueArr.length + addedIssue.length > 30 || estimateArr.length + addedEstimate.length > 15) {
          return res.status(400).json({ error: "Photo limit reached for this submission" });
        }
        if (videoArr.length + addedVideos.length > 3) {
          return res.status(400).json({ error: "Maximum 3 videos allowed per ticket" });
        }
        const mergedVideoUrl = addedVideos.length > 0
          ? serializeVideoUrlsServer([...videoArr, ...addedVideos])
          : cur.videoUrl;
        if (mergedVideoUrl && mergedVideoUrl.length > 500) {
          return res.status(400).json({ error: "Combined video URLs exceed storage limit" });
        }
        const mergedPhotos = JSON.stringify({
          issue: [...issueArr, ...addedIssue],
          estimate: [...estimateArr, ...addedEstimate],
        });

        // Merge thumbnails — only keep entries for photos actually added.
        let thumbMap: Record<string, string> = {};
        try {
          const rawT = cur.photoThumbnails ? JSON.parse(cur.photoThumbnails) : null;
          if (rawT && typeof rawT === "object" && !Array.isArray(rawT)) thumbMap = rawT;
        } catch {}
        const addedSet = new Set([...addedIssue, ...addedEstimate]);
        for (const [k, v] of Object.entries(parsed.data.photoThumbnails || {})) {
          if (addedSet.has(k)) thumbMap[k] = v;
        }

        updated = await storage.updateSubmissionIfStatusAndPhotos(id, ["queued", "pending"], cur.photos ?? null, {
          photos: mergedPhotos,
          photoThumbnails: Object.keys(thumbMap).length > 0 ? JSON.stringify(thumbMap) : cur.photoThumbnails,
          videoUrl: mergedVideoUrl,
          ...(addingVoiceNote ? { voiceNoteUrl: newVoiceNote } : {}),
        } as any, cur.videoUrl ?? null, addingVoiceNote ? null : undefined);
        if (updated) break;
        // CAS conflict — another writer changed the row. Re-read and retry.
        const fresh = await storage.getSubmission(id);
        if (!fresh) return res.status(404).json({ error: "Submission not found" });
        cur = fresh;
      }
      if (!updated) {
        return res.status(409).json({ error: "Ticket was updated by someone else — please try again" });
      }

      // Append-only audit note so the change is visible in the notes
      // timeline (tech detail page, agent panel, admin audit trail).
      try {
        await storage.createSubmissionNote({
          submissionId: id,
          authorId: user.id,
          authorRole: user.role,
          visibility: "shared",
          body: `Added ${totalAdded} additional attachment(s)${addedIssueCount ? ` — ${addedIssueCount} issue photo(s)` : ""}${addedEstimateCount ? ` — ${addedEstimateCount} model/serial/estimate photo(s)` : ""}${addedVideoCount ? ` — ${addedVideoCount} video(s)` : ""}${addedVoiceNote ? " — 1 voice note" : ""}.`,
        });
      } catch (noteErr) {
        console.error(`[add-photos] audit note failed for submission ${id}:`, noteErr);
      }

      // Realtime: tell the assigned agent (if claimed) and admins so open
      // ticket views refresh without waiting for the next poll.
      try {
        if (updated.assignedTo) {
          broadcastToAgent(updated.assignedTo, {
            type: "ticket_updated",
            payload: {
              submissionId: id,
              serviceOrder: updated.serviceOrder,
              message: `Technician added ${totalAdded} attachment(s) to SO #${updated.serviceOrder}`,
            },
          });
        }
        broadcastToAdmins({
          type: "ticket_updated",
          payload: { submissionId: id, ticketStatus: updated.ticketStatus },
        });
      } catch (broadcastErr) {
        console.error(`[add-photos] broadcast failed for submission ${id}:`, broadcastErr);
      }

      return res.status(200).json({ submission: redactSubmissionForRole(user.role, updated), added: totalAdded });
    } catch (error) {
      console.error("Add photos error:", error);
      return res.status(500).json({ error: "Failed to add photos" });
    }
  });

  // ========================================================================
  // ADMIN AUDIT TRAIL — Full timeline for a submission
  // ========================================================================

  app.get("/api/admin/submissions/:id/audit", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid submission ID" });

      const submission = await storage.getSubmission(id);
      if (!submission) return res.status(404).json({ error: "Submission not found" });

      // Perf 2026-08-16 — independent reads fetched in parallel; this
      // endpoint gates the admin ticket-detail dialog open time.
      const bridgePhotoProxyEnabled = isVrsBridgePhotoProxyEnabled();
      const [smsLogs, allRelated, vrsAi] = await Promise.all([
        storage.getSmsNotifications(id),
        storage.getSubmissionHistory(submission.serviceOrder),
        bridgePhotoProxyEnabled ? vrsBridgeStore.getStatusBySubmissionId(id) : Promise.resolve(null),
      ]);

      // Tyler 2026-05-09 (VRS request): admin ticket detail must show the
      // tech's and agent's notes from PRIOR submissions in the same SO#
      // resubmission thread, not just the current row. Mirrors what
      // agents see in the Previous Rejection card. Chain is the root
      // submission + all rows whose `resubmissionOf` points at the root,
      // sorted oldest-first. Excludes the current submission so the UI
      // can render it as a distinct "previous submissions" section.
      const rootId = submission.resubmissionOf || submission.id;
      const fullChain = allRelated
        .filter(s => s.id === rootId || s.resubmissionOf === rootId)
        .sort((a, b) => new Date(a.createdAt!).getTime() - new Date(b.createdAt!).getTime());
      const priorSubmissions = fullChain.filter(s => s.id !== submission.id);

      const userIds = new Set<number>();
      if (submission.technicianId) userIds.add(submission.technicianId);
      if (submission.assignedTo) userIds.add(submission.assignedTo);
      if (submission.reviewedBy) userIds.add(submission.reviewedBy);
      if (submission.stage1ReviewedBy) userIds.add(submission.stage1ReviewedBy);
      if (submission.stage2ReviewedBy) userIds.add(submission.stage2ReviewedBy);
      priorSubmissions.forEach(p => {
        if (p.technicianId) userIds.add(p.technicianId);
        if (p.reviewedBy) userIds.add(p.reviewedBy);
        if (p.stage1ReviewedBy) userIds.add(p.stage1ReviewedBy);
        if (p.stage2ReviewedBy) userIds.add(p.stage2ReviewedBy);
      });

      // Perf 2026-08-16 — one parallel batch instead of a sequential
      // per-user query loop.
      const userNames: Record<number, string> = {};
      await Promise.all(Array.from(userIds).map(async (uid) => {
        const u = await storage.getUser(uid);
        if (u) userNames[uid] = u.name;
      }));

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
        priorSubmissions,
        // DEV-only gallery context; never expose signed source URLs through audit.
        ...(bridgePhotoProxyEnabled ? { vrsAi: browserBridgeStatus(vrsAi, id, true) } : {}),
      });
    } catch (error) {
      console.error("Admin audit trail error:", error);
      return res.status(500).json({ error: "Failed to get audit trail" });
    }
  });

  // ========================================================================
  // TICKET CLAIM ROUTE — Agent claims a queued ticket
  // ========================================================================

  // Named handler (2026-07-21): also invoked by the external v1 decision
  // adapter for auto-claim by the VRS External API system account.
  const claimSubmissionHandler = async (req: Request, res: Response) => {
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

      // Tyler 2026-05-11 (sweep): JWT payload has no `agentStatus` field, so
      // the prior check `authReq.user!.agentStatus !== "working"` was always
      // true and every claim emitted a spurious UPDATE + 2 broadcasts even
      // when the agent was already on `working`. Read the fresh agent_status
      // from DB and only update + broadcast on actual transition.
      if (authReq.user!.role === "vrs_agent") {
        const claimer = await storage.getUser(authReq.user!.id);
        if (claimer && claimer.agentStatus !== "working") {
          await storage.updateUser(authReq.user!.id, { agentStatus: "working", updatedAt: new Date() } as any);
          await safeLogActivity(authReq.user!.id, "status_change_ticket_flow", {
            from: claimer.agentStatus, to: "working", trigger: "claim", submissionId: id,
          });
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

      const warrantyCompany = (submission.warrantyProvider || submission.warrantyType || "").toLowerCase().replace(/_/g, " ");
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
  };

  app.patch("/api/submissions/:id/claim", authenticateToken, requireRole("vrs_agent", "admin"), claimSubmissionHandler);

  // ========================================================================
  // UNIFIED TICKET PROCESS ROUTE — Approve / Reject / Invalid
  // ========================================================================

  const processActionSchema = z.object({
    action: z.enum(["approve", "approve_replacement_review", "b2b_approved_replacement", "reject", "reject_and_close", "invalid", "approve_submission"]),
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
    // 2026-08-06 (Rejection & Coaching Report) — optional coaching capture on
    // negative outcomes (reject / reject_and_close / invalid).
    expectedVsActual: z.string().max(5000).optional(),
    coachingNotes: z.string().max(5000).optional(),
  });

  // Named handler (2026-07-21): also invoked by the external v1 decision
  // adapter with the VRS External API system account impersonated.
  const processSubmissionHandler = async (req: Request, res: Response) => {
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

      const automation = automatedCallbackContexts.get(req);
      if (automation) {
        const tech = submission.technicianLdapId ? undefined : await storage.getUser(submission.technicianId);
        validateAutomatedApproval({...submission, technicianLdapId:submission.technicianLdapId || tech?.racId}, automation.event);
      }
      if (submission.ticketStatus !== "pending") {
        return res.status(400).json({ error: "Ticket must be in pending status to process" });
      }

      if (submission.assignedTo !== authReq.user!.id && authReq.user!.role !== "admin" && authReq.user!.role !== "super_admin") {
        return res.status(403).json({ error: "This ticket is not assigned to you" });
      }

      const { action, rejectionReasons, rejectedMedia, agentNotes, technicianMessage, invalidReason, invalidInstructions, expectedVsActual, coachingNotes } = parsed.data;
      let { authCode } = parsed.data;

      // Tyler 2026-06-27 (Stage-2 six outcomes): previously, once a submission
      // was approved at Stage 1, the ONLY action allowed at Stage 2 was
      // `approve` (issue the auth code) — reject / reject_and_close / invalid
      // were blocked. VRS asked for the full outcome set at the authorization
      // step too, so an agent can decline / permanently close / invalidate a
      // ticket the warranty company came back negative on AFTER the initial
      // approval. Those three now fall through to their normal handlers below
      // (back-to-tech with resubmit link / permanent close / invalid), exactly
      // as at Stage 1. We still block re-running `approve_submission` on an
      // already-approved ticket — it is the Stage 1→2 transition and re-running
      // it would just re-stamp the Stage 1 fields with no valid effect.
      if (submission.submissionApproved && action === "approve_submission") {
        return res.status(400).json({ error: "This submission has already been approved at Stage 1." });
      }

      // Tyler 2026-05-20 (afternoon) — Replacement Review is only valid on
      // the standard authorization path. NLA already has its own explicit
      // replacement_submitted / replacement_tech_initiates actions on the
      // /process-nla route — sending it through here would bypass NLA
      // accounting and the parts-team handoff.
      if (action === "approve_replacement_review" && submission.requestType === "parts_nla") {
        return res.status(400).json({ error: "Replacement Review is not used on NLA tickets. Use the NLA Replacement Submitted or NLA Replacement (Tech Initiates) action instead." });
      }

      // Task #12 — B2B Approved Replacement is only valid on AHS / First
      // American (two-stage) authorization tickets at the Stage 2 step
      // (submission already approved). It is NOT used on NLA tickets and not
      // before Stage 1 approval. Guard both so the action can't be misrouted.
      if (action === "b2b_approved_replacement") {
        if (submission.requestType === "parts_nla") {
          return res.status(400).json({ error: "B2B Approved Replacement is not used on NLA tickets." });
        }
        const warrantyCompany = (submission.warrantyProvider || submission.warrantyType || "").toLowerCase().replace(/_/g, " ");
        const isB2bWarranty = ["american home shield", "ahs", "first american"].some(w => warrantyCompany.includes(w));
        if (!isB2bWarranty) {
          return res.status(400).json({ error: "B2B Approved Replacement is only available on AHS / First American tickets." });
        }
        if (!submission.submissionApproved) {
          return res.status(400).json({ error: "B2B Approved Replacement is only available at the authorization stage, after the submission has been approved." });
        }
      }

      if (action === "invalid" && !invalidReason) {
        return res.status(400).json({ error: "Invalid reason is required" });
      }

      // Bridge-backed AHS tickets cross the human-in-the-loop boundary here.
      // Manual/PWA tickets have no bridge row and retain the legacy Stage 1
      // flow. For a bridge ticket, do not mark Stage 1 approved or notify the
      // technician until VRS AI has durably accepted the outbound request.
      if (action === "approve_submission") {
        const stageOneGate = await runVrsStageOneRouteGate({
          submissionId: id,
          store: vrsBridgeStore,
          resolveConfig: () => resolveVrsStageOneBridgeConfig(process.env),
          createClient: ({ baseUrl, apiKey, callbackUrl, callbackSecret }) => ({
            authorize: ({ payload, appOrigin }) =>
              sendVrsAuthorizeRequest({
                baseUrl,
                apiKey,
                callbackUrl,
                callbackSecret,
                payload,
                appOrigin,
              }),
          }),
          resolveEnrichment: async () => {
            const technicianUser = await storage.getUser(
              submission.technicianId,
            );
            return buildVrsAuthorizeEnrichmentCandidates({
              submissionPhone: submission.phone,
              technicianName: technicianUser?.name,
              submissionPhotos: submission.photos,
            });
          },
          signObjectPhotoUrl: (objectPath) =>
            vrsObjectStorageService.getObjectEntityReadURL(
              objectPath,
              24 * 60 * 60,
            ),
          dispatch: dispatchVrsAiForSubmission,
        }, (bridgeError) => {
          res.status(bridgeError.status).json({
            error: bridgeError.message,
            code: bridgeError.code,
          });
        });
        if (stageOneGate === "responded") {
          return;
        }
      }

      const updateData: Record<string, unknown> = {
        reviewedBy: authReq.user!.id,
        reviewedAt: new Date(),
        agentNotes: automation ? [submission.agentNotes, agentNotes].filter(Boolean).join("\n\n") : agentNotes || null,
        updatedAt: new Date(),
      };

      // 2026-08-06 (Rejection & Coaching Report) — persist coaching fields on
      // negative outcomes only; never null-out existing values when the fields
      // are omitted (they're also editable later via the coaching PATCH).
      if (action === "reject" || action === "reject_and_close" || action === "invalid") {
        if (expectedVsActual !== undefined) updateData.expectedVsActual = expectedVsActual || null;
        if (coachingNotes !== undefined) updateData.coachingNotes = coachingNotes || null;
      }

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

        // Tyler 2026-05-01: optimistic-lock + best-effort SMS.
        // Was: updateSubmission(id, ...) + awaited sendSms inside same
        // try block, so an SMS throw returned 500 *after* the DB row had
        // already moved. Now: status-conditional UPDATE returns 409 on
        // concurrent loss, and SMS is best-effort so a downstream SMS
        // outage cannot retroactively poison a successful approval.
        // Tyler 2026-05-11 (two-agents-on-one-ticket fix): also pin the
        // assignee at write time when the actor is a vrs_agent. Closes
        // the TOCTOU window where an admin reassigned the ticket from
        // A → B between A's read and A's UPDATE — previously A's write
        // still won because status was still "pending". Admins keep the
        // long-standing intentional bypass.
        const expectAssignee = authReq.user!.role === "vrs_agent" ? authReq.user!.id : undefined;
        const updated = await storage.updateSubmissionIfStatus(id, ["pending"], updateData as any, expectAssignee);
        if (!updated) {
          return res.status(409).json({
            error: "This ticket was already moved or reassigned. Please refresh and try again.",
            code: "STALE_STATUS",
          });
        }
        const approveSmsPhone = submission.phoneOverride || submission.phone;
        try {
          await sendSms(submission.id, approveSmsPhone, smsType, smsMessage);
        } catch (smsErr) {
          console.error(`[process:approve_submission] SMS send failed for submission ${submission.id} (DB committed; agent will see success):`, smsErr);
        }

        const vrsAi = await vrsBridgeStore.getStatusBySubmissionId(id);
        return res.status(200).json({
          submission: updated,
          vrsAi: browserBridgeStatus(
            vrsAi,
            id,
            isVrsBridgePhotoProxyEnabled(),
          ),
        });
      }

      if (action === "approve") {
        const needsRgcCode = submission.requestType === "authorization" || submission.requestType === "parts_nla";
        let rgcCode: string | null = null;

        if (needsRgcCode) {
          const todayStr = getEtDateString();
          const todayRgcCode = await storage.getDailyRgcCode(todayStr);
          if (!todayRgcCode) {
            return res.status(400).json({ error: "No RGC code has been set for today. Please contact an administrator." });
          }
          rgcCode = todayRgcCode.code;

          if (submission.requestType === "parts_nla") {
            authCode = rgcCode;
          } else {
            const warrantyCompany = (submission.warrantyProvider || submission.warrantyType || "").toLowerCase().replace(/_/g, " ");
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

      } else if (action === "approve_replacement_review") {
        // Tyler 2026-05-20 (afternoon) — Replacement Review path. Mirrors the
        // standard `approve` flow (issues a code, marks ticket completed) but
        // sets `replacementReviewRecommended=true` so admins/analytics can
        // discriminate. SMS uses buildReplacementReviewMessage with the exact
        // wording specified by VRS so the tech cannot mistake this for a
        // repair approval. AHS/First American still requires an external auth
        // code just like /approve does — same warranty-provider gate.
        const todayStr = getEtDateString();
        const todayRgcCode = await storage.getDailyRgcCode(todayStr);
        if (!todayRgcCode) {
          return res.status(400).json({ error: "No RGC code has been set for today. Please contact an administrator." });
        }
        const rgcCode = todayRgcCode.code;

        const warrantyCompany = (submission.warrantyProvider || submission.warrantyType || "").toLowerCase().replace(/_/g, " ");
        const needsExternalAuth = ["american home shield", "ahs", "first american"].some(w => warrantyCompany.includes(w));
        if (needsExternalAuth) {
          if (!authCode || !authCode.trim()) {
            return res.status(400).json({ error: "External authorization code is required for this warranty provider" });
          }
        } else {
          authCode = rgcCode;
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
        updateData.replacementReviewRecommended = true;
        const replacementNotes = technicianMessage || (submission as any).technicianMessage || null;
        updateData.technicianMessage = replacementNotes;

        smsMessage = await buildReplacementReviewMessage(
          submission.serviceOrder,
          authCode || rgcCode,
          rgcCode,
          replacementNotes ?? undefined,
        );
        smsType = "ticket_replacement_review";

      } else if (action === "b2b_approved_replacement") {
        // Task #12 — B2B Approved Replacement. For AHS / First American tickets
        // at the Stage 2 authorization step where the warranty company decides
        // on replacement instead of repair. UNLIKE approve / Replacement
        // Review, NO auth or RGC code is issued — it is a replacement-only
        // outcome (the tech removes all parts, selects the replacement labor
        // code, and closes the call). Completes the ticket, marks both stages
        // approved, and sets `b2bApprovedReplacement=true` so reporting can
        // distinguish it from Sears Protect Replacement Review. Terminal — the
        // resubmit route blocks any ticket carrying this flag.
        updateData.ticketStatus = "completed";
        updateData.statusChangedAt = new Date();
        updateData.authCode = null;
        updateData.stage1Status = "approved";
        updateData.stage1ReviewedBy = authReq.user!.id;
        updateData.stage1ReviewedAt = new Date();
        updateData.stage2Status = "approved";
        updateData.stage2Outcome = "approved";
        updateData.stage2ReviewedBy = authReq.user!.id;
        updateData.stage2ReviewedAt = new Date();
        updateData.b2bApprovedReplacement = true;
        const b2bNotes = technicianMessage || (submission as any).technicianMessage || null;
        updateData.technicianMessage = b2bNotes;

        smsMessage = await buildB2bReplacementMessage(
          submission.serviceOrder,
          b2bNotes ?? undefined,
        );
        smsType = "ticket_b2b_replacement";

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

        // Tyler 2026-06-27 — Stage-2 audit stamp. When a negative outcome
        // lands at the authorization stage (the submission was already
        // Stage-1 approved), record WHO/WHEN of the Stage-2 decision in the
        // dedicated stage2 columns WITHOUT disturbing stage1Status /
        // stage1ReviewedAt / reviewedBy. The analytics layer treats
        // stage1Status as the overall outcome (Approval-Rate card) and keys
        // the Completed-Today tile off stage1ReviewedAt, so those must keep
        // reflecting the final action. stage2Status is intentionally left
        // as-is (not "declined") so the Submission-History timeline renders a
        // single Rejected entry instead of double-rendering a Declined entry.
        if (submission.submissionApproved) {
          updateData.stage2Outcome = "reject";
          updateData.stage2ReviewedBy = authReq.user!.id;
          updateData.stage2ReviewedAt = new Date();
        }

        // Tyler 2026-05-07 (post-fix audit): detect "wrongful no-photos
        // rejection" pattern in real time. Fires when an agent rejects with
        // a photo-related reason on a ticket whose `photos` column actually
        // contains URLs and where no individual photos were marked rejected
        // via rejectedMedia.photos. This is the same shape as the prod fire
        // (SO 8107-13694650, ticket 828, Zorn). Logs a structured warning
        // visible in deployment logs and returns the flag in the audit feed
        // so admins can spot recurrence patterns by agent.
        try {
          const PHOTO_REASON_RE = /missing required photo|estimate screenshot missing|incomplete submission|photos do not meet|model\/serial number not visible|missing appliance information|no photo|no pic|no estimate|no model|no serial/i;
          const reasonText = (rejectionReasons || []).join(" | ");
          const matchesPhotoReason = PHOTO_REASON_RE.test(reasonText);
          let dbPhotoCount = 0;
          if (submission.photos) {
            try {
              const parsed = JSON.parse(submission.photos);
              if (Array.isArray(parsed)) {
                dbPhotoCount = parsed.filter((u: any) => typeof u === "string" && u).length;
              } else if (parsed && typeof parsed === "object") {
                const est = Array.isArray(parsed.estimate) ? parsed.estimate.filter((u: any) => typeof u === "string" && u).length : 0;
                const iss = Array.isArray(parsed.issue) ? parsed.issue.filter((u: any) => typeof u === "string" && u).length : 0;
                dbPhotoCount = est + iss;
              }
            } catch { /* malformed photos, treat as 0 */ }
          }
          const individualPhotosRejected = Array.isArray((rejectedMedia as any)?.photos) && (rejectedMedia as any).photos.length > 0;
          if (matchesPhotoReason && dbPhotoCount > 0 && !individualPhotosRejected) {
            console.warn(`[suspicious-rejection] submission=${submission.id} so=${submission.serviceOrder} agent=${authReq.user!.id}(${authReq.user!.email || authReq.user!.name || "?"}) photosInDb=${dbPhotoCount} reasons="${reasonText}" tech=${submission.technicianLdapId || submission.technicianId} warranty="${submission.warrantyProvider || submission.warrantyType || ""}"`);
          }
        } catch (auditErr) {
          // Detector must never block the rejection — log and continue.
          console.error(`[suspicious-rejection] detector error on submission ${submission.id}:`, auditErr);
        }

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

        // Tyler 2026-06-27 — Stage-2 audit stamp (see reject handler above).
        if (submission.submissionApproved) {
          updateData.stage2Outcome = "reject_and_close";
          updateData.stage2ReviewedBy = authReq.user!.id;
          updateData.stage2ReviewedAt = new Date();
        }

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

        // Tyler 2026-06-27 — Stage-2 audit stamp (see reject handler above).
        if (submission.submissionApproved) {
          updateData.stage2Outcome = "invalid";
          updateData.stage2ReviewedBy = authReq.user!.id;
          updateData.stage2ReviewedAt = new Date();
        }

        smsMessage = await buildStage1InvalidMessage(submission.serviceOrder, invalidReason || "", invalidInstructions);
        smsType = "ticket_invalid";
      }

      // Tyler 2026-05-01: optimistic-lock — was an unconditional UPDATE
      // BY ID after a read-time status check (race window let two
      // simultaneous agent actions both pass and overwrite each other,
      // sending duplicate SMS). The route already validates
      // `ticketStatus === "pending"` at the top so we encode the same
      // expectation here. Losing concurrent writer gets 409.
      // Tyler 2026-05-11 (two-agents-on-one-ticket fix): also pin the
      // assignee at write time for vrs_agent actors so an admin
      // reassign that lands between this route's read and write cannot
      // be silently overwritten by the original (now-stale) assignee.
      if (automation) {
        updateData.stage1Status = submission.stage1Status;
        updateData.stage1ReviewedBy = submission.stage1ReviewedBy;
        updateData.stage1ReviewedAt = submission.stage1ReviewedAt;
      }
      const expectAssignee = authReq.user!.role === "vrs_agent" ? authReq.user!.id : undefined;
      const updated = await storage.updateSubmissionIfStatus(id, ["pending"], updateData as any, expectAssignee, automation ? submission : undefined);
      if (!updated) {
        return res.status(409).json({
          error: "This ticket was already moved or reassigned. Please refresh and try again.",
          code: "STALE_STATUS",
        });
      }

      // Tyler 2026-05-01: best-effort SMS. Was awaited and would 500 the
      // route on failure even though the DB row had already committed,
      // causing agent retries on an already-moved ticket.
      const reviewSmsPhone = submission.phoneOverride || submission.phone;
      try {
        const notification = await sendSms(submission.id, reviewSmsPhone, smsType, smsMessage);
        if (automation) automation.notification = notification.success
          ? {status:"accepted",notificationId:notification.notificationId}
          : {status:notification.retrySafe === false ? "unknown" : "failed",notificationId:notification.notificationId,message:notification.error || "Notification failed; ticket approval must not be repeated."};
      } catch (smsErr) {
        if (automation) automation.notification = {status:"unknown",message:"Notification outcome needs operator review; ticket approval must not be repeated."};
        console.error(`[process:${action}] SMS send failed for submission ${submission.id} (DB committed; agent will see success):`, smsErr);
      }

      // Tyler 2026-05-01 (architect F2 follow-up): every post-commit side
      // effect below is best-effort — the DB transition + SMS attempt are
      // the contract; agent status/broadcast failures must NOT 500 a
      // route that already succeeded.
      const availabilityAgentIds = [...new Set([
        submission.assignedTo,
        authReq.user!.role === "vrs_agent" ? authReq.user!.id : null,
      ].filter((agentId): agentId is number => agentId != null))];
      for (const agentId of availabilityAgentIds) {
        try {
          const releasedAgent = await releaseProcessedTicketAgent(pool, agentId, id);
          if (!releasedAgent) continue;
          await safeLogActivity(agentId, "status_change_ticket_flow", {
            from: "working", to: "online", trigger: "process", submissionId: id, action: req.body?.action ?? null,
            actorId: authReq.user!.id,
          });
          updateClientStatus(agentId, "online");
          broadcastToAdmins({
            type: "agent_status_changed",
            payload: { userId: agentId, name: releasedAgent.name, status: "online" },
          });
          broadcastToAgent(agentId, {
            type: "own_status_changed",
            payload: { status: "online" },
          });
          await broadcastVrsAvailability();
        } catch (postErr) {
          console.error(`[process:${action}] post-commit agent-status update failed for submission ${submission.id}:`, postErr);
        }
      }

      if (action === "reject") {
        try {
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
        } catch (broadcastErr) {
          console.error(`[process:${action}] reject re-queue broadcast failed for submission ${submission.id}:`, broadcastErr);
        }
      }

      try {
        // Tyler 2026-05-15: admin Ticket Overview was showing a stale
        // pending row (with a live "Handle Time" still ticking) for up
        // to 60s after an agent completed/rejected/etc. — until the
        // next /api/submissions poll. /process-nla already emits
        // `ticket_updated` after every action; /process did not. Mirror
        // the same broadcast here so the admin dashboard's
        // `ticket_updated` subscription invalidates the submissions
        // cache the moment the DB row commits.
        broadcastToAdmins({
          type: "ticket_updated",
          payload: { submissionId: id, ticketStatus: updated?.ticketStatus },
        });
        await broadcastVrsAvailability();
      } catch (broadcastErr) {
        console.error(`[process:${action}] final VRS availability broadcast failed for submission ${submission.id}:`, broadcastErr);
      }

      return res.status(200).json({ submission: updated });
    } catch (error) {
      if (error instanceof VrsCallbackError) return res.status(error.status).json({error:error.message,code:error.code});
      console.error("Process ticket error:", error);
      return res.status(500).json({ error: "Failed to process ticket" });
    }
  };

  app.patch("/api/submissions/:id/process", authenticateToken, requireRole("vrs_agent", "admin"), processSubmissionHandler);

  // Stage 1 AHS review: the VRS manager completes the AHS draft and the save
  // enrolls the ticket in VRS AI (shared/ahs-review.ts).
  registerAhsReviewApi(app, {
    authenticateToken,
    requireRole,
    getSubmission: (id) => storage.getSubmission(id),
    updateSubmissionIfStatus: (id, statuses, data, expectedAssignedTo) =>
      storage.updateSubmissionIfStatus(id, statuses, data as any, expectedAssignedTo),
    getUser: (id) => storage.getUser(id),
    bridge: {
      store: vrsBridgeStore,
      generateCallId: () => `vrs_call_${randomUUID()}`,
    },
    isEnrollEnabled: isVrsAiAppEnrollEnabled,
    lookupSources: (serviceOrder) => lookupAhsPrefillSources(serviceOrder, {
      snowflake: isAhsServiceOrderPrefillEnabled() ? fetchAhsServiceOrderPrefill : null,
      hssom: lookupHssomOrder,
    }),
    createNote: (note) => storage.createSubmissionNote(note),
    broadcastTicketUpdated: (submission) =>
      broadcastToAdmins({
        type: "ticket_updated",
        payload: { submissionId: submission.id, ticketStatus: submission.ticketStatus },
      }),
  });

  // VRS AI calls back into Express, not directly to SASHA. Express applies
  // terminal outcomes through the same ticket handler used by agents (which
  // preserves SMS/audit/optimistic-lock behavior), then signs and forwards
  // the original public bridge call id to SASHA.
  registerVrsAiWebhookApi(app, {
    webhookSecret: process.env.VRS_AI_WEBHOOK_SECRET,
    sink: {
      async receive(event: VrsWebhookEvent) {
        const outcome = await processVrsAiWebhookEvent({
          event,
          store: vrsBridgeStore,
          decryptCallbackSecret: decryptVrsCallbackSecret,
          async applyResult(submissionId, callbackEvent) {
            const decision =
              mapVrsAiWebhookToSubmissionDecision(callbackEvent);
            if (decision.kind === "status_only") return;

            const submission = await storage.getSubmission(submissionId);
            if (!submission) {
              throw new Error(
                `Submission ${submissionId} for VRS AI callback was not found`,
              );
            }

            // Recovery shortcuts still require matching identity and workflow.
            const callbackTech = submission.technicianLdapId ? undefined : await storage.getUser(submission.technicianId);
            validateAutomatedApproval({...submission,technicianLdapId:submission.technicianLdapId || callbackTech?.racId},callbackEvent);

            // A webhook retry can arrive after the ticket transition won but
            // before its event-ledger stamp committed. Recognize the exact
            // resulting state so the retry never sends the technician twice.
            if (
              (callbackEvent.state === "approved" ||
                callbackEvent.state === "partial") &&
              submission.ticketStatus === "completed" &&
              submission.authCode === callbackEvent.authNumber &&
              submission.agentNotes?.includes(
                buildVrsAiWebhookAgentNotes(callbackEvent),
              )
            ) {
              return;
            }
            if (
              callbackEvent.state === "denied" &&
              submission.ticketStatus === "rejected" &&
              submission.agentNotes?.includes(
                buildVrsAiWebhookAgentNotes(callbackEvent),
              )
            ) {
              try {
                const reasons = submission.rejectionReasons
                  ? JSON.parse(submission.rejectionReasons)
                  : [];
                if (
                  Array.isArray(reasons) &&
                  reasons.includes(callbackEvent.denyReason)
                ) {
                  return;
                }
              } catch {
                // A malformed legacy reason is not proof this event applied.
              }
            }

            const reviewerId =
              submission.assignedTo ??
              submission.stage1ReviewedBy ??
              submission.reviewedBy;
            if (!reviewerId) {
              throw new Error(
                `Submission ${submissionId} has no human reviewer for the VRS AI result`,
              );
            }
            const reviewer = await storage.getUser(reviewerId);
            if (!reviewer) {
              throw new Error(
                `Reviewer ${reviewerId} for submission ${submissionId} was not found`,
              );
            }

            const publicUrl =
              process.env.VRS_EXPRESS_PUBLIC_URL ??
              process.env.VRS_AI_CALLBACK_URL ??
              "https://vrs-express.invalid";
            let callbackHost = "vrs-express.invalid";
            try {
              callbackHost = new URL(publicUrl).host;
            } catch {
              // The outbound configuration validation reports bad URLs before
              // dispatch. This fallback only builds a rejection resubmit link.
            }
            const internalRequest = {
              params: { id: String(submissionId) },
              body: decision.body,
              protocol: "https",
              get(name: string) {
                const header = name.toLowerCase();
                if (header === "host") return callbackHost;
                if (header === "x-forwarded-proto") return "https";
                return undefined;
              },
            } as unknown as Request;
            (internalRequest as AuthenticatedRequest).user = {
              id: reviewer.id,
              email: reviewer.email ?? "",
              name: reviewer.name,
              // Internal callback application deliberately bypasses a later
              // reassignment while preserving the human reviewer id in audit
              // columns. This object never crosses the auth middleware.
              role: "admin",
              ldapId: reviewer.racId ?? undefined,
            };

            automatedCallbackContexts.set(internalRequest, {event:callbackEvent});
            const { res: capturedRes, captured } = makeCapturedResponse();
            await processSubmissionHandler(internalRequest, capturedRes);
            if (captured.statusCode >= 400) {
              const body = captured.body as any;
              throw new Error(
                typeof body?.error === "string"
                  ? body.error
                  : `Unable to apply VRS AI result to submission ${submissionId}`,
              );
            }
          },
          forward: ({ callbackUrl, callbackSecret, event: forwardedEvent }) =>
            deliverVrsWebhook({
              callbackUrl,
              callbackSecret,
              event: forwardedEvent,
            }),
        });

        if (outcome === "processed") {
          const record = await vrsBridgeStore.getByProviderCallId(event.callId);
          if (record) {
            const refreshed = await storage.getSubmission(record.submissionId);
            const reviewerId =
              refreshed?.assignedTo ??
              refreshed?.stage1ReviewedBy ??
              refreshed?.reviewedBy;
            if (reviewerId) {
              broadcastToAgent(reviewerId, {
                type: "ticket_updated",
                payload: {
                  submissionId: record.submissionId,
                  ticketStatus: refreshed?.ticketStatus,
                  vrsAiState: event.state,
                },
              });
            }
            broadcastToAdmins({
              type: "ticket_updated",
              payload: {
                submissionId: record.submissionId,
                ticketStatus: refreshed?.ticketStatus,
                vrsAiState: event.state,
              },
            });
          }
        }
        return outcome;
      },
    },
  });

  // VRS AI can also POST a completed call result straight to Express to close
  // the corresponding ticket. Unlike the signed /webhook above, this route
  // does NOT write the vrs_ai_call_events ledger and does NOT forward the
  // result upstream to SASHA — it is the direct "close my ticket" path for
  // the richer call-result payload (part + technician fields included). The
  // close itself runs through processSubmissionHandler, so SMS, audit
  // columns, optimistic locking, and WS broadcasts behave exactly as they do
  // for a human agent approval.
  const directResultReceipts = new PostgresDirectResultReceipts(pool);
  void directResultReceipts.ensureSchema().catch(error => {
    console.warn("[vrs-ai-call-result] Receipt setup unavailable; callbacks will return 503:", error instanceof Error ? error.message : String(error));
  });
  registerVrsAiCallResultApi(app, {
    apiKey: process.env.VRS_SASHA_API_KEY,
    receipts: directResultReceipts,
    enabled: () => process.env.VRS_AI_CALL_RESULT_ENABLED !== "false",
    async loadTicketCandidates({ callId, soNo, techId, boundSubmissionId }) {
      const bridge = await vrsBridgeStore.getByAnyCallId(callId);
      if (bridge && boundSubmissionId && bridge.submissionId !== boundSubmissionId) throw new VrsCallbackError("TICKET_BINDING_CONFLICT", "Call mapping changed after this result was recorded.");
      const id = boundSubmissionId ?? bridge?.submissionId;
      if (id) {
        const linked = await storage.getSubmission(id);
        if (!linked) return [];
        const tech = linked.technicianLdapId ? undefined : await storage.getUser(linked.technicianId);
        return [{...linked,submissionId:linked.id,technicianLdapId:linked.technicianLdapId || tech?.racId || null,linkedByCallId:true}];
      }
      // Exact technician filtering happens before LIMIT. Two rows are enough
      // to prove ambiguity; neither status nor creation time breaks the tie.
      const rows = await storage.getSubmissionCandidatesByServiceOrderSuffix(soNo, 2, techId);
      return rows.map(row => ({...row, linkedByCallId:false}));
    },
    async closeTicket({ ticket, result }) {
      const submission = await storage.getSubmission(ticket.submissionId);
      if (!submission) {
        return {
          kind: "failed",
          status: 404,
          message: `Submission ${ticket.submissionId} was not found`,
        };
      }

      // The close is attributed to the human who owns the ticket, exactly as
      // the signed webhook sink does.
      const reviewerId =
        submission.assignedTo ??
        submission.stage1ReviewedBy ??
        submission.reviewedBy;
      if (!reviewerId) {
        return {
          kind: "failed",
          status: 409,
          message: `Ticket ${ticket.submissionId} has no assigned agent to attribute the close to.`,
        };
      }
      const reviewer = await storage.getUser(reviewerId);
      if (!reviewer) {
        return {
          kind: "failed",
          status: 409,
          message: `Reviewer ${reviewerId} for ticket ${ticket.submissionId} was not found.`,
        };
      }

      let callbackHost = "vrs-express.invalid";
      try {
        callbackHost = new URL(
          process.env.VRS_EXPRESS_PUBLIC_URL ??
            process.env.VRS_AI_CALLBACK_URL ??
            "https://vrs-express.invalid",
        ).host;
      } catch {
        // Only used to build tech-facing links on negative outcomes, which
        // this approve-only route never takes.
      }

      const internalRequest = {
        params: { id: String(ticket.submissionId) },
        body: {
          action: "approve",
          authCode: result.authNumber,
          agentNotes: buildVrsAiCallResultAgentNotes(result),
        },
        protocol: "https",
        get(name: string) {
          const header = name.toLowerCase();
          if (header === "host") return callbackHost;
          if (header === "x-forwarded-proto") return "https";
          return undefined;
        },
      } as unknown as Request;
      (internalRequest as AuthenticatedRequest).user = {
        id: reviewer.id,
        email: reviewer.email ?? "",
        name: reviewer.name,
        // Same deliberate bypass as the signed webhook sink: apply the result
        // even if the ticket was reassigned after dispatch, while keeping the
        // human reviewer id in the audit columns. Never crosses the auth
        // middleware.
        role: "admin",
        ldapId: reviewer.racId ?? undefined,
      };

      const callbackContext = {event:result} as import("./vrs-callback-safety").AutomatedCallbackContext;
      automatedCallbackContexts.set(internalRequest, callbackContext);
      const { res: capturedRes, captured } = makeCapturedResponse();
      await processSubmissionHandler(internalRequest, capturedRes);
      const body = captured.body as any;
      if (captured.statusCode >= 400) {
        return {
          kind: "failed",
          status: captured.statusCode === 409 ? 409 : 422,
          message:
            typeof body?.error === "string"
              ? body.error
              : `Unable to close ticket ${ticket.submissionId}`,
        };
      }

      const closed = body?.submission;
      try {
        broadcastToAgent(reviewerId, {
          type: "ticket_updated",
          payload: {
            submissionId: ticket.submissionId,
            ticketStatus: closed?.ticketStatus,
            vrsAiState: result.state,
          },
        });
      } catch (broadcastErr) {
        console.error(
          `[vrs-ai-call-result] reviewer broadcast failed for submission ${ticket.submissionId}:`,
          broadcastErr,
        );
      }

      return {
        kind: "closed",
        ticketStatus: closed?.ticketStatus ?? "completed",
        authCode: closed?.authCode ?? result.authNumber,
        notification: callbackContext.notification ?? {status:"unknown"},
      };
    },
  });

  app.get("/api/admin/vrs-ai/notifications/:id/retry", authenticateToken, requireRole("admin", "super_admin"), async (req,res) => {
    const id=Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({error:"INVALID_NOTIFICATION_ID"});
    try {
      const row=(await pool.query("SELECT notification_id,actor_id,state,result,updated_at FROM vrs_ai_notification_retries WHERE notification_id=$1",[id])).rows[0];
      return row ? res.json(row) : res.status(404).json({error:"RETRY_NOT_FOUND"});
    } catch { return res.status(503).json({error:"RECOVERY_NOT_READY"}); }
  });

  app.post("/api/admin/vrs-ai/notifications/:id/retry", authenticateToken, requireRole("admin", "super_admin"), async (req,res) => {
    const id=Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({error:"INVALID_NOTIFICATION_ID"});
    try {
      const actor=(req as AuthenticatedRequest).user!;
      const result=await retryVrsApprovalNotification(pool,id,actor.id,req.body?.confirmUndelivered === true,sendSms);
      return res.status(result.ok?200:502).json(result);
    } catch(error) {
      if (error instanceof VrsCallbackError) return res.status(error.status).json({error:error.code,message:error.message});
      return res.status(500).json({error:"NOTIFICATION_RETRY_FAILED",message:"Unable to retry this notification; inspect its recorded state before trying again."});
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

  // Named handler (2026-07-21): also invoked by the external v1 decision
  // adapter with the VRS External API system account impersonated.
  const processNlaSubmissionHandler = async (req: Request, res: Response) => {
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
        const todayStr = getEtDateString();
        const todayRgcCode = await storage.getDailyRgcCode(todayStr);
        if (!todayRgcCode) {
          return res.status(400).json({ error: "No RGC code has been set for today. Please contact an administrator." });
        }
        rgcCode = todayRgcCode.code;
      }

      // Tyler 2026-05-09 (architect review): preserve the escalating
      // research agent's agentNotes when the P-card tech confirms an
      // order without writing their own notes. Previously `agentNotes ||
      // null` would null-out the escalation context whenever the P-card
      // tech left their notes textarea blank. For nla_pcard_confirm
      // (single-step handoff) we keep the existing value when the
      // incoming field is empty.
      const updateData: Record<string, unknown> = {
        agentNotes: agentNotes && agentNotes.trim()
          ? agentNotes
          : (action === "nla_pcard_confirm" ? (submission.agentNotes ?? null) : null),
        updatedAt: new Date(),
      };
      if (submission.nlaEscalatedBy && !submission.nlaReadyForOrderAt) {
        // A production Publish adds the nullable column without backfilling
        // existing rows. Materialize a stable legacy stop before this process
        // action changes statusChangedAt; do not use request-time "now".
        updateData.nlaReadyForOrderAt =
          submission.claimedAt
          ?? submission.statusChangedAt
          ?? submission.updatedAt
          ?? submission.createdAt;
      }

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
        const readyForOrderAt = new Date();
        updateData.nlaResolution = nlaResolution;
        updateData.nlaFoundPartNumber = nlaFoundPartNumber?.trim().toUpperCase() || null;
        updateData.nlaEscalatedBy = authReq.user!.id;
        updateData.nlaReadyForOrderAt = readyForOrderAt;
        updateData.technicianMessage = technicianMessage || null;
        updateData.reassignmentNotes = `Researched by ${currentUser?.name || "agent"}. Ready for P-card order.`;
        updateData.assignedTo = null;
        updateData.ticketStatus = "queued";
        updateData.statusChangedAt = readyForOrderAt;

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

      // Tyler 2026-05-01: optimistic-lock for NLA processing — same race
      // pattern fixed on /process. Route validates `pending` at the top;
      // we re-encode that as the UPDATE predicate. Losing concurrent
      // writer gets 409 instead of silently overwriting.
      // Tyler 2026-05-11 (two-agents-on-one-ticket fix): also pin the
      // assignee for vrs_agent actors so a concurrent admin reassign or
      // /send-to-nla cannot be silently overwritten.
      const expectAssignee = authReq.user!.role === "vrs_agent" ? authReq.user!.id : undefined;
      const updated = await storage.updateSubmissionIfStatus(id, ["pending"], updateData as any, expectAssignee);
      if (!updated) {
        return res.status(409).json({
          error: "This NLA ticket was already moved or reassigned. Please refresh and try again.",
          code: "STALE_STATUS",
        });
      }

      // Tyler 2026-05-01: best-effort SMS — DB row is committed; an SMS
      // outage shouldn't roll back the agent's success indication.
      if (shouldSendSms && smsMessage) {
        const smsPhone = submission.phoneOverride || submission.phone;
        try {
          await sendSms(submission.id, smsPhone, smsType, smsMessage);
        } catch (smsErr) {
          console.error(`[process-nla:${action}] SMS send failed for submission ${submission.id} (DB committed; agent will see success):`, smsErr);
        }
      }

      // Tyler 2026-05-01 (architect F2 follow-up): same hardening as
      // /process — every post-commit side effect is best-effort. The DB
      // transition + SMS attempt are the contract; an agent-status DB
      // hiccup or websocket broadcast failure must not 500 a route that
      // already moved the ticket.
      if (authReq.user!.role === "vrs_agent") {
        try {
          await storage.updateUser(authReq.user!.id, { agentStatus: "online", updatedAt: new Date() } as any);
          await safeLogActivity(authReq.user!.id, "status_change_ticket_flow", {
            from: "working", to: "online", trigger: "process_nla", submissionId: id, action: req.body?.action ?? null,
          });
          updateClientStatus(authReq.user!.id, "online");
          broadcastToAdmins({
            type: "agent_status_changed",
            payload: { userId: authReq.user!.id, name: authReq.user!.name, status: "online" },
          });
          broadcastToAgent(authReq.user!.id, {
            type: "own_status_changed",
            payload: { status: "online" },
          });
        } catch (postErr) {
          console.error(`[process-nla:${action}] post-commit agent-status update failed for submission ${submission.id}:`, postErr);
        }
      }

      try {
        broadcastToAdmins({
          type: "ticket_updated",
          payload: { submissionId: id, ticketStatus: updated?.ticketStatus },
        });
        await broadcastVrsAvailability();
      } catch (broadcastErr) {
        console.error(`[process-nla:${action}] post-commit broadcast failed for submission ${submission.id}:`, broadcastErr);
      }

      return res.status(200).json({ submission: updated });
    } catch (error) {
      console.error("NLA process error:", error);
      return res.status(500).json({ error: "Failed to process NLA ticket" });
    }
  };

  app.patch("/api/submissions/:id/process-nla", authenticateToken, requireRole("vrs_agent", "admin"), processNlaSubmissionHandler);

  // ==========================================================================
  // EXTERNAL API v1 — machine-to-machine REST surface (x-api-key auth)
  // --------------------------------------------------------------------------
  // Reads:  VRS_LOOKUP_API_KEY (same key as the legacy /nla lookup above)
  // Writes: VRS_EXTERNAL_WRITE_API_KEY (separate, higher-privilege key)
  // Write routes are thin adapters over the SAME internal handlers used by the
  // PWA/dashboard (createSubmissionHandler, claimSubmissionHandler,
  // processSubmissionHandler, processNlaSubmissionHandler), so SMS, WebSocket
  // broadcasts, audit stamps, optimistic locking, and the submissions
  // micro-cache bump behave identically to an in-app action. Registered AFTER
  // those consts (they are referenced by value at registration time — TDZ).
  // See docs/architecture/external-api.md for the full contract.
  // ==========================================================================
  const requireExternalWriteKey = makeExternalKeyMiddleware("VRS_EXTERNAL_WRITE_API_KEY");
  const externalReadRateLimit = makeExternalRateLimiter("read", 60);
  const externalWriteRateLimit = makeExternalRateLimiter("write", 10);

  // Public integration guide — deliberately unauthenticated so the URL can be
  // shared with the external team. Static string, no secrets, own light rate
  // limit so doc fetches never eat the real caller's read budget.
  const externalDocsRateLimit = makeExternalRateLimiter("docs", 30);
  app.get("/api/external/v1/docs", externalDocsRateLimit, (_req, res) => {
    res.type("html").send(EXTERNAL_API_DOCS_HTML);
  });

  // Full lookup by service order — every workflow (authorization, infestation,
  // NLA), every status, newest first. Bounded projection only.
  app.get("/api/external/v1/service-orders/:so", requireExternalApiKey, externalReadRateLimit, async (req, res) => {
    const so = String(req.params.so ?? "");
    if (!SERVICE_ORDER_REGEX.test(so)) {
      return res.status(400).json({
        error: "Service order must be in format DDDD-SSSSSSSS (e.g., 8175-12345678)",
        code: "BAD_SERVICE_ORDER",
      });
    }
    try {
      const rows = await storage.getSubmissionsByServiceOrderForExternal(so);
      return res.json({ data: { serviceOrder: so, submissionCount: rows.length, submissions: rows } });
    } catch (err) {
      console.error(`[external-api] GET /v1/service-orders/${so} failed:`, err);
      return res.status(500).json({ error: "Lookup failed" });
    }
  });

  // Filterable list / polling endpoint. Cursor pagination: rows come back in
  // descending id order; pass nextCursor as ?cursor= to fetch the next page.
  app.get("/api/external/v1/submissions", requireExternalApiKey, externalReadRateLimit, async (req, res) => {
    const parsed = externalListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message, code: "BAD_QUERY" });
    }
    try {
      const rows = await storage.getSubmissionsForExternal(parsed.data);
      const nextCursor = rows.length === parsed.data.limit ? rows[rows.length - 1].id : null;
      return res.json({ data: rows, nextCursor });
    } catch (err) {
      console.error("[external-api] GET /v1/submissions failed:", err);
      return res.status(500).json({ error: "List failed" });
    }
  });

  // Create a request on behalf of a real technician (resolved by LDAP id).
  // Media fields and resubmissionOf are deliberately NOT accepted in v1 —
  // see externalCreateSubmissionSchema. The submission is attributed to the
  // real tech user, so the received/claim/decision SMS chain reaches them.
  app.post("/api/external/v1/submissions", requireExternalWriteKey, externalWriteRateLimit, async (req, res) => {
    const parsed = externalCreateSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message, code: "BAD_REQUEST" });
    }
    try {
      const technician = await storage.getTechnicianByLdapId(parsed.data.technicianLdapId);
      if (!technician) {
        return res.status(422).json({
          error: `Unknown technician LDAP id: ${parsed.data.technicianLdapId}`,
          code: "UNKNOWN_TECHNICIAN",
        });
      }
      if (!technician.isActive) {
        return res.status(422).json({
          error: `Technician ${parsed.data.technicianLdapId} is inactive`,
          code: "INACTIVE_TECHNICIAN",
        });
      }
      const phone = parsed.data.phone || technician.phone;
      if (!phone) {
        return res.status(400).json({
          error: "No phone number — technician has none on file, so `phone` is required",
          code: "NO_PHONE",
        });
      }
      const techUser = await storage.getOrCreateTechUser(technician.ldapId, technician.name || technician.ldapId, technician.phone || "");
      if (techUser.role !== "technician") {
        return res.status(409).json({
          error: "The resolved account is not a technician account",
          code: "NOT_A_TECHNICIAN",
        });
      }

      // Rebuild the body with ONLY internal-schema fields, then invoke the
      // same handler the PWA uses, impersonating the resolved technician.
      // warrantyProvider default: internal PWA submits always carry a
      // human-readable provider label; external callers may omit it. Derive
      // one from warrantyType so AHS/First American tickets render the
      // two-stage flow in the agent dashboard like internal ones do.
      const defaultProviderLabels: Record<string, string> = {
        american_home_shield: "American Home Shield",
        first_american: "First American",
      };
      req.body = {
        serviceOrder: parsed.data.serviceOrder,
        applianceType: parsed.data.applianceType,
        requestType: parsed.data.requestType,
        warrantyType: parsed.data.warrantyType,
        warrantyProvider: parsed.data.warrantyProvider || defaultProviderLabels[parsed.data.warrantyType],
        issueDescription: parsed.data.issueDescription,
        estimateAmount: parsed.data.estimateAmount,
        partNumbers: parsed.data.partNumbers,
        phone,
        additionalRequest: parsed.data.additionalRequest,
      };
      (req as AuthenticatedRequest).user = {
        id: techUser.id,
        email: techUser.email ?? "",
        name: techUser.name,
        role: techUser.role,
        ldapId: techUser.racId ?? undefined,
        isTechnician: true,
      };
      const { res: capturedRes, captured } = makeCapturedResponse();
      await createSubmissionHandler(req, capturedRes);
      const body: any = captured.body;
      if (captured.statusCode < 400 && body?.submission) {
        // Re-read through the external projection so write responses share
        // the same nested {technician, agent} shape as the read routes.
        const row = await storage.getSubmissionByIdForExternal(body.submission.id);
        return res.status(captured.statusCode).json({ data: row ?? projectSubmissionForExternal(body.submission) });
      }
      return res.status(captured.statusCode).json(body ?? { error: "Create failed" });
    } catch (err) {
      console.error("[external-api] POST /v1/submissions failed:", err);
      return res.status(500).json({ error: "Create failed" });
    }
  });

  // Record a decision like an agent would. Queued tickets are auto-claimed by
  // the VRS External API system account first (fires the normal claim SMS +
  // broadcasts). A ticket already claimed by a live agent returns 403 —
  // external callers cannot override a human agent's active review.
  app.post("/api/external/v1/submissions/:id/decision", requireExternalWriteKey, externalWriteRateLimit, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid submission ID", code: "BAD_ID" });
    }
    const parsed = externalDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message, code: "BAD_REQUEST" });
    }
    try {
      const submission = await storage.getSubmission(id);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found", code: "NOT_FOUND" });
      }
      const isNlaTicket = submission.requestType === "parts_nla";
      const isNlaAction = (EXTERNAL_NLA_ACTIONS as readonly string[]).includes(parsed.data.action);
      if (isNlaTicket !== isNlaAction) {
        return res.status(400).json({
          error: isNlaTicket
            ? `NLA tickets accept only: ${EXTERNAL_NLA_ACTIONS.join(", ")}`
            : `Authorization/infestation tickets accept only: ${EXTERNAL_AUTH_ACTIONS.join(", ")}`,
          code: "ACTION_MISMATCH",
        });
      }
      const sysUser = await storage.getUserByRacId(EXTERNAL_API_RAC_ID);
      if (!sysUser) {
        return res.status(503).json({
          error: "External API system account is missing — contact an administrator",
          code: "NOT_CONFIGURED",
        });
      }

      (req as AuthenticatedRequest).user = {
        id: sysUser.id,
        email: sysUser.email ?? "",
        name: sysUser.name,
        role: sysUser.role,
      };
      req.body = parsed.data;

      let autoClaimed = false;

      // If the decision step fails AFTER we auto-claimed, return the ticket
      // to the general queue — otherwise it strands assigned to the system
      // account, invisible to human agents, with no decision recorded.
      // Guarded by expectAssignee so a concurrent legitimate move wins.
      const rollbackAutoClaim = async () => {
        try {
          const reverted = await storage.updateSubmissionIfStatus(id, ["pending"], {
            ticketStatus: "queued",
            statusChangedAt: new Date(),
            assignedTo: null,
            updatedAt: new Date(),
          } as any, sysUser.id);
          if (!reverted) return; // already moved by someone else — leave it
          const payload = {
            submissionId: reverted.id,
            serviceOrder: reverted.serviceOrder,
            applianceType: reverted.applianceType,
            applianceLabel: getDivisionLabel(reverted.applianceType),
            warrantyLabel: getWarrantyLabel(reverted.warrantyType),
          };
          if (reverted.requestType === "parts_nla") {
            broadcastToNlaDivisionAgents(reverted.applianceType, { type: "ticket_queued", payload });
          } else {
            broadcastToDivisionAgents(reverted.applianceType, { type: "ticket_queued", payload });
          }
          console.warn(`[external-api] decision failed after auto-claim — submission ${id} returned to queue`);
        } catch (rbErr) {
          console.error(`[external-api] auto-claim rollback failed for submission ${id}:`, rbErr);
        }
      };

      // The claim handler flips the actor to "working" and the process
      // handler to "online" — real agent lifecycle states. The system
      // account never has a session, so park it back on "offline" after
      // every decision flow so it doesn't linger on the admin live board.
      const resetSystemAccountStatus = async () => {
        try {
          const fresh = await storage.getUser(sysUser.id);
          if (fresh && (fresh as any).agentStatus !== "offline") {
            await storage.updateUser(sysUser.id, { agentStatus: "offline", updatedAt: new Date() } as any);
            updateClientStatus(sysUser.id, "offline");
            broadcastToAdmins({
              type: "agent_status_changed",
              payload: { userId: sysUser.id, name: sysUser.name, status: "offline" },
            });
          }
        } catch (stErr) {
          console.error("[external-api] failed to reset system account status:", stErr);
        }
      };

      try {
        if (submission.ticketStatus === "queued") {
          const { res: claimRes, captured: claimCaptured } = makeCapturedResponse();
          await claimSubmissionHandler(req, claimRes);
          if (claimCaptured.statusCode >= 400) {
            return res.status(claimCaptured.statusCode).json(claimCaptured.body ?? { error: "Auto-claim failed" });
          }
          autoClaimed = true;
        }

        const { res: procRes, captured } = makeCapturedResponse();
        if (isNlaTicket) {
          await processNlaSubmissionHandler(req, procRes);
        } else {
          await processSubmissionHandler(req, procRes);
        }
        const body: any = captured.body;
        if (captured.statusCode >= 400 && autoClaimed) {
          await rollbackAutoClaim();
        }
        if (captured.statusCode < 400 && body?.submission) {
          // Same nested {technician, agent} shape as the read routes.
          const row = await storage.getSubmissionByIdForExternal(id);
          return res.status(captured.statusCode).json({ data: row ?? projectSubmissionForExternal(body.submission) });
        }
        return res.status(captured.statusCode).json(body ?? { error: "Decision failed" });
      } catch (innerErr) {
        if (autoClaimed) await rollbackAutoClaim();
        throw innerErr;
      } finally {
        await resetSystemAccountStatus();
      }
    } catch (err) {
      console.error(`[external-api] POST /v1/submissions/${id}/decision failed:`, err);
      return res.status(500).json({ error: "Decision failed" });
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
        // Tyler perf: specializations gate the division-scoped counts, so it
        // must resolve first; the remaining counts are independent and run
        // concurrently (Promise.all) instead of as sequential round-trips.
        const specs = await storage.getSpecializations(authReq.user!.id);
        const divisions = specs.map(s => s.division);

        const [queueCount, pendingCount, completedToday] = await Promise.all([
          storage.getQueuedCount(divisions),
          storage.getPendingCount(authReq.user!.id),
          storage.getCompletedTodayCount(authReq.user!.id),
        ]);

        let nlaQueueCount = 0;
        let nlaPendingCount = 0;
        let nlaCompletedToday = 0;
        if (divisions.includes("nla")) {
          const nla = await Promise.all([
            storage.getNlaQueuedCount(divisions),
            storage.getNlaPendingCount(authReq.user!.id),
            storage.getNlaCompletedTodayCount(authReq.user!.id, divisions),
          ]);
          nlaQueueCount = nla[0];
          nlaPendingCount = nla[1];
          nlaCompletedToday = nla[2];
        }

        return res.status(200).json({ queueCount, pendingCount, completedToday, nlaQueueCount, nlaPendingCount, nlaCompletedToday });
      }

      // Tyler perf: admin counts are all independent — run concurrently.
      const [queueCount, completedToday, nlaQueueCount, nlaCompletedToday] = await Promise.all([
        storage.getQueuedCount(ALL_DIVISIONS),
        storage.getCompletedTodayCount(),
        storage.getNlaQueuedCount(),
        storage.getNlaCompletedTodayCount(),
      ]);

      return res.status(200).json({ queueCount, pendingCount: 0, completedToday, nlaQueueCount, nlaPendingCount: 0, nlaCompletedToday });
    } catch (error) {
      console.error("Agent stats error:", error);
      return res.status(500).json({ error: "Failed to get agent stats" });
    }
  });

  app.get("/api/vrs-availability", authenticateToken, async (_req, res) => {
    try {
      const [onlineAgents, queuedTickets] = await Promise.all([
        storage.getOnlineAgentCount(),
        storage.getQueuedCountAll(),
      ]);
      return res.status(200).json({ onlineAgents, queuedTickets });
    } catch (error) {
      console.error("VRS availability error:", error);
      return res.status(500).json({ error: "Failed to get VRS availability" });
    }
  });

  // ========================================================================
  // AGENT STATUS ROUTES
  // ========================================================================

  // Tyler 2026-05-11 (VRS desync hardening) — lightweight GET so the
  // agent dashboard can reconcile its local toggle against the
  // authoritative DB on tab refocus (visibilitychange). Closes the gap
  // where a backgrounded tab missed an admin-initiated own_status_changed
  // because its WebSocket was killed by the heartbeat before reconnecting.
  app.get("/api/agent/status", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const user = await storage.getUser(authReq.user!.id);
      if (!user) return res.status(404).json({ error: "User not found" });
      return res.status(200).json({
        agentStatus: (user as any).agentStatus || "offline",
        autoOfflinedAt: (user as any).autoOfflinedAt || null,
      });
    } catch (error) {
      console.error("Get agent status error:", error);
      return res.status(500).json({ error: "Failed to fetch status" });
    }
  });

  // Tyler 2026-05-20 (afternoon) — client-driven screen-inactivity
  // auto-offline. Replaces the prior server-side WS-disconnect timer
  // (which fired on proxy/tab-focus churn while agents were actively
  // working a ticket — see Thomas Bottoms screenshot). The agent
  // dashboard tracks real mouse/keyboard/touch/scroll activity and
  // calls this after 30 minutes of true idle. Stamps autoOfflinedAt
  // so the modal re-prompts on next interaction/reload. Skips if the
  // agent has an open pending ticket (don't strand a claimed ticket).
  app.post("/api/agent/auto-offline", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user!.id;
      // Capture request source for the activity log so we can tell client-tab
      // POSTs from cURL/scripted callers when investigating reports.
      const source = {
        ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() || req.ip,
        ua: (req.headers["user-agent"] as string || "").slice(0, 200),
        idleMsClient: req.body?.idleMs ?? null,
      };

      const current = await storage.getUser(userId);
      if (!current) return res.status(404).json({ error: "User not found" });
      if ((current as any).agentStatus !== "online") {
        await safeLogActivity(userId, "auto_offline_skipped_not_online", { agentStatus: (current as any).agentStatus, source });
        return res.status(200).json({ skipped: true, reason: "not_online", agentStatus: (current as any).agentStatus });
      }

      // Architect 2026-05-20: getPendingCount excludes NLA tickets, so we
      // must also check getNlaPendingCount or an agent with a claimed NLA
      // ticket could be auto-offlined and have the NLA work stranded.
      const [pendingCount, nlaPendingCount] = await Promise.all([
        storage.getPendingCount(userId),
        storage.getNlaPendingCount(userId),
      ]);
      if (pendingCount > 0 || nlaPendingCount > 0) {
        await safeLogActivity(userId, "auto_offline_skipped_pending", { pendingCount, nlaPendingCount, source });
        return res.status(200).json({ skipped: true, reason: "pending_ticket" });
      }

      // Tyler 2026-05-26 — multi-tab safety via per-tab idle votes.
      // Each tab generates a stable tabId (sessionStorage) and posts it
      // here when its 30-min idle clock fires. A single backgrounded
      // tab cannot demote the user; we only demote once EVERY live WS
      // session has independently voted idle within IDLE_VOTE_TTL_MS.
      // If only one live session exists, the vote-set comparison still
      // works (one vote ≥ one session) and the single-tab path behaves
      // exactly as before. Votes expire so a tab that became active
      // again automatically loses its vote.
      const liveSessions = getLiveSessionCount(userId);
      const tabId = typeof req.body?.tabId === "string" && req.body.tabId.length > 0 && req.body.tabId.length <= 64
        ? req.body.tabId
        : `legacy-${source.ip || "x"}`;
      const { votes } = recordIdleVote(userId, tabId);
      if (votes < liveSessions) {
        await safeLogActivity(userId, "auto_offline_skipped_multitab", { liveSessions, votes, source });
        return res.status(200).json({ skipped: true, reason: "multi_tab_pending_votes", liveSessions, votes });
      }
      clearIdleVotes(userId);

      const now = new Date();
      await storage.updateUser(userId, { agentStatus: "offline", autoOfflinedAt: now, updatedAt: now } as any);
      await safeLogActivity(userId, "auto_offline_fired", { autoOfflinedAt: now.toISOString(), liveSessions, source });
      updateClientStatus(userId, "offline");
      broadcastToAdmins({
        type: "agent_status_changed",
        payload: { userId, name: authReq.user!.name, status: "offline" },
      });
      broadcastToAgent(userId, {
        type: "own_status_changed",
        payload: { status: "offline" },
      });
      await broadcastVrsAvailability();
      return res.status(200).json({ agentStatus: "offline", autoOfflinedAt: now.toISOString() });
    } catch (error) {
      console.error("Auto-offline error:", error);
      return res.status(500).json({ error: "Failed to auto-offline" });
    }
  });

  // Tyler 2026-05-26 — explicit idle-vote unvote. Called by the client
  // when a previously-idle tab becomes active again, so a stale vote
  // can't cooperate with another tab's fresh vote to falsely demote a
  // user who's actively working. Best-effort: no body validation
  // beyond the tabId string check, never throws.
  app.post("/api/agent/idle-vote-clear", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const tabId = req.body?.tabId;
      if (typeof tabId !== "string" || tabId.length === 0 || tabId.length > 64) {
        return res.status(400).json({ error: "tabId required" });
      }
      clearIdleVoteForTab(authReq.user!.id, tabId);
      return res.status(204).end();
    } catch (error) {
      console.error("Idle vote clear error:", error);
      return res.status(500).json({ error: "Failed to clear idle vote" });
    }
  });

  // Tyler 2026-05-26 — WS reconnect telemetry. The HTTP path stays alive
  // even when WebSocket is zombied, so the client can self-report dead
  // sockets / reconnects via this endpoint. Three accepted event types:
  //   - ws_zombie_detected: keepalive saw no inbound > threshold or send threw
  //   - ws_reconnect_success: WS opened after one or more failed attempts
  //   - ws_unexpected_close: onclose with a non-clean code (not user logout)
  // Anything else is silently dropped (we don't want this to become a
  // generic client-log shovel). Details payload is bounded — we only
  // persist a small, vetted subset of fields.
  app.post("/api/agent/ws-telemetry", authenticateToken, requireRole("vrs_agent", "admin", "super_admin", "technician"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const schema = z.object({
        event: z.enum(["ws_zombie_detected", "ws_reconnect_success", "ws_unexpected_close"]),
        details: z.object({
          reason: z.string().max(120).optional(),
          attempts: z.number().int().min(0).max(10000).optional(),
          downtimeMs: z.number().int().min(0).max(86_400_000).optional(),
          idleMs: z.number().int().min(0).max(86_400_000).optional(),
          code: z.number().int().min(0).max(5000).optional(),
        }).strict().default({}),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid telemetry payload" });
      }
      if (!shouldEmitTelemetry(authReq.user!.id, parsed.data.event)) {
        return res.status(204).end();
      }
      const source = {
        ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() || req.ip,
        ua: (req.headers["user-agent"] as string || "").slice(0, 200),
      };
      await safeLogActivity(authReq.user!.id, parsed.data.event, { ...parsed.data.details, source });
      return res.status(204).end();
    } catch (error) {
      console.error("WS telemetry error:", error);
      return res.status(500).json({ error: "Failed to log telemetry" });
    }
  });

  // Tyler 2026-05-20 — clear the auto-offline flag without changing
  // status. Called by the client modal's "Stay Unavailable" button so
  // the prompt doesn't re-appear on every reconnect. The "Go Available"
  // button instead calls PATCH /api/agent/status which also clears it.
  app.post("/api/agent/auto-offline-ack", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      await storage.updateUser(authReq.user!.id, { autoOfflinedAt: null } as any);
      await safeLogActivity(authReq.user!.id, "auto_offline_ack", {});
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error("Auto-offline ack error:", error);
      return res.status(500).json({ error: "Failed to acknowledge" });
    }
  });

  app.patch("/api/agent/status", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const statusSchema = z.object({ status: z.enum(["online", "offline"]) });
      const parsed = statusSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Status must be 'online' or 'offline'" });
      }

      if (parsed.data.status === "offline") {
        // Architect 2026-05-20: getPendingCount excludes NLA, so an agent
        // mid-NLA could go offline and strand the NLA ticket. Check both.
        const pendingCount = await storage.getPendingCount(authReq.user!.id);
        const nlaPendingCount = await storage.getNlaPendingCount(authReq.user!.id);
        if (pendingCount > 0 || nlaPendingCount > 0) {
          return res.status(400).json({ error: "You have an open ticket. Complete it or ask an admin to reassign it before going unavailable.", hasPendingTicket: true });
        }
      }

      // Tyler 2026-05-20 — any explicit toggle clears the auto-offline
      // flag so the "marked Unavailable due to inactivity" modal won't
      // re-appear next reconnect.
      const priorUser = await storage.getUser(authReq.user!.id);
      const updated = await storage.updateUser(authReq.user!.id, { agentStatus: parsed.data.status, autoOfflinedAt: null, updatedAt: new Date() } as any);
      await safeLogActivity(authReq.user!.id, "status_toggle_self", {
        from: (priorUser as any)?.agentStatus ?? null,
        to: parsed.data.status,
        clearedAutoOfflinedFlag: !!(priorUser as any)?.autoOfflinedAt,
      });
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
      // Tyler 2026-05-20 — admin override also clears the inactivity
      // flag so the agent doesn't later see a stale "marked Unavailable
      // due to inactivity" prompt for what was actually an admin action.
      const updated = await storage.updateUser(id, { agentStatus: parsed.data.status, autoOfflinedAt: null } as any);
      await safeLogActivity(id, "status_toggle_admin", {
        from: (user as any)?.agentStatus ?? null,
        to: parsed.data.status,
        adminUserId: (req as AuthenticatedRequest).user!.id,
        adminName: (req as AuthenticatedRequest).user!.name,
        clearedAutoOfflinedFlag: !!(user as any)?.autoOfflinedAt,
      });
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

  // Tyler 2026-05-20 (afternoon) — append-only activity log for the new
  // screen-inactivity auto-offline feature. Admin-only. Filters:
  //   ?userId=N           — single agent
  //   ?eventType=...      — auto_offline_fired, status_toggle_self, etc.
  //   ?sinceHours=N       — last N hours (default 24)
  //   ?limit=N            — capped at 1000
  app.get("/api/admin/agent-activity", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      // Architect 2026-05-20 — validate query inputs so bad values return
      // 400 with a useful message instead of 500 from the DB layer.
      const querySchema = z.object({
        userId: z.coerce.number().int().positive().optional(),
        eventType: z.string().max(48).optional(),
        sinceHours: z.coerce.number().positive().max(24 * 30).optional(),
        limit: z.coerce.number().int().positive().max(1000).optional(),
      });
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid query", issues: parsed.error.flatten() });
      }
      const { userId, eventType, sinceHours = 24, limit = 200 } = parsed.data;
      const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
      const rows = await storage.getRecentAgentActivity({ userId, eventType, since, limit });
      return res.status(200).json({ events: rows, filters: { userId, eventType, sinceHours, limit } });
    } catch (error) {
      console.error("Agent activity list error:", error);
      return res.status(500).json({ error: "Failed to list agent activity" });
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

      // Snapshot provenance before cascading DB deletion removes the Bridge
      // payload. Shared object prefixes cannot safely use numeric IDs alone.
      let bridgePhotoSources: string[] = [];
      try {
        const bridge = await vrsBridgeStore.getBySubmissionId(id);
        if (Array.isArray(bridge?.requestPayload.appliance_photos)) {
          bridgePhotoSources = bridge.requestPayload.appliance_photos;
        }
      } catch {
        // Missing provenance defers private-byte cleanup to the TTL sweep.
        console.error("[retention] bridge photo deletion provenance unavailable");
      }
      const deleted = await storage.deleteSubmission(id);
      if (!deleted) return res.status(500).json({ message: "Failed to delete submission" });
      try {
        await vrsBridgePhotoStorage.deleteSubmission(id, bridgePhotoSources);
      } catch {
        // Cleanup must continue even after the Pilot is disabled.
        // The committed ticket deletion is not rolled back on storage failure.
        console.error("[retention] bridge photo delete failed");
      }

      // Tyler 2026-05-29 ("Zorn stuck Working" fix): deleting a ticket that
      // an agent had CLAIMED used to leave that agent's agentStatus pinned
      // on "working" forever — their toggle stayed locked and they couldn't
      // go available or claim, even though they had no open ticket (the one
      // they'd claimed no longer existed). Mirrors the status-restore pattern
      // in /process, /process-nla and /send-to-nla. Best-effort: a failure
      // here must NOT undo the already-committed delete. We only demote
      // working→online when the claimer has no OTHER open pending ticket.
      if (submission.assignedTo) {
        try {
          const claimer = await storage.getUser(submission.assignedTo);
          if (claimer && claimer.role === "vrs_agent" && (claimer as any).agentStatus === "working") {
            const [vrsPending, nlaPending] = await Promise.all([
              storage.getPendingCount(claimer.id),
              storage.getNlaPendingCount(claimer.id),
            ]);
            if (Number(vrsPending) + Number(nlaPending) === 0) {
              await storage.updateUser(claimer.id, { agentStatus: "online", updatedAt: new Date() } as any);
              await safeLogActivity(claimer.id, "status_change_ticket_flow", {
                from: "working", to: "online", trigger: "submission_deleted", submissionId: id,
              });
              updateClientStatus(claimer.id, "online");
              broadcastToAdmins({
                type: "agent_status_changed",
                payload: { userId: claimer.id, name: claimer.name, status: "online" },
              });
              broadcastToAgent(claimer.id, {
                type: "own_status_changed",
                payload: { status: "online" },
              });
              await broadcastVrsAvailability();
            }
          }
        } catch (postErr) {
          console.error(`[delete-submission] post-delete claimer status restore failed for submission ${id}:`, postErr);
        }
      }

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

      // Tyler 2026-06-27 (reassign frees previous assignee): when an admin
      // reassigns a ticket — to another agent or back to the queue — the agent
      // who had it claimed used to stay pinned on "working" with no open ticket,
      // the same stuck-toggle bug as the delete-ticket "Zorn stuck Working" fix
      // above. Free them once the reassign has committed. Best-effort: a failure
      // here must NOT 500 a reassign that already succeeded. Only demote
      // working→online when they have no OTHER open pending ticket; because this
      // runs AFTER the update, a self-reassign keeps the ticket in their count
      // and is correctly left untouched. The RECEIVING agent is intentionally
      // NOT set to "working" (Tyler 2026-06-27): "working" is driven by actively
      // claiming/opening a ticket, not by an admin pre-assigning one.
      const previousAssignee = submission.assignedTo;
      // Preserve the legacy researched-handoff stop before reassignment
      // changes statusChangedAt. New transitions already have the dedicated
      // timestamp; ordinary claimed NLA tickets have no escalation marker.
      const legacyNlaReadyForOrderAt =
        submission.requestType === "parts_nla"
        && submission.nlaEscalatedBy
        && !submission.nlaReadyForOrderAt
          ? submission.claimedAt
            ?? submission.statusChangedAt
            ?? submission.updatedAt
            ?? submission.createdAt
          : undefined;
      const freePreviousAssignee = async () => {
        if (!previousAssignee) return;
        try {
          const prior = await storage.getUser(previousAssignee);
          if (prior && prior.role === "vrs_agent" && (prior as any).agentStatus === "working") {
            const [vrsPending, nlaPending] = await Promise.all([
              storage.getPendingCount(prior.id),
              storage.getNlaPendingCount(prior.id),
            ]);
            if (Number(vrsPending) + Number(nlaPending) === 0) {
              await storage.updateUser(prior.id, { agentStatus: "online", updatedAt: new Date() } as any);
              await safeLogActivity(prior.id, "status_change_ticket_flow", {
                from: "working", to: "online", trigger: "reassigned", submissionId: id,
              });
              updateClientStatus(prior.id, "online");
              broadcastToAdmins({
                type: "agent_status_changed",
                payload: { userId: prior.id, name: prior.name, status: "online" },
              });
              broadcastToAgent(prior.id, {
                type: "own_status_changed",
                payload: { status: "online" },
              });
              await broadcastVrsAvailability();
            }
          }
        } catch (postErr) {
          console.error(`[reassign] previous-assignee status restore failed for submission ${id}:`, postErr);
        }
      };

      if (parsed.data.agentId) {
        const agent = await storage.getUser(parsed.data.agentId);
        if (!agent || (agent.role !== "vrs_agent" && agent.role !== "admin" && agent.role !== "super_admin")) {
          return res.status(400).json({ error: "Invalid agent" });
        }
        if (!agent.isActive) {
          return res.status(400).json({ error: "Cannot assign to an inactive user" });
        }

        // Tyler 2026-05-11 (two-agents-on-one-ticket fix): was an
        // unconditional UPDATE BY ID — could clobber a ticket that the
        // current assignee had just completed in the gap between this
        // route's read at L2473 and write here, re-surfacing a
        // finished ticket as "pending" in the new agent's queue. The
        // status guard rejects with 409 if the ticket already moved.
        const updated = await storage.updateSubmissionIfStatus(id, ["queued", "pending"], {
          assignedTo: parsed.data.agentId,
          ticketStatus: "pending",
          statusChangedAt: new Date(),
          ...(legacyNlaReadyForOrderAt
            ? { nlaReadyForOrderAt: legacyNlaReadyForOrderAt }
            : {}),
          reassignmentNotes: parsed.data.notes || null,
          updatedAt: new Date(),
        } as any);
        if (!updated) {
          return res.status(409).json({
            error: "This ticket was just completed or moved by the assigned agent. Please refresh.",
            code: "STALE_STATUS",
          });
        }

        const assignedEvent = {
          type: "ticket_assigned" as const,
          payload: {
            submissionId: updated.id,
            serviceOrder: updated.serviceOrder,
            message: `A ticket has been assigned to you by an admin.`,
          },
        };
        broadcastToAgent(parsed.data.agentId, assignedEvent);
        // Tyler 2026-05-05 (perf-fix paired): admins now subscribe to
        // ticket_assigned silently so a second admin tab sees the
        // assignment-state change immediately under the new 60s
        // safety-net polling.
        broadcastToAdmins(assignedEvent);

        await freePreviousAssignee();
        return res.status(200).json({ submission: updated });
      }

      // Tyler 2026-05-11 (two-agents-on-one-ticket fix): same race
      // window as the agent-target branch above — a "send back to
      // queue" reassign could overwrite a ticket the prior assignee
      // had just completed.
      const updated = await storage.updateSubmissionIfStatus(id, ["queued", "pending"], {
        ticketStatus: "queued",
        statusChangedAt: new Date(),
        ...(legacyNlaReadyForOrderAt
          ? { nlaReadyForOrderAt: legacyNlaReadyForOrderAt }
          : {}),
        assignedTo: null,
        reassignmentNotes: parsed.data.notes || null,
        updatedAt: new Date(),
      } as any);
      if (!updated) {
        return res.status(409).json({
          error: "This ticket was just completed or moved by the assigned agent. Please refresh.",
          code: "STALE_STATUS",
        });
      }

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

      await freePreviousAssignee();
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
      const actor = authReq.user;
      if (!actor) {
        return res.status(401).json({ error: "No user found" });
      }
      const idParam = req.params.id;
      const id = typeof idParam === "string" ? parseInt(idParam, 10) : NaN;
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

      const isAdmin = actor.role === "admin" || actor.role === "super_admin";
      if (!isAdmin && submission.assignedTo !== actor.id) {
        return res.status(403).json({ error: "You can only send your own claimed tickets to NLA" });
      }

      const targetDivision = parsed.data.division || submission.applianceType;

      // Tyler 2026-05-11 (two-agents-on-one-ticket fix): was an
      // unconditional UPDATE BY ID. Could clobber a ticket the
      // assigned agent had just /process'd in the gap between this
      // route's read at L2583 and the write here, re-surfacing the
      // already-completed ticket in the NLA queue. Status guard makes
      // a stale send-to-nla return 409. For non-admin actors we also
      // pin the assignee so an admin reassignment between read/write
      // can't be silently overwritten either.
      const isAdminActor = actor.role === "admin" || actor.role === "super_admin";
      const expectAssignee = isAdminActor ? undefined : actor.id;
      const nlaUpdate: Partial<typeof submissions.$inferInsert> = {
        requestType: "parts_nla",
        applianceType: targetDivision,
        ...(targetDivision !== submission.applianceType ? { applianceKind: null } : {}),
        ticketStatus: "queued",
        assignedTo: null,
        reassignmentNotes: parsed.data.notes || `Sent to NLA queue by ${actor.name}`,
        statusChangedAt: new Date(),
        updatedAt: new Date(),
      };
      const updated = await storage.updateSubmissionIfStatus(id, ["pending"], nlaUpdate, expectAssignee);
      if (!updated) {
        return res.status(409).json({
          error: "This ticket was already moved or reassigned. Please refresh and try again.",
          code: "STALE_STATUS",
        });
      }

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

      // Tyler 2026-05-11 (Rob Seda "Cannot Go Unavailable" fix): when a
      // vrs_agent sends their claimed ticket to the NLA queue, the route
      // previously cleared assignedTo + flipped requestType=parts_nla
      // but never restored the agent's `agentStatus` from "working"
      // back to "online". The agent's toggle stayed locked on Working
      // and the next tick's getPendingCount/race could leave them
      // blocked from going unavailable even though they had no open
      // VRS tickets. Mirrors the exact pattern in /process and
      // /process-nla; admins keep their independent status flow.
      if (actor.role === "vrs_agent") {
        try {
          await storage.updateUser(actor.id, { agentStatus: "online", updatedAt: new Date() } as any);
          await safeLogActivity(actor.id, "status_change_ticket_flow", {
            from: "working", to: "online", trigger: "send_to_nla", submissionId: id,
          });
          updateClientStatus(actor.id, "online");
          broadcastToAdmins({
            type: "agent_status_changed",
            payload: { userId: actor.id, name: actor.name, status: "online" },
          });
          broadcastToAgent(actor.id, {
            type: "own_status_changed",
            payload: { status: "online" },
          });
          await broadcastVrsAvailability();
        } catch (postErr) {
          console.error(`[send-to-nla] post-commit agent-status update failed for submission ${updated.id}:`, postErr);
        }
      }

      return res.status(200).json({ submission: updated });
    } catch (error) {
      console.error("Send to NLA error:", error);
      return res.status(500).json({ error: "Failed to send ticket to NLA queue" });
    }
  });

  // ========================================================================
  // SEND TO VRS AUTHORIZATION — Agent sends an NLA ticket back to the VRS
  // authorization queue. Mirror of /send-to-nla in the opposite direction.
  // ========================================================================

  app.post("/api/submissions/:id/send-to-vrs", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
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

      if (submission.requestType !== "parts_nla") {
        return res.status(400).json({ error: "Only NLA tickets can be sent to VRS Authorization" });
      }

      if (submission.ticketStatus !== "pending") {
        return res.status(400).json({ error: "Can only send claimed (pending) tickets to VRS Authorization" });
      }

      const isAdminActor = authReq.user!.role === "admin" || authReq.user!.role === "super_admin";
      if (!isAdminActor && submission.assignedTo !== authReq.user!.id) {
        return res.status(403).json({ error: "You can only send your own claimed tickets to VRS Authorization" });
      }

      const targetDivision = parsed.data.division || submission.applianceType;

      // Same status-guarded CAS pattern as /send-to-nla: a stale send
      // returns 409 instead of clobbering a concurrent /process-nla or
      // reassignment.
      const expectAssignee = isAdminActor ? undefined : authReq.user!.id;
      const updated = await storage.updateSubmissionIfStatus(id, ["pending"], {
        requestType: "authorization",
        applianceType: targetDivision,
        ...(targetDivision !== submission.applianceType ? { applianceKind: null } : {}),
        ticketStatus: "queued",
        assignedTo: null,
        // Clear NLA-only state: an escalated NLA ticket carries
        // nlaEscalatedBy, which gates claiming to P-card holders. Left in
        // place it would strand the ticket in the VRS queue for most agents.
        nlaEscalatedBy: null,
        nlaReadyForOrderAt: null,
        nlaResolution: null,
        nlaFoundPartNumber: null,
        reassignmentNotes: parsed.data.notes || `Sent to VRS Authorization queue by ${authReq.user!.name}`,
        statusChangedAt: new Date(),
        updatedAt: new Date(),
      } as any, expectAssignee);
      if (!updated) {
        return res.status(409).json({
          error: "This ticket was already moved or reassigned. Please refresh and try again.",
          code: "STALE_STATUS",
        });
      }

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

      // Mirror /send-to-nla: releasing the claimed ticket returns the
      // agent's status from "working" to "online".
      if (authReq.user!.role === "vrs_agent") {
        try {
          await storage.updateUser(authReq.user!.id, { agentStatus: "online", updatedAt: new Date() } as any);
          await safeLogActivity(authReq.user!.id, "status_change_ticket_flow", {
            from: "working", to: "online", trigger: "send_to_vrs", submissionId: id,
          });
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
        } catch (postErr) {
          console.error(`[send-to-vrs] post-commit agent-status update failed for submission ${updated.id}:`, postErr);
        }
      } else if (submission.assignedTo && submission.assignedTo !== authReq.user!.id) {
        // Admin sent another agent's claimed ticket back to VRS — free the
        // displaced assignee (same pattern as reassign's previous-assignee
        // restore). Best-effort: never 500 a send that already committed.
        try {
          const prior = await storage.getUser(submission.assignedTo);
          if (prior && prior.role === "vrs_agent" && (prior as any).agentStatus === "working") {
            const [vrsPending, nlaPending] = await Promise.all([
              storage.getPendingCount(prior.id),
              storage.getNlaPendingCount(prior.id),
            ]);
            if (Number(vrsPending) + Number(nlaPending) === 0) {
              await storage.updateUser(prior.id, { agentStatus: "online", updatedAt: new Date() } as any);
              await safeLogActivity(prior.id, "status_change_ticket_flow", {
                from: "working", to: "online", trigger: "send_to_vrs_admin", submissionId: id,
              });
              updateClientStatus(prior.id, "online");
              broadcastToAdmins({
                type: "agent_status_changed",
                payload: { userId: prior.id, name: prior.name, status: "online" },
              });
              broadcastToAgent(prior.id, {
                type: "own_status_changed",
                payload: { status: "online" },
              });
              await broadcastVrsAvailability();
            }
          }
        } catch (postErr) {
          console.error(`[send-to-vrs] previous-assignee status restore failed for submission ${updated.id}:`, postErr);
        }
      }

      return res.status(200).json({ submission: updated });
    } catch (error) {
      console.error("Send to VRS error:", error);
      return res.status(500).json({ error: "Failed to send ticket to VRS Authorization queue" });
    }
  });

  // ========================================================================
  // REQUEST-TYPE CORRECTION — Agent corrects an Infestation/Non-Accessible
  // ticket that the technician selected by mistake. In-place flip to
  // "authorization" (ticket stays claimed); for NLA the client routes
  // through the existing /send-to-nla flow so queue routing stays uniform.
  // ========================================================================

  app.patch("/api/submissions/:id/correct-request-type", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid submission ID" });
      }

      const bodySchema = z.object({
        newRequestType: z.enum(["authorization"]),
        notes: z.string().max(2000).optional(),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }

      const submission = await storage.getSubmission(id);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      if (submission.requestType !== "infestation_non_accessible") {
        return res.status(400).json({ error: "Only Infestation/Non-Accessible tickets can be corrected" });
      }

      if (submission.ticketStatus !== "pending") {
        return res.status(400).json({ error: "Can only correct claimed (pending) tickets" });
      }

      const isAdminActor = authReq.user!.role === "admin" || authReq.user!.role === "super_admin";
      if (!isAdminActor && submission.assignedTo !== authReq.user!.id) {
        return res.status(403).json({ error: "You can only correct your own claimed tickets" });
      }

      const expectAssignee = isAdminActor ? undefined : authReq.user!.id;
      const updated = await storage.updateSubmissionIfStatus(id, ["pending"], {
        requestType: parsed.data.newRequestType,
        updatedAt: new Date(),
      } as any, expectAssignee);
      if (!updated) {
        return res.status(409).json({
          error: "This ticket was already moved or reassigned. Please refresh and try again.",
          code: "STALE_STATUS",
        });
      }

      // Append-only audit note so the correction is visible in the notes
      // timeline for the tech, agents, and admin audit trail.
      try {
        await storage.createSubmissionNote({
          submissionId: id,
          authorId: authReq.user!.id,
          authorRole: authReq.user!.role,
          visibility: "shared",
          body: `Request type corrected from Infestation/Non-Accessible to Authorization by ${authReq.user!.name}.${parsed.data.notes ? ` Note: ${parsed.data.notes}` : ""}`,
        });
      } catch (noteErr) {
        console.error(`[correct-request-type] audit note failed for submission ${id}:`, noteErr);
      }

      return res.status(200).json({ submission: updated });
    } catch (error) {
      console.error("Correct request type error:", error);
      return res.status(500).json({ error: "Failed to correct request type" });
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

      // Tyler 2026-05-11 (two-agents-on-one-ticket fix, completing audit):
      // both branches were unconditional UPDATE BY ID. The "release"
      // branch in particular could clobber an admin reassignment that
      // landed between this route's read at L2705 and the write below
      // — re-queuing a ticket the new assignee already owned. For
      // vrs_agent actors we pin the assignee so a concurrent reassign
      // is detected; admins keep the ownership-bypass behavior they
      // have on /process and /reassign.
      const expectAssignee =
        authReq.user!.role === "vrs_agent" ? authReq.user!.id : undefined;
      if (agentHasNewDivision) {
        const updated = await storage.updateSubmissionIfStatus(id, ["pending"], {
          applianceType: newDivision,
          applianceKind: null,
          agentNotes: existingNotes,
          updatedAt: new Date(),
        } as any, expectAssignee);
        if (!updated) {
          return res.status(409).json({
            error: "This ticket was already moved or reassigned. Please refresh and try again.",
            code: "STALE_STATUS",
          });
        }
        return res.status(200).json({ submission: updated, agentKeepsTicket: true });
      } else {
        const updated = await storage.updateSubmissionIfStatus(id, ["pending"], {
          applianceType: newDivision,
          applianceKind: null,
          ticketStatus: "queued",
          statusChangedAt: new Date(),
          assignedTo: null,
          agentNotes: existingNotes,
          updatedAt: new Date(),
        } as any, expectAssignee);
        if (!updated) {
          return res.status(409).json({
            error: "This ticket was already moved or reassigned. Please refresh and try again.",
            code: "STALE_STATUS",
          });
        }

        await storage.updateUser(authReq.user!.id, { agentStatus: "online", updatedAt: new Date() } as any);
        await safeLogActivity(authReq.user!.id, "status_change_ticket_flow", {
          from: "working", to: "online", trigger: "correct_division_release", submissionId: id,
        });
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

  // ========================================================================
  // SYSTEM HEALTH REGRESSION WATCH (2026-05-11)
  // ========================================================================
  // GET /api/admin/health/regression-check
  //   Runs all named regression checks tied to fixes shipped today, upserts
  //   findings into system_health_log (opens new incidents, touches still-
  //   present incidents, clears resolved incidents), and returns a summary.
  //
  // GET /api/admin/health/incidents?checkName=&openOnly=&limit=
  //   Lists historical findings from the audit log.
  //
  // Each check name corresponds to a fix area:
  //   - send_to_nla_status_stuck   -> Rob's "stuck Working" fix watch
  //   - escalate_audit_gap         -> Zorn's escalate retry-wrapper fix watch
  //                                   (footprint: completed parts_nla with
  //                                    nla_resolution=part_found_vrs_ordered
  //                                    but nla_escalated_by IS NULL — means
  //                                    a P-card agent finalized without an
  //                                    audit breadcrumb of the prior escalate)
  //   - stale_pending_nla          -> NLA tickets stuck > 4h on an offline
  //                                   agent (potential abandoned escalates)
  app.get("/api/admin/health/regression-check", authenticateToken, requireRole("admin", "super_admin"), async (_req, res) => {
    try {
      const results: Array<{
        checkName: string;
        severity: string;
        currentCount: number;
        opened: number;
        touched: number;
        cleared: number;
        sample: Array<{ entityType: string; entityId: number; finding: any }>;
      }> = [];

      type Detection = { entityType: string; entityId: number; finding: any };

      async function runCheck(
        checkName: string,
        severity: "info" | "warning" | "critical",
        detect: () => Promise<Detection[]>
      ) {
        const detections = await detect();
        const open = await storage.listOpenHealthIncidentsByCheck(checkName);
        const openMap = new Map<string, typeof open[number]>(
          open.map((o) => [`${o.entityType}:${o.entityId}`, o])
        );
        let opened = 0;
        let touched = 0;
        for (const d of detections) {
          const key = `${d.entityType}:${d.entityId}`;
          const existing = openMap.get(key);
          if (existing) {
            await storage.touchHealthIncident(existing.id);
            touched++;
            openMap.delete(key);
          } else {
            await storage.openHealthIncident({
              checkName,
              severity,
              entityType: d.entityType,
              entityId: d.entityId,
              finding: d.finding,
            });
            opened++;
          }
        }
        let cleared = 0;
        for (const stale of openMap.values()) {
          await storage.clearHealthIncident(stale.id);
          cleared++;
        }
        results.push({
          checkName,
          severity,
          currentCount: detections.length,
          opened,
          touched,
          cleared,
          sample: detections.slice(0, 5),
        });
      }

      // Check 1 — send_to_nla_status_stuck (Rob's bug class)
      // VRS agents/admins with agent_status='working', no open pending
      // tickets, and no status update in the last 10 minutes. The fix
      // shipped today restores status correctly when a Send-to-NLA leaves
      // the agent with no remaining work; this watches for any future
      // regression of that path.
      await runCheck("send_to_nla_status_stuck", "warning", async () => {
        const r = await db.execute(sql`
          SELECT u.id, u.name, u.rac_id, u.agent_status, u.updated_at
          FROM users u
          LEFT JOIN submissions s
            ON s.assigned_to = u.id AND s.ticket_status = 'pending'
          WHERE u.role IN ('vrs_agent', 'admin')
            AND u.agent_status = 'working'
            AND u.updated_at < NOW() - INTERVAL '10 minutes'
          GROUP BY u.id, u.name, u.rac_id, u.agent_status, u.updated_at
          HAVING COUNT(s.id) = 0
        `);
        return (r.rows as any[]).map((row) => ({
          entityType: "user",
          entityId: Number(row.id),
          finding: {
            name: row.name,
            racId: row.rac_id,
            agentStatus: row.agent_status,
            stuckSince: row.updated_at,
          },
        }));
      });

      // Check 2 — escalate_audit_gap (Zorn's bug class, ticket #985 footprint)
      // Completed parts_nla submissions where a P-card agent finalized but
      // nla_escalated_by is NULL despite nla_resolution=part_found_vrs_ordered.
      // The retry wrapper shipped today should keep the escalate intent
      // captured; any new occurrence here means escalate intent was lost.
      // assigned_to <> reviewed_by guard (2026-05-12): exclude P-card agents
      // self-serving their own research (no escalation occurred, so
      // nla_escalated_by SHOULD be NULL). Real Zorn signature is a handoff
      // where the escalator audit got lost. IS DISTINCT FROM handles NULL
      // safely vs plain <>.
      await runCheck("escalate_audit_gap", "warning", async () => {
        const r = await db.execute(sql`
          SELECT id, service_order, reviewed_by, status_changed_at
          FROM submissions
          WHERE request_type = 'parts_nla'
            AND ticket_status = 'completed'
            AND nla_resolution = 'part_found_vrs_ordered'
            AND nla_escalated_by IS NULL
            AND assigned_to IS DISTINCT FROM reviewed_by
            AND status_changed_at > NOW() - INTERVAL '7 days'
        `);
        return (r.rows as any[]).map((row) => ({
          entityType: "submission",
          entityId: Number(row.id),
          finding: {
            serviceOrder: row.service_order,
            reviewedBy: row.reviewed_by,
            statusChangedAt: row.status_changed_at,
          },
        }));
      });

      // Check 3 — stale_pending_nla (potential abandoned escalates)
      // NLA tickets sitting in 'pending' for > 4 hours, assigned to an
      // agent who is currently offline. Catches the failure-mode where a
      // transient escalate failure leaves a ticket orphaned on a logged-out
      // agent before any retry wrapper protection.
      await runCheck("stale_pending_nla", "warning", async () => {
        const r = await db.execute(sql`
          SELECT s.id, s.service_order, s.assigned_to, s.claimed_at, u.agent_status
          FROM submissions s
          JOIN users u ON u.id = s.assigned_to
          WHERE s.request_type = 'parts_nla'
            AND s.ticket_status = 'pending'
            AND s.claimed_at < NOW() - INTERVAL '4 hours'
            AND u.agent_status = 'offline'
        `);
        return (r.rows as any[]).map((row) => ({
          entityType: "submission",
          entityId: Number(row.id),
          finding: {
            serviceOrder: row.service_order,
            assignedTo: row.assigned_to,
            claimedAt: row.claimed_at,
            agentStatus: row.agent_status,
          },
        }));
      });

      const totalOpen = results.reduce((sum, r) => sum + r.currentCount, 0);
      return res.status(200).json({
        ranAt: new Date().toISOString(),
        overallStatus: totalOpen === 0 ? "green" : "issues_detected",
        totalActiveFindings: totalOpen,
        checks: results,
      });
    } catch (error) {
      console.error("Regression check error:", error);
      return res.status(500).json({ error: "Failed to run regression check" });
    }
  });

  app.get("/api/admin/health/incidents", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const checkName = (req.query.checkName as string) || undefined;
      const openOnly = req.query.openOnly === "true";
      const rawLimit = req.query.limit ? Number(req.query.limit) : NaN;
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 200;
      const incidents = await storage.listHealthIncidents({ checkName, openOnly, limit });
      return res.status(200).json({ incidents, count: incidents.length });
    } catch (error) {
      console.error("List incidents error:", error);
      return res.status(500).json({ error: "Failed to list incidents" });
    }
  });

  // 2026-05-12 — manual clear endpoint. For incidents the admin has handled
  // out-of-band (data fixed manually, known accepted exception, etc) or wants
  // to silence even though the check still fires. Records who cleared and why
  // for the audit trail. Auto-clear continues to work normally on the next
  // regression-check run for findings that genuinely no longer match.
  const clearIncidentSchema = z.object({
    reason: z.string().trim().min(1).max(500).optional(),
  });
  app.post("/api/admin/health/incidents/:id/clear", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid incident id" });
      }
      const parsed = clearIncidentSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      await storage.clearHealthIncident(id, authReq.user!.id, parsed.data.reason);
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error("Clear incident error:", error);
      return res.status(500).json({ error: "Failed to clear incident" });
    }
  });

  app.get("/api/admin/rgc-code", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const date = (req.query.date as string) || getEtDateString();
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
      const todayStr = getEtDateString();
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
      const todayStr = getEtDateString();
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
      const { email, password, name, role, phone, racId, companyName } = parsed.data;

      if (racId) {
        const existingByRacId = await storage.getUserByRacId(racId);
        if (existingByRacId) {
          if (existingByRacId.role === "technician") {
            return res.status(409).json({ error: 'This LDAP ID belongs to a field technician. Open the Technicians list and use "Grant VRS access" to let them flex into VRS.' });
          }
          return res.status(409).json({ error: "LDAP ID already exists" });
        }
      }

      // 1099 provider portal: a provider account is identified by its login
      // username (stored in racId) + an assigned company name from the preset
      // list. Both are required so the restricted submission view has a
      // company to show and the portal login works.
      if (role === "provider_1099") {
        if (!is1099PortalEnabled()) {
          return res.status(403).json({ error: "The 1099 Provider Portal is not enabled in this environment." });
        }
        if (!racId) {
          return res.status(400).json({ error: "A username is required for 1099 provider accounts." });
        }
        if (!isValidProvider1099Company(companyName || null)) {
          return res.status(400).json({ error: "Select a valid 1099 Company Name for this provider account." });
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
        companyName: role === "provider_1099" ? (companyName || null) : null,
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
    racId: z.string().regex(/^[a-zA-Z]+[a-zA-Z0-9]*$/, "LDAP ID / username must be letters and numbers only (e.g., MTHOMA2)").optional().nullable().or(z.literal("")),
    role: z.enum(["technician", "vrs_agent", "admin", "super_admin", "provider_1099"]).optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(6).optional(),
    resetPassword: z.boolean().optional(),
    canOrderParts: z.boolean().optional(),
    companyName: z.string().max(120).optional().nullable().or(z.literal("")),
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

      if (parsed.data.role !== undefined && parsed.data.role !== user.role) {
        const authReq = req as AuthenticatedRequest;
        if (user.role === "super_admin") {
          return res.status(403).json({ error: "Super admin role cannot be changed." });
        }
        if (user.role === "admin" && authReq.user?.role !== "super_admin") {
          return res.status(403).json({ error: "Only a super admin can change an admin's role." });
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
      // 1099 provider portal: keep companyName in sync. When the resulting
      // role is provider_1099 the company must be a valid preset entry;
      // otherwise the company is cleared so non-providers never carry one.
      const resultingRole = parsed.data.role ?? user.role;
      if (resultingRole === "provider_1099" && !is1099PortalEnabled()) {
        return res.status(403).json({ error: "The 1099 Provider Portal is not enabled in this environment." });
      }
      if (resultingRole === "provider_1099") {
        if (parsed.data.companyName !== undefined) {
          if (!isValidProvider1099Company(parsed.data.companyName || null)) {
            return res.status(400).json({ error: "Select a valid 1099 Company Name for this provider account." });
          }
          updateData.companyName = parsed.data.companyName || null;
        } else if (parsed.data.role === "provider_1099" && !user.companyName) {
          return res.status(400).json({ error: "Select a valid 1099 Company Name for this provider account." });
        }
      } else if (parsed.data.role !== undefined && parsed.data.role !== "provider_1099") {
        updateData.companyName = null;
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

      // Invalidate the 30-second status cache and force-disconnect any live
      // WebSocket sessions so the user loses access immediately rather than
      // retaining privileged real-time events until their next reconnect.
      if (parsed.data.role !== undefined || parsed.data.isActive !== undefined) {
        invalidateUserStatusCache(id);
        forceDisconnectUser(id);
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

  // ==========================================================================
  // AGENT SO LOOKUP (2026-07-24) — cross-division visibility so agents can
  // answer "is this service order in the system, who has it, what's its
  // status" without asking an admin. Read-only, bounded projection (no media,
  // no auth/RGC codes, no phone numbers). Any agent may look up any SO —
  // that is the point of the feature — but they still cannot OPEN tickets
  // outside their division (the detail route keeps its own checks).
  // ==========================================================================
  app.get("/api/agent/so-lookup", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      const raw = String(req.query.so ?? "").trim();
      // Accept "817512345678" too — normalize to the canonical dashed form.
      const so = /^\d{12}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
      if (!SERVICE_ORDER_REGEX.test(so)) {
        return res.status(400).json({ error: "Service order must be in format DDDD-SSSSSSSS (e.g., 8175-12345678)" });
      }
      const rows = await storage.getSubmissionsByServiceOrderForAgentLookup(so);
      return res.status(200).json({ serviceOrder: so, submissions: rows });
    } catch (error) {
      console.error("Agent SO lookup error:", error);
      return res.status(500).json({ error: "Lookup failed" });
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
  // Tyler 2026-05-01 — Admin-configurable VRS business hours
  // Per-category profiles (default + HVAC). Drives the after-hours SMS gate
  // AND shared/business-hours.ts (single source of truth). Stored as JSON in
  // system_settings.vrs_business_hours (no schema change). Reads are open to
  // any authenticated user (dashboards need it for elapsed-time math); writes
  // are super_admin only.
  // ==========================================================================
  app.get("/api/business-hours", authenticateToken, async (_req, res) => {
    try {
      // Cache is warmed at server startup. If something raced and it isn't
      // loaded yet, hit the DB now so the client never sees stale defaults
      // when an admin override exists.
      if (!businessHoursIsLoaded()) {
        await loadBusinessHoursConfig();
      }
      return res.status(200).json(getCachedBusinessHoursConfig());
    } catch (error) {
      console.error("Get business hours error:", error);
      return res.status(500).json({ error: "Failed to load business hours" });
    }
  });

  // Tyler 2026-05-01: write-access set to admin+super_admin (not super_admin
  // only as the original plan said) to match the existing convention for
  // every other admin-config surface (RGC code, comm templates, user mgmt).
  // sysadmin is `admin` and needs to edit hours without escalating.
  app.put("/api/business-hours", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const parsed = businessHoursConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }
      // Zod's enum-from-array helper widens openDays to `string[]` even
       // though the runtime values are guaranteed `DayKey`s by the regex
       // validation above — cast through unknown to avoid leaking the wide
       // type into business-hours-config.ts.
      const saved = await saveBusinessHoursConfig(
        parsed.data as unknown as Parameters<typeof saveBusinessHoursConfig>[0],
      );
      // Notify all admin AND agent clients so any open dashboard re-renders
      // its elapsed-time / open/closed indicator without a page reload.
      // Tyler 2026-05-01 (architect fix): originally only broadcast to
      // admins — but agent dashboards use the same business-hours math
      // for queue urgency and need the update too.
      try {
        broadcastToAdmins({
          type: "business_hours_updated",
          payload: saved,
        });
        broadcastToAllAgents({
          type: "business_hours_updated",
          payload: saved,
        });
      } catch (broadcastErr) {
        console.error("[business-hours] broadcast failed:", broadcastErr);
      }
      return res.status(200).json(saved);
    } catch (error) {
      console.error("Save business hours error:", error);
      return res.status(500).json({ error: "Failed to save business hours" });
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
      const idParam = req.params.id;
      const id = typeof idParam === "string" ? parseInt(idParam, 10) : NaN;
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
      const idParam = req.params.id;
      const id = typeof idParam === "string" ? parseInt(idParam, 10) : NaN;
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

  app.get("/api/admin/analytics/coaching-duplicates", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt((req.query.days as string) || "30", 10) || 30, 1), 365);
      const rows = await storage.getCoachingDuplicateSubmissions(days);
      return res.status(200).json({ days, rows });
    } catch (error) {
      console.error("Coaching duplicates error:", error);
      return res.status(500).json({ error: "Failed to get coaching duplicates" });
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

  // Tyler 2026-05-07 (post-fix audit dashboard): admin-only feed of
  // rejections that match the "wrongful no-photos" pattern. Mirrors the
  // detector in the reject path of /api/submissions/:id/process. Per
  // user request the UI surface was removed; this endpoint is left in
  // place for ad-hoc curl/dashboard access (still RBAC-guarded).
  app.get("/api/admin/suspicious-rejections", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt((req.query.days as string) || "30", 10) || 30, 1), 90);
      const result = await db.execute(sql`
        SELECT
          s.id,
          s.service_order AS "serviceOrder",
          s.technician_ldap_id AS "technicianLdapId",
          s.appliance_type AS "applianceType",
          s.warranty_provider AS "warrantyProvider",
          s.created_at AS "createdAt",
          s.reviewed_at AS "reviewedAt",
          s.rejection_reasons AS "rejectionReasons",
          s.rejected_media AS "rejectedMedia",
          s.photos AS "photos",
          s.reviewed_by AS "reviewedBy",
          u.name AS "reviewingAgentName",
          EXISTS (SELECT 1 FROM submissions r WHERE r.resubmission_of = s.id) AS "hasResubmission"
        FROM submissions s
        LEFT JOIN users u ON u.id = s.reviewed_by
        WHERE s.ticket_status = 'rejected'
          AND s.reviewed_at >= NOW() - (${days}::int * INTERVAL '1 day')
          AND s.photos IS NOT NULL AND s.photos != '' AND length(s.photos) > 30
          AND LOWER(COALESCE(s.rejection_reasons::text, '')) ~ 'missing required photo|estimate screenshot missing|incomplete submission|photos do not meet|model/serial number not visible|missing appliance information|no photo|no pic|no estimate|no model|no serial'
        ORDER BY s.reviewed_at DESC
        LIMIT 500
      `);
      const rows: any[] = (result as any).rows || [];
      // Filter out rows where the agent actually marked individual photos
      // rejected via rejectedMedia.photos — those are legitimate per-photo
      // rejections, not the "no photos" pattern.
      const flagged = rows.filter((r) => {
        try {
          if (!r.rejectedMedia) return true;
          const rm = typeof r.rejectedMedia === "string" ? JSON.parse(r.rejectedMedia) : r.rejectedMedia;
          return !(Array.isArray(rm?.photos) && rm.photos.length > 0);
        } catch { return true; }
      }).map((r) => {
        let photoCount = 0;
        try {
          const p = typeof r.photos === "string" ? JSON.parse(r.photos) : r.photos;
          if (Array.isArray(p)) photoCount = p.filter((u: any) => typeof u === "string" && u).length;
          else if (p && typeof p === "object") {
            const est = Array.isArray(p.estimate) ? p.estimate.filter((u: any) => typeof u === "string" && u).length : 0;
            const iss = Array.isArray(p.issue) ? p.issue.filter((u: any) => typeof u === "string" && u).length : 0;
            photoCount = est + iss;
          }
        } catch {}
        let reasons: string[] = [];
        try {
          const rr = typeof r.rejectionReasons === "string" ? JSON.parse(r.rejectionReasons) : r.rejectionReasons;
          if (Array.isArray(rr)) reasons = rr;
        } catch {}
        return {
          id: r.id,
          serviceOrder: r.serviceOrder,
          technicianLdapId: r.technicianLdapId,
          applianceType: r.applianceType,
          warrantyProvider: r.warrantyProvider,
          createdAt: r.createdAt,
          reviewedAt: r.reviewedAt,
          reviewingAgentName: r.reviewingAgentName,
          reviewingAgentId: r.reviewedBy,
          rejectionReasons: reasons,
          photoCount,
          hasResubmission: !!r.hasResubmission,
        };
      });
      return res.status(200).json({ days, total: flagged.length, items: flagged });
    } catch (error) {
      console.error("Suspicious rejections error:", error);
      return res.status(500).json({ error: "Failed to get suspicious rejections" });
    }
  });

  // ========================================================================
  // CSV EXPORT ROUTE (Admin)
  // ========================================================================

  app.get("/api/admin/export-csv", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const vrsAiOnly = requestsVrsAiPilotScope(req.query as Record<string, unknown>);
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

      const allSubmissions = await storage.getAllSubmissions(
        startDate,
        endDate,
        techLdap || null,
        { vrsAiOnly },
      );

      // Tyler perf: build the id->name map in ONE query instead of a per-row
      // getUser N+1 (the row loop used to await storage.getUser for every
      // tech/reviewer/assignee). getUserName stays async so call sites are
      // unchanged; it's now just a map lookup with no DB round-trip.
      const allUsers = await storage.getUsers();
      const userCache: Record<number, string> = {};
      for (const u of allUsers) userCache[u.id] = u.name || "";
      const getUserName = async (userId: number | null): Promise<string> =>
        userId ? (userCache[userId] || "") : "";

      const headers = [
        "ID", "Service Order", "Technician LDAP", "Technician Name", "Phone",
        "District", "Appliance Type", "Request Type", "Warranty Type", "Warranty Provider",
        "Issue Description", "Estimate Amount",
        "Ticket Status", "Reviewed By", "Reviewed At", "Rejection Reasons",
        "Auth Code", "RGC Code", "Assigned To", "Claimed At",
        "Created At", "Updated At",
        "Replacement Review", "B2B Approved Replacement"
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
          (s as any).replacementReviewRecommended ? "YES" : "",
          (s as any).b2bApprovedReplacement ? "YES" : "",
        ].join(","));
      }

      const csv = rows.join("\n");
      let rangeLabel = customStart ? `${customStart}${customEnd ? '_to_' + customEnd : ''}` : range === "today" ? "today" : range === "week" ? "this-week" : range === "month" ? "this-month" : "all-time";
      if (techLdap) rangeLabel += `-tech-${techLdap}`;
      if (vrsAiOnly) rangeLabel += "-vrs-ai-pilot";
      const filename = `vrs-tickets-${rangeLabel}-${getEtDateString(now)}.csv`;

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

  app.get("/api/admin/replacement-review-analytics", authenticateToken, requireRole("admin"), async (_req, res) => {
    try {
      const analytics = await storage.getReplacementReviewAnalytics();
      return res.json(analytics);
    } catch (error) {
      console.error("Replacement Review analytics error:", error);
      return res.status(500).json({ error: "Failed to fetch Replacement Review analytics" });
    }
  });

  app.get("/api/admin/b2b-replacement-analytics", authenticateToken, requireRole("admin"), async (_req, res) => {
    try {
      const analytics = await storage.getB2bReplacementAnalytics();
      return res.json(analytics);
    } catch (error) {
      console.error("B2B Replacement analytics error:", error);
      return res.status(500).json({ error: "Failed to fetch B2B Replacement analytics" });
    }
  });

  app.get("/api/admin/export-xlsx", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const vrsAiOnly = requestsVrsAiPilotScope(req.query as Record<string, unknown>);
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
        const queueWait = formatDuration(s.createdAt, getQueueWaitEnd(s));
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

      const allSubmissions = await storage.getAllSubmissions(
        startDate,
        endDate,
        techLdap || null,
        { vrsAiOnly },
      );

      // Tyler perf: same N+1 removal as the CSV export — one getUsers() query
      // backs the name map for both the auth and NLA sheets below.
      const allUsers = await storage.getUsers();
      const userCache: Record<number, string> = {};
      for (const u of allUsers) userCache[u.id] = u.name || "";
      const getUserName = async (userId: number | null): Promise<string> =>
        userId ? (userCache[userId] || "") : "";

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
        "Queue Wait", "Handle Time", "Total Time",
        "Replacement Review", "B2B Approved Replacement",
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
          (s as any).replacementReviewRecommended ? "YES" : "",
          (s as any).b2bApprovedReplacement ? "YES" : "",
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
      if (vrsAiOnly) rangeLabel += "-vrs-ai-pilot";
      const filename = `vrs-tickets-${rangeLabel}-${getEtDateString(now)}.xlsx`;

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
  // REJECTION & COACHING REPORT + TECH PDC INTEGRATION (2026-08-06)
  // ========================================================================

  const NEGATIVE_STATUSES = ["rejected", "rejected_closed", "invalid"] as const;

  // Shared query logic for the coaching export + bulk Tech PDC push: mirrors
  // the admin Ticket Overview's active filters (createdAfter window, status
  // tab, request-type toggle, search text) so the export matches the table.
  const getCoachingRecords = async (query: any) => {
    const vrsAiOnly = requestsVrsAiPilotScope(query);
    const createdAfter = query.createdAfter ? new Date(query.createdAfter as string) : null;
    // Optional inclusive upper bound — mirrors the Ticket Overview's custom
    // date range so exports match the visible table.
    const createdBefore = query.createdBefore ? new Date(query.createdBefore as string) : null;
    const status = (query.status as string) || "all";
    const requestType = (query.requestType as string) || "all";
    // Task #43 — Tech PDC status filter, mirrors the Ticket Overview's new
    // Tech PDC dropdown so exports/bulk pushes match the visible table.
    // Values: all | sent | not_sent | pending | failed | missing_notes.
    const pdc = (query.pdc as string) || "all";
    const search = ((query.search as string) || "").toLowerCase().trim();

    const all = await storage.getAllSubmissions(
      createdAfter && !isNaN(createdAfter.getTime()) ? createdAfter : null,
      null,
      null,
      { vrsAiOnly },
    );
    const allUsers = await storage.getUsers();
    const usersById = new Map(allUsers.map(u => [u.id, u]));
    const userName: Record<number, string> = {};
    for (const u of allUsers) userName[u.id] = u.name || "";

    let rows = all.filter(s =>
      (NEGATIVE_STATUSES as readonly string[]).includes(s.ticketStatus)
    );
    if (createdBefore && !isNaN(createdBefore.getTime())) {
      rows = rows.filter(s =>
        s.createdAt && new Date(s.createdAt).getTime() <= createdBefore.getTime()
      );
    }
    if ((NEGATIVE_STATUSES as readonly string[]).includes(status)) {
      rows = rows.filter(s => s.ticketStatus === status);
    } else if (status !== "all") {
      // Task #43 — an explicitly selected non-negative status (queued /
      // pending / completed) can never contain coaching records, so the
      // visible table has zero negative rows. Return an empty set instead of
      // silently ignoring the status, otherwise the export / bulk push would
      // act on tickets the admin cannot see in the filtered table.
      rows = [];
    }
    if (requestType === "nla") rows = rows.filter(s => s.requestType === "parts_nla");
    else if (requestType === "auth") rows = rows.filter(s => s.requestType !== "parts_nla");
    if (pdc === "sent") rows = rows.filter(s => s.techPdcStatus === "sent");
    else if (pdc === "not_sent") rows = rows.filter(s => !s.techPdcStatus);
    else if (pdc === "pending") rows = rows.filter(s => s.techPdcStatus === "pending");
    else if (pdc === "failed") rows = rows.filter(s => s.techPdcStatus === "failed");
    else if (pdc === "missing_notes") rows = rows.filter(s => !(s.coachingNotes || "").trim());
    if (search) {
      rows = rows.filter(s => matchesTicketSearch({
        ...s,
        technicianName: userName[s.technicianId],
        workedAgentSearchTerms: ticketAgentIds(s).flatMap(id => {
          const agent = usersById.get(id);
          return agent ? [agent.name, agent.racId ?? ""] : [];
        }),
      }, search));
    }
    return { rows, userName };
  };

  // Editable coaching fields on a ticket — agents and admins can log or
  // revise coaching guidance after the fact from the detail view.
  const coachingPatchSchema = z.object({
    coachingNotes: z.string().max(5000).nullable().optional(),
    expectedVsActual: z.string().max(5000).nullable().optional(),
    rootCause: z.enum(TECH_PDC_ROOT_CAUSES).nullable().optional(),
  });
  app.patch("/api/submissions/:id/coaching", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid submission ID" });
      const parsed = coachingPatchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
      const submission = await storage.getSubmission(id);
      if (!submission) return res.status(404).json({ error: "Submission not found" });
      // Agents may only edit coaching on tickets they worked (assigned to
      // them or reviewed by them); admins can edit any.
      const requester = (req as AuthenticatedRequest).user!;
      if (requester.role === "vrs_agent" &&
          submission.assignedTo !== requester.id && submission.reviewedBy !== requester.id) {
        return res.status(403).json({ error: "You can only edit coaching notes on tickets you worked." });
      }
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.coachingNotes !== undefined) update.coachingNotes = parsed.data.coachingNotes || null;
      if (parsed.data.expectedVsActual !== undefined) update.expectedVsActual = parsed.data.expectedVsActual || null;
      if (parsed.data.rootCause !== undefined) update.techPdcRootCause = parsed.data.rootCause || null;
      const updated = await storage.updateSubmission(id, update as any);
      return res.json({ submission: updated });
    } catch (error) {
      console.error("Coaching update error:", error);
      return res.status(500).json({ error: "Failed to update coaching notes" });
    }
  });

  // Export Coaching & Rejection Report (CSV or XLSX), honoring the active
  // Ticket Overview filters passed as query params.
  app.get("/api/admin/export-coaching", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const format = (req.query.format as string) === "xlsx" ? "xlsx" : "csv";
      const { rows, userName } = await getCoachingRecords(req.query);

      const headers = [
        "Service Order", "Technician Name", "Technician ID",
        "Rejection Reason", "Supporting Details", "Expected vs Actual",
        "Coaching Notes", "Rejection Timestamp", "Ticket Status",
        "Rejected By", "Tech PDC Status", "Tech PDC Sent At",
      ];
      // Spreadsheet formula-injection guard: user-controlled text starting
      // with = + - @ (or tab/CR) would execute as a formula in Excel. Prefix
      // a single quote so both CSV and XLSX render it as literal text.
      const deFormula = (v: any) => {
        if (typeof v !== "string" || v.length === 0) return v;
        return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
      };
      const toRow = (s: any) => {
        let reasons = "";
        if (s.rejectionReasons) {
          try { reasons = JSON.parse(s.rejectionReasons).join("; "); } catch { reasons = s.rejectionReasons; }
        }
        if (!reasons) reasons = s.stage1RejectionReason || s.invalidReason || "";
        const supporting = [
          s.agentNotes ? `Agent notes: ${s.agentNotes}` : "",
          s.technicianMessage ? `Message to technician: ${s.technicianMessage}` : "",
          s.invalidInstructions ? `Instructions: ${s.invalidInstructions}` : "",
        ].filter(Boolean).join(" | ");
        const rejectedAt = rejectionTimestampOf(s);
        return [
          s.serviceOrder, userName[s.technicianId] || "", s.technicianLdapId || s.racId,
          reasons, supporting, s.expectedVsActual || "",
          s.coachingNotes || "", rejectedAt ? new Date(rejectedAt).toISOString() : "", s.ticketStatus,
          s.reviewedBy ? (userName[s.reviewedBy] || "") : "", s.techPdcStatus || "",
          s.techPdcSentAt ? new Date(s.techPdcSentAt).toISOString() : "",
        ].map(deFormula);
      };

      const filename = `coaching-rejection-report${requestsVrsAiPilotScope(req.query as Record<string, unknown>) ? "-vrs-ai-pilot" : ""}-${getEtDateString(new Date())}`;
      if (format === "xlsx") {
        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Coaching & Rejections");
        sheet.addRow(headers);
        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
        headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC0504D" } };
        for (const s of rows) sheet.addRow(toRow(s));
        headers.forEach((_h, i) => { sheet.getColumn(i + 1).width = 24; });
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
        await workbook.xlsx.write(res);
        return res.end();
      }

      const esc = (v: any) => {
        const str = v === null || v === undefined ? "" : String(v);
        return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
      };
      const csv = [headers, ...rows.map(toRow)].map(r => r.map(esc).join(",")).join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
      return res.send(csv);
    } catch (error) {
      console.error("Coaching export error:", error);
      return res.status(500).json({ error: "Failed to export coaching report" });
    }
  });

  // ---- Weekly IH tech no-login report (Wednesdays 5 PM ET scheduler; see
  // server/services/weekly-tech-report.ts). Admin-only list / download /
  // manual generate.
  app.get("/api/admin/reports/tech-no-login", authenticateToken, requireRole("admin", "super_admin"), async (_req, res) => {
    try {
      const { getLatestTechNoLoginReports } = await import("./services/weekly-tech-report");
      return res.json({ reports: await getLatestTechNoLoginReports() });
    } catch (error) {
      console.error("Weekly report list error:", error);
      return res.status(500).json({ error: "Failed to list weekly reports" });
    }
  });

  app.get("/api/admin/reports/tech-no-login/:id/csv", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const idParam = req.params.id;
      const id = typeof idParam === "string" ? parseInt(idParam, 10) : NaN;
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid report id" });
      const { getWeeklyReportById, TECH_NO_LOGIN_REPORT_TYPE } = await import("./services/weekly-tech-report");
      const report = await getWeeklyReportById(id);
      if (!report || report.reportType !== TECH_NO_LOGIN_REPORT_TYPE) {
        return res.status(404).json({ error: "Report not found" });
      }
      const etDate = new Date(report.generatedAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="ih-techs-not-signed-in-${etDate}.csv"`);
      return res.send(report.csv);
    } catch (error) {
      console.error("Weekly report download error:", error);
      return res.status(500).json({ error: "Failed to download report" });
    }
  });

  app.post("/api/admin/reports/tech-no-login/run", authenticateToken, requireRole("admin", "super_admin"), async (_req, res) => {
    try {
      const { generateTechNoLoginReport } = await import("./services/weekly-tech-report");
      const report = await generateTechNoLoginReport();
      if (!report) {
        throw new Error("Weekly report generation returned no report");
      }
      return res.json({ report: { id: report.id, generatedAt: report.generatedAt, summary: report.summary } });
    } catch (error) {
      console.error("Weekly report generation error:", error);
      return res.status(500).json({ error: "Failed to generate report" });
    }
  });

  // ========================================================================
  // WEEKLY EXECUTIVE SUMMARY (Tyler 2026-09-11)
  // Wednesdays 4:00 PM ET, emailed via SendGrid to the VRS Express owners.
  // See server/services/weekly-exec-summary.ts. Admin-only: list, preview
  // (renders without saving or sending), run now, and recipient management.
  // ========================================================================
  app.get("/api/admin/reports/exec-summary", authenticateToken, requireRole("admin", "super_admin"), async (_req, res) => {
    try {
      if (requestsVrsAiPilotScope(_req.query as Record<string, unknown>)) {
        return res.status(400).json({ error: GLOBAL_REPORT_PILOT_SCOPE_ERROR });
      }
      const { getLatestExecSummaries, getExecSummaryRecipients } =
        await import("./services/weekly-exec-summary");
      const {
        getEmailConfigurationStatus,
        isEmailConfigured,
        resolveFromAddress,
      } = await import("./services/email");
      return createExecSummaryHistoryHandler({
        getLatestExecSummaries,
        getExecSummaryRecipients,
        getEmailConfigurationStatus,
        isEmailConfigured,
        resolveFromAddress,
      })(_req, res);
    } catch (error: unknown) {
      console.error("Exec summary list error:", error instanceof Error ? error.message : "unknown error");
      return res.status(500).json({ error: "Failed to list executive summaries" });
    }
  });

  // Renders THIS MOMENT's summary as the email would look. Writes nothing to
  // weekly_reports and sends nothing — safe to hit as often as you like.
  // ?format=html returns the email body itself so it can be eyeballed in a
  // browser tab; the default JSON carries the same html plus the raw numbers.
  app.get("/api/admin/reports/exec-summary/preview", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const { computeExecSummary, renderExecSummaryHtml, renderExecSummaryText, execSummarySubject, getExecSummaryRecipients } =
        await import("./services/weekly-exec-summary");
      const data = await computeExecSummary();
      const html = renderExecSummaryHtml(data);
      if (String(req.query.format || "").toLowerCase() === "html") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.send(html);
      }
      return res.json({
        subject: execSummarySubject(data),
        recipients: await getExecSummaryRecipients(),
        data,
        html,
        text: renderExecSummaryText(data),
      });
    } catch (error: unknown) {
      console.error("Exec summary preview error:", error instanceof Error ? error.message : "unknown error");
      return res.status(500).json({ error: "Failed to build executive summary preview" });
    }
  });

  // Read one report's durable delivery ledger. The route is deliberately
  // separate from the report list so a status refresh never regenerates a
  // report or attempts an email.
  app.get("/api/admin/reports/exec-summary/:id/delivery", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const reportId = Number(req.params.id);
      if (!Number.isSafeInteger(reportId) || reportId <= 0) {
        return res.status(400).json({ error: "Invalid report id" });
      }
      const { getExecSummaryDeliveryStatus } =
        await import("./services/weekly-exec-summary");
      const delivery = await getExecSummaryDeliveryStatus(reportId);
      // A generate-only report intentionally has no delivery row. Returning
      // 200 with a null ledger lets the admin distinguish "generated only"
      // from an API failure without creating delivery intent.
      return res.json({ reportId, delivery });
    } catch (error: unknown) {
      // Do not serialize database/provider errors. They can contain SQL,
      // recipient addresses, or provider response details.
      console.error("Exec summary delivery status error:", error instanceof Error ? error.message : "unknown error");
      return res.status(500).json({ error: "Failed to load executive summary delivery status" });
    }
  });

  // Send an already-generated report (or the latest report when reportId is
  // omitted). A request key is required so repeated/concurrent clicks resolve
  // to the same durable attempt instead of creating duplicate sends. The
  // service owns the accepted/unknown safety rules; `resend:true` is the
  // explicit operator acknowledgement needed for accepted or unknown state.
  app.post("/api/admin/reports/exec-summary/send", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      if (requestsVrsAiPilotScope(req.body as Record<string, unknown>)) {
        return res.status(400).json({ error: GLOBAL_REPORT_PILOT_SCOPE_ERROR });
      }
      const { getLatestExecSummaries, retryExecSummaryDelivery } =
        await import("./services/weekly-exec-summary");
      return createExecSummarySendHandler({
        getLatestExecSummaries,
        retryExecSummaryDelivery,
      })(req, res);
    } catch (error: unknown) {
      console.error("Exec summary send route setup error:", error instanceof Error ? error.message : "unknown error");
      return res.status(500).json({ error: "Failed to send executive summary" });
    }
  });

  app.post("/api/admin/reports/exec-summary/:id/retry", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const reportId = Number(req.params.id);
      if (!Number.isSafeInteger(reportId) || reportId <= 0) {
        return res.status(400).json({ error: "Invalid report id" });
      }
      const parsed = z.object({
        resend: z.boolean().default(false),
        requestKey: z.string().trim().min(8).max(200),
      }).safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: "resend and a valid requestKey are required" });
      }

      const { retryExecSummaryDelivery } =
        await import("./services/weekly-exec-summary");
      const deliveryResult = await retryExecSummaryDelivery(reportId, {
        resend: parsed.data.resend,
        requestKey: parsed.data.requestKey,
      });
      return res.json({
        reportId,
        action: deliveryResult?.action,
        delivery: deliveryResult?.delivery ?? deliveryResult,
      });
    } catch (error: unknown) {
      console.error("Exec summary retry error:", error instanceof Error ? error.message : "unknown error");
      return res.status(500).json({ error: "Failed to retry executive summary delivery" });
    }
  });

  // Generate now. Body: { send?: boolean, dryRun?: boolean }.
  //   send:false   -> persist the report, email nobody.
  //   dryRun:true  -> persist, log the intended recipients, call no provider.
  // Default (no body) retains scheduler compatibility and persists + sends.
  // Explicit sends of an existing/current report belong to /send above.
  app.post("/api/admin/reports/exec-summary/run", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const { generateAndSendExecSummary } =
        await import("./services/weekly-exec-summary");
      return createExecSummaryGenerateHandler({ generateAndSendExecSummary })(req, res);
    } catch (error: unknown) {
      console.error("Exec summary run route setup error:", error instanceof Error ? error.message : "unknown error");
      return res.status(500).json({ error: "Failed to generate executive summary" });
    }
  });

  app.put("/api/admin/reports/exec-summary/recipients", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      const { EXEC_SUMMARY_RECIPIENTS_SETTING, getExecSummaryRecipients } = await import("./services/weekly-exec-summary");
      const { isPlausibleEmail } = await import("./services/email");
      const raw = (req.body || {}).recipients;
      const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,;\s]+/);
      const cleaned = Array.from(
        new Set(list.map((s: unknown) => String(s).trim()).filter((s: string) => s.length > 0)),
      );
      const invalid = cleaned.filter((s: string) => !isPlausibleEmail(s));
      if (invalid.length) {
        return res.status(400).json({ error: `Not valid email addresses: ${invalid.join(", ")}` });
      }
      if (cleaned.length === 0) {
        return res.status(400).json({ error: "At least one recipient is required" });
      }
      await storage.setSystemSetting(EXEC_SUMMARY_RECIPIENTS_SETTING, cleaned.join(","));
      return res.json({ recipients: await getExecSummaryRecipients() });
    } catch (error: unknown) {
      console.error("Exec summary recipients error:", error instanceof Error ? error.message : "unknown error");
      return res.status(500).json({ error: "Failed to update recipients" });
    }
  });

  // Bulk push: transmit all currently-filtered rejection/coaching records to
  // Tech PDC. Sequential sends (volume is small) so status columns stay
  // accurate; returns a summary the UI toasts.
  app.post("/api/tech-pdc/export", authenticateToken, requireRole("admin", "super_admin"), async (req, res) => {
    try {
      if (!isTechPdcConfigured()) {
        return res.status(503).json({ error: TECH_PDC_NOT_CONFIGURED_MESSAGE, code: "TECH_PDC_NOT_CONFIGURED" });
      }
      // Accept the scope in either the filter body or query string. Query
      // scope wins so a caller cannot accidentally drop the Pilot boundary
      // while constructing the existing filter body.
      const coachingQuery = {
        ...(req.body || {}),
        ...(requestsVrsAiPilotScope(req.query as Record<string, unknown>)
          ? { vrsAiOnly: true }
          : {}),
      };
      const { rows, userName } = await getCoachingRecords(coachingQuery);
      // Skip records already delivered unless the caller asks to resend.
      const resend = Boolean((req.body || {}).resendDelivered);
      const notSent = resend ? rows : rows.filter(s => s.techPdcStatus !== "sent");
      // Root cause is required by the Tech PDC API — skip (don't fail) rows
      // where nobody has selected one yet, and report the count so the UI
      // can prompt the admin.
      const toSend = notSent.filter(s => s.techPdcRootCause);
      let sent = 0, failed = 0;
      for (const s of toSend) {
        const result = await pushSubmissionToTechPdc(s, userName[s.technicianId] || null);
        if (result.ok) sent++; else failed++;
      }
      return res.json({
        total: rows.length,
        attempted: toSend.length,
        sent,
        failed,
        skippedAlreadySent: rows.length - notSent.length,
        skippedMissingRootCause: notSent.length - toSend.length,
      });
    } catch (error) {
      console.error("Tech PDC bulk push error:", error);
      return res.status(500).json({ error: "Failed to push records to Tech PDC" });
    }
  });

  // Single-ticket push / retry from the detail view.
  app.post("/api/submissions/:id/tech-pdc-push", authenticateToken, requireRole("vrs_agent", "admin", "super_admin"), async (req, res) => {
    try {
      if (!isTechPdcConfigured()) {
        return res.status(503).json({ error: TECH_PDC_NOT_CONFIGURED_MESSAGE, code: "TECH_PDC_NOT_CONFIGURED" });
      }
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid submission ID" });
      const submission = await storage.getSubmission(id);
      if (!submission) return res.status(404).json({ error: "Submission not found" });
      if (!(NEGATIVE_STATUSES as readonly string[]).includes(submission.ticketStatus)) {
        return res.status(400).json({ error: "Only rejected, closed, or invalid tickets can be sent to Tech PDC" });
      }
      // Agents may only push tickets they worked; admins can push any.
      const requester = (req as AuthenticatedRequest).user!;
      if (requester.role === "vrs_agent" &&
          submission.assignedTo !== requester.id && submission.reviewedBy !== requester.id) {
        return res.status(403).json({ error: "You can only send tickets you worked to Tech PDC." });
      }
      const tech = await storage.getUser(submission.technicianId);
      const result = await pushSubmissionToTechPdc(submission, tech?.name || null);
      const updated = await storage.getSubmission(id);
      if (result.ok) {
        // Notify admins in real time when an AGENT (not an admin) sends a
        // coaching record to Tech PDC.
        if (requester.role === "vrs_agent") {
          broadcastToAdmins({
            type: "tech_pdc_pushed",
            payload: {
              submissionId: submission.id,
              serviceOrder: submission.serviceOrder,
              technicianName: tech?.name || submission.technicianLdapId || submission.racId,
              agentName: requester.name,
              rootCause: submission.techPdcRootCause,
            },
          });
        }
        return res.json({ ok: true, submission: updated });
      }
      return res.status(502).json({ ok: false, error: result.error, submission: updated });
    } catch (error) {
      console.error("Tech PDC push error:", error);
      return res.status(500).json({ error: "Failed to push record to Tech PDC" });
    }
  });

  // ========================================================================
  // TECHNICIAN SYNC ROUTES (Admin)
  // ========================================================================

  app.post("/api/admin/sync-technicians", authenticateToken, requireRole("admin"), async (req, res) => {
    try {
      const result = await runTechnicianSync();
      return res.status(200).json(result);
    } catch (error: any) {
      console.error("Snowflake sync error:", error);
      return res.status(500).json({ error: `Sync failed: ${error.message || "Unknown error"}` });
    }
  });

  app.get(["/api/tech/lookup-warranty", "/api/tech/lookup-warranty/:serviceOrder"], authenticateToken, requireRole("technician", "flexed_technician"), async (req, res) => {
    // Pre-submission classification lookup (including older open forms using
    // the path-param URL). This does not grant access to an existing ticket.
    //
    // 1. Role gate (requireRole above): only technician / flexed_technician.
    //    All other roles (agents, admins, providers) receive 403 immediately.
    //
    // 2. No prior-submission requirement: this lookup runs BEFORE a new ticket
    //    exists. Submission-time Snowflake verification and all ticket access
    //    controls remain authoritative and unchanged.
    //
    // 3. Rate limiting (secondary defense-in-depth): caps Snowflake traffic
    //    to WARRANTY_LOOKUP_MAX_PER_WINDOW calls per rolling hour per user
    //    for all lookups, including first submissions and retries.
    //
    // Response scoping: procId and clientNm (third-party Snowflake identifiers)
    // are never returned to the client; only the derived warranty classification
    // is returned, plus the service order's product category (non-PII) and the
    // appliance type mapped from it, so the form can preselect the type and
    // show where it came from.
    //
    // Response (shared/warranty.ts WarrantyLookupResponse):
    //   { serviceOrder, derived, applianceType?, serviceOrderProduct? }
    //   derived: (DerivedWarranty & DerivedServiceOrderAppliance) | null.
    //     Stays null whenever the warranty is unknown: older open forms read
    //     any non-null derived as a locked warranty (derived.warrantyType).
    //   applianceType (top level, DerivedServiceOrderAppliance): whenever the
    //     appliance type is known, including when the warranty is unknown.
    //   serviceOrderProduct: { text, source }: the WOM Product Category, else
    //     the Snowflake HS_SP_CD. applianceType is mapped from that same text.
    //   Both are absent when unknown. The product lookup
    //   (resolveServiceOrderProduct: WOM bounded by WOM_TIMEOUT_MS, ~4s, in
    //   parallel with the Snowflake appliance statement, which has the
    //   ProcID lookup's deadline) runs in parallel with the ProcID lookup,
    //   so the response waits for the slower of the two, not their sum; its
    //   failure or timeout only drops these fields and never changes the
    //   warranty answer. A ProcID outage stays a 503 without the product
    //   (apiRequest throws on non-2xx, so the form never reads that body).
    try {
      const authReq = req as AuthenticatedRequest;
      const caller = authReq.user;
      if (!caller) {
        return res.status(401).json({ error: "No user found" });
      }
      const callerUserId = caller.id;
      const callerIdentity = caller.ldapId ?? caller.email;

      const so = String(req.params.serviceOrder || req.query.serviceOrder || "").trim();
      if (!/^\d{4}-\d{8}$/.test(so)) {
        return res.status(400).json({ error: "Invalid service order format" });
      }

      // Cap Snowflake traffic before every lookup, including first submissions.
      const now = Date.now();
      const cutoff = now - WARRANTY_LOOKUP_WINDOW_MS;
      const recentTimestamps = (warrantyLookupLog.get(callerUserId) ?? []).filter(ts => ts > cutoff);
      if (recentTimestamps.length >= WARRANTY_LOOKUP_MAX_PER_WINDOW) {
        console.warn(`[lookup-warranty] rate-limit exceeded: user=${callerIdentity} (${callerUserId}) so=${so} count=${recentTimestamps.length}`);
        return res.status(429).json({ error: "Too many warranty lookups. Please try again later." });
      }
      recentTimestamps.push(now);
      warrantyLookupLog.set(callerUserId, recentTimestamps);

      console.info(`[lookup-warranty] allowed: user=${callerIdentity} (${callerUserId}) so=${so}`);

      // In parallel; the product lookup never rejects (the catch is a backstop).
      const productPromise = Promise.resolve()
        .then(() => resolveServiceOrderProduct(so, {
          snowflake: fetchServiceOrderApplianceType,
          wom: lookupWomProductCategory,
        }))
        .catch(() => ({} as Awaited<ReturnType<typeof resolveServiceOrderProduct>>));
      const result = await fetchProcIdForServiceOrder(so);
      if (result.status === "LOOKUP_UNAVAILABLE") {
        return res.status(503).set("Retry-After", "5").json({
          error: "Warranty lookup temporarily unavailable. Please try again.",
          code: "LOOKUP_UNAVAILABLE", retryable: true,
        });
      }
      const derived = deriveWarrantyFromProcId(result.procId, result.clientNm);
      const { applianceType, serviceOrderProduct } = await productPromise;

      // Only the derived classification and the product: not procId or clientNm.
      const body: WarrantyLookupResponse = {
        serviceOrder: so,
        derived: derived ? { ...derived, ...(applianceType ? { applianceType } : {}) } : null,
        ...(applianceType ? { applianceType } : {}),
        ...(serviceOrderProduct ? { serviceOrderProduct } : {}),
      };
      res.json(body);
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
      let unavailable = 0;
      let failedUpdates = 0;

      for (const sub of missing) {
        try {
          const result = await fetchProcIdForServiceOrder(sub.serviceOrder);
          const outcome = await applyProcIdRepair(result, fields =>
            storage.updateSubmission(sub.id, fields as any));
          if (outcome === "LOOKUP_UNAVAILABLE") {
            unavailable++;
            continue; // Preserve every existing classification; retry on a later run.
          }
          if (outcome === "FOUND") {
            updated++;
          } else {
            failed++;
          }
        } catch (err) {
          console.error(`Backfill failed for submission ${sub.id}:`, err);
          failedUpdates++;
        }
      }

      return res.status(200).json({
        total: allSubs.length,
        needingBackfill: missing.length,
        updated,
        notFound: failed,
        unavailable,
        failedUpdates,
        retryable: unavailable > 0 || failedUpdates > 0,
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
        // CSV import only ever assigns "admin" or "vrs_agent" (line above).
        // super_admin is intentionally not creatable via CSV; only "admin"
        // gets full division access by seed.
        if (role === "admin") {
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
      const idParam = req.params.id;
      const id = typeof idParam === "string" ? parseInt(idParam, 10) : NaN;
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
  // SCOPED MEDIA TOKEN ENDPOINT
  // ========================================================================
  //
  // Issues a short-lived (30 min), path-bound JWT with { type:"media", path }
  // for GET/HEAD /objects/* serving.  The full session JWT is NOT accepted on
  // the media-serving route; only these narrow-claim tokens are, so a leaked
  // /objects/ URL never exposes full account credentials.
  //
  // Per-object authorization is enforced here at issuance time:
  //   • Agents, admins, super_admins → may access any stored object.
  //   • Technicians and 1099 providers → must own a submission that contains
  //     this objectPath in its media fields (DB lookup).
  //   • Feedback attachment paths for their own feedback are also allowed via
  //     the same submission-owner check (they share the same /objects/ space).

  app.get("/api/media-token", authenticateToken, async (req, res) => {
    try {
      const objectPath = typeof req.query.path === "string" ? req.query.path : null;

      if (!objectPath || !objectPath.startsWith("/objects/")) {
        return res.status(400).json({ error: "Invalid object path" });
      }

      const user = (req as AuthenticatedRequest).user!;
      const userId = user.id;
      const role = user.role;

      // Trusted staff roles: can access any stored media
      const staffRoles = ["vrs_agent", "admin", "super_admin"];
      if (!staffRoles.includes(role)) {
        // Technicians and 1099 providers: verify the path belongs to one of
        // their submissions. LIKE on the text/JSON columns is fine here — the
        // paths are UUIDs so false-positive substring matches are impossible.
        const matchPath = `%${objectPath}%`;
        const rows = await db.execute(sql`
          SELECT id FROM submissions
          WHERE technician_id = ${userId}
          AND (
            video_url = ${objectPath}
            OR voice_note_url = ${objectPath}
            OR photos::text LIKE ${matchPath}
            OR photo_thumbnails::text LIKE ${matchPath}
            OR rejected_media::text LIKE ${matchPath}
          )
          LIMIT 1
        `);

        if (!rows.rows || rows.rows.length === 0) {
          return res.status(403).json({ error: "Access denied" });
        }
      }

      const token = issueMediaToken(objectPath);
      return res.json({ token });
    } catch (error) {
      console.error("Media token error:", error);
      return res.status(500).json({ error: "Failed to issue media token" });
    }
  });

  // Tyler 2026-07-08 (perf) — batched variant of GET /api/media-token.
  // A ticket with 12 photos + 12 thumbs used to fire ~24 near-simultaneous
  // token GETs the moment the media grid mounted. This issues all tokens in
  // ONE round trip (and, for techs/providers, one ownership query instead of
  // one per path). Authorization parity with the single-path route:
  //   • staff (vrs_agent/admin/super_admin) → any stored object;
  //   • technician/provider_1099 → fetch the media columns of the caller's
  //     OWN submissions, then verify EACH requested path individually in JS.
  //     A row merely matching *some* path never unlocks the others — one
  //     legitimate path can't be used to batch-mint tokens for someone
  //     else's media. Unverified paths are silently omitted; the client
  //     falls back to the single-path route (which 403s) for those.
  app.post("/api/media-tokens", authenticateToken, async (req, res) => {
    try {
      const bodySchema = z.object({
        paths: z
          .array(z.string().max(500).startsWith("/objects/"))
          .min(1)
          .max(60),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request" });
      }
      const paths = Array.from(new Set(parsed.data.paths));

      const user = (req as AuthenticatedRequest).user!;
      const staffRoles = ["vrs_agent", "admin", "super_admin"];
      let allowedPaths: string[];

      if (staffRoles.includes(user.role)) {
        allowedPaths = paths;
      } else {
        const pathChecks = paths.map((p) => {
          const like = `%${p}%`;
          return sql`(video_url = ${p} OR voice_note_url = ${p} OR photos::text LIKE ${like} OR photo_thumbnails::text LIKE ${like} OR rejected_media::text LIKE ${like})`;
        });
        const rows = await db.execute(sql`
          SELECT video_url, voice_note_url,
                 photos::text AS photos_text,
                 photo_thumbnails::text AS thumbs_text,
                 rejected_media::text AS rejected_text
          FROM submissions
          WHERE technician_id = ${user.id}
          AND (${sql.join(pathChecks, sql` OR `)})
        `);
        const owned = rows.rows || [];
        allowedPaths = paths.filter((p) =>
          owned.some(
            (r: any) =>
              r.video_url === p ||
              r.voice_note_url === p ||
              (typeof r.photos_text === "string" && r.photos_text.includes(p)) ||
              (typeof r.thumbs_text === "string" && r.thumbs_text.includes(p)) ||
              (typeof r.rejected_text === "string" && r.rejected_text.includes(p)),
          ),
        );
      }

      const tokens: Record<string, string> = {};
      for (const p of allowedPaths) {
        tokens[p] = issueMediaToken(p);
      }
      return res.json({ tokens });
    } catch (error) {
      console.error("Batch media token error:", error);
      return res.status(500).json({ error: "Failed to issue media tokens" });
    }
  });

  // DEV-only Bridge sender-photo endpoint. It reads the stored Bridge payload
  // server-side and never accepts an upstream URL from the browser.
  const { BridgePhotoReliability } = await import("./vrs-bridge-photo-reliability");
  const bridgePhotoReliability = new BridgePhotoReliability(
    pool, vrsBridgePhotoStorage, async (checkName, entityId, finding) => {
      if (checkName === "bridge_photo_capture_recovered") {
        for (const check of ["bridge_photo_capture_at_risk", "bridge_photo_capture_failed"]) {
          const incident = await storage.findOpenHealthIncident(check, "submission", entityId);
          if (incident) await storage.clearHealthIncident(incident.id);
        }
        return;
      }
      await storage.openHealthIncident({
        checkName, entityType: "submission", entityId,
        severity: checkName.endsWith("failed") ? "error" : "warning", finding,
      });
    },
  );
  registerVrsBridgePhotoProxy(app, {
    authenticate: authenticateToken,
    getSubmission: (id) => storage.getSubmission(id),
    getBridge: (submissionId) => vrsBridgeStore.getBySubmissionId(submissionId),
    getSpecializations: (userId) => storage.getSpecializations(userId),
    allDivisionCount: ALL_DIVISIONS.length,
    isEnabled: isVrsBridgePhotoProxyEnabled,
    getStoredPhoto: (submissionId, photoIndex, sourceUrl) =>
      vrsBridgePhotoStorage.get(submissionId, photoIndex, Date.now(), sourceUrl),
    downloadStoredPhoto: (photo, req, res) =>
      vrsObjectStorageService.downloadObject(
        photo.file,
        res,
        3600,
        req.headers.range as string | undefined,
        "private, no-store",
      ),
    savePhoto: async (submissionId, photoIndex, image, sourceUrl) => {
      const bridge = await vrsBridgeStore.getBySubmissionId(submissionId);
      if (!bridge?.createdAt) throw new Error("BRIDGE_PHOTO_RETENTION_UNKNOWN");
      const retentionExpiresAt =
        bridge.createdAt.getTime() + VRS_BRIDGE_PHOTO_RETENTION_MS;
      await vrsBridgePhotoStorage.save(
        submissionId,
        photoIndex,
        image,
        Date.now(),
        retentionExpiresAt,
        sourceUrl,
      );
    },
    reportStorageError: (operation) => {
      console.error(`[retention] bridge photo storage ${operation} failed`);
    },
  });

  // Durable Sasha copies are explicitly DEV-only. On a restart, retry only
  // rows created within the two-hour upstream-link window; an expired source
  // is reported as an aggregate failure and is never logged or returned.
  if (process.env.NODE_ENV !== "test") {
    let recoveryRunning = false;
    const recoverBridgePhotos = async () => {
      if (!isVrsBridgePhotoProxyEnabled()) return;
      if (recoveryRunning) return;
      recoveryRunning = true;
      try {
        await bridgePhotoReliability.recover();
      } catch {
        console.error("[retention] bridge photo recovery failed");
        await storage.openHealthIncident({
          checkName: "bridge_photo_recovery_unavailable", entityType: "system", entityId: 0,
          severity: "error", finding: {
            message: "Bridge photo recovery is unavailable. Check DEV status-table migration and database/private-storage access immediately; source photos expire after two hours.",
          },
        }).catch(() => console.error("[retention] bridge photo alert failed"));
      } finally {
        recoveryRunning = false;
      }
    };
    const cleanupExpiredBridgePhotos = async () => {
      try {
        // Shared buckets have no environment namespace. Never infer orphan
        // status from this environment's DB; only stored TTL is authoritative.
        const deleted = await vrsBridgePhotoStorage.sweep(
          Date.now(),
        );
        if (deleted > 0) {
          console.log(`[retention] bridge photos: deleted ${deleted} expired object(s)`);
        }
      } catch {
        console.error("[retention] bridge photo cleanup failed");
      }
    };
    void recoverBridgePhotos();
    void cleanupExpiredBridgePhotos();
    const BRIDGE_PHOTO_RECOVERY_MS = 60 * 1000;
    const BRIDGE_PHOTO_SWEEP_MS = 60 * 60 * 1000;
    setInterval(() => void recoverBridgePhotos(), BRIDGE_PHOTO_RECOVERY_MS).unref();
    setInterval(() => void cleanupExpiredBridgePhotos(), BRIDGE_PHOTO_SWEEP_MS).unref();
  }

  // ========================================================================
  // TECHHUB PARTS PHOTOS (read-only Snowflake lookup + CDN proxy)
  // ========================================================================
  //
  // Surfaces technician-uploaded PART photos from the TechHub app (synced into
  // Snowflake) alongside the VRS-native media on a ticket. Snowflake stores only
  // references; the bytes live in an external CDN/S3 that VRS does not own, so we
  // proxy them server-side (never expose raw bucket URLs) and gate every byte
  // behind the same per-ticket authorization as the submission detail route.
  //
  // Flow:
  //   1. GET /api/submissions/:id/techhub-photos  (session JWT + per-ticket guard)
  //      -> queries Snowflake by the ticket's service order, normalizes the
  //         refs, and returns one short-lived scoped token per photo.
  //   2. GET /api/techhub-photo?token=...  (scoped token only, no session JWT)
  //      -> verifies the token, re-checks the host allowlist, streams the bytes.

  app.get("/api/submissions/:id/techhub-photos", authenticateToken, async (req, res) => {
    try {
      if (!isTechHubPhotosEnabled()) {
        return res.status(200).json({ enabled: false, photos: [] });
      }

      const authReq = req as AuthenticatedRequest;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid submission ID" });
      }

      const submission = await storage.getSubmission(id);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      // Per-ticket access guard — mirrors GET /api/submissions/:id exactly.
      const user = authReq.user!;
      if ((user.role === "technician" || user.role === "provider_1099") && submission.technicianId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (user.role === "vrs_agent") {
        const isAssignedToAgent = submission.assignedTo === user.id;
        const isQueued = submission.ticketStatus === "queued";
        const isReviewer = submission.reviewedBy === user.id;
        if (!isAssignedToAgent && !isQueued && !isReviewer) {
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

      const found = await fetchTechHubPartsPhotosForServiceOrder(submission.serviceOrder);
      const photos = found.map((p) => ({
        proxyPath: `/api/techhub-photo?token=${encodeURIComponent(issueTechHubPhotoToken(p.url))}`,
        partNumber: p.partNumber,
        brand: p.brand,
        partType: p.partType,
        createdAt: p.createdAt,
      }));

      return res.status(200).json({ enabled: true, photos });
    } catch (error) {
      console.error("TechHub photos error:", error);
      return res.status(500).json({ error: "Failed to load TechHub photos" });
    }
  });

  // Scoped proxy: accepts ONLY a techhub_photo token (no session JWT), so a
  // leaked proxy URL exposes a single image for <=30 min and nothing else. The
  // token already encodes a URL we signed; we still re-validate the host against
  // the allowlist before any outbound fetch (defense-in-depth vs. SSRF).
  app.get("/api/techhub-photo", async (req, res) => {
    try {
      const token = typeof req.query.token === "string" ? req.query.token : null;
      if (!token) {
        return res.status(401).json({ error: "No token provided" });
      }
      const url = verifyTechHubPhotoToken(token);
      if (!url) {
        return res.status(403).json({ error: "Invalid or expired token" });
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return res.status(400).json({ error: "Invalid photo URL" });
      }
      if (parsedUrl.protocol !== "https:") {
        return res.status(403).json({ error: "Scheme not allowed" });
      }
      if (!TECHHUB_ALLOWED_HOSTS.has(parsedUrl.hostname)) {
        return res.status(403).json({ error: "Host not allowed" });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let upstream: globalThis.Response;
      try {
        upstream = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!upstream.ok || !upstream.body) {
        // 403 here most likely means the CDN requires signed URLs (the one open
        // item from discovery) — surface it as a bad gateway, not a 500.
        return res.status(502).json({ error: `Upstream returned ${upstream.status}` });
      }

      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=300");
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.status(200).send(buf);
    } catch (error) {
      console.error("TechHub photo proxy error:", error);
      return res.status(502).json({ error: "Failed to fetch photo" });
    }
  });

  // ========================================================================
  // VIDEO CONVERSION ROUTE
  // ========================================================================

  const convertMediaSchema = z.object({
    objectPath: z.string().min(1),
  });

  app.post("/api/uploads/convert-audio", authenticateToken, requireRole("technician", "provider_1099"), async (req, res) => {
    const parsed = convertMediaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "objectPath is required" });
    }

    const { objectPath } = parsed.data;

    // Ownership check: the objectPath must have been issued to this
    // technician via POST /api/uploads/request-url in the current
    // session.  This prevents one technician from triggering ffmpeg
    // processing on another user's stored media.
    const callerUserId = (req as AuthenticatedRequest).user?.id;
    if (!callerUserId || !verifyUploadOwnership(objectPath, callerUserId)) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Saturation guard — reject before we stream anything to /tmp.
    if (ffmpegQueueSaturated()) {
      console.warn(`Audio conversion rejected: queue saturated (depth=${ffmpegQueueDepth})`);
      return res.status(503).json({
        objectPath,
        converted: false,
        error: "Server is busy processing other media. Please try again in a few minutes.",
      });
    }

    const objectStorageService = new ObjectStorageService();
    const inputPath = `/tmp/audio-input-${randomUUID()}`;
    const outputPath = `/tmp/audio-output-${randomUUID()}.mp3`;

    // Hard limit: refuse to transcode files larger than 200 MB.
    const MAX_CONVERT_BYTES = 200 * 1024 * 1024;

    try {
      const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

      // Check the actual GCS object size BEFORE streaming to /tmp so
      // we never write oversized bytes to disk or consume bandwidth on
      // a file we will ultimately reject.  A client that lied about size
      // at request-url time is caught here via the authoritative GCS metadata.
      const [meta] = await objectFile.getMetadata();
      const remoteSize = Number(meta.size ?? 0);
      if (!remoteSize || remoteSize > MAX_CONVERT_BYTES) {
        return res.status(413).json({ objectPath, converted: false, error: "File too large for conversion" });
      }

      const readStream = objectFile.createReadStream();
      const writeStream = createWriteStream(inputPath);
      await pipeline(readStream, writeStream);

      // Queued + low-priority like video conversion: audio transcodes are
      // shorter but still CPU-bound, and must not stack on top of a running
      // video transcode.
      await runFfmpegQueued("audio-convert", () =>
        execFfmpegLowPriority([
          "-i", inputPath,
          "-codec:a", "libmp3lame",
          "-qscale:a", "4",
          "-y",
          outputPath,
        ], { timeout: 60000 }),
      );

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const newObjectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      // Tyler 2026-05-12 — stream the converted file to GCS instead of
      // readFileSync into a Buffer. A 200MB audio Buffer + ffmpeg's residual
      // RSS was the OOM trigger that took the smallest Reserved VM tier down.
      const outputStat = fs.statSync(outputPath);
      const uploadRes = await fetch(uploadURL, {
        method: "PUT",
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(outputStat.size),
        },
        body: Readable.toWeb(fs.createReadStream(outputPath)) as any,
        duplex: "half",
      } as any);

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

  app.post("/api/uploads/convert-video", authenticateToken, requireRole("technician", "provider_1099"), async (req, res) => {
    const parsed = convertMediaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "objectPath is required" });
    }

    const { objectPath } = parsed.data;

    // Ownership check: the objectPath must have been issued to this
    // technician via POST /api/uploads/request-url in the current session.
    const callerUserId = (req as AuthenticatedRequest).user?.id;
    if (!callerUserId || !verifyUploadOwnership(objectPath, callerUserId)) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Saturation guard — reject before we stream anything to /tmp.
    if (ffmpegQueueSaturated()) {
      console.warn(`Video conversion rejected: queue saturated (depth=${ffmpegQueueDepth})`);
      return res.status(503).json({
        converted: false,
        failed: true,
        error: "Server is busy processing other videos. Please try again in a few minutes.",
      });
    }

    const objectStorageService = new ObjectStorageService();
    const inputPath = `/tmp/video-input-${randomUUID()}`;
    const outputPath = `/tmp/video-output-${randomUUID()}.mp4`;

    // Hard limit: refuse to transcode files larger than 200 MB.
    const MAX_CONVERT_BYTES = 200 * 1024 * 1024;

    try {
      const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

      // Check the actual GCS object size BEFORE streaming to /tmp.
      // Catches clients that lied about size at upload-request time.
      const [meta] = await objectFile.getMetadata();
      const remoteSize = Number(meta.size ?? 0);
      if (!remoteSize || remoteSize > MAX_CONVERT_BYTES) {
        return res.status(413).json({ converted: false, failed: true, error: "File too large for conversion" });
      }

      const readStream = objectFile.createReadStream();
      const writeStream = createWriteStream(inputPath);
      await pipeline(readStream, writeStream);

      // Hardened conversion (see convertVideoToPlayableMp4 above). Handles
      // iPhone HEVC/fragmented-MOV/10-bit files that previously failed both
      // passes and got stored as unplayable originals.
      const conversion = await convertVideoToPlayableMp4(inputPath, outputPath);

      if (!conversion.ok) {
        // BOTH passes failed. Do NOT pretend success with the unplayable
        // original — the technician's UI now rejects this so they can retry.
        console.error(
          "Video conversion failed (both passes) for", objectPath,
          "| primary:", conversion.primaryError,
          "| fallback:", conversion.fallbackError,
        );
        try { await unlink(inputPath); } catch {}
        try { await unlink(outputPath); } catch {}
        return res.status(200).json({
          converted: false,
          failed: true,
          error: "Video could not be converted to a playable format.",
        });
      }

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const newObjectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      // Tyler 2026-05-12 — stream the converted file to GCS instead of
      // readFileSync into a Buffer. iPhone 4K .mov re-encodes routinely produce
      // 100-200MB MP4 outputs, and a Buffer that large on top of ffmpeg's
      // residual RSS pushed the smallest Reserved VM into OOM kill.
      const outputStat = fs.statSync(outputPath);
      const uploadRes = await fetch(uploadURL, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(outputStat.size),
        },
        body: Readable.toWeb(fs.createReadStream(outputPath)) as any,
        duplex: "half",
      } as any);

      if (!uploadRes.ok) {
        throw new Error(`Upload failed with status ${uploadRes.status}`);
      }

      try { await unlink(inputPath); } catch {}
      try { await unlink(outputPath); } catch {}

      console.log(
        `Video conversion: success (mode=${conversion.mode}) ${objectPath} -> ${newObjectPath} (${outputStat.size} bytes)`,
      );
      return res.status(200).json({ objectPath: newObjectPath, converted: true });
    } catch (error: any) {
      console.error("Video conversion error:", error);
      try { await unlink(inputPath); } catch {}
      try { await unlink(outputPath); } catch {}
      // Infrastructure error (download/upload/etc), not necessarily an
      // unconvertible file. Still surface failure so we don't store an
      // unplayable original silently.
      return res.status(200).json({ converted: false, failed: true, error: error.message || "Conversion failed" });
    }
  });

  // ========================================================================
  // ONE-TIME VIDEO RECOVERY ROUTE
  //
  // Recovers already-stored videos that are in an unplayable codec (iPhone
  // HEVC/H.265 or 10-bit) because the old conversion silently failed. This
  // is the lowest-risk recovery option chosen over convert-on-demand at
  // serve time: it does NOT touch the (working) object-storage serving
  // route, transcodes each affected video exactly once, and replaces the
  // stored path in-place so existing <video src> bindings keep working. The
  // original objects are left in storage (only the DB path is repointed), so
  // the operation is reversible if needed.
  //
  // Admin-triggered, scoped to recent tickets (default 30 days). Supports a
  // dryRun mode that probes + reports without re-encoding.
  // ========================================================================
  const reconvertVideosSchema = z.object({
    sinceHours: z.number().int().positive().max(24 * 365).optional(),
    submissionId: z.number().int().positive().optional(),
    dryRun: z.boolean().optional(),
  });

  app.post("/api/admin/reconvert-videos", authenticateToken, requireRole("admin"), async (req, res) => {
    const parsed = reconvertVideosSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body" });
    }
    const { submissionId, dryRun } = parsed.data;
    const sinceHours = parsed.data.sinceHours ?? 24 * 30;

    const objectStorageService = new ObjectStorageService();

    type VideoReport = {
      submissionId: number;
      objectPath: string;
      codec?: string;
      pixFmt?: string;
      playable: boolean;
      action: "kept" | "reconverted" | "would_reconvert" | "error";
      newObjectPath?: string;
      error?: string;
    };
    const reports: VideoReport[] = [];

    try {
      let targets: { id: number; videoUrl: string | null }[];
      if (submissionId) {
        const sub = await storage.getSubmission(submissionId);
        targets = sub ? [{ id: sub.id, videoUrl: sub.videoUrl }] : [];
      } else {
        const since = new Date(Date.now() - sinceHours * 3600000);
        const all = await storage.getAllSubmissions(since, null, null);
        targets = all.map((s) => ({ id: s.id, videoUrl: s.videoUrl }));
      }

      let scannedVideos = 0;
      let reconverted = 0;
      let wouldReconvert = 0;

      for (const target of targets) {
        const urls = parseVideoUrlsServer(target.videoUrl);
        if (urls.length === 0) continue;

        let changed = false;
        const nextUrls = [...urls];

        for (let i = 0; i < urls.length; i++) {
          const objectPath = urls[i];
          scannedVideos++;
          const inputPath = `/tmp/recover-input-${randomUUID()}`;
          const outputPath = `/tmp/recover-output-${randomUUID()}.mp4`;
          try {
            const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
            await pipeline(objectFile.createReadStream(), createWriteStream(inputPath));

            const { codec, pixFmt } = await probeVideoStream(inputPath);
            const playable = isBrowserPlayableVideo(codec, pixFmt);

            if (playable) {
              reports.push({ submissionId: target.id, objectPath, codec, pixFmt, playable, action: "kept" });
              try { await unlink(inputPath); } catch {}
              continue;
            }

            if (dryRun) {
              wouldReconvert++;
              reports.push({ submissionId: target.id, objectPath, codec, pixFmt, playable, action: "would_reconvert" });
              try { await unlink(inputPath); } catch {}
              continue;
            }

            const conversion = await convertVideoToPlayableMp4(inputPath, outputPath);
            if (!conversion.ok) {
              reports.push({
                submissionId: target.id, objectPath, codec, pixFmt, playable,
                action: "error",
                error: conversion.fallbackError || conversion.primaryError || "conversion failed",
              });
              try { await unlink(inputPath); } catch {}
              try { await unlink(outputPath); } catch {}
              continue;
            }

            const uploadURL = await objectStorageService.getObjectEntityUploadURL();
            const newObjectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
            const outputStat = fs.statSync(outputPath);
            const uploadRes = await fetch(uploadURL, {
              method: "PUT",
              headers: { "Content-Type": "video/mp4", "Content-Length": String(outputStat.size) },
              body: Readable.toWeb(fs.createReadStream(outputPath)) as any,
              duplex: "half",
            } as any);
            if (!uploadRes.ok) {
              throw new Error(`Upload failed with status ${uploadRes.status}`);
            }

            nextUrls[i] = newObjectPath;
            changed = true;
            reconverted++;
            console.log(
              `Video recovery: submission #${target.id} ${objectPath} (codec=${codec} pix=${pixFmt}) -> ${newObjectPath} (mode=${conversion.mode})`,
            );
            reports.push({ submissionId: target.id, objectPath, codec, pixFmt, playable, action: "reconverted", newObjectPath });

            try { await unlink(inputPath); } catch {}
            try { await unlink(outputPath); } catch {}
          } catch (err: any) {
            reports.push({ submissionId: target.id, objectPath, playable: false, action: "error", error: err?.message || String(err) });
            try { await unlink(inputPath); } catch {}
            try { await unlink(outputPath); } catch {}
          }
        }

        if (changed) {
          await storage.updateSubmission(target.id, { videoUrl: serializeVideoUrlsServer(nextUrls) ?? undefined });
        }
      }

      return res.status(200).json({
        dryRun: Boolean(dryRun),
        scannedSubmissions: targets.length,
        scannedVideos,
        reconverted,
        wouldReconvert,
        reports,
      });
    } catch (error: any) {
      console.error("Video recovery error:", error);
      return res.status(500).json({ error: error?.message || "Video recovery failed", reports });
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

        // Tyler 2026-04-30 / 2026-05-01: terminal-status set is shared
        // across AUTH and NLA via isTerminalTicketStatusForIntake (single
        // source of truth in shared/intake-form-config.ts). Both branches
        // require an intake form on every terminal outcome:
        //   AUTH/Infestation:  approved | completed | rejected | rejected_closed | invalid
        //   NLA:                          completed | rejected | rejected_closed | invalid
        //                                 (NLA never writes "approved")
        // Non-terminal statuses (`pending` for AUTH pre-action,
        // `queued` for NLA escalated to P-Card) stay not_approved here.
        //
        // The authCode subgate ONLY applies to AUTH approved|completed —
        // a successful authorization without an authCode is a data-quality
        // hole (caller is expected to re-authorize). Rejected /
        // rejected_closed / invalid AUTH tickets never have an authCode
        // by design (no auth was issued), so the subgate is skipped for
        // those — without that carve-out, AUTH-rejected confirms would
        // fall through to no_auth_code and the agent would be stuck
        // exactly like sub 566 was on 2026-05-01 (see COMMITS.md entry).
        if (!isTerminalTicketStatusForIntake(sub.ticketStatus)) {
          return res.status(200).json({ required: false, recorded: false, reason: "not_approved" });
        }
        if (
          !isNla &&
          (sub.ticketStatus === "approved" || sub.ticketStatus === "completed") &&
          !sub.authCode
        ) {
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

        // Tyler 2026-04-30 / 2026-05-01: terminal-status predicate is
        // shared across AUTH and NLA via isTerminalTicketStatusForIntake.
        // See shared/intake-form-config.ts for the full rationale and
        // the AUTH/NLA terminal sets.
        //
        // Tyler's design intent (see processMutation.onSuccess comment +
        // shared/intake-form-config.ts) is "agent fills out intake form
        // for every terminal outcome". Pre-2026-05-01 the AUTH branch
        // was inadvertently narrower than the NLA branch — sub 566
        // (SO 8380-13677352) and 5 other AUTH-rejected tickets were
        // stuck behind this gate today even though the agents had
        // already submitted the Smartsheet form successfully (the
        // IntakeFormTab iframe loads for any ticket per the 2026-04-28
        // requirement change). `pending` (AUTH pre-action) and `queued`
        // (NLA escalated to P-Card — handed off to a different agent)
        // remain blocked.
        const status = owned.submission.ticketStatus;
        const isNla = owned.submission.requestType === "parts_nla";
        if (!isTerminalTicketStatusForIntake(status)) {
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

export function createExecSummaryGenerateHandler(
  services: Pick<ExecSummaryRouteServices, "generateAndSendExecSummary">,
) {
  return async (req: Request, res: Response) => {
    try {
      const parsed = z.object({
        send: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        skipIfGeneratedToday: z.boolean().optional(),
      }).safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid executive summary generation options" });
      }
      const result = await services.generateAndSendExecSummary({
        send: parsed.data.send !== false,
        dryRun: parsed.data.dryRun === true,
        skipIfGeneratedToday: parsed.data.skipIfGeneratedToday,
      });
      return res.json({
        report: result.report
          ? { id: result.report.id, generatedAt: result.report.generatedAt, summary: result.report.summary }
          : null,
        email: result.email,
        delivery: result.delivery ?? null,
        skipped: result.skipped ?? null,
      });
    } catch (error: unknown) {
      console.error("Exec summary run error:", error instanceof Error ? error.message : error);
      return res.status(500).json({ error: "Failed to generate executive summary" });
    }
  };
}

type ExecSummaryEmailServices = {
  getExecSummaryRecipients: () => Promise<string[]>;
  getEmailConfigurationStatus: () => {
    configured: boolean;
    apiKeyPresent: boolean;
    fromEmail: string;
    fromEmailValid: boolean;
    issues: string[];
  };
  isEmailConfigured: () => boolean;
  resolveFromAddress: () => { email: string; name: string };
};

/**
 * Recipient configuration is intentionally best-effort for this read-only
 * endpoint. A malformed setting must not hide the saved report/delivery audit.
 * The response exposes only stable issue identifiers; the thrown error is
 * never returned (or logged here).
 */
export function createExecSummaryHistoryHandler(
  services: Pick<ExecSummaryRouteServices, "getLatestExecSummaries"> & ExecSummaryEmailServices,
) {
  return async (_req: Request, res: Response) => {
    try {
      const reports = await services.getLatestExecSummaries();
      let recipients: string[] = [];
      let recipientIssues: string[] = [];
      try {
        recipients = await services.getExecSummaryRecipients();
        const { isPlausibleEmail } = await import("./services/email");
        if (!recipients.length || recipients.some((address) => !isPlausibleEmail(address))) {
          recipients = [];
          recipientIssues = ["invalid_recipient"];
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code || "").toLowerCase()
          : "";
        // The service intentionally normalizes malformed/blank settings to a
        // safe error. Keep both identifiers so operators can distinguish a
        // bad value from a storage outage without exposing either detail.
        const invalidRecipient = code.includes("invalid") ||
          code.includes("recipient") ||
          message.includes("invalid") ||
          message.includes("malformed") ||
          message.includes("empty") ||
          message.includes("recipient");
        recipientIssues = invalidRecipient
          ? ["invalid_recipient", "recipients_unavailable"]
          : ["recipients_unavailable"];
      }

      const baseEmailConfiguration = services.getEmailConfigurationStatus();
      const emailConfiguration = recipientIssues.length > 0
        ? {
            ...baseEmailConfiguration,
            configured: false,
            issues: Array.from(new Set([...baseEmailConfiguration.issues, ...recipientIssues])),
          }
        : baseEmailConfiguration;
      return res.json({
        reports,
        recipients,
        from: services.resolveFromAddress(),
        emailConfigured: emailConfiguration.configured && services.isEmailConfigured(),
        emailConfiguration,
      });
    } catch (error: unknown) {
      console.error("Exec summary list error:", error instanceof Error ? error.message : "unknown error");
      return res.status(500).json({ error: "Failed to list executive summaries" });
    }
  };
}

/**
 * The two mutating executive-summary handlers are kept as small dependency
 * injection seams. Besides making their validation explicit, this lets route
 * tests exercise generate-only -> send and concurrent request-key behavior
 * without importing the database-backed route registration.
 */
export function createExecSummarySendHandler(services: Pick<
  ExecSummaryRouteServices,
  "getLatestExecSummaries" | "retryExecSummaryDelivery"
>) {
  return async (req: Request, res: Response) => {
    try {
      const parsed = z.object({
        reportId: z.number().int().positive().optional(),
        resend: z.boolean().default(false),
        requestKey: z.string().trim().min(8).max(200),
      }).safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: "reportId, resend, and a valid requestKey are required" });
      }

      let reportId = parsed.data.reportId;
      if (reportId === undefined) {
        const latest = await services.getLatestExecSummaries(1);
        reportId = latest[0]?.id;
      }
      if (!reportId) {
        return res.status(404).json({ error: "No executive summary has been generated yet" });
      }

      const deliveryResult = await services.retryExecSummaryDelivery(reportId, {
        resend: parsed.data.resend,
        requestKey: parsed.data.requestKey,
      });
      return res.json({
        reportId,
        action: deliveryResult.action,
        delivery: deliveryResult.delivery ?? deliveryResult,
      });
    } catch (error: unknown) {
      console.error("Exec summary send error:", error instanceof Error ? error.message : error);
      return res.status(500).json({ error: "Failed to send executive summary" });
    }
  };
}
