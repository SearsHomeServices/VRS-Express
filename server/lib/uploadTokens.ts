// In-memory registry of objectPaths issued to specific users via
// POST /api/uploads/request-url.  The convert-audio and convert-video
// routes verify that the caller owns the objectPath before spending
// ffmpeg CPU on it.
//
// TTL is generous (2 h) so that slow upload / conversion pipelines on
// weak mobile connections are still covered.  Memory footprint is tiny:
// each entry is a string key + {userId, expiresAt} ≈ ~100 bytes.
// The map is capped at 20 000 live entries — well above any realistic
// concurrent usage — and expired entries are evicted on every write
// once the map is large.

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_ENTRIES = 20_000;

interface Entry {
  userId: number;
  expiresAt: number;
}

const uploadMap = new Map<string, Entry>();

function evictExpired(): void {
  const now = Date.now();
  for (const [k, v] of uploadMap) {
    if (v.expiresAt < now) uploadMap.delete(k);
  }
}

export function issueUploadToken(objectPath: string, userId: number): void {
  if (uploadMap.size >= MAX_ENTRIES) evictExpired();
  uploadMap.set(objectPath, { userId, expiresAt: Date.now() + TTL_MS });
}

export function verifyUploadOwnership(objectPath: string, userId: number): boolean {
  const entry = uploadMap.get(objectPath);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    uploadMap.delete(objectPath);
    return false;
  }
  return entry.userId === userId;
}
