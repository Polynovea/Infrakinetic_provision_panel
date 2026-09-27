import { describe, expect, it } from "vitest";

import { ROLE_SCOPE_CEILING } from "../../src/identity/roles.js";

// 1A.15 Q5 (D16) — ceiling changes are exactly these two, and no AI write
// authority leaked to roles that were not approved for it.
describe("1A.15 AI role ceilings", () => {
  it("security_operator can read the AI state it can suspend", () => {
    expect(ROLE_SCOPE_CEILING.security_operator).toEqual(expect.arrayContaining(["ai.read", "ai.emergency_suspend"]));
  });

  it("finops_operator can set AI quotas but not provider policy, entitlement or suspension", () => {
    expect(ROLE_SCOPE_CEILING.finops_operator).toContain("ai.quota.write");
    for (const scope of ["ai.provider_policy.write", "ai.entitlement.write", "ai.emergency_suspend"] as const) {
      expect(ROLE_SCOPE_CEILING.finops_operator).not.toContain(scope);
    }
  });

  it("no non-admin role gained ai.entitlement.write or ai.provider_policy.write", () => {
    for (const [role, scopes] of Object.entries(ROLE_SCOPE_CEILING)) {
      if (role === "platform_admin" || role === "break_glass") continue;
      expect(scopes).not.toContain("ai.entitlement.write");
      expect(scopes).not.toContain("ai.provider_policy.write");
    }
  });

  it("security_operator gained no AI write authority other than the existing suspend", () => {
    expect(ROLE_SCOPE_CEILING.security_operator.filter((s) => s.startsWith("ai."))).toEqual(["ai.read", "ai.emergency_suspend"]);
  });
});
