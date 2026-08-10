import { useEffect, useMemo, useState } from "react";
import { api, writeBody } from "./api";
import {
  ConversationComposer,
  ConversationMessageEvidence,
  type ComposerDraft
} from "./ConversationComposer";
import {
  DossierSection,
  EmptyState,
  Modal,
  ReadonlyEvidence,
  Stamp,
  formatTime,
  useDaemonAvailable,
  type StampStatus
} from "./components";
import type {
  Bootstrap,
  ConfigurationProposal,
  ConfigurationProposalStatus,
  Employee,
  Session
} from "./types";

const CONFIGURATION_STEWARD_ROLE_ID = "configuration-steward";

const STATUS_COPY: Record<ConfigurationProposalStatus, string> = {
  "awaiting-review": "待逐项审阅",
  "ready-to-apply": "可应用",
  applying: "应用中",
  applied: "已应用",
  "needs-reapproval": "需重新提案",
  cancelled: "已取消",
  failed: "应用失败"
};

const STATUS_STAMP: Record<ConfigurationProposalStatus, StampStatus> = {
  "awaiting-review": "pending",
  "ready-to-apply": "active",
  applying: "running",
  applied: "passed",
  "needs-reapproval": "blocked",
  cancelled: "archived",
  failed: "failed"
};

const RISK_COPY = { low: "低风险", medium: "中风险", high: "高风险" } as const;

function latestDecisions(proposal: ConfigurationProposal) {
  return new Map(proposal.decisions.map((decision) => [decision.reviewItemId, decision]));
}

export function EmployeeConfigurationDraftModal({
  employee,
  data,
  refresh,
  notify,
  onClose
}: {
  employee: Employee;
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
  onClose: () => void;
}) {
  const daemonAvailable = useDaemonAvailable();
  const project = data.projects.find((candidate) =>
    candidate.status === "active" && (() => {
      const role = candidate.roles.find((item) => item.id === CONFIGURATION_STEWARD_ROLE_ID);
      const projectBinding = data.projectBindings.find((item) => item.projectId === candidate.id && item.projectVersion === candidate.version);
      const assignment = projectBinding?.roles.find((item) => item.roleId === CONFIGURATION_STEWARD_ROLE_ID);
      // The bootstrap payload exposes only each Employee's current version, while a
      // valid project binding intentionally pins a historical version. Compatibility
      // is enforced by Core when the binding is created; do not try to reconstruct it
      // from an unrelated current Employee snapshot here.
      return Boolean(role && assignment);
    })()
  );
  const binding = project
    ? data.projectBindings.find((candidate) => candidate.projectId === project.id && candidate.projectVersion === project.version)
      ?.roles.find((role) => role.roleId === CONFIGURATION_STEWARD_ROLE_ID)
    : undefined;
  const sessions = useMemo(() => data.sessions
    .filter((session) => session.assignment?.projectId === project?.id
      && session.assignment?.roleId === CONFIGURATION_STEWARD_ROLE_ID
      && session.context?.kind === "employee-configuration"
      && session.context.employeeId === employee.id
      && session.context.expectedEmployeeVersion === employee.version)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [data.sessions, employee.id, employee.version, project?.id]);
  const proposals = useMemo(() => (data.configurationProposals ?? [])
    .filter((proposal) => proposal.employeeId === employee.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [data.configurationProposals, employee.id]);
  const [sessionId, setSessionId] = useState("");
  const selectedSession = sessions.find((session) => session.id === sessionId) ?? sessions[0];
  const [proposalId, setProposalId] = useState("");
  const proposal = proposals.find((candidate) => candidate.id === proposalId) ?? proposals[0];
  const [busyItem, setBusyItem] = useState("");
  const [applying, setApplying] = useState(false);
  const decisions = proposal ? latestDecisions(proposal) : new Map();

  useEffect(() => {
    if (sessionId && !sessions.some((session) => session.id === sessionId)) setSessionId("");
  }, [sessionId, sessions]);
  useEffect(() => {
    if (proposalId && !proposals.some((candidate) => candidate.id === proposalId)) setProposalId("");
  }, [proposalId, proposals]);

  const send = async (draft: ComposerDraft): Promise<boolean> => {
    if (!project || !binding) return false;
    try {
      const result = await api<{ session: Session; runId: string; status: string; message: string }>(
        `/api/projects/${project.id}/roles/${CONFIGURATION_STEWARD_ROLE_ID}/invoke`,
        {
          ...writeBody({
            message: `[Employee target: ${employee.id} · expected v${employee.version}]\n${draft.message}`,
            sessionId: selectedSession?.id,
            ...(draft.attachments.length > 0 ? { attachments: draft.attachments } : {}),
            context: {
              kind: "employee-configuration",
              employeeId: employee.id,
              expectedEmployeeVersion: employee.version
            }
          }),
          headers: {
            "x-multi-agent-source": "workbench",
            "x-multi-agent-source-label": "员工档案 · AI 对话起草",
            "x-multi-agent-project": project.id
          }
        }
      );
      setSessionId(result.session.id);
      notify(`配置管家已完成回复 · ${result.runId}`);
      await refresh();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      return false;
    }
  };

  const decide = async (reviewItemId: string, decision: "accepted" | "rejected") => {
    if (!proposal) return;
    setBusyItem(reviewItemId);
    try {
      await api<ConfigurationProposal>(
        `/api/configuration-proposals/${proposal.id}/review-items/${reviewItemId}/decisions`,
        writeBody({
          decision,
          expectedReviewRevision: proposal.reviewRevision,
          expectedReviewHash: proposal.reviewHash
        })
      );
      notify(decision === "accepted" ? "已接受这一项；尚未应用 Employee" : "已拒绝这一项；尚未应用 Employee");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      await refresh();
    } finally {
      setBusyItem("");
    }
  };

  const apply = async () => {
    if (!proposal) return;
    setApplying(true);
    try {
      const applied = await api<ConfigurationProposal>(
        `/api/configuration-proposals/${proposal.id}/apply`,
        writeBody({
          expectedReviewRevision: proposal.reviewRevision,
          expectedReviewHash: proposal.reviewHash
        })
      );
      notify(`已应用为 Employee v${applied.result?.employeeVersion ?? employee.version + 1}`, "success");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      await refresh();
    } finally {
      setApplying(false);
    }
  };

  return <Modal
    title={`AI 对话起草 · ${employee.identity.displayName}`}
    eyebrow={`${employee.id} · CURRENT v${employee.version} · HUMAN REVIEW REQUIRED`}
    onClose={onClose}
    wide
  >
    <div className="configuration-draft-layout">
      <section className="configuration-chat-panel" aria-label="配置管家对话">
        <header>
          <div><span className="ai-content-badge">AI 生成内容</span><h3>配置管家</h3></div>
          <p>通过项目角色与受限 Configuration Control MCP 工作。对话只会创建冻结提案，不会修改 Employee。</p>
        </header>
        {!project || !binding ? <EmptyState title="配置管家尚未完成项目任用">
          缺少已连接的 <code>{CONFIGURATION_STEWARD_ROLE_ID}</code> 项目角色或 binding。请先完成 bootstrap，再开始起草。
        </EmptyState> : <>
          <div className="configuration-chat-evidence">
            <span>项目角色 <code>{project.id}/{CONFIGURATION_STEWARD_ROLE_ID}</code></span>
            <span>固定员工 <code>{binding.employeeId} v{binding.employeeVersion}</code></span>
            <span>目标 <code>{employee.id} v{employee.version}</code></span>
          </div>
          <div className="configuration-transcript" aria-live="polite">
            {selectedSession?.messages.map((item) => <article className={`configuration-message configuration-message--${item.role}`} key={item.id}>
              <header><b>{item.role === "user" ? "你" : item.role === "employee" ? "配置管家 · AI" : "系统"}</b><time>{formatTime(item.at)}</time></header>
              <p>{item.content}</p>
              <ConversationMessageEvidence attachments={item.attachments} documents={item.documents} />
              {item.runId && <code>Run {item.runId}</code>}
            </article>)}
            {!selectedSession && <div className="configuration-chat-empty"><strong>描述你希望调整的内容</strong><p>例如“让职责更聚焦前端测试，并把写权限保持为 none”。不满意时继续对话要求重新提案；已冻结提案不会被直接编辑。</p></div>}
          </div>
          <ConversationComposer
            className="configuration-composer"
            ariaLabel="给配置管家的消息"
            placeholder="说明目标、不能改变的边界和你希望看到的结果…"
            disabled={!daemonAvailable}
            submitLabel="发送并起草"
            sendingLabel="配置管家工作中…"
            hint="发送会创建 Session/Run 证据；聊天文本不是授权。⌘ / Ctrl + Enter 发送"
            offlineHint="daemon 离线：历史可读，不能发送或写入"
            onSend={send}
          />
        </>}
      </section>

      <section className="configuration-proposal-panel" aria-label="配置提案审阅">
        <header className="configuration-proposal-heading">
          <div><span>FROZEN PROPOSAL</span><h3>提案与逐项审阅</h3></div>
          <p>没有“一键全部接受”。每项决定都会追加到审阅记录，显式应用前 Employee 保持不变。</p>
        </header>
        {proposals.length > 1 && <nav className="configuration-proposal-tabs" aria-label="配置提案历史">
          {proposals.map((candidate) => <button type="button" aria-current={candidate.id === proposal?.id ? "page" : undefined} className={candidate.id === proposal?.id ? "selected" : ""} key={candidate.id} onClick={() => setProposalId(candidate.id)}><span>{candidate.title}</span><code>v{candidate.expectedEmployeeVersion} · {STATUS_COPY[candidate.status]}</code></button>)}
        </nav>}
        {!proposal ? <EmptyState title="还没有配置提案">在左侧描述期望；配置管家读取当前 Employee 后可创建严格类型化 Proposal。</EmptyState> : <div className="configuration-proposal-scroll">
          <DossierSection number="01" title="冻结摘要">
            <div className="configuration-proposal-title"><div><span className="ai-content-badge">AI 生成提案</span><h4>{proposal.title}</h4><p>{proposal.reason}</p></div><Stamp status={STATUS_STAMP[proposal.status]} label={STATUS_COPY[proposal.status]} /></div>
            <dl className="configuration-proposal-facts">
              <dt>来源</dt><dd><code>{proposal.source.projectId} v{proposal.source.projectVersion ?? "?"}/{proposal.source.projectRoleId} · binding v{proposal.source.projectBindingVersion ?? "?"}</code></dd>
              <dt>证据</dt><dd><code>{proposal.source.employeeId ?? "legacy-unverified"} v{proposal.source.employeeVersion ?? "?"} · Run {proposal.source.runId ?? "unavailable"}</code></dd>
              <dt>目标版本</dt><dd><code>{proposal.employeeId} · expected v{proposal.expectedEmployeeVersion}</code></dd>
              <dt>计划哈希</dt><dd><code>{proposal.planHash}</code></dd>
              <dt>审阅快照</dt><dd><code>R{proposal.reviewRevision} · {proposal.reviewHash}</code></dd>
              <dt>审阅进度</dt><dd>{proposal.progress.reviewed}/{proposal.progress.total} · 接受 {proposal.progress.accepted} · 拒绝 {proposal.progress.rejected} · 待审 {proposal.progress.pending}</dd>
            </dl>
            {(proposal.error || !proposal.validation.valid) && <div className="configuration-warning" role="alert"><strong>{proposal.status === "needs-reapproval" ? "计划已漂移，必须重新提案" : ["applied", "cancelled", "failed"].includes(proposal.status) ? "历史审计证据不完整" : "候选暂不可应用"}</strong><p>{proposal.error ?? proposal.validation.errors.join("；")}</p></div>}
          </DossierSection>
          <DossierSection number="02" title={`逐项 before / after · ${proposal.reviewItems.length}`}>
            <div className="configuration-review-items">{proposal.reviewItems.map((item) => {
              const decision = decisions.get(item.id);
              const locked = !["awaiting-review", "ready-to-apply"].includes(proposal.status);
              return <article className="configuration-review-item" data-decision={decision?.decision ?? "pending"} key={item.id}>
                <header><div><span>{item.label}</span><strong>{RISK_COPY[item.risk]}</strong></div><p>{item.rationale}</p>{decision && <Stamp status={decision.decision === "accepted" ? "active" : "blocked"} label={decision.decision === "accepted" ? "已接受" : "已拒绝"} />}</header>
                <div className="configuration-diff"><ReadonlyEvidence label="BEFORE · 当前值" value={JSON.stringify(item.before, null, 2)} mono /><ReadonlyEvidence label="AFTER · AI 建议" value={JSON.stringify(item.after, null, 2)} mono /></div>
                <footer><span>{decision ? `最近决定：${decision.actor} · ${formatTime(decision.at)}` : "待人工决定；AI 建议尚未生效。"}</span><div><button type="button" className="button secondary" disabled={!daemonAvailable || locked || Boolean(busyItem)} onClick={() => void decide(item.id, "rejected")}>拒绝此项</button><button type="button" className="button primary" disabled={!daemonAvailable || locked || Boolean(busyItem)} onClick={() => void decide(item.id, "accepted")}>接受此项</button></div></footer>
              </article>;
            })}</div>
          </DossierSection>
          <footer className="configuration-apply-bar">
            <div><strong>{proposal.status === "ready-to-apply" ? "候选已通过 Core 校验" : "Employee 尚未改变"}</strong><span>{proposal.status === "ready-to-apply" ? `应用将一次性生成 v${proposal.expectedEmployeeVersion + 1}；既有 Session 与 Project Binding 继续固定旧版本。` : "完成每一项审阅并至少接受一项后，才会开放应用。"}</span></div>
            <button type="button" className="button primary" disabled={!daemonAvailable || applying || proposal.status !== "ready-to-apply"} onClick={() => void apply()}>{applying ? "重读并应用中…" : `显式应用为 v${proposal.expectedEmployeeVersion + 1}`}</button>
          </footer>
        </div>}
      </section>
    </div>
  </Modal>;
}
