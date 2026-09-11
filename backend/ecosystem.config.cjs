// Deliberately separate from polynovea-api's own ecosystem.config.cjs —
// different process name, different working directory, different log
// path, different port (127.0.0.1:4100 only, never 0.0.0.0). Not deployed
// by this scaffold — deploying this to the shared EC2 host is a separate,
// explicitly-authorized step (master plan §7.1 item 6 / §14 same-EC2
// deployment decision), not implied by this file's existence.
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
      },
      error_file: "../logs/governance-api-error.log",
      out_file: "../logs/governance-api-out.log",
    },
  ],
};
