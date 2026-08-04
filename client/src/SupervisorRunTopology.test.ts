import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { layoutSupervisorRun, SupervisorRunTopology } from "./SupervisorRunTopology";
import type { RunNode } from "./types";

function node(
  nodeId: string,
  roleId: string,
  kind: "supervisor" | "member",
  round: number,
  status: RunNode["status"] = "passed"
): RunNode {
  return { nodeId, roleId, metadata: { kind, round }, status, attempts: 1 };
}

describe("Supervisor runtime topology", () => {
  it("lays out time-expanded supervisor rounds without inventing a static workflow graph", () => {
    const layout = layoutSupervisorRun([
      node("supervisor-r1", "supervisor", "supervisor", 1),
      node("research-r1-1", "research", "member", 1),
      node("build-r1-2", "build", "member", 1),
      node("supervisor-r2", "supervisor", "supervisor", 2)
    ]);
    expect(layout.nodes.map((item) => [item.id, item.round, item.kind])).toEqual([
      ["supervisor-r1", 1, "supervisor"],
      ["research-r1-1", 1, "member"],
      ["build-r1-2", 1, "member"],
      ["supervisor-r2", 2, "supervisor"]
    ]);
    expect(layout.edges).toEqual([
      { from: "supervisor-r1", to: "research-r1-1" },
      { from: "supervisor-r1", to: "build-r1-2" },
      { from: "research-r1-1", to: "supervisor-r2" },
      { from: "build-r1-2", to: "supervisor-r2" }
    ]);
  });

  it("renders a non-color status label and preserves the full long id as accessible SVG text", () => {
    const longId = "independent-release-reviewer-r1-1";
    const markup = renderToStaticMarkup(createElement(SupervisorRunTopology, { nodes: [
      node(longId, "independent-release-reviewer", "member", 1, "failed")
    ] }));
    expect(markup).toContain("× failed");
    expect(markup).toContain(`<title>independent-release-reviewer · ${longId} · failed</title>`);
    expect(markup).toContain("…");
  });

  it("shows DAG flowNodeId/kind so one tester role reads as distinct frontend/backend/integration stages", () => {
    const dagNode = (nodeId: string, kind: string, status: RunNode["status"] = "passed"): RunNode => ({
      nodeId,
      roleId: "tester",
      metadata: { kind: "member", round: 2, flowNodeId: nodeId, flowNodeKind: kind, flowNodeExecution: 1 },
      status,
      attempts: 1
    });
    const layout = layoutSupervisorRun([
      node("supervisor-r2", "supervisor", "supervisor", 2),
      dagNode("frontend-test", "test"),
      dagNode("backend-test", "test"),
      node("supervisor-r4", "supervisor", "supervisor", 4),
      dagNode("integration-test", "integration-test", "running")
    ]);
    expect(layout.nodes.filter((item) => item.roleId === "tester").map((item) => [item.id, item.flowNodeId, item.flowNodeKind])).toEqual([
      ["frontend-test", "frontend-test", "test"],
      ["backend-test", "backend-test", "test"],
      ["integration-test", "integration-test", "integration-test"]
    ]);
    const markup = renderToStaticMarkup(createElement(SupervisorRunTopology, { nodes: [
      dagNode("frontend-test", "test"),
      dagNode("integration-test", "integration-test", "running")
    ] }));
    expect(markup).toContain("环节 frontend-test [test]");
    expect(markup).toContain("环节 integration-test [integration-test]");
    expect(markup).toContain("<title>tester · 环节 integration-test [integration-test] · integration-test · running</title>");
    expect(markup).toContain("▶ running");
  });
});
