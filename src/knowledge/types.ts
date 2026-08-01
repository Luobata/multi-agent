import type { JsonObject, JsonValue } from "../core/types.js";

export type KnowledgeRecordStatus = "active" | "archived";
export type KnowledgeClassification = "internal" | "confidential" | "restricted";
export type KnowledgeAuthority = "canonical" | "reference" | "experimental";
export type KnowledgeSyncStatus = "idle" | "syncing" | "failed";
export type KnowledgeQualityStatus = "healthy" | "degraded" | "stale";
export type KnowledgeActivation = "core" | "conditional" | "on-demand";

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
  assessment?: KnowledgeRevisionAssessment;
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

export interface KnowledgeChangeCancellation {
  actor: string;
  at: string;
  comment?: string;
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
  cancellation?: KnowledgeChangeCancellation;
  result?: JsonValue;
  error?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

export interface KnowledgeChangeCreateInput {
  title: string;
  reason: string;
  requestedBy?: string;
  operation: KnowledgeChangeOperation;
}

export interface KnowledgeCollectionDefinition {
  id: string;
  displayName: string;
  description: string;
  authority: KnowledgeAuthority;
  tags: string[];
}

export interface KnowledgeSourceDefinition {
  id: string;
  kind: "file" | "directory";
  location: string;
  collectionId: string;
  includeExtensions?: string[];
}

export interface KnowledgeBaseDefinition {
  id: string;
  version: number;
  status: KnowledgeRecordStatus;
  displayName: string;
  description: string;
  domain: string;
  product?: string;
  projectId?: string;
  classification: KnowledgeClassification;
  collections: KnowledgeCollectionDefinition[];
  sources: KnowledgeSourceDefinition[];
  latestRevision?: number;
  publishedRevision?: number;
  syncStatus: KnowledgeSyncStatus;
  qualityStatus: KnowledgeQualityStatus;
  lastSyncedAt?: string;
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseRecord {
  current: KnowledgeBaseDefinition;
  versions: KnowledgeBaseDefinition[];
}

export interface KnowledgeDocumentInput {
  id: string;
  title: string;
  content: string;
  collectionId: string;
  sourceId?: string;
  sourceRef?: string;
  metadata?: JsonObject;
}

export interface KnowledgeDocumentDefinition extends KnowledgeDocumentInput {
  updatedAt: string;
}

export interface KnowledgeRevision {
  knowledgeBaseId: string;
  revision: number;
  documents: KnowledgeDocumentDefinition[];
  sourceSummary?: {
    sourceCount: number;
    documentCount: number;
  };
  createdAt: string;
}

export interface KnowledgeIndexChunk {
  id: string;
  documentId: string;
  collectionId: string;
  title: string;
  content: string;
  sourceRef?: string;
  metadata?: JsonObject;
  tokens: string[];
}

export interface KnowledgeIndex {
  knowledgeBaseId: string;
  revision: number;
  chunks: KnowledgeIndexChunk[];
  createdAt: string;
}

export interface KnowledgeBaseCreateInput {
  id: string;
  displayName?: string;
  description: string;
  domain: string;
  product?: string;
  projectId?: string;
  classification?: KnowledgeClassification;
  collections: KnowledgeCollectionDefinition[];
  sources?: KnowledgeSourceDefinition[];
  documents?: KnowledgeDocumentInput[];
  publish?: boolean;
}

export type KnowledgeBaseUpdateInput = Partial<Omit<KnowledgeBaseCreateInput, "id" | "documents" | "publish">>;

export interface KnowledgeRevisionCreateInput {
  documents: KnowledgeDocumentInput[];
}

export interface KnowledgeProfileSelector {
  knowledgeBaseIds?: string[];
  domains?: string[];
  products?: string[];
  projectIds?: string[];
  collectionIds?: string[];
  authorities?: KnowledgeAuthority[];
  maxClassification?: KnowledgeClassification;
}

export interface KnowledgeProfileConditions {
  projectIds?: string[];
  projectRoleIds?: string[];
  taskTags?: string[];
  requestTerms?: string[];
}

export interface KnowledgeBudget {
  maxCollections: number;
  maxChunks: number;
  maxTokens: number;
}

export interface KnowledgeProfileRule {
  id: string;
  selector: KnowledgeProfileSelector;
  activation: KnowledgeActivation;
  conditions?: KnowledgeProfileConditions;
  priority: number;
  required: boolean;
  budget: KnowledgeBudget;
}

export interface KnowledgeProfileDefinition {
  id: string;
  version: number;
  status: KnowledgeRecordStatus;
  displayName: string;
  description: string;
  rules: KnowledgeProfileRule[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeProfileRecord {
  current: KnowledgeProfileDefinition;
  versions: KnowledgeProfileDefinition[];
}

export interface KnowledgeProfileCreateInput {
  id: string;
  displayName?: string;
  description: string;
  rules: KnowledgeProfileRule[];
}

export type KnowledgeProfileUpdateInput = Partial<Omit<KnowledgeProfileCreateInput, "id">>;

export interface KnowledgeResolutionContext {
  request: string;
  projectId?: string;
  projectRoleId?: string;
  taskTags: string[];
}

export interface KnowledgeCandidateMatch {
  profileId: string;
  profileVersion: number;
  ruleId: string;
  activation: KnowledgeActivation;
  priority: number;
  required: boolean;
  budget: KnowledgeBudget;
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
  collection: KnowledgeCollectionDefinition;
  matches: KnowledgeCandidateMatch[];
}

export interface KnowledgeExclusion {
  knowledgeBaseId?: string;
  collectionId?: string;
  profileId?: string;
  reason: string;
}

export interface KnowledgeScope {
  employeeId: string;
  employeeVersion: number;
  context: KnowledgeResolutionContext;
  profileVersions: Record<string, number>;
  eligibleCollections: KnowledgeCandidateCollection[];
  exclusions: KnowledgeExclusion[];
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
  budget: KnowledgeBudget;
}

export interface KnowledgePlan {
  employeeId: string;
  employeeVersion: number;
  context: KnowledgeResolutionContext;
  profileVersions: Record<string, number>;
  eligibleCollections: Array<{
    knowledgeBaseId: string;
    collectionId: string;
    revision: number;
    activations: KnowledgeActivation[];
  }>;
  selectedCollections: KnowledgeSelectedCollection[];
  exclusions: KnowledgeExclusion[];
  strategy: "deterministic-metadata-v1";
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

export interface KnowledgeRevisionWarning {
  code: "empty-revision" | "empty-collection" | "source-coverage-missing";
  severity: "warning" | "blocker";
  message: string;
  collectionId?: string;
}

export interface KnowledgeCollectionAssessment {
  collectionId: string;
  collectionName: string;
  documentCount: number;
  sourceDocumentCount: number;
  manualDocumentCount: number;
}

export interface KnowledgeRevisionAssessment {
  knowledgeBaseId: string;
  revision: number;
  status: "ready" | "attention" | "blocked";
  documentCount: number;
  sourceDocumentCount: number;
  manualDocumentCount: number;
  collections: KnowledgeCollectionAssessment[];
  warnings: KnowledgeRevisionWarning[];
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

export interface KnowledgeRevisionPreviewInput {
  message: string;
  revision?: number;
  collectionIds?: string[];
  maxChunks?: number;
  maxTokens?: number;
}

export interface KnowledgeProfileRuleImpact {
  ruleId: string;
  activation: KnowledgeActivation;
  matchMode: "explicit" | "metadata";
  collectionIds: string[];
}

export interface KnowledgeProfileImpactMatch {
  profileId: string;
  profileName: string;
  profileVersion: number;
  profileStatus: KnowledgeRecordStatus;
  rules: KnowledgeProfileRuleImpact[];
}

export interface KnowledgeBaseImpactMatch {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  knowledgeBaseStatus: KnowledgeRecordStatus;
  publishedRevision?: number;
  rules: KnowledgeProfileRuleImpact[];
}

export interface KnowledgeEmployeeImpact {
  employeeId: string;
  employeeName: string;
  employeeStatus: KnowledgeRecordStatus;
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

export interface KnowledgeBaseImpact {
  knowledgeBaseId: string;
  profileMatches: KnowledgeProfileImpactMatch[];
  employees: KnowledgeEmployeeImpact[];
  projectRoles: KnowledgeProjectRoleImpact[];
}

export interface KnowledgeProfileImpact {
  profileId: string;
  knowledgeBases: KnowledgeBaseImpactMatch[];
  employees: KnowledgeEmployeeImpact[];
  projectRoles: KnowledgeProjectRoleImpact[];
}

export interface KnowledgeDanglingAssignment {
  profileId: string;
  source: "employee" | "project-role";
  employeeId: string;
  projectId?: string;
  roleId?: string;
}

export interface KnowledgeImpactSnapshot {
  knowledgeBases: KnowledgeBaseImpact[];
  profiles: KnowledgeProfileImpact[];
  danglingAssignments: KnowledgeDanglingAssignment[];
  generatedAt: string;
}

export interface KnowledgeBaseDetail {
  knowledgeBase: KnowledgeBaseDefinition;
  versions: KnowledgeBaseDefinition[];
  latestRevision?: KnowledgeRevision;
  publishedRevision?: KnowledgeRevision;
  latestAssessment?: KnowledgeRevisionAssessment;
  publishedAssessment?: KnowledgeRevisionAssessment;
  revisionHistory: KnowledgeRevisionSummary[];
}
