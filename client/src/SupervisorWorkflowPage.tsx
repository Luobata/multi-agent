import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, writeBody } from "./api";
import { DossierSection, EmployeeAvatar, EmptyState, Field, Modal, SelectControl, Stamp, SwitchControl, UtilityIcon, formatTime, scrollRecordIntoView, useDaemonAvailable } from "./components";
import { SupervisorDagCanvas } from "./SupervisorDagCanvas";
import { SupervisorDagEditorCanvas } from "./SupervisorDagEditorCanvas";
import { WorkflowSessionGuide } from "./WorkflowSessionGuide";
import {
  automaticDagPositions,
  buildSupervisorFlowPayload,
  dagNodeDrafts,
  dagNodeKindDescriptions,
  dagNodeKindLabels,
  dagPayloadFromDrafts,
  dagWorkKindLabels,
  defaultDagWorkKind,
  emptyDagNodeDraft,
  renameDagPosition,
  resolveDagPositions,
  scaffoldDagDrafts,
  scaffoldDagRoleIds,
  supervisorDagDraftIssues,
  DAG_NODE_KINDS,
  DAG_WORK_KINDS,
  type DagNodeDraft,
  type DagNodePositions
} from "./supervisorDag";
import { activeWorkflowPublications, buildWorkflowSessionPrompts } from "./workflowSessionPrompts";
import type { Bootstrap, Employee, InvocationRecord, JsonObject, ManagementPolicy, SupervisorDagNodeKind, SupervisorGate, SupervisorWorkflow, SupervisorWorkKind, Workflow } from "./types";

interface PageProps {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
}

interface MemberDraft {
  /** 稳定的列表 identity，不随 roleId 等可编辑字段变化，保证输入时不重挂载、不失焦。 */
  key: string;
  roleId: string;
  description: string;
  employeeId: string;
}

let memberDraftKeyCounter = 0;
function nextMemberDraftKey(): string {
  memberDraftKeyCounter += 1;
  return `member-draft-${memberDraftKeyCounter}`;
}

function newMemberDraft(roleId: string, description: string, employeeId: string): MemberDraft {
  return { key: nextMemberDraftKey(), roleId, description, employeeId };
}

/** 把服务端英文校验错误翻译为可读的中文摘要；原始信息仍完整保留在详情里。 */
function summarizeSubmitError(message: string): string {
  const notAllowed = /supervisor member role (\S+) is not allowed by management policy (\S+) v(\d+)/.exec(message);
  if (notAllowed) return `成员角色槽 ${notAllowed[1]} 未被管理策略 ${notAllowed[2]} v${notAllowed[3]} 允许，请改用策略声明的角色槽。`;
  const duplicate = /duplicate supervisor member role (\S+)/.exec(message);
  if (duplicate) return `成员角色槽 ${duplicate[1]} 重复，请为每个角色槽使用唯一 ID。`;
  if (/management policy \S+ is archived/.test(message)) return "所选管理策略已归档，请改用活动策略后再保存。";
  if (/management policy .*not found/.test(message)) return "管理策略或其固定版本不存在，请重新选择策略与版本。";
  if (/[一-鿿]/.test(message)) return message;
  return "保存未通过服务端校验，请根据下方原始信息修正后重试。";
}

interface SupervisorDraft {
  id: string;
  description: string;
  supervisorEmployeeId: string;
  policyId: string;
  policyVersion: number;
  members: MemberDraft[];
  gates: SupervisorGate[];
  dagEnabled: boolean;
  dagNodes: DagNodeDraft[];
  positions: DagNodePositions;
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
  if (!policy) return existing.length ? existing : [newMemberDraft("worker", "执行领队派发的专业任务。", employees[0]?.id ?? "")];
  return policy.allowedRoleIds.map((roleId) => existing.find((member) => member.roleId === roleId) ?? newMemberDraft(
    roleId,
    `负责 ${roleId} 角色槽的专业任务。`,
    employees[0]?.id ?? ""
  ));
}

function supervisorDraft(workflow: SupervisorWorkflow | undefined, employees: Employee[], policies: ManagementPolicy[]): SupervisorDraft {
  const firstPolicy = policies.find((policy) => policy.status === "active");
  const existing = workflow?.members.map((member) => newMemberDraft(member.roleId, member.description, member.employeeId)) ?? [];
  return {
    id: workflow?.id ?? "",
    description: workflow?.description ?? "",
    supervisorEmployeeId: workflow?.supervisor.employeeId ?? employees[0]?.id ?? "",
    policyId: workflow?.managementPolicy.id ?? firstPolicy?.id ?? "",
    policyVersion: workflow?.managementPolicy.version ?? firstPolicy?.version ?? 1,
    members: workflow ? existing : memberDrafts(firstPolicy, employees, existing),
    gates: workflow?.flow.gates.map((gate) => ({ ...gate })) ?? [],
    dagEnabled: Boolean(workflow?.flow.dag),
    dagNodes: dagNodeDrafts(workflow?.flow.dag),
    positions: { ...(workflow?.presentation?.positions ?? {}) },
    inputSchema: JSON.stringify(workflow?.inputSchema ?? {}, null, 2)
  };
}

function OrchestrationFlow({ workflow, data }: { workflow: SupervisorWorkflow; data: Bootstrap }) {
  const loop = workflow.flow.stages.find((stage) => stage.kind === "delegation-loop");
  return <div className="orchestration-flow" aria-label="固定流程与动态分工">
    <div className="orchestration-flow-track">
      {workflow.flow.stages.map((stage, index) => {
        const gate = stage.kind === "gate" ? workflow.flow.gates.find((candidate) => candidate.id === stage.gateId) : undefined;
        return <div className="orchestration-flow-segment" key={stage.id}>
          <article className={`orchestration-stage orchestration-stage--${stage.kind}`}><span>{String(index + 1).padStart(2, "0")}</span><strong>{stage.title}</strong><small>{stage.kind === "supervisor" ? "领队生成计划" : stage.kind === "delegation-loop" ? "领队在此动态拆解、分配与重排" : stage.kind === "delivery" ? "所有硬门禁通过后交付" : `${gate?.requiredCapability ?? "未配置能力"} · ${gate?.required ? "硬门禁" : "可选"}`}</small>{gate && <code>{gate.mode === "after-each-delegation" ? "逐项检查" : "交付前检查"} · {gate.fallback === "supervisor" ? "领队可兜底" : "成员执行"}</code>}</article>
          {index < workflow.flow.stages.length - 1 && <i aria-hidden="true">→</i>}
        </div>;
      })}
    </div>
    <div className="orchestration-team-rail"><header><span>DYNAMIC DELEGATION ZONE</span><strong>{loop?.title ?? "动态分工"}连接当前团队</strong></header><div>{workflow.members.map((member) => { const employee = data.employees.find((candidate) => candidate.id === member.employeeId); return <article key={member.roleId}><span aria-hidden="true">↗</span><EmployeeAvatar className="small" displayName={employee?.identity.displayName ?? member.employeeId} presentation={employee?.presentation} /><div><strong>{employee?.identity.displayName ?? member.employeeId}</strong><small>{member.roleId} · v{member.employeeVersion}</small><p>{employee?.capabilities.length ? employee.capabilities.join(" · ") : "未声明结构化能力"}</p></div></article>; })}</div></div>
    {workflow.flow.dag && <SupervisorDagCanvas dag={workflow.flow.dag} roleDisplay={(roleId) => {
      const member = workflow.members.find((candidate) => candidate.roleId === roleId);
      const employee = member ? data.employees.find((candidate) => candidate.id === member.employeeId) : undefined;
      return employee?.identity.displayName ?? member?.employeeId;
    }} />}
  </div>;
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
  const [submitError, setSubmitError] = useState("");
  const submitErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!submitError) return;
    // Modal 首次打开也会在 animation frame 内聚焦首个字段；把错误聚焦排在其后，避免快速提交时被抢回。
    const frame = window.requestAnimationFrame(() => submitErrorRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [submitError]);
  useEffect(() => {
    setSubmitError("");
  }, [draft]);
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
  // 客户端可确定的固定版本策略（来自版本清册或当前策略），用于在提交前拦截未被允许的成员角色槽。
  const pinnedPolicy = policyVersions.find((policy) => policy.version === draft.policyVersion)
    ?? (selectedPolicy && selectedPolicy.version === draft.policyVersion ? selectedPolicy : undefined);
  const policyRoleIssues = pinnedPolicy
    ? draft.members
        .map((member) => member.roleId.trim())
        .filter((roleId) => roleId && !pinnedPolicy.allowedRoleIds.includes(roleId))
        .map((roleId) => `成员角色槽 ${roleId} 未被管理策略 ${pinnedPolicy.id} v${pinnedPolicy.version} 允许（允许的角色槽：${pinnedPolicy.allowedRoleIds.join("、")}）。`)
    : [];
  // 角色槽只能取自管理策略声明的有限集合，用选择框而非自由输入，从源头杜绝非法角色。
  const allowedRoleIds = pinnedPolicy?.allowedRoleIds ?? [];
  const usedRoleIds = new Set(draft.members.map((member) => member.roleId.trim()).filter(Boolean));
  const nextAvailableRoleId = allowedRoleIds.find((roleId) => !usedRoleIds.has(roleId)) ?? "";
  const roleSlotOptions = (member: MemberDraft) => {
    const own = member.roleId.trim();
    const options = allowedRoleIds
      .filter((roleId) => roleId === own || !usedRoleIds.has(roleId))
      .map((roleId) => ({ value: roleId, label: roleId, description: roleId === own ? "当前角色槽" : "策略允许的角色槽" }));
    // 兜底：历史团队里遗留的、当前策略版本已不允许的角色槽仍需可见，便于用户改选。
    if (own && !allowedRoleIds.includes(own)) options.unshift({ value: own, label: `${own} · 不符合当前策略`, description: "请改选下方策略允许的角色槽" });
    return options.length ? options : [{ value: "", label: allowedRoleIds.length ? "选择角色槽" : "策略未声明角色槽", disabled: true } as { value: string; label: string; disabled?: boolean }];
  };
  const dagIssues = draft.dagEnabled
    ? supervisorDagDraftIssues(draft.dagNodes, new Set(draft.members.map((member) => member.roleId.trim()).filter(Boolean)))
    : [];
  const generalIssues = [
    !draft.supervisorEmployeeId ? "未选择领队 Employee" : undefined,
    !draft.policyId ? "未绑定活动管理策略" : undefined,
    draft.members.length === 0 ? "成员角色清册为空" : undefined,
    draft.members.some((member) => !member.roleId || !member.employeeId) ? "成员角色或 Employee 尚未分派" : undefined,
    new Set(draft.members.map((member) => member.roleId)).size !== draft.members.length ? "成员角色槽重复" : undefined,
    draft.gates.some((gate) => !gate.id || !gate.requiredCapability || !gate.instructions) ? "门禁 ID、能力或执行说明不完整" : undefined,
    new Set(draft.gates.map((gate) => gate.id)).size !== draft.gates.length ? "门禁 ID 重复" : undefined,
    ...dagIssues
  ].filter((issue): issue is string => Boolean(issue));
  const issues = [...generalIssues, ...policyRoleIssues];
  const primaryIssue = policyRoleIssues[0] ?? generalIssues[0];
  const [selectedDagIndex, setSelectedDagIndex] = useState(0);
  const selectedDagNode = draft.dagNodes[selectedDagIndex] ?? draft.dagNodes[0];
  const dagRoleVisual = (roleId: string): { displayName: string; presentation?: Employee["presentation"] } | undefined => {
    const member = draft.members.find((candidate) => candidate.roleId.trim() === roleId);
    if (!member) return undefined;
    const employee = employees.find((candidate) => candidate.id === member.employeeId);
    return {
      displayName: employee?.identity.displayName ?? member.employeeId,
      presentation: employee?.presentation
    };
  };
  const setMember = (index: number, patch: Partial<MemberDraft>) => setDraft((current) => ({
    ...current,
    members: current.members.map((member, memberIndex) => memberIndex === index ? { ...member, ...patch } : member)
  }));
  const setDagNode = (index: number, patch: Partial<DagNodeDraft>) => setDraft((current) => ({
    ...current,
    dagNodes: current.dagNodes.map((node, nodeIndex) => nodeIndex === index ? { ...node, ...patch } : node)
  }));
  const renameDagNode = (index: number, nodeId: string) => setDraft((current) => {
    const oldId = current.dagNodes[index]?.nodeId ?? "";
    const canMovePosition = !current.dagNodes.some((node, nodeIndex) => nodeIndex !== index && node.nodeId === nodeId);
    return {
      ...current,
      positions: canMovePosition ? renameDagPosition(current.positions, oldId, nodeId) : current.positions,
      dagNodes: current.dagNodes.map((node, nodeIndex) => ({
        ...node,
        nodeId: nodeIndex === index ? nodeId : node.nodeId,
        needs: node.needs.map((need) => need === oldId ? nodeId : need)
      }))
    };
  });
  const removeDagNode = (index: number) => setDraft((current) => {
    const removedId = current.dagNodes[index]?.nodeId ?? "";
    const positions = { ...current.positions };
    delete positions[removedId];
    return {
      ...current,
      positions,
      dagNodes: current.dagNodes
        .filter((_, nodeIndex) => nodeIndex !== index)
        .map((node) => ({ ...node, needs: node.needs.filter((need) => need !== removedId) }))
    };
  });
  const toggleDagNeed = (index: number, need: string) => setDraft((current) => ({
    ...current,
    dagNodes: current.dagNodes.map((node, nodeIndex) => nodeIndex !== index ? node : {
      ...node,
      needs: node.needs.includes(need) ? node.needs.filter((candidate) => candidate !== need) : [...node.needs, need]
    })
  }));
  const addDagNode = () => {
    setDraft((current) => ({
      ...current,
      dagNodes: [...current.dagNodes, emptyDagNodeDraft(current.dagNodes.length + 1, current.members[0]?.roleId.trim() ?? "")]
    }));
    setSelectedDagIndex(draft.dagNodes.length);
  };
  const scaffoldNodesForMembers = (members: MemberDraft[]) => scaffoldDagDrafts(scaffoldDagRoleIds(members.map((member) => ({
    roleId: member.roleId,
    capabilities: employees.find((employee) => employee.id === member.employeeId)?.capabilities ?? []
  }))));
  const applyDagScaffold = () => {
    setDraft((current) => {
      const dagNodes = scaffoldNodesForMembers(current.members);
      return { ...current, dagNodes, positions: automaticDagPositions(dagNodes) };
    });
    setSelectedDagIndex(0);
  };
  const connectDagNodes = (sourceIndex: number, targetIndex: number) => {
    setDraft((current) => {
      const sourceId = current.dagNodes[sourceIndex]?.nodeId.trim();
      const target = current.dagNodes[targetIndex];
      if (!sourceId || !target || sourceIndex === targetIndex || target.needs.includes(sourceId)) return current;
      return {
        ...current,
        dagNodes: current.dagNodes.map((node, nodeIndex) => nodeIndex === targetIndex
          ? { ...node, needs: [...node.needs, sourceId] }
          : node)
      };
    });
    setSelectedDagIndex(targetIndex);
  };
  const toggleDag = (enabled: boolean) => setDraft((current) => {
    if (!enabled || current.dagNodes.length > 0) return { ...current, dagEnabled: enabled };
    const dagNodes = scaffoldNodesForMembers(current.members);
    return { ...current, dagEnabled: true, dagNodes, positions: automaticDagPositions(dagNodes) };
  });
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
    // 客户端预检（含策略允许角色槽）未通过时直接阻止提交，不发请求；服务端校验仍然保留。
    if (issues.length > 0) return;
    setSubmitError("");
    setSaving(true);
    try {
      const dagPayload = draft.dagEnabled ? dagPayloadFromDrafts(draft.dagNodes) : undefined;
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
        flow: buildSupervisorFlowPayload(draft.gates, dagPayload),
        ...(dagPayload ? { presentation: { positions: resolveDagPositions(dagPayload.nodes, draft.positions) } } : {}),
        inputSchema: parseObject(draft.inputSchema || "{}", "Input Schema")
      };
      const saved = workflow
        ? await api<SupervisorWorkflow>(`/api/workflows/${workflow.id}`, writeBody(payload, "PATCH"))
        : await api<SupervisorWorkflow>("/api/workflows", writeBody(payload));
      notify(workflow ? `领队团队已另存为 v${saved.version}` : `领队团队 ${saved.id} 已建立`);
      onSaved(saved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSubmitError(message);
    }
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
        <section className="workflow-contract"><div className="section-kicker"><b>03</b><span>成员角色绑定</span></div>{rosterNotice && <div className="policy-roster-notice" role="status">{rosterNotice}</div>}<div className="supervisor-member-editor">{draft.members.map((member, index) => <article key={member.key}>
          <Field label="角色槽 ID" hint="仅可从管理策略声明的角色槽中选择。"><SelectControl ariaLabel={`选择成员 ${index + 1} 的角色槽`} value={member.roleId.trim()} invalid={Boolean(pinnedPolicy && member.roleId.trim() && !pinnedPolicy.allowedRoleIds.includes(member.roleId.trim()))} errorMessage={pinnedPolicy && member.roleId.trim() && !pinnedPolicy.allowedRoleIds.includes(member.roleId.trim()) ? "该角色槽不符合当前管理策略，请改选。" : undefined} options={roleSlotOptions(member)} onChange={(roleId) => setMember(index, { roleId })} /></Field>
          <Field label="职责"><input required value={member.description} onChange={(event) => setMember(index, { description: event.target.value })} /></Field>
          <Field label="Employee"><SelectControl ariaLabel={`为 ${member.roleId || "成员"} 选择 Employee`} value={member.employeeId} invalid={!member.employeeId} options={[{ value: "", label: "选择员工", disabled: true }, ...employees.map((employee) => ({ value: employee.id, label: employee.identity.displayName, description: `v${employee.version}` }))]} onChange={(employeeId) => setMember(index, { employeeId })} /></Field>
          <button type="button" className="text-button danger-text" disabled={draft.members.length === 1} onClick={() => setDraft({ ...draft, members: draft.members.filter((_, memberIndex) => memberIndex !== index) })}>移除</button>
        </article>)}</div>{policyRoleIssues.length > 0 && <div className="member-policy-errors" role="alert"><strong>角色槽不符合当前管理策略</strong>{policyRoleIssues.map((issue) => <span key={issue}>{issue}</span>)}</div>}<button type="button" className="button secondary" disabled={pinnedPolicy ? !nextAvailableRoleId : false} title={pinnedPolicy && !nextAvailableRoleId ? "策略声明的角色槽已全部添加" : undefined} onClick={() => setDraft({ ...draft, members: [...draft.members, newMemberDraft(pinnedPolicy ? nextAvailableRoleId : `member-${draft.members.length + 1}`, "执行领队派发的专业任务。", employees[0]?.id ?? "")] })}><UtilityIcon name="add" />添加角色槽</button></section>
        <section className="workflow-contract"><div className="section-kicker"><b>04</b><span>固定流程与交付门禁</span></div><div className="flow-editor-intro"><strong>领队只在动态分工区自由拆解；这些 Gate 是流程的硬边界。</strong><p>需要能力只是提示：领队按成员画像挑选执行者，不绑定测试员、审计员等固定角色名。没有合适成员时可由领队兜底。</p></div><div className="gate-editor-list">{draft.gates.map((gate, index) => <article key={`${gate.id}-${index}`}>
          <header><span>GATE {String(index + 1).padStart(2, "0")}</span><button type="button" className="text-button danger-text" onClick={() => setDraft({ ...draft, gates: draft.gates.filter((_, gateIndex) => gateIndex !== index) })}>移除</button></header>
          <div className="form-grid two"><Field label="Gate ID"><input required pattern="[a-z][a-z0-9-]*" value={gate.id} onChange={(event) => setDraft({ ...draft, gates: draft.gates.map((candidate, gateIndex) => gateIndex === index ? { ...candidate, id: event.target.value } : candidate) })} /></Field><Field label="需要能力"><input required value={gate.requiredCapability} placeholder="quality.test" onChange={(event) => setDraft({ ...draft, gates: draft.gates.map((candidate, gateIndex) => gateIndex === index ? { ...candidate, requiredCapability: event.target.value } : candidate) })} /></Field></div>
          <div className="form-grid three"><Field label="执行时机"><SelectControl ariaLabel={`选择门禁 ${gate.id || index + 1} 的执行时机`} value={gate.mode} options={[{ value: "before-completion", label: "最终交付前", description: "所有动态工作完成后统一检查" }, { value: "after-each-delegation", label: "每项匹配工作后", description: "每次符合能力条件的工作完成后立即检查" }]} onChange={(mode) => setDraft({ ...draft, gates: draft.gates.map((candidate, gateIndex) => gateIndex === index ? { ...candidate, mode: mode as SupervisorGate["mode"] } : candidate) })} /></Field><Field label="没有合适成员时"><SelectControl ariaLabel={`选择门禁 ${gate.id || index + 1} 的兜底方式`} value={gate.fallback} options={[{ value: "supervisor", label: "领队兜底", description: "没有成员被能力提示命中时，由领队执行该门禁" }, { value: "block", label: "交给任一成员", description: "不指定领队兜底；仍会挑一名成员执行，不因能力标签阻塞" }]} onChange={(fallback) => setDraft({ ...draft, gates: draft.gates.map((candidate, gateIndex) => gateIndex === index ? { ...candidate, fallback: fallback as SupervisorGate["fallback"] } : candidate) })} /></Field><label className="switch-line"><span><b>硬门禁</b><small>未满足时禁止 finish</small></span><SwitchControl checked={gate.required} ariaLabel={`门禁 ${gate.id || index + 1} 是否为硬门禁`} onChange={(required) => setDraft({ ...draft, gates: draft.gates.map((candidate, gateIndex) => gateIndex === index ? { ...candidate, required } : candidate) })} /></label></div>
          <Field label="执行说明"><textarea required rows={3} value={gate.instructions} onChange={(event) => setDraft({ ...draft, gates: draft.gates.map((candidate, gateIndex) => gateIndex === index ? { ...candidate, instructions: event.target.value } : candidate) })} /></Field>
        </article>)}</div><button type="button" className="button secondary" onClick={() => setDraft({ ...draft, gates: [...draft.gates, { id: `gate-${draft.gates.length + 1}`, requiredCapability: "quality.test", mode: "before-completion", required: true, instructions: "验证本次交付并提供可审计证据。", fallback: "supervisor" }] })}><UtilityIcon name="add" />添加能力门禁</button></section>
        <section className="workflow-contract"><div className="section-kicker"><b>05</b><span>声明式任务 DAG</span></div><div className="flow-editor-intro"><strong>可选：把分支开发 → 分支测试 → 合并 → 集成测试固定为声明式 DAG。</strong><p>启用后领队只能按 nodeId 派工，依赖未通过的环节不可执行；同一角色槽可负责多个环节（如 tester 同时负责 frontend-test、backend-test 与 integration-test）。不启用时保存 payload 不携带 dag，运行行为与旧版一致。</p></div><label className={`switch-line dag-enable-switch ${draft.dagEnabled ? "is-enabled" : "is-disabled"}`}><span><b>启用 DAG 编排</b><small>{draft.dagEnabled ? "保存时会提交 DAG 定义，并由领队按依赖顺序派工。" : "当前仅保留固定阶段与门禁，不提交 DAG。"}</small></span><strong className="switch-state-label" aria-hidden="true">{draft.dagEnabled ? "已启用" : "未启用"}</strong><SwitchControl checked={draft.dagEnabled} ariaLabel="启用 DAG 编排" onChange={toggleDag} /></label>
          {draft.dagEnabled && <div className="workflow-builder supervisor-dag-builder">
            <header className="workflow-builder-toolbar"><div><p className="record-meta">DAG / VISUAL COMPOSER</p><h3>领队编排画布</h3></div><div className="canvas-actions"><button type="button" className="button secondary dag-scaffold-action" onClick={applyDagScaffold}>填入分支-合并示例骨架</button><button type="button" className="button ghost" onClick={addDagNode}><UtilityIcon name="add" />添加环节</button><button type="button" className="button ghost" onClick={() => setDraft((current) => ({ ...current, positions: automaticDagPositions(current.dagNodes) }))}>自动排版</button></div></header>
            <div className="workflow-builder-grid"><div className="canvas-column"><div className="canvas-status"><span>拖动节点排版；从右侧端口连到下游左侧端口建立前置依赖，右侧可补充环节说明。</span><Stamp status={dagIssues.length ? "blocked" : "passed"} label={dagIssues.length ? `${dagIssues.length} 项待修正` : "DAG 草稿通过预检"} /></div><SupervisorDagEditorCanvas nodes={draft.dagNodes} positions={draft.positions} selectedIndex={selectedDagIndex} issues={dagIssues} onSelect={setSelectedDagIndex} onPositionsChange={(positions) => setDraft((current) => ({ ...current, positions }))} onConnect={connectDagNodes} roleVisual={dagRoleVisual} />{dagIssues.length > 0 && <div className="canvas-issues" role="alert">{dagIssues.map((issue) => <span key={issue}>{issue}</span>)}</div>}</div>
              <aside className="node-inspector supervisor-dag-inspector">{selectedDagNode ? <><header><div><p className="record-meta">环节设置</p><h4>{selectedDagNode.nodeId || "未命名节点"}</h4></div><button type="button" className="text-button danger-text" disabled={draft.dagNodes.length === 1} onClick={() => { removeDagNode(selectedDagIndex); setSelectedDagIndex(Math.max(0, selectedDagIndex - 1)); }}>移除</button></header>
                <Field label="环节标识" hint="保存后用于运行记录与证据追踪，建议使用简短英文。"><input required pattern="[a-z][a-z0-9-]*" value={selectedDagNode.nodeId} placeholder="frontend-test" onChange={(event) => renameDagNode(selectedDagIndex, event.target.value)} /></Field>
                <Field label="环节类型" hint="描述这个环节在流程中的职责，不限制员工采用的具体工作方式。"><SelectControl ariaLabel={`节点 ${selectedDagNode.nodeId || "当前"} 的环节类型`} value={selectedDagNode.kind} options={DAG_NODE_KINDS.map((kind) => ({ value: kind, label: dagNodeKindLabels[kind], description: dagNodeKindDescriptions[kind] }))} onChange={(value) => { const kind = value as SupervisorDagNodeKind; setDagNode(selectedDagIndex, { kind, ...(selectedDagNode.workKind === defaultDagWorkKind(selectedDagNode.kind) ? { workKind: defaultDagWorkKind(kind) } : {}) }); }} /></Field>
                <Field label="执行角色" hint="来自第 03 节成员清册；同一角色可以在多个环节重复使用。"><SelectControl ariaLabel={`节点 ${selectedDagNode.nodeId || "当前"} 的执行角色槽`} value={selectedDagNode.roleId} invalid={!draft.members.some((member) => member.roleId.trim() === selectedDagNode.roleId)} errorMessage={!draft.members.some((member) => member.roleId.trim() === selectedDagNode.roleId) ? "请选择第 03 节成员清册中的角色槽。" : undefined} options={[{ value: "", label: "选择成员角色", disabled: true }, ...draft.members.map((member) => { const visual = dagRoleVisual(member.roleId.trim()); return { value: member.roleId.trim(), label: visual ? `${visual.displayName} · ${member.roleId.trim()}` : member.roleId.trim() || "(未命名角色槽)", description: member.description }; })]} onChange={(roleId) => setDagNode(selectedDagIndex, { roleId })} /></Field>
                <Field label="任务说明" hint="说明该角色在这个环节要产出什么，以及完成标准。"><textarea required rows={4} value={selectedDagNode.task} onChange={(event) => setDagNode(selectedDagIndex, { task: event.target.value })} /></Field>
                <label className="switch-line dag-required-switch"><span><b>交付必需</b><small>关闭后，这个环节失败不会阻止领队完成最终交付。</small></span><SwitchControl checked={selectedDagNode.required} ariaLabel="当前环节是否为交付必需" onChange={(required) => setDagNode(selectedDagIndex, { required })} /></label>
                <section className="dag-dependency-editor" aria-label="前置环节设置"><header><div><b>前置环节</b><small>连线表示：这些环节全部通过后，当前环节才可开始。</small></div><span>{selectedDagNode.needs.length}</span></header>
                  <div className="dag-dependency-summary">{selectedDagNode.needs.length ? selectedDagNode.needs.map((needId) => { const candidate = draft.dagNodes.find((node) => node.nodeId === needId); return <button type="button" key={needId} title={`移除前置环节 ${needId}`} onClick={() => toggleDagNeed(selectedDagIndex, needId)}><span>{needId}</span><small>{candidate ? dagNodeKindLabels[candidate.kind] : "未知环节"}</small><i aria-hidden="true">×</i></button>; }) : <p>无前置环节 · 可立即开始</p>}</div>
                  <details><summary><span>精确调整前置环节</span><small>{draft.dagNodes.length <= 1 ? "暂无其他环节" : "连线之外的键盘可访问方式"}</small><UtilityIcon name="toggle" /></summary><fieldset className="dependency-checks"><legend>可选前置环节</legend>{draft.dagNodes.map((candidate, candidateIndex) => {
                    const needId = candidate.nodeId.trim();
                    if (candidateIndex === selectedDagIndex || !needId) return null;
                    return <label key={`${candidateIndex}-${needId}`}><input type="checkbox" checked={selectedDagNode.needs.includes(needId)} onChange={() => toggleDagNeed(selectedDagIndex, needId)} /><span><b>{needId}</b><small>{dagNodeKindLabels[candidate.kind]}</small></span></label>;
                  })}{draft.dagNodes.length <= 1 && <span className="muted">只有一个环节，无可选前置环节。</span>}</fieldset></details>
                </section>
                <details className="dag-advanced-settings"><summary><span><b>高级设置</b><small>能力匹配、工作方式与变更范围</small></span><UtilityIcon name="toggle" /></summary><div>
                  <Field label="工作方式" hint="供领队选择执行策略；通常会随环节类型自动设置。"><SelectControl ariaLabel={`节点 ${selectedDagNode.nodeId || "当前"} 的工作方式`} value={selectedDagNode.workKind} options={DAG_WORK_KINDS.map((workKind) => ({ value: workKind, label: dagWorkKindLabels[workKind], description: workKind }))} onChange={(value) => setDagNode(selectedDagIndex, { workKind: value as SupervisorWorkKind })} /></Field>
                  <Field label="额外能力要求（可选）" hint="仅在执行角色还需具备特定能力时填写；多个能力用逗号分隔。"><input value={selectedDagNode.capabilitiesText} placeholder="例如 quality.test" onChange={(event) => setDagNode(selectedDagIndex, { capabilitiesText: event.target.value })} /></Field>
                  <Field label="变更范围（可选）" hint="用于区分代码分支或产物边界，例如 frontend、backend；非开发任务通常留空。"><input value={selectedDagNode.changeSet} placeholder="例如 frontend" onChange={(event) => setDagNode(selectedDagIndex, { changeSet: event.target.value })} /></Field>
                </div></details>
              </> : <div className="mini-empty">在画布选择一个环节开始编辑。</div>}</aside>
            </div>
          </div>}</section>
        <section className="workflow-contract"><div className="section-kicker"><b>06</b><span>输入契约</span></div><Field label="Input JSON Schema"><textarea className="mono" rows={6} value={draft.inputSchema} onChange={(event) => setDraft({ ...draft, inputSchema: event.target.value })} /></Field></section>
        {generalIssues.length > 0 && <div className="canvas-issues" role="alert">{generalIssues.map((issue) => <span key={issue}>{issue}</span>)}</div>}
      </fieldset>
      <div className="editor-footer-stack">
        {submitError && <div className="editor-submit-error" role="alert" tabIndex={-1} ref={submitErrorRef}>
          <strong>保存失败</strong>
          <p>{summarizeSubmitError(submitError)}</p>
          <details><summary>查看技术详情</summary><code>{submitError}</code></details>
        </div>}
        <div className="editor-savebar"><span className={`editor-save-note${primaryIssue ? " is-error" : ""}`} role={primaryIssue ? "status" : undefined}>{primaryIssue ?? "Flow 固定阶段与门禁；领队只在动态分工区拆解、派发和重排。所有 Employee 与资源均固定版本。"}</span><button type="button" className="button secondary" onClick={onClose}>放弃修改</button><button className="button primary" disabled={saving || !daemonAvailable || issues.length > 0}>{saving ? "校验中…" : workflow ? `校验并另存为 v${workflow.version + 1}` : "校验并建立"}</button></div>
      </div>
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
      const receipt = await api<WorkflowStartReceipt>(`/api/workflows/${selected.id}/start`, { ...writeBody(input), headers: { "x-multi-agent-source": "workbench", "x-multi-agent-source-label": "协作编排调试台" } });
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
    <main className="detail-pane">{!selected ? <EmptyState title="建立第一支领队团队" action={<button className="button primary" disabled={!daemonAvailable || !(data.managementPolicies ?? []).some((item) => item.status === "active")} onClick={() => setEditor("new")}>建立领队团队</button>}>先在管理策略库登记策略，再固定一位领队和多个成员角色；需要固定先后关系时可启用任务 DAG。</EmptyState> : <div className="dossier workflow-dossier">
      <header className="dossier-cover"><div className="file-index"><span>LEAD TEAM WORKFLOW RECORD</span><code>No. {selected.id.toUpperCase()}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">领</div><div><h2>{selected.id}</h2><p>{selected.description}</p></div><Stamp status={selected.status} /></div><div className="dossier-actions"><button className="button primary" disabled={!daemonAvailable || running || selected.status === "archived"} onClick={() => scrollRecordIntoView("run-supervisor-workflow")}>运行团队</button><button className="button secondary" disabled={!daemonAvailable} onClick={() => setEditor("edit")}>修订团队</button><button className="button danger" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setArchiveOpen(true)}>归档</button></div></header>
      <DossierSection number="01" title="领队与管理策略"><div className="supervisor-control-card"><EmployeeAvatar displayName={manager?.identity.displayName ?? selected.supervisor.employeeId} presentation={manager?.presentation} /><div><span>TEAM LEAD EMPLOYEE</span><strong>{manager?.identity.displayName ?? selected.supervisor.employeeId}</strong><small>{selected.supervisor.employeeId} · 固定 v{selected.supervisor.employeeVersion}</small><code>自动注入 {selected.orchestrationSkill.id} · v{selected.orchestrationSkill.version}</code></div><div className="policy-pin"><span>MANAGEMENT POLICY</span><strong>{policy?.displayName ?? selected.managementPolicy.id}</strong><small>{selected.managementPolicy.id} · 固定 v{selected.managementPolicy.version}{policy && policy.version !== selected.managementPolicy.version ? ` · 最新 v${policy.version}` : ""}</small></div></div></DossierSection>
      <DossierSection number="02" title="成员角色绑定"><div className="node-ledger">{selected.members.map((member, index) => { const employee = data.employees.find((candidate) => candidate.id === member.employeeId); return <article key={member.roleId}><span className="node-number">{String(index + 1).padStart(2, "0")}</span><EmployeeAvatar className="small" displayName={employee?.identity.displayName ?? member.employeeId} presentation={employee?.presentation} /><div><strong>{member.roleId}</strong><span>{member.description}</span></div><code>{employee?.identity.displayName ?? member.employeeId} · v{member.employeeVersion}</code></article>; })}</div></DossierSection>
      <DossierSection number="03" title="固定流程与动态分工"><OrchestrationFlow workflow={selected} data={data} /></DossierSection>
      <DossierSection number="04" title="版本"><div className="version-strip">{versions.map((version) => <div key={version.version} className={version.version === selected.version ? "current" : ""}><code>v{version.version}</code><span>{version.version === selected.version ? "当前" : version.status === "archived" ? "归档" : "历史"}</span><time>{formatTime(version.updatedAt)}</time></div>)}</div></DossierSection>
      {sessionPrompts && <DossierSection number="05" title="其他会话使用" action={<Stamp status={publication ? "active" : "pending"} label={publication ? "稳定调用包" : "调试入口"} />}><WorkflowSessionGuide prompts={sessionPrompts} /></DossierSection>}
      <section id="run-supervisor-workflow" className="run-order"><header><div><p className="record-meta">{selected.id} · v{selected.version}</p><h3>签发领队运行工单</h3></div><Stamp status={running ? "running" : "pending"} label={running ? "提交回执" : "待签发"} /></header><Field label="Workflow 输入 (JSON)"><textarea className="mono" rows={8} disabled={!daemonAvailable} value={runInput} onChange={(event) => setRunInput(event.target.value)} /></Field><div className="run-actions"><span>策略上限耗尽会记为 blocked；领队决策或 Provider 技术故障才记为 failed。</span><button className="button primary" disabled={!daemonAvailable || running || selected.status === "archived"} onClick={() => void run()}>{running ? "提交回执…" : "签发并运行"}</button></div></section>
    </div>}</main>
    {editor && <SupervisorEditor workflow={editor === "edit" ? selected : undefined} data={data} notify={notify} onClose={() => setEditor(null)} onSaved={async (saved) => { setEditor(null); setSelectedId(saved.id); await refresh(); }} />}
    {archiveOpen && selected && <Modal title="归档领队团队" eyebrow={`${selected.id} · 保留历史`} onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>历史版本、策略固定和动态 Run 证据都会保留。</b><p>归档后不能签发新的领队运行工单。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveOpen(false)}>取消</button><button className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive()}>确认归档</button></div></div></Modal>}
  </div>;
}
