import type { AuditEvent, AuditSink } from "../auditSink.js";

/** Test-only sink that retains events so assertions can inspect them. */
export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  record(event: AuditEvent): void {
    this.events.push(event);
  }
}
