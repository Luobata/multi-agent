export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ProviderEntry {
  id: string;
  definition: { adapter: string; model?: string; [key: string]: unknown };
}

export type SkillOwner = "system" | "user";
export type SkillInjection = "none" | "supervisor";

export interface Skill {
  id: string;
  version: number;
  status: "active" | "archived";
  /** System skills are injected by position (e.g. supervisor) and can never be managed by users. */
  owner: SkillOwner;
  /** Where the runtime injects this skill; "supervisor" means it appears only on the supervisor runtime role. */
  injection: SkillInjection;
  displayName: string;
  description: string;
  /** One-line function summary shown to the supervisor when judging who fits a task. */
  summary: string;
  instructions: string;
  tools: string[];
  configSchema?: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export type SkillBinding = string | { id: string; config?: JsonObject; enabled?: boolean };

export type EmployeeScope =
  | { kind: "global" }
  | { kind: "project"; projectId: string; projectVersion: number };

export interface EmployeeTemplateSource {
  id: string;
  version: number;
}

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
  /** Structured capability declarations (e.g. code.frontend, quality.test); never role names. */
  capabilities: string[];
  scope: EmployeeScope;
  /** Pinned template source when this employee was derived from an Employee Template. */
  template?: EmployeeTemplateSource;
  skills: SkillBinding[];
  skillVersions: Record<string, number>;
  knowledgeProfileIds?: string[];
  knowledgeGrants?: KnowledgeProfileGrant[];
  providerId: string;
  outputSchema: JsonObject;
  maxAttempts: number;
  verdict?: { path: string; pass: Array<string | number | boolean | null>; block: Array<string | number | boolean | null> };
  permissions: { write: "none" | "artifacts-only" | "project"; tools?: string[] };
  contextPolicy: { historyLimit: number };
  presentation: { accent?: string; initials?: string; avatarUrl?: string };
  /** First-class system-employee marker; absent means a business employee. */
  systemRole?: "automatic" | "conversational";
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeRecordVersions {
  template: EmployeeTemplate;
  versions: EmployeeTemplate[];
}

/** Static, version-pinned defaults used to derive a complete Employee; templates never execute. */
export interface EmployeeTemplateDefaults {
  identity: {
    background: string;
    responsibilities: string[];
    goals?: string[];
    constraints?: string[];
    metadata?: JsonObject;
  };
  description?: string;
  systemPrompt?: string;
  requestPrompt?: string;
  capabilities?: string[];
  scope?: EmployeeScope;
  skills?: SkillBinding[];
  skillVersions?: Record<string, number>;
  knowledgeProfileIds?: string[];
  providerId?: string;
  outputSchema?: JsonObject;
  maxAttempts?: number;
  permissions?: Employee["permissions"];
  verdict?: Employee["verdict"];
  contextPolicy?: { historyLimit: number };
  presentation?: Employee["presentation"];
}

export interface EmployeeTemplate {
  id: string;
  version: number;
  status: "active" | "archived";
  displayName: string;
  description: string;
  defaults: EmployeeTemplateDefaults;
  createdAt: string;
  updatedAt: string;
}

export type ConversationImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** 发送契约：Base64 图片附件；不接受任意文件或 data URL。 */
export interface ConversationImageAttachmentInput {
  name: string;
  mediaType: ConversationImageMediaType;
  base64: string;
}

/** 会话图片元数据；二进制与磁盘路径永不进入会话 JSON。 */
export interface ConversationImageAttachmentMetadata {
  id: string;
  kind: "image";
  name: string;
  mediaType: ConversationImageMediaType;
  sizeBytes: number;
  sha256: string;
}

/** 冻结的外部文档（飞书 / Lark）解析元数据；正文保存在服务端证据库。 */
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

export interface SessionMessage {
  id: string;
  role: "user" | "employee" | "system";
  content: string;
  at: string;
  attachments?: ConversationImageAttachmentMetadata[];
  documents?: ConversationDocumentEvidenceMetadata[];
  runId?: string;
  runDir?: string;
  output?: JsonValue;
}

export interface Session {
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
  messages: SessionMessage[];
  createdAt: string;
  updatedAt: string;
}

export type InvocationSourceKind = "workbench" | "http" | "mcp" | "a2a";

export interface InvocationSource {
  kind: InvocationSourceKind;
  label?: string;
  project?: string;
  targetProject?: string;
  projectRole?: string;
  projectBindingVersion?: number;
  caller?: string;
  contextId?: string;
  taskId?: string;
  /** Caller-chosen durable key used to make an asynchronous dispatch exactly-once from its perspective. */
  idempotencyKey?: string;
  publicationId?: string;
}

export type InvocationStatus = "queued" | "running" | "awaiting-human-decision" | "completed" | "blocked" | "failed" | "cancelled";
export type WorkInstanceStatus = "queued" | "waiting" | "running" | "completed" | "blocked" | "failed" | "skipped" | "cancelled";

export interface InvocationRecord {
  id: string;
  target: { kind: "employee" | "workflow"; id: string; version: number };
  source: InvocationSource;
  status: InvocationStatus;
  phase: string;
  requestSummary: string;
  requestText?: string;
  taskDescription?: string;
  runId: string;
  sessionId?: string;
  instanceIds: string[];
  executionSnapshot?: {
    workflow: { id: string; version: number; architecture: "graph" | "supervisor" };
    managementPolicy?: { id: string; version: number };
    entrance?: {
      policyId: string;
      policyVersion: number;
      result: EntrancePolicyRouteResult;
      decidedBy: EntrancePolicyDecision["decidedBy"];
      target: EntrancePolicyResolvedTarget;
    };
    employees: Array<{ roleId: string; employeeId: string; employeeVersion: number }>;
  };
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
  nodeIds?: string[];
  roleId?: string;
  kind?: "graph" | "supervisor" | "member" | "gate";
  round?: number;
  parentNodeId?: string;
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
  failure?: {
    category: "provider" | "output-validation" | "preparation" | "interrupted";
    kind?: "aborted" | "budget" | "rate-limit" | "start" | "timeout" | "idle-timeout" | "hard-timeout" | "exit" | "unknown";
    retryable: boolean;
  };
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

/** Client mirror of the server-side aggregated progress shape (src/workbench/invocationProgress.ts). */
export interface InvocationProgress {
  invocationId: string;
  runId: string;
  workflowId: string;
  architecture: string;
  status: InvocationStatus;
  phase: string;
  terminal: boolean;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  round: number;
  tally: Record<WorkInstanceStatus, number>;
  steps: Array<{ nodeId: string; roleId?: string; kind?: string; round?: number; employeeId: string; status: WorkInstanceStatus; phase: string; error?: string; startedAt?: string; completedAt?: string }>;
  leaderReport: {
    available: boolean;
    rounds: number;
    delegations: number;
    entries: Array<{ round: number; action: string; summary?: string; assignments: Array<{ roleId?: string; task?: string; workKind?: string }>; status: WorkInstanceStatus | "pending" }>;
    gates: Array<{ gateId: string; status: string }>;
  };
  outcome?: { status: string; summary?: string; reason?: string };
}

export interface WorkflowNode {
  id: string;
  employeeId: string;
  employeeVersion?: number;
  needs: string[];
  with: JsonObject;
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
  | { mode: "employee"; employeeId: string; employeeVersion: number };

export interface EntrancePolicySignalComparison {
  eq?: JsonValue;
  neq?: JsonValue;
  gte?: number;
  lte?: number;
  in?: JsonValue[];
  exists?: boolean;
}

/** Rule conditions only inspect stable structured metadata; message text is never part of an entrance decision. */
export interface EntrancePolicyRuleCondition {
  tagsAllOf?: string[];
  tagsAnyOf?: string[];
  source?: Partial<InvocationSource>;
  signals?: Record<string, EntrancePolicySignalComparison>;
}

export interface EntrancePolicyRule {
  id: string;
  when: EntrancePolicyRuleCondition;
  result: EntrancePolicyRouteResult;
}

export interface EntrancePolicy {
  id: string;
  version: number;
  status: "active" | "archived";
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

export interface ManagementPolicy {
  id: string;
  version: number;
  status: "active" | "archived";
  displayName: string;
  description: string;
  allowedRoleIds: string[];
  instructions: string;
  limits: {
    maxRounds: number;
    maxDelegations: number;
    maxParallelDelegations: number;
    maxDurationMs?: number;
  };
  failure: { workerFailure: "observe-and-replan" | "fail-fast" };
  completion: { requireDelegation: boolean; requireAllDelegationsSuccessful: boolean };
  execution?: { isolation?: "worktree" | "none" };
  createdAt: string;
  updatedAt: string;
}

interface WorkflowBase {
  id: string;
  version: number;
  status: "active" | "archived";
  description: string;
  inputSchema?: JsonObject;
  presentation?: { positions?: Record<string, { x: number; y: number }> };
  createdAt: string;
  updatedAt: string;
}

export interface GraphWorkflow extends WorkflowBase {
  architecture: "graph";
  patternId?: string;
  nodes: WorkflowNode[];
  maxConcurrency: number;
  failFast: boolean;
}

export type SupervisorWorkKind = "discussion" | "code" | "test" | "audit" | "integration" | "other";

export type SupervisorFlowStage =
  | { id: string; kind: "supervisor"; title: string }
  | { id: string; kind: "delegation-loop"; title: string }
  | { id: string; kind: "gate"; title: string; gateId: string }
  | { id: string; kind: "delivery"; title: string };

export type SupervisorGateMode = "after-each-delegation" | "before-completion";
export type SupervisorGateFallback = "supervisor" | "block";

export interface SupervisorGate {
  id: string;
  requiredCapability: string;
  mode: SupervisorGateMode;
  required: boolean;
  instructions: string;
  fallback: SupervisorGateFallback;
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

export interface SupervisorDagNode {
  /** Stable logical identity used by supervisor delegate decisions and Run evidence. */
  nodeId: string;
  /** Workflow-local member slot. Multiple nodes may intentionally reference the same role. */
  roleId: string;
  needs: string[];
  kind: SupervisorDagNodeKind;
  task: string;
  requiredCapabilities: string[];
  workKind: SupervisorWorkKind;
  changeSet?: string;
  required: boolean;
}

export interface SupervisorDagDefinition {
  nodes: SupervisorDagNode[];
}

export interface SupervisorFlowDefinition {
  version: number;
  stages: SupervisorFlowStage[];
  gates: SupervisorGate[];
  dag?: SupervisorDagDefinition;
}

export interface SupervisorWorkflow extends WorkflowBase {
  architecture: "supervisor";
  /** "latest" re-resolves pinned versions to newest on every run; "locked" holds until synced. */
  updatePolicy: SupervisorWorkflowUpdatePolicy;
  supervisor: { employeeId: string; employeeVersion: number };
  /** System skill pinned onto the supervisor position at materialization; members never receive it. */
  orchestrationSkill: { id: string; version: number };
  managementPolicy: { id: string; version: number };
  members: Array<{
    roleId: string;
    description: string;
    employeeId: string;
    employeeVersion: number;
  }>;
  flow: SupervisorFlowDefinition;
}

export type Workflow = GraphWorkflow | SupervisorWorkflow;

export type SupervisorWorkflowUpdatePolicy = "latest" | "locked";

export interface WorkflowEntrancePolicyRefreshResult {
  workflowId: string;
  workflowVersion: number;
  changed: boolean;
  changes: Array<{
    policyId: string;
    fromPolicyVersion: number;
    toPolicyVersion: number;
    fromWorkflowVersion: number;
    toWorkflowVersion: number;
  }>;
}

/** A single supervisor-workflow gate mutation. Client mirror of src/workbench/types.ts. */
export type WorkflowChangeOperation =
  | { kind: "add-gate"; gate: SupervisorGate; rationale: string; risk: string }
  | { kind: "update-gate"; gateId: string; patch: Partial<Omit<SupervisorGate, "id">>; rationale: string; risk: string }
  | { kind: "remove-gate"; gateId: string; rationale: string; risk: string };

export type WorkflowChangeStatus = "awaiting-approval" | "applied" | "rejected";

export interface WorkflowChangeReview {
  actor: string;
  comment?: string;
  at: string;
}

/** A human-approved proposal to change a supervisor workflow's gates. Client mirror of the server record. */
export interface WorkflowChangeRequest {
  id: string;
  workflowId: string;
  /** Frozen at proposal time: the workflow version the operations were authored against. */
  workflowVersion: number;
  status: WorkflowChangeStatus;
  title: string;
  reason: string;
  requestedBy: string;
  operations: WorkflowChangeOperation[];
  review?: WorkflowChangeReview;
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
  metadata?: JsonObject;
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
  output?: JsonValue;
  error?: string;
  /** Present on listRuns summaries (not on getRun detail): coarse run classification. */
  category?: "single" | "graph" | "supervisor";
  /** Present on listRuns summaries when the correlated invocation carried a project. */
  project?: string;
  /** Present on listRuns summaries: the trigger source of the correlated invocation. */
  trigger?: "workbench" | "http" | "mcp" | "a2a";
  /** Present on listRuns summaries when the correlated invocation carried a requirement task id. */
  taskId?: string;
  invocation?: {
    id: string;
    requestSummary: string;
    requestText?: string;
    taskDescription?: string;
  };
  nodes: Record<string, RunNode>;
  /** Present when the run recorded worktree-isolation evidence (WI-T1/T3). */
  isolation?: { mode: "worktree" | "none"; worktreePath?: string; baseCommit?: string; fallbackReason?: string };
  effectiveProfiles?: Record<string, EffectiveExecutionProfile>;
}

export interface RunEvidenceAsset {
  id: string;
  kind: "screenshot" | "recording";
  name: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  url: string;
}

export interface RunGateEvidence {
  gateId: string;
  required: boolean;
  status: string;
  reason?: string;
  /** Server-side capability class, e.g. quality.test / quality.audit. */
  requiredCapability?: string;
  mode?: string;
}

export interface RunDeliveryRecord {
  runId: string;
  status: "awaiting-acceptance" | "queued-for-merge" | "retesting" | "merging" | "returned-to-acceptance" | "conflict" | "merged" | "kept" | "discarded";
  updatedAt: string;
  baseCommit?: string;
  sourceBranch?: string;
  sourceCommit?: string;
  targetBranch?: string;
  targetCommitBeforeMerge?: string;
  queuedTargetCommit?: string;
  mergeCommit?: string;
  message?: string;
  conflictResolution?: {
    status: "resolving" | "retesting" | "leader-review" | "passed" | "failed";
    targetCommit: string;
    updatedAt: string;
    conflictMessage?: string;
    leaderPlanRunId?: string;
    executionRoleId?: string;
    resolutionRunId?: string;
    testRunId?: string;
    leaderReviewRunId?: string;
    message?: string;
  };
  mergeValidation?: {
    required: boolean;
    status: "not-required" | "running" | "passed" | "failed";
    runId?: string;
    targetCommit?: string;
    message?: string;
    updatedAt: string;
  };
  evidenceRerun?: {
    status: "queued" | "running" | "passed" | "failed";
    actor: string;
    requestedAt: string;
    updatedAt: string;
    runId?: string;
    message?: string;
    mediaCount?: number;
  };
  humanDecision?: {
    action: "keep" | "discard" | "merge";
    actor: string;
    at: string;
    note?: string;
  };
}

export type HumanDecisionRiskCategory =
  | "dependency-install"
  | "data-migration"
  | "scope-expansion"
  | "irreversible-other";

export type HumanDecisionRequestStatus = "pending" | "approved" | "rejected" | "voided";

/** Durable high-risk human-decision request pinned to one Invocation/Run (control-plane record). */
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

export interface RunMergePreview {
  runId: string;
  status: "not-ready" | "awaiting-acceptance" | "queued-for-merge" | "retesting" | "merging" | "returned-to-acceptance" | "conflict" | "merged" | "kept" | "discarded";
  eligible: boolean;
  reasons: string[];
  worktreePath?: string;
  repositoryRoot?: string;
  sourceBranch?: string;
  sourceCommit?: string;
  targetBranch?: string;
  targetClean: boolean;
  changes: {
    files: Array<{ status: string; path: string }>;
    fileCount: number;
    summary: string;
    unifiedDiff: {
      text: string;
      truncated: boolean;
      maxBytes: number;
    };
  };
  /** 只读检查命令；服务端保证不含写操作。 */
  safeGitCommands: string[];
  evidence: {
    assets: RunEvidenceAsset[];
    structuredE2eCount: number;
    acceptedVerdict: boolean;
    gates: RunGateEvidence[];
  };
  confirmationToken: string;
  discardConfirmationToken: string;
  delivery?: RunDeliveryRecord;
}

export interface RunMergeResult {
  status: "merged" | "conflict";
  delivery: RunDeliveryRecord;
}

export interface RunMergeQueueResult {
  status: "queued-for-merge";
  delivery: RunDeliveryRecord;
}

export interface RunDeliveryActionResult {
  status: "kept" | "discarded";
  delivery: RunDeliveryRecord;
}

export interface RunWorktreeOpenResult {
  runId: string;
  worktreePath: string;
  repositoryRoot: string;
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

export type ProjectBindingUpdatePolicy = "locked" | "compatible" | "latest";

export interface ProjectRoleContract {
  id: string;
  displayName: string;
  description: string;
  requiredSkills: string[];
  optionalSkills: string[];
  requiredProviderProfiles?: string[];
  knowledgeProfileIds?: string[];
  instructions: string;
  outputSchema?: JsonObject;
  permissions?: Employee["permissions"];
}

export interface Project {
  id: string;
  version: number;
  status: "active" | "archived";
  name: string;
  description: string;
  scope: "repository" | "workspace";
  rootPath: string;
  descriptorPath: string;
  connector: { kind: string; config: JsonObject };
  roles: ProjectRoleContract[];
  createdAt: string;
  updatedAt: string;
}

export interface PassiveProjectAccess {
  id: string;
  rootPath?: string;
  projectKeys: string[];
  displayName: string;
  transport: "mcp";
  requestCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  linkedProjectId?: string;
}

export interface ProjectRoleBinding {
  roleId: string;
  employeeId: string;
  employeeVersion: number;
  skills: SkillBinding[];
  skillVersions: Record<string, number>;
  knowledgeProfileIds?: string[];
  knowledgeGrants?: KnowledgeProfileGrant[];
  updatePolicy: ProjectBindingUpdatePolicy;
}

export interface ProjectBinding {
  projectId: string;
  projectVersion: number;
  version: number;
  roles: ProjectRoleBinding[];
  createdAt: string;
  updatedAt: string;
}

export type KnowledgeClassification = "internal" | "confidential" | "restricted";
export type KnowledgeAuthority = "canonical" | "reference" | "experimental";
export type KnowledgeActivation = "core" | "conditional" | "on-demand";
export type KnowledgeReferenceType = "related" | "supports" | "contradicts" | "depends-on" | "supersedes";
export type KnowledgeGrantSource = "explicit" | "legacy";

export interface KnowledgeCollection {
  id: string;
  displayName: string;
  description: string;
  authority: KnowledgeAuthority;
  tags: string[];
}

export interface KnowledgeSource {
  id: string;
  kind: "file" | "directory";
  location: string;
  collectionId: string;
  includeExtensions?: string[];
}

export interface KnowledgeBase {
  id: string;
  version: number;
  status: "active" | "archived";
  displayName: string;
  description: string;
  domain: string;
  product?: string;
  projectId?: string;
  classification: KnowledgeClassification;
  collections: KnowledgeCollection[];
  sources: KnowledgeSource[];
  latestRevision?: number;
  publishedRevision?: number;
  syncStatus: "idle" | "syncing" | "failed";
  qualityStatus: "healthy" | "degraded" | "stale";
  lastSyncedAt?: string;
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocumentReference {
  type: KnowledgeReferenceType;
  targetDocumentId: string;
  note?: string;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  collectionId: string;
  sourceId?: string;
  sourceRef?: string;
  order?: number;
  parentId?: string;
  references?: KnowledgeDocumentReference[];
  metadata?: JsonObject;
  updatedAt: string;
}

export type KnowledgeDocumentInput = Omit<KnowledgeDocument, "updatedAt">;

export interface KnowledgeRelationCandidate {
  id: string;
  sourceDocumentId: string;
  targetDocumentId: string;
  suggestedType: "related";
  strength: "candidate";
  persisted: false;
  score: number;
  signals: string[];
}

export interface KnowledgeWikiReference {
  sourceDocumentId: string;
  targetDocumentId: string;
  type: KnowledgeReferenceType;
  strength: "explicit";
  note?: string;
}

export interface KnowledgeWikiDocument {
  document: KnowledgeDocument;
  outgoingReferences: KnowledgeWikiReference[];
  backlinks: KnowledgeWikiReference[];
  candidateRelations: KnowledgeRelationCandidate[];
}

export interface KnowledgeWikiView {
  knowledgeBaseId: string;
  revision: number;
  visibility: "published" | "draft";
  documents: KnowledgeWikiDocument[];
  references: KnowledgeWikiReference[];
  candidateRelations: KnowledgeRelationCandidate[];
  generatedAt: string;
}

export interface KnowledgeUrlPreview {
  version: "knowledge-url-preview-v1";
  knowledgeBaseId: string;
  knowledgeBaseVersion: number;
  baseRevision?: number;
  collectionId: string;
  requestedUrl: string;
  finalUrl: string;
  redirects: string[];
  contentType: string;
  byteLength: number;
  contentSha256: string;
  previewHash: string;
  documents: KnowledgeDocumentInput[];
  relationCandidates: KnowledgeRelationCandidate[];
  fetchedAt: string;
}

export interface KnowledgeProfileGrant {
  profileId: string;
  reason: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
  reviewCycleDays?: number;
  lastReviewedAt?: string;
  source: KnowledgeGrantSource;
}

export interface KnowledgeGrantReviewItem {
  id: string;
  subject: {
    kind: "employee" | "project-role";
    employeeId: string;
    projectId?: string;
    roleId?: string;
  };
  grant: KnowledgeProfileGrant;
  status: "overdue" | "due-soon" | "current" | "unscheduled";
  dueAt?: string;
  reasons: string[];
  reminderOnly: true;
}

export interface KnowledgeGrantReviewLedger {
  asOf: string;
  dueSoonDays: number;
  policy: "reminder-only-v1";
  counts: Record<KnowledgeGrantReviewItem["status"], number>;
  items: KnowledgeGrantReviewItem[];
}

export interface KnowledgeCandidateMatch {
  profileId: string;
  profileVersion: number;
  ruleId: string;
  activation: KnowledgeActivation;
  priority: number;
  required: boolean;
  budget: { maxCollections: number; maxChunks: number; maxTokens: number };
  reason: string;
}

export interface KnowledgeCandidateCollection {
  knowledgeBaseId: string;
  knowledgeBaseVersion: number;
  revision: number;
  knowledgeBaseName: string;
  domain: string;
  product?: string;
  projectId?: string;
  classification: KnowledgeClassification;
  collection: KnowledgeCollection;
  matches: KnowledgeCandidateMatch[];
}

export interface KnowledgeSelectedCollection {
  knowledgeBaseId: string;
  knowledgeBaseVersion: number;
  revision: number;
  collectionId: string;
  collectionName: string;
  profileId: string;
  ruleId: string;
  activation: KnowledgeActivation;
  priority: number;
  reason: string;
  query: string;
  budget: { maxCollections: number; maxChunks: number; maxTokens: number };
}

export interface KnowledgeEvidenceUsage {
  runId: string;
  workInstanceId: string;
  nodeId: string;
  status: string;
  at: string;
  context: { request: string; projectId?: string; projectRoleId?: string; taskTags: string[] };
  evidence: KnowledgeEvidence[];
}

export interface KnowledgePerspective {
  employee: {
    id: string;
    version: number;
    knowledgeProfileIds: string[];
    grants: KnowledgeProfileGrant[];
  };
  context: { request: string; projectId?: string; projectRoleId?: string; taskTags: string[] };
  eligible: KnowledgeCandidateCollection[];
  activated: KnowledgeCandidateCollection[];
  selected: KnowledgeSelectedCollection[];
  exclusions: Array<{ knowledgeBaseId?: string; collectionId?: string; profileId?: string; reason: string }>;
  recentEvidence: KnowledgeEvidenceUsage[];
  evidenceWindow: {
    policy: "recent-work-instances-v1";
    limit: number;
    scannedInstances: number;
    matchedRuns: number;
    oldestScannedAt?: string;
    newestScannedAt?: string;
  };
}

export interface KnowledgeRevision {
  knowledgeBaseId: string;
  revision: number;
  documents: KnowledgeDocument[];
  sourceSummary?: { sourceCount: number; documentCount: number };
  createdAt: string;
}

export interface KnowledgeProfileRule {
  id: string;
  selector: {
    knowledgeBaseIds?: string[];
    domains?: string[];
    products?: string[];
    projectIds?: string[];
    collectionIds?: string[];
    authorities?: KnowledgeAuthority[];
    maxClassification?: KnowledgeClassification;
  };
  activation: KnowledgeActivation;
  conditions?: {
    projectIds?: string[];
    projectRoleIds?: string[];
    taskTags?: string[];
    requestTerms?: string[];
  };
  priority: number;
  required: boolean;
  budget: { maxCollections: number; maxChunks: number; maxTokens: number };
}

export interface KnowledgeProfile {
  id: string;
  version: number;
  status: "active" | "archived";
  displayName: string;
  description: string;
  rules: KnowledgeProfileRule[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgePlan {
  employeeId: string;
  employeeVersion: number;
  context: { request: string; projectId?: string; projectRoleId?: string; taskTags: string[] };
  profileVersions: Record<string, number>;
  eligibleCollections: Array<{ knowledgeBaseId: string; collectionId: string; revision: number; activations: KnowledgeActivation[] }>;
  selectedCollections: Array<{
    knowledgeBaseId: string;
    revision: number;
    collectionId: string;
    collectionName: string;
    profileId: string;
    ruleId: string;
    activation: KnowledgeActivation;
    reason: string;
  }>;
  exclusions: Array<{ knowledgeBaseId?: string; collectionId?: string; profileId?: string; reason: string }>;
  strategy: string;
  createdAt: string;
}

export interface KnowledgeEvidence {
  citationId: string;
  knowledgeBaseId: string;
  revision: number;
  collectionId: string;
  documentId: string;
  title: string;
  content: string;
  sourceRef?: string;
  score: number;
}

export interface KnowledgeRuntimeResult {
  plan: KnowledgePlan;
  evidence: KnowledgeEvidence[];
  promptSection: string;
}

export interface KnowledgeRevisionAssessment {
  knowledgeBaseId: string;
  revision: number;
  status: "ready" | "attention" | "blocked";
  documentCount: number;
  sourceDocumentCount: number;
  manualDocumentCount: number;
  collections: Array<{
    collectionId: string;
    collectionName: string;
    documentCount: number;
    sourceDocumentCount: number;
    manualDocumentCount: number;
  }>;
  warnings: Array<{
    code: "empty-revision" | "empty-collection" | "source-coverage-missing";
    severity: "warning" | "blocker";
    message: string;
    collectionId?: string;
  }>;
  assessedAt: string;
}

export interface KnowledgeRevisionSummary {
  revision: number;
  createdAt: string;
  documentCount: number;
  sourceDocumentCount: number;
  manualDocumentCount: number;
  assessmentStatus: KnowledgeRevisionAssessment["status"];
  warningCount: number;
  isLatest: boolean;
  isPublished: boolean;
}

export interface KnowledgeRevisionPreview {
  knowledgeBaseId: string;
  revision: number;
  query: string;
  collectionIds: string[];
  evidence: KnowledgeEvidence[];
  createdAt: string;
}

export interface KnowledgeProfileRuleImpact {
  ruleId: string;
  activation: KnowledgeActivation;
  matchMode: "explicit" | "metadata";
  collectionIds: string[];
}

export interface KnowledgeEmployeeImpact {
  employeeId: string;
  employeeName: string;
  employeeStatus: "active" | "archived";
  viaProfileIds: string[];
}

export interface KnowledgeProjectRoleImpact {
  projectId: string;
  projectName: string;
  roleId: string;
  roleName: string;
  employeeId: string;
  viaProfileIds: string[];
}

export interface KnowledgeImpactSnapshot {
  knowledgeBases: Array<{
    knowledgeBaseId: string;
    profileMatches: Array<{
      profileId: string;
      profileName: string;
      profileVersion: number;
      profileStatus: "active" | "archived";
      rules: KnowledgeProfileRuleImpact[];
    }>;
    employees: KnowledgeEmployeeImpact[];
    projectRoles: KnowledgeProjectRoleImpact[];
  }>;
  profiles: Array<{
    profileId: string;
    knowledgeBases: Array<{
      knowledgeBaseId: string;
      knowledgeBaseName: string;
      knowledgeBaseStatus: "active" | "archived";
      publishedRevision?: number;
      rules: KnowledgeProfileRuleImpact[];
    }>;
    employees: KnowledgeEmployeeImpact[];
    projectRoles: KnowledgeProjectRoleImpact[];
  }>;
  danglingAssignments: Array<{
    profileId: string;
    source: "employee" | "project-role";
    employeeId: string;
    projectId?: string;
    roleId?: string;
  }>;
  generatedAt: string;
}

export type KnowledgeChangeOperationType =
  | "knowledge-base.create"
  | "knowledge-base.update"
  | "knowledge-base.sync"
  | "knowledge-base.archive"
  | "knowledge-base.restore"
  | "knowledge-revision.create"
  | "knowledge-revision.publish"
  | "knowledge-profile.create"
  | "knowledge-profile.update"
  | "knowledge-profile.archive"
  | "knowledge-profile.restore"
  | "employee-profiles.set"
  | "project-role-profiles.set";

export interface KnowledgeChangeOperation {
  type: KnowledgeChangeOperationType;
  targetId?: string;
  projectId?: string;
  roleId?: string;
  expectedVersion?: number;
  payload?: JsonObject;
}

export type KnowledgeChangeStatus =
  | "awaiting-approval"
  | "applying"
  | "applied"
  | "rejected"
  | "cancelled"
  | "failed"
  | "needs-reapproval";

export type KnowledgeChangeRisk = "medium" | "high" | "critical";

export interface KnowledgeChangeImpactSummary {
  knowledgeBaseIds: string[];
  profileIds: string[];
  employeeIds: string[];
  projectRoles: string[];
}

export interface KnowledgeChangePreview {
  summary: string;
  beforeVersion?: number;
  expectedVersion?: number;
  warnings: string[];
  impact: KnowledgeChangeImpactSummary;
  before?: JsonValue;
  proposed?: JsonValue;
}

export interface KnowledgeChangeApproval {
  decision: "approved" | "rejected";
  actor: string;
  at: string;
  comment?: string;
  planHash: string;
}

export interface KnowledgeChangeRequest {
  id: string;
  status: KnowledgeChangeStatus;
  title: string;
  reason: string;
  requestedBy: string;
  operation: KnowledgeChangeOperation;
  risk: KnowledgeChangeRisk;
  preview: KnowledgeChangePreview;
  planHash: string;
  approval?: KnowledgeChangeApproval;
  result?: JsonValue;
  error?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

export type ConfigurationOperationRisk = "low" | "medium" | "high";
export type ConfigurationOperation =
  | { type: "identity-profile.set"; rationale: string; risk: ConfigurationOperationRisk; payload: { identity: Employee["identity"]; description: string } }
  | { type: "prompts.set"; rationale: string; risk: ConfigurationOperationRisk; payload: { systemPrompt: string; requestPrompt: string } }
  | { type: "capabilities.set"; rationale: string; risk: ConfigurationOperationRisk; payload: { capabilities: string[] } }
  | { type: "skills.set"; rationale: string; risk: ConfigurationOperationRisk; payload: { skills: SkillBinding[]; skillVersions?: Record<string, number> } }
  | { type: "runtime.set"; rationale: string; risk: ConfigurationOperationRisk; payload: { providerId: string; maxAttempts: number } }
  | { type: "permissions.set"; rationale: string; risk: ConfigurationOperationRisk; payload: { permissions: Employee["permissions"] } }
  | { type: "output-contract.set"; rationale: string; risk: ConfigurationOperationRisk; payload: { outputSchema: JsonObject; verdict?: Employee["verdict"] | null } }
  | { type: "context-policy.set"; rationale: string; risk: ConfigurationOperationRisk; payload: { historyLimit: number } }
  | { type: "presentation.set"; rationale: string; risk: ConfigurationOperationRisk; payload: Employee["presentation"] };

export type ConfigurationProposalStatus =
  | "awaiting-review"
  | "ready-to-apply"
  | "applying"
  | "applied"
  | "needs-reapproval"
  | "cancelled"
  | "failed";

export interface ConfigurationReviewItem {
  id: string;
  operationIndex: number;
  operationType: ConfigurationOperation["type"];
  label: string;
  rationale: string;
  risk: ConfigurationOperationRisk;
  before: JsonValue;
  after: JsonValue;
}

export interface ConfigurationReviewDecision {
  id: string;
  reviewItemId: string;
  decision: "accepted" | "rejected";
  actor: string;
  at: string;
  comment?: string;
  planHash: string;
}

export interface ConfigurationProposal {
  id: string;
  status: ConfigurationProposalStatus;
  title: string;
  reason: string;
  employeeId: string;
  expectedEmployeeVersion: number;
  operations: ConfigurationOperation[];
  reviewItems: ConfigurationReviewItem[];
  decisions: ConfigurationReviewDecision[];
  progress: { total: number; reviewed: number; accepted: number; rejected: number; pending: number };
  reviewRevision: number;
  reviewHash: string;
  source: {
    kind: "ai-generated";
    invocationId: string;
    projectId: string;
    projectVersion: number;
    projectRoleId: string;
    projectBindingVersion: number;
    employeeId: string;
    employeeVersion: number;
    requestedBy: string;
    sessionId: string;
    runId: string;
  };
  planHash: string;
  validation: { valid: boolean; errors: string[] };
  result?: { employeeId: string; employeeVersion: number };
  application?: {
    actor: string;
    at: string;
    reviewRevision: number;
    reviewHash: string;
    acceptedReviewItemIds: string[];
    fromEmployeeVersion: number;
    toEmployeeVersion: number;
  };
  cancellation?: { actor: string; at: string; comment?: string };
  error?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

export interface KnowledgeBaseDetail {
  knowledgeBase: KnowledgeBase;
  versions: KnowledgeBase[];
  latestRevision?: KnowledgeRevision;
  publishedRevision?: KnowledgeRevision;
  latestAssessment?: KnowledgeRevisionAssessment;
  publishedAssessment?: KnowledgeRevisionAssessment;
  revisionHistory: KnowledgeRevisionSummary[];
}

export interface Bootstrap {
  providers: ProviderEntry[];
  skills: Skill[];
  knowledgeBases?: KnowledgeBase[];
  knowledgeProfiles?: KnowledgeProfile[];
  knowledgeChanges?: KnowledgeChangeRequest[];
  workflowChanges?: WorkflowChangeRequest[];
  configurationProposals?: ConfigurationProposal[];
  architectureTemplates: ArchitectureTemplate[];
  gateValidators?: Array<{ id: string; description: string }>;
  employees: Employee[];
  employeeTemplates?: EmployeeTemplate[];
  managementPolicies?: ManagementPolicy[];
  entrancePolicies?: EntrancePolicy[];
  workflows: Workflow[];
  sessions: Session[];
  publications: Publication[];
  projects: Project[];
  projectBindings: ProjectBinding[];
  passiveProjectAccesses?: PassiveProjectAccess[];
  humanDecisionRequests?: HumanDecisionRequest[];
  activity: ActivitySnapshot;
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

export interface EffectiveConfigurationReference {
  refId: string;
  kind: EffectiveConfigurationSourceKind;
  id: string;
  version?: number;
  revision?: number;
  label: string;
  route?: {
    page: "employees" | "projects" | "skills" | "knowledge" | "workflows" | "runs";
    entityId: string;
  };
  snapshot: JsonValue;
}

export interface EffectiveConfigurationContribution {
  referenceId: string;
  scope: "employee" | "project" | "run";
  action: "base" | "append" | "select" | "override" | "narrow" | "resolve";
  path?: string;
}

export interface EffectiveConfigurationField {
  key: string;
  label: string;
  mergeRule: string;
  value: JsonValue;
  contributions: EffectiveConfigurationContribution[];
}

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

export interface ContextView {
  employee: Employee;
  skills: Skill[];
  session?: Session;
  layers: {
    identity: Employee["identity"];
    systemPrompt: string;
    skills: Array<{ id: string; enabled: boolean; instructions: string; config: JsonObject; tools: string[] }>;
    knowledge?: { plan: KnowledgePlan; evidence: KnowledgeEvidence[] };
    history: SessionMessage[];
    currentRequest?: string;
    dependencyResults: JsonObject;
    runMetadata?: JsonObject;
  };
  effectivePrompt?: { system: string; request: string; combined: string; runId: string; runDir: string };
  effectiveProfile?: EffectiveExecutionProfile;
}

export type MemoryKind = "run-summary" | "node-detail" | "preference";

export interface MemoryScopeSummary {
  scopeKey: string;
  count: number;
}

export interface MemoryRecord {
  id: string;
  scope: { employeeId: string; employeeVersion: number; projectId?: string };
  kind: MemoryKind;
  title: string;
  content: string;
  provenance: { runId: string; traceId: string; invocationId?: string; nodeId?: string; source?: { caller?: string; contextId?: string } };
  status: "active" | "archived";
  tokens: number;
  createdAt: string;
  supersedesId: string | null;
}

export interface MemoryEvidence {
  citationId: string;
  memoryId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  traceId: string;
  score: number;
  createdAt: string;
}
