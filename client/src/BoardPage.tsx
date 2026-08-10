/** 需求看板：七列 + 阻塞/失败/取消三异常态（与列正交）。第一阶段无拖拽，列迁移走详情页。 */
import { useMemo, useState } from "react";
import { api, writeBody } from "./api";
import { ConversationComposer, ConversationMessageEvidence, type ComposerDraft } from "./ConversationComposer";
import { EmptyState, Field, Modal, RuntimeStatusChip, SelectControl, Stamp, formatTime, useDaemonAvailable } from "./components";
import { requirementOwnerLabel } from "./dashboard/advancement";
import { dashboardService, type DashboardService } from "./dashboard/service";
import type { ManagedProject, Requirement, RequirementException, RequirementPriority, SpaceNode } from "./dashboard/types";
import { REQUIREMENT_EXCEPTION_LABELS, REQUIREMENT_LANES, REQUIREMENT_PRIORITY_LABELS } from "./dashboard/types";
import { ErrorBlock, OfflineNotice, PageHeader, SkeletonBlock, useServiceData } from "./dashboard/view";
import type { JsonValue, Session } from "./types";
import "./board-ai.css";

const REQUIREMENT_STEWARD_ROLE_ID = "requirement-steward";

interface AgentRequirementDraft {
  title: string;
  summary: string;
  priority: RequirementPriority;
  rawRequirement: string;
  acceptanceCriteria: string[];
}

interface RequirementStewardOutput {
  message: string;
  nextAction: "clarify" | "draft";
  draft?: AgentRequirementDraft | null;
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

export function requirementStewardOutput(value: JsonValue | undefined): RequirementStewardOutput | undefined {
  const output = objectValue(value);
  if (!output || typeof output.message !== "string" || (output.nextAction !== "clarify" && output.nextAction !== "draft")) return undefined;
  const candidate = objectValue(output.draft);
  const draft = candidate
    && typeof candidate.title === "string"
    && typeof candidate.summary === "string"
    && ["low", "medium", "high"].includes(String(candidate.priority))
    && typeof candidate.rawRequirement === "string"
    && Array.isArray(candidate.acceptanceCriteria)
    && candidate.acceptanceCriteria.every((item) => typeof item === "string")
    ? {
        title: candidate.title,
        summary: candidate.summary,
        priority: candidate.priority as RequirementPriority,
        rawRequirement: candidate.rawRequirement,
        acceptanceCriteria: candidate.acceptanceCriteria as string[]
      }
    : null;
  return { message: output.message, nextAction: output.nextAction, draft };
}

function exceptionChip(exception: Requirement["exception"]) {
  if (exception === "blocked") return <Stamp status="blocked" label={REQUIREMENT_EXCEPTION_LABELS.blocked} />;
  if (exception === "failed") return <Stamp status="failed" label={REQUIREMENT_EXCEPTION_LABELS.failed} />;
  if (exception === "cancelled") return <RuntimeStatusChip status="cancelled" label={REQUIREMENT_EXCEPTION_LABELS.cancelled} />;
  return null;
}

export function BoardPage({ spaceId, go, notify, service = dashboardService, catalogRevision = "" }: {
  spaceId?: string;
  go: (hash: string) => void;
  notify: (message: string, kind?: "success" | "error") => void;
  service?: DashboardService;
  catalogRevision?: string;
}) {
  const daemonAvailable = useDaemonAvailable();
  const { state, reload, setData } = useServiceData<{ requirements: Requirement[]; nodes: SpaceNode[] }>(
    async () => ({ requirements: await service.listBoard(spaceId), nodes: await service.listSpaces() }),
    [service, spaceId, catalogRevision]
  );
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState(spaceId ?? "all");
  const [priority, setPriority] = useState<RequirementPriority | "all">("all");
  const [exception, setException] = useState<Exclude<RequirementException, null> | "all" | "normal">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState(spaceId ?? "");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [rawRequirement, setRawRequirement] = useState("");
  const [criteria, setCriteria] = useState("");
  const [createPriority, setCreatePriority] = useState<RequirementPriority>("medium");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentProjectId, setAgentProjectId] = useState(spaceId ?? "");
  const [agentSession, setAgentSession] = useState<Session>();
  const [agentDraft, setAgentDraft] = useState<AgentRequirementDraft>();
  const [agentPhase, setAgentPhase] = useState<"idle" | "waiting" | "clarify" | "draft">("idle");
  const [agentSourceMessages, setAgentSourceMessages] = useState<string[]>([]);
  const [agentError, setAgentError] = useState("");

  const data = state.status === "ready" ? state.data : undefined;
  const project = data?.nodes.find((node) => node.id === spaceId && node.kind === "project");
  const projects = (data?.nodes ?? []).filter((node): node is ManagedProject => node.kind === "project" && !node.archivedAt);
  const projectName = (projectId: string) => data?.nodes.find((node) => node.id === projectId)?.name ?? projectId;
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (data?.requirements ?? []).filter((item) => {
      if (!spaceId && projectFilter !== "all" && item.projectId !== projectFilter) return false;
      if (priority !== "all" && item.priority !== priority) return false;
      if (exception === "normal" && item.exception !== null) return false;
      if (exception !== "all" && exception !== "normal" && item.exception !== exception) return false;
      return !term || item.code.toLowerCase().includes(term) || item.title.toLowerCase().includes(term) || item.summary.toLowerCase().includes(term);
    });
  }, [data?.requirements, exception, priority, projectFilter, query, spaceId]);
  const grouped = useMemo(() => {
    const map = new Map<string, Requirement[]>(REQUIREMENT_LANES.map((lane) => [lane.id, []]));
    for (const requirement of filtered) map.get(requirement.lane)?.push(requirement);
    return map;
  }, [filtered]);

  const openCreate = () => {
    setCreateProjectId(spaceId ?? projects[0]?.id ?? "");
    setFormError("");
    setCreateOpen(true);
  };

  const resetAgentConversation = (projectId = spaceId ?? projects[0]?.id ?? "") => {
    setAgentProjectId(projectId);
    setAgentSession(undefined);
    setAgentDraft(undefined);
    setAgentPhase("idle");
    setAgentSourceMessages([]);
    setAgentError("");
  };

  const openAgentCreate = () => {
    resetAgentConversation();
    setAgentOpen(true);
  };

  const talkToRequirementSteward = async (draft: ComposerDraft): Promise<boolean> => {
    if (!agentProjectId) return false;
    setAgentError("");
    // A follow-up invalidates the visible draft immediately. The user must never be able to
    // confirm an older draft while the Agent is reconsidering scope or asking a new question.
    setAgentDraft(undefined);
    setAgentPhase("waiting");
    try {
      const result = await api<{ session: Session; runId: string; status: string; message: string; output?: JsonValue }>(
        `/api/projects/${encodeURIComponent(agentProjectId)}/conversations/${REQUIREMENT_STEWARD_ROLE_ID}/invoke`,
        {
          ...writeBody({
            message: draft.message,
            sessionId: agentSession?.id,
            ...(draft.attachments.length > 0 ? { attachments: draft.attachments } : {})
          }),
          headers: {
            "x-multi-agent-source": "workbench",
            "x-multi-agent-source-label": "需求看板 · AI 对话创建",
            "x-multi-agent-project": agentProjectId
          }
        }
      );
      const sourceMessages = [...agentSourceMessages, draft.message];
      setAgentSession(result.session);
      setAgentSourceMessages(sourceMessages);
      const output = requirementStewardOutput(result.output);
      if (output?.nextAction === "draft" && output.draft) {
        setAgentDraft({
          ...output.draft,
          // 原始需求永远来自用户逐轮原话；Agent 无权用改写稿覆盖它。
          rawRequirement: sourceMessages.join("\n\n")
        });
        setAgentPhase("draft");
      } else if (output?.nextAction === "clarify") {
        setAgentPhase("clarify");
      }
      if (!output) {
        setAgentPhase("idle");
        setAgentError("Agent 已回复，但没有返回可识别的需求草稿；你可以继续说明，当前输入和附件证据都已保留在会话中。");
      }
      return true;
    } catch (error) {
      setAgentPhase("idle");
      setAgentError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const confirmAgentRequirement = async () => {
    if (!data || !agentDraft || !agentProjectId) return;
    setSaving(true);
    setAgentError("");
    try {
      const created = await service.createRequirement({
        projectId: agentProjectId,
        title: agentDraft.title,
        summary: agentDraft.summary,
        priority: agentDraft.priority,
        rawRequirement: agentDraft.rawRequirement,
        acceptanceCriteria: agentDraft.acceptanceCriteria
      });
      setData({ ...data, requirements: [created, ...data.requirements] });
      setAgentOpen(false);
      resetAgentConversation();
      notify(`${created.code} 已由你确认创建并进入收件箱`);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const createRequirement = async () => {
    if (!data) return;
    setSaving(true);
    setFormError("");
    try {
      const created = await service.createRequirement({
        projectId: createProjectId, title, summary, priority: createPriority,
        rawRequirement, acceptanceCriteria: criteria.split("\n")
      });
      setData({ ...data, requirements: [created, ...data.requirements] });
      setCreateOpen(false);
      setTitle(""); setSummary(""); setRawRequirement(""); setCriteria(""); setCreatePriority("medium");
      notify(`${created.code} 已创建并进入收件箱`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return <main className="dash-page">
    <PageHeader
      eyebrow="BOARD / SEVEN LANES"
      title={project ? `${project.name} · 需求看板` : "需求看板"}
      description="七列流转；排队中 / 执行中只由真实 Run 自动更新，阻塞 / 失败 / 取消与列正交叠加。其它列请在需求详情页迁移。"
      actions={<>{spaceId && <button type="button" className="button secondary" onClick={() => go(`projects/${spaceId}`)}>← 返回项目详情</button>}<button type="button" className="button secondary" disabled={!daemonAvailable || projects.length === 0} title={projects.length === 0 ? "请先正式接入一个 active 项目" : undefined} onClick={openCreate}>手动创建</button><button type="button" className="button primary" disabled={!daemonAvailable || projects.length === 0} title={projects.length === 0 ? "请先正式接入一个 active 项目" : undefined} onClick={openAgentCreate}>和 AI 说需求</button></>}
    />
    <OfflineNotice />
    <div className="board-toolbar">
      <label className="space-search"><span className="sr-only">搜索需求</span><input type="search" placeholder="搜索编号、标题或摘要…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {!spaceId && <SelectControl ariaLabel="筛选项目" value={projectFilter} options={[{ value: "all", label: "全部项目" }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} onChange={setProjectFilter} />}
      <SelectControl ariaLabel="筛选优先级" value={priority} options={[{ value: "all", label: "全部优先级" }, { value: "high", label: "高优先级" }, { value: "medium", label: "中优先级" }, { value: "low", label: "低优先级" }]} onChange={(value) => setPriority(value as RequirementPriority | "all")} />
      <SelectControl ariaLabel="筛选异常状态" value={exception} options={[{ value: "all", label: "全部状态" }, { value: "normal", label: "无异常" }, { value: "blocked", label: "阻塞" }, { value: "failed", label: "失败" }, { value: "cancelled", label: "已取消" }]} onChange={(value) => setException(value as typeof exception)} />
    </div>
    {state.status === "loading" && <SkeletonBlock rows={4} label="正在加载需求看板" />}
    {state.status === "error" && <ErrorBlock message={state.error ?? "加载失败"} onRetry={reload} />}
    {state.status === "ready" && data && (filtered.length === 0
      ? <EmptyState title={projects.length === 0 ? "还没有可承接需求的项目" : "看板还没有需求"} action={projects.length === 0 ? <button type="button" className="button primary" onClick={() => go("projects")}>前往项目</button> : undefined}><p>{projects.length === 0 ? "只有正式接入且 active 的项目可以创建需求；被动 MCP 记录需要先升级。" : "需求会按列出现在这里；先由产品经理登记第一批需求。"}</p></EmptyState>
      : <div className="board-scroll" role="region" aria-label="需求看板（可横向滚动）" tabIndex={0}>
        <div className="board-grid">
          {REQUIREMENT_LANES.map((lane) => {
            const cards = grouped.get(lane.id) ?? [];
            return <section className="board-lane" key={lane.id} aria-label={`${lane.label}（${cards.length} 条）`}>
              <header className="board-lane-head"><h2>{lane.label}</h2><span className="board-lane-count">{cards.length}</span></header>
              <div className="board-lane-body">
                {cards.map((requirement) => <button type="button" key={requirement.id}
                  className={`board-card${requirement.exception ? ` board-card--${requirement.exception}` : ""}`}
                  onClick={() => go(`requirements/${requirement.id}`)}>
                  <div className="board-card-top"><code>{requirement.code}</code>{!spaceId && <span className="board-card-project" title={projectName(requirement.projectId)}>{projectName(requirement.projectId)}</span>}</div>
                  <strong>{requirement.title}</strong>
                  <p>{requirement.summary}</p>
                  <footer>
                    <span className={`board-priority board-priority--${requirement.priority}`}>{REQUIREMENT_PRIORITY_LABELS[requirement.priority]}</span>
                    <span>{requirementOwnerLabel(requirement)}</span>
                    <time>{formatTime(requirement.updatedAt)}</time>
                    {exceptionChip(requirement.exception)}
                  </footer>
                </button>)}
                {cards.length === 0 && <div className="board-lane-empty">暂无需求</div>}
              </div>
            </section>;
          })}
        </div>
      </div>)}
    <span className="sr-only" role="status">{state.status === "ready" && data ? `当前显示 ${filtered.length} 条需求` : ""}</span>

    {createOpen && <Modal title="创建需求" eyebrow="REQUIREMENT · INBOX" onClose={() => setCreateOpen(false)} wide>
      <form className="modal-body compact-form board-create-form" onSubmit={(event) => { event.preventDefault(); void createRequirement(); }}>
        <Field label="项目"><SelectControl ariaLabel="需求所属项目" value={createProjectId} options={projects.map((item) => ({ value: item.id, label: item.name }))} onChange={setCreateProjectId} /></Field>
        <Field label="优先级"><SelectControl ariaLabel="需求优先级" value={createPriority} options={[{ value: "high", label: "高" }, { value: "medium", label: "中" }, { value: "low", label: "低" }]} onChange={(value) => setCreatePriority(value as RequirementPriority)} /></Field>
        <Field label="标题"><input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
        <Field label="摘要"><input maxLength={160} value={summary} onChange={(event) => setSummary(event.target.value)} /></Field>
        <Field label="原始需求"><textarea required rows={5} value={rawRequirement} onChange={(event) => setRawRequirement(event.target.value)} /></Field>
        <Field label="验收标准" hint="每行一条"><textarea rows={4} value={criteria} onChange={(event) => setCriteria(event.target.value)} /></Field>
        {formError && <p className="dash-form-error" role="alert">{formError}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setCreateOpen(false)}>取消</button><button type="submit" className="button primary" disabled={saving || !createProjectId}>{saving ? "创建中…" : "创建并进入收件箱"}</button></div>
      </form>
    </Modal>}
    {agentOpen && <Modal title="和 AI 说需求" eyebrow="REQUIREMENT STEWARD · DRAFT ONLY" onClose={() => setAgentOpen(false)} wide className="board-ai-modal">
      <div className="board-ai-layout">
        <section className="board-ai-conversation" aria-label="需求管家对话">
          <header><div><span className="ai-content-badge">AI 生成内容</span><h3>先描述，再决定怎么推进</h3></div><p>文字、粘贴图片和飞书文档都会进入同一份会话证据；Agent 只整理草稿，不会替你创建需求。</p></header>
          <Field label="所属项目"><SelectControl ariaLabel="AI 需求所属项目" value={agentProjectId} options={projects.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => resetAgentConversation(value)} /></Field>
          <div className="board-ai-transcript" aria-live="polite">
            {!agentSession && <div className="board-ai-welcome"><strong>把现在知道的都说出来</strong><p>可以是零散描述、界面截图或飞书 docx / wiki 链接。信息不足时我会先追问；足够时才给出可编辑草稿。</p></div>}
            {agentSession?.messages.map((message) => <article className={`board-ai-message board-ai-message--${message.role}`} key={message.id}>
              <div><strong>{message.role === "user" ? "你" : message.role === "employee" ? "需求管家" : "系统"}</strong><time>{formatTime(message.at)}</time>{message.runId && <code>{message.runId}</code>}</div>
              <p>{message.content}</p>
              <ConversationMessageEvidence attachments={message.attachments} documents={message.documents} />
            </article>)}
          </div>
          {agentError && <p className="dash-form-error" role="alert">{agentError}</p>}
          <ConversationComposer
            ariaLabel="描述需求"
            placeholder="例如：购物车空态需要增加优惠推荐；这里是截图和飞书 PRD…"
            disabled={!daemonAvailable || !agentProjectId}
            submitLabel={agentSession ? "继续说明" : "交给需求管家"}
            sendingLabel="需求管家整理中…"
            onSend={talkToRequirementSteward}
          />
        </section>
        <section className="board-ai-draft" aria-label="待确认需求草稿">
          <header><div><span>DRAFT · HUMAN CONFIRMATION</span><h3>可编辑草稿</h3></div><p>右侧字段在你点击确认前不会写入看板。原始需求固定保留你的逐轮原话。</p></header>
          {!agentDraft ? <div className="board-ai-draft-empty"><strong>{agentPhase === "waiting" ? "需求管家正在判断…" : agentPhase === "clarify" ? "需要你补充一点" : "尚未形成草稿"}</strong><p>{agentPhase === "clarify" ? "请回答左侧对话中的问题；补充内容会进入同一个会话，旧草稿已失效。" : "继续在左侧说明；需求管家会按信息完整度选择追问或起草。"}</p></div> : <div className="board-ai-draft-fields">
            <Field label="优先级"><SelectControl ariaLabel="AI 草稿优先级" value={agentDraft.priority} options={[{ value: "high", label: "高" }, { value: "medium", label: "中" }, { value: "low", label: "低" }]} onChange={(value) => setAgentDraft({ ...agentDraft, priority: value as RequirementPriority })} /></Field>
            <Field label="标题"><input required maxLength={80} value={agentDraft.title} onChange={(event) => setAgentDraft({ ...agentDraft, title: event.target.value })} /></Field>
            <Field label="摘要"><input maxLength={160} value={agentDraft.summary} onChange={(event) => setAgentDraft({ ...agentDraft, summary: event.target.value })} /></Field>
            <Field label="原始需求" hint="保留你的逐轮原话，可在确认前补充"><textarea rows={6} value={agentDraft.rawRequirement} onChange={(event) => setAgentDraft({ ...agentDraft, rawRequirement: event.target.value })} /></Field>
            <Field label="验收标准" hint="每行一条"><textarea rows={6} value={agentDraft.acceptanceCriteria.join("\n")} onChange={(event) => setAgentDraft({ ...agentDraft, acceptanceCriteria: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} /></Field>
          </div>}
          <footer className="board-ai-confirm"><span>{agentDraft ? "只有下方确认按钮会调用 createRequirement。" : agentPhase === "clarify" ? "等待你的补充；当前对话不会写入看板。" : "等待需求草稿；当前对话不会写入看板。"}</span><button type="button" className="button primary" disabled={!agentDraft || saving || !agentDraft.title.trim() || !agentDraft.rawRequirement.trim()} onClick={() => void confirmAgentRequirement()}>{saving ? "创建中…" : "确认创建并进入收件箱"}</button></footer>
        </section>
      </div>
    </Modal>}
  </main>;
}
