// Phase 1A.1 domain-portability CI check (master plan §2c.1's hard rule:
// no hostname may appear as canonical identity, and no hostname literal
// may be hardcoded into business logic — env-driven config only).
// Fails the build on any hardcoded "polynovea.in" / "infrakinetic.in"
// string found outside the designated allowlist below.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");

const SCAN_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".github"]);

// Files allowed to reference a real hostname literal: environment
// templates, documentation, and this check itself (it has to contain the
// pattern to check for it).
const ALLOWLIST = [
  /\.env(\..+)?$/,
  /^README\.md$/,
  /^docs\//,
  /check_domain_portability\.mjs$/,
];

const DOMAIN_PATTERN = /["'`][^"'`]*\.(?:polynovea|infrakinetic)\.in[^"'`]*["'`]/g;

function isAllowlisted(relPath) {
  return ALLOWLIST.some((pattern) => pattern.test(relPath));
}

function walk(dir, results = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, results);
    } else if (SCAN_EXTENSIONS.has(extname(entry))) {
      results.push(fullPath);
    }
  }
  return results;
}

const violations = [];
for (const filePath of walk(repoRoot)) {
  const relPath = relative(repoRoot, filePath).replace(/\\/g, "/");
  if (isAllowlisted(relPath)) continue;
  const content = readFileSync(filePath, "utf8");
  const matches = content.match(DOMAIN_PATTERN);
  if (matches) violations.push({ file: relPath, matches });
}

if (violations.length > 0) {
  console.error("Domain-portability check FAILED — hardcoded hostname literal(s) found outside the allowlist:");
  for (const { file, matches } of violations) {
    console.error(`  ${file}: ${matches.join(", ")}`);
  }
  console.error("\nHostnames are deployment configuration, never contract identity (master plan §2c.1). Move the value to an environment variable.");
  process.exit(1);
}

console.log("Domain-portability check passed — no hardcoded polynovea.in/infrakinetic.in literal outside the allowlist.");
