import { describe, expect, it } from "vitest";

import {
  isValidTransition,
  isOperationStatus,
  isTerminalStatus,
  toIdempotencyKeyStatus,
  allowedNextStatuses,
} from "../../../src/management/operations/lifecycle.js";

describe("management/operations/lifecycle", () => {
  it("accepts the documented forward path", () => {
    expect(isValidTransition("submitted", "accepted")).toBe(true);
    expect(isValidTransition("accepted", "running")).toBe(true);
    expect(isValidTransition("running", "partially_completed")).toBe(true);
    expect(isValidTransition("running", "completed")).toBe(true);
    expect(isValidTransition("running", "failed")).toBe(true);
    expect(isValidTransition("partially_completed", "compensating")).toBe(true);
    expect(isValidTransition("partially_completed", "completed")).toBe(true);
    expect(isValidTransition("compensating", "completed")).toBe(true);
  });

  it("rejects skipping a stage", () => {
    expect(isValidTransition("submitted", "completed")).toBe(false);
    expect(isValidTransition("submitted", "running")).toBe(false);
    expect(isValidTransition("accepted", "completed")).toBe(false);
  });

  it("rejects any transition out of a terminal state", () => {
    expect(allowedNextStatuses("completed")).toEqual([]);
    expect(allowedNextStatuses("failed")).toEqual([]);
    expect(isValidTransition("completed", "running")).toBe(false);
    expect(isValidTransition("failed", "accepted")).toBe(false);
  });

  it("rejects moving backwards", () => {
    expect(isValidTransition("running", "accepted")).toBe(false);
    expect(isValidTransition("accepted", "submitted")).toBe(false);
  });

  it("isOperationStatus rejects unknown values", () => {
    expect(isOperationStatus("submitted")).toBe(true);
    expect(isOperationStatus("not_a_status")).toBe(false);
    expect(isOperationStatus(42)).toBe(false);
  });

  it("isTerminalStatus", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
  });

  it("maps the 7-state lifecycle onto 0002's 3-value idempotency status", () => {
    expect(toIdempotencyKeyStatus("submitted")).toBe("in_progress");
    expect(toIdempotencyKeyStatus("accepted")).toBe("in_progress");
    expect(toIdempotencyKeyStatus("running")).toBe("in_progress");
    expect(toIdempotencyKeyStatus("compensating")).toBe("in_progress");
    expect(toIdempotencyKeyStatus("completed")).toBe("completed");
    expect(toIdempotencyKeyStatus("partially_completed")).toBe("completed");
    expect(toIdempotencyKeyStatus("failed")).toBe("failed");
  });
});
