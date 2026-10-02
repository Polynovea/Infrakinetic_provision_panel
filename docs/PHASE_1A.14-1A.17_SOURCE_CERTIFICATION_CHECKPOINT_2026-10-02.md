# Phase 1A.14–1A.17 Source Certification Checkpoint

**Date:** 2026-10-02  
**Branch:** `rectify/1a14-1a15-governance-product`  
**Repos:** Polynovea Platform Governance + Infrakinetic owner/API  
**Status:** **SOURCE-CERTIFIED / DEPLOYED-LIVE CERTIFICATION OPEN**

---

## 1. What this checkpoint means

This checkpoint deliberately separates three different states that must not be conflated:

1. **Implemented in source** — the code exists in the rectification branch.
2. **Source-certified** — type checks, production frontend build, contract/integration suites, migration tests and named 1A.16/1A.17 certification gates pass locally.
3. **Live-certified** — the exact branch has been deployed, its migrations have been applied, real cloud permissions/data sources have been observed, and maker-checker flows have been exercised by two distinct production operators.

Items 1 and 2 are complete for the work covered by this checkpoint. Item 3 is **not** being claimed from local tests.

---

## 2. Final source certification evidence

### Governance backend

- Full backend suite: **800/800 tests green across 78 test files**.
- Named 1A.16/1A.17 certification gate: **8/8 green** plus backend TypeScript typecheck.
- New certification tests prove:
  - infrastructure and FinOps assertions are bound to their exact global resource/action;
  - secret-shaped cloud fields are refused at the Governance boundary;
  - `connectionString`, access/shared/SAS key shapes are treated as secret-bearing fields;
  - Azure cost can remain explicitly `not_connected`/unknown rather than being reported as zero;
  - immutable FinOps allocation policy versions preserve unallocated/shared cost rather than silently assigning it.
- Governance migration runner/migration tests are green with additive migration **0018** allowing `ai.credentials.manage` in the persisted operator-scope constraint.

### Governance frontend

- `npm run typecheck`: green.
- `npm run build`: green.
- Next.js production build generated all product routes, including:
  - `/approvals`
  - `/finops`
  - `/infrastructure`
  - `/ai`
  - `/global-config`
  - `/payment-adapters`
  - `/reconciliation`
  - `/tenants`
  - `/engine-state`

### Infrakinetic owner/API

- Focused AI + infrastructure + FinOps owner regression set: **155/155 green across 6 files**.
- Named 1A.16/1A.17 certification gate: **6/6 green**.
- The local Redis `ECONNREFUSED 127.0.0.1:6379` messages in those tests are test-environment connection noise; the suites completed with zero failures.

---

## 3. Source-closed rectification findings

### 3.1 Governance no longer presents as an internal terminal

Primary product navigation is grouped by operator task instead of subsystem implementation names:

- Fleet
- Operations
- Advanced controls

Operator-facing naming now includes:

- **Tenant health** instead of Reconciliation as the primary label
- **Engine controls** instead of Platform
- **Payment extensions** instead of Payment adapters in the product UI
- **Configuration restore** instead of Global config
- **AI operations** instead of a raw AI subsystem page

Internal identifiers, risk classes, canonical keys and hashes remain available where they are useful as technical/audit evidence, but they are no longer the primary interaction language.

### 3.2 Central approvals inbox

A first-class `/approvals` route now provides a central pending/approved-not-executed inbox.

Page-local approval components remain where action-specific execution material is required, but empty local queues hide themselves so the product no longer appears to have multiple unrelated approval systems.

Maker-checker/self-approval semantics remain enforced by the backend; this is a presentation consolidation, not a security shortcut.

### 3.3 Tenant workspace is no longer a 480 px endless drawer

The tenant detail surface is now a wide responsive workspace with first-class tabs:

- Overview
- People
- AI
- Credentials & integrations
- Engines

People are shown in 25-row batches rather than forcing operators to scroll through an entire large tenant before reaching AI or engine controls.

The wide mode is limited to the tenant workspace; smaller drawers retain their existing size. Mobile remains full-width.

### 3.4 Overview/fleet status is based on platform access, not Billing status

Governance overview/fleet counts now use the platform access state for Governance operational status instead of conflating it with commercial/Billing state.

Tenant health surfaces stuck/stale/drift counts as operational attention signals instead of burying them in a repair page.

### 3.5 Tenant-health rows prefer human identity over UUID identity

Where the tenant directory is available, operator-facing tenant rows resolve to tenant name/slug first and retain the UUID only as secondary diagnostic evidence.

The same principle is now applied on AI quota/top-usage/metering/reconciliation views.

### 3.6 AI credential/runtime truth is explicit

The AI runtime credential inventory now distinguishes:

- provider policy state;
- credential readiness;
- runtime source;
- selected credential count;
- managed-pool readiness;
- individual credential source/state;
- per-credential 30-day requests/tokens/rate-limit evidence;
- last recorded success;
- shared-key overlap across workload pools.

OCR/runtime readiness is tied to whether its relevant credential pool is actually usable rather than merely whether the provider is policy-active.

### 3.7 Provider health no longer invents an uptime score

The AI page now labels the section **Provider attempt outcomes (7 days)** and reports:

- attempts;
- failure count and failure percentage;
- rate-limited count and percentage;
- a simple operational signal derived from recorded outcomes.

The UI explicitly states this is request-outcome telemetry, not a synthetic uptime/SLA score. Credential-level evidence remains visible in the runtime credential pools section.

### 3.8 Infrastructure is a product surface backed by live-safe owner inventory

The 1A.16 inventory path reports safe runtime facts for:

- AWS EC2
- RDS
- S3
- Lambda
- Cognito
- EventBridge Scheduler
- Azure Service Bus
- Stirling hosting/runtime metadata

Partial permissions are surfaced as `permission_denied` or unavailable states instead of being converted to empty/zero inventory.

Credential material is never returned; the Governance boundary now additionally refuses secret-shaped cloud response fields such as connection strings and access/SAS keys.

### 3.9 FinOps is now a real Governance surface

The 1A.17 path includes:

- AWS Cost Explorer source facts;
- AI estimated usage cost;
- provider reconciliation evidence;
- tenant-attributed vs unallocated/shared amounts;
- explicit Azure source state rather than fictional zero cost;
- immutable/versioned allocation policy support.

Shared/unallocated cost remains an explicit disposition until a policy says otherwise; it cannot silently disappear into tenant allocation.

### 3.10 Configuration restore now reflects actual owner capability

Only **Payment provider catalog** currently has a published owner runtime apply contract.

The product now reflects that truth:

- all seven configuration areas may be captured as protected snapshots/drift evidence;
- restore-plan authoring appears only where live apply is actually supported;
- package provenance/content hash/class keys are moved behind technical evidence;
- `Dry-run` is presented as **Preview changes**;
- restore history exposes **Verify current state** and **Prepare rollback plan** in operator language.

The signed-package, exact-diff, dry-run, fresh-step-up and maker-checker backend semantics remain intact.

### 3.11 Emergency and risk language is operational, not implementation jargon

Primary controls no longer ask operators to reason in `R3`/`R4` labels. They state the consequence directly: fresh sign-in, second-operator approval, platform-wide disable, recovery plan, etc.

Risk classes remain part of the ledger/audit/control model and test names; they are not removed from the underlying governance system.

---

## 4. New source assets in this rectification branch

### Governance

Key additions include:

- `backend/migrations/0017_finops_allocation_policies.sql`
- `backend/migrations/0018_ai_credentials_manage_scope.sql`
- `backend/src/management/operations/finOpsAllocationPolicy.ts`
- `backend/src/management/operations/platformFinOpsQuery.ts`
- `backend/src/management/operations/platformInfrastructureQuery.ts`
- `backend/test/management/operations/finOpsAllocationPolicy.test.ts`
- `backend/test/management/operations/platformOperationsQuery.test.ts`
- `backend/test/migrations/0018_ai_credentials_manage_scope.test.ts`
- `frontend/app/(product)/approvals/page.tsx`
- `frontend/app/(product)/finops/page.tsx`
- `frontend/app/(product)/infrastructure/page.tsx`
- `frontend/components/AiManagedCredentialActions.tsx`
- `frontend/components/FinOpsAllocationDialog.tsx`

Named source-certification command:

```text
backend: npm run certify:phase1a16-17
```

### Infrakinetic owner/API

Key additions include:

- `api-server/migrations/381_ai_managed_provider_credentials.sql`
- `api-server/rds-only-migrations/163_rls_ai_managed_provider_credentials.sql`
- `api-server/src/ai/aiManagedCredentials.js`
- `api-server/src/lib/platformInfrastructureInventory.js`
- `api-server/src/lib/platformFinOps.js`
- `api-server/src/lib/__tests__/platformInfrastructureInventory.test.js`
- `api-server/src/lib/__tests__/platformFinOps.test.js`
- `api-server/src/routes/management/v1/__tests__/platformOperationsRoutes.test.js`

Named source-certification command:

```text
api-server: npm run certify:phase1a16-17
```

---

## 5. Read-only production ground truth captured at this checkpoint

This is observation only. No production mutation was performed while writing this checkpoint.

### PM2

Production currently reports:

- `polynovea-api` — 2 cluster workers, online;
- `polynovea-governance-api` — 1 fork worker, online.

This proves the existing production services are up. It does **not** prove the rectification branch is deployed.

### Infrakinetic migration state

The production migration status reports all currently known deployed Infrakinetic migrations complete **through migration 380**.

The rectification branch introduces:

- migration `381_ai_managed_provider_credentials.sql`;
- RDS-only migration `163_rls_ai_managed_provider_credentials.sql`.

Therefore the new managed-provider-credential persistence path is **not claimed as production-applied from this evidence**.

### Deploy identity limitation

The production deploy-status helper returned a last-deploy timestamp (`20260909T050138Z`) but did not return a bindable git SHA in this observation. Therefore this checkpoint does not claim an exact source-commit-to-production correspondence.

Governance migrations `0017` and `0018` likewise remain **live-unverified** in this checkpoint.

---

## 6. Live certification still open

The remaining work is no longer a source-design problem. It is deployment and production evidence.

### Gate A — merge/deploy identity

- commit the rectification branch in both repositories;
- review/merge under the normal repository policy;
- deploy exact reviewed commits;
- record exact deployed commit identities for both API and Governance.

### Gate B — database migrations

Apply and verify:

- Infrakinetic `381_ai_managed_provider_credentials.sql`;
- Infrakinetic RDS-only `163_rls_ai_managed_provider_credentials.sql`;
- Governance `0017_finops_allocation_policies.sql`;
- Governance `0018_ai_credentials_manage_scope.sql`.

Then verify the schema/constraints read-only.

### Gate C — real cloud inventory and permissions

From the deployed Governance UI/API, observe that:

- EC2/RDS/S3/Lambda/Cognito/Scheduler return real facts or explicit permission gaps;
- Azure Service Bus returns the configured namespace/queue runtime facts without credentials;
- Stirling reports its actual endpoint host/version/hosting metadata;
- denied services remain visibly denied rather than appearing empty.

### Gate D — real FinOps feeds

Verify from production:

- AWS Cost Explorer permission and current month-to-date figures;
- AI estimated usage cost and reconciliation totals;
- unallocated/shared cost remains visible;
- Azure cost remains explicitly unavailable until a real Azure billing source is connected, rather than reporting zero.

### Gate E — two-operator maker-checker ceremony

Using two distinct real operators, exercise at least one representative approval flow for each high-risk family touched here, including:

- AI managed runtime-source cutover;
- payment-extension approval/revocation path as applicable;
- configuration restore apply for the supported Payment provider catalog path.

Prove:

- maker cannot self-approve;
- checker sees the safe bound diff/impact;
- execution cannot substitute a different target/material/diff;
- the approval executes once;
- fresh step-up is required where specified;
- post-execution owner observation matches the approved state.

### Gate F — deployed UI smoke

Manually verify the deployed product surfaces:

- central Approvals inbox;
- tenant workspace tabs and 25-row People batching;
- name-first tenant presentation;
- infrastructure partial-failure states;
- FinOps unknown-vs-zero behavior;
- AI runtime credential inventory/provider outcome telemetry;
- Configuration restore capability honesty.

---

## 7. Certification decision

**Source decision:** PASS.  
**Merge readiness:** source/tests are green, subject to normal diff review and repository policy.  
**Production certification:** OPEN.  
**Reason production remains open:** the new source has not been proven deployed with its migrations, real cloud/billing permissions and two-distinct-operator maker-checker ceremony.

No deployment, production migration or irreversible production action was performed as part of this checkpoint.
