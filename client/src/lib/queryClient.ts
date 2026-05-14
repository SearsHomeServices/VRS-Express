import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { getToken } from "./auth";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.status === 401) {
      // Tyler 2026-05-08 — previously every 401 nuked the token and force-
      // redirected to /login. A single transient 401 (deploy restart, network
      // blip, momentary auth-middleware hiccup) was kicking active agents
      // out mid-ticket (Jeff Van Ness, Wayne Harrison reports 2026-05-08).
      // Now: only treat /api/auth/me 401 as definitively logged-out (that
      // route exists specifically to validate the current session). For any
      // other endpoint, throw the error so the caller can show a toast /
      // retry, but DO NOT remove the token or redirect — most 401s on
      // working endpoints are transient and the next request will succeed.
      const url = (res.url || "").toLowerCase();
      const isAuthCheck = url.endsWith("/api/auth/me") || url.includes("/api/auth/me?");
      if (isAuthCheck) {
        localStorage.removeItem("vrs_token");
        window.location.href = "/login";
        // Throw so callers awaiting res.json() bail instead of racing with
        // the navigation (architect 2026-05-08).
        throw new Error("Unauthorized");
      }
      throw new Error("Unauthorized");
    }
    const text = (await res.text()) || res.statusText;
    let message = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) message = parsed.error;
      else if (parsed.message) message = parsed.message;
    } catch {}
    throw new Error(message);
  }
}

function getAuthHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: getAuthHeaders(!!data),
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

// Tyler 2026-05-11 — Replit's edge proxy occasionally rejects POSTs/PATCHs
// before they reach Express, returning a stock HTML 403/5xx page instead
// of our app's JSON. First seen on tech submissions (Mike, AHS, SO 8420-
// 13676372) and again on agent NLA escalation (Zorn, SO 8380-13547409 —
// "Processing Failed" toast with edge HTML 403 body). This helper retries
// the request up to `maxAttempts` times with 800ms / 1600ms backoff when
// the error looks transient. JSON 4xx errors (real validation failures
// from our own server) are NOT retried — caller still sees the actual
// message immediately. Safe by construction for routes that are either
// idempotent (POST /api/submissions has 60s tech-SO# idempotency) or
// status-conditional (PATCH /process, /process-nla use updateSubmission-
// IfStatus, so a duplicate retry returns 409 STALE_STATUS as JSON, not
// extra side effects). Server already enforces these guarantees.
export function isTransientApiError(msg: string): boolean {
  const m = (msg || "").toLowerCase();
  // Replit edge HTML 403 page (no JSON, contains "<title>403")
  if (m.includes("<!doctype html") && m.includes("403")) return true;
  // Generic edge HTML for 502/503/504
  if (m.includes("<!doctype html") && /50\d/.test(m)) return true;
  // fetch network failures
  if (m === "failed to fetch" || m.includes("networkerror")) return true;
  // Server 5xx surfaced as "internal server error" / similar
  if (m.includes("internal server error")) return true;
  return false;
}

// Tyler 2026-05-14 — when all retries in apiRequestWithRetry are exhausted
// and the underlying error is one of the known transient/edge-layer failures,
// the raw error.message is either a giant HTML blob ("<!doctype html>...
// <title>403</title>403 Forbidden") or an opaque "Failed to fetch". Showing
// that to a tech in a toast is confusing and looks like a real server error.
// This helper returns a short, plain-English message for those cases and
// passes through real server errors (JSON validation messages, etc.) as-is.
export function friendlyApiErrorMessage(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).trim();
  if (!raw) return "Something went wrong. Please try again.";
  if (isTransientApiError(raw)) {
    return "Connection issue — please tap Submit again.";
  }
  // Strip any stray HTML if a non-transient HTML body somehow leaked through.
  if (raw.toLowerCase().includes("<!doctype html")) {
    return "Something went wrong. Please try again.";
  }
  return raw;
}

export async function apiRequestWithRetry(
  method: string,
  url: string,
  data?: unknown | undefined,
  opts: { maxAttempts?: number; logTag?: string } = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const logTag = opts.logTag ?? "api-retry";
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await apiRequest(method, url, data);
    } catch (err: any) {
      lastErr = err;
      const msg = err?.message || String(err);
      if (attempt >= maxAttempts || !isTransientApiError(msg)) throw err;
      const backoffMs = 800 * Math.pow(2, attempt - 1);
      console.warn(
        `[${logTag}] attempt ${attempt} failed (transient) — retrying in ${backoffMs}ms. Error: ${msg.slice(0, 160)}`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      headers: getAuthHeaders(false),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
