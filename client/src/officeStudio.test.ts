import { describe, expect, it } from "vitest";
import { activeSupervisorInvocations, completionRatio, progressTone } from "./officeStudio";
import type { InvocationRecord, WorkInstanceStatus } from "./types";

function tally(overrides: Partial<Record<WorkInstanceStatus, number>>): Record<WorkInstanceStatus, number> {
  return { queued: 0, waiting: 0, running: 0, completed: 0, blocked: 0, failed: 0, skipped: 0, cancelled: 0, ...overrides };
}

const base: InvocationRecord = {
  id: "inv-1",
  target: { kind: "workflow", id: "team-flow", version: 1 },
  source: { kind: "workbench" },
  status: "running",
  phase: "provider",
  requestSummary: "team task",
  runId: "run-1",
  instanceIds: [],
  executionSnapshot: { workflow: { id: "team-flow", version: 1, architecture: "supervisor" }, employees: [] },
  createdAt: "t",
  updatedAt: "t",
  transitions: []
};

describe("completionRatio", () => {
  it("returns completed over total, 0 when empty", () => {
    expect(completionRatio(tally({ completed: 2, running: 2 }))).toBe(0.5);
    expect(completionRatio(tally({}))).toBe(0);
    expect(completionRatio(tally({ completed: 3 }))).toBe(1);
  });
});

describe("progressTone", () => {
  it("maps status to a tone", () => {
    expect(progressTone("running")).toBe("running");
    expect(progressTone("queued")).toBe("running");
    expect(progressTone("completed")).toBe("completed");
    expect(progressTone("blocked")).toBe("blocked");
    expect(progressTone("failed")).toBe("failed");
    expect(progressTone("cancelled")).toBe("failed");
  });
});

describe("activeSupervisorInvocations", () => {
  it("keeps only supervisor, non-terminal invocations", () => {
    const graph: InvocationRecord = { ...base, id: "inv-2", executionSnapshot: { workflow: { id: "g", version: 1, architecture: "graph" }, employees: [] } };
    const doneSupervisor: InvocationRecord = { ...base, id: "inv-3", status: "completed" };
    expect(activeSupervisorInvocations([base, graph, doneSupervisor]).map((invocation) => invocation.id)).toEqual(["inv-1"]);
  });
});
