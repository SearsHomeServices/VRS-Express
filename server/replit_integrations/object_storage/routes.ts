import type { Express } from "express";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { authenticateToken, requireRole } from "../../middleware/auth";

export function registerObjectStorageRoutes(app: Express): void {
  const objectStorageService = new ObjectStorageService();

  app.post("/api/uploads/request-url", authenticateToken, requireRole("technician"), async (req, res) => {
    try {
      const { name, size, contentType } = req.body;

      if (!name) {
        return res.status(400).json({
          error: "Missing required field: name",
        });
      }

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

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
  app.get("/objects/{*objectPath}", serveObject);
  app.head("/objects/{*objectPath}", serveObject);
}

