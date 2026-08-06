// tests/memory-extractor.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.js";
import { MemoryExtractor, type RunLike } from "../src/memory/extractor.js";
import type { MemoryScope } from "../src/memory/types.js";

const scope: MemoryScope = { employeeId: "r", employeeVersion: 1, projectId: "cart-fe" };
const multiNodeRun: RunLike = { id: "run_1", status: "completed", nodes: { a: { status: "completed" }, b: { status: "completed" } } };
let seq = 0;
const makeId = () => `mem_${(seq += 1)}`;

describe("MemoryExtractor", () => {
  let dataRoot: string;
  let store: MemoryStore;
  beforeEach(async () => {
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mem-ext-"));
    store = await MemoryStore.open(dataRoot);
    seq = 0;
  });

  it("writes a run-summary when gate passes", async () => {
    const extractor = new MemoryExtractor(store, async () => ({ title: "交付", content: "多节点完成" }), makeId);
    const record = await extractor.onRunComplete({ run: multiNodeRun, scope, provenance: {} });
    expect(record?.kind).toBe("run-summary");
    expect(record?.provenance.runId).toBe("run_1");
    expect(record?.provenance.traceId).toBe("run_1");
    expect(record?.tokens).toBeGreaterThan(0);
  });

  it("skips when gate rejects (trivial run)", async () => {
    const extractor = new MemoryExtractor(store, async () => ({ title: "t", content: "c" }), makeId);
    const trivial: RunLike = { id: "run_2", status: "completed", nodes: { a: { status: "completed" } } };
    expect(await extractor.onRunComplete({ run: trivial, scope, provenance: {} })).toBeNull();
  });

  it("is idempotent per runId", async () => {
    const extractor = new MemoryExtractor(store, async () => ({ title: "t", content: "c" }), makeId);
    const first = await extractor.onRunComplete({ run: multiNodeRun, scope, provenance: {} });
    const second = await extractor.onRunComplete({ run: multiNodeRun, scope, provenance: {} });
    expect(second?.id).toBe(first?.id);
    expect((await store.listByScope("employee:r")).length).toBe(1);
  });

  it("degrades to null when summarizer throws (no throw to caller)", async () => {
    const extractor = new MemoryExtractor(store, async () => { throw new Error("provider down"); }, makeId);
    await expect(extractor.onRunComplete({ run: multiNodeRun, scope, provenance: {} })).resolves.toBeNull();
  });

  it("skips when summarizer returns null", async () => {
    const extractor = new MemoryExtractor(store, async () => null, makeId);
    expect(await extractor.onRunComplete({ run: multiNodeRun, scope, provenance: {} })).toBeNull();
  });
});
