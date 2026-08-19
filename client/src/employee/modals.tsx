import { useMemo, useState, type FormEvent } from "react";
import { api, writeBody } from "../api";
import {
  Field,
  Modal,
  ReadonlyEvidence,
  SwitchControl,
  useDaemonAvailable
} from "../components";
import type { Bootstrap, Employee, KnowledgeRuntimeResult, Skill } from "../types";
import {
  countAddedSkillBindings,
  filterEmployeeSkillChoices,
  type EmployeeSkillManagerMode
} from "../employeeSkillPool";
import { providerRuntimeSummary } from "../providerRuntime";
import type { PageProps } from "../EmployeePage";
import { bindingEnabled, bindingId, parseObject } from "./draft";

export function EmployeeSkillManager({ employee, skills, mode, onClose, onSaved, notify }: {
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
            {selected && <div className="skill-manager-config"><label className="switch-line"><span><b>本员工启用</b><small>关闭后保留版本与配置，运行时不注入。</small></span><SwitchControl checked={enabled[skill.id] !== false} ariaLabel={`本员工是否启用 ${skill.displayName}`} onChange={(nextEnabled) => setEnabled({ ...enabled, [skill.id]: nextEnabled })} /></label><Field label="绑定配置 (JSON)"><textarea className="mono" rows={4} value={configs[skill.id] ?? "{}"} onChange={(event) => setConfigs({ ...configs, [skill.id]: event.target.value })} /></Field></div>}
          </article>;
        })}{visible.length === 0 && <div className="library-empty">{emptyMessage}</div>}</div>
      </fieldset>
      <div className="editor-savebar"><span className="editor-save-note">保存会生成员工新版本，已有 Session 仍固定旧版本。</span><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={saving || !daemonAvailable || (mode === "add" && addedCount === 0)}>{saving ? "保存中…" : mode === "add" ? `添加 ${addedCount} 个并保存为 v${employee.version + 1}` : `保存为 v${employee.version + 1}`}</button></div>
    </form>
  </Modal>;
}

export function RegistryModal({ data, onClose, refresh, notify }: { data: Bootstrap; onClose: () => void; refresh: () => Promise<void>; notify: PageProps["notify"] }) {
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

export function KnowledgePreviewModal({ employee, onClose, notify }: {
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
