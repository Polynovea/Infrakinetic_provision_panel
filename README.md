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

**1A.2 — Privileged operator identity.** Application-side identity/session/role/scope model, `requireManagementApiAuth` + `authorize.ts` authorization middleware, Cognito JWT verification boundary (env-configured, no hardcoded AWS identifiers), and the operator-identity persistence schema are built and locally verified (37/37 tests). The dedicated Cognito pool itself is **not provisioned** — pending separate AWS authorization. See `docs/1A.2_status.md` for exact evidence, the scope decision recorded this subphase, and exactly what AWS resources are needed to finish live 1A.2.
