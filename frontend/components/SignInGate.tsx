"use client";

import type { ReactNode } from "react";

import { getCognitoAuthConfig } from "../lib/authConfig";
import { useOperatorSession } from "../lib/session";
import { DevSignIn } from "./DevSignIn";

export function SignInGate({ children }: { children: ReactNode }) {
  const { status, devBypassAvailable, signIn, setDevToken } = useOperatorSession();
  const cognitoConfigured = getCognitoAuthConfig() !== null;

  if (status === "authenticated") return <>{children}</>;

  if (status === "checking") {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <p>Checking sign-in status…</p>
        </div>
      </main>
    );
  }

  if (status === "unavailable") {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <h1>Sign-in unavailable</h1>
          <p>Sign-in is not available right now. Contact your platform administrator.</p>
        </div>
      </main>
    );
  }

  // status === "signed-out"
  return (
    <main className="auth-screen">
      <div className="auth-card">
        <h1>PolyNovea Platform Governance</h1>
        <p>Sign in to continue.</p>
        {cognitoConfigured && (
          <button className="btn btn-primary" onClick={() => void signIn()}>
            Sign in
          </button>
        )}
        {devBypassAvailable && <DevSignIn onSubmit={(token) => void setDevToken(token)} />}
      </div>
    </main>
  );
}
