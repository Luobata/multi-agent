/** 需求看板：七列 + 阻塞/失败/取消三异常态（与列正交）。第一阶段无拖拽，列迁移走详情页。 */
import { useMemo, useState } from "react";
import { EmptyState, Field, Modal, RuntimeStatusChip, SelectControl, Stamp, formatTime, useDaemonAvailable } from "./components";
import { dashboardService, type DashboardService } from "./dashboard/service";
import type { ManagedProject, Requirement, RequirementException, RequirementPriority, SpaceNode } from "./dashboard/types";
import { REQUIREMENT_EXCEPTION_LABELS, REQUIREMENT_LANES, REQUIREMENT_PRIORITY_LABELS } from "./dashboard/types";
import { ErrorBlock, OfflineNotice, PageHeader, SkeletonBlock, useServiceData } from "./dashboard/view";

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
      description="七列流转；阻塞 / 失败 / 取消与列正交叠加。第一阶段不支持拖拽，列迁移请在需求详情页选择目标列。"
      actions={<>{spaceId && <button type="button" className="button secondary" onClick={() => go(`projects/${spaceId}`)}>← 返回项目详情</button>}<button type="button" className="button primary" disabled={!daemonAvailable || projects.length === 0} title={projects.length === 0 ? "请先正式接入一个 active 项目" : undefined} onClick={openCreate}>创建需求</button></>}
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
                    <span>{requirement.owner}</span>
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
  </main>;
}
