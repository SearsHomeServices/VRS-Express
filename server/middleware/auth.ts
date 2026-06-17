import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { is1099PortalEnabled } from "../featureFlags";
import { storage } from "../storage";
import { verifyMediaToken } from "../lib/mediaTokens";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    email: string;
    name: string;
    role: string;
    ldapId?: string;
    isTechnician?: boolean;
  };
}

interface CachedUserStatus {
  isActive: boolean;
  role: string;
  expiresAt: number;
}

const userStatusCache = new Map<number, CachedUserStatus>();
const CACHE_TTL_MS = 30_000;

function getCachedStatus(userId: number): CachedUserStatus | null {
  const entry = userStatusCache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    userStatusCache.delete(userId);
    return null;
  }
  return entry;
}

function setCachedStatus(userId: number, isActive: boolean, role: string): void {
  userStatusCache.set(userId, { isActive, role, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function invalidateUserStatusCache(userId: number): void {
  userStatusCache.delete(userId);
}

export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    res.status(401).json({ error: "No token provided" });
    return;
  }

  const secret = process.env.SESSION_SECRET!;

  let decoded: {
    id: number;
    email: string;
    name: string;
    role: string;
    ldapId?: string;
    isTechnician?: boolean;
  };

  try {
    decoded = jwt.verify(token, secret) as typeof decoded;
  } catch {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  // 1099 provider portal feature flag: when disabled, reject any
  // already-issued provider token so no provider-reachable route is usable.
  if (decoded.role === "provider_1099" && !is1099PortalEnabled()) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  // Re-validate the user's current status and role against the database so
  // that demoted or deactivated accounts lose access immediately rather than
  // waiting for the 7-day JWT to expire. A 30-second in-process TTL cache
  // keeps the per-request DB cost negligible.
  try {
    if (decoded.isTechnician && decoded.ldapId) {
      // Technicians are managed via the `technicians` directory table AND have
      // a corresponding `users` row. Both must be active for the token to be valid.
      // We also rewrite decoded.role from the users table so that promotions or
      // demotions are reflected immediately, just like non-technician users.
      const cached = getCachedStatus(decoded.id);
      if (!cached) {
        const [techUser, technician] = await Promise.all([
          storage.getUser(decoded.id),
          storage.getTechnicianByLdapId(decoded.ldapId),
        ]);
        if (!techUser || !techUser.isActive) {
          res.status(401).json({ error: "Account is inactive or not found" });
          return;
        }
        if (!technician || !technician.isActive) {
          res.status(401).json({ error: "Account is inactive or not found" });
          return;
        }
        setCachedStatus(decoded.id, techUser.isActive, techUser.role);
        // Reflect the current role from the DB, not the JWT claim.
        decoded = { ...decoded, role: techUser.role };
      } else {
        if (!cached.isActive) {
          res.status(401).json({ error: "Account is inactive or not found" });
          return;
        }
        // Reflect the current role from the cache.
        decoded = { ...decoded, role: cached.role };
      }
    } else {
      // Non-technician: check the users table for current isActive and role.
      const cached = getCachedStatus(decoded.id);
      if (cached) {
        if (!cached.isActive) {
          res.status(401).json({ error: "Account is deactivated" });
          return;
        }
        // Reflect the current role from the DB, not the JWT claim.
        decoded = { ...decoded, role: cached.role };
      } else {
        const user = await storage.getUser(decoded.id);
        if (!user || !user.isActive) {
          res.status(401).json({ error: "Account is deactivated or not found" });
          return;
        }
        setCachedStatus(decoded.id, user.isActive, user.role);
        // Reflect the current role from the DB, not the JWT claim.
        decoded = { ...decoded, role: user.role };
      }
    }
  } catch {
    res.status(500).json({ error: "Authentication error" });
    return;
  }

  (req as AuthenticatedRequest).user = decoded;
  next();
}

// Middleware for GET/HEAD /objects/* (media serving).
//
// Accepts ONLY a scoped media token — a short-lived, path-bound JWT with
// { type:"media", path:"/objects/..." } — via the ?token= query param
// OR the Authorization header.  The full session JWT is NOT accepted here;
// only narrow-claim tokens issued by GET /api/media-token are valid.
//
// This design means a leaked /objects/ URL (browser history, copied link,
// screenshot, proxy log) only exposes access to that single file for ≤5 min,
// not the holder's full account credentials.
//
// Per-object authorization (ownership) is enforced at /api/media-token
// issuance time; here we only verify the scoped token's validity and path
// binding (token.path must equal the requested path).
export function authenticateTokenForMedia(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers["authorization"];
  const headerToken = authHeader && authHeader.split(" ")[1];
  const queryToken =
    typeof (req.query as any).token === "string"
      ? ((req.query as any).token as string)
      : null;
  const token = headerToken || queryToken;

  if (!token) {
    res.status(401).json({ error: "No token provided" });
    return;
  }

  // req.path is the full path e.g. "/objects/.private/abc123.jpg"
  if (!verifyMediaToken(token, req.path)) {
    res.status(403).json({ error: "Invalid or expired media token" });
    return;
  }

  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ error: "No user found" });
      return;
    }

    if (authReq.user.role === "super_admin") {
      next();
      return;
    }

    if (!roles.includes(authReq.user.role)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    next();
  };
}
