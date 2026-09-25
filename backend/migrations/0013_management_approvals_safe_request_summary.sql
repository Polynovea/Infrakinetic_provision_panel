-- Audit remediation H1 (PlatformRectification/Phase1A.1-1A.13_Independent_
-- Audit_2026-09-25.md) — master plan §58: "checker reviews safe diff".
--
-- Until now an R3 credential-rotate approval bound only {action, tenant,
-- credential}; the secret kind, overlap window, webhook endpoint and the new
-- material itself were all chosen by whoever executed, so a checker approved
-- "a rotation happens", never "these keys". The approval hash now also binds
-- those parameters plus a salted, deliberately slow (scrypt) digest of the
-- material — never the material itself — and this column carries the
-- checker-visible safe diff: secret kind, overlap hours, endpoint id, a
-- masked hint of the (non-secret) provider key id, and a short material
-- fingerprint. It never holds secret material.
--
-- Nullable: identity R3 and credential revoke approvals have no parameters
-- beyond the target; rotate approvals created before this migration have no
-- summary and fail closed at execute (a fresh request is required).

ALTER TABLE governance.management_approvals
  ADD COLUMN safe_request_summary JSONB;

COMMENT ON COLUMN governance.management_approvals.safe_request_summary IS
  'Checker-visible safe diff of the approved request (kinds, windows, masked hints, material fingerprint). Never secret material.';

-- Rollback (manual, before any deployment depends on it):
-- ALTER TABLE governance.management_approvals DROP COLUMN safe_request_summary;
