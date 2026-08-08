import { describe, it, expect } from "vitest";
import type { WorkflowChangeRequest, WorkflowChangeOperation } from "../src/workbench/types.js";

describe("WorkflowChangeRequest types", () => {
  it("shapes an add-gate operation", () => {
    const op: WorkflowChangeOperation = {
      kind: "add-gate",
      gate: { id: "g1", requiredCapability: "quality.test", mode: "before-completion", required: true, instructions: "x", fallback: "block", validatorId: "e2e-evidence" },
      rationale: "r", risk: "low"
    };
    const req: WorkflowChangeRequest = {
      id: "wc-1", workflowId: "w", workflowVersion: 1, status: "awaiting-approval",
      title: "t", reason: "r", requestedBy: "gate-steward", operations: [op],
      createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z"
    };
    expect(req.operations[0]?.kind).toBe("add-gate");
  });
});
