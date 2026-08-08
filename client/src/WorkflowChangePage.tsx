import type { Bootstrap, SupervisorGate, SupervisorWorkflow, WorkflowChangeOperation, WorkflowChangeRequest, WorkflowChangeStatus } from "./types.js";
import { EmptyState, Stamp, formatTime, type StampStatus } from "./components.js";

interface PageProps {
  data: Bootstrap;
}

const STATUS_COPY: Record<WorkflowChangeStatus, string> = {
  "awaiting-approval": "待人工批准",
  applied: "已应用",
  rejected: "已拒绝"
};

function changeStamp(status: WorkflowChangeStatus): { status: StampStatus; label: string } {
  switch (status) {
    case "awaiting-approval": return { status: "pending", label: STATUS_COPY[status] };
    case "applied": return { status: "passed", label: STATUS_COPY[status] };
    case "rejected": return { status: "blocked", label: STATUS_COPY[status] };
  }
}

const OPERATION_COPY: Record<WorkflowChangeOperation["kind"], string> = {
  "add-gate": "新增门禁",
  "update-gate": "修改门禁",
  "remove-gate": "移除门禁"
};

const RISK_COPY: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重"
};

function riskLabel(risk: string): string {
  return RISK_COPY[risk] ?? risk;
}

const GATE_FIELD_COPY: Record<string, string> = {
  requiredCapability: "需要能力",
  mode: "执行时机",
  required: "硬门禁",
  instructions: "执行说明",
  fallback: "没有合适成员时",
  validatorId: "证据校验"
};

/** Human-readable rendering for a single gate field value. Falls back to the raw string. */
function gateFieldValue(field: string, value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return field === "validatorId" ? "自动（按能力）" : "—";
  }
  if (field === "mode") return value === "after-each-delegation" ? "每项匹配工作后" : "最终交付前";
  if (field === "fallback") return value === "block" ? "交给任一成员" : "领队兜底";
  if (field === "required") return value ? "是" : "否";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** Raw stringification used by the before/after diff so field names stay machine-comparable. */
function rawFieldValue(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export interface GateFieldDiff {
  field: string;
  before: string;
  after: string;
}

/**
 * Pairs each patched gate field with its prior value from the frozen gate.
 * A missing prior gate (unknown gateId) renders each `before` as an explicit absent marker.
 */
export function gateUpdateDiff(gate: SupervisorGate | undefined, patch: Partial<Omit<SupervisorGate, "id">>): GateFieldDiff[] {
  return Object.entries(patch).map(([field, next]) => ({
    field,
    before: rawFieldValue(gate ? (gate as unknown as Record<string, unknown>)[field] : undefined),
    after: rawFieldValue(next)
  }));
}

function GateFacts({ gate }: { gate: SupervisorGate }) {
  const rows: Array<[string, string]> = [
    ["Gate ID", gate.id],
    [GATE_FIELD_COPY.requiredCapability, gateFieldValue("requiredCapability", gate.requiredCapability)],
    [GATE_FIELD_COPY.mode, gateFieldValue("mode", gate.mode)],
    [GATE_FIELD_COPY.required, gateFieldValue("required", gate.required)],
    [GATE_FIELD_COPY.fallback, gateFieldValue("fallback", gate.fallback)],
    [GATE_FIELD_COPY.validatorId, gateFieldValue("validatorId", gate.validatorId)]
  ];
  return <dl className="change-ledger workflow-change-gate-facts">
    {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    <div className="workflow-change-gate-instructions"><dt>{GATE_FIELD_COPY.instructions}</dt><dd>{gate.instructions}</dd></div>
  </dl>;
}

function OperationBlock({ operation, gates }: { operation: WorkflowChangeOperation; gates: SupervisorGate[] }) {
  return <article className={`workflow-change-op workflow-change-op--${operation.kind}`}>
    <header>
      <span className="change-kind">{OPERATION_COPY[operation.kind]}</span>
      <span className={`change-risk change-risk--${operation.risk}`}>风险 {riskLabel(operation.risk)}</span>
    </header>
    {operation.kind === "add-gate" && <GateFacts gate={operation.gate} />}
    {operation.kind === "remove-gate" && <p className="workflow-change-op-target">移除门禁 <code>{operation.gateId}</code></p>}
    {operation.kind === "update-gate" && <div className="workflow-change-diff">
      <p className="workflow-change-op-target">修改门禁 <code>{operation.gateId}</code></p>
      <div className="workflow-change-diff-rows">{gateUpdateDiff(gates.find((gate) => gate.id === operation.gateId), operation.patch).map((row) => <div className="workflow-change-diff-row" key={row.field}>
        <span className="workflow-change-diff-field">{GATE_FIELD_COPY[row.field] ?? row.field}<code>{row.field}</code></span>
        <span className="workflow-change-diff-values"><del>{row.before}</del> <i aria-hidden="true">→</i> <ins>{row.after}</ins></span>
      </div>)}</div>
    </div>}
    <p className="workflow-change-op-rationale"><span>理由</span>{operation.rationale}</p>
  </article>;
}

function WorkflowChangeCard({ change, workflow }: { change: WorkflowChangeRequest; workflow?: SupervisorWorkflow }) {
  const stamp = changeStamp(change.status);
  const gates = workflow?.flow.gates ?? [];
  return <article className="change-card workflow-change-card" data-status={change.status}>
    <header className="change-card-head">
      <div className="change-card-title">
        <span className="change-kind">门禁变更 · {change.operations.length} 项操作</span>
        <h3>{change.title}</h3>
        <code>{change.id}</code>
      </div>
      <div className="change-card-badges">
        <Stamp status={stamp.status} label={stamp.label} />
      </div>
    </header>
    <p className="change-reason"><span>理由</span>{change.reason}</p>
    <dl className="change-ledger">
      <dt>目标编排</dt><dd>{change.workflowId}</dd>
      <dt>冻结版本</dt><dd>冻结 v{change.workflowVersion}{workflow && workflow.version !== change.workflowVersion ? ` · 当前 v${workflow.version}` : ""}</dd>
      <dt>发起</dt><dd>{change.requestedBy} · {formatTime(change.createdAt)}</dd>
      <dt>更新时间</dt><dd>{formatTime(change.updatedAt)}</dd>
    </dl>
    <div className="workflow-change-ops">
      {change.operations.map((operation, index) => <OperationBlock key={`${operation.kind}-${index}`} operation={operation} gates={gates} />)}
    </div>
    {change.review && <p className={`change-approval ${change.status === "rejected" ? "change-approval--rejected" : ""}`}>
      <strong>审批记录</strong>
      <span>{change.review.actor} · {formatTime(change.review.at)}{change.review.comment ? ` · ${change.review.comment}` : ""}</span>
    </p>}
  </article>;
}

/**
 * Read-only viewer for supervisor-workflow gate change proposals. Approve / reject / apply
 * happen exclusively through the CLI/HTTP surface, so this surface renders no write controls.
 */
export function WorkflowChangePage({ data }: PageProps) {
  const changes = data.workflowChanges ?? [];
  const supervisorWorkflows = new Map(
    data.workflows
      .filter((workflow): workflow is SupervisorWorkflow => workflow.architecture === "supervisor")
      .map((workflow) => [workflow.id, workflow])
  );
  const pending = changes.filter((change) => change.status === "awaiting-approval").length;

  return <section className="workflow-change-console" role="tabpanel">
    <header className="workflow-change-header">
      <div><span className="console-kicker">GATE CHANGE PROPOSALS · READ ONLY</span><h2>门禁变更</h2><p>小关提出的门禁变更提案；批准、拒绝与应用只通过 CLI / HTTP 完成，这里只提供只读查看。</p></div>
      <div className="workflow-change-vitals"><span><b>{changes.length}</b>提案</span><span><b>{pending}</b>待批准</span></div>
    </header>
    {changes.length === 0
      ? <EmptyState title="暂无门禁变更提案">小关生成的门禁变更提案会在这里形成只读卡片；每条提案冻结目标编排版本，逐条展示 add / update / remove 门禁操作与审批记录。</EmptyState>
      : <div className="workflow-change-scroll">
        {changes.map((change) => <WorkflowChangeCard key={change.id} change={change} workflow={supervisorWorkflows.get(change.workflowId)} />)}
      </div>}
  </section>;
}
