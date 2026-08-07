// tests/memory-retriever.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.js";
import { MemoryRetriever } from "../src/memory/retriever.js";
import type { MemoryRecord } from "../src/memory/types.js";

function rec(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "x", scope: { employeeId: "r", employeeVersion: 1, projectId: "cart-fe" },
    kind: "run-summary", title: "t", content: "c",
    provenance: { runId: "run", traceId: "run" },
    status: "active", tokens: 10, createdAt: "2026-08-06T10:00:00.000Z", supersedesId: null,
    ...overrides
  };
}

describe("MemoryRetriever", () => {
  let dataRoot: string;
  let store: MemoryStore;
  beforeEach(async () => {
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mem-ret-"));
    store = await MemoryStore.open(dataRoot);
  });

  it("returns higher score for better term overlap", async () => {
    await store.put(rec({ id: "a", title: "前端改价", content: "改价 前端 交付 完成" }));
    await store.put(rec({ id: "b", title: "后端日志", content: "日志 排查 无关" }));
    const hits = await store.reindex().then(() =>
      new MemoryRetriever(store).search({ query: "前端 改价", scope: { employeeId: "r" } }));
    expect(hits[0]!.memoryId).toBe("a");
    expect(hits[0]!.citationId).toBe("M1");
  });

  it("excludes archived records", async () => {
    await store.put(rec({ id: "a", content: "前端 改价" }));
    await store.archive("a");
    const hits = await new MemoryRetriever(store).search({ query: "前端", scope: { employeeId: "r" } });
    expect(hits.length).toBe(0);
  });

  it("defaults to run-summary kind only", async () => {
    await store.put(rec({ id: "a", kind: "run-summary", content: "前端 改价" }));
    await store.put(rec({ id: "b", kind: "node-detail", content: "前端 改价 细节" }));
    const hits = await new MemoryRetriever(store).search({ query: "前端 改价", scope: { employeeId: "r" } });
    expect(hits.every((h) => h.kind === "run-summary")).toBe(true);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 8; i += 1) await store.put(rec({ id: `a${i}`, content: "前端 改价 交付" }));
    const hits = await new MemoryRetriever(store).search({ query: "前端 改价", scope: { employeeId: "r" }, limit: 3 });
    expect(hits.length).toBe(3);
  });

  it("returns node-detail when explicitly requested (drill-down)", async () => {
    await store.put(rec({ id: "a", kind: "node-detail", content: "前端 改价 细节", provenance: { runId: "run", traceId: "trace-9" } }));
    const hits = await new MemoryRetriever(store).search({ query: "前端 改价", scope: { employeeId: "r" }, kind: "node-detail" });
    expect(hits[0]!.traceId).toBe("trace-9");
  });
});
