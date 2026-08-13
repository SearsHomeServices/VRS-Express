import { Storage, File } from "@google-cloud/storage";
import { Response } from "express";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  setObjectAclPolicy,
} from "./objectAcl";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

// The object storage client is used to interact with the object storage service.
export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

// Tyler 2026-05-09 — perf (final pass): in-process LRU cache for GCS
// object metadata. After the 3-RPC → 1-RPC collapse in the previous
// commit (711c4d9), each /objects/* request still pays one
// file.getMetadata() round-trip. Photos in this app are immutable
// (uploaded once via signed URL to /uploads/<uuid>, never overwritten),
// so the [size, contentType, etag] triple is safe to cache for minutes
// at a time. With a 12-photo dialog reopen during a busy review
// session, this turns 12 GCS RPCs into 0 and the dialog opens roughly
// instantly. Cache hits also free Node event-loop slots that were
// previously blocked on metadata RPCs — addresses Hamed's "lag during
// peak" report.
//
// Capacity 5000 entries × ~100 bytes = ~500KB upper bound, negligible.
// TTL 10min — long enough to absorb back-to-back ticket reopens, short
// enough that ACL changes (none today, but defensive) propagate.
const META_CACHE_MAX = 5000;
const META_CACHE_TTL_MS = 10 * 60 * 1000;
type CachedMeta = { size: number; contentType: string; etag: string | undefined; expiresAt: number };
const metadataCache = new Map<string, CachedMeta>();
function getCachedMetadata(key: string): CachedMeta | null {
  const hit = metadataCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    metadataCache.delete(key);
    return null;
  }
  // LRU touch: re-insert moves to end of Map iteration order.
  metadataCache.delete(key);
  metadataCache.set(key, hit);
  return hit;
}
function setCachedMetadata(key: string, meta: Omit<CachedMeta, "expiresAt">): void {
  if (metadataCache.size >= META_CACHE_MAX) {
    // Evict oldest (Map preserves insertion order).
    const firstKey = metadataCache.keys().next().value;
    if (firstKey !== undefined) metadataCache.delete(firstKey);
  }
  metadataCache.set(key, { ...meta, expiresAt: Date.now() + META_CACHE_TTL_MS });
}

// The object storage service is used to interact with the object storage service.
export class ObjectStorageService {
  constructor() {}

  // Gets the public object search paths.
  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  // Gets the private object directory.
  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  // Search for a public object from the search paths.
  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      // Full path format: /<bucket_name>/<object_name>
      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      // Check if file exists
      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  // Downloads an object to the response.
  //
  // 2026-05-06 (video playback fix): VRS agents reported videos would not
  // play. Root cause: <video controls> sends `Range: bytes=0-` on first load
  // and expects 206 Partial Content with Accept-Ranges/Content-Range
  // headers. Without that, many browsers (Safari especially, but also
  // recent Chrome under certain MIME types) refuse to start playback or
  // hang waiting for the full file. Audio scrub/seek requires the same.
  //
  // This implementation:
  //   - always advertises `Accept-Ranges: bytes`
  //   - on a Range request, returns 206 with a sliced stream and
  //     Content-Range / Content-Length set to the slice
  //   - on a non-range request, returns 200 with full Content-Length
  //     (unchanged behavior for images/PDFs)
  //   - returns 416 on an unsatisfiable range
  //   - bails out cleanly if the client disconnects mid-stream (video
  //     scrubbing aborts the previous request — without this, the GCS
  //     stream throws an unhandled "premature close" and spams logs)
  async downloadObject(
    file: File,
    res: Response,
    cacheTtlSec: number = 3600,
    rangeHeader?: string,
  ) {
    try {
      // Tyler 2026-05-09 — perf: previously this method made THREE separate
      // GCS round-trips per request: objectFile.exists() in
      // getObjectEntityFile + an explicit getMetadata() here + a
      // getObjectAclPolicy() (which internally also calls getMetadata).
      // With ~12 photos in a ticket detail dialog opening at once that
      // was ~36 round-trips — the cause of agents seeing grey placeholder
      // tiles (race) AND the general dashboard latency (event loop slots
      // blocked on metadata RPCs). The ACL lookup was useless for this
      // route: getObjectEntityFile only resolves paths under
      // PRIVATE_OBJECT_DIR so /objects/* is always effectively private —
      // the ACL was solely used to flip Cache-Control public/private. The
      // exists() preflight was also pointless because getMetadata() will
      // itself throw a 404 below. Now: one getMetadata() per request,
      // everything served via /objects/* is private, ETag emitted so the
      // browser can do conditional revalidation (304s).
      // Cache key includes bucket + object so two buckets with the same
      // object name don't collide.
      const cacheKey = `${file.bucket.name}/${file.name}`;
      let totalSize: number;
      let contentType: string;
      let etag: string | undefined;
      const cached = getCachedMetadata(cacheKey);
      if (cached) {
        totalSize = cached.size;
        contentType = cached.contentType;
        etag = cached.etag;
      } else {
        let metadata: any;
        try {
          [metadata] = await file.getMetadata();
        } catch (err: any) {
          // GCS surfaces "no such object" as a 404. Translate into our
          // domain error so the caller (serveObject in routes.ts) returns
          // a clean 404 instead of a 500.
          if (err && (err.code === 404 || err.status === 404)) {
            throw new ObjectNotFoundError();
          }
          throw err;
        }
        totalSize = Number(metadata.size) || 0;
        contentType = metadata.contentType || "application/octet-stream";
        etag = metadata.etag ? String(metadata.etag) : undefined;
        setCachedMetadata(cacheKey, { size: totalSize, contentType, etag });
      }
      const cacheControl = `private, max-age=${cacheTtlSec}`;

      // Conditional GET: if the browser already has the bytes, return 304
      // and skip the entire stream. Object store contents are immutable
      // (uploaded once via signed URL, never overwritten) so the etag is
      // a strong validator. Parse the standard If-None-Match grammar
      // (RFC 9110 §13.1.2): "*", or comma-separated entity-tags, each
      // optionally weak-prefixed with W/. Match if our strong etag equals
      // any provided tag (with optional W/ stripped) or if "*" is present.
      if (etag && !rangeHeader) {
        const ifNoneMatch = (res.req.headers["if-none-match"] as string | undefined)?.trim();
        if (ifNoneMatch) {
          const matched = ifNoneMatch === "*" || ifNoneMatch
            .split(",")
            .map(t => t.trim().replace(/^W\//, ""))
            .some(t => t === etag);
          if (matched) {
            res.status(304).set({
              "ETag": etag,
              "Cache-Control": cacheControl,
            });
            return res.end();
          }
        }
      }

      // Parse Range header if present. Only single-range `bytes=start-end`
      // is supported (which is what every browser <video>/<audio> sends).
      let start = 0;
      let end = totalSize > 0 ? totalSize - 1 : 0;
      let isRange = false;
      if (rangeHeader && totalSize > 0) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        if (m) {
          const sStr = m[1];
          const eStr = m[2];
          if (sStr === "" && eStr !== "") {
            // suffix range: last N bytes
            const suffix = parseInt(eStr, 10);
            if (!Number.isNaN(suffix) && suffix > 0) {
              start = Math.max(0, totalSize - suffix);
              end = totalSize - 1;
              isRange = true;
            }
          } else if (sStr !== "") {
            const sNum = parseInt(sStr, 10);
            const eNum = eStr === "" ? totalSize - 1 : parseInt(eStr, 10);
            if (!Number.isNaN(sNum) && !Number.isNaN(eNum) && sNum <= eNum && sNum < totalSize) {
              start = sNum;
              end = Math.min(eNum, totalSize - 1);
              isRange = true;
            } else {
              // Unsatisfiable range → 416
              res.status(416).set({
                "Content-Range": `bytes */${totalSize}`,
                "Accept-Ranges": "bytes",
              });
              return res.end();
            }
          }
        }
      }

      const chunkSize = end - start + 1;

      const baseHeaders: Record<string, string> = {
        "Cache-Control": cacheControl,
      };
      if (etag) baseHeaders["ETag"] = etag;

      if (isRange) {
        res.status(206).set({
          ...baseHeaders,
          "Content-Type": contentType,
          "Content-Length": String(chunkSize),
          "Content-Range": `bytes ${start}-${end}/${totalSize}`,
          "Accept-Ranges": "bytes",
        });
      } else {
        res.status(200).set({
          ...baseHeaders,
          "Content-Type": contentType,
          "Content-Length": String(totalSize),
          "Accept-Ranges": "bytes",
        });
      }

      // HEAD requests get headers only (browsers occasionally probe).
      if (res.req.method === "HEAD") {
        return res.end();
      }

      const stream = isRange
        ? file.createReadStream({ start, end })
        : file.createReadStream();

      // Client-disconnect cleanup: if the agent scrubs the video, the
      // browser cancels the in-flight request. Destroy the GCS stream so
      // we don't keep pulling bytes from object storage and so the
      // "premature close" error doesn't spam the server logs.
      const onClose = () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      };
      res.once("close", onClose);

      stream.on("error", (err: any) => {
        // ECONNRESET / premature close after client abort is normal —
        // don't log as an error.
        const code = err && (err.code || err.name);
        if (code !== "ECONNRESET" && code !== "ERR_STREAM_PREMATURE_CLOSE") {
          console.error("Stream error:", err);
        }
        if (!res.headersSent) {
          res.status(500).json({ error: "Error streaming file" });
        } else {
          res.end();
        }
      });

      stream.pipe(res);
    } catch (error) {
      // Tyler 2026-05-09 (architect 2026-05-09 follow-up #2): rethrow
      // ObjectNotFoundError so serveObject in routes.ts can map it to a
      // clean 404. Without this rethrow the inner getMetadata-404 path
      // (introduced when we removed the exists() preflight) would be
      // swallowed here and surface as 500 to the browser.
      if (error instanceof ObjectNotFoundError) {
        throw error;
      }
      console.error("Error downloading file:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error downloading file" });
      }
    }
  }

  // Gets the upload URL for an object entity.
  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    // Sign URL for PUT method with TTL
    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  // Gets the object entity file from the object path.
  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    // Tyler 2026-05-09 — perf (architect 2026-05-09 follow-up): the prior
    // objectFile.exists() preflight added a third GCS RPC to every
    // /objects/* request. The downstream consumers — downloadObject() and
    // the conversion routes in server/routes.ts:3937,3988 — all immediately
    // call getMetadata() / createReadStream() / setMetadata() which will
    // themselves throw a GCS 404 if the object does not exist. Callers
    // already translate that into an ObjectNotFoundError (see the catch in
    // downloadObject below and serveObject in routes.ts). Removing the
    // preflight collapses /objects/* to a single GCS RPC per request and
    // is the difference between 36 RPCs and 12 RPCs for a 12-photo dialog.
    return objectFile;
  }

  // Creates a temporary, direct-download URL for a private object entity.
  // This is used when VRS Express sends its stored photos to VRS AI, which
  // cannot use the session-protected /objects/* application route.
  async getObjectEntityReadURL(
    objectPath: string,
    ttlSec: number = 24 * 60 * 60,
  ): Promise<string> {
    if (!Number.isInteger(ttlSec) || ttlSec <= 0) {
      throw new Error("Object read URL TTL must be a positive integer");
    }

    const objectFile = await this.getObjectEntityFile(objectPath);
    return signObjectURL({
      bucketName: objectFile.bucket.name,
      objectName: objectFile.name,
      method: "GET",
      ttlSec,
    });
  }

  normalizeObjectEntityPath(
    rawPath: string,
  ): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }
  
    // Extract the path from the URL by removing query parameters and domain
    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;
  
    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }
  
    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }
  
    // Extract the entity ID from the path
    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  // Tries to set the ACL policy for the object entity and return the normalized path.
  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  // Checks if the user can access the object entity.
  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`
    );
  }

  const { signed_url: signedURL } = await response.json();
  return signedURL;
}

