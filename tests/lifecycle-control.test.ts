import { describe, expect, it } from "vitest";
import { invocationControlProjection } from "../src/workbench/lifecycleControl.js";
import type { InvocationRecord } from "../src/workbench/types.js";

const base: InvocationRecord = {
  id: "inv-1",
  target: { kind: "workflow", id: "flow", version: 1 },
  source: { kind: "workbench", project: "project", taskId: "task", contextId: "requirement-lineage:goal-1" },
  status: "running",
  phase: "provider",
  requestSummary: "task",
  runId: "run-1",
  instanceIds: [],
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
  transitions: []
};

describe("invocation control projection", () => {
  it.each([
    ["running", ["monitor", "cancel"]],
    ["awaiting-human-decision", ["decide", "cancel"]],
    ["cancellation-requested", ["monitor"]],
    ["completed", ["review-delivery", "view-evidence"]],
    ["blocked", ["view-evidence", "retry-successor", "abandon-goal"]],
    ["failed", ["view-evidence", "retry-successor", "abandon-goal"]],
    ["cancelled", ["view-evidence", "restart-successor", "abandon-goal"]]
  ] as const)("maps %s to explicit legal actions", (status, actions) => {
    expect(invocationControlProjection({ ...base, status }).allowedActions).toEqual(actions);
  });

  it("derives immutable successor lineage without rewriting persisted invocations", () => {
    const second = {
      ...base,
      id: "inv-2",
      runId: "run-2",
      status: "queued" as const,
      createdAt: "2026-08-15T01:00:00.000Z"
    };
    expect(invocationControlProjection(second, [{ ...base, status: "blocked" }, second]).lineage).toEqual({
      rootInvocationId: "inv-1",
      predecessorInvocationId: "inv-1",
      cycle: 2
    });
  });
});
