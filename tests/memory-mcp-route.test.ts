import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/workbench/service.js";

// 直接测 service 层的检索契约（MCP/daemon 只是透传）；
// daemon 路由的 e2e 由现有 daemon 测试范式覆盖。
describe("search_memory contract", () => {
  it("service.searchMemory accepts the MCP argument shape", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mem-mcp-"));
    const svc = await WorkbenchService.open({ dataRoot });
    const hits = await svc.searchMemory({
      query: "前端",
      scope: { employeeId: "r", projectId: "cart-fe" },
      limit: 3
    });
    expect(Array.isArray(hits)).toBe(true);
  });
});
