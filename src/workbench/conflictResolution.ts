import type { JsonValue } from "../core/types.js";

export const CONFLICT_RESOLUTION_PASS = "CONFLICT_RESOLUTION: PASS";
export const LEADER_REVALIDATION_PASS = "LEADER_REVALIDATION: PASS";

function evidenceText(output: JsonValue | undefined, message: string): string {
  return `${message}\n${output === undefined ? "" : JSON.stringify(output)}`.toUpperCase();
}

export function hasExplicitDeliveryPass(output: JsonValue | undefined, message: string, marker: string): boolean {
  return evidenceText(output, message).includes(marker.toUpperCase());
}

export function buildConflictResolutionRequest(input: {
  runId: string;
  worktreePath: string;
  targetBranch: string;
  targetCommit: string;
  sourceCommit?: string;
  conflictMessage: string;
  originalRequest?: string;
}): string {
  return [
    "【待合入队列 · 原领队冲突修复】",
    `候选 Run：${input.runId}`,
    `原 worktree：${input.worktreePath}`,
    `目标分支：${input.targetBranch}`,
    `必须 rebase 到的精确目标 commit：${input.targetCommit}`,
    ...(input.sourceCommit ? [`当前候选 commit：${input.sourceCommit}`] : []),
    `合入预检冲突：${input.conflictMessage}`,
    ...(input.originalRequest ? ["原需求：", input.originalRequest] : []),
    "你是该需求的原领队。只在当前原 worktree 内处理这次合入冲突：先检查 Git 状态；如存在中断的 rebase，判断后安全继续或 abort，再执行 git rebase 到上面的精确目标 commit。逐个解决冲突，必须同时保留原需求意图与目标分支已合入的有效改动。",
    "不得安装或升级依赖，不得改写真实目标分支，不得 push，不得删除 worktree，不得用 ours/theirs 整体覆盖来规避逐项判断。完成后运行与冲突文件和原需求直接相关的定向测试，把修复提交在当前交付源分支，并保证 worktree 干净。",
    `只有 rebase、冲突处理、定向自检和提交全部完成时，最终单独输出 ${CONFLICT_RESOLUTION_PASS}；否则输出 CONFLICT_RESOLUTION: BLOCK 并说明仍需处理的文件和原因。`
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
