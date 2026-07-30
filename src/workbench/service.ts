import { randomUUID } from "node:crypto";
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
import { compilePlan } from "../core/plan.js";
import type { JsonObject, JsonValue, RoleSkillBinding } from "../core/types.js";
import { createDefaultProviderRegistry, type ProviderRegistry } from "../runtime/providers.js";
import { runWorkflow, type RunWorkflowResult } from "../runtime/runner.js";
import { materializeWorkflow, resolveSkillBinding } from "./materialize.js";
import { WorkbenchStore } from "./store.js";
import {
  DEFAULT_EMPLOYEE_OUTPUT_SCHEMA,
  type EmployeeContextView,
  type EmployeeCreateInput,
  type EmployeeDefinition,
  type EmployeeInvocationInput,
  type EmployeeInvocationResult,
  type EmployeeRecord,
  type EmployeeSession,
  type PublicationDefinition,
  type SkillCreateInput,
  type SkillUpdateInput,
  type WorkbenchSkillDefinition,
  type WorkbenchState,
  type WorkbenchWorkflowDefinition,
  type WorkflowCreateInput,
  type WorkflowUpdateInput,
  type EmployeeUpdateInput
} from "./types.js";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

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

function invocationMessage(output: JsonValue | undefined): string {
  if (typeof output === "object" && output !== null && !Array.isArray(output)) {
    const message = output.message;
    if (typeof message === "string") return message;
  }
  return output === undefined ? "No structured output was produced." : JSON.stringify(output, null, 2);
}

export interface WorkbenchServiceOptions {
  dataRoot?: string;
  providers?: ProviderRegistry;
  architectures?: ArchitectureRegistry;
}

export class WorkbenchService {
  readonly providers: ProviderRegistry;
  readonly architectures: ArchitectureRegistry;

  private constructor(
    readonly store: WorkbenchStore,
    options: WorkbenchServiceOptions
  ) {
    this.providers = options.providers ?? createDefaultProviderRegistry();
    this.architectures = options.architectures ?? createDefaultArchitectureRegistry();
  }

  static defaultDataRoot(): string {
    return process.env.MULTI_AGENT_DATA_DIR
      ? path.resolve(process.env.MULTI_AGENT_DATA_DIR)
      : path.join(os.homedir(), ".multi-agent", "workbench");
  }

  static async open(options: WorkbenchServiceOptions = {}): Promise<WorkbenchService> {
    const store = await WorkbenchStore.open(options.dataRoot ?? WorkbenchService.defaultDataRoot());
    return new WorkbenchService(store, options);
  }

  snapshot(): WorkbenchState {
    return this.store.snapshot();
  }

  listProviders(): Array<{ id: string; definition: WorkbenchState["providers"][string] }> {
    return Object.entries(this.snapshot().providers).map(([id, definition]) => ({ id, definition }));
  }

  async putProvider(id: string, definition: WorkbenchState["providers"][string]): Promise<void> {
    requireId(id, "provider id");
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
        displayName: requireText(input.displayName ?? id, "skill displayName"),
        description: requireText(input.description, "skill description"),
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
      const updated: WorkbenchSkillDefinition = {
        ...current,
        displayName: input.displayName === undefined ? current.displayName : requireText(input.displayName, "skill displayName"),
        description: input.description === undefined ? current.description : requireText(input.description, "skill description"),
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

  listArchitectureTemplates(): ArchitectureTemplateDefinition[] {
    return listArchitectureTemplates();
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
      const providerId = input.providerId ?? "mock";
      if (!state.providers[providerId]) throw new Error(`unknown provider ${providerId}`);
      const skills = input.skills ?? [];
      const skillVersions = pinSkillVersions(state, skills, input.skillVersions);
      validateSkillBindings(state, skills, skillVersions);
      const outputSchema = input.outputSchema ?? DEFAULT_EMPLOYEE_OUTPUT_SCHEMA;
      validateSchema(outputSchema, `employee ${id} outputSchema`);
      const verdict = input.verdict ?? undefined;
      validateVerdict(verdict, `employee ${id}`);
      const timestamp = now();
      const employee: EmployeeDefinition = {
        id,
        version: 1,
        status: "active",
        identity: {
          displayName: requireText(input.identity.displayName, "employee displayName"),
          background: requireText(input.identity.background, "employee background"),
          responsibilities: input.identity.responsibilities.map((value) => requireText(value, "employee responsibility")),
          goals: input.identity.goals?.map((value) => requireText(value, "employee goal")),
          constraints: input.identity.constraints?.map((value) => requireText(value, "employee constraint")),
          metadata: input.identity.metadata
        },
        description: requireText(input.description ?? input.identity.background, "employee description"),
        systemPrompt: requireText(
          input.systemPrompt ?? "Act within the assigned identity, preserve evidence, and state uncertainty explicitly.",
          "employee systemPrompt"
        ),
        requestPrompt: requireText(
          input.requestPrompt ?? "Complete the current request using the available context and return the required structured output.",
          "employee requestPrompt"
        ),
        skills,
        skillVersions,
        providerId,
        outputSchema,
        maxAttempts: Math.max(1, Math.min(10, input.maxAttempts ?? 1)),
        permissions: input.permissions ?? { write: "none", tools: [] },
        verdict,
        contextPolicy: { historyLimit: Math.max(0, Math.min(100, input.contextPolicy?.historyLimit ?? 20)) },
        presentation: input.presentation ?? {},
        createdAt: timestamp,
        updatedAt: timestamp
      };
      if (employee.identity.responsibilities.length === 0) throw new Error("employee responsibilities must not be empty");
      state.employees[id] = { current: employee, versions: [employee] };
      return employee;
    });
  }

  async updateEmployee(id: string, input: EmployeeUpdateInput): Promise<EmployeeDefinition> {
    return this.store.mutate((state) => {
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
      const outputSchema = input.outputSchema ?? current.outputSchema;
      validateSchema(outputSchema, `employee ${id} outputSchema`);
      const verdict = input.verdict === undefined ? current.verdict : input.verdict ?? undefined;
      validateVerdict(verdict, `employee ${id}`);
      const identity = input.identity ?? current.identity;
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
        skills,
        skillVersions,
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
        updatedAt: now()
      };
      if (updated.identity.responsibilities.length === 0) throw new Error("employee responsibilities must not be empty");
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
      skills: source.skills,
      skillVersions: source.skillVersions,
      providerId: source.providerId,
      outputSchema: source.outputSchema,
      maxAttempts: source.maxAttempts,
      permissions: source.permissions,
      verdict: source.verdict,
      contextPolicy: source.contextPolicy,
      presentation: source.presentation
    });
  }

  async archiveEmployee(id: string): Promise<EmployeeDefinition> {
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

  private directWorkflow(employee: EmployeeDefinition): WorkbenchWorkflowDefinition {
    const timestamp = now();
    return {
      id: `direct-${employee.id}`,
      version: employee.version,
      status: "active",
      architecture: "graph",
      description: `Direct invocation of ${employee.identity.displayName}`,
      nodes: [{ id: "respond", employeeId: employee.id, employeeVersion: employee.version, needs: [], with: {} }],
      maxConcurrency: 1,
      failFast: true,
      createdAt: timestamp,
      updatedAt: timestamp
    };
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

  async invokeEmployee(employeeId: string, input: EmployeeInvocationInput): Promise<EmployeeInvocationResult> {
    requireText(input.message, "message");
    const current = this.getEmployee(employeeId);
    if (current.status !== "active") throw new Error(`employee ${employeeId} is archived`);
    let session = input.sessionId ? this.getSession(input.sessionId) : undefined;
    if (session && session.employeeId !== employeeId) throw new Error(`session ${session.id} belongs to another employee`);
    const employee = session ? this.getEmployee(employeeId, session.employeeVersion) : current;
    if (!session) {
      const timestamp = now();
      session = {
        id: randomUUID(),
        employeeId,
        employeeVersion: employee.version,
        title: input.message.trim().slice(0, 72),
        status: "active",
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const newSession = session;
      await this.store.mutate((state) => {
        state.sessions[newSession.id] = newSession;
      });
    }
    const history = session.messages
      .slice(-employee.contextPolicy.historyLimit)
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n\n");
    const workflow = this.directWorkflow(employee);
    const materialized = await this.materialize(workflow, new Map([[employee.id, employee]]));
    const result = await runWorkflow(materialized.loaded, materialized.workflowId, {
      input: { message: input.message.trim(), sessionHistory: history },
      providers: this.providers,
      architectures: this.architectures,
      artifactRoot: path.join(this.store.dataRoot, "artifacts")
    });
    const node = result.run.nodes.respond;
    const responseMessage = invocationMessage(node?.output);
    const timestamp = now();
    const sessionId = session.id;
    const updatedSession = await this.store.mutate((state) => {
      const target = state.sessions[sessionId];
      if (!target) throw new Error(`session not found: ${sessionId}`);
      target.messages.push(
        { id: randomUUID(), role: "user", content: input.message.trim(), at: timestamp, runId: result.run.id, runDir: result.runDir },
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
    return {
      session: updatedSession,
      runId: result.run.id,
      runDir: result.runDir,
      status: result.run.status,
      output: node?.output,
      message: responseMessage
    };
  }

  async getEmployeeContext(employeeId: string, sessionId?: string): Promise<EmployeeContextView> {
    const session = sessionId ? this.getSession(sessionId) : this.listSessions(employeeId)[0];
    if (session && session.employeeId !== employeeId) throw new Error(`session ${session.id} belongs to another employee`);
    const employee = this.getEmployee(employeeId, session?.employeeVersion);
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
      } catch {
        // A failed attempt can legitimately have incomplete prompt artifacts.
      }
    }
    return view;
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

  private normalizeWorkflow(
    input: WorkflowCreateInput,
    current?: WorkbenchWorkflowDefinition
  ): WorkbenchWorkflowDefinition {
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
    const positions = presentationInput?.positions === undefined
      ? undefined
      : Object.fromEntries(Object.entries(presentationInput.positions).filter(([nodeId, position]) => {
          if (!nodeIds.has(nodeId)) return false;
          if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
            throw new Error(`workflow node ${nodeId} position must contain finite x/y coordinates`);
          }
          if (Math.abs(position.x) > 100_000 || Math.abs(position.y) > 100_000) {
            throw new Error(`workflow node ${nodeId} position is outside the supported canvas bounds`);
          }
          return true;
        }));
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

  async createWorkflow(input: WorkflowCreateInput): Promise<WorkbenchWorkflowDefinition> {
    const workflow = this.normalizeWorkflow(input);
    await this.validateWorkflow(workflow);
    return this.store.mutate((state) => {
      if (state.workflows[workflow.id]) throw new Error(`workflow already exists: ${workflow.id}`);
      state.workflows[workflow.id] = { current: workflow, versions: [workflow] };
      return workflow;
    });
  }

  async updateWorkflow(id: string, input: WorkflowUpdateInput): Promise<WorkbenchWorkflowDefinition> {
    const current = this.getWorkflow(id);
    const workflow = this.normalizeWorkflow({
      id,
      description: input.description ?? current.description,
      nodes: input.nodes ?? current.nodes,
      maxConcurrency: input.maxConcurrency ?? current.maxConcurrency,
      failFast: input.failFast ?? current.failFast,
      inputSchema: input.inputSchema ?? current.inputSchema,
      patternId: input.patternId ?? current.patternId,
      presentation: input.presentation ?? current.presentation
    }, current);
    await this.validateWorkflow(workflow);
    return this.store.mutate((state) => {
      const record = state.workflows[id];
      if (!record) throw new Error(`workflow not found: ${id}`);
      record.current = workflow;
      record.versions.push(workflow);
      return workflow;
    });
  }

  private resolveWorkflowEmployees(workflow: WorkbenchWorkflowDefinition): Map<string, EmployeeDefinition> {
    const employees = new Map<string, EmployeeDefinition>();
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

  private async validateWorkflow(workflow: WorkbenchWorkflowDefinition): Promise<void> {
    const materialized = await this.materialize(workflow, this.resolveWorkflowEmployees(workflow));
    compilePlan(materialized.loaded, materialized.workflowId, this.architectures);
  }

  async planWorkflow(id: string): Promise<ReturnType<typeof compilePlan>> {
    const workflow = this.getWorkflow(id);
    const materialized = await this.materialize(workflow, this.resolveWorkflowEmployees(workflow));
    return compilePlan(materialized.loaded, materialized.workflowId, this.architectures);
  }

  async runWorkbenchWorkflow(id: string, input: JsonObject = {}): Promise<RunWorkflowResult> {
    const workflow = this.getWorkflow(id);
    if (workflow.status !== "active") throw new Error(`workflow ${id} is archived`);
    const employees = this.resolveWorkflowEmployees(workflow);
    for (const employee of employees.values()) {
      if (this.getEmployee(employee.id).status !== "active") throw new Error(`employee ${employee.id} is archived`);
    }
    const materialized = await this.materialize(workflow, employees);
    return runWorkflow(materialized.loaded, materialized.workflowId, {
      input,
      providers: this.providers,
      architectures: this.architectures,
      artifactRoot: path.join(this.store.dataRoot, "artifacts")
    });
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

  async invokePublication(id: string, input: JsonObject): Promise<RunWorkflowResult | EmployeeInvocationResult> {
    const publication = this.getPublication(id);
    if (publication.status !== "active") throw new Error(`publication ${id} is archived`);
    if (publication.target.kind === "employee") {
      const message = typeof input.message === "string" ? input.message : JSON.stringify(input);
      return this.invokeEmployee(publication.target.id, { message });
    }
    return this.runWorkbenchWorkflow(publication.target.id, input);
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
    return records
      .filter((record): record is Record<string, unknown> => Boolean(record))
      .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")))
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  async getRun(id: string): Promise<unknown> {
    requireId(id, "run id");
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.store.dataRoot, "artifacts", "runs", id, "run.json"), "utf8")
      ) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`run not found: ${id}`);
      throw error;
    }
  }
}
