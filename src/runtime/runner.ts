import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { createDefaultArchitectureRegistry } from "../architectures/registry.js";
import type { ArchitectureRegistry } from "../architectures/types.js";
import { ProviderExecutionError } from "../core/errors.js";
import { compilePlan } from "../core/plan.js";
import { renderRoleSystemPrompt, resolveRoleProfile } from "../core/roles.js";
import { renderTemplate } from "../core/template.js";
import type {
  ExecutionPlanNode,
  JsonObject,
  JsonValue,
  LoadedManifest,
  NodeRunResult,
  WorkflowRunRecord
} from "../core/types.js";
import { RunStore, type RunEvent } from "./artifacts.js";
import { createDefaultProviderRegistry, type ProviderRegistry } from "./providers.js";
import { parseProviderOutput, readJsonSchema, statusFromVerdict, validateStructuredOutput } from "./output.js";

export interface RunWorkflowOptions {
  input?: JsonObject;
  runId?: string;
  artifactRoot?: string;
  /** Working directory exposed to the Provider. Manifest assets still resolve from loaded.projectRoot. */
  providerCwd?: string;
  providers?: ProviderRegistry;
  architectures?: ArchitectureRegistry;
  initialArtifacts?: Record<string, JsonValue>;
  prepareNode?: (node: ExecutionPlanNode) => Promise<{
    node: ExecutionPlanNode;
    artifacts?: Record<string, JsonValue>;
  }>;
  onEvent?: (event: ObservedRunEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface ObservedRunEvent extends RunEvent {
  runId: string;
  workflow: string;
}

export interface RunWorkflowResult {
  run: WorkflowRunRecord;
  runDir: string;
}

function now(): string {
  return new Date().toISOString();
}

function nodeRoleId(node: ExecutionPlanNode): string {
  const roleId = node.metadata?.roleId;
  return typeof roleId === "string" && roleId ? roleId : node.role;
}

function providerCallSignal(
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined
): { signal?: AbortSignal; clear: () => void } {
  if (deadlineAt === undefined) return { signal, clear: () => undefined };
  const deadline = new AbortController();
  const remaining = deadlineAt - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (remaining <= 0) deadline.abort();
  else {
    timer = setTimeout(() => deadline.abort(), remaining);
    timer.unref();
  }
  return {
    signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
    clear: () => { if (timer) clearTimeout(timer); }
  };
}

function validateInput(loaded: LoadedManifest, workflowId: string, input: JsonObject): void {
  const inputSchema = loaded.manifest.workflows[workflowId]?.inputSchema;
  if (!inputSchema) return;
  const schema = readJsonSchema(path.resolve(loaded.projectRoot, inputSchema));
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (validate(input)) return;
  const issues = (validate.errors ?? []).map((error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
  throw new Error(`workflow input validation failed: ${issues.join("; ")}`);
}

interface PromptBundle {
  context: Record<string, unknown>;
  systemPrompt: string;
  requestPrompt: string;
  prompt: string;
}

function buildPromptBundle(
  loaded: LoadedManifest,
  run: WorkflowRunRecord,
  node: ExecutionPlanNode,
  input: JsonObject,
  attemptDir: string,
  providerCwd: string
): PromptBundle {
  const profile = resolveRoleProfile(loaded, node.role);
  const role = profile.definition;
  const outputSchema = readJsonSchema(path.resolve(loaded.projectRoot, role.outputSchema));
  const needs = Object.fromEntries(
    node.needs.map((nodeId) => {
      const result = run.nodes[nodeId];
      return [nodeId, { status: result?.status, output: result?.output ?? null, error: result?.error ?? null }];
    })
  );
  const skills = Object.fromEntries(
    profile.skills.map((skill) => [
      skill.id,
      {
        displayName: skill.displayName,
        description: skill.description,
        config: skill.config,
        tools: skill.tools
      }
    ])
  );
  const roleContext = {
    id: node.role,
    description: profile.description,
    identity: role.identity,
    provider: role.provider,
    permissions: { write: profile.writePolicy, tools: profile.effectiveTools },
    toolsCsv: profile.effectiveTools.join(","),
    skills: profile.skills.map((skill) => ({ id: skill.id, displayName: skill.displayName, config: skill.config })),
    outputSchema,
    outputSchemaJson: JSON.stringify(outputSchema),
    outputSchemaPath: path.resolve(loaded.projectRoot, role.outputSchema)
  };
  const baseContext: Record<string, unknown> = {
    input,
    needs,
    skills,
    node: {
      id: node.id,
      with: node.with,
      metadata: node.metadata ?? {}
    },
    role: roleContext,
    run: {
      id: run.id,
      workflow: run.workflow,
      nodeId: node.id,
      artifactDir: attemptDir,
      projectRoot: providerCwd,
      materializedRoot: loaded.projectRoot
    }
  };
  const systemPrompt = renderRoleSystemPrompt(profile, baseContext);
  const nativeDefinitionJson = JSON.stringify({
    [node.role]: { description: profile.description, prompt: systemPrompt }
  });
  const context = {
    ...baseContext,
    role: { ...roleContext, systemPrompt, nativeDefinitionJson }
  };
  const requestTemplate = fs.readFileSync(path.resolve(loaded.projectRoot, role.requestTemplate), "utf8").trim();
  const requestPrompt = renderTemplate(requestTemplate, context);
  return {
    context: { ...context, requestPrompt },
    systemPrompt,
    requestPrompt,
    prompt: `${systemPrompt}\n\n${requestPrompt}\n`
  };
}

async function executeNode(
  loaded: LoadedManifest,
  run: WorkflowRunRecord,
  node: ExecutionPlanNode,
  input: JsonObject,
  store: RunStore,
  registry: ProviderRegistry,
  emit: (type: string, nodeId?: string, detail?: JsonValue) => Promise<void>,
  providerCwd: string,
  signal?: AbortSignal,
  options: { dependencyFailure?: "skip" | "observe"; deadlineAt?: number } = {}
): Promise<NodeRunResult> {
  const role = loaded.manifest.roles[node.role];
  if (!role) throw new Error(`role not found: ${node.role}`);
  const provider = loaded.manifest.providers[role.provider];
  if (!provider) throw new Error(`provider not found: ${role.provider}`);
  const adapter = registry.get(provider.adapter);
  if (!adapter) throw new Error(`provider adapter not registered: ${provider.adapter}`);
  const failedDependency = node.needs.find((nodeId) => ["failed", "skipped"].includes(run.nodes[nodeId]?.status ?? "pending"));
  if (failedDependency && options.dependencyFailure !== "observe") {
    const skipped: NodeRunResult = {
      nodeId: node.id,
      roleId: nodeRoleId(node),
      metadata: node.metadata,
      status: "skipped",
      attempts: 0,
      completedAt: now(),
      error: `dependency ${failedDependency} did not complete`
    };
    run.nodes[node.id] = skipped;
    await store.writeRun(run);
    await emit("node.skipped", node.id, { reason: skipped.error ?? "dependency did not complete" });
    return skipped;
  }

  const result: NodeRunResult = {
    nodeId: node.id,
    roleId: nodeRoleId(node),
    metadata: node.metadata,
    status: "running",
    attempts: 0,
    startedAt: now()
  };
  run.nodes[node.id] = result;
  await store.writeRun(run);
  await emit("node.started", node.id, { provider: node.provider, needs: node.needs });
  const maxAttempts = role.maxAttempts ?? 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result.attempts = attempt;
    const attemptDir = await store.createAttempt(node.id, attempt);
    result.artifactDir = path.relative(store.runDir, attemptDir).split(path.sep).join("/");
    try {
      if (signal?.aborted || (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)) {
        throw new ProviderExecutionError(
          options.deadlineAt !== undefined && Date.now() >= options.deadlineAt
            ? "workflow execution deadline was reached"
            : "workflow execution was aborted",
          "",
          "",
          { kind: "aborted", retryable: false }
        );
      }
      const bundle = buildPromptBundle(loaded, run, node, input, attemptDir, providerCwd);
      await store.writeText(attemptDir, "system-prompt.md", bundle.systemPrompt);
      await store.writeText(attemptDir, "request-prompt.md", bundle.requestPrompt);
      await store.writeText(attemptDir, "prompt.md", bundle.prompt);
      await emit("node.attempt.started", node.id, { attempt });
      const callSignal = providerCallSignal(signal, options.deadlineAt);
      let response: Awaited<ReturnType<typeof adapter.invoke>>;
      try {
        if (callSignal.signal?.aborted) {
          throw new ProviderExecutionError(
            options.deadlineAt !== undefined && Date.now() >= options.deadlineAt
              ? "workflow execution deadline was reached"
              : "workflow execution was aborted",
            "",
            "",
            { kind: "aborted", retryable: false }
          );
        }
        response = await adapter.invoke({
          providerId: role.provider,
          definition: provider,
          cwd: providerCwd,
          prompt: bundle.prompt,
          templateContext: bundle.context,
          signal: callSignal.signal
        });
        if (callSignal.signal?.aborted) {
          throw new ProviderExecutionError(
            options.deadlineAt !== undefined && Date.now() >= options.deadlineAt
              ? "workflow execution deadline was reached"
              : "workflow execution was aborted",
            response.stdout,
            response.stderr,
            { kind: "aborted", retryable: false, durationMs: response.durationMs }
          );
        }
      } finally {
        callSignal.clear();
      }
      await store.writeText(attemptDir, "stdout.txt", response.stdout);
      await store.writeText(attemptDir, "stderr.txt", response.stderr);
      const output = parseProviderOutput(provider.outputProtocol ?? "json", response.stdout);
      validateStructuredOutput(readJsonSchema(path.resolve(loaded.projectRoot, role.outputSchema)), output, node.id);
      const status = statusFromVerdict(output, role.verdict);
      await store.writeAttemptJson(attemptDir, "result.json", output);
      await store.writeAttemptJson(attemptDir, "metadata.json", { attempt, durationMs: response.durationMs, status });
      const completed: NodeRunResult = { ...result, status, output, completedAt: now() };
      run.nodes[node.id] = completed;
      await store.writeRun(run);
      await emit(`node.${status}`, node.id, { attempt });
      return completed;
    } catch (error) {
      lastError = error;
      if (error instanceof ProviderExecutionError) {
        await store.writeText(attemptDir, "stdout.txt", error.stdout);
        await store.writeText(attemptDir, "stderr.txt", error.stderr);
      }
      const retryable = error instanceof ProviderExecutionError && error.retryable;
      const willRetry = attempt < maxAttempts && retryable;
      await store.writeAttemptJson(attemptDir, "error.json", {
        attempt,
        error: error instanceof Error ? error.message : String(error),
        kind: error instanceof ProviderExecutionError ? error.kind : "validation",
        retryable,
        willRetry,
        durationMs: error instanceof ProviderExecutionError ? error.durationMs : undefined
      });
      await emit("node.attempt.failed", node.id, {
        attempt,
        error: error instanceof Error ? error.message : String(error),
        kind: error instanceof ProviderExecutionError ? error.kind : "validation",
        retryable,
        willRetry
      });
      if (!willRetry) break;
    }
  }

  const failed: NodeRunResult = {
    ...result,
    status: "failed",
    completedAt: now(),
    error: lastError instanceof Error ? lastError.message : String(lastError)
  };
  run.nodes[node.id] = failed;
  await store.writeRun(run);
  await emit("node.failed", node.id, { error: failed.error ?? "Provider invocation failed" });
  return failed;
}

export async function runWorkflow(
  loaded: LoadedManifest,
  workflowId: string,
  options: RunWorkflowOptions = {}
): Promise<RunWorkflowResult> {
  const input = options.input ?? {};
  validateInput(loaded, workflowId, input);
  const architectures = options.architectures ?? createDefaultArchitectureRegistry();
  const plan = compilePlan(loaded, workflowId, architectures);
  const architecture = architectures.get(plan.architecture);
  if (!architecture) throw new Error(`architecture adapter not registered: ${plan.architecture}`);
  const providerCwd = path.resolve(options.providerCwd ?? loaded.projectRoot);
  const runId = options.runId ?? `run-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = options.artifactRoot
    ? path.resolve(options.artifactRoot)
    : path.resolve(loaded.projectRoot, loaded.manifest.artifactRoot ?? ".multi-agent");
  const store = await RunStore.create(artifactRoot, runId);
  const run: WorkflowRunRecord = {
    id: runId,
    workflow: workflowId,
    architecture: plan.architecture,
    manifestPath: loaded.manifestPath,
    artifactDir: store.runDir,
    status: "running",
    createdAt: now(),
    nodes: Object.fromEntries(
      plan.nodes.map((node) => [node.id, {
        nodeId: node.id,
        roleId: nodeRoleId(node),
        metadata: node.metadata,
        status: "pending",
        attempts: 0
      }])
    )
  };
  const registry = options.providers ?? createDefaultProviderRegistry();
  const emit = async (type: string, nodeId?: string, detail?: JsonValue): Promise<void> => {
    const event: RunEvent = { at: now(), type, nodeId, detail };
    await store.appendEvent(event);
    await options.onEvent?.({ ...event, runId, workflow: workflowId });
  };
  await store.writeInput(input);
  await store.writePlan(plan);
  for (const [relativePath, value] of Object.entries(options.initialArtifacts ?? {})) {
    await store.writeArtifact(relativePath, value);
  }
  await store.writeRun(run);
  await emit("run.started", undefined, { workflow: workflowId, architecture: plan.architecture });

  const scheduled = new Set<string>();
  const scheduleNode = async (node: ExecutionPlanNode): Promise<void> => {
    const existing = plan.nodes.find((candidate) => candidate.id === node.id);
    if (existing && existing.role !== node.role) throw new Error(`execution node ${node.id} is already assigned to role ${existing.role}`);
    if (!existing) plan.nodes.push(node);
    if (!run.nodes[node.id]) {
      run.nodes[node.id] = {
        nodeId: node.id,
        roleId: nodeRoleId(node),
        metadata: node.metadata,
        status: "pending",
        attempts: 0
      };
    }
    await store.writePlan(plan);
    await store.writeRun(run);
    if (!scheduled.has(node.id)) {
      scheduled.add(node.id);
      await emit("node.scheduled", node.id, {
        role: node.role,
        needs: node.needs,
        metadata: node.metadata ?? {}
      });
    }
  };
  const executePreparedNode = async (
    node: ExecutionPlanNode,
    executionOptions?: { dependencyFailure?: "skip" | "observe"; deadlineAt?: number }
  ): Promise<NodeRunResult> => {
    let prepared: { node: ExecutionPlanNode; artifacts?: Record<string, JsonValue> };
    try {
      prepared = options.prepareNode ? await options.prepareNode(node) : { node };
      for (const [relativePath, value] of Object.entries(prepared.artifacts ?? {})) {
        await store.writeArtifact(relativePath, value);
      }
    } catch (error) {
      const failed: NodeRunResult = {
        nodeId: node.id,
        roleId: nodeRoleId(node),
        metadata: node.metadata,
        status: "failed",
        attempts: 0,
        completedAt: now(),
        error: error instanceof Error ? error.message : String(error)
      };
      run.nodes[node.id] = failed;
      await store.writeRun(run);
      await emit("node.failed", node.id, { error: failed.error ?? "node preparation failed", phase: "prepare" });
      return failed;
    }
    return executeNode(
      loaded,
      run,
      prepared.node,
      input,
      store,
      registry,
      emit,
      providerCwd,
      options.signal,
      executionOptions
    );
  };
  let executionResult: Awaited<ReturnType<typeof architecture.execute>>;
  try {
    executionResult = await architecture.execute({
      loaded,
      input,
      plan,
      run,
      scheduleNode,
      executeNode: executePreparedNode,
      persist: () => store.writeRun(run),
      emit
    });
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    run.completedAt = now();
    await store.writeRun(run);
    await emit("run.failed", undefined, { error: run.error });
    throw error;
  }

  const statuses = Object.values(run.nodes).map((node) => node.status);
  run.status = executionResult?.status ?? (statuses.some((status) => status === "failed" || status === "skipped")
    ? "failed"
    : statuses.some((status) => status === "blocked")
      ? "blocked"
      : "passed");
  if (executionResult?.output !== undefined) run.output = executionResult.output;
  run.completedAt = now();
  await store.writeRun(run);
  await emit(`run.${run.status}`);
  return { run, runDir: store.runDir };
}
