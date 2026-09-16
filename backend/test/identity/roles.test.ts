import { describe, expect, it } from "vitest";

import { isRole, isScope, ROLE_SCOPE_CEILING, ROLES, SCOPES } from "../../src/identity/roles.js";

describe("role/scope catalog", () => {
  it("gives every role a defined scope ceiling with only known scopes", () => {
    for (const role of ROLES) {
      const ceiling = ROLE_SCOPE_CEILING[role];
      expect(ceiling).toBeDefined();
      for (const scope of ceiling) {
        expect(SCOPES).toContain(scope);
      }
    }
  });

  it("gives platform_admin and break_glass the full scope set", () => {
    expect(new Set(ROLE_SCOPE_CEILING.platform_admin)).toEqual(new Set(SCOPES));
    expect(new Set(ROLE_SCOPE_CEILING.break_glass)).toEqual(new Set(SCOPES));
  });

  it("gives provisioning_operator the distinct tenant resume/decommission scopes", () => {
    expect(ROLE_SCOPE_CEILING.provisioning_operator).toEqual(
      expect.arrayContaining(["tenants.commission", "tenants.suspend", "tenants.resume", "tenants.decommission"]),
    );
    expect(isScope("tenants.resume")).toBe(true);
    expect(isScope("tenants.decommission")).toBe(true);
  });

  it("isRole/isScope reject unknown values", () => {
    expect(isRole("platform_admin")).toBe(true);
    expect(isRole("super_root_god_mode")).toBe(false);
    expect(isScope("tenants.read")).toBe(true);
    expect(isScope("tenants.delete_everything")).toBe(false);
  });

  it("platform_viewer's ceiling contains only *.read-shaped scopes (least privilege)", () => {
    for (const scope of ROLE_SCOPE_CEILING.platform_viewer) {
      expect(scope.endsWith(".read")).toBe(true);
    }
  });
});
