import type { InvocationProgress, JsonValue, Run, RunNode } from "../types";
import { objectValue } from "./shared";

/**
 * Supervisor 可观测性：门禁快照、DAG 等待原因、执行步骤表、领队决策时间线与限额行。
 * 所有读取都对缺失/畸形数据宽容；只渲染后端真正持久化的字段，不推断。
 */
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
export function gateVerdicts(value: JsonValue | undefined): GateVerdict[] {
  const raw = objectValue(value)?.gates;
  if (!Array.isArray(raw)) return [];
  return raw.map(gateVerdictFrom).filter((gate): gate is GateVerdict => gate !== undefined);
}

export function GateVerdictList({ gates }: { gates: GateVerdict[] }) {
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
export function supervisorLiveState(run: Run | undefined, progress?: InvocationProgress): SupervisorLiveState | undefined {
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
export function RunStepsTable({ run, progress }: { run: Run; progress: InvocationProgress | undefined }) {
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
export function DecisionTimeline({ progress }: { progress: InvocationProgress | undefined }) {
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
export function SupervisorLimitsLine({ run, progress }: { run: Run; progress: InvocationProgress | undefined }) {
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
