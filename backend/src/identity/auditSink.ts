// Audit/provenance hook for the management-auth boundary. This is
// deliberately narrow: it records *authentication and authorization
// decisions* (who was let in, who was turned away, and why). The immutable,
// queryable operator ledger covering privileged *actions* (§19 of the
// master plan) is 1A.5's deliverable; this sink is the seam 1A.5 will
// replace with a durable, DB-backed implementation, and the shape of
// AuditEvent below is intentionally already superset-compatible with that
// ledger's columns.
export interface AuditEvent {
  eventType:
    | "auth.success"
    | "auth.failure"
    | "authz.denied"
    | "session.revoked"
    | "session.step_up_recorded";
  occurredAt: string;
  operatorId?: string;
  operatorSessionId?: string;
  reasonCode?: string;
  route?: string;
  method?: string;
  correlationId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  record(event: AuditEvent): void | Promise<void>;
}
