import type { RequestHandler } from "express";

import { safeEqualText } from "../identity/browserAuthCrypto.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireBrowserCsrf(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase()) || req.operatorAuthMethod !== "browser-session") {
      next();
      return;
    }

    const expectedToken = req.browserSessionCsrfToken;
    const headerToken = req.header("x-governance-csrf")?.trim();
    if (!expectedToken || !headerToken || !safeEqualText(expectedToken, headerToken)) {
      res.status(403).json({ error: "CSRF_REQUIRED", message: "A valid anti-CSRF token is required." });
      return;
    }

    next();
  };
}
