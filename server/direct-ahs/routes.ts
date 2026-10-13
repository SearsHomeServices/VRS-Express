import type { Express, Request, Response, RequestHandler } from "express";
import { directAhsResultSchema, directAhsReviewSchema, type DirectAhsPayload } from "../../shared/direct-ahs";
import { DirectAhsError, directAhsConfig, sendDirectAhs, verifyDirectAhsSignature, type DirectAhsConfig } from "./contract";
import { DirectAhsStore, type DirectAhsActor, type DirectAhsRow } from "./store";

interface Dependencies {
  store: DirectAhsStore;
  authenticate: RequestHandler;
  config?: () => DirectAhsConfig | null;
  webhookSecret?: () => string | undefined;
  send?: typeof sendDirectAhs;
  media: (ticket: Record<string, any>) => Promise<Pick<DirectAhsPayload, "photoUrls" | "videoUrl" | "voiceNoteUrl">>;
}
export function registerDirectAhsRoutes(app: Express, deps: Dependencies) {
  const config = deps.config ?? (() => directAhsConfig(process.env));
  const secret = deps.webhookSecret ?? (() => process.env.DIRECT_AHS_AI_WEBHOOK_SECRET);
  const actor = (req: Request) => (req as Request & { user: DirectAhsActor }).user;
  const id = (req: Request) => {
    const value = Number(req.params.id);
    if (!Number.isSafeInteger(value) || value <= 0) throw new DirectAhsError(400, "Invalid ticket ID");
    return value;
  };
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      if (error instanceof DirectAhsError) res.status(error.status).json({ error: error.message });
      else {
        console.error("[direct-ahs] request failed:", error instanceof Error ? error.name : "unknown");
        res.status(503).json({ error: "Direct AHS service temporarily unavailable; no success is confirmed" });
      }
    }
  };
  const dispatch = async (row: DirectAhsRow, settings: DirectAhsConfig) => {
    try { await deps.store.acknowledged(row, await (deps.send ?? sendDirectAhs)(row.payload, settings)); }
    catch { await deps.store.ambiguous(row); }
  };
  app.get("/api/submissions/:id/direct-ahs", deps.authenticate, handle(async (req, res) => {
    res.json({ ...await deps.store.get(id(req), actor(req)), enabled: !!config() });
  }));
  app.post("/api/submissions/:id/direct-ahs", deps.authenticate, handle(async (req, res) => {
    const settings = config();
    if (!settings) throw new DirectAhsError(503, "Direct AHS AI is not enabled/configured. The AI service must implement the new contract first.");
    const parsed = directAhsReviewSchema.safeParse(req.body);
    if (!parsed.success) throw new DirectAhsError(400, "Review notes are required (1–4000 characters)");
    const row = await deps.store.enroll(id(req), actor(req), parsed.data.reviewNotes, settings.callbackUrl, deps.media);
    await dispatch(row, settings);
    res.status(202).json({ ...await deps.store.get(id(req), actor(req)), enabled: true });
  }));
  app.post("/api/submissions/:id/direct-ahs/retry", deps.authenticate, handle(async (req, res) => {
    const settings = config();
    if (!settings) throw new DirectAhsError(503, "Direct AHS AI is not enabled/configured");
    const row = await deps.store.claimRetry(id(req), actor(req));
    await dispatch(row, settings);
    res.status(202).json({ ...await deps.store.get(id(req), actor(req)), enabled: true });
  }));
  app.post("/api/integrations/direct-ahs/v1/result", handle(async (req, res) => {
    // Keep callbacks working if dispatch is disabled while requests are in flight.
    const key = secret();
    if (!key) throw new DirectAhsError(503, "Direct AHS callback is not configured");
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(raw) || raw.length > 128000 ||
        !verifyDirectAhsSignature(raw, req.header("x-direct-ahs-timestamp") ?? "", req.header("x-direct-ahs-signature") ?? "", key)) {
      throw new DirectAhsError(401, "Invalid or expired direct AHS signature");
    }
    const parsed = directAhsResultSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid direct AHS result", fields: parsed.error.issues.map(issue => issue.path.join(".")) });
    res.json(await deps.store.apply(parsed.data));
  }));
}

/** Sign existing uploads only; no arbitrary URL fetching or fabricated media. */
export async function directAhsMedia(ticket: Record<string, any>, sign: (path: string) => Promise<string>) {
  let parsed: unknown;
  try { parsed = ticket.photos ? JSON.parse(ticket.photos) : []; }
  catch { throw new DirectAhsError(422, "Ticket photos cannot be read; correct them before sending"); }
  const paths = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object"
    ? Object.values(parsed).flatMap(value => Array.isArray(value) ? value : []) : null;
  if (!paths || paths.some(path => typeof path !== "string" || !path.startsWith("/objects/"))) {
    throw new DirectAhsError(422, "Direct AHS requires uploaded object-storage photos");
  }
  if (paths.length > 40) throw new DirectAhsError(422, "Direct AHS supports up to 40 photos");
  const signOptional = (path: unknown): Promise<string | null> => {
    if (path == null || path === "") return Promise.resolve(null);
    if (typeof path !== "string" || !path.startsWith("/objects/")) throw new DirectAhsError(422, "Direct AHS requires uploaded object-storage video/audio");
    return sign(path);
  };
  return {
    photoUrls: await Promise.all([...new Set(paths as string[])].map(sign)),
    videoUrl: await signOptional(ticket.video_url),
    voiceNoteUrl: await signOptional(ticket.voice_note_url),
  };
}
