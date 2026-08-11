import { describe, expect, it } from "vitest";
import { buildEvidenceRerunRequest, parseOriginalRunRequest } from "../src/workbench/evidenceRerun.js";

describe("evidence rerun request", () => {
  it("retains the original requirement and constrains the tester to focused validation", () => {
    const request = buildEvidenceRerunRequest({
      runId: "run-example",
      worktreePath: "/repo/worktree",
      stagingRoot: "/repo/worktree/evidence",
      originalRequest: "【验收标准】\n1. 卡片可点击进入详情",
      changedFiles: ["client/src/App.tsx", "client/src/App.test.tsx"]
    });

    expect(request).toContain("1. 卡片可点击进入详情");
    expect(request).toContain("- client/src/App.tsx");
    expect(request).toContain("只验证上面的原始需求与验收标准");
    expect(request).toContain("不要运行全仓 npm run check");
    expect(request).toContain("采集 1–2 张");
    expect(request).toContain("立即返回 block");
  });

  it("only accepts a non-empty persisted input message", () => {
    expect(parseOriginalRunRequest({ message: "  original requirement  " })).toBe("original requirement");
    expect(parseOriginalRunRequest({ message: "   " })).toBeUndefined();
    expect(parseOriginalRunRequest({ request: "wrong field" })).toBeUndefined();
    expect(parseOriginalRunRequest(null)).toBeUndefined();
  });
});
