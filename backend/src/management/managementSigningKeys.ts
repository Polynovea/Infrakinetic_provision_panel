import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import type { JWK } from "jose";
import { exportJWK, importJWK } from "jose";

import { DatabaseUnavailableError } from "../db/errors.js";

// 1A.4 — the Governance backend's own signing identity for management
// assertions sent to Infrakinetic's `/management/v1/*`. Deliberately
// separate from every other key material in this backend (Cognito is a
// verification-only relationship; this is the one place Governance signs
// anything). The private key never leaves this module — nothing outside
// `management/` imports it, and nothing under `frontend/` can (see
// scripts/check_no_signing_key_in_frontend.mjs).

export interface ManagementSigningKeySet {
  /** Active signing key id, used in every newly-minted assertion's `kid` header. */
  activeKid: string;
  activePrivateKey: KeyObject;
  /**
   * Every public key Infrakinetic's verifier should currently accept,
   * active key included — lets a previous key stay verifiable for a
   * rotation grace window without needing its private half here.
   */
  publicJwks: JWK[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new DatabaseUnavailableError(
      `Missing required environment variable ${name}. Management assertion signing cannot start until Governance's signing key is configured.`,
    );
  }
  return value;
}

/**
 * Loads the active signing key (required) plus any additional public-only
 * JWKs still valid for verification (optional, JSON array), and derives
 * the active key's own public JWK by importing then re-deriving it from
 * the private key — the source of truth is one PEM, never a
 * separately-maintained public copy that could drift from it.
 */
export async function loadManagementSigningKeys(): Promise<ManagementSigningKeySet> {
  const activeKid = required("GOVERNANCE_MANAGEMENT_SIGNING_KID");
  const privateKeyPem = required("GOVERNANCE_MANAGEMENT_SIGNING_PRIVATE_KEY_PEM");

  let activePrivateKey: KeyObject;
  try {
    activePrivateKey = createPrivateKey(privateKeyPem);
  } catch (err) {
    throw new DatabaseUnavailableError(
      `GOVERNANCE_MANAGEMENT_SIGNING_PRIVATE_KEY_PEM could not be parsed as a private key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Deriving from the PRIVATE key object directly would export the private
  // exponent ('d') into what must be a public-only JWKS — createPublicKey()
  // strips it first, same defense pattern as never printing a password.
  const activePublicJwk = await exportJWK(createPublicKey(activePrivateKey));
  activePublicJwk.kid = activeKid;
  activePublicJwk.alg = "RS256";
  activePublicJwk.use = "sig";

  const publicJwks: JWK[] = [activePublicJwk];

  const additionalRaw = process.env.GOVERNANCE_MANAGEMENT_SIGNING_ADDITIONAL_PUBLIC_JWKS?.trim();
  if (additionalRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(additionalRaw);
    } catch (err) {
      throw new DatabaseUnavailableError(
        `GOVERNANCE_MANAGEMENT_SIGNING_ADDITIONAL_PUBLIC_JWKS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new DatabaseUnavailableError("GOVERNANCE_MANAGEMENT_SIGNING_ADDITIONAL_PUBLIC_JWKS must be a JSON array of JWKs.");
    }
    for (const jwk of parsed as JWK[]) {
      if (!jwk.kid) {
        throw new DatabaseUnavailableError("Every entry in GOVERNANCE_MANAGEMENT_SIGNING_ADDITIONAL_PUBLIC_JWKS must carry a 'kid'.");
      }
      // Fail closed on a malformed entry now, not on the first real
      // verification attempt against it.
      await importJWK(jwk, "RS256");
      publicJwks.push(jwk);
    }
  }

  return { activeKid, activePrivateKey, publicJwks };
}
