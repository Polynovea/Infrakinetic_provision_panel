// 1A.4 browser-isolation check (master plan §16/1A.4 exit gate: "browser
// cannot directly exercise private management path", and this repo's own
// rule "no management signing key in browser/Vercel client bundle"). Fails
// if `frontend/` imports any server-only management-signing module, or
// contains literal PEM private-key material anywhere in its source tree.
// Only import/require specifiers and literal PEM headers are inspected.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");
const frontendRoot = join(repoRoot, "frontend");

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

const IMPORT_SPEC_PATTERN = /(?:from\s+|require\()\s*["']([^"']+)["']/g;
const SIGNING_MODULE_PATTERN = /management\/(managementSigningKeys|managementAssertionIssuer|lazyManagementKeys)/;
const PRIVATE_KEY_LITERAL_PATTERN = /-----BEGIN (RSA |EC )?PRIVATE KEY-----/;

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
    } else if (SCAN_EXTENSIONS.has(extname(entry))) {
      results.push(fullPath);
    }
  }
  return results;
}

const violations = [];
for (const filePath of walk(frontendRoot)) {
  const relPath = relative(repoRoot, filePath).replace(/\\/g, "/");
  const content = readFileSync(filePath, "utf8");

  if (PRIVATE_KEY_LITERAL_PATTERN.test(content)) {
    violations.push({ file: relPath, reason: "contains literal PEM private-key material" });
  }

  for (const match of content.matchAll(IMPORT_SPEC_PATTERN)) {
    const spec = match[1];
    if (SIGNING_MODULE_PATTERN.test(spec)) {
      violations.push({ file: relPath, reason: "imports a server-only management-signing module", spec });
    }
  }
}

if (violations.length > 0) {
  console.error("check:no-signing-key-in-frontend FAILED:");
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.reason}${v.spec ? ` (${v.spec})` : ""}`);
  }
  process.exit(1);
}

console.log("check:no-signing-key-in-frontend: clean — no signing-key material or server-only management module reachable from frontend/.");
