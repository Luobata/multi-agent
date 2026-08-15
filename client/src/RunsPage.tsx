import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, writeBody } from "./api";
import { DossierSection, EmptyState, Modal, SelectControl, Stamp, formatTime, scrollRecordIntoView } from "./components";
import { SupervisorRunTopology } from "./SupervisorRunTopology";
import { EffectiveProfileView } from "./EffectiveProfileView";
import { acceptanceSnapshotFromPreview, isRunAcceptanceReady } from "./dashboard/acceptance";
import type { DashboardService } from "./dashboard/service";
import type { Requirement } from "./dashboard/types";
import type { HumanDecisionRequest, HumanDecisionRiskCategory, InvocationProgress, InvocationRecord, JsonValue, Run, RunDeliveryActionResult, RunDeliveryRecord, RunEvidenceAsset, RunMergePreview, RunMergeQueueResult, RunNode, RunWorktreeOpenResult } from "./types";

export { acceptanceSnapshotFromPreview, isRunAcceptanceReady } from "./dashboard/acceptance";

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
  mode?: string;
  fallback?: string;
  /** Runtime node ids whose outputs were used as gate evidence. */
  sources: string[];
}

/** Reads one supervisor gate snapshot entry (run.output.gates / architectureState.gates); tolerant of partial data. */
function gateVerdictFrom(value: JsonValue | undefined): GateVerdict | undefined {
  const item = objectValue(value);
  if (!item || typeof item.gateId !== "string") return undefined;
  const executions = Array.isArray(item.executions) ? item.executions : [];
  const sources = [...new Set(executions.flatMap((execution) => {
    const record = objectValue(execution as JsonValue);
    return Array.isArray(record?.sourceNodeIds) ? record.sourceNodeIds.filter((id): id is string => typeof id === "string") : [];
  }))];
  return {
    gateId: String(item.gateId),
    status: typeof item.status === "string" ? item.status : "unknown",
    reason: typeof item.reason === "string" && item.reason ? item.reason : undefined,
    requiredCapability: typeof item.requiredCapability === "string" ? item.requiredCapability : undefined,
    mode: typeof item.mode === "string" ? item.mode : undefined,
    fallback: typeof item.fallback === "string" ? item.fallback : undefined,
    sources
  };
}

/** Reads the supervisor gate snapshot off `run.output.gates`; safe when absent or malformed. */
function gateVerdicts(value: JsonValue | undefined): GateVerdict[] {
  const raw = objectValue(value)?.gates;
  if (!Array.isArray(raw)) return [];
  return raw.map(gateVerdictFrom).filter((gate): gate is GateVerdict => gate !== undefined);
}

function GateVerdictList({ gates }: { gates: GateVerdict[] }) {
  if (gates.length === 0) return null;
  return <ul className="run-gate-list">{gates.map((gate) => <li key={gate.gateId} className={`run-gate-item run-gate-item--${gate.status}`}>
    <div className="run-gate-head"><code>{gate.gateId}</code><span className={`gate-status gate-status--${gate.status}`}>{GATE_STATUS_LABELS[gate.status] ?? gate.status}</span>{gate.requiredCapability && <small>{gate.requiredCapability}</small>}{gate.mode && <small>{gate.mode}{gate.fallback ? ` · 领队可兜底` : ""}</small>}</div>
    {gate.reason && <p className="gate-reason">{gate.reason}</p>}
    {gate.sources.length > 0 && <p className="run-gate-sources">证据来源节点：{gate.sources.join("、")}</p>}
  </li>)}</ul>;
}

/* ---------- Supervisor observability (live architectureState + progress) ---------- */

interface SupervisorDagWaitReason {
  kind?: string;
  nodeId?: string;
  status?: string;
  expectedStatuses?: string[];
  reason?: string;
}

interface SupervisorDagNodeView {
  nodeId: string;
  status?: string;
  ready?: boolean;
  needs?: string[];
  whyNotRunning?: SupervisorDagWaitReason[];
}

interface SupervisorLiveState {
  round?: number;
  delegations?: number;
  planRevision?: number;
  limits?: { maxRounds?: number; maxDelegations?: number; maxParallelDelegations?: number };
  dag?: SupervisorDagNodeView[];
  gates?: GateVerdict[];
  scheduling?: {
    mode?: string;
    schedulerVersion?: number;
    compiledDispatchEnabled?: boolean;
    shadowReadyNodeIds?: string[];
  };
}

function dagNodeViews(value: JsonValue | undefined): SupervisorDagNodeView[] {
  const raw = objectValue(value)?.nodes;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => objectValue(item))
    .filter((item): item is Record<string, JsonValue> => item !== undefined && typeof item.nodeId === "string")
    .map((item) => ({
      nodeId: String(item.nodeId),
      status: typeof item.status === "string" ? item.status : undefined,
      ready: typeof item.ready === "boolean" ? item.ready : undefined,
      needs: Array.isArray(item.needs) ? item.needs.filter((need): need is string => typeof need === "string") : undefined,
      whyNotRunning: Array.isArray(item.whyNotRunning)
        ? item.whyNotRunning.map((reason) => objectValue(reason)).filter((reason): reason is Record<string, JsonValue> => reason !== undefined).map((reason) => ({
            kind: typeof reason.kind === "string" ? reason.kind : undefined,
            nodeId: typeof reason.nodeId === "string" ? reason.nodeId : undefined,
            status: typeof reason.status === "string" ? reason.status : undefined,
            expectedStatuses: Array.isArray(reason.expectedStatuses) ? reason.expectedStatuses.filter((s): s is string => typeof s === "string") : undefined,
            reason: typeof reason.reason === "string" ? reason.reason : undefined
          }))
        : undefined
    }));
}

/**
 * Live supervisor projection persisted on run.json (`architectureState`, schemaVersion 1).
 * Absent on legacy/非 supervisor runs — every consumer must treat it as optional and never
 * invent limits, reasons or paths the backend did not persist.
 */
function supervisorLiveState(run: Run | undefined, progress?: InvocationProgress): SupervisorLiveState | undefined {
  const progressState = objectValue(progress?.supervisor);
  const raw = progressState?.kind === "supervisor" ? progressState : objectValue(run?.architectureState);
  if (!raw || raw.kind !== "supervisor") return undefined;
  const limits = objectValue(raw.limits);
  const scheduling = objectValue(raw.scheduling);
  return {
    round: typeof raw.round === "number" ? raw.round : undefined,
    delegations: typeof raw.delegations === "number" ? raw.delegations : undefined,
    planRevision: typeof raw.planRevision === "number" ? raw.planRevision : undefined,
    limits: limits ? {
      maxRounds: typeof limits.maxRounds === "number" ? limits.maxRounds : undefined,
      maxDelegations: typeof limits.maxDelegations === "number" ? limits.maxDelegations : undefined,
      maxParallelDelegations: typeof limits.maxParallelDelegations === "number" ? limits.maxParallelDelegations : undefined
    } : undefined,
    dag: raw.dag ? dagNodeViews(raw.dag) : undefined,
    gates: Array.isArray(raw.gates) ? raw.gates.map(gateVerdictFrom).filter((gate): gate is GateVerdict => gate !== undefined) : undefined,
    scheduling: scheduling ? {
      mode: typeof scheduling.mode === "string" ? scheduling.mode : undefined,
      schedulerVersion: typeof scheduling.schedulerVersion === "number" ? scheduling.schedulerVersion : undefined,
      compiledDispatchEnabled: typeof scheduling.compiledDispatchEnabled === "boolean" ? scheduling.compiledDispatchEnabled : undefined,
      shadowReadyNodeIds: Array.isArray(scheduling.shadowReadyNodeIds)
        ? scheduling.shadowReadyNodeIds.filter((id): id is string => typeof id === "string")
        : undefined
    } : undefined
  };
}

/** Terminal runs carry the same DAG snapshot on `run.output.dag`; prefer the live projection while running. */
function supervisorDagView(run: Run | undefined, progress?: InvocationProgress): SupervisorDagNodeView[] {
  const live = supervisorLiveState(run, progress)?.dag;
  if (live && live.length > 0) return live;
  return dagNodeViews(objectValue(run?.output)?.dag);
}

function waitReasonText(reasons: SupervisorDagWaitReason[] | undefined): string {
  if (!reasons || reasons.length === 0) return "";
  return reasons
    .map((reason) => reason.kind === "terminal"
      ? reason.reason ?? `节点已 ${reason.status ?? "终止"}，需要明确恢复证据后才能重开`
      : `等待 ${reason.nodeId ?? "上游节点"}（当前 ${reason.status ?? "未知"}，需要 ${(reason.expectedStatuses ?? ["passed"]).join("/")}）`)
    .join("；");
}

interface RunStepRow {
  key: string;
  nodeId: string;
  roleId?: string;
  round?: number;
  status: string;
  phase?: string;
  error?: string;
  /** DAG flow node this execution belongs to, used to join persisted whyNotRunning evidence. */
  flowNodeId?: string;
}

/** Steps come from the progress projection when available; otherwise the run record itself. */
function runStepRows(run: Run, progress: InvocationProgress | undefined): RunStepRow[] {
  if (progress && Array.isArray(progress.steps) && progress.steps.length > 0) {
    return progress.steps.map((step, index) => ({
      key: `${step.nodeId}-${index}`,
      nodeId: step.nodeId,
      roleId: step.roleId,
      round: step.round,
      status: step.status,
      phase: step.phase,
      error: step.error,
      flowNodeId: typeof run.nodes[step.nodeId]?.metadata?.flowNodeId === "string" ? String(run.nodes[step.nodeId]!.metadata!.flowNodeId) : undefined
    }));
  }
  return Object.values(run.nodes).map((node) => ({
    key: node.nodeId,
    nodeId: node.nodeId,
    roleId: node.roleId,
    round: typeof node.metadata?.round === "number" ? node.metadata.round : undefined,
    status: node.status,
    phase: undefined,
    error: node.error,
    flowNodeId: typeof node.metadata?.flowNodeId === "string" ? node.metadata.flowNodeId : undefined
  }));
}

/** Text equivalent of the runtime topology SVG: every node, its status, wait reason and error. */
function RunStepsTable({ run, progress }: { run: Run; progress: InvocationProgress | undefined }) {
  const rows = runStepRows(run, progress);
  if (rows.length === 0) return null;
  const dagByFlowId = new Map(supervisorDagView(run, progress).map((node) => [node.nodeId, node]));
  const showWaitReasons = rows.some((row) => {
    const dagNode = dagByFlowId.get(row.flowNodeId ?? row.nodeId);
    return dagNode?.whyNotRunning && dagNode.whyNotRunning.length > 0;
  });
  return <div className="run-steps-table-scroll" tabIndex={0} aria-label="执行步骤表，可横向滚动查看全部列"><table className="run-steps-table">
    <caption>执行步骤表：与上方动态执行图等价的文本视图{showWaitReasons ? "；等待原因来自服务端持久投影" : ""}</caption>
    <thead><tr><th scope="col">节点</th><th scope="col">角色</th><th scope="col">轮次</th><th scope="col">状态</th><th scope="col">阶段</th>{showWaitReasons && <th scope="col">等待原因</th>}<th scope="col">错误</th></tr></thead>
    <tbody>{rows.map((row) => {
      const dagNode = dagByFlowId.get(row.flowNodeId ?? row.nodeId);
      const waiting = waitReasonText(dagNode?.whyNotRunning);
      return <tr key={row.key} className={`run-step-row run-step-row--${row.status}`}>
        <td><code>{row.nodeId}</code></td>
        <td>{row.roleId ?? "—"}</td>
        <td>{row.round ?? "—"}</td>
        <td>{row.status}</td>
        <td>{row.phase ?? "—"}</td>
        {showWaitReasons && <td>{waiting || "—"}</td>}
        <td>{row.error ? <span className="inline-error">{row.error}</span> : "—"}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

const DECISION_ACTION_LABELS: Record<string, string> = {
  "plan-todos": "规划",
  delegate: "委派",
  "satisfy-gate": "补门禁",
  finish: "收尾",
  unknown: "决策"
};

/** Full leader decision timeline from the progress projection (every round, not just the latest). */
function DecisionTimeline({ progress }: { progress: InvocationProgress | undefined }) {
  // Progress payloads from older daemons or partial mocks may omit leaderReport entirely.
  const report = progress?.leaderReport;
  const entries = Array.isArray(report?.entries) ? report.entries : [];
  if (!report?.available) return <p className="run-node-placeholder">尚无领队决策记录。</p>;
  return <ol className="run-decision-timeline">{entries.map((entry, index) => <li key={`${entry.round}-${index}`} className={`run-decision-entry run-decision-entry--${entry.status}`}>
    <div className="run-decision-head">
      <span className="run-decision-round">Round {entry.round}</span>
      <code>{DECISION_ACTION_LABELS[entry.action] ?? entry.action}</code>
      <span className={`run-decision-status run-decision-status--${entry.status}`}>{entry.status}</span>
    </div>
    {entry.summary && <p className="run-decision-summary">{entry.summary}</p>}
    {Array.isArray(entry.assignments) && entry.assignments.length > 0 && <ul className="run-decision-assignments">{entry.assignments.map((assignment, assignmentIndex) => <li key={assignmentIndex}>
      <strong>{assignment.roleId ?? "未指定角色"}</strong>{assignment.task ? `：${assignment.task}` : ""}{assignment.workKind ? <small>（{assignment.workKind}）</small> : null}
    </li>)}</ul>}
  </li>)}</ol>;
}

/** Round/delegation usage with policy limits; renders only what the backend actually persisted. */
function SupervisorLimitsLine({ run, progress }: { run: Run; progress: InvocationProgress | undefined }) {
  const live = supervisorLiveState(run, progress);
  const round = live?.round ?? (progress && progress.round > 0 ? progress.round : undefined);
  const delegations = live?.delegations ?? progress?.leaderReport?.delegations;
  const limits = live?.limits;
  const parts: string[] = [];
  if (round !== undefined) parts.push(limits?.maxRounds !== undefined ? `轮次 ${round} / 上限 ${limits.maxRounds}` : `轮次 ${round}`);
  if (delegations !== undefined) parts.push(limits?.maxDelegations !== undefined ? `累计委派 ${delegations} / 上限 ${limits.maxDelegations}` : `累计委派 ${delegations}`);
  if (limits?.maxParallelDelegations !== undefined) parts.push(`单批并行上限 ${limits.maxParallelDelegations}`);
  if (live?.planRevision !== undefined) parts.push(`计划版本 v${live.planRevision}`);
  if (live?.scheduling?.mode) {
    const version = live.scheduling.schedulerVersion !== undefined ? ` v${live.scheduling.schedulerVersion}` : "";
    parts.push(`调度 ${live.scheduling.mode}${version}`);
  }
  if (live?.scheduling?.compiledDispatchEnabled === false) parts.push("完成即补位关闭");
  if (live?.scheduling?.shadowReadyNodeIds) {
    parts.push(`影子就绪 ${live.scheduling.shadowReadyNodeIds.length}（仅观测）`);
  }
  if (parts.length === 0) return null;
  return <p className="run-limits-line">{parts.join(" · ")}</p>;
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
  acceptanceBindingLoading,
  acceptanceRunId,
  acceptanceBindingError,
  onOpenAcceptanceRun,
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
  acceptanceBindingLoading: boolean;
  acceptanceRunId?: string;
  acceptanceBindingError: boolean;
  onOpenAcceptanceRun: () => void;
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
  const evidenceRecovered = !evidenceMissing
    && evidenceRerun?.status === "passed"
    && Boolean(evidenceRerun.message?.includes("恢复"));
  const evidenceNeedsAttention = evidenceMissing || evidenceFailed;
  const conflictBusy = conflict && ["resolving", "retesting", "leader-review"].includes(conflictResolution?.status ?? "");
  const actionable = !merged && !discarded && !mergeBusy && !conflictBusy && Boolean(preview.worktreePath) && (preview.status === "awaiting-acceptance" || preview.status === "conflict" || preview.status === "kept" || preview.status === "returned-to-acceptance");
  const canQueueMerge = preview.eligible && !merged && !discarded && !mergeBusy && !evidenceBusy && preview.status !== "conflict";
  const showMergeAction = isRunAcceptanceReady(preview) && !merged && !discarded && !mergeBusy && preview.status !== "conflict";
  const mergeDisabledReason = !preview.eligible
    ? (preview.reasons[0] ?? "服务端合入门禁暂未通过，请处理阻塞后重试。")
    : evidenceBusy
      ? "验收证据正在更新，完成前不能加入待合入。"
      : undefined;
  const isAcceptanceRun = !taskId || Boolean(acceptanceRunId && acceptanceRunId === preview.runId);
  const canRerunEvidence = evidenceNeedsAttention && !acceptanceBindingLoading && isAcceptanceRun && !evidenceBusy && !mergeBusy && !conflictBusy && Boolean(preview.worktreePath) && !discarded && !merged;
  const evidenceDisabledReason = acceptanceBindingLoading
    ? "正在核对该需求绑定的验收 Run，完成前不会启动补采。"
    : acceptanceBindingError
      ? "无法核对该需求绑定的验收 Run，请重试或刷新页面后再补采。"
    : taskId && !acceptanceRunId
      ? "该需求尚未提交到待验收；请先提交并固定验收 Run，再补采媒体证据。"
      : !isAcceptanceRun
        ? `当前是 Run ${preview.runId}，该需求绑定的验收 Run 是 ${acceptanceRunId}；为避免跨 Run 写入，不能在当前卷宗补采。`
        : !preview.worktreePath
          ? "绑定的验收 Run 没有可用 worktree，无法补采；请重新发起验收 Run。"
          : discarded
            ? "候选结果已丢弃，worktree 已清理，不能补采。"
            : merged
              ? "交付已经合并，当前验收 Run 不再接受补采。"
              : evidenceBusy
                ? "test-engineer 正在补采证据，请等待当前任务完成。"
                : mergeBusy
                  ? "当前合入流程正在重测或写入，不能并行启动另一轮补采。"
                  : conflictBusy
                    ? "冲突处理正在进行，不能并行启动证据补采。"
                    : undefined;
  const diff = preview.changes.unifiedDiff;
  return <div className="run-delivery-panel">
    {conflict && <div className="run-delivery-callout run-delivery-callout--conflict" role="alert"><strong>{conflictResolution?.status === "resolving" ? "原领队正在规划并委派冲突修复" : conflictResolution?.status === "retesting" ? "冲突已解决，正在回跑测试" : conflictResolution?.status === "leader-review" ? "测试已通过，等待原领队放行" : conflictResolution?.status === "failed" ? (conflictResolution.failureClass === "environment-blocked" ? "候选环境阻塞，可重试验收" : conflictResolution.failureClass === "evidence-incomplete" ? "候选证据不完整，不得放行" : "候选产品回归失败") : "目标分支存在合并冲突"}</strong><p>{preview.delivery?.message ?? "候选仍在待合入队列，原 worktree 与证据均已保留。"}</p>{conflictResolution?.leaderPlanRunId && <small>领队计划 Run：<code>{conflictResolution.leaderPlanRunId}</code></small>}{conflictResolution?.executionRoleId && <small>执行角色：<code>{conflictResolution.executionRoleId}</code></small>}{conflictResolution?.resolutionRunId && <small>工程修复 Run：<code>{conflictResolution.resolutionRunId}</code></small>}{conflictResolution?.testRunId && <small>复测 Run：<code>{conflictResolution.testRunId}</code></small>}{conflictResolution?.testedUrl && <small>受管候选：<code>{conflictResolution.testedUrl}</code></small>}{conflictResolution?.leaderReviewRunId && <small>领队复验 Run：<code>{conflictResolution.leaderReviewRunId}</code></small>}{conflictResolution?.status === "failed" && <button type="button" className="button secondary" disabled={conflictRetrying} aria-busy={conflictRetrying} onClick={onRetryConflict}>{conflictRetrying ? "正在重新排队…" : "重新让原领队处理冲突"}</button>}{conflictRetryError && <small className="inline-error">{conflictRetryError}</small>}</div>}
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
      <div className="run-delivery-evidence-head"><strong>Evidence wall</strong><span>{preview.evidence.assets.length} 项媒体证据 · {preview.evidence.structuredE2eCount} 条结构化 E2E</span></div>
      <div className="run-delivery-evidence-summary" role="status">
        <span>结构化 E2E：{preview.evidence.structuredE2eCount} 条</span>
        <span>Required Gates：{preview.evidence.gates.filter((gate) => gate.required).length > 0
          ? preview.evidence.gates.filter((gate) => gate.required).map((gate) => `${gate.gateId} ${gate.status}`).join("；")
          : "未声明"}</span>
        {evidenceMissing && (preview.evidence.structuredE2eCount > 0 || preview.evidence.gates.some((gate) => gate.required)) && <strong>媒体 0 项不等于无验收证据</strong>}
      </div>
      {evidenceRecovered && <div className="run-delivery-evidence-attention run-delivery-evidence-attention--recovered" role="status">
        <div><strong>媒体证据已恢复，无需重复补采</strong><p>{evidenceRerun?.message ?? `daemon 中断了补采过程，但已恢复 ${preview.evidence.assets.length} 项可验收媒体；现有证据继续参与交付门禁。`}</p></div>
        <Stamp status="passed" label={`${preview.evidence.assets.length} 项可查看`} />
      </div>}
      {evidenceNeedsAttention && <div className={`run-delivery-evidence-attention${evidenceFailed ? " run-delivery-evidence-attention--interrupted" : ""}`} role="status">
        <div><strong>{evidenceFailed ? (evidenceMissing ? "截图补采失败，仍没有可查看媒体" : "截图补采失败，已保留部分媒体") : "缺少可查看的截图或录屏"}</strong><p>{evidenceFailed ? `${evidenceRerun.message ?? "上一轮补采未完整完成。"} 可以再次补采；已有媒体历史会保留。` : "结构化 E2E 已保留；媒体 0 项不等于无验收证据。是否让项目 test-engineer 重新走一遍验收路径并补采真实界面证据？"}</p></div>
        {!acceptanceBindingLoading && acceptanceRunId && !isAcceptanceRun
          ? <button type="button" className="button secondary" onClick={onOpenAcceptanceRun}>打开该需求绑定的验收 Run →</button>
          : <button type="button" className="button secondary" disabled={!canRerunEvidence} aria-busy={evidenceBusy} onClick={onRerunEvidence}>{evidenceBusy ? "test-engineer 补采中…" : evidenceFailed ? "重新运行 test-engineer 补采" : "让 test-engineer 补采证据"}</button>}
        {!canRerunEvidence && evidenceDisabledReason && <small role="note">{evidenceDisabledReason}</small>}
        {evidenceRerunError && <small className="inline-error" role="alert">{evidenceRerunError}</small>}
      </div>}
      {preview.evidence.assets.length > 0 && <div className="run-delivery-evidence-wall">{preview.evidence.assets.map((asset) => <RunEvidenceCard key={asset.id} asset={asset} />)}</div>}
    </div>
    {boardSubmitError && <div className="inline-error" role="alert">{boardSubmitError}</div>}
    {(showMergeAction || actionable || canSubmitToBoard) && !discarded && <div className="run-delivery-actions">
      {canSubmitToBoard && <button type="button" className="button secondary" disabled={boardSubmitting} aria-busy={boardSubmitting} onClick={onSubmitToBoard} title={taskId ? `写入看板需求 ${taskId} 的验收快照并迁移到待验收` : undefined}>{boardSubmitting ? "提交中…" : merged ? "补登记该需求到待验收" : "提交该需求到待验收"}</button>}
      {actionable && <button type="button" className="button danger" onClick={onOpenDiscard}>丢弃候选结果</button>}
      {actionable && <button type="button" className="button secondary" onClick={onOpenKeep}>人工保留</button>}
      {showMergeAction && <button type="button" className="button primary" disabled={!canQueueMerge} aria-describedby={!canQueueMerge && mergeDisabledReason ? "run-merge-disabled-reason" : undefined} onClick={onOpenMerge}>批准并加入待合入</button>}
      {showMergeAction && !canQueueMerge && mergeDisabledReason && <small id="run-merge-disabled-reason" role="note">暂不可合入：{mergeDisabledReason}</small>}
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

/** Client mirror of `WorkflowProgressWaitResult` (src/workbench/invocationProgress.ts), fields optional for tolerance. */
interface ProgressWaitResult {
  nextCursor?: string;
  changed?: boolean;
  terminal?: boolean;
  progress?: InvocationProgress;
}

export function RunsPage({ notify, activityRevision = "", focusedRunId = "", pendingRunId = "", onConsumePending, onSelectRun, onDashboardSync, onOpenRequirement, mode = "full", view = "all", dashboard, fromStudio = false, onReturnOffice }: {
  notify: (message: string, kind?: "success" | "error") => void;
  activityRevision?: string;
  focusedRunId?: string;
  /** @deprecated use focusedRunId; retained for callers during the hash-routing migration. */
  pendingRunId?: string;
  onConsumePending?: () => void;
  onSelectRun?: (runId: string) => void;
  onDashboardSync?: (requirement: Requirement) => void;
  onOpenRequirement?: (requirementId: string, section?: "overview" | "run" | "acceptance") => void;
  mode?: "full" | "embedded";
  view?: "all" | "acceptance";
  fromStudio?: boolean;
  onReturnOffice?: () => void;
  /** 可选看板服务；注入后合格交付可以把验收快照原子写回需求看板。 */
  dashboard?: DashboardService;
}) {
  const requestedRunId = focusedRunId || pendingRunId;
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState(requestedRunId);
  const [detail, setDetail] = useState<Run>();
  const [detailLoading, setDetailLoading] = useState(Boolean(requestedRunId));
  const [receipt, setReceipt] = useState<Record<string, unknown>>();
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const dossierTitleRef = useRef<HTMLHeadingElement>(null);
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
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [progress, setProgress] = useState<InvocationProgress>();
  // Supervisor dossiers prefer the cursor long-poll; any malformed/failed wait response
  // falls back to the interval refresh below so a missing endpoint can never freeze the UI.
  const [progressChannel, setProgressChannel] = useState<"idle" | "longpoll" | "interval">("idle");
  const [acceptanceBinding, setAcceptanceBinding] = useState<{ taskId: string; runId?: string; capturedAt?: string }>();
  const [acceptanceBindingError, setAcceptanceBindingError] = useState("");
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
  // A focused Run is navigation state, so apply prop changes before the browser
  // can paint the previous dossier. This is especially important for the
  // requirement-embedded view, where acting on a stale Run could mutate the
  // wrong delivery record.
  useLayoutEffect(() => {
    if (requestedRunId) setSelectedId(requestedRunId);
  }, [requestedRunId]);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setListError("");
    api<Run[]>("/api/runs?limit=100").then((value) => {
      if (!current) return;
      setRuns(value);
      // A focused Run is authoritative. Never briefly select the newest Run
      // while its list entry is loading or when switching requirement dossiers.
      setSelectedId((selected) => requestedRunId || selected || value[0]?.id || "");
      if (requestedRunId && value.some((run) => run.id === requestedRunId)) {
        if (pendingRunId) onConsumePending?.();
      }
    }).catch((error: unknown) => {
      if (current) setListError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (current) { setLoading(false); setRetrying(false); } });
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
    if (typeof window.matchMedia === "function") scrollRecordIntoView(requestedRunId);
  }, [mode, requestedRunId, runs]);
  useEffect(() => {
    if (!selectedId) {
      detailRunIdRef.current = "";
      setDetail(undefined);
      setDetailLoading(false);
      return;
    }
    let current = true;
    // Clear only when the operator selects another Run. Activity SSE updates refresh the same
    // dossier in the background; blanking it first changes page height and visibly jumps scroll.
    if (detailRunIdRef.current !== selectedId) {
      detailRunIdRef.current = selectedId;
      setDetail(undefined);
    }
    setDetailLoading(true);
    setDetailError("");
    api<Run>(`/api/runs/${encodeURIComponent(selectedId)}`)
      .then((value) => { if (current) { setDetail(value); setRetrying(false); } })
      .catch((error: unknown) => { if (current) { setDetailError(error instanceof Error ? error.message : String(error)); setRetrying(false); } })
      .finally(() => { if (current) setDetailLoading(false); });
    return () => { current = false; };
  }, [selectedId, activityRevision, decisionRevision, loadRevision]);
  useEffect(() => {
    if (!selectedId || !/(?:\?|&)view=receipt(?:&|$)/.test(window.location.hash)) { setReceipt(undefined); return; }
    let current = true;
    api<Record<string, unknown>>(`/api/runs/${encodeURIComponent(selectedId)}/receipt`).then(value => { if (current) setReceipt(value); }).catch(() => { if (current) setReceipt(undefined); });
    return () => { current = false; };
  }, [selectedId, activityRevision, loadRevision]);
  const projectOptions = useMemo(
    () => [...new Set(runs.map((run) => run.project).filter((project): project is string => Boolean(project)))].sort(),
    [runs]
  );
  const visibleRuns = useMemo(
    () => filterRuns(runs, { category: categoryFilter, project: projectFilter }),
    [runs, categoryFilter, projectFilter]
  );
  const directed = Boolean(requestedRunId);
  const targetMissing = Boolean(pendingRunId) && !loading && !listError && !runs.some((run) => run.id === pendingRunId);
  const summary = visibleRuns.find((run) => run.id === selectedId) ?? (directed ? undefined : visibleRuns[0]);
  const selected = detail?.id === selectedId ? detail : summary;
  // Running dossiers refresh every two seconds. Keep the last complete dossier interactive
  // while those background reads are in flight; the skeleton is only an initial empty state.
  const showDossierSkeleton = !selected && (loading || (directed && detailLoading));
  const acceptanceBindingLoading = Boolean(dashboard && selected?.taskId && acceptanceBinding?.taskId !== selected.taskId);
  const acceptanceRunId = acceptanceBinding && acceptanceBinding.taskId === selected?.taskId ? acceptanceBinding.runId : undefined;
  useEffect(() => {
    if (!dashboard || !selected?.taskId) {
      setAcceptanceBinding(undefined);
      setAcceptanceBindingError("");
      return;
    }
    let current = true;
    setAcceptanceBindingError("");
    dashboard.getRequirement(selected.taskId)
      .then((requirement) => {
        if (current) setAcceptanceBinding({
          taskId: selected.taskId!,
          runId: requirement.evidence.acceptance?.runId,
          capturedAt: requirement.evidence.acceptance?.capturedAt
        });
      })
      .catch(() => {
        if (current) {
          setAcceptanceBinding({ taskId: selected.taskId! });
          setAcceptanceBindingError(selected.taskId!);
        }
      });
    return () => { current = false; };
  }, [dashboard, selected?.taskId]);
  useEffect(() => {
    if (!selected?.id || targetMissing) return;
    window.scrollTo({ top: 0, behavior: "auto" });
    window.requestAnimationFrame(() => dossierTitleRef.current?.focus());
  }, [selected?.id, targetMissing]);
  useEffect(() => {
    if (!targetMissing || !pendingRunId) return;
    const timer = window.setInterval(() => setLoadRevision((value) => value + 1), 2000);
    return () => window.clearInterval(timer);
  }, [targetMissing, pendingRunId]);
  const supervisorInvocationId = selected?.architecture === "supervisor" ? selected.invocation?.id : undefined;
  useEffect(() => {
    if (!supervisorInvocationId) {
      setProgress(undefined);
      return;
    }
    let current = true;
    api<InvocationProgress>(`/api/invocations/${encodeURIComponent(supervisorInvocationId)}/progress`)
      .then((value) => { if (current) setProgress(value); })
      .catch(() => { /* the dossier still renders from the run record itself */ });
    return () => { current = false; };
  }, [supervisorInvocationId, activityRevision, loadRevision]);
  useEffect(() => {
    if (!supervisorInvocationId || selected?.status !== "running" || targetMissing) return;
    let cancelled = false;
    let cursor: string | undefined;
    setProgressChannel((channel) => channel === "longpoll" ? channel : "longpoll");
    const loop = async () => {
      while (!cancelled) {
        try {
          const result = await api<ProgressWaitResult>(`/api/invocations/${encodeURIComponent(supervisorInvocationId)}/progress/wait?timeoutMs=20000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          if (cancelled) return;
          if (!result || typeof result.nextCursor !== "string" || !result.progress) throw new Error("progress wait result is malformed");
          cursor = result.nextCursor;
          setProgress(result.progress);
          if (result.changed || result.terminal) setLoadRevision((value) => value + 1);
          if (result.terminal) return;
          // Yield between iterations so an instantly-resolving (mocked or proxied) endpoint
          // can never spin the render loop; the server normally holds this request open.
          await new Promise((resolve) => setTimeout(resolve, 250));
        } catch {
          if (!cancelled) setProgressChannel("interval");
          return;
        }
      }
    };
    void loop();
    return () => {
      cancelled = true;
      setProgressChannel((channel) => channel === "longpoll" ? "idle" : channel);
    };
  }, [supervisorInvocationId, selected?.status, targetMissing]);
  useEffect(() => {
    if (selected?.status !== "running" || targetMissing) return;
    // The interval is the documented fallback: it stays off while the long-poll channel is live.
    if (supervisorInvocationId && progressChannel === "longpoll") return;
    const timer = window.setInterval(() => setLoadRevision((value) => value + 1), 2000);
    return () => window.clearInterval(timer);
  }, [selected?.status, targetMissing, supervisorInvocationId, progressChannel]);
  const retry = () => { setRetrying(true); setLoadRevision((value) => value + 1); };
  const returnAction = onReturnOffice ? <button type="button" className="secondary-button run-return-button" onClick={onReturnOffice}>← 返回领队工作室</button> : undefined;
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
      status as "queued-for-merge" | "retesting" | "merging" | "merged" | "conflict" | "returned-to-acceptance",
      {
        serverUpdatedAt: mergePreview.delivery.updatedAt,
        ...(mergePreview.delivery.message ? { message: mergePreview.delivery.message } : {}),
        ...(mergePreview.delivery.conflictResolution ? { conflictResolution: {
          status: mergePreview.delivery.conflictResolution.status,
          ...(mergePreview.delivery.conflictResolution.failureClass ? { failureClass: mergePreview.delivery.conflictResolution.failureClass } : {}),
          ...(mergePreview.delivery.conflictResolution.message ? { message: mergePreview.delivery.conflictResolution.message } : {})
        } } : {})
      }
    ).then((updated) => onDashboardSyncRef.current?.(updated)).catch(() => undefined);
  }, [dashboard, selected?.taskId, selected?.id, mergePreview?.delivery?.status, mergePreview?.delivery?.updatedAt, mergePreview?.delivery?.message, mergePreview?.delivery?.conflictResolution?.status, mergePreview?.delivery?.conflictResolution?.failureClass, mergePreview?.delivery?.conflictResolution?.message]);
  useEffect(() => {
    const capture = mergePreview?.delivery?.evidenceRerun;
    if (!dashboard || !selected?.taskId || acceptanceRunId !== selected.id || !capture) return;
    const captureTime = new Date(capture.updatedAt).getTime();
    const acceptanceTime = new Date(acceptanceBinding?.capturedAt ?? "").getTime();
    if ((capture.status === "queued" || capture.status === "running")
      && Number.isFinite(captureTime)
      && Number.isFinite(acceptanceTime)
      && captureTime <= acceptanceTime) return;
    void dashboard.syncRequirementEvidenceCapture(selected.taskId, selected.id, {
      status: capture.status,
      updatedAt: capture.updatedAt,
      message: capture.message,
      mediaCount: mergePreview.evidence.assets.length
    }).then((updated) => onDashboardSyncRef.current?.(updated)).catch(() => undefined);
  }, [dashboard, selected?.taskId, selected?.id, acceptanceRunId, acceptanceBinding?.capturedAt, mergePreview?.delivery?.evidenceRerun?.status, mergePreview?.delivery?.evidenceRerun?.updatedAt, mergePreview?.evidence.assets.length]);
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
        const updated = await dashboard.syncRequirementDelivery(selected.taskId, selected.id, result.status, {
          serverUpdatedAt: result.delivery.updatedAt,
          ...(result.delivery.message ? { message: result.delivery.message } : {})
        });
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
    if (!selected || acceptanceBindingLoading || acceptanceBindingError === selected.taskId || (selected.taskId && acceptanceRunId !== selected.id) || !mergePreview?.worktreePath) return;
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
      const result = await api<RunMergeQueueResult>(`/api/runs/${encodeURIComponent(selected.id)}/merge-conflict-retry`, writeBody({ actor: "workbench-operator" }));
      if (dashboard && selected.taskId) {
        const updated = await dashboard.syncRequirementDelivery(selected.taskId, selected.id, result.status, {
          serverUpdatedAt: result.delivery.updatedAt,
          ...(result.delivery.message ? { message: result.delivery.message } : {}),
          ...(result.delivery.conflictResolution ? { conflictResolution: {
            status: result.delivery.conflictResolution.status,
            ...(result.delivery.conflictResolution.failureClass ? { failureClass: result.delivery.conflictResolution.failureClass } : {}),
            ...(result.delivery.conflictResolution.message ? { message: result.delivery.conflictResolution.message } : {})
          } } : {})
        });
        onDashboardSyncRef.current?.(updated);
      }
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
    if (!dashboard || !selected?.taskId || !mergePreview || !isRunAcceptanceReady(mergePreview) || boardSubmitting) return;
    setBoardSubmitting(true);
    setBoardSubmitError("");
    try {
      const snapshot = acceptanceSnapshotFromPreview(mergePreview, new Date().toISOString());
      const updated = await dashboard.submitRequirementForAcceptance(selected.taskId, snapshot);
      setAcceptanceBinding({ taskId: selected.taskId, runId: snapshot.runId, capturedAt: snapshot.capturedAt });
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
  const cancelInvocation = async () => {
    const invocationId = selected?.invocation?.id;
    if (!invocationId || cancelling) return;
    setCancelling(true);
    setCancelError("");
    setDetail((current) => current?.id === selected.id && current.invocation
      ? { ...current, invocation: { ...current.invocation, status: "cancellation-requested" } }
      : current);
    try {
      await api<InvocationRecord>(`/api/invocations/${encodeURIComponent(invocationId)}/cancel`, writeBody({
        actor: "workbench-operator",
        ...(cancelReason.trim() ? { reason: cancelReason.trim() } : {})
      }));
      setCancelOpen(false);
      setCancelReason("");
      setLoadRevision((value) => value + 1);
      notify(`Run ${selected.id} 已安全停止；原始证据仍完整保留。`, "success");
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : String(error));
      setLoadRevision((value) => value + 1);
    } finally {
      setCancelling(false);
    }
  };
  const canSubmitToBoard = Boolean(
    dashboard
    && selected?.taskId
    && mergePreview
    && isRunAcceptanceReady(mergePreview)
    && !acceptanceBindingLoading
    && acceptanceBindingError !== selected.taskId
    && acceptanceRunId !== selected.id
    && !["queued-for-merge", "retesting", "merging", "discarded"].includes(mergePreview.status)
  );
  const profileEntries = Object.entries(selected?.effectiveProfiles ?? {});
  const showHumanDecisionFirst = humanRequestsLoading || humanRequests.some((request) => request.status === "pending");
  const controlActions = selected?.invocation?.control?.allowedActions ?? (
    selected?.invocation?.status === "queued" || selected?.invocation?.status === "running"
      ? ["monitor", "cancel"]
      : selected?.invocation?.status === "awaiting-human-decision" ? ["decide", "cancel"] : []
  );
  const canCancelInvocation = controlActions.includes("cancel");
  const needsGoalAction = controlActions.some((action) => action === "review-delivery"
    || action === "retry-successor" || action === "restart-successor" || action === "abandon-goal");
  return <div className={`page-grid page-grid--runs${mode === "embedded" ? " page-grid--runs-embedded" : ""}`}>
    <aside className="record-list"><header className="list-header"><h1>运行卷宗</h1></header><div className="run-filter-bar"><div data-testid="run-type-filter"><SelectControl ariaLabel="按类型筛选运行卷宗" value={categoryFilter} options={[{ value: "all", label: "全部类型" }, { value: "single", label: "单任务" }, { value: "graph", label: "Graph 编排" }, { value: "supervisor", label: "领队协作" }]} onChange={(value) => setCategoryFilter(value as typeof categoryFilter)} /></div><div data-testid="run-project-filter"><SelectControl ariaLabel="按项目筛选运行卷宗" value={projectFilter} options={[{ value: "all", label: "全部项目" }, { value: "none", label: "无项目" }, ...projectOptions.map((project) => ({ value: project, label: project }))]} onChange={(value) => setProjectFilter(value)} /></div></div><div className="record-scroll run-list">{visibleRuns.map((run) => <button key={run.id} id={run.id} className={`run-card ${selected?.id === run.id ? "selected" : ""}`} onClick={() => { setSelectedId(run.id); onSelectRun?.(run.id); }}><div><code>{run.id}</code><strong>{run.workflow}</strong><small>{formatTime(run.createdAt)} · {run.architecture} · {Object.keys(run.nodes).length} 节点</small><div className="run-card-tags">{run.category && <span className={`run-category-tag run-category-tag--${run.category}`}>{CATEGORY_LABELS[run.category]}</span>}{run.project && <span className="run-project-chip">{run.project}</span>}</div></div><Stamp status={run.status} /></button>)}{!loading && visibleRuns.length === 0 && <div className="mini-empty">{runs.length === 0 ? "还没有 Run 证据。" : "没有符合筛选条件的卷宗。"}</div>}</div><footer className="list-footer"><span>{visibleRuns.length}/{runs.length} 份卷宗</span><span>READ ONLY</span></footer></aside>
    <main className="detail-pane">{showDossierSkeleton ? <div className="skeleton-page" aria-label="正在调取运行卷宗"><i /><i /><i /></div> : targetMissing ? <EmptyState title="运行卷宗正在建立" action={<><button type="button" disabled={retrying} onClick={retry}>{retrying ? "重试中…" : "重试"}</button>{returnAction}</>}>Run {pendingRunId} 尚未出现在本地 Run Store，可稍后重试。</EmptyState> : listError || detailError ? <section className="run-detail-error" role="alert"><h2>运行卷宗加载失败</h2><p>{listError || detailError}</p><code>Run ID · {requestedRunId || selectedId || "未提供"}</code><div><button type="button" disabled={retrying} onClick={retry}>{retrying ? "重试中…" : "重试"}</button>{returnAction}</div></section> : !selected ? <EmptyState title={directed ? "无法定位运行卷宗" : "尚无运行卷宗"}>{directed ? `无法找到目标 Run ${requestedRunId}，且不会回退到其他运行卷宗。` : "直接交办员工或签发一次 Workflow 后，这里会出现不可变的执行记录。"}</EmptyState> : <div className="dossier run-dossier">
      {fromStudio && returnAction}
      <header className="dossier-cover"><div className="file-index"><span>RUN EVIDENCE RECORD</span><code>{selected.id}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">证</div><div><h2 ref={dossierTitleRef} tabIndex={-1} aria-label={`${selected.workflow}，Run ${selected.id} 运行卷宗`}>{selected.workflow}</h2><p>{selected.status === "blocked" ? "流程已完成，但存在业务阻塞结论。" : selected.status === "failed" ? "执行发生技术故障，可查看原始输出与错误证据。" : selected.status === "running" ? "执行仍在进行。" : "流程完成，证据已归档。"}</p></div><Stamp status={selected.status} /></div></header>
      {(canCancelInvocation || needsGoalAction || selected.invocation?.status === "cancellation-requested") && <section className="run-control-bar" aria-label="本次运行的可用操作">
        <div><span>CONTROL PLANE · NEXT ACTION</span><strong>{selected.invocation?.status === "cancellation-requested"
          ? "正在安全停止"
          : controlActions.includes("review-delivery") ? "执行已结束，请核对交付"
            : controlActions.includes("restart-successor") ? "本轮已取消，请决定是否继续目标"
              : controlActions.includes("retry-successor") ? "本轮未达成，请先处理根因"
                : "运行仍在进行"}</strong><p>{selected.invocation?.status === "cancellation-requested"
          ? "系统正在作废待决请求并等待实例收尾；无需重复操作。"
          : needsGoalAction && selected.taskId ? "原 Run 是不可变证据；后续推进会创建新的执行周期。" : "你可以继续监控，或显式停止这一轮执行。"}</p></div>
        <div className="run-control-actions">
          {needsGoalAction && selected.taskId && onOpenRequirement && <button type="button" className="button primary" onClick={() => onOpenRequirement(selected.taskId!, controlActions.includes("review-delivery") ? "run" : "overview")}>{controlActions.includes("review-delivery") ? "核对交付与验收" : "回到需求处理下一步"}</button>}
          {needsGoalAction && !selected.taskId && <span className="run-control-unavailable">原 Run 不可原地重试；请从协作编排新启动一次。</span>}
          {canCancelInvocation && <button type="button" className="button danger" onClick={() => { setCancelError(""); setCancelOpen(true); }}>停止本轮运行</button>}
        </div>
      </section>}
      {receipt && <section className="dossier-section run-receipt" aria-labelledby="run-receipt-title"><h3 id="run-receipt-title">Run Receipt</h3>{Boolean(receipt.legacy) && <p className="dash-hint-line">Legacy Run：缺失字段显示 unavailable，不推断失败原因。</p>}<dl><dt>状态 / 阶段</dt><dd>{String(receipt.status)} / {String(receipt.phase)}</dd><dt>下一步</dt><dd>{String(receipt.nextAction)}</dd><dt>预算</dt><dd><code>{JSON.stringify(receipt.budget)}</code></dd><dt>目标版本</dt><dd><code>{JSON.stringify(receipt.target)}</code></dd><dt>失败分类</dt><dd><code>{JSON.stringify(receipt.failure)}</code></dd></dl></section>}
      {view === "all" && <>{showHumanDecisionFirst && <DossierSection number="待办" title="需要你的决定"><HumanDecisionPanel requests={humanRequests} loading={humanRequestsLoading} commentDrafts={commentDrafts} deciding={deciding} onCommentChange={(requestId, value) => setCommentDrafts((drafts) => ({ ...drafts, [requestId]: value }))} onOpenDecision={openDecision} /></DossierSection>}
      <DossierSection number="01" title="运行元数据"><dl className="ledger"><dt>Run ID</dt><dd><code>{selected.id}</code></dd><dt>Architecture</dt><dd>{selected.architecture}</dd><dt>创建时间</dt><dd>{formatTime(selected.createdAt)}</dd><dt>完成时间</dt><dd>{formatTime(selected.completedAt)}</dd><dt>证据目录</dt><dd><code className="path-code">{selected.artifactDir}</code></dd><dt>隔离</dt><dd><IsolationValue isolation={selected.isolation} /></dd></dl></DossierSection>
      <DossierSection number="02" title="任务与当前请求"><div className="run-request-context">{!selected.invocation?.requestText && <div className="run-context-warning" role="status">当前 Run 未保存请求全文；以下仅为调用摘要。</div>}<h3>任务描述</h3><p>{selected.invocation?.taskDescription ?? "未保存独立任务描述。"}</p><h3>当前请求全文</h3><p>{selected.invocation?.requestText ?? "请求全文不可用。"}</p><h3>请求摘要（核对用）</h3><p>{selected.invocation?.requestSummary ?? "未保存调用摘要。"}</p></div></DossierSection>
      {profileEntries.length > 0 && <DossierSection number="02" title="有效执行配置与来源"><div className="run-profile-list">{profileEntries.map(([nodeId, profile]) => <details key={nodeId} open={profileEntries.length === 1}><summary><strong>{nodeId}</strong><span>{profile.employee.displayName} · v{profile.employee.version}</span></summary><EffectiveProfileView profile={profile} /></details>)}</div></DossierSection>}
      {selected.architecture === "supervisor" && <DossierSection number={profileEntries.length > 0 ? "03" : "02"} title="动态执行图"><SupervisorRunTopology nodes={Object.values(selected.nodes)} /></DossierSection>}
      {selected.architecture === "supervisor" && <DossierSection number="进度" title="执行步骤与领队决策">
        <SupervisorLimitsLine run={selected} progress={progress} />
        <RunStepsTable run={selected} progress={progress} />
        {selected.status === "running" && (supervisorLiveState(selected, progress)?.gates?.length ?? 0) > 0 && <>
          <h3 className="run-subhead">门禁状态（进行中，服务端持久投影）</h3>
          <GateVerdictList gates={supervisorLiveState(selected, progress)?.gates ?? []} />
        </>}
        <h3 className="run-subhead">领队决策时间线</h3>
        <DecisionTimeline progress={progress} />
      </DossierSection>}
      <DossierSection number={profileEntries.length > 0 ? (selected.architecture === "supervisor" ? "04" : "03") : (selected.architecture === "supervisor" ? "03" : "02")} title="节点结果"><div className="run-node-list">{Object.values(selected.nodes).length === 0 && <p className="run-node-placeholder">{selected.status === "running" ? "节点正在建立，尚无角色输出。" : "此 Run 未记录节点输出。"}</p>}{Object.values(selected.nodes).map((node, index) => { const decision = supervisorDecision(node); return <article key={node.nodeId}><div className="run-node-head"><span className="node-number">{String(index + 1).padStart(2, "0")}</span><div><strong>{node.nodeId}</strong><code>{node.roleId}{node.metadata?.kind === "supervisor" ? ` · 领队 Round ${node.metadata.round ?? "—"}` : node.metadata?.kind === "member" ? ` · 成员 Round ${node.metadata.round ?? "—"}` : ""}{dagFlowTag(node)}</code></div><Stamp status={node.status} /></div><dl className="ledger horizontal"><dt>尝试</dt><dd>{node.attempts}</dd><dt>开始</dt><dd>{formatTime(node.startedAt)}</dd><dt>结束</dt><dd>{formatTime(node.completedAt)}</dd></dl>{decision && <div className="supervisor-decision-summary"><code>{decision.action.toUpperCase()}</code><span>{decision.summary ?? "领队未提供本轮摘要。"}</span></div>}{node.error && <div className="inline-error">{node.error}</div>}{node.output !== undefined ? <><E2eEvidenceList entries={e2eEvidenceEntries(node.output)} /><pre className="result-json">{JSON.stringify(node.output, null, 2)}</pre></> : node.status === "running" || selected.status === "running" ? <p className="run-node-placeholder">该节点正在执行，尚无输出。</p> : <p className="run-node-placeholder">该节点未记录输出。</p>}<code className="artifact-path">{node.artifactDir}</code></article>; })}</div></DossierSection>
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
        acceptanceBindingLoading={acceptanceBindingLoading}
        acceptanceRunId={acceptanceRunId}
        acceptanceBindingError={acceptanceBindingError === selected?.taskId}
        onOpenAcceptanceRun={() => { if (acceptanceRunId) { setSelectedId(acceptanceRunId); onSelectRun?.(acceptanceRunId); } }}
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
    {cancelOpen && selected?.invocation && <Modal title="停止本轮运行" eyebrow="CANCEL ATTEMPT · EVIDENCE PRESERVED" onClose={() => { if (!cancelling) setCancelOpen(false); }}>
      <div className="modal-body compact-form"><p>这会停止当前 Invocation 的所有实例，并作废尚未处理的人工决定。Run、提示词、输出和状态迁移证据都会保留；需求本身不会被删除。</p><label><span>停止原因（可选）</span><textarea rows={3} maxLength={2000} disabled={cancelling} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="例如：推进方向偏离需求，先停止并修正范围。" /></label>{cancelError && <div className="inline-error" role="alert">{cancelError}</div>}<div className="modal-actions"><button type="button" className="button secondary" disabled={cancelling} onClick={() => setCancelOpen(false)}>继续运行</button><button type="button" className="button danger-filled" disabled={cancelling} onClick={() => void cancelInvocation()}>{cancelling ? "正在停止…" : "确认停止本轮运行"}</button></div></div>
    </Modal>}
  </div>;
}
