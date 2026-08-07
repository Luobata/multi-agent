import { describe, it, expect } from "vitest";
import { shouldExtract } from "../src/memory/extractionGate.js";

// Runner vocabulary (src/runtime/runner.ts): a finished run is "passed" | "blocked" | "failed".
// There is no "completed" run status — the gate must match the real vocabulary.
const run = (status: string, nodeCount: number) => ({
  status,
  nodes: Object.fromEntries(Array.from({ length: nodeCount }, (_, i) => [`n${i}`, { status: "passed" }]))
});

describe("shouldExtract", () => {
  it("extracts failed runs (lessons)", () => {
    expect(shouldExtract(run("failed", 1)).extract).toBe(true);
  });
  it("extracts blocked runs", () => {
    expect(shouldExtract(run("blocked", 1)).extract).toBe(true);
  });
  it("skips trivial single-node passed runs", () => {
    expect(shouldExtract(run("passed", 1)).extract).toBe(false);
  });
  it("extracts multi-node passed runs", () => {
    expect(shouldExtract(run("passed", 3)).extract).toBe(true);
  });
  it("skips unknown/incomplete statuses", () => {
    expect(shouldExtract(run("running", 3)).extract).toBe(false);
  });
});
