import type { OperatorRecord } from "./types.js";

// Governance-owned operator persistence port. The 1A.2 default
// implementation (adapters/inMemoryOperatorDirectory.ts) is a fixture-seeded
// in-memory store — there is no Governance database yet (that is 1A.3). The
// migration in migrations/0001_operator_identity_schema.sql is authored
// against this exact shape so a Postgres-backed implementation can replace
// the in-memory one in 1A.3 without touching the middleware or routes that
// depend on this interface.
export interface OperatorDirectory {
  findByCognitoSub(cognitoSub: string): Promise<OperatorRecord | undefined>;
  // Self-service activation for an operator bootstrapped pending their first
  // MFA'd login (status 'disabled', mfaEnrolled false — see
  // bootstrapOperatorDb.ts). Callers must only invoke this after already
  // verifying that exact precondition themselves; the directory does not
  // re-check it. See routes/auth/index.ts's callback handler for why this is
  // safe: on a pool with MfaConfiguration=ON, a successfully verified ID
  // token is itself proof MFA was completed.
  activatePendingOperator(operatorId: string): Promise<void>;
}
