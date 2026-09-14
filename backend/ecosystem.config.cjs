// Deliberately separate from polynovea-api's own ecosystem.config.cjs —
// different process name, different working directory, different log
// path, different port (127.0.0.1:4100 only, never 0.0.0.0). Not deployed
// by this scaffold — deploying this to the shared EC2 host is a separate,
// explicitly-authorized step (master plan §7.1 item 6 / §14 same-EC2
// deployment decision), not implied by this file's existence.
//
// This is the git-tracked TEMPLATE only — no real secret ever belongs in
// this file or in this repository. The real, deployed copy lives only on
// the EC2 host (server-local, never committed) and reads secret material
// at PM2-start time from EC2-only, mode-600 files sitting next to it:
// .signing-key.pem / .signing-kid.txt (management assertion signing),
// .db-secrets.env (GOVERNANCE_DB_*), .cognito-secrets.env
// (GOVERNANCE_COGNITO_*) — see docs/1A.2_status.md and 1A.3_status.md.
const fs = require("fs");
const path = require("path");

const KID = fs.readFileSync(path.join(__dirname, ".signing-kid.txt"), "utf8").trim();
const PRIVATE_KEY_PEM = fs.readFileSync(path.join(__dirname, ".signing-key.pem"), "utf8");

function parseDotEnv(filePath) {
  const out = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}

const dbSecrets = parseDotEnv(path.join(__dirname, ".db-secrets.env"));
const cognitoSecrets = parseDotEnv(path.join(__dirname, ".cognito-secrets.env"));

module.exports = {
  apps: [
    {
      name: "polynovea-governance-api",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        GOVERNANCE_MANAGEMENT_ISSUER: "https://governance.infrakinetic.in",
        GOVERNANCE_MANAGEMENT_AUDIENCE: "infrakinetic-management-api",
        GOVERNANCE_MANAGEMENT_SIGNING_KID: KID,
        GOVERNANCE_MANAGEMENT_SIGNING_PRIVATE_KEY_PEM: PRIVATE_KEY_PEM,
        ...dbSecrets,
        ...cognitoSecrets,
      },
      error_file: "./logs/governance-api-error.log",
      out_file: "./logs/governance-api-out.log",
    },
  ],
};
