import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, writeBody } from "./api";
import {
  DossierSection,
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
  useDaemonAvailable
} from "./components";
import type {
  Bootstrap,
  Employee,
  PassiveProjectAccess,
  Project,
  ProjectBinding,
  ProjectBindingUpdatePolicy,
  ProjectRoleContract,
  SkillBinding
} from "./types";

interface PageProps {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
  /** 统一项目页从目录 Tab 打开接入配置时，保持同一个 projectId。 */
  initialProjectId?: string;
  /** 父级每次递增时直接打开接入声明 Modal。 */
  connectRequest?: number;
  onConnectRequestHandled?: () => void;
}

interface RoleDraft {
  employeeId: string;
  skillIds: string[];
  knowledgeProfileIds: string[];
  updatePolicy: ProjectBindingUpdatePolicy;
}

function bindingId(binding: SkillBinding): string {
  return typeof binding === "string" ? binding : binding.id;
}

function bindingEnabled(binding: SkillBinding): boolean {
  return typeof binding === "string" || binding.enabled !== false;
}

function employeeSkillIds(employee: Employee | undefined): string[] {
  return employee?.skills.filter(bindingEnabled).map(bindingId) ?? [];
}

function defaultSkillIds(role: ProjectRoleContract, employee: Employee | undefined): string[] {
  const available = new Set(employeeSkillIds(employee));
  return [...role.requiredSkills, ...role.optionalSkills].filter((id) => available.has(id));
}

function initialRoleDrafts(project: Project, binding: ProjectBinding | undefined, employees: Employee[]): Record<string, RoleDraft> {
  return Object.fromEntries(project.roles.map((role) => {
    const existing = binding?.roles.find((candidate) => candidate.roleId === role.id);
    const employee = employees.find((candidate) => candidate.id === existing?.employeeId);
    return [role.id, {
      employeeId: existing?.employeeId ?? "",
      skillIds: existing ? existing.skills.filter(bindingEnabled).map(bindingId) : defaultSkillIds(role, employee),
      knowledgeProfileIds: existing?.knowledgeProfileIds ?? role.knowledgeProfileIds ?? [],
      updatePolicy: existing?.updatePolicy ?? "compatible"
    }];
  }));
}

function roleReadiness(
  role: ProjectRoleContract,
  draft: RoleDraft | undefined,
  employee: Employee | undefined,
  activeKnowledgeProfileIds: Set<string>
): {
  ready: boolean;
  label: string;
  missing: string[];
  invalidKnowledgeProfiles: string[];
} {
  if (!draft?.employeeId || !employee) {
    return { ready: false, label: "待分派", missing: role.requiredSkills, invalidKnowledgeProfiles: [] };
  }
  const available = new Set(employeeSkillIds(employee));
  const selected = new Set(draft.skillIds);
  const missing = role.requiredSkills.filter((skill) => !available.has(skill) || !selected.has(skill));
  const invalidKnowledgeProfiles = draft.knowledgeProfileIds.filter((profileId) => !activeKnowledgeProfileIds.has(profileId));
  if (missing.length) return { ready: false, label: `缺少 ${missing.length} 项能力`, missing, invalidKnowledgeProfiles };
  if (invalidKnowledgeProfiles.length) {
    return { ready: false, label: `知识策略不可用`, missing: [], invalidKnowledgeProfiles };
  }
  return { ready: true, label: "契约匹配", missing: [], invalidKnowledgeProfiles: [] };
}

function policyLabel(policy: ProjectBindingUpdatePolicy): string {
  if (policy === "locked") return "锁定版本";
  if (policy === "latest") return "始终最新";
  return "兼容更新";
}

export function ProjectPage({ data, refresh, notify, initialProjectId, connectRequest = 0, onConnectRequestHandled }: PageProps) {
  const daemonAvailable = useDaemonAvailable();
  // Lightweight page clock so a short-lived "completed" chip actually fades
  // after its dwell while someone stays on this page. Cleaned up on unmount.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const activeProjects = data.projects.filter((project) => project.status === "active");
  const passiveProjectAccesses = data.passiveProjectAccesses ?? [];
  const unlinkedPassiveAccesses = passiveProjectAccesses.filter((access) => !access.linkedProjectId);
  const passiveAccessByProjectId = new Map(
    passiveProjectAccesses
      .filter((access): access is PassiveProjectAccess & { linkedProjectId: string } => Boolean(access.linkedProjectId))
      .map((access) => [access.linkedProjectId, access])
  );
  const assignableEmployees = data.employees.filter((employee) => employee.status === "active");
  const [selectedId, setSelectedId] = useState(initialProjectId ?? activeProjects[0]?.id ?? data.projects[0]?.id ?? "");
  const selected = data.projects.find((project) => project.id === selectedId) ?? data.projects[0];
  const binding = data.projectBindings.find((candidate) => candidate.projectId === selected?.id);
  const [connectOpen, setConnectOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [invokeRoleId, setInvokeRoleId] = useState<string>();
  const [connectDraft, setConnectDraft] = useState({ rootPath: "", descriptorPath: "multi-agent.project.yaml" });
  const [roleDrafts, setRoleDrafts] = useState<Record<string, RoleDraft>>({});
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [invokeMessage, setInvokeMessage] = useState("请按项目验收契约检查当前改动，并给出可追溯的结论。");
  const [invokeResult, setInvokeResult] = useState("");
  const [invoking, setInvoking] = useState(false);
  const origin = typeof window === "undefined" ? "http://127.0.0.1:4318" : window.location.origin;
  const activeKnowledgeProfileIds = useMemo(
    () => new Set((data.knowledgeProfiles ?? []).filter((profile) => profile.status === "active").map((profile) => profile.id)),
    [data.knowledgeProfiles]
  );

  useEffect(() => {
    if (!selected) return;
    setRoleDrafts(initialRoleDrafts(selected, binding, data.employees));
  }, [selected?.id, selected?.version, binding?.version, data.employees]);
  useEffect(() => {
    if (initialProjectId) setSelectedId(initialProjectId);
  }, [initialProjectId]);
  useEffect(() => {
    if (connectRequest > 0) {
      setConnectDraft({ rootPath: "", descriptorPath: "multi-agent.project.yaml" });
      setConnectOpen(true);
      onConnectRequestHandled?.();
    }
  }, [connectRequest, onConnectRequestHandled]);

  const readiness = useMemo(() => selected?.roles.map((role) => {
    const draft = roleDrafts[role.id];
    const employee = data.employees.find((candidate) => candidate.id === draft?.employeeId);
    return { role, draft, employee, ...roleReadiness(role, draft, employee, activeKnowledgeProfileIds) };
  }) ?? [], [selected, roleDrafts, data.employees, activeKnowledgeProfileIds]);
  const complete = readiness.length > 0 && readiness.every((item) => item.ready);
  const updates = binding?.roles.filter((role) => {
    const employee = data.employees.find((candidate) => candidate.id === role.employeeId);
    return employee && employee.version > role.employeeVersion;
  }).length ?? 0;

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const project = await api<Project>("/api/projects/connect", writeBody({
        rootPath: connectDraft.rootPath.trim(),
        descriptorPath: connectDraft.descriptorPath.trim() || undefined
      }));
      setSelectedId(project.id);
      setConnectOpen(false);
      notify(`项目 ${project.name} 已接入；接下来分派角色即可`);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };

  const saveBinding = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const saved = await api<ProjectBinding>(`/api/projects/${selected.id}/binding`, writeBody({
        roles: selected.roles.map((role) => ({
          roleId: role.id,
          employeeId: roleDrafts[role.id]?.employeeId,
          skills: roleDrafts[role.id]?.skillIds ?? [],
          knowledgeProfileIds: roleDrafts[role.id]?.knowledgeProfileIds ?? [],
          updatePolicy: roleDrafts[role.id]?.updatePolicy ?? "compatible"
        }))
      }, "PUT"));
      notify(`项目任用关系已保存为 v${saved.version}`);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };

  const refreshBinding = async () => {
    if (!selected) return;
    setSyncing(true);
    try {
      const result = await api<{ changed: boolean; binding: ProjectBinding; roles: Array<{ status: string; message: string }> }>(
        `/api/projects/${selected.id}/binding/refresh`,
        writeBody({})
      );
      const approvals = result.roles.filter((role) => role.status === "approval-required").length;
      notify(result.changed
        ? `已生成任用关系 v${result.binding.version}${approvals ? `；${approvals} 项仍需确认` : ""}`
        : approvals ? `${approvals} 项更新需要人工确认` : "所有任用关系已是当前版本");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSyncing(false);
    }
  };

  const archive = async () => {
    if (!selected) return;
    try {
      await api(`/api/projects/${selected.id}/archive`, writeBody({}));
      setArchiveOpen(false);
      notify(`项目 ${selected.name} 已归档；历史任用与运行证据保留`);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const invoke = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !invokeRoleId) return;
    setInvoking(true);
    setInvokeResult("");
    try {
      const result = await api<{ message: string; runId: string }>(
        `/api/projects/${selected.id}/roles/${invokeRoleId}/invoke`,
        {
          ...writeBody({ message: invokeMessage }),
          headers: {
            "x-multi-agent-source": "workbench",
            "x-multi-agent-source-label": "项目接入调试台",
            "x-multi-agent-project": selected.id
          }
        }
      );
      setInvokeResult(`${result.message}\n\nRun: ${result.runId}`);
      notify(`${selected.roles.find((role) => role.id === invokeRoleId)?.displayName ?? invokeRoleId} 已完成交办`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setInvokeResult(message);
      notify(message, "error");
    } finally {
      setInvoking(false);
    }
  };

  return <div className="page-grid page-grid--projects">
    <aside className="record-list">
      <header className="list-header"><h1>已接入项目</h1><button className="square-action" disabled={!daemonAvailable} onClick={() => setConnectOpen(true)} aria-label="接入项目"><UtilityIcon name="add" /></button></header>
      <div className="list-tools"><span className="project-list-note">声明需求，再分派员工</span><button className="text-button" disabled={!daemonAvailable} onClick={() => setConnectOpen(true)}>读取项目声明</button></div>
      <div className="record-scroll project-list">
        {data.projects.map((project) => {
          const projectBinding = data.projectBindings.find((candidate) => candidate.projectId === project.id);
          const passiveAccess = passiveAccessByProjectId.get(project.id);
          const assignedEmployeeNames = passiveAccess
            ? (projectBinding?.roles ?? [])
                .map((role) => data.employees.find((employee) => employee.id === role.employeeId)?.identity.displayName)
                .filter((name): name is string => Boolean(name))
            : [];
          return <button type="button" key={project.id} className={`project-card ${selected?.id === project.id ? "selected" : ""}`} onClick={() => setSelectedId(project.id)}>
            <span className="project-card-mark" aria-hidden="true">项</span>
            <div><strong>{project.name}</strong><code>{project.id} · v{project.version}</code><small>{projectBinding?.roles.length ?? 0}/{project.roles.length} 个角色已分派 · {project.connector.kind}</small>{passiveAccess && <small>MCP 最近触发 {formatTime(passiveAccess.lastSeenAt)} · {passiveAccess.requestCount} 次请求</small>}{assignedEmployeeNames.length > 0 && <small className="employee-inline">任用员工：{assignedEmployeeNames.join("、")}</small>}</div>
            <Stamp status={project.status} />
          </button>;
        })}
        {data.projects.length === 0 && <div className="mini-empty">尚未正式接入项目。项目只需一份很短的声明文件，不需要复制员工 Prompt。</div>}
        {unlinkedPassiveAccesses.length > 0 && <div className="passive-project-heading"><strong>MCP 被动接入</strong><small>工具请求触发后自动留档；尚未建立角色任用关系。</small></div>}
        {unlinkedPassiveAccesses.map((access) => <article className="project-card passive-project-card" key={access.id}>
          <span className="project-card-mark passive-project-mark" aria-hidden="true">MCP</span>
          <div><strong>{access.displayName}</strong><code>{access.rootPath ?? "未记录工作目录（历史调用）"}</code>{access.projectKeys.length > 0 && <small>项目标识 {access.projectKeys.join(" · ")}</small>}<small>首次 {formatTime(access.firstSeenAt)} · 最近 {formatTime(access.lastSeenAt)}</small><small>{access.requestCount} 次 Workbench 请求</small></div>
          <Stamp status="active" label="被动" />
        </article>)}
      </div>
      <footer className="list-footer"><span>{activeProjects.length} 个正式接入 · {unlinkedPassiveAccesses.length} 个被动记录</span><span>DESCRIPTOR → BINDING</span></footer>
    </aside>

    <main className="detail-pane">
      {!selected ? <EmptyState title="把第一个项目接入员工小镇" action={<button className="button primary" disabled={!daemonAvailable} onClick={() => setConnectOpen(true)}>读取项目声明</button>}>
        {unlinkedPassiveAccesses.length > 0 && <>Workbench 已记录上方 MCP 被动接入；它只证明工具曾被触发，不会自动获得项目角色或权限。</>} 在项目根目录放一份 <code>multi-agent.project.yaml</code>，即可把被动记录升级为正式项目接入。
      </EmptyState> : <div className="dossier project-dossier">
        <header className="dossier-cover">
          <div className="file-index"><span>PROJECT CONNECTION RECORD</span><code>No. {selected.id.toUpperCase()}</code></div>
          <div className="dossier-title-row"><div className="workflow-mark project-mark" aria-hidden="true">接</div><div><h2>{selected.name}</h2><p>{selected.description}</p></div><Stamp status={selected.status} /></div>
          <div className="dossier-actions"><button className="button secondary" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => { setConnectDraft({ rootPath: selected.rootPath, descriptorPath: selected.descriptorPath }); setConnectOpen(true); }}>重新读取声明</button><button className="button danger" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setArchiveOpen(true)}>归档项目</button></div>
        </header>

        <DossierSection number="01" title="项目声明"><dl className="ledger project-ledger"><dt>项目范围</dt><dd>{selected.scope === "repository" ? "代码仓库" : "当前工作区"}</dd><dt>项目根目录</dt><dd><code>{selected.rootPath}</code></dd><dt>声明文件</dt><dd><code>{selected.descriptorPath}</code></dd><dt>接入器</dt><dd><code>{selected.connector.kind}</code></dd><dt>声明版本</dt><dd>v{selected.version} · {formatTime(selected.updatedAt)}</dd></dl></DossierSection>

        <DossierSection number="02" title="角色与员工关联" action={<div className="project-binding-actions"><span>{binding ? `任用关系 v${binding.version}` : "尚未保存"}</span>{updates > 0 && <button type="button" className="text-button" disabled={!daemonAvailable || syncing} onClick={() => void refreshBinding()}>{syncing ? "同步中…" : `${updates} 项兼容更新`}</button>}</div>}>
          <div className="project-role-list">
            {readiness.map(({ role, draft, employee, ready, label, missing, invalidKnowledgeProfiles }) => {
              const existing = binding?.roles.find((candidate) => candidate.roleId === role.id);
              const employeeRuntimeState = employee ? employeeRuntimeStatus(data.activity.instances.filter((instance) => instance.employeeId === employee.id), clock) : "idle";
              const selectableSkills = [...new Set([...role.requiredSkills, ...role.optionalSkills])];
              const selectableKnowledgeProfiles = role.knowledgeProfileIds ?? [];
              return <article className={`project-role-row ${ready ? "is-ready" : "is-blocked"}`} key={role.id}>
                <header><div><code>{role.id}</code><h4>{role.displayName}</h4><p>{role.description}</p></div><Stamp status={ready ? "active" : "blocked"} label={label} /></header>
                <div className="project-role-fields">
                  <Field label="分派员工" hint={existing ? `当前固定员工 v${existing.employeeVersion}` : "选择一位在册员工；不会复制档案。"}>
                    <SelectControl
                      ariaLabel={`${role.displayName}分派员工`}
                      disabled={!daemonAvailable || selected.status === "archived"}
                      value={draft?.employeeId ?? ""}
                      options={[
                        { value: "", label: assignableEmployees.length ? "选择员工" : "暂无在册员工", description: assignableEmployees.length ? "从在册员工中分派" : "请先建立或恢复员工档案", disabled: assignableEmployees.length === 0 },
                        ...assignableEmployees.map((employeeOption) => {
                          const missingCount = role.requiredSkills.filter((skill) => !employeeSkillIds(employeeOption).includes(skill)).length;
                          return {
                            value: employeeOption.id,
                            label: employeeOption.identity.displayName,
                            description: missingCount ? `缺少 ${missingCount} 项必需能力` : `v${employeeOption.version} · 契约可用`
                          };
                        })
                      ]}
                      onChange={(employeeId) => {
                      const nextEmployee = data.employees.find((candidate) => candidate.id === employeeId);
                      setRoleDrafts((current) => ({ ...current, [role.id]: {
                        employeeId,
                        skillIds: defaultSkillIds(role, nextEmployee),
                        knowledgeProfileIds: current[role.id]?.knowledgeProfileIds ?? selectableKnowledgeProfiles,
                        updatePolicy: current[role.id]?.updatePolicy ?? "compatible"
                      } }));
                      }}
                    />
                  </Field>
                  <Field label="更新策略" hint="兼容更新只同步身份与提示词等安全变更；Provider、权限和输出契约变化需确认。">
                    <SelectControl
                      ariaLabel={`${role.displayName}更新策略`}
                      disabled={!daemonAvailable || selected.status === "archived"}
                      value={draft?.updatePolicy ?? "compatible"}
                      options={[
                        { value: "compatible", label: "兼容更新（推荐）", description: "安全变更自动同步，契约变化需确认" },
                        { value: "locked", label: "锁定版本", description: "始终保留当前固定版本" },
                        { value: "latest", label: "始终最新", description: "每次刷新尝试采用员工最新版本" }
                      ]}
                      onChange={(updatePolicy) => setRoleDrafts((current) => ({ ...current, [role.id]: { ...(current[role.id] ?? { employeeId: "", skillIds: [], knowledgeProfileIds: selectableKnowledgeProfiles }), updatePolicy: updatePolicy as ProjectBindingUpdatePolicy } }))}
                    />
                  </Field>
                </div>
                {employee && <div className="project-employee-preview"><EmployeeAvatar displayName={employee.identity.displayName} presentation={employee.presentation} /><div><strong>{employee.identity.displayName}</strong><code>{employee.id} · 当前 v{employee.version}</code></div><span className="project-employee-flags">{employeeRuntimeState !== "idle" && <RuntimeStatusChip status={employeeRuntimeState} />}{existing && employee.version > existing.employeeVersion && <span className="project-update-flag">可更新 v{existing.employeeVersion} → v{employee.version}</span>}</span></div>}
                <div className="project-skill-choice"><span>本项目启用的 Skill</span>{selectableSkills.length ? selectableSkills.map((skillId) => {
                  const available = employeeSkillIds(employee).includes(skillId);
                  const required = role.requiredSkills.includes(skillId);
                  const checked = draft?.skillIds.includes(skillId) ?? false;
                  const skill = data.skills.find((candidate) => candidate.id === skillId);
                  return <label className={!available ? "is-missing" : ""} key={skillId}><input type="checkbox" checked={checked} disabled={!daemonAvailable || !available || required || selected.status === "archived"} onChange={(event) => setRoleDrafts((current) => {
                    const currentRole = current[role.id] ?? { employeeId: "", skillIds: [], knowledgeProfileIds: selectableKnowledgeProfiles, updatePolicy: "compatible" };
                    const skillIds = event.target.checked ? [...new Set([...currentRole.skillIds, skillId])] : currentRole.skillIds.filter((id) => id !== skillId);
                    return { ...current, [role.id]: { ...currentRole, skillIds } };
                  })} /><span>{skill?.displayName ?? skillId}<small>{required ? "必需" : "可选"}{!available ? " · 员工未配置" : ""}</small></span></label>;
                }) : <small>此角色不要求额外 Skill，只使用员工稳定身份与项目策略。</small>}</div>
                <div className="project-knowledge-choice"><span>本项目临时追加的知识 Profile</span>{selectableKnowledgeProfiles.length ? selectableKnowledgeProfiles.map((profileId) => {
                  const profile = (data.knowledgeProfiles ?? []).find((candidate) => candidate.id === profileId);
                  const available = profile?.status === "active";
                  const checked = draft?.knowledgeProfileIds.includes(profileId) ?? false;
                  return <label className={!available ? "is-missing" : ""} key={profileId}><input type="checkbox" checked={checked} disabled={!daemonAvailable || !available || selected.status === "archived"} onChange={(event) => setRoleDrafts((current) => {
                    const currentRole = current[role.id] ?? { employeeId: "", skillIds: [], knowledgeProfileIds: [], updatePolicy: "compatible" };
                    const knowledgeProfileIds = event.target.checked
                      ? [...new Set([...currentRole.knowledgeProfileIds, profileId])]
                      : currentRole.knowledgeProfileIds.filter((id) => id !== profileId);
                    return { ...current, [role.id]: { ...currentRole, knowledgeProfileIds } };
                  })} /><span>{profile?.displayName ?? profileId}<small>{available ? `Profile v${profile.version} · 仅当前项目角色生效` : "Profile 缺失或已归档"}</small></span></label>;
                }) : <small>项目声明未追加知识策略；只沿用员工自身 Profile。</small>}</div>
                {missing.length > 0 && <p className="project-role-error">需要先给员工配置：{missing.join("、")}</p>}
                {invalidKnowledgeProfiles.length > 0 && <p className="project-role-error">知识 Profile 不可用，请修复声明或取消选择：{invalidKnowledgeProfiles.join("、")}</p>}
                {existing && ready && <footer><span>{policyLabel(existing.updatePolicy)} · 固定员工 v{existing.employeeVersion}</span><button type="button" className="text-button" disabled={!daemonAvailable} onClick={() => { setInvokeRoleId(role.id); setInvokeResult(""); }}>交办测试</button></footer>}
              </article>;
            })}
          </div>
          <div className="project-binding-save"><div><strong>{complete ? "所有角色契约已满足" : "还有角色尚未准备好"}</strong><span>保存员工引用、版本策略、Skill 子集和项目临时知识 Profile。</span></div><button type="button" className="button primary" disabled={!daemonAvailable || !complete || saving || selected.status === "archived"} onClick={() => void saveBinding()}>{saving ? "保存中…" : binding ? `保存为任用关系 v${binding.version + 1}` : "建立任用关系"}</button></div>
        </DossierSection>

        <DossierSection number="03" title="项目如何调用"><div className="project-callout"><strong>项目不需要复制 Prompt。</strong><p>运行时由 Workbench 合成员工身份、此项目的角色策略、已选 Skill、当前任务与会话历史，并把最终 Prompt 和结果写入 Run 证据。</p></div><ReadonlyEvidence label="MCP · 对话中调用" value={JSON.stringify({ tool: "invoke_project_role", arguments: { projectId: selected.id, roleId: selected.roles[0]?.id ?? "role-id", message: "在这里填写任务" } }, null, 2)} mono /><ReadonlyEvidence label="HTTP / SDK · 项目运行时调用" value={`POST ${origin}/api/projects/${selected.id}/roles/${selected.roles[0]?.id ?? "role-id"}/invoke\nContent-Type: application/json\n\n{"message":"在这里填写任务"}`} mono /></DossierSection>
        <DossierSection number="04" title="版本与生效范围"><dl className="ledger"><dt>项目声明</dt><dd>v{selected.version}</dd><dt>任用关系</dt><dd>{binding ? `v${binding.version}（基于项目 v${binding.projectVersion}）` : "未建立"}</dd><dt>进行中的会话</dt><dd>继续使用启动时固定的项目、任用、员工和 Skill 版本</dd><dt>新增 Skill</dt><dd>只显示为可选能力，不会自动在项目中启用</dd></dl></DossierSection>
      </div>}
    </main>

    {connectOpen && <Modal title={selected && connectDraft.rootPath ? "重新读取项目声明" : "接入项目"} eyebrow="DESCRIPTOR · NO PROMPT COPY" onClose={() => setConnectOpen(false)}><form className="modal-body compact-form" onSubmit={connect}><div className="project-connect-note"><strong>项目只提交一张“需求卡”。</strong><p>员工档案、完整 Skill 和 Provider 都留在 Workbench；声明文件只写项目 ID、角色槽位以及策略文件引用。</p></div><Field label="项目根目录"><input required disabled={!daemonAvailable} placeholder="/path/to/your-project" value={connectDraft.rootPath} onChange={(event) => setConnectDraft({ ...connectDraft, rootPath: event.target.value })} /></Field><Field label="项目声明文件" hint="相对路径会从项目根目录解析。"><input required disabled={!daemonAvailable} value={connectDraft.descriptorPath} onChange={(event) => setConnectDraft({ ...connectDraft, descriptorPath: event.target.value })} /></Field><div className="descriptor-mini-example"><span>声明文件只需类似：</span><pre>{`version: 1\nproject:\n  id: your-project\n  name: 项目名称\nroles:\n  tester:\n    requiredSkills: [browser-e2e-validation]\n    policyRef: docs/agents/tester.md`}</pre></div><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setConnectOpen(false)}>取消</button><button className="button primary" disabled={!daemonAvailable || saving}>{saving ? "读取中…" : "读取并接入"}</button></div></form></Modal>}
    {archiveOpen && selected && <Modal title="归档项目接入" eyebrow={`${selected.id} · 保留历史`} onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>归档后停止新的项目角色调用。</b><p>项目声明版本、任用关系、员工档案和已有 Run 证据都会保留。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveOpen(false)}>取消</button><button className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive()}>确认归档</button></div></div></Modal>}
    {invokeRoleId && selected && <Modal title={`交办给 ${selected.roles.find((role) => role.id === invokeRoleId)?.displayName ?? invokeRoleId}`} eyebrow={`${selected.id} · ${invokeRoleId}`} onClose={() => setInvokeRoleId(undefined)}><form className="modal-body compact-form" onSubmit={invoke}><Field label="任务"><textarea required rows={6} disabled={!daemonAvailable || invoking} value={invokeMessage} onChange={(event) => setInvokeMessage(event.target.value)} /></Field>{invokeResult && <ReadonlyEvidence label="本次返回" value={invokeResult} mono />}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setInvokeRoleId(undefined)}>关闭</button><button className="button primary" disabled={!daemonAvailable || invoking}>{invoking ? "执行中…" : "通过项目关系交办"}</button></div></form></Modal>}
  </div>;
}
