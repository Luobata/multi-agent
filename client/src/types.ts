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
  knowledgeProfileIds?: string[];
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
  assignment?: {
    projectId: string;
    projectVersion: number;
    projectBindingVersion: number;
    roleId: string;
  };
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
  projectRole?: string;
  projectBindingVersion?: number;
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

export type ProjectBindingUpdatePolicy = "locked" | "compatible" | "latest";

export interface ProjectRoleContract {
  id: string;
  displayName: string;
  description: string;
  requiredSkills: string[];
  optionalSkills: string[];
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

export interface ProjectRoleBinding {
  roleId: string;
  employeeId: string;
  employeeVersion: number;
  skills: SkillBinding[];
  skillVersions: Record<string, number>;
  knowledgeProfileIds?: string[];
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

export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  collectionId: string;
  sourceId?: string;
  sourceRef?: string;
  metadata?: JsonObject;
  updatedAt: string;
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
  architectureTemplates: ArchitectureTemplate[];
  employees: Employee[];
  workflows: Workflow[];
  sessions: Session[];
  publications: Publication[];
  projects: Project[];
  projectBindings: ProjectBinding[];
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
    knowledge?: { plan: KnowledgePlan; evidence: KnowledgeEvidence[] };
    history: SessionMessage[];
    currentRequest?: string;
    dependencyResults: JsonObject;
    runMetadata?: JsonObject;
  };
  effectivePrompt?: { system: string; request: string; combined: string; runId: string; runDir: string };
}
