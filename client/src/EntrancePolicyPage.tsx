import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, writeBody } from "./api";
import { DossierSection, EmptyState, Field, Modal, Stamp, UtilityIcon, formatTime, useDaemonAvailable } from "./components";
import { isSystemEmployee } from "./employeeAccess";
import type {
  Bootstrap,
  EntrancePolicy,
  EntrancePolicyDecision,
  EntrancePolicyResolvedTarget,
  EntrancePolicyRoute,
  EntrancePolicyRouteResult,
  EntrancePolicySpecialistTarget,
  InvocationSourceKind,
  JsonObject,
  SupervisorWorkflow
} from "./types";

interface PageProps {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
}

type DecisionRoute = Exclude<EntrancePolicyRoute, "auto">;
type DirectMode = "none" | "caller" | "employee";
type SpecialistKind = EntrancePolicySpecialistTarget["kind"];

interface SpecialistDraft {
  clientId: string;
  key: string;
  kind: SpecialistKind;
  referenceId: string;
  pinned?: EntrancePolicySpecialistTarget;
}

interface RuleDraft {
  clientId: string;
  id: string;
  whenText: string;
  route: DecisionRoute;
  specialistKey: string;
}

interface PolicyDraft {
  id: string;
  displayName: string;
  description: string;
  directMode: DirectMode;
  directEmployeeId: string;
  specialists: SpecialistDraft[];
  leaderWorkflowId: string;
  rules: RuleDraft[];
  defaultRoute: DecisionRoute;
  defaultSpecialistKey: string;
}

let draftRowSequence = 0;
function draftRowId(prefix: string): string {
  draftRowSequence += 1;
  return `${prefix}-${draftRowSequence}`;
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 对象`);
  return parsed as Record<string, unknown>;
}

function objectIssue(value: string, label: string): string {
  try {
    parseObject(value || "{}", label);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function routeResult(route: DecisionRoute, specialistKey: string): EntrancePolicyRouteResult {
  if (route === "specialist") {
    if (!specialistKey.trim()) throw new Error("路由为专家时必须选择 Specialist Key");
    return { route, specialistKey: specialistKey.trim() };
  }
  return { route };
}

function specialistReference(target: EntrancePolicySpecialistTarget): string {
  if (target.kind === "employee") return target.employeeId;
  if (target.kind === "project-role") return `${target.projectId}::${target.roleId}`;
  return target.workflowId;
}

function draftFor(policy?: EntrancePolicy): PolicyDraft {
  const directMode: DirectMode = policy?.direct?.mode ?? "caller";
  return {
    id: policy?.id ?? "",
    displayName: policy?.displayName ?? "",
    description: policy?.description ?? "",
    directMode,
    directEmployeeId: policy?.direct?.mode === "employee" ? policy.direct.employeeId : "",
    specialists: Object.entries(policy?.specialists ?? {}).map(([key, target]) => ({
      clientId: draftRowId("specialist"),
      key,
      kind: target.kind,
      referenceId: specialistReference(target),
      pinned: target
    })),
    leaderWorkflowId: policy?.leader?.workflowId ?? "",
    rules: (policy?.rules ?? []).map((rule) => ({
      clientId: draftRowId("rule"),
      id: rule.id,
      whenText: JSON.stringify(rule.when, null, 2),
      route: rule.result.route,
      specialistKey: rule.result.route === "specialist" ? rule.result.specialistKey : ""
    })),
    defaultRoute: policy?.default.route ?? "direct",
    defaultSpecialistKey: policy?.default.route === "specialist" ? policy.default.specialistKey : ""
  };
}

function specialistInput(rows: SpecialistDraft[]): Record<string, unknown> {
  const seen = new Set<string>();
  return Object.fromEntries(rows.map((row, index) => {
    const key = row.key.trim();
    if (!key) throw new Error(`专家目标第 ${index + 1} 行缺少 Specialist Key`);
    if (seen.has(key)) throw new Error(`Specialist Key 重复：${key}`);
    seen.add(key);
    const referenceId = row.referenceId.trim();
    if (!referenceId) throw new Error(`专家目标 ${key} 尚未选择固定目标`);
    if (row.kind === "employee") {
      const pinned = row.pinned?.kind === "employee" && row.pinned.employeeId === referenceId ? row.pinned : undefined;
      return [key, { kind: row.kind, employeeId: referenceId, ...(pinned ? { employeeVersion: pinned.employeeVersion } : {}) }];
    }
    if (row.kind === "project-role") {
      const [projectId, roleId] = referenceId.split("::");
      if (!projectId || !roleId) throw new Error(`专家目标 ${key} 的项目角色无效`);
      const pinned = row.pinned?.kind === "project-role" && row.pinned.projectId === projectId && row.pinned.roleId === roleId ? row.pinned : undefined;
      return [key, {
        kind: row.kind,
        projectId,
        roleId,
        ...(pinned ? { projectVersion: pinned.projectVersion, projectBindingVersion: pinned.projectBindingVersion } : {})
      }];
    }
    const pinned = row.pinned?.kind === "graph-workflow" && row.pinned.workflowId === referenceId ? row.pinned : undefined;
    return [key, { kind: row.kind, workflowId: referenceId, ...(pinned ? { workflowVersion: pinned.workflowVersion } : {}) }];
  }));
}

function rulesInput(rows: RuleDraft[]): unknown[] {
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const id = row.id.trim();
    if (!id) throw new Error(`第 ${index + 1} 条规则缺少 Rule ID`);
    if (seen.has(id)) throw new Error(`Rule ID 重复：${id}`);
    seen.add(id);
    return {
      id,
      when: parseObject(row.whenText || "{}", `规则 ${id} 的 when`),
      result: routeResult(row.route, row.specialistKey)
    };
  });
}

function targetLabel(target: EntrancePolicyResolvedTarget): string {
  if (target.kind === "caller") return "交还调用方 · 不创建内部工单或运行";
  if (target.kind === "employee") return `Employee ${target.employeeId} · v${target.employeeVersion}`;
  if (target.kind === "project-role") {
    return `Project Role ${target.projectId}/${target.roleId} · project v${target.projectVersion} · binding v${target.projectBindingVersion} · ${target.employeeId} v${target.employeeVersion}`;
  }
  return `${target.kind === "graph-workflow" ? "Graph" : "协作编排"} ${target.workflowId} · v${target.workflowVersion}`;
}

function resultLabel(result: EntrancePolicyRouteResult): string {
  if (result.route === "direct") return "direct · 直达";
  if (result.route === "leader") return "leader · 协作编排";
  return `specialist · ${result.specialistKey}`;
}

function decidedByLabel(decision: EntrancePolicyDecision): string {
  if (decision.decidedBy === "explicit") return "调用方显式指定";
  if (decision.decidedBy === "rule") return `顺序规则 ${decision.matchedRuleId ?? "—"}`;
  return "兜底结果";
}

function RequestLifecycle() {
  return <section className="entrance-lifecycle" aria-label="工作启动原则">
    <header><span>DISCUSS FIRST · START WORK WHEN READY</span><strong>讨论是默认状态。只有你明确交给员工或启动团队，系统才开始执行。</strong></header>
    <div className="entrance-lifecycle-routes entrance-lifecycle-routes--intent">
      <article><code>01</code><b>继续讨论</b><small>不建工单，不创建 Run，也不让领队提前介入。</small></article>
      <article><code>02</code><b>交给一位员工</b><small>目标清楚、无需拆分时，固定一位执行者。</small></article>
      <article><code>03</code><b>开始协作编排</b><small>需要拆解、分工或交付门禁时，再让领队组织团队。</small></article>
    </div>
  </section>;
}

function PolicyEditor({ policy, data, onClose, onSaved, notify }: {
  policy?: EntrancePolicy;
  data: Bootstrap;
  onClose: () => void;
  onSaved: (policy: EntrancePolicy) => void;
  notify: PageProps["notify"];
}) {
  const daemonAvailable = useDaemonAvailable();
  const [draft, setDraft] = useState(() => draftFor(policy));
  const [saving, setSaving] = useState(false);
  // Mirrors the server guard: system-level employees (identity.metadata.internalProjectId)
  // can only be reached through their internal project role, never as direct specialists.
  const activeEmployees = data.employees.filter((employee) => employee.status === "active" && !isSystemEmployee(employee));
  const supervisorWorkflows = data.workflows.filter(
    (workflow): workflow is SupervisorWorkflow => workflow.architecture === "supervisor" && workflow.status === "active"
  );
  const graphWorkflows = data.workflows.filter((workflow) => workflow.architecture === "graph" && workflow.status === "active");
  const projectRoleOptions = data.projects.flatMap((project) => {
    if (project.status !== "active") return [];
    const binding = data.projectBindings.find((candidate) => candidate.projectId === project.id);
    return project.roles.flatMap((role) => {
      const assignment = binding?.roles.find((candidate) => candidate.roleId === role.id);
      return assignment ? [{
        value: `${project.id}::${role.id}`,
        label: `${project.name} / ${role.displayName}`,
        description: `${project.id}/${role.id} · ${assignment.employeeId} v${assignment.employeeVersion}`
      }] : [];
    });
  });
  const specialistKeys = draft.specialists.map((row) => row.key.trim()).filter(Boolean);
  const duplicateSpecialistKeys = new Set(specialistKeys.filter((key, index) => specialistKeys.indexOf(key) !== index));
  const ruleIds = draft.rules.map((row) => row.id.trim()).filter(Boolean);
  const duplicateRuleIds = new Set(ruleIds.filter((id, index) => ruleIds.indexOf(id) !== index));
  const specialistKeyIssues = draft.specialists.map((row) => {
    if (!row.key.trim()) return "请填写 Specialist Key";
    if (!/^[a-z][a-z0-9-]*$/.test(row.key.trim())) return "Specialist Key 需使用小写字母、数字和连字符";
    if (duplicateSpecialistKeys.has(row.key.trim())) return `Specialist Key 重复：${row.key.trim()}`;
    return "";
  });
  const specialistTargetIssues = draft.specialists.map((row) => row.referenceId.trim() ? "" : "请选择固定目标");
  const specialistIssues = draft.specialists.map((_, index) => specialistKeyIssues[index] || specialistTargetIssues[index] || "");
  const ruleIdIssues = draft.rules.map((row) => {
    if (!row.id.trim()) return "请填写 Rule ID";
    if (!/^[a-z][a-z0-9-]*$/.test(row.id.trim())) return "Rule ID 需使用小写字母、数字和连字符";
    if (duplicateRuleIds.has(row.id.trim())) return `Rule ID 重复：${row.id.trim()}`;
    return "";
  });
  const ruleWhenIssues = draft.rules.map((row, index) => objectIssue(row.whenText, `规则 ${row.id.trim() || index + 1} 的 when`));
  const ruleResultIssues = draft.rules.map((row) => row.route === "specialist" && !specialistKeys.includes(row.specialistKey)
    ? "请选择仍然存在的 Specialist Key"
    : "");
  const ruleIssues = draft.rules.map((_, index) => ruleIdIssues[index] || ruleWhenIssues[index] || ruleResultIssues[index] || "");
  const defaultIssue = draft.defaultRoute === "specialist" && !specialistKeys.includes(draft.defaultSpecialistKey)
    ? "兜底为专家时，必须选择仍然存在的 Specialist Key"
    : "";
  const editorHasIssues = specialistIssues.some(Boolean) || ruleIssues.some(Boolean) || Boolean(defaultIssue)
    || !draft.id.trim() || !draft.displayName.trim() || !draft.description.trim();

  const updateSpecialist = (clientId: string, patch: Partial<SpecialistDraft>) => {
    setDraft((current) => ({
      ...current,
      specialists: current.specialists.map((row) => row.clientId === clientId ? { ...row, ...patch } : row)
    }));
  };
  const removeSpecialist = (clientId: string) => setDraft((current) => ({
    ...current,
    specialists: current.specialists.filter((row) => row.clientId !== clientId)
  }));
  const addSpecialist = () => setDraft((current) => ({
    ...current,
    specialists: [...current.specialists, { clientId: draftRowId("specialist"), key: "", kind: "project-role", referenceId: "" }]
  }));
  const updateRule = (clientId: string, patch: Partial<RuleDraft>) => setDraft((current) => ({
    ...current,
    rules: current.rules.map((row) => row.clientId === clientId ? { ...row, ...patch } : row)
  }));
  const removeRule = (clientId: string) => setDraft((current) => ({
    ...current,
    rules: current.rules.filter((row) => row.clientId !== clientId)
  }));
  const moveRule = (index: number, offset: -1 | 1) => setDraft((current) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= current.rules.length) return current;
    const rules = [...current.rules];
    [rules[index], rules[nextIndex]] = [rules[nextIndex]!, rules[index]!];
    return { ...current, rules };
  });
  const addRule = () => setDraft((current) => ({
    ...current,
    rules: [...current.rules, {
      clientId: draftRowId("rule"),
      id: `rule-${current.rules.length + 1}`,
      whenText: "{\n  \"signals\": {\n    \"signalName\": { \"exists\": true }\n  }\n}",
      route: "direct",
      specialistKey: ""
    }]
  }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (editorHasIssues) return;
    setSaving(true);
    try {
      const specialists = specialistInput(draft.specialists);
      const rules = rulesInput(draft.rules);
      const direct = draft.directMode === "none"
        ? null
        : draft.directMode === "caller"
          ? { mode: "caller" as const }
          : (() => {
              if (!draft.directEmployeeId) throw new Error("Direct 选择 Employee 时必须指定员工");
              const pinnedDirectVersion = policy?.direct?.mode === "employee" && policy.direct.employeeId === draft.directEmployeeId
                ? policy.direct.employeeVersion
                : undefined;
              return {
                mode: "employee" as const,
                employeeId: draft.directEmployeeId,
                ...(pinnedDirectVersion ? { employeeVersion: pinnedDirectVersion } : {})
              };
            })();
      const samePinnedLeader = Boolean(policy?.leader && policy.leader.workflowId === draft.leaderWorkflowId);
      const leader = draft.leaderWorkflowId
        ? { workflowId: draft.leaderWorkflowId, ...(samePinnedLeader ? { workflowVersion: policy?.leader?.workflowVersion } : {}) }
        : null;
      const common = {
        displayName: draft.displayName.trim(),
        description: draft.description.trim(),
        direct,
        specialists,
        leader,
        rules,
        default: routeResult(draft.defaultRoute, draft.defaultSpecialistKey)
      };
      const saved = policy
        ? await api<EntrancePolicy>(`/api/entrance-policies/${policy.id}`, writeBody(common, "PATCH"))
        : await api<EntrancePolicy>("/api/entrance-policies", writeBody({ id: draft.id.trim(), ...common }));
      notify(policy ? `请求分流策略已另存为 v${saved.version}` : `请求分流策略 ${saved.id} 已登记`);
      onSaved(saved);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };

  return <Modal title={policy ? `修订 ${policy.displayName}` : "登记请求分流策略"} eyebrow="STRUCTURED REQUEST → ROUTE → PINNED TARGET" onClose={onClose} wide>
    <form className="editor-form entrance-policy-editor" onSubmit={submit}>
      <fieldset className="daemon-write-surface" disabled={!daemonAvailable}>
        <section className="workflow-basics"><div className="section-kicker"><b>01</b><span>策略身份</span></div><div className="form-grid entrance-identity-grid">
          <Field label="Policy ID"><input required pattern="[a-z][a-z0-9-]*" disabled={Boolean(policy)} value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></Field>
          <Field label="显示名"><input required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
          <Field label="说明"><input required value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field>
        </div></section>

        <section className="workflow-contract"><div className="section-kicker"><b>02</b><span>固定目标</span></div>
          <div className="form-grid entrance-target-grid">
            <Field label="Direct 目标"><select value={draft.directMode} onChange={(event) => setDraft({ ...draft, directMode: event.target.value as DirectMode })}><option value="caller">交还调用方 · 不建内部工单</option><option value="employee">固定 Employee · 创建工单与 Run</option><option value="none">不配置 direct</option></select></Field>
            {draft.directMode === "employee" && <Field label="Direct Employee"><select required value={draft.directEmployeeId} onChange={(event) => setDraft({ ...draft, directEmployeeId: event.target.value })}><option value="">选择员工</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.identity.displayName} · {employee.id} · v{employee.version}</option>)}</select></Field>}
            <Field label="Leader 协作编排"><select value={draft.leaderWorkflowId} onChange={(event) => setDraft({ ...draft, leaderWorkflowId: event.target.value })}><option value="">不配置 leader</option>{supervisorWorkflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.id} · v{workflow.version}</option>)}</select></Field>
          </div>
          <div className="entrance-subsection-heading"><div><span>SPECIALIST TARGETS</span><strong>专家目标</strong><small>每个 key 固定到一种内部执行目标；保存时继续由后端校验并固定版本。</small></div><button type="button" className="button secondary" onClick={addSpecialist}><UtilityIcon name="add" />添加专家目标</button></div>
          <div className="entrance-specialist-editor">
            {draft.specialists.map((row, index) => <article key={row.clientId} className={specialistIssues[index] ? "is-invalid" : ""}>
              <Field label="Specialist Key"><input required pattern="[a-z][a-z0-9-]*" aria-invalid={Boolean(specialistKeyIssues[index]) || undefined} value={row.key} onChange={(event) => updateSpecialist(row.clientId, { key: event.target.value })} /></Field>
              <Field label="目标类型"><select value={row.kind} onChange={(event) => updateSpecialist(row.clientId, { kind: event.target.value as SpecialistKind, referenceId: "", pinned: undefined })}><option value="project-role">Project Role</option><option value="employee">Employee</option><option value="graph-workflow">Graph Workflow</option></select></Field>
              <Field label="固定目标">{row.kind === "employee" ? <select required aria-invalid={Boolean(specialistTargetIssues[index]) || undefined} value={row.referenceId} onChange={(event) => updateSpecialist(row.clientId, { referenceId: event.target.value })}><option value="">选择员工</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.identity.displayName} · {employee.id} · v{employee.version}</option>)}</select> : row.kind === "project-role" ? <select required aria-invalid={Boolean(specialistTargetIssues[index]) || undefined} value={row.referenceId} onChange={(event) => updateSpecialist(row.clientId, { referenceId: event.target.value })}><option value="">选择项目角色</option>{projectRoleOptions.map((option) => <option key={option.value} value={option.value}>{option.label} · {option.description}</option>)}</select> : <select required aria-invalid={Boolean(specialistTargetIssues[index]) || undefined} value={row.referenceId} onChange={(event) => updateSpecialist(row.clientId, { referenceId: event.target.value })}><option value="">选择 Graph</option>{graphWorkflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.id} · v{workflow.version}</option>)}</select>}</Field>
              <button type="button" className="button ghost entrance-row-remove" onClick={() => removeSpecialist(row.clientId)}>删除</button>
              {specialistIssues[index] && <p className="entrance-inline-error" role="alert">{specialistIssues[index]}</p>}
            </article>)}
            {draft.specialists.length === 0 && <div className="mini-empty">尚未配置专家目标；specialist 路由将不可用。</div>}
          </div>
        </section>

        <section className="workflow-contract"><div className="section-kicker"><b>03</b><span>顺序规则</span></div>
          <div className="entrance-no-message"><strong>只读取结构化条件</strong><span>规则可读取 tags、source 和 signals；消息正文不会进入分流决策，也不能配置关键词匹配。</span></div>
          <div className="entrance-subsection-heading"><div><span>FIRST MATCH WINS</span><strong>规则卡片</strong><small>按从上到下的顺序匹配；when 保留小型 JSON，以支持完整条件表达式。</small></div><button type="button" className="button secondary" onClick={addRule}><UtilityIcon name="add" />添加规则</button></div>
          <div className="entrance-rule-editor">
            {draft.rules.map((row, index) => <article key={row.clientId} className={ruleIssues[index] ? "is-invalid" : ""}>
              <header><span>{String(index + 1).padStart(2, "0")}</span><strong>{row.id || "未命名规则"}</strong><div><button type="button" className="text-button" disabled={index === 0} onClick={() => moveRule(index, -1)}>上移</button><button type="button" className="text-button" disabled={index === draft.rules.length - 1} onClick={() => moveRule(index, 1)}>下移</button><button type="button" className="text-button danger-text" onClick={() => removeRule(row.clientId)}>删除</button></div></header>
              <div className="entrance-rule-fields">
                <Field label="Rule ID"><input required pattern="[a-z][a-z0-9-]*" aria-invalid={Boolean(ruleIdIssues[index]) || undefined} value={row.id} onChange={(event) => updateRule(row.clientId, { id: event.target.value })} /></Field>
                <Field label="结果路由"><select aria-invalid={Boolean(ruleResultIssues[index]) || undefined} value={row.route} onChange={(event) => updateRule(row.clientId, { route: event.target.value as DecisionRoute, specialistKey: event.target.value === "specialist" ? row.specialistKey : "" })}><option value="direct">direct · 直达</option><option value="specialist">specialist · 专家</option><option value="leader">leader · 协作编排</option></select></Field>
                {row.route === "specialist" && <Field label="Specialist Key"><select required aria-invalid={Boolean(ruleResultIssues[index]) || undefined} value={row.specialistKey} onChange={(event) => updateRule(row.clientId, { specialistKey: event.target.value })}><option value="">选择专家目标</option>{specialistKeys.map((key) => <option key={key} value={key}>{key}</option>)}</select></Field>}
              </div>
              <Field label="when (JSON 对象)" hint="支持 tagsAllOf、tagsAnyOf、source 与 signals；不读取 message。"><textarea className="mono" rows={5} aria-invalid={Boolean(ruleWhenIssues[index]) || undefined} value={row.whenText} onChange={(event) => updateRule(row.clientId, { whenText: event.target.value })} /></Field>
              {ruleIssues[index] && <p className="entrance-inline-error" role="alert">{ruleIssues[index]}</p>}
            </article>)}
            {draft.rules.length === 0 && <div className="mini-empty">没有顺序规则；auto 始终使用兜底结果。</div>}
          </div>
        </section>

        <section className="workflow-contract"><div className="section-kicker"><b>04</b><span>兜底结果</span></div><div className="form-grid entrance-default-grid">
          <Field label="Default Route"><select value={draft.defaultRoute} onChange={(event) => setDraft({ ...draft, defaultRoute: event.target.value as DecisionRoute, defaultSpecialistKey: event.target.value === "specialist" ? draft.defaultSpecialistKey : "" })}><option value="direct">direct · 直达</option><option value="specialist">specialist · 专家目标</option><option value="leader">leader · 协作编排</option></select></Field>
          {draft.defaultRoute === "specialist" && <Field label="Default Specialist Key"><select required aria-invalid={Boolean(defaultIssue) || undefined} value={draft.defaultSpecialistKey} onChange={(event) => setDraft({ ...draft, defaultSpecialistKey: event.target.value })}><option value="">选择专家目标</option>{specialistKeys.map((key) => <option key={key} value={key}>{key}</option>)}</select></Field>}
        </div>{defaultIssue && <p className="entrance-inline-error" role="alert">{defaultIssue}</p>}</section>
      </fieldset>
      <div className="editor-savebar"><span className="editor-save-note">显式路由优先，其次按序规则，最后才用兜底结果；修订始终创建新版本。</span><button type="button" className="button secondary" onClick={onClose}>放弃修改</button><button className="button primary" disabled={!daemonAvailable || saving || editorHasIssues}>{saving ? "校验并固定版本…" : policy ? `另存为 v${policy.version + 1}` : "登记分流策略"}</button></div>
    </form>
  </Modal>;
}

function EvaluationDesk({ policy, data, notify }: { policy: EntrancePolicy; data: Bootstrap; notify: PageProps["notify"] }) {
  const daemonAvailable = useDaemonAvailable();
  const specialistEntries = Object.entries(policy.specialists);
  const [intent, setIntent] = useState<"discussion" | "employee" | "team">("discussion");
  const [route, setRoute] = useState<EntrancePolicyRoute>("auto");
  const [specialistKey, setSpecialistKey] = useState(specialistEntries[0]?.[0] ?? "");
  const [tags, setTags] = useState("");
  const [sourceKind, setSourceKind] = useState<InvocationSourceKind>("workbench");
  const [sourceLabel, setSourceLabel] = useState("请求分流试算台");
  const [signalsText, setSignalsText] = useState("{}");
  const [decision, setDecision] = useState<EntrancePolicyDecision>();
  const [evaluating, setEvaluating] = useState(false);
  const signalsIssue = objectIssue(signalsText, "Signals");
  const presets = [
    { label: "动态重规划", value: { requiresDynamicReplanning: true } },
    { label: "独立验收", value: { requiresIndependentValidation: true } },
    { label: "多角色协作", value: { requiredRoleCount: 2 } }
  ];

  useEffect(() => { setDecision(undefined); }, [policy.id, policy.version]);

  const evaluate = async (advanced = false) => {
    if (!advanced && intent === "discussion") {
      setDecision(undefined);
      notify("保持讨论状态：没有创建工单、Run 或领队任务");
      return;
    }
    if (signalsIssue) return;
    setEvaluating(true);
    try {
      const signals = parseObject(signalsText || "{}", "Signals") as JsonObject;
      const requestedRoute = advanced ? route : intent === "employee" ? "specialist" : "leader";
      const body = {
        route: requestedRoute,
        ...(requestedRoute === "specialist" ? { specialistKey: specialistKey.trim() } : {}),
        tags: [...new Set(tags.split(",").map((tag) => tag.trim()).filter(Boolean))],
        signals,
        source: { kind: sourceKind, ...(sourceLabel.trim() ? { label: sourceLabel.trim() } : {}) }
      };
      const result = await api<EntrancePolicyDecision>(`/api/entrance-policies/${policy.id}/evaluate`, writeBody(body));
      setDecision(result);
      notify(`试算完成：${resultLabel(result.result)}`);
    } catch (error) {
      setDecision(undefined);
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setEvaluating(false);
    }
  };

  const specialistTarget = policy.specialists[specialistKey];
  const specialistName = specialistTarget?.kind === "employee"
    ? data.employees.find((employee) => employee.id === specialistTarget.employeeId)?.identity.displayName
    : undefined;
  const leader = policy.leader ? data.workflows.find((workflow) => workflow.id === policy.leader?.workflowId) : undefined;
  return <div className="entrance-evaluation-desk">
    <div className="work-intent-grid" role="radiogroup" aria-label="选择工作方式">
      <button type="button" role="radio" aria-checked={intent === "discussion"} className={intent === "discussion" ? "selected" : ""} onClick={() => { setIntent("discussion"); setDecision(undefined); }}><span>01 · DEFAULT</span><strong>继续讨论</strong><p>还在澄清设计或目标时保持当前对话，不创建任何内部工作。</p><small>无工单 · 无 Run · 无领队</small></button>
      <button type="button" role="radio" aria-checked={intent === "employee"} className={intent === "employee" ? "selected" : ""} disabled={specialistEntries.length === 0} onClick={() => { setIntent("employee"); setRoute("specialist"); }}><span>02 · SINGLE OWNER</span><strong>交给一位员工</strong><p>事项边界清楚，不需要领队拆解或多人协作。</p><small>{specialistEntries.length ? `${specialistEntries.length} 个可用目标` : "当前策略未配置员工目标"}</small></button>
      <button type="button" role="radio" aria-checked={intent === "team"} className={intent === "team" ? "selected" : ""} disabled={!policy.leader} onClick={() => { setIntent("team"); setRoute("leader"); }}><span>03 · TEAM FLOW</span><strong>开始协作编排</strong><p>由领队拆解任务，固定 Flow 负责阶段和交付 Gate。</p><small>{leader ? `${leader.id} · v${policy.leader?.workflowVersion}` : "当前策略未配置领队团队"}</small></button>
    </div>
    {intent === "employee" && <div className="intent-target-picker"><Field label="选择执行目标"><select required value={specialistKey} onChange={(event) => setSpecialistKey(event.target.value)}><option value="">选择一位员工或单目标流程</option>{specialistEntries.map(([key, target]) => <option key={key} value={key}>{target.kind === "employee" ? data.employees.find((employee) => employee.id === target.employeeId)?.identity.displayName ?? target.employeeId : targetLabel(target)}</option>)}</select></Field>{specialistTarget && <p>{specialistName ?? targetLabel(specialistTarget)} · 内部固定版本已由策略保存</p>}</div>}
    {intent === "team" && policy.leader && <div className="intent-team-preview"><span>LEADER WORKFLOW</span><strong>{leader?.id ?? policy.leader.workflowId}</strong><p>预览只确认去向；真正启动后，才创建团队 Run 并注入领队系统能力。</p></div>}
    <div className="entrance-evaluate-actions"><span>{intent === "discussion" ? <><b>这是默认项。</b>继续当前对话，不触发后台工作。</> : <><b>先预览，不执行。</b>确认后由真正的 dispatch 创建工单与 Run。</>}</span><button type="button" className="button primary" disabled={!daemonAvailable || evaluating || policy.status === "archived" || (intent === "employee" && !specialistKey) || (intent === "team" && !policy.leader)} onClick={() => void evaluate(false)}>{evaluating ? "预览中…" : intent === "discussion" ? "保持讨论" : "预览工作去向"}</button></div>
    <details className="entrance-advanced"><summary><span>高级启动规则</span><small>系统集成与确定性路由调试</small><UtilityIcon name="toggle" /></summary><div className="entrance-evaluator-grid">
      <Field label="内部路由"><select value={route} onChange={(event) => setRoute(event.target.value as EntrancePolicyRoute)}><option value="auto">auto · 按策略</option><option value="direct">direct</option><option value="specialist">specialist</option><option value="leader">leader</option></select></Field>
      {route === "specialist" && <Field label="目标 Key"><select required value={specialistKey} onChange={(event) => setSpecialistKey(event.target.value)}><option value="">选择目标</option>{specialistEntries.map(([key]) => <option key={key} value={key}>{key}</option>)}</select></Field>}
      <Field label="任务标签"><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="review, risky" /></Field>
      <Field label="调用来源"><select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as InvocationSourceKind)}><option value="workbench">workbench</option><option value="http">http</option><option value="mcp">mcp</option><option value="a2a">a2a</option></select></Field>
      <Field label="来源备注"><input value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)} /></Field>
    </div><div className="entrance-signal-presets"><span>常用信号</span>{presets.map((preset) => <button type="button" className="paper-tag" key={preset.label} onClick={() => setSignalsText(JSON.stringify(preset.value, null, 2))}>{preset.label}</button>)}<button type="button" className="paper-tag" onClick={() => setSignalsText("{}")}>清空</button></div><Field label="结构化信号 (JSON)" hint="只用于规则决策，不作为员工执行消息。"><textarea className="mono" rows={5} aria-invalid={Boolean(signalsIssue) || undefined} value={signalsText} onChange={(event) => setSignalsText(event.target.value)} /></Field>{signalsIssue && <p className="entrance-inline-error" role="alert">{signalsIssue}</p>}<div className="entrance-advanced-actions"><span>只返回内部决策，不创建任务。</span><button type="button" className="button secondary" disabled={!daemonAvailable || evaluating || Boolean(signalsIssue) || (route === "specialist" && !specialistKey)} onClick={() => void evaluate(true)}>高级试算</button></div></details>
    {decision && <article className={`entrance-decision-card entrance-decision-card--${decision.target.kind === "caller" ? "caller" : decision.executable ? "ready" : "blocked"}`} role="status">
      <header><div><span>去向预览 · policy v{decision.policyVersion}</span><strong>{decision.target.kind === "caller" ? "继续讨论" : targetLabel(decision.target)}</strong></div><Stamp status={decision.target.kind === "caller" ? "pending" : decision.executable ? "passed" : "blocked"} label={decision.target.kind === "caller" ? "不启动工作" : decision.executable ? "可以启动" : "目标不可执行"} /></header>
      <dl className="ledger horizontal"><dt>决策来源</dt><dd>{decidedByLabel(decision)}</dd><dt>固定目标</dt><dd><code>{targetLabel(decision.target)}</code></dd></dl>
      {decision.warnings.length > 0 && <div className="entrance-warnings">{decision.warnings.map((warning, index) => <span key={`${index}-${warning}`}>{decision.target.kind === "caller" && warning === "direct caller route returns control without creating an Invocation or Run" ? "不会创建内部工单或运行，也不会静默升级给领队。" : warning}</span>)}</div>}
    </article>}
  </div>;
}

export function EntrancePolicyPage({ data, refresh, notify }: PageProps) {
  const daemonAvailable = useDaemonAvailable();
  const policies = data.entrancePolicies ?? [];
  const [selectedId, setSelectedId] = useState(policies.find((policy) => policy.status === "active")?.id ?? policies[0]?.id ?? "");
  const selected = policies.find((policy) => policy.id === selectedId) ?? policies[0];
  const [versions, setVersions] = useState<EntrancePolicy[]>([]);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);

  useEffect(() => {
    if (!selected) { setVersions([]); return; }
    api<{ versions: EntrancePolicy[] }>(`/api/entrance-policies/${selected.id}`)
      .then((detail) => setVersions(detail.versions))
      .catch(() => setVersions([selected]));
  }, [selected?.id, selected?.version]);

  const references = useMemo(() => data.workflows.filter(
    (workflow): workflow is SupervisorWorkflow => workflow.architecture === "supervisor" && workflow.id === selected?.leader?.workflowId
  ), [data.workflows, selected?.leader?.workflowId]);

  const archive = async () => {
    if (!selected) return;
    try {
      await api(`/api/entrance-policies/${selected.id}/archive`, writeBody({}));
      notify(`请求分流策略 ${selected.id} 已归档`);
      setArchiveOpen(false);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const restore = async () => {
    if (!selected) return;
    try {
      await api(`/api/entrance-policies/${selected.id}/restore`, writeBody({}));
      notify(`请求分流策略 ${selected.id} 已恢复`);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };

  return <div className="page-grid page-grid--workflows entrance-policy-page">
    <aside className="record-list"><header className="list-header"><h1>开始一项工作</h1><button className="square-action" disabled={!daemonAvailable} onClick={() => setEditor("new")} aria-label="登记高级启动策略"><UtilityIcon name="add" /></button></header><div className="architecture-summary"><span>{policies.filter((policy) => policy.status === "active").length} 套启动配置</span><small>默认继续讨论</small></div><div className="record-scroll workflow-list">{policies.map((policy) => <button className={`workflow-card ${selected?.id === policy.id ? "selected" : ""}`} key={policy.id} onClick={() => setSelectedId(policy.id)}><div><strong>{policy.displayName}</strong><span>{policy.description}</span><small>{policy.id} · v{policy.version} · {policy.rules.length} 条高级规则</small></div><Stamp status={policy.status} /></button>)}{policies.length === 0 && <div className="mini-empty">尚无工作启动配置。</div>}</div><footer className="list-footer"><span>{policies.length} 套启动配置</span><span>DISCUSS FIRST</span></footer></aside>
    <main className="detail-pane">{!selected ? <EmptyState title="建立第一条请求分流策略" action={<button className="button primary" disabled={!daemonAvailable} onClick={() => setEditor("new")}>登记分流策略</button>}>先用结构化信号决定 direct、specialist 或 leader；此时还没有任务，只有真正分发到内部目标后才会产生运行。</EmptyState> : <div className="dossier workflow-dossier entrance-policy-dossier">
      <header className="dossier-cover entrance-policy-cover"><div className="file-index"><span>REQUEST ROUTING POLICY RECORD</span><code>No. {selected.id.toUpperCase()}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">分</div><div><h2>{selected.displayName}</h2><p>{selected.description}</p></div><Stamp status={selected.status} /></div><div className="dossier-actions"><button className="button primary" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setEditor("edit")}>修订分流策略</button>{selected.status === "active" ? <button className="button danger" disabled={!daemonAvailable} onClick={() => setArchiveOpen(true)}>归档</button> : <button className="button secondary" disabled={!daemonAvailable} onClick={() => void restore()}>恢复并创建 v{selected.version + 1}</button>}</div><RequestLifecycle /></header>
      <DossierSection number="01" title="选择工作方式"><EvaluationDesk policy={selected} data={data} notify={notify} /></DossierSection>
      <DossierSection number="02" title="可用工作目标"><div className="entrance-target-cards"><article className="is-discussion"><span>讨论</span><strong>留在当前对话</strong><p>不创建内部工单或运行；这是默认行为。</p><small>无需配置</small></article>{Object.entries(selected.specialists).map(([key, target]) => <article key={key}><span>单人</span><strong>{target.kind === "employee" ? data.employees.find((employee) => employee.id === target.employeeId)?.identity.displayName ?? target.employeeId : target.kind === "project-role" ? `${target.projectId} / ${target.roleId}` : target.workflowId}</strong><p>{targetLabel(target)}</p><small>固定目标 · {key}</small></article>)}<article className={selected.leader ? "is-team" : "is-unavailable"}><span>团队</span><strong>{selected.leader ? references[0]?.id ?? selected.leader.workflowId : "尚未配置协作编排"}</strong><p>{selected.leader ? "领队动态分工，Flow 与 Gate 约束最终交付。" : "修订高级启动策略后可用。"}</p><small>{selected.leader ? `固定 v${selected.leader.workflowVersion}` : "不可启动"}</small></article></div></DossierSection>
      <DossierSection number="03" title="高级规则与兜底"><details className="entrance-rules-disclosure"><summary><span>查看内部确定性路由规则</span><small>供系统集成和调试使用，正常启动无需理解</small><UtilityIcon name="toggle" /></summary><div className="entrance-rules">{selected.rules.map((rule, index) => <article key={rule.id}><header><span>{String(index + 1).padStart(2, "0")}</span><strong>{rule.id}</strong><code>{resultLabel(rule.result)}</code></header><pre>{JSON.stringify(rule.when, null, 2)}</pre></article>)}{selected.rules.length === 0 && <div className="mini-empty">没有顺序规则；系统集成会使用兜底结果。</div>}</div><div className="entrance-default-result"><span>FALLBACK</span><strong>{resultLabel(selected.default)}</strong></div></details></DossierSection>
      <DossierSection number="04" title="版本记录"><div className="version-strip">{versions.map((version) => <div key={version.version} className={version.version === selected.version ? "current" : ""}><code>v{version.version}</code><span>{version.version === selected.version ? "当前" : version.status === "archived" ? "归档" : "历史"}</span><time>{formatTime(version.updatedAt)}</time></div>)}</div></DossierSection>
    </div>}</main>
    {editor && <PolicyEditor policy={editor === "edit" ? selected : undefined} data={data} notify={notify} onClose={() => setEditor(null)} onSaved={async (saved) => { setEditor(null); setSelectedId(saved.id); await refresh(); }} />}
    {archiveOpen && selected && <Modal title="归档请求分流策略" eyebrow={`${selected.id} · 保留版本证据`} onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>归档后不再接受新试算或分发。</b><p>历史策略版本、固定目标和已有 Invocation / Run 证据继续保留。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveOpen(false)}>取消</button><button className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive()}>确认归档</button></div></div></Modal>}
  </div>;
}
