import type { Express } from "express";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { authenticateToken, authenticateTokenForMedia, requireRole } from "../../middleware/auth";
import { issueUploadToken } from "../../lib/uploadTokens";

// Maximum declared file size accepted at request-url time.
// The actual bytes go straight to GCS; we cannot intercept the upload,
// but rejecting an obviously-oversized declared size blocks
// unsophisticated DoS attempts and forces the client to lie about size
// (which is then caught at conversion time — see convert-audio/video).
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB

// Allowed MIME-type prefixes for uploaded media.
const ALLOWED_CONTENT_TYPE_PREFIXES = ["image/", "video/", "audio/", "application/octet-stream"];

export function registerObjectStorageRoutes(app: Express): void {
  const objectStorageService = new ObjectStorageService();

  app.post("/api/uploads/request-url", authenticateToken, requireRole("technician", "provider_1099"), async (req, res) => {
    try {
      const { name, size, contentType } = req.body;

      if (!name) {
        return res.status(400).json({
          error: "Missing required field: name",
        });
      }

      // size is required and must be a positive finite number.
      // Accepting stringified or missing size would let a raw API caller
      // bypass the ceiling entirely.
      if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
        return res.status(400).json({ error: "Invalid file size" });
      }
      if (size > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ error: "File too large" });
      }

      // contentType is required and must be a supported media prefix.
      if (typeof contentType !== "string" || !contentType) {
        return res.status(400).json({ error: "Missing required field: contentType" });
      }
      const allowed = ALLOWED_CONTENT_TYPE_PREFIXES.some((p) => contentType.startsWith(p));
      if (!allowed) {
        return res.status(400).json({ error: "Unsupported content type" });
      }

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      // Record which user was issued this objectPath so the convert
      // endpoints can verify ownership before spending ffmpeg resources.
      const authReq = req as any;
      if (authReq.user?.id) {
        issueUploadToken(objectPath, authReq.user.id);
      }

      res.json({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      });
    } catch (error) {
      console.error("Error generating upload URL:", error);
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  });

  app.post("/api/uploads/report-error", authenticateToken, async (req, res) => {
    try {
      console.error("[UPLOAD-DIAGNOSTIC]", JSON.stringify(req.body));
    } catch {}
    res.json({ ok: true });
  });

  // 2026-05-06: pass the Range header through so videos and audio play
  // correctly. <video controls> requires HTTP 206 Partial Content
  // responses on the first load — without it the browser refuses to
  // start playback (this is the "agents can't view video" bug).
  // Also handle HEAD so browsers/probes don't crash the stream.
  //
  // 2026-06-17: authenticateTokenForMedia added.  Browser-native media
  // elements (<img>, <video>, <audio>) cannot attach an Authorization
  // header, so the frontend appends ?token=<jwt> to every /objects/ URL
  // and this middleware accepts that query-parameter token in addition
  // to the standard Authorization header.
  const serveObject = async (req: any, res: any) => {
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(req.path);
      const rangeHeader = req.headers["range"] as string | undefined;
      await objectStorageService.downloadObject(objectFile, res, 3600, rangeHeader);
    } catch (error) {
      console.error("Error serving object:", error);
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Object not found" });
      }
      return res.status(500).json({ error: "Failed to serve object" });
    }
  };
  app.get("/objects/{*objectPath}", authenticateTokenForMedia, serveObject);
  app.head("/objects/{*objectPath}", authenticateTokenForMedia, serveObject);
}
