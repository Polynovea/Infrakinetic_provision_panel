#!/usr/bin/env node
// 1A.3 — applies backend/migrations/*.sql to the Governance database
// configured via GOVERNANCE_DB_* (see .env.example). Explicit,
// operator-invoked CLI only, same posture as scripts/bootstrapOperator.ts —
// no HTTP surface. Idempotent (safe to re-run; already-applied migrations
// are reported and skipped, not re-run).
//
// Usage:
//   npm run db:migrate            # apply every pending migration
//   npm run db:migrate -- --dry-run   # report what would be applied, without writing

import { fileURLToPath } from "node:url";

import { runMigrations } from "../src/db/migrationRunner.js";
import { PgDbClient } from "../src/db/pgDbClient.js";

function parseArgs(argv: readonly string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

  const client = PgDbClient.fromEnv();
  try {
    const results = await runMigrations(client, migrationsDir, { dryRun });
    for (const result of results) {
      const label = !result.applied
        ? "already applied (skip)"
        : dryRun
          ? "would apply"
          : "applied";
      console.log(`${result.id}: ${label}`);
    }
    const pendingOrApplied = results.filter((r) => r.applied).length;
    console.log(
      dryRun
        ? `${pendingOrApplied} migration(s) pending.`
        : `${pendingOrApplied} migration(s) applied this run.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
