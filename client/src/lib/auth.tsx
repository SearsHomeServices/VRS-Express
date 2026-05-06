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
