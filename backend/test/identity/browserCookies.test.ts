import { describe, expect, it } from "vitest";

import { sessionCookieCandidates } from "../../src/identity/browserCookies.js";

// Audit remediation L8 — in production only the __Host- session cookie is
// honoured; an unprefixed cookie planted from a sibling subdomain is ignored.
describe("sessionCookieCandidates", () => {
  it("production accepts only the __Host- prefixed session cookie", () => {
    expect(sessionCookieCandidates(true)).toEqual(["__Host-governance_session"]);
  });

  it("local non-TLS development still accepts the plain name", () => {
    expect(sessionCookieCandidates(false)).toContain("governance_session");
  });
});
