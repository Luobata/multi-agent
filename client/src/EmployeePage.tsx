import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, writeBody } from "./api";
import {
  DossierSection,
  DEFAULT_EMPLOYEE_ACCENT,
  defaultEmployeeAccentInput,
  EmployeeAvatar,
  EmptyState,
  Field,
  Modal,
  ReadonlyEvidence,
  RuntimeStatusChip,
  SelectControl,
  Stamp,
  UtilityIcon,
  employeeRuntimeStatus,
  formatTime,
  scrollRecordIntoView,
  useDaemonAvailable
} from "./components";
import type {
  Bootstrap,
  ContextView,
  Employee,
  JsonObject,
  KnowledgeRuntimeResult,
  ProviderEntry,
  Session,
  Skill,
  SkillBinding
} from "./types";
import {
  countAddedSkillBindings,
  filterEmployeeSkillChoices,
  type EmployeeSkillManagerMode
} from "./employeeSkillPool";
import { providerRuntimeSummary } from "./providerRuntime";
import { KnowledgePerspectiveExplorer } from "./knowledgePerspective";
import { EmployeeKnowledgeGrantModal } from "./employeeKnowledgeGrant";

interface PageProps {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
}

interface EmployeeDraft {
  id: string;
  displayName: string;
  background: string;
  responsibilities: string;
  goals: string;
  constraints: string;
  metadata: string;
  description: string;
  systemPrompt: string;
  requestPrompt: string;
  providerId: string;
  selectedSkills: string[];
  skillConfigs: Record<string, string>;
  skillEnabled: Record<string, boolean>;
  write: "none" | "artifacts-only" | "project";
  tools: string;
  outputSchema: string;
  verdictPath: string;
  verdictPass: string;
  verdictBlock: string;
  maxAttempts: number;
  historyLimit: number;
  accent: string;
  initials: string;
  avatarUrl: string;
}

const defaultOutputSchema = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: { message: { type: "string" } }
}, null, 2);

function bindingId(binding: SkillBinding): string {
  return typeof binding === "string" ? binding : binding.id;
}

function bindingEnabled(binding: SkillBinding): boolean {
  return typeof binding === "string" || binding.enabled !== false;
}

function draftFrom(employee?: Employee): EmployeeDraft {
  return {
    id: employee?.id ?? "",
    displayName: employee?.identity.displayName ?? "",
    background: employee?.identity.background ?? "",
    responsibilities: employee?.identity.responsibilities.join("\n") ?? "",
    goals: employee?.identity.goals?.join("\n") ?? "",
    constraints: employee?.identity.constraints?.join("\n") ?? "",
    metadata: JSON.stringify(employee?.identity.metadata ?? {}, null, 2),
    description: employee?.description ?? "",
    systemPrompt: employee?.systemPrompt ?? "保持证据边界，明确说明不确定性，并严格履行被分配的职责。",
    requestPrompt: employee?.requestPrompt ?? "完成当前交办事项，并按约定的结构化输出返回结果。",
    providerId: employee?.providerId ?? "mock",
    selectedSkills: employee?.skills.map(bindingId) ?? [],
    skillConfigs: Object.fromEntries((employee?.skills ?? []).map((binding) => [
      bindingId(binding),
      JSON.stringify(typeof binding === "string" ? {} : binding.config ?? {}, null, 2)
    ])),
    skillEnabled: Object.fromEntries((employee?.skills ?? []).map((binding) => [bindingId(binding), bindingEnabled(binding)])),
    write: employee?.permissions.write ?? "none",
    tools: employee?.permissions.tools?.join(", ") ?? "",
    outputSchema: JSON.stringify(employee?.outputSchema ?? JSON.parse(defaultOutputSchema), null, 2),
    verdictPath: employee?.verdict?.path ?? "",
    verdictPass: employee?.verdict?.pass.map(String).join(", ") ?? "",
    verdictBlock: employee?.verdict?.block.map(String).join(", ") ?? "",
    maxAttempts: employee?.maxAttempts ?? 1,
    historyLimit: employee?.contextPolicy.historyLimit ?? 20,
    accent: employee?.presentation.accent ?? defaultEmployeeAccentInput(),
    initials: employee?.presentation.initials ?? "",
    avatarUrl: employee?.presentation.avatarUrl ?? ""
  };
}

function nonemptyLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function parseObject(value: string, label: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 对象`);
  return parsed as JsonObject;
}

function payloadFrom(draft: EmployeeDraft) {
  const skills = draft.selectedSkills.map((id) => ({
    id,
    config: parseObject(draft.skillConfigs[id] || "{}", `Skill ${id} 配置`),
    enabled: draft.skillEnabled[id] !== false
  }));
  return {
    id: draft.id.trim(),
    identity: {
      displayName: draft.displayName.trim(),
      background: draft.background.trim(),
      responsibilities: nonemptyLines(draft.responsibilities),
      goals: nonemptyLines(draft.goals),
      constraints: nonemptyLines(draft.constraints),
      metadata: parseObject(draft.metadata || "{}", "Identity metadata")
    },
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    requestPrompt: draft.requestPrompt.trim(),
    skills,
    providerId: draft.providerId,
    outputSchema: parseObject(draft.outputSchema, "Output Schema"),
    verdict: draft.verdictPath.trim() ? {
      path: draft.verdictPath.trim(),
      pass: draft.verdictPass.split(",").map((value) => value.trim()).filter(Boolean),
      block: draft.verdictBlock.split(",").map((value) => value.trim()).filter(Boolean)
    } : null,
    maxAttempts: Number(draft.maxAttempts),
    permissions: { write: draft.write, tools: draft.tools.split(",").map((value) => value.trim()).filter(Boolean) },
    contextPolicy: { historyLimit: Number(draft.historyLimit) },
    presentation: {
      accent: draft.accent || undefined,
      initials: draft.initials.trim() || undefined,
      avatarUrl: draft.avatarUrl.trim() || undefined
    }
  };
}

function EmployeeEditor({ employee, providers, skills, onClose, onSaved, notify }: {
  employee?: Employee;
  providers: ProviderEntry[];
  skills: Skill[];
  onClose: () => void;
  onSaved: (employee: Employee) => void;
  notify: PageProps["notify"];
}) {
  const [draft, setDraft] = useState(() => draftFrom(employee));
  const [saving, setSaving] = useState(false);
  const daemonAvailable = useDaemonAvailable();
  const patch = <K extends keyof EmployeeDraft>(key: K, value: EmployeeDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = payloadFrom(draft);
      const saved = employee
        ? await api<Employee>(`/api/employees/${employee.id}`, writeBody(payload, "PATCH"))
        : await api<Employee>("/api/employees", writeBody(payload));
      notify(employee ? `已另存为 v${saved.version}` : `已建立员工档案 ${saved.id}`);
      onSaved(saved);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };

  return <Modal title={employee ? `修订 ${employee.identity.displayName}` : "建立员工档案"} onClose={onClose} wide>
    <form className="editor-form" onSubmit={submit}>
      <fieldset className="daemon-write-surface" disabled={!daemonAvailable}>
      <DossierSection number="01" title="身份">
        <div className="form-grid two">
          <Field label="员工 ID" hint="小写字母开头，只能使用字母、数字和连字符。">
            <input required pattern="[a-z][a-z0-9-]*" value={draft.id} disabled={Boolean(employee)} onChange={(e) => patch("id", e.target.value)} />
          </Field>
          <Field label="显示名"><input required value={draft.displayName} onChange={(e) => patch("displayName", e.target.value)} /></Field>
        </div>
        <Field label="背景"><textarea required rows={3} value={draft.background} onChange={(e) => patch("background", e.target.value)} /></Field>
        <Field label="职责" hint="每行一项，至少一项。"><textarea required rows={3} value={draft.responsibilities} onChange={(e) => patch("responsibilities", e.target.value)} /></Field>
        <div className="form-grid two">
          <Field label="目标" hint="每行一项"><textarea rows={3} value={draft.goals} onChange={(e) => patch("goals", e.target.value)} /></Field>
          <Field label="约束" hint="每行一项"><textarea rows={3} value={draft.constraints} onChange={(e) => patch("constraints", e.target.value)} /></Field>
        </div>
        <Field label="Identity metadata (JSON)"><textarea className="mono" rows={4} value={draft.metadata} onChange={(e) => patch("metadata", e.target.value)} /></Field>
        <Field label="档案摘要"><input required value={draft.description} onChange={(e) => patch("description", e.target.value)} /></Field>
      </DossierSection>

      <DossierSection number="02" title="提示词">
        <Field label="角色系统指令"><textarea rows={6} required value={draft.systemPrompt} onChange={(e) => patch("systemPrompt", e.target.value)} /></Field>
        <Field label="单次请求指令"><textarea rows={4} required value={draft.requestPrompt} onChange={(e) => patch("requestPrompt", e.target.value)} /></Field>
      </DossierSection>

      <DossierSection number="03" title="共享技能">
        {skills.length === 0 ? <p className="muted">共享 Skill 注册表为空。可先关闭本页并打开“注册表”新建 Skill。</p> : <div className="skill-selector">
          {skills.filter((skill) => skill.status === "active" || draft.selectedSkills.includes(skill.id)).map((skill) => {
            const selected = draft.selectedSkills.includes(skill.id);
            return <div className={`skill-option ${selected ? "selected" : ""}`} key={skill.id}>
              <label><input type="checkbox" checked={selected} onChange={(event) => {
                patch("selectedSkills", event.target.checked
                  ? [...draft.selectedSkills, skill.id]
                  : draft.selectedSkills.filter((id) => id !== skill.id));
                if (event.target.checked && !draft.skillConfigs[skill.id]) {
                  patch("skillConfigs", { ...draft.skillConfigs, [skill.id]: "{}" });
                  patch("skillEnabled", { ...draft.skillEnabled, [skill.id]: true });
                }
              }} /><span><strong>{skill.displayName}</strong><small>{skill.id} · v{skill.version}</small></span></label>
              {selected && <><label className="binding-enable"><input type="checkbox" checked={draft.skillEnabled[skill.id] !== false} onChange={(event) => patch("skillEnabled", { ...draft.skillEnabled, [skill.id]: event.target.checked })} /><span>在本员工上启用</span></label><Field label="绑定配置 (JSON)"><textarea className="mono" rows={3} value={draft.skillConfigs[skill.id] ?? "{}"} onChange={(e) => patch("skillConfigs", { ...draft.skillConfigs, [skill.id]: e.target.value })} /></Field></>}
            </div>;
          })}
        </div>}
      </DossierSection>

      <DossierSection number="04" title="知识授权">
        <div className="project-connect-note">
          <strong>知识授权与员工档案分开管理。</strong>
          <p>{employee
            ? "本次档案修订不会改变知识 Profile。请保存后在员工详情使用“调整授权”，生成待人工审批的变更提案。"
            : "先建立员工档案，再从员工详情生成知识授权提案；新员工不会因为建立档案而自动获得知识。"}</p>
        </div>
        {employee && <p className="muted">当前知识 Profile：{(employee.knowledgeProfileIds ?? []).length ? (employee.knowledgeProfileIds ?? []).join("、") : "无"}</p>}
      </DossierSection>

      <DossierSection number="05" title="Provider">
        <div className="form-grid two">
          <Field label="Provider 实例"><SelectControl ariaLabel="Provider 实例" value={draft.providerId} options={providers.map((provider) => { const runtime = providerRuntimeSummary(provider); return { value: provider.id, label: provider.id, description: `${runtime.model} · ${runtime.adapter}` }; })} onChange={(providerId) => patch("providerId", providerId)} /></Field>
          <Field label="技术失败重试次数"><input type="number" min={1} max={10} value={draft.maxAttempts} onChange={(e) => patch("maxAttempts", Number(e.target.value))} /></Field>
        </div>
      </DossierSection>

      <DossierSection number="06" title="权限与上下文">
        <div className="form-grid two">
          <Field label="写入策略"><SelectControl ariaLabel="员工写入策略" value={draft.write} options={[{ value: "none", label: "none", description: "不写入" }, { value: "artifacts-only", label: "artifacts-only", description: "仅写入证据目录" }, { value: "project", label: "project", description: "允许写入项目目录" }]} onChange={(write) => patch("write", write as EmployeeDraft["write"])} /></Field>
          <Field label="Session 历史条数"><input type="number" min={0} max={100} value={draft.historyLimit} onChange={(e) => patch("historyLimit", Number(e.target.value))} /></Field>
        </div>
        <Field label="额外工具" hint="逗号分隔；这是声明，真正限制由 Provider/sandbox 执行。"><input value={draft.tools} onChange={(e) => patch("tools", e.target.value)} /></Field>
        <Field label="输出 JSON Schema"><textarea className="mono" rows={9} required value={draft.outputSchema} onChange={(e) => patch("outputSchema", e.target.value)} /></Field>
        <div className="form-grid three"><Field label="Verdict JSON path" hint="可选，如 verdict"><input value={draft.verdictPath} onChange={(e) => patch("verdictPath", e.target.value)} /></Field><Field label="Pass 值" hint="逗号分隔"><input value={draft.verdictPass} onChange={(e) => patch("verdictPass", e.target.value)} /></Field><Field label="Block 值" hint="逗号分隔"><input value={draft.verdictBlock} onChange={(e) => patch("verdictBlock", e.target.value)} /></Field></div>
      </DossierSection>

      <DossierSection number="07" title="外观">
        <div className="form-grid three">
          <Field label="档案强调色"><input type="color" value={draft.accent} onChange={(e) => patch("accent", e.target.value)} /></Field>
          <Field label="首字母"><input maxLength={2} value={draft.initials} onChange={(e) => patch("initials", e.target.value)} /></Field>
          <div className="avatar-field-row">
            <EmployeeAvatar className="large" displayName={draft.displayName || draft.id || "新员工"} presentation={{ accent: draft.accent, initials: draft.initials, avatarUrl: draft.avatarUrl }} />
            <Field label="头像地址" hint="支持 /avatars/... 项目资源或 https:// 图片；加载失败自动回退首字母。"><input type="text" placeholder="/avatars/employee.png" value={draft.avatarUrl} onChange={(e) => patch("avatarUrl", e.target.value)} /></Field>
          </div>
        </div>
      </DossierSection>

      {employee && <div className="version-warning"><Stamp status="blocked" label="版本固定" />已有会话仍固定使用旧版本；保存后请新建会话以使用 v{employee.version + 1}。</div>}
      </fieldset>
      <div className="editor-savebar"><button type="button" className="button secondary" onClick={onClose}>放弃修改</button><button className="button primary" disabled={saving || !daemonAvailable}>{saving ? "保存中…" : employee ? `另存为 v${employee.version + 1}` : "建立档案"}</button></div>
    </form>
  </Modal>;
}

function ContextDrawer({ employee, sessionId, onClose }: {
  employee: Employee;
  sessionId?: string;
  onClose: () => void;
}) {
  const [context, setContext] = useState<ContextView>();
  const [error, setError] = useState("");
  const [copiedAll, setCopiedAll] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerRef.current?.querySelector<HTMLButtonElement>(".icon-button")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab") {
        const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), summary, input:not([disabled]), textarea:not([disabled]), [role='combobox']:not([disabled]), select:not([disabled])") ?? []).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, []);
  useEffect(() => {
    api<ContextView>(`/api/employees/${employee.id}/context${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`)
      .then(setContext).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [employee.id, sessionId]);

  const copyAll = async () => {
    if (!context) return;
    await navigator.clipboard.writeText(JSON.stringify(context, null, 2));
    setCopiedAll(true);
    window.setTimeout(() => setCopiedAll(false), 2500);
  };

  return <aside ref={drawerRef} className="context-drawer" role="dialog" aria-modal="true" aria-label="上下文检查器">
    <header className="drawer-header"><div><p className="record-meta">{employee.id} · 上下文证据</p><h2>上下文检查器</h2><p className="mono muted">v{context?.employee.version ?? employee.version}</p></div><button className="icon-button" onClick={onClose} aria-label="关闭上下文检查器"><UtilityIcon name="close" /></button></header>
    {error && <div className="inline-error">{error}</div>}
    {!context ? <div className="drawer-loading">正在调取上下文证据…</div> : <div className="context-layers">
      <details><summary><b>01</b><span>身份与角色指令</span><UtilityIcon name="toggle" /></summary><ReadonlyEvidence label="Identity" value={JSON.stringify(context.layers.identity, null, 2)} mono /><ReadonlyEvidence label="System instructions" value={context.layers.systemPrompt} /></details>
      <details><summary><b>02</b><span>Skill 指令、配置与工具</span><UtilityIcon name="toggle" /></summary><ReadonlyEvidence label="Resolved skills" value={JSON.stringify(context.layers.skills, null, 2)} mono /></details>
      <details><summary><b>03</b><span>Knowledge Plan 与证据</span><UtilityIcon name="toggle" /></summary>{context.layers.knowledge ? <><ReadonlyEvidence label="Knowledge Plan" value={JSON.stringify(context.layers.knowledge.plan, null, 2)} mono /><ReadonlyEvidence label="Retrieved evidence" value={JSON.stringify(context.layers.knowledge.evidence, null, 2)} mono /></> : <p className="muted drawer-note">本次运行没有知识证据；可能尚未分配 Profile，或没有内容达到相关度阈值。</p>}</details>
      <details><summary><b>04</b><span>Session 历史</span><UtilityIcon name="toggle" /></summary><ReadonlyEvidence label="Pinned history" value={JSON.stringify(context.layers.history, null, 2)} mono /></details>
      <details><summary><b>05</b><span>当前请求与依赖结果</span><UtilityIcon name="toggle" /></summary><ReadonlyEvidence label="Current request" value={context.layers.currentRequest ?? "尚无请求"} /><ReadonlyEvidence label="Graph dependencies" value={Object.keys(context.layers.dependencyResults).length ? JSON.stringify(context.layers.dependencyResults, null, 2) : "直接调用编译为单节点 Graph；没有上游依赖。"} mono /></details>
      <details open><summary><b>06</b><span>Effective Prompt</span><UtilityIcon name="toggle" /></summary>{context.effectivePrompt ? <><ReadonlyEvidence label="Combined prompt" value={context.effectivePrompt.combined} /><ReadonlyEvidence label="System prompt" value={context.effectivePrompt.system} /><ReadonlyEvidence label="Request prompt" value={context.effectivePrompt.request} /></> : <p className="muted drawer-note">尚无有效提示词证据；完成一次调用后生成。</p>}</details>
      <details><summary><b>07</b><span>Run 元数据</span><UtilityIcon name="toggle" /></summary><ReadonlyEvidence label="Run evidence" value={context.layers.runMetadata ? JSON.stringify(context.layers.runMetadata, null, 2) : "尚无 Run"} mono /></details>
    </div>}
    <footer className="drawer-footer"><button className="button secondary" disabled={!context} onClick={() => void copyAll()} aria-live="polite">{copiedAll ? "完整上下文已复制" : "复制完整上下文"}</button></footer>
  </aside>;
}

function DirectDesk({ employee, sessions, refresh, notify, onContext }: {
  employee: Employee;
  sessions: Session[];
  refresh: () => Promise<void>;
  notify: PageProps["notify"];
  onContext: (sessionId?: string) => void;
}) {
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const daemonAvailable = useDaemonAvailable();
  useEffect(() => {
    setSessionId(sessions[0]?.id ?? "");
  }, [employee.id]);
  useEffect(() => {
    if (sessionId && !sessions.some((session) => session.id === sessionId)) setSessionId(sessions[0]?.id ?? "");
  }, [sessions, sessionId]);
  const session = sessions.find((candidate) => candidate.id === sessionId);

  const invoke = async (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    setRunning(true);
    try {
      const result = await api<{ session: Session; runId: string; status: string }>(`/api/employees/${employee.id}/invoke`, {
        ...writeBody({ message, sessionId: sessionId || undefined }),
        headers: { "x-multi-agent-source": "workbench", "x-multi-agent-source-label": "直接交办调试台" }
      });
      setSessionId(result.session.id);
      setMessage("");
      notify(result.status === "blocked" ? "请求完成，员工给出业务阻塞结论" : `工单已完成 · ${result.runId}`);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setRunning(false);
    }
  };

  return <div className="work-order">
    <header className="work-order-header"><div><p className="record-meta">{employee.id} · v{employee.version}</p><h3>直接交办</h3></div><div className="session-controls"><SelectControl ariaLabel="选择会话" value={sessionId} options={[{ value: "", label: "新会话", description: `固定员工 v${employee.version}` }, ...sessions.map((item) => ({ value: item.id, label: item.title, description: `员工 v${item.employeeVersion} · ${formatTime(item.updatedAt)}` }))]} onChange={setSessionId} /><button type="button" className="button ghost" onClick={() => { setSessionId(""); notify(`下一次请求将新建 v${employee.version} 会话`); }}>新会话</button><button type="button" className="button ghost" onClick={() => onContext(sessionId || undefined)}>检查上下文</button></div></header>
    <div className="transcript" aria-live="polite">
      {!session?.messages.length ? <div className="transcript-empty"><span>工单尚未填写</span><p>提交第一项请求后，原始请求、处理结果与 Run 编号会留存在这里。</p></div> : session.messages.map((item) => <article className={`transcript-row transcript-row--${item.role}`} key={item.id}>
        <div className="transcript-meta"><span>{item.role === "user" ? "请求" : item.role === "employee" ? "处理结果" : "系统记录"}</span><time>{formatTime(item.at)}</time>{item.runId && <code>{item.runId}</code>}</div>
        <p>{item.content}</p>
      </article>)}
    </div>
    <form className="composer" onSubmit={invoke}>
      <textarea rows={3} disabled={!daemonAvailable} value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit();
      }} placeholder="写下要交办的事项……" aria-label="交办事项" />
      <div className="composer-footer"><span>{daemonAvailable ? "⌘ / Ctrl + Enter" : "服务离线，仅可查阅历史"}</span><button className="button primary" disabled={!daemonAvailable || running || !message.trim()}>{running ? "执行中…" : "提交请求"}</button></div>
    </form>
  </div>;
}

function EmployeeSkillManager({ employee, skills, mode, onClose, onSaved, notify }: {
  employee: Employee;
  skills: Skill[];
  mode: EmployeeSkillManagerMode;
  onClose: () => void;
  onSaved: (employee: Employee) => Promise<void>;
  notify: PageProps["notify"];
}) {
  const daemonAvailable = useDaemonAvailable();
  const initialBoundIds = useMemo(() => employee.skills.map(bindingId), [employee.id, employee.version]);
  const [selectedIds, setSelectedIds] = useState(() => initialBoundIds);
  const [configs, setConfigs] = useState<Record<string, string>>(() => Object.fromEntries(employee.skills.map((binding) => [
    bindingId(binding),
    JSON.stringify(typeof binding === "string" ? {} : binding.config ?? {}, null, 2)
  ])));
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(employee.skills.map((binding) => [bindingId(binding), bindingEnabled(binding)])));
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const addedCount = countAddedSkillBindings(selectedIds, initialBoundIds);
  const visible = filterEmployeeSkillChoices(skills, { mode, initialBoundIds, selectedIds, search });
  const emptyMessage = mode === "add"
    ? search.trim()
      ? "没有匹配的可添加 Skill。"
      : "技能池中暂无可添加的 Skill；已绑定或归档的 Skill 不会重复显示。"
    : "没有可绑定的 Skill；请先在“技能台账”注册。";

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const bindings = selectedIds.map((id) => ({ id, enabled: enabled[id] !== false, config: parseObject(configs[id] || "{}", `Skill ${id} 配置`) }));
      const skillVersions = Object.fromEntries(selectedIds.map((id) => [
        id,
        employee.skillVersions[id] ?? skills.find((skill) => skill.id === id)?.version ?? 1
      ]));
      const saved = await api<Employee>(`/api/employees/${employee.id}`, writeBody({ skills: bindings, skillVersions }, "PATCH"));
      notify(mode === "add"
        ? `已从技能池添加 ${addedCount} 个 Skill · 员工 v${saved.version}`
        : `已更新 ${employee.identity.displayName} 的 Skill 绑定 · 员工 v${saved.version}`);
      await onSaved(saved);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };

  return <Modal
    title={mode === "add" ? "从技能池添加" : "管理员工 Skill"}
    eyebrow={`${employee.identity.displayName} · ${mode === "add" ? "选择未绑定能力" : "独立绑定"}`}
    onClose={onClose}
    wide
  >
    <form className="editor-form employee-skill-manager" onSubmit={save}>
      <fieldset className="daemon-write-surface" disabled={!daemonAvailable}>
        <div className="skill-manager-toolbar"><div aria-live="polite" aria-atomic="true"><b>{mode === "add" ? addedCount : selectedIds.length}</b><span>{mode === "add" ? "个待添加 Skill" : "个已绑定能力"}</span></div><input type="search" aria-label={mode === "add" ? "搜索技能池" : "搜索 Skill 绑定"} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={mode === "add" ? "搜索技能池…" : "搜索 Skill…"} /></div>
        <div className="skill-manager-list">{visible.map((skill) => {
          const selected = selectedIds.includes(skill.id);
          return <article className={selected ? "selected" : ""} key={skill.id}>
            <label className="skill-manager-select"><input type="checkbox" checked={selected} onChange={(event) => {
              setSelectedIds((current) => event.target.checked ? [...current, skill.id] : current.filter((id) => id !== skill.id));
              if (event.target.checked) {
                setConfigs((current) => ({ ...current, [skill.id]: current[skill.id] ?? "{}" }));
                setEnabled((current) => ({ ...current, [skill.id]: current[skill.id] ?? true }));
              }
            }} /><span><strong>{skill.displayName}</strong><code>{skill.id} · v{employee.skillVersions[skill.id] ?? skill.version}</code><small>{skill.description}</small></span></label>
            {selected && <div className="skill-manager-config"><label className="switch-line"><span><b>本员工启用</b><small>关闭后保留版本与配置，运行时不注入。</small></span><input type="checkbox" role="switch" checked={enabled[skill.id] !== false} onChange={(event) => setEnabled({ ...enabled, [skill.id]: event.target.checked })} /></label><Field label="绑定配置 (JSON)"><textarea className="mono" rows={4} value={configs[skill.id] ?? "{}"} onChange={(event) => setConfigs({ ...configs, [skill.id]: event.target.value })} /></Field></div>}
          </article>;
        })}{visible.length === 0 && <div className="library-empty">{emptyMessage}</div>}</div>
      </fieldset>
      <div className="editor-savebar"><span className="editor-save-note">保存会生成员工新版本，已有 Session 仍固定旧版本。</span><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={saving || !daemonAvailable || (mode === "add" && addedCount === 0)}>{saving ? "保存中…" : mode === "add" ? `添加 ${addedCount} 个并保存为 v${employee.version + 1}` : `保存为 v${employee.version + 1}`}</button></div>
    </form>
  </Modal>;
}

function RegistryModal({ data, onClose, refresh, notify }: { data: Bootstrap; onClose: () => void; refresh: () => Promise<void>; notify: PageProps["notify"] }) {
  const emptySkill = { id: "", displayName: "", description: "", instructions: "", tools: "", configSchema: "" };
  const [skill, setSkill] = useState(emptySkill);
  const [editingSkillId, setEditingSkillId] = useState("");
  const [provider, setProvider] = useState({ id: "", definition: "{\n  \"adapter\": \"command\",\n  \"command\": \"claude\",\n  \"args\": [\"--print\"],\n  \"outputProtocol\": \"json\"\n}" });
  const daemonAvailable = useDaemonAvailable();
  const createSkill = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const payload = {
        ...skill,
        configSchema: skill.configSchema.trim() ? parseObject(skill.configSchema, "Skill configSchema") : undefined,
        tools: skill.tools.split(",").map((value) => value.trim()).filter(Boolean)
      };
      await api(editingSkillId ? `/api/skills/${editingSkillId}` : "/api/skills", writeBody(payload, editingSkillId ? "PATCH" : "POST"));
      notify(editingSkillId ? `Skill ${editingSkillId} 已生成新版本` : `Skill ${skill.id} 已注册`); setSkill(emptySkill); setEditingSkillId(""); await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const putProvider = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api(`/api/providers/${provider.id}`, writeBody(parseObject(provider.definition, "Provider definition"), "PUT"));
      notify(`Provider ${provider.id} 已注册`); await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  return <Modal title="共享注册表" eyebrow="Skill 与 Provider · 共享定义" onClose={onClose} wide>
    <fieldset className="daemon-write-surface" disabled={!daemonAvailable}>
    <div className="registry-columns">
      <section><h3>共享 Skill</h3><div className="registry-list">{data.skills.map((item) => <article key={item.id}><div><strong>{item.displayName}</strong><code>{item.id} · v{item.version}</code></div><p>{item.description}</p><button type="button" className="text-button" onClick={() => { setEditingSkillId(item.id); setSkill({ id: item.id, displayName: item.displayName, description: item.description, instructions: item.instructions, tools: item.tools.join(", "), configSchema: item.configSchema ? JSON.stringify(item.configSchema, null, 2) : "" }); }}>修订为新版本</button></article>)}</div>
        <form className="compact-form" onSubmit={createSkill}><Field label="Skill ID"><input required pattern="[a-z][a-z0-9-]*" disabled={Boolean(editingSkillId)} value={skill.id} onChange={(e) => setSkill({ ...skill, id: e.target.value })} /></Field><Field label="显示名"><input required value={skill.displayName} onChange={(e) => setSkill({ ...skill, displayName: e.target.value })} /></Field><Field label="说明"><input required value={skill.description} onChange={(e) => setSkill({ ...skill, description: e.target.value })} /></Field><Field label="可复用指令"><textarea required rows={5} value={skill.instructions} onChange={(e) => setSkill({ ...skill, instructions: e.target.value })} /></Field><Field label="配置 JSON Schema（可选）"><textarea className="mono" rows={5} value={skill.configSchema} onChange={(e) => setSkill({ ...skill, configSchema: e.target.value })} /></Field><Field label="工具（逗号分隔）"><input value={skill.tools} onChange={(e) => setSkill({ ...skill, tools: e.target.value })} /></Field><div className="form-buttons">{editingSkillId && <button type="button" className="button secondary" onClick={() => { setEditingSkillId(""); setSkill(emptySkill); }}>取消修订</button>}<button className="button primary">{editingSkillId ? `保存为 v${(data.skills.find((item) => item.id === editingSkillId)?.version ?? 0) + 1}` : "注册 Skill"}</button></div></form>
      </section>
      <section><h3>Provider 实例</h3><div className="registry-list">{data.providers.map((item) => { const runtime = providerRuntimeSummary(item); return <article key={item.id}><div><strong>{item.id}</strong><code>{runtime.model} · {runtime.adapter}</code></div><pre>{JSON.stringify(item.definition, null, 2)}</pre></article>; })}</div>
        <form className="compact-form" onSubmit={putProvider}><Field label="Provider ID"><input required pattern="[a-z][a-z0-9-]*" value={provider.id} onChange={(e) => setProvider({ ...provider, id: e.target.value })} /></Field><Field label="定义 (JSON)"><textarea className="mono" required rows={9} value={provider.definition} onChange={(e) => setProvider({ ...provider, definition: e.target.value })} /></Field><button className="button primary">注册 Provider</button></form>
      </section>
    </div>
    </fieldset>
  </Modal>;
}

function KnowledgePreviewModal({ employee, onClose, notify }: {
  employee: Employee;
  onClose: () => void;
  notify: PageProps["notify"];
}) {
  const daemonAvailable = useDaemonAvailable();
  const [message, setMessage] = useState("请预览这名员工处理当前职责相关任务时会获得哪些知识证据。");
  const [result, setResult] = useState<KnowledgeRuntimeResult>();
  const [loading, setLoading] = useState(false);
  const preview = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      setResult(await api<KnowledgeRuntimeResult>(`/api/employees/${employee.id}/knowledge-preview`, writeBody({ message })));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setLoading(false); }
  };
  return <Modal title="知识试跑" eyebrow={`${employee.id} · NO PROVIDER CALL`} onClose={onClose} wide><form className="modal-body compact-form" onSubmit={preview}><div className="project-connect-note"><strong>只运行 Resolver、Router 与 Retriever。</strong><p>不会调用 Provider，也不会创建 Session；用它检查 Profile 是否过宽、过窄或没有命中。</p></div><Field label="模拟任务"><textarea required rows={4} disabled={!daemonAvailable || loading} value={message} onChange={(event) => setMessage(event.target.value)} /></Field>{result && <div className="knowledge-preview-result"><ReadonlyEvidence label="Knowledge Plan" value={JSON.stringify(result.plan, null, 2)} mono /><ReadonlyEvidence label={`Evidence · ${result.evidence.length} 条`} value={result.evidence.length ? JSON.stringify(result.evidence, null, 2) : "没有内容达到相关度门槛。请检查 Profile 范围、发布 Revision、元数据标签或任务措辞。"} mono /></div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>关闭</button><button className="button primary" disabled={!daemonAvailable || loading}>{loading ? "路由中…" : "预览知识计划"}</button></div></form></Modal>;
}

export function EmployeePage({ data, refresh, notify }: PageProps) {
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
  const [selectedId, setSelectedId] = useState(visible[0]?.id ?? "");
  const selected = data.employees.find((employee) => employee.id === selectedId) ?? visible[0];
  const selectedProvider = selected ? data.providers.find((provider) => provider.id === selected.providerId) : undefined;
  const selectedRuntime = providerRuntimeSummary(selectedProvider);
  const selectedRuntimeState = selected ? employeeRuntimeStatus(data.activity.instances.filter((instance) => instance.employeeId === selected.id), clock) : "idle";
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
      notify(`已复制为 ${cloned.id}；Session 与 Run 历史未复制`); setCloneOpen(false); setSelectedId(cloned.id); await refresh();
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
        {visible.map((employee) => { const runtime = providerRuntimeSummary(data.providers.find((provider) => provider.id === employee.providerId)); const runtimeState = employeeRuntimeStatus(data.activity.instances.filter((instance) => instance.employeeId === employee.id), clock); return <button className={`employee-card ${selected?.id === employee.id ? "selected" : ""}`} key={employee.id} onClick={() => setSelectedId(employee.id)}>
          <EmployeeAvatar displayName={employee.identity.displayName} presentation={employee.presentation} />
          <span className="employee-card-copy"><strong>{employee.identity.displayName}</strong><code>{employee.id} · v{employee.version}</code><small>{employee.description}</small><span className="employee-runtime"><span>模型 <code>{runtime.model}</code></span><span title={runtime.launchCommand}>启动 <code>{runtime.launchPreview}</code></span></span></span>
          <span className="employee-card-stamps"><Stamp status={employee.status} />{runtimeState !== "idle" && <RuntimeStatusChip status={runtimeState} />}</span>
        </button>; })}
        {visible.length === 0 && <div className="mini-empty">没有符合条件的员工档案。</div>}
      </div>
      <footer className="list-footer"><span>{visible.length} 份档案</span><span>LOCAL</span></footer>
    </aside>

    <main className="detail-pane">
      {!selected ? <EmptyState title="建立第一位本地员工" action={<button className="button primary" disabled={!daemonAvailable} onClick={() => setEditor("new")}>建立档案</button>}>定义他的背景、职责、提示词、共享 Skill、Provider 与权限。之后可以在任意 MCP 会话直接调用，也可以将他放进协作编排。</EmptyState> : <div className="dossier employee-dossier" style={{ "--dossier-accent": selected.presentation.accent ?? DEFAULT_EMPLOYEE_ACCENT } as React.CSSProperties}>
        <header className="dossier-cover">
          <div className="file-index"><span>LOCAL PERSONNEL RECORD</span><code>No. {selected.id.toUpperCase()}</code></div>
          <div className="dossier-title-row"><EmployeeAvatar className="large" displayName={selected.identity.displayName} presentation={selected.presentation} /><div><h2>{selected.identity.displayName}</h2><p>{selected.description}</p></div><div className="dossier-stamps"><Stamp status={selected.status} />{selectedRuntimeState !== "idle" && <RuntimeStatusChip status={selectedRuntimeState} />}</div></div>
          <div className="dossier-actions"><button className="button primary" disabled={selected.status === "archived"} onClick={() => scrollRecordIntoView("direct-desk")}>直接交办</button>{selectedRuntimeState === "failed" && <button className="button secondary" onClick={() => { window.location.hash = "runs"; }}>查看故障运行证据</button>}<button className="button secondary" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setKnowledgePreviewOpen(true)}>知识试跑</button><button className="button secondary" disabled={!daemonAvailable} onClick={() => setPerspectiveOpen(true)}>知识视角</button><button className="button secondary" disabled={!daemonAvailable} onClick={() => setEditor("edit")}>修订档案</button><button className="button secondary" disabled={!daemonAvailable} onClick={() => { setCloneDraft({ id: `${selected.id}-copy`, displayName: `${selected.identity.displayName} 副本` }); setCloneOpen(true); }}>复制</button><button className="button danger" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setArchiveOpen(true)}>归档</button></div>
        </header>

        <DossierSection number="01" title="身份"><div className="fact-grid"><div><span>背景</span><p>{selected.identity.background}</p></div><div><span>职责</span><ul>{selected.identity.responsibilities.map((item) => <li key={item}>{item}</li>)}</ul></div><div><span>目标</span><ul>{selected.identity.goals?.map((item) => <li key={item}>{item}</li>) ?? <li>未声明</li>}</ul></div><div><span>约束</span><ul>{selected.identity.constraints?.map((item) => <li key={item}>{item}</li>) ?? <li>未声明</li>}</ul></div></div></DossierSection>
        <DossierSection number="02" title="提示词"><div className="prompt-preview"><div><span>系统指令</span><p>{selected.systemPrompt}</p></div><div><span>请求指令</span><p>{selected.requestPrompt}</p></div></div></DossierSection>
        <DossierSection number="03" title="技能" action={<div className="skill-section-actions">
          <button type="button" className="text-button icon-text-button" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setSkillManagerMode("add")}><UtilityIcon name="add" />从技能池添加</button>
          <button type="button" className="text-button" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setSkillManagerMode("manage")}>管理绑定</button>
        </div>}><div className="employee-skill-ledger">{selected.skills.length ? selected.skills.map((binding) => { const id = bindingId(binding); const skill = data.skills.find((candidate) => candidate.id === id); const enabled = bindingEnabled(binding); return <article className={!enabled ? "is-disabled" : ""} key={id}><div className="skill-book" aria-hidden="true">S</div><div><strong>{skill?.displayName ?? id}</strong><code>{id} · 固定 v{selected.skillVersions[id] ?? "—"}</code><small>{skill?.description ?? "共享能力定义不可用"}</small></div><Stamp status={enabled ? "active" : "archived"} label={enabled ? "已启用" : "已停用"} /><label className="compact-switch"><span className="sr-only">{enabled ? "停用" : "启用"} {skill?.displayName ?? id}</span><input type="checkbox" role="switch" disabled={!daemonAvailable || Boolean(togglingSkill) || selected.status === "archived"} checked={enabled} onChange={(event) => void toggleSkill(id, event.target.checked)} /></label></article>; }) : <div className="empty-inline"><span>尚未绑定共享 Skill</span><button type="button" className="text-button" disabled={!daemonAvailable} onClick={() => setSkillManagerMode("add")}>从技能池添加</button></div>}</div></DossierSection>
        <DossierSection number="04" title="知识授权" action={<div className="skill-section-actions"><button type="button" className="text-button" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setKnowledgeGrantOpen(true)}>调整授权</button><button type="button" className="text-button" disabled={!daemonAvailable} onClick={() => setPerspectiveOpen(true)}>查看知识视角</button></div>}><div className="employee-knowledge-profiles">{(selected.knowledgeProfileIds ?? []).length ? (selected.knowledgeProfileIds ?? []).map((profileId) => { const profile = (data.knowledgeProfiles ?? []).find((candidate) => candidate.id === profileId); return <article key={profileId}><span aria-hidden="true">知</span><div><strong>{profile?.displayName ?? profileId}</strong><code>{profileId} · 当前 v{profile?.version ?? "—"}</code><small>{profile?.description ?? "Profile 已不可用；后续调用会在 Knowledge Plan 中排除。"}</small></div><Stamp status={profile?.status ?? "blocked"} /></article>; }) : <div className="empty-inline"><span>尚未授权知识 Profile；员工仍可正常工作，但不会预加载知识证据。</span><button type="button" className="text-button" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setKnowledgeGrantOpen(true)}>生成授权提案</button></div>}</div></DossierSection>
        <div className="dossier-columns"><DossierSection number="05" title="Provider"><dl className="ledger"><dt>实例</dt><dd><code>{selected.providerId}</code></dd><dt>模型</dt><dd className="provider-model"><code>{selectedRuntime.model}</code></dd><dt>Adapter</dt><dd>{selectedRuntime.adapter}</dd><dt>最大尝试</dt><dd>{selected.maxAttempts}</dd></dl><div className="provider-launch"><span>启动指令模板</span><pre>{selectedRuntime.launchCommand}</pre><small>当前 Provider 配置中的 argv；模板变量会在运行时渲染，敏感参数仅显示为 ***。</small></div></DossierSection><DossierSection number="06" title="权限"><dl className="ledger"><dt>写入</dt><dd>{selected.permissions.write}</dd><dt>声明工具</dt><dd>{selected.permissions.tools?.join(", ") || "无"}</dd><dt>历史窗口</dt><dd>{selected.contextPolicy.historyLimit} 条</dd><dt>Verdict</dt><dd>{selected.verdict ? <code>{selected.verdict.path}: {selected.verdict.pass.join("/")} | {selected.verdict.block.join("/")}</code> : "未配置"}</dd></dl></DossierSection></div>
        <DossierSection number="07" title="外观"><dl className="ledger horizontal"><dt>强调色</dt><dd><span className="color-chip" style={{ background: selected.presentation.accent ?? DEFAULT_EMPLOYEE_ACCENT }} />{selected.presentation.accent ?? "默认朱红"}</dd><dt>首字母</dt><dd>{selected.presentation.initials || selected.identity.displayName.slice(0, 2)}</dd><dt>头像</dt><dd>{selected.presentation.avatarUrl ? <code className="avatar-source">{selected.presentation.avatarUrl}</code> : "未配置，显示首字母"}</dd></dl></DossierSection>
        <DossierSection number="08" title="版本"><div className="version-strip">{versions.map((version) => <div key={version.version} className={version.version === selected.version ? "current" : ""}><code>v{version.version}</code><span>{version.status === "archived" ? "归档" : version.version === selected.version ? "当前" : "历史"}</span><time>{formatTime(version.updatedAt)}</time></div>)}</div></DossierSection>
        <div id="direct-desk"><DirectDesk employee={selected} sessions={sessions} refresh={refresh} notify={notify} onContext={(sessionId) => { setContextSessionId(sessionId); setContextOpen(true); }} /></div>
      </div>}
    </main>

    {editor && <EmployeeEditor employee={editor === "edit" ? selected : undefined} providers={data.providers} skills={data.skills} notify={notify} onClose={() => setEditor(null)} onSaved={async (saved) => { setEditor(null); setSelectedId(saved.id); await refresh(); }} />}
    {registryOpen && <RegistryModal data={data} onClose={() => setRegistryOpen(false)} refresh={refresh} notify={notify} />}
    {skillManagerMode && selected && <EmployeeSkillManager employee={selected} skills={data.skills} mode={skillManagerMode} notify={notify} onClose={() => setSkillManagerMode(null)} onSaved={async () => { setSkillManagerMode(null); await refresh(); }} />}
    {knowledgePreviewOpen && selected && <KnowledgePreviewModal employee={selected} notify={notify} onClose={() => setKnowledgePreviewOpen(false)} />}
    {perspectiveOpen && selected && <Modal title={`知识视角 · ${selected.identity.displayName}`} eyebrow={`${selected.id} v${selected.version} · ELIGIBLE → ACTIVATED → SELECTED`} onClose={() => setPerspectiveOpen(false)} wide>
      <div className="modal-body perspective-modal-body"><KnowledgePerspectiveExplorer employee={selected} bindings={data.projectBindings} notify={notify} /></div>
    </Modal>}
    {knowledgeGrantOpen && selected && <EmployeeKnowledgeGrantModal employee={selected} knowledgeProfiles={data.knowledgeProfiles ?? []} notify={notify} onClose={() => setKnowledgeGrantOpen(false)} onCreated={refresh} />}
    {cloneOpen && selected && <Modal title="复制员工档案" eyebrow={`来源 ${selected.id} · v${selected.version}`} onClose={() => setCloneOpen(false)}><form className="modal-body compact-form" onSubmit={clone}><p className="notice-copy">复制身份、提示词、Skill、Provider 与权限。不会复制 Session、密钥或 Run 历史。</p><Field label="新员工 ID"><input required disabled={!daemonAvailable} pattern="[a-z][a-z0-9-]*" value={cloneDraft.id} onChange={(e) => setCloneDraft({ ...cloneDraft, id: e.target.value })} /></Field><Field label="显示名"><input required disabled={!daemonAvailable} value={cloneDraft.displayName} onChange={(e) => setCloneDraft({ ...cloneDraft, displayName: e.target.value })} /></Field><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setCloneOpen(false)}>取消</button><button className="button primary" disabled={!daemonAvailable}>建立副本</button></div></form></Modal>}
    {archiveOpen && selected && <Modal title="归档员工" eyebrow={`${selected.id} · 保留历史`} onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>只归档，不物理删除。</b><p>归档后不能接受新调用，也不能加入新 Workflow；已有 Session、版本与 Run 证据继续保留。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveOpen(false)}>保留在册</button><button className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive()}>确认归档</button></div></div></Modal>}
    {contextOpen && selected && <><div className="drawer-scrim" onClick={() => setContextOpen(false)} /><ContextDrawer employee={selected} sessionId={contextSessionId} onClose={() => setContextOpen(false)} /></>}
  </div>;
}
