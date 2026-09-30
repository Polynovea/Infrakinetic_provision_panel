// Phase 1A.15 final closure — proves Governance's copy of the module_ai operator contract is the one the owner
// (Infrakinetic) currently publishes, WITHOUT importing any owner source: it only compares two published data files.
//
//   node scripts/check_ai_contract_sync.mjs <infrakinetic-repo-root>
//
// Run it before a Governance release that consumes the AI plane, with the Infrakinetic checkout that will be
// deployed. It compares (line-ending independent):
//   <root>/api-server/src/contracts/management/ai-management.contract.generated.json  ==  src/management/contracts/aiManagement.contract.json
//   <root>/api-server/src/contracts/management/ai-management.examples.generated.json  ==  src/management/contracts/aiManagement.examples.json
// and that the local hash pin matches both. Any difference exits 1: copy the owner's files, update the pin
// (aiManagement.sha256) and run the Governance tests, which check every operation, route and DTO against the new contract.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const local = path.resolve(here, "../src/management/contracts");
const ownerRoot = process.argv[2];
if (!ownerRoot) {
  console.error("usage: node scripts/check_ai_contract_sync.mjs <infrakinetic-repo-root>");
  process.exit(2);
}

const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const sha = (text) => createHash("sha256").update(text).digest("hex");
const pairs = [
  ["aiManagement.contract.json", "ai-management.contract.generated.json"],
  ["aiManagement.examples.json", "ai-management.examples.generated.json"],
];
const pins = Object.fromEntries(read(path.join(local, "aiManagement.sha256")).trim().split("\n").map((line) => {
  const [hash, name] = line.split(/\s+\*?/);
  return [name, hash];
}));

let failed = false;
for (const [copy, published] of pairs) {
  const ownerFile = path.join(ownerRoot, "api-server", "src", "contracts", "management", published);
  const ours = read(path.join(local, copy));
  let theirs;
  try { theirs = read(ownerFile); } catch { console.error(`cannot read the owner's ${ownerFile}`); process.exit(2); }
  const same = ours === theirs;
  const pinned = pins[copy] === sha(ours);
  console.log(`${copy}: ${same ? "matches the owner's published file" : "DIFFERS from the owner's published file"}; pin ${pinned ? "ok" : "STALE"} (${sha(ours).slice(0, 12)}…)`);
  if (!same || !pinned) failed = true;
}
process.exit(failed ? 1 : 0);
