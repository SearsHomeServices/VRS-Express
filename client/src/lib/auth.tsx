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
    inflightTokenFetches.clear();
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

// Tyler 2026-07-08 (perf) — in-flight dedupe map. Before this, N <MediaImage>
// components rendering the same ticket each fired their own
// GET /api/media-token the instant the grid mounted (the 25-min cache only
// helps AFTER the first resolution). Now the first request (or a batch
// prefetch — see prefetchMediaTokens) registers a promise here and every
// concurrent caller awaits it instead of duplicating the fetch.
const inflightTokenFetches = new Map<string, Promise<string>>();

async function fetchSingleMediaToken(objectPath: string): Promise<string> {
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
  mediaTokenCache.set(objectPath, { token: data.token, exp: Date.now() + CACHE_TTL_MS });
  return data.token;
}

export async function getMediaToken(objectPath: string): Promise<string> {
  const now = Date.now();
  const cached = mediaTokenCache.get(objectPath);
  if (cached && cached.exp > now + 10_000) {
    return cached.token;
  }

  const pending = inflightTokenFetches.get(objectPath);
  if (pending) return pending;

  const promise = fetchSingleMediaToken(objectPath);
  inflightTokenFetches.set(objectPath, promise);
  try {
    return await promise;
  } finally {
    if (inflightTokenFetches.get(objectPath) === promise) {
      inflightTokenFetches.delete(objectPath);
    }
  }
}

// Tyler 2026-07-08 (perf) — batched token prefetch. POST /api/media-tokens
// issues tokens for up to 60 paths in ONE round trip (one DB ownership check
// server-side instead of one per path). Call this the moment a ticket's
// media list is known; each path gets an in-flight promise so concurrent
// <MediaImage> mounts await the batch instead of firing individual GETs.
// Fire-and-forget by design: any batch failure (or a path missing from the
// response) falls back per-path to the original single-token GET, so worst
// case is exactly the pre-batch behavior.
export function prefetchMediaTokens(paths: Array<string | null | undefined>): void {
  const now = Date.now();
  const need = Array.from(
    new Set(
      paths.filter(
        (p): p is string => typeof p === "string" && p.startsWith("/objects/")
      )
    )
  ).filter((p) => {
    const cached = mediaTokenCache.get(p);
    if (cached && cached.exp > now + 10_000) return false;
    return !inflightTokenFetches.has(p);
  });
  if (need.length === 0) return;

  for (let i = 0; i < need.length; i += 60) {
    const chunk = need.slice(i, i + 60);
    const batchPromise = (async () => {
      const sessionToken = getToken();
      if (!sessionToken) throw new Error("Not authenticated");
      const res = await fetch("/api/media-tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ paths: chunk }),
      });
      if (!res.ok) throw new Error(`Batch media token fetch failed: ${res.status}`);
      const data = await res.json();
      return (data?.tokens || {}) as Record<string, string>;
    })();

    for (const p of chunk) {
      const perPath = batchPromise
        .then((tokens) => {
          const t = tokens[p];
          if (!t) throw new Error("Path missing from batch response");
          mediaTokenCache.set(p, { token: t, exp: Date.now() + CACHE_TTL_MS });
          return t;
        })
        .catch(() => fetchSingleMediaToken(p));
      inflightTokenFetches.set(p, perPath);
      perPath
        .catch(() => {})
        .finally(() => {
          if (inflightTokenFetches.get(p) === perPath) {
            inflightTokenFetches.delete(p);
          }
        });
    }
  }
}

// Collects every /objects/ media path on a submission row (slim or full):
// photos (new {issue,estimate} format or legacy array), thumbnail map
// values, video, voice note. Junk/missing JSON is skipped silently.
export function collectSubmissionMediaPaths(sub: {
  photos?: string | null;
  photoThumbnails?: string | null;
  videoUrl?: string | null;
  voiceNoteUrl?: string | null;
}): string[] {
  const out: unknown[] = [];
  try {
    const parsed = sub.photos ? JSON.parse(sub.photos) : null;
    if (Array.isArray(parsed)) out.push(...parsed);
    else if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.issue)) out.push(...parsed.issue);
      if (Array.isArray(parsed.estimate)) out.push(...parsed.estimate);
    }
  } catch {}
  try {
    const thumbs = sub.photoThumbnails ? JSON.parse(sub.photoThumbnails) : null;
    if (thumbs && typeof thumbs === "object" && !Array.isArray(thumbs)) {
      out.push(...Object.values(thumbs));
    }
  } catch {}
  if (sub.videoUrl) out.push(sub.videoUrl);
  if (sub.voiceNoteUrl) out.push(sub.voiceNoteUrl);
  return out.filter(
    (p): p is string => typeof p === "string" && p.startsWith("/objects/")
  );
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
