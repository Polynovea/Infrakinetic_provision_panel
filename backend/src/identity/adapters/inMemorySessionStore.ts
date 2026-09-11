import type { OperatorSessionStore } from "../sessionStore.js";
import type { StepUpState } from "../types.js";

// 1A.2 interim implementation — revocation/step-up state lives only in
// process memory, so it does not survive a restart and does not scale past
// one backend instance. Acceptable for 1A.2's exit criteria (prove
// logout/revocation works end-to-end locally); 1A.3's Postgres-backed
// implementation is required before this can be relied on in a real
// deployment with more than one process.
export class InMemorySessionStore implements OperatorSessionStore {
  private readonly revoked = new Map<string, string>();
  private readonly stepUps = new Map<string, StepUpState>();

  async isRevoked(sessionId: string): Promise<boolean> {
    return this.revoked.has(sessionId);
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    this.revoked.set(sessionId, reason);
  }

  async recordStepUp(sessionId: string, state: StepUpState): Promise<void> {
    this.stepUps.set(sessionId, state);
  }

  async getStepUp(sessionId: string): Promise<StepUpState | undefined> {
    return this.stepUps.get(sessionId);
  }
}
