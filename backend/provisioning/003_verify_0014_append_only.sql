\set ON_ERROR_STOP on

-- Audit remediation M6 — certification for migration 0014
-- (append-only enforcement). pg-mem cannot execute PL/pgSQL, so 0014's
-- triggers are proven here, against the real Governance Postgres, after the
-- migration has been applied.
--
-- Everything runs inside ONE transaction that is ROLLED BACK at the end: no
-- audit row, operation or operator written here survives. Each check uses a
-- SAVEPOINT so an expected rejection does not abort the transaction, and
-- RAISEs (stopping the script, ON_ERROR_STOP) if a mutation that must be
-- rejected was allowed.
--
-- Run as governance_app (the application role — the point is that even the
-- schema owner's DML is rejected):
--   psql -h <host> -U governance_app -d <governance db> \
--     -f backend/provisioning/003_verify_0014_append_only.sql

BEGIN;

DO $$
DECLARE
  op_id uuid := gen_random_uuid();
  operator uuid := gen_random_uuid();
  rejected boolean;
BEGIN
  INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
  VALUES (operator, 'verify-0014-' || operator, 'verify-0014-' || operator || '@example.invalid', 'verify 0014', 'active', true, now(), now());

  INSERT INTO governance.operator_auth_audit_log (occurred_at, event_type, reason_code) VALUES (now(), 'auth.failure', 'VERIFY_0014');
  INSERT INTO governance.operator_audit_log (occurred_at, action, result) VALUES (now(), 'verify.0014', 'submitted');

  -- 1. operator_auth_audit_log rejects UPDATE and DELETE.
  BEGIN
    UPDATE governance.operator_auth_audit_log SET reason_code = 'TAMPERED' WHERE reason_code = 'VERIFY_0014';
    rejected := false;
  EXCEPTION WHEN insufficient_privilege THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: operator_auth_audit_log accepted an UPDATE'; END IF;

  BEGIN
    DELETE FROM governance.operator_auth_audit_log WHERE reason_code = 'VERIFY_0014';
    rejected := false;
  EXCEPTION WHEN insufficient_privilege THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: operator_auth_audit_log accepted a DELETE'; END IF;

  -- 2. operator_audit_log rejects UPDATE and DELETE.
  BEGIN
    UPDATE governance.operator_audit_log SET result = 'completed' WHERE action = 'verify.0014';
    rejected := false;
  EXCEPTION WHEN insufficient_privilege THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: operator_audit_log accepted an UPDATE'; END IF;

  BEGIN
    DELETE FROM governance.operator_audit_log WHERE action = 'verify.0014';
    rejected := false;
  EXCEPTION WHEN insufficient_privilege THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: operator_audit_log accepted a DELETE'; END IF;

  -- 3. management_operations: lifecycle UPDATEs still work...
  INSERT INTO governance.management_idempotency_keys (idempotency_key, requested_action, operator_id, request_hash, status, created_at)
  VALUES ('verify-0014-' || op_id, 'verify.0014', operator, 'hash', 'in_progress', now());
  INSERT INTO governance.management_operations
    (operation_id, idempotency_key, operator_id, requested_action, target_resource_type, target_resource_id,
     risk_class, safe_payload_hash, contract_version, correlation_id, requested_at, status, created_at, updated_at)
  VALUES (op_id, 'verify-0014-' || op_id, operator, 'verify.0014', 'verify', 'verify', 'R1', 'hash', 'v1',
          gen_random_uuid(), now(), 'submitted', now(), now());
  UPDATE governance.management_operations SET status = 'accepted', accepted_at = now() WHERE operation_id = op_id;
  UPDATE governance.management_operations SET status = 'running' WHERE operation_id = op_id;
  UPDATE governance.management_operations SET status = 'completed', completed_at = now(), result = '{"ok":true}' WHERE operation_id = op_id;

  -- ...a first rollback reference may be attached to a terminal op...
  UPDATE governance.management_operations SET rollback_reference = '{"recoveryOperationId":"x"}' WHERE operation_id = op_id;

  -- ...but attribution never changes,
  BEGIN
    UPDATE governance.management_operations SET operator_id = NULL WHERE operation_id = op_id;
    rejected := false;
  EXCEPTION WHEN insufficient_privilege THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: management_operations allowed an attribution change'; END IF;

  -- a terminal op's outcome is frozen,
  BEGIN
    UPDATE governance.management_operations SET result = '{"ok":false}' WHERE operation_id = op_id;
    rejected := false;
  EXCEPTION WHEN insufficient_privilege THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: management_operations allowed a terminal result change'; END IF;

  -- the rollback reference is set-once,
  BEGIN
    UPDATE governance.management_operations SET rollback_reference = '{"recoveryOperationId":"y"}' WHERE operation_id = op_id;
    rejected := false;
  EXCEPTION WHEN insufficient_privilege THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: management_operations allowed a second rollback reference'; END IF;

  -- and rows can never be deleted.
  BEGIN
    DELETE FROM governance.management_operations WHERE operation_id = op_id;
    rejected := false;
  EXCEPTION WHEN insufficient_privilege THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: management_operations accepted a DELETE'; END IF;

  RAISE NOTICE 'PASS: migration 0014 append-only enforcement verified';
END;
$$;

ROLLBACK;
