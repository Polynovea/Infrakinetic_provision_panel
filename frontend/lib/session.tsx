"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { getCognitoAuthConfig, isDevAuthBypassEnabled } from "./authConfig";
import { beginSignIn, buildSignOutUrl, decodeJwtExpiry, ID_TOKEN_STORAGE_KEY } from "./cognitoAuth";

export const GOVERNANCE_API_BASE_URL = process.env.NEXT_PUBLIC_GOVERNANCE_API_BASE_URL ?? "http://127.0.0.1:4100";

export interface OperatorIdentity {
  operatorId: string;
  email: string;
  roles: readonly string[];
  scopes: readonly string[];
}

export type SessionStatus =
  | "checking"
  | "unavailable" // sign-in not configured and no dev bypass — fail closed
  | "signed-out"
  | "authenticated";

interface SessionContextValue {
  status: SessionStatus;
  token: string | null;
  operator: OperatorIdentity | null;
  devBypassAvailable: boolean;
  signIn: () => Promise<void>;
  signOut: () => void;
  /** Dev-only bypass entry point — see components/DevSignIn.tsx, never rendered in production. */
  setDevToken: (token: string) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

async function fetchOperator(token: string): Promise<OperatorIdentity | null> {
  try {
    const res = await fetch(`${GOVERNANCE_API_BASE_URL}/management/v1/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.operator ?? null;
  } catch {
    return null;
  }
}

export function OperatorSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("checking");
  const [token, setToken] = useState<string | null>(null);
  const [operator, setOperator] = useState<OperatorIdentity | null>(null);

  const devBypassAvailable = isDevAuthBypassEnabled();
  const cognitoConfig = getCognitoAuthConfig();

  const adopt = useCallback(async (candidateToken: string): Promise<boolean> => {
    const expiry = decodeJwtExpiry(candidateToken);
    if (expiry !== null && expiry <= Date.now()) return false;
    const identity = await fetchOperator(candidateToken);
    if (!identity) return false;
    setToken(candidateToken);
    setOperator(identity);
    setStatus("authenticated");
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = sessionStorage.getItem(ID_TOKEN_STORAGE_KEY);
      if (stored) {
        const ok = await adopt(stored);
        if (cancelled) return;
        if (ok) return;
        sessionStorage.removeItem(ID_TOKEN_STORAGE_KEY);
      }
      if (cancelled) return;
      setStatus(cognitoConfig || devBypassAvailable ? "signed-out" : "unavailable");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = useCallback(async () => {
    if (!cognitoConfig) return;
    await beginSignIn(cognitoConfig);
  }, [cognitoConfig]);

  const signOut = useCallback(() => {
    sessionStorage.removeItem(ID_TOKEN_STORAGE_KEY);
    setToken(null);
    setOperator(null);
    setStatus(cognitoConfig || devBypassAvailable ? "signed-out" : "unavailable");
    if (cognitoConfig) {
      window.location.assign(buildSignOutUrl(cognitoConfig, window.location.origin));
    }
  }, [cognitoConfig, devBypassAvailable]);

  const setDevToken = useCallback(
    async (candidateToken: string) => {
      if (!devBypassAvailable) return;
      const ok = await adopt(candidateToken);
      if (ok) sessionStorage.setItem(ID_TOKEN_STORAGE_KEY, candidateToken);
    },
    [adopt, devBypassAvailable],
  );

  const value = useMemo<SessionContextValue>(
    () => ({ status, token, operator, devBypassAvailable, signIn, signOut, setDevToken }),
    [status, token, operator, devBypassAvailable, signIn, signOut, setDevToken],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useOperatorSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useOperatorSession() must be used within an OperatorSessionProvider.");
  return ctx;
}
