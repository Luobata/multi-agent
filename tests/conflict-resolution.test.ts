import { describe, expect, it } from "vitest";
import {
  CONFLICT_EXECUTION_PASS,
  CONFLICT_PLAN_READY,
  LEADER_REVALIDATION_PASS,
  buildConflictExecutionRequest,
  buildConflictPlanningRequest,
  buildConflictRetestRequest,
  buildLeaderRevalidationRequest,
  environmentBlockedClaimContradicted,
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
    const browserEvidence = { e2eEvidence: [{ method: "browser", observed: "Candidate is visibly correct." }] };
    expect(validateConflictRetestEvidence({ ...expected, ...browserEvidence, verdict: "pass" }, expected)).toEqual([]);
    const issues = validateConflictRetestEvidence({
      ...expected,
      ...browserEvidence,
      url: "http://127.0.0.1:4318/",
      candidateRevision: "main"
    }, expected);
    expect(issues).toHaveLength(2);
    expect(classifyConflictRetestFailure("passed", issues)).toBe("evidence-incomplete");
    expect(classifyConflictRetestFailure("browser environment unavailable", [])).toBe("environment-blocked");
    expect(classifyConflictRetestFailure(
      "MIDSCENE_ENVIRONMENT_BLOCKED: connect produced no result",
      ["受管候选 URL 没有真实访问记录"]
    )).toBe("environment-blocked");
    expect(classifyConflictRetestFailure("breadcrumb is missing", [])).toBe("product-failed");
    expect(classifyConflictRetestFailure("browser shows missing checkout button", [])).toBe("product-failed");
    expect(classifyConflictRetestFailure("browser failed to launch", ["url 未证明"])).toBe("environment-blocked");
    expect(classifyConflictRetestFailure("leader says evidence is insufficient", [])).toBe("evidence-incomplete");
  });

  it("accepts one exact schema-compatible candidate identity attestation in summary", () => {
    const expected = {
      url: "http://127.0.0.1:49166/?candidate-token=proof123",
      sourceCommit: "cb557b3fa52cafc949dc2523a8f253868696bfd7",
      candidateRevision: "sha256:996def400b586948f3ba6771a580d192de4e40d9cae3d4db384a51747954ceca"
    };
    expect(validateConflictRetestEvidence({
      verdict: "pass",
      summary: `Pass。CANDIDATE_IDENTITY url=${expected.url}；sourceCommit=${expected.sourceCommit}；candidateRevision=${expected.candidateRevision}。`,
      e2eEvidence: [{ method: "browser", observed: "Candidate page loaded and the interaction passed." }]
    }, expected)).toEqual([]);
    expect(validateConflictRetestEvidence({
      verdict: "pass",
      summary: `url=${expected.url}；sourceCommit=${expected.sourceCommit}；candidateRevision=${expected.candidateRevision}。`,
      e2eEvidence: [{ method: "browser", observed: "Candidate page loaded and the interaction passed." }]
    }, expected)).toEqual([]);
    expect(validateConflictRetestEvidence({
      verdict: "pass",
      summary: `url=${expected.url}；url=http://127.0.0.1:4318/；sourceCommit=${expected.sourceCommit}；candidateRevision=${expected.candidateRevision}。`,
      e2eEvidence: [{ method: "browser", observed: "Candidate page loaded." }]
    }, expected)).toHaveLength(3);
    expect(validateConflictRetestEvidence({
      verdict: "pass",
      summary: `url=${expected.url}；sourceCommit=${expected.sourceCommit}；candidateRevision=sha256:${"0".repeat(64)}。`,
      e2eEvidence: [{ method: "browser", observed: "Candidate page loaded." }]
    }, expected)).toHaveLength(3);
  });

  it("requires non-empty structured browser evidence in addition to candidate identity", () => {
    const expected = {
      url: "http://127.0.0.1:49166/?candidate-token=proof123",
      sourceCommit: "cb557b3fa52cafc949dc2523a8f253868696bfd7",
      candidateRevision: "sha256:996def400b586948f3ba6771a580d192de4e40d9cae3d4db384a51747954ceca"
    };
    const summary = `url=${expected.url}；sourceCommit=${expected.sourceCommit}；candidateRevision=${expected.candidateRevision}。`;

    expect(validateConflictRetestEvidence({ verdict: "pass", summary }, expected))
      .toContain("e2eEvidence 未包含 observed 非空的 browser 验收证据");
    expect(validateConflictRetestEvidence({
      verdict: "pass",
      summary,
      e2eEvidence: [{ method: "http-behavior", observed: "GET returned 200." }]
    }, expected)).toContain("e2eEvidence 未包含 observed 非空的 browser 验收证据");
    expect(validateConflictRetestEvidence({
      verdict: "pass",
      summary,
      e2eEvidence: [{ method: "browser", observed: "   " }]
    }, expected)).toContain("e2eEvidence 未包含 observed 非空的 browser 验收证据");
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

describe("conflict retest grounding", () => {
  const retestInput = {
    runId: "run-conflict-1",
    url: "http://127.0.0.1:49231/?candidate-token=proof123",
    targetCommit: "abc123",
    sourceCommit: "cb557b3fa52cafc949dc2523a8f253868696bfd7",
    candidateRevision: "sha256:996def400b586948f3ba6771a580d192de4e40d9cae3d4db384a51747954ceca"
  };

  it("detects a contradiction when MIDSCENE_ENVIRONMENT_BLOCKED is claimed but browser evidence proves reachability", () => {
    const output = {
      verdict: "block",
      summary: "恢复会话仍停在详情页 MIDSCENE_ENVIRONMENT_BLOCKED",
      e2eEvidence: [{ method: "browser", observed: "页面可达，已回到项目列表页" }]
    };
    expect(environmentBlockedClaimContradicted(output)).toBe(true);
  });

  it("does not detect a contradiction when browser observed lacks reachability language", () => {
    const output = {
      verdict: "block",
      summary: "MIDSCENE_ENVIRONMENT_BLOCKED: connect produced no result",
      e2eEvidence: [{ method: "browser", observed: "页面停留在详情页" }]
    };
    expect(environmentBlockedClaimContradicted(output)).toBe(false);
  });

  it("does not detect a contradiction when summary lacks MIDSCENE_ENVIRONMENT_BLOCKED", () => {
    const output = {
      verdict: "block",
      summary: "交互失败，面包屑未点击",
      e2eEvidence: [{ method: "browser", observed: "页面可达" }]
    };
    expect(environmentBlockedClaimContradicted(output)).toBe(false);
    expect(environmentBlockedClaimContradicted(undefined)).toBe(false);
  });

  it("appends a contradiction issue in validateConflictRetestEvidence", () => {
    const expected = {
      url: retestInput.url,
      sourceCommit: retestInput.sourceCommit,
      candidateRevision: retestInput.candidateRevision
    };
    const output = {
      verdict: "block",
      summary: `MIDSCENE_ENVIRONMENT_BLOCKED。CANDIDATE_IDENTITY url=${expected.url}；sourceCommit=${expected.sourceCommit}；candidateRevision=${expected.candidateRevision}。`,
      e2eEvidence: [{ method: "browser", observed: "页面可达，最终截图显示项目列表页" }]
    };
    const issues = validateConflictRetestEvidence(output, expected);
    expect(issues).toContain("环境阻塞声明与浏览器可达证据矛盾");
  });

  it("skips environment-blocked classification when the claim is contradicted", () => {
    const output = {
      verdict: "block",
      summary: "恢复会话仍停在详情页，未执行目标面包屑点击 MIDSCENE_ENVIRONMENT_BLOCKED",
      e2eEvidence: [{ method: "browser", observed: "页面可达，已回到项目列表页" }]
    };
    // With evidence issues → evidence-incomplete, not environment-blocked.
    expect(classifyConflictRetestFailure("恢复会话仍停在详情页 MIDSCENE_ENVIRONMENT_BLOCKED", ["证据缺口"], output))
      .toBe("evidence-incomplete");
    // Without evidence issues → product-failed, not environment-blocked.
    expect(classifyConflictRetestFailure("恢复会话仍停在详情页 MIDSCENE_ENVIRONMENT_BLOCKED", [], output))
      .toBe("product-failed");
  });

  it("preserves environment-blocked classification when the claim is not contradicted", () => {
    // No output at all (2-arg call) → environment-blocked.
    expect(classifyConflictRetestFailure("MIDSCENE_ENVIRONMENT_BLOCKED: connect produced no result", []))
      .toBe("environment-blocked");
    // Output present but browser evidence lacks reachability language → environment-blocked.
    const nonContradicted = {
      verdict: "block",
      summary: "MIDSCENE_ENVIRONMENT_BLOCKED",
      e2eEvidence: [{ method: "browser", observed: "页面停留在详情页" }]
    };
    expect(classifyConflictRetestFailure("MIDSCENE_ENVIRONMENT_BLOCKED", [], nonContradicted))
      .toBe("environment-blocked");
  });

  it("builds a retest request with grounding requirements and preserves original constraints", () => {
    const prompt = buildConflictRetestRequest(retestInput);
    // Four new grounding requirements (key phrases).
    expect(prompt).toContain("assert");
    expect(prompt).toContain("最终状态为准");
    expect(prompt).toContain("MIDSCENE_ENVIRONMENT_BLOCKED 仅用于");
    expect(prompt).toContain("一致");
    // Original constraints preserved.
    expect(prompt).toContain("唯一受管候选 URL");
    expect(prompt).toContain("CANDIDATE_IDENTITY");
    expect(prompt).toContain("不得安装依赖");
    expect(prompt).toContain(retestInput.url);
    expect(prompt).toContain(retestInput.sourceCommit);
    expect(prompt).toContain(retestInput.candidateRevision);
  });
});
