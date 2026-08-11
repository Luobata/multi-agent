import { describe, expect, it } from "vitest";
import {
  CONFLICT_EXECUTION_PASS,
  CONFLICT_PLAN_READY,
  LEADER_REVALIDATION_PASS,
  buildConflictExecutionRequest,
  buildConflictPlanningRequest,
  buildLeaderRevalidationRequest,
  hasExplicitDeliveryPass,
  selectConflictExecutionRole
} from "../src/workbench/conflictResolution.js";

describe("merge conflict leader protocol", () => {
  it("has the read-only original leader plan and a write-capable project role execute in the original worktree", () => {
    const plan = buildConflictPlanningRequest({
      runId: "run-conflict-1",
      worktreePath: "/repo/.multi-agent/worktrees/run-conflict-1",
      targetBranch: "main",
      targetCommit: "abc123",
      sourceCommit: "def456",
      conflictMessage: "BoardPage.tsx conflicts",
      originalRequest: "keep board navigation stable"
    });
    expect(plan).toContain("运行核心会把你的计划委派");
    expect(plan).toContain(CONFLICT_PLAN_READY);
    const execution = buildConflictExecutionRequest({
      runId: "run-conflict-1",
      worktreePath: "/repo/.multi-agent/worktrees/run-conflict-1",
      targetBranch: "main",
      targetCommit: "abc123",
      conflictMessage: "client/src/BoardPage.tsx conflicts",
      leaderPlan: "preserve both navigation behaviors",
      originalRequest: "keep board navigation stable"
    });
    expect(execution).toContain("git rebase");
    expect(execution).toContain("abc123");
    expect(execution).toContain("不得安装或升级依赖");
    expect(execution).toContain(CONFLICT_EXECUTION_PASS);
    expect(selectConflictExecutionRole("client/src/BoardPage.tsx conflicts")).toBe("frontend-developer");
    expect(selectConflictExecutionRole("src/workbench/service.ts conflicts")).toBe("backend-developer");
    expect(selectConflictExecutionRole("client/App.tsx and src/workbench/service.ts conflict")).toBe("fullstack-developer");
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
