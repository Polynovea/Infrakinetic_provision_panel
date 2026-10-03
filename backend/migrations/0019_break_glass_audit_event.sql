ALTER TABLE governance.operator_auth_audit_log
  DROP CONSTRAINT IF EXISTS operator_auth_audit_log_event_type_check;

-- pg-mem names the original inline CHECK differently from PostgreSQL.
-- Dropping both names keeps local migration tests faithful without changing
-- production semantics (the second DROP is a no-op on PostgreSQL).
ALTER TABLE governance.operator_auth_audit_log
  DROP CONSTRAINT IF EXISTS operator_auth_audit_log_constraint_1;

ALTER TABLE governance.operator_auth_audit_log
  ADD CONSTRAINT operator_auth_audit_log_event_type_check
  CHECK (event_type IN (
    'auth.success', 'auth.failure', 'authz.denied',
    'session.revoked', 'session.step_up_recorded',
    'break_glass.used'
  ));
