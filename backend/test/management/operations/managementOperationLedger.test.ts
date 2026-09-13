import { beforeEach, describe, expect, it } from "vitest";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import {
  MissingIdempotencyKeyError,
  InvalidRiskClassError,
  MissingReasonError,
  IdempotencyConflictError,
  InvalidLifecycleTransitionError,
  OperationNotFoundError,
} from "../../../src/management/operations/managementOperationErrors.js";
import { buildSafeSnapshot } from "../../../src/management/operations/evidence.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { CreateManagementOperationParams } from "../../../src/management/operations/managementOperationLedger.js";

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CORRELATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function seedOperator(client: DbClient) {
  await client.query(
    `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
     VALUES ($1, 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())`,
    [OPERATOR_ID],
  );
}

function baseParams(overrides: Partial<CreateManagementOperationParams> = {}): CreateManagementOperationParams {
  return {
    idempotencyKey: "certify-key-1",
    operatorId: OPERATOR_ID,
    operatorSessionId: SESSION_ID,
    requestedAction: "platform.engine-state.set",
    targetTenantId: null,
    targetEngine: "module_ai",
    reason: "synthetic certification",
    riskClass: "R2",
    payload: { desiredState: "enabled" },
    contractVersion: "platform-management.operation.v1",
    correlationId: CORRELATION_ID,
    ...overrides,
  };
}

describe("management/operations/managementOperationLedger", () => {
  let client: DbClient;
  let ledger: ManagementOperationLedger;

  beforeEach(async () => {
    const built = buildMigratedPgMemClient();
    client = built.client;
    ledger = new ManagementOperationLedger(client);
    await seedOperator(client);
  });

  it("creates a new operation on first use of an idempotency key", async () => {
    const { operation, replay } = await ledger.createOrReplayOperation(baseParams());
    expect(replay).toBe(false);
    expect(operation.status).toBe("submitted");
    expect(operation.operationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("persists immutable attribution: operator, session, correlation, action, engine, contract version", async () => {
    const { operation } = await ledger.createOrReplayOperation(baseParams());
    expect(operation.operatorId).toBe(OPERATOR_ID);
    expect(operation.operatorSessionId).toBe(SESSION_ID);
    expect(operation.correlationId).toBe(CORRELATION_ID);
    expect(operation.requestedAction).toBe("platform.engine-state.set");
    expect(operation.targetEngine).toBe("module_ai");
    expect(operation.contractVersion).toBe("platform-management.operation.v1");
  });

  it("accepts every valid risk class", async () => {
    for (const [i, riskClass] of (["R0", "R1", "R2", "R3", "R4"] as const).entries()) {
      const reason = riskClass === "R0" || riskClass === "R1" ? undefined : "required for this risk class";
      const { operation } = await ledger.createOrReplayOperation(
        baseParams({ idempotencyKey: `risk-key-${i}`, riskClass, reason }),
      );
      expect(operation.riskClass).toBe(riskClass);
    }
  });

  it("rejects an invalid risk class", async () => {
    // @ts-expect-error deliberately invalid for the test
    await expect(ledger.createOrReplayOperation(baseParams({ riskClass: "R99" }))).rejects.toBeInstanceOf(
      InvalidRiskClassError,
    );
  });

  it("rejects R2 with no reason", async () => {
    await expect(
      ledger.createOrReplayOperation(baseParams({ reason: undefined })),
    ).rejects.toBeInstanceOf(MissingReasonError);
  });

  it("rejects R0 needing no reason with no reason (control case — must NOT throw)", async () => {
    await expect(
      ledger.createOrReplayOperation(baseParams({ riskClass: "R0", reason: undefined })),
    ).resolves.toBeDefined();
  });

  it("rejects a missing idempotency key", async () => {
    await expect(
      ledger.createOrReplayOperation(baseParams({ idempotencyKey: "" })),
    ).rejects.toBeInstanceOf(MissingIdempotencyKeyError);
  });

  it("same key + same payload returns the same durable operation (safe replay)", async () => {
    const first = await ledger.createOrReplayOperation(baseParams());
    const second = await ledger.createOrReplayOperation(baseParams());
    expect(second.replay).toBe(true);
    expect(second.operation.operationId).toBe(first.operation.operationId);

    const all = await client.query("SELECT * FROM governance.management_operations");
    expect(all.rows).toHaveLength(1);
  });

  it("same key + different payload is rejected as a conflict", async () => {
    await ledger.createOrReplayOperation(baseParams());
    await expect(
      ledger.createOrReplayOperation(baseParams({ payload: { desiredState: "disabled" } })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("same key + different requested_action (action mismatch) is rejected as a conflict", async () => {
    await ledger.createOrReplayOperation(baseParams());
    await expect(
      ledger.createOrReplayOperation(baseParams({ requestedAction: "platform.engine-state.disable-globally" })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("same key + different target (target mismatch) is rejected as a conflict", async () => {
    await ledger.createOrReplayOperation(baseParams());
    await expect(
      ledger.createOrReplayOperation(baseParams({ targetEngine: "module_billing" })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    await expect(
      ledger.createOrReplayOperation(
        baseParams({ targetTenantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("a conflicting request never creates a second operation row", async () => {
    await ledger.createOrReplayOperation(baseParams());
    await ledger
      .createOrReplayOperation(baseParams({ payload: { desiredState: "disabled" } }))
      .catch(() => undefined);

    const all = await client.query("SELECT * FROM governance.management_operations");
    expect(all.rows).toHaveLength(1);
  });

  it("concurrent identical requests collapse to exactly one durable operation", async () => {
    const [a, b] = await Promise.all([
      ledger.createOrReplayOperation(baseParams()),
      ledger.createOrReplayOperation(baseParams()),
    ]);
    expect(a.operation.operationId).toBe(b.operation.operationId);
    expect([a.replay, b.replay].sort()).toEqual([false, true]);

    const all = await client.query("SELECT * FROM governance.management_operations");
    expect(all.rows).toHaveLength(1);
  });

  it("durable result is retrievable by operation id and by idempotency key", async () => {
    const { operation } = await ledger.createOrReplayOperation(baseParams());
    const byId = await ledger.getOperation(operation.operationId);
    const byKey = await ledger.getByIdempotencyKey(operation.idempotencyKey);
    expect(byId.operationId).toBe(operation.operationId);
    expect(byKey?.operationId).toBe(operation.operationId);
  });

  it("throws OperationNotFoundError for an unknown operation id", async () => {
    await expect(ledger.getOperation("00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(
      OperationNotFoundError,
    );
  });

  it("survives 'process recreation' — a fresh service instance over the same store still sees prior state", async () => {
    const { operation } = await ledger.createOrReplayOperation(baseParams());
    const freshLedger = new ManagementOperationLedger(client); // simulates a new process, same DB
    const replay = await freshLedger.createOrReplayOperation(baseParams());
    expect(replay.replay).toBe(true);
    expect(replay.operation.operationId).toBe(operation.operationId);
  });

  describe("lifecycle transitions", () => {
    it("walks submitted -> accepted -> running -> completed", async () => {
      const { operation } = await ledger.createOrReplayOperation(baseParams());
      const accepted = await ledger.transitionOperation(operation.operationId, { toStatus: "accepted" });
      expect(accepted.status).toBe("accepted");
      expect(accepted.acceptedAt).toBeDefined();

      const running = await ledger.transitionOperation(operation.operationId, { toStatus: "running" });
      expect(running.status).toBe("running");

      const completed = await ledger.transitionOperation(operation.operationId, {
        toStatus: "completed",
        result: { synthetic: true },
      });
      expect(completed.status).toBe("completed");
      expect(completed.completedAt).toBeDefined();
      expect(completed.result).toEqual({ synthetic: true });

      const keyRow = await client.query<{ status: string }>(
        "SELECT status FROM governance.management_idempotency_keys WHERE idempotency_key = $1",
        [operation.idempotencyKey],
      );
      expect(keyRow.rows[0]?.status).toBe("completed");
    });

    it("persists a partial-failure result on partially_completed", async () => {
      const { operation } = await ledger.createOrReplayOperation(baseParams());
      await ledger.transitionOperation(operation.operationId, { toStatus: "accepted" });
      await ledger.transitionOperation(operation.operationId, { toStatus: "running" });
      const partial = await ledger.transitionOperation(operation.operationId, {
        toStatus: "partially_completed",
        partialFailureState: { failedSteps: ["step-2"], succeededSteps: ["step-1"] },
      });
      expect(partial.status).toBe("partially_completed");
      expect(partial.partialFailureState).toEqual({ failedSteps: ["step-2"], succeededSteps: ["step-1"] });

      const reread = await ledger.getOperation(operation.operationId);
      expect(reread.partialFailureState).toEqual({ failedSteps: ["step-2"], succeededSteps: ["step-1"] });
    });

    it("rejects an invalid transition (submitted -> completed, skipping accepted/running)", async () => {
      const { operation } = await ledger.createOrReplayOperation(baseParams());
      await expect(
        ledger.transitionOperation(operation.operationId, { toStatus: "completed" }),
      ).rejects.toBeInstanceOf(InvalidLifecycleTransitionError);
    });

    it("rejects any transition out of a terminal state", async () => {
      const { operation } = await ledger.createOrReplayOperation(baseParams());
      await ledger.transitionOperation(operation.operationId, { toStatus: "accepted" });
      await ledger.transitionOperation(operation.operationId, { toStatus: "running" });
      await ledger.transitionOperation(operation.operationId, { toStatus: "failed" });
      await expect(
        ledger.transitionOperation(operation.operationId, { toStatus: "completed" }),
      ).rejects.toBeInstanceOf(InvalidLifecycleTransitionError);
    });
  });

  describe("rollback reference", () => {
    it("can be attached to an existing operation", async () => {
      const { operation } = await ledger.createOrReplayOperation(baseParams());
      const updated = await ledger.attachRollbackReference(operation.operationId, {
        type: "compensating-command",
        commandId: "cccccccc-0000-4000-8000-000000000000",
      });
      expect(updated.rollbackReference).toEqual({
        type: "compensating-command",
        commandId: "cccccccc-0000-4000-8000-000000000000",
      });
    });
  });

  describe("safe evidence redaction", () => {
    it("redacts secret-shaped fields out of approval evidence before it is stored", async () => {
      const { operation } = await ledger.createOrReplayOperation(
        baseParams({
          approvalEvidence: { approverId: "op-2", note: "looks fine", apiKey: "sk_live_should_not_persist" },
        }),
      );
      expect(JSON.stringify(operation.approvalEvidence)).not.toContain("sk_live_should_not_persist");
      expect((operation.approvalEvidence as Record<string, unknown>).apiKey).toBe("[redacted]");
      expect((operation.approvalEvidence as Record<string, unknown>).note).toBe("looks fine");
    });

    it("redacts secret-shaped fields out of before/after snapshots", async () => {
      const { operation } = await ledger.createOrReplayOperation(baseParams());
      await ledger.transitionOperation(operation.operationId, { toStatus: "accepted" });
      const running = await ledger.transitionOperation(operation.operationId, {
        toStatus: "running",
        beforeStateSafeSnapshot: buildSafeSnapshot({ quota: 10, providerSecret: "should-not-survive" }),
      });
      const raw = JSON.stringify(running.beforeStateSafeSnapshot);
      expect(raw).not.toContain("should-not-survive");
      expect(raw).toContain("[redacted]");
      expect((running.beforeStateSafeSnapshot as { version: string }).version).toBe("1A.5-evidence.v1");
    });
  });

  describe("ledger immutability (application-service surface)", () => {
    it("exposes no update/delete method for audit-log rows", () => {
      const proto = Object.getPrototypeOf(ledger) as Record<string, unknown>;
      const methodNames = Object.getOwnPropertyNames(proto);
      const forbidden = methodNames.filter((name) => /update.*audit|delete.*audit|remove.*audit/i.test(name));
      expect(forbidden).toEqual([]);
    });

    it("each lifecycle transition appends a new immutable ledger row rather than mutating a prior one", async () => {
      const { operation } = await ledger.createOrReplayOperation(baseParams());
      await ledger.transitionOperation(operation.operationId, { toStatus: "accepted" });
      await ledger.transitionOperation(operation.operationId, { toStatus: "running" });
      await ledger.transitionOperation(operation.operationId, { toStatus: "completed", result: { ok: true } });

      const events = await client.query<{ result: string }>(
        "SELECT result FROM governance.operator_audit_log WHERE idempotency_key = $1 ORDER BY id",
        [operation.idempotencyKey],
      );
      expect(events.rows.map((r) => r.result)).toEqual(["submitted", "accepted", "running", "completed"]);
    });
  });
});
