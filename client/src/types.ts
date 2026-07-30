export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ProviderEntry {
  id: string;
  definition: { adapter: string; model?: string; [key: string]: unknown };
}

export interface Skill {
  id: string;
  version: number;
  status: "active" | "archived";
  displayName: string;
  description: string;
  instructions: string;
  tools: string[];
  configSchema?: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export type SkillBinding = string | { id: string; config?: JsonObject; enabled?: boolean };

export interface Employee {
  id: string;
  version: number;
  status: "active" | "archived";
  identity: {
    displayName: string;
    background: string;
    responsibilities: string[];
    goals?: string[];
    constraints?: string[];
    metadata?: JsonObject;
  };
  description: string;
  systemPrompt: string;
  requestPrompt: string;
  skills: SkillBinding[];
  skillVersions: Record<string, number>;
  providerId: string;
  outputSchema: JsonObject;
  maxAttempts: number;
  verdict?: { path: string; pass: Array<string | number | boolean | null>; block: Array<string | number | boolean | null> };
  permissions: { write: "none" | "artifacts-only" | "project"; tools?: string[] };
  contextPolicy: { historyLimit: number };
  presentation: { accent?: string; initials?: string; avatarUrl?: string };
  createdAt: string;
  updatedAt: string;
}

export interface SessionMessage {
  id: string;
  role: "user" | "employee" | "system";
  content: string;
  at: string;
  runId?: string;
  runDir?: string;
  output?: JsonValue;
}

export interface Session {
  id: string;
  employeeId: string;
  employeeVersion: number;
  title: string;
  status: "active" | "closed";
  messages: SessionMessage[];
  createdAt: string;
  updatedAt: string;
}

export type InvocationSourceKind = "workbench" | "http" | "mcp" | "a2a";

export interface InvocationSource {
  kind: InvocationSourceKind;
  label?: string;
  project?: string;
  caller?: string;
  contextId?: string;
  taskId?: string;
  publicationId?: string;
}

export type InvocationStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";
export type WorkInstanceStatus = "queued" | "waiting" | "running" | "completed" | "blocked" | "failed" | "skipped" | "cancelled";

export interface InvocationRecord {
  id: string;
  target: { kind: "employee" | "workflow"; id: string; version: number };
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
  transitions: Array<{ at: string; status: InvocationStatus; phase: string; message?: string }>;
}

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
  transitions: Array<{ at: string; status: WorkInstanceStatus; phase: string; message?: string }>;
}

export interface ActivitySnapshot {
  invocations: InvocationRecord[];
  instances: WorkInstanceRecord[];
}

export type ActivityEvent =
  | { type: "invocation.changed"; at: string; invocation: InvocationRecord }
  | { type: "instance.changed"; at: string; instance: WorkInstanceRecord };

export interface WorkflowNode {
  id: string;
  employeeId: string;
  employeeVersion?: number;
  needs: string[];
  with: JsonObject;
}

export interface Workflow {
  id: string;
  version: number;
  status: "active" | "archived";
  architecture: "graph";
  patternId?: string;
  description: string;
  nodes: WorkflowNode[];
  maxConcurrency: number;
  failFast: boolean;
  inputSchema?: JsonObject;
  presentation?: { positions?: Record<string, { x: number; y: number }> };
  createdAt: string;
  updatedAt: string;
}

export interface ArchitectureTemplate {
  id: string;
  displayName: string;
  pattern: string;
  summary: string;
  bestFor: string;
  slots: Array<{ id: string; label: string; description: string }>;
  maxConcurrency: number;
  failFast: boolean;
}

export interface InstantiatedArchitectureTemplate {
  patternId: string;
  description: string;
  nodes: WorkflowNode[];
  maxConcurrency: number;
  failFast: boolean;
}

export interface RunNode {
  nodeId: string;
  roleId: string;
  status: "pending" | "running" | "passed" | "blocked" | "failed" | "skipped";
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  output?: JsonValue;
  error?: string;
  artifactDir?: string;
}

export interface Run {
  id: string;
  workflow: string;
  architecture: string;
  artifactDir: string;
  status: "running" | "passed" | "blocked" | "failed";
  createdAt: string;
  completedAt?: string;
  nodes: Record<string, RunNode>;
}

export interface Publication {
  id: string;
  version: number;
  status: "active" | "archived";
  name: string;
  description: string;
  target: { kind: "employee" | "workflow"; id: string };
  createdAt: string;
  updatedAt: string;
}

export interface Bootstrap {
  providers: ProviderEntry[];
  skills: Skill[];
  architectureTemplates: ArchitectureTemplate[];
  employees: Employee[];
  workflows: Workflow[];
  sessions: Session[];
  publications: Publication[];
  activity: ActivitySnapshot;
}

export interface ContextView {
  employee: Employee;
  skills: Skill[];
  session?: Session;
  layers: {
    identity: Employee["identity"];
    systemPrompt: string;
    skills: Array<{ id: string; enabled: boolean; instructions: string; config: JsonObject; tools: string[] }>;
    history: SessionMessage[];
    currentRequest?: string;
    dependencyResults: JsonObject;
    runMetadata?: JsonObject;
  };
  effectivePrompt?: { system: string; request: string; combined: string; runId: string; runDir: string };
}
