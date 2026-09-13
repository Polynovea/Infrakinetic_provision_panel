import { describe, expect, it } from "vitest";

import {
  isRiskClass,
  riskClassRequiresReason,
  RISK_CLASS_POLICY,
} from "../../../src/management/operations/riskClassification.js";

describe("management/operations/riskClassification", () => {
  it("accepts exactly R0-R4", () => {
    for (const rc of ["R0", "R1", "R2", "R3", "R4"]) expect(isRiskClass(rc)).toBe(true);
  });

  it("rejects anything outside the known vocabulary", () => {
    expect(isRiskClass("R5")).toBe(false);
    expect(isRiskClass("r2")).toBe(false);
    expect(isRiskClass(2)).toBe(false);
    expect(isRiskClass(undefined)).toBe(false);
  });

  it("R0/R1 do not require a reason; R2-R4 do", () => {
    expect(riskClassRequiresReason("R0")).toBe(false);
    expect(riskClassRequiresReason("R1")).toBe(false);
    expect(riskClassRequiresReason("R2")).toBe(true);
    expect(riskClassRequiresReason("R3")).toBe(true);
    expect(riskClassRequiresReason("R4")).toBe(true);
  });

  it("R3/R4 flag an approval-workflow hook without 1A.5 implementing one", () => {
    expect(RISK_CLASS_POLICY.R3.requiresApprovalWorkflow).toBe(true);
    expect(RISK_CLASS_POLICY.R4.requiresApprovalWorkflow).toBe(true);
    expect(RISK_CLASS_POLICY.R2.requiresApprovalWorkflow).toBe(false);
  });
});
