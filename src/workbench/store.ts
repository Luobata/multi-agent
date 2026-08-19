import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync, truncateSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { decodeUtf8HeaderValue } from "../core/httpHeaders.js";
import { configurationReviewHash, configurationReviewProgress } from "../configuration/proposal.js";
import type { ProviderDefinition } from "../core/types.js";
import type { KnowledgeProfileGrant } from "../knowledge/types.js";
import { isSystemManagedProviderId, systemProviderRuntimeProfiles } from "../runtime/systemProviders.js";
import type { EmployeeDefinition, EmployeeSession, EmployeeSessionMessage, WorkbenchSkillDefinition, WorkbenchState } from "./types.js";
import {
  ACTIVITY_ENTITIES,
  ACTIVITY_SHARD_DIRS,
  type ActivityAppend,
  type ActivityEntity,
  type ActivityLogEvent,
  type ActivityManifests,
  type ActivityShardManifest,
  type ActivityState,
  type StoreOpenReport,
  type StoreVerifyReport,
  type WorkbenchConfigState,
  type WorkbenchStateV2
} from "./storeTypes.js";
import { defaultSupervisorFlow } from "./supervisorFlow.js";
import { normalizePassiveProjectAccesses } from "./passiveProjectAccess.js";

const KNOWLEDGE_CONTROL_TOOLS = [
  "knowledge_control_snapshot",
  "knowledge_base_get",
  "knowledge_revision_assess",
  "knowledge_revision_preview",
  "knowledge_url_preview",
  "knowledge_url_propose",
  "knowledge_wiki_get",
  "employee_knowledge_perspective",
  "knowledge_review_list",
  "knowledge_impact_get",
  "knowledge_change_list",
  "knowledge_change_get",
  "knowledge_change_propose"
];
const CONFIGURATION_CONTROL_TOOLS = [
  "configuration_control_snapshot",
  "configuration_proposal_list",
  "configuration_proposal_get",
  "configuration_proposal_create"
];
const GATE_CONTROL_TOOLS = [
  "workflow_control_snapshot",
  "workflow_change_list",
  "workflow_change_get",
  "workflow_change_propose"
];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SYSTEM_SKILL_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const TEAM_ORCHESTRATION_SKILL_VERSION = 9;
const TEAM_ORCHESTRATION_INSTRUCTIONS = [
  "Coordinate the assigned team within the Supervisor workflow policy. Delegate explicit work, preserve evidence, respect runtime limits and gates, and finish only when the required work is complete.",
  "For any coding, test, audit, or integration request that needs more than one bounded milestone, first emit plan-todos. Split the work into dependency-ordered TODOs with one verifiable outcome each. Do not paste the whole request into every TODO. Give sequential TODOs handled by the same role on the same changeSet one stable sessionKey; the runtime preserves that member's logical Work Instance and prior bounded outputs between calls, serializes the session, and releases it only after its last planned TODO or the Run terminates. Delegate only ready todoId values and let the runtime inject the immutable planned task. While a TODO plan is active, every assignment must carry the exact planned todoId and must not override its task, roleId, workKind, or changeSet. For conditional repair, plan only the original validation TODO and one repair TODO whose needs includes the validation and whose needsWhen accepts blocked/failed; after repair passes, rerun the original validation todoId instead of adding a permanently blocked retest TODO. Do not invent an unplanned test or audit assignment after implementation: once all required TODOs pass or conditionally skipped branches converge, emit finish and let the runtime execute the configured quality Gates automatically. Independent TODOs may run in parallel within maxParallelDelegations.",
  "Every coding plan or direct coding delegation must include a structured impact assessment. Base it on changed files and contracts, UI routes, APIs, persistence/state boundaries, concurrency, security, migrations, shared packages, and target-branch drift. Choose regressionScope=targeted for local low-risk changes, package for shared/package behavior, and full only for high-risk cross-boundary or integration changes. List concrete requiredChecks. Downstream test and audit Gates receive this assessment and must reuse same-commit evidence, run only the recorded scope, and return to the leader before widening it. Never request full regression by habit.",
  "For oversized validation, derive independent domains from acceptance criteria. Put each required check into exactly one optional validationGroups entry and create as many bounded groups as the actual checklist needs; there is no fixed group-count target or ceiling. Each test group should cover a coherent main path, related failure path, targeted automation group, or necessary type/build check. When exact repository-relative coverage is known, include impactedFiles so later revisions can inherit only provably unaffected shards. If you omit groups, the runtime derives them dynamically from checklist size. Serial quality-Gate groups reuse one retained test member Session, pass prior bounded evidence into the next group, and release that Work Instance only after the final group or Run termination. Later Gates reuse same-commit shard evidence and run only the smallest missing cross-shard check; never ask one tester to repeat every shard or debug test infrastructure indefinitely.",
  "When the delivery queue calls the original leader back for a merge conflict, the leader owns the conflict tradeoff and must produce a concrete execution plan instead of blocking merely because the leader role is read-only. The trusted runtime starts and advances rebase Git state; it delegates each conflict round to a write-capable frontend, backend, or full-stack project role, which edits and tests only the preserved original worktree. The engineering role must preserve both the accepted requirement and valid target-branch behavior, never install dependencies, never modify or push the real target branch, and must not block merely because its sandbox cannot write parent-repository Git worktree metadata.",
  "After conflict repair, require the independent project test role to rerun requirement-scoped tests and browser evidence, then perform a final leader review. Emit the runtime-requested PASS marker only when the rebased code, test evidence, and original requirement all remain valid; otherwise block with concrete evidence. Automatic merge remains owned by the deterministic serial delivery queue."
].join("\n\n");

function teamOrchestrationSkill(version = TEAM_ORCHESTRATION_SKILL_VERSION, createdAt = SYSTEM_SKILL_TIMESTAMP): WorkbenchSkillDefinition {
  return {
    id: "team-orchestration",
    version,
    status: "active",
    owner: "system",
    injection: "supervisor",
    displayName: "Team orchestration",
    description: "System-owned guidance for a Supervisor runtime that plans, delegates, verifies, and delivers team work.",
    summary: "Plan, delegate, verify, and deliver team work as the Supervisor runtime.",
    instructions: TEAM_ORCHESTRATION_INSTRUCTIONS,
    tools: [],
    createdAt,
    updatedAt: SYSTEM_SKILL_TIMESTAMP
  };
}

/** Derive a bounded one-line summary from a skill description for pre-summary persisted skills. */
function backfillSkillSummary(description: string): string {
  const source = (description ?? "").trim().split(/(?<=[.!?。！？])\s+/)[0] || (description ?? "").trim();
  const collapsed = source.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 159).trimEnd()}…` : collapsed;
}

function ensureSystemSkills(state: WorkbenchState): void {
  const existing = state.skills["team-orchestration"];
  if (!existing) {
    const skill = teamOrchestrationSkill();
    state.skills[skill.id] = skill;
    state.skillHistory[skill.id] = [skill];
    return;
  }
  if (existing.owner === "system"
    && existing.injection === "supervisor"
    && existing.instructions === TEAM_ORCHESTRATION_INSTRUCTIONS) return;
  const skill = teamOrchestrationSkill(Math.max(existing.version + 1, TEAM_ORCHESTRATION_SKILL_VERSION), existing.createdAt);
  state.skills[skill.id] = skill;
  (state.skillHistory[skill.id] ??= [existing]).push(skill);
}

/**
 * Backfill the first-class `systemRole` on the built-in internal employees
 * (小忆 automatic summarizer, 小知/小配/小关 conversational stewards) and repair
 * the summarizer's provider if a legacy record left it on the generic `codex`.
 *
 * This is pure field migration — it never creates employees or skills, so it is
 * safe to run on every load/mutation. Creation of the stewards is a domain-level
 * bootstrap concern (version-pinned project roles + skills), not normalization.
 *
 * Keyed strictly on `employeeKind` (the marker the four system-employee templates
 * carry) plus the fixed summarizer id — NOT on `internalProjectId` alone, so
 * ad-hoc legacy project-internal employees are left to their existing behavior.
 */
function backfillSystemEmployeeRoles(state: WorkbenchState): void {
  for (const record of Object.values(state.employees)) {
    for (const employee of record.versions) {
      const kind = employee.identity.metadata?.employeeKind;
      if (kind === "system-automatic-summarizer" || employee.id === "memory-summarizer") {
        employee.systemRole ??= "automatic";
        if (employee.providerId === "codex") employee.providerId = "codex-memory-summarizer";
      } else if (kind === "project-internal-control-agent") {
        employee.systemRole ??= "conversational";
      }
    }
  }
}

function legacyProjectScope(employee: EmployeeDefinition): EmployeeDefinition["scope"] {
  const projectId = employee.identity.metadata?.internalProjectId;
  return typeof projectId === "string" && projectId.trim()
    ? { kind: "project", projectId: projectId.trim(), projectVersion: 1 }
    : { kind: "global" };
}

function executable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCodexCommand(): string {
  const configured = process.env.MULTI_AGENT_CODEX_COMMAND?.trim();
  if (configured) return configured;
  const pathCandidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, "codex"));
  const home = os.homedir();
  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  const nvmCandidates = existsSync(nvmRoot)
    ? readdirSync(nvmRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => path.join(nvmRoot, version, "bin", "codex"))
    : [];
  const candidates = [
    ...pathCandidates,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    path.join(home, ".local", "bin", "codex"),
    path.join(home, ".volta", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    ...nvmCandidates
  ];
  return candidates.find(executable) ?? "codex";
}

function codexKnowledgeControlProvider(): ProviderDefinition {
  return {
    adapter: "codex",
    runtimeProfiles: [...systemProviderRuntimeProfiles("codex-knowledge-control")!],
    command: resolveCodexCommand(),
    filesystemIsolation: "workspace-read-only",
    workingDirectory: "{{run.materializedRoot}}",
    approvalPolicy: "never",
    timeoutMs: 600_000,
    outputProtocol: "json",
    mcpServers: {
      knowledge_control: {
        command: process.execPath,
        args: [path.join(packageRoot, "dist", "mcp", "main.js"), "--profile", "knowledge-control"],
        cwd: "{{run.projectRoot}}",
        enabledTools: KNOWLEDGE_CONTROL_TOOLS,
        defaultToolsApprovalMode: "approve"
      }
    }
  };
}

function codexConfigurationControlProvider(): ProviderDefinition {
  return {
    adapter: "codex",
    runtimeProfiles: [...systemProviderRuntimeProfiles("codex-configuration-control")!],
    command: resolveCodexCommand(),
    filesystemIsolation: "workspace-read-only",
    workingDirectory: "{{run.materializedRoot}}",
    approvalPolicy: "never",
    timeoutMs: 600_000,
    outputProtocol: "json",
    mcpServers: {
      configuration_control: {
        command: process.execPath,
        args: [
          path.join(packageRoot, "dist", "mcp", "main.js"),
          "--profile",
          "configuration-control",
          "--source-run-id",
          "{{run.id}}"
        ],
        cwd: "{{run.projectRoot}}",
        enabledTools: CONFIGURATION_CONTROL_TOOLS,
        defaultToolsApprovalMode: "approve"
      }
    }
  };
}

function codexGateControlProvider(): ProviderDefinition {
  return {
    adapter: "codex",
    runtimeProfiles: [...systemProviderRuntimeProfiles("codex-gate-control")!],
    command: resolveCodexCommand(),
    filesystemIsolation: "workspace-read-only",
    workingDirectory: "{{run.materializedRoot}}",
    approvalPolicy: "never",
    timeoutMs: 600_000,
    outputProtocol: "json",
    mcpServers: {
      gate_control: {
        command: process.execPath,
        args: [path.join(packageRoot, "dist", "mcp", "main.js"), "--profile", "gate-control"],
        cwd: "{{run.projectRoot}}",
        enabledTools: GATE_CONTROL_TOOLS,
        defaultToolsApprovalMode: "approve"
      }
    }
  };
}

// The memory-summarizer (小忆) runs codex read-only with no control MCP profile;
// mirrors templates/workbench/codex-memory-summarizer.provider.json. Unlike the
// control providers it carries no runtime profile, so it is NOT system-managed.
function codexMemorySummarizerProvider(): ProviderDefinition {
  return {
    adapter: "codex",
    command: resolveCodexCommand(),
    filesystemIsolation: "workspace-read-only",
    approvalPolicy: "never",
    timeoutMs: 120_000,
    outputProtocol: "json"
  };
}

/**
 * Older Workbench installations registered the shared `codex` Provider as a
 * generic shell command. That path can parse Codex JSONL, but it cannot attach
 * the materialized Role output schema to `codex exec`; useful work is therefore
 * reported as failed whenever the final message is Markdown or has extra keys.
 *
 * Migrate only the exact legacy shape we shipped. User-authored command
 * Providers (including commands that merely happen to mention Codex) remain
 * untouched. Invocation snapshots already in flight are immutable and continue
 * to use their pinned definition; new Invocations receive the native adapter.
 */
function migrateLegacyCodexProvider(state: WorkbenchState): void {
  const current = state.providers.codex;
  if (current?.adapter !== "command") return;
  const command = typeof current.command === "string" ? current.command : "";
  const args = Array.isArray(current.args) && current.args.every((argument) => typeof argument === "string")
    ? current.args as string[]
    : [];
  const legacyInvocation = [command, ...args].join(" ");
  if (!/\bcodex\s+exec\b/.test(legacyInvocation) || !args.some((argument) => argument.includes("--json"))) return;

  state.providers.codex = {
    adapter: "codex",
    command: resolveCodexCommand(),
    ...(typeof current.model === "string" ? { model: current.model } : {}),
    sandbox: "workspace-write",
    approvalPolicy: "never",
    ...(typeof current.timeoutMs === "number" ? { timeoutMs: current.timeoutMs } : {}),
    ...(typeof current.idleTimeoutMs === "number" ? { idleTimeoutMs: current.idleTimeoutMs } : {}),
    ...(typeof current.hardTimeoutMs === "number" ? { hardTimeoutMs: current.hardTimeoutMs } : {}),
    outputProtocol: "json"
  };
}

const LEGACY_RELAY_RETRY_KEYS = new Set([
  "initialDelayMs",
  "maxDelayMs",
  "multiplier",
  "jitterRatio"
]);
const LEGACY_RELAY_SESSION_KEYS = new Set([
  "idArgs",
  "resumeArgs",
  "resumeInputTemplate",
  "maxReconnects",
  "initialDelayMs",
  "maxDelayMs",
  "multiplier",
  "jitterRatio"
]);

function legacyRelayObject(value: unknown, allowedKeys: ReadonlySet<string>): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowedKeys.has(key));
}

/**
 * One released relay experiment persisted Provider-level `retry` and `session`
 * objects, then the generic command adapter deliberately returned to stateless
 * Attempts. A daemon opened by the newer runtime could still read that state,
 * materialize the retired fields into a fresh manifest, and fail before a Run
 * received any Provider output.
 *
 * Migrate only the two known local relay ids and only when every retired object
 * has the exact historical key family. Unknown shapes remain fail-closed under
 * normal adapter validation. The experiment also shipped a fixed $3 CLI budget;
 * remove that pair in the same compatibility migration, preserving every other
 * argument and all immutable historical Run manifests.
 */
function migrateLegacyRelayRecoveryProvider(state: WorkbenchState): void {
  for (const id of ["claude-relay", "claude-relay-execution"] as const) {
    const definition = state.providers[id];
    if (definition?.adapter !== "command") continue;
    const retry = definition.retry;
    const session = definition.session;
    if (retry === undefined && session === undefined) continue;
    if (retry !== undefined && !legacyRelayObject(retry, LEGACY_RELAY_RETRY_KEYS)) continue;
    if (session !== undefined && !legacyRelayObject(session, LEGACY_RELAY_SESSION_KEYS)) continue;

    delete definition.retry;
    delete definition.session;
    if (Array.isArray(definition.args) && definition.args.every((argument) => typeof argument === "string")) {
      const migratedArgs: string[] = [];
      for (let index = 0; index < definition.args.length; index += 1) {
        if (definition.args[index] === "--max-budget-usd" && typeof definition.args[index + 1] === "string") {
          index += 1;
          continue;
        }
        migratedArgs.push(definition.args[index] as string);
      }
      definition.args = migratedArgs;
    }
  }
}

function initialState(): WorkbenchState {
  return {
    schemaVersion: 1,
    providers: {
      mock: {
        adapter: "mock",
        model: "deterministic-mock",
        outputProtocol: "json"
      },
      "codex-knowledge-control": codexKnowledgeControlProvider(),
      "codex-configuration-control": codexConfigurationControlProvider(),
      "codex-gate-control": codexGateControlProvider(),
      "codex-memory-summarizer": codexMemorySummarizerProvider()
    },
    skills: { "team-orchestration": teamOrchestrationSkill() },
    skillHistory: { "team-orchestration": [teamOrchestrationSkill()] },
    knowledgeBases: {},
    knowledgeProfiles: {},
    knowledgeChangeRequests: {},
    workflowChangeRequests: {},
    configurationProposals: {},
    employees: {},
    employeeTemplates: {},
    managementPolicies: {},
    entrancePolicies: {},
    workflows: {},
    sessions: {},
    publications: {},
    projects: {},
    projectBindings: {},
    passiveProjectAccesses: {},
    invocations: {},
    workInstances: {},
    humanDecisionRequests: {}
  };
}

function normalizedStoredGrants(
  profileIds: string[],
  grants: KnowledgeProfileGrant[] | undefined,
  fallbackAt: string
): KnowledgeProfileGrant[] {
  const byProfile = new Map((grants ?? []).map((grant) => [grant.profileId, grant]));
  return profileIds.map((profileId) => byProfile.get(profileId) ?? {
    profileId,
    reason: "Legacy knowledgeProfileIds assignment",
    grantedBy: "legacy-migration",
    grantedAt: fallbackAt,
    source: "legacy"
  });
}

function normalizeState(state: WorkbenchState): WorkbenchState {
  // Runtime profiles are certifications, not user-authored metadata. Persisted
  // custom Providers from older versions must not be able to self-assert one.
  for (const [id, definition] of Object.entries(state.providers)) {
    if (!isSystemManagedProviderId(id)) delete definition.runtimeProfiles;
  }
  if (state.providers.mock?.adapter === "mock" && state.providers.mock.model === undefined) {
    state.providers.mock.model = "deterministic-mock";
  }
  migrateLegacyCodexProvider(state);
  migrateLegacyRelayRecoveryProvider(state);
  const currentKnowledgeControl = state.providers["codex-knowledge-control"];
  state.providers["codex-knowledge-control"] = {
    ...codexKnowledgeControlProvider(),
    ...(typeof currentKnowledgeControl?.model === "string" ? { model: currentKnowledgeControl.model } : {})
  };
  const currentConfigurationControl = state.providers["codex-configuration-control"];
  state.providers["codex-configuration-control"] = {
    ...codexConfigurationControlProvider(),
    ...(typeof currentConfigurationControl?.model === "string" ? { model: currentConfigurationControl.model } : {})
  };
  const currentGateControl = state.providers["codex-gate-control"];
  state.providers["codex-gate-control"] = {
    ...codexGateControlProvider(),
    ...(typeof currentGateControl?.model === "string" ? { model: currentGateControl.model } : {})
  };
  const currentMemorySummarizer = state.providers["codex-memory-summarizer"];
  state.providers["codex-memory-summarizer"] = {
    ...codexMemorySummarizerProvider(),
    ...(typeof currentMemorySummarizer?.model === "string" ? { model: currentMemorySummarizer.model } : {})
  };
  state.skillHistory ??= Object.fromEntries(
    Object.entries(state.skills).map(([id, skill]) => [id, [skill]])
  );
  state.knowledgeBases ??= {};
  state.knowledgeProfiles ??= {};
  state.knowledgeChangeRequests ??= {};
  state.workflowChangeRequests ??= {};
  state.configurationProposals ??= {};
  for (const proposal of Object.values(state.configurationProposals)) {
    proposal.progress = configurationReviewProgress(
      proposal.reviewItems.map((item) => item.id),
      proposal.decisions
    );
    if (!Number.isInteger(proposal.reviewRevision) || proposal.reviewRevision < 0) {
      proposal.reviewRevision = proposal.decisions.length;
    }
    proposal.reviewHash = configurationReviewHash(proposal);
    const source = proposal.source as Partial<typeof proposal.source>;
    const verifiedSource = source.kind === "ai-generated"
      && typeof source.invocationId === "string"
      && typeof source.projectId === "string"
      && Number.isInteger(source.projectVersion)
      && typeof source.projectRoleId === "string"
      && Number.isInteger(source.projectBindingVersion)
      && typeof source.employeeId === "string"
      && Number.isInteger(source.employeeVersion)
      && typeof source.requestedBy === "string"
      && typeof source.sessionId === "string"
      && typeof source.runId === "string";
    const reviewItemIds = new Set(proposal.reviewItems.map((item) => item.id));
    const validLedger = reviewItemIds.size === proposal.reviewItems.length
      && proposal.decisions.every((decision) => reviewItemIds.has(decision.reviewItemId) && decision.planHash === proposal.planHash);
    if (!verifiedSource || !validLedger) {
      const integrityError = !verifiedSource
        ? "legacy configuration proposal has no verifiable source Run"
        : "configuration proposal review ledger is invalid";
      if (["awaiting-review", "ready-to-apply", "applying", "needs-reapproval"].includes(proposal.status)) {
        proposal.status = "needs-reapproval";
        proposal.error = `${integrityError}; create a fresh proposal`;
      } else {
        proposal.error = `${integrityError}; historical outcome was preserved but its audit evidence is incomplete`;
      }
      proposal.validation = { valid: false, errors: [proposal.error] };
    }
  }
  state.managementPolicies ??= {};
  state.entrancePolicies ??= {};
  state.invocations ??= {};
  state.workInstances ??= {};
  state.humanDecisionRequests ??= {};
  state.projects ??= {};
  state.projectBindings ??= {};
  state.passiveProjectAccesses ??= {};
  state.employeeTemplates ??= {};
  for (const activity of [...Object.values(state.invocations), ...Object.values(state.workInstances)]) {
    const source = activity.source;
    if (source.label) source.label = decodeUtf8HeaderValue(source.label);
    if (source.project) source.project = decodeUtf8HeaderValue(source.project);
    if (source.caller) source.caller = decodeUtf8HeaderValue(source.caller);
    if (source.contextId) source.contextId = decodeUtf8HeaderValue(source.contextId);
  }
  normalizePassiveProjectAccesses(state);
  for (const skill of Object.values(state.skills)) {
    skill.status ??= "active";
    skill.owner ??= "user";
    skill.injection ??= "none";
    skill.summary ??= backfillSkillSummary(skill.description);
  }
  for (const versions of Object.values(state.skillHistory)) {
    for (const skill of versions) {
      skill.status ??= "active";
      skill.owner ??= "user";
      skill.injection ??= "none";
      skill.summary ??= backfillSkillSummary(skill.description);
    }
  }
  ensureSystemSkills(state);
  backfillSystemEmployeeRoles(state);
  const orchestrationSkillVersion = state.skills["team-orchestration"]!.version;
  for (const record of Object.values(state.workflows)) {
    for (const workflow of record.versions) {
      if (workflow.architecture !== "supervisor") continue;
      workflow.updatePolicy ??= "latest";
      workflow.orchestrationSkill ??= { id: "team-orchestration", version: orchestrationSkillVersion };
      workflow.flow ??= defaultSupervisorFlow();
      workflow.flow.version ??= 1;
      workflow.flow.stages ??= defaultSupervisorFlow().stages;
      workflow.flow.gates ??= [];
    }
    record.current = record.versions.find((workflow) => workflow.version === record.current.version) ?? record.current;
    if (record.current.architecture === "supervisor") {
      record.current.updatePolicy ??= "latest";
      record.current.orchestrationSkill ??= { id: "team-orchestration", version: orchestrationSkillVersion };
      record.current.flow ??= defaultSupervisorFlow();
    }
  }
  for (const record of Object.values(state.employees)) {
    for (const employee of record.versions) {
      employee.capabilities ??= [];
      employee.scope ??= legacyProjectScope(employee);
      employee.skills = employee.skills.filter((binding) => {
        const id = typeof binding === "string" ? binding : binding.id;
        return state.skills[id]?.owner !== "system";
      });
      employee.knowledgeProfileIds ??= [];
      employee.knowledgeGrants = normalizedStoredGrants(
        employee.knowledgeProfileIds,
        employee.knowledgeGrants,
        employee.createdAt
      );
      employee.skillVersions ??= Object.fromEntries(
        employee.skills.map((binding) => {
          const id = typeof binding === "string" ? binding : binding.id;
          return [id, state.skills[id]?.version ?? 1];
        })
      );
      for (const skillId of Object.keys(employee.skillVersions)) {
        if (!employee.skills.some((binding) => (typeof binding === "string" ? binding : binding.id) === skillId)) {
          delete employee.skillVersions[skillId];
        }
      }
    }
    record.current = record.versions.find((employee) => employee.version === record.current.version) ?? record.current;
    record.current.knowledgeProfileIds ??= [];
    record.current.capabilities ??= [];
    record.current.scope ??= legacyProjectScope(record.current);
    record.current.knowledgeGrants = normalizedStoredGrants(
      record.current.knowledgeProfileIds,
      record.current.knowledgeGrants,
      record.current.createdAt
    );
    record.current.skillVersions ??= Object.fromEntries(
      record.current.skills.map((binding) => {
        const id = typeof binding === "string" ? binding : binding.id;
        return [id, state.skills[id]?.version ?? 1];
      })
    );
  }
  for (const record of Object.values(state.projects)) {
    for (const project of record.versions) {
      for (const role of project.roles) {
        role.knowledgeProfileIds ??= [];
        role.requiredProviderProfiles ??= [];
      }
    }
    for (const role of record.current.roles) {
      role.knowledgeProfileIds ??= [];
      role.requiredProviderProfiles ??= [];
    }
  }
  for (const record of Object.values(state.projectBindings)) {
    for (const binding of record.versions) {
      for (const role of binding.roles) role.knowledgeProfileIds ??= [];
      for (const role of binding.roles) {
        role.knowledgeGrants = normalizedStoredGrants(role.knowledgeProfileIds, role.knowledgeGrants, binding.createdAt);
      }
    }
    for (const role of record.current.roles) {
      role.knowledgeProfileIds ??= [];
      role.knowledgeGrants = normalizedStoredGrants(role.knowledgeProfileIds, role.knowledgeGrants, record.current.createdAt);
    }
  }
  return state;
}

async function fsyncPath(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(dirPath: string): Promise<void> {
  const handle = await fs.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsyncPath(temporaryPath);
  await fs.rename(temporaryPath, filePath);
  await fsyncDirectory(path.dirname(filePath));
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
      return async () => {
        await handle.close();
        await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.min(attempt, 40)));
    }
  }
  throw new Error(`timed out waiting for Workbench state lock: ${lockPath}`);
}

// ---------------------------------------------------------------------------
// Store v2: config document + append-only activity shards (design A3)
// ---------------------------------------------------------------------------

/** Loose envelope for parsing state.json before its schema version is known. */
type PersistedEnvelope = { schemaVersion: number } & Record<string, unknown>;

const CONFIG_DOMAINS = [
  "providers",
  "skills",
  "skillHistory",
  "knowledgeBases",
  "knowledgeProfiles",
  "knowledgeChangeRequests",
  "workflowChangeRequests",
  "configurationProposals",
  "employees",
  "employeeTemplates",
  "managementPolicies",
  "entrancePolicies",
  "workflows",
  "publications",
  "projects",
  "projectBindings",
  "passiveProjectAccesses",
  "humanDecisionRequests"
] as const;

function pickConfig(state: WorkbenchState): WorkbenchConfigState {
  const config = {} as WorkbenchConfigState;
  for (const domain of CONFIG_DOMAINS) {
    (config as Record<string, unknown>)[domain] = state[domain];
  }
  return config;
}

function activityOf(state: WorkbenchState): ActivityState {
  return {
    sessions: state.sessions,
    workInstances: state.workInstances,
    invocations: state.invocations
  };
}

function assembleState(config: WorkbenchConfigState, activity: ActivityState): WorkbenchState {
  return {
    schemaVersion: 1,
    ...config,
    sessions: activity.sessions,
    workInstances: activity.workInstances,
    invocations: activity.invocations
  } as WorkbenchState;
}

function sha256Digest(content: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function shardDir(root: string, entity: ActivityEntity): string {
  return path.join(root, "activity", ACTIVITY_SHARD_DIRS[entity]);
}

function shardBasePath(root: string, entity: ActivityEntity): string {
  return path.join(shardDir(root, entity), "base.json");
}

function shardLogPath(root: string, entity: ActivityEntity): string {
  return path.join(shardDir(root, entity), "log.jsonl");
}

function hasActivityData(state: WorkbenchState): boolean {
  return Object.keys(state.sessions).length > 0
    || Object.keys(state.invocations).length > 0
    || Object.keys(state.workInstances).length > 0;
}

function isActivityLogEvent(value: unknown): value is ActivityLogEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.v !== 1 || typeof event.seq !== "number" || typeof event.op !== "string") return false;
  if (event.op === "record.upsert") return typeof event.id === "string" && "record" in event;
  if (event.op === "record.delete") return typeof event.id === "string";
  if (event.op === "messages.append") {
    return event.entity === "sessions" && typeof event.id === "string"
      && event.message !== null && typeof event.message === "object";
  }
  return false;
}

interface ParsedLog {
  events: ActivityLogEvent[];
  /** Byte offset just past the last complete (parsed) line. */
  lastValidEnd: number;
  /** True when the final line could not be parsed (torn append). */
  tailTorn: boolean;
}

/** Parses log content line by line; a torn tail is reported, not fatal. */
function parseLogContent(raw: string): ParsedLog {
  const events: ActivityLogEvent[] = [];
  let lineStart = 0;
  const lineEnds: number[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === "\n") {
      lineEnds.push(index + 1);
      lineStart = index + 1;
    }
  }
  const hasTrailingFragment = lineStart < raw.length;
  const boundaries = [...lineEnds];
  if (hasTrailingFragment) boundaries.push(raw.length);
  let lastValidEnd = 0;
  let tailTorn = false;
  for (let index = 0; index < boundaries.length; index += 1) {
    const end = boundaries[index]!;
    const start = index === 0 ? 0 : boundaries[index - 1]!;
    const text = raw.slice(start, end).replace(/\n$/, "");
    if (text.trim().length === 0) {
      lastValidEnd = end;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (index === boundaries.length - 1) {
        tailTorn = true;
        break;
      }
      throw new Error(`corrupt activity log at byte ${start}`);
    }
    if (!isActivityLogEvent(parsed)) {
      if (index === boundaries.length - 1) {
        tailTorn = true;
        break;
      }
      throw new Error(`invalid activity event at byte ${start}`);
    }
    events.push(parsed);
    lastValidEnd = end;
  }
  return { events, lastValidEnd, tailTorn };
}

interface ReplayedShard {
  records: Record<string, unknown>;
  lastSeq: number;
  /** Number of parsed (non-blank) log lines. */
  logEntries: number;
  truncatedTailBytes: number;
  skippedEvents: number;
}

function replayEvents(
  records: Record<string, unknown>,
  baseSeq: number,
  events: ActivityLogEvent[]
): { lastSeq: number; logEntries: number; skippedEvents: number } {
  let lastSeq = baseSeq;
  let skippedEvents = 0;
  let logEntries = 0;
  for (const event of events) {
    logEntries += 1;
    if (event.seq <= lastSeq) {
      skippedEvents += 1;
      continue;
    }
    if (event.op === "record.upsert") {
      records[event.id] = event.record;
    } else if (event.op === "record.delete") {
      delete records[event.id];
    } else {
      const session = records[event.id] as EmployeeSession | undefined;
      if (!session) {
        skippedEvents += 1;
        continue;
      }
      const dedupeKey = event.dedupeKey ?? event.message.dedupeKey;
      if (dedupeKey && session.messages.some((message) => message.dedupeKey === dedupeKey)) {
        skippedEvents += 1;
        continue;
      }
      if (event.dedupeKey && !event.message.dedupeKey) event.message.dedupeKey = event.dedupeKey;
      session.messages.push(event.message);
    }
    lastSeq = event.seq;
  }
  return { lastSeq, logEntries, skippedEvents };
}

async function replayShard(
  root: string,
  entity: ActivityEntity,
  manifest: ActivityShardManifest,
  options: { truncateTail?: boolean } = {}
): Promise<ReplayedShard> {
  const baseBytes = await fs.readFile(shardBasePath(root, entity));
  if (sha256Digest(baseBytes) !== manifest.baseSha256) {
    throw new Error(`activity shard ${entity} base.json sha256 mismatch`);
  }
  const records = JSON.parse(baseBytes.toString("utf8")) as Record<string, unknown>;
  let raw = "";
  try {
    raw = await fs.readFile(shardLogPath(root, entity), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { records, lastSeq: manifest.baseSeq, logEntries: 0, truncatedTailBytes: 0, skippedEvents: 0 };
  }
  const parsed = parseLogContent(raw);
  if (parsed.tailTorn && parsed.lastValidEnd < raw.length && options.truncateTail !== false) {
    await fs.truncate(shardLogPath(root, entity), parsed.lastValidEnd);
  }
  const replayed = replayEvents(records, manifest.baseSeq, parsed.events);
  return {
    records,
    lastSeq: replayed.lastSeq,
    logEntries: replayed.logEntries,
    truncatedTailBytes: parsed.tailTorn ? raw.length - parsed.lastValidEnd : 0,
    skippedEvents: replayed.skippedEvents
  };
}

function replayShardSync(root: string, entity: ActivityEntity, manifest: ActivityShardManifest): ReplayedShard {
  const baseBytes = readFileSync(shardBasePath(root, entity));
  if (sha256Digest(baseBytes) !== manifest.baseSha256) {
    throw new Error(`activity shard ${entity} base.json sha256 mismatch`);
  }
  const records = JSON.parse(baseBytes.toString("utf8")) as Record<string, unknown>;
  let raw = "";
  try {
    raw = readFileSync(shardLogPath(root, entity), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { records, lastSeq: manifest.baseSeq, logEntries: 0, truncatedTailBytes: 0, skippedEvents: 0 };
  }
  const parsed = parseLogContent(raw);
  if (parsed.tailTorn && parsed.lastValidEnd < raw.length) {
    truncateSync(shardLogPath(root, entity), parsed.lastValidEnd);
  }
  const replayed = replayEvents(records, manifest.baseSeq, parsed.events);
  return {
    records,
    lastSeq: replayed.lastSeq,
    logEntries: replayed.logEntries,
    truncatedTailBytes: parsed.tailTorn ? raw.length - parsed.lastValidEnd : 0,
    skippedEvents: replayed.skippedEvents
  };
}

/** Diffs two activity states into append events; sessions message-only appends use messages.append. */
function diffActivity(
  before: ActivityState,
  after: ActivityState,
  lastSeq: Record<ActivityEntity, number>,
  at: string
): { events: ActivityLogEvent[]; nextSeq: Record<ActivityEntity, number> } {
  const events: ActivityLogEvent[] = [];
  const nextSeq: Record<ActivityEntity, number> = { ...lastSeq };
  for (const entity of ACTIVITY_ENTITIES) {
    const beforeRecords = before[entity] as unknown as Record<string, Record<string, unknown>>;
    const afterRecords = after[entity] as unknown as Record<string, Record<string, unknown>>;
    for (const id of Object.keys(afterRecords)) {
      const beforeRecord = beforeRecords[id];
      const afterRecord = afterRecords[id]!;
      if (beforeRecord && JSON.stringify(beforeRecord) === JSON.stringify(afterRecord)) continue;
      if (entity === "sessions" && beforeRecord && onlyMessagesAppended(beforeRecord, afterRecord)) {
        const oldMessages = (beforeRecord.messages as EmployeeSessionMessage[] | undefined) ?? [];
        const newMessages = (afterRecord.messages as EmployeeSessionMessage[] | undefined) ?? [];
        for (const message of newMessages.slice(oldMessages.length)) {
          nextSeq[entity] += 1;
          events.push({
            v: 1, seq: nextSeq[entity], op: "messages.append", entity: "sessions",
            id, message, dedupeKey: message.dedupeKey, at
          });
        }
      } else {
        nextSeq[entity] += 1;
        events.push({ v: 1, seq: nextSeq[entity], op: "record.upsert", entity, id, record: afterRecord, at });
      }
    }
    for (const id of Object.keys(beforeRecords)) {
      if (!afterRecords[id]) {
        nextSeq[entity] += 1;
        events.push({ v: 1, seq: nextSeq[entity], op: "record.delete", entity, id, at });
      }
    }
  }
  return { events, nextSeq };
}

function onlyMessagesAppended(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const beforeMessages = (before.messages as EmployeeSessionMessage[] | undefined) ?? [];
  const afterMessages = (after.messages as EmployeeSessionMessage[] | undefined) ?? [];
  if (afterMessages.length < beforeMessages.length) return false;
  for (let index = 0; index < beforeMessages.length; index += 1) {
    if (JSON.stringify(beforeMessages[index]) !== JSON.stringify(afterMessages[index])) return false;
  }
  const beforeRest: Record<string, unknown> = { ...before };
  const afterRest: Record<string, unknown> = { ...after };
  delete beforeRest.messages;
  delete afterRest.messages;
  return JSON.stringify(beforeRest) === JSON.stringify(afterRest);
}

function applyAppendToState(state: WorkbenchState, append: ActivityAppend): void {
  if (append.op === "record.upsert") {
    (state[append.entity] as Record<string, unknown>)[append.id] = append.record;
  } else if (append.op === "record.delete") {
    delete (state[append.entity] as Record<string, unknown>)[append.id];
  } else {
    const session = state.sessions[append.id];
    if (!session) return;
    const dedupeKey = append.dedupeKey ?? append.message.dedupeKey;
    if (dedupeKey && session.messages.some((message) => message.dedupeKey === dedupeKey)) return;
    if (append.dedupeKey && !append.message.dedupeKey) append.message.dedupeKey = append.dedupeKey;
    session.messages.push(append.message);
  }
}

/**
 * One-shot v1 → v2 migration under the caller's lock. Writes shards, the v2
 * state document, and a `.v1.bak` backup, then reconciles the reassembled v2
 * state against the v1 parse per domain; any mismatch restores v1 and throws.
 */
async function migrateV1ToV2(
  root: string,
  v1Raw: string,
  v1: WorkbenchState
): Promise<{ config: WorkbenchConfigState; activity: ActivityState; manifests: ActivityManifests; report: NonNullable<StoreOpenReport["migration"]> }> {
  const started = Date.now();
  const backupPath = path.join(root, "state.json.v1.bak");
  await fs.writeFile(backupPath, v1Raw, "utf8");
  await fsyncPath(backupPath);

  const manifests = {} as ActivityManifests;
  const activity = {} as Record<ActivityEntity, Record<string, unknown>>;
  for (const entity of ACTIVITY_ENTITIES) {
    const dir = shardDir(root, entity);
    await fs.mkdir(dir, { recursive: true });
    const records = v1[entity] as unknown as Record<string, unknown>;
    const baseBytes = Buffer.from(`${JSON.stringify(records, null, 2)}\n`, "utf8");
    await fs.writeFile(shardBasePath(root, entity), baseBytes);
    await fsyncPath(shardBasePath(root, entity));
    await fs.writeFile(shardLogPath(root, entity), "", "utf8");
    await fsyncPath(shardLogPath(root, entity));
    manifests[entity] = { version: 1, baseSeq: 0, logEntries: 0, baseSha256: sha256Digest(baseBytes) };
    activity[entity] = structuredClone(records);
  }
  const config = pickConfig(v1);
  const v2: WorkbenchStateV2 = { schemaVersion: 2, config, activity: manifests };
  await writeJsonAtomic(path.join(root, "state.json"), v2);

  // Reconciliation: reassemble from disk and compare every domain with the v1 parse.
  const reassembled = await assembleFromDisk(root, v2);
  const domainSha256: Record<string, `sha256:${string}`> = {};
  for (const domain of [...CONFIG_DOMAINS, "sessions", "workInstances", "invocations"] as const) {
    const before = JSON.stringify(v1[domain]);
    const after = JSON.stringify(reassembled[domain]);
    if (before !== after) {
      await fs.writeFile(path.join(root, "state.json"), v1Raw, "utf8");
      await fs.rm(path.join(root, "activity"), { recursive: true, force: true });
      throw new Error(`v1→v2 migration reconciliation failed for domain ${String(domain)}`);
    }
    domainSha256[String(domain)] = sha256Digest(after);
  }
  return {
    config,
    activity: activity as unknown as ActivityState,
    manifests,
    report: {
      v1Sha256: sha256Digest(v1Raw),
      v2Sha256: sha256Digest(JSON.stringify(reassembled)),
      domainSha256,
      activityCounts: {
        sessions: Object.keys(v1.sessions).length,
        workInstances: Object.keys(v1.workInstances).length,
        invocations: Object.keys(v1.invocations).length
      },
      durationMs: Date.now() - started
    }
  };
}

async function assembleFromDisk(root: string, v2: WorkbenchStateV2): Promise<WorkbenchState> {
  const activity = {} as Record<ActivityEntity, Record<string, unknown>>;
  for (const entity of ACTIVITY_ENTITIES) {
    const replayed = await replayShard(root, entity, v2.activity[entity], { truncateTail: false });
    activity[entity] = replayed.records;
  }
  return assembleState(v2.config, activity as unknown as ActivityState);
}

export class WorkbenchStore {
  private state: WorkbenchState;
  private mutationQueue: Promise<void> = Promise.resolve();
  private snapshotMtimeMs = -1;
  private mode: "v1" | "v2";
  private config: WorkbenchConfigState | undefined;
  private activityState: ActivityState | undefined;
  private manifests: ActivityManifests | undefined;
  private lastSeq: Record<ActivityEntity, number> | undefined;
  private shardKeys: Partial<Record<ActivityEntity, string>> = {};
  private cacheKey = "";
  readonly openReport: StoreOpenReport;

  private constructor(
    public readonly dataRoot: string,
    state: WorkbenchState,
    mode: "v1" | "v2",
    openReport: StoreOpenReport
  ) {
    this.state = state;
    this.mode = mode;
    this.openReport = openReport;
  }

  static async open(dataRoot: string): Promise<WorkbenchStore> {
    const resolvedRoot = path.resolve(dataRoot);
    await fs.mkdir(resolvedRoot, { recursive: true });
    const statePath = path.join(resolvedRoot, "state.json");
    const report: StoreOpenReport = { migrated: false, truncatedTail: [], manifestDrift: [], skippedEvents: 0 };
    let raw: string;
    try {
      raw = await fs.readFile(statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const state = initialState();
      await writeJsonAtomic(statePath, state);
      return new WorkbenchStore(resolvedRoot, state, "v1", report);
    }
    const persisted = JSON.parse(raw) as PersistedEnvelope;
    if (persisted.schemaVersion === 2) {
      return await WorkbenchStore.openV2(resolvedRoot, persisted as unknown as WorkbenchStateV2, report);
    }
    if (persisted.schemaVersion !== 1) {
      throw new Error(`unsupported workbench schema version ${String(persisted.schemaVersion)}`);
    }
    const persistedV1 = persisted as unknown as WorkbenchState;
    if (!hasActivityData(persistedV1)) {
      return WorkbenchStore.openV1Legacy(resolvedRoot, statePath, persistedV1, report);
    }
    // v1 with activity data: migrate under the global lock (double-checked).
    const release = await acquireFileLock(path.join(resolvedRoot, "state.lock"));
    try {
      const latestRaw = await fs.readFile(statePath, "utf8");
      const latest = JSON.parse(latestRaw) as PersistedEnvelope;
      if (latest.schemaVersion === 2) {
        return await WorkbenchStore.openV2(resolvedRoot, latest as unknown as WorkbenchStateV2, report);
      }
      if (latest.schemaVersion !== 1) {
        throw new Error(`unsupported workbench schema version ${String(latest.schemaVersion)}`);
      }
      const normalized = normalizeState(structuredClone(latest as unknown as WorkbenchState)) as WorkbenchState;
      const migration = await migrateV1ToV2(resolvedRoot, latestRaw, normalized);
      report.migrated = true;
      report.migration = migration.report;
      const store = new WorkbenchStore(resolvedRoot, normalized, "v2", report);
      store.config = migration.config;
      store.activityState = migration.activity;
      store.manifests = migration.manifests;
      store.lastSeq = { sessions: 0, workInstances: 0, invocations: 0 };
      store.cacheKey = store.currentCacheKey();
      return store;
    } finally {
      await release();
    }
  }

  /** v1 without activity data: the legacy normalize + passive-write-back path, unchanged. */
  private static async openV1Legacy(
    resolvedRoot: string,
    statePath: string,
    persisted: WorkbenchState,
    report: StoreOpenReport
  ): Promise<WorkbenchStore> {
    const passiveBefore = JSON.stringify(persisted.passiveProjectAccesses ?? {});
    let state = normalizeState(persisted);
    if (state.schemaVersion !== 1) throw new Error(`unsupported workbench schema version ${String(state.schemaVersion)}`);
    if (passiveBefore !== JSON.stringify(state.passiveProjectAccesses)) {
      const release = await acquireFileLock(path.join(resolvedRoot, "state.lock"));
      try {
        const latestRaw = await fs.readFile(statePath, "utf8");
        const latestEnvelope = JSON.parse(latestRaw) as PersistedEnvelope;
        if (latestEnvelope.schemaVersion === 2) {
          // Another process migrated under us; v2 migration already normalized passive accesses.
          const v2 = latestEnvelope as unknown as WorkbenchStateV2;
          const activity = {} as Record<ActivityEntity, Record<string, unknown>>;
          for (const entity of ACTIVITY_ENTITIES) {
            activity[entity] = (await replayShard(resolvedRoot, entity, v2.activity[entity])).records;
          }
          state = normalizeState(assembleState(v2.config, activity as unknown as ActivityState));
          return new WorkbenchStore(resolvedRoot, state, "v2", report);
        }
        const latestPersisted = latestEnvelope as unknown as WorkbenchState;
        const latestPassiveBefore = JSON.stringify(latestPersisted.passiveProjectAccesses ?? {});
        const latest = normalizeState(structuredClone(latestPersisted));
        if (latestPassiveBefore !== JSON.stringify(latest.passiveProjectAccesses)) {
          latestPersisted.passiveProjectAccesses = latest.passiveProjectAccesses;
          await writeJsonAtomic(statePath, latestPersisted);
        }
        state = latest;
      } finally {
        await release();
      }
    }
    return new WorkbenchStore(resolvedRoot, state, "v1", report);
  }

  private static async openV2(
    resolvedRoot: string,
    v2: WorkbenchStateV2,
    report: StoreOpenReport
  ): Promise<WorkbenchStore> {
    const activity = {} as Record<ActivityEntity, Record<string, unknown>>;
    const lastSeq: Record<ActivityEntity, number> = { sessions: 0, workInstances: 0, invocations: 0 };
    for (const entity of ACTIVITY_ENTITIES) {
      const manifest = v2.activity[entity];
      const replayed = await replayShard(resolvedRoot, entity, manifest);
      activity[entity] = replayed.records;
      lastSeq[entity] = replayed.lastSeq;
      if (replayed.truncatedTailBytes > 0) {
        report.truncatedTail.push({ entity, bytesDropped: replayed.truncatedTailBytes });
      }
      if (manifest.logEntries !== replayed.logEntries) {
        report.manifestDrift.push({ entity, expected: manifest.logEntries, actual: replayed.logEntries });
      }
      report.skippedEvents += replayed.skippedEvents;
    }
    const state = normalizeState(assembleState(v2.config, activity as unknown as ActivityState));
    const store = new WorkbenchStore(resolvedRoot, state, "v2", report);
    store.config = v2.config;
    store.activityState = activity as unknown as ActivityState;
    store.manifests = v2.activity;
    store.lastSeq = lastSeq;
    store.cacheKey = store.currentCacheKey();
    return store;
  }

  snapshot(): WorkbenchState {
    if (this.mode === "v1") {
      const statePath = path.join(this.dataRoot, "state.json");
      const mtimeMs = statSync(statePath).mtimeMs;
      if (mtimeMs === this.snapshotMtimeMs) return structuredClone(this.state);
      const raw = readFileSync(statePath, "utf8");
      if (this.adoptV2(raw)) return structuredClone(this.state);
      const latest = normalizeState(JSON.parse(raw) as WorkbenchState);
      if (latest.schemaVersion !== 1) throw new Error(`unsupported workbench schema version ${String(latest.schemaVersion)}`);
      this.state = latest;
      this.snapshotMtimeMs = mtimeMs;
      return structuredClone(this.state);
    }
    const key = this.currentCacheKey();
    if (key === this.cacheKey) return structuredClone(this.state);
    this.reloadV2Sync();
    this.cacheKey = key;
    return structuredClone(this.state);
  }

  /**
   * Adopts a v2 layout migrated by another process while this instance was open
   * in v1 mode (daemon/CLI interleave). Returns false when the content is still v1.
   */
  private adoptV2(raw: string): boolean {
    const parsed = JSON.parse(raw) as PersistedEnvelope;
    if (parsed.schemaVersion !== 2) return false;
    const v2 = parsed as unknown as WorkbenchStateV2;
    const activity = {} as Record<ActivityEntity, Record<string, unknown>>;
    const lastSeq: Record<ActivityEntity, number> = { sessions: 0, workInstances: 0, invocations: 0 };
    for (const entity of ACTIVITY_ENTITIES) {
      const replayed = replayShardSync(this.dataRoot, entity, v2.activity[entity]);
      activity[entity] = replayed.records;
      lastSeq[entity] = replayed.lastSeq;
    }
    this.config = v2.config;
    this.manifests = v2.activity;
    this.activityState = activity as unknown as ActivityState;
    this.lastSeq = lastSeq;
    this.shardKeys = {};
    this.state = normalizeState(assembleState(v2.config, this.activityState));
    this.mode = "v2";
    this.cacheKey = this.currentCacheKey();
    return true;
  }

  async mutate<T>(mutation: (state: WorkbenchState) => T | Promise<T>): Promise<T> {
    if (this.mode === "v1") return this.mutateV1(mutation);
    return this.writeLocked(() => this.writeV2Mutation(mutation));
  }

  /** Applies a full-state mutation in v2 mode (diff → activity-first persist). Caller must hold the lock. */
  private async writeV2Mutation<T>(mutation: (state: WorkbenchState) => T | Promise<T>): Promise<T> {
    this.reloadV2Sync();
    const before = this.state;
    const next = structuredClone(before);
    const result = await mutation(next);
    const configChanged = (CONFIG_DOMAINS as readonly string[]).some(
      (domain) => JSON.stringify(before[domain as keyof WorkbenchState]) !== JSON.stringify(next[domain as keyof WorkbenchState])
    );
    const { events, nextSeq } = diffActivity(
      activityOf(before),
      activityOf(next),
      this.lastSeq!,
      new Date().toISOString()
    );
    if (configChanged || events.length > 0) {
      await this.persistV2(next, events);
      this.lastSeq = nextSeq;
    }
    return result;
  }

  /** Config-only write: the 18 configuration domains, untouched activity shards. */
  async mutateConfig<T>(mutation: (config: WorkbenchConfigState) => T | Promise<T>): Promise<T> {
    if (this.mode === "v1") {
      return this.mutate((state) => {
        const slice = pickConfig(state);
        const result = mutation(slice);
        for (const domain of CONFIG_DOMAINS) {
          (state as unknown as Record<string, unknown>)[domain] = slice[domain];
        }
        return result;
      });
    }
    return this.writeLocked(async () => {
      this.reloadV2Sync();
      const nextConfig = structuredClone(this.config!);
      const result = await mutation(nextConfig);
      const v2: WorkbenchStateV2 = { schemaVersion: 2, config: nextConfig, activity: this.manifests! };
      await writeJsonAtomic(path.join(this.dataRoot, "state.json"), v2);
      this.config = nextConfig;
      this.state = normalizeState(assembleState(nextConfig, this.activityState!));
      this.cacheKey = this.currentCacheKey();
      return result;
    });
  }

  /** Activity-only write: record-level diff becomes upsert/delete events. */
  async mutateActivity<T>(mutation: (activity: ActivityState) => T | Promise<T>): Promise<T> {
    if (this.mode === "v1") {
      return this.mutate((state) => {
        const slice = activityOf(state);
        const result = mutation(slice);
        state.sessions = slice.sessions;
        state.workInstances = slice.workInstances;
        state.invocations = slice.invocations;
        return result;
      });
    }
    return this.writeLocked(async () => {
      this.reloadV2Sync();
      const before = this.activityState!;
      const next = structuredClone(before) as ActivityState;
      const result = await mutation(next);
      const { events, nextSeq } = diffActivity(before, next, this.lastSeq!, new Date().toISOString());
      if (events.length > 0) {
        await this.persistV2(assembleState(this.config!, next), events);
        this.lastSeq = nextSeq;
      }
      return result;
    });
  }

  /** Hot-path single-event append (session messages, status transitions). */
  async appendActivity(append: ActivityAppend): Promise<void> {
    if (this.mode === "v1") {
      await this.mutate((state) => {
        applyAppendToState(state, append);
      });
      return;
    }
    await this.writeLocked(async () => {
      this.reloadV2Sync();
      const entity = append.entity;
      const seq = this.lastSeq![entity] + 1;
      const at = new Date().toISOString();
      const event: ActivityLogEvent = append.op === "messages.append"
        ? { v: 1, seq, op: "messages.append", entity: append.entity, id: append.id, message: append.message, dedupeKey: append.dedupeKey, at }
        : append.op === "record.upsert"
          ? { v: 1, seq, op: "record.upsert", entity, id: append.id, record: append.record, at }
          : { v: 1, seq, op: "record.delete", entity, id: append.id, at };
      await this.persistV2(this.state, [event]);
      this.lastSeq![entity] = seq;
    });
  }

  private async writeLocked<T>(body: () => Promise<T>): Promise<T> {
    let result: T | undefined;
    let failure: unknown;
    this.mutationQueue = this.mutationQueue.then(async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquireFileLock(path.join(this.dataRoot, "state.lock"));
        result = await body();
      } catch (error) {
        failure = error;
      } finally {
        await release?.();
      }
    });
    await this.mutationQueue;
    if (failure) throw failure;
    return result as T;
  }

  private async mutateV1<T>(mutation: (state: WorkbenchState) => T | Promise<T>): Promise<T> {
    let result: T | undefined;
    let failure: unknown;
    this.mutationQueue = this.mutationQueue.then(async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquireFileLock(path.join(this.dataRoot, "state.lock"));
        const raw = await fs.readFile(path.join(this.dataRoot, "state.json"), "utf8");
        if (this.adoptV2(raw)) {
          // Another process migrated while this instance was open in v1 mode.
          result = await this.writeV2Mutation(mutation);
          return;
        }
        const latest = normalizeState(JSON.parse(raw) as WorkbenchState);
        if (latest.schemaVersion !== 1) throw new Error(`unsupported workbench schema version ${String(latest.schemaVersion)}`);
        const next = structuredClone(latest);
        result = await mutation(next);
        await writeJsonAtomic(path.join(this.dataRoot, "state.json"), next);
        this.state = next;
        this.snapshotMtimeMs = -1;
      } catch (error) {
        failure = error;
      } finally {
        await release?.();
      }
    });
    await this.mutationQueue;
    if (failure) throw failure;
    return result as T;
  }

  /** Appends events to shard logs (activity first), then persists config + manifests. */
  private async persistV2(nextState: WorkbenchState, events: ActivityLogEvent[]): Promise<void> {
    const byEntity = new Map<ActivityEntity, ActivityLogEvent[]>();
    for (const event of events) {
      const list = byEntity.get(event.entity) ?? [];
      list.push(event);
      byEntity.set(event.entity, list);
    }
    for (const [entity, shardEvents] of byEntity) {
      const handle = await fs.open(shardLogPath(this.dataRoot, entity), "a");
      try {
        for (const event of shardEvents) {
          await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.manifests![entity].logEntries += shardEvents.length;
      for (const event of shardEvents) {
        applyEventToRecords(this.activityState![entity], event);
      }
    }
    const nextConfig = pickConfig(nextState);
    const v2: WorkbenchStateV2 = { schemaVersion: 2, config: nextConfig, activity: this.manifests! };
    await writeJsonAtomic(path.join(this.dataRoot, "state.json"), v2);
    this.config = nextConfig;
    this.state = normalizeState(assembleState(nextConfig, this.activityState!));
    this.cacheKey = this.currentCacheKey();
  }

  /** Re-reads the config document and replays shards changed on disk (cross-process). */
  private reloadV2Sync(): void {
    const v2 = JSON.parse(readFileSync(path.join(this.dataRoot, "state.json"), "utf8")) as WorkbenchStateV2;
    if (v2.schemaVersion !== 2) throw new Error(`unsupported workbench schema version ${String(v2.schemaVersion)}`);
    this.config = v2.config;
    this.manifests = v2.activity;
    for (const entity of ACTIVITY_ENTITIES) {
      let baseMtime = 0;
      let logSize = -1;
      let logMtime = 0;
      try {
        baseMtime = statSync(shardBasePath(this.dataRoot, entity)).mtimeMs;
        const logStat = statSync(shardLogPath(this.dataRoot, entity));
        logSize = logStat.size;
        logMtime = logStat.mtimeMs;
      } catch {
        // shard files missing → key stays distinct from any cached value
      }
      const key = `${baseMtime}:${logSize}:${logMtime}`;
      if (key === this.shardKeys[entity]) continue;
      const replayed = replayShardSync(this.dataRoot, entity, v2.activity[entity]);
      (this.activityState! as Record<ActivityEntity, Record<string, unknown>>)[entity] = replayed.records;
      this.lastSeq![entity] = replayed.lastSeq;
      this.shardKeys[entity] = key;
    }
    this.state = normalizeState(assembleState(this.config, this.activityState!));
  }

  private currentCacheKey(): string {
    const parts: string[] = [];
    try {
      parts.push(`state:${statSync(path.join(this.dataRoot, "state.json")).mtimeMs}`);
    } catch {
      parts.push("state:missing");
    }
    for (const entity of ACTIVITY_ENTITIES) {
      try {
        parts.push(`${entity}-base:${statSync(shardBasePath(this.dataRoot, entity)).mtimeMs}`);
      } catch {
        parts.push(`${entity}-base:missing`);
      }
      try {
        const stat = statSync(shardLogPath(this.dataRoot, entity));
        parts.push(`${entity}-log:${stat.size}:${stat.mtimeMs}`);
      } catch {
        parts.push(`${entity}-log:missing`);
      }
    }
    return parts.join("|");
  }
}

function applyEventToRecords(records: Record<string, unknown>, event: ActivityLogEvent): void {
  if (event.op === "record.upsert") {
    records[event.id] = event.record;
  } else if (event.op === "record.delete") {
    delete records[event.id];
  } else {
    const session = records[event.id] as EmployeeSession | undefined;
    if (!session) return;
    const dedupeKey = event.dedupeKey ?? event.message.dedupeKey;
    if (dedupeKey && session.messages.some((message) => message.dedupeKey === dedupeKey)) return;
    if (event.dedupeKey && !event.message.dedupeKey) event.message.dedupeKey = event.dedupeKey;
    session.messages.push(event.message);
  }
}

/**
 * Read-only health check for `workbench store-verify`: replays every shard,
 * reconciles manifests, and (when a `.v1.bak` exists) reports drift against it.
 */
export async function verifyStore(dataRoot: string): Promise<StoreVerifyReport> {
  const root = path.resolve(dataRoot);
  const report: StoreVerifyReport = { ok: true, dataRoot: root, schemaVersion: 1, notes: [] };
  const statePath = path.join(root, "state.json");
  const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as PersistedEnvelope;
  if (parsed.schemaVersion === 1) {
    report.notes.push("v1 state.json; no shards to verify");
    return report;
  }
  if (parsed.schemaVersion !== 2) {
    throw new Error(`unsupported workbench schema version ${String(parsed.schemaVersion)}`);
  }
  const v2 = parsed as unknown as WorkbenchStateV2;
  report.schemaVersion = 2;
  report.shards = [];
  for (const entity of ACTIVITY_ENTITIES) {
    const manifest = v2.activity[entity];
    const baseBytes = await fs.readFile(shardBasePath(root, entity));
    const baseSha256Matches = sha256Digest(baseBytes) === manifest.baseSha256;
    if (!baseSha256Matches) report.ok = false;
    let recordCount = 0;
    if (baseSha256Matches) {
      const replayed = await replayShard(root, entity, manifest, { truncateTail: false });
      recordCount = Object.keys(replayed.records).length;
    } else {
      recordCount = Object.keys(JSON.parse(baseBytes.toString("utf8")) as Record<string, unknown>).length;
    }
    let logRaw = "";
    try {
      logRaw = await fs.readFile(shardLogPath(root, entity), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const actualLines = logRaw === "" ? 0 : logRaw.split("\n").filter((line) => line.trim().length > 0).length;
    const torn = parseLogContent(logRaw).tailTorn;
    if (torn) report.ok = false;
    if (manifest.logEntries !== actualLines) report.ok = false;
    report.shards.push({
      entity,
      baseSha256Matches,
      logEntriesExpected: manifest.logEntries,
      logEntriesActual: actualLines,
      recordCount,
      truncatedTail: torn
    });
  }
  const backupPath = path.join(root, "state.json.v1.bak");
  try {
    const backupRaw = await fs.readFile(backupPath, "utf8");
    const backup = JSON.parse(backupRaw) as WorkbenchState;
    if (report.shards?.every((shard) => shard.baseSha256Matches)) {
      const assembled = await assembleFromDisk(root, v2);
      const backupDrift: Record<ActivityEntity, { backup: number; current: number }> = {} as Record<ActivityEntity, { backup: number; current: number }>;
      for (const entity of ACTIVITY_ENTITIES) {
        backupDrift[entity] = {
          backup: Object.keys(backup[entity]).length,
          current: Object.keys(assembled[entity]).length
        };
      }
      report.backupDrift = backupDrift;
    }
    report.notes.push(`state.json.v1.bak present (sha256 ${sha256Digest(backupRaw)})`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return report;
}
