import { beforeEach, describe, expect, it } from "vitest";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { certifySyntheticManagementOperation } from "../../../src/management/operations/syntheticCertification.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "../../../src/management/operations/commandEnvelope.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { SyntheticManagementRequest } from "../../../src/management/operations/syntheticCertification.js";

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function seedOperator(client: DbClient) {
  await client.query(
    `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
     VALUES ($1, 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())`,
    [OPERATOR_ID],
  );
}

function baseRequest(overrides: Partial<SyntheticManagementRequest> = {}): SyntheticManagementRequest {
  return {
    idempotencyKey: "synthetic-cert-1",
    operatorId: OPERATOR_ID,
    operatorSessionId: SESSION_ID,
    requestedAction: "platform.engine-state.set",
    targetTenantId: null,
    targetEngine: "module_ai",
    reason: "1A.5 exit-gate certification",
    riskClass: "R2",
    payload: { desiredState: "enabled" },
    ...overrides,
  };
}

describe("management/operations/syntheticCertification", () => {
  let client: DbClient;
  let ledger: ManagementOperationLedger;

  beforeEach(async () => {
    const built = buildMigratedPgMemClient();
    client = built.client;
    ledger = new ManagementOperationLedger(client);
    await seedOperator(client);
  });

  it("runs the full chain to a completed, traceable, no-mutation result", async () => {
    const { operation, envelope, replay } = await certifySyntheticManagementOperation(ledger, baseRequest());

    expect(replay).toBe(false);
    expect(operation.status).toBe("completed");
    expect(operation.result).toMatchObject({ accepted: true });
    expect((operation.result as { note: string }).note).toContain("synthetic acceptance only");

    expect(envelope.contract).toBe(MANAGEMENT_COMMAND_CONTRACT);
    expect(envelope.idempotency_key).toBe(operation.idempotencyKey);
    expect(envelope.correlation_id).toBe(operation.correlationId);

    // Full lifecycle event trail exists and is in order.
    const events = await client.query<{ result: string }>(
      "SELECT result FROM governance.operator_audit_log WHERE idempotency_key = $1 ORDER BY id",
      [operation.idempotencyKey],
    );
    expect(events.rows.map((r) => r.result)).toEqual(["submitted", "accepted", "running", "completed"]);
  });

  it("never issues a real network call or mutation — result is fully synthetic", async () => {
    const { operation } = await certifySyntheticManagementOperation(ledger, baseRequest());
    expect((operation.result as { accepted: boolean }).accepted).toBe(true);
    expect((operation.afterStateSafeSnapshot as { data: { realMutationPerformed: boolean } }).data.realMutationPerformed).toBe(
      false,
    );
  });

  it("is traceable: operator, session, and correlation id survive from request to final operation", async () => {
    const { operation } = await certifySyntheticManagementOperation(ledger, baseRequest());
    expect(operation.operatorId).toBe(OPERATOR_ID);
    expect(operation.operatorSessionId).toBe(SESSION_ID);
    expect(operation.correlationId).toBeDefined();
  });

  it("is idempotent: replaying the same synthetic request returns the same completed operation without re-running the lifecycle", async () => {
    const first = await certifySyntheticManagementOperation(ledger, baseRequest());
    const second = await certifySyntheticManagementOperation(ledger, baseRequest());

    expect(second.replay).toBe(true);
    expect(second.operation.operationId).toBe(first.operation.operationId);
    expect(second.operation.status).toBe("completed");

    const events = await client.query("SELECT * FROM governance.operator_audit_log WHERE idempotency_key = $1", [
      first.operation.idempotencyKey,
    ]);
    expect(events.rows).toHaveLength(4); // submitted/accepted/running/completed — not duplicated by the replay
  });

  it("a duplicate key with a different payload is rejected before any lifecycle event is recorded", async () => {
    await certifySyntheticManagementOperation(ledger, baseRequest());
    await expect(
      certifySyntheticManagementOperation(ledger, baseRequest({ payload: { desiredState: "disabled" } })),
    ).rejects.toThrow();

    const events = await client.query("SELECT * FROM governance.operator_audit_log");
    expect(events.rows).toHaveLength(4); // only the first request's events
  });
});
