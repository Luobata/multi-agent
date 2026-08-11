import { describe, expect, it } from "vitest";
import {
  CONFLICT_RESOLUTION_PASS,
  LEADER_REVALIDATION_PASS,
  buildConflictResolutionRequest,
  buildLeaderRevalidationRequest,
  hasExplicitDeliveryPass
} from "../src/workbench/conflictResolution.js";

describe("merge conflict leader protocol", () => {
  it("pins conflict repair to the original worktree and exact target commit", () => {
    const prompt = buildConflictResolutionRequest({
      runId: "run-conflict-1",
      worktreePath: "/repo/.multi-agent/worktrees/run-conflict-1",
      targetBranch: "main",
      targetCommit: "abc123",
      sourceCommit: "def456",
      conflictMessage: "BoardPage.tsx conflicts",
      originalRequest: "keep board navigation stable"
    });
    expect(prompt).toContain("git rebase");
    expect(prompt).toContain("abc123");
    expect(prompt).toContain("不得安装或升级依赖");
    expect(prompt).toContain(CONFLICT_RESOLUTION_PASS);
  });

  it("requires an explicit leader pass after independent test evidence", () => {
    const prompt = buildLeaderRevalidationRequest({
      runId: "run-conflict-1",
      targetCommit: "abc123",
      sourceCommit: "rebased789",
      testRunId: "run-test-1",
      testMessage: "all relevant tests passed"
    });
    expect(prompt).toContain("原需求领队");
    expect(prompt).toContain("run-test-1");
    expect(prompt).toContain(LEADER_REVALIDATION_PASS);
    expect(hasExplicitDeliveryPass(undefined, `done\n${LEADER_REVALIDATION_PASS}`, LEADER_REVALIDATION_PASS)).toBe(true);
    expect(hasExplicitDeliveryPass({ verdict: "block" }, "looks fine", LEADER_REVALIDATION_PASS)).toBe(false);
  });
});
