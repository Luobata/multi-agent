import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { createDefaultArchitectureRegistry } from "../architectures/registry.js";
import type { ArchitectureRegistry, ExecuteNodeOptions } from "../architectures/types.js";
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
  NodeRunFailure,
  RuntimeHumanDecisionOutcome,
  RuntimeHumanDecisionRequest,
  WorkflowRunIsolation,
  WorkflowRunRecord
} from "../core/types.js";
import { RunStore, type RunEvent } from "./artifacts.js";
import { candidateWorkspaceSnapshot } from "./candidateRevision.js";
import { createDefaultProviderRegistry, providerContract, type ProviderProgress, type ProviderRegistry } from "./providers.js";
import { parseProviderOutput, preflightStrictOutputSchema, readJsonSchema, statusFromVerdict, validateStructuredOutput } from "./output.js";
import {
  ExecutionBudget,
  ExecutionBudgetExceededError,
  CapabilityBrokerUnavailableError,
  SideEffectAuthorizationError,
  type CapabilityBroker,
  type Checkpoint,
  type ExecutionBudgetSnapshot
} from "./governance.js";

const INLINE_DEPENDENCY_BYTES = 64 * 1024;

interface RuntimeCheckpointValue {
  runStatus: WorkflowRunRecord["status"];
  cancellationEpoch: number;
  budget?: ExecutionBudgetSnapshot;
}

export interface RunWorkflowOptions {
  input?: JsonObject;
  runId?: string;
  artifactRoot?: string;
  /** Working directory exposed to the Provider. Manifest assets still resolve from loaded.projectRoot. */
  providerCwd?: string;
  providers?: ProviderRegistry;
  architectures?: ArchitectureRegistry;
  initialArtifacts?: Record<string, JsonValue>;
  /** Execution isolation evidence recorded verbatim on the run record. */
  isolation?: WorkflowRunIsolation;
  prepareNode?: (node: ExecutionPlanNode) => Promise<{
    node: ExecutionPlanNode;
    artifacts?: Record<string, JsonValue>;
  }>;
  /**
   * Acquires process-wide resources needed by a prepared node. The returned
   * release callback is always invoked, including provider and validation
   * failures. This keeps shared adapters (for example one visible browser
   * session) exclusive without turning an Employee identity into a capacity
   * limit.
   */
  acquireNodePermit?: (node: ExecutionPlanNode) => Promise<{
    release: () => void | Promise<void>;
    resources?: string[];
  } | undefined>;
  onEvent?: (event: ObservedRunEvent) => void | Promise<void>;
  /** Opens a durable human-decision request and returns a live waiter for the same Run. */
  openHumanDecision?: (request: RuntimeHumanDecisionRequest) => Promise<{
    requestId: string;
    decision: Promise<RuntimeHumanDecisionOutcome>;
  }>;
  signal?: AbortSignal;
  /** Authorizes every actual Provider side effect. Omitted preserves legacy manifests and emits a warning event. */
  capabilityBroker?: CapabilityBroker;
  /** Shared per-Run budget ledger. Reservations prevent concurrent nodes from oversubscribing a quota. */
  budget?: ExecutionBudget;
  /** Reads the durable Invocation cancellation epoch used to fence late writes. */
  getCancellationEpoch?: () => number | Promise<number>;
  /**
   * Continue a durable Run after the local daemon restarts. Successful or
   * deterministically terminal nodes are replayed from Run Store evidence;
   * only pending/running/retryable-failed work is invoked again.
   */
  resume?: boolean;
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
  providerCwd: string,
  projectedNeeds?: Record<string, unknown>
): PromptBundle {
  const profile = resolveRoleProfile(loaded, node.role);
  const role = profile.definition;
  const outputSchema = readJsonSchema(path.resolve(loaded.projectRoot, role.outputSchema));
  const needs = projectedNeeds ?? Object.fromEntries(
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

async function projectDependencies(
  run: WorkflowRunRecord,
  node: ExecutionPlanNode,
  store: RunStore,
  attemptDir: string
): Promise<Record<string, unknown>> {
  const projection: Record<string, unknown> = {};
  const evidence: Record<string, unknown> = {};
  for (const nodeId of node.needs) {
    const result = run.nodes[nodeId];
    const envelope = { status: result?.status, output: result?.output ?? null, error: result?.error ?? null };
    const serialized = JSON.stringify(envelope.output);
    if (Buffer.byteLength(serialized) <= INLINE_DEPENDENCY_BYTES) {
      projection[nodeId] = envelope;
      evidence[nodeId] = { mode: "inline", bytes: Buffer.byteLength(serialized) };
      continue;
    }
    const digest = createHash("sha256").update(serialized).digest("hex");
    const relativePath = `context/dependencies/${nodeId}-${digest.slice(0, 12)}.json`;
    try {
      const existing = await store.readArtifact<unknown>(relativePath);
      const actual = createHash("sha256").update(JSON.stringify(existing)).digest("hex");
      if (actual !== digest) throw new Error(`dependency artifact ${nodeId} digest mismatch`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await store.writeArtifact(relativePath, envelope.output);
    }
    const ref = { kind: "artifact-ref", path: relativePath, digest: `sha256:${digest}`, bytes: Buffer.byteLength(serialized) };
    projection[nodeId] = {
      status: envelope.status,
      output: ref,
      error: envelope.error,
      summary: `Dependency ${nodeId} completed with status ${String(envelope.status)}; ${ref.bytes} byte output is available as a verified artifact.`
    };
    evidence[nodeId] = { mode: "artifact", ...ref };
  }
  await store.writeAttemptJson(attemptDir, "context-projection.json", evidence);
  return projection;
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
  options: ExecuteNodeOptions = {},
  governance: Pick<RunWorkflowOptions, "capabilityBroker" | "budget" | "openHumanDecision" | "getCancellationEpoch"> & { cancellationEpoch?: number } = {}
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

  const previousAttempts = run.nodes[node.id]?.attempts ?? 0;
  const result: NodeRunResult = {
    nodeId: node.id,
    roleId: nodeRoleId(node),
    metadata: node.metadata,
    status: "running",
    attempts: previousAttempts,
    startedAt: now()
  };
  run.nodes[node.id] = result;
  await store.writeRun(run);
  await emit("node.started", node.id, { provider: node.provider, needs: node.needs });
  const maxAttempts = role.maxAttempts ?? 1;
  let lastError: unknown;
  let lastFailure: NodeRunFailure | undefined;

  for (let recoveryAttempt = 1; recoveryAttempt <= maxAttempts; recoveryAttempt += 1) {
    const attempt = previousAttempts + recoveryAttempt;
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
      const outputSchema = readJsonSchema(path.resolve(loaded.projectRoot, role.outputSchema));
      const contract = providerContract(adapter);
      const requiredCapabilities = Array.isArray(provider.requiredCapabilities)
        ? provider.requiredCapabilities.filter((value): value is string => typeof value === "string")
        : [];
      let strictSchemaIssue: string | undefined;
      try { preflightStrictOutputSchema(outputSchema, node.id); } catch (error) {
        strictSchemaIssue = error instanceof Error ? error.message : String(error);
      }
      const unsupported = requiredCapabilities.filter((capability) => !contract.capabilities.includes(capability));
      const adapterIssues = await adapter.preflight?.({
        providerId: role.provider,
        definition: provider,
        projectRoot: providerCwd,
        requiredCapabilities
      }) ?? [];
      await store.writeAttemptJson(attemptDir, "preflight.json", {
        providerId: role.provider,
        adapter: adapter.id,
        contract,
        requiredCapabilities,
        unsupportedCapabilities: unsupported,
        issues: adapterIssues,
        strictOutputSchema: strictSchemaIssue ? { valid: false, issue: strictSchemaIssue } : { valid: true }
      });
      const requiresStrictOutputSchema = requiredCapabilities.includes("strict-output-schema")
        || contract.invocationRequirements?.includes("strict-output-schema") === true;
      if (requiresStrictOutputSchema && strictSchemaIssue) throw new Error(strictSchemaIssue);
      if (unsupported.length > 0) {
        throw new Error(`provider ${role.provider} does not support required capabilities: ${unsupported.join(", ")}`);
      }
      if (adapterIssues.length > 0) throw new Error(`provider ${role.provider} preflight failed: ${adapterIssues.join("; ")}`);
      const projectedNeeds = await projectDependencies(run, node, store, attemptDir);
      const bundle = buildPromptBundle(loaded, run, node, input, attemptDir, providerCwd, projectedNeeds);
      await store.writeText(attemptDir, "system-prompt.md", bundle.systemPrompt);
      await store.writeText(attemptDir, "request-prompt.md", bundle.requestPrompt);
      await store.writeText(attemptDir, "prompt.md", bundle.prompt);
      await emit("node.attempt.started", node.id, { attempt });
      governance.budget?.assertWallClock();
      const attemptReservation = governance.budget?.reserve("attempts");
      let providerReservation: ReturnType<ExecutionBudget["reserve"]> | undefined;
      const intent = {
        kind: "provider-call" as const,
        capability: `provider:${role.provider}:invoke`,
        principal: nodeRoleId(node),
        runId: run.id,
        nodeId: node.id,
        providerId: role.provider
      };
      try {
        providerReservation = governance.budget?.reserve("providerCalls");
        if (governance.capabilityBroker) {
          let authorization;
          try {
            authorization = await governance.capabilityBroker.authorize(intent);
          } catch (error) {
            throw new CapabilityBrokerUnavailableError(intent, error);
          }
          if (authorization.compatibilityWarning) {
            await emit("node.authorization.compatibility-warning", node.id, { warning: authorization.compatibilityWarning });
          }
          if (authorization.decision === "approval-required" && governance.openHumanDecision) {
            const opened = await governance.openHumanDecision({
              nodeId: node.id,
              round: Number(node.metadata?.round ?? 1),
              riskCategory: "irreversible-other",
              summary: authorization.reason ?? `Approval required for ${intent.capability}`,
              proposedAction: { action: "authorize-side-effect", intent: intent as unknown as JsonValue }
            });
            const outcome = await opened.decision;
            if (outcome.decision === "rejected") {
              throw new SideEffectAuthorizationError("approval-required", intent, authorization.reason ?? "human rejected the proposed side effect");
            }
            await emit("node.authorization.granted", node.id, {
              requestId: outcome.requestId,
              decidedBy: outcome.decidedBy ?? null,
              comment: outcome.comment ?? null,
              intent: intent as unknown as JsonValue
            });
          } else if (authorization.decision !== "allowed") {
            throw new SideEffectAuthorizationError(authorization.decision, intent, authorization.reason);
          }
        } else {
          await emit("node.authorization.compatibility-warning", node.id, {
            warning: "legacy manifest has no CapabilityBroker; Provider invocation was allowed for compatibility"
          });
        }
        attemptReservation?.commit();
        providerReservation?.commit();
      } catch (error) {
        attemptReservation?.release();
        providerReservation?.release();
        throw error;
      }
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
          signal: callSignal.signal,
          onProgress: async (progress: ProviderProgress) => {
            const eventType = progress.kind === "long-running"
              ? "node.long-running"
              : progress.kind === "output"
                ? "node.progress"
                : "node.provider-timeout";
            await emit(eventType, node.id, progress);
          }
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
      if (governance.getCancellationEpoch
        && await governance.getCancellationEpoch() !== governance.cancellationEpoch) {
        throw new ProviderExecutionError("workflow execution was cancelled; late Provider result was fenced", response.stdout, response.stderr, {
          kind: "aborted", retryable: false, durationMs: response.durationMs
        });
      }
      await store.writeText(attemptDir, "stdout.txt", response.stdout);
      await store.writeText(attemptDir, "stderr.txt", response.stderr);
      await store.writeText(attemptDir, "raw-output.txt", response.stdout);
      const output = parseProviderOutput(provider.outputProtocol ?? "json", response.stdout);
      validateStructuredOutput(outputSchema, output, node.id);
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
      const validationFailure = !(error instanceof ProviderExecutionError)
        && !(error instanceof SideEffectAuthorizationError)
        && !(error instanceof CapabilityBrokerUnavailableError)
        && !(error instanceof ExecutionBudgetExceededError);
      const retryable = error instanceof ProviderExecutionError
        ? error.retryable
        : Boolean(options.retryValidation);
      lastFailure = error instanceof SideEffectAuthorizationError
        ? { category: "authorization", kind: error.decision, retryable: false }
        : error instanceof CapabilityBrokerUnavailableError
          ? { category: "authorization-technical", kind: "broker-unavailable", retryable: false }
        : error instanceof ExecutionBudgetExceededError
          ? { category: "budget", kind: error.counter, retryable: false }
          : error instanceof ProviderExecutionError
        ? { category: "provider", kind: error.kind, retryable }
        : { category: "output-validation", retryable };
      const willRetry = recoveryAttempt < maxAttempts && retryable;
      if (willRetry && validationFailure) {
        node.with = {
          ...node.with,
          __previousAttemptError: error instanceof Error ? error.message : String(error)
        };
      }
      await store.writeAttemptJson(attemptDir, "error.json", {
        attempt,
        error: error instanceof Error ? error.message : String(error),
        kind: error instanceof SideEffectAuthorizationError
          ? error.decision
          : error instanceof CapabilityBrokerUnavailableError
            ? "broker-unavailable"
          : error instanceof ExecutionBudgetExceededError
            ? error.counter
            : error instanceof ProviderExecutionError ? error.kind : "validation",
        retryable,
        willRetry,
        durationMs: error instanceof ProviderExecutionError ? error.durationMs : undefined
      });
      await emit("node.attempt.failed", node.id, {
        attempt,
        error: error instanceof Error ? error.message : String(error),
        kind: error instanceof SideEffectAuthorizationError
          ? error.decision
          : error instanceof CapabilityBrokerUnavailableError
            ? "broker-unavailable"
          : error instanceof ExecutionBudgetExceededError
            ? error.counter
            : error instanceof ProviderExecutionError ? error.kind : "validation",
        retryable,
        willRetry
      });
      if (!willRetry) break;
    }
  }

  const failed: NodeRunResult = {
    ...result,
    status: lastFailure?.category === "authorization" && lastFailure.kind === "approval-required" ? "blocked" : "failed",
    completedAt: now(),
    error: lastError instanceof Error ? lastError.message : String(lastError),
    failure: lastFailure
  };
  run.nodes[node.id] = failed;
  await store.writeRun(run);
  await emit("node.failed", node.id, {
    error: failed.error ?? "Provider invocation failed",
    failure: failed.failure ? {
      category: failed.failure.category,
      ...(failed.failure.kind ? { kind: failed.failure.kind } : {}),
      retryable: failed.failure.retryable
    } : null
  });
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
  let plan = compilePlan(loaded, workflowId, architectures);
  const architecture = architectures.get(plan.architecture);
  if (!architecture) throw new Error(`architecture adapter not registered: ${plan.architecture}`);
  const providerCwd = path.resolve(options.providerCwd ?? loaded.projectRoot);
  const runId = options.runId ?? `run-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = options.artifactRoot
    ? path.resolve(options.artifactRoot)
    : path.resolve(loaded.projectRoot, loaded.manifest.artifactRoot ?? ".multi-agent");
  const store = await RunStore.create(artifactRoot, runId);
  const effectivePolicyPack = loaded.manifest.workflows[workflowId]?.config.effectivePolicyPack;
  if (effectivePolicyPack) {
    await fs.promises.writeFile(
      path.join(store.runDir, "effective-policy-pack.json"),
      `${JSON.stringify(effectivePolicyPack, null, 2)}\n`,
      "utf8"
    );
  }
  const checkpointOwner = `runner-${process.pid}-${randomUUID().slice(0, 8)}`;
  let checkpoint: Checkpoint<RuntimeCheckpointValue> | undefined;
  let checkpointQueue: Promise<void> = Promise.resolve();
  let budget = options.budget;
  const cancellationEpoch = options.getCancellationEpoch ? await options.getCancellationEpoch() : 0;
  const assertCancellationEpoch = async (): Promise<void> => {
    if (options.getCancellationEpoch && await options.getCancellationEpoch() !== cancellationEpoch) {
      throw new ProviderExecutionError("workflow cancellation epoch changed", "", "", { kind: "aborted", retryable: false });
    }
  };
  let run: WorkflowRunRecord;
  if (options.resume) {
    const [persistedRun, persistedPlan, durableCheckpoint] = await Promise.all([
      fs.promises.readFile(path.join(store.runDir, "run.json"), "utf8"),
      fs.promises.readFile(path.join(store.runDir, "plan.json"), "utf8"),
      store.readCheckpoint<RuntimeCheckpointValue>()
    ]);
    run = JSON.parse(persistedRun) as WorkflowRunRecord;
    plan = JSON.parse(persistedPlan) as typeof plan;
    if (run.id !== runId || run.workflow !== workflowId || run.architecture !== plan.architecture) {
      throw new Error(`Run ${runId} recovery snapshot does not match workflow ${workflowId}`);
    }
    if (durableCheckpoint && Date.parse(durableCheckpoint.leaseExpiresAt) > Date.now()) {
      throw new Error(`Run ${runId} checkpoint lease is held by ${durableCheckpoint.owner}`);
    }
    if (durableCheckpoint?.value.budget) {
      budget = new ExecutionBudget(durableCheckpoint.value.budget.limits, durableCheckpoint.value.budget);
    }
    checkpoint = {
      revision: (durableCheckpoint?.revision ?? 0) + 1,
      owner: checkpointOwner,
      fencingToken: (durableCheckpoint?.fencingToken ?? 0) + 1,
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      value: { runStatus: "running", cancellationEpoch, ...(budget ? { budget: budget.snapshot() } : {}) }
    };
    await store.commitCheckpoint(checkpoint, durableCheckpoint?.revision ?? 0);
    run.status = "running";
    delete run.completedAt;
    delete run.error;
    if (options.isolation) run.isolation = options.isolation;
  } else {
    run = {
      id: runId,
      workflow: workflowId,
      architecture: plan.architecture,
      manifestPath: loaded.manifestPath,
      artifactDir: store.runDir,
      status: "running",
      createdAt: now(),
      ...(options.isolation ? { isolation: options.isolation } : {}),
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
    checkpoint = {
      revision: 1,
      owner: checkpointOwner,
      fencingToken: 1,
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      value: { runStatus: "running", cancellationEpoch, ...(budget ? { budget: budget.snapshot() } : {}) }
    };
    await store.commitCheckpoint(checkpoint, 0);
  }
  const registry = options.providers ?? createDefaultProviderRegistry();
  const emit = async (type: string, nodeId?: string, detail?: JsonValue): Promise<void> => {
    const event: RunEvent = { at: now(), type, nodeId, detail };
    await store.appendEvent(event);
    await options.onEvent?.({ ...event, runId, workflow: workflowId });
    checkpointQueue = checkpointQueue.then(async () => {
      if (!checkpoint) return;
      await assertCancellationEpoch();
      const next: Checkpoint<RuntimeCheckpointValue> = {
        ...checkpoint,
        revision: checkpoint.revision + 1,
        leaseExpiresAt: new Date(Date.now() + (/^run\.(?:passed|blocked|failed)$/.test(type) ? 0 : 30_000)).toISOString(),
        value: { runStatus: run.status, cancellationEpoch, ...(budget ? { budget: budget.snapshot() } : {}) }
      };
      await store.commitCheckpoint(next, checkpoint.revision);
      checkpoint = next;
      await store.writeRunManifest({ budget: next.value.budget, checkpointRevision: next.revision });
    });
    await checkpointQueue;
  };
  if (!options.resume) {
    await store.writeInput(input);
    await store.writePlan(plan);
    for (const [relativePath, value] of Object.entries(options.initialArtifacts ?? {})) {
      await store.writeArtifact(relativePath, value);
    }
  }
  await store.writeRun(run);
  await emit(options.resume ? "run.resumed" : "run.started", undefined, {
    workflow: workflowId,
    architecture: plan.architecture
  });

  const scheduled = new Set<string>(options.resume ? plan.nodes.map((node) => node.id) : []);
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
    executionOptions?: ExecuteNodeOptions
  ): Promise<NodeRunResult> => {
    const durable = run.nodes[node.id];
    if (options.resume && durable && (
      durable.status === "passed"
      || durable.status === "blocked"
      || (durable.status === "failed" && durable.failure?.retryable !== true)
      || durable.status === "skipped"
    )) {
      await emit("node.replayed", node.id, { status: durable.status, attempts: durable.attempts });
      return durable;
    }
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
        error: error instanceof Error ? error.message : String(error),
        failure: { category: "preparation", retryable: false }
      };
      run.nodes[node.id] = failed;
      await store.writeRun(run);
      await emit("node.failed", node.id, {
        error: failed.error ?? "node preparation failed",
        phase: "prepare",
        failure: { category: "preparation", retryable: false }
      });
      return failed;
    }
    let permit: Awaited<ReturnType<NonNullable<RunWorkflowOptions["acquireNodePermit"]>>> = undefined;
    try {
      permit = await options.acquireNodePermit?.(prepared.node);
      if (permit?.resources?.length) {
        await emit("node.resources.acquired", prepared.node.id, { resources: permit.resources });
      }
      return await executeNode(
        loaded,
        run,
        prepared.node,
        input,
        store,
        registry,
        emit,
        providerCwd,
        options.signal,
      executionOptions,
      {
        capabilityBroker: options.capabilityBroker,
        budget,
        openHumanDecision: options.openHumanDecision,
        getCancellationEpoch: options.getCancellationEpoch,
        cancellationEpoch
      }
      );
    } catch (error) {
      if (permit) throw error;
      const failed: NodeRunResult = {
        nodeId: prepared.node.id,
        roleId: nodeRoleId(prepared.node),
        metadata: prepared.node.metadata,
        status: "failed",
        attempts: 0,
        completedAt: now(),
        error: error instanceof Error ? error.message : String(error),
        failure: { category: "preparation", retryable: false }
      };
      run.nodes[prepared.node.id] = failed;
      await store.writeRun(run);
      await emit("node.failed", prepared.node.id, {
        error: failed.error ?? "node resource acquisition failed",
        phase: "resource-acquisition",
        failure: { category: "preparation", retryable: false }
      });
      return failed;
    } finally {
      if (permit) {
        await permit.release();
        if (permit.resources?.length) {
          await emit("node.resources.released", prepared.node.id, { resources: permit.resources });
        }
      }
    }
  };
  let executionResult: Awaited<ReturnType<typeof architecture.execute>>;
  try {
    executionResult = await architecture.execute({
      loaded,
      input,
      plan,
      run,
      budget,
      scheduleNode,
      executeNode: executePreparedNode,
      readArtifact: async <T>(relativePath: string): Promise<T | undefined> => {
        try {
          return await store.readArtifact<T>(relativePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
      writeArtifact: (relativePath, value) => store.writeArtifact(relativePath, value),
      candidateSnapshot: () => candidateWorkspaceSnapshot(options.providerCwd ?? loaded.projectRoot),
      executionPackageScripts: async () => {
        try {
          const value = JSON.parse(await fs.promises.readFile(
            path.join(options.providerCwd ?? loaded.projectRoot, "package.json"),
            "utf8"
          )) as { scripts?: Record<string, unknown> };
          return Object.fromEntries(Object.entries(value.scripts ?? {})
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
          throw error;
        }
      },
      requestHumanDecision: options.openHumanDecision
        ? async (request) => {
            const opened = await options.openHumanDecision!(request);
            await emit("human-decision.requested", request.nodeId, {
              requestId: opened.requestId,
              round: request.round,
              riskCategory: request.riskCategory,
              summary: request.summary,
              proposedAction: request.proposedAction
            });
            const outcome = await opened.decision;
            await emit(`human-decision.${outcome.decision}`, request.nodeId, {
              requestId: outcome.requestId,
              decision: outcome.decision,
              decidedBy: outcome.decidedBy ?? null,
              comment: outcome.comment ?? null
            });
            return outcome;
          }
        : undefined,
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
  const workflowContract = loaded.manifest.workflows[workflowId]?.outputSchema;
  if (workflowContract && run.status === "passed") {
    const schema = readJsonSchema(path.resolve(loaded.projectRoot, workflowContract));
    try {
      validateStructuredOutput(schema, run.output ?? null, `workflow ${workflowId}`);
      await fs.promises.writeFile(path.join(store.runDir, "workflow-output-validation.json"), `${JSON.stringify({
        status: "passed",
        schemaVersion: loaded.manifest.workflows[workflowId]?.outputSchemaVersion ?? 1,
        schemaDigest: loaded.manifest.workflows[workflowId]?.outputSchemaDigest ?? null
      }, null, 2)}\n`, "utf8");
      await emit("workflow.output-validation.passed");
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      await fs.promises.writeFile(path.join(store.runDir, "workflow-output-validation.json"), `${JSON.stringify({
        status: "failed",
        category: "workflow-output-validation",
        error: run.error,
        output: run.output ?? null,
        schemaVersion: loaded.manifest.workflows[workflowId]?.outputSchemaVersion ?? 1,
        schemaDigest: loaded.manifest.workflows[workflowId]?.outputSchemaDigest ?? null
      }, null, 2)}\n`, "utf8");
      await emit("workflow.output-validation.failed", undefined, { category: "workflow-output-validation", error: run.error });
    }
  }
  run.completedAt = now();
  await store.writeRun(run);
  await emit(`run.${run.status}`);
  return { run, runDir: store.runDir };
}
