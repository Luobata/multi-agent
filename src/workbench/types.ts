import type {
  JsonObject,
  JsonValue,
  ProviderDefinition,
  RoleIdentityDefinition,
  RolePermissionDefinition,
  RoleSkillBinding,
  RoleVerdictDefinition
} from "../core/types.js";
import type {
  KnowledgeBaseRecord,
  KnowledgeChangeRequest,
  KnowledgeEvidence,
  KnowledgePlan,
  KnowledgeProfileGrant,
  KnowledgeProfileGrantInput,
  KnowledgeProfileRecord
} from "../knowledge/types.js";
import type { ConfigurationProposal } from "../configuration/types.js";

export type RecordStatus = "active" | "archived";

export type SkillOwner = "system" | "user";
export type SkillInjection = "none" | "supervisor";

export interface WorkbenchSkillDefinition {
  id: string;
  version: number;
  status: RecordStatus;
  owner: SkillOwner;
  injection: SkillInjection;
  displayName: string;
  description: string;
  instructions: string;
  configSchema?: JsonObject;
  tools: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EmployeePresentation {
  accent?: string;
  initials?: string;
  avatarUrl?: string;
}

export interface EmployeeContextPolicy {
  historyLimit: number;
}

export type EmployeeScope =
  | { kind: "global" }
  | { kind: "project"; projectId: string; projectVersion: number };

export type EmployeeScopeInput =
  | { kind: "global" }
  | { kind: "project"; projectId: string; projectVersion?: number };

export interface EmployeeTemplateSource {
  id: string;
  version: number;
}

export interface EmployeeDefinition {
  id: string;
  version: number;
  status: RecordStatus;
  identity: RoleIdentityDefinition;
  description: string;
  systemPrompt: string;
  requestPrompt: string;
  capabilities: string[];
  scope: EmployeeScope;
  template?: EmployeeTemplateSource;
  skills: RoleSkillBinding[];
  skillVersions: Record<string, number>;
  knowledgeProfileIds: string[];
  knowledgeGrants: KnowledgeProfileGrant[];
  providerId: string;
  outputSchema: JsonObject;
  maxAttempts: number;
  permissions: RolePermissionDefinition;
  verdict?: RoleVerdictDefinition;
  contextPolicy: EmployeeContextPolicy;
  presentation: EmployeePresentation;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeRecord {
  current: EmployeeDefinition;
  versions: EmployeeDefinition[];
}

export type EmployeeTemplateDefaults = Omit<EmployeeCreateInput, "id" | "identity"> & {
  identity: Omit<RoleIdentityDefinition, "displayName">;
};

export interface EmployeeTemplateDefinition {
  id: string;
  version: number;
  status: RecordStatus;
  displayName: string;
  description: string;
  defaults: EmployeeTemplateDefaults;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeTemplateRecord {
  current: EmployeeTemplateDefinition;
  versions: EmployeeTemplateDefinition[];
}

export type ManagementPolicyWorkerFailure = "observe-and-replan" | "fail-fast";

export interface ManagementPolicyLimits {
  maxRounds: number;
  maxDelegations: number;
  maxParallelDelegations: number;
  maxDurationMs: number;
}

export interface ManagementPolicyDefinition {
  id: string;
  version: number;
  status: RecordStatus;
  displayName: string;
  description: string;
  /** Stable workflow-local role slots that a supervisor may delegate to. */
  allowedRoleIds: string[];
  /** Soft management guidance injected into every supervisor decision turn. */
  instructions: string;
  limits: ManagementPolicyLimits;
  failure: {
    workerFailure: ManagementPolicyWorkerFailure;
  };
  completion: {
    requireDelegation: boolean;
    requireAllDelegationsSuccessful: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ManagementPolicyRecord {
  current: ManagementPolicyDefinition;
  versions: ManagementPolicyDefinition[];
}

export interface WorkbenchWorkflowNode {
  id: string;
  employeeId: string;
  employeeVersion?: number;
  needs: string[];
  with: JsonObject;
}

export interface WorkbenchWorkflowPresentation {
  positions?: Record<string, { x: number; y: number }>;
}

interface WorkbenchWorkflowBase {
  id: string;
  version: number;
  status: RecordStatus;
  description: string;
  inputSchema?: JsonObject;
  presentation?: WorkbenchWorkflowPresentation;
  createdAt: string;
  updatedAt: string;
}

export interface GraphWorkbenchWorkflowDefinition extends WorkbenchWorkflowBase {
  architecture: "graph";
  /** The graph template used to create this workflow. Runtime behavior is still owned by Graph. */
  patternId?: string;
  nodes: WorkbenchWorkflowNode[];
  maxConcurrency: number;
  failFast: boolean;
}

export interface SupervisorEmployeeBinding {
  employeeId: string;
  employeeVersion: number;
}

export interface SupervisorMemberBinding extends SupervisorEmployeeBinding {
  /** Stable slot exposed to supervisor decisions; it is deliberately separate from Employee identity. */
  roleId: string;
  description: string;
}

export type SupervisorWorkKind = "discussion" | "code" | "test" | "audit" | "integration" | "other";

export type SupervisorFlowStage =
  | { id: string; kind: "supervisor"; title: string }
  | { id: string; kind: "delegation-loop"; title: string }
  | { id: string; kind: "gate"; title: string; gateId: string }
  | { id: string; kind: "delivery"; title: string };

export interface SupervisorGate {
  id: string;
  requiredCapability: string;
  mode: "after-each-delegation" | "before-completion";
  required: boolean;
  instructions: string;
  fallback: "supervisor" | "block";
}

export interface SupervisorFlowDefinition {
  version: number;
  stages: SupervisorFlowStage[];
  gates: SupervisorGate[];
}

export type SupervisorFlowInput = Omit<SupervisorFlowDefinition, "version">;

export interface SupervisorWorkbenchWorkflowDefinition extends WorkbenchWorkflowBase {
  architecture: "supervisor";
  supervisor: SupervisorEmployeeBinding;
  orchestrationSkill: {
    id: "team-orchestration";
    version: number;
  };
  managementPolicy: {
    id: string;
    version: number;
  };
  members: SupervisorMemberBinding[];
  flow: SupervisorFlowDefinition;
}

export type WorkbenchWorkflowDefinition =
  | GraphWorkbenchWorkflowDefinition
  | SupervisorWorkbenchWorkflowDefinition;

export interface WorkbenchWorkflowRecord {
  current: WorkbenchWorkflowDefinition;
  versions: WorkbenchWorkflowDefinition[];
}

export interface EmployeeSessionMessage {
  id: string;
  role: "user" | "employee" | "system";
  content: string;
  at: string;
  runId?: string;
  runDir?: string;
  output?: JsonValue;
}

export interface EmployeeSession {
  id: string;
  employeeId: string;
  employeeVersion: number;
  assignment?: {
    projectId: string;
    projectVersion: number;
    projectBindingVersion: number;
    roleId: string;
  };
  title: string;
  status: "active" | "closed";
  context?: JsonObject;
  messages: EmployeeSessionMessage[];
  createdAt: string;
  updatedAt: string;
}

export type InvocationSourceKind = "workbench" | "http" | "mcp" | "a2a";

export interface InvocationSource {
  kind: InvocationSourceKind;
  label?: string;
  project?: string;
  projectRole?: string;
  projectBindingVersion?: number;
  caller?: string;
  contextId?: string;
  taskId?: string;
  publicationId?: string;
}

export type EntrancePolicyRoute = "auto" | "direct" | "specialist" | "leader";

export type EntrancePolicyRouteResult =
  | { route: "direct" }
  | { route: "specialist"; specialistKey: string }
  | { route: "leader" };

export interface EntrancePolicyEmployeeTarget {
  kind: "employee";
  employeeId: string;
  employeeVersion: number;
}

export interface EntrancePolicyProjectRoleTarget {
  kind: "project-role";
  projectId: string;
  projectVersion: number;
  projectBindingVersion: number;
  roleId: string;
  employeeId: string;
  employeeVersion: number;
}

export interface EntrancePolicyGraphWorkflowTarget {
  kind: "graph-workflow";
  workflowId: string;
  workflowVersion: number;
}

export interface EntrancePolicySupervisorWorkflowTarget {
  kind: "supervisor-workflow";
  workflowId: string;
  workflowVersion: number;
}

export type EntrancePolicySpecialistTarget =
  | EntrancePolicyEmployeeTarget
  | EntrancePolicyProjectRoleTarget
  | EntrancePolicyGraphWorkflowTarget;

export type EntrancePolicyResolvedTarget =
  | { kind: "caller" }
  | EntrancePolicySpecialistTarget
  | EntrancePolicySupervisorWorkflowTarget;

export type EntrancePolicyDirectRoute =
  | { mode: "caller" }
  | ({ mode: "employee" } & Omit<EntrancePolicyEmployeeTarget, "kind">);

export interface EntrancePolicySourceCondition {
  kind?: InvocationSourceKind;
  label?: string;
  project?: string;
  projectRole?: string;
  projectBindingVersion?: number;
  caller?: string;
  contextId?: string;
  taskId?: string;
  publicationId?: string;
}

export interface EntrancePolicySignalComparison {
  eq?: JsonValue;
  neq?: JsonValue;
  gte?: number;
  lte?: number;
  in?: JsonValue[];
  exists?: boolean;
}

export interface EntrancePolicyRuleCondition {
  tagsAllOf?: string[];
  tagsAnyOf?: string[];
  source?: EntrancePolicySourceCondition;
  /** Dot-delimited paths are resolved only inside EvaluationInput.signals. */
  signals?: Record<string, EntrancePolicySignalComparison>;
}

export interface EntrancePolicyRule {
  id: string;
  when: EntrancePolicyRuleCondition;
  result: EntrancePolicyRouteResult;
}

export interface EntrancePolicyRuleInput {
  id?: string;
  when: EntrancePolicyRuleCondition;
  result: EntrancePolicyRouteResult;
}

export interface EntrancePolicyDefinition {
  id: string;
  version: number;
  status: RecordStatus;
  displayName: string;
  description: string;
  direct?: EntrancePolicyDirectRoute;
  specialists: Record<string, EntrancePolicySpecialistTarget>;
  leader?: EntrancePolicySupervisorWorkflowTarget;
  rules: EntrancePolicyRule[];
  default: EntrancePolicyRouteResult;
  createdAt: string;
  updatedAt: string;
}

export interface EntrancePolicyRecord {
  current: EntrancePolicyDefinition;
  versions: EntrancePolicyDefinition[];
}

export interface EntrancePolicyEvaluationInput {
  route: EntrancePolicyRoute;
  specialistKey?: string;
  tags: string[];
  signals: JsonObject;
  source: InvocationSource;
}

export interface EntrancePolicyDecision {
  policyId: string;
  policyVersion: number;
  result: EntrancePolicyRouteResult;
  decidedBy: "explicit" | "rule" | "default";
  matchedRuleId?: string;
  target: EntrancePolicyResolvedTarget;
  executable: boolean;
  warnings: string[];
}

export interface EntrancePolicyExecutionSnapshot {
  policyId: string;
  policyVersion: number;
  result: EntrancePolicyRouteResult;
  decidedBy: EntrancePolicyDecision["decidedBy"];
  target: EntrancePolicyResolvedTarget;
}

export interface EntrancePolicyDispatchInput extends EntrancePolicyEvaluationInput {
  message?: string;
  sessionId?: string;
}

export type EntrancePolicyDispatchResult =
  | {
      decision: EntrancePolicyDecision;
      dispatch: { kind: "return-to-caller"; invocationCreated: false };
    }
  | {
      decision: EntrancePolicyDecision;
      dispatch: { kind: "employee" | "project-role"; result: EmployeeInvocationResult };
    }
  | {
      decision: EntrancePolicyDecision;
      dispatch: { kind: "invocation-started"; receipt: InvocationStartResult };
    };

export type InvocationStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";
export type WorkInstanceStatus =
  | "queued"
  | "waiting"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "skipped"
  | "cancelled";

export interface ActivityTransition<TStatus extends string> {
  at: string;
  status: TStatus;
  phase: string;
  message?: string;
}

/** One addressable request entering the workbench through HTTP, MCP, A2A, or its local debug desk. */
export interface InvocationRecord {
  id: string;
  target: {
    kind: "employee" | "workflow";
    id: string;
    version: number;
  };
  source: InvocationSource;
  status: InvocationStatus;
  phase: string;
  requestSummary: string;
  requestContext?: JsonObject;
  runId: string;
  sessionId?: string;
  instanceIds: string[];
  executionSnapshot?: {
    workflow: { id: string; version: number; architecture: WorkbenchWorkflowDefinition["architecture"] };
    managementPolicy?: { id: string; version: number };
    entrance?: EntrancePolicyExecutionSnapshot;
    employees: Array<{ roleId: string; employeeId: string; employeeVersion: number }>;
  };
  error?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  transitions: Array<ActivityTransition<InvocationStatus>>;
}

/** Ephemeral attendance of one Employee inside an Invocation. The Employee identity itself is never cloned. */
export interface WorkInstanceRecord {
  id: string;
  invocationId: string;
  employeeId: string;
  employeeVersion: number;
  workflowId: string;
  workflowVersion: number;
  nodeId: string;
  /** Workflow-local responsibility slot (distinct from Employee identity). */
  roleId?: string;
  kind?: "graph" | "supervisor" | "member" | "gate";
  round?: number;
  parentNodeId?: string;
  runId: string;
  sessionId?: string;
  providerId: string;
  model?: string;
  source: InvocationSource;
  status: WorkInstanceStatus;
  phase: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  transitions: Array<ActivityTransition<WorkInstanceStatus>>;
}

export interface ActivitySnapshot {
  invocations: InvocationRecord[];
  instances: WorkInstanceRecord[];
}

export interface InvocationStartResult {
  invocation: InvocationRecord;
  runId: string;
}

export interface InvocationDetail {
  invocation: InvocationRecord;
  instances: WorkInstanceRecord[];
  run?: unknown;
}

export type ActivityEvent =
  | { type: "invocation.changed"; at: string; invocation: InvocationRecord }
  | { type: "instance.changed"; at: string; instance: WorkInstanceRecord };

export interface PublicationTarget {
  kind: "employee" | "workflow";
  id: string;
}

export interface PublicationDefinition {
  id: string;
  version: number;
  status: RecordStatus;
  name: string;
  description: string;
  target: PublicationTarget;
  createdAt: string;
  updatedAt: string;
}

export type ProjectScope = "repository" | "workspace";
export type ProjectBindingUpdatePolicy = "locked" | "compatible" | "latest";

export interface ProjectConnectorDefinition {
  kind: string;
  config: JsonObject;
}

/** A role slot is a project-owned contract. It describes the work required, not the Employee identity. */
export interface ProjectRoleContract {
  id: string;
  displayName: string;
  description: string;
  requiredSkills: string[];
  optionalSkills: string[];
  requiredProviderProfiles: string[];
  knowledgeProfileIds: string[];
  instructions: string;
  outputSchema?: JsonObject;
  permissions?: RolePermissionDefinition;
}

export interface ProjectDefinition {
  id: string;
  version: number;
  status: RecordStatus;
  name: string;
  description: string;
  scope: ProjectScope;
  rootPath: string;
  descriptorPath: string;
  connector: ProjectConnectorDefinition;
  roles: ProjectRoleContract[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  current: ProjectDefinition;
  versions: ProjectDefinition[];
}

/** A version-pinned Employee assignment for one project role slot. */
export interface ProjectRoleBinding {
  roleId: string;
  employeeId: string;
  employeeVersion: number;
  skills: RoleSkillBinding[];
  skillVersions: Record<string, number>;
  knowledgeProfileIds: string[];
  knowledgeGrants: KnowledgeProfileGrant[];
  updatePolicy: ProjectBindingUpdatePolicy;
}

export interface ProjectBindingDefinition {
  projectId: string;
  projectVersion: number;
  version: number;
  roles: ProjectRoleBinding[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectBindingRecord {
  current: ProjectBindingDefinition;
  versions: ProjectBindingDefinition[];
}

export interface WorkbenchState {
  schemaVersion: 1;
  providers: Record<string, ProviderDefinition>;
  skills: Record<string, WorkbenchSkillDefinition>;
  skillHistory: Record<string, WorkbenchSkillDefinition[]>;
  knowledgeBases: Record<string, KnowledgeBaseRecord>;
  knowledgeProfiles: Record<string, KnowledgeProfileRecord>;
  knowledgeChangeRequests: Record<string, KnowledgeChangeRequest>;
  configurationProposals: Record<string, ConfigurationProposal>;
  employees: Record<string, EmployeeRecord>;
  employeeTemplates: Record<string, EmployeeTemplateRecord>;
  managementPolicies: Record<string, ManagementPolicyRecord>;
  entrancePolicies: Record<string, EntrancePolicyRecord>;
  workflows: Record<string, WorkbenchWorkflowRecord>;
  sessions: Record<string, EmployeeSession>;
  publications: Record<string, PublicationDefinition>;
  projects: Record<string, ProjectRecord>;
  projectBindings: Record<string, ProjectBindingRecord>;
  invocations: Record<string, InvocationRecord>;
  workInstances: Record<string, WorkInstanceRecord>;
}

export interface ProjectCreateInput {
  id: string;
  name?: string;
  description?: string;
  scope?: ProjectScope;
  rootPath: string;
  descriptorPath: string;
  connector?: Partial<ProjectConnectorDefinition> & Pick<ProjectConnectorDefinition, "kind">;
  roles: Array<Partial<Omit<ProjectRoleContract, "id">> & Pick<ProjectRoleContract, "id">>;
}

export interface ProjectConnectInput {
  rootPath: string;
  descriptorPath?: string;
}

export interface ProjectRoleBindingInput {
  roleId: string;
  employeeId: string;
  employeeVersion?: number;
  skills?: RoleSkillBinding[];
  knowledgeProfileIds?: string[];
  knowledgeGrants?: KnowledgeProfileGrantInput[];
  updatePolicy?: ProjectBindingUpdatePolicy;
}

export interface ProjectBindingInput {
  roles: ProjectRoleBindingInput[];
}

export interface ProjectBindingRefreshResult {
  changed: boolean;
  binding: ProjectBindingDefinition;
  roles: Array<{
    roleId: string;
    status: "current" | "updated" | "locked" | "approval-required";
    message: string;
  }>;
}

export interface EmployeeCreateInput {
  id: string;
  identity: RoleIdentityDefinition;
  description?: string;
  systemPrompt?: string;
  requestPrompt?: string;
  capabilities?: string[];
  scope?: EmployeeScopeInput;
  skills?: RoleSkillBinding[];
  skillVersions?: Record<string, number>;
  knowledgeProfileIds?: string[];
  knowledgeGrants?: KnowledgeProfileGrantInput[];
  providerId?: string;
  outputSchema?: JsonObject;
  maxAttempts?: number;
  permissions?: RolePermissionDefinition;
  verdict?: RoleVerdictDefinition | null;
  contextPolicy?: Partial<EmployeeContextPolicy>;
  presentation?: EmployeePresentation;
}

export type EmployeeUpdateInput = Partial<Omit<EmployeeCreateInput, "id">>;

export interface EmployeeTemplateCreateInput {
  id: string;
  displayName?: string;
  description: string;
  defaults: EmployeeTemplateDefaults;
}

export type EmployeeTemplateUpdateInput = Partial<Omit<EmployeeTemplateCreateInput, "id">>;

export interface EmployeeFromTemplateCreateInput extends Partial<Omit<EmployeeCreateInput, "id" | "identity">> {
  id: string;
  templateVersion?: number;
  identity: Pick<RoleIdentityDefinition, "displayName"> & Partial<Omit<RoleIdentityDefinition, "displayName">>;
}

export interface SkillCreateInput {
  id: string;
  displayName?: string;
  description: string;
  instructions: string;
  configSchema?: JsonObject;
  tools?: string[];
}

export type SkillUpdateInput = Partial<Omit<SkillCreateInput, "id">>;

export interface ManagementPolicyCreateInput {
  id: string;
  displayName?: string;
  description?: string;
  allowedRoleIds: string[];
  instructions: string;
  limits?: Partial<ManagementPolicyLimits>;
  failure?: Partial<ManagementPolicyDefinition["failure"]>;
  completion?: Partial<ManagementPolicyDefinition["completion"]>;
}

export type ManagementPolicyUpdateInput = Partial<Omit<ManagementPolicyCreateInput, "id">>;

export type EntrancePolicySpecialistTargetInput =
  | { kind: "employee"; employeeId: string; employeeVersion?: number }
  | {
      kind: "project-role";
      projectId: string;
      projectVersion?: number;
      projectBindingVersion?: number;
      roleId: string;
    }
  | { kind: "graph-workflow"; workflowId: string; workflowVersion?: number };

export type EntrancePolicyDirectRouteInput =
  | { mode: "caller" }
  | { mode: "employee"; employeeId: string; employeeVersion?: number };

export interface EntrancePolicyLeaderInput {
  workflowId: string;
  workflowVersion?: number;
}

export interface EntrancePolicyCreateInput {
  id: string;
  displayName?: string;
  description?: string;
  direct?: EntrancePolicyDirectRouteInput;
  specialists?: Record<string, EntrancePolicySpecialistTargetInput>;
  leader?: EntrancePolicyLeaderInput;
  rules?: EntrancePolicyRuleInput[];
  default: EntrancePolicyRouteResult;
}

export interface EntrancePolicyUpdateInput {
  displayName?: string;
  description?: string;
  direct?: EntrancePolicyDirectRouteInput | null;
  specialists?: Record<string, EntrancePolicySpecialistTargetInput>;
  leader?: EntrancePolicyLeaderInput | null;
  rules?: EntrancePolicyRuleInput[];
  default?: EntrancePolicyRouteResult;
}

interface WorkflowCreateBase {
  id: string;
  description?: string;
  inputSchema?: JsonObject;
  presentation?: WorkbenchWorkflowPresentation;
}

export interface GraphWorkflowCreateInput extends WorkflowCreateBase {
  architecture?: "graph";
  nodes: Array<Partial<Omit<WorkbenchWorkflowNode, "id" | "employeeId">> & Pick<WorkbenchWorkflowNode, "id" | "employeeId">>;
  maxConcurrency?: number;
  failFast?: boolean;
  patternId?: string;
}

export interface SupervisorWorkflowCreateInput extends WorkflowCreateBase {
  architecture: "supervisor";
  supervisor: { employeeId: string; employeeVersion?: number };
  managementPolicy: { id: string; version?: number };
  members: Array<{
    roleId: string;
    description?: string;
    employeeId: string;
    employeeVersion?: number;
  }>;
  flow?: SupervisorFlowInput;
}

export type WorkflowCreateInput = GraphWorkflowCreateInput | SupervisorWorkflowCreateInput;

export type GraphWorkflowUpdateInput = Partial<Omit<GraphWorkflowCreateInput, "id" | "architecture">> & {
  architecture?: "graph";
};

export type SupervisorWorkflowUpdateInput = Partial<Omit<SupervisorWorkflowCreateInput, "id" | "architecture">> & {
  architecture?: "supervisor";
};

export type WorkflowUpdateInput = GraphWorkflowUpdateInput | SupervisorWorkflowUpdateInput;

export interface EmployeeInvocationInput {
  message: string;
  sessionId?: string;
  context?: JsonObject;
}

export interface EmployeeInvocationResult {
  session: EmployeeSession;
  runId: string;
  runDir: string;
  status: string;
  output?: JsonValue;
  message: string;
}

export type EffectiveConfigurationSourceKind =
  | "employee"
  | "project-contract"
  | "project-binding"
  | "skill"
  | "knowledge-profile"
  | "knowledge-base"
  | "provider"
  | "workflow"
  | "task";

export type EffectiveConfigurationPage =
  | "employees"
  | "projects"
  | "skills"
  | "knowledge"
  | "workflows"
  | "runs";

/** One immutable, expandable source captured when a node is prepared. */
export interface EffectiveConfigurationReference {
  refId: string;
  kind: EffectiveConfigurationSourceKind;
  id: string;
  version?: number;
  revision?: number;
  label: string;
  route?: { page: EffectiveConfigurationPage; entityId: string };
  snapshot: JsonValue;
}

export interface EffectiveConfigurationContribution {
  referenceId: string;
  scope: "employee" | "project" | "run";
  action: "base" | "append" | "select" | "override" | "narrow" | "resolve";
  path?: string;
}

export interface EffectiveConfigurationField {
  key:
    | "identity"
    | "instructions"
    | "capabilities"
    | "skills"
    | "knowledge"
    | "runtime"
    | "permissions"
    | "output-contract"
    | "context-policy"
    | "task"
    | "workflow";
  label: string;
  mergeRule: string;
  value: JsonValue;
  contributions: EffectiveConfigurationContribution[];
}

/**
 * The executable, source-traceable configuration for one runtime node.
 * This is a compiled Run artifact; Employee/Project/Skill records remain the sources of truth.
 */
export interface EffectiveExecutionProfile {
  schemaVersion: 1;
  compiledAt: string;
  runId: string;
  nodeId: string;
  employee: { id: string; version: number; displayName: string };
  assignment?: {
    projectId: string;
    projectVersion: number;
    projectBindingVersion: number;
    roleId: string;
  };
  fields: EffectiveConfigurationField[];
  references: EffectiveConfigurationReference[];
}

export interface EmployeeContextView {
  employee: EmployeeDefinition;
  skills: WorkbenchSkillDefinition[];
  session?: EmployeeSession;
  layers: {
    identity: RoleIdentityDefinition;
    systemPrompt: string;
    skills: Array<{ id: string; enabled: boolean; instructions: string; config: JsonObject; tools: string[] }>;
    knowledge?: {
      plan: KnowledgePlan;
      evidence: KnowledgeEvidence[];
    };
    history: EmployeeSessionMessage[];
    currentRequest?: string;
    dependencyResults: JsonObject;
    runMetadata?: JsonObject;
  };
  effectivePrompt?: {
    system: string;
    request: string;
    combined: string;
    runId: string;
    runDir: string;
  };
  effectiveProfile?: EffectiveExecutionProfile;
}

export const DEFAULT_EMPLOYEE_OUTPUT_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string" }
  }
};
