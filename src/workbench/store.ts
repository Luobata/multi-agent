import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeUtf8HeaderValue } from "../core/httpHeaders.js";
import { configurationReviewHash, configurationReviewProgress } from "../configuration/proposal.js";
import type { ProviderDefinition } from "../core/types.js";
import type { KnowledgeProfileGrant } from "../knowledge/types.js";
import { isSystemManagedProviderId, systemProviderRuntimeProfiles } from "../runtime/systemProviders.js";
import type { EmployeeDefinition, WorkbenchSkillDefinition, WorkbenchState } from "./types.js";
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
const TEAM_ORCHESTRATION_SKILL_VERSION = 7;
const TEAM_ORCHESTRATION_INSTRUCTIONS = [
  "Coordinate the assigned team within the Supervisor workflow policy. Delegate explicit work, preserve evidence, respect runtime limits and gates, and finish only when the required work is complete.",
  "For any coding, test, audit, or integration request that needs more than one bounded milestone, first emit plan-todos. Split the work into dependency-ordered TODOs with one verifiable outcome each. Do not paste the whole request into every TODO. Give sequential TODOs handled by the same role on the same changeSet one stable sessionKey; the runtime preserves that member's logical Work Instance and prior bounded outputs between calls, serializes the session, and releases it only after its last planned TODO or the Run terminates. Delegate only ready todoId values and let the runtime inject the immutable planned task. While a TODO plan is active, every assignment must carry the exact planned todoId and must not override its task, roleId, workKind, or changeSet. Do not invent an unplanned test or audit assignment after implementation: once all required TODOs pass, emit finish and let the runtime execute the configured quality Gates automatically. Independent TODOs may run in parallel within maxParallelDelegations.",
  "Every coding plan or direct coding delegation must include a structured impact assessment. Base it on changed files and contracts, UI routes, APIs, persistence/state boundaries, concurrency, security, migrations, shared packages, and target-branch drift. Choose regressionScope=targeted for local low-risk changes, package for shared/package behavior, and full only for high-risk cross-boundary or integration changes. List concrete requiredChecks. Downstream test and audit Gates receive this assessment and must reuse same-commit evidence, run only the recorded scope, and return to the leader before widening it. Never request full regression by habit.",
  "For oversized validation, derive independent domains from acceptance criteria and split them into two or three same-changeSet TODOs. Each test TODO covers at most one main path, one related failure path, one targeted automation group, and one necessary type/build check. Later Gates reuse same-commit shard evidence and run only the smallest missing cross-shard check; never ask one tester to repeat every shard or debug test infrastructure indefinitely.",
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

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
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

export class WorkbenchStore {
  private state: WorkbenchState;
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    public readonly dataRoot: string,
    state: WorkbenchState
  ) {
    this.state = state;
  }

  static async open(dataRoot: string): Promise<WorkbenchStore> {
    const resolvedRoot = path.resolve(dataRoot);
    await fs.mkdir(resolvedRoot, { recursive: true });
    const statePath = path.join(resolvedRoot, "state.json");
    let state: WorkbenchState;
    try {
      const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as WorkbenchState;
      const passiveBefore = JSON.stringify(persisted.passiveProjectAccesses ?? {});
      state = normalizeState(persisted);
      if (state.schemaVersion !== 1) throw new Error(`unsupported workbench schema version ${String(state.schemaVersion)}`);
      if (passiveBefore !== JSON.stringify(state.passiveProjectAccesses)) {
        const release = await acquireFileLock(path.join(resolvedRoot, "state.lock"));
        try {
          const latestPersisted = JSON.parse(await fs.readFile(statePath, "utf8")) as WorkbenchState;
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = initialState();
      await writeJsonAtomic(statePath, state);
    }
    return new WorkbenchStore(resolvedRoot, state);
  }

  snapshot(): WorkbenchState {
    const latest = normalizeState(JSON.parse(readFileSync(path.join(this.dataRoot, "state.json"), "utf8")) as WorkbenchState);
    if (latest.schemaVersion !== 1) throw new Error(`unsupported workbench schema version ${String(latest.schemaVersion)}`);
    this.state = latest;
    return structuredClone(this.state);
  }

  async mutate<T>(mutation: (state: WorkbenchState) => T | Promise<T>): Promise<T> {
    let result: T | undefined;
    let failure: unknown;
    this.mutationQueue = this.mutationQueue.then(async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquireFileLock(path.join(this.dataRoot, "state.lock"));
        const latest = normalizeState(JSON.parse(await fs.readFile(path.join(this.dataRoot, "state.json"), "utf8")) as WorkbenchState);
        if (latest.schemaVersion !== 1) throw new Error(`unsupported workbench schema version ${String(latest.schemaVersion)}`);
        const next = structuredClone(latest);
        result = await mutation(next);
        await writeJsonAtomic(path.join(this.dataRoot, "state.json"), next);
        this.state = next;
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
}
