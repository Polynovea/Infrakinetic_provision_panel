import { beforeEach, describe, expect, it } from "vitest";

import { buildMigratedPgMemClient } from "../helpers/pgMemDb.js";
import { PostgresAuditSink } from "../../src/identity/adapters/postgresAuditSink.js";
import { InMemoryAuditSink } from "../../src/identity/adapters/inMemoryAuditSink.js";
import type { DbClient } from "../../src/db/dbClient.js";

// Audit remediation M6 — auth/authz decisions must land in the durable
// governance.operator_auth_audit_log, not only on stdout.

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("PostgresAuditSink", () => {
  let client: DbClient;
  let mirror: InMemoryAuditSink;
  let sink: PostgresAuditSink;

  beforeEach(async () => {
    client = buildMigratedPgMemClient().client;
    await client.query(
      `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
       VALUES ($1, 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())`,
      [OPERATOR_ID],
    );
    mirror = new InMemoryAuditSink();
    sink = new PostgresAuditSink(client, mirror);
  });

  async function rows() {
    return (await client.query<Record<string, unknown>>("SELECT * FROM governance.operator_auth_audit_log ORDER BY id")).rows;
  }

  it("persists the event durably AND mirrors it (stdout in production)", async () => {
    await sink.record({
      eventType: "auth.success", occurredAt: "2026-09-25T00:00:00.000Z", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      reasonCode: "OK", route: "/auth/callback", method: "GET", detail: { selfActivatedPendingMfa: false },
    });

    const persisted = await rows();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ event_type: "auth.success", operator_id: OPERATOR_ID, operator_session_id: SESSION_ID, reason_code: "OK" });
    expect(mirror.events).toHaveLength(1);
  });

  it("an operator id not in the directory (denied, unprovisioned subject) is kept in detail instead of losing the event", async () => {
    await sink.record({ eventType: "auth.failure", occurredAt: "2026-09-25T00:00:00.000Z", operatorId: "99999999-9999-4999-8999-999999999999", reasonCode: "OPERATOR_NOT_PROVISIONED" });

    const persisted = await rows();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].operator_id).toBeNull();
    const detail = typeof persisted[0].detail === "string" ? JSON.parse(persisted[0].detail as string) : persisted[0].detail;
    expect(detail).toMatchObject({ rawOperatorId: "99999999-9999-4999-8999-999999999999" });
  });

  it("non-UUID session/correlation values move to detail rather than failing the UUID columns", async () => {
    await sink.record({ eventType: "authz.denied", occurredAt: "2026-09-25T00:00:00.000Z", operatorSessionId: "not-a-uuid", correlationId: "req-123" });

    const persisted = await rows();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].operator_session_id).toBeNull();
    expect(persisted[0].correlation_id).toBeNull();
    const detail = typeof persisted[0].detail === "string" ? JSON.parse(persisted[0].detail as string) : persisted[0].detail;
    expect(detail).toMatchObject({ rawOperatorSessionId: "not-a-uuid", rawCorrelationId: "req-123" });
  });

  it("a database failure never fails the audited request — the event still reaches the mirror", async () => {
    const broken = new PostgresAuditSink(
      { query: async () => { throw new Error("db down"); }, transaction: async () => { throw new Error("db down"); } } as unknown as DbClient,
      mirror,
    );
    await expect(broken.record({ eventType: "auth.failure", occurredAt: "2026-09-25T00:00:00.000Z", reasonCode: "X" })).resolves.toBeUndefined();
    expect(mirror.events).toHaveLength(1);
  });
});
