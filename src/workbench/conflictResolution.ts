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

const REACHABILITY_PATTERN = /可达|可见|已连接|在线|rendered|reachable|connected/i;

/**
 * Detects a verdict that claims MIDSCENE_ENVIRONMENT_BLOCKED while its own browser
 * evidence proves the candidate was reachable. Such a contradiction means the block
 * is an interaction/product failure, not an environment failure.
 */
export function environmentBlockedClaimContradicted(output: JsonValue | undefined): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const summaries = stringsForKey(output, "summary");
  if (!summaries.some((summary) => /\bMIDSCENE_ENVIRONMENT_BLOCKED\b/i.test(summary))) return false;
  const evidence = output.e2eEvidence;
  return Array.isArray(evidence) && evidence.some((entry) => (
    entry !== null
    && typeof entry === "object"
    && !Array.isArray(entry)
    && entry.method === "browser"
    && typeof entry.observed === "string"
    && REACHABILITY_PATTERN.test(entry.observed)
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
  if (environmentBlockedClaimContradicted(output)) {
    issues.push("环境阻塞声明与浏览器可达证据矛盾");
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

export function classifyConflictRetestFailure(
  message: string,
  evidenceIssues: string[],
  output?: JsonValue | undefined
): "environment-blocked" | "evidence-incomplete" | "product-failed" {
  if (/\bMIDSCENE_ENVIRONMENT_BLOCKED\b/i.test(message) && !environmentBlockedClaimContradicted(output)) {
    return "environment-blocked";
  }
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

export function buildConflictRetestRequest(input: {
  runId: string;
  url: string;
  targetCommit: string;
  sourceCommit: string;
  candidateRevision: string;
}): string {
  return [
    "【冲突修复后原需求回归】",
    `候选 Run：${input.runId}`,
    `唯一受管候选 URL：${input.url}`,
    `已 rebase 目标 commit：${input.targetCommit}`,
    `冲突修复后候选 commit：${input.sourceCommit}`,
    `候选 revision：${input.candidateRevision}`,
    "只能用上述唯一 URL 形成候选结论；严禁使用 4318/main 或其他已运行页面替代候选。请在原候选 worktree 上执行独立测试，界面路径必须用 Midscene 留下真实可见证据。不得安装依赖，不得修改代码或 Git 历史。",
    `测试角色的固定输出 Schema 不允许增加字段；请在 summary 中原样包含一条候选身份声明：CANDIDATE_IDENTITY url=${input.url}；sourceCommit=${input.sourceCommit}；candidateRevision=${input.candidateRevision}。`,
    "服务端还会独立校验候选真实 GET、工作区 commit 与 revision；不得只复述身份而改用其他页面测试。测试、环境或证据有任一缺口必须返回 Block；只有可复现且证据充分才返回 Pass。",
    "接地要求（verdict 必须与自身证据一致，不得自相矛盾）：",
    "- 关键交互后必须用 Midscene assert 验证期望状态，并把 assert 结果写入 e2eEvidence 的 observed。",
    "- verdict 必须以最终截图与 Midscene 报告的最终状态为准；assert 通过即交互证据充分，不得以\"证据缺口\"Block。",
    "- MIDSCENE_ENVIRONMENT_BLOCKED 仅用于候选 URL 无法连接或页面无法渲染（连接拒绝、空白页、核心离线）；页面可达但交互失败属于产品问题，不得标记为 environment-blocked。",
    "- summary 的事实陈述必须与 e2eEvidence 一致，不得引用与结论矛盾的截图或报告作为证据。"
  ].join("\n");
}
