// Phase 1A risk classification. R3/R4 are the central high-risk policy classes:
// both require an approval workflow; route/domain adapters additionally enforce
// fresh step-up and bind maker/checker evidence to the concrete operation.

export const RISK_CLASSES = ["R0", "R1", "R2", "R3", "R4"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export function isRiskClass(value: unknown): value is RiskClass {
  return typeof value === "string" && (RISK_CLASSES as readonly string[]).includes(value);
}

export interface RiskClassPolicy {
  readonly label: string;
  readonly requiresReason: boolean;
  /** High-risk workflow flag consumed by Phase 1A hardening checks. */
  readonly requiresApprovalWorkflow: boolean;
}

export const RISK_CLASS_POLICY: Readonly<Record<RiskClass, RiskClassPolicy>> = Object.freeze({
  R0: { label: "Observe (read-only)", requiresReason: false, requiresApprovalWorkflow: false },
  R1: { label: "Low-impact metadata", requiresReason: false, requiresApprovalWorkflow: false },
  R2: { label: "Tenant operational", requiresReason: true, requiresApprovalWorkflow: false },
  R3: { label: "Sensitive identity/credential", requiresReason: true, requiresApprovalWorkflow: true },
  R4: { label: "Platform/global emergency", requiresReason: true, requiresApprovalWorkflow: true },
});

export function riskClassRequiresReason(riskClass: RiskClass): boolean {
  return RISK_CLASS_POLICY[riskClass].requiresReason;
}

export function riskClassRequiresApprovalWorkflow(riskClass: RiskClass): boolean {
  return RISK_CLASS_POLICY[riskClass].requiresApprovalWorkflow;
}
