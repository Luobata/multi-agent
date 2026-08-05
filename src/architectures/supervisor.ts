import { Ajv, type ErrorObject } from "ajv";
import { ManifestValidationError } from "../core/errors.js";
import type { ExecutionPlan, ExecutionPlanNode, JsonObject, JsonValue, LoadedManifest, NodeRunResult } from "../core/types.js";
import type {
  ArchitectureAdapter,
  ArchitectureExecutionContext,
  ArchitectureExecutionResult,
  ArchitectureValidationContext
} from "./types.js";
import {
  normalizeSupervisorDagConfig,
  supervisorDagIssues,
  supervisorDagSnapshot,
  type SupervisorDagConfig,
  type SupervisorDagNodeTracker
} from "./supervisorDag.js";

type SupervisorWorkKind = "discussion" | "code" | "test" | "audit" | "integration" | "other";

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

interface SupervisorGateConfig {
  id: string;
  requiredCapability: string;
  mode: "after-each-delegation" | "before-completion";
  required: boolean;
  instructions: string;
  fallback: "supervisor" | "block";
}

type SupervisorFlowStageConfig =
  | { id: string; kind: "supervisor"; title: string }
  | { id: string; kind: "delegation-loop"; title: string }
  | { id: string; kind: "gate"; title: string; gateId: string }
  | { id: string; kind: "delivery"; title: string };

interface SupervisorFlowConfig {
  version: number;
  stages: SupervisorFlowStageConfig[];
  gates: SupervisorGateConfig[];
  dag?: SupervisorDagConfig;
}

interface SupervisorTeamMemberConfig {
  roleId: string;
  role: string;
  description: string;
  capabilities: string[];
}

interface SupervisorWorkflowConfig {
  supervisor: {
    role: string;
    capabilities: string[];
    skillInjection?: { id: string; version: number; reason: string };
  };
  policy: SupervisorPolicyConfig;
  members: SupervisorTeamMemberConfig[];
  flow: SupervisorFlowConfig;
}

interface SupervisorAssignment {
  nodeId?: string;
  roleId: string;
  task?: string;
  requiredCapabilities?: string[];
  workKind?: SupervisorWorkKind;
  changeSet?: string;
  context?: JsonObject;
}

type SupervisorDecision =
  | {
      action: "delegate";
      summary?: string;
      assignments: SupervisorAssignment[];
    }
  | {
      action: "satisfy-gate";
      gateId: string;
      summary: string;
      evidence: JsonValue;
    }
  | {
      action: "finish";
      summary: string;
      result: JsonValue;
    };

interface DelegationRecord {
  assignment: SupervisorAssignment;
  worker: ExecutionPlanNode;
  result: NodeRunResult;
}

function normalizedAssignmentFingerprint(assignment: SupervisorAssignment): string {
  const task = assignment.task?.trim().replace(/\s+/g, " ").toLocaleLowerCase() ?? "";
  return JSON.stringify([
    assignment.roleId,
    assignment.workKind ?? "other",
    assignment.changeSet ?? "",
    task,
    assignment.context ?? {}
  ]);
}

function repeatedBlockedAssignment(
  assignment: SupervisorAssignment,
  ledger: DelegationRecord[]
): DelegationRecord | undefined {
  const fingerprint = normalizedAssignmentFingerprint(assignment);
  const prior = [...ledger].reverse().find((record) => (
    record.result.status === "blocked"
    && normalizedAssignmentFingerprint(record.assignment) === fingerprint
  ));
  if (!prior) return undefined;
  const priorRound = typeof prior.worker.metadata?.round === "number" ? prior.worker.metadata.round : 0;
  const prerequisiteProgress = ledger.some((record) => {
    const recordRound = typeof record.worker.metadata?.round === "number" ? record.worker.metadata.round : 0;
    return record !== prior
      && record.result.status === "passed"
      && recordRound >= priorRound
      && (
        !assignment.changeSet
        || !record.assignment.changeSet
        || record.assignment.changeSet === assignment.changeSet
      );
  });
  return prerequisiteProgress ? undefined : prior;
}

type GateRunStatus = "pending" | "passed" | "blocked" | "skipped";

interface GateActivation {
  key: string;
  sourceNodeIds: string[];
}

interface GateExecutionRecord {
  nodeId: string;
  executorRoleId: string;
  executorRuntimeRole: string;
  activation: string;
  sourceNodeIds: string[];
  status: string;
  evidence: JsonValue;
  error: string | null;
}

interface GateTracker {
  gate: SupervisorGateConfig;
  status: GateRunStatus;
  activations: Map<string, GateActivation>;
  passed: Set<string>;
  executions: GateExecutionRecord[];
  reason?: string;
  noExecutor: boolean;
}

const defaultFlow = (): SupervisorFlowConfig => ({
  version: 1,
  stages: [
    { id: "plan", kind: "supervisor", title: "Plan" },
    { id: "delegation-loop", kind: "delegation-loop", title: "Delegation loop" },
    { id: "delivery", kind: "delivery", title: "Delivery" }
  ],
  gates: []
});

const supervisorConfigSchema = {
  type: "object",
  additionalProperties: false,
  required: ["supervisor", "policy", "members"],
  properties: {
    supervisor: {
      type: "object",
      additionalProperties: false,
      required: ["role"],
      properties: {
        role: { type: "string", minLength: 1 },
        capabilities: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
        skillInjection: {
          type: "object",
          additionalProperties: false,
          required: ["id", "version", "reason"],
          properties: {
            id: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
            version: { type: "integer", minimum: 1 },
            reason: { type: "string", minLength: 1 }
          }
        }
      }
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
          description: { type: "string", minLength: 1 },
          capabilities: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } }
        }
      }
    },
    flow: {
      type: "object",
      additionalProperties: false,
      required: ["version", "stages", "gates"],
      properties: {
        version: { type: "integer", minimum: 1 },
        stages: {
          type: "array",
          minItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "kind", "title"],
            properties: {
              id: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
              kind: { enum: ["supervisor", "delegation-loop", "gate", "delivery"] },
              title: { type: "string", minLength: 1 },
              gateId: { type: "string", pattern: "^[a-z][a-z0-9-]*$" }
            }
          }
        },
        gates: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "requiredCapability", "mode", "required", "instructions", "fallback"],
            properties: {
              id: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
              requiredCapability: { type: "string", minLength: 1 },
              mode: { enum: ["after-each-delegation", "before-completion"] },
              required: { type: "boolean" },
              instructions: { type: "string", minLength: 1 },
              fallback: { enum: ["supervisor", "block"] }
            }
          }
        },
        dag: {
          type: "object",
          additionalProperties: false,
          required: ["nodes"],
          properties: {
            nodes: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["nodeId", "needs", "kind", "task"],
                anyOf: [{ required: ["roleId"] }, { required: ["roleRef"] }],
                properties: {
                  nodeId: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
                  roleId: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
                  roleRef: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
                  needs: {
                    type: "array",
                    uniqueItems: true,
                    items: { type: "string", pattern: "^[a-z][a-z0-9-]*$" }
                  },
                  kind: { enum: ["task", "review", "test", "approval", "merge", "integration", "integration-test", "delivery", "other"] },
                  task: { type: "string", minLength: 1 },
                  requiredCapabilities: {
                    type: "array",
                    uniqueItems: true,
                    items: { type: "string", minLength: 1 }
                  },
                  workKind: { enum: ["discussion", "code", "test", "audit", "integration", "other"] },
                  changeSet: { type: "string", minLength: 1 },
                  required: { type: "boolean" }
                }
              }
            }
          }
        }
      }
    }
  }
} as const;

function config(value: JsonObject): SupervisorWorkflowConfig {
  const raw = value as unknown as Omit<SupervisorWorkflowConfig, "flow"> & { flow?: SupervisorFlowConfig };
  const flow = raw.flow ?? defaultFlow();
  return {
    ...raw,
    supervisor: { ...raw.supervisor, capabilities: raw.supervisor.capabilities ?? [] },
    members: raw.members.map((member) => ({ ...member, capabilities: member.capabilities ?? [] })),
    flow: { ...flow, dag: normalizeSupervisorDagConfig(flow.dag) }
  };
}

function shapeIssues(value: JsonObject): string[] {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(supervisorConfigSchema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map(
    (error: ErrorObject) => `supervisor config${error.instancePath || "/"} ${error.message ?? "is invalid"}`
  );
}

function flowIssues(workflowId: string, flow: SupervisorFlowConfig): string[] {
  const issues: string[] = [];
  const stageIds = new Set<string>();
  const gateIds = new Set<string>();
  for (const stage of flow.stages) {
    if (stageIds.has(stage.id)) issues.push(`workflow ${workflowId} has duplicate supervisor flow stage ${stage.id}`);
    stageIds.add(stage.id);
  }
  for (const gate of flow.gates) {
    if (gateIds.has(gate.id)) issues.push(`workflow ${workflowId} has duplicate supervisor gate ${gate.id}`);
    gateIds.add(gate.id);
  }
  const loopIndexes = flow.stages.flatMap((stage, index) => stage.kind === "delegation-loop" ? [index] : []);
  const deliveryIndexes = flow.stages.flatMap((stage, index) => stage.kind === "delivery" ? [index] : []);
  if (loopIndexes.length !== 1) issues.push(`workflow ${workflowId} supervisor flow must contain exactly one delegation-loop stage`);
  if (deliveryIndexes.length !== 1) issues.push(`workflow ${workflowId} supervisor flow must contain exactly one delivery stage`);
  const loopIndex = loopIndexes[0];
  const deliveryIndex = deliveryIndexes[0];
  if (loopIndex !== undefined && !flow.stages.some((stage, index) => stage.kind === "supervisor" && index < loopIndex)) {
    issues.push(`workflow ${workflowId} supervisor flow requires a supervisor plan stage before delegation-loop`);
  }
  if (loopIndex !== undefined && deliveryIndex !== undefined && (deliveryIndex <= loopIndex || deliveryIndex !== flow.stages.length - 1)) {
    issues.push(`workflow ${workflowId} supervisor flow delivery must be the final stage after delegation-loop`);
  }
  const referenced = new Set<string>();
  for (let index = 0; index < flow.stages.length; index += 1) {
    const stage = flow.stages[index]!;
    if (stage.kind !== "gate") continue;
    if (!stage.gateId) {
      issues.push(`workflow ${workflowId} supervisor gate stage ${stage.id} requires gateId`);
      continue;
    }
    if (!gateIds.has(stage.gateId)) issues.push(`workflow ${workflowId} supervisor gate stage ${stage.id} references unknown gate ${stage.gateId}`);
    if (referenced.has(stage.gateId)) issues.push(`workflow ${workflowId} supervisor gate ${stage.gateId} is referenced more than once`);
    referenced.add(stage.gateId);
    if (loopIndex !== undefined && deliveryIndex !== undefined && (index <= loopIndex || index >= deliveryIndex)) {
      issues.push(`workflow ${workflowId} supervisor gate stage ${stage.id} must be between delegation-loop and delivery`);
    }
  }
  for (const gate of flow.gates) {
    if (!referenced.has(gate.id)) issues.push(`workflow ${workflowId} supervisor gate ${gate.id} is not referenced by a flow stage`);
  }
  return issues;
}

function validateSupervisor(context: ArchitectureValidationContext): string[] {
  const issues = shapeIssues(context.workflow.config);
  if (issues.length > 0) return issues;
  const value = config(context.workflow.config);
  if (!context.manifest.roles[value.supervisor.role]) {
    issues.push(`workflow ${context.workflowId} supervisor references unknown role ${value.supervisor.role}`);
  }
  const roleIds = new Set<string>();
  const runtimeRoles = new Set<string>([value.supervisor.role]);
  const allowed = new Set(value.policy.allowedRoleIds);
  for (const member of value.members) {
    if (roleIds.has(member.roleId)) issues.push(`workflow ${context.workflowId} has duplicate supervisor member role ${member.roleId}`);
    if (runtimeRoles.has(member.role)) issues.push(`workflow ${context.workflowId} maps more than one team position to runtime role ${member.role}`);
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
  issues.push(...flowIssues(context.workflowId, value.flow));
  issues.push(...supervisorDagIssues(context.workflowId, value.flow.dag, roleIds));
  return issues;
}

function gateSnapshot(trackers: Map<string, GateTracker>, finalize = false): JsonValue[] {
  return [...trackers.values()].map((tracker) => {
    const status = finalize && tracker.status === "pending"
      ? tracker.activations.size === 0 ? "skipped" : "blocked"
      : tracker.status;
    return {
      gateId: tracker.gate.id,
      requiredCapability: tracker.gate.requiredCapability,
      mode: tracker.gate.mode,
      required: tracker.gate.required,
      fallback: tracker.gate.fallback,
      status,
      activations: tracker.activations.size,
      satisfiedActivations: tracker.passed.size,
      reason: tracker.reason ?? null,
      executions: tracker.executions.map((execution) => ({ ...execution }))
    };
  });
}

function supervisorWith(
  value: SupervisorWorkflowConfig,
  round: number,
  history: JsonValue[],
  gates: JsonValue[] = [],
  dagTrackers?: Map<string, SupervisorDagNodeTracker>
): JsonObject {
  return {
    __supervisorRound: round,
    __managementPolicy: value.policy as unknown as JsonValue,
    __supervisorFlow: value.flow as unknown as JsonValue,
    __supervisorTeam: value.members.map(({ roleId, description, capabilities }) => ({ roleId, description, capabilities })),
    __supervisorCapabilities: value.supervisor.capabilities,
    __supervisorGates: gates,
    ...(dagTrackers ? { __supervisorDag: supervisorDagSnapshot(dagTrackers) } : {}),
    __gateExecution: null,
    __supervisorHistory: history,
    __previousAttemptError: ""
  };
}

function supervisorNode(
  value: SupervisorWorkflowConfig,
  round: number,
  needs: string[],
  history: JsonValue[],
  gates: JsonValue[] = [],
  dagTrackers?: Map<string, SupervisorDagNodeTracker>
): ExecutionPlanNode {
  return {
    id: `supervisor-r${round}`,
    role: value.supervisor.role,
    provider: "",
    needs,
    with: supervisorWith(value, round, history, gates, dagTrackers),
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
    data: value as unknown as JsonObject
  };
}

function planConfig(plan: ExecutionPlan): SupervisorWorkflowConfig {
  return config(plan.data);
}

function formatSupervisorText(plan: ExecutionPlan): string {
  const value = planConfig(plan);
  const gates = value.flow.gates.length === 0
    ? "none"
    : value.flow.gates.map((gate) => `${gate.id} [${gate.mode}, ${gate.required ? "required" : "optional"}, ${gate.requiredCapability}]`).join(", ");
  return [
    `Workflow: ${plan.workflow}`,
    "Architecture: supervisor",
    plan.description ? `Purpose: ${plan.description}` : undefined,
    `Flow v${value.flow.version}: ${value.flow.stages.map((stage) => `${stage.title} [${stage.kind}]`).join(" -> ")}`,
    `Gates: ${gates}`,
    value.flow.dag
      ? `DAG: ${value.flow.dag.nodes.map((node) => `${node.nodeId} [${node.kind}, ${node.roleId}]`).join(", ")}`
      : undefined,
    `Management policy: ${value.policy.id} v${value.policy.version}`,
    `Supervisor role: ${value.supervisor.role} (capabilities: ${value.supervisor.capabilities.join(", ") || "none"})`,
    `Members: ${value.members.map((member) => `${member.roleId} (${member.role}; capabilities: ${member.capabilities.join(", ") || "none"})`).join(", ")}`,
    `Limits: ${value.policy.limits.maxRounds} rounds, ${value.policy.limits.maxDelegations} delegations, ${value.policy.limits.maxParallelDelegations} parallel`
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function mermaidId(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_]/g, "_");
}

function mermaidLabel(value: string): string {
  return value.replaceAll('"', "'");
}

function formatSupervisorMermaid(plan: ExecutionPlan): string {
  const value = planConfig(plan);
  const lines = ["flowchart LR"];
  for (const stage of value.flow.stages) {
    const nodeId = `stage_${mermaidId(stage.id)}`;
    const label = `${mermaidLabel(stage.title)}<br/>${stage.kind}`;
    lines.push(stage.kind === "gate" ? `  ${nodeId}{"${label}"}` : `  ${nodeId}["${label}"]`);
  }
  for (let index = 1; index < value.flow.stages.length; index += 1) {
    lines.push(`  stage_${mermaidId(value.flow.stages[index - 1]!.id)} --> stage_${mermaidId(value.flow.stages[index]!.id)}`);
  }
  const loop = value.flow.stages.find((stage) => stage.kind === "delegation-loop")!;
  for (const member of value.members) {
    const memberId = `member_${mermaidId(member.roleId)}`;
    lines.push(`  ${memberId}["${mermaidLabel(member.roleId)}<br/>${mermaidLabel(member.role)}"]`);
    lines.push(`  stage_${mermaidId(loop.id)} -. runtime delegation .-> ${memberId}`);
  }
  if (value.flow.dag) {
    for (const node of value.flow.dag.nodes) {
      const dagId = `dag_${mermaidId(node.nodeId)}`;
      lines.push(`  ${dagId}["${mermaidLabel(node.nodeId)}<br/>${mermaidLabel(node.kind)} · ${mermaidLabel(node.roleId)}"]`);
      if (node.needs.length === 0) lines.push(`  stage_${mermaidId(loop.id)} -. ready .-> ${dagId}`);
      for (const need of node.needs) lines.push(`  dag_${mermaidId(need)} --> ${dagId}`);
    }
  }
  return lines.join("\n");
}

function decision(value: JsonValue | undefined): SupervisorDecision | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, JsonValue>;
  if (candidate.action === "delegate" && Array.isArray(candidate.assignments)) return candidate as unknown as SupervisorDecision;
  if (
    candidate.action === "satisfy-gate"
    && typeof candidate.gateId === "string"
    && typeof candidate.summary === "string"
    && "evidence" in candidate
  ) {
    return candidate as unknown as SupervisorDecision;
  }
  if (candidate.action === "finish" && typeof candidate.summary === "string" && "result" in candidate) {
    return candidate as unknown as SupervisorDecision;
  }
  return undefined;
}

function output(
  reason: string | undefined,
  round: number,
  delegations: number,
  trackers: Map<string, GateTracker>,
  result?: { summary: string; result: JsonValue },
  dagTrackers?: Map<string, SupervisorDagNodeTracker>
): JsonObject {
  return {
    ...(reason ? { reason } : {}),
    ...(result ?? {}),
    rounds: round,
    delegations,
    gates: gateSnapshot(trackers, true),
    ...(dagTrackers ? { dag: supervisorDagSnapshot(dagTrackers) } : {})
  };
}

function blocked(
  reason: string,
  round: number,
  delegations: number,
  trackers: Map<string, GateTracker>,
  dagTrackers?: Map<string, SupervisorDagNodeTracker>
): ArchitectureExecutionResult {
  return { status: "blocked", output: output(reason, round, delegations, trackers, undefined, dagTrackers) };
}

function gateMatchesAssignment(gate: SupervisorGateConfig, assignment: SupervisorAssignment): boolean {
  if (gate.requiredCapability === "code.integration") return false;
  if (gate.requiredCapability === "quality.test" || gate.requiredCapability === "quality.audit") {
    return assignment.workKind === "code" || assignment.workKind === "integration";
  }
  if (gate.requiredCapability.startsWith("code.")) {
    return assignment.workKind === "code" || assignment.workKind === "integration";
  }
  return true;
}

function codeChangeSetRecords(records: DelegationRecord[]): DelegationRecord[] {
  const byChangeSet = new Map<string, DelegationRecord>();
  for (const record of records) {
    if (
      record.result.status === "passed"
      && record.assignment.workKind === "code"
      && typeof record.assignment.changeSet === "string"
      && record.assignment.changeSet.trim()
    ) {
      byChangeSet.set(record.assignment.changeSet.trim(), record);
    }
  }
  return [...byChangeSet.values()];
}

function trackerStatus(tracker: GateTracker): void {
  if (tracker.noExecutor) {
    tracker.status = "blocked";
  } else if (tracker.activations.size > 0 && tracker.passed.size === tracker.activations.size) {
    tracker.status = "passed";
    tracker.reason = undefined;
  } else {
    tracker.status = "pending";
  }
}

function resolveGateExecutor(
  value: SupervisorWorkflowConfig,
  gate: SupervisorGateConfig
): { roleId: string; role: string } | undefined {
  const member = value.members.find((candidate) => candidate.capabilities.includes(gate.requiredCapability));
  if (member) return { roleId: member.roleId, role: member.role };
  if (gate.fallback === "supervisor" && value.supervisor.capabilities.includes(gate.requiredCapability)) {
    return { roleId: "supervisor", role: value.supervisor.role };
  }
  return undefined;
}

function gateWorkKind(gate: SupervisorGateConfig): SupervisorWorkKind {
  if (gate.requiredCapability === "quality.test") return "test";
  if (gate.requiredCapability === "quality.audit") return "audit";
  if (gate.requiredCapability === "code.integration") return "integration";
  return "other";
}

async function executeGateActivation(
  context: ArchitectureExecutionContext,
  value: SupervisorWorkflowConfig,
  tracker: GateTracker,
  activation: GateActivation,
  round: number,
  parentNodeId: string,
  deadlineAt: number,
  sequence: number
): Promise<string | undefined> {
  tracker.activations.set(activation.key, activation);
  if (tracker.passed.has(activation.key)) return undefined;
  const executor = resolveGateExecutor(value, tracker.gate);
  if (!executor) {
    tracker.noExecutor = true;
    tracker.reason = `gate ${tracker.gate.id} requires capability ${tracker.gate.requiredCapability}, but no eligible member or supervisor fallback has it`;
    trackerStatus(tracker);
    await context.emit("gate.blocked", undefined, {
      gateId: tracker.gate.id,
      requiredCapability: tracker.gate.requiredCapability,
      reason: tracker.reason
    });
    await context.persist();
    return undefined;
  }
  const role = context.loaded.manifest.roles[executor.role];
  if (!role) throw new Error(`gate executor runtime role not found: ${executor.role}`);
  const node: ExecutionPlanNode = {
    id: `gate-${tracker.gate.id}-r${round}-${sequence}`,
    role: executor.role,
    provider: role.provider,
    needs: activation.sourceNodeIds,
    with: {
      __delegatedRoleId: executor.roleId,
      __delegatedTask: tracker.gate.instructions,
      __requiredCapabilities: [tracker.gate.requiredCapability],
      __workKind: gateWorkKind(tracker.gate),
      __changeSet: "",
      __delegatedContext: {},
      __supervisorSummary: `Execute required workflow Gate ${tracker.gate.id}.`,
      __gateExecution: {
        gateId: tracker.gate.id,
        requiredCapability: tracker.gate.requiredCapability,
        mode: tracker.gate.mode,
        required: tracker.gate.required,
        instructions: tracker.gate.instructions,
        activation: activation.key,
        sourceNodeIds: activation.sourceNodeIds
      },
      ...supervisorWith(value, round, [], gateSnapshot(new Map([[tracker.gate.id, tracker]])))
    },
    metadata: {
      kind: "gate",
      roleId: executor.roleId,
      round,
      parentNodeId,
      gateId: tracker.gate.id,
      requiredCapability: tracker.gate.requiredCapability,
      activation: activation.key
    }
  };
  // supervisorWith supplies a null default; Gate execution must win after the common context is assembled.
  node.with.__gateExecution = {
    gateId: tracker.gate.id,
    requiredCapability: tracker.gate.requiredCapability,
    mode: tracker.gate.mode,
    required: tracker.gate.required,
    instructions: tracker.gate.instructions,
    activation: activation.key,
    sourceNodeIds: activation.sourceNodeIds
  };
  await context.scheduleNode(node);
  const result = await context.executeNode(node, { dependencyFailure: "observe", deadlineAt });
  let passed = result.status === "passed";
  if (passed && executor.roleId === "supervisor") {
    const gateDecision = decision(result.output);
    passed = gateDecision?.action === "satisfy-gate" && gateDecision.gateId === tracker.gate.id;
  }
  tracker.executions.push({
    nodeId: node.id,
    executorRoleId: executor.roleId,
    executorRuntimeRole: executor.role,
    activation: activation.key,
    sourceNodeIds: activation.sourceNodeIds,
    status: passed ? "passed" : result.status,
    evidence: result.output ?? null,
    error: passed ? null : result.error ?? (executor.roleId === "supervisor" ? "supervisor fallback did not return satisfy-gate" : null)
  });
  if (passed) tracker.passed.add(activation.key);
  else tracker.reason = `gate ${tracker.gate.id} activation ${activation.key} has not passed`;
  trackerStatus(tracker);
  await context.emit(passed ? "gate.passed" : "gate.unsatisfied", node.id, {
    gateId: tracker.gate.id,
    activation: activation.key,
    executorRoleId: executor.roleId,
    status: result.status
  });
  await context.persist();
  return node.id;
}

async function runAfterDelegationGates(
  context: ArchitectureExecutionContext,
  value: SupervisorWorkflowConfig,
  trackers: Map<string, GateTracker>,
  completed: DelegationRecord[],
  allDelegations: DelegationRecord[],
  round: number,
  parentNodeId: string,
  deadlineAt: number,
  sequence: { value: number }
): Promise<string[]> {
  const nodeIds: string[] = [];
  for (const tracker of trackers.values()) {
    if (tracker.gate.mode !== "after-each-delegation") continue;
    if (tracker.gate.requiredCapability === "code.integration") {
      const changeSets = codeChangeSetRecords(allDelegations);
      if (changeSets.length < 2) continue;
      const key = `change-sets:${changeSets.map((record) => record.assignment.changeSet!).sort().join(",")}`;
      const nodeId = await executeGateActivation(
        context,
        value,
        tracker,
        { key, sourceNodeIds: changeSets.map((record) => record.worker.id) },
        round,
        parentNodeId,
        deadlineAt,
        ++sequence.value
      );
      if (nodeId) nodeIds.push(nodeId);
      continue;
    }
    for (const record of completed) {
      if (record.result.status !== "passed" || !gateMatchesAssignment(tracker.gate, record.assignment)) continue;
      const nodeId = await executeGateActivation(
        context,
        value,
        tracker,
        { key: `delegation:${record.worker.id}`, sourceNodeIds: [record.worker.id] },
        round,
        parentNodeId,
        deadlineAt,
        ++sequence.value
      );
      if (nodeId) nodeIds.push(nodeId);
    }
  }
  return nodeIds;
}

async function runCompletionGates(
  context: ArchitectureExecutionContext,
  value: SupervisorWorkflowConfig,
  trackers: Map<string, GateTracker>,
  delegations: DelegationRecord[],
  round: number,
  parentNodeId: string,
  deadlineAt: number,
  sequence: { value: number }
): Promise<string[]> {
  const nodeIds: string[] = [];
  const passedDelegations = delegations.filter((record) => record.result.status === "passed");
  for (const tracker of trackers.values()) {
    if (tracker.gate.mode === "after-each-delegation") {
      for (const activation of tracker.activations.values()) {
        if (tracker.passed.has(activation.key)) continue;
        const nodeId = await executeGateActivation(
          context, value, tracker, activation, round, parentNodeId, deadlineAt, ++sequence.value
        );
        if (nodeId) nodeIds.push(nodeId);
      }
      continue;
    }
    let activation: GateActivation | undefined;
    if (tracker.gate.requiredCapability === "code.integration") {
      const changeSets = codeChangeSetRecords(delegations);
      if (changeSets.length >= 2) {
        activation = {
          key: `completion-change-sets:${changeSets.map((record) => record.assignment.changeSet!).sort().join(",")}`,
          sourceNodeIds: changeSets.map((record) => record.worker.id)
        };
      }
    } else {
      const matching = passedDelegations.filter((record) => gateMatchesAssignment(tracker.gate, record.assignment));
      const capabilityHasWorkCondition = tracker.gate.requiredCapability === "quality.test"
        || tracker.gate.requiredCapability === "quality.audit"
        || tracker.gate.requiredCapability.startsWith("code.");
      if (matching.length > 0 || !capabilityHasWorkCondition) {
        activation = {
          key: matching.length > 0 ? `completion:${matching.map((record) => record.worker.id).join(",")}` : "completion",
          sourceNodeIds: matching.map((record) => record.worker.id)
        };
      }
    }
    if (!activation) continue;
    const nodeId = await executeGateActivation(
      context, value, tracker, activation, round, parentNodeId, deadlineAt, ++sequence.value
    );
    if (nodeId) nodeIds.push(nodeId);
  }
  return nodeIds;
}

function requiredGateIssues(trackers: Map<string, GateTracker>): GateTracker[] {
  return [...trackers.values()].filter(
    (tracker) => tracker.gate.required && tracker.activations.size > 0 && tracker.status !== "passed"
  );
}

async function executeSupervisor(context: ArchitectureExecutionContext): Promise<ArchitectureExecutionResult> {
  const value = planConfig(context.plan);
  const members = new Map(value.members.map((member) => [member.roleId, member]));
  const dagTrackers = value.flow.dag
    ? new Map(value.flow.dag.nodes.map((node): [string, SupervisorDagNodeTracker] => [node.nodeId, {
        node,
        status: "pending",
        executions: []
      }]))
    : undefined;
  const trackers = new Map<string, GateTracker>(value.flow.gates.map((gate): [string, GateTracker] => [gate.id, {
    gate,
    status: "pending",
    activations: new Map<string, GateActivation>(),
    passed: new Set<string>(),
    executions: [],
    noExecutor: false
  }]));
  const startedAt = Date.now();
  const history: JsonValue[] = [];
  const workerResults: Array<{ status: string }> = [];
  const delegationLedger: DelegationRecord[] = [];
  const gateSequence = { value: 0 };
  let round = 1;
  let delegationCount = 0;
  let latestNodeIds: string[] = [];
  const deadlineAt = startedAt + value.policy.limits.maxDurationMs;
  const durationExceeded = () => Date.now() >= deadlineAt;

  while (true) {
    if (durationExceeded()) {
      return blocked("management policy duration limit reached before convergence", round - 1, delegationCount, trackers, dagTrackers);
    }
    const node = round === 1
      ? context.plan.nodes[0]!
      : supervisorNode(value, round, latestNodeIds, history, gateSnapshot(trackers), dagTrackers);
    if (round === 1) node.with = supervisorWith(value, round, history, gateSnapshot(trackers), dagTrackers);
    const supervisorRole = context.loaded.manifest.roles[node.role];
    if (!supervisorRole) throw new Error(`supervisor runtime role not found: ${node.role}`);
    node.provider = supervisorRole.provider;
    await context.scheduleNode(node);
    const supervisorResult = await context.executeNode(node, {
      dependencyFailure: "observe",
      deadlineAt,
      retryValidation: true
    });
    if (durationExceeded()) {
      return blocked("management policy duration limit reached before convergence", round, delegationCount, trackers, dagTrackers);
    }
    if (supervisorResult.status === "failed" || supervisorResult.status === "skipped") {
      return {
        status: "failed",
        output: output(supervisorResult.error ?? "supervisor decision failed", round, delegationCount, trackers, undefined, dagTrackers)
      };
    }
    const next = decision(supervisorResult.output);
    if (!next) {
      return {
        status: "failed",
        output: output("supervisor returned an invalid decision", round, delegationCount, trackers, undefined, dagTrackers)
      };
    }

    if (next.action === "satisfy-gate") {
      const tracker = trackers.get(next.gateId);
      const executor = tracker ? resolveGateExecutor(value, tracker.gate) : undefined;
      const pending = tracker ? [...tracker.activations.values()].filter((activation) => !tracker.passed.has(activation.key)) : [];
      if (!tracker || executor?.roleId !== "supervisor" || pending.length === 0) {
        return {
          status: "failed",
          output: output(
            `supervisor cannot satisfy inactive or member-owned gate ${next.gateId}`,
            round,
            delegationCount,
            trackers,
            undefined,
            dagTrackers
          )
        };
      }
      for (const activation of pending) {
        tracker.passed.add(activation.key);
        tracker.executions.push({
          nodeId: node.id,
          executorRoleId: "supervisor",
          executorRuntimeRole: value.supervisor.role,
          activation: activation.key,
          sourceNodeIds: activation.sourceNodeIds,
          status: "passed",
          evidence: next.evidence,
          error: null
        });
      }
      trackerStatus(tracker);
      history.push({ round, supervisorNodeId: node.id, decision: next as unknown as JsonValue });
      if (round >= value.policy.limits.maxRounds) {
        return blocked("management policy round limit reached before convergence", round, delegationCount, trackers, dagTrackers);
      }
      latestNodeIds = [node.id];
      round += 1;
      continue;
    }

    if (next.action === "finish") {
      if (value.policy.completion.requireDelegation && delegationCount === 0) {
        return blocked(
          "management policy requires at least one delegation before completion",
          round,
          delegationCount,
          trackers,
          dagTrackers
        );
      }
      const requiredDagNodes = dagTrackers
        ? [...dagTrackers.values()].filter((tracker) => tracker.node.required && tracker.status !== "passed")
        : [];
      if (requiredDagNodes.length > 0) {
        return blocked(
          `supervisor cannot finish before required DAG nodes pass: ${requiredDagNodes.map((tracker) => `${tracker.node.nodeId} (${tracker.status})`).join(", ")}`,
          round,
          delegationCount,
          trackers,
          dagTrackers
        );
      }
      const unsuccessfulDelegation = dagTrackers
        ? [...dagTrackers.values()].some((tracker) => tracker.executions.length > 0 && tracker.status !== "passed")
        : workerResults.some((result) => result.status !== "passed");
      if (value.policy.completion.requireAllDelegationsSuccessful && unsuccessfulDelegation) {
        return blocked(
          "management policy requires every delegation to complete successfully",
          round,
          delegationCount,
          trackers,
          dagTrackers
        );
      }
      const gateNodeIds = await runCompletionGates(
        context, value, trackers, delegationLedger, round, node.id, deadlineAt, gateSequence
      );
      if (durationExceeded()) {
        return blocked("management policy duration limit reached before convergence", round, delegationCount, trackers, dagTrackers);
      }
      const unmet = requiredGateIssues(trackers);
      if (unmet.length > 0) {
        if (unmet.some((tracker) => tracker.noExecutor)) {
          return blocked(
            unmet.map((tracker) => tracker.reason).filter(Boolean).join("; "),
            round,
            delegationCount,
            trackers,
            dagTrackers
          );
        }
        if (round >= value.policy.limits.maxRounds) {
          for (const tracker of unmet) tracker.status = "blocked";
          return blocked(
            `required workflow Gates remain unsatisfied: ${unmet.map((tracker) => tracker.gate.id).join(", ")}`,
            round,
            delegationCount,
            trackers,
            dagTrackers
          );
        }
        history.push({
          round,
          supervisorNodeId: node.id,
          decision: next as unknown as JsonValue,
          finishIntercepted: true,
          gates: gateSnapshot(trackers)
        });
        latestNodeIds = gateNodeIds.length > 0 ? gateNodeIds : [node.id];
        round += 1;
        continue;
      }
      return {
        status: "passed",
        output: output(
          undefined,
          round,
          delegationCount,
          trackers,
          { summary: next.summary, result: next.result },
          dagTrackers
        )
      };
    }

    if (round >= value.policy.limits.maxRounds) {
      return blocked("management policy round limit reached before convergence", round, delegationCount, trackers, dagTrackers);
    }
    if (next.assignments.length === 0) {
      return {
        status: "failed",
        output: output("delegate decision contains no assignments", round, delegationCount, trackers, undefined, dagTrackers)
      };
    }
    if (next.assignments.length > value.policy.limits.maxParallelDelegations) {
      return blocked("management policy parallel delegation limit exceeded", round, delegationCount, trackers, dagTrackers);
    }
    if (delegationCount + next.assignments.length > value.policy.limits.maxDelegations) {
      return blocked("management policy delegation limit reached before convergence", round, delegationCount, trackers, dagTrackers);
    }

    if (!dagTrackers) {
      const repeated = next.assignments.find((assignment) => repeatedBlockedAssignment(assignment, delegationLedger));
      if (repeated) {
        const reason = `blocked assignment was repeated without new prerequisite evidence: ${repeated.roleId}`;
        history.push({
          round,
          supervisorNodeId: node.id,
          decision: next as unknown as JsonValue,
          decisionRejected: reason
        });
        await context.emit("supervisor.delegation.rejected", node.id, { reason });
        latestNodeIds = [node.id];
        round += 1;
        continue;
      }
    }

    const dagViolation = async (reason: string): Promise<ArchitectureExecutionResult> => {
      await context.emit("supervisor.dag.blocked", node.id, {
        reason,
        dag: supervisorDagSnapshot(dagTrackers)
      });
      await context.persist();
      return blocked(reason, round, delegationCount, trackers, dagTrackers);
    };
    const scheduled: Array<{ assignment: SupervisorAssignment; worker: ExecutionPlanNode }> = [];
    const scheduledDagNodes = new Set<string>();
    for (let index = 0; index < next.assignments.length; index += 1) {
      const assignment = next.assignments[index]!;
      const dagTracker = dagTrackers && typeof assignment.nodeId === "string"
        ? dagTrackers.get(assignment.nodeId)
        : undefined;
      if (dagTrackers) {
        if (typeof assignment.nodeId !== "string" || !assignment.nodeId.trim()) {
          return dagViolation("supervisor DAG delegation must specify nodeId");
        }
        if (!dagTracker) {
          return dagViolation(`supervisor delegated outside the declared DAG: ${assignment.nodeId}`);
        }
        if (scheduledDagNodes.has(assignment.nodeId)) {
          return dagViolation(`supervisor delegated DAG node ${assignment.nodeId} more than once in the same round`);
        }
        scheduledDagNodes.add(assignment.nodeId);
        if (dagTracker.status === "passed") {
          return dagViolation(`supervisor cannot delegate DAG node ${assignment.nodeId} because it already passed`);
        }
        if (assignment.roleId !== dagTracker.node.roleId) {
          return dagViolation(
            `supervisor delegated DAG node ${assignment.nodeId} to role ${assignment.roleId}; expected ${dagTracker.node.roleId}`
          );
        }
        const unmetNeeds = dagTracker.node.needs.filter((need) => dagTrackers.get(need)?.status !== "passed");
        if (unmetNeeds.length > 0) {
          return dagViolation(
            `supervisor delegated DAG node ${assignment.nodeId} before dependencies passed: ${unmetNeeds.map((need) => `${need} (${dagTrackers.get(need)?.status ?? "unknown"})`).join(", ")}`
          );
        }
      }
      const member = members.get(assignment.roleId);
      if (!member) {
        const reason = `supervisor delegated to unbound role ${assignment.roleId}`;
        return dagTrackers ? dagViolation(reason) : blocked(reason, round, delegationCount, trackers);
      }
      if (dagTracker && assignment.workKind !== undefined && assignment.workKind !== dagTracker.node.workKind) {
        return dagViolation(
          `supervisor delegated DAG node ${assignment.nodeId} with workKind ${assignment.workKind}; expected ${dagTracker.node.workKind}`
        );
      }
      if (dagTracker && assignment.changeSet !== undefined && assignment.changeSet !== dagTracker.node.changeSet) {
        return dagViolation(
          `supervisor delegated DAG node ${assignment.nodeId} with changeSet ${assignment.changeSet}; expected ${dagTracker.node.changeSet ?? "none"}`
        );
      }
      const requiredCapabilities = [...new Set([
        ...(dagTracker?.node.requiredCapabilities ?? []),
        ...(assignment.requiredCapabilities ?? [])
      ])];
      const missing = requiredCapabilities.filter((capability) => !member.capabilities.includes(capability));
      if (missing.length > 0) {
        return blocked(
          `supervisor member ${assignment.roleId} lacks required capabilities: ${missing.join(", ")}`,
          round,
          delegationCount,
          trackers,
          dagTrackers
        );
      }
      const role = context.loaded.manifest.roles[member.role];
      if (!role) throw new Error(`supervisor member runtime role not found: ${member.role}`);
      const delegatedTask = assignment.task?.trim() || dagTracker?.node.task;
      if (!delegatedTask) {
        return dagTrackers
          ? dagViolation(`supervisor DAG node ${assignment.nodeId} has no delegated task`)
          : { status: "failed", output: output("delegate assignment task is missing", round, delegationCount, trackers) };
      }
      const workKind = dagTracker?.node.workKind ?? assignment.workKind ?? "other";
      const changeSet = dagTracker?.node.changeSet ?? assignment.changeSet;
      const effectiveAssignment: SupervisorAssignment = {
        ...assignment,
        task: delegatedTask,
        requiredCapabilities,
        workKind,
        ...(changeSet ? { changeSet } : {})
      };
      const executionNumber = dagTracker ? dagTracker.executions.length + 1 : 1;
      const workerId = dagTracker
        ? executionNumber === 1 ? dagTracker.node.nodeId : `${dagTracker.node.nodeId}-retry-${executionNumber}`
        : `${member.roleId}-r${round}-${index + 1}`;
      const dependencyNodeIds = dagTracker
        ? dagTracker.node.needs.map((need) => dagTrackers!.get(need)!.passedExecutionNodeId!)
        : [];
      scheduled.push({
        assignment: effectiveAssignment,
        worker: {
          id: workerId,
          role: member.role,
          provider: role.provider,
          needs: [node.id, ...dependencyNodeIds],
          with: {
            __delegatedRoleId: member.roleId,
            __delegatedTask: delegatedTask,
            __requiredCapabilities: requiredCapabilities,
            __workKind: workKind,
            __changeSet: changeSet ?? "",
            __gateExecution: null,
            __delegatedContext: assignment.context ?? {},
            __supervisorSummary: next.summary ?? ""
          },
          metadata: {
            kind: "member",
            roleId: member.roleId,
            round,
            parentNodeId: node.id,
            workKind,
            changeSet: changeSet ?? "",
            requiredCapabilities,
            ...(dagTracker ? {
              flowNodeId: dagTracker.node.nodeId,
              flowNodeKind: dagTracker.node.kind,
              flowNodeRequired: dagTracker.node.required,
              flowNodeExecution: executionNumber
            } : {})
          }
        }
      });
    }
    for (const item of scheduled) await context.scheduleNode(item.worker);
    const completed = await Promise.all(scheduled.map(async ({ assignment, worker }): Promise<DelegationRecord> => ({
      assignment,
      worker,
      result: await context.executeNode(worker, { deadlineAt })
    })));
    if (dagTrackers) {
      for (const record of completed) {
        const tracker = record.assignment.nodeId ? dagTrackers.get(record.assignment.nodeId) : undefined;
        if (!tracker) continue;
        tracker.status = record.result.status;
        tracker.executions.push({
          nodeId: record.worker.id,
          status: record.result.status,
          output: record.result.output ?? null,
          error: record.result.error ?? null
        });
        if (record.result.status === "passed") tracker.passedExecutionNodeId = record.worker.id;
      }
      await context.emit("supervisor.dag.updated", node.id, { dag: supervisorDagSnapshot(dagTrackers) });
      await context.persist();
    }
    delegationCount += completed.length;
    delegationLedger.push(...completed);
    workerResults.push(...completed.map(({ result }) => ({ status: result.status })));
    history.push({
      round,
      supervisorNodeId: node.id,
      decision: next as unknown as JsonValue,
      delegations: completed.map(({ assignment, worker, result }) => ({
        nodeId: worker.id,
        flowNodeId: assignment.nodeId ?? null,
        roleId: assignment.roleId,
        task: assignment.task ?? null,
        requiredCapabilities: assignment.requiredCapabilities ?? [],
        workKind: assignment.workKind ?? "other",
        changeSet: assignment.changeSet ?? null,
        status: result.status,
        output: result.output ?? null,
        error: result.error ?? null
      }))
    });
    const gateNodeIds = await runAfterDelegationGates(
      context, value, trackers, completed, delegationLedger, round, node.id, deadlineAt, gateSequence
    );
    const missingGateExecutors = [...trackers.values()].filter((tracker) => tracker.gate.required && tracker.noExecutor);
    if (missingGateExecutors.length > 0) {
      return blocked(
        missingGateExecutors.map((tracker) => tracker.reason).filter(Boolean).join("; "),
        round,
        delegationCount,
        trackers,
        dagTrackers
      );
    }
    latestNodeIds = gateNodeIds.length > 0 ? gateNodeIds : completed.map(({ worker }) => worker.id);
    if (durationExceeded()) {
      return blocked("management policy duration limit reached before convergence", round, delegationCount, trackers, dagTrackers);
    }
    if (
      value.policy.failure.workerFailure === "fail-fast"
      && completed.some(({ result }) => result.status === "failed" || result.status === "skipped")
    ) {
      return {
        status: "failed",
        output: output(
          "a delegated worker failed under fail-fast policy",
          round,
          delegationCount,
          trackers,
          undefined,
          dagTrackers
        )
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
