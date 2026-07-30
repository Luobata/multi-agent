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
import { RunStore } from "./artifacts.js";
import { createDefaultProviderRegistry, type ProviderRegistry } from "./providers.js";
import { parseProviderOutput, readJsonSchema, statusFromVerdict, validateStructuredOutput } from "./output.js";

export interface RunWorkflowOptions {
  input?: JsonObject;
  runId?: string;
  artifactRoot?: string;
  providers?: ProviderRegistry;
  architectures?: ArchitectureRegistry;
}

export interface RunWorkflowResult {
  run: WorkflowRunRecord;
  runDir: string;
}

function now(): string {
  return new Date().toISOString();
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
  attemptDir: string
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
    outputSchemaJson: JSON.stringify(outputSchema)
  };
  const baseContext: Record<string, unknown> = {
    input,
    needs,
    skills,
    node: {
      id: node.id,
      with: node.with
    },
    role: roleContext,
    run: {
      id: run.id,
      workflow: run.workflow,
      nodeId: node.id,
      artifactDir: attemptDir,
      projectRoot: loaded.projectRoot
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
  registry: ProviderRegistry
): Promise<NodeRunResult> {
  const role = loaded.manifest.roles[node.role];
  if (!role) throw new Error(`role not found: ${node.role}`);
  const provider = loaded.manifest.providers[role.provider];
  if (!provider) throw new Error(`provider not found: ${role.provider}`);
  const adapter = registry.get(provider.adapter);
  if (!adapter) throw new Error(`provider adapter not registered: ${provider.adapter}`);
  const failedDependency = node.needs.find((nodeId) => ["failed", "skipped"].includes(run.nodes[nodeId]?.status ?? "pending"));
  if (failedDependency) {
    return {
      nodeId: node.id,
      roleId: node.role,
      status: "skipped",
      attempts: 0,
      completedAt: now(),
      error: `dependency ${failedDependency} did not complete`
    };
  }

  const result: NodeRunResult = {
    nodeId: node.id,
    roleId: node.role,
    status: "running",
    attempts: 0,
    startedAt: now()
  };
  const maxAttempts = role.maxAttempts ?? 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result.attempts = attempt;
    const attemptDir = await store.createAttempt(node.id, attempt);
    result.artifactDir = path.relative(store.runDir, attemptDir).split(path.sep).join("/");
    try {
      const bundle = buildPromptBundle(loaded, run, node, input, attemptDir);
      await store.writeText(attemptDir, "system-prompt.md", bundle.systemPrompt);
      await store.writeText(attemptDir, "request-prompt.md", bundle.requestPrompt);
      await store.writeText(attemptDir, "prompt.md", bundle.prompt);
      await store.appendEvent({ at: now(), type: "node.attempt.started", nodeId: node.id, detail: { attempt } });
      const response = await adapter.invoke({
        providerId: role.provider,
        definition: provider,
        cwd: loaded.projectRoot,
        prompt: bundle.prompt,
        templateContext: bundle.context
      });
      await store.writeText(attemptDir, "stdout.txt", response.stdout);
      await store.writeText(attemptDir, "stderr.txt", response.stderr);
      const output = parseProviderOutput(provider.outputProtocol ?? "json", response.stdout);
      validateStructuredOutput(readJsonSchema(path.resolve(loaded.projectRoot, role.outputSchema)), output, node.id);
      const status = statusFromVerdict(output, role.verdict);
      await store.writeAttemptJson(attemptDir, "result.json", output);
      await store.writeAttemptJson(attemptDir, "metadata.json", { attempt, durationMs: response.durationMs, status });
      await store.appendEvent({ at: now(), type: `node.${status}`, nodeId: node.id, detail: { attempt } });
      return { ...result, status, output, completedAt: now() };
    } catch (error) {
      lastError = error;
      if (error instanceof ProviderExecutionError) {
        await store.writeText(attemptDir, "stdout.txt", error.stdout);
        await store.writeText(attemptDir, "stderr.txt", error.stderr);
      }
      await store.writeAttemptJson(attemptDir, "error.json", {
        attempt,
        error: error instanceof Error ? error.message : String(error)
      });
      await store.appendEvent({
        at: now(),
        type: "node.attempt.failed",
        nodeId: node.id,
        detail: { attempt, error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  return {
    ...result,
    status: "failed",
    completedAt: now(),
    error: lastError instanceof Error ? lastError.message : String(lastError)
  };
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
      plan.nodes.map((node) => [node.id, { nodeId: node.id, roleId: node.role, status: "pending", attempts: 0 }])
    )
  };
  const registry = options.providers ?? createDefaultProviderRegistry();
  await store.writeInput(input);
  await store.writePlan(plan);
  await store.writeRun(run);
  await store.appendEvent({ at: now(), type: "run.started", detail: { workflow: workflowId, architecture: plan.architecture } });

  await architecture.execute({
    loaded,
    input,
    plan,
    run,
    executeNode: (node) => executeNode(loaded, run, node, input, store, registry),
    persist: () => store.writeRun(run),
    emit: (type, nodeId, detail) => store.appendEvent({ at: now(), type, nodeId, detail })
  });

  const statuses = Object.values(run.nodes).map((node) => node.status);
  run.status = statuses.some((status) => status === "failed" || status === "skipped")
    ? "failed"
    : statuses.some((status) => status === "blocked")
      ? "blocked"
      : "passed";
  run.completedAt = now();
  await store.writeRun(run);
  await store.appendEvent({ at: now(), type: `run.${run.status}` });
  return { run, runDir: store.runDir };
}
