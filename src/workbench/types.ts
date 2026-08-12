import type {
  HumanDecisionRiskCategory,
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
  /** One-line summary of the skill's rough function, used to help the supervisor judge who fits a task. */
  summary: string;
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
  systemRole?: "automatic" | "conversational";
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

export type ManagementPolicyIsolationMode = "worktree" | "none";

export interface ManagementPolicyExecution {
  /** Execution isolation for delegated work. Omitted = no isolation (current behavior). */
  isolation?: ManagementPolicyIsolationMode;
}

export interface ManagementPolicyLimits {
  maxRounds: number;
  maxDelegations: number;
  maxParallelDelegations: number;
  /** Optional absolute wall-clock ceiling. Omitted = unbounded: the run continues while work makes
   *  progress and is stopped only by per-node idle timeouts or the round/delegation limits. */
  maxDurationMs?: number;
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
  /** Optional execution controls. Omitted = no isolation (current behavior). */
  execution?: ManagementPolicyExecution;
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
  /** Optional evidence validator id; "none" disables the capability's default validator. */
  validatorId?: string;
}

export type SupervisorDagNodeKind =
  | "task"
  | "review"
  | "test"
  | "approval"
  | "merge"
  | "integration"
  | "integration-test"
  | "delivery"
  | "other";
export type SupervisorDagWorkKind = "discussion" | "code" | "test" | "audit" | "integration" | "other";

export interface SupervisorDagNode {
  /** Stable logical identity used by supervisor delegate decisions and Run evidence. */
  nodeId: string;
  /** Workflow-local member slot. Multiple nodes may intentionally reference the same role. */
  roleId: string;
  needs: string[];
  kind: SupervisorDagNodeKind;
  task: string;
  requiredCapabilities: string[];
  workKind: SupervisorDagWorkKind;
  changeSet?: string;
  required: boolean;
}

export interface SupervisorDagDefinition {
  nodes: SupervisorDagNode[];
}

export interface SupervisorDagNodeInput extends Omit<SupervisorDagNode, "roleId" | "required" | "requiredCapabilities" | "workKind"> {
  /** Canonical member slot reference. */
  roleId?: string;
  /** Accepted authoring alias; persisted definitions are normalized to roleId. */
  roleRef?: string;
  requiredCapabilities?: string[];
  workKind?: SupervisorDagWorkKind;
  required?: boolean;
}

export interface SupervisorDagInput {
  nodes: SupervisorDagNodeInput[];
}

export interface SupervisorFlowDefinition {
  version: number;
  stages: SupervisorFlowStage[];
  gates: SupervisorGate[];
  dag?: SupervisorDagDefinition;
}

export interface SupervisorFlowInput {
  stages: SupervisorFlowStage[];
  gates: SupervisorGate[];
  dag?: SupervisorDagInput;
}

export interface SupervisorWorkbenchWorkflowDefinition extends WorkbenchWorkflowBase {
  architecture: "supervisor";
  /** How pinned versions track their sources. "latest" re-resolves supervisor/members/policy/skill
   *  to their newest versions on every run; "locked" keeps the pinned versions until synced. */
  updatePolicy: SupervisorWorkflowUpdatePolicy;
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

export type SupervisorWorkflowUpdatePolicy = "latest" | "locked";

/** One version change surfaced by refreshing a workflow's pinned sources to latest. */
export interface WorkflowRefreshChange {
  kind: "supervisor" | "member" | "management-policy" | "orchestration-skill";
  id: string;
  from: number;
  to: number;
}

export interface WorkflowRefreshResult {
  workflow: SupervisorWorkbenchWorkflowDefinition;
  changed: boolean;
  changes: WorkflowRefreshChange[];
}

/** One Entrance Policy version created while re-pinning references to a Supervisor Workflow. */
export interface WorkflowEntrancePolicyRefreshChange {
  policyId: string;
  fromPolicyVersion: number;
  toPolicyVersion: number;
  fromWorkflowVersion: number;
  toWorkflowVersion: number;
}

export interface WorkflowEntrancePolicyRefreshResult {
  workflowId: string;
  workflowVersion: number;
  changed: boolean;
  changes: WorkflowEntrancePolicyRefreshChange[];
}

export type WorkbenchWorkflowDefinition =
  | GraphWorkbenchWorkflowDefinition
  | SupervisorWorkbenchWorkflowDefinition;

export interface WorkbenchWorkflowRecord {
  current: WorkbenchWorkflowDefinition;
  versions: WorkbenchWorkflowDefinition[];
}

/** A single gate mutation proposed against a supervisor workflow's flow. */
export type WorkflowChangeOperation =
  | { kind: "add-gate"; gate: SupervisorGate; rationale: string; risk: string }
  | { kind: "update-gate"; gateId: string; patch: Partial<Omit<SupervisorGate, "id">>; rationale: string; risk: string }
  | { kind: "remove-gate"; gateId: string; rationale: string; risk: string };

/** A human-approved proposal to change a supervisor workflow's gates. Mirrors KnowledgeChangeRequest. */
export interface WorkflowChangeRequest {
  id: string;
  workflowId: string;
  /** Frozen at proposal time: the workflow version the operations were authored against. */
  workflowVersion: number;
  status: "awaiting-approval" | "applied" | "rejected";
  title: string;
  reason: string;
  /** Defaults to "gate-steward". */
  requestedBy: string;
  operations: WorkflowChangeOperation[];
  review?: { actor: string; comment?: string; at: string };
  createdAt: string;
  updatedAt: string;
}

/** Input for proposing a supervisor workflow gate change. Mirrors KnowledgeChangeCreateInput. */
export interface WorkflowChangeCreateInput {
  workflowId: string;
  title: string;
  reason: string;
  /** Defaults to "gate-steward" when omitted. */
  requestedBy?: string;
  operations: WorkflowChangeOperation[];
}

export interface EmployeeSessionMessage {
  id: string;
  role: "user" | "employee" | "system";
  content: string;
  at: string;
  /** Stable image metadata only. Binary/base64 payloads and filesystem paths are never persisted in state.json. */
  attachments?: ConversationImageAttachmentMetadata[];
  /** Frozen external-document metadata. Document bodies and filesystem paths live in the conversation evidence store. */
  documents?: ConversationDocumentEvidenceMetadata[];
  /** Stable key used by deterministic background writers to avoid duplicate progress/delivery messages. */
  dedupeKey?: string;
  runId?: string;
  runDir?: string;
  output?: JsonValue;
}

export interface SupervisorSessionContext {
  architecture: "supervisor";
  invocationId: string;
  runId: string;
  workflowId: string;
  workflowVersion: number;
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
  /** Present only for the durable leader conversation created by an asynchronous Supervisor run. */
  supervisor?: SupervisorSessionContext;
  messages: EmployeeSessionMessage[];
  createdAt: string;
  updatedAt: string;
}

export type InvocationSourceKind = "workbench" | "http" | "mcp" | "a2a";

export interface InvocationSource {
  kind: InvocationSourceKind;
  label?: string;
  project?: string;
  /** The project the conversation is about when a compatible host role is reused. */
  targetProject?: string;
  projectRole?: string;
  projectBindingVersion?: number;
  caller?: string;
  contextId?: string;
  taskId?: string;
  /** Caller-chosen durable key used to deduplicate asynchronous dispatch retries. */
  idempotencyKey?: string;
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
  idempotencyKey?: string;
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

export type InvocationStatus =
  | "queued"
  | "running"
  | "awaiting-human-decision"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";
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

export type HumanDecisionRequestStatus = "pending" | "approved" | "rejected" | "voided";

/** Durable control-plane record pinned to the exact Supervisor decision that created it. */
export interface HumanDecisionRequest {
  id: string;
  idempotencyKey: string;
  invocationId: string;
  runId: string;
  workflowId: string;
  workflowVersion: number;
  supervisorNodeId: string;
  round: number;
  riskCategory: HumanDecisionRiskCategory;
  summary: string;
  proposedAction: JsonObject;
  status: HumanDecisionRequestStatus;
  decidedBy?: string;
  comment?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

export interface HumanDecisionRequestCreateInput {
  invocationId: string;
  runId: string;
  workflowId: string;
  workflowVersion: number;
  supervisorNodeId: string;
  round: number;
  riskCategory: HumanDecisionRiskCategory;
  summary: string;
  proposedAction: JsonObject;
}

export interface HumanDecisionRequestDecisionInput {
  decision: "approve" | "reject";
  decidedBy: string;
  comment?: string;
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
  /** Original request text when the caller supplied one; optional for legacy persisted invocations. */
  requestText?: string;
  /** Caller-supplied task description when distinct from the request text. */
  taskDescription?: string;
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
  /** All execution-node turns served by this logical member session. `nodeId` is the active/latest turn. */
  nodeIds?: string[];
  /** Workflow-local responsibility slot (distinct from Employee identity). */
  roleId?: string;
  kind?: "graph" | "supervisor" | "member" | "gate";
  round?: number;
  parentNodeId?: string;
  /** Supervisor-managed logical continuity across bounded TODO calls to the same member role/change set. */
  memberSessionId?: string;
  memberSessionKey?: string;
  memberSessionRetained?: boolean;
  todoId?: string;
  runId: string;
  sessionId?: string;
  providerId: string;
  model?: string;
  source: InvocationSource;
  status: WorkInstanceStatus;
  phase: string;
  error?: string;
  failure?: import("../core/types.js").NodeRunFailure;
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
  /** Only Supervisor workflows create a durable leader conversation. Graph workflows never set this. */
  leaderSessionId?: string;
  monitor: WorkflowMonitorContract;
}

export interface WorkflowMonitorContract {
  mode: "long-poll";
  tool: "wait_workflow_progress";
  initialCursor: string;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  instructions: string;
}

export interface InvocationDetail {
  invocation: InvocationRecord;
  instances: WorkInstanceRecord[];
  humanDecisionRequests?: HumanDecisionRequest[];
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

/** Durable evidence that an MCP client running inside a local project contacted the workbench. */
export interface PassiveProjectAccessRecord {
  id: string;
  /** Missing on records recovered from legacy Invocation metadata. */
  rootPath?: string;
  /** MCP source.project values observed for this project directory. */
  projectKeys: string[];
  displayName: string;
  transport: "mcp";
  requestCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Resolved dynamically when the observed root or project key matches a connected Project. */
  linkedProjectId?: string;
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
  workflowChangeRequests: Record<string, WorkflowChangeRequest>;
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
  passiveProjectAccesses: Record<string, PassiveProjectAccessRecord>;
  invocations: Record<string, InvocationRecord>;
  workInstances: Record<string, WorkInstanceRecord>;
  humanDecisionRequests: Record<string, HumanDecisionRequest>;
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
  /** Explicit control-plane consent to scaffold a missing descriptor. Passive MCP discovery never sets this. */
  createDescriptorIfMissing?: boolean;
  /** Passive MCP evidence used only to seed a valid starter descriptor. */
  projectIdHint?: string;
  projectNameHint?: string;
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
  systemRole?: "automatic" | "conversational";
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
  /** Optional one-line function summary; derived from the description's first sentence when omitted. */
  summary?: string;
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
  /** maxDurationMs accepts null to explicitly clear an existing absolute ceiling (unbounded). */
  limits?: Partial<Omit<ManagementPolicyLimits, "maxDurationMs">> & { maxDurationMs?: number | null };
  failure?: Partial<ManagementPolicyDefinition["failure"]>;
  completion?: Partial<ManagementPolicyDefinition["completion"]>;
  execution?: ManagementPolicyExecution;
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
  /** Defaults to "latest" when omitted. */
  updatePolicy?: SupervisorWorkflowUpdatePolicy;
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
  /** Base64-encoded image attachments. Arbitrary files and data URLs are not accepted. */
  attachments?: ConversationImageAttachmentInput[];
}

export type ConversationImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ConversationImageAttachmentInput {
  name: string;
  mediaType: ConversationImageMediaType;
  base64: string;
}

export interface ConversationImageAttachmentMetadata {
  id: string;
  kind: "image";
  name: string;
  mediaType: ConversationImageMediaType;
  sizeBytes: number;
  sha256: string;
}

export interface ConversationDocumentEvidenceMetadata {
  id: string;
  kind: "lark-document";
  url: string;
  status: "available" | "failed";
  fetchedAt: string;
  documentId?: string;
  revisionId?: string;
  contentBytes?: number;
  sha256?: string;
  error?: {
    code: string;
    message: string;
    action: string;
  };
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
