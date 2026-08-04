import { describe, expect, it } from "vitest";
import {
  buildSupervisorFlowPayload,
  dagPayloadFromDrafts,
  defaultDagWorkKind,
  layoutSupervisorDag,
  scaffoldDagDrafts,
  supervisorDagDraftIssues,
  type DagNodeDraft
} from "./supervisorDag";
import type { SupervisorDagNodeKind, SupervisorGate, SupervisorWorkKind } from "./types";

const MEMBERS = new Set(["frontend", "backend", "tester", "integrator"]);

function draft(nodeId: string, roleId: string, needs: string[], kind: SupervisorDagNodeKind, patch: Partial<DagNodeDraft> = {}): DagNodeDraft {
  return {
    nodeId,
    roleId,
    needs,
    kind,
    task: `${nodeId} 的任务说明`,
    capabilitiesText: "",
    workKind: defaultDagWorkKind(kind),
    changeSet: "",
    required: true,
    ...patch
  };
}

/** tester 角色槽在 frontend-test / backend-test / integration-test 三个环节复用。 */
function branchFlowDrafts(): DagNodeDraft[] {
  return [
    draft("frontend-task", "frontend", [], "task", { workKind: "code", changeSet: "frontend" }),
    draft("backend-task", "backend", [], "task", { workKind: "code", changeSet: "backend" }),
    draft("frontend-test", "tester", ["frontend-task"], "test", { capabilitiesText: "quality.test" }),
    draft("backend-test", "tester", ["backend-task"], "test", { capabilitiesText: "quality.test" }),
    draft("merge", "integrator", ["frontend-test", "backend-test"], "merge", { capabilitiesText: "code.integration" }),
    draft("integration-test", "tester", ["merge"], "integration-test", { capabilitiesText: "quality.test" })
  ];
}

describe("supervisor DAG drafts", () => {
  it("accepts the branch → tests → merge → integration-test flow with one tester role reused across three nodes", () => {
    const issues = supervisorDagDraftIssues(branchFlowDrafts(), MEMBERS);
    expect(issues).toEqual([]);
  });

  it("scaffolds a valid example aligned to the team's member role slots", () => {
    const drafts = scaffoldDagDrafts(["frontend", "backend", "tester", "integrator"]);
    expect(supervisorDagDraftIssues(drafts, MEMBERS)).toEqual([]);
    expect(drafts.map((node) => node.kind)).toEqual(["task", "task", "test", "test", "merge", "integration-test"]);
    expect(drafts.find((node) => node.nodeId === "merge")).toMatchObject({
      roleId: "integrator",
      capabilitiesText: "code.integration"
    });
    expect(drafts.filter((node) => node.roleId === "tester")).toHaveLength(3);
  });

  it("flags duplicate nodeId, unknown needs, self dependency and unknown member roles deterministically", () => {
    const issues = supervisorDagDraftIssues([
      draft("build", "frontend", [], "task"),
      draft("build", "backend", [], "task"),
      draft("verify", "ghost-role", ["missing-node"], "test"),
      draft("selfish", "tester", ["selfish"], "test")
    ], MEMBERS);
    expect(issues).toContain("DAG 节点 nodeId 重复：build");
    expect(issues).toContain("DAG 节点 verify 依赖了未知节点 missing-node");
    expect(issues).toContain("DAG 节点 selfish 不能依赖自身");
    expect(issues).toContain("DAG 节点 verify 引用了不存在的成员角色 ghost-role");
  });

  it("requires merge nodes to directly depend on at least two test nodes", () => {
    const singleTest = supervisorDagDraftIssues([
      draft("frontend-test", "tester", [], "test"),
      draft("merge", "integrator", ["frontend-test"], "merge")
    ], MEMBERS);
    expect(singleTest).toContain("合并节点 merge 必须直接依赖至少两个 test 节点");
    const nonTestNeeds = supervisorDagDraftIssues([
      draft("frontend-task", "frontend", [], "task"),
      draft("backend-task", "backend", [], "task"),
      draft("merge", "integrator", ["frontend-task", "backend-task"], "merge")
    ], MEMBERS);
    expect(nonTestNeeds).toContain("合并节点 merge 必须直接依赖至少两个 test 节点");
  });

  it("requires integration-test nodes to directly depend on a merge node", () => {
    const issues = supervisorDagDraftIssues([
      draft("frontend-test", "tester", [], "test"),
      draft("integration-test", "tester", ["frontend-test"], "integration-test")
    ], MEMBERS);
    expect(issues).toContain("集成测试节点 integration-test 必须直接依赖一个 merge 节点");
  });

  it("detects dependency cycles instead of looping forever", () => {
    const issues = supervisorDagDraftIssues([
      draft("cycle-one", "frontend", ["cycle-two"], "task"),
      draft("cycle-two", "backend", ["cycle-one"], "task")
    ], MEMBERS);
    expect(issues.some((issue) => issue.startsWith("DAG 存在循环依赖"))).toBe(true);
  });
});

describe("supervisor flow save payload", () => {
  const gates: SupervisorGate[] = [{
    id: "quality",
    requiredCapability: "quality.test",
    mode: "before-completion",
    required: true,
    instructions: "验证交付并提供证据。",
    fallback: "supervisor"
  }];

  it("keeps existing stages/gates untouched and appends dag only when enabled", () => {
    const dag = dagPayloadFromDrafts(branchFlowDrafts());
    const payload = buildSupervisorFlowPayload(gates, dag);
    expect(payload.stages.map((stage) => stage.id)).toEqual(["plan", "delegation-loop", "gate-quality", "delivery"]);
    expect(payload.gates).toEqual(gates);
    expect(payload.gates[0]).not.toBe(gates[0]);
    expect(payload.dag?.nodes.map((node) => [node.nodeId, node.roleId, node.kind])).toEqual([
      ["frontend-task", "frontend", "task"],
      ["backend-task", "backend", "task"],
      ["frontend-test", "tester", "test"],
      ["backend-test", "tester", "test"],
      ["merge", "integrator", "merge"],
      ["integration-test", "tester", "integration-test"]
    ]);
    const testerNodes = payload.dag!.nodes.filter((node) => node.roleId === "tester");
    expect(testerNodes.map((node) => node.nodeId)).toEqual(["frontend-test", "backend-test", "integration-test"]);
    expect(payload.dag!.nodes[2]).toMatchObject({ requiredCapabilities: ["quality.test"], workKind: "test", required: true });
  });

  it("omits dag entirely when the DAG is not enabled so legacy workflows behave unchanged", () => {
    const payload = buildSupervisorFlowPayload(gates);
    expect(payload).not.toHaveProperty("dag");
    expect(payload.stages.map((stage) => stage.kind)).toEqual(["supervisor", "delegation-loop", "gate", "delivery"]);
  });

  it("normalizes capability text, trims changeSet and drops empty changeSet", () => {
    const dag = dagPayloadFromDrafts([
      draft("build", "frontend", [], "task", { capabilitiesText: " code.frontend,\nquality.test ", changeSet: "  " })
    ]);
    expect(dag.nodes[0]).toMatchObject({ requiredCapabilities: ["code.frontend", "quality.test"] });
    expect(dag.nodes[0]).not.toHaveProperty("changeSet");
  });
});

describe("supervisor DAG layout", () => {
  it("lays out branch, fan-in and integration-test stages as distinct left-to-right layers", () => {
    const layout = layoutSupervisorDag(dagPayloadFromDrafts(branchFlowDrafts()).nodes);
    const depthOf = (nodeId: string) => layout.nodes.find((item) => item.node.nodeId === nodeId)?.depth;
    expect(depthOf("frontend-task")).toBe(0);
    expect(depthOf("backend-task")).toBe(0);
    expect(depthOf("frontend-test")).toBe(1);
    expect(depthOf("backend-test")).toBe(1);
    expect(depthOf("merge")).toBe(2);
    expect(depthOf("integration-test")).toBe(3);
    const sameLayer = layout.nodes.filter((item) => item.depth === 1);
    expect(new Set(sameLayer.map((item) => item.y)).size).toBe(2);
    expect(layout.edges).toContainEqual({ from: "frontend-test", to: "merge" });
    expect(layout.edges).toContainEqual({ from: "backend-test", to: "merge" });
    expect(layout.edges).toContainEqual({ from: "merge", to: "integration-test" });
    expect(layout.cyclic).toBe(false);
  });

  it("marks cyclic graphs so the canvas can warn instead of mis-layering", () => {
    const layout = layoutSupervisorDag([
      { nodeId: "a", roleId: "frontend", needs: ["b"], kind: "task", task: "A", requiredCapabilities: [], workKind: "code" as SupervisorWorkKind, required: true },
      { nodeId: "b", roleId: "backend", needs: ["a"], kind: "task", task: "B", requiredCapabilities: [], workKind: "code" as SupervisorWorkKind, required: true }
    ]);
    expect(layout.cyclic).toBe(true);
  });
});
