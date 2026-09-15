#!/usr/bin/env -S npx tsx
// SUPERSEDED FOR PRODUCTION USE (2026-09-15): writes only to the interim
// config/operators.seed.json file, which the running process has not read
// since 1A.3 wired PostgresOperatorDirectory unconditionally in
// src/index.ts. Running this against a live deployment silently does
// nothing observable — the real operator directory is
// governance.operators/operator_roles/operator_scopes. Use
// scripts/bootstrapOperatorDb.ts (npm run bootstrap:operator:db) instead.
// Kept only as a reference for the seed-store adapter's own tests.
//
// 1A.2 — deliberately narrow operator bootstrap CLI.
//
// This exists ONLY because there is no governed tenant/operator
// commissioning pipeline yet (that is 1A.3's DB, 1A.5's audit ledger, and
// 1A.18's real tenant-commissioning workflow — all later subphases). It is
// not a general-purpose admin API: it is a local, operator-invoked CLI
// script with no HTTP surface, so it cannot be reached by anything but a
// human with filesystem access to this deployment.
//
// It never touches Cognito or any AWS resource. It takes a Cognito `sub`
// as INPUT (the human must already have created — or must separately
// create — that Cognito identity through the existing, already-provisioned
// Infrakinetic Cognito pool; this script does not call AdminCreateUser).
// Its only job is the governance-owned half: upsert a governance
// OperatorRecord for that sub into the 1A.2 interim seed store
// (config/operators.seed.json) and record why.
//
// Retire this in favor of a real commissioning workflow once 1A.3 (DB) and
// 1A.12/1A.18 exist — see docs/1A.2_status.md "Bootstrap mechanism".
//
// Usage:
//   npx tsx scripts/bootstrapOperator.ts \
//     --cognito-sub <sub> --email <email> --display-name <name> \
//     --role platform_admin --actor <your name> --reason <why> --mfa-verified \
//     [--bootstrap-root] [--dry-run] [--seed-path <path>]
//
//   npx tsx scripts/bootstrapOperator.ts --list [--seed-path <path>]

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isRole, ROLE_SCOPE_CEILING, type Role } from "../src/identity/roles.js";
import type { OperatorRecord } from "../src/identity/types.js";

const backendRoot = join(fileURLToPath(import.meta.url), "..", "..");
const DEFAULT_SEED_PATH = join(backendRoot, "config", "operators.seed.json");
const DEFAULT_AUDIT_PATH = join(backendRoot, "config", "operator_bootstrap_audit.jsonl");

interface Args {
  cognitoSub?: string;
  email?: string;
  displayName?: string;
  role?: string;
  actor?: string;
  reason?: string;
  mfaVerified: boolean;
  bootstrapRoot: boolean;
  dryRun: boolean;
  list: boolean;
  seedPath: string;
  auditPath: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mfaVerified: false,
    bootstrapRoot: false, dryRun: false, list: false,
    seedPath: DEFAULT_SEED_PATH, auditPath: DEFAULT_AUDIT_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--cognito-sub": args.cognitoSub = argv[++i]; break;
      case "--email": args.email = argv[++i]; break;
      case "--display-name": args.displayName = argv[++i]; break;
      case "--role": args.role = argv[++i]; break;
      case "--actor": args.actor = argv[++i]; break;
      case "--reason": args.reason = argv[++i]; break;
      case "--mfa-verified": args.mfaVerified = true; break;
      case "--seed-path": args.seedPath = argv[++i]; break;
      case "--audit-path": args.auditPath = argv[++i]; break;
      case "--bootstrap-root": args.bootstrapRoot = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--list": args.list = true; break;
      default:
        throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return args;
}

function loadSeed(seedPath: string): OperatorRecord[] {
  if (!existsSync(seedPath)) return [];
  const raw = readFileSync(seedPath, "utf8").trim();
  return raw === "" ? [] : (JSON.parse(raw) as OperatorRecord[]);
}

function writeSeed(seedPath: string, operators: OperatorRecord[]): void {
  mkdirSync(dirname(seedPath), { recursive: true });
  writeFileSync(seedPath, JSON.stringify(operators, null, 2) + "\n", "utf8");
}

interface AuditEntry {
  timestamp: string;
  actor: string;
  action: string;
  result: "created" | "no_change" | "refused";
  cognitoSub?: string;
  email?: string;
  role?: string;
  reason?: string;
  mfaVerified: boolean;
  bootstrapRoot: boolean;
  detail?: string;
}

function recordAudit(auditPath: string, entry: AuditEntry, dryRun: boolean): void {
  const line = JSON.stringify(entry);
  if (dryRun) {
    console.log(`[dry-run] would append to ${auditPath}:\n  ${line}`);
    return;
  }
  mkdirSync(dirname(auditPath), { recursive: true });
  appendFileSync(auditPath, line + "\n", "utf8");
}

function recordsEqual(a: OperatorRecord, b: OperatorRecord): boolean {
  return (
    a.email === b.email &&
    a.displayName === b.displayName &&
    a.status === b.status &&
    JSON.stringify([...a.roles].sort()) === JSON.stringify([...b.roles].sort()) &&
    JSON.stringify([...a.scopes].sort()) === JSON.stringify([...b.scopes].sort())
  );
}

function fail(message: string): never {
  console.error(`bootstrap_operator: REFUSED — ${message}`);
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const operators = loadSeed(args.seedPath);
    console.log(JSON.stringify(operators.map((op) => ({
      operatorId: op.operatorId, email: op.email, displayName: op.displayName,
      status: op.status, roles: op.roles, cognitoSub: op.cognitoSub,
    })), null, 2));
    return;
  }

  const { cognitoSub, email, displayName, role, actor, reason } = args;
  if (!cognitoSub || !email || !displayName || !role || !actor || !reason) {
    fail(
      "missing required argument(s). Required: --cognito-sub --email --display-name --role --actor --reason " +
        "--mfa-verified (optional: --bootstrap-root --dry-run --seed-path --list)",
    );
  }
  if (!args.mfaVerified) {
    fail("--mfa-verified is required before creating an active operator; this CLI never silently claims MFA enrollment.");
  }
  if (!isRole(role)) {
    fail(`'${role}' is not a known role. Valid roles are defined in src/identity/roles.ts.`);
  }

  const operators = loadSeed(args.seedPath);
  const existingBySub = operators.find((op) => op.cognitoSub === cognitoSub);
  const existingByEmail = operators.find((op) => op.email === email && op.cognitoSub !== cognitoSub);

  // "Refuse to create duplicate platform roots" — --bootstrap-root is only
  // for standing up the very first operator ever, or for idempotently
  // re-asserting that SAME root's own record. If the seed store already
  // holds a DIFFERENT operator, the platform root has already been
  // bootstrapped; use a normal (non-root) invocation to add further
  // operators instead.
  if (args.bootstrapRoot && operators.length > 0 && !existingBySub) {
    recordAudit(args.auditPath, {
      timestamp: new Date().toISOString(), actor, action: "bootstrap_operator",
      result: "refused", cognitoSub, email, role, reason, mfaVerified: args.mfaVerified, bootstrapRoot: true,
      detail: `seed store already has ${operators.length} operator(s), none matching this cognito_sub — platform root already bootstrapped`,
    }, args.dryRun);
    fail(`--bootstrap-root requires an empty operator seed store (or one containing only this same cognito_sub), but it already has ${operators.length} other entry(ies). The platform root has already been bootstrapped.`);
  }

  if (existingByEmail) {
    recordAudit(args.auditPath, {
      timestamp: new Date().toISOString(), actor, action: "bootstrap_operator",
      result: "refused", cognitoSub, email, role, reason, mfaVerified: args.mfaVerified, bootstrapRoot: args.bootstrapRoot,
      detail: `email already bound to a different cognito_sub (${existingByEmail.cognitoSub})`,
    }, args.dryRun);
    fail(`email '${email}' is already bound to a different operator record (cognito_sub=${existingByEmail.cognitoSub}). Ambiguous state — resolve manually, this script will not guess which is correct.`);
  }

  const candidate: OperatorRecord = {
    operatorId: existingBySub?.operatorId ?? randomUUID(),
    cognitoSub,
    email,
    displayName,
    status: "active",
    roles: [role as Role],
    scopes: ROLE_SCOPE_CEILING[role as Role],
    mfaEnrolled: args.mfaVerified,
    createdAt: existingBySub?.createdAt ?? new Date().toISOString(),
  };

  if (existingBySub) {
    if (recordsEqual(existingBySub, candidate)) {
      recordAudit(args.auditPath, {
        timestamp: new Date().toISOString(), actor, action: "bootstrap_operator",
        result: "no_change", cognitoSub, email, role, reason, mfaVerified: args.mfaVerified, bootstrapRoot: args.bootstrapRoot,
      }, args.dryRun);
      console.log(`bootstrap_operator: no change — an identical operator record already exists for cognito_sub=${cognitoSub}.`);
      return;
    }
    // Existing record differs from the requested one — fail closed rather
    // than silently overwriting a role/scope grant someone else set.
    recordAudit(args.auditPath, {
      timestamp: new Date().toISOString(), actor, action: "bootstrap_operator",
      result: "refused", cognitoSub, email, role, reason, mfaVerified: args.mfaVerified, bootstrapRoot: args.bootstrapRoot,
      detail: "an operator record already exists for this cognito_sub with different attributes",
    }, args.dryRun);
    fail(
      `an operator record already exists for cognito_sub=${cognitoSub} with different attributes ` +
        `(existing roles=[${existingBySub.roles.join(", ")}], requested roles=[${candidate.roles.join(", ")}], or email/displayName/status differ). ` +
        `This script does not overwrite an existing grant — edit ${args.seedPath} deliberately if that is really intended, with its own audit trail.`,
    );
  }

  const nextOperators = [...operators, candidate];

  console.log(
    `bootstrap_operator: ${args.dryRun ? "[dry-run] would create" : "creating"} operator ` +
      `${candidate.operatorId} (${candidate.email}), role=${candidate.roles.join(",")}, ` +
      `scopes=${candidate.scopes.length} granted (full ${role} ceiling).`,
  );

  if (!args.dryRun) {
    writeSeed(args.seedPath, nextOperators);
  }

  recordAudit(args.auditPath, {
    timestamp: new Date().toISOString(), actor, action: "bootstrap_operator",
    result: "created", cognitoSub, email, role, reason, mfaVerified: args.mfaVerified, bootstrapRoot: args.bootstrapRoot,
  }, args.dryRun);

  console.log(args.dryRun ? "[dry-run] no files were written." : `Done. ${args.seedPath} and ${args.auditPath} updated.`);
}

main();
