import type { RequestHandler } from "express";

export function createGovernanceCors(frontendOrigin: string | undefined): RequestHandler {
  return (req, res, next) => {
    const origin = req.header("origin");
    if (origin) {
      if (!frontendOrigin || origin !== frontendOrigin) {
        res.status(403).json({ error: "ORIGIN_NOT_ALLOWED" });
        return;
      }
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
      res.header("Access-Control-Allow-Credentials", "true");
      res.header("Access-Control-Allow-Headers", "content-type, x-governance-csrf, x-correlation-id, authorization");
      res.header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
