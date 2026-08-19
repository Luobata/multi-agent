import { useState, type FormEvent } from "react";
import { api, writeBody } from "../api";
import {
  DossierSection,
  EmployeeAvatar,
  Field,
  Modal,
  SelectControl,
  Stamp,
  SwitchControl,
  useDaemonAvailable
} from "../components";
import type { Bootstrap, Employee } from "../types";
import { providerRuntimeSummary } from "../providerRuntime";
import type { PageProps } from "../EmployeePage";
import {
  E2E_OUTPUT_SCHEMA,
  draftFrom,
  draftFromTemplate,
  payloadFrom,
  schemaRequiresE2eEvidence,
  type EmployeeDraft
} from "./draft";

export function EmployeeEditor({ employee, data, onClose, onSaved, notify }: {
  employee?: Employee;
  data: Bootstrap;
  onClose: () => void;
  onSaved: (employee: Employee) => void;
  notify: PageProps["notify"];
}) {
  const providers = data.providers;
  const skills = data.skills.filter((skill) => skill.owner !== "system");
  const templates = (data.employeeTemplates ?? []).filter((template) => template.status === "active");
  const projects = data.projects.filter((project) => project.status === "active");
  const [draft, setDraft] = useState(() => draftFrom(employee));
  const [templateId, setTemplateId] = useState("");
  const [saving, setSaving] = useState(false);
  const daemonAvailable = useDaemonAvailable();
  const patch = <K extends keyof EmployeeDraft>(key: K, value: EmployeeDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = payloadFrom(draft);
      const project = projects.find((candidate) => candidate.id === draft.scopeProjectId);
      const scopedPayload = {
        ...payload,
        scope: employee ? employee.scope : draft.scopeKind === "project"
          ? { kind: "project" as const, projectId: draft.scopeProjectId, projectVersion: project?.version ?? 1 }
          : { kind: "global" as const }
      };
      const saved = employee
        ? await api<Employee>(`/api/employees/${employee.id}`, writeBody(scopedPayload, "PATCH"))
        : templateId
          ? await api<Employee>(`/api/employee-templates/${templateId}/employees`, writeBody({ ...scopedPayload, templateVersion: templates.find((template) => template.id === templateId)?.version }))
          : await api<Employee>("/api/employees", writeBody(scopedPayload));
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
      {!employee && <section className="employee-template-picker" aria-label="员工模板与作用域">
        <div><span>EMPLOYEE BLUEPRINT</span><strong>从通用模板派生项目员工</strong><p>模板只在创建时复制默认值并固定版本；之后员工独立演进，不会随模板静默变化。</p></div>
        <Field label="员工模板（可选）"><SelectControl ariaLabel="选择员工模板" value={templateId} options={[{ value: "", label: "空白档案", description: "不从通用模板复制默认值" }, ...templates.map((template) => ({ value: template.id, label: template.displayName, description: `${template.id} · 固定 v${template.version}` }))]} onChange={(nextId) => {
          setTemplateId(nextId);
          const template = templates.find((candidate) => candidate.id === nextId);
          if (!template) return;
          const next = draftFromTemplate(template);
          setDraft({ ...next, id: draft.id, displayName: draft.displayName });
        }} /></Field>
      </section>}
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
        <div className="form-grid two">
          <Field label="所属范围" hint={employee ? "创建后不可变。" : "项目员工只能在固定项目版本内调用。"}><SelectControl ariaLabel="选择员工所属范围" disabled={Boolean(employee)} value={draft.scopeKind} options={[{ value: "global", label: "全局员工", description: "可被所有允许的内部入口引用" }, { value: "project", label: "项目员工", description: "仅能通过固定项目版本中的角色调用" }]} onChange={(scopeKind) => patch("scopeKind", scopeKind as EmployeeDraft["scopeKind"])} /></Field>
          {draft.scopeKind === "project" && <Field label="所属项目"><SelectControl ariaLabel="选择员工所属项目" disabled={Boolean(employee)} invalid={!draft.scopeProjectId} errorMessage={!draft.scopeProjectId ? "请选择一个项目。" : undefined} value={draft.scopeProjectId} options={[{ value: "", label: "选择项目", disabled: true }, ...projects.map((project) => ({ value: project.id, label: project.name, description: `${project.id} · 固定 v${project.version}` }))]} onChange={(scopeProjectId) => patch("scopeProjectId", scopeProjectId)} /></Field>}
        </div>
        <Field label="结构化能力" hint="逗号分隔，例如 code.frontend、quality.test；协作编排按能力而不是角色名分工。"><input value={draft.capabilities} onChange={(event) => patch("capabilities", event.target.value)} placeholder="code.frontend, quality.audit" /></Field>
      </DossierSection>

      <DossierSection number="02" title="提示词">
        <Field label="角色系统指令"><textarea rows={6} required value={draft.systemPrompt} onChange={(e) => patch("systemPrompt", e.target.value)} /></Field>
        <Field label="单次请求指令"><textarea rows={4} required value={draft.requestPrompt} onChange={(e) => patch("requestPrompt", e.target.value)} /></Field>
      </DossierSection>

      <DossierSection number="03" title="共享技能">
        {skills.length === 0 ? <p className="muted">自定义 Skill 注册表为空。系统能力按运行位置自动注入，不能在这里手工绑定。</p> : <div className="skill-selector">
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
        <label className="switch-line"><span><b>要求 e2e 证据</b><small>一键注入 e2e 证据输出契约并预填 verdict；下方原始字段仍是最终来源。</small></span><SwitchControl checked={schemaRequiresE2eEvidence(draft.outputSchema)} ariaLabel="要求 e2e 证据" onChange={(nextChecked) => {
          // One-way convenience injector: enabling overwrites the schema + verdict fields;
          // disabling intentionally does NOT auto-clear them so manual edits survive.
          if (!nextChecked) return;
          setDraft((current) => ({ ...current, outputSchema: JSON.stringify(E2E_OUTPUT_SCHEMA, null, 2), verdictPath: "/verdict", verdictPass: "pass", verdictBlock: "block" }));
        }} /></label>
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
