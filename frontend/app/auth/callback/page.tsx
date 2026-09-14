"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { getCognitoAuthConfig } from "../../../lib/authConfig";
import { completeSignIn } from "../../../lib/cognitoAuth";

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = params.get("code");
    const config = getCognitoAuthConfig();
    if (!config || !code) {
      setError("Sign-in could not be completed.");
      return;
    }
    completeSignIn(config, code)
      .then(() => {
        router.replace("/");
        router.refresh();
      })
      .catch(() => setError("Sign-in could not be completed."));
  }, [params, router]);

  return (
    <main className="auth-screen">
      {error ? (
        <div className="auth-card">
          <p className="auth-error">{error}</p>
          <a className="btn btn-primary" href="/">
            Back to sign-in
          </a>
        </div>
      ) : (
        <div className="auth-card">
          <p>Completing sign-in…</p>
        </div>
      )}
    </main>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackInner />
    </Suspense>
  );
}
