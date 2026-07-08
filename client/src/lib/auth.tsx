import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { User } from "@shared/schema";
import { queryClient } from "./queryClient";

type SafeUser = Omit<User, "password">;

interface AuthContextType {
  user: SafeUser | null;
  token: string | null;
  isLoading: boolean;
  login: (identifier: string, password: string) => Promise<SafeUser>;
  techLogin: (ldapId: string) => Promise<{ technician: any }>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SafeUser | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("vrs_token"));
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (token) {
      fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(async (res) => {
          if (res.ok) {
            const data = await res.json();
            setUser(data.user);
          } else {
            localStorage.removeItem("vrs_token");
            setToken(null);
            setUser(null);
          }
        })
        .catch(() => {
          localStorage.removeItem("vrs_token");
          setToken(null);
          setUser(null);
        })
        .finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, [token]);

  const login = useCallback(async (identifier: string, password: string): Promise<SafeUser> => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Login failed");
    }

    const data = await res.json();
    localStorage.setItem("vrs_token", data.token);
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  // Passwordless technician login: submit LDAP ID → server issues JWT directly.
  const techLogin = useCallback(async (ldapId: string) => {
    const res = await fetch("/api/auth/tech-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ldapId }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Login failed");
    }

    const data = await res.json();
    localStorage.setItem("vrs_token", data.token);
    setToken(data.token);
    setUser(data.user);
    return { technician: data.technician };
  }, []);

  const refreshUser = useCallback(async () => {
    const currentToken = localStorage.getItem("vrs_token");
    if (!currentToken) return;
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${currentToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
      }
    } catch {}
  }, []);

  const logout = useCallback(async () => {
    try {
      const { disconnectWs } = await import("./websocket");
      disconnectWs();
    } catch {}
    // Tier 1 hotfix (2026-04-28): clear ALL tech-submit drafts on logout.
    // The draft key is scoped per user.id, but if a session is somehow
    // inherited across techs on the same client, leaving a prior tech's
    // draft behind means the next person logging in could load it.
    // See client/src/lib/draft-identity.ts for the load-time defense.
    try {
      const { clearAllTechSubmitDrafts } = await import("./draft-identity");
      clearAllTechSubmitDrafts(localStorage);
    } catch {}
    localStorage.removeItem("vrs_token");
    // Clear the scoped media token cache on logout so the next user
    // doesn't inherit a stale cache from a prior session.
    mediaTokenCache.clear();
    setToken(null);
    setUser(null);
    queryClient.clear();
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, techLogin, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}

export function getToken(): string | null {
  return localStorage.getItem("vrs_token");
}

// ---------------------------------------------------------------------------
// Scoped media token cache + helpers
//
// GET /api/media-token?path=<objectPath> issues a short-lived (30 min),
// path-bound JWT with { type:"media", path } that is accepted by
// GET/HEAD /objects/* instead of the full session JWT.  This prevents
// leaked /objects/ URLs from exposing full account credentials.
//
// Tokens are cached client-side for 25 minutes (slightly under the server's
// 30 min TTL) so repeated renders of the same image don't hammer the endpoint
// AND — critically — so the tokenized /objects/ URL stays byte-identical
// across dialog reopens. Browsers key their HTTP cache on the full URL, so
// a stable URL is what lets Cache-Control/ETag actually avoid re-downloading
// media bytes (this was the "media takes super long to populate" fix).
// The cache is keyed by objectPath and cleared on logout.
// ---------------------------------------------------------------------------

interface CachedMediaToken {
  token: string;
  exp: number; // ms timestamp — token is considered valid until this point
}

const CACHE_TTL_MS = 25 * 60 * 1000; // 25 min (server TTL is 30 min)

export const mediaTokenCache = new Map<string, CachedMediaToken>();

export async function getMediaToken(objectPath: string): Promise<string> {
  const now = Date.now();
  const cached = mediaTokenCache.get(objectPath);
  if (cached && cached.exp > now + 10_000) {
    return cached.token;
  }

  const sessionToken = getToken();
  if (!sessionToken) throw new Error("Not authenticated");

  const res = await fetch(
    `/api/media-token?path=${encodeURIComponent(objectPath)}`,
    { headers: { Authorization: `Bearer ${sessionToken}` } }
  );

  if (!res.ok) {
    throw new Error(`Media token fetch failed: ${res.status}`);
  }

  const data = await res.json();
  mediaTokenCache.set(objectPath, { token: data.token, exp: now + CACHE_TTL_MS });
  return data.token;
}

// Build a tokenized URL for use in src/href attributes.
// Returns a promise so callers that need it synchronously can await it.
export async function buildMediaUrl(url: string | null | undefined): Promise<string> {
  if (!url) return "";
  if (!url.startsWith("/objects/")) return url;
  try {
    const token = await getMediaToken(url);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}token=${encodeURIComponent(token)}`;
  } catch {
    return "";
  }
}

// Tokenize an array of /objects/ URLs in parallel (for lightboxes, galleries).
// Non-/objects/ URLs pass through unchanged.
export async function buildMediaUrls(urls: string[]): Promise<string[]> {
  return Promise.all(urls.map(buildMediaUrl));
}

// React hook: returns a tokenized URL, initially "" until the async token
// fetch resolves.  Handles null/undefined src and non-/objects/ URLs.
export function useMediaUrl(url: string | null | undefined): string {
  const [tokenizedUrl, setTokenizedUrl] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    if (!url) {
      setTokenizedUrl("");
      return;
    }
    if (!url.startsWith("/objects/")) {
      setTokenizedUrl(url);
      return;
    }
    buildMediaUrl(url).then((result) => {
      if (!cancelled) setTokenizedUrl(result);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return tokenizedUrl;
}
