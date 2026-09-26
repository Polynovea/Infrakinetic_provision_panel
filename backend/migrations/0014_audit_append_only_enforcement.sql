-- Audit remediation M6 (PlatformRectification/Phase1A.1-1A.13_Independent_
-- Audit_2026-09-25.md) — database-level append-only enforcement.
--
-- 0001/0002 made operator_auth_audit_log and operator_audit_log append-only
-- "by convention" and explicitly deferred database enforcement. Because
-- governance_app OWNS the governance schema (provisioning/001), a REVOKE on
-- its own tables is not a real control — the owner can simply re-grant. A
-- trigger is: removing it takes deliberate, reviewable DDL (a migration),
-- not a stray UPDATE/DELETE from application code or a hijacked app role
-- running DML. Master plan §19: "Immutable provisioning ledger ...
-- Application logs do not replace this ledger."
--
-- governance.management_operations cannot be fully immutable — the ledger
-- advances an operation through its lifecycle with UPDATEs — so it gets a
-- narrower guard:
--   - DELETE and TRUNCATE are rejected outright;
--   - identity/attribution columns can never change after insert;
--   - a terminal ('completed'/'failed') operation is frozen, except that a
--     rollback/reversal reference may be attached ONCE (engine-state recovery
--     attaches it to the completed original operation — §19's "rollback/
--     reversal reference").
-- governance.management_idempotency_keys is deliberately NOT guarded: an
-- unused reservation is released on insert failure (managementOperation
-- Ledger.ts, M5), and it is a uniqueness guard, not history.
--
-- pg-mem cannot execute PL/pgSQL, so this migration is a pg-mem fidelity gap
-- (like 0008/0010) and must be certified against real Postgres; see
-- scripts/sql/verify_0014_append_only.sql.

CREATE OR REPLACE FUNCTION governance.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'governance.% is append-only: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER operator_auth_audit_log_append_only
  BEFORE UPDATE OR DELETE ON governance.operator_auth_audit_log
  FOR EACH ROW EXECUTE FUNCTION governance.reject_append_only_mutation();

CREATE TRIGGER operator_auth_audit_log_no_truncate
  BEFORE TRUNCATE ON governance.operator_auth_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION governance.reject_append_only_mutation();

CREATE TRIGGER operator_audit_log_append_only
  BEFORE UPDATE OR DELETE ON governance.operator_audit_log
  FOR EACH ROW EXECUTE FUNCTION governance.reject_append_only_mutation();

CREATE TRIGGER operator_audit_log_no_truncate
  BEFORE TRUNCATE ON governance.operator_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION governance.reject_append_only_mutation();

CREATE OR REPLACE FUNCTION governance.guard_management_operation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.operation_id          IS DISTINCT FROM OLD.operation_id
  OR NEW.idempotency_key       IS DISTINCT FROM OLD.idempotency_key
  OR NEW.operator_id           IS DISTINCT FROM OLD.operator_id
  OR NEW.operator_session_id   IS DISTINCT FROM OLD.operator_session_id
  OR NEW.requested_action      IS DISTINCT FROM OLD.requested_action
  OR NEW.target_tenant_id      IS DISTINCT FROM OLD.target_tenant_id
  OR NEW.target_engine         IS DISTINCT FROM OLD.target_engine
  OR NEW.target_resource_type  IS DISTINCT FROM OLD.target_resource_type
  OR NEW.target_resource_id    IS DISTINCT FROM OLD.target_resource_id
  OR NEW.reason                IS DISTINCT FROM OLD.reason
  OR NEW.risk_class            IS DISTINCT FROM OLD.risk_class
  OR NEW.approval_evidence::text IS DISTINCT FROM OLD.approval_evidence::text
  OR NEW.safe_payload_hash     IS DISTINCT FROM OLD.safe_payload_hash
  OR NEW.contract_version      IS DISTINCT FROM OLD.contract_version
  OR NEW.correlation_id        IS DISTINCT FROM OLD.correlation_id
  OR NEW.causation_id          IS DISTINCT FROM OLD.causation_id
  OR NEW.requested_at          IS DISTINCT FROM OLD.requested_at
  OR NEW.created_at            IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'governance.management_operations %: identity/attribution columns are immutable', OLD.operation_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status IN ('completed', 'failed') THEN
    IF NEW.status                          IS DISTINCT FROM OLD.status
    OR NEW.accepted_at                     IS DISTINCT FROM OLD.accepted_at
    OR NEW.completed_at                    IS DISTINCT FROM OLD.completed_at
    OR NEW.failed_at                       IS DISTINCT FROM OLD.failed_at
    OR NEW.before_state_safe_snapshot::text IS DISTINCT FROM OLD.before_state_safe_snapshot::text
    OR NEW.after_state_safe_snapshot::text  IS DISTINCT FROM OLD.after_state_safe_snapshot::text
    OR NEW.result::text                    IS DISTINCT FROM OLD.result::text
    OR NEW.partial_failure_state::text     IS DISTINCT FROM OLD.partial_failure_state::text
    OR (OLD.rollback_reference IS NOT NULL AND NEW.rollback_reference::text IS DISTINCT FROM OLD.rollback_reference::text)
    THEN
      RAISE EXCEPTION 'governance.management_operations %: terminal operation is immutable (only a first rollback reference may be attached)', OLD.operation_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER management_operations_guard_update
  BEFORE UPDATE ON governance.management_operations
  FOR EACH ROW EXECUTE FUNCTION governance.guard_management_operation_update();

CREATE TRIGGER management_operations_no_delete
  BEFORE DELETE ON governance.management_operations
  FOR EACH ROW EXECUTE FUNCTION governance.reject_append_only_mutation();

CREATE TRIGGER management_operations_no_truncate
  BEFORE TRUNCATE ON governance.management_operations
  FOR EACH STATEMENT EXECUTE FUNCTION governance.reject_append_only_mutation();

-- Rollback (manual; requires a deliberate migration, which is the point):
-- DROP TRIGGER management_operations_no_truncate ON governance.management_operations;
-- DROP TRIGGER management_operations_no_delete ON governance.management_operations;
-- DROP TRIGGER management_operations_guard_update ON governance.management_operations;
-- DROP TRIGGER operator_audit_log_no_truncate ON governance.operator_audit_log;
-- DROP TRIGGER operator_audit_log_append_only ON governance.operator_audit_log;
-- DROP TRIGGER operator_auth_audit_log_no_truncate ON governance.operator_auth_audit_log;
-- DROP TRIGGER operator_auth_audit_log_append_only ON governance.operator_auth_audit_log;
-- DROP FUNCTION governance.guard_management_operation_update();
-- DROP FUNCTION governance.reject_append_only_mutation();
