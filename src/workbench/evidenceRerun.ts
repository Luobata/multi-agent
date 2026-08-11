const MAX_ORIGINAL_REQUEST_CHARS = 20_000;
const MAX_CHANGED_FILES = 80;

export interface EvidenceRerunRequestInput {
  runId: string;
  worktreePath: string;
  stagingRoot: string;
  originalRequest?: string;
  changedFiles: string[];
}

export function parseOriginalRunRequest(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const message = (value as { message?: unknown }).message;
  if (typeof message !== "string" || message.trim().length === 0) return undefined;
  return message.trim().slice(0, MAX_ORIGINAL_REQUEST_CHARS);
}

export function buildEvidenceRerunRequest(input: EvidenceRerunRequestInput): string {
  const changedFiles = input.changedFiles
    .map((file) => file.trim())
    .filter(Boolean)
    .slice(0, MAX_CHANGED_FILES);
  const originalRequest = input.originalRequest?.trim();
  return [
    "【补采验收截图】",
    `父 Run：${input.runId}`,
    `候选 worktree：${input.worktreePath}`,
    `截图输出目录：${input.stagingRoot}`,
    "",
    "【本次唯一验收范围】",
    originalRequest || "原 Run 未保存需求原文；只验证候选改动直接影响的可观察路径。",
    "",
    "【候选改动文件】",
    changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`).join("\n") : "- 未取得文件清单",
    "",
    "【执行约束】",
    "1. 只验证上面的原始需求与验收标准，不重新规划、实现或扩大范围。",
    "2. 优先复用现有服务和仓库已有的定向测试；不要运行全仓 npm run check，也不要读取或输出完整 Git diff。",
    "3. 界面需求必须按验收标准复现真实页面路径，采集 1–2 张能直接辨认结果的截图或录屏，并写入指定目录。",
    "4. 不得安装依赖，不得修改产品代码、配置、Git 历史或目标分支；媒体文件是唯一允许写入的内容。",
    "5. 若在聚焦验证后仍不具备验收条件，立即返回 block，准确说明失败步骤与缺口，不要继续扫描无关代码。"
  ].join("\n");
}
