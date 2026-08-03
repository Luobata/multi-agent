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
});
