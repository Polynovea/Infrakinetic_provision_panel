import type { AuditEvent, AuditSink } from "../auditSink.js";

// 1A.2 interim implementation — structured console output only. Not an
// immutable ledger; do not treat this as satisfying §19's audit
// requirements on its own. 1A.5 replaces this with a durable, queryable,
// append-only sink behind the same AuditSink interface.
export class ConsoleAuditSink implements AuditSink {
  record(event: AuditEvent): void {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ audit: true, ...event }));
  }
}
