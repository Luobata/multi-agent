import { useMemo, useState, type FormEvent } from "react";
import { api, writeBody } from "./api";
import { EmployeeAvatar, Field, Modal, Stamp, UtilityIcon, formatTime, useDaemonAvailable } from "./components";
import type { Bootstrap, JsonObject, Skill, SkillBinding } from "./types";

interface PageProps {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
}

interface SkillDraft {
  id: string;
  displayName: string;
  description: string;
  summary: string;
  instructions: string;
  configSchema: string;
  tools: string;
}

const emptyDraft: SkillDraft = {
  id: "",
  displayName: "",
  description: "",
  summary: "",
  instructions: "",
  configSchema: "",
  tools: ""
};

function bindingId(binding: SkillBinding): string {
  return typeof binding === "string" ? binding : binding.id;
}

function bindingEnabled(binding: SkillBinding): boolean {
  return typeof binding === "string" || binding.enabled !== false;
}

function parseObject(value: string, label: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 对象`);
  return parsed as JsonObject;
}

function draftFrom(skill?: Skill): SkillDraft {
  return skill ? {
    id: skill.id,
    displayName: skill.displayName,
    description: skill.description,
    summary: skill.summary,
    instructions: skill.instructions,
    configSchema: skill.configSchema ? JSON.stringify(skill.configSchema, null, 2) : "",
    tools: skill.tools.join(", ")
  } : emptyDraft;
}

function SkillEditor({ skill, onClose, onSaved, notify }: {
  skill?: Skill;
  onClose: () => void;
  onSaved: () => Promise<void>;
  notify: PageProps["notify"];
}) {
  const [draft, setDraft] = useState(() => draftFrom(skill));
  const [saving, setSaving] = useState(false);
  const daemonAvailable = useDaemonAvailable();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        id: draft.id.trim(),
        displayName: draft.displayName.trim(),
        description: draft.description.trim(),
        summary: draft.summary.trim() || undefined,
        instructions: draft.instructions.trim(),
        configSchema: draft.configSchema.trim() ? parseObject(draft.configSchema, "配置 JSON Schema") : undefined,
        tools: draft.tools.split(",").map((value) => value.trim()).filter(Boolean)
      };
      await api(skill ? `/api/skills/${skill.id}` : "/api/skills", writeBody(payload, skill ? "PATCH" : "POST"));
      notify(skill ? `Skill ${skill.id} 已修订为 v${skill.version + 1}` : `Skill ${payload.id} 已注册`);
      await onSaved();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };

  return <Modal title={skill ? `修订 ${skill.displayName}` : "注册 Skill"} eyebrow="SHARED CAPABILITY · VERSIONED" onClose={onClose} wide>
    <form className="editor-form skill-editor-form" onSubmit={submit}>
      <fieldset className="daemon-write-surface" disabled={!daemonAvailable}>
        <div className="form-grid two">
          <Field label="Skill ID" hint="注册后不可修改。"><input required pattern="[a-z][a-z0-9-]*" disabled={Boolean(skill)} value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></Field>
          <Field label="显示名"><input required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
        </div>
        <Field label="能力说明"><input required value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field>
        <Field label="功能摘要（可选）" hint="一句话概括这个 Skill 大致能做什么，供领队派工时判断谁合适；留空则自动取能力说明首句。"><input value={draft.summary} placeholder="例如：产出精确到组件与状态的交互设计规范" onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></Field>
        <Field label="可复用指令" hint="Role 只绑定 Skill；运行时按版本注入这些指令。"><textarea required rows={10} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></Field>
        <div className="form-grid two">
          <Field label="配置 JSON Schema（可选）"><textarea className="mono" rows={8} value={draft.configSchema} onChange={(event) => setDraft({ ...draft, configSchema: event.target.value })} /></Field>
          <Field label="工具声明" hint="逗号分隔；实际授权仍由 Provider 与 sandbox 负责。"><textarea rows={8} value={draft.tools} onChange={(event) => setDraft({ ...draft, tools: event.target.value })} /></Field>
        </div>
      </fieldset>
      <div className="editor-savebar"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={saving || !daemonAvailable}>{saving ? "保存中…" : skill ? `保存为 v${skill.version + 1}` : "注册 Skill"}</button></div>
    </form>
  </Modal>;
}

function SkillInspector({ skill, data, onClose }: { skill: Skill; data: Bootstrap; onClose: () => void }) {
  const isSystem = skill.owner === "system";
  const bindings = data.employees.flatMap((employee) => employee.skills
    .filter((binding) => bindingId(binding) === skill.id)
    .map((binding) => ({ employee, enabled: bindingEnabled(binding) })));
  return <Modal title={skill.displayName} eyebrow={`${skill.id} · v${skill.version}${isSystem ? " · 系统能力" : ""}`} onClose={onClose} wide>
    <div className="skill-inspector">
      <div className="skill-inspector-head"><Stamp status={skill.status} label={isSystem ? "系统 · 自动注入" : undefined} /><p>{skill.description}</p><time>更新于 {formatTime(skill.updatedAt)}</time></div>
      {isSystem && <div className="system-skill-note" role="note"><strong>系统能力 · 只读</strong><p>{skill.injection === "supervisor" ? "任何被放进领队位置的员工会在运行时临时获得该能力；它不会写入员工档案，也不接受手工修订、归档、恢复或绑定。" : "由系统维护，不接受手工修订、归档、恢复或绑定。"}</p></div>}
      <div className="skill-inspector-grid">
        <section><h3>可复用指令</h3><pre>{skill.instructions}</pre></section>
        <section><h3>配置契约</h3><pre className="mono">{skill.configSchema ? JSON.stringify(skill.configSchema, null, 2) : "未声明配置 Schema"}</pre><h3>工具</h3><div className="tag-row">{skill.tools.length ? skill.tools.map((tool) => <code className="paper-tag" key={tool}>{tool}</code>) : <span className="muted">无工具声明</span>}</div></section>
      </div>
      {isSystem
        ? <section className="skill-binding-summary"><h3>使用方式</h3><p className="muted">由 Supervisor 编排物化时按领队位置自动注入并固定版本，成员不会获得；注入版本与原因写入 Run 证据。</p></section>
        : <section className="skill-binding-summary"><h3>员工绑定</h3>{bindings.length ? bindings.map(({ employee, enabled }) => <div key={employee.id}><strong>{employee.identity.displayName}</strong><code>{employee.id} · v{employee.version}</code><Stamp status={enabled ? "active" : "archived"} label={enabled ? "已启用" : "已停用"} /></div>) : <p className="muted">尚未绑定到任何员工。</p>}</section>}
    </div>
  </Modal>;
}

export function SkillsPage({ data, refresh, notify }: PageProps) {
  const daemonAvailable = useDaemonAvailable();
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState<"new" | string | null>(null);
  const [inspectId, setInspectId] = useState<string>();
  const [archiveId, setArchiveId] = useState<string>();
  const visible = useMemo(() => data.skills.filter((skill) => {
    if (!showArchived && skill.status === "archived") return false;
    const haystack = `${skill.id} ${skill.displayName} ${skill.description} ${skill.tools.join(" ")}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  }), [data.skills, search, showArchived]);
  const systemSkills = visible.filter((skill) => skill.owner === "system");
  const customSkills = visible.filter((skill) => skill.owner !== "system");
  const inspect = data.skills.find((skill) => skill.id === inspectId);
  const editing = editor && editor !== "new" ? data.skills.find((skill) => skill.id === editor && skill.owner !== "system") : undefined;
  const archived = data.skills.filter((skill) => skill.status === "archived").length;

  const archive = async (skill: Skill) => {
    try {
      await api(`/api/skills/${skill.id}/archive`, writeBody({}));
      notify(`Skill ${skill.id} 已归档；既有版本与员工配置已保留`);
      setArchiveId(undefined);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const restore = async (skill: Skill) => {
    try {
      await api(`/api/skills/${skill.id}/restore`, writeBody({}));
      notify(`Skill ${skill.id} 已恢复为可绑定状态`);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };

  return <main className="library-page">
    <header className="library-header"><div><p className="record-meta">LIBRARY / LOCAL</p><h1>Skills</h1><p>{data.skills.length} 个可复用能力 · 系统 {data.skills.filter((skill) => skill.owner === "system").length} · 自定义 {data.skills.filter((skill) => skill.owner !== "system").length} · {data.employees.length} 份员工档案 · {archived} 个归档</p></div><button className="button primary library-primary" disabled={!daemonAvailable} onClick={() => setEditor("new")}><UtilityIcon name="add" />注册 Skill</button></header>
    <section className="library-toolbar"><label className="library-search"><span>检索</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、ID、说明或工具…" /></label><label className="check-line"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />显示归档</label><span>{visible.length} 条记录</span></section>
    <section className="skill-group" aria-labelledby="skill-group-system">
      <header className="skill-group-heading"><div><h2 id="skill-group-system">系统能力</h2><span>{systemSkills.length}</span></div><p>由系统维护并按领队位置自动注入；可查看版本、指令与工具，但不接受修订、归档、恢复或手工绑定。</p></header>
      <div className="skill-ledger" aria-label="系统能力">
        {systemSkills.map((skill) => <article className="skill-ledger-row skill-ledger-row--system" key={skill.id}>
          <button type="button" className="skill-ledger-identity" onClick={() => setInspectId(skill.id)}><span className="skill-book" aria-hidden="true">S</span><span><strong>{skill.displayName}</strong><small>{skill.description}</small></span></button>
          <div className="skill-source"><code>SYSTEM</code><span>{skill.id}</span><small>revision v{skill.version}</small></div>
          <div className="skill-bound"><strong>按领队位置注入</strong><span>{skill.injection === "supervisor" ? "仅注入领队运行时" : "由系统注入"}</span></div>
          <Stamp status={skill.status} label={skill.status === "active" ? "自动注入" : "已归档"} />
          <div className="skill-row-actions"><button type="button" className="text-button" onClick={() => setInspectId(skill.id)}>查看</button></div>
        </article>)}
        {systemSkills.length === 0 && <div className="library-empty">{search.trim() ? "没有符合条件的系统能力。" : "当前核心尚未注册系统能力。"}</div>}
      </div>
    </section>
    <section className="skill-group" aria-labelledby="skill-group-custom">
      <header className="skill-group-heading"><div><h2 id="skill-group-custom">自定义能力</h2><span>{customSkills.length}</span></div><p>由你注册、版本化修订并绑定到员工的可复用能力。</p></header>
      <div className="skill-ledger" aria-label="自定义能力">
      <header className="skill-ledger-row skill-ledger-labels"><span>Skill</span><span>来源 / 版本</span><span>员工绑定</span><span>状态</span><span>操作</span></header>
      {customSkills.map((skill) => {
        const bound = data.employees.filter((employee) => employee.skills.some((binding) => bindingId(binding) === skill.id));
        const enabled = data.employees.filter((employee) => employee.skills.some((binding) => bindingId(binding) === skill.id && bindingEnabled(binding))).length;
        return <article className={`skill-ledger-row ${skill.status === "archived" ? "is-archived" : ""}`} key={skill.id}>
          <button type="button" className="skill-ledger-identity" onClick={() => setInspectId(skill.id)}><span className="skill-book" aria-hidden="true">S</span><span><strong>{skill.displayName}</strong><small>{skill.description}</small></span></button>
          <div className="skill-source"><code>LOCAL</code><span>{skill.id}</span><small>revision v{skill.version}</small></div>
          <div className="skill-bound"><strong>{bound.length} 人绑定</strong><span>{enabled} 人启用</span><div>{bound.slice(0, 3).map((employee) => <EmployeeAvatar className="small skill-bound-avatar" title={employee.identity.displayName} displayName={employee.identity.displayName} presentation={employee.presentation} key={employee.id} />)}</div></div>
          <Stamp status={skill.status} label={skill.status === "active" ? "可绑定" : "已归档"} />
          <div className="skill-row-actions"><button type="button" className="text-button" onClick={() => setInspectId(skill.id)}>查看</button>{skill.status === "active" ? <><button type="button" className="text-button" disabled={!daemonAvailable} onClick={() => setEditor(skill.id)}>修订</button><button type="button" className="text-button danger-text" disabled={!daemonAvailable} onClick={() => setArchiveId(skill.id)}>归档</button></> : <button type="button" className="text-button" disabled={!daemonAvailable} onClick={() => void restore(skill)}>恢复</button>}</div>
        </article>;
      })}
      {customSkills.length === 0 && <div className="library-empty">没有符合当前条件的自定义 Skill。</div>}
      </div>
    </section>
    <footer className="library-footnote"><b>版本策略</b><span>修订会生成新版本；员工继续固定原版本，直到明确重新绑定。归档不会物理删除历史证据。系统能力由核心维护，只能查看。</span></footer>

    {editor && <SkillEditor skill={editing} notify={notify} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await refresh(); }} />}
    {inspect && <SkillInspector skill={inspect} data={data} onClose={() => setInspectId(undefined)} />}
    {archiveId && (() => { const skill = data.skills.find((candidate) => candidate.id === archiveId); return skill ? <Modal title="归档 Skill" eyebrow={`${skill.id} · 可恢复`} onClose={() => setArchiveId(undefined)}><div className="modal-body"><div className="danger-notice"><b>不会删除既有员工绑定或历史版本。</b><p>归档后，该 Skill 不再出现在新增绑定列表；已固定版本的员工仍可运行。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveId(undefined)}>取消</button><button className="button danger-filled" onClick={() => void archive(skill)}>确认归档</button></div></div></Modal> : null; })()}
  </main>;
}
