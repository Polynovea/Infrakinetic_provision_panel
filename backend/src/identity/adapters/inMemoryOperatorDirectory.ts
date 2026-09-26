import { isPendingFirstMfaLogin, type OperatorDirectory } from "../operatorDirectory.js";
import type { OperatorRecord } from "../types.js";

// 1A.2 interim implementation. Real operator provisioning (add/disable an
// operator without a redeploy) requires the Governance database from 1A.3 —
// tracked as a known limitation in docs/1A.2_status.md. This class exists
// solely so the rest of the auth boundary can be built and tested against a
// stable OperatorDirectory contract today.
export class InMemoryOperatorDirectory implements OperatorDirectory {
  private readonly byCognitoSub: Map<string, OperatorRecord>;

  constructor(seed: readonly OperatorRecord[]) {
    this.byCognitoSub = new Map(seed.map((op) => [op.cognitoSub, op]));
  }

  async findByCognitoSub(cognitoSub: string): Promise<OperatorRecord | undefined> {
    return this.byCognitoSub.get(cognitoSub);
  }

  async activatePendingOperator(operatorId: string): Promise<boolean> {
    for (const [sub, op] of this.byCognitoSub) {
      if (op.operatorId === operatorId) {
        if (!isPendingFirstMfaLogin(op)) return false;
        this.byCognitoSub.set(sub, { ...op, status: "active", mfaEnrolled: true, disabledAt: undefined, disabledReason: undefined });
        return true;
      }
    }
    return false;
  }
}
