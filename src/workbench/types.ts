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

export type RecordStatus = "active" | "archived";

export interface WorkbenchSkillDefinition {
  id: string;
  version: number;
  status: RecordStatus;
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

export interface EmployeeDefinition {
  id: string;
  version: number;
  status: RecordStatus;
  identity: RoleIdentityDefinition;
  description: string;
  systemPrompt: string;
  requestPrompt: string;
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

export interface WorkbenchWorkflowNode {
  id: string;
  employeeId: string;
  employeeVersion?: number;
  needs: string[];
  with: JsonObject;
}

export interface WorkbenchWorkflowDefinition {
  id: string;
  version: number;
  status: RecordStatus;
  architecture: "graph";
  /** The graph template used to create this workflow. Runtime behavior is still owned by Graph. */
  patternId?: string;
  description: string;
  nodes: WorkbenchWorkflowNode[];
  maxConcurrency: number;
  failFast: boolean;
  inputSchema?: JsonObject;
  presentation?: {
    positions?: Record<string, { x: number; y: number }>;
  };
  createdAt: string;
  updatedAt: string;
}

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
  runId: string;
  sessionId?: string;
  instanceIds: string[];
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
  employees: Record<string, EmployeeRecord>;
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

export interface SkillCreateInput {
  id: string;
  displayName?: string;
  description: string;
  instructions: string;
  configSchema?: JsonObject;
  tools?: string[];
}

export type SkillUpdateInput = Partial<Omit<SkillCreateInput, "id">>;

export interface WorkflowCreateInput {
  id: string;
  description?: string;
  nodes: Array<Partial<Omit<WorkbenchWorkflowNode, "id" | "employeeId">> & Pick<WorkbenchWorkflowNode, "id" | "employeeId">>;
  maxConcurrency?: number;
  failFast?: boolean;
  inputSchema?: JsonObject;
  patternId?: string;
  presentation?: WorkbenchWorkflowDefinition["presentation"];
}

export type WorkflowUpdateInput = Partial<Omit<WorkflowCreateInput, "id">>;

export interface EmployeeInvocationInput {
  message: string;
  sessionId?: string;
}

export interface EmployeeInvocationResult {
  session: EmployeeSession;
  runId: string;
  runDir: string;
  status: string;
  output?: JsonValue;
  message: string;
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
}

export const DEFAULT_EMPLOYEE_OUTPUT_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string" }
  }
};
