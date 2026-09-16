import { describe, expect, it } from "vitest";

import {
  buildCommandEnvelope,
  validateCommandEnvelope,
  InvalidCommandEnvelopeError,
  MANAGEMENT_COMMAND_CONTRACT,
} from "../../../src/management/operations/commandEnvelope.js";

function validParams() {
  return {
    commandId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    idempotencyKey: "key-1",
    operatorId: "11111111-1111-4111-8111-111111111111",
    operatorSessionId: "22222222-2222-4222-8222-222222222222",
    tenantId: null as string | null,
    targetEngine: "module_ai",
    requestedAction: "tenant-ai-policy.apply",
    correlationId: "33333333-3333-4333-8333-333333333333",
    requestedAt: new Date().toISOString(),
    payload: { desiredState: "enabled" },
  };
}

describe("management/operations/commandEnvelope", () => {
  it("builds an envelope carrying the master plan §17 contract", () => {
    const envelope = buildCommandEnvelope(validParams());
    expect(envelope.contract).toBe(MANAGEMENT_COMMAND_CONTRACT);
    expect(envelope.command_id).toBe(validParams().commandId);
    expect(envelope.tenant_id).toBeNull();
  });

  it("validates a well-formed envelope without throwing", () => {
    expect(() => validateCommandEnvelope(buildCommandEnvelope(validParams()))).not.toThrow();
  });

  it("builds and validates a non-engine generic target without fake target_engine", () => {
    const envelope = buildCommandEnvelope({
      ...validParams(),
      targetEngine: undefined,
      targetResourceType: "commission_request",
      targetResourceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      requestedAction: "tenant.commission",
    });
    expect(envelope.target_engine).toBeUndefined();
    expect(envelope.target_resource_type).toBe("commission_request");
    expect(envelope.target_resource_id).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(() => validateCommandEnvelope(envelope)).not.toThrow();
  });

  it("preserves target_engine and projects it to the generic engine address", () => {
    const envelope = buildCommandEnvelope(validParams());
    expect(envelope.target_engine).toBe("module_ai");
    expect(envelope.target_resource_type).toBe("engine");
    expect(envelope.target_resource_id).toBe("module_ai");
  });

  it("rejects missing/partial/conflicting target addresses", () => {
    expect(() => buildCommandEnvelope({ ...validParams(), targetEngine: undefined })).toThrow(InvalidCommandEnvelopeError);
    expect(() => buildCommandEnvelope({
      ...validParams(),
      targetEngine: undefined,
      targetResourceType: "tenant",
    })).toThrow(InvalidCommandEnvelopeError);
    expect(() => validateCommandEnvelope({
      ...buildCommandEnvelope(validParams()),
      target_resource_type: "tenant",
      target_resource_id: "tenant-x",
    })).toThrow(InvalidCommandEnvelopeError);
  });

  it("rejects a wrong contract string", () => {
    const envelope = { ...buildCommandEnvelope(validParams()), contract: "something-else.v1" };
    expect(() => validateCommandEnvelope(envelope)).toThrow(InvalidCommandEnvelopeError);
  });

  it("rejects a missing required field", () => {
    const envelope = buildCommandEnvelope(validParams()) as unknown as Record<string, unknown>;
    delete envelope.correlation_id;
    expect(() => validateCommandEnvelope(envelope)).toThrow(InvalidCommandEnvelopeError);
  });

  it("rejects a non-string, non-null tenant_id", () => {
    const envelope = { ...buildCommandEnvelope(validParams()), tenant_id: 12345 };
    expect(() => validateCommandEnvelope(envelope)).toThrow(InvalidCommandEnvelopeError);
  });

  it("accepts a null tenant_id (platform-wide command)", () => {
    const envelope = buildCommandEnvelope({ ...validParams(), tenantId: null });
    expect(() => validateCommandEnvelope(envelope)).not.toThrow();
  });

  it("requires a payload key even if empty", () => {
    const envelope = buildCommandEnvelope(validParams()) as unknown as Record<string, unknown>;
    delete envelope.payload;
    expect(() => validateCommandEnvelope(envelope)).toThrow(InvalidCommandEnvelopeError);
  });

  it("rejects a non-object value entirely", () => {
    expect(() => validateCommandEnvelope("not-an-object")).toThrow(InvalidCommandEnvelopeError);
    expect(() => validateCommandEnvelope(null)).toThrow(InvalidCommandEnvelopeError);
  });
});
