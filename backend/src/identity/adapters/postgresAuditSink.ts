import type { DbClient } from "../../db/dbClient.js";
import type { AuditEvent, AuditSink } from "../auditSink.js";

// Audit remediation M6 (PlatformRectification/Phase1A.1-1A.13_Independent_
// Audit_2026-09-25.md) — the durable auth/authz audit sink the 1A.2 console
// sink's own header promised. Until now every login success/failure, authz
// denial, step-up, logout and operator self-activation went only to PM2
// stdout, and governance.operator_auth_audit_log (migration 0001) was
// created but never written. Master plan §19: "Application logs do not
// replace this ledger."
//
// Behaviour:
//   - every event is inserted into governance.operator_auth_audit_log
//     (append-only at the database level from migration 0014);
//   - every event is ALSO mirrored to the fallback sink (stdout), so log
//     shipping keeps working and nothing is lost if the insert fails;
//   - an insert failure never fails the request being audited — it is
//     reported on stderr with the event, not thrown. Auth decisions are
//     made before auditing; refusing a login because the audit table is
//     briefly unavailable would turn an audit outage into an auth outage.
//
// The table types operator_session_id/correlation_id as UUID and
// operator_id as an FK onto governance.operators. Values that do not fit
// (a non-UUID correlation header, an operator id that is not in the
// directory) are moved into `detail` rather than failing the insert.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrUndefined(value: string | undefined): string | undefined {
  return value && UUID_PATTERN.test(value) ? value : undefined;
}

export class PostgresAuditSink implements AuditSink {
  constructor(
    private readonly db: DbClient,
    private readonly mirror: AuditSink,
  ) {}

  async record(event: AuditEvent): Promise<void> {
    try {
      await this.mirror.record(event);
    } catch {
      // The mirror is best-effort; the durable insert below is what matters.
    }

    const operatorSessionId = uuidOrUndefined(event.operatorSessionId);
    const correlationId = uuidOrUndefined(event.correlationId);
    const overflow: Record<string, unknown> = {};
    if (event.operatorSessionId && !operatorSessionId) overflow.rawOperatorSessionId = event.operatorSessionId;
    if (event.correlationId && !correlationId) overflow.rawCorrelationId = event.correlationId;
    const detail = { ...(event.detail ?? {}), ...overflow };

    const insert = (operatorId: string | undefined, extraDetail: Record<string, unknown>) =>
      this.db.query(
        `INSERT INTO governance.operator_auth_audit_log
           (occurred_at, event_type, operator_id, operator_session_id, reason_code, route, method, correlation_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          event.occurredAt,
          event.eventType,
          operatorId ?? null,
          operatorSessionId ?? null,
          event.reasonCode ?? null,
          event.route ?? null,
          event.method ?? null,
          correlationId ?? null,
          Object.keys({ ...detail, ...extraDetail }).length > 0 ? JSON.stringify({ ...detail, ...extraDetail }) : null,
        ],
      );

    try {
      await insert(uuidOrUndefined(event.operatorId), event.operatorId && !uuidOrUndefined(event.operatorId) ? { rawOperatorId: event.operatorId } : {});
    } catch (firstErr) {
      // Most likely the operator_id FK (an id not in the directory, e.g. a
      // denied, unprovisioned subject). Keep the event, move the id aside.
      try {
        if (!event.operatorId) throw firstErr;
        await insert(undefined, { rawOperatorId: event.operatorId });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ auditPersistFailed: true, error: err instanceof Error ? err.message : String(err), event }));
      }
    }
  }
}
