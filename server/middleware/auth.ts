import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { is1099PortalEnabled } from "../featureFlags";

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

export function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    res.status(401).json({ error: "No token provided" });
    return;
  }

  const secret = process.env.SESSION_SECRET!;

  try {
    const decoded = jwt.verify(token, secret) as {
      id: number;
      email: string;
      name: string;
      role: string;
      ldapId?: string;
      isTechnician?: boolean;
    };
    // 1099 provider portal feature flag: when disabled, reject any
    // already-issued provider token so no provider-reachable route is usable.
    if (decoded.role === "provider_1099" && !is1099PortalEnabled()) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    (req as AuthenticatedRequest).user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
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
