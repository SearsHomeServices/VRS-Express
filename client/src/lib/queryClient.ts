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
