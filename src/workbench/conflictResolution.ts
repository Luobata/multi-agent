import type { JsonValue } from "../core/types.js";

export const CONFLICT_PLAN_READY = "CONFLICT_PLAN: READY";
export const CONFLICT_EXECUTION_PASS = "CONFLICT_EXECUTION: PASS";
export const LEADER_REVALIDATION_PASS = "LEADER_REVALIDATION: PASS";

export interface ConflictRetestEvidence {
  url: string;
  sourceCommit: string;
  candidateRevision: string;
}

export interface CandidateWorkspaceState {
  revision: string;
  baseCommit: string;
  changedFiles: string[];
}

function stringsForKey(value: JsonValue | undefined, key: string, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) stringsForKey(item, key, found);
  else if (value && typeof value === "object") for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key && typeof entryValue === "string") found.push(entryValue);
    stringsForKey(entryValue, key, found);
  }
  return found;
}

function uniqueMatches(value: string, pattern: RegExp): string[] {
  return [...new Set([...value.matchAll(pattern)].map((match) => match[1]).filter((entry): entry is string => Boolean(entry)))];
}

function hasCandidateIdentityAttestation(value: JsonValue | undefined, expected: ConflictRetestEvidence): boolean {
  return stringsForKey(value, "summary").some((summary) => {
    const urls = uniqueMatches(summary, /(?:^|[\s;；，,。])url=([^\s;；，,。]+)/giu);
    const sourceCommits = uniqueMatches(summary, /(?:^|[\s;；，,。])sourceCommit=([0-9a-f]{40})(?=$|[\s;；，,。])/giu);
    const candidateRevisions = uniqueMatches(summary, /(?:^|[\s;；，,。])candidateRevision=(sha256:[0-9a-f]{64})(?=$|[\s;；，,。])/giu);
    return urls.length === 1
      && sourceCommits.length === 1
      && candidateRevisions.length === 1
      && urls[0] === expected.url
      && sourceCommits[0] === expected.sourceCommit
      && candidateRevisions[0] === expected.candidateRevision;
  });
}

function hasBrowserE2eEvidence(value: JsonValue | undefined): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value.e2eEvidence;
  return Array.isArray(evidence) && evidence.some((entry) => (
    entry !== null
    && typeof entry === "object"
    && !Array.isArray(entry)
    && entry.method === "browser"
    && typeof entry.observed === "string"
    && entry.observed.trim().length > 0
  ));
}

export function validateConflictRetestEvidence(output: JsonValue | undefined, expected: ConflictRetestEvidence): string[] {
  // Project test roles use strict, versioned output schemas. Some schemas expose
  // identity fields directly; the standard tester schema intentionally allows
  // only verdict/summary/e2eEvidence/risks. A canonical identity attestation in
  // summary keeps that schema satisfiable while remaining exact and unambiguous.
  const issues: string[] = [];
  if (!hasBrowserE2eEvidence(output)) {
    issues.push("e2eEvidence 未包含 observed 非空的 browser 验收证据");
  }
  if (!hasCandidateIdentityAttestation(output, expected)) {
    for (const key of ["url", "sourceCommit", "candidateRevision"] as const) {
      const values = stringsForKey(output, key);
      if (!values.includes(expected[key])) issues.push(`${key} 未证明为受管候选值 ${expected[key]}`);
    }
  }
  return issues;
}

export function validateCandidateWorkspaceState(
  snapshot: CandidateWorkspaceState,
  expected: { sourceCommit: string; revision?: string }
): string[] {
  const issues: string[] = [];
  if (snapshot.baseCommit !== expected.sourceCommit) {
    issues.push(`候选 HEAD ${snapshot.baseCommit} 与待合入 sourceCommit ${expected.sourceCommit} 不一致`);
  }
  if (snapshot.changedFiles.length > 0) {
    issues.push(`候选 worktree 存在未提交改动：${snapshot.changedFiles.join("、")}`);
  }
  if (expected.revision && snapshot.revision !== expected.revision) {
    issues.push(`候选 revision 在测试期间变化：${expected.revision} → ${snapshot.revision}`);
  }
  return issues;
}

export function classifyConflictRetestFailure(message: string, evidenceIssues: string[]): "environment-blocked" | "evidence-incomplete" | "product-failed" {
  if (/\bMIDSCENE_ENVIRONMENT_BLOCKED\b/i.test(message)) return "environment-blocked";
  if (/econnrefused|eaddrinuse|enotfound|eacces|eperm|permission denied|sandbox|provider [^\n]{0,30}unavailable|socket|preview (?:server )?(?:unavailable|failed)|browser [^\n]{0,40}(?:unavailable|failed to (?:start|launch|connect))|health.?check|timeout|timed out|端口|环境(?:不可用|异常|失败)|预览(?:服务)?(?:不可用|失败|提前退出|超时)|无法.*预览|启动(?:失败|超时)|连接(?:失败|超时)/i.test(message)) {
    return "environment-blocked";
  }
  if (evidenceIssues.length > 0 || /evidence|证据|无法证明|identity|revision|sourcecommit|worktree.*未提交/i.test(message)) return "evidence-incomplete";
  return "product-failed";
}

function evidenceText(output: JsonValue | undefined, message: string): string {
  return `${message}\n${output === undefined ? "" : JSON.stringify(output)}`.toUpperCase();
}

export function hasExplicitDeliveryPass(output: JsonValue | undefined, message: string, marker: string): boolean {
  return evidenceText(output, message).includes(marker.toUpperCase());
}

export function selectConflictExecutionRole(conflictMessage: string): "frontend-developer" | "backend-developer" | "fullstack-developer" {
  const normalized = conflictMessage.toLowerCase();
  const frontend = /(?:^|[\s\t])(?:client|frontend|web)\//m.test(normalized) || /\.(?:tsx|jsx|css|scss|html)\b/.test(normalized);
  const backend = /(?:^|[\s\t])(?:server|backend|src\/(?:daemon|runtime|workbench))\//m.test(normalized)
    || /\.(?:go|py|java|kt|rs|sql)\b/.test(normalized);
  if (frontend && !backend) return "frontend-developer";
  if (backend && !frontend) return "backend-developer";
  return "fullstack-developer";
}

export function buildConflictPlanningRequest(input: {
  runId: string;
  worktreePath: string;
  targetBranch: string;
  targetCommit: string;
  sourceCommit?: string;
  conflictMessage: string;
  originalRequest?: string;
}): string {
  return [
    "【待合入队列 · 原领队冲突处置计划】",
    `候选 Run：${input.runId}`,
    `原 worktree：${input.worktreePath}`,
    `目标分支：${input.targetBranch}`,
    `必须 rebase 到的精确目标 commit：${input.targetCommit}`,
    ...(input.sourceCommit ? [`当前候选 commit：${input.sourceCommit}`] : []),
    `合入预检冲突：${input.conflictMessage}`,
    ...(input.originalRequest ? ["原需求：", input.originalRequest] : []),
    "你是该需求的原领队，当前阶段负责判断冲突双方意图、列出必须保留的行为、指定定向测试与风险边界。不要因为领队本人是只读角色而阻塞；运行核心会把你的计划委派给具备 Git、写文件和测试权限的工程角色实际执行。",
    "不得要求安装或升级依赖，不得允许改写真实目标分支、push、删除 worktree，也不得用 ours/theirs 整体覆盖来规避逐项判断。计划必须让工程角色在原 worktree rebase 到精确目标 commit，逐项解冲突，运行与冲突文件及原需求直接相关的测试，提交当前交付源分支并保证 worktree 干净。",
    `计划具体且可以交给工程角色执行时，最终单独输出 ${CONFLICT_PLAN_READY}；若需求取舍本身无法判断，输出 CONFLICT_PLAN: BLOCK 并说明需要哪项人工决定。`
  ].join("\n");
}

export function buildConflictExecutionRequest(input: {
  runId: string;
  worktreePath: string;
  targetBranch: string;
  targetCommit: string;
  conflictMessage: string;
  conflictPaths: string[];
  leaderPlan: string;
  originalRequest?: string;
}): string {
  return [
    "【待合入队列 · 工程角色执行冲突修复】",
    `候选 Run：${input.runId}`,
    `必须操作的原 worktree：${input.worktreePath}`,
    `目标分支：${input.targetBranch}`,
    `必须 rebase 到的精确目标 commit：${input.targetCommit}`,
    `合入预检冲突：${input.conflictMessage}`,
    `运行核心已启动 rebase；本轮必须解决的冲突文件：${input.conflictPaths.join("、")}`,
    ...(input.originalRequest ? ["原需求：", input.originalRequest] : []),
    "【原领队处置计划】",
    input.leaderPlan,
    "你是运行核心按原领队计划委派的工程执行角色。受信任运行核心已经开始 rebase，并保留 Git 元数据写权限；你只在上面的原 worktree 内逐项编辑本轮冲突文件，同时保留原需求与目标分支有效改动，然后运行原领队指定的定向测试。",
    "不要执行 git rebase、git add、git commit 或 git rebase --continue；这些 Git 状态迁移会由运行核心在你报告完成后执行。看到 unmerged 状态是本阶段的正常现象，不得因无权写 .git/worktrees 元数据而阻塞。",
    "不得安装或升级依赖，不得改写真实目标分支，不得 push，不得删除 worktree，不得整体选择 ours/theirs。不得只给建议或代码片段，必须真实编辑并测试。",
    `只有本轮所有冲突文件都已真实编辑、无冲突标记且定向测试通过时，最终单独输出 ${CONFLICT_EXECUTION_PASS}；否则输出 CONFLICT_EXECUTION: BLOCK，并给出已执行命令、剩余冲突文件和阻塞原因。`
  ].join("\n");
}

export function buildLeaderRevalidationRequest(input: {
  runId: string;
  targetCommit: string;
  sourceCommit: string;
  testRunId: string;
  testMessage: string;
}): string {
  return [
    "【待合入队列 · 原领队最终复验】",
    `候选 Run：${input.runId}`,
    `已 rebase 目标 commit：${input.targetCommit}`,
    `冲突修复后候选 commit：${input.sourceCommit}`,
    `独立测试 Run：${input.testRunId}`,
    `独立测试结论：${input.testMessage}`,
    "运行核心已经验证 worktree 干净、目标 commit 是候选祖先、merge-tree 无冲突，独立 test-engineer 也已回跑原需求相关测试。现在请作为原需求领队核对冲突取舍是否仍满足原需求、是否错误覆盖目标分支新行为，以及测试证据是否足以放行。此阶段只审阅，不再修改代码、Git 历史或依赖。",
    `只有确认可以自动合入时，最终单独输出 ${LEADER_REVALIDATION_PASS}；否则输出 LEADER_REVALIDATION: BLOCK 并说明缺失证据或风险。`
  ].join("\n");
}
