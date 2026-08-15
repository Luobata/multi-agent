import { describe, expect, it } from "vitest";
import {
  CONFLICT_EXECUTION_PASS,
  CONFLICT_PLAN_READY,
  LEADER_REVALIDATION_PASS,
  buildConflictExecutionRequest,
  buildConflictPlanningRequest,
  buildLeaderRevalidationRequest,
  hasExplicitDeliveryPass,
  classifyConflictRetestFailure,
  validateCandidateWorkspaceState,
  validateConflictRetestEvidence,
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
      conflictPaths: ["client/src/BoardPage.tsx"],
      leaderPlan: "preserve both navigation behaviors",
      originalRequest: "keep board navigation stable"
    });
    expect(execution).toContain("运行核心已经开始 rebase");
    expect(execution).toContain("不要执行 git rebase");
    expect(execution).toContain("client/src/BoardPage.tsx");
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

  it("deterministically rejects evidence from main or another revision", () => {
    const expected = { url: "http://127.0.0.1:49231/", sourceCommit: "source-1", candidateRevision: "revision-1" };
    expect(validateConflictRetestEvidence({ ...expected, verdict: "pass" }, expected)).toEqual([]);
    const issues = validateConflictRetestEvidence({ ...expected, url: "http://127.0.0.1:4318/", candidateRevision: "main" }, expected);
    expect(issues).toHaveLength(2);
    expect(classifyConflictRetestFailure("passed", issues)).toBe("evidence-incomplete");
    expect(classifyConflictRetestFailure("browser environment unavailable", [])).toBe("environment-blocked");
    expect(classifyConflictRetestFailure("breadcrumb is missing", [])).toBe("product-failed");
    expect(classifyConflictRetestFailure("browser shows missing checkout button", [])).toBe("product-failed");
    expect(classifyConflictRetestFailure("browser failed to launch", ["url 未证明"])).toBe("environment-blocked");
    expect(classifyConflictRetestFailure("leader says evidence is insufficient", [])).toBe("evidence-incomplete");
  });

  it("binds pre-test and post-test workspace state to the persisted source commit", () => {
    const clean = { revision: "sha256:one", baseCommit: "source-1", changedFiles: [] };
    expect(validateCandidateWorkspaceState(clean, { sourceCommit: "source-1" })).toEqual([]);
    expect(validateCandidateWorkspaceState({ ...clean, baseCommit: "source-2" }, { sourceCommit: "source-1" })[0]).toContain("HEAD");
    expect(validateCandidateWorkspaceState({ ...clean, changedFiles: ["client/src/App.tsx"] }, { sourceCommit: "source-1" })[0]).toContain("未提交改动");
    expect(validateCandidateWorkspaceState({ ...clean, revision: "sha256:two" }, {
      sourceCommit: "source-1",
      revision: "sha256:one"
    })[0]).toContain("测试期间变化");
  });
});
