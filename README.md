# PolyNovea Platform Governance & Provisioning

Root PolyNovea-operated governance, commissioning and platform-control application for Infrakinetic.

**Service identity:** `polynovea.platform-governance`
**Management contract family:** `platform-management.v1`
**Operator origin (planned):** `https://governance.infrakinetic.in`

Phase 1A of the Infrakinetic platform remediation programme. See:
`docs/Infrakinetic Document/Architecture Plan Docx/Engine Overhauls/Phase1A_Polynovea_Platform_Governance_Extended_Master_Plan_2026-09-10_v2.md`
and
`docs/Infrakinetic Document/Architecture Plan Docx/Engine Overhauls/PlatformRectification/Phase1A_Scoping_and_Implementation_Plan_2026-09-04.md`
in the Infrakinetic repository (`polynovea-platform-governance` is intentionally its own repository — those docs are not duplicated here yet; `/docs` in this repo holds this application's own operational documentation as it's written).

## What this application is

Platform Governance owns platform/operator **desired state**, tenant commissioning, commercial ceilings, privileged operator workflows, fleet policy and fleet reconciliation. It controls Infrakinetic through versioned management contracts — it is not a cross-tenant SQL console, and it does not perform domain writes (no journal lines, no invoice state, no employment records). Those remain owning-engine actions.

## Hard boundary rules

1. No filesystem-path imports from the Infrakinetic repository. Ever.
2. No shared database credentials with Infrakinetic's business database.
3. No shared `.env` file with Infrakinetic's `api-server`.
4. No shared writable application directories with Infrakinetic's deployment.
5. No tenant identity is ever accepted as a platform operator identity.
6. No management signing key may reach a browser or Vercel client bundle.
7. No raw secret value is ever retrievable through this application's UI or API after submission.
8. No direct cross-database mutation of Infrakinetic's business database (no `dblink`, no FDW).
9. No write to any Infrakinetic engine's private table. All cross-service calls go through the versioned management API only.
10. Independent release and rollback — this application's deploys never depend on, or block, an Infrakinetic deploy, and vice versa.

## Repository layout

```
/frontend   Next.js / TypeScript operator UI (deploys to Vercel)
/backend    Express / TypeScript management backend (deploys to EC2/PM2, co-located
            with polynovea-api initially as a fully isolated separate process)
/docs       This application's own operational documentation
```

## Status

**1A.1 — Repository and environment foundation.** Infrastructure-only. No database connection, no Cognito, no management API authentication, no calls to Infrakinetic's `api-server` of any kind. See `docs/1A.1_status.md`.

**1A.2 — Privileged operator identity.** Application-side identity/session/role/scope model, `requireManagementApiAuth` + `authorize.ts` authorization middleware, Cognito JWT verification boundary (env-configured, no hardcoded AWS identifiers), the operator-identity persistence schema, and an idempotent, audited operator-bootstrap CLI (`npm run bootstrap:operator`) are built and locally verified. Corrected finding (2026-09-11): this backend is designed to **reuse Infrakinetic's existing Cognito pool via a new, dedicated app client**, not stand up a second pool — see `docs/1A.2_status.md` "2026-09-11 follow-up" for the evidence and the one open question (pool-wide MFA posture) that needs live AWS access to close. Live Cognito integration and the real internal-Polynovea-tenant/operator bootstrap remain **pending**, explicitly sequenced at 1A.18.

**1A.3 — Governance DB.** A dedicated Postgres schema (`migrations/0001_operator_identity_schema.sql` + `0002_governance_db_foundation.sql`: base ledger/idempotency tables, plus a correction to 0001's session model), a lazily-configured DB connection layer, a migration runner (`npm run db:migrate`), and Postgres-backed `OperatorDirectory`/`OperatorSessionStore` adapters (replacing 1A.2's in-memory ones, per that subphase's own design) are built and locally verified (77/77 tests) against pg-mem. **No real Postgres database exists anywhere** — this session has neither AWS credentials nor a local Postgres/Docker install; the provisioning script (`backend/provisioning/001_create_role_and_database.sql`) is authored but has never been run. See `docs/1A.3_status.md`.
