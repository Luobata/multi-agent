import { describe, expect, it } from "vitest";
import { layoutTopology } from "../client/src/topology.js";

describe("workbench topology layout", () => {
  it("places independent nodes together and dependent nodes in later layers", () => {
    const layout = layoutTopology([
      { id: "research", employeeId: "researcher", needs: [], with: {} },
      { id: "review", employeeId: "reviewer", needs: [], with: {} },
      { id: "decision", employeeId: "chair", needs: ["research", "review"], with: {} }
    ]);
    expect(layout.cyclic).toBe(false);
    expect(layout.nodes.find((node) => node.id === "research")?.depth).toBe(0);
    expect(layout.nodes.find((node) => node.id === "review")?.depth).toBe(0);
    expect(layout.nodes.find((node) => node.id === "decision")?.depth).toBe(1);
    expect(layout.edges).toHaveLength(2);
  });

  it("marks cyclic drafts without recursing forever", () => {
    const layout = layoutTopology([
      { id: "one", employeeId: "a", needs: ["two"], with: {} },
      { id: "two", employeeId: "b", needs: ["one"], with: {} }
    ]);
    expect(layout.cyclic).toBe(true);
    expect(layout.nodes).toHaveLength(2);
  });
});
