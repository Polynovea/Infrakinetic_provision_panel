import { createRequire } from "node:module";

// Phase 1A.15 final closure — Governance's typed view of the module_ai operator contract.
//
// The contract is DATA published by the owner (Infrakinetic: src/contracts/management/
// ai-management.contract.generated.json) and kept here as a byte-identical copy with a pinned hash
// (contracts/aiManagement.sha256). Governance never imports Infrakinetic source: it consumes the
// artefact. Everything route-shaped in aiOperation.ts (scope, requested action, risk class, target
// binding, method and path) is READ from this contract, so a Governance operation cannot disagree with
// the owner's route table; the tests prove the copy matches the owner's, that this validator agrees
// with the owner's on every recorded schema vector, and that Governance's own routes cover the contract.

export type AiRisk = "R0" | "R1" | "R2" | "R3" | "R4";

export interface AiSchema {
  type?: string | string[];
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: AiSchema;
  required?: string[];
  properties?: Record<string, AiSchema>;
  additionalProperties?: boolean;
}

export interface AiBindingResource {
  type: string;
  id: { param?: string; constant?: string; derived?: string };
}

export interface AiContractRoute {
  id: string;
  kind: "read" | "mutation";
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  scope: string;
  action: string;
  risk: AiRisk;
  riskNarrowing?: AiRisk;
  approval: "none" | "maker_checker";
  /** Conditional maker-checker when an otherwise-R2 route narrows into R4. */
  approvalWhenNarrowing?: "maker_checker";
  /** Who may execute an approved R3/R4 command: only a party to the approval (its maker or its checker). */
  approvalExecutor?: "maker_or_checker";
  receipted?: boolean;
  stepUp?: boolean;
  recoveryIntent?: boolean;
  recoveryIntentWhenNarrowing?: boolean;
  requiresDryRunHash?: boolean;
  requiresEvidenceRef?: boolean;
  binding: { tenant: string | null; resource: AiBindingResource | "receipt" | null };
  requestSchema?: AiSchema;
  response?: string;
  registeredBy?: string;
  query?: Record<string, unknown>;
  /** Request fields that may transit to the owner but must never be persisted by Governance. */
  sensitiveFields?: string[];
}

export interface AiSchemaVector { routeId: string; name: string; body: unknown; valid: boolean }

export interface AiManagementContract {
  contractVersion: string;
  scopes: string[];
  actions: Record<string, string>;
  r3Actions: string[];
  commandResultEnvelope: string[];
  enums: Record<string, string[]>;
  bounds: { maxGraceDays: number; graceMaxFractionOfHard: number };
  routes: AiContractRoute[];
  schemaVectors: AiSchemaVector[];
}

// Loaded with createRequire (not a JSON import attribute) so the compiled service runs on any supported Node
// without an experimental-feature dependency; tsconfig includes the JSON so `npm run build` emits it beside this module.
const nodeRequire = createRequire(import.meta.url);
export const AI_CONTRACT = nodeRequire("../contracts/aiManagement.contract.json") as AiManagementContract;
export const AI_CONTRACT_VERSION = AI_CONTRACT.contractVersion;

export class UnknownAiRouteError extends Error {
  constructor(readonly routeId: string) {
    super(`'${routeId}' is not a route of the module_ai operator contract.`);
    this.name = "UnknownAiRouteError";
  }
}

export function aiRoute(routeId: string): AiContractRoute {
  const route = AI_CONTRACT.routes.find((entry) => entry.id === routeId);
  if (!route) throw new UnknownAiRouteError(routeId);
  return route;
}

export function aiRouteByAction(action: string): AiContractRoute | undefined {
  return AI_CONTRACT.routes.find((entry) => entry.action === action && entry.kind === "mutation");
}

/** The risk class an execution is ledgered at (provider state narrows to R4). */
export function effectiveRisk(route: AiContractRoute, body: Record<string, unknown>): AiRisk {
  if (route.riskNarrowing && body.status !== undefined && body.status !== "active") return route.riskNarrowing;
  return route.risk;
}

// ── path and target resolution ──────────────────────────────────────────

export const MANAGEMENT_V1 = "/management/v1";

export function ownerPath(route: AiContractRoute, params: Record<string, string>): string {
  return `${MANAGEMENT_V1}${route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (typeof value !== "string" || value === "") throw new Error(`route ${route.id} needs path parameter '${name}'`);
    return encodeURIComponent(value);
  })}`;
}

export interface AiTarget { targetTenantId?: string; targetResourceType?: string; targetResourceId?: string }

const MODEL_POLICY_DERIVED = "providerKey/(modelKey|*)";

/** The (tenant, resource pair) this route addresses — exactly what the owner binds the assertion to. */
export function resolveTarget(route: AiContractRoute, params: Record<string, string>, body: Record<string, unknown> = {}): AiTarget {
  const target: AiTarget = {};
  if (route.binding.tenant) {
    const tenantId = params[route.binding.tenant];
    if (!tenantId) throw new Error(`route ${route.id} needs path parameter '${route.binding.tenant}'`);
    target.targetTenantId = tenantId;
  }
  const resource = route.binding.resource;
  if (resource && resource !== "receipt") {
    target.targetResourceType = resource.type;
    if (resource.id.param) target.targetResourceId = params[resource.id.param];
    else if (resource.id.constant) target.targetResourceId = resource.id.constant;
    else if (resource.id.derived === MODEL_POLICY_DERIVED) target.targetResourceId = `${String(body.providerKey)}/${body.modelKey ? String(body.modelKey) : "*"}`;
    else throw new Error(`route ${route.id} declares an unknown derived resource rule '${resource.id.derived}'`);
    if (!target.targetResourceId) throw new Error(`route ${route.id} could not resolve its resource id`);
  } else if (route.binding.tenant) {
    // Tenant-bound routes with no explicit resource (state, credentials reads) address the tenant itself.
    target.targetResourceType = "tenant";
    target.targetResourceId = target.targetTenantId;
  }
  return target;
}

// ── strict request-body validation (independent implementation of the contract's schema subset) ──

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
};

const matchesType = (value: unknown, type: string): boolean => {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
};

export function validateAiSchema(schema: AiSchema, value: unknown, path = "$"): string[] {
  const types = [schema.type ?? []].flat();
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) return [`${path}: expected ${types.join("|")}`];
  if (value === null) return [];
  const violations: string[] = [];
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) violations.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) violations.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) violations.push(`${path}: does not match the required pattern`);
    if (schema.enum !== undefined && !schema.enum.includes(value)) violations.push(`${path}: must be one of ${schema.enum.join(", ")}`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) violations.push(`${path}: must be finite`);
    if (schema.minimum !== undefined && value < schema.minimum) violations.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) violations.push(`${path}: above ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) violations.push(`${path}: must exceed ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) violations.push(`${path}: must be below ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) violations.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) violations.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => violations.push(...validateAiSchema(schema.items as AiSchema, item, `${path}[${index}]`)));
  }
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in record)) violations.push(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(record)) {
      if (!(key in properties)) {
        if (schema.additionalProperties === false) violations.push(`${path}.${key}: unknown property`);
        continue;
      }
      violations.push(...validateAiSchema(properties[key] as AiSchema, item, `${path}.${key}`));
    }
  }
  return violations;
}

export class InvalidAiRequestError extends Error {
  readonly code = "AI_REQUEST_INVALID";
  readonly httpStatus = 400;
  constructor(readonly routeId: string, readonly violations: string[]) {
    super(`Invalid request for ${routeId}: ${violations.join("; ")}`);
    this.name = "InvalidAiRequestError";
  }
}

/** Validates a full owner request body (idempotencyKey + reason + fields) against the route's schema. */
export function validateAiBody(route: AiContractRoute, body: unknown): string[] {
  if (!route.requestSchema) return typeOf(body) === "object" && Object.keys(body as object).length === 0 ? [] : ["$: this route takes no body"];
  return validateAiSchema(route.requestSchema, body);
}

/**
 * The same schema with the idempotency key removed: R3 REQUEST bodies carry the reason and the fields
 * (the idempotency key belongs to the later execute step).
 */
export function requestSchemaWithoutIdempotency(route: AiContractRoute): AiSchema {
  const schema = route.requestSchema as AiSchema;
  const properties = { ...(schema.properties ?? {}) };
  delete properties.idempotencyKey;
  return { ...schema, required: (schema.required ?? []).filter((key) => key !== "idempotencyKey"), properties };
}
