"use client";

import type { ReactNode } from "react";

import { useOperatorSession } from "../lib/session";
import { DevSignIn } from "./DevSignIn";

export function SignInGate({ children }: { children: ReactNode }) {
  const { status, devBypassAvailable, signIn, setDevToken, refresh } = useOperatorSession();

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
          <h1>PolyNovea Platform Governance</h1>
          <p>Authentication is temporarily unavailable.</p>
          <button className="btn" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-screen">
      <div className="auth-card">
        <h1>PolyNovea Platform Governance</h1>
        <p>Sign in to continue.</p>
        <button className="btn btn-primary" onClick={signIn}>
          Sign in
        </button>
        {devBypassAvailable && <DevSignIn onSubmit={(token) => void setDevToken(token)} />}
      </div>
    </main>
  );
}