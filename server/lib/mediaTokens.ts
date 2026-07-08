// Scoped media access tokens.
//
// These are narrow-claim JWTs with:
//   type: "media"         — distinguishes from session JWTs (no account access)
//   path: "/objects/..."  — bound to a single object path
//   exp:  now + 30 min    — short-lived to limit damage from URL leakage
//
// They are issued by GET /api/media-token?path= (requires a valid session
// JWT in the Authorization header) and accepted ONLY by
// GET/HEAD /objects/{*objectPath} via authenticateTokenForMedia.
// The full session JWT is NOT accepted on the media route; only scoped
// tokens are, so leaked /objects/ URLs never expose full account credentials.

import jwt from "jsonwebtoken";

// 2026-07-08 (Tyler — "media takes super long to populate"): raised from
// 5 min to 30 min. The token rides in the /objects/ URL query string, and
// browsers key their HTTP cache on the FULL URL — so every token rotation
// changed every media URL and silently defeated the browser cache +
// ETag/304 revalidation the server already supports. Result: reopening a
// ticket re-downloaded every photo through the VM. With a 30 min TTL (and
// the client caching tokens for 25 min) URLs stay stable across dialog
// reopens, so repeat views come from browser cache / 304s.
// Security tradeoff (deliberate): a leaked URL now exposes that ONE file
// for ≤30 min instead of ≤5 — still path-bound, still no account access.
const MEDIA_TOKEN_TTL_SEC = 30 * 60; // 30 minutes

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return s;
}

export function issueMediaToken(objectPath: string): string {
  return jwt.sign(
    { type: "media", path: objectPath },
    getSecret(),
    { expiresIn: MEDIA_TOKEN_TTL_SEC }
  );
}

export function verifyMediaToken(token: string, expectedPath: string): boolean {
  try {
    const payload = jwt.verify(token, getSecret()) as any;
    return payload.type === "media" && payload.path === expectedPath;
  } catch {
    return false;
  }
}

// TechHub parts-photo tokens.
//
// Same narrow-claim design as media tokens, but bound to an absolute external
// CDN/S3 URL (type:"techhub_photo", url:"https://...") rather than an internal
// /objects/ path. Issued by GET /api/submissions/:id/techhub-photos AFTER the
// per-ticket access guard passes, and accepted ONLY by the proxy route
// GET /api/techhub-photo?token=. The session JWT is never accepted on the proxy,
// and the signed URL can only be one we returned — so the proxy cannot be
// pointed at an arbitrary host (SSRF) by the caller.
export function issueTechHubPhotoToken(url: string): string {
  return jwt.sign(
    { type: "techhub_photo", url },
    getSecret(),
    { expiresIn: MEDIA_TOKEN_TTL_SEC }
  );
}

export function verifyTechHubPhotoToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, getSecret()) as any;
    if (payload.type === "techhub_photo" && typeof payload.url === "string") {
      return payload.url;
    }
    return null;
  } catch {
    return null;
  }
}
