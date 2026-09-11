// 1A.2 architecture/boundary check (README.md hard rule #1 / master plan
// §13 "no filesystem imports from Infrakinetic"). Fails the build if any
// backend source file imports a path that resolves outside backend/src, or
// whose import specifier names the Infrakinetic/CRM source tree — the
// concrete failure mode this guards against is a developer typing a
// relative import like `../../../CRM/api-server/src/...` to "borrow" a
// helper. Only import/require specifiers are inspected — comments and
// unrelated string literals are not.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = join(fileURLToPath(import.meta.url), "..", "..");
const srcRoot = join(backendRoot, "src");

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

// Matches `from "spec"`, `import "spec"`, `require("spec")` — the specifier
// capture group is what gets checked, nothing else in the file.
const IMPORT_SPEC_PATTERN = /(?:from\s+|require\()\s*["']([^"']+)["']/g;
const INFRAKINETIC_NAME_PATTERN = /\b(Infrakinetic|api-server|apps\/infrakinetic)\b/i;

function walk(dir, results = []) {
  for (const entry of readdirSync(dir)) {
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
for (const filePath of walk(srcRoot)) {
  const relPath = relative(backendRoot, filePath).replace(/\\/g, "/");
  const content = readFileSync(filePath, "utf8");
  const fileDir = dirname(filePath);

  for (const match of content.matchAll(IMPORT_SPEC_PATTERN)) {
    const spec = match[1];

    if (INFRAKINETIC_NAME_PATTERN.test(spec)) {
      violations.push({ file: relPath, reason: "import specifier names the Infrakinetic/CRM source tree", spec });
      continue;
    }

    if (spec.startsWith(".")) {
      const resolved = resolve(fileDir, spec);
      const withinSrc = resolved === srcRoot || resolved.startsWith(srcRoot + "/") || resolved.startsWith(srcRoot + "\\");
      if (!withinSrc) {
        violations.push({ file: relPath, reason: "relative import resolves outside backend/src", spec });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Infrakinetic import-boundary check FAILED:");
  for (const { file, reason, spec } of violations) {
    console.error(`  ${file}: ${reason} — "${spec}"`);
  }
  console.error("\nThis repository must never import from the Infrakinetic/CRM source tree (README.md hard rule #1).");
  process.exit(1);
}

console.log("Infrakinetic import-boundary check passed — no cross-repo or escaping relative imports under backend/src.");
