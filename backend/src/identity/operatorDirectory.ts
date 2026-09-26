import type { OperatorRecord } from "./types.js";

// Governance-owned operator persistence port. The 1A.2 default
// implementation (adapters/inMemoryOperatorDirectory.ts) is a fixture-seeded
// in-memory store — there is no Governance database yet (that is 1A.3). The
// migration in migrations/0001_operator_identity_schema.sql is authored
// against this exact shape so a Postgres-backed implementation can replace
// the in-memory one in 1A.3 without touching the middleware or routes that
// depend on this interface.

// The exact disabled_reason bootstrapOperatorDb.ts writes for an operator
// created pending their first MFA'd login. Audit remediation M2: this marker,
// not merely "disabled + mfaEnrolled=false", is what makes an operator
// eligible for self-activation — an operator disabled FOR CAUSE before they
// ever completed a first login has the same status/mfa shape but a different
// reason, and must stay disabled when they log in.
export const PENDING_MFA_DISABLED_REASON = "Pending real TOTP MFA enrollment (bootstrap-created, not yet verified)";

export function isPendingFirstMfaLogin(operator: Pick<OperatorRecord, "status" | "mfaEnrolled" | "disabledReason">): boolean {
  return operator.status === "disabled" && !operator.mfaEnrolled && operator.disabledReason === PENDING_MFA_DISABLED_REASON;
}

export interface OperatorDirectory {
  findByCognitoSub(cognitoSub: string): Promise<OperatorRecord | undefined>;
  // Self-service activation for an operator bootstrapped pending their first
  // MFA'd login (status 'disabled', mfaEnrolled false, disabled_reason ===
  // PENDING_MFA_DISABLED_REASON — see bootstrapOperatorDb.ts). The directory
  // re-checks that exact precondition atomically and returns false (changing
  // nothing) when it does not hold. See routes/auth/index.ts's callback
  // handler for why this is safe: on a pool with MfaConfiguration=ON, a
  // successfully verified ID token is itself proof MFA was completed.
  activatePendingOperator(operatorId: string): Promise<boolean>;
}
