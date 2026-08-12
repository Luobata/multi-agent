import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { createDefaultArchitectureRegistry } from "../architectures/registry.js";
import {
  instantiateArchitectureTemplate,
  listArchitectureTemplates,
  type ArchitectureTemplateDefinition,
  type InstantiatedArchitectureTemplate
} from "../architectures/templates.js";
import type { ArchitectureRegistry } from "../architectures/types.js";
import { listGateValidators as listRegisteredGateValidators } from "../architectures/gateValidators.js";
import { compilePlan } from "../core/plan.js";
import { loadManifest } from "../config/loadManifest.js";
import type {
  JsonObject,
  JsonValue,
  RuntimeHumanDecisionOutcome,
  RuntimeHumanDecisionRequest,
  RoleIdentityDefinition,
  RolePermissionDefinition,
  RoleSkillBinding,
  WorkflowRunRecord,
  WorkflowRunIsolation
} from "../core/types.js";
import {
  configurationPlanHash,
  configurationReviewHash,
  configurationReviewProgress,
  latestConfigurationDecisions
} from "../configuration/proposal.js";
import type {
  ConfigurationOperation,
  ConfigurationOperationRisk,
  ConfigurationOperationType,
  ConfigurationProposal,
  ConfigurationProposalApplyInput,
  ConfigurationProposalCreateInput,
  ConfigurationReviewDecisionInput,
  ConfigurationReviewItem
} from "../configuration/types.js";
import { KnowledgeRuntime } from "../knowledge/runtime.js";
import { assessKnowledgeRevision } from "../knowledge/assessment.js";
import { knowledgeChangePlanHash, knowledgeChangeRisk } from "../knowledge/change.js";
import { buildKnowledgeWiki, deriveKnowledgeRelationCandidates } from "../knowledge/documents.js";
import { buildKnowledgeImpactSnapshot } from "../knowledge/impact.js";
import { resolveKnowledgeScope } from "../knowledge/resolver.js";
import { activatedKnowledgeCollectionKeys, routeKnowledge } from "../knowledge/router.js";
import { RestrictedKnowledgeUrlFetcher } from "../knowledge/urlFetcher.js";
import { webpageToKnowledgeDocuments } from "../knowledge/urlImport.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryRetriever } from "../memory/retriever.js";
import { MemoryExtractor, summarizerContent, buildRunEvidence, type RunLike, type SummarizeFn } from "../memory/extractor.js";
import { buildEvidenceRerunRequest, parseOriginalRunRequest } from "./evidenceRerun.js";
import { employeeRuntimeResources, ExclusiveRuntimeResourceQueue } from "./runtimeResources.js";
import type { MemoryEvidence, MemoryRecord, MemoryScope, MemorySearchQuery } from "../memory/types.js";
import type {
  KnowledgeBaseCreateInput,
  KnowledgeBaseDefinition,
  KnowledgeBaseDetail,
  KnowledgeBaseUpdateInput,
  KnowledgeChangeCreateInput,
  KnowledgeChangeImpactSummary,
  KnowledgeChangeOperation,
  KnowledgeChangeOperationType,
  KnowledgeChangePreview,
  KnowledgeChangeRequest,
  KnowledgeDocumentDefinition,
  KnowledgeDocumentInput,
  KnowledgeEvidenceUsage,
  KnowledgeGrantReviewItem,
  KnowledgeGrantReviewLedger,
  KnowledgeImpactSnapshot,
  KnowledgePerspective,
  KnowledgePerspectiveInput,
  KnowledgeProfileGrant,
  KnowledgeProfileGrantInput,
  KnowledgeProfileGrantOverride,
  KnowledgeReferenceType,
  KnowledgeProfileCreateInput,
  KnowledgeProfileDefinition,
  KnowledgeProfileRule,
  KnowledgeProfileSelector,
  KnowledgeProfileUpdateInput,
  KnowledgeRevision,
  KnowledgeRevisionAssessment,
  KnowledgeRevisionCreateInput,
  KnowledgeRevisionPreview,
  KnowledgeRevisionPreviewInput,
  KnowledgeRuntimeResult,
  KnowledgeUrlPreview,
  KnowledgeUrlPreviewInput,
  KnowledgeUrlProposeInput,
  KnowledgeWikiView
} from "../knowledge/types.js";
import { createDefaultProviderRegistry, type ProviderRegistry } from "../runtime/providers.js";
import { RunStore } from "../runtime/artifacts.js";
import { isSystemManagedProviderId } from "../runtime/systemProviders.js";
import { runWorkflow, type ObservedRunEvent, type RunWorkflowResult } from "../runtime/runner.js";
import { createRunWorktree, removeRunWorktree, worktreeHasChanges } from "../runtime/worktree.js";
import {
  acceptRebasedRunSource,
  beginManagedRunRebase,
  continueManagedRunRebase,
  assessQueuedRun,
  createMergeValidationWorktree,
  discardRunWorktree,
  keepRunWorktree,
  mergeAcceptedRun,
  openManagedRunWorktree,
  previewRunMerge,
  queueAcceptedRun,
  removeMergeValidationWorktree,
  resolveRunEvidenceAsset,
  transitionRunDelivery,
  updateRunDelivery,
  updateRunEvidenceRerun,
  type RunDeliveryActionResult,
  type RunDeliveryRecord,
  type RunEvidenceAsset,
  type RunMergePreview,
  type RunMergeQueueResult,
  type RunMergeResult
} from "../runtime/worktreeDelivery.js";
import {
  CONFLICT_EXECUTION_PASS,
  CONFLICT_PLAN_READY,
  LEADER_REVALIDATION_PASS,
  buildConflictExecutionRequest,
  buildConflictPlanningRequest,
  buildLeaderRevalidationRequest,
  hasExplicitDeliveryPass,
  selectConflictExecutionRole
} from "./conflictResolution.js";
import {
  materializeWorkflow,
  resolveSkillBinding,
  SUPERVISOR_RUNTIME_ROLE_ID,
  supervisorMemberRuntimeRoleId
} from "./materialize.js";
import { ensureProjectDescriptor, loadProjectDescriptor } from "./projectDescriptor.js";
import {
  observePassiveProjectAccess,
  passiveProjectAccessLinkedProjectId
} from "./passiveProjectAccess.js";
import { WorkbenchStore } from "./store.js";
import {
  conversationDocumentPath,
  conversationImagePath,
  isConversationAttachmentId,
  LarkCliDocumentFetcher,
  prepareConversationEvidence,
  resolvePersistedConversationImage,
  validateConversationImages,
  type LarkDocumentFetcher
} from "./conversationEvidence.js";
import { normalizeSupervisorFlow } from "./supervisorFlow.js";
import {
  computeInvocationProgress,
  formatInvocationProgressReport,
  invocationProgressCursor,
  type InvocationProgress,
  type WorkflowProgressWaitResult
} from "./invocationProgress.js";
import { compileEffectiveExecutionProfile } from "./effectiveProfile.js";
import {
  evaluateEntrancePolicyDefinition,
  normalizeEntrancePolicyRouteResult,
  normalizeEntrancePolicyRules,
  parseEntrancePolicyDispatchInput,
  parseEntrancePolicyEvaluationInput,
  resolveEntrancePolicyTarget
} from "./entrancePolicy.js";
import {
  DEFAULT_EMPLOYEE_OUTPUT_SCHEMA,
  type ActivityEvent,
  type ActivitySnapshot,
  type EmployeeContextView,
  type EmployeeCreateInput,
  type EmployeeDefinition,
  type EffectiveExecutionProfile,
  type EmployeeFromTemplateCreateInput,
  type EmployeeScope,
  type EmployeeScopeInput,
  type EmployeeTemplateCreateInput,
  type EmployeeTemplateDefaults,
  type EmployeeTemplateDefinition,
  type EmployeeTemplateRecord,
  type EmployeeTemplateSource,
  type EmployeeTemplateUpdateInput,
  type EmployeeUpdateInput,
  type EmployeeInvocationInput,
  type EmployeeInvocationResult,
  type EmployeeRecord,
  type EmployeeSession,
  type EmployeeSessionMessage,
  type EntrancePolicyCreateInput,
  type EntrancePolicyDecision,
  type EntrancePolicyDefinition,
  type EntrancePolicyDirectRoute,
  type EntrancePolicyDispatchInput,
  type EntrancePolicyDispatchResult,
  type EntrancePolicyEvaluationInput,
  type EntrancePolicyExecutionSnapshot,
  type EntrancePolicyLeaderInput,
  type EntrancePolicyProjectRoleTarget,
  type EntrancePolicySpecialistTarget,
  type EntrancePolicySpecialistTargetInput,
  type EntrancePolicyUpdateInput,
  type InvocationDetail,
  type InvocationRecord,
  type InvocationStartResult,
  type InvocationSource,
  type InvocationStatus,
  type HumanDecisionRequest,
  type HumanDecisionRequestCreateInput,
  type HumanDecisionRequestDecisionInput,
  type PassiveProjectAccessRecord,
  type PublicationDefinition,
  type ProjectBindingDefinition,
  type ProjectBindingInput,
  type ProjectBindingRefreshResult,
  type ProjectConnectInput,
  type ProjectCreateInput,
  type ProjectDefinition,
  type ProjectRecord,
  type ProjectRoleContract,
  type ProjectRoleBinding,
  type ProjectRoleBindingInput,
  type GraphWorkbenchWorkflowDefinition,
  type GraphWorkflowCreateInput,
  type ManagementPolicyCreateInput,
  type ManagementPolicyDefinition,
  type ManagementPolicyExecution,
  type ManagementPolicyLimits,
  type ManagementPolicyUpdateInput,
  type SkillCreateInput,
  type SkillUpdateInput,
  type WorkbenchSkillDefinition,
  type WorkbenchState,
  type WorkbenchWorkflowDefinition,
  type SupervisorWorkbenchWorkflowDefinition,
  type SupervisorWorkflowCreateInput,
  type WorkflowEntrancePolicyRefreshResult,
  type WorkflowRefreshResult,
  type WorkflowRefreshChange,
  type WorkflowChangeRequest,
  type WorkflowChangeOperation,
  type WorkflowChangeCreateInput,
  type SupervisorGate,
  type SupervisorFlowStage,
  type SupervisorFlowInput,
  type WorkInstanceRecord,
  type WorkInstanceStatus,
  type WorkflowCreateInput,
  type WorkflowUpdateInput
} from "./types.js";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Internal Employee id used to summarize completed runs into reusable memory. */
const MEMORY_SUMMARIZER_ID = "memory-summarizer";

/** Internal invocation caller marker. Callers prefixed with "system:" are treated as
 * internal system triggers and are exempt from the human-direct-invocation guard on
 * automatic system employees. */
const INTERNAL_CALLER = "system:memory-extractor";

export const WORKFLOW_PROGRESS_DEFAULT_TIMEOUT_MS = 30_000;
export const WORKFLOW_PROGRESS_MAX_TIMEOUT_MS = 55_000;
const WORKFLOW_PROGRESS_MIN_TIMEOUT_MS = 1_000;


function now(): string {
  return new Date().toISOString();
}

function requireId(id: string, label: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`${label} must match ${ID_PATTERN.source}`);
  return id;
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty`);
  return trimmed;
}

function normalizeBinding(binding: RoleSkillBinding): { id: string; config: JsonObject; enabled: boolean } {
  return typeof binding === "string"
    ? { id: binding, config: {}, enabled: true }
    : { id: binding.id, config: binding.config ?? {}, enabled: binding.enabled !== false };
}

function validateSchema(schema: JsonObject, label: string): void {
  try {
    new Ajv({ allErrors: true, strict: false }).compile(schema);
  } catch (error) {
    throw new Error(`${label} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateVerdict(verdict: EmployeeDefinition["verdict"], label: string): void {
  if (!verdict) return;
  requireText(verdict.path, `${label} verdict path`);
  if (verdict.pass.length === 0 || verdict.block.length === 0) {
    throw new Error(`${label} verdict pass and block must each contain at least one value`);
  }
  const overlap = verdict.pass.filter((value) => verdict.block.includes(value));
  if (overlap.length > 0) throw new Error(`${label} verdict pass/block values overlap: ${overlap.join(", ")}`);
}

function resolveSkillVersion(
  state: WorkbenchState,
  id: string,
  version?: number
): WorkbenchSkillDefinition {
  const current = state.skills[id];
  if (!current) throw new Error(`unknown skill ${id}`);
  if (version === undefined || current.version === version) return current;
  const historical = state.skillHistory[id]?.find((candidate) => candidate.version === version);
  if (!historical) throw new Error(`skill ${id} version ${version} not found`);
  return historical;
}

function pinSkillVersions(
  state: WorkbenchState,
  bindings: RoleSkillBinding[],
  requested: Record<string, number> = {}
): Record<string, number> {
  return Object.fromEntries(bindings.map((binding) => {
    const id = normalizeBinding(binding).id;
    const skill = resolveSkillVersion(state, id, requested[id]);
    return [id, skill.version];
  }));
}

function validateSkillBindings(
  state: WorkbenchState,
  bindings: RoleSkillBinding[],
  versions: Record<string, number>
): void {
  const seen = new Set<string>();
  for (const binding of bindings) {
    const normalized = normalizeBinding(binding);
    if (seen.has(normalized.id)) throw new Error(`skill ${normalized.id} is bound more than once`);
    seen.add(normalized.id);
    const skill = resolveSkillVersion(state, normalized.id, versions[normalized.id]);
    if (skill.owner === "system") {
      throw new Error(`system skill ${normalized.id} cannot be bound to an Employee manually`);
    }
    if (skill.configSchema) {
      const validate = new Ajv({ allErrors: true, strict: false }).compile(skill.configSchema);
      if (!validate(normalized.config)) {
        const issues = (validate.errors ?? []).map(
          (error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
        );
        throw new Error(`skill ${normalized.id} config is invalid: ${issues.join("; ")}`);
      }
    }
  }
}

function employeeVersion(record: EmployeeRecord, version?: number): EmployeeDefinition {
  if (version === undefined) return record.current;
  const found = record.versions.find((candidate) => candidate.version === version);
  if (!found) throw new Error(`employee ${record.current.id} version ${version} not found`);
  return found;
}

function employeeTemplateVersion(record: EmployeeTemplateRecord, version?: number): EmployeeTemplateDefinition {
  if (version === undefined) return record.current;
  const found = record.versions.find((candidate) => candidate.version === version);
  if (!found) throw new Error(`employee template ${record.current.id} version ${version} not found`);
  return found;
}

function projectVersion(record: ProjectRecord, version?: number): ProjectDefinition {
  if (version === undefined) return record.current;
  const found = record.versions.find((candidate) => candidate.version === version);
  if (!found) throw new Error(`project ${record.current.id} version ${version} not found`);
  return found;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function narrowPermissions(
  employee: RolePermissionDefinition,
  project: RolePermissionDefinition | undefined
): RolePermissionDefinition {
  if (!project) return employee;
  const rank: Record<RolePermissionDefinition["write"], number> = { none: 0, "artifacts-only": 1, project: 2 };
  const write = rank[employee.write] <= rank[project.write] ? employee.write : project.write;
  const tools = employee.tools && project.tools
    ? employee.tools.filter((tool) => project.tools?.includes(tool))
    : employee.tools ?? project.tools;
  return { write, tools };
}

function uniqueIds(values: string[], label: string): string[] {
  const normalized = values.map((value) => requireId(value, label));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicates`);
  return normalized;
}

function validateKnowledgeProfileIds(state: WorkbenchState, values: string[], label: string): string[] {
  const ids = uniqueIds(values, label);
  for (const id of ids) {
    const profile = state.knowledgeProfiles[id]?.current;
    if (!profile) throw new Error(`knowledge profile not found: ${id}`);
    if (profile.status !== "active") throw new Error(`knowledge profile ${id} is archived`);
  }
  return ids;
}

function normalizedStringList(values: string[] | undefined, label: string): string[] | undefined {
  if (values === undefined) return undefined;
  const normalized = values.map((value) => requireText(value, label));
  return [...new Set(normalized)];
}

function normalizeCapabilities(values: string[] | undefined, label: string): string[] {
  return normalizedStringList(values ?? [], label) ?? [];
}

/**
 * Produce a bounded one-line skill summary the supervisor can read when judging who fits a task.
 * Uses an explicit summary when provided, otherwise the description's first sentence, capped so
 * the leader prompt does not balloon as skill bodies grow.
 */
function deriveSkillSummary(summary: string | undefined, description: string): string {
  const explicit = summary?.trim();
  const source = explicit || description.trim().split(/(?<=[.!?。！？])\s+/)[0] || description.trim();
  const collapsed = source.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 159).trimEnd()}…` : collapsed;
}

function legacyMetadataProjectId(identity: RoleIdentityDefinition): string | undefined {
  const value = identity.metadata?.internalProjectId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeEmployeeScope(
  state: WorkbenchState,
  scope: EmployeeScopeInput | undefined,
  identity: RoleIdentityDefinition,
  label: string
): EmployeeScope {
  const legacyProjectId = scope === undefined ? legacyMetadataProjectId(identity) : undefined;
  const normalized = scope ?? (legacyProjectId
    ? { kind: "project" as const, projectId: legacyProjectId, projectVersion: 1 }
    : { kind: "global" as const });
  if (normalized.kind === "global") return normalized;
  const projectId = requireId(normalized.projectId, `${label} project id`);
  const projectVersionValue = validRevision(
    normalized.projectVersion,
    legacyProjectId ? 1 : state.projects[projectId]?.current.version,
    `${label} project version`
  );
  if (!legacyProjectId) {
    const project = state.projects[projectId];
    if (!project) throw new Error(`project not found: ${projectId}`);
    if (!project.versions.some((candidate) => candidate.version === projectVersionValue)) {
      throw new Error(`project ${projectId} version ${projectVersionValue} not found`);
    }
  }
  return { kind: "project", projectId, projectVersion: projectVersionValue };
}

function sameEmployeeScope(left: EmployeeScope, right: EmployeeScope): boolean {
  return left.kind === right.kind && (left.kind === "global" || (
    right.kind === "project"
    && left.projectId === right.projectId
    && left.projectVersion === right.projectVersion
  ));
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function validRevision(value: number | undefined, fallback: number | undefined, label: string): number {
  const revision = value ?? fallback;
  if (!Number.isInteger(revision) || (revision ?? 0) < 1) throw new Error(`${label} must be a positive integer`);
  return revision as number;
}

function normalizedTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return new Date(timestamp).toISOString();
}

function normalizeKnowledgeGrants(
  profileIds: string[],
  inputs: KnowledgeProfileGrantInput[] | undefined,
  fallbackAt: string,
  existing: KnowledgeProfileGrant[] = []
): KnowledgeProfileGrant[] {
  if (inputs === undefined) {
    const previous = new Map(existing.map((grant) => [grant.profileId, grant]));
    return profileIds.map((profileId) => previous.get(profileId) ?? {
      profileId,
      reason: "Legacy knowledgeProfileIds assignment",
      grantedBy: "legacy-migration",
      grantedAt: fallbackAt,
      source: "legacy" as const
    });
  }
  const previous = new Map(existing.map((grant) => [grant.profileId, grant]));
  const seen = new Set<string>();
  const normalized = inputs.map((input) => {
    const profileId = requireId(input.profileId, "knowledge grant profileId");
    if (seen.has(profileId)) throw new Error(`knowledge grant ${profileId} is repeated`);
    seen.add(profileId);
    const grantedAt = input.grantedAt ? normalizedTimestamp(input.grantedAt, `knowledge grant ${profileId} grantedAt`) : fallbackAt;
    const expiresAt = input.expiresAt ? normalizedTimestamp(input.expiresAt, `knowledge grant ${profileId} expiresAt`) : undefined;
    const lastReviewedAt = input.lastReviewedAt
      ? normalizedTimestamp(input.lastReviewedAt, `knowledge grant ${profileId} lastReviewedAt`)
      : undefined;
    if (input.reviewCycleDays !== undefined && (!Number.isInteger(input.reviewCycleDays) || input.reviewCycleDays < 1 || input.reviewCycleDays > 3650)) {
      throw new Error(`knowledge grant ${profileId} reviewCycleDays must be an integer from 1 to 3650`);
    }
    const prior = previous.get(profileId);
    const normalizedGrant = {
      profileId,
      reason: requireText(input.reason, `knowledge grant ${profileId} reason`),
      grantedBy: requireText(input.grantedBy, `knowledge grant ${profileId} grantedBy`),
      grantedAt,
      expiresAt,
      reviewCycleDays: input.reviewCycleDays,
      lastReviewedAt
    };
    const unchanged = prior !== undefined
      && prior.reason === normalizedGrant.reason
      && prior.grantedBy === normalizedGrant.grantedBy
      && prior.grantedAt === normalizedGrant.grantedAt
      && prior.expiresAt === normalizedGrant.expiresAt
      && prior.reviewCycleDays === normalizedGrant.reviewCycleDays
      && prior.lastReviewedAt === normalizedGrant.lastReviewedAt;
    return {
      ...normalizedGrant,
      source: unchanged ? prior.source : "explicit" as const
    };
  });
  const expected = [...profileIds].sort();
  const actual = normalized.map((grant) => grant.profileId).sort();
  if (!jsonEqual(expected, actual)) {
    throw new Error("knowledge grant metadata must contain exactly one record for every knowledgeProfileId");
  }
  return profileIds.map((profileId) => normalized.find((grant) => grant.profileId === profileId)!);
}

export function systemRoleOf(e: { systemRole?: string }): "automatic" | "conversational" | undefined {
  return e.systemRole === "automatic" || e.systemRole === "conversational" ? e.systemRole : undefined;
}

export function isSystemEmployee(e: { systemRole?: string }): boolean {
  return systemRoleOf(e) !== undefined;
}

function buildEmployeeDefinition(
  state: WorkbenchState,
  input: EmployeeCreateInput,
  timestamp: string,
  template?: EmployeeTemplateSource
): EmployeeDefinition {
  const id = requireId(input.id, "employee id");
  const providerId = input.providerId ?? "mock";
  if (!state.providers[providerId]) throw new Error(`unknown provider ${providerId}`);
  const identity: RoleIdentityDefinition = {
    displayName: requireText(input.identity.displayName, "employee displayName"),
    background: requireText(input.identity.background, "employee background"),
    responsibilities: input.identity.responsibilities.map((value) => requireText(value, "employee responsibility")),
    goals: input.identity.goals?.map((value) => requireText(value, "employee goal")),
    constraints: input.identity.constraints?.map((value) => requireText(value, "employee constraint")),
    metadata: input.identity.metadata
  };
  if (identity.responsibilities.length === 0) throw new Error("employee responsibilities must not be empty");
  const skills = input.skills ?? [];
  const skillVersions = pinSkillVersions(state, skills, input.skillVersions);
  validateSkillBindings(state, skills, skillVersions);
  const knowledgeProfileIds = validateKnowledgeProfileIds(
    state,
    input.knowledgeProfileIds ?? [],
    `employee ${id} knowledge profile`
  );
  const outputSchema = input.outputSchema ?? DEFAULT_EMPLOYEE_OUTPUT_SCHEMA;
  validateSchema(outputSchema, `employee ${id} outputSchema`);
  const verdict = input.verdict ?? undefined;
  validateVerdict(verdict, `employee ${id}`);
  if (input.systemRole !== undefined && input.systemRole !== "automatic" && input.systemRole !== "conversational") {
    throw new Error(`employee ${id} systemRole must be "automatic" or "conversational"`);
  }
  return {
    id,
    version: 1,
    status: "active",
    identity,
    description: requireText(input.description ?? identity.background, "employee description"),
    systemPrompt: requireText(
      input.systemPrompt ?? "Act within the assigned identity, preserve evidence, and state uncertainty explicitly.",
      "employee systemPrompt"
    ),
    requestPrompt: requireText(
      input.requestPrompt ?? "Complete the current request using the available context and return the required structured output.",
      "employee requestPrompt"
    ),
    capabilities: normalizeCapabilities(input.capabilities, `employee ${id} capability`),
    scope: normalizeEmployeeScope(state, input.scope, identity, `employee ${id} scope`),
    template,
    skills,
    skillVersions,
    knowledgeProfileIds,
    knowledgeGrants: normalizeKnowledgeGrants(knowledgeProfileIds, input.knowledgeGrants, timestamp),
    providerId,
    outputSchema,
    maxAttempts: Math.max(1, Math.min(10, input.maxAttempts ?? 1)),
    permissions: input.permissions ?? { write: "none", tools: [] },
    verdict,
    contextPolicy: { historyLimit: Math.max(0, Math.min(100, input.contextPolicy?.historyLimit ?? 20)) },
    presentation: input.presentation ?? {},
    systemRole: input.systemRole,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function buildUpdatedEmployeeDefinition(
  state: WorkbenchState,
  id: string,
  input: EmployeeUpdateInput,
  updatedAt: string,
  allowProjectRepin = false
): EmployeeDefinition {
  const record = state.employees[id];
  if (!record) throw new Error(`employee not found: ${id}`);
  const current = record.current;
  const providerId = input.providerId ?? current.providerId;
  if (!state.providers[providerId]) throw new Error(`unknown provider ${providerId}`);
  const skills = input.skills ?? current.skills;
  const skillVersions = input.skills === undefined && input.skillVersions === undefined
    ? current.skillVersions
    : pinSkillVersions(state, skills, input.skillVersions);
  validateSkillBindings(state, skills, skillVersions);
  const knowledgeProfileIds = input.knowledgeProfileIds === undefined
    ? current.knowledgeProfileIds
    : validateKnowledgeProfileIds(state, input.knowledgeProfileIds, `employee ${id} knowledge profile`);
  const outputSchema = input.outputSchema ?? current.outputSchema;
  validateSchema(outputSchema, `employee ${id} outputSchema`);
  const verdict = input.verdict === undefined ? current.verdict : input.verdict ?? undefined;
  validateVerdict(verdict, `employee ${id}`);
  const identity = input.identity ?? current.identity;
  const legacyScopedProjectId = legacyMetadataProjectId(current.identity);
  if (legacyMetadataProjectId(identity) !== legacyScopedProjectId) {
    throw new Error(legacyScopedProjectId
      ? `employee ${id} internal project scope ${legacyScopedProjectId} is immutable`
      : `employee ${id} internal project identity scope is immutable`);
  }
  const scopedRoleId = internalProjectRoleId(current);
  if (internalProjectRoleId({ ...current, identity }) !== scopedRoleId) {
    throw new Error(scopedRoleId
      ? `employee ${id} internal project role scope ${scopedRoleId} is immutable`
      : `employee ${id} internal project role scope is immutable`);
  }
  const knowledgeGrants = normalizeKnowledgeGrants(
    knowledgeProfileIds,
    input.knowledgeGrants,
    updatedAt,
    current.knowledgeGrants
  );
  const scope = input.scope === undefined
    ? current.scope
    : normalizeEmployeeScope(state, input.scope, identity, `employee ${id} scope`);
  const repinsSameProject = current.scope.kind === "project"
    && scope.kind === "project"
    && current.scope.projectId === scope.projectId;
  if (!sameEmployeeScope(current.scope, scope) && !(allowProjectRepin && repinsSameProject)) {
    throw new Error(`employee ${id} scope is immutable outside its current project`);
  }
  const updated: EmployeeDefinition = {
    ...current,
    identity: {
      ...identity,
      displayName: requireText(identity.displayName, "employee displayName"),
      background: requireText(identity.background, "employee background"),
      responsibilities: identity.responsibilities.map((value) => requireText(value, "employee responsibility")),
      goals: identity.goals?.map((value) => requireText(value, "employee goal")),
      constraints: identity.constraints?.map((value) => requireText(value, "employee constraint"))
    },
    description: input.description === undefined ? current.description : requireText(input.description, "employee description"),
    systemPrompt: input.systemPrompt === undefined ? current.systemPrompt : requireText(input.systemPrompt, "employee systemPrompt"),
    requestPrompt: input.requestPrompt === undefined ? current.requestPrompt : requireText(input.requestPrompt, "employee requestPrompt"),
    capabilities: input.capabilities === undefined
      ? current.capabilities
      : normalizeCapabilities(input.capabilities, `employee ${id} capability`),
    scope,
    skills,
    skillVersions,
    knowledgeProfileIds,
    knowledgeGrants,
    providerId,
    outputSchema,
    maxAttempts: input.maxAttempts === undefined ? current.maxAttempts : Math.max(1, Math.min(10, input.maxAttempts)),
    permissions: input.permissions ?? current.permissions,
    verdict,
    contextPolicy: {
      historyLimit: Math.max(0, Math.min(100, input.contextPolicy?.historyLimit ?? current.contextPolicy.historyLimit))
    },
    presentation: input.presentation ?? current.presentation,
    version: current.version + 1,
    updatedAt
  };
  if (updated.identity.responsibilities.length === 0) throw new Error("employee responsibilities must not be empty");
  return updated;
}

function normalizeEmployeeTemplateDefaults(
  state: WorkbenchState,
  id: string,
  displayName: string,
  defaults: EmployeeTemplateDefaults,
  timestamp: string
): EmployeeTemplateDefaults {
  const employee = buildEmployeeDefinition(state, {
    ...defaults,
    id: `template-${id}`,
    identity: { ...defaults.identity, displayName }
  }, timestamp);
  const { displayName: _displayName, ...identity } = employee.identity;
  return {
    identity,
    description: employee.description,
    systemPrompt: employee.systemPrompt,
    requestPrompt: employee.requestPrompt,
    capabilities: employee.capabilities,
    scope: employee.scope,
    skills: employee.skills,
    skillVersions: employee.skillVersions,
    knowledgeProfileIds: employee.knowledgeProfileIds,
    knowledgeGrants: employee.knowledgeGrants.map(({ source: _source, ...grant }) => grant),
    providerId: employee.providerId,
    outputSchema: employee.outputSchema,
    maxAttempts: employee.maxAttempts,
    permissions: employee.permissions,
    verdict: employee.verdict,
    contextPolicy: employee.contextPolicy,
    presentation: employee.presentation
  };
}

function normalizeKnowledgeRule(rule: KnowledgeProfileRule): KnowledgeProfileRule {
  const selector: KnowledgeProfileSelector = {
    knowledgeBaseIds: normalizedStringList(rule.selector.knowledgeBaseIds, "knowledge selector knowledgeBaseId")?.map((id) => requireId(id, "knowledge selector knowledgeBaseId")),
    domains: normalizedStringList(rule.selector.domains, "knowledge selector domain")?.map((id) => requireId(id, "knowledge selector domain")),
    products: normalizedStringList(rule.selector.products, "knowledge selector product")?.map((id) => requireId(id, "knowledge selector product")),
    projectIds: normalizedStringList(rule.selector.projectIds, "knowledge selector projectId")?.map((id) => requireId(id, "knowledge selector projectId")),
    collectionIds: normalizedStringList(rule.selector.collectionIds, "knowledge selector collectionId")?.map((id) => requireId(id, "knowledge selector collectionId")),
    authorities: rule.selector.authorities ? [...new Set(rule.selector.authorities)] : ["canonical", "reference"],
    maxClassification: rule.selector.maxClassification ?? "internal"
  };
  const hasCatalogScope = [
    selector.knowledgeBaseIds,
    selector.domains,
    selector.products,
    selector.projectIds,
    selector.collectionIds
  ].some((value) => value && value.length > 0);
  if (!hasCatalogScope) {
    throw new Error(`knowledge profile rule ${rule.id} must constrain a knowledge base, domain, product, project, or collection`);
  }
  if (selector.authorities?.some((authority) => !["canonical", "reference", "experimental"].includes(authority))) {
    throw new Error(`knowledge profile rule ${rule.id} has an invalid authority`);
  }
  if (selector.maxClassification && !["internal", "confidential", "restricted"].includes(selector.maxClassification)) {
    throw new Error(`knowledge profile rule ${rule.id} has an invalid maxClassification`);
  }
  if (!["core", "conditional", "on-demand"].includes(rule.activation)) {
    throw new Error(`knowledge profile rule ${rule.id} has invalid activation ${String(rule.activation)}`);
  }
  const conditions = rule.conditions ? {
    projectIds: normalizedStringList(rule.conditions.projectIds, "knowledge condition projectId")?.map((id) => requireId(id, "knowledge condition projectId")),
    projectRoleIds: normalizedStringList(rule.conditions.projectRoleIds, "knowledge condition projectRoleId")?.map((id) => requireId(id, "knowledge condition projectRoleId")),
    taskTags: normalizedStringList(rule.conditions.taskTags, "knowledge condition taskTag"),
    requestTerms: normalizedStringList(rule.conditions.requestTerms, "knowledge condition requestTerm")
  } : undefined;
  return {
    id: requireId(rule.id, "knowledge profile rule id"),
    selector,
    activation: rule.activation,
    conditions,
    priority: boundedNumber(rule.priority, 0, -100, 100),
    required: Boolean(rule.required),
    budget: {
      maxCollections: boundedNumber(rule.budget?.maxCollections, 3, 1, 12),
      maxChunks: boundedNumber(rule.budget?.maxChunks, 4, 1, 20),
      maxTokens: boundedNumber(rule.budget?.maxTokens, 2_000, 128, 16_000)
    }
  };
}

function normalizeKnowledgeDocuments(
  documents: KnowledgeDocumentInput[],
  collectionIds: Set<string>,
  timestamp: string
): KnowledgeDocumentDefinition[] {
  const seen = new Set<string>();
  const referenceTypes = new Set(["related", "supports", "contradicts", "depends-on", "supersedes"]);
  const normalized = documents.map((document, index) => {
    const id = requireId(document.id, "knowledge document id");
    if (seen.has(id)) throw new Error(`knowledge document ${id} is repeated`);
    seen.add(id);
    const collectionId = requireId(document.collectionId, `knowledge document ${id} collectionId`);
    if (!collectionIds.has(collectionId)) throw new Error(`knowledge document ${id} references unknown collection ${collectionId}`);
    const order = document.order ?? index;
    if (!Number.isInteger(order) || order < 0) throw new Error(`knowledge document ${id} order must be a non-negative integer`);
    const references = (document.references ?? []).map((reference) => {
      if (!referenceTypes.has(reference.type)) throw new Error(`knowledge document ${id} has invalid reference type ${String(reference.type)}`);
      return {
        type: reference.type,
        targetDocumentId: requireId(reference.targetDocumentId, `knowledge document ${id} reference target`),
        note: reference.note?.trim() || undefined
      };
    });
    const referenceKeys = references.map((reference) => `${reference.type}/${reference.targetDocumentId}`);
    if (new Set(referenceKeys).size !== referenceKeys.length) throw new Error(`knowledge document ${id} repeats an explicit reference`);
    return {
      id,
      title: requireText(document.title, `knowledge document ${id} title`),
      content: requireText(document.content, `knowledge document ${id} content`),
      collectionId,
      sourceId: document.sourceId ? requireId(document.sourceId, `knowledge document ${id} sourceId`) : undefined,
      sourceRef: document.sourceRef?.trim() || undefined,
      order,
      parentId: document.parentId ? requireId(document.parentId, `knowledge document ${id} parentId`) : undefined,
      references,
      metadata: document.metadata,
      updatedAt: timestamp
    };
  });
  const byId = new Map(normalized.map((document) => [document.id, document]));
  for (const document of normalized) {
    if (document.parentId) {
      const parent = byId.get(document.parentId);
      if (!parent) throw new Error(`knowledge document ${document.id} parent ${document.parentId} is not in this revision`);
      if (parent.collectionId !== document.collectionId) throw new Error(`knowledge document ${document.id} parent must use the same collection`);
    }
    for (const reference of document.references) {
      if (reference.targetDocumentId === document.id) throw new Error(`knowledge document ${document.id} cannot reference itself`);
      if (!byId.has(reference.targetDocumentId)) {
        throw new Error(`knowledge document ${document.id} reference target ${reference.targetDocumentId} is not in this revision`);
      }
    }
  }
  for (const document of normalized) {
    const ancestors = new Set([document.id]);
    let parentId = document.parentId;
    while (parentId) {
      if (ancestors.has(parentId)) throw new Error(`knowledge document hierarchy contains a cycle at ${document.id}`);
      ancestors.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
  }
  return normalized;
}

function invocationMessage(output: JsonValue | undefined): string {
  if (typeof output === "object" && output !== null && !Array.isArray(output)) {
    const message = output.message;
    if (typeof message === "string") return message;
  }
  return output === undefined ? "No structured output was produced." : JSON.stringify(output, null, 2);
}

function runIdentifier(): string {
  return `run-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function summarizeInput(input: JsonObject): string {
  const value = typeof input.message === "string" ? input.message : JSON.stringify(input);
  return value.replaceAll(/\s+/g, " ").trim().slice(0, 180) || "Structured request";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const KNOWLEDGE_CHANGE_TYPES = new Set<KnowledgeChangeOperationType>([
  "knowledge-base.create",
  "knowledge-base.update",
  "knowledge-base.sync",
  "knowledge-base.archive",
  "knowledge-base.restore",
  "knowledge-revision.create",
  "knowledge-revision.publish",
  "knowledge-profile.create",
  "knowledge-profile.update",
  "knowledge-profile.archive",
  "knowledge-profile.restore",
  "employee-profiles.set",
  "project-role-profiles.set"
]);

function jsonPayload(operation: KnowledgeChangeOperation): JsonObject {
  const payload = operation.payload ?? {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`knowledge change ${operation.type} payload must be an object`);
  }
  return payload;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function documentSourcePage(document: KnowledgeDocumentInput): string | undefined {
  const metadataPage = document.metadata?.finalUrl ?? document.metadata?.sourceUrl;
  const value = typeof metadataPage === "string" ? metadataPage : document.sourceRef;
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return value.split("#", 1)[0];
  }
}

function uniqueReferences(
  references: NonNullable<KnowledgeDocumentInput["references"]>
): NonNullable<KnowledgeDocumentInput["references"]> {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.type}/${reference.targetDocumentId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function internalProjectId(employee: EmployeeDefinition): string | undefined {
  return employee.scope.kind === "project" ? employee.scope.projectId : undefined;
}

function internalProjectVersion(employee: EmployeeDefinition): number | undefined {
  return employee.scope.kind === "project" ? employee.scope.projectVersion : undefined;
}

function internalProjectRoleId(employee: EmployeeDefinition): string | undefined {
  const value = employee.identity.metadata?.internalProjectRoleId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function assertProjectRoleProviderCompatibility(
  state: WorkbenchState,
  role: Pick<ProjectRoleContract, "id" | "requiredProviderProfiles">,
  employee: EmployeeDefinition
): void {
  const provider = state.providers[employee.providerId];
  if (!provider) throw new Error(`employee ${employee.id} uses unknown provider ${employee.providerId}`);
  const missingProviderProfiles = role.requiredProviderProfiles
    .filter((profile) => !provider.runtimeProfiles?.includes(profile));
  if (missingProviderProfiles.length > 0) {
    throw new Error(`employee ${employee.id} Provider ${employee.providerId} lacks required runtime profiles: ${missingProviderProfiles.join(", ")}`);
  }
}

const CONFIGURATION_OPERATION_LABELS: Record<ConfigurationOperationType, string> = {
  "identity-profile.set": "身份与档案摘要",
  "prompts.set": "提示词",
  "capabilities.set": "结构化能力",
  "skills.set": "Skill 绑定",
  "runtime.set": "运行时",
  "permissions.set": "权限",
  "output-contract.set": "输出契约",
  "context-policy.set": "上下文策略",
  "presentation.set": "外观"
};

const CONFIGURATION_RISK_RANK: Record<ConfigurationOperationRisk, number> = {
  low: 0,
  medium: 1,
  high: 2
};

const CONFIGURATION_MINIMUM_RISK: Record<ConfigurationOperationType, ConfigurationOperationRisk> = {
  "identity-profile.set": "medium",
  "prompts.set": "medium",
  "capabilities.set": "medium",
  "skills.set": "high",
  "runtime.set": "high",
  "permissions.set": "high",
  "output-contract.set": "high",
  "context-policy.set": "medium",
  "presentation.set": "low"
};

function configurationOperationRisk(
  type: ConfigurationOperationType,
  proposedRisk: ConfigurationOperationRisk
): ConfigurationOperationRisk {
  const minimumRisk = CONFIGURATION_MINIMUM_RISK[type];
  return CONFIGURATION_RISK_RANK[proposedRisk] >= CONFIGURATION_RISK_RANK[minimumRisk]
    ? proposedRisk
    : minimumRisk;
}

function strictConfigurationObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyConfigurationKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}`);
}

function configurationStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((item) => requireText(item, label));
}

function normalizeConfigurationOperation(value: unknown, index: number): ConfigurationOperation {
  const label = `configuration operation ${index + 1}`;
  const operation = strictConfigurationObject(value, label);
  onlyConfigurationKeys(operation, ["type", "rationale", "risk", "payload"], label);
  const type = operation.type;
  if (typeof type !== "string" || !(type in CONFIGURATION_OPERATION_LABELS)) {
    throw new Error(`${label} has unsupported type ${String(type)}`);
  }
  const operationType = type as ConfigurationOperationType;
  const rationale = requireText(String(operation.rationale ?? ""), `${label} rationale`);
  if (operation.risk !== "low" && operation.risk !== "medium" && operation.risk !== "high") {
    throw new Error(`${label} risk must be low, medium, or high`);
  }
  const risk = configurationOperationRisk(operationType, operation.risk);
  const payload = strictConfigurationObject(operation.payload, `${label} payload`);
  switch (operationType) {
    case "identity-profile.set": {
      onlyConfigurationKeys(payload, ["identity", "description"], `${label} payload`);
      const identity = strictConfigurationObject(payload.identity, `${label} identity`);
      onlyConfigurationKeys(identity, ["displayName", "background", "responsibilities", "goals", "constraints", "metadata"], `${label} identity`);
      const metadata = identity.metadata === undefined
        ? undefined
        : strictConfigurationObject(identity.metadata, `${label} identity metadata`) as JsonObject;
      return {
        type: operationType,
        rationale,
        risk,
        payload: {
          identity: {
            displayName: requireText(String(identity.displayName ?? ""), `${label} displayName`),
            background: requireText(String(identity.background ?? ""), `${label} background`),
            responsibilities: configurationStringArray(identity.responsibilities, `${label} responsibilities`),
            goals: identity.goals === undefined ? undefined : configurationStringArray(identity.goals, `${label} goals`),
            constraints: identity.constraints === undefined ? undefined : configurationStringArray(identity.constraints, `${label} constraints`),
            metadata
          },
          description: requireText(String(payload.description ?? ""), `${label} description`)
        }
      };
    }
    case "prompts.set":
      onlyConfigurationKeys(payload, ["systemPrompt", "requestPrompt"], `${label} payload`);
      return {
        type: operationType,
        rationale,
        risk,
        payload: {
          systemPrompt: requireText(String(payload.systemPrompt ?? ""), `${label} systemPrompt`),
          requestPrompt: requireText(String(payload.requestPrompt ?? ""), `${label} requestPrompt`)
        }
      };
    case "capabilities.set":
      onlyConfigurationKeys(payload, ["capabilities"], `${label} payload`);
      return { type: operationType, rationale, risk, payload: { capabilities: configurationStringArray(payload.capabilities, `${label} capabilities`) } };
    case "skills.set": {
      onlyConfigurationKeys(payload, ["skills", "skillVersions"], `${label} payload`);
      if (!Array.isArray(payload.skills)) throw new Error(`${label} skills must be an array`);
      const skills = payload.skills.map((binding, bindingIndex): RoleSkillBinding => {
        if (typeof binding === "string") return requireId(binding, `${label} skill id`);
        const entry = strictConfigurationObject(binding, `${label} skill ${bindingIndex + 1}`);
        onlyConfigurationKeys(entry, ["id", "config", "enabled"], `${label} skill ${bindingIndex + 1}`);
        const config = entry.config === undefined
          ? {}
          : strictConfigurationObject(entry.config, `${label} skill ${bindingIndex + 1} config`) as JsonObject;
        if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
          throw new Error(`${label} skill ${bindingIndex + 1} enabled must be boolean`);
        }
        return { id: requireId(String(entry.id ?? ""), `${label} skill id`), config, enabled: entry.enabled as boolean | undefined };
      });
      let skillVersions: Record<string, number> | undefined;
      if (payload.skillVersions !== undefined) {
        const versions = strictConfigurationObject(payload.skillVersions, `${label} skillVersions`);
        skillVersions = Object.fromEntries(Object.entries(versions).map(([id, version]) => {
          requireId(id, `${label} skill version id`);
          if (!Number.isInteger(version) || Number(version) < 1) {
            throw new Error(`${label} skill version ${id} must be a positive integer`);
          }
          return [id, Number(version)];
        }));
      }
      return { type: operationType, rationale, risk, payload: { skills, skillVersions } };
    }
    case "runtime.set": {
      onlyConfigurationKeys(payload, ["providerId", "maxAttempts"], `${label} payload`);
      const maxAttempts = Number(payload.maxAttempts);
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
        throw new Error(`${label} maxAttempts must be an integer from 1 to 10`);
      }
      return { type: operationType, rationale, risk, payload: { providerId: requireId(String(payload.providerId ?? ""), `${label} providerId`), maxAttempts } };
    }
    case "permissions.set": {
      onlyConfigurationKeys(payload, ["permissions"], `${label} payload`);
      const permissions = strictConfigurationObject(payload.permissions, `${label} permissions`);
      onlyConfigurationKeys(permissions, ["write", "tools"], `${label} permissions`);
      if (permissions.write !== "none" && permissions.write !== "artifacts-only" && permissions.write !== "project") {
        throw new Error(`${label} permissions.write is invalid`);
      }
      return {
        type: operationType,
        rationale,
        risk,
        payload: {
          permissions: {
            write: permissions.write,
            tools: permissions.tools === undefined ? undefined : configurationStringArray(permissions.tools, `${label} permission tools`)
          }
        }
      };
    }
    case "output-contract.set": {
      onlyConfigurationKeys(payload, ["outputSchema", "verdict"], `${label} payload`);
      const outputSchema = strictConfigurationObject(payload.outputSchema, `${label} outputSchema`) as JsonObject;
      let verdict: EmployeeDefinition["verdict"] | null | undefined;
      if (payload.verdict === null) verdict = null;
      else if (payload.verdict !== undefined) {
        const rawVerdict = strictConfigurationObject(payload.verdict, `${label} verdict`);
        onlyConfigurationKeys(rawVerdict, ["path", "pass", "block"], `${label} verdict`);
        if (!Array.isArray(rawVerdict.pass) || !Array.isArray(rawVerdict.block)) throw new Error(`${label} verdict pass/block must be arrays`);
        const primitives = (items: unknown[], itemLabel: string) => items.map((item) => {
          if (item !== null && !["string", "number", "boolean"].includes(typeof item)) throw new Error(`${itemLabel} must contain JSON primitives`);
          return item as string | number | boolean | null;
        });
        verdict = {
          path: requireText(String(rawVerdict.path ?? ""), `${label} verdict path`),
          pass: primitives(rawVerdict.pass, `${label} verdict pass`),
          block: primitives(rawVerdict.block, `${label} verdict block`)
        };
      }
      return { type: operationType, rationale, risk, payload: { outputSchema, verdict } };
    }
    case "context-policy.set": {
      onlyConfigurationKeys(payload, ["historyLimit"], `${label} payload`);
      const historyLimit = Number(payload.historyLimit);
      if (!Number.isInteger(historyLimit) || historyLimit < 0 || historyLimit > 100) {
        throw new Error(`${label} historyLimit must be an integer from 0 to 100`);
      }
      return { type: operationType, rationale, risk, payload: { historyLimit } };
    }
    case "presentation.set": {
      onlyConfigurationKeys(payload, ["accent", "initials", "avatarUrl"], `${label} payload`);
      const optionalText = (value: unknown, field: string) => value === undefined ? undefined : requireText(String(value), `${label} ${field}`);
      return {
        type: operationType,
        rationale,
        risk,
        payload: {
          accent: optionalText(payload.accent, "accent"),
          initials: optionalText(payload.initials, "initials"),
          avatarUrl: optionalText(payload.avatarUrl, "avatarUrl")
        }
      };
    }
  }
}

function configurationUpdateInput(operations: ConfigurationOperation[]): EmployeeUpdateInput {
  const input: EmployeeUpdateInput = {};
  for (const operation of operations) {
    switch (operation.type) {
      case "identity-profile.set":
        input.identity = operation.payload.identity;
        input.description = operation.payload.description;
        break;
      case "prompts.set":
        input.systemPrompt = operation.payload.systemPrompt;
        input.requestPrompt = operation.payload.requestPrompt;
        break;
      case "capabilities.set": input.capabilities = operation.payload.capabilities; break;
      case "skills.set":
        input.skills = operation.payload.skills;
        input.skillVersions = operation.payload.skillVersions;
        break;
      case "runtime.set":
        input.providerId = operation.payload.providerId;
        input.maxAttempts = operation.payload.maxAttempts;
        break;
      case "permissions.set": input.permissions = operation.payload.permissions; break;
      case "output-contract.set":
        input.outputSchema = operation.payload.outputSchema;
        if ("verdict" in operation.payload) input.verdict = operation.payload.verdict;
        break;
      case "context-policy.set": input.contextPolicy = { historyLimit: operation.payload.historyLimit }; break;
      case "presentation.set": input.presentation = operation.payload; break;
    }
  }
  return input;
}

function employeeConfigurationGroup(employee: EmployeeDefinition, type: ConfigurationOperationType): JsonValue {
  switch (type) {
    case "identity-profile.set": return jsonValue({ identity: employee.identity, description: employee.description });
    case "prompts.set": return jsonValue({ systemPrompt: employee.systemPrompt, requestPrompt: employee.requestPrompt });
    case "capabilities.set": return jsonValue({ capabilities: employee.capabilities });
    case "skills.set": return jsonValue({ skills: employee.skills, skillVersions: employee.skillVersions });
    case "runtime.set": return jsonValue({ providerId: employee.providerId, maxAttempts: employee.maxAttempts });
    case "permissions.set": return jsonValue({ permissions: employee.permissions });
    case "output-contract.set": return jsonValue({ outputSchema: employee.outputSchema, verdict: employee.verdict });
    case "context-policy.set": return jsonValue(employee.contextPolicy);
    case "presentation.set": return jsonValue(employee.presentation);
  }
}

interface ConfigurationProposalPlan {
  operations: ConfigurationOperation[];
  reviewItems: ConfigurationReviewItem[];
  candidate: EmployeeDefinition;
  planHash: string;
}

function planConfigurationProposal(
  state: WorkbenchState,
  employeeIdInput: string,
  expectedVersion: number,
  operationInputs: ConfigurationOperation[]
): ConfigurationProposalPlan {
  const employeeId = requireId(employeeIdInput, "configuration proposal employeeId");
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error("configuration proposal expectedEmployeeVersion must be a positive integer");
  }
  const record = state.employees[employeeId];
  if (!record) throw new Error(`employee not found: ${employeeId}`);
  const current = record.current;
  if (current.version !== expectedVersion) {
    throw new Error(`employee ${employeeId} is v${current.version}, expected v${expectedVersion}`);
  }
  if (current.status !== "active") throw new Error(`employee ${employeeId} is archived`);
  if (!Array.isArray(operationInputs) || operationInputs.length === 0 || operationInputs.length > 9) {
    throw new Error("configuration proposal must contain from 1 to 9 semantic operations");
  }
  const operations = operationInputs.map(normalizeConfigurationOperation).map((operation): ConfigurationOperation => {
    if (operation.type !== "skills.set") return operation;
    const boundIds = operation.payload.skills.map((binding) => normalizeBinding(binding).id);
    const unexpectedVersionIds = Object.keys(operation.payload.skillVersions ?? {})
      .filter((id) => !boundIds.includes(id));
    if (unexpectedVersionIds.length > 0) {
      throw new Error(`configuration proposal skillVersions reference unbound Skills: ${unexpectedVersionIds.join(", ")}`);
    }
    const skillVersions = Object.fromEntries(boundIds.flatMap((id) => {
      const requestedVersion = operation.payload.skillVersions?.[id];
      const retainedVersion = current.skillVersions[id];
      const version = requestedVersion ?? retainedVersion;
      return version === undefined ? [] : [[id, version]];
    }));
    return { ...operation, payload: { ...operation.payload, skillVersions } };
  });
  const repeated = operations.find((operation, index) => operations.findIndex((candidate) => candidate.type === operation.type) !== index);
  if (repeated) throw new Error(`configuration proposal repeats semantic group ${repeated.type}`);
  const candidate = buildUpdatedEmployeeDefinition(state, employeeId, configurationUpdateInput(operations), current.updatedAt);
  const reviewItems = operations.map((operation, operationIndex): ConfigurationReviewItem => ({
    id: `review-${String(operationIndex + 1).padStart(2, "0")}-${operation.type.replace(".set", "")}`,
    operationIndex,
    operationType: operation.type,
    label: CONFIGURATION_OPERATION_LABELS[operation.type],
    rationale: operation.rationale,
    risk: operation.risk,
    before: employeeConfigurationGroup(current, operation.type),
    after: employeeConfigurationGroup(candidate, operation.type)
  }));
  const unchanged = reviewItems.find((item) => configurationPlanHash(item.before) === configurationPlanHash(item.after));
  if (unchanged) {
    throw new Error(`configuration proposal operation ${unchanged.operationType} does not change the current Employee`);
  }
  const planHash = configurationPlanHash(jsonValue({
    employeeId,
    expectedEmployeeVersion: expectedVersion,
    operations,
    reviewItems,
    dependencies: {
      provider: state.providers[candidate.providerId],
      skillVersions: candidate.skillVersions
    }
  }));
  return { operations, reviewItems, candidate, planHash };
}

interface ConfigurationControlAccess {
  invocation: InvocationRecord;
  session: EmployeeSession;
  targetEmployeeId: string;
  expectedEmployeeVersion: number;
  project: ProjectDefinition;
  binding: ProjectBindingDefinition;
  projectRoleId: string;
  steward: EmployeeDefinition;
}

function configurationControlAccess(
  state: WorkbenchState,
  sourceRunIdInput: string,
  requiredTool: string
): ConfigurationControlAccess {
  const sourceRunId = requireText(sourceRunIdInput, "configuration control sourceRunId");
  const invocation = Object.values(state.invocations).find((candidate) => candidate.runId === sourceRunId);
  if (!invocation) throw new Error(`configuration control run not found: ${sourceRunId}`);
  if (invocation.status !== "running") {
    throw new Error(`configuration control run ${sourceRunId} is ${invocation.status}, expected running`);
  }
  if (!invocation.sessionId) throw new Error(`configuration control run ${sourceRunId} has no Session`);
  const session = state.sessions[invocation.sessionId];
  if (!session?.assignment) throw new Error(`configuration control run ${sourceRunId} has no project assignment`);
  const projectId = requireId(invocation.source.project ?? "", "configuration control source project");
  const projectRoleId = requireId(invocation.source.projectRole ?? "", "configuration control source project role");
  if (session.assignment.projectId !== projectId || session.assignment.roleId !== projectRoleId) {
    throw new Error(`configuration control run ${sourceRunId} Session assignment does not match its source`);
  }
  if (invocation.source.projectBindingVersion !== session.assignment.projectBindingVersion) {
    throw new Error(`configuration control run ${sourceRunId} binding version does not match its Session`);
  }
  const projectRecord = state.projects[projectId];
  if (!projectRecord) throw new Error(`configuration control project not found: ${projectId}`);
  const project = projectVersion(projectRecord, session.assignment.projectVersion);
  const role = project.roles.find((candidate) => candidate.id === projectRoleId);
  if (!role) throw new Error(`configuration control project role not found: ${projectId}/${projectRoleId}`);
  const bindingRecord = state.projectBindings[projectId];
  const binding = bindingRecord?.versions.find((candidate) => candidate.version === session.assignment?.projectBindingVersion);
  if (!binding || binding.projectVersion !== project.version) {
    throw new Error(`configuration control binding v${session.assignment.projectBindingVersion} is unavailable for project v${project.version}`);
  }
  const roleBinding = binding.roles.find((candidate) => candidate.roleId === projectRoleId);
  if (!roleBinding || roleBinding.employeeId !== session.employeeId || roleBinding.employeeVersion !== session.employeeVersion) {
    throw new Error(`configuration control Session is not pinned to ${projectId}/${projectRoleId}`);
  }
  const stewardRecord = state.employees[session.employeeId];
  if (!stewardRecord) throw new Error(`configuration control steward not found: ${session.employeeId}`);
  const steward = employeeVersion(stewardRecord, session.employeeVersion);
  if (invocation.target.id !== steward.id || invocation.target.version !== steward.version) {
    throw new Error(`configuration control run ${sourceRunId} target does not match its bound Employee`);
  }
  const stewardProvider = state.providers[steward.providerId];
  if (!stewardProvider?.runtimeProfiles?.includes("configuration-proposal-only")) {
    throw new Error(`configuration control steward Provider ${steward.providerId} is not proposal-only`);
  }
  if (!role.permissions?.tools?.includes(requiredTool) || !steward.permissions.tools?.includes(requiredTool)) {
    throw new Error(`configuration control run ${sourceRunId} is not allowed to use ${requiredTool}`);
  }
  const context = strictConfigurationObject(invocation.requestContext, "configuration control invocation context");
  onlyConfigurationKeys(context, ["kind", "employeeId", "expectedEmployeeVersion"], "configuration control invocation context");
  if (context.kind !== "employee-configuration") {
    throw new Error("configuration control invocation context kind must be employee-configuration");
  }
  if (!session.context || !jsonEqual(session.context, context)) {
    throw new Error(`configuration control run ${sourceRunId} context does not match its Session`);
  }
  const targetEmployeeId = requireId(String(context.employeeId ?? ""), "configuration control target Employee");
  const expectedEmployeeVersion = Number(context.expectedEmployeeVersion);
  if (!Number.isInteger(expectedEmployeeVersion) || expectedEmployeeVersion < 1) {
    throw new Error("configuration control expected Employee version must be a positive integer");
  }
  const target = state.employees[targetEmployeeId]?.current;
  if (!target) throw new Error(`employee not found: ${targetEmployeeId}`);
  if (target.status !== "active") throw new Error(`employee ${targetEmployeeId} is archived`);
  if (target.version !== expectedEmployeeVersion) {
    throw new Error(`employee ${targetEmployeeId} is v${target.version}, expected v${expectedEmployeeVersion}`);
  }
  return {
    invocation,
    session,
    targetEmployeeId,
    expectedEmployeeVersion,
    project,
    binding,
    projectRoleId,
    steward
  };
}

type ConfigurationProposalAttestation =
  | { kind: "attested" }
  | { kind: "pending"; error: string }
  | { kind: "invalid"; error: string };

const CONFIGURATION_ATTESTATION_GRACE_MS = 30_000;

function configurationProposalAttestation(
  state: WorkbenchState,
  proposal: ConfigurationProposal
): ConfigurationProposalAttestation {
  const invocation = state.invocations[proposal.source.invocationId];
  if (!invocation || invocation.runId !== proposal.source.runId) {
    return { kind: "invalid", error: `configuration proposal ${proposal.id} source invocation is unavailable` };
  }
  if (invocation.sessionId !== proposal.source.sessionId) {
    return { kind: "invalid", error: `configuration proposal ${proposal.id} source Session does not match its invocation` };
  }
  if (["failed", "blocked", "cancelled"].includes(invocation.status)) {
    return { kind: "invalid", error: `configuration proposal ${proposal.id} source run is ${invocation.status}; create a fresh proposal` };
  }
  if (invocation.status !== "completed") {
    return { kind: "pending", error: `configuration proposal ${proposal.id} source run is ${invocation.status}, expected completed` };
  }
  const session = state.sessions[proposal.source.sessionId];
  if (!session) {
    return { kind: "invalid", error: `configuration proposal ${proposal.id} source Session is unavailable` };
  }
  const attestation = session?.messages.find((message) => {
    if (message.role !== "employee" || message.runId !== proposal.source.runId) return false;
    if (typeof message.output !== "object" || message.output === null || Array.isArray(message.output)) return false;
    const proposalIds = (message.output as JsonObject).proposalIds;
    return Array.isArray(proposalIds) && proposalIds.includes(proposal.id);
  });
  if (!attestation) {
    // Invocation completion is persisted before its Employee message is appended
    // to the Session. Keep that narrow interval retryable, but fail closed after
    // a crash leaves no writer capable of completing the attestation.
    const completedAt = invocation.completedAt ? Date.parse(invocation.completedAt) : Number.NaN;
    if (!Number.isFinite(completedAt) || Math.abs(Date.now() - completedAt) > CONFIGURATION_ATTESTATION_GRACE_MS) {
      return {
        kind: "invalid",
        error: `configuration proposal ${proposal.id} source Run completed without attestation; create a fresh proposal`
      };
    }
    return { kind: "pending", error: `configuration proposal ${proposal.id} is waiting for source Run attestation` };
  }
  return { kind: "attested" };
}

function assertConfigurationReviewSnapshot(
  proposal: ConfigurationProposal,
  expectedReviewRevision: number,
  expectedReviewHashInput: string
): void {
  if (!Number.isInteger(expectedReviewRevision) || expectedReviewRevision < 0) {
    throw new Error("configuration proposal expectedReviewRevision must be a non-negative integer");
  }
  const expectedReviewHash = requireText(expectedReviewHashInput, "configuration proposal expectedReviewHash");
  if (!/^[a-f0-9]{64}$/.test(expectedReviewHash)) {
    throw new Error("configuration proposal expectedReviewHash must be a sha256 hex digest");
  }
  const currentReviewHash = configurationReviewHash(proposal);
  if (proposal.reviewRevision !== expectedReviewRevision
    || proposal.reviewHash !== expectedReviewHash
    || currentReviewHash !== proposal.reviewHash) {
    throw new Error(`configuration proposal ${proposal.id} review changed; reload and confirm the final selections`);
  }
}

function markConfigurationSourceInvalid(proposal: ConfigurationProposal, error: string): void {
  proposal.status = "needs-reapproval";
  proposal.error = error;
  proposal.validation = { valid: false, errors: [error] };
  proposal.updatedAt = now();
}

function stringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of ids`);
  }
  return value as string[];
}

function optionalPayloadText(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return requireText(value, label);
}

type KnowledgeGrantMutation = Omit<KnowledgeProfileGrantOverride, "profileId">;

function knowledgeGrantMutation(value: JsonObject, label: string): KnowledgeGrantMutation {
  const reason = optionalPayloadText(value.reason, `${label} reason`);
  const grantedBy = optionalPayloadText(value.grantedBy, `${label} grantedBy`);
  const grantedAt = optionalPayloadText(value.grantedAt, `${label} grantedAt`);
  const expiresAt = optionalPayloadText(value.expiresAt, `${label} expiresAt`);
  const lastReviewedAt = optionalPayloadText(value.lastReviewedAt, `${label} lastReviewedAt`);
  let reviewCycleDays: number | undefined;
  if (value.reviewCycleDays !== undefined && value.reviewCycleDays !== null) {
    if (typeof value.reviewCycleDays !== "number"
      || !Number.isInteger(value.reviewCycleDays)
      || value.reviewCycleDays < 1
      || value.reviewCycleDays > 3650) {
      throw new Error(`${label} reviewCycleDays must be an integer from 1 to 3650`);
    }
    reviewCycleDays = value.reviewCycleDays;
  }
  const mutation: KnowledgeGrantMutation = {};
  if (reason !== undefined) mutation.reason = reason;
  if (grantedBy !== undefined) mutation.grantedBy = grantedBy;
  if (grantedAt !== undefined) mutation.grantedAt = normalizedTimestamp(grantedAt, `${label} grantedAt`);
  if (expiresAt !== undefined) mutation.expiresAt = normalizedTimestamp(expiresAt, `${label} expiresAt`);
  if (reviewCycleDays !== undefined) mutation.reviewCycleDays = reviewCycleDays;
  if (lastReviewedAt !== undefined) mutation.lastReviewedAt = normalizedTimestamp(lastReviewedAt, `${label} lastReviewedAt`);
  return mutation;
}

function hasKnowledgeGrantMutation(value: KnowledgeGrantMutation): boolean {
  return Object.values(value).some((item) => item !== undefined);
}

function grantOverridesFromSetPayload(payload: JsonObject): KnowledgeProfileGrantOverride[] {
  if (payload.grantOverrides === undefined || payload.grantOverrides === null) return [];
  if (!Array.isArray(payload.grantOverrides)) {
    throw new Error("knowledge grantOverrides must be an array");
  }
  const allowedKeys = new Set([
    "profileId",
    "reason",
    "grantedBy",
    "grantedAt",
    "expiresAt",
    "reviewCycleDays",
    "lastReviewedAt"
  ]);
  const seen = new Set<string>();
  return payload.grantOverrides.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`knowledge grantOverrides[${index}] must be an object`);
    }
    const entry = value as JsonObject;
    const unsupported = Object.keys(entry).filter((key) => !allowedKeys.has(key));
    if (unsupported.length > 0) {
      throw new Error(`knowledge grantOverrides[${index}] has unsupported fields: ${unsupported.join(", ")}`);
    }
    if (typeof entry.profileId !== "string") {
      throw new Error(`knowledge grantOverrides[${index}] profileId must be an id`);
    }
    const profileId = requireId(entry.profileId, `knowledge grantOverrides[${index}] profileId`);
    if (seen.has(profileId)) throw new Error(`knowledge grant override ${profileId} is repeated`);
    seen.add(profileId);
    const mutation = knowledgeGrantMutation(entry, `knowledge grant override ${profileId}`);
    if (!hasKnowledgeGrantMutation(mutation)) {
      throw new Error(`knowledge grant override ${profileId} must change at least one metadata field`);
    }
    return { profileId, ...mutation };
  });
}

function knowledgeGrantInput(grant: KnowledgeProfileGrant): KnowledgeProfileGrantInput {
  return {
    profileId: grant.profileId,
    reason: grant.reason,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    reviewCycleDays: grant.reviewCycleDays,
    lastReviewedAt: grant.lastReviewedAt
  };
}

function resolveKnowledgeSetGrants(
  profileIds: string[],
  payload: JsonObject,
  existing: KnowledgeProfileGrant[],
  fallbackAt: string
): KnowledgeProfileGrant[] {
  const globalMutation = knowledgeGrantMutation(payload, "knowledge grant");
  if (globalMutation.reason === undefined && globalMutation.grantedBy !== undefined) {
    throw new Error("knowledge grant reason is required when grantedBy is provided");
  }
  if (globalMutation.reason !== undefined && globalMutation.grantedBy === undefined) {
    throw new Error("knowledge grant grantedBy is required when reason is provided");
  }
  const overrides = grantOverridesFromSetPayload(payload);
  const profileIdSet = new Set(profileIds);
  for (const override of overrides) {
    if (!profileIdSet.has(override.profileId)) {
      throw new Error(`knowledge grant override ${override.profileId} is not present in profileIds`);
    }
  }
  const existingById = new Map(existing.map((grant) => [grant.profileId, grant]));
  const overrideById = new Map(overrides.map((override) => [override.profileId, override]));
  const globalAppliesToSoleExisting = overrides.length === 0
    && profileIds.length === 1
    && existing.length === 1
    && existing[0]?.profileId === profileIds[0]
    && hasKnowledgeGrantMutation(globalMutation);
  const inputs = profileIds.map((profileId): KnowledgeProfileGrantInput => {
    const prior = existingById.get(profileId);
    const override = overrideById.get(profileId);
    const applyGlobal = prior === undefined || override !== undefined || globalAppliesToSoleExisting;
    const { profileId: _profileId, ...specificMutation } = override ?? { profileId };
    const mutation: KnowledgeGrantMutation = {
      ...(applyGlobal ? globalMutation : {}),
      ...specificMutation
    };
    const reason = mutation.reason ?? prior?.reason;
    const grantedBy = mutation.grantedBy ?? prior?.grantedBy;
    if (!reason) throw new Error(`knowledge grant ${profileId} reason is required for a new profile`);
    if (!grantedBy) throw new Error(`knowledge grant ${profileId} grantedBy is required for a new profile`);
    return {
      profileId,
      reason,
      grantedBy,
      grantedAt: mutation.grantedAt ?? prior?.grantedAt,
      expiresAt: mutation.expiresAt ?? prior?.expiresAt,
      reviewCycleDays: mutation.reviewCycleDays ?? prior?.reviewCycleDays,
      lastReviewedAt: mutation.lastReviewedAt ?? prior?.lastReviewedAt
    };
  });
  return normalizeKnowledgeGrants(profileIds, inputs, fallbackAt, existing);
}

function knowledgeGrantReviewId(
  subject: KnowledgeGrantReviewItem["subject"],
  profileId: string
): string {
  const digest = createHash("sha256")
    .update([subject.kind, subject.projectId, subject.roleId, subject.employeeId, profileId].filter(Boolean).join("\0"))
    .digest("hex")
    .slice(0, 20);
  return `grant-review-${digest}`;
}

function knowledgeGrantReviewItem(
  subject: KnowledgeGrantReviewItem["subject"],
  grant: KnowledgeProfileGrant,
  asOfMs: number,
  dueSoonMs: number
): KnowledgeGrantReviewItem {
  const schedules: Array<{ at: string; reason: string }> = [];
  if (grant.expiresAt) {
    schedules.push({
      at: grant.expiresAt,
      reason: `Authorization expiry review at ${grant.expiresAt}; expiry is reminder-only and does not revoke access.`
    });
  }
  if (grant.reviewCycleDays) {
    const baseline = Date.parse(grant.lastReviewedAt ?? grant.grantedAt);
    schedules.push({
      at: new Date(baseline + grant.reviewCycleDays * 86_400_000).toISOString(),
      reason: `Periodic review every ${grant.reviewCycleDays} days from ${grant.lastReviewedAt ?? grant.grantedAt}.`
    });
  }
  schedules.sort((left, right) => left.at.localeCompare(right.at) || left.reason.localeCompare(right.reason));
  const dueAt = schedules[0]?.at;
  const dueMs = dueAt ? Date.parse(dueAt) : undefined;
  const status: KnowledgeGrantReviewItem["status"] = dueMs === undefined
    ? "unscheduled"
    : dueMs <= asOfMs
      ? "overdue"
      : dueMs <= dueSoonMs
        ? "due-soon"
        : "current";
  return {
    id: knowledgeGrantReviewId(subject, grant.profileId),
    subject,
    grant,
    status,
    dueAt,
    reasons: schedules.length > 0
      ? schedules.map((schedule) => schedule.reason)
      : ["No expiresAt or reviewCycleDays is configured; access remains active until a human changes it."],
    reminderOnly: true
  };
}

function isInvocationTerminal(status: InvocationStatus): boolean {
  return ["completed", "blocked", "failed", "cancelled"].includes(status);
}

function isInstanceTerminal(status: WorkInstanceStatus): boolean {
  return ["completed", "blocked", "failed", "skipped", "cancelled"].includes(status);
}

function normalizeWorkflowPositions(
  positions: Record<string, { x: number; y: number }> | undefined,
  nodeIds: ReadonlySet<string>
): Record<string, { x: number; y: number }> | undefined {
  if (positions === undefined) return undefined;
  return Object.fromEntries(Object.entries(positions).filter(([nodeId, position]) => {
    if (!nodeIds.has(nodeId)) return false;
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new Error(`workflow node ${nodeId} position must contain finite x/y coordinates`);
    }
    if (Math.abs(position.x) > 100_000 || Math.abs(position.y) > 100_000) {
      throw new Error(`workflow node ${nodeId} position is outside the supported canvas bounds`);
    }
    return true;
  }));
}

export interface WorkbenchServiceOptions {
  dataRoot?: string;
  providers?: ProviderRegistry;
  architectures?: ArchitectureRegistry;
  knowledgeUrlFetcher?: Pick<RestrictedKnowledgeUrlFetcher, "fetch">;
  larkDocumentFetcher?: LarkDocumentFetcher;
}

export class WorkbenchService {
  readonly providers: ProviderRegistry;
  readonly architectures: ArchitectureRegistry;
  readonly knowledge: KnowledgeRuntime;
  readonly knowledgeUrlFetcher: Pick<RestrictedKnowledgeUrlFetcher, "fetch">;
  readonly larkDocumentFetcher: LarkDocumentFetcher;
  private readonly activityListeners = new Set<(event: ActivityEvent) => void>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly backgroundInvocations = new Map<string, Promise<void>>();
  private readonly evidenceReruns = new Map<string, Promise<void>>();
  private readonly activeMergeRuns = new Map<string, Promise<void>>();
  private readonly mergeBranchQueues = new Map<string, Promise<void>>();
  private readonly runtimeResources = new ExclusiveRuntimeResourceQueue();
  /**
   * Closes the small race between two callers that dispatch the same durable task cycle at once.
   * The persisted Invocation source remains the source of truth across daemon restarts.
   */
  private readonly idempotentWorkflowStarts = new Map<string, Promise<InvocationStartResult>>();
  private readonly humanDecisionWaiters = new Map<string, {
    promise: Promise<RuntimeHumanDecisionOutcome>;
    resolve: (outcome: RuntimeHumanDecisionOutcome) => void;
    reject: (error: Error) => void;
  }>();
  private memoryStore!: MemoryStore;
  private memoryRetriever!: MemoryRetriever;
  private memoryExtractor!: MemoryExtractor;

  private constructor(
    readonly store: WorkbenchStore,
    knowledge: KnowledgeRuntime,
    options: WorkbenchServiceOptions
  ) {
    this.providers = options.providers ?? createDefaultProviderRegistry();
    this.architectures = options.architectures ?? createDefaultArchitectureRegistry();
    this.knowledge = knowledge;
    this.knowledgeUrlFetcher = options.knowledgeUrlFetcher ?? new RestrictedKnowledgeUrlFetcher();
    this.larkDocumentFetcher = options.larkDocumentFetcher ?? new LarkCliDocumentFetcher();
  }

  static defaultDataRoot(): string {
    return process.env.MULTI_AGENT_DATA_DIR
      ? path.resolve(process.env.MULTI_AGENT_DATA_DIR)
      : path.join(os.homedir(), ".multi-agent", "workbench");
  }

  static async open(options: WorkbenchServiceOptions = {}): Promise<WorkbenchService> {
    const store = await WorkbenchStore.open(options.dataRoot ?? WorkbenchService.defaultDataRoot());
    const knowledge = await KnowledgeRuntime.open(store.dataRoot);
    const service = new WorkbenchService(store, knowledge, options);
    await service.initMemory();
    return service;
  }

  private async initMemory(): Promise<void> {
    this.memoryStore = await MemoryStore.open(this.store.dataRoot);
    this.memoryRetriever = new MemoryRetriever(this.memoryStore);
    const summarize: SummarizeFn = async ({ run }) => {
      // 优先复用内部提炼器 Employee；不存在或抛错则降级为规则摘要。
      try {
        const exists = this.listEmployees(true).some((employee) => employee.id === MEMORY_SUMMARIZER_ID);
        if (exists) {
          const result = await this.invokeEmployee(
            MEMORY_SUMMARIZER_ID,
            {
              message:
                `提炼这次运行的可复用经验（<=120字）。以下是运行证据（节点状态与产出、最终结果）：\n` +
                buildRunEvidence(run)
            },
            // 内部系统来源标记：豁免"禁人工直调 automatic 系统员工"守卫，
            // 否则小忆（memory-summarizer，systemRole=automatic）的自动提炼会被拦死。
            { kind: "workbench", caller: INTERNAL_CALLER }
          );
          const output = (result as { output?: unknown }).output;
          const content = summarizerContent(output);
          if (content) return { title: `运行 ${run.id}`, content };
        }
      } catch {
        // fall through to rule summary
      }
      const nodeCount = Object.keys(run.nodes).length;
      return { title: `运行 ${run.id}`, content: `状态=${run.status}，节点数=${nodeCount}。` };
    };
    let counter = 0;
    this.memoryExtractor = new MemoryExtractor(
      this.memoryStore,
      summarize,
      () => `mem_${Date.now().toString(36)}_${(counter += 1)}`
    );
  }

  async searchMemory(query: MemorySearchQuery): Promise<MemoryEvidence[]> {
    try {
      return await this.memoryRetriever.search(query);
    } catch {
      return [];
    }
  }

  async archiveMemory(id: string): Promise<MemoryRecord | null> {
    return this.memoryStore.archive(id);
  }

  async reindexMemory(): Promise<number> {
    return this.memoryStore.reindex();
  }

  async listMemoryScopes(): Promise<Array<{ scopeKey: string; count: number }>> {
    try {
      return await this.memoryStore.listScopes();
    } catch {
      return [];
    }
  }

  async listMemoryByScope(scopeKey: string): Promise<MemoryRecord[]> {
    try {
      return await this.memoryStore.listByScope(scopeKey);
    } catch {
      return [];
    }
  }

  private extractMemoryForRun(
    runId: string,
    scope: MemoryScope,
    provenance: { invocationId?: string; source?: { caller?: string; contextId?: string } }
  ): void {
    // 内部提炼器 Employee 自身的运行不再触发提炼，避免后台无限递归。
    if (scope.employeeId === MEMORY_SUMMARIZER_ID) return;
    // 异步旁路：绝不阻塞返回、绝不把 memory 故障抛给主链路。
    void (async () => {
      try {
        const run = (await this.getRun(runId)) as RunLike | null;
        if (!run || !run.id) return;
        await this.memoryExtractor.onRunComplete({ run, scope, provenance });
      } catch {
        // 尽力而为
      }
    })();
  }

  snapshot(): WorkbenchState {
    return this.store.snapshot();
  }

  private async reconcileInterruptedRun(runId: string, timestamp: string): Promise<void> {
    if (!/^run-[A-Za-z0-9-]+$/.test(runId)) return;
    const runDir = path.join(this.store.dataRoot, "artifacts", "runs", runId);
    let run: WorkflowRunRecord;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || (parsed as { id?: unknown }).id !== runId) return;
      run = parsed as WorkflowRunRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // A damaged historical Run must not prevent the daemon from recovering the
      // durable Invocation and Work Instance control records.
      return;
    }
    if (run.status !== "running") return;

    const interruption = "Local runtime restarted before this run completed.";
    const store = new RunStore(runDir);
    const interruptedNodeIds: string[] = [];
    const skippedNodeIds: string[] = [];
    for (const node of Object.values(run.nodes)) {
      if (node.status === "running") {
        node.status = "failed";
        node.completedAt = timestamp;
        node.error = interruption;
        node.failure = { category: "interrupted", retryable: true };
        interruptedNodeIds.push(node.nodeId);
      } else if (node.status === "pending") {
        node.status = "skipped";
        node.completedAt = timestamp;
        node.error = "Local runtime restarted before this node started.";
        node.failure = { category: "interrupted", retryable: true };
        skippedNodeIds.push(node.nodeId);
      }
    }
    run.status = "failed";
    run.error = interruption;
    run.completedAt = timestamp;
    await store.writeRun(run);
    for (const nodeId of interruptedNodeIds) {
      await store.appendEvent({
        at: timestamp,
        type: "node.failed",
        nodeId,
        detail: { error: interruption, failure: { category: "interrupted", retryable: true } }
      });
    }
    for (const nodeId of skippedNodeIds) {
      await store.appendEvent({
        at: timestamp,
        type: "node.skipped",
        nodeId,
        detail: { reason: "Local runtime restarted before this node started." }
      });
    }
    await store.appendEvent({ at: timestamp, type: "run.failed", detail: { error: interruption } });
  }

  private workflowForInterruptedRecovery(invocation: InvocationRecord): WorkbenchWorkflowDefinition {
    if (invocation.target.kind !== "workflow" || !invocation.executionSnapshot) {
      throw new Error("only pinned Workflow invocations can be recovered");
    }
    const workflow = this.getWorkflow(invocation.target.id, invocation.target.version);
    if (workflow.architecture !== "supervisor") return workflow;
    const pins = new Map(invocation.executionSnapshot.employees.map((binding) => [binding.roleId, binding]));
    const supervisor = pins.get("supervisor");
    if (!supervisor) throw new Error(`Invocation ${invocation.id} has no pinned supervisor`);
    return {
      ...workflow,
      supervisor: { employeeId: supervisor.employeeId, employeeVersion: supervisor.employeeVersion },
      ...(invocation.executionSnapshot.managementPolicy
        ? { managementPolicy: invocation.executionSnapshot.managementPolicy }
        : {}),
      members: workflow.members.map((member) => {
        const pin = pins.get(member.roleId);
        if (!pin) throw new Error(`Invocation ${invocation.id} has no pinned member ${member.roleId}`);
        return { ...member, employeeId: pin.employeeId, employeeVersion: pin.employeeVersion };
      })
    };
  }

  private async interruptedRecoveryContext(invocation: InvocationRecord): Promise<{
    workflow: WorkbenchWorkflowDefinition;
    employees: Map<string, EmployeeDefinition>;
    input: JsonObject;
    providerCwd: string;
    isolation?: WorkflowRunIsolation;
    manifestPath: string;
  } | undefined> {
    if (invocation.target.kind !== "workflow" || !invocation.executionSnapshot) return undefined;
    if (Object.values(this.snapshot().humanDecisionRequests).some((request) => (
      request.invocationId === invocation.id && request.status === "pending"
    ))) return undefined;
    if (!/^run-[A-Za-z0-9-]+$/.test(invocation.runId)) return undefined;
    const runDir = path.join(this.store.dataRoot, "artifacts", "runs", invocation.runId);
    try {
      const [runValue, inputValue] = await Promise.all([
        fs.readFile(path.join(runDir, "run.json"), "utf8"),
        fs.readFile(path.join(runDir, "input.json"), "utf8")
      ]);
      const run = JSON.parse(runValue) as WorkflowRunRecord;
      const input = JSON.parse(inputValue) as unknown;
      if (run.id !== invocation.runId || run.status !== "running") return undefined;
      if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
      const generatedRoot = path.resolve(this.store.dataRoot, "generated");
      const manifestPath = path.resolve(run.manifestPath);
      const manifestRelative = path.relative(generatedRoot, manifestPath);
      if (manifestRelative.startsWith("..") || path.isAbsolute(manifestRelative)) return undefined;
      await fs.access(manifestPath);
      const workflow = this.workflowForInterruptedRecovery(invocation);
      const employees = this.resolveWorkflowEmployees(workflow);
      let providerCwd = (await this.workflowExecutionRoot(invocation.source)) ?? path.resolve(".");
      if (run.isolation?.mode === "worktree") {
        if (!run.isolation.worktreePath) return undefined;
        const worktreePath = path.resolve(run.isolation.worktreePath);
        if (path.basename(worktreePath) !== invocation.runId || path.basename(path.dirname(worktreePath)) !== "worktrees") {
          return undefined;
        }
        const worktree = await fs.stat(worktreePath);
        if (!worktree.isDirectory()) return undefined;
        providerCwd = worktreePath;
      }
      return {
        workflow,
        employees,
        input: input as JsonObject,
        providerCwd,
        isolation: run.isolation,
        manifestPath
      };
    } catch {
      return undefined;
    }
  }

  private trackRecoveredInvocation(
    invocation: InvocationRecord,
    recovery: NonNullable<Awaited<ReturnType<WorkbenchService["interruptedRecoveryContext"]>>>
  ): void {
    const execution = this.runTrackedWorkflow(
      invocation,
      recovery.workflow,
      recovery.employees,
      recovery.input,
      recovery.providerCwd,
      {
        providerCwd: recovery.providerCwd,
        isolation: recovery.isolation,
        manifestPath: recovery.manifestPath
      }
    );
    const settled = execution.then(() => undefined, () => undefined);
    this.backgroundInvocations.set(invocation.id, settled);
    void settled.finally(() => {
      if (this.backgroundInvocations.get(invocation.id) === settled) {
        this.backgroundInvocations.delete(invocation.id);
      }
    });
  }

  async recoverInterruptedActivity(): Promise<void> {
    const state = this.snapshot();
    const hasInterrupted = Object.values(state.invocations).some((invocation) => !isInvocationTerminal(invocation.status));
    const hasPendingDecision = Object.values(state.humanDecisionRequests).some((request) => request.status === "pending");
    const hasInterruptedRunReference = Object.values(state.invocations)
      .some((invocation) => invocation.phase === "interrupted" && Boolean(invocation.runId));
    if (!hasInterrupted && !hasPendingDecision && !hasInterruptedRunReference) return;
    const timestamp = now();
    const recoveries = new Map<string, NonNullable<Awaited<ReturnType<WorkbenchService["interruptedRecoveryContext"]>>>>();
    for (const invocation of Object.values(state.invocations)) {
      if (isInvocationTerminal(invocation.status)) continue;
      const recovery = await this.interruptedRecoveryContext(invocation);
      if (recovery) recoveries.set(invocation.id, recovery);
    }
    const voidedDecisionKeys: string[] = [];
    const newlyInterruptedInvocationIds = new Set<string>();
    await this.store.mutate((next) => {
      for (const invocation of Object.values(next.invocations)) {
        if (isInvocationTerminal(invocation.status)) continue;
        newlyInterruptedInvocationIds.add(invocation.id);
        if (recoveries.has(invocation.id)) {
          invocation.status = "queued";
          invocation.phase = "recovering";
          delete invocation.completedAt;
          delete invocation.error;
          invocation.updatedAt = timestamp;
          invocation.transitions.push({
            at: timestamp,
            status: "queued",
            phase: "recovering",
            message: "Local runtime restarted; automatically resuming this Run from durable checkpoints."
          });
          if (invocation.sessionId) {
            const session = next.sessions[invocation.sessionId];
            if (session && !session.messages.some((message) => message.dedupeKey === `supervisor-recovery:${invocation.runId}`)) {
              session.messages.push({
                id: randomUUID(),
                role: "system",
                content: "本地运行服务已重启；调度器正在从已完成节点和原 Worktree 自动续跑，不会重做已通过的分片。",
                at: timestamp,
                dedupeKey: `supervisor-recovery:${invocation.runId}`,
                runId: invocation.runId
              });
              session.updatedAt = timestamp;
            }
          }
          continue;
        }
        invocation.status = "failed";
        invocation.phase = "interrupted";
        invocation.error = "Local runtime restarted before this invocation completed.";
        invocation.updatedAt = timestamp;
        invocation.completedAt = timestamp;
        invocation.transitions.push({
          at: timestamp,
          status: "failed",
          phase: "interrupted",
          message: invocation.error
        });
      }
      for (const instance of Object.values(next.workInstances)) {
        if (isInstanceTerminal(instance.status)) continue;
        if (recoveries.has(instance.invocationId)) {
          const retained = instance.status === "waiting" && instance.phase === "waiting-next-todo";
          instance.status = retained ? "waiting" : "queued";
          instance.phase = retained ? "waiting-next-todo" : "recovering";
          delete instance.completedAt;
          delete instance.error;
          delete instance.failure;
          instance.updatedAt = timestamp;
          instance.transitions.push({
            at: timestamp,
            status: instance.status,
            phase: instance.phase,
            message: retained ? "保留成员会话，等待恢复调度。" : "从持久化节点检查点恢复。"
          });
          continue;
        }
        instance.status = "failed";
        instance.phase = "interrupted";
        instance.error = "Local runtime restarted before this work instance completed.";
        instance.failure = { category: "interrupted", retryable: true };
        instance.updatedAt = timestamp;
        instance.completedAt = timestamp;
        instance.transitions.push({
          at: timestamp,
          status: "failed",
          phase: "interrupted",
          message: instance.error
        });
      }
      for (const request of Object.values(next.humanDecisionRequests)) {
        if (request.status !== "pending") continue;
        request.status = "voided";
        request.decidedBy = "runtime-recovery";
        request.comment = "Local runtime restarted before the human decision was received.";
        request.updatedAt = timestamp;
        request.decidedAt = timestamp;
        voidedDecisionKeys.push(request.idempotencyKey);
      }
    });
    for (const key of voidedDecisionKeys) {
      const waiter = this.humanDecisionWaiters.get(key);
      waiter?.reject(new Error("human decision request was voided after local runtime restart"));
      this.humanDecisionWaiters.delete(key);
    }
    const recovered = this.snapshot();
    for (const invocation of Object.values(recovered.invocations)) {
      const recovery = recoveries.get(invocation.id);
      if (recovery) {
        this.emitActivity({ type: "invocation.changed", at: timestamp, invocation });
        for (const instanceId of invocation.instanceIds) {
          const instance = recovered.workInstances[instanceId];
          if (instance) this.emitActivity({ type: "instance.changed", at: timestamp, instance });
        }
        this.trackRecoveredInvocation(invocation, recovery);
        continue;
      }
      if (invocation.phase !== "interrupted") continue;
      await this.reconcileInterruptedRun(invocation.runId, invocation.completedAt ?? timestamp);
      if (!newlyInterruptedInvocationIds.has(invocation.id)) continue;
      this.emitActivity({ type: "invocation.changed", at: timestamp, invocation });
      for (const instanceId of invocation.instanceIds) {
        const instance = recovered.workInstances[instanceId];
        if (instance) this.emitActivity({ type: "instance.changed", at: timestamp, instance });
      }
      await this.persistSupervisorSessionProgress(invocation.id);
    }
  }

  subscribeActivity(listener: (event: ActivityEvent) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  private emitActivity(event: ActivityEvent): void {
    for (const listener of this.activityListeners) {
      try {
        listener(event);
      } catch {
        // A disconnected observer must not interrupt Provider execution.
      }
    }
  }

  getActivitySnapshot(limit = 100): ActivitySnapshot {
    const state = this.snapshot();
    const ordered = Object.values(state.invocations).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const bounded = Math.max(1, Math.min(500, limit));
    const active = ordered.filter((invocation) => !isInvocationTerminal(invocation.status));
    const included = [...active, ...ordered.filter((invocation) => isInvocationTerminal(invocation.status)).slice(0, bounded)];
    const invocationIds = new Set(included.map((invocation) => invocation.id));
    return {
      invocations: included,
      instances: Object.values(state.workInstances)
        .filter((instance) => invocationIds.has(instance.invocationId))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    };
  }

  async getInvocationDetail(id: string): Promise<InvocationDetail> {
    const state = this.snapshot();
    const invocation = state.invocations[id];
    if (!invocation) throw new Error(`invocation not found: ${id}`);
    const instances = invocation.instanceIds
      .map((instanceId) => state.workInstances[instanceId])
      .filter((instance): instance is WorkInstanceRecord => Boolean(instance));
    let run: unknown;
    try {
      run = await this.getRun(invocation.runId);
    } catch (error) {
      if (!/run not found/.test(errorMessage(error))) throw error;
    }
    const humanDecisionRequests = Object.values(state.humanDecisionRequests)
      .filter((request) => request.invocationId === id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return { invocation, instances, humanDecisionRequests, run };
  }

  listHumanDecisionRequests(filter: { invocationId?: string; status?: HumanDecisionRequest["status"] } = {}): HumanDecisionRequest[] {
    return Object.values(this.snapshot().humanDecisionRequests)
      .filter((request) => !filter.invocationId || request.invocationId === filter.invocationId)
      .filter((request) => !filter.status || request.status === filter.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getHumanDecisionRequest(id: string): HumanDecisionRequest {
    const request = this.snapshot().humanDecisionRequests[id];
    if (!request) throw new Error(`human decision request not found: ${id}`);
    return request;
  }

  private humanDecisionIdempotencyKey(input: HumanDecisionRequestCreateInput): string {
    return [
      "human-decision",
      input.invocationId,
      input.runId,
      input.workflowId,
      `v${input.workflowVersion}`,
      `r${input.round}`
    ].join(":");
  }

  /** Supervisor-only creation path. The deterministic pin makes repeated creation idempotent. */
  async createHumanDecisionRequest(input: HumanDecisionRequestCreateInput): Promise<HumanDecisionRequest> {
    const summary = requireText(input.summary, "human decision summary");
    if (summary.length > 4_000) throw new Error("human decision summary must not exceed 4000 characters");
    if (!Number.isInteger(input.round) || input.round < 1) throw new Error("human decision round must be a positive integer");
    if (!Number.isInteger(input.workflowVersion) || input.workflowVersion < 1) {
      throw new Error("human decision workflowVersion must be a positive integer");
    }
    const risks = new Set(["dependency-install", "data-migration", "scope-expansion", "irreversible-other"]);
    if (!risks.has(input.riskCategory)) throw new Error(`unsupported human decision risk category: ${input.riskCategory}`);
    if (input.proposedAction.action !== "delegate" || !Array.isArray(input.proposedAction.assignments)
      || input.proposedAction.assignments.length === 0) {
      throw new Error("human decision proposedAction must be a delegate action with assignments");
    }
    if (JSON.stringify(input.proposedAction).length > 65_536) {
      throw new Error("human decision proposedAction must not exceed 65536 JSON characters");
    }
    const idempotencyKey = this.humanDecisionIdempotencyKey(input);
    const timestamp = now();
    let created = false;
    const request = await this.store.mutate((state) => {
      const existing = Object.values(state.humanDecisionRequests)
        .find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (existing) return existing;
      const invocation = state.invocations[input.invocationId];
      if (!invocation) throw new Error(`invocation not found: ${input.invocationId}`);
      const snapshot = invocation.executionSnapshot?.workflow;
      if (
        invocation.runId !== input.runId
        || snapshot?.architecture !== "supervisor"
        || snapshot.id !== input.workflowId
        || snapshot.version !== input.workflowVersion
      ) {
        throw new Error("human decision request does not match the pinned Supervisor invocation/run/workflow version");
      }
      if (isInvocationTerminal(invocation.status)) {
        throw new Error(`cannot request a human decision for terminal invocation ${invocation.id}`);
      }
      const supervisorInstance = invocation.instanceIds
        .map((instanceId) => state.workInstances[instanceId])
        .find((instance) => instance?.nodeId === input.supervisorNodeId);
      if (supervisorInstance?.kind !== "supervisor" || supervisorInstance.round !== input.round) {
        throw new Error("human decision request does not match the pinned Supervisor node/round");
      }
      const next: HumanDecisionRequest = {
        id: `human-decision-${randomUUID()}`,
        idempotencyKey,
        invocationId: invocation.id,
        runId: invocation.runId,
        workflowId: snapshot.id,
        workflowVersion: snapshot.version,
        supervisorNodeId: input.supervisorNodeId,
        round: input.round,
        riskCategory: input.riskCategory,
        summary,
        proposedAction: structuredClone(input.proposedAction),
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.humanDecisionRequests[next.id] = next;
      invocation.status = "awaiting-human-decision";
      invocation.phase = "awaiting-human-decision";
      invocation.updatedAt = timestamp;
      invocation.transitions.push({
        at: timestamp,
        status: "awaiting-human-decision",
        phase: "awaiting-human-decision",
        message: `${input.riskCategory}: ${summary}`
      });
      created = true;
      return next;
    });
    if (created) {
      const invocation = this.snapshot().invocations[input.invocationId];
      if (invocation) this.emitActivity({ type: "invocation.changed", at: timestamp, invocation });
    }
    return request;
  }

  async decideHumanDecisionRequest(
    id: string,
    input: HumanDecisionRequestDecisionInput
  ): Promise<HumanDecisionRequest> {
    if (input.decision !== "approve" && input.decision !== "reject") {
      throw new Error("human decision must be approve or reject");
    }
    const decidedBy = requireText(input.decidedBy, "human decision actor");
    if (decidedBy.length > 240) throw new Error("human decision actor must not exceed 240 characters");
    const comment = input.comment?.trim() || undefined;
    if (comment && comment.length > 4_000) throw new Error("human decision comment must not exceed 4000 characters");
    const timestamp = now();
    let invocationAfter: InvocationRecord | undefined;
    const request = await this.store.mutate((state) => {
      const target = state.humanDecisionRequests[id];
      if (!target) throw new Error(`human decision request not found: ${id}`);
      if (target.status !== "pending") {
        throw new Error(`human decision request ${id} was already decided as ${target.status}`);
      }
      const invocation = state.invocations[target.invocationId];
      if (!invocation
        || invocation.runId !== target.runId
        || invocation.executionSnapshot?.workflow.id !== target.workflowId
        || invocation.executionSnapshot.workflow.version !== target.workflowVersion) {
        throw new Error("human decision request no longer matches its pinned invocation/run/workflow version");
      }
      if (invocation.status !== "awaiting-human-decision") {
        throw new Error(`invocation ${invocation.id} is not awaiting a human decision`);
      }
      target.status = input.decision === "approve" ? "approved" : "rejected";
      target.decidedBy = decidedBy;
      target.comment = comment;
      target.updatedAt = timestamp;
      target.decidedAt = timestamp;
      invocation.status = "running";
      invocation.phase = input.decision === "approve" ? "resuming-after-human-approval" : "replanning-after-human-rejection";
      invocation.updatedAt = timestamp;
      invocation.transitions.push({
        at: timestamp,
        status: "running",
        phase: invocation.phase,
        message: comment
      });
      invocationAfter = invocation;
      return target;
    });
    if (invocationAfter) this.emitActivity({ type: "invocation.changed", at: timestamp, invocation: invocationAfter });
    const waiter = this.humanDecisionWaiters.get(request.idempotencyKey);
    waiter?.resolve({
      requestId: request.id,
      decision: request.status === "approved" ? "approved" : "rejected",
      ...(request.decidedBy ? { decidedBy: request.decidedBy } : {}),
      ...(request.comment ? { comment: request.comment } : {})
    });
    return request;
  }

  private async openHumanDecisionRequest(
    invocation: InvocationRecord,
    workflow: WorkbenchWorkflowDefinition,
    runtimeRequest: RuntimeHumanDecisionRequest
  ): Promise<{ requestId: string; decision: Promise<RuntimeHumanDecisionOutcome> }> {
    const createInput: HumanDecisionRequestCreateInput = {
      invocationId: invocation.id,
      runId: invocation.runId,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      supervisorNodeId: runtimeRequest.nodeId,
      round: runtimeRequest.round,
      riskCategory: runtimeRequest.riskCategory,
      summary: runtimeRequest.summary,
      proposedAction: runtimeRequest.proposedAction
    };
    const idempotencyKey = this.humanDecisionIdempotencyKey(createInput);
    let waiter = this.humanDecisionWaiters.get(idempotencyKey);
    if (!waiter) {
      let resolve!: (outcome: RuntimeHumanDecisionOutcome) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<RuntimeHumanDecisionOutcome>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      waiter = { promise, resolve, reject };
      this.humanDecisionWaiters.set(idempotencyKey, waiter);
    }
    let request: HumanDecisionRequest;
    try {
      request = await this.createHumanDecisionRequest(createInput);
    } catch (error) {
      if (this.humanDecisionWaiters.get(idempotencyKey) === waiter) this.humanDecisionWaiters.delete(idempotencyKey);
      throw error;
    }
    const latest = this.getHumanDecisionRequest(request.id);
    if (latest.status === "approved" || latest.status === "rejected") {
      waiter.resolve({
        requestId: latest.id,
        decision: latest.status,
        ...(latest.decidedBy ? { decidedBy: latest.decidedBy } : {}),
        ...(latest.comment ? { comment: latest.comment } : {})
      });
    } else if (latest.status === "voided") {
      waiter.reject(new Error(`human decision request ${latest.id} was voided`));
    }
    return {
      requestId: request.id,
      decision: waiter.promise.finally(() => {
        if (this.humanDecisionWaiters.get(idempotencyKey) === waiter) this.humanDecisionWaiters.delete(idempotencyKey);
      })
    };
  }

  async waitForInvocation(id: string): Promise<InvocationDetail> {
    await this.backgroundInvocations.get(id);
    return this.getInvocationDetail(id);
  }

  /** Aggregated caller-facing progress (overall status, per-step tally, leader narrative) for one invocation. */
  async getInvocationProgress(id: string): Promise<InvocationProgress> {
    return computeInvocationProgress(await this.getInvocationDetail(id));
  }

  private async workflowProgressWaitResult(
    id: string,
    cursor: string | undefined,
    heartbeat = false
  ): Promise<WorkflowProgressWaitResult> {
    const detail = await this.getInvocationDetail(id);
    const progress = computeInvocationProgress(detail);
    const nextCursor = invocationProgressCursor(progress);
    const changed = cursor === undefined || cursor !== nextCursor;
    const session = detail.invocation.sessionId
      ? this.snapshot().sessions[detail.invocation.sessionId]
      : undefined;
    const leaderSessionId = session?.supervisor?.invocationId === id ? session.id : undefined;
    return {
      invocationId: id,
      ...(leaderSessionId ? { leaderSessionId } : {}),
      nextCursor,
      changed,
      terminal: progress.terminal,
      reason: progress.terminal ? "terminal" : changed ? "changed" : heartbeat ? "heartbeat" : "changed",
      progressReport: formatInvocationProgressReport(progress, changed),
      progress
    };
  }

  /** Event-driven long poll; the listener and timer are always released on change, heartbeat, terminal, or abort. */
  async waitForWorkflowProgress(
    id: string,
    options: { cursor?: string; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<WorkflowProgressWaitResult> {
    const timeoutMs = Math.round(boundedNumber(
      options.timeoutMs,
      WORKFLOW_PROGRESS_DEFAULT_TIMEOUT_MS,
      WORKFLOW_PROGRESS_MIN_TIMEOUT_MS,
      WORKFLOW_PROGRESS_MAX_TIMEOUT_MS
    ));
    const initial = await this.workflowProgressWaitResult(id, options.cursor);
    if (initial.changed || initial.terminal) return initial;
    if (options.signal?.aborted) throw new Error("workflow progress wait aborted");

    return new Promise<WorkflowProgressWaitResult>((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => settleError(new Error("workflow progress wait aborted"));
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        unsubscribe();
        options.signal?.removeEventListener("abort", onAbort);
      };
      const settle = (result: WorkflowProgressWaitResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const settleError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const inspect = async (heartbeat = false) => {
        if (settled) return;
        try {
          const result = await this.workflowProgressWaitResult(id, options.cursor, heartbeat);
          if (heartbeat || result.changed || result.terminal) settle(result);
        } catch (error) {
          settleError(error instanceof Error ? error : new Error(String(error)));
        }
      };
      unsubscribe = this.subscribeActivity((event) => {
        const relevant = event.type === "invocation.changed"
          ? event.invocation.id === id
          : event.instance.invocationId === id;
        if (relevant) void inspect();
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      // The signal can flip between the pre-Promise guard and listener registration.
      // Re-check it here so a disconnect can never leave a long-poll listener stranded.
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      timer = setTimeout(() => void inspect(true), timeoutMs);
      // Close the race between the initial snapshot and listener registration.
      void inspect();
    });
  }

  private async persistSupervisorSessionProgress(invocationId: string): Promise<void> {
    const detail = await this.getInvocationDetail(invocationId);
    const { invocation } = detail;
    if (invocation.executionSnapshot?.workflow.architecture !== "supervisor" || !invocation.sessionId) return;
    const progress = computeInvocationProgress(detail);
    const terminal = progress.terminal;
    const completedLeaderEntry = [...progress.leaderReport.entries].reverse().find((entry) =>
      entry.action !== "unknown" && ["completed", "blocked", "failed"].includes(entry.status)
    );
    // Live MCP monitoring reports every changed snapshot and heartbeat. Keep the durable Session
    // concise: accepted task, completed leader rounds, and terminal delivery only.
    if (!terminal && !completedLeaderEntry) return;
    const dedupeKey = terminal
      ? `supervisor-delivery:${invocation.runId}`
      : `supervisor-round:${invocation.runId}:${completedLeaderEntry!.round}:${completedLeaderEntry!.action}`;
    const content = formatInvocationProgressReport(progress, true);
    const timestamp = now();
    await this.store.mutate((state) => {
      const session = state.sessions[invocation.sessionId!];
      if (!session?.supervisor || session.supervisor.invocationId !== invocationId) return;
      if (session.messages.some((message) => message.dedupeKey === dedupeKey)) return;
      session.messages.push({
        id: randomUUID(),
        role: terminal ? "employee" : "system",
        content,
        at: timestamp,
        dedupeKey,
        runId: invocation.runId,
        output: terminal && progress.outcome ? progress.outcome as unknown as JsonValue : undefined
      });
      session.updatedAt = timestamp;
    });
  }

  private async createInvocationActivity(options: {
    target: InvocationRecord["target"];
    source: InvocationSource;
    workflow: WorkbenchWorkflowDefinition;
    employees: Map<string, EmployeeDefinition>;
    input: JsonObject;
    sessionId?: string;
    createLeaderSession?: boolean;
    entrance?: EntrancePolicyExecutionSnapshot;
  }): Promise<InvocationRecord> {
    const timestamp = now();
    const runId = runIdentifier();
    const invocationId = `inv-${randomUUID()}`;
    const state = this.snapshot();
    const leaderSession: EmployeeSession | undefined = options.workflow.architecture === "supervisor" && options.createLeaderSession
      ? {
          id: randomUUID(),
          employeeId: options.workflow.supervisor.employeeId,
          employeeVersion: options.workflow.supervisor.employeeVersion,
          title: summarizeInput(options.input).slice(0, 72),
          status: "active",
          context: typeof options.input.context === "object"
            && options.input.context !== null
            && !Array.isArray(options.input.context)
            ? options.input.context as JsonObject
            : undefined,
          supervisor: {
            architecture: "supervisor",
            invocationId,
            runId,
            workflowId: options.workflow.id,
            workflowVersion: options.workflow.version
          },
          messages: [
            {
              id: randomUUID(),
              role: "user",
              content: typeof options.input.message === "string"
                ? options.input.message.trim()
                : JSON.stringify(options.input),
              at: timestamp,
              dedupeKey: `supervisor-task:${invocationId}`,
              runId
            },
            {
              id: randomUUID(),
              role: "system",
              content: `领队已接单，Supervisor Workflow ${options.workflow.id} v${options.workflow.version} 正在后台执行；后续进度与最终交付会继续写入本会话。`,
              at: timestamp,
              dedupeKey: `supervisor-start:${invocationId}`,
              runId
            }
          ],
          createdAt: timestamp,
          updatedAt: timestamp
        }
      : undefined;
    const sessionId = leaderSession?.id ?? options.sessionId;
    const graphNodes = options.workflow.architecture === "graph" ? options.workflow.nodes : [];
    const instances: WorkInstanceRecord[] = graphNodes.map((node) => {
      const employee = options.employees.get(node.employeeId);
      if (!employee) throw new Error(`employee ${node.employeeId} is not materialized`);
      const waiting = node.needs.length > 0;
      const status: WorkInstanceStatus = waiting ? "waiting" : "queued";
      const phase = waiting ? "waiting-dependencies" : "queued";
      return {
        id: `work-${randomUUID()}`,
        invocationId,
        employeeId: employee.id,
        employeeVersion: employee.version,
        workflowId: options.workflow.id,
        workflowVersion: options.workflow.version,
        nodeId: node.id,
        roleId: node.id,
        kind: "graph",
        runId,
        sessionId,
        providerId: employee.providerId,
        model: state.providers[employee.providerId]?.model,
        source: options.source,
        status,
        phase,
        createdAt: timestamp,
        updatedAt: timestamp,
        transitions: [{ at: timestamp, status, phase }]
      };
    });
    const invocation: InvocationRecord = {
      id: invocationId,
      target: options.target,
      source: options.source,
      status: "queued",
      phase: "queued",
      requestSummary: summarizeInput(options.input),
      requestText: typeof options.input.message === "string" ? options.input.message : undefined,
      taskDescription: typeof options.input.taskDescription === "string"
        ? options.input.taskDescription
        : typeof options.input.context === "object" && options.input.context !== null && !Array.isArray(options.input.context)
          && typeof (options.input.context as JsonObject).taskDescription === "string"
          ? String((options.input.context as JsonObject).taskDescription)
          : undefined,
      requestContext: typeof options.input.context === "object"
        && options.input.context !== null
        && !Array.isArray(options.input.context)
        ? options.input.context as JsonObject
        : undefined,
      runId,
      sessionId,
      instanceIds: instances.map((instance) => instance.id),
      executionSnapshot: {
        workflow: {
          id: options.workflow.id,
          version: options.workflow.version,
          architecture: options.workflow.architecture
        },
        managementPolicy: options.workflow.architecture === "supervisor"
          ? options.workflow.managementPolicy
          : undefined,
        entrance: options.entrance,
        employees: options.workflow.architecture === "graph"
          ? options.workflow.nodes.map((node) => ({
              roleId: node.id,
              employeeId: node.employeeId,
              employeeVersion: node.employeeVersion ?? options.employees.get(node.employeeId)!.version
            }))
          : [
              {
                roleId: "supervisor",
                employeeId: options.workflow.supervisor.employeeId,
                employeeVersion: options.workflow.supervisor.employeeVersion
              },
              ...options.workflow.members.map((member) => ({
                roleId: member.roleId,
                employeeId: member.employeeId,
                employeeVersion: member.employeeVersion
              }))
            ]
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      transitions: [{ at: timestamp, status: "queued", phase: "queued" }]
    };
    await this.store.mutate((next) => {
      next.invocations[invocation.id] = invocation;
      if (leaderSession) next.sessions[leaderSession.id] = leaderSession;
      for (const instance of instances) next.workInstances[instance.id] = instance;
    });
    this.emitActivity({ type: "invocation.changed", at: timestamp, invocation });
    for (const instance of instances) this.emitActivity({ type: "instance.changed", at: timestamp, instance });
    return invocation;
  }

  private async createScheduledInstance(
    invocationId: string,
    nodeId: string,
    detail: { role?: string; metadata?: JsonObject } | undefined,
    employees: Map<string, EmployeeDefinition>
  ): Promise<WorkInstanceRecord | undefined> {
    const runtimeRole = detail?.role;
    if (!runtimeRole) return undefined;
    const employee = employees.get(runtimeRole);
    if (!employee) throw new Error(`runtime role ${runtimeRole} is not bound to an Employee`);
    const timestamp = now();
    let created = false;
    let reused = false;
    const instance = await this.store.mutate((state) => {
      const invocation = state.invocations[invocationId];
      if (!invocation) throw new Error(`invocation not found: ${invocationId}`);
      const existing = invocation.instanceIds
        .map((id) => state.workInstances[id])
        .find((candidate) => candidate?.nodeId === nodeId || candidate?.nodeIds?.includes(nodeId));
      if (existing) return existing;
      const metadata = detail?.metadata ?? {};
      const memberSessionId = typeof metadata.memberSessionId === "string" ? metadata.memberSessionId : undefined;
      const retained = memberSessionId
        ? invocation.instanceIds
            .map((id) => state.workInstances[id])
            .find((candidate) => (
              candidate?.memberSessionId === memberSessionId
              && candidate.status === "waiting"
              && candidate.phase === "waiting-next-todo"
            ))
        : undefined;
      if (retained) {
        retained.nodeId = nodeId;
        retained.nodeIds = [...new Set([...(retained.nodeIds ?? []), nodeId])];
        retained.round = typeof metadata.round === "number" ? metadata.round : retained.round;
        retained.parentNodeId = typeof metadata.parentNodeId === "string" ? metadata.parentNodeId : retained.parentNodeId;
        retained.todoId = typeof metadata.todoId === "string" ? metadata.todoId : undefined;
        retained.memberSessionRetained = metadata.memberSessionRetained === true;
        retained.status = "queued";
        retained.phase = "continuing-session";
        retained.updatedAt = timestamp;
        delete retained.completedAt;
        delete retained.error;
        delete retained.failure;
        retained.transitions.push({
          at: timestamp,
          status: "queued",
          phase: "continuing-session",
          message: retained.todoId ? `继续 TODO ${retained.todoId}` : "继续成员会话"
        });
        invocation.updatedAt = timestamp;
        reused = true;
        return retained;
      }
      const next: WorkInstanceRecord = {
        id: `work-${randomUUID()}`,
        invocationId,
        employeeId: employee.id,
        employeeVersion: employee.version,
        workflowId: invocation.executionSnapshot?.workflow.id ?? invocation.target.id,
        workflowVersion: invocation.executionSnapshot?.workflow.version ?? invocation.target.version,
        nodeId,
        nodeIds: [nodeId],
        roleId: typeof metadata.roleId === "string" ? metadata.roleId : runtimeRole,
        kind: metadata.kind === "supervisor" || metadata.kind === "member" || metadata.kind === "gate"
          ? metadata.kind
          : undefined,
        round: typeof metadata.round === "number" ? metadata.round : undefined,
        parentNodeId: typeof metadata.parentNodeId === "string" ? metadata.parentNodeId : undefined,
        memberSessionId,
        memberSessionKey: typeof metadata.memberSessionKey === "string" ? metadata.memberSessionKey : undefined,
        memberSessionRetained: metadata.memberSessionRetained === true,
        todoId: typeof metadata.todoId === "string" ? metadata.todoId : undefined,
        runId: invocation.runId,
        sessionId: invocation.sessionId,
        providerId: employee.providerId,
        model: state.providers[employee.providerId]?.model,
        source: invocation.source,
        status: "queued",
        phase: "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
        transitions: [{ at: timestamp, status: "queued", phase: "queued" }]
      };
      state.workInstances[next.id] = next;
      invocation.instanceIds.push(next.id);
      invocation.updatedAt = timestamp;
      created = true;
      return next;
    });
    if (created || reused) {
      this.emitActivity({ type: "instance.changed", at: timestamp, instance });
      const invocation = this.snapshot().invocations[invocationId];
      if (invocation) this.emitActivity({ type: "invocation.changed", at: timestamp, invocation });
    }
    return instance;
  }

  private async transitionInvocation(
    id: string,
    status: InvocationStatus,
    phase: string,
    message?: string
  ): Promise<InvocationRecord> {
    const timestamp = now();
    const invocation = await this.store.mutate((state) => {
      const target = state.invocations[id];
      if (!target) throw new Error(`invocation not found: ${id}`);
      target.status = status;
      target.phase = phase;
      target.updatedAt = timestamp;
      if (status === "running") target.startedAt ??= timestamp;
      if (isInvocationTerminal(status)) target.completedAt = timestamp;
      if (status === "failed" && message !== undefined) target.error = message;
      const previous = target.transitions.at(-1);
      if (previous?.status !== status || previous.phase !== phase || (message && previous.message !== message)) {
        target.transitions.push({ at: timestamp, status, phase, message });
      }
      return target;
    });
    this.emitActivity({ type: "invocation.changed", at: timestamp, invocation });
    if (isInvocationTerminal(status)) {
      const retainedInstances = this.snapshot().invocations[id]?.instanceIds
        .map((instanceId) => this.snapshot().workInstances[instanceId])
        .filter((instance): instance is WorkInstanceRecord => (
          instance !== undefined
          && instance.status === "waiting"
          && instance.phase === "waiting-next-todo"
        )) ?? [];
      for (const instance of retainedInstances) {
        await this.transitionInstance(
          id,
          instance.nodeId,
          status === "completed" ? "completed" : "cancelled",
          "member-session-closed",
          "Run 已结束，成员会话已释放。"
        );
      }
    }
    if (isInvocationTerminal(status) && invocation.executionSnapshot?.workflow.architecture === "supervisor") {
      await this.persistSupervisorSessionProgress(id);
    }
    return invocation;
  }

  private async transitionInstance(
    invocationId: string,
    nodeId: string,
    status: WorkInstanceStatus,
    phase: string,
    message?: string,
    failure?: WorkInstanceRecord["failure"]
  ): Promise<WorkInstanceRecord | undefined> {
    const timestamp = now();
    const instance = await this.store.mutate((state) => {
      const invocation = state.invocations[invocationId];
      const target = invocation?.instanceIds
        .map((id) => state.workInstances[id])
        .find((candidate) => candidate?.nodeId === nodeId || candidate?.nodeIds?.includes(nodeId));
      if (!target) return undefined;
      target.status = status;
      target.phase = phase;
      target.updatedAt = timestamp;
      if (status === "running") target.startedAt ??= timestamp;
      if (isInstanceTerminal(status)) target.completedAt = timestamp;
      if (phase === "member-session-closed") target.memberSessionRetained = false;
      if (status === "failed") {
        target.error = message;
        target.failure = failure;
      }
      const previous = target.transitions.at(-1);
      if (previous?.status !== status || previous.phase !== phase || (message && previous.message !== message)) {
        target.transitions.push({ at: timestamp, status, phase, message });
      }
      return target;
    });
    if (instance) {
      this.emitActivity({ type: "instance.changed", at: timestamp, instance });
      if (instance.kind === "supervisor" && isInstanceTerminal(status)) {
        await this.persistSupervisorSessionProgress(invocationId);
      }
    }
    return instance;
  }

  private async observeRunEvent(
    invocationId: string,
    event: ObservedRunEvent,
    employees: Map<string, EmployeeDefinition>
  ): Promise<void> {
    if (event.type === "run.started") {
      await this.transitionInvocation(invocationId, "running", "executing");
      return;
    }
    if (event.type === "node.scheduled" && event.nodeId) {
      await this.createScheduledInstance(
        invocationId,
        event.nodeId,
        event.detail as { role?: string; metadata?: JsonObject } | undefined,
        employees
      );
      return;
    }
    if (event.nodeId) {
      if (event.type === "node.started" || event.type === "node.attempt.started") {
        await this.transitionInstance(invocationId, event.nodeId, "running", "provider");
      } else if (event.type === "node.progress") {
        const detail = event.detail as { longRunning?: boolean } | undefined;
        await this.transitionInstance(
          invocationId,
          event.nodeId,
          "running",
          detail?.longRunning ? "long-running" : "making-progress"
        );
      } else if (event.type === "node.long-running") {
        await this.transitionInstance(invocationId, event.nodeId, "running", "long-running");
      } else if (event.type === "node.provider-timeout") {
        const detail = event.detail as { kind?: string } | undefined;
        await this.transitionInstance(
          invocationId,
          event.nodeId,
          "running",
          detail?.kind === "idle-timeout" ? "idle-timeout" : "hard-timeout"
        );
      } else if (event.type === "node.attempt.failed") {
        const detail = event.detail as { error?: string } | undefined;
        await this.transitionInstance(invocationId, event.nodeId, "running", "retrying", detail?.error);
      } else if (event.type === "node.passed") {
        const eventNodeId = event.nodeId;
        const snapshot = this.snapshot();
        const retained = snapshot.invocations[invocationId]?.instanceIds
          .map((id) => snapshot.workInstances[id])
          .find((candidate) => candidate?.nodeId === eventNodeId || candidate?.nodeIds?.includes(eventNodeId))
          ?.memberSessionRetained === true;
        await this.transitionInstance(
          invocationId,
          eventNodeId,
          retained ? "waiting" : "completed",
          retained ? "waiting-next-todo" : "done",
          retained ? "当前 TODO 已完成，保留成员上下文等待下一分片。" : undefined
        );
      } else if (event.type === "node.blocked") {
        await this.transitionInstance(invocationId, event.nodeId, "blocked", "done");
      } else if (event.type === "node.failed") {
        const detail = event.detail as { error?: string; failure?: WorkInstanceRecord["failure"] } | undefined;
        await this.transitionInstance(invocationId, event.nodeId, "failed", "error", detail?.error, detail?.failure);
      } else if (event.type === "node.skipped") {
        const detail = event.detail as { reason?: string } | undefined;
        await this.transitionInstance(invocationId, event.nodeId, "skipped", "done", detail?.reason);
      }
    }
    if (event.type === "run.passed") await this.transitionInvocation(invocationId, "completed", "done");
    if (event.type === "run.blocked") await this.transitionInvocation(invocationId, "blocked", "done");
    if (event.type === "run.failed") {
      const state = this.snapshot();
      const invocation = state.invocations[invocationId];
      const detail = event.detail as { error?: string } | undefined;
      const failure = invocation?.instanceIds
        .map((id) => state.workInstances[id]?.error)
        .find((message): message is string => Boolean(message));
      await this.transitionInvocation(
        invocationId,
        "failed",
        "error",
        failure ?? detail?.error ?? "One or more work instances failed."
      );
    }
  }

  private async failInvocationActivity(invocationId: string, error: unknown): Promise<void> {
    const message = errorMessage(error);
    const snapshot = this.snapshot();
    const invocation = snapshot.invocations[invocationId];
    if (!invocation) return;
    for (const instanceId of invocation.instanceIds) {
      const instance = snapshot.workInstances[instanceId];
      if (instance && !isInstanceTerminal(instance.status)) {
        await this.transitionInstance(invocationId, instance.nodeId, "failed", "error", message);
      }
    }
    await this.transitionInvocation(invocationId, "failed", "error", message);
  }

  private async runTrackedWorkflow(
    invocation: InvocationRecord,
    workflow: WorkbenchWorkflowDefinition,
    employees: Map<string, EmployeeDefinition>,
    input: JsonObject,
    providerCwd?: string,
    recovery?: { providerCwd: string; isolation?: WorkflowRunIsolation; manifestPath: string }
  ): Promise<RunWorkflowResult> {
    await this.transitionInvocation(invocation.id, "running", recovery ? "recovering" : "materializing");
    try {
      const inputTaskTags = (Array.isArray(input.taskTags) ? input.taskTags : [])
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .map((value) => value.trim());
      const materialized = recovery
        ? {
            loaded: loadManifest(recovery.manifestPath, {
              providers: this.providers,
              architectures: this.architectures
            }),
            workflowId: workflow.id
          }
        : await this.materialize(workflow, employees);
      // Resolve execution isolation before runWorkflow can schedule or invoke a Provider. Worktree
      // isolation is fail-closed: setup failures terminate the Invocation instead of running code in
      // the caller's original checkout.
      const resolvedIsolation = recovery
        ? {
            providerCwd: recovery.providerCwd,
            isolation: recovery.isolation,
            teardownWorktree: async () => undefined
          }
        : await this.resolveRunIsolation(workflow, invocation.runId, providerCwd, materialized.loaded.projectRoot);
      const { providerCwd: effectiveProviderCwd, isolation, teardownWorktree } = resolvedIsolation;
      try {
        const runResult = await runWorkflow(materialized.loaded, materialized.workflowId, {
          runId: invocation.runId,
          input,
          resume: Boolean(recovery),
          initialArtifacts: input.conversationEvidence
            ? { "conversation/evidence.json": input.conversationEvidence }
            : undefined,
          providers: this.providers,
          architectures: this.architectures,
          artifactRoot: path.join(this.store.dataRoot, "artifacts"),
          providerCwd: effectiveProviderCwd,
          isolation,
          openHumanDecision: workflow.architecture === "supervisor"
            ? (request) => this.openHumanDecisionRequest(invocation, workflow, request)
            : undefined,
          acquireNodePermit: async (node) => {
            const employee = employees.get(node.role);
            if (!employee) throw new Error(`runtime role ${node.role} is not materialized`);
            const resources = employeeRuntimeResources(employee);
            if (resources.length === 0) return undefined;
            const release = await this.runtimeResources.acquire(resources);
            return { release, resources };
          },
          prepareNode: async (node) => {
          const employee = employees.get(node.role);
          if (!employee) throw new Error(`runtime role ${node.role} is not materialized`);
          const nodeTaskTags = (Array.isArray(node.with.taskTags) ? node.with.taskTags : [])
            .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
            .map((value) => value.trim());
          const delegatedTask = node.with.__delegatedTask;
          const request = typeof delegatedTask === "string"
            ? delegatedTask
            : typeof input.message === "string"
              ? input.message
              : JSON.stringify(input);
          const preparationState = this.snapshot();
          const taskTags = [...new Set([...inputTaskTags, ...nodeTaskTags])];
          const knowledge = await this.knowledge.prepare(preparationState, employee, {
            request,
            projectId: invocation.source.project,
            projectRoleId: invocation.source.projectRole,
            taskTags
          });
          const effectiveProfile = compileEffectiveExecutionProfile({
            state: preparationState,
            invocation,
            employee,
            nodeId: node.id,
            request,
            taskTags,
            knowledge
          });
          return {
            node: {
              ...node,
              with: { ...node.with, __knowledgeEvidence: knowledge.promptSection }
            },
            artifacts: {
              [`knowledge/${node.id}.json`]: JSON.parse(JSON.stringify(knowledge)) as JsonValue,
              [`effective-profile/${node.id}.json`]: JSON.parse(JSON.stringify(effectiveProfile)) as JsonValue
            }
          };
        },
        onEvent: (event) => this.observeRunEvent(invocation.id, event, employees)
      });
      // Supervisor runs are multi-node and finish as "passed"; attribute the
      // distilled memory to the supervisor employee + project. Graph runs
      // (including single-employee direct invocations) keep their own trigger
      // in invokeResolvedEmployee, so this does not double-fire.
      if (workflow.architecture === "supervisor") {
        this.extractMemoryForRun(
          runResult.run.id,
          {
            employeeId: workflow.supervisor.employeeId,
            employeeVersion: workflow.supervisor.employeeVersion,
            projectId: invocation.source.project
          },
          { invocationId: invocation.id, source: { caller: invocation.source.caller, contextId: invocation.source.contextId } }
        );
      }
      return runResult;
      } finally {
        // Always attempt teardown; teardownWorktree is a no-op when no worktree was created and
        // never throws, so worktree cleanup cannot mask or replace the run's own result/error.
        await teardownWorktree();
      }
    } catch (error) {
      await this.failInvocationActivity(invocation.id, error);
      throw error;
    }
  }

  /**
   * Resolves execution isolation for a run from the workflow's management policy (supervisor only).
   * When the policy requests `execution.isolation === "worktree"` and the execution root is a git
   * repository, a detached worktree is created and returned as the effective providerCwd. A non-git
   * root or worktree creation failure throws before runWorkflow can invoke a Provider. Non-worktree
   * policies retain the historical non-isolated behavior. `teardownWorktree` is always safe to call
   * and is a no-op unless a worktree was actually created.
   */
  private async resolveRunIsolation(
    workflow: WorkbenchWorkflowDefinition,
    runId: string,
    providerCwd: string | undefined,
    projectRoot: string
  ): Promise<{
    providerCwd: string | undefined;
    isolation?: WorkflowRunIsolation;
    teardownWorktree: () => Promise<void>;
  }> {
    const noTeardown = async (): Promise<void> => {};
    // Only supervisor workflows carry a management policy; graph workflows are never isolated.
    if (workflow.architecture !== "supervisor") {
      return { providerCwd, teardownWorktree: noTeardown };
    }
    const policy = this.getManagementPolicy(
      workflow.managementPolicy.id,
      workflow.managementPolicy.version
    );
    const requested = policy.execution?.isolation === "worktree";
    if (!requested) {
      return { providerCwd, isolation: { mode: "none" }, teardownWorktree: noTeardown };
    }
    const repoRoot = providerCwd ?? projectRoot;
    try {
      const worktree = await createRunWorktree(repoRoot, runId);
      if (!worktree) throw new Error(`worktree isolation requires a Git execution root: ${repoRoot}`);
      return {
        providerCwd: worktree.path,
        isolation: { mode: "worktree", worktreePath: worktree.path, baseCommit: worktree.baseCommit },
        teardownWorktree: async () => {
          // A changed worktree is the candidate delivery and must survive the Run for explicit
          // human acceptance. Inspection failure also preserves it: cleanup must never destroy
          // code merely because Git status could not be read.
          try {
            if (await worktreeHasChanges(worktree.path, worktree.baseCommit)) return;
            await removeRunWorktree(repoRoot, worktree.path);
          } catch (error) {
            console.warn(`worktree cleanup skipped for ${worktree.path}: ${errorMessage(error)}`);
          }
        }
      };
    } catch (error) {
      throw new Error(`worktree isolation setup failed before Provider execution: ${errorMessage(error)}`);
    }
  }

  private async validatedProviderCwd(providerCwd?: string): Promise<string | undefined> {
    const requested = providerCwd?.trim();
    if (!requested) return undefined;
    if (!path.isAbsolute(requested)) throw new Error("workflow execution root must be an absolute path");
    let resolved: string;
    try {
      resolved = await fs.realpath(requested);
      const stats = await fs.stat(resolved);
      if (!stats.isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new Error(`workflow execution root is unavailable: ${requested} (${errorMessage(error)})`);
    }
    return resolved;
  }

  /**
   * `source.project` is an identity, never a caller-supplied filesystem path. Resolve it through
   * the versioned Project control plane so HTTP/workbench starts receive the same trusted
   * repository root as direct project-role invocations. An explicit MCP execution root keeps
   * precedence because the daemon has already restricted it to MCP transport metadata.
   */
  private async workflowExecutionRoot(
    source: InvocationSource,
    explicitRoot?: string
  ): Promise<string | undefined> {
    if (explicitRoot?.trim()) return this.validatedProviderCwd(explicitRoot);
    const projectId = source.project?.trim();
    const project = projectId ? this.snapshot().projects[projectId]?.current : undefined;
    if (!project || project.status !== "active") return undefined;
    return this.validatedProviderCwd(project.rootPath);
  }

  private async inSessionQueue<T>(
    sessionId: string,
    onWaiting: () => void | Promise<void>,
    task: () => Promise<T>
  ): Promise<T> {
    const predecessor = this.sessionQueues.get(sessionId);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = (predecessor ?? Promise.resolve()).catch(() => undefined).then(() => gate);
    this.sessionQueues.set(sessionId, tail);
    if (predecessor) await onWaiting();
    await predecessor?.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.sessionQueues.get(sessionId) === tail) this.sessionQueues.delete(sessionId);
    }
  }

  listProviders(): Array<{ id: string; definition: WorkbenchState["providers"][string] }> {
    return Object.entries(this.snapshot().providers).map(([id, definition]) => ({ id, definition }));
  }

  async putProvider(id: string, definition: WorkbenchState["providers"][string]): Promise<void> {
    requireId(id, "provider id");
    if (isSystemManagedProviderId(id)) {
      throw new Error(`provider ${id} has system-managed runtime profiles and cannot be replaced`);
    }
    if (definition.runtimeProfiles !== undefined) {
      throw new Error("provider runtimeProfiles are reserved for system-managed Provider definitions");
    }
    const adapter = this.providers.get(definition.adapter);
    if (!adapter) throw new Error(`provider adapter not registered: ${definition.adapter}`);
    const issues = adapter.validate({ providerId: id, definition, projectRoot: this.store.dataRoot });
    if (issues.length > 0) throw new Error(issues.join("; "));
    if (definition.adapter === "command" && definition.env !== undefined) {
      const env = definition.env as Record<string, unknown>;
      const unsafe = Object.entries(env).find(([, value]) => typeof value !== "string" || !/^\$ENV:[A-Za-z_][A-Za-z0-9_]*$/.test(value));
      if (unsafe) {
        throw new Error(`workbench provider env ${unsafe[0]} must use a $ENV:VARIABLE_NAME reference; plaintext values are not persisted`);
      }
    }
    await this.store.mutate((state) => {
      state.providers[id] = definition;
    });
  }

  listSkills(includeArchived = false): WorkbenchSkillDefinition[] {
    return Object.values(this.snapshot().skills)
      .filter((skill) => includeArchived || skill.status === "active")
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  async createSkill(input: SkillCreateInput): Promise<WorkbenchSkillDefinition> {
    const id = requireId(input.id, "skill id");
    if (input.configSchema) validateSchema(input.configSchema, `skill ${id} configSchema`);
    return this.store.mutate((state) => {
      if (state.skills[id]) throw new Error(`skill already exists: ${id}`);
      const timestamp = now();
      const skill: WorkbenchSkillDefinition = {
        id,
        version: 1,
        status: "active",
        owner: "user",
        injection: "none",
        displayName: requireText(input.displayName ?? id, "skill displayName"),
        description: requireText(input.description, "skill description"),
        summary: deriveSkillSummary(input.summary, input.description),
        instructions: requireText(input.instructions, "skill instructions"),
        configSchema: input.configSchema,
        tools: [...new Set(input.tools ?? [])],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.skills[id] = skill;
      state.skillHistory[id] = [skill];
      return skill;
    });
  }

  async updateSkill(id: string, input: SkillUpdateInput): Promise<WorkbenchSkillDefinition> {
    if (input.configSchema) validateSchema(input.configSchema, `skill ${id} configSchema`);
    return this.store.mutate((state) => {
      const current = state.skills[id];
      if (!current) throw new Error(`skill not found: ${id}`);
      if (current.owner === "system") throw new Error(`system skill ${id} cannot be updated`);
      const updated: WorkbenchSkillDefinition = {
        ...current,
        displayName: input.displayName === undefined ? current.displayName : requireText(input.displayName, "skill displayName"),
        description: input.description === undefined ? current.description : requireText(input.description, "skill description"),
        summary: input.summary === undefined && input.description === undefined
          ? current.summary
          : deriveSkillSummary(input.summary, input.description ?? current.description),
        instructions: input.instructions === undefined ? current.instructions : requireText(input.instructions, "skill instructions"),
        configSchema: input.configSchema === undefined ? current.configSchema : input.configSchema,
        tools: input.tools === undefined ? current.tools : [...new Set(input.tools)],
        version: current.version + 1,
        updatedAt: now()
      };
      state.skills[id] = updated;
      (state.skillHistory[id] ??= [current]).push(updated);
      return updated;
    });
  }

  async archiveSkill(id: string): Promise<WorkbenchSkillDefinition> {
    return this.store.mutate((state) => {
      const current = state.skills[id];
      if (!current) throw new Error(`skill not found: ${id}`);
      if (current.owner === "system") throw new Error(`system skill ${id} cannot be archived`);
      if (current.status === "archived") return current;
      const archived: WorkbenchSkillDefinition = {
        ...current,
        status: "archived",
        version: current.version + 1,
        updatedAt: now()
      };
      state.skills[id] = archived;
      (state.skillHistory[id] ??= [current]).push(archived);
      return archived;
    });
  }

  async restoreSkill(id: string): Promise<WorkbenchSkillDefinition> {
    return this.store.mutate((state) => {
      const current = state.skills[id];
      if (!current) throw new Error(`skill not found: ${id}`);
      if (current.owner === "system") throw new Error(`system skill ${id} cannot be restored`);
      if (current.status === "active") return current;
      const restored: WorkbenchSkillDefinition = {
        ...current,
        status: "active",
        version: current.version + 1,
        updatedAt: now()
      };
      state.skills[id] = restored;
      (state.skillHistory[id] ??= [current]).push(restored);
      return restored;
    });
  }

  listEmployeeTemplates(includeArchived = false): EmployeeTemplateDefinition[] {
    return Object.values(this.snapshot().employeeTemplates)
      .map((record) => record.current)
      .filter((template) => includeArchived || template.status === "active")
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  getEmployeeTemplate(id: string, version?: number): EmployeeTemplateDefinition {
    const record = this.snapshot().employeeTemplates[id];
    if (!record) throw new Error(`employee template not found: ${id}`);
    return employeeTemplateVersion(record, version);
  }

  getEmployeeTemplateVersions(id: string): EmployeeTemplateDefinition[] {
    const record = this.snapshot().employeeTemplates[id];
    if (!record) throw new Error(`employee template not found: ${id}`);
    return [...record.versions].sort((left, right) => right.version - left.version);
  }

  async createEmployeeTemplate(input: EmployeeTemplateCreateInput): Promise<EmployeeTemplateDefinition> {
    const id = requireId(input.id, "employee template id");
    return this.store.mutate((state) => {
      if (state.employeeTemplates[id]) throw new Error(`employee template already exists: ${id}`);
      const timestamp = now();
      const displayName = requireText(input.displayName ?? id, "employee template displayName");
      const template: EmployeeTemplateDefinition = {
        id,
        version: 1,
        status: "active",
        displayName,
        description: requireText(input.description, "employee template description"),
        defaults: normalizeEmployeeTemplateDefaults(state, id, displayName, input.defaults, timestamp),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.employeeTemplates[id] = { current: template, versions: [template] };
      return template;
    });
  }

  async updateEmployeeTemplate(id: string, input: EmployeeTemplateUpdateInput): Promise<EmployeeTemplateDefinition> {
    return this.store.mutate((state) => {
      const record = state.employeeTemplates[id];
      if (!record) throw new Error(`employee template not found: ${id}`);
      const current = record.current;
      const timestamp = now();
      const displayName = input.displayName === undefined
        ? current.displayName
        : requireText(input.displayName, "employee template displayName");
      const updated: EmployeeTemplateDefinition = {
        ...current,
        version: current.version + 1,
        displayName,
        description: input.description === undefined
          ? current.description
          : requireText(input.description, "employee template description"),
        defaults: input.defaults === undefined
          ? current.defaults
          : normalizeEmployeeTemplateDefaults(state, id, displayName, input.defaults, timestamp),
        updatedAt: timestamp
      };
      record.current = updated;
      record.versions.push(updated);
      return updated;
    });
  }

  async archiveEmployeeTemplate(id: string): Promise<EmployeeTemplateDefinition> {
    return this.store.mutate((state) => {
      const record = state.employeeTemplates[id];
      if (!record) throw new Error(`employee template not found: ${id}`);
      if (record.current.status === "archived") return record.current;
      const archived = {
        ...record.current,
        status: "archived" as const,
        version: record.current.version + 1,
        updatedAt: now()
      };
      record.current = archived;
      record.versions.push(archived);
      return archived;
    });
  }

  async restoreEmployeeTemplate(id: string): Promise<EmployeeTemplateDefinition> {
    return this.store.mutate((state) => {
      const record = state.employeeTemplates[id];
      if (!record) throw new Error(`employee template not found: ${id}`);
      if (record.current.status === "active") return record.current;
      const restored = {
        ...record.current,
        status: "active" as const,
        version: record.current.version + 1,
        updatedAt: now()
      };
      record.current = restored;
      record.versions.push(restored);
      return restored;
    });
  }

  listKnowledgeBases(includeArchived = false): KnowledgeBaseDefinition[] {
    return Object.values(this.snapshot().knowledgeBases)
      .map((record) => record.current)
      .filter((knowledgeBase) => includeArchived || knowledgeBase.status === "active")
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  getKnowledgeBase(id: string, version?: number): KnowledgeBaseDefinition {
    const record = this.snapshot().knowledgeBases[id];
    if (!record) throw new Error(`knowledge base not found: ${id}`);
    if (version === undefined) return record.current;
    const found = record.versions.find((candidate) => candidate.version === version);
    if (!found) throw new Error(`knowledge base ${id} version ${version} not found`);
    return found;
  }

  getKnowledgeBaseVersions(id: string): KnowledgeBaseDefinition[] {
    const record = this.snapshot().knowledgeBases[id];
    if (!record) throw new Error(`knowledge base not found: ${id}`);
    return [...record.versions].sort((left, right) => right.version - left.version);
  }

  async getKnowledgeBaseDetail(id: string): Promise<KnowledgeBaseDetail> {
    const knowledgeBase = this.getKnowledgeBase(id);
    const revisions = new Map<number, Promise<KnowledgeRevision>>();
    const read = (revision: number | undefined): Promise<KnowledgeRevision> | undefined => {
      if (!revision) return undefined;
      const existing = revisions.get(revision);
      if (existing) return existing;
      const request = this.knowledge.contentStore.readRevision(id, revision);
      revisions.set(revision, request);
      return request;
    };
    const latestRevision = await read(knowledgeBase.latestRevision);
    const publishedRevision = await read(knowledgeBase.publishedRevision);
    const revisionNumbers = [...new Set(this.getKnowledgeBaseVersions(id).flatMap((version) => [
      version.latestRevision,
      version.publishedRevision
    ]).filter((revision): revision is number => Boolean(revision)))].sort((left, right) => right - left);
    const revisionHistory = await Promise.all(revisionNumbers.map(async (revisionNumber) => {
      const revision = await read(revisionNumber);
      if (!revision) throw new Error(`knowledge revision not found: ${id}@${revisionNumber}`);
      const assessment = assessKnowledgeRevision(knowledgeBase, revision);
      return {
        revision: revisionNumber,
        createdAt: revision.createdAt,
        documentCount: assessment.documentCount,
        sourceDocumentCount: assessment.sourceDocumentCount,
        manualDocumentCount: assessment.manualDocumentCount,
        assessmentStatus: assessment.status,
        warningCount: assessment.warnings.length,
        isLatest: revisionNumber === knowledgeBase.latestRevision,
        isPublished: revisionNumber === knowledgeBase.publishedRevision
      };
    }));
    return {
      knowledgeBase,
      versions: this.getKnowledgeBaseVersions(id),
      latestRevision,
      publishedRevision,
      latestAssessment: latestRevision ? assessKnowledgeRevision(knowledgeBase, latestRevision) : undefined,
      publishedAssessment: publishedRevision ? assessKnowledgeRevision(knowledgeBase, publishedRevision) : undefined,
      revisionHistory
    };
  }

  async assessKnowledgeRevision(id: string, revisionValue?: number): Promise<KnowledgeRevisionAssessment> {
    const knowledgeBase = this.getKnowledgeBase(id);
    if (revisionValue === undefined && !knowledgeBase.latestRevision) throw new Error(`knowledge base ${id} has no revision to assess`);
    const revision = validRevision(revisionValue, knowledgeBase.latestRevision, "knowledge revision");
    return assessKnowledgeRevision(knowledgeBase, await this.knowledge.contentStore.readRevision(id, revision));
  }

  async previewKnowledgeRevision(id: string, input: KnowledgeRevisionPreviewInput): Promise<KnowledgeRevisionPreview> {
    const knowledgeBase = this.getKnowledgeBase(id);
    if (knowledgeBase.status !== "active") throw new Error(`knowledge base ${id} is archived`);
    if (input.revision === undefined && !knowledgeBase.latestRevision) throw new Error(`knowledge base ${id} has no revision to preview`);
    const revision = validRevision(input.revision, knowledgeBase.latestRevision, "knowledge revision");
    await this.knowledge.contentStore.readRevision(id, revision);
    return this.knowledge.previewRevision(
      knowledgeBase,
      revision,
      requireText(input.message, "knowledge revision preview message"),
      {
        collectionIds: input.collectionIds,
        maxChunks: input.maxChunks,
        maxTokens: input.maxTokens
      }
    );
  }

  async getKnowledgeWiki(id: string, revisionValue?: number): Promise<KnowledgeWikiView> {
    const knowledgeBase = this.getKnowledgeBase(id);
    const fallback = knowledgeBase.publishedRevision ?? knowledgeBase.latestRevision;
    if (revisionValue === undefined && fallback === undefined) throw new Error(`knowledge base ${id} has no revision`);
    const revision = validRevision(revisionValue, fallback, "knowledge wiki revision");
    const content = await this.knowledge.contentStore.readRevision(id, revision);
    return buildKnowledgeWiki(
      content,
      revision === knowledgeBase.publishedRevision ? "published" : "draft"
    );
  }

  async previewKnowledgeUrl(input: KnowledgeUrlPreviewInput): Promise<KnowledgeUrlPreview> {
    const knowledgeBaseId = requireId(input.knowledgeBaseId, "knowledge URL knowledgeBaseId");
    const collectionId = requireId(input.collectionId, "knowledge URL collectionId");
    const knowledgeBase = this.getKnowledgeBase(knowledgeBaseId);
    if (knowledgeBase.status !== "active") throw new Error(`knowledge base ${knowledgeBaseId} is archived`);
    if (!knowledgeBase.collections.some((collection) => collection.id === collectionId)) {
      throw new Error(`knowledge collection not found: ${knowledgeBaseId}/${collectionId}`);
    }
    const fetched = await this.knowledgeUrlFetcher.fetch(requireText(input.url, "knowledge URL"));
    const documents = webpageToKnowledgeDocuments(fetched, collectionId);
    const normalizedDocuments = normalizeKnowledgeDocuments(
      documents,
      new Set(knowledgeBase.collections.map((collection) => collection.id)),
      fetched.fetchedAt
    );
    const currentRevision = knowledgeBase.latestRevision
      ? await this.knowledge.contentStore.readRevision(knowledgeBaseId, knowledgeBase.latestRevision)
      : undefined;
    const sourcePages = new Set(normalizedDocuments.map(documentSourcePage).filter((value): value is string => Boolean(value)));
    const candidateTargets = (currentRevision?.documents ?? []).filter((document) => {
      const sourcePage = documentSourcePage(document);
      return !sourcePage || !sourcePages.has(sourcePage);
    });
    const relationCandidates = deriveKnowledgeRelationCandidates(normalizedDocuments, candidateTargets, 5);
    const frozen = {
      version: "knowledge-url-preview-v1" as const,
      knowledgeBaseId,
      knowledgeBaseVersion: knowledgeBase.version,
      baseRevision: knowledgeBase.latestRevision,
      collectionId,
      requestedUrl: fetched.requestedUrl,
      finalUrl: fetched.finalUrl,
      redirects: fetched.redirects,
      contentType: fetched.contentType,
      byteLength: fetched.byteLength,
      contentSha256: fetched.contentSha256,
      documents,
      relationCandidates
    };
    return {
      ...frozen,
      previewHash: knowledgeChangePlanHash(jsonValue(frozen)),
      fetchedAt: fetched.fetchedAt
    };
  }

  async proposeKnowledgeUrl(input: KnowledgeUrlProposeInput): Promise<KnowledgeChangeRequest> {
    const expectedHash = requireText(input.previewHash, "knowledge URL previewHash");
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("knowledge URL previewHash must be a sha256 hex digest");
    const preview = await this.previewKnowledgeUrl(input);
    if (preview.previewHash !== expectedHash) {
      throw new Error("knowledge URL changed after preview; review the refreshed content and propose again");
    }
    const knowledgeBase = this.getKnowledgeBase(preview.knowledgeBaseId);
    if (knowledgeBase.version !== preview.knowledgeBaseVersion || knowledgeBase.latestRevision !== preview.baseRevision) {
      throw new Error("knowledge base changed after URL preview; create a fresh preview");
    }
    const selected = input.selectedRelations ?? [];
    const relationTypes = new Set<KnowledgeReferenceType>(["related", "supports", "contradicts", "depends-on", "supersedes"]);
    const selectedIds = new Set<string>();
    const candidates = new Map(preview.relationCandidates.map((candidate) => [candidate.id, candidate]));
    const selectedBySource = new Map<string, NonNullable<KnowledgeDocumentInput["references"]>>();
    for (const selection of selected) {
      const candidateId = requireText(selection.candidateId, "knowledge URL selected candidateId");
      if (selectedIds.has(candidateId)) throw new Error(`knowledge URL relation candidate ${candidateId} is selected more than once`);
      selectedIds.add(candidateId);
      const candidate = candidates.get(candidateId);
      if (!candidate) throw new Error(`knowledge URL relation candidate is not in the frozen preview: ${candidateId}`);
      if (!relationTypes.has(selection.type)) throw new Error(`knowledge URL relation type is invalid: ${String(selection.type)}`);
      const references = selectedBySource.get(candidate.sourceDocumentId) ?? [];
      references.push({
        type: selection.type,
        targetDocumentId: candidate.targetDocumentId,
        note: selection.note?.trim() || undefined
      });
      selectedBySource.set(candidate.sourceDocumentId, references);
    }

    const previous = preview.baseRevision
      ? await this.knowledge.contentStore.readRevision(preview.knowledgeBaseId, preview.baseRevision)
      : undefined;
    const incomingPages = new Set(preview.documents.map(documentSourcePage).filter((value): value is string => Boolean(value)));
    const previousBySourceRef = new Map((previous?.documents ?? []).flatMap((document) =>
      document.sourceRef ? [[document.sourceRef, document] as const] : []
    ));
    const importedIdMap = new Map(preview.documents.map((document) => [
      document.id,
      document.sourceRef ? previousBySourceRef.get(document.sourceRef)?.id ?? document.id : document.id
    ]));
    const retained = (previous?.documents ?? []).filter((document) => {
      const page = documentSourcePage(document);
      return !page || !incomingPages.has(page);
    });
    const imported = preview.documents.map((document) => {
      const prior = document.sourceRef ? previousBySourceRef.get(document.sourceRef) : undefined;
      return {
        ...document,
        id: importedIdMap.get(document.id) ?? document.id,
        parentId: document.parentId ? importedIdMap.get(document.parentId) ?? document.parentId : undefined,
        references: uniqueReferences([
          ...(prior?.references ?? []),
          ...(selectedBySource.get(document.id) ?? [])
        ]).map((reference) => ({
          ...reference,
          targetDocumentId: importedIdMap.get(reference.targetDocumentId) ?? reference.targetDocumentId
        }))
      };
    });
    const documents = [...retained, ...imported];
    normalizeKnowledgeDocuments(
      documents,
      new Set(knowledgeBase.collections.map((collection) => collection.id)),
      now()
    );
    return this.createKnowledgeChangeRequest({
      title: requireText(input.title, "knowledge URL proposal title"),
      reason: requireText(input.reason, "knowledge URL proposal reason"),
      requestedBy: input.requestedBy?.trim() || "project-knowledge-steward",
      operation: {
        type: "knowledge-revision.create",
        targetId: preview.knowledgeBaseId,
        expectedVersion: preview.knowledgeBaseVersion,
        payload: { documents: jsonValue(documents) }
      }
    });
  }

  listKnowledgeGrantReviews(
    options: { asOf?: string; dueSoonDays?: number } = {}
  ): KnowledgeGrantReviewLedger {
    const asOf = normalizedTimestamp(options.asOf ?? now(), "knowledge review asOf");
    const dueSoonDays = options.dueSoonDays ?? 30;
    if (!Number.isInteger(dueSoonDays) || dueSoonDays < 0 || dueSoonDays > 3650) {
      throw new Error("knowledge review dueSoonDays must be an integer from 0 to 3650");
    }
    const asOfMs = Date.parse(asOf);
    const dueSoonMs = asOfMs + dueSoonDays * 86_400_000;
    const state = this.snapshot();
    const items: KnowledgeGrantReviewItem[] = [];
    for (const record of Object.values(state.employees)) {
      const employee = record.current;
      const subject: KnowledgeGrantReviewItem["subject"] = { kind: "employee", employeeId: employee.id };
      for (const grant of employee.knowledgeGrants) {
        items.push(knowledgeGrantReviewItem(subject, grant, asOfMs, dueSoonMs));
      }
    }
    for (const record of Object.values(state.projectBindings)) {
      for (const role of record.current.roles) {
        const subject: KnowledgeGrantReviewItem["subject"] = {
          kind: "project-role",
          employeeId: role.employeeId,
          projectId: record.current.projectId,
          roleId: role.roleId
        };
        for (const grant of role.knowledgeGrants) {
          items.push(knowledgeGrantReviewItem(subject, grant, asOfMs, dueSoonMs));
        }
      }
    }
    const statusRank: Record<KnowledgeGrantReviewItem["status"], number> = {
      overdue: 0,
      "due-soon": 1,
      current: 2,
      unscheduled: 3
    };
    items.sort((left, right) => statusRank[left.status] - statusRank[right.status]
      || (left.dueAt ?? "").localeCompare(right.dueAt ?? "")
      || left.id.localeCompare(right.id));
    const counts: KnowledgeGrantReviewLedger["counts"] = {
      overdue: 0,
      "due-soon": 0,
      current: 0,
      unscheduled: 0
    };
    for (const item of items) counts[item.status] += 1;
    return {
      asOf,
      dueSoonDays,
      policy: "reminder-only-v1",
      counts,
      items
    };
  }

  getKnowledgeImpactSnapshot(): KnowledgeImpactSnapshot {
    return buildKnowledgeImpactSnapshot(this.snapshot());
  }

  listKnowledgeChangeRequests(): KnowledgeChangeRequest[] {
    return Object.values(this.snapshot().knowledgeChangeRequests)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getKnowledgeChangeRequest(id: string): KnowledgeChangeRequest {
    const request = this.snapshot().knowledgeChangeRequests[id];
    if (!request) throw new Error(`knowledge change request not found: ${id}`);
    return request;
  }

  private validateWorkflowChangeOperations(
    workflow: SupervisorWorkbenchWorkflowDefinition,
    operations: WorkflowChangeOperation[]
  ): void {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new Error("工作流变更提案必须至少包含一个操作");
    }
    const validatorIds = new Set(listRegisteredGateValidators().map((validator) => validator.id));
    const existingGateIds = new Set(workflow.flow.gates.map((gate) => gate.id));
    const addedGateIds = new Set<string>();
    const modes = new Set<SupervisorGate["mode"]>(["after-each-delegation", "before-completion"]);
    const fallbacks = new Set<SupervisorGate["fallback"]>(["supervisor", "block"]);
    operations.forEach((operation, index) => {
      const label = `工作流变更操作 ${index + 1}`;
      requireText(operation.rationale, `${label} rationale`);
      requireText(operation.risk, `${label} risk`);
      switch (operation.kind) {
        case "add-gate": {
          const gate = operation.gate;
          const gateId = requireText(gate.id, `${label} gate id`);
          if (existingGateIds.has(gateId) || addedGateIds.has(gateId)) {
            throw new Error(`${label}：门禁 ${gateId} 已存在于工作流 ${workflow.id} 中，不能重复添加`);
          }
          requireText(gate.requiredCapability, `${label} gate requiredCapability`);
          requireText(gate.instructions, `${label} gate instructions`);
          if (!modes.has(gate.mode)) {
            throw new Error(`${label}：门禁 ${gateId} 的 mode 非法（应为 after-each-delegation 或 before-completion），收到 ${String(gate.mode)}`);
          }
          if (typeof gate.required !== "boolean") {
            throw new Error(`${label}：门禁 ${gateId} 的 required 必须是布尔值`);
          }
          if (!fallbacks.has(gate.fallback)) {
            throw new Error(`${label}：门禁 ${gateId} 的 fallback 非法（应为 supervisor 或 block），收到 ${String(gate.fallback)}`);
          }
          if (gate.validatorId !== undefined && gate.validatorId !== "none" && !validatorIds.has(gate.validatorId)) {
            throw new Error(`${label}：门禁 ${gateId} 引用了未知的 validator ${gate.validatorId}；合法取值为 ${[...validatorIds].join("、") || "（无）"} 或 none`);
          }
          addedGateIds.add(gateId);
          break;
        }
        case "update-gate": {
          const gateId = requireText(operation.gateId, `${label} gateId`);
          if (!existingGateIds.has(gateId)) {
            throw new Error(`${label}：门禁 ${gateId} 不存在于工作流 ${workflow.id} 中，无法更新`);
          }
          const patch = operation.patch ?? {};
          if (patch.mode !== undefined && !modes.has(patch.mode)) {
            throw new Error(`${label}：门禁 ${gateId} 的 mode 非法（应为 after-each-delegation 或 before-completion），收到 ${String(patch.mode)}`);
          }
          if (patch.fallback !== undefined && !fallbacks.has(patch.fallback)) {
            throw new Error(`${label}：门禁 ${gateId} 的 fallback 非法（应为 supervisor 或 block），收到 ${String(patch.fallback)}`);
          }
          if (patch.required !== undefined && typeof patch.required !== "boolean") {
            throw new Error(`${label}：门禁 ${gateId} 的 required 必须是布尔值`);
          }
          if (patch.validatorId !== undefined && patch.validatorId !== "none" && !validatorIds.has(patch.validatorId)) {
            throw new Error(`${label}：门禁 ${gateId} 引用了未知的 validator ${patch.validatorId}；合法取值为 ${[...validatorIds].join("、") || "（无）"} 或 none`);
          }
          break;
        }
        case "remove-gate": {
          const gateId = requireText(operation.gateId, `${label} gateId`);
          if (!existingGateIds.has(gateId)) {
            throw new Error(`${label}：门禁 ${gateId} 不存在于工作流 ${workflow.id} 中，无法删除`);
          }
          break;
        }
      }
    });
  }

  async createWorkflowChangeRequest(input: WorkflowChangeCreateInput): Promise<WorkflowChangeRequest> {
    const workflowId = requireText(input.workflowId, "workflow change workflowId");
    const workflow = this.getWorkflow(workflowId);
    if (workflow.architecture !== "supervisor") {
      throw new Error(`工作流 ${workflowId} 是 ${workflow.architecture} 架构，只有 supervisor 工作流才有门禁可供变更`);
    }
    this.validateWorkflowChangeOperations(workflow, input.operations);
    const timestamp = now();
    const request: WorkflowChangeRequest = {
      id: `wc-${timestamp.replaceAll(/[:.]/g, "-").toLowerCase()}-${randomUUID().slice(0, 8)}`,
      workflowId,
      workflowVersion: workflow.version,
      status: "awaiting-approval",
      title: requireText(input.title, "workflow change title"),
      reason: requireText(input.reason, "workflow change reason"),
      requestedBy: input.requestedBy?.trim() || "gate-steward",
      operations: input.operations,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.store.mutate((state) => {
      state.workflowChangeRequests[request.id] = request;
      return request;
    });
  }

  listWorkflowChangeRequests(): WorkflowChangeRequest[] {
    return Object.values(this.snapshot().workflowChangeRequests)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getWorkflowChangeRequest(id: string): WorkflowChangeRequest {
    const request = this.snapshot().workflowChangeRequests[id];
    if (!request) throw new Error(`工作流变更请求不存在：${id}`);
    return request;
  }

  /**
   * Apply a change request's operations against the target supervisor workflow's flow.
   *
   * apply MUST go through updateWorkflow so the change is re-validated and produces a fresh
   * workflow version — it never writes state.workflows directly and never bypasses gate checks.
   * Because normalizeSupervisorFlow requires every gate to be referenced by exactly one gate stage,
   * add-gate also inserts a gate stage before delivery and remove-gate drops the matching stage.
   */
  async approveWorkflowChangeRequest(id: string, actor = "local-owner", comment?: string): Promise<WorkflowChangeRequest> {
    const request = this.getWorkflowChangeRequest(id);
    if (request.status !== "awaiting-approval") {
      throw new Error(`工作流变更请求 ${id} 当前状态为 ${request.status}，无法重复审批`);
    }
    const workflow = this.getWorkflow(request.workflowId);
    if (workflow.architecture !== "supervisor") {
      throw new Error(`工作流 ${request.workflowId} 是 ${workflow.architecture} 架构，只有 supervisor 工作流才有门禁可供变更`);
    }
    if (workflow.version !== request.workflowVersion) {
      throw new Error(
        `工作流 ${request.workflowId} 当前版本 ${workflow.version} 与提案冻结的版本 ${request.workflowVersion} 不一致（stale），请基于最新版本重新提案`
      );
    }
    // Re-validate operations against the current flow before applying.
    this.validateWorkflowChangeOperations(workflow, request.operations);

    const gates: SupervisorGate[] = workflow.flow.gates.map((gate) => ({ ...gate }));
    const stages: SupervisorFlowStage[] = workflow.flow.stages.map((stage) => ({ ...stage }));
    const deliveryIndex = stages.findIndex((stage) => stage.kind === "delivery");
    if (deliveryIndex < 0) throw new Error(`工作流 ${request.workflowId} 缺少 delivery 阶段，无法应用门禁变更`);
    for (const operation of request.operations) {
      switch (operation.kind) {
        case "add-gate": {
          gates.push({ ...operation.gate });
          const insertAt = stages.findIndex((stage) => stage.kind === "delivery");
          stages.splice(insertAt, 0, {
            id: `${operation.gate.id}-stage`,
            kind: "gate",
            title: operation.gate.instructions.slice(0, 60) || operation.gate.id,
            gateId: operation.gate.id
          });
          break;
        }
        case "update-gate": {
          const index = gates.findIndex((gate) => gate.id === operation.gateId);
          if (index < 0) throw new Error(`工作流 ${request.workflowId} 中不存在门禁 ${operation.gateId}，无法更新`);
          gates[index] = { ...gates[index]!, ...operation.patch, id: operation.gateId };
          break;
        }
        case "remove-gate": {
          const index = gates.findIndex((gate) => gate.id === operation.gateId);
          if (index < 0) throw new Error(`工作流 ${request.workflowId} 中不存在门禁 ${operation.gateId}，无法删除`);
          gates.splice(index, 1);
          for (let stageIndex = stages.length - 1; stageIndex >= 0; stageIndex -= 1) {
            const stage = stages[stageIndex]!;
            if (stage.kind === "gate" && stage.gateId === operation.gateId) stages.splice(stageIndex, 1);
          }
          break;
        }
      }
    }
    const flow: SupervisorFlowInput = { stages, gates, ...(workflow.flow.dag ? { dag: workflow.flow.dag } : {}) };
    // apply through updateWorkflow → re-validates and produces a new workflow version.
    await this.updateWorkflow(request.workflowId, { architecture: "supervisor", flow });

    return this.store.mutate((state) => {
      const stored = state.workflowChangeRequests[id];
      if (!stored) throw new Error(`工作流变更请求不存在：${id}`);
      const timestamp = now();
      stored.status = "applied";
      stored.review = { actor: requireText(actor, "工作流变更审批人"), at: timestamp, comment: comment?.trim() || undefined };
      stored.updatedAt = timestamp;
      return stored;
    });
  }

  async rejectWorkflowChangeRequest(id: string, actor = "local-owner", comment?: string): Promise<WorkflowChangeRequest> {
    return this.store.mutate((state) => {
      const request = state.workflowChangeRequests[id];
      if (!request) throw new Error(`工作流变更请求不存在：${id}`);
      if (request.status !== "awaiting-approval") {
        throw new Error(`工作流变更请求 ${id} 当前状态为 ${request.status}，无法重复审批`);
      }
      const timestamp = now();
      request.status = "rejected";
      request.review = { actor: requireText(actor, "工作流变更审批人"), at: timestamp, comment: comment?.trim() || undefined };
      request.updatedAt = timestamp;
      return request;
    });
  }

  private knowledgeChangeImpactSummary(
    operation: KnowledgeChangeOperation,
    impact: KnowledgeImpactSnapshot
  ): KnowledgeChangeImpactSummary {
    const knowledgeBaseIds = new Set<string>();
    const profileIds = new Set<string>();
    const employeeIds = new Set<string>();
    const projectRoles = new Set<string>();
    const addBase = (knowledgeBaseId: string) => {
      knowledgeBaseIds.add(knowledgeBaseId);
      const found = impact.knowledgeBases.find((candidate) => candidate.knowledgeBaseId === knowledgeBaseId);
      for (const profile of found?.profileMatches ?? []) profileIds.add(profile.profileId);
      for (const employee of found?.employees ?? []) employeeIds.add(employee.employeeId);
      for (const role of found?.projectRoles ?? []) projectRoles.add(`${role.projectId}/${role.roleId}`);
    };
    const addProfile = (profileId: string) => {
      profileIds.add(profileId);
      const found = impact.profiles.find((candidate) => candidate.profileId === profileId);
      for (const base of found?.knowledgeBases ?? []) knowledgeBaseIds.add(base.knowledgeBaseId);
      for (const employee of found?.employees ?? []) employeeIds.add(employee.employeeId);
      for (const role of found?.projectRoles ?? []) projectRoles.add(`${role.projectId}/${role.roleId}`);
    };
    if (operation.type.startsWith("knowledge-base.") || operation.type.startsWith("knowledge-revision.")) {
      if (operation.targetId) addBase(operation.targetId);
    } else if (operation.type.startsWith("knowledge-profile.")) {
      if (operation.targetId) addProfile(operation.targetId);
    } else if (operation.type === "employee-profiles.set") {
      if (operation.targetId) employeeIds.add(operation.targetId);
      for (const profileId of stringArray(jsonPayload(operation).profileIds, "employee profileIds")) addProfile(profileId);
    } else if (operation.type === "project-role-profiles.set") {
      if (operation.projectId && operation.roleId) projectRoles.add(`${operation.projectId}/${operation.roleId}`);
      for (const profileId of stringArray(jsonPayload(operation).profileIds, "project role profileIds")) addProfile(profileId);
    }
    return {
      knowledgeBaseIds: [...knowledgeBaseIds].sort(),
      profileIds: [...profileIds].sort(),
      employeeIds: [...employeeIds].sort(),
      projectRoles: [...projectRoles].sort()
    };
  }

  private normalizeKnowledgeChangeOperation(input: KnowledgeChangeOperation): KnowledgeChangeOperation {
    if (!KNOWLEDGE_CHANGE_TYPES.has(input.type)) throw new Error(`unsupported knowledge change operation ${String(input.type)}`);
    const payload = jsonValue(jsonPayload(input)) as JsonObject;
    const targetRequired = !["project-role-profiles.set"].includes(input.type);
    const targetId = targetRequired ? requireId(input.targetId ?? String(payload.id ?? ""), "knowledge change target id") : undefined;
    if (input.type === "knowledge-base.create" || input.type === "knowledge-profile.create") {
      const payloadId = typeof payload.id === "string" ? requireId(payload.id, "knowledge change payload id") : undefined;
      if (payloadId && payloadId !== targetId) {
        throw new Error(`knowledge change target id ${targetId} does not match payload id ${payloadId}`);
      }
      payload.id = targetId!;
    }
    const state = this.snapshot();
    let currentVersion: number | undefined;
    let existingGrants: KnowledgeProfileGrant[] | undefined;
    if (input.type.startsWith("knowledge-base.") || input.type.startsWith("knowledge-revision.")) {
      currentVersion = input.type === "knowledge-base.create" ? undefined : state.knowledgeBases[targetId!]?.current.version;
      if (input.type !== "knowledge-base.create" && currentVersion === undefined) throw new Error(`knowledge base not found: ${targetId}`);
    } else if (input.type.startsWith("knowledge-profile.")) {
      currentVersion = input.type === "knowledge-profile.create" ? undefined : state.knowledgeProfiles[targetId!]?.current.version;
      if (input.type !== "knowledge-profile.create" && currentVersion === undefined) throw new Error(`knowledge profile not found: ${targetId}`);
    } else if (input.type === "employee-profiles.set") {
      const employee = state.employees[targetId!]?.current;
      if (!employee) throw new Error(`employee not found: ${targetId}`);
      currentVersion = employee.version;
      existingGrants = employee.knowledgeGrants;
    } else {
      const projectId = requireId(input.projectId ?? "", "knowledge change project id");
      const roleId = requireId(input.roleId ?? "", "knowledge change project role id");
      const binding = state.projectBindings[projectId]?.current;
      if (!binding) throw new Error(`project binding not found: ${projectId}`);
      const role = binding.roles.find((candidate) => candidate.roleId === roleId);
      if (!role) throw new Error(`project role is not assigned: ${projectId}/${roleId}`);
      currentVersion = binding.version;
      existingGrants = role.knowledgeGrants;
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
      throw new Error(`knowledge change expected v${input.expectedVersion}, current version is ${currentVersion ?? "uncreated"}`);
    }
    if (input.type === "employee-profiles.set" || input.type === "project-role-profiles.set") {
      const profileIds = stringArray(payload.profileIds, "knowledge grant profileIds");
      const grants = resolveKnowledgeSetGrants(profileIds, payload, existingGrants ?? [], now());
      for (const key of ["reason", "grantedBy", "grantedAt", "expiresAt", "reviewCycleDays", "lastReviewedAt"]) {
        delete payload[key];
      }
      payload.grantOverrides = jsonValue(grants.map(knowledgeGrantInput));
    }
    return {
      type: input.type,
      targetId,
      projectId: input.projectId,
      roleId: input.roleId,
      expectedVersion: currentVersion,
      payload
    };
  }

  private async planKnowledgeChange(input: KnowledgeChangeOperation): Promise<{
    operation: KnowledgeChangeOperation;
    preview: KnowledgeChangePreview;
    planHash: string;
  }> {
    const operation = this.normalizeKnowledgeChangeOperation(input);
    const payload = jsonPayload(operation);
    const state = this.snapshot();
    const hypothetical = structuredClone(state);
    let summary = "";
    let before: JsonValue | undefined;
    let proposed: JsonValue | undefined;
    let assessment: KnowledgeRevisionAssessment | undefined;
    const warnings: string[] = [];
    const targetId = operation.targetId;

    switch (operation.type) {
      case "knowledge-base.create": {
        if (hypothetical.knowledgeBases[targetId!]) throw new Error(`knowledge base already exists: ${targetId}`);
        const normalized = this.normalizeKnowledgeBase(payload as unknown as KnowledgeBaseCreateInput);
        const documents = normalizeKnowledgeDocuments(
          (payload.documents ?? []) as unknown as KnowledgeDocumentInput[],
          new Set(normalized.collections.map((collection) => collection.id)),
          now()
        );
        hypothetical.knowledgeBases[normalized.id] = { current: normalized, versions: [normalized] };
        summary = `建立知识库 ${normalized.displayName}${documents.length ? `，并生成包含 ${documents.length} 份文档的未发布草稿` : "，等待补充首份草稿"}`;
        proposed = jsonValue({ ...normalized, draftDocumentCount: documents.length });
        break;
      }
      case "knowledge-base.update": {
        const current = this.getKnowledgeBase(targetId!);
        const normalized = this.normalizeKnowledgeBase({
          id: targetId!,
          displayName: typeof payload.displayName === "string" ? payload.displayName : current.displayName,
          description: typeof payload.description === "string" ? payload.description : current.description,
          domain: typeof payload.domain === "string" ? payload.domain : current.domain,
          product: payload.product === undefined ? current.product : payload.product as string,
          projectId: payload.projectId === undefined ? current.projectId : payload.projectId as string,
          classification: payload.classification === undefined ? current.classification : payload.classification as KnowledgeBaseCreateInput["classification"],
          collections: payload.collections === undefined ? current.collections : payload.collections as unknown as KnowledgeBaseCreateInput["collections"],
          sources: payload.sources === undefined ? current.sources : payload.sources as unknown as KnowledgeBaseCreateInput["sources"]
        }, current);
        if (current.latestRevision) {
          const revision = await this.knowledge.contentStore.readRevision(targetId!, current.latestRevision);
          const allowed = new Set(normalized.collections.map((collection) => collection.id));
          const orphan = revision.documents.find((document) => !allowed.has(document.collectionId));
          if (orphan) throw new Error(`collection ${orphan.collectionId} is still used by knowledge document ${orphan.id}`);
        }
        hypothetical.knowledgeBases[targetId!]!.current = normalized;
        hypothetical.knowledgeBases[targetId!]!.versions.push(normalized);
        summary = `修订知识库 ${current.displayName} 的目录、来源或分类配置`;
        before = jsonValue(current);
        proposed = jsonValue(normalized);
        break;
      }
      case "knowledge-base.sync": {
        const current = this.getKnowledgeBase(targetId!);
        if (current.status !== "active") throw new Error(`knowledge base ${targetId} is archived`);
        if (current.sources.length === 0) throw new Error(`knowledge base ${targetId} has no configured sources`);
        summary = `同步 ${current.displayName} 的 ${current.sources.length} 个来源并生成未发布 Revision`;
        before = jsonValue(current);
        warnings.push("同步只生成草稿，不会自动改变员工使用的发布版本。");
        break;
      }
      case "knowledge-base.archive":
      case "knowledge-base.restore": {
        const current = this.getKnowledgeBase(targetId!);
        const status = operation.type.endsWith("archive") ? "archived" as const : "active" as const;
        const normalized = { ...current, status, version: current.version + 1, updatedAt: now() };
        hypothetical.knowledgeBases[targetId!]!.current = normalized;
        hypothetical.knowledgeBases[targetId!]!.versions.push(normalized);
        summary = `${status === "archived" ? "归档" : "恢复"}知识库 ${current.displayName}`;
        before = jsonValue(current);
        proposed = jsonValue(normalized);
        break;
      }
      case "knowledge-revision.create": {
        const current = this.getKnowledgeBase(targetId!);
        if (current.status !== "active") throw new Error(`knowledge base ${targetId} is archived`);
        const documents = normalizeKnowledgeDocuments(
          (payload.documents ?? []) as unknown as KnowledgeDocumentInput[],
          new Set(current.collections.map((collection) => collection.id)),
          now()
        );
        summary = `为 ${current.displayName} 建立包含 ${documents.length} 份文档的未发布 Revision`;
        proposed = jsonValue({ revision: (current.latestRevision ?? 0) + 1, documentCount: documents.length });
        break;
      }
      case "knowledge-revision.publish": {
        const current = this.getKnowledgeBase(targetId!);
        const revision = validRevision(typeof payload.revision === "number" ? payload.revision : undefined, current.latestRevision, "knowledge revision");
        assessment = assessKnowledgeRevision(current, await this.knowledge.contentStore.readRevision(targetId!, revision));
        if (assessment.status === "blocked") throw new Error(`knowledge revision ${targetId}@${revision} is blocked`);
        warnings.push(...assessment.warnings.map((warning) => warning.message));
        summary = `${revision < (current.publishedRevision ?? 0) ? "回滚" : "发布"} ${current.displayName} Revision R${revision}`;
        before = jsonValue({ publishedRevision: current.publishedRevision });
        proposed = jsonValue({ publishedRevision: revision });
        hypothetical.knowledgeBases[targetId!]!.current = { ...current, publishedRevision: revision };
        break;
      }
      case "knowledge-profile.create": {
        if (hypothetical.knowledgeProfiles[targetId!]) throw new Error(`knowledge profile already exists: ${targetId}`);
        const normalized = this.normalizeKnowledgeProfile(payload as unknown as KnowledgeProfileCreateInput);
        hypothetical.knowledgeProfiles[normalized.id] = { current: normalized, versions: [normalized] };
        summary = `建立知识 Profile ${normalized.displayName}`;
        proposed = jsonValue(normalized);
        break;
      }
      case "knowledge-profile.update": {
        const current = this.getKnowledgeProfile(targetId!);
        const normalized = this.normalizeKnowledgeProfile({
          id: targetId!,
          displayName: typeof payload.displayName === "string" ? payload.displayName : current.displayName,
          description: typeof payload.description === "string" ? payload.description : current.description,
          rules: payload.rules === undefined ? current.rules : payload.rules as unknown as KnowledgeProfileCreateInput["rules"]
        }, current);
        hypothetical.knowledgeProfiles[targetId!]!.current = normalized;
        hypothetical.knowledgeProfiles[targetId!]!.versions.push(normalized);
        summary = `修订知识 Profile ${current.displayName}`;
        before = jsonValue(current);
        proposed = jsonValue(normalized);
        break;
      }
      case "knowledge-profile.archive":
      case "knowledge-profile.restore": {
        const current = this.getKnowledgeProfile(targetId!);
        const status = operation.type.endsWith("archive") ? "archived" as const : "active" as const;
        const normalized = { ...current, status, version: current.version + 1, updatedAt: now() };
        hypothetical.knowledgeProfiles[targetId!]!.current = normalized;
        hypothetical.knowledgeProfiles[targetId!]!.versions.push(normalized);
        summary = `${status === "archived" ? "归档" : "恢复"}知识 Profile ${current.displayName}`;
        before = jsonValue(current);
        proposed = jsonValue(normalized);
        break;
      }
      case "employee-profiles.set": {
        const employee = this.getEmployee(targetId!);
        const profileIds = validateKnowledgeProfileIds(state, stringArray(payload.profileIds, "employee profileIds"), `employee ${targetId} knowledge profile`);
        const grants = resolveKnowledgeSetGrants(profileIds, payload, employee.knowledgeGrants, now());
        const updated = { ...employee, knowledgeProfileIds: profileIds, knowledgeGrants: grants, version: employee.version + 1, updatedAt: now() };
        hypothetical.employees[targetId!]!.current = updated;
        hypothetical.employees[targetId!]!.versions.push(updated);
        summary = `把员工 ${employee.identity.displayName} 的知识 Profile 调整为 ${profileIds.join("、") || "空"}`;
        before = jsonValue({ knowledgeProfileIds: employee.knowledgeProfileIds, knowledgeGrants: employee.knowledgeGrants });
        proposed = jsonValue({ knowledgeProfileIds: profileIds, knowledgeGrants: grants });
        break;
      }
      case "project-role-profiles.set": {
        const projectId = operation.projectId!;
        const roleId = operation.roleId!;
        const project = this.getProject(projectId);
        const role = project.roles.find((candidate) => candidate.id === roleId);
        if (!role) throw new Error(`project role not found: ${projectId}/${roleId}`);
        const profileIds = validateKnowledgeProfileIds(state, stringArray(payload.profileIds, "project role profileIds"), `project role ${roleId} knowledge profile`);
        const unexpected = profileIds.filter((profileId) => !role.knowledgeProfileIds.includes(profileId));
        if (unexpected.length > 0) throw new Error(`project role ${roleId} does not declare knowledge profiles: ${unexpected.join(", ")}`);
        const binding = hypothetical.projectBindings[projectId]!.current;
        const roleBinding = binding.roles.find((candidate) => candidate.roleId === roleId)!;
        const previous = [...roleBinding.knowledgeProfileIds];
        const previousGrants = [...roleBinding.knowledgeGrants];
        const grants = resolveKnowledgeSetGrants(profileIds, payload, roleBinding.knowledgeGrants, now());
        roleBinding.knowledgeProfileIds = profileIds;
        roleBinding.knowledgeGrants = grants;
        binding.version += 1;
        summary = `调整项目角色 ${project.name}/${role.displayName} 的知识 Profile`;
        before = jsonValue({ knowledgeProfileIds: previous, knowledgeGrants: previousGrants });
        proposed = jsonValue({ knowledgeProfileIds: profileIds, knowledgeGrants: grants });
        break;
      }
    }

    const impact = this.knowledgeChangeImpactSummary(operation, buildKnowledgeImpactSnapshot(hypothetical, "preview"));
    const preview: KnowledgeChangePreview = {
      summary,
      beforeVersion: operation.expectedVersion,
      expectedVersion: operation.expectedVersion,
      warnings,
      impact,
      assessment,
      before,
      proposed
    };
    const planHash = knowledgeChangePlanHash(jsonValue({
      operation,
      summary,
      beforeVersion: preview.beforeVersion,
      warnings,
      impact,
      assessment: assessment ? {
        revision: assessment.revision,
        status: assessment.status,
        warnings: assessment.warnings.map((warning) => warning.code)
      } : undefined
    }));
    return { operation, preview, planHash };
  }

  async createKnowledgeChangeRequest(input: KnowledgeChangeCreateInput): Promise<KnowledgeChangeRequest> {
    const plan = await this.planKnowledgeChange(input.operation);
    const timestamp = now();
    const request: KnowledgeChangeRequest = {
      id: `kc-${timestamp.replaceAll(/[:.]/g, "-").toLowerCase()}-${randomUUID().slice(0, 8)}`,
      status: "awaiting-approval",
      title: requireText(input.title, "knowledge change title"),
      reason: requireText(input.reason, "knowledge change reason"),
      requestedBy: input.requestedBy?.trim() || "knowledge-steward",
      operation: plan.operation,
      risk: knowledgeChangeRisk(plan.operation.type),
      preview: plan.preview,
      planHash: plan.planHash,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.store.mutate((state) => {
      state.knowledgeChangeRequests[request.id] = request;
      return request;
    });
  }

  private async applyKnowledgeChangeOperation(operation: KnowledgeChangeOperation): Promise<JsonValue> {
    const payload = jsonPayload(operation);
    switch (operation.type) {
      case "knowledge-base.create":
        return jsonValue(await this.createKnowledgeBase({ ...(payload as unknown as KnowledgeBaseCreateInput), publish: false }));
      case "knowledge-base.update":
        return jsonValue(await this.updateKnowledgeBase(operation.targetId!, payload as unknown as KnowledgeBaseUpdateInput));
      case "knowledge-base.sync":
        return jsonValue(await this.syncKnowledgeBase(operation.targetId!));
      case "knowledge-base.archive":
        return jsonValue(await this.archiveKnowledgeBase(operation.targetId!));
      case "knowledge-base.restore":
        return jsonValue(await this.restoreKnowledgeBase(operation.targetId!));
      case "knowledge-revision.create":
        return jsonValue(await this.createKnowledgeRevision(operation.targetId!, payload as unknown as KnowledgeRevisionCreateInput));
      case "knowledge-revision.publish":
        return jsonValue(await this.publishKnowledgeRevision(operation.targetId!, typeof payload.revision === "number" ? payload.revision : undefined));
      case "knowledge-profile.create":
        return jsonValue(await this.createKnowledgeProfile(payload as unknown as KnowledgeProfileCreateInput));
      case "knowledge-profile.update":
        return jsonValue(await this.updateKnowledgeProfile(operation.targetId!, payload as unknown as KnowledgeProfileUpdateInput));
      case "knowledge-profile.archive":
        return jsonValue(await this.archiveKnowledgeProfile(operation.targetId!));
      case "knowledge-profile.restore":
        return jsonValue(await this.restoreKnowledgeProfile(operation.targetId!));
      case "employee-profiles.set":
        {
          const profileIds = stringArray(payload.profileIds, "employee profileIds");
          const employee = this.getEmployee(operation.targetId!);
          const grants = resolveKnowledgeSetGrants(profileIds, payload, employee.knowledgeGrants, now());
          return jsonValue(await this.updateEmployee(operation.targetId!, {
            knowledgeProfileIds: profileIds,
            knowledgeGrants: grants.map(knowledgeGrantInput)
          }));
        }
      case "project-role-profiles.set": {
        const projectId = operation.projectId!;
        const roleId = operation.roleId!;
        const binding = this.getProjectBinding(projectId);
        const profileIds = stringArray(payload.profileIds, "project role profileIds");
        const currentRole = binding.roles.find((role) => role.roleId === roleId);
        if (!currentRole) throw new Error(`project role is not assigned: ${projectId}/${roleId}`);
        const knowledgeGrants = resolveKnowledgeSetGrants(profileIds, payload, currentRole.knowledgeGrants, now())
          .map(knowledgeGrantInput);
        return jsonValue(await this.saveProjectBinding(projectId, {
          roles: binding.roles.map((role) => ({
            roleId: role.roleId,
            employeeId: role.employeeId,
            employeeVersion: role.employeeVersion,
            skills: role.skills,
            knowledgeProfileIds: role.roleId === roleId ? profileIds : role.knowledgeProfileIds,
            knowledgeGrants: role.roleId === roleId ? knowledgeGrants : undefined,
            updatePolicy: role.updatePolicy
          }))
        }));
      }
    }
  }

  async approveKnowledgeChangeRequest(id: string, actor = "local-owner", comment?: string): Promise<KnowledgeChangeRequest> {
    const current = this.getKnowledgeChangeRequest(id);
    if (current.status !== "awaiting-approval") throw new Error(`knowledge change ${id} is ${current.status}`);
    let plan: Awaited<ReturnType<WorkbenchService["planKnowledgeChange"]>>;
    try {
      plan = await this.planKnowledgeChange(current.operation);
    } catch (error) {
      await this.store.mutate((state) => {
        const request = state.knowledgeChangeRequests[id];
        if (!request) return;
        request.status = "needs-reapproval";
        request.error = errorMessage(error);
        request.updatedAt = now();
      });
      throw error;
    }
    if (plan.planHash !== current.planHash) {
      await this.store.mutate((state) => {
        const request = state.knowledgeChangeRequests[id];
        if (!request) return;
        request.status = "needs-reapproval";
        request.error = "knowledge change impact or validation result changed; create a fresh proposal";
        request.updatedAt = now();
      });
      throw new Error(`knowledge change ${id} changed after review and needs reapproval`);
    }
    const approvedAt = now();
    await this.store.mutate((state) => {
      const request = state.knowledgeChangeRequests[id];
      if (!request || request.status !== "awaiting-approval") throw new Error(`knowledge change ${id} is no longer awaiting approval`);
      request.status = "applying";
      request.approval = {
        decision: "approved",
        actor: requireText(actor, "knowledge change approver"),
        at: approvedAt,
        comment: comment?.trim() || undefined,
        planHash: request.planHash
      };
      request.updatedAt = approvedAt;
    });
    try {
      const result = await this.applyKnowledgeChangeOperation(plan.operation);
      return this.store.mutate((state) => {
        const request = state.knowledgeChangeRequests[id];
        if (!request) throw new Error(`knowledge change request not found: ${id}`);
        request.status = "applied";
        request.result = result;
        request.error = undefined;
        request.appliedAt = now();
        request.updatedAt = request.appliedAt;
        return request;
      });
    } catch (error) {
      await this.store.mutate((state) => {
        const request = state.knowledgeChangeRequests[id];
        if (!request) return;
        request.status = "failed";
        request.error = errorMessage(error);
        request.updatedAt = now();
      });
      throw error;
    }
  }

  async rejectKnowledgeChangeRequest(id: string, actor = "local-owner", comment?: string): Promise<KnowledgeChangeRequest> {
    return this.store.mutate((state) => {
      const request = state.knowledgeChangeRequests[id];
      if (!request) throw new Error(`knowledge change request not found: ${id}`);
      if (request.status !== "awaiting-approval") throw new Error(`knowledge change ${id} is ${request.status}`);
      const timestamp = now();
      request.status = "rejected";
      request.approval = {
        decision: "rejected",
        actor: requireText(actor, "knowledge change reviewer"),
        at: timestamp,
        comment: comment?.trim() || undefined,
        planHash: request.planHash
      };
      request.updatedAt = timestamp;
      return request;
    });
  }

  async cancelKnowledgeChangeRequest(
    id: string,
    actor = "local-owner",
    comment?: string
  ): Promise<KnowledgeChangeRequest> {
    return this.store.mutate((state) => {
      const request = state.knowledgeChangeRequests[id];
      if (!request) throw new Error(`knowledge change request not found: ${id}`);
      if (request.status !== "awaiting-approval" && request.status !== "needs-reapproval") {
        throw new Error(`knowledge change ${id} cannot be cancelled from ${request.status}`);
      }
      const timestamp = now();
      request.status = "cancelled";
      request.cancellation = {
        actor: requireText(actor, "knowledge change cancellation actor"),
        at: timestamp,
        comment: comment?.trim() || undefined
      };
      request.updatedAt = timestamp;
      return request;
    });
  }

  listConfigurationProposals(employeeId?: string): ConfigurationProposal[] {
    return Object.values(this.snapshot().configurationProposals)
      .filter((proposal) => !employeeId || proposal.employeeId === employeeId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getConfigurationProposal(id: string): ConfigurationProposal {
    const proposal = this.snapshot().configurationProposals[id];
    if (!proposal) throw new Error(`configuration proposal not found: ${id}`);
    return proposal;
  }

  getConfigurationControlSnapshot(sourceRunId: string): {
    employee: Omit<EmployeeDefinition, "knowledgeProfileIds" | "knowledgeGrants">;
    providers: Array<{ id: string; adapter: string; model?: string; runtimeProfiles?: string[] }>;
    skills: Array<Pick<WorkbenchSkillDefinition, "id" | "version" | "status" | "displayName" | "description" | "tools" | "configSchema">>;
    proposals: ConfigurationProposal[];
  } {
    const state = this.snapshot();
    const access = configurationControlAccess(state, sourceRunId, "configuration_control_snapshot");
    const target = state.employees[access.targetEmployeeId]!.current;
    const { knowledgeProfileIds: _profileIds, knowledgeGrants: _grants, ...employee } = target;
    return {
      employee,
      providers: Object.entries(state.providers).map(([id, definition]) => ({
        id,
        adapter: definition.adapter,
        ...(typeof definition.model === "string" ? { model: definition.model } : {}),
        ...(definition.runtimeProfiles?.length ? { runtimeProfiles: definition.runtimeProfiles } : {})
      })),
      skills: Object.values(state.skills).map((skill) => ({
        id: skill.id,
        version: skill.version,
        status: skill.status,
        displayName: skill.displayName,
        description: skill.description,
        tools: skill.tools,
        ...(skill.configSchema ? { configSchema: skill.configSchema } : {})
      })),
      proposals: Object.values(state.configurationProposals)
        .filter((proposal) => proposal.employeeId === access.targetEmployeeId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    };
  }

  listConfigurationProposalsForControl(sourceRunId: string): ConfigurationProposal[] {
    const state = this.snapshot();
    const access = configurationControlAccess(state, sourceRunId, "configuration_proposal_list");
    return Object.values(state.configurationProposals)
      .filter((proposal) => proposal.employeeId === access.targetEmployeeId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getConfigurationProposalForControl(sourceRunId: string, id: string): ConfigurationProposal {
    const state = this.snapshot();
    const access = configurationControlAccess(state, sourceRunId, "configuration_proposal_get");
    const proposal = state.configurationProposals[id];
    if (!proposal || proposal.employeeId !== access.targetEmployeeId) {
      throw new Error(`configuration proposal not found for the active target: ${id}`);
    }
    return proposal;
  }

  async createConfigurationProposal(input: ConfigurationProposalCreateInput): Promise<ConfigurationProposal> {
    return this.store.mutate((state) => {
      const access = configurationControlAccess(state, input.sourceRunId, "configuration_proposal_create");
      const plan = planConfigurationProposal(
        state,
        access.targetEmployeeId,
        access.expectedEmployeeVersion,
        input.operations
      );
      const timestamp = now();
      const proposal: ConfigurationProposal = {
        id: `cp-${timestamp.replaceAll(/[:.]/g, "-").toLowerCase()}-${randomUUID().slice(0, 8)}`,
        status: "awaiting-review",
        title: requireText(input.title, "configuration proposal title"),
        reason: requireText(input.reason, "configuration proposal reason"),
        employeeId: access.targetEmployeeId,
        expectedEmployeeVersion: access.expectedEmployeeVersion,
        operations: plan.operations,
        reviewItems: plan.reviewItems,
        decisions: [],
        progress: configurationReviewProgress(plan.reviewItems.map((item) => item.id), []),
        reviewRevision: 0,
        reviewHash: configurationReviewHash({
          planHash: plan.planHash,
          reviewItems: plan.reviewItems,
          decisions: []
        }),
        source: {
          kind: "ai-generated",
          invocationId: access.invocation.id,
          projectId: access.project.id,
          projectVersion: access.project.version,
          projectRoleId: access.projectRoleId,
          projectBindingVersion: access.binding.version,
          employeeId: access.steward.id,
          employeeVersion: access.steward.version,
          requestedBy: access.steward.id,
          sessionId: access.session.id,
          runId: access.invocation.runId
        },
        planHash: plan.planHash,
        validation: { valid: true, errors: [] },
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.configurationProposals[proposal.id] = proposal;
      return proposal;
    });
  }

  async decideConfigurationReviewItem(
    proposalId: string,
    reviewItemId: string,
    input: ConfigurationReviewDecisionInput
  ): Promise<ConfigurationProposal> {
    const outcome = await this.store.mutate((state) => {
      const proposal = state.configurationProposals[proposalId];
      if (!proposal) throw new Error(`configuration proposal not found: ${proposalId}`);
      if (proposal.status !== "awaiting-review" && proposal.status !== "ready-to-apply") {
        throw new Error(`configuration proposal ${proposalId} cannot be reviewed from ${proposal.status}`);
      }
      const reviewItem = proposal.reviewItems.find((item) => item.id === reviewItemId);
      if (!reviewItem) throw new Error(`configuration review item not found: ${reviewItemId}`);
      if (input.decision !== "accepted" && input.decision !== "rejected") {
        throw new Error("configuration review decision must be accepted or rejected");
      }
      assertConfigurationReviewSnapshot(
        proposal,
        input.expectedReviewRevision,
        input.expectedReviewHash
      );
      const attestation = configurationProposalAttestation(state, proposal);
      if (attestation.kind === "invalid") {
        markConfigurationSourceInvalid(proposal, attestation.error);
        return { proposal, stale: false, sourceInvalid: true };
      }
      if (attestation.kind === "pending") throw new Error(attestation.error);
      let fullPlan: ConfigurationProposalPlan;
      try {
        fullPlan = planConfigurationProposal(
          state,
          proposal.employeeId,
          proposal.expectedEmployeeVersion,
          proposal.operations
        );
      } catch (error) {
        proposal.status = "needs-reapproval";
        proposal.error = errorMessage(error);
        proposal.validation = { valid: false, errors: [proposal.error] };
        proposal.updatedAt = now();
        return { proposal, stale: true, sourceInvalid: false };
      }
      if (fullPlan.planHash !== proposal.planHash) {
        proposal.status = "needs-reapproval";
        proposal.error = "configuration dependencies or semantic preview changed; create a fresh proposal";
        proposal.validation = { valid: false, errors: [proposal.error] };
        proposal.updatedAt = now();
        return { proposal, stale: true, sourceInvalid: false };
      }
      const timestamp = now();
      proposal.decisions.push({
        id: `decision-${randomUUID()}`,
        reviewItemId,
        decision: input.decision,
        actor: requireText(input.actor?.trim() || "local-owner", "configuration reviewer"),
        at: timestamp,
        comment: input.comment?.trim() || undefined,
        planHash: proposal.planHash
      });
      proposal.reviewRevision += 1;
      proposal.reviewHash = configurationReviewHash(proposal);
      proposal.progress = configurationReviewProgress(
        proposal.reviewItems.map((item) => item.id),
        proposal.decisions
      );
      proposal.status = "awaiting-review";
      proposal.error = undefined;
      proposal.validation = { valid: true, errors: [] };
      if (proposal.progress.pending === 0) {
        if (proposal.progress.accepted === 0) {
          proposal.validation = { valid: false, errors: ["至少接受一项配置变更后才能应用。"] };
        } else {
          const latest = latestConfigurationDecisions(proposal);
          const acceptedOperations = proposal.reviewItems
            .filter((item) => latest.get(item.id)?.decision === "accepted")
            .map((item) => proposal.operations[item.operationIndex]!);
          try {
            planConfigurationProposal(
              state,
              proposal.employeeId,
              proposal.expectedEmployeeVersion,
              acceptedOperations
            );
            proposal.status = "ready-to-apply";
          } catch (error) {
            proposal.validation = { valid: false, errors: [errorMessage(error)] };
          }
        }
      }
      proposal.updatedAt = timestamp;
      return { proposal, stale: false, sourceInvalid: false };
    });
    if (outcome.sourceInvalid) throw new Error(outcome.proposal.error);
    if (outcome.stale) throw new Error(`configuration proposal ${proposalId} needs reapproval`);
    return outcome.proposal;
  }

  async applyConfigurationProposal(
    id: string,
    input: ConfigurationProposalApplyInput,
    actor = "local-owner"
  ): Promise<ConfigurationProposal> {
    const outcome = await this.store.mutate((state) => {
      const proposal = state.configurationProposals[id];
      if (!proposal) throw new Error(`configuration proposal not found: ${id}`);
      assertConfigurationReviewSnapshot(proposal, input.expectedReviewRevision, input.expectedReviewHash);
      if (proposal.status !== "ready-to-apply") {
        throw new Error(`configuration proposal ${id} is ${proposal.status}`);
      }
      const attestation = configurationProposalAttestation(state, proposal);
      if (attestation.kind === "invalid") {
        markConfigurationSourceInvalid(proposal, attestation.error);
        return { proposal, stale: false, sourceInvalid: true };
      }
      if (attestation.kind === "pending") throw new Error(attestation.error);
      let fullPlan: ConfigurationProposalPlan;
      try {
        fullPlan = planConfigurationProposal(
          state,
          proposal.employeeId,
          proposal.expectedEmployeeVersion,
          proposal.operations
        );
      } catch (error) {
        proposal.status = "needs-reapproval";
        proposal.error = errorMessage(error);
        proposal.validation = { valid: false, errors: [proposal.error] };
        proposal.updatedAt = now();
        return { proposal, stale: true, sourceInvalid: false };
      }
      if (fullPlan.planHash !== proposal.planHash) {
        proposal.status = "needs-reapproval";
        proposal.error = "configuration dependencies or semantic preview changed; create a fresh proposal";
        proposal.validation = { valid: false, errors: [proposal.error] };
        proposal.updatedAt = now();
        return { proposal, stale: true, sourceInvalid: false };
      }
      proposal.progress = configurationReviewProgress(
        proposal.reviewItems.map((item) => item.id),
        proposal.decisions
      );
      if (proposal.progress.pending > 0 || proposal.progress.accepted === 0) {
        throw new Error(`configuration proposal ${id} is not fully reviewed`);
      }
      const latest = latestConfigurationDecisions(proposal);
      const acceptedOperations = proposal.reviewItems
        .filter((item) => latest.get(item.id)?.decision === "accepted")
        .map((item) => proposal.operations[item.operationIndex]!);
      let acceptedPlan: ConfigurationProposalPlan;
      try {
        acceptedPlan = planConfigurationProposal(
          state,
          proposal.employeeId,
          proposal.expectedEmployeeVersion,
          acceptedOperations
        );
      } catch (error) {
        proposal.status = "needs-reapproval";
        proposal.error = errorMessage(error);
        proposal.validation = { valid: false, errors: [proposal.error] };
        proposal.updatedAt = now();
        return { proposal, stale: true, sourceInvalid: false };
      }
      const timestamp = now();
      const record = state.employees[proposal.employeeId]!;
      const appliedEmployee = { ...acceptedPlan.candidate, updatedAt: timestamp };
      proposal.status = "applying";
      record.current = appliedEmployee;
      record.versions.push(appliedEmployee);
      proposal.status = "applied";
      proposal.result = { employeeId: appliedEmployee.id, employeeVersion: appliedEmployee.version };
      proposal.application = {
        actor: requireText(actor, "configuration proposal application actor"),
        at: timestamp,
        reviewRevision: proposal.reviewRevision,
        reviewHash: proposal.reviewHash,
        acceptedReviewItemIds: proposal.reviewItems
          .filter((item) => latest.get(item.id)?.decision === "accepted")
          .map((item) => item.id),
        fromEmployeeVersion: proposal.expectedEmployeeVersion,
        toEmployeeVersion: appliedEmployee.version
      };
      proposal.validation = { valid: true, errors: [] };
      proposal.error = undefined;
      proposal.appliedAt = timestamp;
      proposal.updatedAt = timestamp;
      return { proposal, stale: false, sourceInvalid: false };
    });
    if (outcome.sourceInvalid) throw new Error(outcome.proposal.error);
    if (outcome.stale) throw new Error(`configuration proposal ${id} changed after review and needs reapproval`);
    return outcome.proposal;
  }

  async cancelConfigurationProposal(id: string, actor = "local-owner", comment?: string): Promise<ConfigurationProposal> {
    return this.store.mutate((state) => {
      const proposal = state.configurationProposals[id];
      if (!proposal) throw new Error(`configuration proposal not found: ${id}`);
      if (proposal.status !== "awaiting-review" && proposal.status !== "ready-to-apply" && proposal.status !== "needs-reapproval") {
        throw new Error(`configuration proposal ${id} cannot be cancelled from ${proposal.status}`);
      }
      const timestamp = now();
      proposal.status = "cancelled";
      proposal.cancellation = {
        actor: requireText(actor, "configuration cancellation actor"),
        at: timestamp,
        comment: comment?.trim() || undefined
      };
      proposal.error = undefined;
      proposal.updatedAt = timestamp;
      return proposal;
    });
  }

  private normalizeKnowledgeBase(
    input: KnowledgeBaseCreateInput,
    current?: KnowledgeBaseDefinition
  ): KnowledgeBaseDefinition {
    const id = requireId(input.id, "knowledge base id");
    const collectionIds = new Set<string>();
    const collections = input.collections.map((collection) => {
      const collectionId = requireId(collection.id, `knowledge base ${id} collection id`);
      if (collectionIds.has(collectionId)) throw new Error(`knowledge base ${id} repeats collection ${collectionId}`);
      collectionIds.add(collectionId);
      if (!["canonical", "reference", "experimental"].includes(collection.authority)) {
        throw new Error(`knowledge collection ${collectionId} has invalid authority ${String(collection.authority)}`);
      }
      return {
        id: collectionId,
        displayName: requireText(collection.displayName, `knowledge collection ${collectionId} displayName`),
        description: requireText(collection.description, `knowledge collection ${collectionId} description`),
        authority: collection.authority,
        tags: [...new Set(collection.tags.map((tag) => requireText(tag, `knowledge collection ${collectionId} tag`)))]
      };
    });
    if (collections.length === 0) throw new Error(`knowledge base ${id} must contain at least one collection`);
    const sourceIds = new Set<string>();
    const sources = (input.sources ?? []).map((source) => {
      const sourceId = requireId(source.id, `knowledge base ${id} source id`);
      if (sourceIds.has(sourceId)) throw new Error(`knowledge base ${id} repeats source ${sourceId}`);
      sourceIds.add(sourceId);
      if (source.kind !== "file" && source.kind !== "directory") {
        throw new Error(`knowledge source ${sourceId} kind must be file or directory`);
      }
      const collectionId = requireId(source.collectionId, `knowledge source ${sourceId} collectionId`);
      if (!collectionIds.has(collectionId)) throw new Error(`knowledge source ${sourceId} references unknown collection ${collectionId}`);
      return {
        id: sourceId,
        kind: source.kind,
        location: path.resolve(requireText(source.location, `knowledge source ${sourceId} location`)),
        collectionId,
        includeExtensions: source.includeExtensions?.map((extension) => requireText(extension, `knowledge source ${sourceId} extension`))
      };
    });
    const classification = input.classification ?? current?.classification ?? "internal";
    if (!["internal", "confidential", "restricted"].includes(classification)) {
      throw new Error(`knowledge base ${id} has invalid classification ${String(classification)}`);
    }
    const timestamp = now();
    return {
      id,
      version: current ? current.version + 1 : 1,
      status: current?.status ?? "active",
      displayName: requireText(input.displayName ?? id, "knowledge base displayName"),
      description: requireText(input.description, "knowledge base description"),
      domain: requireId(input.domain, "knowledge base domain"),
      product: input.product ? requireId(input.product, "knowledge base product") : undefined,
      projectId: input.projectId ? requireId(input.projectId, "knowledge base projectId") : undefined,
      classification,
      collections,
      sources,
      latestRevision: current?.latestRevision,
      publishedRevision: current?.publishedRevision,
      syncStatus: current?.syncStatus ?? "idle",
      qualityStatus: current?.qualityStatus ?? "healthy",
      lastSyncedAt: current?.lastSyncedAt,
      lastSyncError: current?.lastSyncError,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
  }

  async createKnowledgeBase(input: KnowledgeBaseCreateInput): Promise<KnowledgeBaseDefinition> {
    if (this.snapshot().knowledgeBases[input.id]) throw new Error(`knowledge base already exists: ${input.id}`);
    const knowledgeBase = this.normalizeKnowledgeBase(input);
    const documents = normalizeKnowledgeDocuments(input.documents ?? [], new Set(knowledgeBase.collections.map((item) => item.id)), knowledgeBase.createdAt);
    if (documents.length > 0) {
      const revision: KnowledgeRevision = {
        knowledgeBaseId: knowledgeBase.id,
        revision: 1,
        documents,
        sourceSummary: { sourceCount: 0, documentCount: documents.length },
        createdAt: knowledgeBase.createdAt
      };
      await this.knowledge.contentStore.writeRevision(revision);
      knowledgeBase.latestRevision = 1;
      if (input.publish) knowledgeBase.publishedRevision = 1;
    }
    return this.store.mutate((state) => {
      if (state.knowledgeBases[knowledgeBase.id]) throw new Error(`knowledge base already exists: ${knowledgeBase.id}`);
      state.knowledgeBases[knowledgeBase.id] = { current: knowledgeBase, versions: [knowledgeBase] };
      return knowledgeBase;
    });
  }

  async updateKnowledgeBase(id: string, input: KnowledgeBaseUpdateInput): Promise<KnowledgeBaseDefinition> {
    const current = this.getKnowledgeBase(id);
    const updated = this.normalizeKnowledgeBase({
      id,
      displayName: input.displayName ?? current.displayName,
      description: input.description ?? current.description,
      domain: input.domain ?? current.domain,
      product: input.product === undefined ? current.product : input.product,
      projectId: input.projectId === undefined ? current.projectId : input.projectId,
      classification: input.classification ?? current.classification,
      collections: input.collections ?? current.collections,
      sources: input.sources ?? current.sources
    }, current);
    if (current.latestRevision) {
      const revision = await this.knowledge.contentStore.readRevision(id, current.latestRevision);
      const allowed = new Set(updated.collections.map((collection) => collection.id));
      const orphan = revision.documents.find((document) => !allowed.has(document.collectionId));
      if (orphan) throw new Error(`collection ${orphan.collectionId} is still used by knowledge document ${orphan.id}`);
    }
    return this.store.mutate((state) => {
      const record = state.knowledgeBases[id];
      if (!record) throw new Error(`knowledge base not found: ${id}`);
      record.current = updated;
      record.versions.push(updated);
      return updated;
    });
  }

  async createKnowledgeRevision(id: string, input: KnowledgeRevisionCreateInput): Promise<KnowledgeRevision> {
    const knowledgeBase = this.getKnowledgeBase(id);
    if (knowledgeBase.status !== "active") throw new Error(`knowledge base ${id} is archived`);
    const timestamp = now();
    const documents = normalizeKnowledgeDocuments(input.documents, new Set(knowledgeBase.collections.map((item) => item.id)), timestamp);
    const revision: KnowledgeRevision = {
      knowledgeBaseId: id,
      revision: (knowledgeBase.latestRevision ?? 0) + 1,
      documents,
      sourceSummary: { sourceCount: 0, documentCount: documents.length },
      createdAt: timestamp
    };
    await this.knowledge.contentStore.writeRevision(revision);
    await this.store.mutate((state) => {
      const record = state.knowledgeBases[id];
      if (!record || record.current.version !== knowledgeBase.version) throw new Error(`knowledge base ${id} changed while creating revision`);
      const updated: KnowledgeBaseDefinition = {
        ...record.current,
        version: record.current.version + 1,
        latestRevision: revision.revision,
        qualityStatus: "healthy",
        updatedAt: timestamp
      };
      record.current = updated;
      record.versions.push(updated);
    });
    return revision;
  }

  async syncKnowledgeBase(id: string): Promise<KnowledgeRevision> {
    const current = this.getKnowledgeBase(id);
    if (current.status !== "active") throw new Error(`knowledge base ${id} is archived`);
    if (current.syncStatus === "syncing") throw new Error(`knowledge base ${id} is already syncing`);
    if (current.sources.length === 0) throw new Error(`knowledge base ${id} has no configured sources`);
    const startedAt = now();
    const knowledgeBase = await this.store.mutate((state) => {
      const record = state.knowledgeBases[id];
      if (!record || record.current.version !== current.version) throw new Error(`knowledge base ${id} changed before syncing`);
      const syncing: KnowledgeBaseDefinition = {
        ...record.current,
        version: record.current.version + 1,
        syncStatus: "syncing",
        lastSyncError: undefined,
        updatedAt: startedAt
      };
      record.current = syncing;
      record.versions.push(syncing);
      return syncing;
    });
    const timestamp = now();
    try {
      const previous = knowledgeBase.latestRevision
        ? await this.knowledge.contentStore.readRevision(id, knowledgeBase.latestRevision)
        : undefined;
      const manualDocuments = previous?.documents.filter((document) => !document.sourceId) ?? [];
      const sourceDocuments = await this.knowledge.contentStore.collectSources(knowledgeBase);
      const documents = [...manualDocuments, ...sourceDocuments];
      const seen = new Set<string>();
      const allowedCollections = new Set(knowledgeBase.collections.map((collection) => collection.id));
      for (const document of documents) {
        if (seen.has(document.id)) throw new Error(`knowledge sync produced duplicate document ${document.id}`);
        seen.add(document.id);
        if (!allowedCollections.has(document.collectionId)) throw new Error(`knowledge document ${document.id} references unknown collection ${document.collectionId}`);
      }
      const revision: KnowledgeRevision = {
        knowledgeBaseId: id,
        revision: (knowledgeBase.latestRevision ?? 0) + 1,
        documents,
        sourceSummary: { sourceCount: knowledgeBase.sources.length, documentCount: documents.length },
        createdAt: timestamp
      };
      await this.knowledge.contentStore.writeRevision(revision);
      await this.store.mutate((state) => {
        const record = state.knowledgeBases[id];
        if (!record || record.current.version !== knowledgeBase.version) throw new Error(`knowledge base ${id} changed while syncing`);
        const updated: KnowledgeBaseDefinition = {
          ...record.current,
          version: record.current.version + 1,
          latestRevision: revision.revision,
          syncStatus: "idle",
          qualityStatus: "healthy",
          lastSyncedAt: timestamp,
          lastSyncError: undefined,
          updatedAt: timestamp
        };
        record.current = updated;
        record.versions.push(updated);
      });
      return revision;
    } catch (error) {
      await this.store.mutate((state) => {
        const record = state.knowledgeBases[id];
        if (!record) return;
        if (record.current.version !== knowledgeBase.version || record.current.syncStatus !== "syncing") return;
        const failed: KnowledgeBaseDefinition = {
          ...record.current,
          version: record.current.version + 1,
          syncStatus: "failed",
          qualityStatus: record.current.publishedRevision ? "degraded" : "stale",
          lastSyncError: errorMessage(error),
          updatedAt: now()
        };
        record.current = failed;
        record.versions.push(failed);
      });
      throw error;
    }
  }

  async publishKnowledgeRevision(id: string, revisionValue?: number): Promise<KnowledgeBaseDefinition> {
    const current = this.getKnowledgeBase(id);
    if (current.status !== "active") throw new Error(`knowledge base ${id} is archived`);
    if (revisionValue === undefined && !current.latestRevision) throw new Error(`knowledge base ${id} has no revision to publish`);
    const revision = validRevision(revisionValue, current.latestRevision, "knowledge revision");
    const contentRevision = await this.knowledge.contentStore.readRevision(id, revision);
    const assessment = assessKnowledgeRevision(current, contentRevision);
    if (assessment.status === "blocked") {
      throw new Error(`knowledge revision ${id}@${revision} is blocked: ${assessment.warnings.map((warning) => warning.message).join("; ")}`);
    }
    const updated: KnowledgeBaseDefinition = {
      ...current,
      version: current.version + 1,
      publishedRevision: revision,
      qualityStatus: "healthy",
      updatedAt: now()
    };
    return this.store.mutate((state) => {
      const record = state.knowledgeBases[id];
      if (!record || record.current.version !== current.version) throw new Error(`knowledge base ${id} changed while publishing`);
      record.current = updated;
      record.versions.push(updated);
      return updated;
    });
  }

  async archiveKnowledgeBase(id: string): Promise<KnowledgeBaseDefinition> {
    const current = this.getKnowledgeBase(id);
    if (current.status === "archived") return current;
    const archived: KnowledgeBaseDefinition = { ...current, status: "archived", version: current.version + 1, updatedAt: now() };
    return this.store.mutate((state) => {
      const record = state.knowledgeBases[id];
      if (!record || record.current.version !== current.version) throw new Error(`knowledge base ${id} changed while archiving`);
      record.current = archived;
      record.versions.push(archived);
      return archived;
    });
  }

  async restoreKnowledgeBase(id: string): Promise<KnowledgeBaseDefinition> {
    const current = this.getKnowledgeBase(id);
    if (current.status === "active") return current;
    const restored: KnowledgeBaseDefinition = { ...current, status: "active", version: current.version + 1, updatedAt: now() };
    return this.store.mutate((state) => {
      const record = state.knowledgeBases[id];
      if (!record || record.current.version !== current.version) throw new Error(`knowledge base ${id} changed while restoring`);
      record.current = restored;
      record.versions.push(restored);
      return restored;
    });
  }

  listKnowledgeProfiles(includeArchived = false): KnowledgeProfileDefinition[] {
    return Object.values(this.snapshot().knowledgeProfiles)
      .map((record) => record.current)
      .filter((profile) => includeArchived || profile.status === "active")
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  getKnowledgeProfile(id: string, version?: number): KnowledgeProfileDefinition {
    const record = this.snapshot().knowledgeProfiles[id];
    if (!record) throw new Error(`knowledge profile not found: ${id}`);
    if (version === undefined) return record.current;
    const found = record.versions.find((candidate) => candidate.version === version);
    if (!found) throw new Error(`knowledge profile ${id} version ${version} not found`);
    return found;
  }

  private normalizeKnowledgeProfile(
    input: KnowledgeProfileCreateInput,
    current?: KnowledgeProfileDefinition
  ): KnowledgeProfileDefinition {
    const id = requireId(input.id, "knowledge profile id");
    const rules = input.rules.map(normalizeKnowledgeRule);
    if (rules.length === 0) throw new Error(`knowledge profile ${id} must contain at least one rule`);
    if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error(`knowledge profile ${id} repeats a rule id`);
    const state = this.snapshot();
    for (const knowledgeBaseId of rules.flatMap((rule) => rule.selector.knowledgeBaseIds ?? [])) {
      if (!state.knowledgeBases[knowledgeBaseId]) throw new Error(`knowledge profile ${id} references unknown knowledge base ${knowledgeBaseId}`);
    }
    const timestamp = now();
    return {
      id,
      version: current ? current.version + 1 : 1,
      status: current?.status ?? "active",
      displayName: requireText(input.displayName ?? id, "knowledge profile displayName"),
      description: requireText(input.description, "knowledge profile description"),
      rules,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
  }

  async createKnowledgeProfile(input: KnowledgeProfileCreateInput): Promise<KnowledgeProfileDefinition> {
    const profile = this.normalizeKnowledgeProfile(input);
    return this.store.mutate((state) => {
      if (state.knowledgeProfiles[profile.id]) throw new Error(`knowledge profile already exists: ${profile.id}`);
      state.knowledgeProfiles[profile.id] = { current: profile, versions: [profile] };
      return profile;
    });
  }

  async updateKnowledgeProfile(id: string, input: KnowledgeProfileUpdateInput): Promise<KnowledgeProfileDefinition> {
    const current = this.getKnowledgeProfile(id);
    const updated = this.normalizeKnowledgeProfile({
      id,
      displayName: input.displayName ?? current.displayName,
      description: input.description ?? current.description,
      rules: input.rules ?? current.rules
    }, current);
    return this.store.mutate((state) => {
      const record = state.knowledgeProfiles[id];
      if (!record) throw new Error(`knowledge profile not found: ${id}`);
      record.current = updated;
      record.versions.push(updated);
      return updated;
    });
  }

  async archiveKnowledgeProfile(id: string): Promise<KnowledgeProfileDefinition> {
    const current = this.getKnowledgeProfile(id);
    if (current.status === "archived") return current;
    const archived: KnowledgeProfileDefinition = { ...current, status: "archived", version: current.version + 1, updatedAt: now() };
    return this.store.mutate((state) => {
      const record = state.knowledgeProfiles[id];
      if (!record || record.current.version !== current.version) throw new Error(`knowledge profile ${id} changed while archiving`);
      record.current = archived;
      record.versions.push(archived);
      return archived;
    });
  }

  async restoreKnowledgeProfile(id: string): Promise<KnowledgeProfileDefinition> {
    const current = this.getKnowledgeProfile(id);
    if (current.status === "active") return current;
    const restored: KnowledgeProfileDefinition = { ...current, status: "active", version: current.version + 1, updatedAt: now() };
    return this.store.mutate((state) => {
      const record = state.knowledgeProfiles[id];
      if (!record || record.current.version !== current.version) throw new Error(`knowledge profile ${id} changed while restoring`);
      record.current = restored;
      record.versions.push(restored);
      return restored;
    });
  }

  async previewEmployeeKnowledge(
    employeeId: string,
    input: { message: string; projectId?: string; projectRoleId?: string; taskTags?: string[] }
  ): Promise<KnowledgeRuntimeResult> {
    const employee = this.getEmployee(employeeId);
    return this.knowledge.prepare(this.snapshot(), employee, {
      request: requireText(input.message, "knowledge preview message"),
      projectId: input.projectId,
      projectRoleId: input.projectRoleId,
      taskTags: input.taskTags ?? []
    });
  }

  async getEmployeeKnowledgePerspective(
    employeeId: string,
    input: KnowledgePerspectiveInput
  ): Promise<KnowledgePerspective> {
    const projectId = input.projectId ? requireId(input.projectId, "knowledge perspective projectId") : undefined;
    const projectRoleId = input.projectRoleId
      ? requireId(input.projectRoleId, "knowledge perspective projectRoleId")
      : undefined;
    const taskTags = normalizedStringList(input.taskTags, "knowledge perspective task tag") ?? [];
    const evidenceLimit = input.evidenceLimit ?? 10;
    if (!Number.isInteger(evidenceLimit) || evidenceLimit < 1 || evidenceLimit > 50) {
      throw new Error("knowledge perspective evidenceLimit must be an integer from 1 to 50");
    }
    let employee = this.getEmployee(employeeId);
    if (projectId && projectRoleId) {
      const resolved = this.resolveProjectEmployee(projectId, projectRoleId);
      if (resolved.employee.id !== employeeId) {
        throw new Error(`project role ${projectId}/${projectRoleId} is assigned to ${resolved.employee.id}, not ${employeeId}`);
      }
      employee = resolved.employee;
    }
    const context = {
      request: requireText(input.message, "knowledge perspective message"),
      projectId,
      projectRoleId,
      taskTags
    };
    const state = this.snapshot();
    const scope = resolveKnowledgeScope(state, employee, context);
    const plan = routeKnowledge(scope);
    const activatedKeys = activatedKnowledgeCollectionKeys(scope);
    const candidates = Object.values(state.workInstances)
      .filter((instance) => instance.employeeId === employeeId)
      .filter((instance) => projectId === undefined || instance.source.project === projectId)
      .filter((instance) => projectRoleId === undefined || instance.source.projectRole === projectRoleId)
      .sort((left, right) => (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt)
        || right.id.localeCompare(left.id));
    const scanned = candidates.slice(0, evidenceLimit);
    const recentEvidence = (await Promise.all(scanned.map(async (instance): Promise<KnowledgeEvidenceUsage | undefined> => {
      try {
        const artifact = JSON.parse(await fs.readFile(path.join(
          this.store.dataRoot,
          "artifacts",
          "runs",
          instance.runId,
          "knowledge",
          `${instance.nodeId}.json`
        ), "utf8")) as Partial<KnowledgeRuntimeResult>;
        if (!artifact.plan || !Array.isArray(artifact.evidence)) return undefined;
        return {
          runId: instance.runId,
          workInstanceId: instance.id,
          nodeId: instance.nodeId,
          status: instance.status,
          at: instance.completedAt ?? instance.updatedAt,
          context: artifact.plan.context,
          evidence: artifact.evidence
        };
      } catch {
        return undefined;
      }
    }))).filter((item): item is KnowledgeEvidenceUsage => Boolean(item));
    return {
      employee: {
        id: employee.id,
        version: employee.version,
        knowledgeProfileIds: employee.knowledgeProfileIds,
        grants: employee.knowledgeGrants
      },
      context,
      eligible: scope.eligibleCollections,
      activated: scope.eligibleCollections.filter((collection) =>
        activatedKeys.has(`${collection.knowledgeBaseId}/${collection.collection.id}`)
      ),
      selected: plan.selectedCollections,
      exclusions: plan.exclusions,
      recentEvidence,
      evidenceWindow: {
        policy: "recent-work-instances-v1",
        limit: evidenceLimit,
        scannedInstances: scanned.length,
        matchedRuns: new Set(recentEvidence.map((usage) => usage.runId)).size,
        oldestScannedAt: scanned.at(-1)?.completedAt ?? scanned.at(-1)?.updatedAt,
        newestScannedAt: scanned[0]?.completedAt ?? scanned[0]?.updatedAt
      }
    };
  }

  listArchitectureTemplates(): ArchitectureTemplateDefinition[] {
    return listArchitectureTemplates();
  }

  listGateValidators(): Array<{ id: string; description: string }> {
    return listRegisteredGateValidators();
  }

  instantiateArchitectureTemplate(id: string, employeeIds: string[]): InstantiatedArchitectureTemplate {
    const state = this.snapshot();
    for (const employeeId of employeeIds) {
      const employee = state.employees[employeeId]?.current;
      if (!employee) throw new Error(`employee not found: ${employeeId}`);
      if (employee.status !== "active") throw new Error(`employee ${employeeId} is archived`);
    }
    return instantiateArchitectureTemplate(id, employeeIds);
  }

  listProjects(includeArchived = false): ProjectDefinition[] {
    return Object.values(this.snapshot().projects)
      .map((record) => record.current)
      .filter((project) => includeArchived || project.status === "active")
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  listPassiveProjectAccesses(): PassiveProjectAccessRecord[] {
    const state = this.snapshot();
    const projects = Object.values(state.projects).map((record) => record.current);
    return Object.values(state.passiveProjectAccesses)
      .map((access) => ({
        ...access,
        linkedProjectId: passiveProjectAccessLinkedProjectId(access, projects)
      }))
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  async recordPassiveProjectAccess(input: {
    rootPath?: string;
    projectKey?: string;
  }): Promise<PassiveProjectAccessRecord> {
    const requestedRoot = input.rootPath?.trim();
    if (requestedRoot && !path.isAbsolute(requestedRoot)) throw new Error("MCP client root must be an absolute path");
    const rootPath = requestedRoot ? path.normalize(requestedRoot) : undefined;
    const projectKey = input.projectKey?.trim() || undefined;
    if (!rootPath && !projectKey) throw new Error("MCP project access requires a root path or project key");
    const timestamp = now();
    const stored = await this.store.mutate((state) => {
      return observePassiveProjectAccess(state, { rootPath, projectKey, seenAt: timestamp });
    });
    const projects = Object.values(this.snapshot().projects).map((record) => record.current);
    return { ...stored, linkedProjectId: passiveProjectAccessLinkedProjectId(stored, projects) };
  }

  getProject(id: string, version?: number): ProjectDefinition {
    const record = this.snapshot().projects[id];
    if (!record) throw new Error(`project not found: ${id}`);
    return projectVersion(record, version);
  }

  getProjectVersions(id: string): ProjectDefinition[] {
    const record = this.snapshot().projects[id];
    if (!record) throw new Error(`project not found: ${id}`);
    return [...record.versions].sort((left, right) => right.version - left.version);
  }

  listProjectBindings(): ProjectBindingDefinition[] {
    return Object.values(this.snapshot().projectBindings)
      .map((record) => record.current)
      .sort((left, right) => left.projectId.localeCompare(right.projectId));
  }

  getProjectBinding(projectId: string, version?: number): ProjectBindingDefinition {
    const record = this.snapshot().projectBindings[projectId];
    if (!record) throw new Error(`project binding not found: ${projectId}`);
    if (version === undefined) return record.current;
    const found = record.versions.find((candidate) => candidate.version === version);
    if (!found) throw new Error(`project binding ${projectId} version ${version} not found`);
    return found;
  }

  getProjectBindingVersions(projectId: string): ProjectBindingDefinition[] {
    const record = this.snapshot().projectBindings[projectId];
    if (!record) return [];
    return [...record.versions].sort((left, right) => right.version - left.version);
  }

  private normalizeProject(input: ProjectCreateInput, current?: ProjectDefinition): ProjectDefinition {
    const id = requireId(input.id, "project id");
    const seen = new Set<string>();
    const roles = input.roles.map((role) => {
      const roleId = requireId(role.id, "project role id");
      if (seen.has(roleId)) throw new Error(`duplicate project role ${roleId}`);
      seen.add(roleId);
      const requiredSkills = [...new Set(role.requiredSkills ?? [])].map((skillId) => requireId(skillId, `project role ${roleId} required skill`));
      const optionalSkills = [...new Set(role.optionalSkills ?? [])].map((skillId) => requireId(skillId, `project role ${roleId} optional skill`));
      const requiredProviderProfiles = [...new Set(role.requiredProviderProfiles ?? [])]
        .map((profile) => requireId(profile, `project role ${roleId} required Provider profile`));
      const knowledgeProfileIds = uniqueIds(role.knowledgeProfileIds ?? [], `project role ${roleId} knowledge profile`);
      const overlap = requiredSkills.filter((skillId) => optionalSkills.includes(skillId));
      if (overlap.length > 0) throw new Error(`project role ${roleId} repeats skills as required and optional: ${overlap.join(", ")}`);
      if (role.outputSchema) validateSchema(role.outputSchema, `project role ${roleId} outputSchema`);
      return {
        id: roleId,
        displayName: requireText(role.displayName ?? roleId, `project role ${roleId} displayName`),
        description: requireText(role.description ?? `Project role ${roleId}.`, `project role ${roleId} description`),
        requiredSkills,
        optionalSkills,
        requiredProviderProfiles,
        knowledgeProfileIds,
        instructions: requireText(role.instructions ?? `Follow the ${roleId} project role contract.`, `project role ${roleId} instructions`),
        outputSchema: role.outputSchema,
        permissions: role.permissions
      };
    });
    if (roles.length === 0) throw new Error("project roles must not be empty");
    const timestamp = now();
    return {
      id,
      version: current ? current.version + 1 : 1,
      status: current?.status ?? "active",
      name: requireText(input.name ?? id, "project name"),
      description: requireText(input.description ?? `Locally connected project ${id}.`, "project description"),
      scope: input.scope ?? "repository",
      rootPath: path.resolve(requireText(input.rootPath, "project rootPath")),
      descriptorPath: path.resolve(requireText(input.descriptorPath, "project descriptorPath")),
      connector: {
        kind: requireId(input.connector?.kind ?? "generic", "project connector kind"),
        config: input.connector?.config ?? {}
      },
      roles,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
  }

  async createProject(input: ProjectCreateInput): Promise<ProjectDefinition> {
    const project = this.normalizeProject(input);
    return this.store.mutate((state) => {
      if (state.projects[project.id]) throw new Error(`project already exists: ${project.id}`);
      state.projects[project.id] = { current: project, versions: [project] };
      return project;
    });
  }

  async updateProject(id: string, input: ProjectCreateInput): Promise<ProjectDefinition> {
    const current = this.getProject(id);
    if (input.id !== id) throw new Error(`project id cannot change from ${id} to ${input.id}`);
    const project = this.normalizeProject(input, current);
    const comparable = (value: ProjectDefinition) => ({
      name: value.name,
      description: value.description,
      scope: value.scope,
      rootPath: value.rootPath,
      descriptorPath: value.descriptorPath,
      connector: value.connector,
      roles: value.roles,
      status: value.status
    });
    if (jsonEqual(comparable(current), comparable(project))) return current;
    return this.store.mutate((state) => {
      const record = state.projects[id];
      if (!record) throw new Error(`project not found: ${id}`);
      record.current = project;
      record.versions.push(project);
      return project;
    });
  }

  async connectProject(input: ProjectConnectInput): Promise<ProjectDefinition> {
    if (input.createDescriptorIfMissing) await ensureProjectDescriptor(input);
    const definition = await loadProjectDescriptor(input);
    return this.snapshot().projects[definition.id]
      ? this.updateProject(definition.id, definition)
      : this.createProject(definition);
  }

  async archiveProject(id: string): Promise<ProjectDefinition> {
    const current = this.getProject(id);
    if (current.status === "archived") return current;
    const archived: ProjectDefinition = { ...current, status: "archived", version: current.version + 1, updatedAt: now() };
    return this.store.mutate((state) => {
      const record = state.projects[id];
      if (!record) throw new Error(`project not found: ${id}`);
      record.current = archived;
      record.versions.push(archived);
      return archived;
    });
  }

  private normalizeProjectRoleBinding(
    state: WorkbenchState,
    project: ProjectDefinition,
    input: ProjectRoleBindingInput
  ): ProjectRoleBinding {
    const role = project.roles.find((candidate) => candidate.id === input.roleId);
    if (!role) throw new Error(`project role not found: ${project.id}/${input.roleId}`);
    const record = state.employees[input.employeeId];
    if (!record) throw new Error(`employee not found: ${input.employeeId}`);
    if (record.current.status !== "active") throw new Error(`employee ${input.employeeId} is archived`);
    const employee = employeeVersion(record, input.employeeVersion);
    const scopedProjectId = internalProjectId(employee);
    // 系统员工默认不允许被绑定为项目角色；但内部对话型系统员工（小配/小知等，
    // scope 固定到自身内部项目）只能通过绑定到「自己所属项目的角色」再经 invokeProjectRole 调用，
    // 这是它们唯一的调用入口，故仅当目标不是其自身内部项目时才拒绝——
    // 防止系统员工泄漏为任意/外部项目角色，同时不破坏其既有调用链路。
    if (isSystemEmployee(employee) && scopedProjectId !== project.id) {
      throw new Error(`员工 ${employee.id} 是系统员工（systemRole=${employee.systemRole}），不允许绑定为项目角色`);
    }
    assertProjectRoleProviderCompatibility(state, role, employee);
    if (scopedProjectId && scopedProjectId !== project.id) {
      throw new Error(`employee ${employee.id} is internal to project ${scopedProjectId}`);
    }
    const scopedProjectVersion = internalProjectVersion(employee);
    if (scopedProjectVersion !== undefined && scopedProjectVersion !== project.version) {
      throw new Error(`employee ${employee.id} is fixed to project ${project.id} v${scopedProjectVersion}, not v${project.version}`);
    }
    const scopedRoleId = internalProjectRoleId(employee);
    if (scopedRoleId && scopedRoleId !== role.id) {
      throw new Error(`employee ${employee.id} is internal to project role ${scopedRoleId}`);
    }
    const configured = new Map(employee.skills.map((binding) => [normalizeBinding(binding).id, binding]));
    const requested = input.skills ?? [...role.requiredSkills, ...role.optionalSkills]
      .filter((skillId) => configured.has(skillId))
      .map((skillId) => skillId);
    const selected = requested.map((binding) => {
      const normalized = normalizeBinding(binding);
      const employeeBinding = configured.get(normalized.id);
      if (!employeeBinding) throw new Error(`employee ${employee.id} does not have project skill ${normalized.id}`);
      const employeeNormalized = normalizeBinding(employeeBinding);
      if (!employeeNormalized.enabled) throw new Error(`employee ${employee.id} has project skill ${normalized.id} disabled`);
      return {
        id: normalized.id,
        config: typeof binding === "string" ? employeeNormalized.config : normalized.config,
        enabled: true
      };
    });
    const selectedIds = new Set(selected.map((binding) => binding.id));
    const allowed = new Set([...role.requiredSkills, ...role.optionalSkills]);
    const unexpected = [...selectedIds].filter((skillId) => !allowed.has(skillId));
    if (unexpected.length > 0) throw new Error(`project role ${role.id} does not declare skills: ${unexpected.join(", ")}`);
    const missing = role.requiredSkills.filter((skillId) => !selectedIds.has(skillId));
    if (missing.length > 0) throw new Error(`employee ${employee.id} is missing required project skills: ${missing.join(", ")}`);
    const skillVersions = Object.fromEntries(selected.map((binding) => {
      const version = employee.skillVersions[binding.id];
      if (!version) throw new Error(`employee ${employee.id} does not pin skill ${binding.id}`);
      return [binding.id, version];
    }));
    validateSkillBindings(state, selected, skillVersions);
    const requestedKnowledgeProfiles = input.knowledgeProfileIds ?? role.knowledgeProfileIds;
    const unexpectedKnowledgeProfiles = requestedKnowledgeProfiles.filter((profileId) => !role.knowledgeProfileIds.includes(profileId));
    if (unexpectedKnowledgeProfiles.length > 0) {
      throw new Error(`project role ${role.id} does not declare knowledge profiles: ${unexpectedKnowledgeProfiles.join(", ")}`);
    }
    const knowledgeProfileIds = validateKnowledgeProfileIds(
      state,
      requestedKnowledgeProfiles,
      `project role ${role.id} knowledge profile`
    );
    const existingGrants = state.projectBindings[project.id]?.current.roles
      .find((candidate) => candidate.roleId === role.id)?.knowledgeGrants ?? [];
    const knowledgeGrants = normalizeKnowledgeGrants(
      knowledgeProfileIds,
      input.knowledgeGrants,
      now(),
      existingGrants
    );
    return {
      roleId: role.id,
      employeeId: employee.id,
      employeeVersion: employee.version,
      skills: selected,
      skillVersions,
      knowledgeProfileIds,
      knowledgeGrants,
      updatePolicy: input.updatePolicy ?? "compatible"
    };
  }

  async saveProjectBinding(projectId: string, input: ProjectBindingInput): Promise<ProjectBindingDefinition> {
    const state = this.snapshot();
    const project = projectVersion(state.projects[projectId] ?? (() => { throw new Error(`project not found: ${projectId}`); })());
    if (project.status !== "active") throw new Error(`project ${projectId} is archived`);
    const seen = new Set<string>();
    const roles = input.roles.map((role) => {
      if (seen.has(role.roleId)) throw new Error(`project role ${role.roleId} is bound more than once`);
      seen.add(role.roleId);
      return this.normalizeProjectRoleBinding(state, project, role);
    });
    const current = state.projectBindings[projectId]?.current;
    const timestamp = now();
    const binding: ProjectBindingDefinition = {
      projectId,
      projectVersion: project.version,
      version: current ? current.version + 1 : 1,
      roles,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    return this.store.mutate((next) => {
      const record = next.projectBindings[projectId];
      if (record) {
        record.current = binding;
        record.versions.push(binding);
      } else {
        next.projectBindings[projectId] = { current: binding, versions: [binding] };
      }
      return binding;
    });
  }

  async refreshProjectBinding(projectId: string): Promise<ProjectBindingRefreshResult> {
    const state = this.snapshot();
    const binding = this.getProjectBinding(projectId);
    const project = this.getProject(projectId, binding.projectVersion);
    const refreshed: ProjectRoleBinding[] = [];
    const results: ProjectBindingRefreshResult["roles"] = [];
    let changed = false;
    for (const roleBinding of binding.roles) {
      const currentEmployee = state.employees[roleBinding.employeeId]?.current;
      if (!currentEmployee || currentEmployee.status !== "active") {
        refreshed.push(roleBinding);
        results.push({ roleId: roleBinding.roleId, status: "approval-required", message: "员工已不存在或已归档。" });
        continue;
      }
      if (currentEmployee.version === roleBinding.employeeVersion) {
        refreshed.push(roleBinding);
        results.push({ roleId: roleBinding.roleId, status: "current", message: `已固定在员工 v${currentEmployee.version}。` });
        continue;
      }
      if (roleBinding.updatePolicy === "locked") {
        refreshed.push(roleBinding);
        results.push({ roleId: roleBinding.roleId, status: "locked", message: `发现员工 v${currentEmployee.version}，当前策略保持锁定。` });
        continue;
      }
      const previousEmployee = employeeVersion(state.employees[roleBinding.employeeId]!, roleBinding.employeeVersion);
      const compatible = previousEmployee.providerId === currentEmployee.providerId
        && jsonEqual(previousEmployee.permissions, currentEmployee.permissions)
        && jsonEqual(previousEmployee.outputSchema, currentEmployee.outputSchema)
        && jsonEqual(previousEmployee.verdict, currentEmployee.verdict);
      if (roleBinding.updatePolicy === "compatible" && !compatible) {
        refreshed.push(roleBinding);
        results.push({ roleId: roleBinding.roleId, status: "approval-required", message: `员工已更新至 v${currentEmployee.version}，Provider、权限或输出契约发生变化。` });
        continue;
      }
      try {
        const next = this.normalizeProjectRoleBinding(state, project, {
          roleId: roleBinding.roleId,
          employeeId: roleBinding.employeeId,
          employeeVersion: currentEmployee.version,
          skills: roleBinding.skills,
          knowledgeProfileIds: roleBinding.knowledgeProfileIds,
          knowledgeGrants: roleBinding.knowledgeGrants,
          updatePolicy: roleBinding.updatePolicy
        });
        refreshed.push(next);
        changed = true;
        results.push({ roleId: roleBinding.roleId, status: "updated", message: `已同步到员工 v${currentEmployee.version}；项目 Skill 子集保持不变。` });
      } catch (error) {
        refreshed.push(roleBinding);
        results.push({ roleId: roleBinding.roleId, status: "approval-required", message: errorMessage(error) });
      }
    }
    if (!changed) return { changed, binding, roles: results };
    const timestamp = now();
    const nextBinding: ProjectBindingDefinition = {
      ...binding,
      version: binding.version + 1,
      roles: refreshed,
      updatedAt: timestamp
    };
    await this.store.mutate((next) => {
      const record = next.projectBindings[projectId];
      if (!record) throw new Error(`project binding not found: ${projectId}`);
      record.current = nextBinding;
      record.versions.push(nextBinding);
    });
    return { changed, binding: nextBinding, roles: results };
  }

  listEmployees(includeArchived = false): EmployeeDefinition[] {
    return Object.values(this.snapshot().employees)
      .map((record) => record.current)
      .filter((employee) => includeArchived || employee.status === "active")
      .sort((left, right) => left.identity.displayName.localeCompare(right.identity.displayName));
  }

  getEmployee(id: string, version?: number): EmployeeDefinition {
    const record = this.snapshot().employees[id];
    if (!record) throw new Error(`employee not found: ${id}`);
    return employeeVersion(record, version);
  }

  getEmployeeVersions(id: string): EmployeeDefinition[] {
    const record = this.snapshot().employees[id];
    if (!record) throw new Error(`employee not found: ${id}`);
    return [...record.versions].sort((left, right) => right.version - left.version);
  }

  async createEmployee(input: EmployeeCreateInput): Promise<EmployeeDefinition> {
    const id = requireId(input.id, "employee id");
    return this.store.mutate((state) => {
      if (state.employees[id]) throw new Error(`employee already exists: ${id}`);
      const timestamp = now();
      const employee = buildEmployeeDefinition(state, input, timestamp);
      state.employees[id] = { current: employee, versions: [employee] };
      return employee;
    });
  }

  async createEmployeeFromTemplate(
    templateId: string,
    input: EmployeeFromTemplateCreateInput
  ): Promise<EmployeeDefinition> {
    requireId(templateId, "employee template id");
    const id = requireId(input.id, "employee id");
    return this.store.mutate((state) => {
      if (state.employees[id]) throw new Error(`employee already exists: ${id}`);
      const record = state.employeeTemplates[templateId];
      if (!record) throw new Error(`employee template not found: ${templateId}`);
      if (record.current.status !== "active") throw new Error(`employee template ${templateId} is archived`);
      const template = employeeTemplateVersion(record, input.templateVersion);
      if (template.status !== "active") {
        throw new Error(`employee template ${templateId} v${template.version} is archived`);
      }
      const { templateVersion: _templateVersion, id: _id, identity: identityInput, ...overrides } = input;
      const employeeInput: EmployeeCreateInput = {
        ...structuredClone(template.defaults),
        ...overrides,
        id,
        identity: {
          ...structuredClone(template.defaults.identity),
          ...identityInput,
          displayName: identityInput.displayName
        }
      };
      const timestamp = now();
      const employee = buildEmployeeDefinition(
        state,
        employeeInput,
        timestamp,
        { id: template.id, version: template.version }
      );
      state.employees[id] = { current: employee, versions: [employee] };
      return employee;
    });
  }

  async updateEmployee(
    id: string,
    input: EmployeeUpdateInput,
    options?: { allowSystemEmployeeMutation?: boolean }
  ): Promise<EmployeeDefinition> {
    const current = this.getEmployee(id);
    if (isSystemEmployee(current) && !options?.allowSystemEmployeeMutation) {
      throw new Error(`员工 ${id} 是系统员工，默认受保护；如确需修改请显式确认（allowSystemEmployeeMutation）`);
    }
    return this.store.mutate((state) => {
      const record = state.employees[id];
      if (!record) throw new Error(`employee not found: ${id}`);
      const updatedAt = now();
      const updated = buildUpdatedEmployeeDefinition(state, id, input, updatedAt);
      record.current = updated;
      record.versions.push(updated);
      return updated;
    });
  }

  async repinEmployeeProject(id: string, requestedProjectVersion?: number): Promise<EmployeeDefinition> {
    const employee = this.getEmployee(id);
    if (employee.scope.kind !== "project") throw new Error(`employee ${id} is not project-scoped`);
    const project = this.getProject(employee.scope.projectId, requestedProjectVersion);
    if (project.status !== "active") throw new Error(`project ${project.id} is archived`);
    if (employee.scope.projectVersion === project.version) return employee;
    return this.store.mutate((state) => {
      const record = state.employees[id];
      if (!record) throw new Error(`employee not found: ${id}`);
      const updated = buildUpdatedEmployeeDefinition(state, id, {
        scope: { kind: "project", projectId: project.id, projectVersion: project.version }
      }, now(), true);
      record.current = updated;
      record.versions.push(updated);
      return updated;
    });
  }

  async cloneEmployee(sourceId: string, newId: string, displayName?: string): Promise<EmployeeDefinition> {
    const source = this.getEmployee(sourceId);
    return this.createEmployee({
      id: requireId(newId, "cloned employee id"),
      identity: { ...source.identity, displayName: displayName?.trim() || `${source.identity.displayName} Copy` },
      description: source.description,
      systemPrompt: source.systemPrompt,
      requestPrompt: source.requestPrompt,
      capabilities: source.capabilities,
      scope: source.scope,
      skills: source.skills,
      skillVersions: source.skillVersions,
      knowledgeProfileIds: source.knowledgeProfileIds,
      knowledgeGrants: source.knowledgeGrants.map((grant) => ({
        profileId: grant.profileId,
        reason: grant.reason,
        grantedBy: grant.grantedBy,
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt,
        reviewCycleDays: grant.reviewCycleDays,
        lastReviewedAt: grant.lastReviewedAt
      })),
      providerId: source.providerId,
      outputSchema: source.outputSchema,
      maxAttempts: source.maxAttempts,
      permissions: source.permissions,
      verdict: source.verdict,
      contextPolicy: source.contextPolicy,
      presentation: source.presentation
    });
  }

  async archiveEmployee(
    id: string,
    options?: { allowSystemEmployeeMutation?: boolean }
  ): Promise<EmployeeDefinition> {
    const current = this.getEmployee(id);
    if (isSystemEmployee(current) && !options?.allowSystemEmployeeMutation) {
      throw new Error(`员工 ${id} 是系统员工，默认受保护；如确需归档请显式确认（allowSystemEmployeeMutation）`);
    }
    return this.store.mutate((state) => {
      const record = state.employees[id];
      if (!record) throw new Error(`employee not found: ${id}`);
      if (record.current.status === "archived") return record.current;
      const archived = { ...record.current, status: "archived" as const, version: record.current.version + 1, updatedAt: now() };
      record.current = archived;
      record.versions.push(archived);
      return archived;
    });
  }

  listSessions(employeeId?: string): EmployeeSession[] {
    return Object.values(this.snapshot().sessions)
      .filter((session) => !employeeId || session.employeeId === employeeId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getSession(id: string): EmployeeSession {
    const session = this.snapshot().sessions[id];
    if (!session) throw new Error(`session not found: ${id}`);
    return session;
  }

  private directWorkflow(
    employee: EmployeeDefinition,
    context?: { id: string; version: number; description: string }
  ): GraphWorkbenchWorkflowDefinition {
    const timestamp = now();
    return {
      id: context?.id ?? `direct-${employee.id}`,
      version: context?.version ?? employee.version,
      status: "active",
      architecture: "graph",
      description: context?.description ?? `Direct invocation of ${employee.identity.displayName}`,
      nodes: [{ id: "respond", employeeId: employee.id, employeeVersion: employee.version, needs: [], with: {} }],
      maxConcurrency: 1,
      failFast: true,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  private resolveProjectEmployee(
    projectId: string,
    roleId: string,
    projectVersionValue?: number,
    bindingVersionValue?: number
  ): {
    project: ProjectDefinition;
    binding: ProjectBindingDefinition;
    roleBinding: ProjectRoleBinding;
    employee: EmployeeDefinition;
  } {
    const project = this.getProject(projectId, projectVersionValue);
    const binding = this.getProjectBinding(projectId, bindingVersionValue);
    if (binding.projectVersion !== project.version) {
      throw new Error(`project binding v${binding.version} targets project v${binding.projectVersion}, not v${project.version}`);
    }
    const role = project.roles.find((candidate) => candidate.id === roleId);
    if (!role) throw new Error(`project role not found: ${project.id}/${roleId}`);
    const roleBinding = binding.roles.find((candidate) => candidate.roleId === roleId);
    if (!roleBinding) throw new Error(`project role is not assigned: ${project.id}/${roleId}`);
    const base = this.getEmployee(roleBinding.employeeId, roleBinding.employeeVersion);
    assertProjectRoleProviderCompatibility(this.snapshot(), role, base);
    const assignmentHeader = [
      "## Project assignment",
      `Project: ${project.name} (${project.id})`,
      `Role slot: ${role.displayName} (${role.id})`,
      `Project version: v${project.version}; binding version: v${binding.version}`,
      "The following policy is scoped to this project assignment and does not change your reusable Employee identity.",
      "",
      role.instructions
    ].join("\n");
    const employee: EmployeeDefinition = {
      ...base,
      identity: {
        ...base.identity,
        metadata: {
          ...(base.identity.metadata ?? {}),
          projectId: project.id,
          projectRole: role.id,
          projectVersion: project.version,
          projectBindingVersion: binding.version
        }
      },
      description: `${base.description} Assigned as ${role.displayName} for ${project.name}.`,
      systemPrompt: `${base.systemPrompt.trim()}\n\n${assignmentHeader}`,
      skills: roleBinding.skills,
      skillVersions: roleBinding.skillVersions,
      knowledgeProfileIds: [...new Set([...base.knowledgeProfileIds, ...roleBinding.knowledgeProfileIds])],
      knowledgeGrants: [...new Map(
        [...base.knowledgeGrants, ...roleBinding.knowledgeGrants].map((grant) => [grant.profileId, grant])
      ).values()],
      outputSchema: role.outputSchema ?? base.outputSchema,
      permissions: narrowPermissions(base.permissions, role.permissions)
    };
    return { project, binding, roleBinding, employee };
  }

  private async materialize(workflow: WorkbenchWorkflowDefinition, employees: Map<string, EmployeeDefinition>) {
    return materializeWorkflow({
      dataRoot: this.store.dataRoot,
      state: this.snapshot(),
      workflow,
      employees,
      providers: this.providers,
      architectures: this.architectures
    });
  }

  private formatSessionHistoryMessage(sessionId: string, message: EmployeeSessionMessage): string {
    const evidence: string[] = [];
    for (const attachment of message.attachments ?? []) {
      evidence.push(
        `IMAGE ${attachment.id}: name=${JSON.stringify(attachment.name)}, mediaType=${attachment.mediaType}, `
        + `sizeBytes=${attachment.sizeBytes}, sha256=${attachment.sha256}, `
        + `absolutePath=${JSON.stringify(conversationImagePath(this.store.dataRoot, sessionId, attachment))}`
      );
    }
    for (const document of message.documents ?? []) {
      if (document.status === "available") {
        evidence.push(
          `LARK_DOCUMENT ${document.id}: url=${JSON.stringify(document.url)}, revisionId=${document.revisionId ?? "unknown"}, `
          + `sha256=${document.sha256 ?? "unknown"}, `
          + `absolutePath=${JSON.stringify(conversationDocumentPath(this.store.dataRoot, sessionId, document.id))}`
        );
      } else {
        evidence.push(
          `LARK_DOCUMENT ${document.id}: url=${JSON.stringify(document.url)}, status=failed, `
          + `error=${JSON.stringify(document.error?.message ?? "fetch failed")}, `
          + `action=${JSON.stringify(document.error?.action ?? "Ask the user to verify authentication and access.")}`
        );
      }
    }
    return `${message.role.toUpperCase()}: ${message.content}${evidence.length ? `\nEVIDENCE:\n${evidence.join("\n")}` : ""}`;
  }

  async getConversationImageAttachment(id: string): Promise<{
    id: string;
    name: string;
    mediaType: string;
    sizeBytes: number;
    filePath: string;
  }> {
    if (!isConversationAttachmentId(id)) throw new Error("conversation attachment id is invalid");
    let found: { sessionId: string; attachment: NonNullable<EmployeeSessionMessage["attachments"]>[number] } | undefined;
    for (const session of Object.values(this.snapshot().sessions)) {
      for (const message of session.messages) {
        const attachment = message.attachments?.find((candidate) => candidate.id === id);
        if (!attachment) continue;
        if (found) throw new Error(`conversation attachment id is not unique: ${id}`);
        found = { sessionId: session.id, attachment };
      }
    }
    if (!found) throw new Error(`conversation attachment not found: ${id}`);
    const filePath = await resolvePersistedConversationImage({
      dataRoot: this.store.dataRoot,
      sessionId: found.sessionId,
      attachment: found.attachment
    });
    return {
      id,
      name: found.attachment.name,
      mediaType: found.attachment.mediaType,
      sizeBytes: found.attachment.sizeBytes,
      filePath
    };
  }

  private async invokeResolvedEmployee(options: {
    employee: EmployeeDefinition;
    input: EmployeeInvocationInput;
    source: InvocationSource;
    session?: EmployeeSession;
    assignment?: EmployeeSession["assignment"];
    workflow?: { id: string; version: number; description: string };
    providerCwd?: string;
    entrance?: EntrancePolicyExecutionSnapshot;
  }): Promise<EmployeeInvocationResult> {
    const { employee, input, source } = options;
    // 自动型系统员工（systemRole=automatic）只能由系统内部触发（source.caller 以 "system:" 前缀标记），
    // 不支持人工直接调用。守卫下沉到此汇聚点：invokeEmployee / invokePinnedEmployee / invokeProjectRole /
    // invokePinnedProjectRole 都经此处，避免任一路径绕过。内部来源豁免必须保留，否则小忆
    // （memory-summarizer，systemRole=automatic）经 extractMemoryForRun 的自动提炼会被拦死。
    const isInternalCaller = typeof source.caller === "string" && source.caller.startsWith("system:");
    if (systemRoleOf(employee) === "automatic" && !isInternalCaller) {
      throw new Error(`员工 ${employee.id} 是自动型系统员工，只能由系统触发，不支持人工直接调用`);
    }
    if (input.context !== undefined && (typeof input.context !== "object" || input.context === null || Array.isArray(input.context))) {
      throw new Error("invocation context must be a JSON object");
    }
    const validatedAttachments = validateConversationImages(input.attachments);
    let session = options.session;
    if (session && !jsonEqual(session.context, input.context)) {
      throw new Error(`session ${session.id} belongs to another structured invocation context`);
    }
    if (!session) {
      const timestamp = now();
      session = {
        id: randomUUID(),
        employeeId: employee.id,
        employeeVersion: employee.version,
        assignment: options.assignment,
        title: input.message.trim().slice(0, 72),
        status: "active",
        context: input.context,
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const newSession = session;
      await this.store.mutate((state) => {
        state.sessions[newSession.id] = newSession;
      });
    }
    const conversationEvidence = await prepareConversationEvidence({
      dataRoot: this.store.dataRoot,
      sessionId: session.id,
      message: input.message.trim(),
      attachments: input.attachments,
      validatedAttachments,
      larkDocumentFetcher: this.larkDocumentFetcher
    });
    const hasConversationEvidence = conversationEvidence.attachments.length > 0 || conversationEvidence.documents.length > 0;
    const promptEvidence = hasConversationEvidence
      ? JSON.parse(JSON.stringify(conversationEvidence.prompt)) as JsonObject
      : undefined;
    const workflow = this.directWorkflow(employee, options.workflow);
    const employees = new Map([[employee.id, employee]]);
    const invocation = await this.createInvocationActivity({
      target: { kind: "employee", id: employee.id, version: employee.version },
      source,
      workflow,
      employees,
      input: {
        message: input.message.trim(),
        ...(input.context ? { context: input.context } : {}),
        ...(promptEvidence ? { conversationEvidence: promptEvidence } : {})
      },
      sessionId: session.id,
      entrance: options.entrance
    });
    const sessionId = session.id;
    return this.inSessionQueue(sessionId, async () => {
      await this.transitionInstance(invocation.id, "respond", "waiting", "waiting-session");
    }, async () => {
      const latestSession = this.getSession(sessionId);
      const history = latestSession.messages
        .slice(-employee.contextPolicy.historyLimit)
        .map((message) => this.formatSessionHistoryMessage(sessionId, message))
        .join("\n\n");
      const result = await this.runTrackedWorkflow(invocation, workflow, employees, {
        message: input.message.trim(),
        sessionHistory: history,
        ...(input.context ? { context: input.context } : {}),
        ...(promptEvidence ? { conversationEvidence: promptEvidence } : {})
      }, options.providerCwd);
      const node = result.run.nodes.respond;
      const responseMessage = invocationMessage(node?.output);
      const timestamp = now();
      const updatedSession = await this.store.mutate((state) => {
        const target = state.sessions[sessionId];
        if (!target) throw new Error(`session not found: ${sessionId}`);
        target.messages.push(
          {
            id: randomUUID(),
            role: "user",
            content: input.message.trim(),
            at: timestamp,
            runId: result.run.id,
            runDir: result.runDir,
            ...(conversationEvidence.attachments.length > 0 ? { attachments: conversationEvidence.attachments } : {}),
            ...(conversationEvidence.documents.length > 0 ? { documents: conversationEvidence.documents } : {})
          },
          {
            id: randomUUID(),
            role: node?.status === "failed" ? "system" : "employee",
            content: responseMessage,
            at: timestamp,
            runId: result.run.id,
            runDir: result.runDir,
            output: node?.output
          }
        );
        target.updatedAt = timestamp;
        return target;
      });
      // 运行已完成，异步提炼 memory（尽力而为，不阻塞返回、不抛给主链路）。
      this.extractMemoryForRun(
        result.run.id,
        {
          employeeId: employee.id,
          employeeVersion: employee.version,
          projectId: options.assignment?.projectId
        },
        {
          invocationId: invocation.id,
          source: { caller: source.caller, contextId: source.contextId }
        }
      );
      return {
        session: updatedSession,
        runId: result.run.id,
        runDir: result.runDir,
        status: result.run.status,
        output: node?.output,
        message: responseMessage
      };
    });
  }

  async invokeEmployee(
    employeeId: string,
    input: EmployeeInvocationInput,
    source: InvocationSource = { kind: "workbench" },
    options: { providerCwd?: string } = {}
  ): Promise<EmployeeInvocationResult> {
    requireText(input.message, "message");
    const current = this.getEmployee(employeeId);
    if (current.status !== "active") throw new Error(`employee ${employeeId} is archived`);
    // 自动型系统员工守卫已下沉到 invokeResolvedEmployee 汇聚点，此处不再重复。
    const scopedProjectId = internalProjectId(current);
    if (scopedProjectId) throw new Error(`employee ${employeeId} is internal to project ${scopedProjectId}; invoke it through a project role`);
    const session = input.sessionId ? this.getSession(input.sessionId) : undefined;
    if (session && session.employeeId !== employeeId) throw new Error(`session ${session.id} belongs to another employee`);
    if (session?.supervisor) throw new Error(`session ${session.id} is a Supervisor leader session; use continue_workflow_conversation`);
    if (session?.assignment) throw new Error(`session ${session.id} belongs to project ${session.assignment.projectId}/${session.assignment.roleId}`);
    const employee = session ? this.getEmployee(employeeId, session.employeeVersion) : current;
    const providerCwd = await this.validatedProviderCwd(options.providerCwd);
    return this.invokeResolvedEmployee({ employee, input: { ...input, message: input.message.trim() }, source, session, providerCwd });
  }

  private async invokePinnedEmployee(
    employeeId: string,
    employeeVersionValue: number,
    input: EmployeeInvocationInput,
    source: InvocationSource,
    entrance: EntrancePolicyExecutionSnapshot,
    providerCwd?: string
  ): Promise<EmployeeInvocationResult> {
    requireText(input.message, "message");
    const current = this.getEmployee(employeeId);
    if (current.status !== "active") throw new Error(`employee ${employeeId} is archived`);
    const scopedProjectId = internalProjectId(current);
    if (scopedProjectId) throw new Error(`employee ${employeeId} is internal to project ${scopedProjectId}; invoke it through a project role`);
    const employee = this.getEmployee(employeeId, employeeVersionValue);
    const session = input.sessionId ? this.getSession(input.sessionId) : undefined;
    if (session && session.employeeId !== employeeId) throw new Error(`session ${session.id} belongs to another employee`);
    if (session?.supervisor) throw new Error(`session ${session.id} is a Supervisor leader session; use continue_workflow_conversation`);
    if (session?.assignment) throw new Error(`session ${session.id} belongs to project ${session.assignment.projectId}/${session.assignment.roleId}`);
    if (session && session.employeeVersion !== employee.version) {
      throw new Error(`session ${session.id} pins employee ${employeeId} v${session.employeeVersion}, not v${employee.version}`);
    }
    return this.invokeResolvedEmployee({
      employee,
      input: { ...input, message: input.message.trim() },
      source,
      session,
      entrance,
      providerCwd: await this.validatedProviderCwd(providerCwd)
    });
  }

  async continueWorkflowConversation(
    leaderSessionId: string,
    input: string | EmployeeInvocationInput,
    source: InvocationSource = { kind: "workbench" },
    options: { providerCwd?: string } = {}
  ): Promise<EmployeeInvocationResult> {
    const continuation = typeof input === "string" ? { message: input } : input;
    const normalizedMessage = requireText(continuation.message, "message");
    const session = this.getSession(requireText(leaderSessionId, "leader session id"));
    if (session.status !== "active") throw new Error(`leader session ${session.id} is closed`);
    const supervisor = session.supervisor;
    if (!supervisor || supervisor.architecture !== "supervisor") {
      throw new Error(`session ${session.id} is not a Supervisor workflow leader session`);
    }
    const state = this.snapshot();
    const originalInvocation = state.invocations[supervisor.invocationId];
    if (!originalInvocation
      || originalInvocation.sessionId !== session.id
      || originalInvocation.runId !== supervisor.runId
      || originalInvocation.target.kind !== "workflow"
      || originalInvocation.target.id !== supervisor.workflowId
      || originalInvocation.target.version !== supervisor.workflowVersion
      || originalInvocation.executionSnapshot?.workflow.architecture !== "supervisor") {
      throw new Error(`leader session ${session.id} has invalid or missing Supervisor workflow provenance`);
    }
    const supervisorBinding = originalInvocation.executionSnapshot.employees.find((binding) => binding.roleId === "supervisor");
    if (!supervisorBinding
      || supervisorBinding.employeeId !== session.employeeId
      || supervisorBinding.employeeVersion !== session.employeeVersion) {
      throw new Error(`leader session ${session.id} does not match the pinned Supervisor Employee`);
    }
    if (!isInvocationTerminal(originalInvocation.status)) {
      throw new Error(`Supervisor workflow ${supervisor.workflowId} is still running; keep monitoring before continuing the leader conversation`);
    }
    const current = this.getEmployee(session.employeeId);
    if (current.status !== "active") throw new Error(`employee ${session.employeeId} is archived`);
    const employee = this.getEmployee(session.employeeId, session.employeeVersion);
    return this.invokeResolvedEmployee({
      employee,
      input: {
        message: normalizedMessage,
        context: session.context,
        ...(continuation.attachments ? { attachments: continuation.attachments } : {})
      },
      source: { ...originalInvocation.source, ...source },
      session,
      providerCwd: await this.validatedProviderCwd(options.providerCwd),
      workflow: {
        id: `leader-session-${supervisor.workflowId}`,
        version: supervisor.workflowVersion,
        description: `Continue leader conversation for Supervisor workflow ${supervisor.workflowId}`
      }
    });
  }

  async invokeProjectRole(
    projectId: string,
    roleId: string,
    input: EmployeeInvocationInput,
    source: InvocationSource = { kind: "workbench" }
  ): Promise<EmployeeInvocationResult> {
    requireText(input.message, "message");
    const currentProject = this.getProject(projectId);
    if (currentProject.status !== "active") throw new Error(`project ${projectId} is archived`);
    const session = input.sessionId ? this.getSession(input.sessionId) : undefined;
    if (session && (!session.assignment || session.assignment.projectId !== projectId || session.assignment.roleId !== roleId)) {
      throw new Error(`session ${session.id} belongs to another project assignment`);
    }
    const resolved = session?.assignment
      ? this.resolveProjectEmployee(
          projectId,
          roleId,
          session.assignment.projectVersion,
          session.assignment.projectBindingVersion
        )
      : this.resolveProjectEmployee(projectId, roleId);
    const currentEmployee = this.getEmployee(resolved.employee.id);
    if (currentEmployee.status !== "active") throw new Error(`employee ${resolved.employee.id} is archived`);
    const assignment = session?.assignment ?? {
      projectId,
      projectVersion: resolved.project.version,
      projectBindingVersion: resolved.binding.version,
      roleId
    };
    return this.invokeResolvedEmployee({
      employee: resolved.employee,
      input: { ...input, message: input.message.trim() },
      source: {
        ...source,
        project: projectId,
        projectRole: roleId,
        projectBindingVersion: resolved.binding.version
      },
      session,
      assignment,
      providerCwd: resolved.project.rootPath,
      workflow: {
        id: `project-${projectId}-${roleId}`,
        version: resolved.binding.version,
        description: `${resolved.project.name} / ${resolved.project.roles.find((role) => role.id === roleId)?.displayName ?? roleId}`
      }
    });
  }

  /**
   * Invoke a conversational role for a target project. Projects may intentionally
   * omit global intake roles from their own descriptor, so a compatible assigned
   * role from another active project can host the read-only conversation. The
   * target project remains explicit in both the prompt and persisted provenance.
   */
  async invokeProjectConversation(
    targetProjectId: string,
    roleId: string,
    input: EmployeeInvocationInput,
    source: InvocationSource = { kind: "workbench" }
  ): Promise<EmployeeInvocationResult> {
    requireText(input.message, "message");
    const targetProject = this.getProject(targetProjectId);
    if (targetProject.status !== "active") throw new Error(`project ${targetProjectId} is archived`);

    const session = input.sessionId ? this.getSession(input.sessionId) : undefined;
    let hostProjectId = session?.assignment?.projectId;
    if (session) {
      if (!session.assignment || session.assignment.roleId !== roleId) {
        throw new Error(`session ${session.id} belongs to another project conversation`);
      }
    } else {
      const bindings = new Map(this.listProjectBindings().map((binding) => [binding.projectId, binding]));
      const candidates = this.listProjects()
        .filter((project) => project.status === "active")
        .filter((project) => project.roles.some((role) => role.id === roleId))
        .filter((project) => bindings.get(project.id)?.roles.some((role) => role.roleId === roleId))
        .sort((left, right) => {
          if (left.id === targetProjectId) return -1;
          if (right.id === targetProjectId) return 1;
          return left.id.localeCompare(right.id);
        });
      hostProjectId = candidates[0]?.id;
    }
    if (!hostProjectId) {
      throw new Error(`no active project assignment can host conversational role: ${roleId}`);
    }

    const contextualMessage = [
      "【本轮对话归属项目】",
      `项目 ID：${targetProject.id}`,
      `项目名称：${targetProject.name}`,
      "请只围绕该项目澄清或整理用户原话，不要创建、推进或修改任何需求记录。",
      "【用户原话】",
      input.message.trim()
    ].join("\n");
    return this.invokeProjectRole(
      hostProjectId,
      roleId,
      { ...input, message: contextualMessage },
      { ...source, targetProject: targetProject.id }
    );
  }

  private async invokePinnedProjectRole(
    target: EntrancePolicyProjectRoleTarget,
    input: EmployeeInvocationInput,
    source: InvocationSource,
    entrance: EntrancePolicyExecutionSnapshot
  ): Promise<EmployeeInvocationResult> {
    requireText(input.message, "message");
    const currentProject = this.getProject(target.projectId);
    if (currentProject.status !== "active") throw new Error(`project ${target.projectId} is archived`);
    const resolved = this.resolveProjectEmployee(
      target.projectId,
      target.roleId,
      target.projectVersion,
      target.projectBindingVersion
    );
    if (resolved.employee.id !== target.employeeId || resolved.employee.version !== target.employeeVersion) {
      throw new Error(
        `entrance policy project role target ${target.projectId}/${target.roleId} no longer matches its pinned Employee`
      );
    }
    const currentEmployee = this.getEmployee(resolved.employee.id);
    if (currentEmployee.status !== "active") throw new Error(`employee ${resolved.employee.id} is archived`);
    const session = input.sessionId ? this.getSession(input.sessionId) : undefined;
    if (session && (
      !session.assignment
      || session.assignment.projectId !== target.projectId
      || session.assignment.roleId !== target.roleId
      || session.assignment.projectVersion !== target.projectVersion
      || session.assignment.projectBindingVersion !== target.projectBindingVersion
      || session.employeeVersion !== target.employeeVersion
    )) {
      throw new Error(`session ${session.id} belongs to another project assignment or pinned version`);
    }
    const assignment = session?.assignment ?? {
      projectId: target.projectId,
      projectVersion: target.projectVersion,
      projectBindingVersion: target.projectBindingVersion,
      roleId: target.roleId
    };
    return this.invokeResolvedEmployee({
      employee: resolved.employee,
      input: { ...input, message: input.message.trim() },
      source: {
        ...source,
        project: target.projectId,
        projectRole: target.roleId,
        projectBindingVersion: target.projectBindingVersion
      },
      session,
      assignment,
      providerCwd: resolved.project.rootPath,
      workflow: {
        id: `project-${target.projectId}-${target.roleId}`,
        version: target.projectBindingVersion,
        description: `${resolved.project.name} / ${resolved.project.roles.find((role) => role.id === target.roleId)?.displayName ?? target.roleId}`
      },
      entrance
    });
  }

  async getEmployeeContext(employeeId: string, sessionId?: string): Promise<EmployeeContextView> {
    const session = sessionId ? this.getSession(sessionId) : this.listSessions(employeeId)[0];
    if (session && session.employeeId !== employeeId) throw new Error(`session ${session.id} belongs to another employee`);
    const employee = session?.assignment
      ? this.resolveProjectEmployee(
          session.assignment.projectId,
          session.assignment.roleId,
          session.assignment.projectVersion,
          session.assignment.projectBindingVersion
        ).employee
      : this.getEmployee(employeeId, session?.employeeVersion);
    const state = this.snapshot();
    const skills = employee.skills.map((binding) => {
      const id = normalizeBinding(binding).id;
      return resolveSkillVersion(state, id, employee.skillVersions[id]);
    });
    const view: EmployeeContextView = {
      employee,
      skills,
      session,
      layers: {
        identity: employee.identity,
        systemPrompt: employee.systemPrompt,
        skills: employee.skills.map((binding) => {
          const id = normalizeBinding(binding).id;
          const skill = resolveSkillVersion(state, id, employee.skillVersions[id]);
          return resolveSkillBinding(binding, skill);
        }),
        history: session?.messages ?? [],
        currentRequest: [...(session?.messages ?? [])].reverse().find((message) => message.role === "user")?.content,
        dependencyResults: {}
      }
    };
    const latest = [...(session?.messages ?? [])].reverse().find((message) => message.runDir && message.runId);
    if (latest?.runDir && latest.runId) {
      try {
        const run = JSON.parse(await fs.readFile(path.join(latest.runDir, "run.json"), "utf8")) as {
          status?: string;
          artifactDir?: string;
          nodes?: { respond?: { attempts?: number } };
        };
        const attempt = run.nodes?.respond?.attempts ?? 1;
        const attemptDir = path.join(latest.runDir, "nodes", "respond", `attempt-${attempt}`);
        const [system, request, combined] = await Promise.all([
          fs.readFile(path.join(attemptDir, "system-prompt.md"), "utf8"),
          fs.readFile(path.join(attemptDir, "request-prompt.md"), "utf8"),
          fs.readFile(path.join(attemptDir, "prompt.md"), "utf8")
        ]);
        view.effectivePrompt = { system, request, combined, runId: latest.runId, runDir: latest.runDir };
        view.layers.runMetadata = {
          runId: latest.runId,
          runDir: latest.runDir,
          status: run.status ?? "unknown",
          artifactDir: run.artifactDir ?? latest.runDir,
          attempts: attempt
        };
        try {
          const knowledge = JSON.parse(
            await fs.readFile(path.join(latest.runDir, "knowledge", "respond.json"), "utf8")
          ) as KnowledgeRuntimeResult;
          view.layers.knowledge = { plan: knowledge.plan, evidence: knowledge.evidence };
        } catch {
          // Older runs and employees without prepared knowledge have no knowledge artifact.
        }
        try {
          view.effectiveProfile = JSON.parse(
            await fs.readFile(path.join(latest.runDir, "effective-profile", "respond.json"), "utf8")
          ) as EffectiveExecutionProfile;
        } catch {
          // Runs created before effective configuration compilation have no profile artifact.
        }
      } catch {
        // A failed attempt can legitimately have incomplete prompt artifacts.
      }
    }
    return view;
  }

  listEntrancePolicies(includeArchived = false): EntrancePolicyDefinition[] {
    return Object.values(this.snapshot().entrancePolicies)
      .map((record) => record.current)
      .filter((policy) => includeArchived || policy.status === "active")
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  getEntrancePolicy(id: string, version?: number): EntrancePolicyDefinition {
    const record = this.snapshot().entrancePolicies[id];
    if (!record) throw new Error(`entrance policy not found: ${id}`);
    if (version === undefined) return record.current;
    const found = record.versions.find((candidate) => candidate.version === version);
    if (!found) throw new Error(`entrance policy ${id} version ${version} not found`);
    return found;
  }

  getEntrancePolicyVersions(id: string): EntrancePolicyDefinition[] {
    const record = this.snapshot().entrancePolicies[id];
    if (!record) throw new Error(`entrance policy not found: ${id}`);
    return [...record.versions].sort((left, right) => right.version - left.version);
  }

  private resolveEntranceEmployeeTarget(
    input: { employeeId: string; employeeVersion?: number },
    label: string
  ): EntrancePolicySpecialistTarget & { kind: "employee" } {
    const state = this.snapshot();
    const employeeId = requireId(input.employeeId, `${label} employee id`);
    const record = state.employees[employeeId];
    if (!record) throw new Error(`employee not found: ${employeeId}`);
    if (record.current.status !== "active") throw new Error(`${label} employee ${employeeId} is archived`);
    const employee = employeeVersion(record, input.employeeVersion);
    if (employee.status !== "active") throw new Error(`${label} employee ${employeeId} v${employee.version} is archived`);
    const scopedProjectId = internalProjectId(employee);
    if (scopedProjectId) {
      throw new Error(`${label} employee ${employeeId} is internal to project ${scopedProjectId}; use a project-role target`);
    }
    return { kind: "employee", employeeId, employeeVersion: employee.version };
  }

  private resolveEntranceProjectRoleTarget(
    input: Extract<EntrancePolicySpecialistTargetInput, { kind: "project-role" }>,
    label: string
  ): EntrancePolicyProjectRoleTarget {
    const projectId = requireId(input.projectId, `${label} project id`);
    const roleId = requireId(input.roleId, `${label} role id`);
    const currentProject = this.getProject(projectId);
    if (currentProject.status !== "active") throw new Error(`${label} project ${projectId} is archived`);
    const project = this.getProject(projectId, input.projectVersion);
    if (project.status !== "active") throw new Error(`${label} project ${projectId} v${project.version} is archived`);
    const binding = this.getProjectBinding(projectId, input.projectBindingVersion);
    if (binding.projectVersion !== project.version) {
      throw new Error(
        `${label} project binding v${binding.version} targets project v${binding.projectVersion}, not v${project.version}`
      );
    }
    if (!project.roles.some((role) => role.id === roleId)) throw new Error(`project role not found: ${projectId}/${roleId}`);
    const roleBinding = binding.roles.find((candidate) => candidate.roleId === roleId);
    if (!roleBinding) throw new Error(`project role is not assigned: ${projectId}/${roleId}`);
    const currentEmployee = this.getEmployee(roleBinding.employeeId);
    if (currentEmployee.status !== "active") throw new Error(`${label} employee ${roleBinding.employeeId} is archived`);
    const employee = this.getEmployee(roleBinding.employeeId, roleBinding.employeeVersion);
    if (employee.status !== "active") {
      throw new Error(`${label} employee ${roleBinding.employeeId} v${roleBinding.employeeVersion} is archived`);
    }
    return {
      kind: "project-role",
      projectId,
      projectVersion: project.version,
      projectBindingVersion: binding.version,
      roleId,
      employeeId: employee.id,
      employeeVersion: employee.version
    };
  }

  private resolveEntranceWorkflowTarget(
    workflowIdValue: string,
    workflowVersionValue: number | undefined,
    architecture: "graph" | "supervisor",
    label: string
  ): EntrancePolicySpecialistTarget | EntrancePolicyDefinition["leader"] {
    const workflowId = requireId(workflowIdValue, `${label} workflow id`);
    const current = this.getWorkflow(workflowId);
    if (current.status !== "active") throw new Error(`${label} workflow ${workflowId} is archived`);
    const workflow = this.getWorkflow(workflowId, workflowVersionValue);
    if (workflow.status !== "active") throw new Error(`${label} workflow ${workflowId} v${workflow.version} is archived`);
    if (workflow.architecture !== architecture) {
      throw new Error(`${label} workflow ${workflowId} must use architecture=${architecture}, got ${workflow.architecture}`);
    }
    if (workflow.architecture === "supervisor") {
      const currentPolicy = this.getManagementPolicy(workflow.managementPolicy.id);
      if (currentPolicy.status !== "active") throw new Error(`management policy ${currentPolicy.id} is archived`);
      this.getManagementPolicy(workflow.managementPolicy.id, workflow.managementPolicy.version);
    }
    for (const employee of this.resolveWorkflowEmployees(workflow).values()) {
      if (this.getEmployee(employee.id).status !== "active") throw new Error(`${label} employee ${employee.id} is archived`);
    }
    return architecture === "graph"
      ? { kind: "graph-workflow", workflowId, workflowVersion: workflow.version }
      : { kind: "supervisor-workflow", workflowId, workflowVersion: workflow.version };
  }

  private resolveEntranceSpecialistTarget(
    input: EntrancePolicySpecialistTargetInput,
    label: string
  ): EntrancePolicySpecialistTarget {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be a JSON object`);
    if (input.kind === "employee") return this.resolveEntranceEmployeeTarget(input, label);
    if (input.kind === "project-role") return this.resolveEntranceProjectRoleTarget(input, label);
    if (input.kind === "graph-workflow") {
      return this.resolveEntranceWorkflowTarget(input.workflowId, input.workflowVersion, "graph", label) as EntrancePolicySpecialistTarget;
    }
    throw new Error(`${label} kind must be employee, project-role, or graph-workflow`);
  }

  private resolveEntranceDirectRoute(
    input: EntrancePolicyCreateInput["direct"],
    label: string
  ): EntrancePolicyDirectRoute | undefined {
    if (input === undefined) return undefined;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be a JSON object`);
    if (input.mode === "caller") return { mode: "caller" };
    if (input.mode === "employee") {
      const target = this.resolveEntranceEmployeeTarget(input, label);
      return { mode: "employee", employeeId: target.employeeId, employeeVersion: target.employeeVersion };
    }
    throw new Error(`${label}.mode must be caller or employee`);
  }

  private resolveEntranceLeader(
    input: EntrancePolicyLeaderInput | undefined,
    label: string
  ): EntrancePolicyDefinition["leader"] {
    if (input === undefined) return undefined;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be a JSON object`);
    return this.resolveEntranceWorkflowTarget(
      input.workflowId,
      input.workflowVersion,
      "supervisor",
      label
    ) as NonNullable<EntrancePolicyDefinition["leader"]>;
  }

  private normalizeEntrancePolicy(
    input: EntrancePolicyCreateInput | (EntrancePolicyUpdateInput & { id: string }),
    current?: EntrancePolicyDefinition
  ): EntrancePolicyDefinition {
    const id = requireId(input.id, "entrance policy id");
    const direct = input.direct === undefined
      ? current?.direct
      : input.direct === null
        ? undefined
        : this.resolveEntranceDirectRoute(input.direct, `entrance policy ${id} direct`);
    const specialists = input.specialists === undefined
      ? current?.specialists ?? {}
      : Object.fromEntries(Object.entries(input.specialists).map(([key, target]) => {
          const specialistKey = requireId(key, `entrance policy ${id} specialist key`);
          return [specialistKey, this.resolveEntranceSpecialistTarget(target, `entrance policy ${id} specialist ${specialistKey}`)];
        }));
    const leader = input.leader === undefined
      ? current?.leader
      : input.leader === null
        ? undefined
        : this.resolveEntranceLeader(input.leader, `entrance policy ${id} leader`);
    const rules = input.rules === undefined
      ? current?.rules ?? []
      : normalizeEntrancePolicyRules(input.rules, `entrance policy ${id} rules`);
    const defaultResult = input.default === undefined
      ? current?.default ?? (() => { throw new Error(`entrance policy ${id} default is required`); })()
      : normalizeEntrancePolicyRouteResult(input.default, `entrance policy ${id} default`);
    const timestamp = now();
    const policy: EntrancePolicyDefinition = {
      id,
      version: current ? current.version + 1 : 1,
      status: current?.status ?? "active",
      displayName: requireText(input.displayName ?? current?.displayName ?? id, "entrance policy displayName"),
      description: requireText(
        input.description ?? current?.description ?? `Task entrance policy ${id}.`,
        "entrance policy description"
      ),
      direct,
      specialists,
      leader,
      rules,
      default: defaultResult,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    resolveEntrancePolicyTarget(policy, policy.default);
    for (const rule of policy.rules) resolveEntrancePolicyTarget(policy, rule.result);
    return policy;
  }

  async createEntrancePolicy(input: EntrancePolicyCreateInput): Promise<EntrancePolicyDefinition> {
    const policy = this.normalizeEntrancePolicy(input);
    return this.store.mutate((state) => {
      if (state.entrancePolicies[policy.id]) throw new Error(`entrance policy already exists: ${policy.id}`);
      state.entrancePolicies[policy.id] = { current: policy, versions: [policy] };
      return policy;
    });
  }

  async updateEntrancePolicy(id: string, input: EntrancePolicyUpdateInput): Promise<EntrancePolicyDefinition> {
    const current = this.getEntrancePolicy(id);
    const policy = this.normalizeEntrancePolicy({ id, ...input }, current);
    return this.store.mutate((state) => {
      const record = state.entrancePolicies[id];
      if (!record) throw new Error(`entrance policy not found: ${id}`);
      record.current = policy;
      record.versions.push(policy);
      return policy;
    });
  }

  async archiveEntrancePolicy(id: string): Promise<EntrancePolicyDefinition> {
    return this.store.mutate((state) => {
      const record = state.entrancePolicies[id];
      if (!record) throw new Error(`entrance policy not found: ${id}`);
      if (record.current.status === "archived") return record.current;
      const archived = {
        ...record.current,
        status: "archived" as const,
        version: record.current.version + 1,
        updatedAt: now()
      };
      record.current = archived;
      record.versions.push(archived);
      return archived;
    });
  }

  async restoreEntrancePolicy(id: string): Promise<EntrancePolicyDefinition> {
    return this.store.mutate((state) => {
      const record = state.entrancePolicies[id];
      if (!record) throw new Error(`entrance policy not found: ${id}`);
      if (record.current.status === "active") return record.current;
      const restored = {
        ...record.current,
        status: "active" as const,
        version: record.current.version + 1,
        updatedAt: now()
      };
      record.current = restored;
      record.versions.push(restored);
      return restored;
    });
  }

  private entranceTargetWarnings(target: EntrancePolicyDecision["target"]): string[] {
    if (target.kind === "caller") return [];
    try {
      if (target.kind === "employee") {
        const current = this.getEmployee(target.employeeId);
        if (current.status !== "active") throw new Error(`employee ${target.employeeId} is archived`);
        const employee = this.getEmployee(target.employeeId, target.employeeVersion);
        if (employee.status !== "active") throw new Error(`employee ${target.employeeId} v${target.employeeVersion} is archived`);
      } else if (target.kind === "project-role") {
        const current = this.getProject(target.projectId);
        if (current.status !== "active") throw new Error(`project ${target.projectId} is archived`);
        const resolved = this.resolveProjectEmployee(
          target.projectId,
          target.roleId,
          target.projectVersion,
          target.projectBindingVersion
        );
        if (resolved.employee.id !== target.employeeId || resolved.employee.version !== target.employeeVersion) {
          throw new Error(`project role ${target.projectId}/${target.roleId} does not match the pinned Employee`);
        }
        if (this.getEmployee(target.employeeId).status !== "active") throw new Error(`employee ${target.employeeId} is archived`);
      } else {
        const current = this.getWorkflow(target.workflowId);
        if (current.status !== "active") throw new Error(`workflow ${target.workflowId} is archived`);
        const workflow = this.getWorkflow(target.workflowId, target.workflowVersion);
        const expected = target.kind === "graph-workflow" ? "graph" : "supervisor";
        if (workflow.architecture !== expected) {
          throw new Error(`workflow ${target.workflowId} no longer has expected architecture ${expected}`);
        }
        if (workflow.architecture === "supervisor") {
          const policy = this.getManagementPolicy(workflow.managementPolicy.id);
          if (policy.status !== "active") throw new Error(`management policy ${policy.id} is archived`);
          this.getManagementPolicy(workflow.managementPolicy.id, workflow.managementPolicy.version);
        }
        for (const employee of this.resolveWorkflowEmployees(workflow).values()) {
          if (this.getEmployee(employee.id).status !== "active") throw new Error(`employee ${employee.id} is archived`);
        }
      }
      return [];
    } catch (error) {
      return [`pinned entrance target is not executable: ${errorMessage(error)}`];
    }
  }

  evaluateEntrancePolicy(id: string, input: EntrancePolicyEvaluationInput): EntrancePolicyDecision {
    const policy = this.getEntrancePolicy(id);
    if (policy.status !== "active") throw new Error(`entrance policy ${id} is archived`);
    const parsed = parseEntrancePolicyEvaluationInput(input);
    const decision = evaluateEntrancePolicyDefinition(policy, parsed);
    const targetWarnings = this.entranceTargetWarnings(decision.target);
    return {
      ...decision,
      executable: decision.executable && targetWarnings.length === 0,
      warnings: [...decision.warnings, ...targetWarnings]
    };
  }

  private entranceExecutionSnapshot(decision: EntrancePolicyDecision): EntrancePolicyExecutionSnapshot {
    return {
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      result: decision.result,
      decidedBy: decision.decidedBy,
      target: decision.target
    };
  }

  async dispatchEntrancePolicy(
    id: string,
    input: EntrancePolicyDispatchInput,
    options: { providerCwd?: string } = {}
  ): Promise<EntrancePolicyDispatchResult> {
    const parsed = parseEntrancePolicyDispatchInput(input);
    const { message: dispatchMessage, sessionId, ...evaluationInput } = parsed;
    const decision = this.evaluateEntrancePolicy(id, evaluationInput);
    if (decision.target.kind === "caller") {
      return { decision, dispatch: { kind: "return-to-caller", invocationCreated: false } };
    }
    if (!decision.executable) {
      throw new Error(`entrance policy ${id} target is not executable: ${decision.warnings.join("; ")}`);
    }
    const message = requireText(dispatchMessage ?? "", "entrance policy dispatch message");
    const entrance = this.entranceExecutionSnapshot(decision);
    if (decision.target.kind === "employee") {
      const result = await this.invokePinnedEmployee(
        decision.target.employeeId,
        decision.target.employeeVersion,
        { message, sessionId },
        parsed.source,
        entrance,
        options.providerCwd
      );
      return { decision, dispatch: { kind: "employee", result } };
    }
    if (decision.target.kind === "project-role") {
      const result = await this.invokePinnedProjectRole(
        decision.target,
        { message, sessionId },
        parsed.source,
        entrance
      );
      return { decision, dispatch: { kind: "project-role", result } };
    }
    const receipt = await this.startWorkbenchWorkflow(
      decision.target.workflowId,
      { message },
      parsed.source,
      { workflowVersion: decision.target.workflowVersion, entrance, providerCwd: options.providerCwd }
    );
    return { decision, dispatch: { kind: "invocation-started", receipt } };
  }

  listManagementPolicies(includeArchived = false): ManagementPolicyDefinition[] {
    return Object.values(this.snapshot().managementPolicies)
      .map((record) => record.current)
      .filter((policy) => includeArchived || policy.status === "active")
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  getManagementPolicy(id: string, version?: number): ManagementPolicyDefinition {
    const record = this.snapshot().managementPolicies[id];
    if (!record) throw new Error(`management policy not found: ${id}`);
    if (version === undefined) return record.current;
    const found = record.versions.find((candidate) => candidate.version === version);
    if (!found) throw new Error(`management policy ${id} version ${version} not found`);
    return found;
  }

  getManagementPolicyVersions(id: string): ManagementPolicyDefinition[] {
    const record = this.snapshot().managementPolicies[id];
    if (!record) throw new Error(`management policy not found: ${id}`);
    return [...record.versions].sort((left, right) => right.version - left.version);
  }

  private normalizeManagementPolicy(
    input: ManagementPolicyCreateInput,
    current?: ManagementPolicyDefinition
  ): ManagementPolicyDefinition {
    const id = requireId(input.id, "management policy id");
    const allowedRoleIds = [...new Set(input.allowedRoleIds.map((roleId) => requireId(roleId, "management policy role id")))];
    if (allowedRoleIds.length === 0) throw new Error(`management policy ${id} must allow at least one member role`);
    // maxDurationMs: null explicitly clears the ceiling; undefined inherits the current value.
    const maxDurationMs = input.limits?.maxDurationMs === null
      ? undefined
      : input.limits?.maxDurationMs ?? current?.limits.maxDurationMs;
    const limits: ManagementPolicyLimits = {
      maxRounds: input.limits?.maxRounds ?? current?.limits.maxRounds ?? 6,
      maxDelegations: input.limits?.maxDelegations ?? current?.limits.maxDelegations ?? 12,
      maxParallelDelegations: input.limits?.maxParallelDelegations ?? current?.limits.maxParallelDelegations ?? 3,
      // Optional: omitted = unbounded (progress-based). A value acts as an absolute safety ceiling.
      ...(maxDurationMs === undefined ? {} : { maxDurationMs })
    };
    const bounds: Array<[keyof typeof limits, number, number]> = [
      ["maxRounds", 1, 32],
      ["maxDelegations", 1, 256],
      ["maxParallelDelegations", 1, 32],
      ...(limits.maxDurationMs === undefined ? [] : [["maxDurationMs", 1_000, 86_400_000] as [keyof typeof limits, number, number]])
    ];
    for (const [key, minimum, maximum] of bounds) {
      const value = limits[key];
      if (value === undefined || !Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`management policy ${key} must be an integer between ${minimum} and ${maximum}`);
      }
    }
    if (limits.maxParallelDelegations > limits.maxDelegations) {
      throw new Error("management policy maxParallelDelegations cannot exceed maxDelegations");
    }
    const workerFailure = input.failure?.workerFailure ?? current?.failure.workerFailure ?? "observe-and-replan";
    if (workerFailure !== "observe-and-replan" && workerFailure !== "fail-fast") {
      throw new Error(`management policy workerFailure is invalid: ${String(workerFailure)}`);
    }
    // execution: undefined inherits the current value; a provided value replaces it and is validated.
    const executionInput = input.execution === undefined ? current?.execution : input.execution;
    let execution: ManagementPolicyExecution | undefined;
    if (executionInput !== undefined) {
      const isolation = executionInput.isolation;
      if (isolation !== undefined && isolation !== "worktree" && isolation !== "none") {
        throw new Error(`management policy execution.isolation is invalid: ${String(isolation)}`);
      }
      execution = isolation === undefined ? {} : { isolation };
    }
    const timestamp = now();
    return {
      id,
      version: current ? current.version + 1 : 1,
      status: current?.status ?? "active",
      displayName: requireText(input.displayName ?? current?.displayName ?? id, "management policy displayName"),
      description: requireText(input.description ?? current?.description ?? `Management policy ${id}.`, "management policy description"),
      allowedRoleIds,
      instructions: requireText(input.instructions, "management policy instructions"),
      limits,
      failure: { workerFailure },
      completion: {
        requireDelegation: input.completion?.requireDelegation ?? current?.completion.requireDelegation ?? false,
        requireAllDelegationsSuccessful:
          input.completion?.requireAllDelegationsSuccessful
          ?? current?.completion.requireAllDelegationsSuccessful
          ?? false
      },
      ...(execution === undefined ? {} : { execution }),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
  }

  async createManagementPolicy(input: ManagementPolicyCreateInput): Promise<ManagementPolicyDefinition> {
    const policy = this.normalizeManagementPolicy(input);
    return this.store.mutate((state) => {
      if (state.managementPolicies[policy.id]) throw new Error(`management policy already exists: ${policy.id}`);
      state.managementPolicies[policy.id] = { current: policy, versions: [policy] };
      return policy;
    });
  }

  async updateManagementPolicy(id: string, input: ManagementPolicyUpdateInput): Promise<ManagementPolicyDefinition> {
    const current = this.getManagementPolicy(id);
    const policy = this.normalizeManagementPolicy({
      id,
      displayName: input.displayName ?? current.displayName,
      description: input.description ?? current.description,
      allowedRoleIds: input.allowedRoleIds ?? current.allowedRoleIds,
      instructions: input.instructions ?? current.instructions,
      limits: input.limits ?? current.limits,
      failure: input.failure ?? current.failure,
      completion: input.completion ?? current.completion,
      execution: input.execution ?? current.execution
    }, current);
    return this.store.mutate((state) => {
      const record = state.managementPolicies[id];
      if (!record) throw new Error(`management policy not found: ${id}`);
      record.current = policy;
      record.versions.push(policy);
      return policy;
    });
  }

  async archiveManagementPolicy(id: string): Promise<ManagementPolicyDefinition> {
    const references = this.listWorkflows().filter(
      (workflow): workflow is SupervisorWorkbenchWorkflowDefinition =>
        workflow.architecture === "supervisor" && workflow.managementPolicy.id === id
    );
    if (references.length > 0) {
      throw new Error(`management policy ${id} is used by active workflows: ${references.map((workflow) => workflow.id).join(", ")}`);
    }
    return this.store.mutate((state) => {
      const record = state.managementPolicies[id];
      if (!record) throw new Error(`management policy not found: ${id}`);
      if (record.current.status === "archived") return record.current;
      const archived = { ...record.current, status: "archived" as const, version: record.current.version + 1, updatedAt: now() };
      record.current = archived;
      record.versions.push(archived);
      return archived;
    });
  }

  async restoreManagementPolicy(id: string): Promise<ManagementPolicyDefinition> {
    return this.store.mutate((state) => {
      const record = state.managementPolicies[id];
      if (!record) throw new Error(`management policy not found: ${id}`);
      if (record.current.status === "active") return record.current;
      const restored = { ...record.current, status: "active" as const, version: record.current.version + 1, updatedAt: now() };
      record.current = restored;
      record.versions.push(restored);
      return restored;
    });
  }

  listWorkflows(includeArchived = false): WorkbenchWorkflowDefinition[] {
    return Object.values(this.snapshot().workflows)
      .map((record) => record.current)
      .filter((workflow) => includeArchived || workflow.status === "active")
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getWorkflow(id: string, version?: number): WorkbenchWorkflowDefinition {
    const record = this.snapshot().workflows[id];
    if (!record) throw new Error(`workflow not found: ${id}`);
    if (version === undefined) return record.current;
    const found = record.versions.find((candidate) => candidate.version === version);
    if (!found) throw new Error(`workflow ${id} version ${version} not found`);
    return found;
  }

  getWorkflowVersions(id: string): WorkbenchWorkflowDefinition[] {
    const record = this.snapshot().workflows[id];
    if (!record) throw new Error(`workflow not found: ${id}`);
    return [...record.versions].sort((left, right) => right.version - left.version);
  }

  private normalizeGraphWorkflow(
    input: GraphWorkflowCreateInput,
    current?: GraphWorkbenchWorkflowDefinition
  ): GraphWorkbenchWorkflowDefinition {
    const id = requireId(input.id, "workflow id");
    if (input.nodes.length === 0) throw new Error("workflow nodes must not be empty");
    const state = this.snapshot();
    const nodeIds = new Set<string>();
    const nodes = input.nodes.map((node) => {
      requireId(node.id, "workflow node id");
      if (nodeIds.has(node.id)) throw new Error(`duplicate workflow node ${node.id}`);
      nodeIds.add(node.id);
      const employee = employeeVersion(
        state.employees[node.employeeId] ?? (() => { throw new Error(`employee not found: ${node.employeeId}`); })(),
        node.employeeVersion
      );
      if (state.employees[node.employeeId]?.current.status !== "active") throw new Error(`employee ${employee.id} is archived`);
      const scopedProjectId = internalProjectId(employee);
      if (scopedProjectId) {
        throw new Error(
          `employee ${employee.id} is internal to project ${scopedProjectId} and cannot be used in a global workflow`
        );
      }
      return {
        id: node.id,
        employeeId: node.employeeId,
        employeeVersion: node.employeeVersion ?? employee.version,
        needs: node.needs ?? [],
        with: node.with ?? {}
      };
    });
    const timestamp = now();
    const presentationInput = input.presentation ?? current?.presentation;
    const positions = normalizeWorkflowPositions(presentationInput?.positions, nodeIds);
    const patternId = input.patternId ?? current?.patternId;
    if (patternId) requireId(patternId, "workflow pattern id");
    return {
      id,
      version: current ? current.version + 1 : 1,
      status: current?.status ?? "active",
      architecture: "graph",
      patternId,
      description: input.description?.trim() || `Graph workflow ${id}`,
      nodes,
      maxConcurrency: Math.max(1, Math.min(32, input.maxConcurrency ?? current?.maxConcurrency ?? 4)),
      failFast: input.failFast ?? current?.failFast ?? false,
      inputSchema: input.inputSchema ?? current?.inputSchema,
      presentation: positions ? { positions } : undefined,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
  }

  private normalizeSupervisorWorkflow(
    input: SupervisorWorkflowCreateInput,
    current?: SupervisorWorkbenchWorkflowDefinition,
    options: { refreshOrchestrationSkill?: boolean } = {}
  ): SupervisorWorkbenchWorkflowDefinition {
    const id = requireId(input.id, "workflow id");
    const state = this.snapshot();
    const resolveEmployee = (employeeId: string, requestedVersion: number | undefined, label: string): EmployeeDefinition => {
      const record = state.employees[employeeId];
      if (!record) throw new Error(`employee not found: ${employeeId}`);
      if (record.current.status !== "active") throw new Error(`${label} employee ${employeeId} is archived`);
      const employee = employeeVersion(record, requestedVersion);
      const scopedProjectId = internalProjectId(employee);
      if (scopedProjectId) {
        throw new Error(`employee ${employee.id} is internal to project ${scopedProjectId} and cannot be used in a global workflow`);
      }
      return employee;
    };
    const supervisor = resolveEmployee(input.supervisor.employeeId, input.supervisor.employeeVersion, "supervisor");
    const orchestrationSkill = state.skills["team-orchestration"];
    if (
      !orchestrationSkill
      || orchestrationSkill.status !== "active"
      || orchestrationSkill.owner !== "system"
      || orchestrationSkill.injection !== "supervisor"
    ) {
      throw new Error("system supervisor Skill team-orchestration is unavailable");
    }
    const policyRecord = state.managementPolicies[input.managementPolicy.id];
    if (!policyRecord) throw new Error(`management policy not found: ${input.managementPolicy.id}`);
    if (policyRecord.current.status !== "active") throw new Error(`management policy ${input.managementPolicy.id} is archived`);
    const policy = input.managementPolicy.version === undefined
      ? policyRecord.current
      : policyRecord.versions.find((candidate) => candidate.version === input.managementPolicy.version);
    if (!policy) throw new Error(`management policy ${input.managementPolicy.id} version ${input.managementPolicy.version} not found`);
    const seen = new Set<string>();
    const allowed = new Set(policy.allowedRoleIds);
    const members = input.members.map((member) => {
      const roleId = requireId(member.roleId, "supervisor member role id");
      if (seen.has(roleId)) throw new Error(`duplicate supervisor member role ${roleId}`);
      seen.add(roleId);
      if (!allowed.has(roleId)) {
        throw new Error(`supervisor member role ${roleId} is not allowed by management policy ${policy.id} v${policy.version}`);
      }
      const employee = resolveEmployee(member.employeeId, member.employeeVersion, `member ${roleId}`);
      return {
        roleId,
        description: requireText(member.description ?? `Delegated ${roleId} work.`, `supervisor member ${roleId} description`),
        employeeId: employee.id,
        employeeVersion: employee.version
      };
    });
    if (members.length === 0) throw new Error("supervisor workflow members must not be empty");
    const timestamp = now();
    const flow = normalizeSupervisorFlow(input.flow, current?.flow, new Set(members.map((member) => member.roleId)));
    const positions = flow.dag
      ? normalizeWorkflowPositions(
          (input.presentation ?? current?.presentation)?.positions,
          new Set(flow.dag.nodes.map((node) => node.nodeId))
        )
      : undefined;
    return {
      id,
      version: current ? current.version + 1 : 1,
      status: current?.status ?? "active",
      architecture: "supervisor",
      updatePolicy: input.updatePolicy ?? current?.updatePolicy ?? "latest",
      description: input.description?.trim() || `Supervisor workflow ${id}`,
      supervisor: { employeeId: supervisor.id, employeeVersion: supervisor.version },
      orchestrationSkill: current && !options.refreshOrchestrationSkill ? current.orchestrationSkill : {
        id: "team-orchestration",
        version: orchestrationSkill.version
      },
      managementPolicy: { id: policy.id, version: policy.version },
      members,
      flow,
      inputSchema: input.inputSchema ?? current?.inputSchema,
      presentation: positions ? { positions } : undefined,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
  }

  private normalizeWorkflow(
    input: WorkflowCreateInput,
    current?: WorkbenchWorkflowDefinition,
    options: { refreshOrchestrationSkill?: boolean } = {}
  ): WorkbenchWorkflowDefinition {
    const architecture = input.architecture ?? current?.architecture ?? "graph";
    if (current && architecture !== current.architecture) {
      throw new Error(`workflow architecture cannot change from ${current.architecture} to ${architecture}`);
    }
    if (architecture === "supervisor") {
      return this.normalizeSupervisorWorkflow(
        input as SupervisorWorkflowCreateInput,
        current as SupervisorWorkbenchWorkflowDefinition | undefined,
        options
      );
    }
    return this.normalizeGraphWorkflow(
      input as GraphWorkflowCreateInput,
      current as GraphWorkbenchWorkflowDefinition | undefined
    );
  }

  async createWorkflow(input: GraphWorkflowCreateInput): Promise<GraphWorkbenchWorkflowDefinition>;
  async createWorkflow(input: SupervisorWorkflowCreateInput): Promise<SupervisorWorkbenchWorkflowDefinition>;
  async createWorkflow(input: WorkflowCreateInput): Promise<WorkbenchWorkflowDefinition>;
  async createWorkflow(input: WorkflowCreateInput): Promise<WorkbenchWorkflowDefinition> {
    const workflow = this.normalizeWorkflow(input);
    await this.validateWorkflow(workflow);
    return this.store.mutate((state) => {
      if (state.workflows[workflow.id]) throw new Error(`workflow already exists: ${workflow.id}`);
      state.workflows[workflow.id] = { current: workflow, versions: [workflow] };
      return workflow;
    });
  }

  async updateWorkflow(
    id: string,
    input: WorkflowUpdateInput,
    options: { refreshOrchestrationSkill?: boolean } = {}
  ): Promise<WorkbenchWorkflowDefinition> {
    const current = this.getWorkflow(id);
    if (input.architecture && input.architecture !== current.architecture) {
      throw new Error(`workflow architecture cannot change from ${current.architecture} to ${input.architecture}`);
    }
    const workflow = current.architecture === "graph"
      ? this.normalizeWorkflow({
          id,
          architecture: "graph",
          description: input.description ?? current.description,
          nodes: "nodes" in input && input.nodes ? input.nodes : current.nodes,
          maxConcurrency: "maxConcurrency" in input ? input.maxConcurrency ?? current.maxConcurrency : current.maxConcurrency,
          failFast: "failFast" in input ? input.failFast ?? current.failFast : current.failFast,
          inputSchema: input.inputSchema ?? current.inputSchema,
          patternId: "patternId" in input ? input.patternId ?? current.patternId : current.patternId,
          presentation: input.presentation ?? current.presentation
        }, current)
      : this.normalizeWorkflow({
          id,
          architecture: "supervisor",
          updatePolicy: "updatePolicy" in input && input.updatePolicy
            ? input.updatePolicy
            : current.architecture === "supervisor" ? current.updatePolicy : undefined,
          description: input.description ?? current.description,
          supervisor: "supervisor" in input && input.supervisor ? input.supervisor : current.supervisor,
          managementPolicy:
            "managementPolicy" in input && input.managementPolicy ? input.managementPolicy : current.managementPolicy,
          members: "members" in input && input.members ? input.members : current.members,
          flow: "flow" in input ? input.flow : undefined,
          inputSchema: input.inputSchema ?? current.inputSchema,
          presentation: input.presentation ?? current.presentation
        }, current, options);
    await this.validateWorkflow(workflow);
    return this.store.mutate((state) => {
      const record = state.workflows[id];
      if (!record) throw new Error(`workflow not found: ${id}`);
      record.current = workflow;
      record.versions.push(workflow);
      return workflow;
    });
  }

  /**
   * Re-pin a supervisor workflow's sources (supervisor, members, management policy, orchestration
   * skill) to their newest active versions and, when anything changed, persist a new workflow
   * version. Works regardless of updatePolicy — the explicit "sync to latest" action. Returns the
   * per-source changes so the UI can show what moved.
   */
  async refreshWorkflow(id: string): Promise<WorkflowRefreshResult> {
    const current = this.getWorkflow(id);
    if (current.architecture !== "supervisor") throw new Error(`workflow ${id} is not a supervisor workflow`);
    const state = this.snapshot();
    const changes: WorkflowRefreshChange[] = [];

    const supervisorRecord = state.employees[current.supervisor.employeeId];
    if (!supervisorRecord || supervisorRecord.current.status !== "active") {
      throw new Error(`supervisor employee ${current.supervisor.employeeId} is unavailable; cannot sync`);
    }
    const policyRecord = state.managementPolicies[current.managementPolicy.id];
    if (!policyRecord || policyRecord.current.status !== "active") {
      throw new Error(`management policy ${current.managementPolicy.id} is unavailable; cannot sync`);
    }
    const skillRecord = state.skills[current.orchestrationSkill.id];
    if (!skillRecord) throw new Error(`orchestration skill ${current.orchestrationSkill.id} is unavailable; cannot sync`);

    const latestPolicy = policyRecord.current;
    const allowed = new Set(latestPolicy.allowedRoleIds);
    for (const member of current.members) {
      if (!allowed.has(member.roleId)) {
        throw new Error(
          `management policy ${latestPolicy.id} v${latestPolicy.version} no longer allows member role ${member.roleId}; `
          + `adjust the member roster to the latest policy's roles (${latestPolicy.allowedRoleIds.join(", ")}) before syncing`
        );
      }
    }

    if (supervisorRecord.current.version !== current.supervisor.employeeVersion) {
      changes.push({ kind: "supervisor", id: current.supervisor.employeeId, from: current.supervisor.employeeVersion, to: supervisorRecord.current.version });
    }
    if (latestPolicy.version !== current.managementPolicy.version) {
      changes.push({ kind: "management-policy", id: latestPolicy.id, from: current.managementPolicy.version, to: latestPolicy.version });
    }
    if (skillRecord.version !== current.orchestrationSkill.version) {
      changes.push({ kind: "orchestration-skill", id: current.orchestrationSkill.id, from: current.orchestrationSkill.version, to: skillRecord.version });
    }
    for (const member of current.members) {
      const record = state.employees[member.employeeId];
      if (record && record.current.status === "active" && record.current.version !== member.employeeVersion) {
        changes.push({ kind: "member", id: member.employeeId, from: member.employeeVersion, to: record.current.version });
      }
    }

    if (changes.length === 0) return { workflow: current, changed: false, changes: [] };

    const updated = await this.updateWorkflow(id, {
      architecture: "supervisor",
      supervisor: { employeeId: current.supervisor.employeeId },
      managementPolicy: { id: current.managementPolicy.id },
      members: current.members.map((member) => ({ roleId: member.roleId, description: member.description, employeeId: member.employeeId }))
      // flow omitted → normalizeSupervisorFlow inherits the current flow unchanged.
    }, { refreshOrchestrationSkill: true });
    if (updated.architecture !== "supervisor") throw new Error("expected supervisor workflow after refresh");
    return { workflow: updated, changed: true, changes };
  }

  /**
   * Create a new version of every active Entrance Policy whose leader target still pins an older
   * version of this Supervisor Workflow. The operation is explicit and version-preserving: policy
   * history remains auditable, while a second call is idempotent once every reference is current.
   */
  async refreshWorkflowEntrancePolicies(id: string): Promise<WorkflowEntrancePolicyRefreshResult> {
    const workflow = this.getWorkflow(id);
    if (workflow.architecture !== "supervisor") throw new Error(`workflow ${id} is not a supervisor workflow`);
    if (workflow.status !== "active") throw new Error(`workflow ${id} is archived; cannot refresh Entrance Policy references`);
    const stale = this.listEntrancePolicies().filter((policy) => (
      policy.leader?.workflowId === workflow.id
      && policy.leader.workflowVersion !== workflow.version
    ));
    if (stale.length === 0) {
      return { workflowId: workflow.id, workflowVersion: workflow.version, changed: false, changes: [] };
    }

    // Resolve and validate every replacement before mutating persistence, so one invalid policy
    // cannot leave a partially refreshed group behind.
    const replacements = stale.map((policy) => ({
      previous: policy,
      next: this.normalizeEntrancePolicy({
        id: policy.id,
        leader: { workflowId: workflow.id }
      }, policy)
    }));
    await this.store.mutate((state) => {
      for (const replacement of replacements) {
        const record = state.entrancePolicies[replacement.previous.id];
        if (!record) throw new Error(`entrance policy not found: ${replacement.previous.id}`);
        if (record.current.version !== replacement.previous.version) {
          throw new Error(`entrance policy ${replacement.previous.id} changed while references were being refreshed; retry`);
        }
      }
      for (const replacement of replacements) {
        const record = state.entrancePolicies[replacement.previous.id]!;
        record.current = replacement.next;
        record.versions.push(replacement.next);
      }
    });
    return {
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      changed: true,
      changes: replacements.map(({ previous, next }) => ({
        policyId: previous.id,
        fromPolicyVersion: previous.version,
        toPolicyVersion: next.version,
        fromWorkflowVersion: previous.leader!.workflowVersion,
        toWorkflowVersion: next.leader!.workflowVersion
      }))
    };
  }

  private resolveWorkflowEmployees(workflow: WorkbenchWorkflowDefinition): Map<string, EmployeeDefinition> {
    const employees = new Map<string, EmployeeDefinition>();
    if (workflow.architecture === "graph") {
      for (const node of workflow.nodes) {
        const employee = this.getEmployee(node.employeeId, node.employeeVersion);
        const existing = employees.get(employee.id);
        if (existing && existing.version !== employee.version) {
          throw new Error(`workflow cannot use two versions of employee ${employee.id} in v1`);
        }
        employees.set(employee.id, employee);
      }
      return employees;
    }
    employees.set(
      SUPERVISOR_RUNTIME_ROLE_ID,
      this.getEmployee(workflow.supervisor.employeeId, workflow.supervisor.employeeVersion)
    );
    for (const member of workflow.members) {
      employees.set(
        supervisorMemberRuntimeRoleId(member.roleId),
        this.getEmployee(member.employeeId, member.employeeVersion)
      );
    }
    return employees;
  }

  private async validateWorkflow(workflow: WorkbenchWorkflowDefinition): Promise<void> {
    const materialized = await this.materialize(workflow, this.resolveWorkflowEmployees(workflow));
    compilePlan(materialized.loaded, materialized.workflowId, this.architectures);
  }

  async planWorkflow(id: string): Promise<ReturnType<typeof compilePlan>> {
    const workflow = this.getWorkflow(id);
    const materialized = await this.materialize(workflow, this.resolveWorkflowEmployees(workflow));
    return compilePlan(materialized.loaded, materialized.workflowId, this.architectures);
  }

  async runWorkbenchWorkflow(
    id: string,
    input: JsonObject = {},
    source: InvocationSource = { kind: "workbench" },
    options: { providerCwd?: string } = {}
  ): Promise<RunWorkflowResult> {
    const providerCwd = await this.workflowExecutionRoot(source, options.providerCwd);
    const prepared = await this.prepareWorkbenchWorkflowInvocation(id, input, source);
    return this.runTrackedWorkflow(prepared.invocation, prepared.workflow, prepared.employees, input, providerCwd);
  }

  /**
   * For a "latest" supervisor workflow, return an in-memory copy whose pinned versions are
   * re-resolved to the newest active versions (supervisor, members, management policy,
   * orchestration skill). This copy drives a single run only — it is not persisted, so run
   * evidence still records the versions actually used. "locked" workflows are returned unchanged.
   * Throws when the latest policy no longer allows a member role slot, so the caller can surface a
   * clear "sync members" message instead of silently dropping members.
   */
  private resolveWorkflowForRun(workflow: WorkbenchWorkflowDefinition): WorkbenchWorkflowDefinition {
    if (workflow.architecture !== "supervisor" || workflow.updatePolicy !== "latest") return workflow;
    const state = this.snapshot();
    const supervisorRecord = state.employees[workflow.supervisor.employeeId];
    const policyRecord = state.managementPolicies[workflow.managementPolicy.id];
    const skillRecord = state.skills[workflow.orchestrationSkill.id];
    // Missing/archived sources are validated downstream with their own errors; keep pins as-is here.
    if (!supervisorRecord || !policyRecord || !skillRecord) return workflow;
    const latestPolicy = policyRecord.current;
    const allowed = new Set(latestPolicy.allowedRoleIds);
    for (const member of workflow.members) {
      if (!allowed.has(member.roleId)) {
        throw new Error(
          `management policy ${latestPolicy.id} v${latestPolicy.version} no longer allows member role ${member.roleId}; `
          + `sync this workflow's members to the latest policy (allowed roles: ${latestPolicy.allowedRoleIds.join(", ")})`
        );
      }
    }
    return {
      ...workflow,
      supervisor: { employeeId: workflow.supervisor.employeeId, employeeVersion: supervisorRecord.current.version },
      orchestrationSkill: { id: workflow.orchestrationSkill.id, version: skillRecord.version },
      managementPolicy: { id: latestPolicy.id, version: latestPolicy.version },
      members: workflow.members.map((member) => {
        const record = state.employees[member.employeeId];
        return record ? { ...member, employeeVersion: record.current.version } : member;
      })
    };
  }

  private async prepareWorkbenchWorkflowInvocation(
    id: string,
    input: JsonObject,
    source: InvocationSource,
    options: { workflowVersion?: number; entrance?: EntrancePolicyExecutionSnapshot; createLeaderSession?: boolean } = {}
  ): Promise<{
    invocation: InvocationRecord;
    workflow: WorkbenchWorkflowDefinition;
    employees: Map<string, EmployeeDefinition>;
  }> {
    const currentWorkflow = this.getWorkflow(id);
    if (currentWorkflow.status !== "active") throw new Error(`workflow ${id} is archived`);
    // "latest" workflows re-resolve their pinned versions to newest before the run; a specific
    // workflowVersion pin (e.g. from an entrance policy) opts out and runs exactly as recorded.
    const workflow = options.workflowVersion === undefined
      ? this.resolveWorkflowForRun(this.getWorkflow(id))
      : this.getWorkflow(id, options.workflowVersion);
    if (workflow.status !== "active") throw new Error(`workflow ${id} v${workflow.version} is archived`);
    if (workflow.architecture === "supervisor") {
      const currentPolicy = this.getManagementPolicy(workflow.managementPolicy.id);
      if (currentPolicy.status !== "active") {
        throw new Error(`management policy ${workflow.managementPolicy.id} is archived`);
      }
      this.getManagementPolicy(workflow.managementPolicy.id, workflow.managementPolicy.version);
    }
    // Revalidate the exact run-time pins before creating an Invocation. This is especially
    // important for updatePolicy=latest: a newly worktree-isolated policy must not make an older
    // workflow executable until its mandatory quality.test and quality.audit Gates are present.
    await this.validateWorkflow(workflow);
    const employees = this.resolveWorkflowEmployees(workflow);
    for (const employee of employees.values()) {
      if (this.getEmployee(employee.id).status !== "active") throw new Error(`employee ${employee.id} is archived`);
      const scopedProjectId = internalProjectId(employee);
      if (scopedProjectId) {
        throw new Error(
          `employee ${employee.id} is internal to project ${scopedProjectId} and cannot run in a global workflow`
        );
      }
    }
    const invocation = await this.createInvocationActivity({
      target: { kind: "workflow", id: workflow.id, version: workflow.version },
      source,
      workflow,
      employees,
      input,
      createLeaderSession: options.createLeaderSession,
      entrance: options.entrance
    });
    return { invocation, workflow, employees };
  }

  private async workflowInvocationReceipt(invocation: InvocationRecord): Promise<InvocationStartResult> {
    const initialCursor = invocationProgressCursor(await this.getInvocationProgress(invocation.id));
    return {
      invocation,
      runId: invocation.runId,
      ...(invocation.executionSnapshot?.workflow.architecture === "supervisor" && invocation.sessionId
        ? { leaderSessionId: invocation.sessionId }
        : {}),
      monitor: {
        mode: "long-poll",
        tool: "wait_workflow_progress",
        initialCursor,
        defaultTimeoutMs: WORKFLOW_PROGRESS_DEFAULT_TIMEOUT_MS,
        maxTimeoutMs: WORKFLOW_PROGRESS_MAX_TIMEOUT_MS,
        instructions: "启动后立即用 initialCursor 循环调用 wait_workflow_progress；非终态不要结束当前回合，每次变化或心跳都向用户汇报，终态交付最终摘要。"
      }
    };
  }

  private async startWorkbenchWorkflowOnce(
    id: string,
    input: JsonObject = {},
    source: InvocationSource = { kind: "workbench" },
    options: { workflowVersion?: number; entrance?: EntrancePolicyExecutionSnapshot; providerCwd?: string } = {}
  ): Promise<InvocationStartResult> {
    const providerCwd = await this.workflowExecutionRoot(source, options.providerCwd);
    const prepared = await this.prepareWorkbenchWorkflowInvocation(id, input, source, {
      ...options,
      createLeaderSession: true
    });
    const execution = this.runTrackedWorkflow(prepared.invocation, prepared.workflow, prepared.employees, input, providerCwd);
    const settled = execution.then(() => undefined, () => undefined);
    this.backgroundInvocations.set(prepared.invocation.id, settled);
    void settled.finally(() => {
      if (this.backgroundInvocations.get(prepared.invocation.id) === settled) {
        this.backgroundInvocations.delete(prepared.invocation.id);
      }
    });
    return this.workflowInvocationReceipt(prepared.invocation);
  }

  async startWorkbenchWorkflow(
    id: string,
    input: JsonObject = {},
    source: InvocationSource = { kind: "workbench" },
    options: { workflowVersion?: number; entrance?: EntrancePolicyExecutionSnapshot; providerCwd?: string } = {}
  ): Promise<InvocationStartResult> {
    const idempotencyKey = source.idempotencyKey?.trim();
    if (!idempotencyKey) return this.startWorkbenchWorkflowOnce(id, input, source, options);

    const existing = Object.values(this.snapshot().invocations)
      .find((candidate) => candidate.source.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.target.kind !== "workflow" || existing.target.id !== id
        || (options.workflowVersion !== undefined && existing.target.version !== options.workflowVersion)
        || existing.source.taskId !== source.taskId
        || existing.source.project !== source.project) {
        throw new Error(`idempotency key ${idempotencyKey} is already bound to another workflow Invocation`);
      }
      return this.workflowInvocationReceipt(existing);
    }

    const pending = this.idempotentWorkflowStarts.get(idempotencyKey);
    if (pending) return pending;
    const started = this.startWorkbenchWorkflowOnce(id, input, { ...source, idempotencyKey }, options);
    this.idempotentWorkflowStarts.set(idempotencyKey, started);
    try {
      return await started;
    } finally {
      if (this.idempotentWorkflowStarts.get(idempotencyKey) === started) {
        this.idempotentWorkflowStarts.delete(idempotencyKey);
      }
    }
  }

  /**
   * Start a Workflow through its stable Publication boundary without falling back to the
   * synchronous compatibility path. Employee Publications remain conversational and must use
   * invokePublication instead.
   */
  async startPublication(
    id: string,
    input: JsonObject = {},
    source: InvocationSource = { kind: "http" },
    options: { providerCwd?: string } = {}
  ): Promise<InvocationStartResult> {
    const publication = this.getPublication(id);
    if (publication.status !== "active") throw new Error(`publication ${id} is archived`);
    if (publication.target.kind !== "workflow") {
      throw new Error(`publication ${id} targets an Employee; use invoke_publication instead`);
    }
    return this.startWorkbenchWorkflow(
      publication.target.id,
      input,
      { ...source, publicationId: id },
      options
    );
  }

  /** Return a fresh long-poll receipt for a durable Workflow Invocation identified by Run id. */
  async resumeWorkflowMonitor(runId: string): Promise<InvocationStartResult> {
    if (!/^run-[A-Za-z0-9-]+$/.test(runId)) throw new Error("run id is invalid");
    const invocation = Object.values(this.snapshot().invocations)
      .find((candidate) => candidate.runId === runId);
    if (!invocation) throw new Error(`workflow Invocation not found for Run: ${runId}`);
    if (invocation.target.kind !== "workflow") {
      throw new Error(`Run ${runId} belongs to an Employee Invocation and has no Workflow monitor`);
    }
    return this.workflowInvocationReceipt(invocation);
  }

  async archiveWorkflow(id: string): Promise<WorkbenchWorkflowDefinition> {
    return this.store.mutate((state) => {
      const record = state.workflows[id];
      if (!record) throw new Error(`workflow not found: ${id}`);
      if (record.current.status === "archived") return record.current;
      const archived = { ...record.current, status: "archived" as const, version: record.current.version + 1, updatedAt: now() };
      record.current = archived;
      record.versions.push(archived);
      return archived;
    });
  }

  listPublications(includeArchived = false): PublicationDefinition[] {
    return Object.values(this.snapshot().publications)
      .filter((publication) => includeArchived || publication.status === "active")
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getPublication(id: string): PublicationDefinition {
    const publication = this.snapshot().publications[id];
    if (!publication) throw new Error(`publication not found: ${id}`);
    return publication;
  }

  async createPublication(input: {
    id: string;
    name: string;
    description?: string;
    target: PublicationDefinition["target"];
  }): Promise<PublicationDefinition> {
    requireId(input.id, "publication id");
    const target = input.target.kind === "employee" ? this.getEmployee(input.target.id) : this.getWorkflow(input.target.id);
    if (target.status !== "active") throw new Error(`${input.target.kind} ${input.target.id} is archived`);
    if (input.target.kind === "employee") {
      if (isSystemEmployee(target as EmployeeDefinition)) {
        throw new Error(`员工 ${(target as EmployeeDefinition).id} 是系统员工（systemRole=${(target as EmployeeDefinition).systemRole}），不允许对外发布`);
      }
      if (internalProjectId(target as EmployeeDefinition)) {
        throw new Error(`employee ${input.target.id} is project-internal and cannot be published directly`);
      }
    } else {
      for (const member of this.resolveWorkflowEmployees(target as WorkbenchWorkflowDefinition).values()) {
        if (isSystemEmployee(member)) {
          throw new Error(`工作流 ${input.target.id} 含系统员工 ${member.id}（systemRole=${member.systemRole}），不允许对外发布`);
        }
      }
    }
    return this.store.mutate((state) => {
      if (state.publications[input.id]) throw new Error(`publication already exists: ${input.id}`);
      const timestamp = now();
      const publication: PublicationDefinition = {
        id: input.id,
        version: 1,
        status: "active",
        name: requireText(input.name, "publication name"),
        description: input.description?.trim() || `${input.target.kind} ${input.target.id}`,
        target: input.target,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.publications[input.id] = publication;
      return publication;
    });
  }

  async archivePublication(id: string): Promise<PublicationDefinition> {
    return this.store.mutate((state) => {
      const current = state.publications[id];
      if (!current) throw new Error(`publication not found: ${id}`);
      if (current.status === "archived") return current;
      const archived: PublicationDefinition = {
        ...current,
        version: current.version + 1,
        status: "archived",
        updatedAt: now()
      };
      state.publications[id] = archived;
      return archived;
    });
  }

  private sessionForExternalContext(employeeId: string, source: InvocationSource): string | undefined {
    if (!source.contextId) return undefined;
    const state = this.snapshot();
    const match = Object.values(state.invocations)
      .filter((invocation) =>
        invocation.target.kind === "employee"
        && invocation.target.id === employeeId
        && invocation.sessionId !== undefined
        && invocation.source.kind === source.kind
        && invocation.source.contextId === source.contextId
        && invocation.source.publicationId === source.publicationId
        && invocation.source.project === source.project
        && invocation.source.caller === source.caller
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return match?.sessionId && state.sessions[match.sessionId]?.status === "active" ? match.sessionId : undefined;
  }

  async invokePublication(
    id: string,
    input: JsonObject,
    source: InvocationSource = { kind: "http" },
    options: { providerCwd?: string } = {}
  ): Promise<RunWorkflowResult | EmployeeInvocationResult> {
    const publication = this.getPublication(id);
    if (publication.status !== "active") throw new Error(`publication ${id} is archived`);
    const publicationSource: InvocationSource = { ...source, publicationId: id };
    if (publication.target.kind === "employee") {
      const message = typeof input.message === "string" ? input.message : JSON.stringify(input);
      return this.invokeEmployee(publication.target.id, {
        message,
        sessionId: this.sessionForExternalContext(publication.target.id, publicationSource),
        ...(typeof input.context === "object" && input.context !== null && !Array.isArray(input.context)
          ? { context: input.context as JsonObject }
          : {}),
        ...(input.attachments !== undefined
          ? { attachments: input.attachments as unknown as EmployeeInvocationInput["attachments"] }
          : {})
      }, publicationSource, options);
    }
    return this.runWorkbenchWorkflow(publication.target.id, input, publicationSource, options);
  }

  async listRuns(limit = 50): Promise<unknown[]> {
    const runsRoot = path.join(this.store.dataRoot, "artifacts", "runs");
    let entries: string[];
    try {
      entries = await fs.readdir(runsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(
      entries.map(async (entry) => {
        try {
          return JSON.parse(await fs.readFile(path.join(runsRoot, entry, "run.json"), "utf8")) as unknown;
        } catch {
          return undefined;
        }
      })
    );
    const invocationsByRunId = new Map<string, InvocationRecord>();
    for (const invocation of Object.values(this.snapshot().invocations)) {
      invocationsByRunId.set(invocation.runId, invocation);
    }
    return records
      .filter((record): record is Record<string, unknown> => Boolean(record))
      .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")))
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map((record) => this.classifyRunSummary(record, invocationsByRunId.get(String(record.id ?? ""))));
  }

  private classifyRunSummary(
    record: Record<string, unknown>,
    invocation: InvocationRecord | undefined
  ): Record<string, unknown> {
    const workflow = String(record.workflow ?? "");
    const runArchitecture = String(record.architecture ?? "");
    let category: "single" | "graph" | "supervisor";
    if (invocation) {
      category = invocation.target.kind === "employee"
        ? "single"
        : invocation.executionSnapshot?.workflow.architecture === "supervisor"
          ? "supervisor"
          : "graph";
    } else {
      category = runArchitecture === "supervisor"
        ? "supervisor"
        : workflow.startsWith("direct-")
          ? "single"
          : "graph";
    }
    return {
      ...record,
      category,
      ...(invocation?.source.project ? { project: invocation.source.project } : {}),
      ...(invocation?.source.taskId ? { taskId: invocation.source.taskId } : {}),
      ...(invocation ? { trigger: invocation.source.kind } : {})
    };
  }

  async getRun(id: string): Promise<unknown> {
    if (!/^run-[A-Za-z0-9-]+$/.test(id)) throw new Error("run id is invalid");
    try {
      const run = JSON.parse(
        await fs.readFile(path.join(this.store.dataRoot, "artifacts", "runs", id, "run.json"), "utf8")
      ) as Record<string, unknown>;
      const profileDir = path.join(this.store.dataRoot, "artifacts", "runs", id, "effective-profile");
      const effectiveProfiles: Record<string, EffectiveExecutionProfile> = {};
      try {
        const entries = await fs.readdir(profileDir, { withFileTypes: true });
        await Promise.all(entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(async (entry) => {
            const nodeId = entry.name.slice(0, -".json".length);
            effectiveProfiles[nodeId] = JSON.parse(
              await fs.readFile(path.join(profileDir, entry.name), "utf8")
            ) as EffectiveExecutionProfile;
          }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const invocation = Object.values(this.snapshot().invocations).find((candidate) => candidate.runId === id);
      const enriched = this.classifyRunSummary(run, invocation);
      const invocationContext = invocation ? {
        id: invocation.id,
        requestSummary: invocation.requestSummary,
        ...(invocation.requestText ? { requestText: invocation.requestText } : {}),
        ...(invocation.taskDescription ? { taskDescription: invocation.taskDescription } : {})
      } : undefined;
      return {
        ...enriched,
        ...(invocationContext ? { invocation: invocationContext } : {}),
        ...(Object.keys(effectiveProfiles).length > 0 ? { effectiveProfiles } : {})
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`run not found: ${id}`);
      throw error;
    }
  }

  private async getRunDeliveryContext(id: string): Promise<{
    run: WorkflowRunRecord;
    runDir: string;
  }> {
    const run = await this.getRun(id);
    if (typeof run !== "object" || run === null || Array.isArray(run) || (run as { id?: unknown }).id !== id) {
      throw new Error(`run record is invalid: ${id}`);
    }
    return {
      run: run as WorkflowRunRecord,
      // Never trust artifactDir persisted inside run.json for delivery reads or writes. The Run
      // Store layout plus the validated id is the only authority for resolving delivery assets.
      runDir: path.join(this.store.dataRoot, "artifacts", "runs", id)
    };
  }

  private invocationForRun(id: string): InvocationRecord | undefined {
    return Object.values(this.snapshot().invocations).find((candidate) => candidate.runId === id);
  }

  private async invokeProjectRoleAtPath(
    projectId: string,
    roleId: string,
    taskId: string | undefined,
    providerCwd: string,
    message: string,
    caller: string
  ): Promise<EmployeeInvocationResult> {
    const project = this.getProject(projectId);
    if (project.status !== "active") throw new Error(`project ${projectId} is archived`);
    const resolved = this.resolveProjectEmployee(projectId, roleId);
    const currentEmployee = this.getEmployee(resolved.employee.id);
    if (currentEmployee.status !== "active") throw new Error(`employee ${resolved.employee.id} is archived`);
    return this.invokeResolvedEmployee({
      employee: resolved.employee,
      input: { message },
      source: {
        kind: "workbench",
        project: projectId,
        projectRole: roleId,
        projectBindingVersion: resolved.binding.version,
        caller,
        ...(taskId ? { taskId } : {})
      },
      assignment: {
        projectId,
        projectVersion: resolved.project.version,
        projectBindingVersion: resolved.binding.version,
        roleId
      },
      providerCwd: await this.validatedProviderCwd(providerCwd),
      workflow: {
        id: `project-${projectId}-${roleId}`,
        version: resolved.binding.version,
        description: `${resolved.project.name} / ${resolved.project.roles.find((role) => role.id === roleId)?.displayName ?? roleId}`
      }
    });
  }

  private invokeProjectTestRoleAtPath(
    projectId: string,
    taskId: string | undefined,
    providerCwd: string,
    message: string,
    caller: string
  ): Promise<EmployeeInvocationResult> {
    return this.invokeProjectRoleAtPath(projectId, "test-engineer", taskId, providerCwd, message, caller);
  }

  private async copyEvidenceMedia(sourceRoot: string, destinationRoot: string): Promise<number> {
    const mediaExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov"]);
    let copied = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8 || copied >= 200) return;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (copied >= 200) break;
        if (entry.isSymbolicLink()) continue;
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(candidate, depth + 1);
          continue;
        }
        if (!entry.isFile() || !mediaExtensions.has(path.extname(entry.name).toLowerCase())) continue;
        await fs.mkdir(destinationRoot, { recursive: true });
        const destination = path.join(destinationRoot, `${String(copied + 1).padStart(3, "0")}-${path.basename(entry.name)}`);
        await fs.copyFile(candidate, destination);
        copied += 1;
      }
    };
    await visit(sourceRoot, 0);
    return copied;
  }

  private async originalRequestForRun(runDir: string): Promise<string | undefined> {
    try {
      return parseOriginalRunRequest(JSON.parse(await fs.readFile(path.join(runDir, "input.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  private async recoverInterruptedEvidenceRerun(
    runDir: string,
    id: string,
    worktreePath: string,
    current: NonNullable<RunDeliveryRecord["evidenceRerun"]> | undefined
  ): Promise<boolean> {
    if (!current || !["queued", "running"].includes(current.status) || this.evidenceReruns.has(id)) return false;
    const stagingParent = path.join(worktreePath, ".multi-agent", "evidence-rerun");
    const requestedAtMs = Date.parse(current.requestedAt);
    let recoveredMediaCount = 0;
    try {
      const entries = await fs.readdir(stagingParent, { withFileTypes: true });
      const candidates: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(`${id}-`)) continue;
        const candidate = path.join(stagingParent, entry.name);
        const stat = await fs.stat(candidate);
        if (Number.isFinite(requestedAtMs) && stat.mtimeMs < requestedAtMs - 5_000) continue;
        candidates.push(candidate);
      }
      for (const [index, candidate] of candidates.sort().entries()) {
        recoveredMediaCount += await this.copyEvidenceMedia(
          candidate,
          path.join(runDir, "evidence-reruns", `recovered-${current.requestedAt.replaceAll(/[^0-9A-Za-z-]/g, "-")}-${index + 1}`)
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await updateRunEvidenceRerun(runDir, id, {
      ...current,
      status: recoveredMediaCount > 0 ? "passed" : "failed",
      updatedAt: now(),
      ...(recoveredMediaCount > 0 ? { mediaCount: recoveredMediaCount } : {}),
      message: recoveredMediaCount > 0
        ? `daemon 重启中断了上一轮截图补采；已从原 worktree 恢复 ${recoveredMediaCount} 项媒体证据，现有证据继续参与交付门禁，无需重复补采。`
        : "daemon 重启中断了上一轮截图补采；候选 worktree 与已有证据均已保留，可以重新补采。"
    });
    return true;
  }

  async requestRunEvidenceRerun(id: string, input: { actor: string }): Promise<RunDeliveryRecord> {
    const actor = requireText(input.actor, "evidence rerun actor");
    const { run, runDir } = await this.getRunDeliveryContext(id);
    const preview = await previewRunMerge(run, runDir);
    if (!preview.worktreePath) throw new Error("该 Run 没有可用于截图验收的 worktree");
    const current = preview.delivery?.evidenceRerun;
    // Media recovered from an interrupted attempt remains first-class delivery evidence. Re-running
    // the same capture after the evidence gate is already satisfied only creates contradictory UI
    // and duplicate artifacts, so the operator may retry only while no viewable media exists.
    if (preview.evidence.assets.length > 0) {
      throw new Error("该 Run 已有完整媒体证据，无需重复补采");
    }
    if (["queued-for-merge", "retesting", "merging", "merged", "discarded"].includes(preview.status)) {
      throw new Error("该交付已进入合入或终态，不能再启动截图补采");
    }
    if (current?.status === "queued" || current?.status === "running") {
      if (this.evidenceReruns.has(id)) return preview.delivery!;
      await this.recoverInterruptedEvidenceRerun(runDir, id, preview.worktreePath, current);
    }
    const requestedAt = now();
    const queued = await updateRunEvidenceRerun(runDir, id, {
      status: "queued",
      actor,
      requestedAt,
      updatedAt: requestedAt,
      message: "已进入独立截图验收队列。"
    });
    const invocation = this.invocationForRun(id);
    const projectId = invocation?.source.project;
    const taskId = invocation?.source.taskId;
    const worktreePath = preview.worktreePath;
    const originalRequest = await this.originalRequestForRun(runDir);
    const stagingRoot = path.join(worktreePath, ".multi-agent", "evidence-rerun", `${id}-${randomUUID()}`);
    const job = (async () => {
      let preservedMediaCount = 0;
      try {
        if (!projectId) throw new Error("原 Run 缺少项目来源，无法路由项目 test-engineer");
        await fs.mkdir(stagingRoot, { recursive: true });
        await updateRunEvidenceRerun(runDir, id, {
          status: "running",
          actor,
          requestedAt,
          updatedAt: now(),
          message: "独立测试角色正在复现验收路径并采集截图。"
        });
        const result = await this.invokeProjectTestRoleAtPath(
          projectId,
          taskId,
          worktreePath,
          buildEvidenceRerunRequest({
            runId: id,
            worktreePath,
            stagingRoot,
            originalRequest,
            changedFiles: preview.changes.files.map((file) => file.path)
          }),
          "system:evidence-rerun"
        );
        const destination = path.join(runDir, "evidence-reruns", result.runId);
        const mediaCount = await this.copyEvidenceMedia(stagingRoot, destination);
        preservedMediaCount = mediaCount;
        if (result.status !== "passed" || mediaCount === 0) {
          throw new Error(result.status !== "passed"
            ? `独立截图验收未通过：${result.message}`
            : "独立测试角色未产出可展示的截图或录屏");
        }
        await updateRunEvidenceRerun(runDir, id, {
          status: "passed",
          actor,
          requestedAt,
          updatedAt: now(),
          runId: result.runId,
          mediaCount,
          message: `已补采 ${mediaCount} 项媒体证据。`
        });
      } catch (error) {
        if (preservedMediaCount === 0) {
          preservedMediaCount = await this.copyEvidenceMedia(
            stagingRoot,
            path.join(runDir, "evidence-reruns", `failed-${requestedAt.replaceAll(/[^0-9A-Za-z-]/g, "-")}`)
          );
        }
        const failureMessage = error instanceof Error ? error.message : String(error);
        await updateRunEvidenceRerun(runDir, id, {
          status: "failed",
          actor,
          requestedAt,
          updatedAt: now(),
          ...(preservedMediaCount > 0 ? { mediaCount: preservedMediaCount } : {}),
          message: preservedMediaCount > 0
            ? `${failureMessage}；已保留 ${preservedMediaCount} 项媒体证据供人工核对。`
            : failureMessage
        });
      } finally {
        await fs.rm(stagingRoot, { recursive: true, force: true });
      }
    })().finally(() => {
      if (this.evidenceReruns.get(id) === job) this.evidenceReruns.delete(id);
    });
    this.evidenceReruns.set(id, job);
    return queued;
  }

  private scheduleQueuedMerge(id: string, preview?: RunMergePreview): void {
    if (this.activeMergeRuns.has(id)) return;
    const start = async (): Promise<void> => {
      const currentPreview = preview ?? await (async () => {
        const { run, runDir } = await this.getRunDeliveryContext(id);
        return previewRunMerge(run, runDir);
      })();
      if (!currentPreview.repositoryRoot || !currentPreview.targetBranch) {
        throw new Error("待合入记录缺少目标仓库或目标分支");
      }
      const queueKey = `${currentPreview.repositoryRoot}\u0000${currentPreview.targetBranch}`;
      const previous = this.mergeBranchQueues.get(queueKey) ?? Promise.resolve();
      const worker = previous.catch(() => undefined).then(() => this.processQueuedMerge(id));
      const tail = worker.catch(() => undefined).finally(() => {
        if (this.mergeBranchQueues.get(queueKey) === tail) this.mergeBranchQueues.delete(queueKey);
      });
      this.mergeBranchQueues.set(queueKey, tail);
      await worker;
    };
    const job = start().catch(async (error) => {
      const { runDir } = await this.getRunDeliveryContext(id);
      await transitionRunDelivery(runDir, id, "returned-to-acceptance", {
        message: `自动合入意外终止：${error instanceof Error ? error.message : String(error)}；候选 worktree 已保留。`
      });
    }).finally(() => {
      if (this.activeMergeRuns.get(id) === job) this.activeMergeRuns.delete(id);
    });
    this.activeMergeRuns.set(id, job);
  }

  private async completeConflictRevalidation(
    id: string,
    run: WorkflowRunRecord,
    runDir: string,
    preview: RunMergePreview
  ): Promise<void> {
    let current = preview;
    let resolution = current.delivery?.conflictResolution;
    if (!current.worktreePath || !current.targetBranch || !resolution) {
      throw new Error("冲突修复记录缺少原 worktree、目标分支或目标 commit");
    }
    const worktreePath = current.worktreePath;
    const invocation = this.invocationForRun(id);
    const projectId = invocation?.source.project;
    const taskId = invocation?.source.taskId;
    const leaderSessionId = invocation?.sessionId;
    if (!projectId) throw new Error("原 Run 缺少项目来源，无法回跑项目测试");
    if (!leaderSessionId) throw new Error("原 Run 缺少持久化领队 Session，不能由原领队处理冲突");

    if (resolution.status === "resolving") {
      const originalRequest = await this.originalRequestForRun(runDir);
      const leaderResult = await this.continueWorkflowConversation(
        leaderSessionId,
        buildConflictPlanningRequest({
          runId: id,
          worktreePath,
          targetBranch: current.targetBranch,
          targetCommit: resolution.targetCommit,
          sourceCommit: current.delivery?.sourceCommit,
          conflictMessage: resolution.conflictMessage ?? current.delivery?.message ?? "合入预检发现冲突",
          originalRequest
        }),
        { kind: "workbench", caller: "system:merge-conflict-plan", project: projectId, ...(taskId ? { taskId } : {}) },
        { providerCwd: worktreePath }
      );
      if (leaderResult.status !== "passed"
        || !hasExplicitDeliveryPass(leaderResult.output, leaderResult.message, CONFLICT_PLAN_READY)) {
        throw new Error(`原领队没有形成可执行的冲突处置计划：${leaderResult.message}`);
      }
      const executionRoleId = selectConflictExecutionRole(resolution.conflictMessage ?? current.delivery?.message ?? "");
      await transitionRunDelivery(runDir, id, "conflict", {
        message: `原领队已完成冲突取舍，正在委派 ${executionRoleId} 在原 worktree 执行 rebase。`,
        conflictResolution: {
          ...resolution,
          status: "resolving",
          leaderPlanRunId: leaderResult.runId,
          executionRoleId,
          updatedAt: now(),
          message: leaderResult.message
        }
      });
      let rebaseStep = await beginManagedRunRebase(run, runDir, resolution.targetCommit);
      let executionRunId: string | undefined;
      let executionMessage = rebaseStep.message;
      for (let round = 1; rebaseStep.status === "conflict"; round += 1) {
        if (round > 20) throw new Error("冲突修复超过 20 轮，已停止以避免无限重试");
        const executionResult = await this.invokeProjectRoleAtPath(
          projectId,
          executionRoleId,
          taskId,
          worktreePath,
          buildConflictExecutionRequest({
            runId: id,
            worktreePath,
            targetBranch: current.targetBranch,
            targetCommit: resolution.targetCommit,
            conflictMessage: rebaseStep.message,
            conflictPaths: rebaseStep.conflictPaths,
            leaderPlan: leaderResult.message,
            originalRequest
          }),
          `system:merge-conflict-execution-r${round}`
        );
        if (executionResult.status !== "passed"
          || !hasExplicitDeliveryPass(executionResult.output, executionResult.message, CONFLICT_EXECUTION_PASS)) {
          throw new Error(`${executionRoleId} 没有完成第 ${round} 轮冲突修复：${executionResult.message}`);
        }
        executionRunId = executionResult.runId;
        executionMessage = executionResult.message;
        rebaseStep = await continueManagedRunRebase(run, runDir, resolution.targetCommit);
      }
      await transitionRunDelivery(runDir, id, "conflict", {
        message: `${executionRoleId} 已解决冲突并通过定向测试，运行核心已完成 rebase，正在验证结果。`,
        conflictResolution: {
          ...resolution,
          status: "resolving",
          leaderPlanRunId: leaderResult.runId,
          executionRoleId,
          ...(executionRunId ? { resolutionRunId: executionRunId } : {}),
          updatedAt: now(),
          message: executionMessage
        }
      });
      await acceptRebasedRunSource(run, runDir, resolution.targetCommit);
      current = await previewRunMerge(run, runDir);
      resolution = current.delivery?.conflictResolution;
      if (!resolution) throw new Error("rebase 完成后冲突修复审计记录丢失");
    }

    if (resolution.status === "retesting") {
      const testResult = await this.invokeProjectTestRoleAtPath(
        projectId,
        taskId,
        worktreePath,
        [
          "【冲突修复后原需求回归】",
          `候选 Run：${id}`,
          `已 rebase 目标 commit：${resolution.targetCommit}`,
          `冲突修复后候选 commit：${current.delivery?.sourceCommit ?? "unknown"}`,
          "请在原候选 worktree 上重新执行与原需求及冲突文件相关的独立测试流程，界面路径必须使用 Midscene 留下真实可见证据。不得安装依赖，不得修改代码或 Git 历史。",
          "测试、环境或证据有任一缺口必须返回 Block；只有可复现且证据充分才返回 Pass。"
        ].join("\n"),
        "system:merge-conflict-retest"
      );
      if (testResult.status !== "passed") throw new Error(`冲突修复后的独立测试未通过：${testResult.message}`);
      await transitionRunDelivery(runDir, id, "retesting", {
        message: "冲突修复后的独立测试已通过，正在等待原需求领队最终复验。",
        conflictResolution: {
          ...resolution,
          status: "leader-review",
          testRunId: testResult.runId,
          updatedAt: now(),
          message: testResult.message
        },
        mergeValidation: {
          required: true,
          status: "running",
          runId: testResult.runId,
          targetCommit: resolution.targetCommit,
          message: testResult.message,
          updatedAt: now()
        }
      });
      current = await previewRunMerge(run, runDir);
      resolution = current.delivery?.conflictResolution;
      if (!resolution) throw new Error("独立测试后冲突修复审计记录丢失");
    }

    if (resolution.status === "leader-review") {
      if (!resolution.testRunId || !current.delivery?.sourceCommit) throw new Error("原领队复验缺少测试 Run 或 rebased 候选 commit");
      const leaderReview = await this.continueWorkflowConversation(
        leaderSessionId,
        buildLeaderRevalidationRequest({
          runId: id,
          targetCommit: resolution.targetCommit,
          sourceCommit: current.delivery.sourceCommit,
          testRunId: resolution.testRunId,
          testMessage: resolution.message ?? "独立测试通过"
        }),
        { kind: "workbench", caller: "system:merge-conflict-leader-review", project: projectId, ...(taskId ? { taskId } : {}) },
        { providerCwd: worktreePath }
      );
      if (leaderReview.status !== "passed"
        || !hasExplicitDeliveryPass(leaderReview.output, leaderReview.message, LEADER_REVALIDATION_PASS)) {
        throw new Error(`原领队未放行冲突修复后的交付：${leaderReview.message}`);
      }
      await transitionRunDelivery(runDir, id, "merging", {
        message: "冲突修复、独立测试和原领队复验均已通过，正在按队列顺序自动合入。",
        conflictResolution: {
          ...resolution,
          status: "passed",
          leaderReviewRunId: leaderReview.runId,
          updatedAt: now(),
          message: leaderReview.message
        },
        mergeValidation: {
          required: true,
          status: "passed",
          runId: resolution.testRunId,
          targetCommit: resolution.targetCommit,
          message: `独立测试与原领队复验通过：${leaderReview.message}`,
          updatedAt: now()
        }
      });
    }
  }

  private async failConflictRevalidation(id: string, run: WorkflowRunRecord, runDir: string, error: unknown): Promise<void> {
    const preview = await previewRunMerge(run, runDir);
    const resolution = preview.delivery?.conflictResolution;
    await transitionRunDelivery(runDir, id, "conflict", {
      message: `AI 冲突处理未通过：${error instanceof Error ? error.message : String(error)}；候选仍在待合入队列，原 worktree 与证据均已保留。`,
      ...(resolution ? {
        conflictResolution: {
          ...resolution,
          status: "failed",
          updatedAt: now(),
          message: error instanceof Error ? error.message : String(error)
        }
      } : {})
    });
  }

  private async processQueuedMerge(id: string): Promise<void> {
    const { run, runDir } = await this.getRunDeliveryContext(id);
    let delivery = await previewRunMerge(run, runDir);
    const activeConflict = delivery.status === "conflict"
      && ["resolving", "retesting", "leader-review"].includes(delivery.delivery?.conflictResolution?.status ?? "");
    const legacyConflict = delivery.status === "conflict"
      && !delivery.delivery?.conflictResolution
      && delivery.delivery?.humanDecision?.action === "merge";
    if (!["queued-for-merge", "retesting", "merging"].includes(delivery.status) && !activeConflict && !legacyConflict) return;
    let conflictRevalidated = false;
    if (activeConflict) {
      try {
        await this.completeConflictRevalidation(id, run, runDir, delivery);
        conflictRevalidated = true;
      } catch (error) {
        await this.failConflictRevalidation(id, run, runDir, error);
        return;
      }
      delivery = await previewRunMerge(run, runDir);
    }
    const assessment = await assessQueuedRun(run, runDir);
    const completedValidation = delivery.delivery?.mergeValidation;
    if (delivery.status === "merging"
      && completedValidation?.status === "passed"
      && completedValidation.targetCommit === assessment.currentTargetCommit) {
      if (!delivery.targetBranch) throw new Error("恢复合入前无法解析目标分支");
      await mergeAcceptedRun(run, runDir, {
        confirmation: delivery.confirmationToken,
        targetBranch: delivery.targetBranch
      });
      return;
    }
    if (assessment.conflict && !conflictRevalidated) {
      await transitionRunDelivery(runDir, id, "conflict", {
        message: `${assessment.conflictMessage ?? "候选与目标分支发生冲突"}；已留在待合入队列，正在通知原需求领队在原 worktree rebase 处理。`,
        conflictResolution: {
          status: "resolving",
          targetCommit: assessment.currentTargetCommit,
          conflictMessage: assessment.conflictMessage,
          updatedAt: now(),
          message: "等待原领队处理冲突。"
        }
      });
      try {
        await this.completeConflictRevalidation(id, run, runDir, await previewRunMerge(run, runDir));
        conflictRevalidated = true;
      } catch (error) {
        await this.failConflictRevalidation(id, run, runDir, error);
        return;
      }
    }

    if (assessment.targetChanged && !conflictRevalidated) {
      const invocation = this.invocationForRun(id);
      const projectId = invocation?.source.project;
      if (!projectId) throw new Error("原 Run 缺少项目来源，目标分支变化后无法路由独立重测");
      await transitionRunDelivery(runDir, id, "retesting", {
        message: "目标分支在排队期间发生变化，正在临时集成 worktree 上执行独立回归。",
        mergeValidation: {
          required: true,
          status: "running",
          targetCommit: assessment.currentTargetCommit,
          updatedAt: now()
        }
      });
      const validation = await createMergeValidationWorktree(run, runDir);
      try {
        const result = await this.invokeProjectTestRoleAtPath(
          projectId,
          invocation?.source.taskId,
          validation.worktreePath,
          [
            "【待合入队列目标漂移重测】",
            `候选 Run：${id}`,
            `目标分支：${validation.targetBranch}`,
            `目标 commit：${validation.targetCommit}`,
            `候选 commit：${validation.sourceCommit}`,
            "当前目录是系统创建的临时集成 worktree，已合入候选但尚未写入真实目标分支。",
            "请执行与本需求相关的独立回归测试并给出结构化 verdict。不得安装依赖，不得修改代码、Git 历史或任何真实分支。",
            "测试失败、环境异常或无法证明通过时必须返回 block，不能把工具失败当作通过。"
          ].join("\n"),
          "system:merge-queue-retest"
        );
        if (result.status !== "passed") {
          await transitionRunDelivery(runDir, id, "returned-to-acceptance", {
            message: `目标分支变化后的独立重测未通过：${result.message}；候选已保留，请重新验收。`,
            mergeValidation: {
              required: true,
              status: "failed",
              runId: result.runId,
              targetCommit: validation.targetCommit,
              message: result.message,
              updatedAt: now()
            }
          });
          return;
        }
        await transitionRunDelivery(runDir, id, "merging", {
          message: "目标漂移回归已通过，正在写入真实目标分支。",
          mergeValidation: {
            required: true,
            status: "passed",
            runId: result.runId,
            targetCommit: validation.targetCommit,
            message: result.message,
            updatedAt: now()
          }
        });
      } finally {
        await removeMergeValidationWorktree(validation);
      }
    } else if (!conflictRevalidated) {
      await transitionRunDelivery(runDir, id, "merging", {
        message: "目标分支未发生变化，正在执行已批准的串行合入。",
        mergeValidation: {
          required: false,
          status: "not-required",
          targetCommit: assessment.currentTargetCommit,
          updatedAt: now()
        }
      });
    }

    const latest = await previewRunMerge(run, runDir);
    if (!latest.targetBranch) throw new Error("合入前无法解析目标分支");
    await mergeAcceptedRun(run, runDir, {
      confirmation: latest.confirmationToken,
      targetBranch: latest.targetBranch
    });
  }

  async getRunMergePreview(id: string): Promise<RunMergePreview> {
    const { run, runDir } = await this.getRunDeliveryContext(id);
    let preview = await previewRunMerge(run, runDir);
    if (preview.worktreePath
      && await this.recoverInterruptedEvidenceRerun(runDir, id, preview.worktreePath, preview.delivery?.evidenceRerun)) {
      preview = await previewRunMerge(run, runDir);
    }
    const activeConflict = preview.status === "conflict"
      && ["resolving", "retesting", "leader-review"].includes(preview.delivery?.conflictResolution?.status ?? "");
    const legacyConflict = preview.status === "conflict"
      && !preview.delivery?.conflictResolution
      && preview.delivery?.humanDecision?.action === "merge";
    if (["queued-for-merge", "retesting", "merging"].includes(preview.status) || activeConflict || legacyConflict) {
      this.scheduleQueuedMerge(id, preview);
    }
    return preview;
  }

  async queueRunMerge(
    id: string,
    input: { confirmation: string; targetBranch: string; actor: string }
  ): Promise<RunMergeQueueResult> {
    const { run, runDir } = await this.getRunDeliveryContext(id);
    const queued = await queueAcceptedRun(run, runDir, input);
    this.scheduleQueuedMerge(id);
    return queued;
  }

  async retryRunMergeConflict(id: string, input: { actor: string }): Promise<RunMergeQueueResult> {
    const actor = requireText(input.actor, "conflict retry actor");
    const { run, runDir } = await this.getRunDeliveryContext(id);
    const preview = await previewRunMerge(run, runDir);
    if (preview.status !== "conflict" || preview.delivery?.conflictResolution?.status !== "failed") {
      throw new Error("只有 AI 冲突处理失败的待合入候选可以重新处理");
    }
    if (preview.delivery.humanDecision?.action !== "merge") throw new Error("该候选缺少原始人工合入批准");
    const queued = await updateRunDelivery(runDir, id, (current) => {
      if (!current) throw new Error("交付记录不存在");
      const { conflictResolution: _previousAttempt, ...preserved } = current;
      return {
        ...preserved,
        runId: id,
        status: "queued-for-merge",
        updatedAt: now(),
        message: `${actor} 已要求原领队重新处理合入冲突；候选保持原队列批准，不需要再次人工验收。`
      };
    });
    this.scheduleQueuedMerge(id);
    return { status: "queued-for-merge", delivery: queued };
  }

  async mergeRun(
    id: string,
    input: { confirmation: string; targetBranch: string }
  ): Promise<RunMergeResult> {
    const { run, runDir } = await this.getRunDeliveryContext(id);
    return mergeAcceptedRun(run, runDir, input);
  }

  async keepRun(
    id: string,
    input: { actor: string; note?: string }
  ): Promise<RunDeliveryActionResult> {
    const { run, runDir } = await this.getRunDeliveryContext(id);
    return keepRunWorktree(run, runDir, input);
  }

  async discardRun(
    id: string,
    input: { confirmation: string; actor: string; note?: string }
  ): Promise<RunDeliveryActionResult> {
    const { run, runDir } = await this.getRunDeliveryContext(id);
    return discardRunWorktree(run, runDir, input);
  }

  async openRunWorktree(id: string): Promise<{ runId: string; worktreePath: string; repositoryRoot: string }> {
    const { run } = await this.getRunDeliveryContext(id);
    return openManagedRunWorktree(run);
  }

  async getRunEvidenceAsset(id: string, assetId: string): Promise<{
    filePath: string;
    asset: RunEvidenceAsset;
  }> {
    const { runDir } = await this.getRunDeliveryContext(id);
    return resolveRunEvidenceAsset(runDir, id, assetId);
  }
}
