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
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SYSTEM_SKILL_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function teamOrchestrationSkill(version = 1, createdAt = SYSTEM_SKILL_TIMESTAMP): WorkbenchSkillDefinition {
  return {
    id: "team-orchestration",
    version,
    status: "active",
    owner: "system",
    injection: "supervisor",
    displayName: "Team orchestration",
    description: "System-owned guidance for a Supervisor runtime that plans, delegates, verifies, and delivers team work.",
    instructions: "Coordinate the assigned team within the Supervisor workflow policy. Delegate explicit work, preserve evidence, respect runtime limits and gates, and finish only when the required work is complete.",
    tools: [],
    createdAt,
    updatedAt: SYSTEM_SKILL_TIMESTAMP
  };
}

function ensureSystemSkills(state: WorkbenchState): void {
  const existing = state.skills["team-orchestration"];
  if (!existing) {
    const skill = teamOrchestrationSkill();
    state.skills[skill.id] = skill;
    state.skillHistory[skill.id] = [skill];
    return;
  }
  if (existing.owner === "system" && existing.injection === "supervisor") return;
  const skill = teamOrchestrationSkill(existing.version + 1, existing.createdAt);
  state.skills[skill.id] = skill;
  (state.skillHistory[skill.id] ??= [existing]).push(skill);
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
      "codex-configuration-control": codexConfigurationControlProvider()
    },
    skills: { "team-orchestration": teamOrchestrationSkill() },
    skillHistory: { "team-orchestration": [teamOrchestrationSkill()] },
    knowledgeBases: {},
    knowledgeProfiles: {},
    knowledgeChangeRequests: {},
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
    invocations: {},
    workInstances: {}
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
  state.skillHistory ??= Object.fromEntries(
    Object.entries(state.skills).map(([id, skill]) => [id, [skill]])
  );
  state.knowledgeBases ??= {};
  state.knowledgeProfiles ??= {};
  state.knowledgeChangeRequests ??= {};
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
  state.projects ??= {};
  state.projectBindings ??= {};
  state.employeeTemplates ??= {};
  for (const activity of [...Object.values(state.invocations), ...Object.values(state.workInstances)]) {
    const source = activity.source;
    if (source.label) source.label = decodeUtf8HeaderValue(source.label);
    if (source.project) source.project = decodeUtf8HeaderValue(source.project);
    if (source.caller) source.caller = decodeUtf8HeaderValue(source.caller);
    if (source.contextId) source.contextId = decodeUtf8HeaderValue(source.contextId);
  }
  for (const skill of Object.values(state.skills)) {
    skill.status ??= "active";
    skill.owner ??= "user";
    skill.injection ??= "none";
  }
  for (const versions of Object.values(state.skillHistory)) {
    for (const skill of versions) {
      skill.status ??= "active";
      skill.owner ??= "user";
      skill.injection ??= "none";
    }
  }
  ensureSystemSkills(state);
  const orchestrationSkillVersion = state.skills["team-orchestration"]!.version;
  for (const record of Object.values(state.workflows)) {
    for (const workflow of record.versions) {
      if (workflow.architecture !== "supervisor") continue;
      workflow.orchestrationSkill ??= { id: "team-orchestration", version: orchestrationSkillVersion };
      workflow.flow ??= defaultSupervisorFlow();
      workflow.flow.version ??= 1;
      workflow.flow.stages ??= defaultSupervisorFlow().stages;
      workflow.flow.gates ??= [];
    }
    record.current = record.versions.find((workflow) => workflow.version === record.current.version) ?? record.current;
    if (record.current.architecture === "supervisor") {
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
      state = normalizeState(JSON.parse(await fs.readFile(statePath, "utf8")) as WorkbenchState);
      if (state.schemaVersion !== 1) throw new Error(`unsupported workbench schema version ${String(state.schemaVersion)}`);
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
