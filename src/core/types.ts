export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type OutputProtocol = "json" | "claude-json" | "raw";
export type WritePolicy = "none" | "artifacts-only" | "project";

export interface ProviderDefinition {
  adapter: string;
  /** Human-readable runtime model metadata. Invocation remains owned by the adapter definition. */
  model?: string;
  outputProtocol?: OutputProtocol;
  [key: string]: unknown;
}

export interface CommandProviderDefinition extends ProviderDefinition {
  adapter: "command";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  inputTemplate?: string;
  timeoutMs?: number;
}

export interface CodexMcpServerDefinition {
  command: string;
  args?: string[];
  cwd?: string;
  enabledTools?: string[];
  defaultToolsApprovalMode?: "auto" | "prompt" | "writes" | "approve";
}

export interface CodexProviderDefinition extends ProviderDefinition {
  adapter: "codex";
  command?: string;
  sandbox?: "read-only" | "workspace-write";
  filesystemIsolation?: "workspace-read-only";
  workingDirectory?: string;
  approvalPolicy?: "never";
  timeoutMs?: number;
  mcpServers?: Record<string, CodexMcpServerDefinition>;
}

export interface RoleVerdictDefinition {
  path: string;
  pass: JsonPrimitive[];
  block: JsonPrimitive[];
}

export interface RolePermissionDefinition {
  write: WritePolicy;
  tools?: string[];
}

export interface SkillDefinition {
  displayName?: string;
  description: string;
  instructions: string;
  configSchema?: string;
  tools?: string[];
}

export interface RoleSkillBindingDefinition {
  id: string;
  config?: JsonObject;
  /** A disabled binding remains configured and version-pinned, but is not injected at runtime. */
  enabled?: boolean;
}

export type RoleSkillBinding = string | RoleSkillBindingDefinition;

export interface RoleIdentityDefinition {
  displayName: string;
  background: string;
  responsibilities: string[];
  goals?: string[];
  constraints?: string[];
  metadata?: JsonObject;
}

export interface RoleDefinition {
  identity: RoleIdentityDefinition;
  description?: string;
  provider: string;
  instructions?: string;
  skills?: RoleSkillBinding[];
  requestTemplate: string;
  outputSchema: string;
  maxAttempts?: number;
  permissions?: RolePermissionDefinition;
  verdict?: RoleVerdictDefinition;
}

export interface WorkflowNodeDefinition {
  id: string;
  role: string;
  needs?: string[];
  with?: JsonObject;
}

export interface WorkflowDefinition {
  architecture: string;
  description?: string;
  inputSchema?: string;
  config: JsonObject;
}

export interface MultiAgentManifest {
  version: 1;
  name: string;
  artifactRoot?: string;
  providers: Record<string, ProviderDefinition>;
  skills?: Record<string, SkillDefinition>;
  roles: Record<string, RoleDefinition>;
  workflows: Record<string, WorkflowDefinition>;
}

export interface LoadedManifest {
  manifest: MultiAgentManifest;
  manifestPath: string;
  projectRoot: string;
}

export type NodeRunStatus = "pending" | "running" | "passed" | "blocked" | "failed" | "skipped";
export type WorkflowRunStatus = "running" | "passed" | "blocked" | "failed";

export interface NodeRunResult {
  nodeId: string;
  roleId: string;
  metadata?: JsonObject;
  status: NodeRunStatus;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  output?: JsonValue;
  error?: string;
  artifactDir?: string;
}

export interface WorkflowRunRecord {
  id: string;
  workflow: string;
  architecture: string;
  manifestPath: string;
  artifactDir: string;
  status: WorkflowRunStatus;
  createdAt: string;
  completedAt?: string;
  output?: JsonValue;
  error?: string;
  nodes: Record<string, NodeRunResult>;
}

export interface ExecutionPlanNode {
  id: string;
  role: string;
  provider: string;
  needs: string[];
  with: JsonObject;
  metadata?: JsonObject;
}

export interface ExecutionPlan {
  architecture: string;
  workflow: string;
  description?: string;
  nodes: ExecutionPlanNode[];
  data: JsonObject;
}
