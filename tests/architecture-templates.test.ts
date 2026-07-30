import { describe, expect, it } from "vitest";
import { instantiateArchitectureTemplate, listArchitectureTemplates } from "../src/architectures/templates.js";

describe("architecture graph templates", () => {
  it("exposes a focused launch set without adding runtime adapters", () => {
    const templates = listArchitectureTemplates();
    expect(templates.map((template) => template.id)).toEqual([
      "sequential-pipeline",
      "parallel-fanout-gather",
      "review-council",
      "plan-execute-synthesize"
    ]);
    expect(templates.every((template) => template.slots.length >= 3)).toBe(true);
  });

  it("instantiates deterministic DAGs from ordered employee slot assignments", () => {
    const sequential = instantiateArchitectureTemplate("sequential-pipeline", ["planner", "builder", "reviewer"]);
    expect(sequential.nodes.map((node) => [node.id, node.employeeId, node.needs])).toEqual([
      ["discover", "planner", []],
      ["execute", "builder", ["discover"]],
      ["verify", "reviewer", ["execute"]]
    ]);

    const parallel = instantiateArchitectureTemplate("parallel-fanout-gather", ["left", "right", "judge"]);
    expect(parallel.nodes[2]?.needs).toEqual(["track-a", "track-b"]);

    const council = instantiateArchitectureTemplate("review-council", ["writer", "product", "engineer", "chair"]);
    expect(council.nodes.at(-1)?.needs).toEqual(["review-product", "review-delivery"]);
  });

  it("rejects incomplete slot mapping", () => {
    expect(() => instantiateArchitectureTemplate("review-council", ["writer", "reviewer"])).toThrow(/requires 4/);
  });
});
