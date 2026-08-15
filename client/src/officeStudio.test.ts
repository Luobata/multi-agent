import { describe, expect, it } from "vitest";
import { activeSupervisorInvocations, completionRatio, historicalExceptionCount, progressTone, studioSupervisorInvocations } from "./officeStudio";
import type { InvocationRecord, WorkInstanceStatus } from "./types";

function tally(overrides: Partial<Record<WorkInstanceStatus, number>>): Record<WorkInstanceStatus, number> {
  return { queued: 0, waiting: 0, running: 0, "cancellation-requested": 0, completed: 0, blocked: 0, failed: 0, skipped: 0, cancelled: 0, ...overrides };
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
  it("measures actionable delivery progress without counting retained failure history", () => {
    expect(completionRatio(tally({ completed: 2, running: 2 }))).toBe(0.5);
    expect(completionRatio(tally({ completed: 2, failed: 3, blocked: 1 }))).toBe(1);
    expect(completionRatio(tally({ failed: 2 }))).toBe(0);
    expect(completionRatio(tally({}))).toBe(0);
    expect(completionRatio(tally({ completed: 3 }))).toBe(1);
  });
});

describe("historicalExceptionCount", () => {
  it("keeps failed attempts visible outside the progress denominator", () => {
    expect(historicalExceptionCount(tally({ failed: 2, blocked: 1, skipped: 1, cancelled: 1 }))).toBe(5);
  });
});

describe("progressTone", () => {
  it("maps status to a tone", () => {
    expect(progressTone("running")).toBe("running");
    expect(progressTone("queued")).toBe("running");
    expect(progressTone("cancellation-requested")).toBe("running");
    expect(progressTone("awaiting-human-decision")).toBe("confirmation");
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

describe("studioSupervisorInvocations", () => {
  const NOW = 1_000_000;
  const supervisor = (id: string, overrides: Partial<InvocationRecord>): InvocationRecord => ({ ...base, id, ...overrides });

  it("keeps active supervisors and recently-completed ones within the grace window", () => {
    const active = supervisor("inv-active", { status: "running" });
    const justDone = supervisor("inv-done", { status: "completed", completedAt: new Date(NOW - 10_000).toISOString() });
    const longDone = supervisor("inv-old", { status: "completed", completedAt: new Date(NOW - 90_000).toISOString() });
    const noStamp = supervisor("inv-nostamp", { status: "failed" });
    const graph: InvocationRecord = { ...base, id: "inv-graph", status: "running", executionSnapshot: { workflow: { id: "g", version: 1, architecture: "graph" }, employees: [] } };
    const result = studioSupervisorInvocations([active, justDone, longDone, noStamp, graph], NOW).map((i) => i.id);
    expect(result).toEqual(["inv-active", "inv-done"]);
  });

  it("honors a custom grace window", () => {
    const justDone = supervisor("inv-done", { status: "blocked", completedAt: new Date(NOW - 10_000).toISOString() });
    expect(studioSupervisorInvocations([justDone], NOW, 5_000).map((i) => i.id)).toEqual([]);
    expect(studioSupervisorInvocations([justDone], NOW, 20_000).map((i) => i.id)).toEqual(["inv-done"]);
  });
});
