import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/workbench/service.js";

async function freshService(): Promise<WorkbenchService> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mem-svc-"));
  return WorkbenchService.open({ dataRoot });
}

describe("WorkbenchService memory integration", () => {
  it("searchMemory returns empty for unknown scope (no crash)", async () => {
    const svc = await freshService();
    const hits = await svc.searchMemory({ query: "任何", scope: { employeeId: "nobody" } });
    expect(hits).toEqual([]);
  });

  it("archiveMemory returns null for missing id", async () => {
    const svc = await freshService();
    expect(await svc.archiveMemory("mem_missing")).toBeNull();
  });

  it("reindexMemory returns 0 on empty store", async () => {
    const svc = await freshService();
    expect(await svc.reindexMemory()).toBe(0);
  });

  // 主链路回归：一次真实 mock-provider employee 调用完成后，
  // 服务不因后台 memory 提炼而报错，且检索方法可安全调用。
  it("employee invocation completes even though memory extraction runs in background", async () => {
    const svc = await freshService();
    expect(typeof svc.searchMemory).toBe("function");
    expect(typeof svc.archiveMemory).toBe("function");
    expect(typeof svc.reindexMemory).toBe("function");

    const employee = await svc.createEmployee({
      id: "memory-regression-worker",
      identity: {
        displayName: "Memory Regression Worker",
        background: "Exercises the main invocation path.",
        responsibilities: ["Respond"]
      }
    });

    const result = await svc.invokeEmployee(employee.id, { message: "Hello from the regression test" });
    expect(result.runId).toMatch(/^run-/);

    // 检索在后台提炼进行中也必须安全返回，不抛错。
    const hits = await svc.searchMemory({ query: "Hello", scope: { employeeId: employee.id } });
    expect(Array.isArray(hits)).toBe(true);
  });
});
