"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { isDevAuthBypassEnabled } from "./authConfig";

export const GOVERNANCE_API_BASE_URL = process.env.NEXT_PUBLIC_GOVERNANCE_API_BASE_URL ?? "http://localhost:4100";
const DEV_TOKEN_STORAGE_KEY = "governance.dev.idToken";

export interface OperatorIdentity {
  operatorId: string;
  email: string;
  roles: readonly string[];
  scopes: readonly string[];
}

export type SessionStatus = "checking" | "unavailable" | "signed-out" | "authenticated";

interface WhoAmIResponse {
  operator?: OperatorIdentity;
  csrfToken?: string;
}

interface SessionContextValue {
  status: SessionStatus;
  operator: OperatorIdentity | null;
  devBypassAvailable: boolean;
  signIn: () => void;
  signOut: () => Promise<void>;
  setDevToken: (token: string) => Promise<boolean>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function isUnsafeMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return !["GET", "HEAD", "OPTIONS"].includes(normalized);
}

async function readWhoAmI(devToken?: string): Promise<{ response: Response; body: WhoAmIResponse | null }> {
  const headers = new Headers();
  if (devToken) headers.set("authorization", `Bearer ${devToken}`);
  try {
    const response = await fetch(`${GOVERNANCE_API_BASE_URL}/management/v1/whoami`, {
      headers,
      credentials: "include",
    });
    const body = response.ok ? ((await response.json()) as WhoAmIResponse) : null;
    return { response, body };
  } catch {
    return { response: new Response(null, { status: 503 }), body: null };
  }
}

async function authConfigured(): Promise<boolean> {
  try {
    const response = await fetch(`${GOVERNANCE_API_BASE_URL}/auth/status`, { credentials: "include" });
    if (!response.ok) return false;
    const body = (await response.json()) as { configured?: boolean };
    return body.configured === true;
  } catch {
    return false;
  }
}

export function OperatorSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("checking");
  const [operator, setOperator] = useState<OperatorIdentity | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [devToken, setDevTokenState] = useState<string | null>(null);
  const devBypassAvailable = isDevAuthBypassEnabled();

  const adoptWhoAmI = useCallback((body: WhoAmIResponse | null): boolean => {
    if (!body?.operator) return false;
    setOperator(body.operator);
    setCsrfToken(body.csrfToken ?? null);
    setStatus("authenticated");
    return true;
  }, []);

  const refresh = useCallback(async () => {
    const sessionResult = await readWhoAmI();
    if (sessionResult.response.ok && adoptWhoAmI(sessionResult.body)) {
      setDevTokenState(null);
      return;
    }

    if (devBypassAvailable) {
      const stored = sessionStorage.getItem(DEV_TOKEN_STORAGE_KEY);
      if (stored) {
        const devResult = await readWhoAmI(stored);
        if (devResult.response.ok && adoptWhoAmI(devResult.body)) {
          setDevTokenState(stored);
          return;
        }
        sessionStorage.removeItem(DEV_TOKEN_STORAGE_KEY);
      }
    }

    setOperator(null);
    setCsrfToken(null);
    setDevTokenState(null);
    const configured = await authConfigured();
    setStatus(configured || devBypassAvailable ? "signed-out" : "unavailable");
  }, [adoptWhoAmI, devBypassAvailable]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(() => {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`${GOVERNANCE_API_BASE_URL}/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, []);

  const request = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (devToken) {
        headers.set("authorization", `Bearer ${devToken}`);
      } else if (isUnsafeMethod(init.method)) {
        if (!csrfToken) throw new Error("Authenticated browser session is missing its anti-CSRF token.");
        headers.set("x-governance-csrf", csrfToken);
      }
      return fetch(`${GOVERNANCE_API_BASE_URL}${path}`, {
        ...init,
        headers,
        credentials: "include",
      });
    },
    [csrfToken, devToken],
  );

  const signOut = useCallback(async () => {
    if (devToken) {
      sessionStorage.removeItem(DEV_TOKEN_STORAGE_KEY);
      setDevTokenState(null);
      setOperator(null);
      setCsrfToken(null);
      setStatus("signed-out");
      return;
    }

    try {
      await request("/management/v1/session/logout", { method: "POST" });
    } finally {
      setOperator(null);
      setCsrfToken(null);
      setStatus("signed-out");
      window.location.assign(`${GOVERNANCE_API_BASE_URL}/auth/cognito-logout`);
    }
  }, [devToken, request]);

  const setDevToken = useCallback(
    async (candidateToken: string): Promise<boolean> => {
      if (!devBypassAvailable) return false;
      const result = await readWhoAmI(candidateToken);
      if (!result.response.ok || !adoptWhoAmI(result.body)) return false;
      sessionStorage.setItem(DEV_TOKEN_STORAGE_KEY, candidateToken);
      setDevTokenState(candidateToken);
      return true;
    },
    [adoptWhoAmI, devBypassAvailable],
  );

  const value = useMemo<SessionContextValue>(
    () => ({ status, operator, devBypassAvailable, signIn, signOut, setDevToken, request, refresh }),
    [status, operator, devBypassAvailable, signIn, signOut, setDevToken, request, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useOperatorSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useOperatorSession() must be used within an OperatorSessionProvider.");
  return ctx;
}