import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  registerVrsBridgePhotoProxy,
  SHSAI_DEV_PHOTO_HOST,
} from "../server/vrs-bridge-photo-proxy";
import {
  VrsBridgePhotoStorage,
  VRS_BRIDGE_PHOTO_RETENTION_MS,
} from "../server/vrs-bridge-photo-storage";

// A real 1x1 PNG, rather than arbitrary bytes, keeps this test representative
// of the MIME-validated upstream response.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterEach(() => vi.useRealTimers());

type FakeEntry = {
  body: Buffer;
  contentType: string;
  metadata: Record<string, string>;
};

class FakeObjectStorage {
  entries = new Map<string, FakeEntry>();

  async getObjectEntityFile(path: string): Promise<any> {
    const entry = this.entries.get(path);
    const file = {
      name: path.slice(1),
      getMetadata: async () => {
        if (!entry) {
          const error: any = new Error("missing");
          error.code = 404;
          throw error;
        }
        return [{
          contentType: entry.contentType,
          metadata: entry.metadata,
          size: entry.body.length,
        }];
      },
      body: entry?.body,
      download: async () => {
        if (!entry) throw Object.assign(new Error("missing"), { code: 404 });
        return [entry.body];
      },
    };
    return file;
  }

  async getServerOwnedObjectEntityFile(path: string): Promise<any> {
    return this.getObjectEntityFile(path);
  }

  async saveObjectEntity(
    path: string,
    body: Buffer,
    contentType: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    this.entries.set(path, { body, contentType, metadata });
  }

  async deleteObjectEntity(path: string): Promise<void> {
    this.entries.delete(path);
  }

  async listObjectEntityFiles(prefix: string): Promise<any[]> {
    return [...this.entries.keys()]
      .filter((path) => path.includes(`/${prefix}`))
      .map((path) => ({
        name: path.slice(1),
        getMetadata: async () => {
          const entry = this.entries.get(path)!;
          return [{ metadata: entry.metadata }];
        },
        delete: async () => this.entries.delete(path),
      }));
  }

  async listObjectEntityFilesPage(prefix: string): Promise<{ files: any[]; nextPageToken?: string }> {
    return { files: await this.listObjectEntityFiles(prefix) };
  }
}

function makeProxyApp(
  storage: VrsBridgePhotoStorage,
  fetchImpl: typeof fetch,
  sourceUrl = `https://${SHSAI_DEV_PHOTO_HOST}/expired.png`,
  user: { id: number; role: string } = { id: 17, role: "vrs_agent" },
) {
  const app = express();
  registerVrsBridgePhotoProxy(app, {
    authenticate: (_req, _res, next) => {
      (_req as any).user = user;
      next();
    },
    getSubmission: async () => ({
      id: 44,
      technicianId: 17,
      assignedTo: 17,
      ticketStatus: "pending",
      reviewedBy: null,
      requestType: "authorization",
      applianceType: "laundry",
    }),
    getBridge: async () => ({
      requestPayload: { appliance_photos: [sourceUrl] },
    }) as any,
    getSpecializations: async () => [{ division: "laundry" }],
    allDivisionCount: 8,
    isEnabled: () => true,
    fetchImpl,
    getStoredPhoto: (submissionId, photoIndex, originalUrl) =>
      storage.get(submissionId, photoIndex, Date.now(), originalUrl),
    downloadStoredPhoto: async (photo: any, _req, res) => {
      res.setHeader("Content-Type", photo.contentType);
      res.send(photo.file.body);
    },
    savePhoto: (submissionId, photoIndex, image) =>
      storage.save(submissionId, photoIndex, image),
  });
  return app;
}

describe("DEV Sasha bridge private photo copies", () => {
  it("captures valid image bytes and serves them after upstream expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const objectStorage = new FakeObjectStorage();
    const storage = new VrsBridgePhotoStorage(objectStorage as any);
    let upstreamCalls = 0;
    const sourceUrl = `https://${SHSAI_DEV_PHOTO_HOST}/fresh.png`;
    const capture = await storage.capture(
      44,
      [sourceUrl],
      async () => {
        upstreamCalls++;
        return { body: ONE_PIXEL_PNG, contentType: "image/png" };
      },
      () => true,
    );
    expect(capture).toEqual({ captured: 1, failures: 0 });
    expect(upstreamCalls).toBe(1);

    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000 + 1);
    const restartedStorage = new VrsBridgePhotoStorage(objectStorage as any);
    const response = await request(
      makeProxyApp(
        restartedStorage,
        (async () => {
          upstreamCalls++;
          return new Response("expired", { status: 410 });
        }) as typeof fetch,
        sourceUrl,
      ),
    ).get("/api/submissions/44/vrs-ai-photos/0");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^image\/png/);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(response.body)).toEqual(ONE_PIXEL_PNG);
    expect(upstreamCalls).toBe(1);
  });

  it("survives a restart and a source-link age beyond two hours", async () => {
    const objectStorage = new FakeObjectStorage();
    const captureStorage = new VrsBridgePhotoStorage(objectStorage as any);
    const capturedAt = Date.now();
    const sourceUrl = `https://${SHSAI_DEV_PHOTO_HOST}/captured.png`;
    await captureStorage.save(
      77,
      0,
      { body: ONE_PIXEL_PNG, contentType: "image/png" },
      capturedAt,
      capturedAt + VRS_BRIDGE_PHOTO_RETENTION_MS,
      sourceUrl,
    );
    const restartedStorage = new VrsBridgePhotoStorage(objectStorage as any);
    const saved = await restartedStorage.get(
      77,
      0,
      capturedAt + 2 * 60 * 60 * 1000 + 1,
      sourceUrl,
    );
    expect(saved).not.toBeNull();
    expect(saved?.expiresAt.getTime()).toBe(
      capturedAt + VRS_BRIDGE_PHOTO_RETENTION_MS,
    );
  });

  it("does not renew an existing copy when a retry sees the same source", async () => {
    const objectStorage = new FakeObjectStorage();
    const storage = new VrsBridgePhotoStorage(objectStorage as any);
    const capturedAt = Date.now();
    const sourceUrl = `https://${SHSAI_DEV_PHOTO_HOST}/stable.png`;
    const expiresAt = capturedAt + VRS_BRIDGE_PHOTO_RETENTION_MS;
    await storage.save(
      78,
      0,
      { body: ONE_PIXEL_PNG, contentType: "image/png" },
      capturedAt,
      expiresAt,
      sourceUrl,
    );
    await storage.save(
      78,
      0,
      { body: ONE_PIXEL_PNG, contentType: "image/png" },
      capturedAt + 24 * 60 * 60 * 1000,
      capturedAt + 31 * 24 * 60 * 60 * 1000,
      sourceUrl,
    );
    expect((await storage.get(78, 0, capturedAt + 24 * 60 * 60 * 1000, sourceUrl))
      ?.expiresAt.getTime()).toBe(expiresAt);
  });

  it("expires and deletes bytes after the 30-day retention window", async () => {
    const objectStorage = new FakeObjectStorage();
    const storage = new VrsBridgePhotoStorage(objectStorage as any);
    const now = Date.now();
    await storage.save(44, 0, {
      body: ONE_PIXEL_PNG,
      contentType: "image/png",
    }, now - VRS_BRIDGE_PHOTO_RETENTION_MS - 1);
    expect(await storage.get(44, 0, now)).toBeNull();
    expect(await storage.cleanupExpired(now)).toBe(1);
    expect(objectStorage.entries.size).toBe(0);
  });

  it("checks ticket access before storage or upstream IO", async () => {
    const objectStorage = new FakeObjectStorage();
    const storage = new VrsBridgePhotoStorage(objectStorage as any);
    let upstreamCalls = 0;
    let storageCalls = 0;
    const originalGet = storage.get.bind(storage);
    storage.get = (async (...args: Parameters<typeof storage.get>) => {
      storageCalls++;
      return originalGet(...args);
    }) as typeof storage.get;
    const response = await request(
      makeProxyApp(
        storage,
        (async () => {
          upstreamCalls++;
          return new Response(ONE_PIXEL_PNG, {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }) as typeof fetch,
        `https://${SHSAI_DEV_PHOTO_HOST}/expired.png`,
        { id: 99, role: "technician" },
      ),
    ).get("/api/submissions/44/vrs-ai-photos/0");
    expect(response.status).toBe(403);
    expect(storageCalls).toBe(0);
    expect(upstreamCalls).toBe(0);
  });

  it("rejects unsupported and oversized captures without retaining bytes", async () => {
    const objectStorage = new FakeObjectStorage();
    const storage = new VrsBridgePhotoStorage(objectStorage as any);
    const result = await storage.capture(
      44,
      [
        `https://${SHSAI_DEV_PHOTO_HOST}/bad`,
        `https://${SHSAI_DEV_PHOTO_HOST}/large`,
      ],
      async (url) => {
        if (url.endsWith("large")) {
          return { body: Buffer.alloc(10 * 1024 * 1024 + 1), contentType: "image/png" };
        }
        return { body: ONE_PIXEL_PNG, contentType: "text/html" };
      },
      () => true,
    );
    expect(result).toEqual({ captured: 0, failures: 2 });
    expect(objectStorage.entries.size).toBe(0);
  });

  it("removes orphaned submission copies during the bounded sweep", async () => {
    const objectStorage = new FakeObjectStorage();
    const storage = new VrsBridgePhotoStorage(objectStorage as any);
    await storage.save(404, 0, {
      body: ONE_PIXEL_PNG,
      contentType: "image/png",
    });
    expect(await storage.sweep(Date.now(), async () => false)).toBe(1);
    expect(objectStorage.entries.size).toBe(0);
  });

  it("requires matching payload provenance for guarded ticket deletion across environments", async () => {
    const objects = new FakeObjectStorage();
    const storage = new VrsBridgePhotoStorage(objects as any);
    const deadline = Date.now() + VRS_BRIDGE_PHOTO_RETENTION_MS;
    await storage.save(44, 0, { body: ONE_PIXEL_PNG, contentType: "image/png" },
      Date.now(), deadline, "dev-source");
    await storage.deleteSubmission(44, ["prod-source"]);
    expect(await storage.get(44, 0)).not.toBeNull();
    // A ticket with no Bridge record may reuse the same numeric identifier.
    await storage.deleteSubmission(44, []);
    expect(await storage.get(44, 0)).not.toBeNull();
    await storage.deleteSubmission(44, ["dev-source"]);
    expect(await storage.get(44, 0)).toBeNull();
  });

  it("preserves provenance-free copies until TTL rather than inferring a DB orphan", async () => {
    const objects = new FakeObjectStorage();
    const storage = new VrsBridgePhotoStorage(objects as any);
    await storage.save(44, 0, { body: ONE_PIXEL_PNG, contentType: "image/png" });
    await storage.deleteSubmission(44, ["source"]);
    expect(await storage.sweep()).toBe(0);
    expect(await storage.get(44, 0)).not.toBeNull();
    expect(await storage.sweep(Date.now() + VRS_BRIDGE_PHOTO_RETENTION_MS + 1)).toBe(1);
  });

  it("keeps scheduled cleanup TTL-only and snapshots deletion provenance before DB deletion", () => {
    const routes = readFileSync("server/routes.ts", "utf8");
    const scheduler = routes.slice(routes.indexOf("const cleanupExpiredBridgePhotos = async"));
    const cleanup = scheduler.slice(0, scheduler.indexOf("void recoverBridgePhotos()"));
    expect(cleanup).toMatch(/vrsBridgePhotoStorage\.sweep\(\s*Date\.now\(\),?\s*\)/);
    expect(cleanup).not.toContain("storage.getSubmission");
    const deletion = routes.slice(routes.indexOf('app.delete("/api/submissions/:id"'));
    expect(deletion.indexOf("vrsBridgeStore.getBySubmissionId(id)"))
      .toBeLessThan(deletion.indexOf("storage.deleteSubmission(id)"));
    expect(deletion).toContain("vrsBridgePhotoStorage.deleteSubmission(id, bridgePhotoSources)");
  });

  it("reports unreadable saved bytes as failure and recovers on a later attempt", async () => {
    const objects = new FakeObjectStorage();
    const storage = new VrsBridgePhotoStorage(objects as any);
    const original = objects.getServerOwnedObjectEntityFile.bind(objects);
    const read = vi.spyOn(objects, "getServerOwnedObjectEntityFile").mockImplementation(async (path) => {
      const file = await original(path);
      file.download = async () => { throw new Error("read unavailable"); };
      return file;
    });
    const upstream = vi.fn(async () => ({ body: ONE_PIXEL_PNG, contentType: "image/png" }));
    expect(await storage.capture(44, ["source"], upstream, () => true))
      .toEqual({ captured: 0, failures: 1 });
    // Metadata now exists, but unreadable bytes still cannot count as captured.
    expect(await storage.capture(44, ["source"], upstream, () => true))
      .toEqual({ captured: 0, failures: 1 });
    read.mockRestore();
    expect(await storage.capture(44, ["source"], upstream, () => true))
      .toEqual({ captured: 1, failures: 0 });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("cleans expired and deleted-ticket photos with flags off without touching unrelated media", async () => {
    vi.stubEnv("VRS_AI_BRIDGE_ENABLED", "false");
    vi.stubEnv("VRS_BRIDGE_PHOTO_PROXY_ENABLED", "false");
    try {
      const objects = new FakeObjectStorage();
      const storage = new VrsBridgePhotoStorage(objects as any);
      await storage.save(44, 0, { body: ONE_PIXEL_PNG, contentType: "image/png" });
      await storage.save(45, 0, { body: ONE_PIXEL_PNG, contentType: "image/png" });
      objects.entries.set("/objects/unrelated/keep", {
        body: ONE_PIXEL_PNG, contentType: "image/png", metadata: { expiresAt: "1" },
      });
      await storage.deleteSubmission(44);
      expect(await storage.get(44, 0)).toBeNull();
      expect(await storage.sweep(Date.now() + VRS_BRIDGE_PHOTO_RETENTION_MS + 1)).toBe(1);
      expect([...objects.entries.keys()]).toEqual(["/objects/unrelated/keep"]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("continues a bounded sweep from its next page instead of starving later objects", async () => {
    const requestedPages: Array<string | undefined> = [];
    const fake = {
      listObjectEntityFilesPage: async (_prefix: string, pageToken?: string) => {
        requestedPages.push(pageToken);
        const page = Number(pageToken ?? 0);
        return { files: [], nextPageToken: page < 11 ? String(page + 1) : undefined };
      },
    };
    const storage = new VrsBridgePhotoStorage(fake as any);
    await storage.sweep();
    expect(requestedPages).toHaveLength(10);
    await storage.sweep();
    expect(requestedPages.slice(10)).toEqual(["10", "11"]);
    await storage.sweep();
    expect(requestedPages[12]).toBeUndefined();
  });

  it("does not re-fetch or claim capture after the retention deadline", async () => {
    const upstream = vi.fn();
    const storage = new VrsBridgePhotoStorage(new FakeObjectStorage() as any);
    expect(await storage.capture(
      44, [`https://${SHSAI_DEV_PHOTO_HOST}/fresh.png`],
      upstream, () => true, Date.now() - 1,
    )).toEqual({ captured: 0, failures: 1 });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.skipIf(
    process.env.VRS_BRIDGE_PHOTO_GCS_INTEGRATION !== "true" ||
      !process.env.PRIVATE_OBJECT_DIR,
  )("round-trips a private object and cleans it up (opt-in)", async () => {
    const storage = new VrsBridgePhotoStorage();
    const submissionId = Number.parseInt(
      randomUUID().replaceAll("-", "").slice(0, 12),
      16,
    );
    try {
      await storage.save(submissionId, 0, {
        body: ONE_PIXEL_PNG,
        contentType: "image/png",
      });
      const saved = await storage.get(submissionId, 0);
      expect(saved).not.toBeNull();
      const [body] = await saved!.file.download();
      expect(body).toEqual(ONE_PIXEL_PNG);
    } finally {
      await storage.deleteSubmission(submissionId);
    }
    expect(await storage.get(submissionId, 0)).toBeNull();
  });
});