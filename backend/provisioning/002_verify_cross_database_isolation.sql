\set ON_ERROR_STOP on

-- 1A.3 — READ-ONLY effective-privilege certification for governance_app
-- against the EXISTING Infrakinetic database.
--
-- Run as the RDS admin/master identity while connected to polynoveacrm AFTER
-- 001 has created governance_app. This script changes no ACL and no data; it
-- only inspects catalog/effective-privilege state and raises if the isolation
-- gate is not satisfied.
--
-- Example:
--   psql -h 127.0.0.1 -p 5433 -U <admin> -d polynoveacrm \
--     -f backend/provisioning/002_verify_cross_database_isolation.sql

SELECT current_database() AS inspected_database;

-- Inventory every login role that can currently connect. If the isolation
-- gate fails because PUBLIC still grants CONNECT, this output is the evidence
-- needed to build a reviewed explicit allow-list before changing PUBLIC.
SELECT r.rolname,
       has_database_privilege(r.rolname, current_database(), 'CONNECT') AS can_connect
FROM pg_roles r
WHERE r.rolcanlogin
ORDER BY r.rolname;

-- governance_app must remain a non-admin role with no inherited role
-- memberships that could silently widen its authority.
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit
FROM pg_roles
WHERE rolname = 'governance_app';

SELECT parent.rolname AS inherited_role
FROM pg_auth_members m
JOIN pg_roles child  ON child.oid = m.member
JOIN pg_roles parent ON parent.oid = m.roleid
WHERE child.rolname = 'governance_app'
ORDER BY parent.rolname;

-- Diagnostic object-level effective privilege counts. These remain useful
-- even after CONNECT is denied, because they expose future drift if somebody
-- later re-grants database connectivity.
SELECT count(*) AS tables_with_effective_dml
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND (
    has_table_privilege('governance_app', c.oid, 'SELECT') OR
    has_table_privilege('governance_app', c.oid, 'INSERT') OR
    has_table_privilege('governance_app', c.oid, 'UPDATE') OR
    has_table_privilege('governance_app', c.oid, 'DELETE') OR
    has_table_privilege('governance_app', c.oid, 'TRUNCATE') OR
    has_table_privilege('governance_app', c.oid, 'REFERENCES') OR
    has_table_privilege('governance_app', c.oid, 'TRIGGER')
  );

SELECT count(*) AS executable_security_definer_functions
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND p.prosecdef
  AND has_function_privilege('governance_app', p.oid, 'EXECUTE');

-- Hard gate. A direct per-role REVOKE cannot override PUBLIC CONNECT, so this
-- checks the *effective* privilege PostgreSQL will actually use.
DO $$
DECLARE
  v_can_connect boolean;
  v_super boolean;
  v_createdb boolean;
  v_createrole boolean;
  v_bypassrls boolean;
  v_memberships integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'governance_app') THEN
    RAISE EXCEPTION '1A.3 isolation FAIL: governance_app role does not exist';
  END IF;

  SELECT has_database_privilege('governance_app', current_database(), 'CONNECT')
    INTO v_can_connect;

  SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
    INTO v_super, v_createdb, v_createrole, v_bypassrls
  FROM pg_roles
  WHERE rolname = 'governance_app';

  SELECT count(*)
    INTO v_memberships
  FROM pg_auth_members m
  JOIN pg_roles child ON child.oid = m.member
  WHERE child.rolname = 'governance_app';

  IF v_can_connect THEN
    RAISE EXCEPTION
      '1A.3 isolation FAIL: governance_app can effectively CONNECT to %. A direct REVOKE FROM governance_app is insufficient when PUBLIC has CONNECT. Inventory legitimate roles, revoke CONNECT from PUBLIC, explicitly re-grant legitimate roles, then rerun this verifier.',
      current_database();
  END IF;

  IF v_super OR v_createdb OR v_createrole OR v_bypassrls THEN
    RAISE EXCEPTION
      '1A.3 isolation FAIL: governance_app has an administrative role attribute (super=%, createdb=%, createrole=%, bypassrls=%)',
      v_super, v_createdb, v_createrole, v_bypassrls;
  END IF;

  IF v_memberships <> 0 THEN
    RAISE EXCEPTION
      '1A.3 isolation FAIL: governance_app inherits/member-of % role(s); expected zero',
      v_memberships;
  END IF;

  RAISE NOTICE '1A.3 cross-database isolation PASS: governance_app cannot CONNECT to %, has no admin attributes, and has no role memberships.', current_database();
END
$$;
