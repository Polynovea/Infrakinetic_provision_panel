import express from "express";

// 1A.1 — infrastructure-only. No database connection, no Cognito, no
// management API authentication, no calls to Infrakinetic's api-server of
// any kind. /healthz must pass with zero DB dependency (master plan
// §7.1/§7.2 exit gate).
const app = express();

const HOST = process.env.GOVERNANCE_API_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GOVERNANCE_API_PORT ?? 4100);

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "polynovea.platform-governance", phase: "1A.1" });
});

// Every other route 404s — no other surface exists yet.
app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.listen(PORT, HOST, () => {
  console.log(`PolyNovea Platform Governance backend listening on ${HOST}:${PORT}`);
});
