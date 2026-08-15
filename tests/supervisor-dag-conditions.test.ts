import { describe, expect, it } from "vitest";
import {
  supervisorDagHasFreshCandidateEvidence,
  supervisorDagHasFreshDependencyEvidence,
  supervisorDagIssues,
  supervisorDagNodeReady,
  supervisorDagSnapshot,
  type SupervisorDagConfig,
  type SupervisorDagNodeTracker
} from "../src/architectures/supervisorDag.js";

function trackers(dag: SupervisorDagConfig): Map<string, SupervisorDagNodeTracker> {
  return new Map(dag.nodes.map((node) => [node.nodeId, { node, status: "pending", executions: [] }]));
}

const node = (nodeId: string, needs: string[] = []): SupervisorDagConfig["nodes"][number] => ({
  nodeId,
  roleId: "worker",
  needs,
  kind: "task",
  task: nodeId,
  requiredCapabilities: [],
  workKind: "other",
  required: true
});

describe("Supervisor DAG conditional dependencies", () => {
  it("keeps passed-only as the default and permits an explicit blocked observation", () => {
    const dag: SupervisorDagConfig = { nodes: [
      node("validate"),
      { ...node("repair", ["validate"]), needsWhen: [{ nodeId: "validate", statuses: ["blocked", "failed"] }] }
    ] };
    const state = trackers(dag);
    state.get("validate")!.status = "blocked";
    expect(supervisorDagNodeReady(state.get("repair")!.node, state)).toBe(true);
    expect(supervisorDagNodeReady({ ...node("ordinary", ["validate"]) }, state)).toBe(false);
    expect(supervisorDagSnapshot(state)).toMatchObject({ nodes: [
      expect.objectContaining({
        nodeId: "validate",
        ready: false,
        whyNotRunning: [expect.objectContaining({ kind: "terminal", status: "blocked" })]
      }),
      expect.objectContaining({ nodeId: "repair", ready: true, needsWhen: [{ nodeId: "validate", statuses: ["blocked", "failed"] }] })
    ] });
  });

  it("explains every unmet dependency for a pending node", () => {
    const dag: SupervisorDagConfig = { nodes: [
      node("build"),
      node("review"),
      node("release", ["build", "review"])
    ] };
    const state = trackers(dag);
    state.get("build")!.status = "running";
    state.get("review")!.status = "blocked";

    expect(supervisorDagSnapshot(state)).toMatchObject({ nodes: [
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        nodeId: "release",
        ready: false,
        whyNotRunning: [
          { kind: "dependency", nodeId: "build", status: "running", expectedStatuses: ["passed"] },
          { kind: "dependency", nodeId: "review", status: "blocked", expectedStatuses: ["passed"] }
        ]
      })
    ] });
  });

  it("treats terminal as every terminal status", () => {
    const dag: SupervisorDagConfig = { nodes: [
      node("upstream"),
      { ...node("observer", ["upstream"]), needsWhen: [{ nodeId: "upstream", statuses: ["terminal"] }] }
    ] };
    for (const status of ["passed", "blocked", "failed", "skipped"] as const) {
      const state = trackers(dag);
      state.get("upstream")!.status = status;
      expect(supervisorDagNodeReady(state.get("observer")!.node, state)).toBe(true);
    }
  });

  it("reopens a passed conditional node only for a fresh matching dependency execution", () => {
    const dag: SupervisorDagConfig = { nodes: [
      node("validate"),
      { ...node("repair", ["validate"]), needsWhen: [{ nodeId: "validate", statuses: ["blocked", "failed"] }] }
    ] };
    const state = trackers(dag);
    const validation = state.get("validate")!;
    const repair = state.get("repair")!;
    validation.status = "blocked";
    validation.executions.push({ nodeId: "validate", status: "blocked", output: null, error: null, dependencyNodeIds: [] });
    repair.status = "passed";
    repair.executions.push({
      nodeId: "repair",
      status: "passed",
      output: null,
      error: null,
      dependencyNodeIds: ["validate"]
    });

    expect(supervisorDagHasFreshDependencyEvidence(repair, state)).toBe(false);
    validation.executions.push({ nodeId: "validate-retry-2", status: "blocked", output: null, error: null, dependencyNodeIds: [] });
    expect(supervisorDagHasFreshDependencyEvidence(repair, state)).toBe(true);
    expect(supervisorDagSnapshot(state)).toMatchObject({ nodes: [
      expect.anything(),
      expect.objectContaining({ nodeId: "repair", status: "passed", ready: true })
    ] });

    repair.executions.push({
      nodeId: "repair-retry-2",
      status: "passed",
      output: null,
      error: null,
      dependencyNodeIds: ["validate-retry-2"]
    });
    expect(supervisorDagHasFreshDependencyEvidence(repair, state)).toBe(false);
    validation.status = "passed";
    validation.executions.push({ nodeId: "validate-retry-3", status: "passed", output: null, error: null, dependencyNodeIds: [] });
    expect(supervisorDagHasFreshDependencyEvidence(repair, state)).toBe(false);
  });

  it("reopens passed validation only once for each newer candidate execution", () => {
    const dag: SupervisorDagConfig = { nodes: [
      { ...node("validate"), kind: "test", workKind: "test" },
      { ...node("repair"), workKind: "code" }
    ] };
    const state = trackers(dag);
    const validation = state.get("validate")!;
    const repair = state.get("repair")!;
    repair.status = "passed";
    repair.executions.push({ nodeId: "repair", status: "passed", output: null, error: null });
    validation.status = "passed";
    validation.executions.push({
      nodeId: "validate",
      status: "passed",
      output: null,
      error: null,
      candidateNodeIds: ["repair"]
    });

    expect(supervisorDagHasFreshCandidateEvidence(validation, state)).toBe(false);
    repair.executions.push({ nodeId: "repair-retry-2", status: "passed", output: null, error: null });
    expect(supervisorDagHasFreshCandidateEvidence(validation, state)).toBe(true);
    expect(supervisorDagSnapshot(state)).toMatchObject({ nodes: [
      expect.objectContaining({ nodeId: "validate", status: "passed", ready: true }),
      expect.anything()
    ] });

    validation.executions.push({
      nodeId: "validate-retry-2",
      status: "passed",
      output: null,
      error: null,
      candidateNodeIds: ["repair-retry-2"]
    });
    expect(supervisorDagHasFreshCandidateEvidence(validation, state)).toBe(false);
  });

  it("fails closed for unknown, duplicate, non-needs, and empty conditions", () => {
    const dag: SupervisorDagConfig = { nodes: [
      node("upstream"),
      {
        ...node("consumer", ["upstream"]),
        needsWhen: [
          { nodeId: "missing", statuses: [] },
          { nodeId: "missing", statuses: ["blocked"] }
        ]
      },
      {
        ...node("invalid-statuses", ["upstream"]),
        needsWhen: [{
          nodeId: "upstream",
          statuses: ["blocked", "blocked", "unknown"] as never
        }]
      }
    ] };
    expect(supervisorDagIssues("conditional", dag, new Set(["worker"]))).toEqual(expect.arrayContaining([
      expect.stringContaining("duplicate needsWhen"),
      expect.stringContaining("must reference a needs node"),
      expect.stringContaining("statuses must not be empty"),
      expect.stringContaining("duplicate statuses"),
      expect.stringContaining("unsupported status unknown")
    ]));
  });
});
