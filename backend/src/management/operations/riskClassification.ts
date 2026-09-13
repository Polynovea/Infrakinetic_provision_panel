// 1A.5 — risk classification (master plan §20). The durable model and its
// "requires reason" policy hook only — maker-checker/step-up workflows for
// R3/R4 are deliberately NOT implemented here (instruction #5); this module
// exists so a later phase can add that workflow without a schema or type
// change, by reading the same RISK_CLASS_POLICY table.

export const RISK_CLASSES = ["R0", "R1", "R2", "R3", "R4"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export function isRiskClass(value: unknown): value is RiskClass {
  return typeof value === "string" && (RISK_CLASSES as readonly string[]).includes(value);
}

export interface RiskClassPolicy {
  readonly label: string;
  readonly requiresReason: boolean;
  /** Not enforced by 1A.5 — recorded so a future phase's maker-checker gate has a single source of truth to read. */
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
