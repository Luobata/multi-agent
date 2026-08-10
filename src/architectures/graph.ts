import { Ajv, type ErrorObject } from "ajv";
import { ManifestValidationError } from "../core/errors.js";
import type {
  ExecutionPlan,
  ExecutionPlanNode,
  JsonObject,
  LoadedManifest,
  WorkflowNodeDefinition
} from "../core/types.js";
import type { ArchitectureAdapter, ArchitectureExecutionContext, ArchitectureValidationContext } from "./types.js";

interface GraphWorkflowConfig {
  maxConcurrency?: number;
  failFast?: boolean;
  nodes: WorkflowNodeDefinition[];
}

const graphConfigSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nodes"],
  properties: {
    maxConcurrency: { type: "integer", minimum: 1, maximum: 32 },
    failFast: { type: "boolean" },
    nodes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "role"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
          role: { type: "string", minLength: 1 },
          needs: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
          with: { type: "object" }
        }
      }
    }
  }
} as const;

function graphConfig(value: JsonObject): GraphWorkflowConfig {
  return value as unknown as GraphWorkflowConfig;
}

function shapeIssues(config: JsonObject): string[] {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(graphConfigSchema);
  if (validate(config)) return [];
  return (validate.errors ?? []).map(
    (error: ErrorObject) => `graph config${error.instancePath || "/"} ${error.message ?? "is invalid"}`
  );
}

function validateGraph(context: ArchitectureValidationContext): string[] {
  const issues = shapeIssues(context.workflow.config);
  if (issues.length > 0) return issues;
  const config = graphConfig(context.workflow.config);
  const nodeIds = new Set<string>();

  for (const node of config.nodes) {
    if (nodeIds.has(node.id)) issues.push(`workflow ${context.workflowId} has duplicate node id ${node.id}`);
    nodeIds.add(node.id);
    if (!context.manifest.roles[node.role]) {
      issues.push(`workflow ${context.workflowId} node ${node.id} references unknown role ${node.role}`);
    }
  }
  for (const node of config.nodes) {
    for (const need of node.needs ?? []) {
      if (!nodeIds.has(need)) issues.push(`workflow ${context.workflowId} node ${node.id} needs unknown node ${need}`);
      if (need === node.id) issues.push(`workflow ${context.workflowId} node ${node.id} cannot depend on itself`);
    }
  }

  const remaining = new Set(nodeIds);
  const resolved = new Set<string>();
  while (remaining.size > 0) {
    const ready = config.nodes.filter((node) => remaining.has(node.id) && (node.needs ?? []).every((need) => resolved.has(need)));
    if (ready.length === 0) {
      issues.push(`workflow ${context.workflowId} contains a dependency cycle involving: ${[...remaining].join(", ")}`);
      break;
    }
    for (const node of ready) {
      remaining.delete(node.id);
      resolved.add(node.id);
    }
  }
  return issues;
}

function compileGraph(loaded: LoadedManifest, workflowId: string): ExecutionPlan {
  const workflow = loaded.manifest.workflows[workflowId];
  if (!workflow) throw new ManifestValidationError([`workflow not found: ${workflowId}`]);
  const config = graphConfig(workflow.config);
  const remaining = new Map(config.nodes.map((node) => [node.id, node]));
  const resolved = new Set<string>();
  const waves: ExecutionPlanNode[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((node) => (node.needs ?? []).every((need) => resolved.has(need)));
    if (ready.length === 0) throw new ManifestValidationError([`workflow ${workflowId} contains a dependency cycle`]);
    waves.push(
      ready.map((node) => {
        const role = loaded.manifest.roles[node.role];
        if (!role) throw new ManifestValidationError([`unknown role ${node.role}`]);
        return {
          id: node.id,
          role: node.role,
          provider: role.provider,
          needs: node.needs ?? [],
          with: { ...(node.with ?? {}), __previousAttemptError: "" }
        };
      })
    );
    for (const node of ready) {
      remaining.delete(node.id);
      resolved.add(node.id);
    }
  }

  return {
    architecture: "graph",
    workflow: workflowId,
    description: workflow.description,
    nodes: waves.flat(),
    data: {
      maxConcurrency: config.maxConcurrency ?? 4,
      failFast: config.failFast ?? false,
      waves: waves.map((wave) => wave.map((node) => node.id))
    }
  };
}

function planWaves(plan: ExecutionPlan): ExecutionPlanNode[][] {
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const waveIds = plan.data.waves;
  if (!Array.isArray(waveIds)) throw new Error("graph execution plan is missing waves");
  return waveIds.map((wave) => {
    if (!Array.isArray(wave)) throw new Error("graph execution plan wave must be an array");
    return wave.map((nodeId) => {
      if (typeof nodeId !== "string") throw new Error("graph execution plan node id must be a string");
      const node = nodes.get(nodeId);
      if (!node) throw new Error(`graph execution plan references unknown node ${nodeId}`);
      return node;
    });
  });
}

function planConcurrency(plan: ExecutionPlan): number {
  const value = plan.data.maxConcurrency;
  if (typeof value !== "number") throw new Error("graph execution plan is missing maxConcurrency");
  return value;
}

function planFailFast(plan: ExecutionPlan): boolean {
  return plan.data.failFast === true;
}

function formatGraphText(plan: ExecutionPlan): string {
  const maxConcurrency = planConcurrency(plan);
  const failFast = planFailFast(plan);
  const lines = [
    `Workflow: ${plan.workflow}`,
    `Architecture: ${plan.architecture}`,
    plan.description ? `Purpose: ${plan.description}` : undefined,
    `Concurrency: ${maxConcurrency}`,
    `Failure policy: ${failFast ? "fail-fast" : "collect independent evidence"}`,
    ""
  ].filter((line): line is string => line !== undefined);
  planWaves(plan).forEach((wave, index) => {
    lines.push(`Wave ${index + 1} (${wave.length > 1 ? "parallel" : "serial"})`);
    for (const node of wave) {
      lines.push(`  - ${node.id}: ${node.role} via ${node.provider}${node.needs.length ? `; needs ${node.needs.join(", ")}` : ""}`);
    }
  });
  return lines.join("\n");
}

function formatGraphMermaid(plan: ExecutionPlan): string {
  const lines = ["flowchart LR"];
  for (const node of plan.nodes) {
    lines.push(`  ${node.id.replaceAll("-", "_")}[\"${node.id}<br/>${node.role}\"]`);
    for (const dependency of node.needs) {
      lines.push(`  ${dependency.replaceAll("-", "_")} --> ${node.id.replaceAll("-", "_")}`);
    }
  }
  return lines.join("\n");
}

async function executeGraph(context: ArchitectureExecutionContext): Promise<void> {
  const pending = new Map(context.plan.nodes.map((node) => [node.id, node]));
  const running = new Map<string, Promise<{ nodeId: string; result: Awaited<ReturnType<typeof context.executeNode>> }>>();
  const concurrency = planConcurrency(context.plan);
  let halted = false;

  const skipPending = async (): Promise<void> => {
    for (const node of pending.values()) {
      context.run.nodes[node.id] = {
        nodeId: node.id,
        roleId: node.role,
        status: "skipped",
        attempts: 0,
        completedAt: new Date().toISOString(),
        error: "workflow stopped by fail-fast policy"
      };
      await context.emit("node.skipped", node.id, { reason: "fail-fast" });
    }
    pending.clear();
    await context.persist();
  };

  while (pending.size > 0 || running.size > 0) {
    if (!halted) {
      const ready = [...pending.values()].filter((node) =>
        node.needs.every((dependency) => !["pending", "running"].includes(context.run.nodes[dependency]?.status ?? "pending"))
      );
      for (const node of ready) {
        if (running.size >= concurrency) break;
        pending.delete(node.id);
        running.set(node.id, context.executeNode(node, { retryValidation: true }).then((result) => ({ nodeId: node.id, result })));
      }
    }

    if (halted && pending.size > 0) await skipPending();
    if (running.size === 0) {
      if (pending.size > 0) throw new Error(`graph scheduler stalled with pending nodes: ${[...pending.keys()].join(", ")}`);
      break;
    }

    const completed = await Promise.race(running.values());
    running.delete(completed.nodeId);
    context.run.nodes[completed.nodeId] = completed.result;
    await context.persist();
    if (planFailFast(context.plan) && completed.result.status === "failed") halted = true;
  }
}

export const graphArchitectureAdapter: ArchitectureAdapter = {
  id: "graph",
  validate: validateGraph,
  compile: compileGraph,
  formatText: formatGraphText,
  formatMermaid: formatGraphMermaid,
  execute: executeGraph
};
