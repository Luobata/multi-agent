import { Ajv, type ErrorObject } from "ajv";
import { ManifestValidationError } from "../core/errors.js";
import type { ExecutionPlan, ExecutionPlanNode, JsonObject, JsonValue, LoadedManifest } from "../core/types.js";
import type {
  ArchitectureAdapter,
  ArchitectureExecutionContext,
  ArchitectureExecutionResult,
  ArchitectureValidationContext
} from "./types.js";

interface SupervisorPolicyConfig {
  id: string;
  version: number;
  instructions: string;
  allowedRoleIds: string[];
  limits: {
    maxRounds: number;
    maxDelegations: number;
    maxParallelDelegations: number;
    maxDurationMs: number;
  };
  failure: {
    workerFailure: "observe-and-replan" | "fail-fast";
  };
  completion: {
    requireDelegation: boolean;
    requireAllDelegationsSuccessful: boolean;
  };
}

interface SupervisorWorkflowConfig {
  supervisor: { role: string };
  policy: SupervisorPolicyConfig;
  members: Array<{ roleId: string; role: string; description: string }>;
}

type SupervisorDecision =
  | {
      action: "delegate";
      summary?: string;
      assignments: Array<{ roleId: string; task: string; context?: JsonObject }>;
    }
  | {
      action: "finish";
      summary: string;
      result: JsonValue;
    };

const supervisorConfigSchema = {
  type: "object",
  additionalProperties: false,
  required: ["supervisor", "policy", "members"],
  properties: {
    supervisor: {
      type: "object",
      additionalProperties: false,
      required: ["role"],
      properties: { role: { type: "string", minLength: 1 } }
    },
    policy: {
      type: "object",
      additionalProperties: false,
      required: ["id", "version", "instructions", "allowedRoleIds", "limits", "failure", "completion"],
      properties: {
        id: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
        version: { type: "integer", minimum: 1 },
        instructions: { type: "string", minLength: 1 },
        allowedRoleIds: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z][a-z0-9-]*$" }
        },
        limits: {
          type: "object",
          additionalProperties: false,
          required: ["maxRounds", "maxDelegations", "maxParallelDelegations", "maxDurationMs"],
          properties: {
            maxRounds: { type: "integer", minimum: 1, maximum: 32 },
            maxDelegations: { type: "integer", minimum: 1, maximum: 256 },
            maxParallelDelegations: { type: "integer", minimum: 1, maximum: 32 },
            maxDurationMs: { type: "integer", minimum: 1000, maximum: 86400000 }
          }
        },
        failure: {
          type: "object",
          additionalProperties: false,
          required: ["workerFailure"],
          properties: { workerFailure: { enum: ["observe-and-replan", "fail-fast"] } }
        },
        completion: {
          type: "object",
          additionalProperties: false,
          required: ["requireDelegation", "requireAllDelegationsSuccessful"],
          properties: {
            requireDelegation: { type: "boolean" },
            requireAllDelegationsSuccessful: { type: "boolean" }
          }
        }
      }
    },
    members: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["roleId", "role", "description"],
        properties: {
          roleId: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
          role: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 }
        }
      }
    }
  }
} as const;

function config(value: JsonObject): SupervisorWorkflowConfig {
  return value as unknown as SupervisorWorkflowConfig;
}

function shapeIssues(value: JsonObject): string[] {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(supervisorConfigSchema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map(
    (error: ErrorObject) => `supervisor config${error.instancePath || "/"} ${error.message ?? "is invalid"}`
  );
}

function validateSupervisor(context: ArchitectureValidationContext): string[] {
  const issues = shapeIssues(context.workflow.config);
  if (issues.length > 0) return issues;
  const value = config(context.workflow.config);
  if (!context.manifest.roles[value.supervisor.role]) {
    issues.push(`workflow ${context.workflowId} supervisor references unknown role ${value.supervisor.role}`);
  }
  const roleIds = new Set<string>();
  const runtimeRoles = new Set<string>();
  const allowed = new Set(value.policy.allowedRoleIds);
  for (const member of value.members) {
    if (roleIds.has(member.roleId)) issues.push(`workflow ${context.workflowId} has duplicate supervisor member role ${member.roleId}`);
    if (runtimeRoles.has(member.role)) issues.push(`workflow ${context.workflowId} maps more than one member to runtime role ${member.role}`);
    if (!allowed.has(member.roleId)) {
      issues.push(`workflow ${context.workflowId} member role ${member.roleId} is not allowed by policy ${value.policy.id} v${value.policy.version}`);
    }
    if (!context.manifest.roles[member.role]) {
      issues.push(`workflow ${context.workflowId} member ${member.roleId} references unknown role ${member.role}`);
    }
    roleIds.add(member.roleId);
    runtimeRoles.add(member.role);
  }
  if (value.policy.limits.maxParallelDelegations > value.policy.limits.maxDelegations) {
    issues.push(`workflow ${context.workflowId} maxParallelDelegations cannot exceed maxDelegations`);
  }
  return issues;
}

function supervisorWith(value: SupervisorWorkflowConfig, round: number, history: JsonValue[]): JsonObject {
  return {
    __supervisorRound: round,
    __managementPolicy: value.policy as unknown as JsonValue,
    __supervisorTeam: value.members.map(({ roleId, description }) => ({ roleId, description })),
    __supervisorHistory: history
  };
}

function supervisorNode(value: SupervisorWorkflowConfig, round: number, needs: string[], history: JsonValue[]): ExecutionPlanNode {
  return {
    id: `supervisor-r${round}`,
    role: value.supervisor.role,
    provider: "",
    needs,
    with: supervisorWith(value, round, history),
    metadata: { kind: "supervisor", roleId: "supervisor", round }
  };
}

function compileSupervisor(loaded: LoadedManifest, workflowId: string): ExecutionPlan {
  const workflow = loaded.manifest.workflows[workflowId];
  if (!workflow) throw new ManifestValidationError([`workflow not found: ${workflowId}`]);
  const value = config(workflow.config);
  const initial = supervisorNode(value, 1, [], []);
  initial.provider = loaded.manifest.roles[initial.role]?.provider ?? "";
  return {
    architecture: "supervisor",
    workflow: workflowId,
    description: workflow.description,
    nodes: [initial],
    data: workflow.config
  };
}

function planConfig(plan: ExecutionPlan): SupervisorWorkflowConfig {
  return config(plan.data);
}

function formatSupervisorText(plan: ExecutionPlan): string {
  const value = planConfig(plan);
  return [
    `Workflow: ${plan.workflow}`,
    "Architecture: supervisor",
    plan.description ? `Purpose: ${plan.description}` : undefined,
    `Management policy: ${value.policy.id} v${value.policy.version}`,
    `Supervisor role: ${value.supervisor.role}`,
    `Members: ${value.members.map((member) => `${member.roleId} (${member.role})`).join(", ")}`,
    `Limits: ${value.policy.limits.maxRounds} rounds, ${value.policy.limits.maxDelegations} delegations, ${value.policy.limits.maxParallelDelegations} parallel`
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function mermaidId(value: string): string {
  return value.replaceAll("-", "_");
}

function formatSupervisorMermaid(plan: ExecutionPlan): string {
  const value = planConfig(plan);
  const lines = ["flowchart LR", `  supervisor[\"Supervisor<br/>${value.supervisor.role}\"]`];
  for (const member of value.members) {
    lines.push(`  ${mermaidId(member.roleId)}[\"${member.roleId}<br/>${member.role}\"]`);
    lines.push(`  supervisor -. runtime delegation .-> ${mermaidId(member.roleId)}`);
  }
  return lines.join("\n");
}

function decision(value: JsonValue | undefined): SupervisorDecision | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, JsonValue>;
  if (candidate.action === "delegate" && Array.isArray(candidate.assignments)) return candidate as unknown as SupervisorDecision;
  if (candidate.action === "finish" && typeof candidate.summary === "string" && "result" in candidate) {
    return candidate as unknown as SupervisorDecision;
  }
  return undefined;
}

function blocked(reason: string, round: number, delegations: number): ArchitectureExecutionResult {
  return {
    status: "blocked",
    output: { reason, rounds: round, delegations }
  };
}

async function executeSupervisor(context: ArchitectureExecutionContext): Promise<ArchitectureExecutionResult> {
  const value = planConfig(context.plan);
  const members = new Map(value.members.map((member) => [member.roleId, member]));
  const startedAt = Date.now();
  const history: JsonValue[] = [];
  const workerResults: Array<{ status: string }> = [];
  let round = 1;
  let delegationCount = 0;
  let latestWorkerNodeIds: string[] = [];
  const deadlineAt = startedAt + value.policy.limits.maxDurationMs;
  const durationExceeded = () => Date.now() >= deadlineAt;

  while (true) {
    if (durationExceeded()) {
      return blocked("management policy duration limit reached before convergence", round - 1, delegationCount);
    }
    const node = round === 1
      ? context.plan.nodes[0]!
      : supervisorNode(value, round, latestWorkerNodeIds, history);
    const supervisorRole = context.loaded.manifest.roles[node.role];
    if (!supervisorRole) throw new Error(`supervisor runtime role not found: ${node.role}`);
    node.provider = supervisorRole.provider;
    await context.scheduleNode(node);
    const supervisorResult = await context.executeNode(node, { dependencyFailure: "observe", deadlineAt });
    if (durationExceeded()) {
      return blocked("management policy duration limit reached before convergence", round, delegationCount);
    }
    if (supervisorResult.status === "failed" || supervisorResult.status === "skipped") {
      return {
        status: "failed",
        output: { reason: supervisorResult.error ?? "supervisor decision failed", rounds: round, delegations: delegationCount }
      };
    }
    const next = decision(supervisorResult.output);
    if (!next) {
      return {
        status: "failed",
        output: { reason: "supervisor returned an invalid decision", rounds: round, delegations: delegationCount }
      };
    }

    if (next.action === "finish") {
      if (value.policy.completion.requireDelegation && delegationCount === 0) {
        return blocked("management policy requires at least one delegation before completion", round, delegationCount);
      }
      if (
        value.policy.completion.requireAllDelegationsSuccessful
        && workerResults.some((result) => result.status !== "passed")
      ) {
        return blocked("management policy requires every delegation to complete successfully", round, delegationCount);
      }
      return {
        status: "passed",
        output: { summary: next.summary, result: next.result, rounds: round, delegations: delegationCount }
      };
    }

    if (round >= value.policy.limits.maxRounds) {
      return blocked("management policy round limit reached before convergence", round, delegationCount);
    }
    if (next.assignments.length === 0) {
      return { status: "failed", output: { reason: "delegate decision contains no assignments", rounds: round, delegations: delegationCount } };
    }
    if (next.assignments.length > value.policy.limits.maxParallelDelegations) {
      return blocked("management policy parallel delegation limit exceeded", round, delegationCount);
    }
    if (delegationCount + next.assignments.length > value.policy.limits.maxDelegations) {
      return blocked("management policy delegation limit reached before convergence", round, delegationCount);
    }

    const scheduled = next.assignments.map((assignment, index) => {
      const member = members.get(assignment.roleId);
      if (!member) throw new Error(`supervisor delegated to unbound role ${assignment.roleId}`);
      const role = context.loaded.manifest.roles[member.role];
      if (!role) throw new Error(`supervisor member runtime role not found: ${member.role}`);
      const worker: ExecutionPlanNode = {
        id: `${member.roleId}-r${round}-${index + 1}`,
        role: member.role,
        provider: role.provider,
        needs: [node.id],
        with: {
          __delegatedRoleId: member.roleId,
          __delegatedTask: assignment.task,
          __delegatedContext: assignment.context ?? {},
          __supervisorSummary: next.summary ?? ""
        },
        metadata: {
          kind: "member",
          roleId: member.roleId,
          round,
          parentNodeId: node.id
        }
      };
      return { assignment, worker };
    });
    for (const item of scheduled) await context.scheduleNode(item.worker);
    const completed = await Promise.all(scheduled.map(async ({ assignment, worker }) => ({
      assignment,
      worker,
      result: await context.executeNode(worker, { deadlineAt })
    })));
    delegationCount += completed.length;
    workerResults.push(...completed.map(({ result }) => ({ status: result.status })));
    history.push({
      round,
      supervisorNodeId: node.id,
      decision: next as unknown as JsonValue,
      delegations: completed.map(({ assignment, worker, result }) => ({
        nodeId: worker.id,
        roleId: assignment.roleId,
        task: assignment.task,
        status: result.status,
        output: result.output ?? null,
        error: result.error ?? null
      }))
    });
    latestWorkerNodeIds = completed.map(({ worker }) => worker.id);
    if (durationExceeded()) {
      return blocked("management policy duration limit reached before convergence", round, delegationCount);
    }
    if (
      value.policy.failure.workerFailure === "fail-fast"
      && completed.some(({ result }) => result.status === "failed" || result.status === "skipped")
    ) {
      return {
        status: "failed",
        output: { reason: "a delegated worker failed under fail-fast policy", rounds: round, delegations: delegationCount }
      };
    }
    round += 1;
  }
}

export const supervisorArchitectureAdapter: ArchitectureAdapter = {
  id: "supervisor",
  validate: validateSupervisor,
  compile: compileSupervisor,
  formatText: formatSupervisorText,
  formatMermaid: formatSupervisorMermaid,
  execute: executeSupervisor
};
