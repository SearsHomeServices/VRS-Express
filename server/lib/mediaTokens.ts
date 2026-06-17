// Scoped media access tokens.
//
// These are narrow-claim JWTs with:
//   type: "media"         — distinguishes from session JWTs (no account access)
//   path: "/objects/..."  — bound to a single object path
//   exp:  now + 5 min     — short-lived to limit damage from URL leakage
//
// They are issued by GET /api/media-token?path= (requires a valid session
// JWT in the Authorization header) and accepted ONLY by
// GET/HEAD /objects/{*objectPath} via authenticateTokenForMedia.
// The full session JWT is NOT accepted on the media route; only scoped
// tokens are, so leaked /objects/ URLs never expose full account credentials.

import jwt from "jsonwebtoken";

const MEDIA_TOKEN_TTL_SEC = 5 * 60; // 5 minutes

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
