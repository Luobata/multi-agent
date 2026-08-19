import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, writeBody } from "./api";
import {
  DossierSection,
  DEFAULT_EMPLOYEE_ACCENT,
  EmployeeAvatar,
  EmptyState,
  Field,
  Modal,
  RuntimeStatusChip,
  Stamp,
  SwitchControl,
  UtilityIcon,
  employeeRuntimeStatus,
  formatTime,
  scrollRecordIntoView,
  useDaemonAvailable
} from "./components";
import type { Bootstrap, Employee } from "./types";
import { type EmployeeSkillManagerMode } from "./employeeSkillPool";
import { providerRuntimeSummary } from "./providerRuntime";
import { KnowledgePerspectiveExplorer } from "./knowledgePerspective";
import { EmployeeKnowledgeGrantModal } from "./employeeKnowledgeGrant";
import { isProjectEmployee, isSystemEmployee, systemEmployeeScope } from "./employeeAccess";
import { EmployeeConfigurationDraftModal } from "./EmployeeConfigurationDraftModal";
import { bindingEnabled, bindingId } from "./employee/draft";
import { EmployeeEditor } from "./employee/editor";
import { ContextDrawer } from "./employee/contextDrawer";
import { DirectDesk } from "./employee/directDesk";
import { EmployeeSkillManager, KnowledgePreviewModal, RegistryModal } from "./employee/modals";

export interface PageProps {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
}

export function EmployeePage({ data, refresh, notify, focusedEmployeeId, onSelectEmployee }: PageProps & {
  focusedEmployeeId?: string;
  onSelectEmployee?: (employeeId: string) => void;
}) {
  const daemonAvailable = useDaemonAvailable();
  // Lightweight page clock so a short-lived "completed" chip actually fades
  // after its dwell while someone stays on this page. Cleaned up on unmount.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const visible = useMemo(() => data.employees.filter((employee) => {
    const runtime = providerRuntimeSummary(data.providers.find((provider) => provider.id === employee.providerId));
    return (showArchived || employee.status === "active") &&
      `${employee.id} ${employee.identity.displayName} ${employee.description} ${employee.providerId} ${runtime.model} ${runtime.launchCommand}`.toLowerCase().includes(search.toLowerCase());
  }), [data.employees, data.providers, search, showArchived]);
  const visibleExternal = visible.filter((employee) => !isSystemEmployee(employee));
  const visibleProject = visible.filter(isProjectEmployee);
  const visibleGlobal = visibleExternal.filter((employee) => !isProjectEmployee(employee));
  const visibleSystem = visible.filter(isSystemEmployee);
  const [selectedId, setSelectedId] = useState(() => focusedEmployeeId && data.employees.some((employee) => employee.id === focusedEmployeeId) ? focusedEmployeeId : visible[0]?.id ?? "");
  const selected = data.employees.find((employee) => employee.id === selectedId) ?? visible[0];
  const selectEmployee = (employeeId: string) => {
    setSelectedId(employeeId);
    onSelectEmployee?.(employeeId);
  };
  useEffect(() => {
    if (focusedEmployeeId && data.employees.some((employee) => employee.id === focusedEmployeeId)) setSelectedId(focusedEmployeeId);
  }, [focusedEmployeeId, data.employees]);
  const selectedSystemScope = selected ? systemEmployeeScope(selected) : undefined;
  const selectedProvider = selected ? data.providers.find((provider) => provider.id === selected.providerId) : undefined;
  const selectedRuntime = providerRuntimeSummary(selectedProvider);
  const selectedRuntimeState = selected ? employeeRuntimeStatus(data.activity.instances.filter((instance) => (
    instance.employeeId === selected.id && instance.employeeVersion === selected.version
  )), clock) : "idle";
  const sessions = selected ? data.sessions.filter((session) => session.employeeId === selected.id) : [];
  const [versions, setVersions] = useState<Employee[]>([]);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneDraft, setCloneDraft] = useState({ id: "", displayName: "" });
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [contextSessionId, setContextSessionId] = useState<string | undefined>();
  const [contextOpen, setContextOpen] = useState(false);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [skillManagerMode, setSkillManagerMode] = useState<EmployeeSkillManagerMode | null>(null);
  const [knowledgePreviewOpen, setKnowledgePreviewOpen] = useState(false);
  const [perspectiveOpen, setPerspectiveOpen] = useState(false);
  const [knowledgeGrantOpen, setKnowledgeGrantOpen] = useState(false);
  const [configurationDraftOpen, setConfigurationDraftOpen] = useState(false);
  const [togglingSkill, setTogglingSkill] = useState("");

  useEffect(() => {
    if (!selected) { setVersions([]); return; }
    api<{ versions: Employee[] }>(`/api/employees/${selected.id}`).then((detail) => setVersions(detail.versions)).catch(() => setVersions([selected]));
  }, [selected?.id, selected?.version]);

  const clone = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    try {
      const cloned = await api<Employee>(`/api/employees/${selected.id}/clone`, writeBody(cloneDraft));
      notify(`已复制为 ${cloned.id}；Session 与 Run 历史未复制`); setCloneOpen(false); selectEmployee(cloned.id); await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const archive = async () => {
    if (!selected) return;
    try { await api(`/api/employees/${selected.id}/archive`, writeBody({})); notify(`${selected.identity.displayName} 已归档，历史证据保留`); setArchiveOpen(false); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const toggleSkill = async (skillId: string, enabled: boolean) => {
    if (!selected) return;
    setTogglingSkill(skillId);
    try {
      const skills = selected.skills.map((binding) => bindingId(binding) === skillId ? {
        id: skillId,
        config: typeof binding === "string" ? {} : binding.config ?? {},
        enabled
      } : binding);
      const saved = await api<Employee>(`/api/employees/${selected.id}`, writeBody({ skills, skillVersions: selected.skillVersions }, "PATCH"));
      notify(`${data.skills.find((skill) => skill.id === skillId)?.displayName ?? skillId} 已${enabled ? "启用" : "停用"} · 员工 v${saved.version}`);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setTogglingSkill(""); }
  };

  return <div className="page-grid page-grid--employees">
    <aside className="record-list">
      <header className="list-header"><h1>员工档案</h1><button className="square-action" disabled={!daemonAvailable} onClick={() => setEditor("new")} aria-label="新建员工"><UtilityIcon name="add" /></button></header>
      <div className="list-tools"><input type="search" placeholder="检索姓名、ID 或职责…" value={search} onChange={(e) => setSearch(e.target.value)} /><label className="archive-toggle"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />含归档</label><button className="text-button" disabled={!daemonAvailable} onClick={() => setRegistryOpen(true)}>共享注册表</button></div>
      <div className="record-scroll">
        {[
          { id: "external", title: "外部可调用员工", note: "可通过直接交办、调用包或全局编排使用", employees: visibleGlobal },
          { id: "project", title: "项目员工", note: "真实可执行员工；只在固定项目范围内工作，可由通用模板派生", employees: visibleProject },
          { id: "system", title: "系统级员工", note: "仅供内部项目角色调用，可在此管理", employees: visibleSystem }
        ].map((group) => <section className={`employee-roster-group employee-roster-group--${group.id}`} key={group.id} aria-labelledby={`employee-group-${group.id}`}>
          <header><div><h2 id={`employee-group-${group.id}`}>{group.title}</h2><span>{group.employees.length}</span></div><p>{group.note}</p></header>
          <div>{group.employees.map((employee) => { const runtime = providerRuntimeSummary(data.providers.find((provider) => provider.id === employee.providerId)); const runtimeState = employeeRuntimeStatus(data.activity.instances.filter((instance) => instance.employeeId === employee.id && instance.employeeVersion === employee.version), clock); return <button className={`employee-card ${selected?.id === employee.id ? "selected" : ""}`} key={employee.id} onClick={() => selectEmployee(employee.id)}>
            <EmployeeAvatar displayName={employee.identity.displayName} presentation={employee.presentation} />
            <span className="employee-card-copy"><strong>{employee.identity.displayName}</strong><code>{employee.id} · v{employee.version}</code><small>{employee.description}</small><span className="employee-runtime"><span>模型 <code>{runtime.model}</code></span><span title={runtime.launchCommand}>启动 <code>{runtime.launchPreview}</code></span></span></span>
            <span className="employee-card-stamps">{group.id === "system" && <span className="system-level-badge">系统级</span>}<Stamp status={employee.status} />{runtimeState !== "idle" && <RuntimeStatusChip status={runtimeState} />}</span>
          </button>; })}</div>
          {group.employees.length === 0 && <div className="mini-empty">{search.trim() ? "本组没有符合条件的档案。" : group.id === "system" ? "暂无系统级员工。" : "暂无外部可调用员工。"}</div>}
        </section>)}
      </div>
      <footer className="list-footer"><span>{visibleGlobal.length} 位全局 · {visibleProject.length} 位项目 · {visibleSystem.length} 位系统员工</span><span>LOCAL</span></footer>
    </aside>

    <main className="detail-pane">
      {!selected ? <EmptyState title="建立第一位本地员工" action={<button className="button primary" disabled={!daemonAvailable} onClick={() => setEditor("new")}>建立档案</button>}>定义背景、职责、提示词、共享 Skill、Provider 与权限。普通员工可以对外调用；系统级员工只允许通过内部项目角色使用。</EmptyState> : <div className="dossier employee-dossier" style={{ "--dossier-accent": selected.presentation.accent ?? DEFAULT_EMPLOYEE_ACCENT } as React.CSSProperties}>
        <header className="dossier-cover">
          <div className="file-index"><span>{selectedSystemScope ? "SYSTEM PERSONNEL RECORD" : "LOCAL PERSONNEL RECORD"}</span><code>No. {selected.id.toUpperCase()}</code></div>
          <div className="dossier-title-row"><EmployeeAvatar className="large" displayName={selected.identity.displayName} presentation={selected.presentation} /><div><h2>{selected.identity.displayName}</h2><p>{selected.description}</p></div><div className="dossier-stamps">{selectedSystemScope && <span className="system-level-badge">系统级</span>}<Stamp status={selected.status} />{selectedRuntimeState !== "idle" && <RuntimeStatusChip status={selectedRuntimeState} />}</div></div>
          <div className="dossier-actions">{!selectedSystemScope && <button className="button primary" disabled={selected.status === "archived"} onClick={() => scrollRecordIntoView("direct-desk")}>直接交办</button>}<button className="button configuration-draft-entry" disabled={selected.status === "archived"} onClick={() => setConfigurationDraftOpen(true)}>AI 对话起草</button>{selectedRuntimeState === "failed" && <button className="button secondary" onClick={() => { window.location.hash = "runs"; }}>查看故障运行证据</button>}<button className="button secondary" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setKnowledgePreviewOpen(true)}>知识试跑</button><button className="button secondary" disabled={!daemonAvailable} onClick={() => setPerspectiveOpen(true)}>知识视角</button><button className="button secondary" disabled={!daemonAvailable} onClick={() => setEditor("edit")}>高级表单</button><button className="button secondary" disabled={!daemonAvailable} onClick={() => { setCloneDraft({ id: `${selected.id}-copy`, displayName: `${selected.identity.displayName} 副本` }); setCloneOpen(true); }}>复制</button><button className="button danger" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setArchiveOpen(true)}>归档</button></div>
        </header>

        {selectedSystemScope && <aside className="system-employee-boundary" aria-label="系统级员工调用边界"><span>SYSTEM / INTERNAL ONLY</span><div><strong>仅供内部管理与项目角色调用</strong><p>不会出现在直接交办、调用包或全局 Workflow 的可调用员工中。</p></div><dl><dt>内部项目</dt><dd><code>{selectedSystemScope.projectId}</code></dd><dt>固定角色</dt><dd><code>{selectedSystemScope.roleId ?? "由项目绑定约束"}</code></dd></dl></aside>}

        <DossierSection number="01" title="身份"><div className="employee-provenance"><span>{selected.scope.kind === "project" ? "PROJECT EMPLOYEE" : "GLOBAL EMPLOYEE"}</span><strong>{selected.scope.kind === "project" ? `${selected.scope.projectId} · 固定项目 v${selected.scope.projectVersion}` : "全局范围"}</strong><small>{selected.template ? `派生自 ${selected.template.id} · 固定模板 v${selected.template.version}` : "独立建立的员工档案"}</small></div><div className="employee-capability-row"><b>结构化能力</b>{selected.capabilities.length ? selected.capabilities.map((capability) => <code className="paper-tag" key={capability}>{capability}</code>) : <span className="muted">尚未声明；领队不会按名称猜测能力。</span>}</div><div className="fact-grid"><div><span>背景</span><p>{selected.identity.background}</p></div><div><span>职责</span><ul>{selected.identity.responsibilities.map((item) => <li key={item}>{item}</li>)}</ul></div><div><span>目标</span><ul>{selected.identity.goals?.map((item) => <li key={item}>{item}</li>) ?? <li>未声明</li>}</ul></div><div><span>约束</span><ul>{selected.identity.constraints?.map((item) => <li key={item}>{item}</li>) ?? <li>未声明</li>}</ul></div></div></DossierSection>
        <DossierSection number="02" title="提示词"><div className="prompt-preview"><div><span>系统指令</span><p>{selected.systemPrompt}</p></div><div><span>请求指令</span><p>{selected.requestPrompt}</p></div></div></DossierSection>
        <DossierSection number="03" title="技能" action={<div className="skill-section-actions">
          <button type="button" className="text-button icon-text-button" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setSkillManagerMode("add")}><UtilityIcon name="add" />从技能池添加</button>
          <button type="button" className="text-button" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setSkillManagerMode("manage")}>管理绑定</button>
        </div>}><div className="employee-skill-ledger">{selected.skills.length ? selected.skills.map((binding) => { const id = bindingId(binding); const skill = data.skills.find((candidate) => candidate.id === id); const enabled = bindingEnabled(binding); return <article className={!enabled ? "is-disabled" : ""} key={id}><div className="skill-book" aria-hidden="true">S</div><div><strong>{skill?.displayName ?? id}</strong><code>{id} · 固定 v{selected.skillVersions[id] ?? "—"}</code><small>{skill?.description ?? "共享能力定义不可用"}</small></div><Stamp status={enabled ? "active" : "archived"} label={enabled ? "已启用" : "已停用"} /><label className="compact-switch"><span className="sr-only">{enabled ? "停用" : "启用"} {skill?.displayName ?? id}</span><SwitchControl checked={enabled} disabled={!daemonAvailable || Boolean(togglingSkill) || selected.status === "archived"} ariaLabel={`${enabled ? "停用" : "启用"} ${skill?.displayName ?? id}`} onChange={(nextEnabled) => void toggleSkill(id, nextEnabled)} /></label></article>; }) : <div className="empty-inline"><span>尚未绑定共享 Skill</span><button type="button" className="text-button" disabled={!daemonAvailable} onClick={() => setSkillManagerMode("add")}>从技能池添加</button></div>}</div></DossierSection>
        <DossierSection number="04" title="知识授权" action={<div className="skill-section-actions"><button type="button" className="text-button" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setKnowledgeGrantOpen(true)}>调整授权</button><button type="button" className="text-button" disabled={!daemonAvailable} onClick={() => setPerspectiveOpen(true)}>查看知识视角</button></div>}><div className="employee-knowledge-profiles">{(selected.knowledgeProfileIds ?? []).length ? (selected.knowledgeProfileIds ?? []).map((profileId) => { const profile = (data.knowledgeProfiles ?? []).find((candidate) => candidate.id === profileId); return <article key={profileId}><span aria-hidden="true">知</span><div><strong>{profile?.displayName ?? profileId}</strong><code>{profileId} · 当前 v{profile?.version ?? "—"}</code><small>{profile?.description ?? "Profile 已不可用；后续调用会在 Knowledge Plan 中排除。"}</small></div><Stamp status={profile?.status ?? "blocked"} /></article>; }) : <div className="empty-inline"><span>尚未授权知识 Profile；员工仍可正常工作，但不会预加载知识证据。</span><button type="button" className="text-button" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setKnowledgeGrantOpen(true)}>生成授权提案</button></div>}</div></DossierSection>
        <div className="dossier-columns"><DossierSection number="05" title="Provider"><dl className="ledger"><dt>实例</dt><dd><code>{selected.providerId}</code></dd><dt>模型</dt><dd className="provider-model"><code>{selectedRuntime.model}</code></dd><dt>Adapter</dt><dd>{selectedRuntime.adapter}</dd><dt>最大尝试</dt><dd>{selected.maxAttempts}</dd></dl><div className="provider-launch"><span>启动指令模板</span><pre>{selectedRuntime.launchCommand}</pre><small>当前 Provider 配置中的 argv；模板变量会在运行时渲染，敏感参数仅显示为 ***。</small></div></DossierSection><DossierSection number="06" title="权限"><dl className="ledger"><dt>写入</dt><dd>{selected.permissions.write}</dd><dt>声明工具</dt><dd>{selected.permissions.tools?.join(", ") || "无"}</dd><dt>历史窗口</dt><dd>{selected.contextPolicy.historyLimit} 条</dd><dt>Verdict</dt><dd>{selected.verdict ? <code>{selected.verdict.path}: {selected.verdict.pass.join("/")} | {selected.verdict.block.join("/")}</code> : "未配置"}</dd></dl></DossierSection></div>
        <DossierSection number="07" title="外观"><dl className="ledger horizontal"><dt>强调色</dt><dd><span className="color-chip" style={{ background: selected.presentation.accent ?? DEFAULT_EMPLOYEE_ACCENT }} />{selected.presentation.accent ?? "默认朱红"}</dd><dt>首字母</dt><dd>{selected.presentation.initials || selected.identity.displayName.slice(0, 2)}</dd><dt>头像</dt><dd>{selected.presentation.avatarUrl ? <code className="avatar-source">{selected.presentation.avatarUrl}</code> : "未配置，显示首字母"}</dd></dl></DossierSection>
        <DossierSection number="08" title="版本"><div className="version-strip">{versions.map((version) => <div key={version.version} className={version.version === selected.version ? "current" : ""}><code>v{version.version}</code><span>{version.status === "archived" ? "归档" : version.version === selected.version ? "当前" : "历史"}</span><time>{formatTime(version.updatedAt)}</time></div>)}</div></DossierSection>
        {!selectedSystemScope && <div id="direct-desk"><DirectDesk employee={selected} sessions={sessions} refresh={refresh} notify={notify} onContext={(sessionId) => { setContextSessionId(sessionId); setContextOpen(true); }} /></div>}
      </div>}
    </main>

    {editor && <EmployeeEditor employee={editor === "edit" ? selected : undefined} data={data} notify={notify} onClose={() => setEditor(null)} onSaved={async (saved) => { setEditor(null); selectEmployee(saved.id); await refresh(); }} />}
    {registryOpen && <RegistryModal data={data} onClose={() => setRegistryOpen(false)} refresh={refresh} notify={notify} />}
    {skillManagerMode && selected && <EmployeeSkillManager employee={selected} skills={data.skills} mode={skillManagerMode} notify={notify} onClose={() => setSkillManagerMode(null)} onSaved={async () => { setSkillManagerMode(null); await refresh(); }} />}
    {knowledgePreviewOpen && selected && <KnowledgePreviewModal employee={selected} notify={notify} onClose={() => setKnowledgePreviewOpen(false)} />}
    {perspectiveOpen && selected && <Modal title={`知识视角 · ${selected.identity.displayName}`} eyebrow={`${selected.id} v${selected.version} · ELIGIBLE → ACTIVATED → SELECTED`} onClose={() => setPerspectiveOpen(false)} wide>
      <div className="modal-body perspective-modal-body"><KnowledgePerspectiveExplorer employee={selected} bindings={data.projectBindings} notify={notify} /></div>
    </Modal>}
    {knowledgeGrantOpen && selected && <EmployeeKnowledgeGrantModal employee={selected} knowledgeProfiles={data.knowledgeProfiles ?? []} notify={notify} onClose={() => setKnowledgeGrantOpen(false)} onCreated={refresh} />}
    {configurationDraftOpen && selected && <EmployeeConfigurationDraftModal employee={selected} data={data} refresh={refresh} notify={notify} onClose={() => setConfigurationDraftOpen(false)} />}
    {cloneOpen && selected && <Modal title="复制员工档案" eyebrow={`来源 ${selected.id} · v${selected.version}`} onClose={() => setCloneOpen(false)}><form className="modal-body compact-form" onSubmit={clone}><p className="notice-copy">复制身份、提示词、Skill、Provider 与权限。不会复制 Session、密钥或 Run 历史。</p><Field label="新员工 ID"><input required disabled={!daemonAvailable} pattern="[a-z][a-z0-9-]*" value={cloneDraft.id} onChange={(e) => setCloneDraft({ ...cloneDraft, id: e.target.value })} /></Field><Field label="显示名"><input required disabled={!daemonAvailable} value={cloneDraft.displayName} onChange={(e) => setCloneDraft({ ...cloneDraft, displayName: e.target.value })} /></Field><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setCloneOpen(false)}>取消</button><button className="button primary" disabled={!daemonAvailable}>建立副本</button></div></form></Modal>}
    {archiveOpen && selected && <Modal title="归档员工" eyebrow={`${selected.id} · 保留历史`} onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>只归档，不物理删除。</b><p>归档后不能接受新调用，也不能加入新 Workflow；已有 Session、版本与 Run 证据继续保留。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveOpen(false)}>保留在册</button><button className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive()}>确认归档</button></div></div></Modal>}
    {contextOpen && selected && <><div className="drawer-scrim" onClick={() => setContextOpen(false)} /><ContextDrawer employee={selected} sessionId={contextSessionId} onClose={() => setContextOpen(false)} /></>}
  </div>;
}
