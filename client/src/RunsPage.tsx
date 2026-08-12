import { useEffect, useMemo, useRef, useState } from "react";
import { api, writeBody } from "./api";
import { DossierSection, EmptyState, Modal, SelectControl, Stamp, formatTime, scrollRecordIntoView } from "./components";
import { SupervisorRunTopology } from "./SupervisorRunTopology";
import { EffectiveProfileView } from "./EffectiveProfileView";
import { acceptanceSnapshotFromPreview } from "./dashboard/acceptance";
import type { DashboardService } from "./dashboard/service";
import type { Requirement } from "./dashboard/types";
import type { HumanDecisionRequest, HumanDecisionRiskCategory, JsonValue, Run, RunDeliveryActionResult, RunDeliveryRecord, RunEvidenceAsset, RunMergePreview, RunMergeQueueResult, RunNode, RunWorktreeOpenResult } from "./types";

export { acceptanceSnapshotFromPreview } from "./dashboard/acceptance";

const CATEGORY_LABELS: Record<"single" | "graph" | "supervisor", string> = {
  single: "单任务",
  graph: "Graph 编排",
  supervisor: "领队协作"
};

export function filterRuns(
  runs: Run[],
  filters: { category: "all" | "single" | "graph" | "supervisor"; project: "all" | "none" | string }
): Run[] {
  return runs.filter((run) => {
    if (filters.category !== "all" && (run.category ?? "graph") !== filters.category) return false;
    if (filters.project === "none") return !run.project;
    if (filters.project !== "all" && run.project !== filters.project) return false;
    return true;
  });
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function supervisorDecision(node: RunNode): { action: string; summary?: string } | undefined {
  if (node.metadata?.kind !== "supervisor") return undefined;
  const output = objectValue(node.output);
  if (typeof output?.action !== "string") return undefined;
  return { action: output.action, summary: typeof output.summary === "string" ? output.summary : undefined };
}

function finalSummary(run: Run): string | undefined {
  const output = objectValue(run.output);
  return typeof output?.summary === "string" ? output.summary : undefined;
}

interface E2eEvidenceEntry {
  method?: string;
  steps?: string;
  observed?: string;
}

/** Reads a structured `e2eEvidence` array off any output object; tolerant of missing/oddly-typed fields. */
function e2eEvidenceEntries(value: JsonValue | undefined): E2eEvidenceEntry[] {
  const raw = objectValue(value)?.e2eEvidence;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => objectValue(item))
    .filter((item): item is Record<string, JsonValue> => item !== undefined)
    .map((item) => ({
      method: typeof item.method === "string" ? item.method : undefined,
      steps: typeof item.steps === "string" ? item.steps : undefined,
      observed: typeof item.observed === "string" ? item.observed : undefined
    }))
    .filter((entry) => entry.method || entry.steps || entry.observed);
}

function E2eEvidenceList({ entries }: { entries: E2eEvidenceEntry[] }) {
  if (entries.length === 0) return null;
  return <ul className="run-e2e-evidence">{entries.map((entry, index) => <li key={index}>
    {entry.method && <code className="run-e2e-method">{entry.method}</code>}
    {entry.steps && <span className="run-e2e-steps">{entry.steps}</span>}
    {entry.observed && <><span className="run-e2e-arrow" aria-hidden="true">→</span><span className="run-e2e-observed">{entry.observed}</span></>}
  </li>)}</ul>;
}

const GATE_STATUS_LABELS: Record<string, string> = {
  passed: "通过",
  blocked: "未通过",
  pending: "待判定",
  skipped: "跳过"
};

interface GateVerdict {
  gateId: string;
  status: string;
  reason?: string;
  requiredCapability?: string;
}

/** Reads the supervisor gate snapshot off `run.output.gates`; safe when absent or malformed. */
function gateVerdicts(value: JsonValue | undefined): GateVerdict[] {
  const raw = objectValue(value)?.gates;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => objectValue(item))
    .filter((item): item is Record<string, JsonValue> => item !== undefined && typeof item.gateId === "string")
    .map((item) => ({
      gateId: String(item.gateId),
      status: typeof item.status === "string" ? item.status : "unknown",
      reason: typeof item.reason === "string" ? item.reason : undefined,
      requiredCapability: typeof item.requiredCapability === "string" ? item.requiredCapability : undefined
    }));
}

function GateVerdictList({ gates }: { gates: GateVerdict[] }) {
  if (gates.length === 0) return null;
  return <ul className="run-gate-list">{gates.map((gate) => <li key={gate.gateId} className={`run-gate-item run-gate-item--${gate.status}`}>
    <div className="run-gate-head"><code>{gate.gateId}</code><span className={`gate-status gate-status--${gate.status}`}>{GATE_STATUS_LABELS[gate.status] ?? gate.status}</span>{gate.requiredCapability && <small>{gate.requiredCapability}</small>}</div>
    {gate.status !== "passed" && gate.reason && <p className="gate-reason">{gate.reason}</p>}
  </li>)}</ul>;
}

function dagFlowTag(node: RunNode): string {
  if (node.metadata?.kind !== "member" || typeof node.metadata.flowNodeId !== "string") return "";
  const kind = typeof node.metadata.flowNodeKind === "string" ? node.metadata.flowNodeKind : "dag";
  const execution = typeof node.metadata.flowNodeExecution === "number" && node.metadata.flowNodeExecution > 1
    ? ` · 第 ${node.metadata.flowNodeExecution} 次执行`
    : "";
  return ` · 环节 ${node.metadata.flowNodeId} [${kind}]${execution}`;
}

/** Renders the run's worktree-isolation evidence as a `<dd>`; falls back to "普通" when absent. */
function IsolationValue({ isolation }: { isolation: Run["isolation"] }) {
  if (isolation?.mode === "worktree") {
    return <span className="run-isolation run-isolation--worktree">worktree{isolation.worktreePath && <> · <code className="path-code">{isolation.worktreePath}</code></>}</span>;
  }
  if (isolation?.fallbackReason) {
    return <span className="run-isolation run-isolation--fallback">回退 · {isolation.fallbackReason}</span>;
  }
  return <span className="run-isolation run-isolation--none">普通</span>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

const HUMAN_DECISION_RISK_LABELS: Record<HumanDecisionRiskCategory, string> = {
  "dependency-install": "依赖安装",
  "data-migration": "数据迁移",
  "scope-expansion": "范围扩张",
  "irreversible-other": "其他不可逆操作"
};

const HUMAN_DECISION_STATUS_META: Record<HumanDecisionRequest["status"], { stamp: "blocked" | "passed" | "archived"; label: string }> = {
  pending: { stamp: "blocked", label: "等待决定" },
  approved: { stamp: "passed", label: "已批准" },
  rejected: { stamp: "blocked", label: "已拒绝" },
  voided: { stamp: "archived", label: "已作废" }
};

export type HumanDecisionKind = "approve" | "reject";

/** Sorts pending requests first (they need action), then newest first within each group. */
export function sortHumanDecisionRequests(requests: HumanDecisionRequest[]): HumanDecisionRequest[] {
  return [...requests].sort((a, b) => {
    const pending = Number(b.status === "pending") - Number(a.status === "pending");
    return pending !== 0 ? pending : b.createdAt.localeCompare(a.createdAt);
  });
}

function HumanDecisionCard({
  request,
  comment,
  deciding,
  onCommentChange,
  onOpenDecision
}: {
  request: HumanDecisionRequest;
  comment: string;
  deciding: boolean;
  onCommentChange: (value: string) => void;
  onOpenDecision: (decision: HumanDecisionKind) => void;
}) {
  const meta = HUMAN_DECISION_STATUS_META[request.status] ?? HUMAN_DECISION_STATUS_META.voided;
  const riskLabel = HUMAN_DECISION_RISK_LABELS[request.riskCategory] ?? request.riskCategory;
  if (request.status !== "pending") {
    return <article className={`human-decision-card human-decision-card--${request.status}`}>
      <div className="human-decision-card-head"><strong>{riskLabel}</strong><Stamp status={meta.stamp} label={meta.label} /></div>
      <p className="human-decision-summary">{request.summary}</p>
      <dl className="ledger horizontal">
        <dt>决定人</dt><dd>{request.decidedBy ?? "—"}</dd>
        <dt>决定时间</dt><dd>{request.decidedAt ? formatTime(request.decidedAt) : "—"}</dd>
      </dl>
      {request.comment && <blockquote className="human-decision-comment-quote">{request.comment}</blockquote>}
      <small className="human-decision-meta">领队节点 <code>{request.supervisorNodeId}</code> · Round {request.round} · 创建于 {formatTime(request.createdAt)}</small>
    </article>;
  }
  return <article className="human-decision-card human-decision-card--pending">
    <div className="human-decision-callout" role="alert">
      <strong>等待你的决定</strong>
      <p>领队在调度这项高风险操作前已暂停原 Run。批准后原 Run 继续执行；拒绝后反馈会返回领队重新规划。确认前不会有任何写入。</p>
    </div>
    <dl className="ledger">
      <dt>风险类型</dt><dd>{riskLabel}</dd>
      <dt>Workflow</dt><dd><code>{request.workflowId} · v{request.workflowVersion}</code></dd>
      <dt>Run</dt><dd><code>{request.runId}</code></dd>
      <dt>领队节点 / Round</dt><dd><code>{request.supervisorNodeId}</code> · Round {request.round}</dd>
      <dt>创建时间</dt><dd>{formatTime(request.createdAt)}</dd>
    </dl>
    <div className="human-decision-proposal">
      <strong>拟执行摘要</strong>
      <p className="human-decision-summary">{request.summary}</p>
      <strong>拟派单</strong>
      <pre className="result-json">{JSON.stringify(request.proposedAction, null, 2)}</pre>
    </div>
    <label className="human-decision-comment-field">
      <span>反馈（可选；拒绝时会返回给领队）</span>
      <textarea
        value={comment}
        rows={3}
        maxLength={4000}
        disabled={deciding}
        placeholder="例如：只允许安装锁定的依赖版本。"
        onChange={(event) => onCommentChange(event.target.value)}
      />
    </label>
    <div className="human-decision-actions">
      <button type="button" className="button danger" disabled={deciding} onClick={() => onOpenDecision("reject")}>拒绝并返回领队</button>
      <button type="button" className="button primary" disabled={deciding} onClick={() => onOpenDecision("approve")}>批准并继续原 Run</button>
    </div>
  </article>;
}

function HumanDecisionPanel({
  requests,
  loading,
  commentDrafts,
  deciding,
  onCommentChange,
  onOpenDecision
}: {
  requests: HumanDecisionRequest[];
  loading: boolean;
  commentDrafts: Record<string, string>;
  deciding: boolean;
  onCommentChange: (requestId: string, value: string) => void;
  onOpenDecision: (request: HumanDecisionRequest, decision: HumanDecisionKind) => void;
}) {
  if (loading && requests.length === 0) return <p className="run-delivery-loading">正在核对人在回路请求…</p>;
  if (requests.length === 0) return <p className="mini-empty">本 Run 没有人在回路请求。</p>;
  return <div className="human-decision-list">{sortHumanDecisionRequests(requests).map((request) => <HumanDecisionCard
    key={request.id}
    request={request}
    comment={commentDrafts[request.id] ?? ""}
    deciding={deciding}
    onCommentChange={(value) => onCommentChange(request.id, value)}
    onOpenDecision={(decision) => onOpenDecision(request, decision)}
  />)}</div>;
}

function HumanDecisionConfirmation({
  target,
  comment,
  busy,
  error,
  onClose,
  onConfirm
}: {
  target: { request: HumanDecisionRequest; decision: HumanDecisionKind };
  comment: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const approve = target.decision === "approve";
  const riskLabel = HUMAN_DECISION_RISK_LABELS[target.request.riskCategory] ?? target.request.riskCategory;
  return <Modal
    title={approve ? "确认批准并继续原 Run" : "确认拒绝并返回领队"}
    eyebrow="HUMAN DECISION · EXPLICIT CONFIRMATION"
    onClose={onClose}
  >
    <div className="modal-body human-decision-confirm">
      <div className="run-delivery-callout"><strong>确认前零写入</strong><p>打开此窗口不会提交任何内容。只有点击下方确认按钮后，才会发送这一次不可撤销的人工决定。</p></div>
      <dl className="ledger">
        <dt>请求</dt><dd><code>{target.request.id}</code></dd>
        <dt>风险类型</dt><dd>{riskLabel}</dd>
        <dt>拟执行摘要</dt><dd>{target.request.summary}</dd>
        <dt>决定</dt><dd>{approve ? "批准并继续原 Run" : "拒绝并返回领队"}</dd>
        {comment && <><dt>反馈</dt><dd>{comment}</dd></>}
      </dl>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>再想想</button>
        <button type="button" className={`button ${approve ? "primary" : "danger-filled"}`} disabled={busy} onClick={onConfirm}>{busy ? "提交中…" : approve ? "确认批准" : "确认拒绝"}</button>
      </div>
    </div>
  </Modal>;
}


/** 复制按钮：剪贴板不可用时给出可见错误， busy/copied/failed 都有非颜色信号。 */
function CopyButton({ value, label, className = "button ghost" }: { value: string; label: string; className?: string }) {
  const [status, setStatus] = useState<"idle" | "busy" | "copied" | "failed">("idle");
  const copy = async () => {
    if (status === "busy") return;
    setStatus("busy");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard is unavailable");
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    window.setTimeout(() => setStatus("idle"), 2500);
  };
  return <span className="copy-control">
    <button type="button" className={className} disabled={status === "busy"} aria-busy={status === "busy"} aria-live="polite" onClick={() => void copy()}>
      {status === "busy" ? "复制中…" : status === "copied" ? "已复制" : status === "failed" ? "复制失败" : label}
    </button>
    {status === "failed" && <span className="copy-error" role="alert">剪贴板不可用，请手动选择文本复制。</span>}
  </span>;
}

function RunDeliveryPanel({
  preview,
  loading,
  taskId,
  canSubmitToBoard,
  boardSubmitting,
  boardSubmitError,
  onOpenMerge,
  onOpenWorktree,
  openingWorktree,
  onOpenKeep,
  onOpenDiscard,
  onSubmitToBoard,
  onRerunEvidence,
  evidenceRerunError,
  onRetryConflict,
  conflictRetrying,
  conflictRetryError
}: {
  preview?: RunMergePreview;
  loading: boolean;
  taskId?: string;
  canSubmitToBoard: boolean;
  boardSubmitting: boolean;
  boardSubmitError: string;
  onOpenMerge: () => void;
  onOpenWorktree: () => void;
  openingWorktree: boolean;
  onOpenKeep: () => void;
  onOpenDiscard: () => void;
  onSubmitToBoard: () => void;
  onRerunEvidence: () => void;
  evidenceRerunError: string;
  onRetryConflict: () => void;
  conflictRetrying: boolean;
  conflictRetryError: string;
}) {
  if (loading && !preview) return <p className="run-delivery-loading">正在核对 worktree 与验收证据…</p>;
  if (!preview) return null;
  const conflict = preview.status === "conflict" || preview.delivery?.status === "conflict";
  const merged = preview.status === "merged" || preview.delivery?.status === "merged";
  const kept = preview.status === "kept" || preview.delivery?.status === "kept";
  const discarded = preview.status === "discarded" || preview.delivery?.status === "discarded";
  const queued = preview.status === "queued-for-merge" || preview.delivery?.status === "queued-for-merge";
  const retesting = preview.status === "retesting" || preview.delivery?.status === "retesting";
  const merging = preview.status === "merging" || preview.delivery?.status === "merging";
  const returned = preview.status === "returned-to-acceptance" || preview.delivery?.status === "returned-to-acceptance";
  const mergeBusy = queued || retesting || merging;
  const evidenceRerun = preview.delivery?.evidenceRerun;
  const conflictResolution = preview.delivery?.conflictResolution;
  const evidenceBusy = evidenceRerun?.status === "queued" || evidenceRerun?.status === "running";
  const evidenceFailed = evidenceRerun?.status === "failed";
  const evidenceMissing = preview.evidence.assets.length === 0;
  const evidenceRecovered = !evidenceMissing && Boolean(
    evidenceRerun?.message?.includes("恢复")
    || (evidenceFailed && evidenceRerun?.mediaCount)
  );
  const evidenceNeedsAttention = evidenceMissing;
  const conflictBusy = conflict && ["resolving", "retesting", "leader-review"].includes(conflictResolution?.status ?? "");
  const actionable = !merged && !discarded && !mergeBusy && !conflictBusy && Boolean(preview.worktreePath) && (preview.status === "awaiting-acceptance" || preview.status === "conflict" || preview.status === "kept" || preview.status === "returned-to-acceptance");
  const canQueueMerge = preview.eligible && !merged && !discarded && !mergeBusy && !evidenceBusy && preview.status !== "conflict";
  const canRerunEvidence = evidenceNeedsAttention && !evidenceBusy && !mergeBusy && !conflictBusy && Boolean(preview.worktreePath) && !discarded && !merged;
  const diff = preview.changes.unifiedDiff;
  return <div className="run-delivery-panel">
    {conflict && <div className="run-delivery-callout run-delivery-callout--conflict" role="alert"><strong>{conflictResolution?.status === "resolving" ? "原领队正在规划并委派冲突修复" : conflictResolution?.status === "retesting" ? "冲突已解决，正在回跑测试" : conflictResolution?.status === "leader-review" ? "测试已通过，等待原领队放行" : conflictResolution?.status === "failed" ? "AI 冲突处理需要介入" : "目标分支存在合并冲突"}</strong><p>{preview.delivery?.message ?? "候选仍在待合入队列，原 worktree 与证据均已保留。"}</p>{conflictResolution?.leaderPlanRunId && <small>领队计划 Run：<code>{conflictResolution.leaderPlanRunId}</code></small>}{conflictResolution?.executionRoleId && <small>执行角色：<code>{conflictResolution.executionRoleId}</code></small>}{conflictResolution?.resolutionRunId && <small>工程修复 Run：<code>{conflictResolution.resolutionRunId}</code></small>}{conflictResolution?.testRunId && <small>复测 Run：<code>{conflictResolution.testRunId}</code></small>}{conflictResolution?.leaderReviewRunId && <small>领队复验 Run：<code>{conflictResolution.leaderReviewRunId}</code></small>}{conflictResolution?.status === "failed" && <button type="button" className="button secondary" disabled={conflictRetrying} aria-busy={conflictRetrying} onClick={onRetryConflict}>{conflictRetrying ? "正在重新排队…" : "重新让原领队处理冲突"}</button>}{conflictRetryError && <small className="inline-error">{conflictRetryError}</small>}</div>}
    {queued && <div className="run-delivery-callout run-delivery-callout--queued" role="status"><strong>已进入待合入队列</strong><p>{preview.delivery?.message ?? "同一目标分支上的候选会按批准顺序串行处理。"}</p></div>}
    {retesting && <div className="run-delivery-callout run-delivery-callout--retesting" role="status"><strong>{conflictResolution ? "冲突处理 2/3 · 正在重新验收" : "合入检查 1/2 · 目标变化后正在重测"}</strong><p>{preview.delivery?.message ?? "系统正在隔离环境执行独立回归。"}</p><small>{conflictResolution ? "当前尚未写入目标分支；独立测试通过后还需原领队复验，放行后才会自动合入。" : "当前尚未写入目标分支；独立回归通过后才会进入真正的合入阶段。"}</small></div>}
    {merging && <div className="run-delivery-callout run-delivery-callout--queued" role="status"><strong>合入处理 3/3 · 正在写入目标分支</strong><p>{preview.delivery?.message ?? "测试与复验已经通过，正在写入已批准的目标分支。"}</p></div>}
    {returned && <div className="run-delivery-callout run-delivery-callout--conflict" role="alert"><strong>自动合入已退回待验收</strong><p>{preview.delivery?.message ?? "候选 worktree 已保留，请处理异常后重新验收。"}</p></div>}
    {merged && <div className="run-delivery-callout run-delivery-callout--merged"><strong>交付已合并</strong><p>{preview.delivery?.mergeCommit ? <>Merge commit：<code>{preview.delivery.mergeCommit}</code></> : "合并记录已归档。"}</p></div>}
    {kept && <div className="run-delivery-callout run-delivery-callout--kept"><strong>交付已人工保留</strong><p>{preview.delivery?.humanDecision ? <>由 <code>{preview.delivery.humanDecision.actor}</code> 于 {formatTime(preview.delivery.humanDecision.at)} 标记保留；候选 worktree 原样保留，未执行 merge 或 push。{preview.delivery.humanDecision.note ? <> 备注:{preview.delivery.humanDecision.note}</> : null}</> : (preview.delivery?.message ?? "候选 worktree 已保留，未执行 merge 或 push。")}</p></div>}
    {discarded && <div className="run-delivery-callout run-delivery-callout--discarded" role="alert"><strong>候选结果已丢弃</strong><p>{preview.delivery?.humanDecision ? <>由 <code>{preview.delivery.humanDecision.actor}</code> 于 {formatTime(preview.delivery.humanDecision.at)} 确认丢弃；候选 worktree 已清理，合并、保留与丢弃操作均已关闭。{preview.delivery.humanDecision.note ? <> 备注:{preview.delivery.humanDecision.note}</> : null}</> : "候选 worktree 已清理，不能再合并、保留或丢弃。"}</p></div>}
    <dl className="ledger">
      <dt>目标分支</dt><dd>{preview.targetBranch ? <code>{preview.targetBranch}</code> : "—"}</dd>
      <dt>目标状态</dt><dd>{preview.targetClean ? "洁净" : "不可合并"}</dd>
      <dt>变更文件</dt><dd>{preview.changes.fileCount}</dd>
      <dt>结构化 E2E</dt><dd>{preview.evidence.structuredE2eCount} 条</dd>
      {preview.worktreePath && <><dt>候选 worktree</dt><dd className="run-delivery-path"><code className="path-code">{preview.worktreePath}</code><span className="run-delivery-path-actions"><button type="button" className="button ghost" disabled={openingWorktree || discarded} aria-busy={openingWorktree} onClick={onOpenWorktree}>{openingWorktree ? "打开中…" : "在系统中打开"}</button><CopyButton value={preview.worktreePath} label="复制路径" /></span></dd></>}
    </dl>
    {preview.reasons.length > 0 && <div className="run-delivery-reasons"><strong>当前不能合并</strong><ul>{preview.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
    {preview.changes.files.length > 0 && <div className="run-delivery-changes"><strong>代码变更</strong><ul>{preview.changes.files.map((file, index) => <li key={`${file.status}-${file.path}-${index}`}><code>{file.status}</code><span>{file.path}</span></li>)}</ul>{preview.changes.summary && <pre>{preview.changes.summary}</pre>}</div>}
    {diff.text && <details className="run-delivery-diff">
      <summary><strong>完整 unified diff</strong><span>{diff.truncated ? `已截断 · 上限 ${formatBytes(diff.maxBytes)}` : `${formatBytes(new TextEncoder().encode(diff.text).length)}`}</span></summary>
      {diff.truncated && <p className="run-delivery-diff-truncated" role="note">diff 超过 {formatBytes(diff.maxBytes)}，仅展示前半部分；完整内容请在候选 worktree 中用下方安全命令查看。</p>}
      <pre className="run-delivery-diff-text">{diff.text}</pre>
    </details>}
    {preview.safeGitCommands.length > 0 && <div className="run-delivery-git">
      <div className="run-delivery-git-head"><strong>安全 Git 检查命令</strong><CopyButton value={preview.safeGitCommands.join("\n")} label="复制全部命令" /></div>
      <p className="run-delivery-git-hint">只读命令，用于在终端自行核对候选交付；不会修改任何分支。</p>
      <ul>{preview.safeGitCommands.map((command) => <li key={command}><code>{command}</code><CopyButton value={command} label="复制" /></li>)}</ul>
    </div>}
    <div className="run-delivery-evidence">
      <div className="run-delivery-evidence-head"><strong>Evidence wall</strong><span>{preview.evidence.assets.length} 项媒体证据</span></div>
      {evidenceRecovered && <div className="run-delivery-evidence-attention run-delivery-evidence-attention--recovered" role="status">
        <div><strong>媒体证据已恢复，无需重复补采</strong><p>{evidenceRerun?.message ?? `daemon 中断了补采过程，但已恢复 ${preview.evidence.assets.length} 项可验收媒体；现有证据继续参与交付门禁。`}</p></div>
        <Stamp status="passed" label={`${preview.evidence.assets.length} 项可查看`} />
      </div>}
      {evidenceNeedsAttention && <div className={`run-delivery-evidence-attention${evidenceFailed ? " run-delivery-evidence-attention--interrupted" : ""}`} role="status">
        <div><strong>{evidenceFailed ? "截图补采失败，仍没有可查看媒体" : "缺少可查看的截图或录屏"}</strong><p>{evidenceFailed ? (evidenceRerun.message ?? "上一轮补采未产出媒体证据，可以重新运行独立验收。") : "结构化 E2E 已保留；是否让项目 test-engineer 重新走一遍验收路径并补采真实界面证据？"}</p></div>
        <button type="button" className="button secondary" disabled={!canRerunEvidence} aria-busy={evidenceBusy} onClick={onRerunEvidence}>{evidenceBusy ? "test-engineer 补采中…" : evidenceFailed ? "重新运行 test-engineer 补采" : "让 test-engineer 补采证据"}</button>
        {!canRerunEvidence && mergeBusy && <small>当前合入流程正在重测或写入，不能并行启动另一轮补采；若交付退回验收，可在这里直接重跑。</small>}
        {evidenceRerunError && <small className="inline-error" role="alert">{evidenceRerunError}</small>}
      </div>}
      {preview.evidence.assets.length > 0 && <div className="run-delivery-evidence-wall">{preview.evidence.assets.map((asset) => <RunEvidenceCard key={asset.id} asset={asset} />)}</div>}
    </div>
    {boardSubmitError && <div className="inline-error" role="alert">{boardSubmitError}</div>}
    {(preview.eligible || actionable || canSubmitToBoard) && !discarded && <div className="run-delivery-actions">
      {canSubmitToBoard && <button type="button" className="button secondary" disabled={boardSubmitting} aria-busy={boardSubmitting} onClick={onSubmitToBoard} title={taskId ? `写入看板需求 ${taskId} 的验收快照并迁移到待验收` : undefined}>{boardSubmitting ? "提交中…" : "提交该需求到待验收"}</button>}
      {actionable && <button type="button" className="button danger" onClick={onOpenDiscard}>丢弃候选结果</button>}
      {actionable && <button type="button" className="button secondary" onClick={onOpenKeep}>人工保留</button>}
      {canQueueMerge && <button type="button" className="button primary" onClick={onOpenMerge}>批准并加入待合入</button>}
    </div>}
  </div>;
}

function RunEvidenceCard({ asset }: { asset: RunEvidenceAsset }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  return <>
    <figure className="run-delivery-evidence-card">
      {asset.kind === "screenshot"
        ? <button type="button" className="run-delivery-evidence-trigger" aria-haspopup="dialog" aria-label={`在项目内预览证据 ${asset.name}`} onClick={() => setPreviewOpen(true)}><img className="run-delivery-evidence-media" src={asset.url} alt={asset.name} loading="lazy" /></button>
        : <video className="run-delivery-evidence-media" src={asset.url} controls preload="metadata" aria-label={asset.name} />}
      <figcaption><strong>{asset.name}</strong><span>{asset.kind === "screenshot" ? "截图 · 点击放大" : "录屏"} · {formatBytes(asset.sizeBytes)}</span><code>{asset.relativePath}</code></figcaption>
    </figure>
    {asset.kind === "screenshot" && previewOpen && <Modal title={asset.name} eyebrow="PROJECT EVIDENCE · IMAGE VIEWER" onClose={() => setPreviewOpen(false)} wide className="run-evidence-viewer-modal">
      <div className="run-evidence-viewer">
        <div className="run-evidence-viewer-stage"><img src={asset.url} alt={asset.name} /></div>
        <footer><span>{asset.mediaType.split("/")[1]?.toUpperCase()} · {formatBytes(asset.sizeBytes)}</span><code>{asset.relativePath}</code><a className="button secondary" href={asset.url} target="_blank" rel="noreferrer">打开原始文件</a></footer>
      </div>
    </Modal>}
  </>;
}

function RunKeepConfirmation({
  preview,
  note,
  busy,
  error,
  onNoteChange,
  onClose,
  onKeep
}: {
  preview: RunMergePreview;
  note: string;
  busy: boolean;
  error: string;
  onNoteChange: (value: string) => void;
  onClose: () => void;
  onKeep: () => void;
}) {
  return <Modal title="人工保留候选交付" eyebrow="KEEP · NO MERGE · NO PUSH" onClose={onClose}>
    <div className="modal-body run-delivery-confirm">
      <div className="run-delivery-callout"><strong>只记录保留决定</strong><p>确认后服务端会把该交付标记为「人工保留」，候选 worktree 原样留在磁盘上；不会执行 merge，更不会 push。</p></div>
      <dl className="ledger">
        <dt>Run</dt><dd><code>{preview.runId}</code></dd>
        <dt>候选 worktree</dt><dd><code className="path-code">{preview.worktreePath}</code></dd>
        <dt>变更文件</dt><dd>{preview.changes.fileCount}</dd>
      </dl>
      <label className="run-delivery-note-field"><span>备注（可选，随保留决定归档）</span><textarea rows={3} maxLength={2000} value={note} disabled={busy} placeholder="例如：等待产品确认后再手动合并。" onChange={(event) => onNoteChange(event.target.value)} /></label>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="button" className="button primary" disabled={busy} onClick={onKeep}>{busy ? "提交中…" : "确认人工保留"}</button></div>
    </div>
  </Modal>;
}

function RunDiscardConfirmation({
  preview,
  token,
  note,
  busy,
  error,
  onTokenChange,
  onNoteChange,
  onClose,
  onDiscard
}: {
  preview: RunMergePreview;
  token: string;
  note: string;
  busy: boolean;
  error: string;
  onTokenChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onClose: () => void;
  onDiscard: () => void;
}) {
  const exact = token === preview.discardConfirmationToken;
  return <Modal title="丢弃候选结果" eyebrow="DISCARD · IRREVERSIBLE" onClose={onClose}>
    <div className="modal-body run-delivery-confirm">
      <div className="danger-notice"><b>候选 worktree 将被物理清理。</b><p>确认后服务端会删除该 Run 的候选 worktree 与未合并改动，此操作不可撤销；不会触碰目标分支，也不会 push。</p></div>
      <dl className="ledger">
        <dt>Run</dt><dd><code>{preview.runId}</code></dd>
        <dt>候选 worktree</dt><dd><code className="path-code">{preview.worktreePath}</code></dd>
        <dt>变更文件</dt><dd>{preview.changes.fileCount}</dd>
      </dl>
      <label className="run-delivery-token-field"><span>输入 <code>{preview.discardConfirmationToken}</code> 以确认丢弃</span><input type="text" value={token} disabled={busy} autoComplete="off" spellCheck={false} aria-invalid={token.length > 0 && !exact} placeholder={preview.discardConfirmationToken} onChange={(event) => onTokenChange(event.target.value)} />{token.length > 0 && !exact && <small className="run-delivery-token-mismatch" role="alert">确认文字不匹配，请完整输入 {preview.discardConfirmationToken}</small>}</label>
      <label className="run-delivery-note-field"><span>备注（可选，随丢弃决定归档）</span><textarea rows={3} maxLength={2000} value={note} disabled={busy} placeholder="例如：方案作废，改由新 Run 重做。" onChange={(event) => onNoteChange(event.target.value)} /></label>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="button" className="button danger-filled" disabled={busy || !exact} onClick={onDiscard}>{busy ? "丢弃中…" : "确认丢弃候选结果"}</button></div>
    </div>
  </Modal>;
}


function RunMergeConfirmation({
  preview,
  confirmed,
  busy,
  error,
  onConfirmedChange,
  onClose,
  onMerge
}: {
  preview: RunMergePreview;
  confirmed: boolean;
  busy: boolean;
  error: string;
  onConfirmedChange: (value: boolean) => void;
  onClose: () => void;
  onMerge: () => void;
}) {
  return <Modal title="批准并加入待合入" eyebrow="HUMAN ACCEPTANCE · SERIAL MERGE QUEUE" onClose={onClose} wide>
    <div className="modal-body run-delivery-confirm">
      <div className="run-delivery-callout"><strong>批准后由队列串行推进</strong><p>当前预览只读。确认后候选进入待合入；若前序合并改变目标分支，系统会先在临时集成 worktree 重测。冲突、重测失败或意外会保留候选并退回待验收，不会自动 push。</p></div>
      <dl className="ledger">
        <dt>Run</dt><dd><code>{preview.runId}</code></dd>
        <dt>目标分支</dt><dd><code>{preview.targetBranch}</code></dd>
        <dt>变更文件</dt><dd>{preview.changes.fileCount}</dd>
        <dt>验收媒体</dt><dd>{preview.evidence.assets.length}</dd>
        <dt>确认 token</dt><dd><code>{preview.confirmationToken}</code></dd>
      </dl>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <label className="run-delivery-confirm-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => onConfirmedChange(event.target.checked)} /><span><strong>我已核对代码变更与验收证据，并批准进入目标分支合入队列</strong><small>这次确认不会被自动化扩大到其它候选；每个需求仍需独立人工批准。</small></span></label>
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="button" className="button primary" disabled={busy || !confirmed} onClick={onMerge}>{busy ? "入队中…" : `批准并排队合入 ${preview.targetBranch}`}</button></div>
    </div>
  </Modal>;
}

export function RunsPage({ notify, activityRevision = "", focusedRunId = "", pendingRunId = "", onConsumePending, onSelectRun, onDashboardSync, mode = "full", view = "all", dashboard }: {
  notify: (message: string, kind?: "success" | "error") => void;
  activityRevision?: string;
  focusedRunId?: string;
  /** @deprecated use focusedRunId; retained for callers during the hash-routing migration. */
  pendingRunId?: string;
  onConsumePending?: () => void;
  onSelectRun?: (runId: string) => void;
  onDashboardSync?: (requirement: Requirement) => void;
  mode?: "full" | "embedded";
  view?: "all" | "acceptance";
  /** 可选看板服务；注入后合格交付可以把验收快照原子写回需求看板。 */
  dashboard?: DashboardService;
}) {
  const requestedRunId = focusedRunId || pendingRunId;
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Run>();
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<"all" | "single" | "graph" | "supervisor">("all");
  const [projectFilter, setProjectFilter] = useState<"all" | "none" | string>("all");
  const [mergePreview, setMergePreview] = useState<RunMergePreview>();
  const [mergePreviewLoading, setMergePreviewLoading] = useState(false);
  const [deliveryRevision, setDeliveryRevision] = useState(0);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeConfirmed, setMergeConfirmed] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState("");
  const [keepOpen, setKeepOpen] = useState(false);
  const [keepNote, setKeepNote] = useState("");
  const [keeping, setKeeping] = useState(false);
  const [keepError, setKeepError] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardToken, setDiscardToken] = useState("");
  const [discardNote, setDiscardNote] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState("");
  const [boardSubmitting, setBoardSubmitting] = useState(false);
  const [boardSubmitError, setBoardSubmitError] = useState("");
  const [evidenceRerunError, setEvidenceRerunError] = useState("");
  const [conflictRetrying, setConflictRetrying] = useState(false);
  const [conflictRetryError, setConflictRetryError] = useState("");
  const [openingWorktree, setOpeningWorktree] = useState(false);
  const [humanRequests, setHumanRequests] = useState<HumanDecisionRequest[]>([]);
  const [humanRequestsLoading, setHumanRequestsLoading] = useState(false);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [decisionTarget, setDecisionTarget] = useState<{ request: HumanDecisionRequest; decision: HumanDecisionKind }>();
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [decisionRevision, setDecisionRevision] = useState(0);
  const detailRunIdRef = useRef("");
  // A deep link should reveal its Run once when the operator enters the dossier.
  // Activity SSE updates also refresh this list; treating every refresh as a new
  // navigation would repeatedly scroll the operator away from the evidence they
  // are currently reading.
  const revealedRunIdRef = useRef("");
  // Dashboard projection callbacks are UI events, not polling inputs. Keeping the
  // latest callback in a ref prevents an inline parent callback from retriggering
  // terminal delivery/capture effects on every render.
  const onDashboardSyncRef = useRef(onDashboardSync);
  onDashboardSyncRef.current = onDashboardSync;
  useEffect(() => {
    let current = true;
    api<Run[]>("/api/runs?limit=100").then((value) => {
      if (!current) return;
      setRuns(value);
      setSelectedId((selected) => selected || value[0]?.id || "");
      // A memory detail can hand us a run to open. Select and reveal it once the
      // list confirms the run exists; silently ignore ids absent from the list.
      if (requestedRunId && value.some((run) => run.id === requestedRunId)) {
        setSelectedId(requestedRunId);
        if (pendingRunId) onConsumePending?.();
      }
    }).catch((error: unknown) => {
      if (current) notify(error instanceof Error ? error.message : String(error), "error");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [notify, activityRevision, requestedRunId, pendingRunId, onConsumePending, mode]);
  useEffect(() => {
    if (!requestedRunId) {
      revealedRunIdRef.current = "";
      return;
    }
    if (mode !== "full"
      || revealedRunIdRef.current === requestedRunId
      || !runs.some((run) => run.id === requestedRunId)) return;
    revealedRunIdRef.current = requestedRunId;
    scrollRecordIntoView(requestedRunId);
  }, [mode, requestedRunId, runs]);
  useEffect(() => {
    if (!selectedId) {
      detailRunIdRef.current = "";
      setDetail(undefined);
      return;
    }
    let current = true;
    // Clear only when the operator selects another Run. Activity SSE updates refresh the same
    // dossier in the background; blanking it first changes page height and visibly jumps scroll.
    if (detailRunIdRef.current !== selectedId) {
      detailRunIdRef.current = selectedId;
      setDetail(undefined);
    }
    api<Run>(`/api/runs/${encodeURIComponent(selectedId)}`)
      .then((value) => { if (current) setDetail(value); })
      .catch((error: unknown) => { if (current) notify(error instanceof Error ? error.message : String(error), "error"); });
    return () => { current = false; };
  }, [selectedId, notify, activityRevision, decisionRevision]);
  const projectOptions = useMemo(
    () => [...new Set(runs.map((run) => run.project).filter((project): project is string => Boolean(project)))].sort(),
    [runs]
  );
  const visibleRuns = useMemo(
    () => filterRuns(runs, { category: categoryFilter, project: projectFilter }),
    [runs, categoryFilter, projectFilter]
  );
  const summary = visibleRuns.find((run) => run.id === selectedId) ?? visibleRuns[0];
  const selected = detail?.id === summary?.id ? detail : summary;
  useEffect(() => {
    if (!selected?.id) {
      setMergePreview(undefined);
      return;
    }
    // Form state belongs to one selected delivery. Background delivery polling must never reset
    // an open dossier or its controls.
    setMergePreview(undefined);
    setMergePreviewLoading(true);
    setMergeOpen(false);
    setMergeConfirmed(false);
    setMergeError("");
    setKeepOpen(false);
    setKeepNote("");
    setKeepError("");
    setDiscardOpen(false);
    setDiscardToken("");
    setDiscardNote("");
    setDiscardError("");
    setBoardSubmitError("");
    setEvidenceRerunError("");
    setConflictRetryError("");
  }, [selected?.id]);
  useEffect(() => {
    if (!selected?.id) return;
    let current = true;
    setMergePreviewLoading(true);
    api<RunMergePreview>(`/api/runs/${encodeURIComponent(selected.id)}/merge-preview`)
      .then((value) => { if (current) setMergePreview(value); })
      .catch((error: unknown) => { if (current) notify(error instanceof Error ? error.message : String(error), "error"); })
      .finally(() => { if (current) setMergePreviewLoading(false); });
    return () => { current = false; };
  }, [selected?.id, activityRevision, deliveryRevision, notify]);
  useEffect(() => {
    const status = mergePreview?.delivery?.status;
    const evidenceStatus = mergePreview?.delivery?.evidenceRerun?.status;
    const conflictStatus = mergePreview?.delivery?.conflictResolution?.status;
    if (!["queued-for-merge", "retesting", "merging"].includes(status ?? "")
      && !["resolving", "retesting", "leader-review"].includes(conflictStatus ?? "")
      && !["queued", "running"].includes(evidenceStatus ?? "")) return;
    const timer = window.setTimeout(() => setDeliveryRevision((value) => value + 1), 2_000);
    return () => window.clearTimeout(timer);
  }, [mergePreview?.delivery?.status, mergePreview?.delivery?.updatedAt, mergePreview?.delivery?.conflictResolution?.status, mergePreview?.delivery?.evidenceRerun?.status]);
  useEffect(() => {
    if (!dashboard || !selected?.taskId || !mergePreview?.delivery) return;
    const status = mergePreview.delivery.status;
    if (!["queued-for-merge", "retesting", "merging", "merged", "conflict", "returned-to-acceptance"].includes(status)) return;
    void dashboard.syncRequirementDelivery(
      selected.taskId,
      selected.id,
      status as "queued-for-merge" | "retesting" | "merging" | "merged" | "conflict" | "returned-to-acceptance"
    ).then((updated) => onDashboardSyncRef.current?.(updated)).catch(() => undefined);
  }, [dashboard, selected?.taskId, selected?.id, mergePreview?.delivery?.status, mergePreview?.delivery?.updatedAt]);
  useEffect(() => {
    const capture = mergePreview?.delivery?.evidenceRerun;
    if (!dashboard || !selected?.taskId || !selected.id || !capture) return;
    void dashboard.syncRequirementEvidenceCapture(selected.taskId, selected.id, {
      status: capture.status,
      updatedAt: capture.updatedAt,
      message: capture.message,
      mediaCount: mergePreview.evidence.assets.length
    }).then((updated) => onDashboardSyncRef.current?.(updated)).catch(() => undefined);
  }, [dashboard, selected?.taskId, selected?.id, mergePreview?.delivery?.evidenceRerun?.status, mergePreview?.delivery?.evidenceRerun?.updatedAt, mergePreview?.evidence.assets.length]);
  useEffect(() => {
    if (!selected?.id) {
      setHumanRequests([]);
      return;
    }
    let current = true;
    setHumanRequestsLoading(true);
    setDecisionTarget(undefined);
    setDecisionError("");
    api<HumanDecisionRequest[]>("/api/human-decision-requests")
      .then((value) => {
        if (!current) return;
        const list = Array.isArray(value) ? value : [];
        setHumanRequests(list.filter((request) => request.runId === selected.id));
      })
      .catch((error: unknown) => { if (current) notify(error instanceof Error ? error.message : String(error), "error"); })
      .finally(() => { if (current) setHumanRequestsLoading(false); });
    return () => { current = false; };
    // The list endpoint scopes by invocation, not run; filtering by runId keeps this pinned to the open dossier.
  }, [selected?.id, activityRevision, decisionRevision, notify]);
  const openDecision = (request: HumanDecisionRequest, decision: HumanDecisionKind) => {
    if (deciding || request.status !== "pending") return;
    setDecisionError("");
    setDecisionTarget({ request, decision });
  };
  const submitDecision = async () => {
    if (!decisionTarget || deciding) return;
    const comment = (commentDrafts[decisionTarget.request.id] ?? "").trim();
    setDeciding(true);
    setDecisionError("");
    try {
      const updated = await api<HumanDecisionRequest>(
        `/api/human-decision-requests/${encodeURIComponent(decisionTarget.request.id)}/decide`,
        writeBody({
          decision: decisionTarget.decision,
          decidedBy: "workbench-operator",
          ...(comment ? { comment } : {})
        })
      );
      setHumanRequests((list) => list.map((item) => (item.id === updated.id ? updated : item)));
      setCommentDrafts((drafts) => {
        const next = { ...drafts };
        delete next[updated.id];
        return next;
      });
      setDecisionTarget(undefined);
      setDecisionRevision((value) => value + 1);
      notify(decisionTarget.decision === "approve" ? "已批准，原 Run 继续执行。" : "已拒绝，任务返回领队重新规划。", "success");
    } catch (error) {
      // Keep the modal open and the feedback draft intact so the operator can retry unchanged.
      setDecisionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeciding(false);
    }
  };
  const openMerge = () => {
    if (!mergePreview?.eligible) return;
    setMergeConfirmed(false);
    setMergeError("");
    setMergeOpen(true);
  };
  const mergeDelivery = async () => {
    if (!selected || !mergePreview?.eligible || !mergePreview.targetBranch || !mergeConfirmed || merging) return;
    setMerging(true);
    setMergeError("");
    try {
      if (dashboard && selected.taskId) {
        const updated = await dashboard.submitRequirementForAcceptance(
          selected.taskId,
          acceptanceSnapshotFromPreview(mergePreview, new Date().toISOString())
        );
        onDashboardSyncRef.current?.(updated);
      }
      const result = await api<RunMergeQueueResult>(`/api/runs/${encodeURIComponent(selected.id)}/merge-queue`, {
        method: "POST",
        body: JSON.stringify({
          confirmation: mergePreview.confirmationToken,
          targetBranch: mergePreview.targetBranch,
          actor: "workbench-operator"
        })
      });
      setMergeOpen(false);
      if (dashboard && selected.taskId) {
        const updated = await dashboard.syncRequirementDelivery(selected.taskId, selected.id, result.status);
        onDashboardSyncRef.current?.(updated);
      }
      setDeliveryRevision((value) => value + 1);
      notify(`Run ${selected.id} 已进入 ${result.delivery.targetBranch} 的待合入队列。`, "success");
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : String(error));
    } finally {
      setMerging(false);
    }
  };
  const rerunEvidence = async () => {
    if (!selected || !mergePreview?.worktreePath) return;
    setEvidenceRerunError("");
    try {
      const delivery = await api<RunDeliveryRecord>(`/api/runs/${encodeURIComponent(selected.id)}/evidence-rerun`, writeBody({
        actor: "workbench-operator"
      }));
      if (dashboard && selected.taskId && delivery.evidenceRerun) {
        const updated = await dashboard.syncRequirementEvidenceCapture(selected.taskId, selected.id, {
          status: delivery.evidenceRerun.status,
          updatedAt: delivery.evidenceRerun.updatedAt,
          message: delivery.evidenceRerun.message,
          mediaCount: mergePreview.evidence.assets.length
        });
        onDashboardSyncRef.current?.(updated);
      }
      setDeliveryRevision((value) => value + 1);
      notify(`Run ${selected.id} 已进入独立截图验收队列。`, "success");
    } catch (error) {
      setEvidenceRerunError(error instanceof Error ? error.message : String(error));
    }
  };
  const retryConflict = async () => {
    if (!selected || conflictRetrying) return;
    setConflictRetrying(true);
    setConflictRetryError("");
    try {
      await api<RunMergeQueueResult>(`/api/runs/${encodeURIComponent(selected.id)}/merge-conflict-retry`, writeBody({ actor: "workbench-operator" }));
      setDeliveryRevision((value) => value + 1);
      notify(`Run ${selected.id} 已重新进入冲突处理队列，原领队会继续使用保留的 worktree。`, "success");
    } catch (error) {
      setConflictRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setConflictRetrying(false);
    }
  };
  const keepDelivery = async () => {
    if (!selected || keeping) return;
    setKeeping(true);
    setKeepError("");
    try {
      const note = keepNote.trim();
      await api<RunDeliveryActionResult>(`/api/runs/${encodeURIComponent(selected.id)}/keep`, writeBody({
        actor: "workbench-operator",
        ...(note ? { note } : {})
      }));
      setKeepOpen(false);
      setKeepNote("");
      setDeliveryRevision((value) => value + 1);
      notify(`Run ${selected.id} 已标记为人工保留；未执行 merge 或 push。`, "success");
    } catch (error) {
      // 保留弹窗与备注草稿，操作者可原样重试。
      setKeepError(error instanceof Error ? error.message : String(error));
    } finally {
      setKeeping(false);
    }
  };
  const discardDelivery = async () => {
    if (!selected || !mergePreview || discarding) return;
    if (discardToken !== mergePreview.discardConfirmationToken) return;
    setDiscarding(true);
    setDiscardError("");
    try {
      const note = discardNote.trim();
      await api<RunDeliveryActionResult>(`/api/runs/${encodeURIComponent(selected.id)}/discard`, writeBody({
        confirmation: discardToken,
        actor: "workbench-operator",
        ...(note ? { note } : {})
      }));
      setDiscardOpen(false);
      setDiscardToken("");
      setDiscardNote("");
      setDeliveryRevision((value) => value + 1);
      notify(`Run ${selected.id} 的候选结果已丢弃；候选 worktree 已清理。`, "success");
    } catch (error) {
      setDiscardError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiscarding(false);
    }
  };
  const submitToBoard = async () => {
    if (!dashboard || !selected?.taskId || !mergePreview?.eligible || boardSubmitting) return;
    setBoardSubmitting(true);
    setBoardSubmitError("");
    try {
      const snapshot = acceptanceSnapshotFromPreview(mergePreview, new Date().toISOString());
      const updated = await dashboard.submitRequirementForAcceptance(selected.taskId, snapshot);
      onDashboardSyncRef.current?.(updated);
      notify(`${updated.code} 已提交到待验收；Run ${snapshot.runId} 验收快照已固定。`, "success");
    } catch (error) {
      setBoardSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBoardSubmitting(false);
    }
  };
  const openWorktree = async () => {
    if (!selected || openingWorktree) return;
    setOpeningWorktree(true);
    try {
      const opened = await api<RunWorktreeOpenResult>(`/api/runs/${encodeURIComponent(selected.id)}/open-worktree`, { method: "POST" });
      notify(`已在系统中打开 Run ${opened.runId} 的候选 worktree。`, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setOpeningWorktree(false);
    }
  };
  const canSubmitToBoard = Boolean(
    dashboard
    && selected?.taskId
    && mergePreview?.eligible
    && !["queued-for-merge", "retesting", "merging", "merged", "discarded"].includes(mergePreview.status)
  );
  const profileEntries = Object.entries(selected?.effectiveProfiles ?? {});
  const showHumanDecisionFirst = humanRequestsLoading || humanRequests.some((request) => request.status === "pending");
  return <div className={`page-grid page-grid--runs${mode === "embedded" ? " page-grid--runs-embedded" : ""}`}>
    <aside className="record-list"><header className="list-header"><h1>运行卷宗</h1></header><div className="run-filter-bar"><div data-testid="run-type-filter"><SelectControl ariaLabel="按类型筛选运行卷宗" value={categoryFilter} options={[{ value: "all", label: "全部类型" }, { value: "single", label: "单任务" }, { value: "graph", label: "Graph 编排" }, { value: "supervisor", label: "领队协作" }]} onChange={(value) => setCategoryFilter(value as typeof categoryFilter)} /></div><div data-testid="run-project-filter"><SelectControl ariaLabel="按项目筛选运行卷宗" value={projectFilter} options={[{ value: "all", label: "全部项目" }, { value: "none", label: "无项目" }, ...projectOptions.map((project) => ({ value: project, label: project }))]} onChange={(value) => setProjectFilter(value)} /></div></div><div className="record-scroll run-list">{visibleRuns.map((run) => <button key={run.id} id={run.id} className={`run-card ${selected?.id === run.id ? "selected" : ""}`} onClick={() => { setSelectedId(run.id); onSelectRun?.(run.id); }}><div><code>{run.id}</code><strong>{run.workflow}</strong><small>{formatTime(run.createdAt)} · {run.architecture} · {Object.keys(run.nodes).length} 节点</small><div className="run-card-tags">{run.category && <span className={`run-category-tag run-category-tag--${run.category}`}>{CATEGORY_LABELS[run.category]}</span>}{run.project && <span className="run-project-chip">{run.project}</span>}</div></div><Stamp status={run.status} /></button>)}{!loading && visibleRuns.length === 0 && <div className="mini-empty">{runs.length === 0 ? "还没有 Run 证据。" : "没有符合筛选条件的卷宗。"}</div>}</div><footer className="list-footer"><span>{visibleRuns.length}/{runs.length} 份卷宗</span><span>READ ONLY</span></footer></aside>
    <main className="detail-pane">{loading ? <div className="skeleton-page" aria-label="正在调取运行卷宗"><i /><i /><i /></div> : !selected ? <EmptyState title="尚无运行卷宗">直接交办员工或签发一次 Workflow 后，这里会出现不可变的执行记录。</EmptyState> : <div className="dossier run-dossier">
      <header className="dossier-cover"><div className="file-index"><span>RUN EVIDENCE RECORD</span><code>{selected.id}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">证</div><div><h2>{selected.workflow}</h2><p>{selected.status === "blocked" ? "流程已完成，但存在业务阻塞结论。" : selected.status === "failed" ? "执行发生技术故障，可查看原始输出与错误证据。" : selected.status === "running" ? "执行仍在进行。" : "流程完成，证据已归档。"}</p></div><Stamp status={selected.status} /></div></header>
      {view === "all" && <>{showHumanDecisionFirst && <DossierSection number="待办" title="需要你的决定"><HumanDecisionPanel requests={humanRequests} loading={humanRequestsLoading} commentDrafts={commentDrafts} deciding={deciding} onCommentChange={(requestId, value) => setCommentDrafts((drafts) => ({ ...drafts, [requestId]: value }))} onOpenDecision={openDecision} /></DossierSection>}
      <DossierSection number="01" title="运行元数据"><dl className="ledger"><dt>Run ID</dt><dd><code>{selected.id}</code></dd><dt>Architecture</dt><dd>{selected.architecture}</dd><dt>创建时间</dt><dd>{formatTime(selected.createdAt)}</dd><dt>完成时间</dt><dd>{formatTime(selected.completedAt)}</dd><dt>证据目录</dt><dd><code className="path-code">{selected.artifactDir}</code></dd><dt>隔离</dt><dd><IsolationValue isolation={selected.isolation} /></dd></dl></DossierSection>
      {profileEntries.length > 0 && <DossierSection number="02" title="有效执行配置与来源"><div className="run-profile-list">{profileEntries.map(([nodeId, profile]) => <details key={nodeId} open={profileEntries.length === 1}><summary><strong>{nodeId}</strong><span>{profile.employee.displayName} · v{profile.employee.version}</span></summary><EffectiveProfileView profile={profile} /></details>)}</div></DossierSection>}
      {selected.architecture === "supervisor" && <DossierSection number={profileEntries.length > 0 ? "03" : "02"} title="动态执行图"><SupervisorRunTopology nodes={Object.values(selected.nodes)} /></DossierSection>}
      <DossierSection number={profileEntries.length > 0 ? (selected.architecture === "supervisor" ? "04" : "03") : (selected.architecture === "supervisor" ? "03" : "02")} title="节点结果"><div className="run-node-list">{Object.values(selected.nodes).map((node, index) => { const decision = supervisorDecision(node); return <article key={node.nodeId}><div className="run-node-head"><span className="node-number">{String(index + 1).padStart(2, "0")}</span><div><strong>{node.nodeId}</strong><code>{node.roleId}{node.metadata?.kind === "supervisor" ? ` · 领队 Round ${node.metadata.round ?? "—"}` : node.metadata?.kind === "member" ? ` · 成员 Round ${node.metadata.round ?? "—"}` : ""}{dagFlowTag(node)}</code></div><Stamp status={node.status} /></div><dl className="ledger horizontal"><dt>尝试</dt><dd>{node.attempts}</dd><dt>开始</dt><dd>{formatTime(node.startedAt)}</dd><dt>结束</dt><dd>{formatTime(node.completedAt)}</dd></dl>{decision && <div className="supervisor-decision-summary"><code>{decision.action.toUpperCase()}</code><span>{decision.summary ?? "领队未提供本轮摘要。"}</span></div>}{node.error && <div className="inline-error">{node.error}</div>}{node.output !== undefined && <><E2eEvidenceList entries={e2eEvidenceEntries(node.output)} /><pre className="result-json">{JSON.stringify(node.output, null, 2)}</pre></>}<code className="artifact-path">{node.artifactDir}</code></article>; })}</div></DossierSection>
      {selected.output !== undefined && <DossierSection number={profileEntries.length > 0 ? (selected.architecture === "supervisor" ? "05" : "04") : (selected.architecture === "supervisor" ? "04" : "03")} title="Workflow 最终输出">{finalSummary(selected) && <p className="workflow-final-summary">{finalSummary(selected)}</p>}<GateVerdictList gates={gateVerdicts(selected.output)} /><E2eEvidenceList entries={e2eEvidenceEntries(selected.output)} /><pre className="result-json">{JSON.stringify(selected.output, null, 2)}</pre></DossierSection>}
      {!showHumanDecisionFirst && <DossierSection number="人审" title="人在回路"><HumanDecisionPanel requests={humanRequests} loading={humanRequestsLoading} commentDrafts={commentDrafts} deciding={deciding} onCommentChange={(requestId, value) => setCommentDrafts((drafts) => ({ ...drafts, [requestId]: value }))} onOpenDecision={openDecision} /></DossierSection>}</>}
      <DossierSection number="交付" title="验收与合并"><RunDeliveryPanel
        preview={mergePreview?.runId === selected.id ? mergePreview : undefined}
        loading={mergePreviewLoading}
        taskId={selected.taskId}
        canSubmitToBoard={canSubmitToBoard}
        boardSubmitting={boardSubmitting}
        boardSubmitError={boardSubmitError}
        onOpenMerge={openMerge}
        onOpenWorktree={() => void openWorktree()}
        openingWorktree={openingWorktree}
        onOpenKeep={() => { setKeepError(""); setKeepOpen(true); }}
        onOpenDiscard={() => { setDiscardError(""); setDiscardToken(""); setDiscardOpen(true); }}
        onSubmitToBoard={() => void submitToBoard()}
        onRerunEvidence={() => void rerunEvidence()}
        evidenceRerunError={evidenceRerunError}
        onRetryConflict={() => void retryConflict()}
        conflictRetrying={conflictRetrying}
        conflictRetryError={conflictRetryError}
      /></DossierSection>
    </div>}</main>
    {mergeOpen && mergePreview?.eligible && <RunMergeConfirmation preview={mergePreview} confirmed={mergeConfirmed} busy={merging} error={mergeError} onConfirmedChange={setMergeConfirmed} onClose={() => { if (!merging) setMergeOpen(false); }} onMerge={() => void mergeDelivery()} />}
    {keepOpen && mergePreview && <RunKeepConfirmation preview={mergePreview} note={keepNote} busy={keeping} error={keepError} onNoteChange={setKeepNote} onClose={() => { if (!keeping) setKeepOpen(false); }} onKeep={() => void keepDelivery()} />}
    {discardOpen && mergePreview && <RunDiscardConfirmation preview={mergePreview} token={discardToken} note={discardNote} busy={discarding} error={discardError} onTokenChange={setDiscardToken} onNoteChange={setDiscardNote} onClose={() => { if (!discarding) setDiscardOpen(false); }} onDiscard={() => void discardDelivery()} />}
    {decisionTarget && <HumanDecisionConfirmation target={decisionTarget} comment={(commentDrafts[decisionTarget.request.id] ?? "").trim()} busy={deciding} error={decisionError} onClose={() => { if (!deciding) setDecisionTarget(undefined); }} onConfirm={() => void submitDecision()} />}
  </div>;
}
