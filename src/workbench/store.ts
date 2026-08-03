import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeUtf8HeaderValue } from "../core/httpHeaders.js";
import type { ProviderDefinition } from "../core/types.js";
import type { KnowledgeProfileGrant } from "../knowledge/types.js";
import type { WorkbenchState } from "./types.js";

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
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

function initialState(): WorkbenchState {
  return {
    schemaVersion: 1,
    providers: {
      mock: {
        adapter: "mock",
        model: "deterministic-mock",
        outputProtocol: "json"
      },
      "codex-knowledge-control": codexKnowledgeControlProvider()
    },
    skills: {},
    skillHistory: {},
    knowledgeBases: {},
    knowledgeProfiles: {},
    knowledgeChangeRequests: {},
    employees: {},
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
  if (state.providers.mock?.adapter === "mock" && state.providers.mock.model === undefined) {
    state.providers.mock.model = "deterministic-mock";
  }
  const currentKnowledgeControl = state.providers["codex-knowledge-control"];
  state.providers["codex-knowledge-control"] = {
    ...codexKnowledgeControlProvider(),
    ...(typeof currentKnowledgeControl?.model === "string" ? { model: currentKnowledgeControl.model } : {})
  };
  state.skillHistory ??= Object.fromEntries(
    Object.entries(state.skills).map(([id, skill]) => [id, [skill]])
  );
  state.knowledgeBases ??= {};
  state.knowledgeProfiles ??= {};
  state.knowledgeChangeRequests ??= {};
  state.managementPolicies ??= {};
  state.entrancePolicies ??= {};
  state.invocations ??= {};
  state.workInstances ??= {};
  state.projects ??= {};
  state.projectBindings ??= {};
  for (const activity of [...Object.values(state.invocations), ...Object.values(state.workInstances)]) {
    const source = activity.source;
    if (source.label) source.label = decodeUtf8HeaderValue(source.label);
    if (source.project) source.project = decodeUtf8HeaderValue(source.project);
    if (source.caller) source.caller = decodeUtf8HeaderValue(source.caller);
    if (source.contextId) source.contextId = decodeUtf8HeaderValue(source.contextId);
  }
  for (const skill of Object.values(state.skills)) skill.status ??= "active";
  for (const versions of Object.values(state.skillHistory)) {
    for (const skill of versions) skill.status ??= "active";
  }
  for (const record of Object.values(state.employees)) {
    for (const employee of record.versions) {
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
    }
    record.current = record.versions.find((employee) => employee.version === record.current.version) ?? record.current;
    record.current.knowledgeProfileIds ??= [];
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
      for (const role of project.roles) role.knowledgeProfileIds ??= [];
    }
    for (const role of record.current.roles) role.knowledgeProfileIds ??= [];
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
