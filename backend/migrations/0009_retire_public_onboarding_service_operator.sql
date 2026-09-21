-- Phase 1A.11 architecture correction — retire the temporary public-onboarding
-- system identity introduced by 0007.
--
-- InfraKinetic is operator-commissioned B2B enterprise software. The temporary
-- public self-service signup boundary has been removed from both Governance and
-- Infrakinetic, so its reserved system operator must not remain active merely
-- because the historical migration that created it is immutable.
--
-- This is intentionally additive migration history: do not rewrite 0007 after
-- it may have been applied. If the row is already disabled/revoked, leave that
-- stronger/equivalent state untouched. Defensive role/scope cleanup is included
-- even though 0007 did not grant any rows there.

BEGIN;

DELETE FROM governance.operator_scopes
WHERE operator_id = '00000000-0000-0000-0000-0000000000f0';

DELETE FROM governance.operator_roles
WHERE operator_id = '00000000-0000-0000-0000-0000000000f0';

UPDATE governance.operators
SET status = 'disabled',
    disabled_at = COALESCE(disabled_at, now()),
    disabled_reason = COALESCE(disabled_reason, 'Retired Phase 1A.11 public-onboarding service identity'),
    updated_at = now()
WHERE operator_id = '00000000-0000-0000-0000-0000000000f0'
  AND cognito_sub = 'system:public-onboarding-service'
  AND status = 'active';

COMMIT;
