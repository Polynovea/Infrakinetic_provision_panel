import { describe, expect, it } from "vitest";

import {
  TENANT_LIFECYCLE_STATES,
  isTerminalTenantLifecycleState,
  isValidTenantLifecycleTransition,
  tenantRiskClassFor,
} from "../../../src/management/operations/tenantLifecycle.js";

describe("management/operations/tenantLifecycle", () => {
  it("contains the locked ten-state Governance lifecycle", () => {
    expect(TENANT_LIFECYCLE_STATES).toEqual([
      "draft",
      "requested",
      "approved",
      "provisioning",
      "active",
      "suspended",
      "decommission_requested",
      "decommissioning",
      "decommissioned",
      "failed",
    ]);
  });

  it("accepts the normal commission, suspend/resume, and decommission paths", () => {
    expect(isValidTenantLifecycleTransition("draft", "requested")).toBe(true);
    expect(isValidTenantLifecycleTransition("requested", "approved")).toBe(true);
    expect(isValidTenantLifecycleTransition("approved", "provisioning")).toBe(true);
    expect(isValidTenantLifecycleTransition("provisioning", "active")).toBe(true);
    expect(isValidTenantLifecycleTransition("active", "suspended")).toBe(true);
    expect(isValidTenantLifecycleTransition("suspended", "active")).toBe(true);
    expect(isValidTenantLifecycleTransition("active", "decommission_requested")).toBe(true);
    expect(isValidTenantLifecycleTransition("decommission_requested", "decommissioning")).toBe(true);
    expect(isValidTenantLifecycleTransition("decommissioning", "decommissioned")).toBe(true);
  });

  // 1A.8.0 scoping §9 ("Decommission: active/suspended -> decommission_requested")
  // — a suspended tenant must be directly decommissionable, without first
  // requiring a resume back to active.
  it("allows decommissioning directly from suspended, not only from active", () => {
    expect(isValidTenantLifecycleTransition("suspended", "decommission_requested")).toBe(true);
  });

  it("fails closed on invalid skips/reversals and makes decommissioned terminal", () => {
    expect(isValidTenantLifecycleTransition("draft", "active")).toBe(false);
    expect(isValidTenantLifecycleTransition("active", "draft")).toBe(false);
    expect(isValidTenantLifecycleTransition("decommission_requested", "active")).toBe(false);
    for (const state of TENANT_LIFECYCLE_STATES) {
      expect(isValidTenantLifecycleTransition("decommissioned", state)).toBe(false);
    }
    expect(isTerminalTenantLifecycleState("decommissioned")).toBe(true);
    expect(isTerminalTenantLifecycleState("active")).toBe(false);
  });

  it("classifies every tenant lifecycle mutation as R2", () => {
    expect(tenantRiskClassFor("tenant.commission")).toBe("R2");
    expect(tenantRiskClassFor("tenant.suspend")).toBe("R2");
    expect(tenantRiskClassFor("tenant.resume")).toBe("R2");
    expect(tenantRiskClassFor("tenant.decommission")).toBe("R2");
  });
});
