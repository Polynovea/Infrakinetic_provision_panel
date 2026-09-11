import type { StepUpState } from "./types.js";

// Governance-owned session/revocation persistence port. The operator
// session id is the verified IdP token's own "jti" (1A.2 does not mint a
// separate management assertion — see docs/1A.2_status.md for that
// architecture decision). Revocation and step-up state must survive
// independently of whether the underlying Cognito token is still
// time-valid, which is why they are tracked here rather than as claims.
export interface OperatorSessionStore {
  isRevoked(sessionId: string): Promise<boolean>;
  revoke(sessionId: string, reason: string): Promise<void>;
  recordStepUp(sessionId: string, state: StepUpState): Promise<void>;
  getStepUp(sessionId: string): Promise<StepUpState | undefined>;
}
