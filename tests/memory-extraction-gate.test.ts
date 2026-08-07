import { describe, it, expect } from "vitest";
import { shouldExtract } from "../src/memory/extractionGate.js";

const run = (status: string, nodeCount: number) => ({
  status,
  nodes: Object.fromEntries(Array.from({ length: nodeCount }, (_, i) => [`n${i}`, { status: "completed" }]))
});

describe("shouldExtract", () => {
  it("extracts failed runs (lessons)", () => {
    expect(shouldExtract(run("failed", 1)).extract).toBe(true);
  });
  it("extracts blocked runs", () => {
    expect(shouldExtract(run("blocked", 1)).extract).toBe(true);
  });
  it("skips cancelled runs", () => {
    expect(shouldExtract(run("cancelled", 3)).extract).toBe(false);
  });
  it("skips trivial single-node completed runs", () => {
    expect(shouldExtract(run("completed", 1)).extract).toBe(false);
  });
  it("extracts multi-node completed runs", () => {
    expect(shouldExtract(run("completed", 3)).extract).toBe(true);
  });
});
