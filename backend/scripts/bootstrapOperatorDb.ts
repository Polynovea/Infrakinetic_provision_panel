#!/usr/bin/env -S npx tsx
// 1A.2/1A.3 — real operator bootstrap CLI, targeting the live Governance
// Postgres directory (governance.operators/operator_roles/operator_scopes).
//
// Supersedes scripts/bootstrapOperator.ts, which only ever wrote to the
// interim file-backed config/operators.seed.json store. Production has
// used PostgresOperatorDirectory unconditionally since 1A.3 shipped
// (src/index.ts wires it up with no fallback) — that JSON file is not
// read by the running process at all, so bootstrapping into it would
// silently do nothing for a real deployment. This script writes directly
// to the same tables PostgresOperatorDirectory.findByCognitoSub() reads.
//
// Still deliberately narrow, same as the file it replaces: no HTTP surface,
// invoked only by a human with credentials/network access to the live DB.
// It never touches Cognito — it takes a Cognito `sub` as INPUT, produced by
// a human who has already created (or is creating) that identity directly
// in the Cognito console. This script does not call AdminCreateUser.
//
// Usage:
//   npx tsx scripts/bootstrapOperatorDb.ts \
//     --cognito-sub <sub> --email <email> --display-name <name> \
//     --role platform_admin --actor <your name> --reason <why> \
//     [--scopes tenants.read,tenants.commission,...] [--mfa-verified] \
//     [--dry-run]
//
//   npx tsx scripts/bootstrapOperatorDb.ts --list
//   npx tsx scripts/bootstrapOperatorDb.ts --mark-mfa-verified --cognito-sub <sub> --actor <name> --reason <why>

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PgDbClient } from "../src/db/pgDbClient.js";
import { ROLE_SCOPE_CEILING, isRole, isScope, type Role, type Scope } from "../src/identity/roles.js";

const backendRoot = join(fileURLToPath(import.meta.url), "..", "..");
const AUDIT_PATH = join(backendRoot, "config", "operator_bootstrap_audit.jsonl");

interface Args {
  cognitoSub?: string;
  email?: string;
  displayName?: string;
  role?: string;
  scopes?: string;
  actor?: string;
  reason?: string;
  mfaVerified: boolean;
  dryRun: boolean;
  list: boolean;
  markMfaVerified: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mfaVerified: false, dryRun: false, list: false, markMfaVerified: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--cognito-sub": args.cognitoSub = argv[++i]; break;
      case "--email": args.email = argv[++i]; break;
      case "--display-name": args.displayName = argv[++i]; break;
      case "--role": args.role = argv[++i]; break;
      case "--scopes": args.scopes = argv[++i]; break;
      case "--actor": args.actor = argv[++i]; break;
      case "--reason": args.reason = argv[++i]; break;
      case "--mfa-verified": args.mfaVerified = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--list": args.list = true; break;
      case "--mark-mfa-verified": args.markMfaVerified = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function appendAudit(entry: Record<string, unknown>): void {
  const dir = dirname(AUDIT_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(AUDIT_PATH, JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n", "utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = PgDbClient.fromEnv();

  if (args.list) {
    const result = await db.query<{
      operator_id: string; cognito_sub: string; email: string; display_name: string;
      status: string; mfa_enrolled: boolean; created_at: string;
    }>("SELECT operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at FROM governance.operators ORDER BY created_at");
    console.log(JSON.stringify(result.rows, null, 2));
    process.exit(0);
  }

  if (!args.cognitoSub) throw new Error("--cognito-sub is required");
  if (!args.actor) throw new Error("--actor is required");
  if (!args.reason) throw new Error("--reason is required");

  const existing = await db.query<{ operator_id: string; email: string; status: string; mfa_enrolled: boolean }>(
    "SELECT operator_id, email, status, mfa_enrolled FROM governance.operators WHERE cognito_sub = $1",
    [args.cognitoSub],
  );

  if (args.markMfaVerified) {
    const row = existing.rows[0];
    if (!row) throw new Error(`No operator found for cognito_sub ${args.cognitoSub} — bootstrap it first.`);
    if (row.mfa_enrolled && row.status === "active") {
      console.log(`Operator ${row.operator_id} already active with mfa_enrolled=true — no-op.`);
      process.exit(0);
    }
    if (args.dryRun) {
      console.log(`DRY RUN: would set operator ${row.operator_id} to status=active, mfa_enrolled=true, disabled_at=NULL, disabled_reason=NULL.`);
      process.exit(0);
    }
    await db.query(
      "UPDATE governance.operators SET status = 'active', mfa_enrolled = true, disabled_at = NULL, disabled_reason = NULL, updated_at = now() WHERE operator_id = $1",
      [row.operator_id],
    );
    appendAudit({ action: "mfa_verified", operatorId: row.operator_id, cognitoSub: args.cognitoSub, actor: args.actor, reason: args.reason });
    console.log(`Operator ${row.operator_id} is now active with mfa_enrolled=true.`);
    process.exit(0);
  }

  if (!args.email) throw new Error("--email is required");
  if (!args.displayName) throw new Error("--display-name is required");
  if (!args.role || !isRole(args.role)) throw new Error(`--role must be one of the known roles (got: ${args.role})`);
  const role = args.role as Role;

  const ceiling = ROLE_SCOPE_CEILING[role];
  const requestedScopes = args.scopes ? args.scopes.split(",").map((s) => s.trim()) : [...ceiling];
  for (const scope of requestedScopes) {
    if (!isScope(scope)) throw new Error(`Unknown scope: ${scope}`);
    if (!ceiling.includes(scope as Scope)) throw new Error(`Scope ${scope} exceeds ${role}'s ceiling.`);
  }

  const emailConflict = await db.query<{ operator_id: string; cognito_sub: string }>(
    "SELECT operator_id, cognito_sub FROM governance.operators WHERE email = $1 AND cognito_sub <> $2",
    [args.email, args.cognitoSub],
  );
  if (emailConflict.rows.length > 0) {
    throw new Error(
      `Email ${args.email} is already bound to a different cognito_sub (${emailConflict.rows[0].cognito_sub}, operator_id ${emailConflict.rows[0].operator_id}). Refusing to create a duplicate.`,
    );
  }

  if (existing.rows.length > 0) {
    console.log(`Operator already exists for cognito_sub ${args.cognitoSub}: operator_id ${existing.rows[0].operator_id}, status ${existing.rows[0].status}. No changes made (idempotent no-op). Use --mark-mfa-verified to activate it.`);
    process.exit(0);
  }

  const operatorId = randomUUID();
  const now = new Date().toISOString();
  // Schema requires disabled_at whenever status <> 'active' — bootstrap
  // deliberately lands here disabled, never active, until MFA is verified
  // (see --mark-mfa-verified above). This is a real, enforced pending state,
  // not a cosmetic one: requireManagementApiAuth rejects non-active operators.
  const initialStatus = "disabled";
  const disabledReason = "Pending real TOTP MFA enrollment (bootstrap-created, not yet verified)";

  console.log("About to create:");
  console.log(JSON.stringify({ operatorId, cognitoSub: args.cognitoSub, email: args.email, displayName: args.displayName, role, scopes: requestedScopes, initialStatus, disabledReason }, null, 2));

  if (args.dryRun) {
    console.log("DRY RUN: no changes made.");
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO governance.operators
       (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at, disabled_at, disabled_reason)
       VALUES ($1, $2, $3, $4, $5, false, $6, $6, $6, $7)`,
      [operatorId, args.cognitoSub, args.email, args.displayName, initialStatus, now, disabledReason],
    );
    await tx.query(
      `INSERT INTO governance.operator_roles (operator_id, role, granted_at, granted_by) VALUES ($1, $2, $3, NULL)`,
      [operatorId, role, now],
    );
    for (const scope of requestedScopes) {
      await tx.query(
        `INSERT INTO governance.operator_scopes (operator_id, scope, granted_at, granted_by) VALUES ($1, $2, $3, NULL)`,
        [operatorId, scope, now],
      );
    }
  });

  appendAudit({
    action: "created", operatorId, cognitoSub: args.cognitoSub, email: args.email, displayName: args.displayName,
    role, scopes: requestedScopes, initialStatus, actor: args.actor, reason: args.reason,
  });

  console.log(`Created operator ${operatorId} — status=disabled (pending MFA), role=${role}, ${requestedScopes.length} scope(s) granted.`);
  console.log(`Once MFA enrollment is confirmed, run with --mark-mfa-verified --cognito-sub ${args.cognitoSub} to activate.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("bootstrapOperatorDb FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
