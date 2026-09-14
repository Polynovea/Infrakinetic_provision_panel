// 786e002 follow-up: the Cognito confidential app-client secret
// (GOVERNANCE_COGNITO_APP_CLIENT_SECRET) authenticates the token exchange in
// routes/auth/index.ts and must never reach frontend/ — not as a literal, not
// via a NEXT_PUBLIC_ alias, not via any other Cognito config the browser has
// no reason to hold now that the OAuth exchange is entirely backend-owned.
// Same technique as check_no_signing_key_in_frontend.mjs.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");
const frontendRoot = join(repoRoot, "frontend");

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".env", ".env.example", ".env.local"]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

const SECRET_NAME_PATTERN = /GOVERNANCE_COGNITO_APP_CLIENT_SECRET/;
const NEXT_PUBLIC_COGNITO_PATTERN = /NEXT_PUBLIC_GOVERNANCE_COGNITO/;

function walk(dir, results = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results; // frontend/ may not exist in every checkout state
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, results);
    } else if (SCAN_EXTENSIONS.has(extname(entry)) || entry.startsWith(".env")) {
      results.push(fullPath);
    }
  }
  return results;
}

const violations = [];
for (const filePath of walk(frontendRoot)) {
  const relPath = relative(repoRoot, filePath).replace(/\\/g, "/");
  const content = readFileSync(filePath, "utf8");

  if (SECRET_NAME_PATTERN.test(content)) {
    violations.push({ file: relPath, reason: "references GOVERNANCE_COGNITO_APP_CLIENT_SECRET" });
  }
  if (NEXT_PUBLIC_COGNITO_PATTERN.test(content)) {
    violations.push({ file: relPath, reason: "defines/reads a NEXT_PUBLIC_GOVERNANCE_COGNITO* variable" });
  }
}

if (violations.length > 0) {
  console.error("check:no-cognito-secret-in-frontend FAILED:");
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.reason}`);
  }
  process.exit(1);
}

console.log("check:no-cognito-secret-in-frontend: clean — no Cognito secret material or NEXT_PUBLIC_ Cognito config reachable from frontend/.");
