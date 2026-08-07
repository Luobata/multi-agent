// tests/memory-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.js";
import type { MemoryRecord } from "../src/memory/types.js";

function sampleRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem_1",
    scope: { employeeId: "researcher", employeeVersion: 3, projectId: "cart-fe" },
    kind: "run-summary",
    title: "前端改价交付",
    content: "完成了改价，测试通过。",
    provenance: { runId: "run_1", traceId: "run_1" },
    status: "active",
    tokens: 20,
    createdAt: "2026-08-06T10:00:00.000Z",
    supersedesId: null,
    ...overrides
  };
}

describe("MemoryStore", () => {
  let dataRoot: string;
  beforeEach(async () => {
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mem-store-"));
  });

  it("scopeKeys returns employee and project keys", () => {
    expect(MemoryStore.scopeKeys({ employeeId: "r", employeeVersion: 1, projectId: "p" }))
      .toEqual(["employee:r", "project:p"]);
    expect(MemoryStore.scopeKeys({ employeeId: "r", employeeVersion: 1 }))
      .toEqual(["employee:r"]);
  });

  it("put then get round-trips a record", async () => {
    const store = await MemoryStore.open(dataRoot);
    await store.put(sampleRecord());
    const got = await store.get("mem_1");
    expect(got?.title).toBe("前端改价交付");
  });

  it("get returns null for missing id", async () => {
    const store = await MemoryStore.open(dataRoot);
    expect(await store.get("nope")).toBeNull();
  });

  it("listByScope returns records indexed under a scope key", async () => {
    const store = await MemoryStore.open(dataRoot);
    await store.put(sampleRecord({ id: "mem_1" }));
    await store.put(sampleRecord({ id: "mem_2" }));
    const byEmployee = await store.listByScope("employee:researcher");
    expect(byEmployee.map((r) => r.id).sort()).toEqual(["mem_1", "mem_2"]);
    const byProject = await store.listByScope("project:cart-fe");
    expect(byProject.length).toBe(2);
  });

  it("archive flips status to archived", async () => {
    const store = await MemoryStore.open(dataRoot);
    await store.put(sampleRecord());
    const archived = await store.archive("mem_1");
    expect(archived?.status).toBe("archived");
    expect((await store.get("mem_1"))?.status).toBe("archived");
  });

  it("reindex rebuilds indexes from records on disk", async () => {
    const store = await MemoryStore.open(dataRoot);
    await store.put(sampleRecord({ id: "mem_1" }));
    // 删掉索引目录，模拟损坏
    await fs.rm(path.join(dataRoot, "memory", "index"), { recursive: true, force: true });
    const count = await store.reindex();
    expect(count).toBe(1);
    expect((await store.listByScope("employee:researcher")).length).toBe(1);
  });

  it("listScopes returns each scope key with its record count", async () => {
    const store = await MemoryStore.open(dataRoot);
    await store.put(sampleRecord({ id: "mem_1" }));
    await store.put(sampleRecord({ id: "mem_2" }));
    const scopes = await store.listScopes();
    // sampleRecord scope 同时落 employee:researcher 与 project:cart-fe
    const byKey = Object.fromEntries(scopes.map((s) => [s.scopeKey, s.count]));
    expect(byKey["employee:researcher"]).toBe(2);
    expect(byKey["project:cart-fe"]).toBe(2);
  });

  it("listScopes returns empty array on empty store", async () => {
    const store = await MemoryStore.open(dataRoot);
    expect(await store.listScopes()).toEqual([]);
  });
});
