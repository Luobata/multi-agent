import type { JsonValue, ProviderDefinition, RoleSkillBinding } from "../core/types.js";
import type { KnowledgeRuntimeResult } from "../knowledge/types.js";
import type {
  EffectiveConfigurationContribution,
  EffectiveConfigurationField,
  EffectiveConfigurationReference,
  EffectiveExecutionProfile,
  EmployeeDefinition,
  InvocationRecord,
  ProjectBindingDefinition,
  ProjectDefinition,
  ProjectRoleBinding,
  ProjectRoleContract,
  WorkbenchState,
  WorkbenchWorkflowDefinition,
  WorkbenchSkillDefinition
} from "./types.js";

export interface EffectiveProfileCompilationInput {
  state: WorkbenchState;
  invocation: InvocationRecord;
  employee: EmployeeDefinition;
  nodeId: string;
  request: string;
  taskTags: string[];
  knowledge: KnowledgeRuntimeResult;
  compiledAt?: string;
}

function jsonSnapshot(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function bindingId(binding: RoleSkillBinding): string {
  return typeof binding === "string" ? binding : binding.id;
}

function employeeVersion(state: WorkbenchState, id: string, version: number): EmployeeDefinition {
  const record = state.employees[id];
  const employee = record?.versions.find((candidate) => candidate.version === version);
  if (!employee) throw new Error(`effective profile employee ${id} v${version} is unavailable`);
  return employee;
}

function skillVersion(state: WorkbenchState, id: string, version: number): WorkbenchSkillDefinition {
  const current = state.skills[id];
  if (current?.version === version) return current;
  const historical = state.skillHistory[id]?.find((candidate) => candidate.version === version);
  if (!historical) throw new Error(`effective profile skill ${id} v${version} is unavailable`);
  return historical;
}

function workflowVersion(
  state: WorkbenchState,
  id: string,
  version: number
): WorkbenchWorkflowDefinition | undefined {
  return state.workflows[id]?.versions.find((candidate) => candidate.version === version);
}

function safeProviderSnapshot(id: string, provider: ProviderDefinition): JsonValue {
  return jsonSnapshot({
    id,
    adapter: provider.adapter,
    model: provider.model,
    runtimeProfiles: provider.runtimeProfiles,
    outputProtocol: provider.outputProtocol
  });
}

function referenceId(kind: EffectiveConfigurationReference["kind"], id: string, version?: number, revision?: number): string {
  return [kind, id, version === undefined ? undefined : `v${version}`, revision === undefined ? undefined : `r${revision}`]
    .filter(Boolean)
    .join(":");
}

function contribution(
  reference: EffectiveConfigurationReference,
  scope: EffectiveConfigurationContribution["scope"],
  action: EffectiveConfigurationContribution["action"],
  path?: string
): EffectiveConfigurationContribution {
  return { referenceId: reference.refId, scope, action, path };
}

function projectAssignmentSources(
  state: WorkbenchState,
  invocation: InvocationRecord
): {
  assignment?: EffectiveExecutionProfile["assignment"];
  project?: ProjectDefinition;
  role?: ProjectRoleContract;
  binding?: ProjectBindingDefinition;
  roleBinding?: ProjectRoleBinding;
} {
  const session = invocation.sessionId ? state.sessions[invocation.sessionId] : undefined;
  const assignment = session?.assignment;
  if (!assignment) return {};
  const project = state.projects[assignment.projectId]?.versions.find(
    (candidate) => candidate.version === assignment.projectVersion
  );
  const binding = state.projectBindings[assignment.projectId]?.versions.find(
    (candidate) => candidate.version === assignment.projectBindingVersion
  );
  if (!project || !binding) throw new Error(`effective profile project assignment ${assignment.projectId} is unavailable`);
  const role = project.roles.find((candidate) => candidate.id === assignment.roleId);
  const roleBinding = binding.roles.find((candidate) => candidate.roleId === assignment.roleId);
  if (!role || !roleBinding) throw new Error(`effective profile project role ${assignment.projectId}/${assignment.roleId} is unavailable`);
  return { assignment, project, role, binding, roleBinding };
}

/** Compile the exact node configuration and its immutable source snapshots. */
export function compileEffectiveExecutionProfile(input: EffectiveProfileCompilationInput): EffectiveExecutionProfile {
  const { state, invocation, employee, knowledge } = input;
  const references: EffectiveConfigurationReference[] = [];
  const addReference = (reference: EffectiveConfigurationReference): EffectiveConfigurationReference => {
    const existing = references.find((candidate) => candidate.refId === reference.refId);
    if (existing) return existing;
    references.push(reference);
    return reference;
  };

  const baseEmployee = employeeVersion(state, employee.id, employee.version);
  const employeeRef = addReference({
    refId: referenceId("employee", baseEmployee.id, baseEmployee.version),
    kind: "employee",
    id: baseEmployee.id,
    version: baseEmployee.version,
    label: `${baseEmployee.identity.displayName} · Employee v${baseEmployee.version}`,
    route: { page: "employees", entityId: baseEmployee.id },
    snapshot: jsonSnapshot(baseEmployee)
  });

  const assignmentSources = projectAssignmentSources(state, invocation);
  let contractRef: EffectiveConfigurationReference | undefined;
  let bindingRef: EffectiveConfigurationReference | undefined;
  if (assignmentSources.assignment && assignmentSources.project && assignmentSources.role && assignmentSources.binding && assignmentSources.roleBinding) {
    const { assignment, project, role, binding, roleBinding } = assignmentSources;
    contractRef = addReference({
      refId: referenceId("project-contract", `${project.id}/${role.id}`, project.version),
      kind: "project-contract",
      id: `${project.id}/${role.id}`,
      version: project.version,
      label: `${project.name} / ${role.displayName} · Contract v${project.version}`,
      route: { page: "projects", entityId: project.id },
      snapshot: jsonSnapshot({
        project: { id: project.id, version: project.version, name: project.name, description: project.description, scope: project.scope },
        role
      })
    });
    bindingRef = addReference({
      refId: referenceId("project-binding", `${project.id}/${role.id}`, binding.version),
      kind: "project-binding",
      id: `${project.id}/${role.id}`,
      version: binding.version,
      label: `${project.name} / ${role.displayName} · Binding v${binding.version}`,
      route: { page: "projects", entityId: project.id },
      snapshot: jsonSnapshot({
        projectId: binding.projectId,
        projectVersion: binding.projectVersion,
        bindingVersion: binding.version,
        role: roleBinding,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt
      })
    });
  }

  const skillReferences = employee.skills.map((binding) => {
    const id = bindingId(binding);
    const version = employee.skillVersions[id];
    if (!version) throw new Error(`effective profile employee ${employee.id} does not pin skill ${id}`);
    const skill = skillVersion(state, id, version);
    return addReference({
      refId: referenceId("skill", id, version),
      kind: "skill",
      id,
      version,
      label: `${skill.displayName} · Skill v${version}`,
      route: { page: "skills", entityId: id },
      snapshot: jsonSnapshot({ definition: skill, binding })
    });
  });

  const profileReferences = Object.entries(knowledge.plan.profileVersions).map(([id, version]) => {
    const profile = state.knowledgeProfiles[id]?.versions.find((candidate) => candidate.version === version);
    if (!profile) throw new Error(`effective profile knowledge profile ${id} v${version} is unavailable`);
    return addReference({
      refId: referenceId("knowledge-profile", id, version),
      kind: "knowledge-profile",
      id,
      version,
      label: `${profile.displayName} · Knowledge Profile v${version}`,
      route: { page: "knowledge", entityId: id },
      snapshot: jsonSnapshot(profile)
    });
  });

  const selectedByBase = new Map<string, typeof knowledge.plan.selectedCollections>();
  for (const selected of knowledge.plan.selectedCollections) {
    selectedByBase.set(selected.knowledgeBaseId, [...(selectedByBase.get(selected.knowledgeBaseId) ?? []), selected]);
  }
  const knowledgeBaseReferences = [...selectedByBase.entries()].map(([id, selected]) => {
    const record = state.knowledgeBases[id];
    if (!record) throw new Error(`effective profile knowledge base ${id} is unavailable`);
    const revision = selected[0]!.revision;
    return addReference({
      refId: referenceId("knowledge-base", id, record.current.version, revision),
      kind: "knowledge-base",
      id,
      version: record.current.version,
      revision,
      label: `${record.current.displayName} · Knowledge v${record.current.version} / r${revision}`,
      route: { page: "knowledge", entityId: id },
      snapshot: jsonSnapshot({ definition: record.current, selectedCollections: selected })
    });
  });

  const provider = state.providers[employee.providerId];
  if (!provider) throw new Error(`effective profile provider ${employee.providerId} is unavailable`);
  const providerRef = addReference({
    refId: referenceId("provider", employee.providerId),
    kind: "provider",
    id: employee.providerId,
    label: `${employee.providerId} · Provider`,
    snapshot: safeProviderSnapshot(employee.providerId, provider)
  });

  const workflowSnapshot = invocation.executionSnapshot?.workflow;
  const pinnedWorkflow = workflowSnapshot
    ? workflowVersion(state, workflowSnapshot.id, workflowSnapshot.version)
    : undefined;
  const workflowRef = addReference({
    refId: referenceId("workflow", workflowSnapshot?.id ?? invocation.target.id, workflowSnapshot?.version ?? invocation.target.version),
    kind: "workflow",
    id: workflowSnapshot?.id ?? invocation.target.id,
    version: workflowSnapshot?.version ?? invocation.target.version,
    label: `${workflowSnapshot?.id ?? invocation.target.id} · Workflow v${workflowSnapshot?.version ?? invocation.target.version}`,
    route: pinnedWorkflow ? { page: "workflows", entityId: pinnedWorkflow.id } : undefined,
    snapshot: jsonSnapshot(pinnedWorkflow ?? {
      executionSnapshot: invocation.executionSnapshot ?? { workflow: workflowSnapshot ?? invocation.target },
      node: { id: input.nodeId, employeeId: employee.id, employeeVersion: employee.version }
    })
  });

  const taskRef = addReference({
    refId: referenceId("task", invocation.runId),
    kind: "task",
    id: invocation.runId,
    label: `${invocation.runId} · Task`,
    route: { page: "runs", entityId: invocation.runId },
    snapshot: jsonSnapshot({
      invocationId: invocation.id,
      runId: invocation.runId,
      request: input.request,
      requestContext: invocation.requestContext,
      taskTags: input.taskTags,
      source: invocation.source
    })
  });

  const employeeBase = (path?: string) => contribution(employeeRef, "employee", "base", path);
  const projectContribution = (
    reference: EffectiveConfigurationReference | undefined,
    action: EffectiveConfigurationContribution["action"],
    path: string
  ): EffectiveConfigurationContribution[] => reference ? [contribution(reference, "project", action, path)] : [];

  const fields: EffectiveConfigurationField[] = [
    {
      key: "identity",
      label: "身份与职责",
      mergeRule: "Employee 身份为基础；项目分配只追加可追踪的 assignment 元数据，不改写员工身份。",
      value: jsonSnapshot(employee.identity),
      contributions: [employeeBase("identity"), ...projectContribution(contractRef, "append", "project.role")]
    },
    {
      key: "instructions",
      label: "执行指令",
      mergeRule: "Employee 长期指令为基础；Project Contract 指令按项目作用域追加。",
      value: jsonSnapshot({ systemPrompt: employee.systemPrompt, requestPrompt: employee.requestPrompt }),
      contributions: [
        employeeBase("systemPrompt"),
        employeeBase("requestPrompt"),
        ...projectContribution(contractRef, "append", "project.role.instructions")
      ]
    },
    {
      key: "capabilities",
      label: "能力声明",
      mergeRule: "能力来自固定 Employee 版本；项目只校验兼容性，不在运行时扩张能力。",
      value: jsonSnapshot(employee.capabilities),
      contributions: [employeeBase("capabilities")]
    },
    {
      key: "skills",
      label: "技能与约束",
      mergeRule: bindingRef ? "Project Binding 从 Employee 已具备的 Skill 中选择并固定版本。" : "Employee 绑定选择并固定 Skill 版本。",
      value: jsonSnapshot(employee.skills.map((binding) => ({ binding, version: employee.skillVersions[bindingId(binding)] }))),
      contributions: [
        contribution(bindingRef ?? employeeRef, bindingRef ? "project" : "employee", "select", bindingRef ? "role.skills" : "skills"),
        ...skillReferences.map((reference) => contribution(reference, "employee", "resolve", "definition"))
      ]
    },
    {
      key: "knowledge",
      label: "知识选择",
      mergeRule: "Employee 与 Project Binding 的授权先合并；Knowledge Profile 再按当前 Task 确定集合和 Revision。",
      value: jsonSnapshot({
        profileVersions: knowledge.plan.profileVersions,
        selectedCollections: knowledge.plan.selectedCollections,
        exclusions: knowledge.plan.exclusions,
        strategy: knowledge.plan.strategy
      }),
      contributions: [
        employeeBase("knowledgeProfileIds"),
        ...projectContribution(bindingRef, "append", "role.knowledgeProfileIds"),
        ...profileReferences.map((reference) => contribution(reference, "run", "resolve", "rules")),
        ...knowledgeBaseReferences.map((reference) => contribution(reference, "run", "select", "selectedCollections"))
      ]
    },
    {
      key: "runtime",
      label: "运行时",
      mergeRule: "Employee 选择 Provider 与重试上限；Provider 运行定义单独解析，敏感启动参数不复制到检查器。",
      value: jsonSnapshot({ providerId: employee.providerId, model: provider.model, maxAttempts: employee.maxAttempts }),
      contributions: [employeeBase("providerId"), employeeBase("maxAttempts"), contribution(providerRef, "employee", "resolve")]
    },
    {
      key: "permissions",
      label: "权限边界",
      mergeRule: contractRef ? "Employee 权限与 Project Contract 权限取更严格交集。" : "直接使用固定 Employee 版本的权限。",
      value: jsonSnapshot(employee.permissions),
      contributions: [employeeBase("permissions"), ...projectContribution(contractRef, "narrow", "project.role.permissions")]
    },
    {
      key: "output-contract",
      label: "输出契约",
      mergeRule: contractRef ? "Project Contract 可覆盖输出 Schema；否则使用 Employee 默认契约。" : "使用固定 Employee 版本的输出契约。",
      value: jsonSnapshot({ outputSchema: employee.outputSchema, verdict: employee.verdict }),
      contributions: [employeeBase("outputSchema"), employeeBase("verdict"), ...projectContribution(contractRef, "override", "project.role.outputSchema")]
    },
    {
      key: "context-policy",
      label: "上下文策略",
      mergeRule: "Session 读取范围由固定 Employee 版本控制。",
      value: jsonSnapshot(employee.contextPolicy),
      contributions: [employeeBase("contextPolicy")]
    },
    {
      key: "task",
      label: "当前任务",
      mergeRule: "Task 是本次运行输入，只在 Run 作用域生效。",
      value: jsonSnapshot({ request: input.request, taskTags: input.taskTags, source: invocation.source }),
      contributions: [contribution(taskRef, "run", "override")]
    },
    {
      key: "workflow",
      label: "执行编排",
      mergeRule: "Workflow 只决定本次节点和依赖关系，不修改 Employee 或项目配置。",
      value: jsonSnapshot(invocation.executionSnapshot?.workflow ?? invocation.target),
      contributions: [contribution(workflowRef, "run", "resolve")]
    }
  ];

  return {
    schemaVersion: 1,
    compiledAt: input.compiledAt ?? new Date().toISOString(),
    runId: invocation.runId,
    nodeId: input.nodeId,
    employee: { id: employee.id, version: employee.version, displayName: employee.identity.displayName },
    assignment: assignmentSources.assignment,
    fields,
    references
  };
}
