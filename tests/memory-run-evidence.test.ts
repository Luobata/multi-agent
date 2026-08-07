import { describe, it, expect } from "vitest";
import { buildRunEvidence, type RunLike } from "../src/memory/extractor.js";

const run = (over: Partial<RunLike> = {}): RunLike => ({
  id: "run_1",
  status: "passed",
  nodes: {
    "supervisor-r1": { status: "passed", output: { action: "delegate", summary: "先做最小方案" } },
    "engineer-r1-1": { status: "passed", output: { message: "实现了最近浏览入口" } }
  },
  output: { summary: "交付最近浏览入口", result: { answer: "done" } },
  ...over
});

describe("buildRunEvidence", () => {
  it("includes run id, status, node statuses, node outputs and final output", () => {
    const text = buildRunEvidence(run());
    expect(text).toContain("run_1");
    expect(text).toContain("passed");
    expect(text).toContain("supervisor-r1");
    expect(text).toContain("先做最小方案");
    expect(text).toContain("实现了最近浏览入口");
    expect(text).toContain("交付最近浏览入口");
  });

  it("tolerates nodes without output", () => {
    const text = buildRunEvidence(run({ nodes: { a: { status: "passed" } }, output: undefined }));
    expect(text).toContain("run_1");
    expect(text).toContain("a");
  });

  it("caps total length to avoid oversized prompts", () => {
    const big = "x".repeat(20000);
    const text = buildRunEvidence(run({ output: { summary: big } }));
    expect(text.length).toBeLessThanOrEqual(8000);
  });
});
