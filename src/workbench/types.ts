import type {
  JsonObject,
  JsonValue,
  ProviderDefinition,
  RoleIdentityDefinition,
  RolePermissionDefinition,
  RoleSkillBinding,
  RoleVerdictDefinition
} from "../core/types.js";

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
  title: string;
  status: "active" | "closed";
  messages: EmployeeSessionMessage[];
  createdAt: string;
  updatedAt: string;
}

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

export interface WorkbenchState {
  schemaVersion: 1;
  providers: Record<string, ProviderDefinition>;
  skills: Record<string, WorkbenchSkillDefinition>;
  skillHistory: Record<string, WorkbenchSkillDefinition[]>;
  employees: Record<string, EmployeeRecord>;
  workflows: Record<string, WorkbenchWorkflowRecord>;
  sessions: Record<string, EmployeeSession>;
  publications: Record<string, PublicationDefinition>;
}

export interface EmployeeCreateInput {
  id: string;
  identity: RoleIdentityDefinition;
  description?: string;
  systemPrompt?: string;
  requestPrompt?: string;
  skills?: RoleSkillBinding[];
  skillVersions?: Record<string, number>;
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
