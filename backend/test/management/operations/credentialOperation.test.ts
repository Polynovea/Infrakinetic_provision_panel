import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import {
  requestCredentialReplace,
  requestCredentialTest,
  MissingCredentialTargetError,
} from "../../../src/management/operations/credentialOperation.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { CredentialOperationDeps } from "../../../src/management/operations/credentialOperation.js";

// 1A.13 — the routine (R2) credential replace mutation and the R0/R1 test
// action, same pg-mem + fake-fetch harness as identityOperation.test.ts.
// Focus: target validation happens before any network call, a full success
// round trip records a completed operation whose result never carries the
// raw secretValue, idempotent replay never re-dispatches the mutation, and
// `test` (unlike replace) never touches the ledger at all.

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RAW_SECRET = "sk_live_totally_secret_value_9f8e7d";

async function seedOperator(client: DbClient) {
  await client.query(
    `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
     VALUES ($1, 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())`,
    [OPERATOR_ID],
  );
}

async function buildFixtureSigningKeys(): Promise<ManagementSigningKeySet> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { activeKid: "test-kid", activePrivateKey: privateKey, publicJwks: [jwk] };
}

const TRANSPORT_CONFIG: ManagementTransportConfig = {
  issuer: "https://governance.test.invalid",
  audience: "infrakinetic-management-api-test",
};

interface FakeCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as Response;
}

function buildFakeInfrakinetic(responseByPath: Record<string, { status: number; body: unknown }>) {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET") as string;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });
    const match = responseByPath[url.pathname];
    if (!match) return jsonResponse(404, { error: "NO_FIXTURE_FOR_PATH" });
    return jsonResponse(match.status, match.body);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("requestCredentialReplace — target validation", () => {
  it("rejects a missing tenantId before any network call", async () => {
    const { client } = buildMigratedPgMemClient();
    const ledger = new ManagementOperationLedger(client);
    const signingKeys = await buildFixtureSigningKeys();
    const { fetchImpl, calls } = buildFakeInfrakinetic({});
    const deps: CredentialOperationDeps = { ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl };

    await expect(
      requestCredentialReplace(deps, {
        idempotencyKey: "idem-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.submit"],
        tenantId: "", credentialId: CREDENTIAL_ID, secretKind: "webhook_secret", secretValue: RAW_SECRET, reason: "test",
      }),
    ).rejects.toThrow(MissingCredentialTargetError);
    expect(calls).toHaveLength(0);
  });
});

describe("requestCredentialReplace — full success round trip (establish-only, R2)", () => {
  it("webhook_secret: records a completed operation whose result never contains the raw secretValue", async () => {
    const { client } = buildMigratedPgMemClient();
    await seedOperator(client);
    const ledger = new ManagementOperationLedger(client);
    const signingKeys = await buildFixtureSigningKeys();
    const path = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}/replace`;
    const { fetchImpl, calls } = buildFakeInfrakinetic({
      [path]: { status: 200, body: { action: "replace", secretKind: "webhook_secret", connectionStatus: "active", resultingSecrets: [{ kind: "webhook_secret", version: 1, status: "active", maskedHint: "****e7d" }] } },
    });
    const deps: CredentialOperationDeps = { ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl };

    const result = await requestCredentialReplace(deps, {
      idempotencyKey: "idem-replace-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.submit"],
      tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, secretKind: "webhook_secret", secretValue: RAW_SECRET,
      reason: "support ticket #42 — establishing the webhook secret for the first time",
    });

    expect(result.replay).toBe(false);
    expect(result.operation.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].body?.secretValue).toBe(RAW_SECRET); // sent to Infrakinetic, as expected
    expect(calls[0].body?.reason).toBe("support ticket #42 — establishing the webhook secret for the first time");
    expect(JSON.stringify(result.operation.result)).not.toContain(RAW_SECRET);
    expect(JSON.stringify(result.operation)).not.toContain(RAW_SECRET);
  });

  it("api_key_pair: sends apiKeyId/apiKeySecret together, never a bare secretValue, and neither appears in the recorded result", async () => {
    const { client } = buildMigratedPgMemClient();
    await seedOperator(client);
    const ledger = new ManagementOperationLedger(client);
    const signingKeys = await buildFixtureSigningKeys();
    const path = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}/replace`;
    const { fetchImpl, calls } = buildFakeInfrakinetic({
      [path]: {
        status: 200,
        body: {
          action: "replace",
          secretKind: "api_key_pair",
          connectionStatus: "active",
          resultingSecrets: [
            { kind: "api_key_id", version: 1, status: "active", maskedHint: "****9abc" },
            { kind: "api_key_secret", version: 1, status: "active", maskedHint: "****def0" },
          ],
        },
      },
    });
    const deps: CredentialOperationDeps = { ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl };
    const rawApiKeyId = "rzp_live_key_id_9abc";
    const rawApiKeySecret = "rzp_live_key_secret_def0";

    const result = await requestCredentialReplace(deps, {
      idempotencyKey: "idem-replace-pair-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.submit"],
      tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, secretKind: "api_key_pair", apiKeyId: rawApiKeyId, apiKeySecret: rawApiKeySecret,
      reason: "establishing the initial Razorpay key pair for this connection",
    });

    expect(result.replay).toBe(false);
    expect(result.operation.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].body?.apiKeyId).toBe(rawApiKeyId);
    expect(calls[0].body?.apiKeySecret).toBe(rawApiKeySecret);
    expect(calls[0].body?.secretValue).toBeUndefined();
    expect(JSON.stringify(result.operation)).not.toMatch(new RegExp(`${rawApiKeyId}|${rawApiKeySecret}`));
  });

  it("same idempotencyKey replayed -> zero new Infrakinetic calls", async () => {
    const { client } = buildMigratedPgMemClient();
    await seedOperator(client);
    const ledger = new ManagementOperationLedger(client);
    const signingKeys = await buildFixtureSigningKeys();
    const path = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}/replace`;
    const { fetchImpl, calls } = buildFakeInfrakinetic({
      [path]: { status: 200, body: { action: "replace", secretKind: "webhook_secret", connectionStatus: "active", resultingSecrets: null } },
    });
    const deps: CredentialOperationDeps = { ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl };
    const input = {
      idempotencyKey: "idem-replace-2", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.submit"],
      tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, secretKind: "webhook_secret", secretValue: RAW_SECRET, reason: "establishing the webhook secret",
    };

    await requestCredentialReplace(deps, input);
    expect(calls).toHaveLength(1);
    const replay = await requestCredentialReplace(deps, input);
    expect(replay.replay).toBe(true);
    expect(calls).toHaveLength(1); // unchanged — no second dispatch, no second secret transmission
  });
});

describe("requestCredentialTest — no ledger involvement", () => {
  it("calls Infrakinetic's test route directly and returns validationStatus without ever touching the operation ledger", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}/test`;
    const { fetchImpl, calls } = buildFakeInfrakinetic({
      [path]: { status: 200, body: { tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, validationStatus: "valid", testedAt: "2026-09-23T00:00:00Z", correlationId: "corr-1" } },
    });
    const signingKeys = await buildFixtureSigningKeys();

    const result = await requestCredentialTest(
      { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl },
      { operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID, operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.metadata.read"], tenantId: TENANT_ID, credentialId: CREDENTIAL_ID },
    );

    expect(result.validationStatus).toBe("valid");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBeUndefined(); // no reason/idempotencyKey — R0/R1, no ledger row
  });
});
