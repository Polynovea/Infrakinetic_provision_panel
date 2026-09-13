// 1A.5 — durable operation lifecycle (master plan §60). Encodes which
// transitions are valid so an invalid one fails closed at the service layer
// rather than silently corrupting the ledger's meaning.

export const OPERATION_STATUSES = [
  "submitted",
  "accepted",
  "running",
  "partially_completed",
  "failed",
  "compensating",
  "completed",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export function isOperationStatus(value: unknown): value is OperationStatus {
  return typeof value === "string" && (OPERATION_STATUSES as readonly string[]).includes(value);
}

export const TERMINAL_STATUSES: readonly OperationStatus[] = ["completed", "failed"];

export function isTerminalStatus(status: OperationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// Adjacency list of allowed forward transitions. There is no path back to
// "submitted"/"accepted" from anywhere, and both terminal states have no
// outgoing edges at all — a completed or failed operation is done.
const ALLOWED_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = Object.freeze({
  submitted: ["accepted", "failed"],
  accepted: ["running", "failed"],
  running: ["partially_completed", "completed", "failed"],
  partially_completed: ["compensating", "completed", "failed"],
  compensating: ["completed", "failed"],
  failed: [],
  completed: [],
});

export function isValidTransition(from: OperationStatus, to: OperationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function allowedNextStatuses(from: OperationStatus): readonly OperationStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

// Maps the rich 7-state operation lifecycle onto 0002's 3-value
// management_idempotency_keys.status vocabulary. See
// migrations/0003_management_operation_ledger.sql's header for why this is
// an application-level mapping rather than a 4th schema value: from the
// idempotency guard's point of view, "a durable result exists, replay is
// safe" is true the moment an operation leaves the in-flight set, whatever
// the business outcome was.
export function toIdempotencyKeyStatus(status: OperationStatus): "in_progress" | "completed" | "failed" {
  if (status === "failed") return "failed";
  if (status === "completed" || status === "partially_completed") return "completed";
  return "in_progress"; // submitted | accepted | running | compensating
}
