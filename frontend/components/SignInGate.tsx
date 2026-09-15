"use client";

import type { ReactNode } from "react";

import { useOperatorSession } from "../lib/session";
import { DevSignIn } from "./DevSignIn";
import { Icon } from "./Icon";

function BrandMark() {
  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <div className="text-headline">PolyNovea</div>
      <div className="text-label-caps" style={{ color: "var(--action-primary)", marginTop: "0.3rem" }}>
        Platform Governance
      </div>
    </div>
  );
}

export function SignInGate({ children }: { children: ReactNode }) {
  const { status, devBypassAvailable, signIn, setDevToken, refresh } = useOperatorSession();

  if (status === "authenticated") return <>{children}</>;

  if (status === "checking") {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <BrandMark />
          <p>Checking sign-in status…</p>
        </div>
      </main>
    );
  }

  if (status === "unavailable") {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <BrandMark />
          <Icon name="cloud_off" size="lg" className="auth-error" />
          <p className="auth-error" style={{ marginTop: "0.5rem" }}>
            Authentication is temporarily unavailable.
          </p>
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
        <BrandMark />
        <p>Sign in to continue.</p>
        <button className="btn btn-primary" onClick={signIn} style={{ width: "100%", marginTop: "0.5rem" }}>
          <Icon name="login" size="sm" /> Sign in
        </button>
        {devBypassAvailable && <DevSignIn onSubmit={(token) => void setDevToken(token)} />}
      </div>
    </main>
  );
}