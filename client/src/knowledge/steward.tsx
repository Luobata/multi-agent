import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, writeBody } from "../api";
import {
  ConversationComposer,
  ConversationMessageEvidence,
  type ComposerDraft
} from "../ConversationComposer";
import {
  EmptyState,
  Field,
  Modal,
  Stamp,
  UtilityIcon,
  formatTime,
  useDaemonAvailable,
  type StampStatus
} from "../components";
import type {
  Bootstrap,
  KnowledgeChangeOperationType,
  KnowledgeChangeRequest,
  KnowledgeChangeStatus,
  Project,
  Session
} from "../types";
import type { PageProps } from "./editors";

export const KNOWLEDGE_STEWARD_ROLE_ID = "knowledge-steward";

export function findKnowledgeStewardProjects(data: Bootstrap): Project[] {
  const boundRoles = new Map<string, Set<string>>();
  for (const binding of data.projectBindings) {
    boundRoles.set(binding.projectId, new Set(binding.roles.map((role) => role.roleId)));
  }
  return data.projects.filter((project) =>
    project.status === "active"
    && project.roles.some((role) => role.id === KNOWLEDGE_STEWARD_ROLE_ID)
    && (boundRoles.get(project.id)?.has(KNOWLEDGE_STEWARD_ROLE_ID) ?? false)
  );
}

export function listKnowledgeStewardSessions(data: Bootstrap): Session[] {
  return data.sessions
    .filter((session) => session.assignment?.roleId === KNOWLEDGE_STEWARD_ROLE_ID)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

const CHANGE_STATUS_COPY: Record<KnowledgeChangeStatus, string> = {
  "awaiting-approval": "待人工批准",
  applying: "执行中",
  applied: "已应用",
  rejected: "已拒绝",
  cancelled: "已取消",
  failed: "执行失败",
  "needs-reapproval": "需重新提案"
};

export function knowledgeChangeStamp(status: KnowledgeChangeStatus): { status: StampStatus; label: string } {
  switch (status) {
    case "awaiting-approval": return { status: "pending", label: CHANGE_STATUS_COPY[status] };
    case "applying": return { status: "running", label: CHANGE_STATUS_COPY[status] };
    case "applied": return { status: "passed", label: CHANGE_STATUS_COPY[status] };
    case "rejected": return { status: "blocked", label: CHANGE_STATUS_COPY[status] };
    case "cancelled": return { status: "archived", label: CHANGE_STATUS_COPY[status] };
    case "failed": return { status: "failed", label: CHANGE_STATUS_COPY[status] };
    case "needs-reapproval": return { status: "blocked", label: CHANGE_STATUS_COPY[status] };
  }
}

const OPERATION_COPY: Record<KnowledgeChangeOperationType, string> = {
  "knowledge-base.create": "建立知识库",
  "knowledge-base.update": "修订知识库",
  "knowledge-base.sync": "同步知识库来源",
  "knowledge-base.archive": "归档知识库",
  "knowledge-base.restore": "恢复知识库",
  "knowledge-revision.create": "生成知识 Revision",
  "knowledge-revision.publish": "发布 / 回滚 Revision",
  "knowledge-profile.create": "建立知识 Profile",
  "knowledge-profile.update": "修订知识 Profile",
  "knowledge-profile.archive": "归档知识 Profile",
  "knowledge-profile.restore": "恢复知识 Profile",
  "employee-profiles.set": "调整员工知识 Profile 授权",
  "project-role-profiles.set": "调整项目角色知识 Profile 授权"
};

const RISK_COPY: Record<KnowledgeChangeRequest["risk"], string> = {
  medium: "中",
  high: "高",
  critical: "严重"
};

type ChangeDecisionKind = "approve" | "reject" | "cancel";

interface ChangeDecision {
  kind: ChangeDecisionKind;
  change: KnowledgeChangeRequest;
}

const DECISION_COPY: Record<ChangeDecisionKind, { title: string; note: string; confirm: string }> = {
  approve: {
    title: "批准变更提案",
    note: "批准后 Core 会重新校验目标版本、质量与影响；任何变化都会让提案转为“需重新提案”，旧审批不会继续生效。",
    confirm: "确认批准并执行"
  },
  reject: {
    title: "拒绝变更提案",
    note: "拒绝只关闭这份提案，不会修改任何知识内容、发布指针或授权关系。",
    confirm: "确认拒绝"
  },
  cancel: {
    title: "取消变更提案",
    note: "取消后提案关闭；知识管家可以基于当前状态重新生成一份新提案。",
    confirm: "确认取消提案"
  }
};

function KnowledgeChangeCard({ change, busy, onDecide }: {
  change: KnowledgeChangeRequest;
  busy: boolean;
  onDecide: (decision: ChangeDecision) => void;
}) {
  const daemonAvailable = useDaemonAvailable();
  const stamp = knowledgeChangeStamp(change.status);
  const awaiting = change.status === "awaiting-approval";
  const actionable = awaiting || change.status === "needs-reapproval";
  const impactGroups: Array<{ label: string; ids: string[] }> = [
    { label: "知识库", ids: change.preview.impact.knowledgeBaseIds },
    { label: "Profile", ids: change.preview.impact.profileIds },
    { label: "员工", ids: change.preview.impact.employeeIds },
    { label: "项目角色", ids: change.preview.impact.projectRoles }
  ];
  return <article className="change-card" data-status={change.status}>
    <header className="change-card-head">
      <div className="change-card-title">
        <span className="change-kind">{OPERATION_COPY[change.operation.type]}</span>
        <h3>{change.title}</h3>
        <code>{change.id}</code>
      </div>
      <div className="change-card-badges">
        <span className={`change-risk change-risk--${change.risk}`}>风险 {RISK_COPY[change.risk]}</span>
        <Stamp status={stamp.status} label={stamp.label} />
      </div>
    </header>
    <p className="change-summary">{change.preview.summary}</p>
    <p className="change-reason"><span>理由</span>{change.reason}</p>
    {change.preview.warnings.length > 0 && <ul className="change-warnings">
      {change.preview.warnings.map((warning) => <li key={warning}><strong>提醒</strong>{warning}</li>)}
    </ul>}
    <div className="change-impact">
      <span className="change-impact-title">影响范围</span>
      <div className="change-impact-grid">{impactGroups.map((group) => <div className="change-impact-group" key={group.label}>
        <span>{group.label} · {group.ids.length}</span>
        <code>{group.ids.length ? group.ids.join("、") : "无直接影响"}</code>
      </div>)}</div>
    </div>
    <dl className="change-ledger">
      <dt>目标</dt><dd>{change.operation.targetId ?? "（新建目标）"}</dd>
      {change.operation.projectId && <><dt>项目角色</dt><dd>{change.operation.projectId}/{change.operation.roleId ?? "—"}</dd></>}
      {change.preview.expectedVersion !== undefined && <><dt>版本基准</dt><dd>v{change.preview.beforeVersion ?? "—"} → v{change.preview.expectedVersion}</dd></>}
      <dt>计划哈希</dt><dd><code>{change.planHash}</code></dd>
      <dt>发起</dt><dd>{change.requestedBy} · {formatTime(change.createdAt)}</dd>
      {change.appliedAt && <><dt>应用时间</dt><dd>{formatTime(change.appliedAt)}</dd></>}
    </dl>
    {change.approval && <p className={`change-approval change-approval--${change.approval.decision}`}>
      <strong>{change.approval.decision === "approved" ? "人工批准" : "人工拒绝"}</strong>
      <span>{change.approval.actor} · {formatTime(change.approval.at)}{change.approval.comment ? ` · ${change.approval.comment}` : ""}</span>
    </p>}
    {change.error && <p className="inline-error change-error">{change.error}</p>}
    {change.status === "needs-reapproval" && <p className="change-reapproval-note">目标版本或影响范围已变化，旧审批已失效。请取消此提案，并让知识管家基于当前状态重新生成。</p>}
    {actionable && <footer className="change-actions">
      {awaiting && <>
        <button type="button" className="button primary" disabled={!daemonAvailable || busy} onClick={() => onDecide({ kind: "approve", change })}>批准并执行</button>
        <button type="button" className="button danger" disabled={!daemonAvailable || busy} onClick={() => onDecide({ kind: "reject", change })}>拒绝</button>
      </>}
      <button type="button" className="button ghost" disabled={!daemonAvailable || busy} onClick={() => onDecide({ kind: "cancel", change })}>取消提案</button>
    </footer>}
  </article>;
}

const STEWARD_QUICK_PROMPTS = [
  "检查所有待发布草稿的质检结果和影响范围",
  "同步运营文档知识库并生成发布提案",
  "解释哪些员工和项目角色目前能看到机密知识"
];

export function KnowledgeStewardConsole({ data, refresh, notify }: PageProps) {
  const daemonAvailable = useDaemonAvailable();
  const stewardProjects = useMemo(() => findKnowledgeStewardProjects(data), [data]);
  const sessions = useMemo(() => listKnowledgeStewardSessions(data), [data]);
  const changes = useMemo(() => data.knowledgeChanges ?? [], [data]);
  const pendingChanges = changes.filter((change) => change.status === "awaiting-approval" || change.status === "needs-reapproval");
  const [sessionId, setSessionId] = useState("");
  const [freshSession, setFreshSession] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [decision, setDecision] = useState<ChangeDecision>();
  const [comment, setComment] = useState("");
  const [deciding, setDeciding] = useState(false);
  // 默认打开最新会话，刷新后历史立即可见；显式点击“新会话”才进入欢迎态。
  const selectedSession = freshSession ? undefined : sessions.find((session) => session.id === sessionId) ?? sessions[0];
  const stewardProject = stewardProjects.find((project) => project.id === selectedSession?.assignment?.projectId) ?? stewardProjects[0];
  const stewardRole = stewardProject?.roles.find((role) => role.id === KNOWLEDGE_STEWARD_ROLE_ID);
  const stewardName = stewardRole?.displayName ?? "知识管家";

  useEffect(() => {
    if (!freshSession && sessionId && !sessions.some((session) => session.id === sessionId)) setSessionId("");
  }, [sessions, sessionId, freshSession]);

  const send = async (draft: ComposerDraft): Promise<boolean> => {
    if (!stewardProject) return false;
    try {
      const result = await api<{ session: Session; runId: string; status: string; message: string }>(
        `/api/projects/${stewardProject.id}/roles/${KNOWLEDGE_STEWARD_ROLE_ID}/invoke`,
        {
          ...writeBody({
            message: draft.message,
            sessionId: freshSession ? undefined : selectedSession?.id,
            ...(draft.attachments.length > 0 ? { attachments: draft.attachments } : {})
          }),
          headers: {
            "x-multi-agent-source": "workbench",
            "x-multi-agent-source-label": "知识控制台 · AI 管理",
            "x-multi-agent-project": stewardProject.id
          }
        }
      );
      setSessionId(result.session.id);
      setFreshSession(false);
      notify(result.status === "blocked" ? "知识管家给出了业务阻塞结论" : `知识管家已完成回复 · ${result.runId}`);
      await refresh();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      return false;
    }
  };

  const submitDecision = async (event: FormEvent) => {
    event.preventDefault();
    if (!decision) return;
    setDeciding(true);
    try {
      const updated = await api<KnowledgeChangeRequest>(
        `/api/knowledge-changes/${decision.change.id}/${decision.kind}`,
        writeBody(decision.kind === "cancel" ? {} : { comment: comment.trim() || undefined })
      );
      if (decision.kind === "approve") {
        notify(updated.status === "applied" ? `「${updated.title}」已批准并应用` : `「${updated.title}」已批准，但执行失败：${updated.error ?? "未知错误"}`, updated.status === "applied" ? "success" : "error");
      } else {
        notify(decision.kind === "reject" ? `「${updated.title}」已拒绝；知识状态未修改` : `「${updated.title}」已取消`);
      }
      setDecision(undefined);
      setComment("");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      await refresh();
    } finally {
      setDeciding(false);
    }
  };

  return <div className="knowledge-console-workspace page-grid steward-console" role="tabpanel">
    <aside className="record-list steward-session-list">
      <header className="list-header"><h2>知识会话</h2><button className="square-action" disabled={!daemonAvailable || !stewardProjects.length} onClick={() => { setSessionId(""); setFreshSession(true); }} aria-label="新的知识会话"><UtilityIcon name="add" /></button></header>
      <div className="record-scroll">
        {sessions.map((session) => <button type="button" className={`steward-session-item ${session.id === selectedSession?.id ? "selected" : ""}`} key={session.id} onClick={() => { setSessionId(session.id); setFreshSession(false); }}>
          <span><strong>{session.title}</strong><code>{session.id}</code><small>{session.assignment?.projectId} · {session.messages.length} 条 · {formatTime(session.updatedAt)}</small></span>
        </button>)}
        {!sessions.length && <p className="steward-session-empty">尚无知识会话。发送第一条消息后会自动建立，并固定当前项目任用版本。</p>}
      </div>
      <footer className="list-footer"><span>{sessions.length} 个会话</span><span>STEWARD</span></footer>
    </aside>
    <main className="detail-pane steward-main">
      {!stewardProject ? <EmptyState title="还没有项目接入知识管家">
        AI 管理只通过已连接且已绑定 <code>{KNOWLEDGE_STEWARD_ROLE_ID}</code> 项目角色工作。请先在项目接入页完成任用，再回到这里开始会话；这里不会直接调用任何 Employee。
      </EmptyState> : <>
        <header className="steward-header">
          <div><span className="console-kicker">KNOWLEDGE STEWARD · PROJECT ROLE</span><h2>{stewardName}</h2><p>{stewardProject.name} · {stewardProject.id} · 会话固定项目任用版本，读取即时返回，变更必须人工批准。</p></div>
          <div className="steward-header-vitals"><span><b>{sessions.length}</b>会话</span><span><b>{pendingChanges.length}</b>待批提案</span></div>
        </header>
        <div className="steward-body">
          <section className="steward-chat">
            <header className="steward-chat-header"><div><span>SESSION TRANSCRIPT</span><h3>{selectedSession ? selectedSession.title : "新的知识会话"}</h3></div>{selectedSession && <code>{selectedSession.id}</code>}</header>
            <div className="steward-transcript" aria-live="polite">
              {(!selectedSession || selectedSession.messages.length === 0) && !sending && <div className="steward-welcome">
                <span className="console-kicker">WELCOME · {stewardProject.id}</span>
                <h3>你好，我是本项目的知识管家</h3>
                <p>我可以查询知识库与 Revision 质检、试跑草稿检索、解释 Profile 授权链；需要长期变更时，我会先生成标准提案卡，由你在右侧审批栏显式决定。</p>
                <div className="steward-prompt-chips">{STEWARD_QUICK_PROMPTS.map((prompt) => <button type="button" key={prompt} disabled={!daemonAvailable || sending} onClick={() => setMessage(prompt)}>{prompt}</button>)}</div>
                <p className="steward-welcome-note">对话内容不会自动批准任何变更。新增、修改、同步、发布、回滚、归档和授权调整都会先进入右侧待批卡片，只有显式批准才会执行。</p>
              </div>}
              {selectedSession?.messages.map((item) => <article className={`steward-message steward-message--${item.role}`} key={item.id}>
                <div className="steward-message-meta"><span>{item.role === "user" ? "我" : item.role === "employee" ? stewardName : "系统"}</span><time>{formatTime(item.at)}</time>{item.runId && <code>{item.runId}</code>}</div>
                <p className="steward-message-bubble">{item.content}</p>
                <ConversationMessageEvidence attachments={item.attachments} documents={item.documents} />
              </article>)}
              {sending && <article className="steward-message steward-message--employee steward-message--pending">
                <div className="steward-message-meta"><span>{stewardName}</span><span>处理中</span></div>
                <p className="steward-message-bubble">正在通过项目角色调用知识管家；回复、Prompt 与 Run 证据会一起留存…</p>
              </article>}
            </div>
            <ConversationComposer
              className="steward-composer"
              ariaLabel="发给知识管家的消息"
              placeholder="询问知识现状、要求试跑或提出变更……"
              disabled={!daemonAvailable}
              message={message}
              onMessageChange={setMessage}
              onSend={send}
              onPendingChange={setSending}
              sendingLabel="知识管家处理中…"
            />
          </section>
          <section className="steward-changes">
            <header><div><span className="console-kicker">CHANGE PROPOSALS · HUMAN APPROVAL</span><h3>变更提案</h3></div><strong>{pendingChanges.length} 待批</strong></header>
            <div className="steward-changes-scroll">
              {changes.map((change) => <KnowledgeChangeCard change={change} busy={deciding} key={change.id} onDecide={(next) => { setComment(""); setDecision(next); }} />)}
              {!changes.length && <div className="steward-changes-empty"><strong>暂无变更提案</strong><span>对话中提出的长期变更会在这里形成标准提案卡；批准、拒绝与取消只能由人工按钮完成。</span></div>}
            </div>
          </section>
        </div>
      </>}
    </main>
    {decision && <Modal title={`${DECISION_COPY[decision.kind].title} · ${decision.change.title}`} eyebrow={`${decision.change.id} · HUMAN DECISION REQUIRED`} onClose={() => { setDecision(undefined); setComment(""); }}>
      <form className="modal-body compact-form" onSubmit={submitDecision}>
        <div className="project-connect-note"><strong>{DECISION_COPY[decision.kind].note}</strong><p>提案卡与对话文案都不是授权凭证；这次点击会作为人工决定写入审批记录。</p></div>
        {decision.kind !== "cancel" && <Field label={decision.kind === "approve" ? "批准批注（可选）" : "拒绝原因（可选）"}><textarea rows={3} disabled={!daemonAvailable || deciding} value={comment} onChange={(event) => setComment(event.target.value)} /></Field>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={() => { setDecision(undefined); setComment(""); }}>返回</button>
          <button className={decision.kind === "reject" ? "button danger-filled" : "button primary"} disabled={!daemonAvailable || deciding}>{deciding ? "提交中…" : DECISION_COPY[decision.kind].confirm}</button>
        </div>
      </form>
    </Modal>}
  </div>;
}
