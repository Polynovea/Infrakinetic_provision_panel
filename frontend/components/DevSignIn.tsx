"use client";

// Development-only sign-in bypass. Gated at the call site by
// isDevAuthBypassEnabled() (NODE_ENV !== "production" AND an explicit local
// opt-in flag) — this component is never reachable in a production build.
// Deliberately styled as an out-of-band developer tool (dashed border,
// warning color, explicit "not available in production" copy) rather than
// as a normal part of the product's sign-in experience.

import { useState } from "react";

export function DevSignIn({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="dev-banner">
      <strong>Development sign-in</strong> — not available in production builds.
      <div className="field" style={{ marginTop: "0.6rem" }}>
        <input
          type="password"
          placeholder="Paste a Cognito ID token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <button className="btn" onClick={() => onSubmit(value)} disabled={value.trim() === ""}>
        Continue
      </button>
    </div>
  );
}
