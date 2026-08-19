import { Modal, Stamp, formatTime } from "../components";
import type { HumanDecisionRequest, HumanDecisionRiskCategory } from "../types";

/** 人在回路：请求卡片、面板与显式确认弹窗。 */
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

export function HumanDecisionPanel({
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

export function HumanDecisionConfirmation({
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
