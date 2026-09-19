import type { File } from "@google-cloud/storage";
import { createHash } from "crypto";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "./replit_integrations/object_storage/objectStorage";

export const VRS_BRIDGE_PHOTO_PREFIX = "vrs-bridge-photos";
export const VRS_BRIDGE_PHOTO_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type StoredBridgePhoto = {
  file: File;
  contentType: string;
  expiresAt: Date;
};

export type BridgePhotoImage = {
  body: Buffer;
  contentType: string;
};

export type BridgePhotoCaptureResult = {
  captured: number;
  failures: number;
};

const MAX_SWEEP_PAGES = 10;
const PAGE_SIZE = 100;
const activeCaptures = new Set<string>();

function photoPath(submissionId: number, photoIndex: number): string {
  return `/objects/${VRS_BRIDGE_PHOTO_PREFIX}/${submissionId}/${photoIndex}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ObjectNotFoundError ||
    (typeof error === "object" && error !== null &&
      ((error as any).code === 404 || (error as any).status === 404));
}

function sourceHash(sourceUrl: string): string {
  return createHash("sha256").update(sourceUrl).digest("hex");
}

/**
 * Private, server-owned copies of Sasha media. This deliberately has no
 * public URL or signed URL API: the bridge proxy must perform ticket auth.
 */
export class VrsBridgePhotoStorage {
  private sweepPageToken: string | undefined;
  private sweepRunning = false;

  constructor(
    private readonly objectStorage: ObjectStorageService = new ObjectStorageService(),
  ) {}

  pathFor(submissionId: number, photoIndex: number): string {
    return photoPath(submissionId, photoIndex);
  }

  async get(
    submissionId: number,
    photoIndex: number,
    now = Date.now(),
    sourceUrl?: string,
  ): Promise<StoredBridgePhoto | null> {
    try {
      const file = await this.objectStorage.getServerOwnedObjectEntityFile(
        photoPath(submissionId, photoIndex),
      );
      const [metadata] = await file.getMetadata();
      const custom = (metadata.metadata ?? {}) as Record<string, string>;
      const expiresAtMs = Number(custom.expiresAt);
      if (sourceUrl && custom.sourceHash !== sourceHash(sourceUrl)) return null;
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
        return null;
      }
      const contentType = String(metadata.contentType || "").toLowerCase();
      const size = Number(metadata.size);
      if (!IMAGE_CONTENT_TYPES.has(contentType) || !Number.isSafeInteger(size) ||
          size < 1 || size > MAX_PHOTO_BYTES) return null;
      return {
        file,
        contentType,
        expiresAt: new Date(expiresAtMs),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async save(
    submissionId: number,
    photoIndex: number,
    image: BridgePhotoImage,
    now = Date.now(),
    retentionExpiresAt = now + VRS_BRIDGE_PHOTO_RETENTION_MS,
    sourceUrl?: string,
  ): Promise<void> {
    const path = photoPath(submissionId, photoIndex);
    try {
      const existing = await this.objectStorage.getServerOwnedObjectEntityFile(path);
      const [metadata] = await existing.getMetadata();
      const custom = (metadata.metadata ?? {}) as Record<string, string>;
      const existingExpiry = Number(custom.expiresAt);
      if (Number.isFinite(existingExpiry) && existingExpiry > now) {
        if (!sourceUrl || custom.sourceHash === sourceHash(sourceUrl)) {
          await this.verify(submissionId, photoIndex, sourceUrl, undefined, now);
          return;
        }
      } else if (Number.isFinite(existingExpiry)) {
        // Expired objects are tombstones until the sweep removes them. This
        // prevents a stale proxy fallback from renewing the 30-day window.
        return;
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (retentionExpiresAt <= now) return;
    await this.objectStorage.saveObjectEntity(
      path,
      image.body,
      image.contentType,
      {
        expiresAt: String(retentionExpiresAt),
        submissionId: String(submissionId),
        photoIndex: String(photoIndex),
        ...(sourceUrl ? { sourceHash: sourceHash(sourceUrl) } : {}),
      },
    );
    await this.verify(submissionId, photoIndex, sourceUrl, image.body, now);
  }

  private async verify(
    submissionId: number, photoIndex: number, sourceUrl?: string, expected?: Buffer, now = Date.now(),
  ): Promise<void> {
    const stored = await this.get(submissionId, photoIndex, now, sourceUrl);
    if (!stored) throw new Error("BRIDGE_PHOTO_VERIFY_FAILED");
    const [bytes] = await stored.file.download();
    if (!bytes.length || (expected && !bytes.equals(expected))) {
      throw new Error("BRIDGE_PHOTO_VERIFY_FAILED");
    }
  }

  async deleteSubmission(submissionId: number, sourceUrls?: readonly string[]): Promise<void> {
    // Keys are not environment-namespaced. Route-driven deletion must prove
    // provenance from the pre-deletion Bridge payload, not just a numeric ID.
    if (sourceUrls && sourceUrls.length === 0) return;
    let pageToken: string | undefined;
    do {
      const result = await this.objectStorage.listObjectEntityFilesPage(
        `${VRS_BRIDGE_PHOTO_PREFIX}/${submissionId}/`,
        pageToken,
        PAGE_SIZE,
      );
      await Promise.all(result.files.map(async (file) => {
        if (sourceUrls !== undefined) {
          try {
            const [metadata] = await file.getMetadata();
            const custom = (metadata.metadata ?? {}) as Record<string, string>;
            const index = Number(custom.photoIndex);
            const sourceUrl = sourceUrls[index];
            if (custom.submissionId !== String(submissionId) ||
                !Number.isSafeInteger(index) || index < 0 ||
                !file.name.endsWith(`/${submissionId}/${index}`) ||
                typeof sourceUrl !== "string" ||
                custom.sourceHash !== sourceHash(sourceUrl)) return;
            // Do not remove a different generation replaced after this check.
            const matchedFile = metadata.generation
              ? file.bucket.file(file.name, { generation: metadata.generation })
              : file;
            await matchedFile.delete({ ignoreNotFound: true });
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
          return;
        }
        await file.delete({ ignoreNotFound: true });
      }));
      pageToken = result.nextPageToken;
    } while (pageToken);
  }

  async cleanupExpired(now = Date.now()): Promise<number> {
    return this.sweep(now);
  }

  async sweep(
    now = Date.now(),
    isSubmissionLive?: (submissionId: number) => Promise<boolean>,
  ): Promise<number> {
    if (this.sweepRunning) return 0;
    this.sweepRunning = true;
    let deleted = 0;
    let pageToken = this.sweepPageToken;
    try {
    for (let page = 0; page < MAX_SWEEP_PAGES; page++) {
      const result = await this.objectStorage.listObjectEntityFilesPage(
        `${VRS_BRIDGE_PHOTO_PREFIX}/`,
        pageToken,
        PAGE_SIZE,
      );
      for (const file of result.files) {
        try {
          const [metadata] = await file.getMetadata();
          const custom = (metadata.metadata ?? {}) as Record<string, string>;
          const expiresAt = Number(custom.expiresAt);
          const submissionId = Number(custom.submissionId);
          const orphan = isSubmissionLive && Number.isSafeInteger(submissionId)
            ? !(await isSubmissionLive(submissionId))
            : false;
          if (orphan || !Number.isFinite(expiresAt) || expiresAt <= now) {
            await file.delete({ ignoreNotFound: true });
            deleted++;
          }
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      pageToken = result.nextPageToken;
      // Resume on the next pass rather than repeatedly scanning only the
      // first 1,000 live objects and starving later expired/orphaned copies.
      this.sweepPageToken = pageToken;
      if (!pageToken) break;
    }
    return deleted;
    } finally {
      this.sweepRunning = false;
    }
  }

  async capture(
    submissionId: number,
    sourceUrls: readonly string[],
    fetchImage: (url: string) => Promise<BridgePhotoImage>,
    isAllowedSource: (url: string) => boolean,
    retentionExpiresAt?: number,
  ): Promise<BridgePhotoCaptureResult> {
    if (retentionExpiresAt !== undefined && retentionExpiresAt <= Date.now()) {
      return { captured: 0, failures: sourceUrls.length };
    }
    let captured = 0;
    let failures = 0;
    for (let photoIndex = 0; photoIndex < sourceUrls.length; photoIndex++) {
      const sourceUrl = sourceUrls[photoIndex];
      const lockKey = `${submissionId}/${photoIndex}`;
      if (activeCaptures.has(lockKey)) continue;
      activeCaptures.add(lockKey);
      try {
        if (!isAllowedSource(sourceUrl)) {
          failures++;
          continue;
        }
        const existing = await this.get(submissionId, photoIndex, Date.now(), sourceUrl);
        if (existing) {
          await this.verify(submissionId, photoIndex, sourceUrl);
          captured++;
          continue;
        }
        const image = await fetchImage(sourceUrl);
        if (
          image.body.byteLength === 0 ||
          image.body.byteLength > MAX_PHOTO_BYTES ||
          !IMAGE_CONTENT_TYPES.has(image.contentType)
        ) {
          failures++;
          continue;
        }
        await this.save(
          submissionId,
          photoIndex,
          image,
          Date.now(),
          retentionExpiresAt ?? Date.now() + VRS_BRIDGE_PHOTO_RETENTION_MS,
          sourceUrl,
        );
        captured++;
      } catch {
        // The intake response must not include upstream URLs or fetch errors.
        // The caller reports only the aggregate count and can retry on boot.
        failures++;
      } finally {
        activeCaptures.delete(lockKey);
      }
    }
    return { captured, failures };
  }

  async recover(
    recentIntakes: readonly {
      submissionId: number;
      appliancePhotos: readonly string[];
      retentionExpiresAt?: number;
    }[],
    fetchImage: (url: string) => Promise<BridgePhotoImage>,
    isAllowedSource: (url: string) => boolean,
  ): Promise<{ attempted: number; failures: number }> {
    let attempted = 0;
    let failures = 0;
    for (const intake of recentIntakes) {
      const result = await this.capture(
        intake.submissionId,
        intake.appliancePhotos,
        fetchImage,
        isAllowedSource,
        intake.retentionExpiresAt,
      );
      attempted += intake.appliancePhotos.length;
      failures += result.failures;
    }
    return { attempted, failures };
  }
}