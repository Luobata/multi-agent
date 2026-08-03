import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, writeBody } from "./api";
import { DossierSection, EmployeeAvatar, EmptyState, Field, Modal, ReadonlyEvidence, SelectControl, Stamp, UtilityIcon, formatTime, scrollRecordIntoView, useDaemonAvailable } from "./components";
import { activeWorkflowPublications, buildWorkflowSessionPrompts } from "./workflowSessionPrompts";
import type { Bootstrap, Employee, InvocationRecord, JsonObject, ManagementPolicy, SupervisorWorkflow, Workflow } from "./types";

interface PageProps {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
}

interface MemberDraft {
  roleId: string;
  description: string;
  employeeId: string;
}

interface SupervisorDraft {
  id: string;
  description: string;
  supervisorEmployeeId: string;
  policyId: string;
  policyVersion: number;
  members: MemberDraft[];
  inputSchema: string;
}

interface WorkflowStartReceipt {
  invocation: InvocationRecord;
  runId: string;
  statusUrl: string;
  streamUrl: string;
}

function parseObject(value: string, label: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 对象`);
  return parsed as JsonObject;
}

function memberDrafts(policy: ManagementPolicy | undefined, employees: Employee[], existing: MemberDraft[] = []): MemberDraft[] {
  if (!policy) return existing.length ? existing : [{ roleId: "worker", description: "执行领队派发的专业任务。", employeeId: employees[0]?.id ?? "" }];
  return policy.allowedRoleIds.map((roleId) => existing.find((member) => member.roleId === roleId) ?? {
    roleId,
    description: `负责 ${roleId} 角色槽的专业任务。`,
    employeeId: employees[0]?.id ?? ""
  });
}

function supervisorDraft(workflow: SupervisorWorkflow | undefined, employees: Employee[], policies: ManagementPolicy[]): SupervisorDraft {
  const firstPolicy = policies.find((policy) => policy.status === "active");
  const existing = workflow?.members.map((member) => ({
    roleId: member.roleId,
    description: member.description,
    employeeId: member.employeeId
  })) ?? [];
  return {
    id: workflow?.id ?? "",
    description: workflow?.description ?? "",
    supervisorEmployeeId: workflow?.supervisor.employeeId ?? employees[0]?.id ?? "",
    policyId: workflow?.managementPolicy.id ?? firstPolicy?.id ?? "",
    policyVersion: workflow?.managementPolicy.version ?? firstPolicy?.version ?? 1,
    members: workflow ? existing : memberDrafts(firstPolicy, employees, existing),
    inputSchema: JSON.stringify(workflow?.inputSchema ?? {}, null, 2)
  };
}

function SupervisorEditor({ workflow, data, onClose, onSaved, notify }: {
  workflow?: SupervisorWorkflow;
  data: Bootstrap;
  onClose: () => void;
  onSaved: (workflow: SupervisorWorkflow) => void;
  notify: PageProps["notify"];
}) {
  const employees = data.employees.filter((employee) => employee.status === "active");
  const policies = (data.managementPolicies ?? []).filter((policy) => policy.status === "active");
  const daemonAvailable = useDaemonAvailable();
  const [draft, setDraft] = useState(() => supervisorDraft(workflow, employees, policies));
  const [saving, setSaving] = useState(false);
  const [policyVersions, setPolicyVersions] = useState<ManagementPolicy[]>([]);
  const [rosterNotice, setRosterNotice] = useState("");
  const selectedPolicy = policies.find((policy) => policy.id === draft.policyId);
  useEffect(() => {
    let current = true;
    if (!draft.policyId) { setPolicyVersions([]); return () => { current = false; }; }
    api<{ policy: ManagementPolicy; versions: ManagementPolicy[] }>(`/api/management-policies/${draft.policyId}`)
      .then((detail) => { if (current) setPolicyVersions(detail.versions); })
      .catch(() => { if (current) setPolicyVersions(selectedPolicy ? [selectedPolicy] : []); });
    return () => { current = false; };
  }, [draft.policyId, selectedPolicy?.version]);
  const selectablePolicyVersions = policyVersions.filter((policy) => policy.status === "active");
  const selectedPolicyVersion = selectablePolicyVersions.find((policy) => policy.version === draft.policyVersion);
  const policyVersionOptions = [
    ...(!selectedPolicyVersion ? [{ value: String(draft.policyVersion), label: `v${draft.policyVersion}`, description: "正在读取固定版本", disabled: true }] : []),
    ...selectablePolicyVersions.map((policy) => ({
      value: String(policy.version),
      label: `v${policy.version}${policy.version === selectedPolicy?.version ? " · 当前" : " · 历史"}`,
      description: `${policy.allowedRoleIds.length} 个角色槽 · ${formatTime(policy.updatedAt)}`
    }))
  ];
  const issues = [
    !draft.supervisorEmployeeId ? "未选择领队 Employee" : undefined,
    !draft.policyId ? "未绑定活动管理策略" : undefined,
    draft.members.length === 0 ? "成员角色清册为空" : undefined,
    draft.members.some((member) => !member.roleId || !member.employeeId) ? "成员角色或 Employee 尚未分派" : undefined,
    new Set(draft.members.map((member) => member.roleId)).size !== draft.members.length ? "成员角色槽重复" : undefined
  ].filter((issue): issue is string => Boolean(issue));
  const setMember = (index: number, patch: Partial<MemberDraft>) => setDraft((current) => ({
    ...current,
    members: current.members.map((member, memberIndex) => memberIndex === index ? { ...member, ...patch } : member)
  }));
  const selectPolicy = (policyId: string) => {
    const policy = policies.find((candidate) => candidate.id === policyId);
    setPolicyVersions(policy ? [policy] : []);
    setRosterNotice(policy ? `成员清册已按策略 ${policy.id} v${policy.version} 的角色槽对齐。` : "");
    setDraft((current) => ({
      ...current,
      policyId,
      policyVersion: policy?.version ?? 1,
      members: memberDrafts(policy, employees, current.members)
    }));
  };
  const selectPolicyVersion = (value: string) => {
    const requestedVersion = Number(value);
    const version = selectablePolicyVersions.find((candidate) => candidate.version === requestedVersion)
      ?? (selectedPolicy?.version === requestedVersion ? selectedPolicy : undefined);
    if (!version) return;
    setRosterNotice(`成员清册已按策略 ${version.id} v${version.version} 的角色槽重建；同名角色保留原 Employee 分配。`);
    setDraft((current) => ({
      ...current,
      policyVersion: version.version,
      members: memberDrafts(version, employees, current.members)
    }));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        id: draft.id.trim(),
        architecture: "supervisor",
        description: draft.description.trim(),
        supervisor: { employeeId: draft.supervisorEmployeeId },
        managementPolicy: { id: draft.policyId, version: Number(draft.policyVersion) },
        members: draft.members.map((member) => ({
          roleId: member.roleId.trim(),
          description: member.description.trim(),
          employeeId: member.employeeId
        })),
        inputSchema: parseObject(draft.inputSchema || "{}", "Input Schema")
      };
      const saved = workflow
        ? await api<SupervisorWorkflow>(`/api/workflows/${workflow.id}`, writeBody(payload, "PATCH"))
        : await api<SupervisorWorkflow>("/api/workflows", writeBody(payload));
      notify(workflow ? `领队团队已另存为 v${saved.version}` : `领队团队 ${saved.id} 已建立`);
      onSaved(saved);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setSaving(false); }
  };
  return <Modal title={workflow ? `修订 ${workflow.id}` : "建立领队团队"} eyebrow="TEAM LEAD → POLICY → TEAM" onClose={onClose} wide>
    <form className="editor-form supervisor-editor" onSubmit={submit}>
      <fieldset className="daemon-write-surface" disabled={!daemonAvailable}>
        <section className="workflow-basics"><div className="section-kicker"><b>01</b><span>定义团队</span></div><div className="form-grid workflow-basics-grid">
          <Field label="Workflow ID"><input required pattern="[a-z][a-z0-9-]*" disabled={Boolean(workflow)} value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></Field>
          <Field label="说明"><input required value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field>
          <Field label="领队 Employee"><SelectControl ariaLabel="选择领队 Employee" value={draft.supervisorEmployeeId} invalid={!draft.supervisorEmployeeId} options={[{ value: "", label: "选择领队", disabled: true }, ...employees.map((employee) => ({ value: employee.id, label: employee.identity.displayName, description: `${employee.providerId} · v${employee.version}` }))]} onChange={(supervisorEmployeeId) => setDraft({ ...draft, supervisorEmployeeId })} /></Field>
        </div></section>
        <section className="workflow-contract"><div className="section-kicker"><b>02</b><span>固定管理策略版本</span></div><div className="form-grid workflow-basics-grid">
          <Field label="管理策略"><SelectControl ariaLabel="选择管理策略" value={draft.policyId} invalid={!draft.policyId} options={[{ value: "", label: policies.length ? "选择策略" : "暂无活动策略", disabled: true }, ...policies.map((policy) => ({ value: policy.id, label: policy.displayName, description: `${policy.id} · 当前 v${policy.version}` }))]} onChange={selectPolicy} /></Field>
          <Field label="固定版本"><SelectControl ariaLabel="选择管理策略固定版本" value={String(draft.policyVersion)} options={policyVersionOptions} onChange={selectPolicyVersion} /></Field>
        </div>{workflow && selectedPolicy && workflow.managementPolicy.id === selectedPolicy.id && workflow.managementPolicy.version !== selectedPolicy.version && <div className="policy-upgrade-note"><span>当前团队固定 v{workflow.managementPolicy.version}；策略库最新为 v{selectedPolicy.version}。升级会按新版本角色槽重建成员清册。</span><button type="button" className="text-button" onClick={() => selectPolicyVersion(String(selectedPolicy.version))}>显式升级</button></div>}</section>
        <section className="workflow-contract"><div className="section-kicker"><b>03</b><span>成员角色绑定</span></div>{rosterNotice && <div className="policy-roster-notice" role="status">{rosterNotice}</div>}<div className="supervisor-member-editor">{draft.members.map((member, index) => <article key={`${member.roleId}-${index}`}>
          <Field label="角色槽 ID"><input required pattern="[a-z][a-z0-9-]*" value={member.roleId} onChange={(event) => setMember(index, { roleId: event.target.value })} /></Field>
          <Field label="职责"><input required value={member.description} onChange={(event) => setMember(index, { description: event.target.value })} /></Field>
          <Field label="Employee"><SelectControl ariaLabel={`为 ${member.roleId || "成员"} 选择 Employee`} value={member.employeeId} invalid={!member.employeeId} options={[{ value: "", label: "选择员工", disabled: true }, ...employees.map((employee) => ({ value: employee.id, label: employee.identity.displayName, description: `v${employee.version}` }))]} onChange={(employeeId) => setMember(index, { employeeId })} /></Field>
          <button type="button" className="text-button danger-text" disabled={draft.members.length === 1} onClick={() => setDraft({ ...draft, members: draft.members.filter((_, memberIndex) => memberIndex !== index) })}>移除</button>
        </article>)}</div><button type="button" className="button secondary" onClick={() => setDraft({ ...draft, members: [...draft.members, { roleId: `member-${draft.members.length + 1}`, description: "执行领队派发的专业任务。", employeeId: employees[0]?.id ?? "" }] })}><UtilityIcon name="add" />添加角色槽</button></section>
        <section className="workflow-contract"><div className="section-kicker"><b>04</b><span>输入契约</span></div><Field label="Input JSON Schema"><textarea className="mono" rows={6} value={draft.inputSchema} onChange={(event) => setDraft({ ...draft, inputSchema: event.target.value })} /></Field></section>
        {issues.length > 0 && <div className="canvas-issues" role="alert">{issues.map((issue) => <span key={issue}>{issue}</span>)}</div>}
      </fieldset>
      <div className="editor-savebar"><span className="editor-save-note">领队、策略和成员 Employee 都会固定版本；运行时路径由领队动态生成。</span><button type="button" className="button secondary" onClick={onClose}>放弃修改</button><button className="button primary" disabled={saving || !daemonAvailable || issues.length > 0}>{saving ? "校验中…" : workflow ? `校验并另存为 v${workflow.version + 1}` : "校验并建立"}</button></div>
    </form>
  </Modal>;
}

export function SupervisorWorkflowPage({ data, refresh, notify }: PageProps) {
  const daemonAvailable = useDaemonAvailable();
  const workflows = data.workflows.filter((workflow): workflow is SupervisorWorkflow => workflow.architecture === "supervisor");
  const [selectedId, setSelectedId] = useState(workflows.find((workflow) => workflow.status === "active")?.id ?? workflows[0]?.id ?? "");
  const selected = workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0];
  const [versions, setVersions] = useState<SupervisorWorkflow[]>([]);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [runInput, setRunInput] = useState("{\n  \"message\": \"请领队组织团队完成这项任务\"\n}");
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!selected) { setVersions([]); return; }
    api<{ versions: Workflow[] }>(`/api/workflows/${selected.id}`)
      .then((detail) => setVersions(detail.versions.filter((version): version is SupervisorWorkflow => version.architecture === "supervisor")))
      .catch(() => setVersions([selected]));
  }, [selected?.id, selected?.version]);
  const manager = data.employees.find((employee) => employee.id === selected?.supervisor.employeeId);
  const policy = (data.managementPolicies ?? []).find((candidate) => candidate.id === selected?.managementPolicy.id);
  const publications = useMemo(() => selected ? activeWorkflowPublications(selected.id, data.publications) : [], [selected?.id, data.publications]);
  const publication = publications[0];
  const sessionPrompts = useMemo(() => selected ? buildWorkflowSessionPrompts(selected, publication) : undefined, [selected, publication]);
  const run = async () => {
    if (!selected) return;
    setRunning(true);
    try {
      const input = parseObject(runInput, "Workflow 输入");
      const receipt = await api<WorkflowStartReceipt>(`/api/workflows/${selected.id}/start`, { ...writeBody(input), headers: { "x-multi-agent-source": "workbench", "x-multi-agent-source-label": "领队协作调试台" } });
      notify(`领队团队工单已受理 · Run ${receipt.runId}（工单 ${receipt.invocation.id}）`);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setRunning(false); }
  };
  const archive = async () => {
    if (!selected) return;
    try { await api(`/api/workflows/${selected.id}/archive`, writeBody({})); notify(`领队团队 ${selected.id} 已归档`); setArchiveOpen(false); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  return <div className="page-grid page-grid--workflows">
    <aside className="record-list"><header className="list-header"><h1>领队团队</h1><button className="square-action" disabled={!daemonAvailable || !(data.managementPolicies ?? []).some((item) => item.status === "active")} onClick={() => setEditor("new")} aria-label="建立领队团队"><UtilityIcon name="add" /></button></header><div className="architecture-summary"><span>{workflows.filter((workflow) => workflow.status === "active").length} 个活动团队</span><small>动态控制循环</small></div><div className="record-scroll workflow-list">{workflows.map((workflow) => <button className={`workflow-card ${selected?.id === workflow.id ? "selected" : ""}`} key={workflow.id} onClick={() => setSelectedId(workflow.id)}><div><strong>{workflow.id}</strong><span>{workflow.description}</span><small>{workflow.members.length} 个成员角色 · 策略 {workflow.managementPolicy.id} v{workflow.managementPolicy.version}</small></div><Stamp status={workflow.status} /></button>)}{workflows.length === 0 && <div className="mini-empty">尚无领队团队。</div>}</div><footer className="list-footer"><span>{workflows.length} 份团队编排</span><span>LEAD TEAM v1</span></footer></aside>
    <main className="detail-pane">{!selected ? <EmptyState title="建立第一支领队团队" action={<button className="button primary" disabled={!daemonAvailable || !(data.managementPolicies ?? []).some((item) => item.status === "active")} onClick={() => setEditor("new")}>建立领队团队</button>}>先在管理策略库登记策略，再固定一位领队和多个成员角色。实际派工路径只会在运行时生成。</EmptyState> : <div className="dossier workflow-dossier">
      <header className="dossier-cover"><div className="file-index"><span>LEAD TEAM WORKFLOW RECORD</span><code>No. {selected.id.toUpperCase()}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">领</div><div><h2>{selected.id}</h2><p>{selected.description}</p></div><Stamp status={selected.status} /></div><div className="dossier-actions"><button className="button primary" disabled={!daemonAvailable || running || selected.status === "archived"} onClick={() => scrollRecordIntoView("run-supervisor-workflow")}>运行团队</button><button className="button secondary" disabled={!daemonAvailable} onClick={() => setEditor("edit")}>修订团队</button><button className="button danger" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setArchiveOpen(true)}>归档</button></div></header>
      <DossierSection number="01" title="领队与管理策略"><div className="supervisor-control-card"><EmployeeAvatar displayName={manager?.identity.displayName ?? selected.supervisor.employeeId} presentation={manager?.presentation} /><div><span>TEAM LEAD EMPLOYEE</span><strong>{manager?.identity.displayName ?? selected.supervisor.employeeId}</strong><small>{selected.supervisor.employeeId} · 固定 v{selected.supervisor.employeeVersion}</small></div><div className="policy-pin"><span>MANAGEMENT POLICY</span><strong>{policy?.displayName ?? selected.managementPolicy.id}</strong><small>{selected.managementPolicy.id} · 固定 v{selected.managementPolicy.version}{policy && policy.version !== selected.managementPolicy.version ? ` · 最新 v${policy.version}` : ""}</small></div></div></DossierSection>
      <DossierSection number="02" title="成员角色绑定"><div className="node-ledger">{selected.members.map((member, index) => { const employee = data.employees.find((candidate) => candidate.id === member.employeeId); return <article key={member.roleId}><span className="node-number">{String(index + 1).padStart(2, "0")}</span><EmployeeAvatar className="small" displayName={employee?.identity.displayName ?? member.employeeId} presentation={employee?.presentation} /><div><strong>{member.roleId}</strong><span>{member.description}</span></div><code>{employee?.identity.displayName ?? member.employeeId} · v{member.employeeVersion}</code></article>; })}</div></DossierSection>
      <DossierSection number="03" title="运行时执行图"><div className="dynamic-graph-note"><div className="dynamic-graph-seed"><span>初始节点</span><strong>supervisor-r1</strong></div><span className="dynamic-graph-arrow">→</span><div><strong>运行中增量生长</strong><p>领队每轮输出结构化 delegate / finish 决策。成员节点与下一轮领队节点写入 Run 证据；这里不预画不存在的静态 DAG。</p></div></div></DossierSection>
      <DossierSection number="04" title="版本"><div className="version-strip">{versions.map((version) => <div key={version.version} className={version.version === selected.version ? "current" : ""}><code>v{version.version}</code><span>{version.version === selected.version ? "当前" : version.status === "archived" ? "归档" : "历史"}</span><time>{formatTime(version.updatedAt)}</time></div>)}</div></DossierSection>
      {sessionPrompts && <DossierSection number="05" title="其他会话使用" action={<Stamp status={publication ? "active" : "pending"} label={publication ? "稳定调用包" : "调试入口"} />}><div className="workflow-session-examples"><ReadonlyEvidence label="给 Codex 会话的提示词 · 推荐" value={sessionPrompts.humanPrompt} /><ReadonlyEvidence label={`MCP 参数示例 · ${sessionPrompts.tool}`} value={sessionPrompts.mcpJson} mono /></div></DossierSection>}
      <section id="run-supervisor-workflow" className="run-order"><header><div><p className="record-meta">{selected.id} · v{selected.version}</p><h3>签发领队运行工单</h3></div><Stamp status={running ? "running" : "pending"} label={running ? "提交回执" : "待签发"} /></header><Field label="Workflow 输入 (JSON)"><textarea className="mono" rows={8} disabled={!daemonAvailable} value={runInput} onChange={(event) => setRunInput(event.target.value)} /></Field><div className="run-actions"><span>策略上限耗尽会记为 blocked；领队决策或 Provider 技术故障才记为 failed。</span><button className="button primary" disabled={!daemonAvailable || running || selected.status === "archived"} onClick={() => void run()}>{running ? "提交回执…" : "签发并运行"}</button></div></section>
    </div>}</main>
    {editor && <SupervisorEditor workflow={editor === "edit" ? selected : undefined} data={data} notify={notify} onClose={() => setEditor(null)} onSaved={async (saved) => { setEditor(null); setSelectedId(saved.id); await refresh(); }} />}
    {archiveOpen && selected && <Modal title="归档领队团队" eyebrow={`${selected.id} · 保留历史`} onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>历史版本、策略固定和动态 Run 证据都会保留。</b><p>归档后不能签发新的领队运行工单。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveOpen(false)}>取消</button><button className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive()}>确认归档</button></div></div></Modal>}
  </div>;
}
