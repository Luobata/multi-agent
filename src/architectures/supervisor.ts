import { Ajv, type ErrorObject } from "ajv";
import fs from "node:fs";
import path from "node:path";
import { ManifestValidationError } from "../core/errors.js";
import type {
  ExecutionPlan,
  ExecutionPlanNode,
  HumanDecisionRiskCategory,
  JsonObject,
  JsonValue,
  LoadedManifest,
  NodeRunResult
} from "../core/types.js";
import type {
  ArchitectureAdapter,
  ArchitectureExecutionContext,
  ArchitectureExecutionResult,
  ArchitectureValidationContext
} from "./types.js";
import {
  normalizeSupervisorDagConfig,
  supervisorDagCandidateEvidenceNodeIds,
  supervisorDagDependencyMatches,
  supervisorDagHasFreshCandidateEvidence,
  supervisorDagHasFreshDependencyEvidence,
  supervisorDagIssues,
  supervisorDagNodeReady,
  supervisorDagSnapshot,
  supervisorDagTrackerReady,
  type SupervisorDagConfig,
  type SupervisorDagNodeTracker
} from "./supervisorDag.js";
import { resolveGateValidator } from "./gateValidators.js";
import {
  artifactDigest,
  gateCandidateIdentity,
  preflightGateCandidate,
  recordEnvironmentFailure,
  reconcileRuntimeImpact,
  reusableGateShard,
  normalizeValidationGroups,
  supportedRequiredChecks,
  type EnvironmentCircuitState,
  type GateShardEvidence,
  type RuntimeImpactManifest
} from "../runtime/gateGovernance.js";

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
    maxDurationMs?: number;
  };
  failure: {
    workerFailure: "observe-and-replan" | "fail-fast";
  };
  completion: {
    requireDelegation: boolean;
    requireAllDelegationsSuccessful: boolean;
  };
  execution?: {
    isolation?: "worktree" | "none";
  };
}

interface SupervisorGateConfig {
  id: string;
  requiredCapability: string;
  mode: "after-each-delegation" | "before-completion";
  required: boolean;
  instructions: string;
  fallback: "supervisor" | "block";
  validatorId?: string;
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
  employeeId?: string;
  principalId?: string;
  description: string;
  capabilities: string[];
  /** Bounded profile signals the supervisor uses to judge fit — not hard gates. */
  responsibilities?: string[];
  skillSummaries?: string[];
}

interface SupervisorWorkflowConfig {
  supervisor: {
    role: string;
    employeeId?: string;
    principalId?: string;
    capabilities: string[];
    skillInjection?: { id: string; version: number; reason: string };
  };
  policy: SupervisorPolicyConfig;
  members: SupervisorTeamMemberConfig[];
  flow: SupervisorFlowConfig;
  effectivePolicyPack?: JsonObject;
  separationOfDuties?: {
    producerRoleIds: string[];
    approverRoleIds: string[];
    mustDifferEmployee?: boolean;
    sameSessionForbidden?: boolean;
    independentEvidenceRequired?: boolean;
  };
}

interface SupervisorAssignment {
  nodeId?: string;
  todoId?: string;
  roleId: string;
  task?: string;
  requiredCapabilities?: string[];
  workKind?: SupervisorWorkKind;
  changeSet?: string;
  context?: JsonObject;
}

type RegressionRiskLevel = "low" | "medium" | "high";
type RegressionScope = "none" | "targeted" | "package" | "full";

interface SupervisorImpactAssessment {
  level: RegressionRiskLevel;
  regressionScope: RegressionScope;
  affectedAreas: string[];
  reasons: string[];
  requiredChecks: string[];
  /** Optional semantic grouping proposed by the leader; the runtime validates exact coverage. */
  validationGroups?: SupervisorValidationGroup[];
}

interface SupervisorValidationGroup {
  id: string;
  requiredChecks: string[];
  /** Optional exact file coverage. Cross-revision cache inheritance is disabled when absent. */
  impactedFiles?: string[];
}

interface SupervisorTodo {
  id: string;
  roleId: string;
  task: string;
  needs: string[];
  needsWhen?: import("./supervisorDag.js").SupervisorDagNeedCondition[];
  workKind: SupervisorWorkKind;
  changeSet?: string;
  sessionKey?: string;
  requiredCapabilities?: string[];
  context?: JsonObject;
}

export function supervisorHumanDecisionPlanIssues(
  assignments: ReadonlyArray<Pick<SupervisorAssignment, "todoId" | "roleId" | "workKind">>,
  dagTrackers: ReadonlyMap<string, SupervisorDagNodeTracker>
): string[] {
  return assignments.flatMap((assignment) => {
    const todoId = assignment.todoId;
    if (typeof todoId !== "string" || !todoId.trim()) {
      return ["human-decision assignment for an active dynamic plan must specify todoId"];
    }
    const tracker = dagTrackers.get(todoId);
    if (!tracker) return [`human-decision assignment references todoId ${todoId} outside the active TODO plan`];
    const issues: string[] = [];
    if (assignment.roleId !== tracker.node.roleId) {
      issues.push(`human-decision assignment for todoId ${todoId} uses role ${assignment.roleId}; expected ${tracker.node.roleId}`);
    }
    if (assignment.workKind !== undefined && assignment.workKind !== tracker.node.workKind) {
      issues.push(`human-decision assignment for todoId ${todoId} uses workKind ${assignment.workKind}; expected ${tracker.node.workKind}`);
    }
    return issues;
  });
}

interface MemberSessionTurn {
  todoId: string;
  nodeId: string;
  task: string;
  status: NodeRunResult["status"];
  output: JsonValue;
  error: string | null;
  /** Best-effort handoff notes the member left for its next delegation; null when none were written. */
  handoff: string | null;
  /** True when the attempt completed without a handoff file (missing or empty). Recorded for observability; never blocks the Run by itself. */
  handoffMissing?: boolean;
}

interface MemberSessionState {
  id: string;
  key: string;
  roleId: string;
  changeSet?: string;
  status: "open" | "closed";
  turns: MemberSessionTurn[];
}

type SupervisorDecision =
  | {
      action: "plan-todos";
      summary: string;
      impact: SupervisorImpactAssessment;
      todos: SupervisorTodo[];
    }
  | {
      action: "delegate";
      summary?: string;
      impact?: SupervisorImpactAssessment;
      assignments: SupervisorAssignment[];
    }
  | {
      action: "satisfy-gate";
      gateId: string;
      summary: string;
      evidence: JsonValue;
    }
  | {
      action: "request-human-decision";
      riskCategory: HumanDecisionRiskCategory;
      summary: string;
      impact?: SupervisorImpactAssessment;
      assignments: SupervisorAssignment[];
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

function technicalCircuitReason(
  assignment: SupervisorAssignment,
  ledger: DelegationRecord[]
): string | undefined {
  const failures = ledger.filter((record) => (
    record.assignment.roleId === assignment.roleId
    && record.result.status === "failed"
  ));
  const latest = failures.at(-1);
  if (!latest?.result.failure) return undefined;
  const failure = latest.result.failure;
  const providerKind = failure.category === "provider" ? failure.kind : undefined;

  // A budget or startup failure cannot be repaired by reissuing the same assignment. Stop after
  // the first occurrence so the caller can change budget/runtime configuration deliberately.
  if (providerKind === "budget" || providerKind === "start") {
    return `technical circuit opened for ${assignment.roleId}: ${latest.result.error ?? providerKind}`;
  }

  const matching = failures.filter((record) => (
    record.result.failure?.category === failure.category
    && record.result.failure?.kind === failure.kind
  ));
  if (matching.length < 2) return undefined;
  const latestFailureRound = typeof latest.worker.metadata?.round === "number" ? latest.worker.metadata.round : 0;
  const recovered = ledger.some((record) => (
    record.assignment.roleId === assignment.roleId
    && record.result.status === "passed"
    && typeof record.worker.metadata?.round === "number"
    && record.worker.metadata.round >= latestFailureRound
  ));
  return recovered
    ? undefined
    : `technical circuit opened for ${assignment.roleId} after ${matching.length} repeated ${failure.kind ?? failure.category} failures: ${latest.result.error ?? "no diagnostic detail"}`;
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
        employeeId: { type: "string", minLength: 1 },
        principalId: { type: "string", minLength: 1 },
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
          required: ["maxRounds", "maxDelegations", "maxParallelDelegations"],
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
        },
        execution: {
          type: "object",
          additionalProperties: false,
          properties: {
            isolation: { enum: ["worktree", "none"] }
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
          employeeId: { type: "string", minLength: 1 },
          principalId: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          capabilities: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
          responsibilities: { type: "array", items: { type: "string", minLength: 1 } },
          skillSummaries: { type: "array", items: { type: "string", minLength: 1 } }
        }
      }
    },
    effectivePolicyPack: { type: "object" },
    separationOfDuties: {
      type: "object",
      additionalProperties: false,
      required: ["producerRoleIds", "approverRoleIds"],
      properties: {
        producerRoleIds: { type: "array", uniqueItems: true, items: { type: "string" } },
        approverRoleIds: { type: "array", uniqueItems: true, items: { type: "string" } },
        mustDifferEmployee: { type: "boolean" },
        sameSessionForbidden: { type: "boolean" },
        independentEvidenceRequired: { type: "boolean" }
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
              fallback: { enum: ["supervisor", "block"] },
              validatorId: { type: "string", minLength: 1 }
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
                  needsWhen: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["nodeId", "statuses"],
                      properties: {
                        nodeId: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
                        statuses: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["passed", "blocked", "failed", "skipped", "terminal"] } }
                      }
                    }
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

function strictWorktreeFlowIssues(workflowId: string, value: SupervisorWorkflowConfig): string[] {
  if ((value.effectivePolicyPack as { ref?: { id?: string } } | undefined)?.ref?.id !== "software-delivery") return [];
  if (value.policy.execution?.isolation !== "worktree") return [];
  const issues: string[] = [];
  const qualityTest = value.flow.gates.find((gate) => (
    gate.requiredCapability === "quality.test"
    && gate.mode === "before-completion"
    && gate.required
    && gate.validatorId !== "none"
  ));
  if (!qualityTest) {
    issues.push(
      `workflow ${workflowId} uses worktree isolation and requires a before-completion required quality.test gate with real e2e validation`
    );
  }
  const qualityAudit = value.flow.gates.find((gate) => (
    gate.requiredCapability === "quality.audit"
    && gate.mode === "before-completion"
    && gate.required
    && gate.fallback === "block"
  ));
  if (!qualityAudit) {
    issues.push(
      `workflow ${workflowId} uses worktree isolation and requires a before-completion required quality.audit gate with fallback=block`
    );
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
  const sod = value.separationOfDuties;
  if (sod?.mustDifferEmployee) {
    const producers = value.members.filter((member) => sod.producerRoleIds.includes(member.roleId));
    const approvers = value.members.filter((member) => sod.approverRoleIds.includes(member.roleId));
    const hasIndependentPair = producers.some((producer) => approvers.some((approver) => (
      producer.employeeId && approver.employeeId && producer.employeeId !== approver.employeeId
    )));
    if (!hasIndependentPair) {
      issues.push(`workflow ${context.workflowId} staffing-gap/preparation: separation of duties requires a different producer and approver Employee`);
    }
  }
  if (value.policy.limits.maxParallelDelegations > value.policy.limits.maxDelegations) {
    issues.push(`workflow ${context.workflowId} maxParallelDelegations cannot exceed maxDelegations`);
  }
  issues.push(...flowIssues(context.workflowId, value.flow));
  issues.push(...strictWorktreeFlowIssues(context.workflowId, value));
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
    __supervisorTeam: value.members.map(({ roleId, employeeId, principalId, description, capabilities, responsibilities, skillSummaries }) => ({
      roleId,
      employeeId: employeeId ?? null,
      principalId: principalId ?? employeeId ?? null,
      description,
      capabilities,
      ...(responsibilities && responsibilities.length ? { responsibilities } : {}),
      ...(skillSummaries && skillSummaries.length ? { skillSummaries } : {})
    })),
    __supervisorCapabilities: value.supervisor.capabilities,
    __effectivePolicyPack: value.effectivePolicyPack ?? null,
    __separationOfDuties: value.separationOfDuties ?? null,
    __supervisorGates: gates,
    ...(dagTrackers ? { __supervisorDag: supervisorDagSnapshot(dagTrackers) } : {}),
    __gateExecution: null,
    __supervisorHistory: history,
    __previousAttemptError: ""
  };
}

/**
 * Deterministic server-side compaction for the supervisor history injected into each prompt.
 * The last `keepRounds` rounds stay verbatim; older entries collapse to one deterministic line
 * each (action → target → status). Entries carrying human decisions, Gate decisions, or Gate
 * snapshots stay verbatim regardless of age: supervisor replanning depends on their exact text.
 * Persisted history is never mutated — compaction only transforms the injected view.
 */
const DEFAULT_SUPERVISOR_HISTORY_KEEP_ROUNDS = 6;
const HISTORY_SUMMARY_TEXT_LIMIT = 160;

function supervisorHistoryKeepRounds(context: ArchitectureExecutionContext): number {
  const configured = context.supervisorHistoryKeepRounds;
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_SUPERVISOR_HISTORY_KEEP_ROUNDS;
}

function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function historySummaryText(value: unknown, limit = HISTORY_SUMMARY_TEXT_LIMIT): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const collapsed = text.replace(/\s+/g, " ");
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** Deterministic one-line summary for an aged-out history entry: action → target → status. */
function summarizeHistoryEntry(entry: JsonObject): string {
  const round = typeof entry.round === "number" ? entry.round : 0;
  const decision = asJsonObject(entry.decision as JsonValue | undefined) ?? {};
  const action = typeof decision.action === "string" ? decision.action : "unknown";
  const parts = [`[r${round}] ${action}`];
  if (action === "delegate" && Array.isArray(decision.assignments)) {
    const roles = decision.assignments
      .map((assignment) => asJsonObject(assignment as JsonValue)?.roleId)
      .filter((roleId): roleId is string => typeof roleId === "string")
      .join(",");
    parts.push(`roles=[${roles}]`);
  } else if (action === "satisfy-gate" && typeof decision.gateId === "string") {
    parts.push(`gate=${decision.gateId}`);
  } else if (action === "request-human-decision") {
    parts.push(`risk=${typeof decision.riskCategory === "string" ? decision.riskCategory : "?"}`);
  } else if (action === "plan-todos" && Array.isArray(decision.todos)) {
    parts.push(`todos=${decision.todos.length}`);
  } else if (action === "finish" && typeof decision.summary === "string") {
    parts.push(`summary=${historySummaryText(decision.summary)}`);
  }
  if (typeof entry.decisionRejected === "string") {
    parts.push(`rejected=${historySummaryText(entry.decisionRejected)}`);
  }
  if (entry.humanDecision !== undefined) {
    const human = asJsonObject(entry.humanDecision as JsonValue);
    parts.push(`human=${human && typeof human.decision === "string" ? human.decision : "?"}`);
  }
  if (Array.isArray(entry.delegations)) {
    const statuses = entry.delegations
      .map((delegation) => asJsonObject(delegation as JsonValue)?.status)
      .filter((status): status is string => typeof status === "string")
      .join(",");
    parts.push(`statuses=[${statuses}]`);
  }
  if (entry.todoPlanAccepted === true) parts.push("accepted");
  if (entry.finishIntercepted === true) parts.push("finish-intercepted");
  return parts.join(" → ");
}

/** Entries whose exact text is decision-critical and must never be compressed. */
function historyEntryVerbatim(entry: JsonObject): boolean {
  if (entry.humanDecision !== undefined) return true;
  if (entry.gates !== undefined) return true;
  return asJsonObject(entry.decision as JsonValue | undefined)?.action === "satisfy-gate";
}

export interface CompactedSupervisorHistory {
  entries: JsonValue[];
  keepRounds: number;
  compactedRounds: number;
  compactedEntries: number;
  charsSaved: number;
}

export function compactSupervisorHistory(history: JsonValue[], currentRound: number, keepRounds: number): CompactedSupervisorHistory {
  const verbatimRound = currentRound - keepRounds;
  const beforeChars = JSON.stringify(history).length;
  const compactedRounds = new Set<number>();
  let compactedEntries = 0;
  const entries = history.map((entry) => {
    const record = asJsonObject(entry);
    if (!record) return entry;
    const round = typeof record.round === "number" ? record.round : 0;
    if (round > verbatimRound || historyEntryVerbatim(record)) return entry;
    compactedEntries += 1;
    compactedRounds.add(round);
    return summarizeHistoryEntry(record);
  });
  return {
    entries,
    keepRounds,
    compactedRounds: compactedRounds.size,
    compactedEntries,
    charsSaved: beforeChars - JSON.stringify(entries).length
  };
}

function updateSupervisorRunState(
  context: ArchitectureExecutionContext,
  value: SupervisorWorkflowConfig,
  round: number,
  delegations: number,
  history: JsonValue[],
  trackers: Map<string, GateTracker>,
  dagTrackers: Map<string, SupervisorDagNodeTracker> | undefined,
  impact: SupervisorImpactAssessment | undefined,
  planRevision: number
): void {
  const previousSequence = typeof context.run.architectureState?.sequence === "number"
    ? context.run.architectureState.sequence
    : 0;
  context.run.architectureState = {
    schemaVersion: 1,
    kind: "supervisor",
    sequence: previousSequence + 1,
    round,
    delegations,
    planRevision,
    scheduling: {
      mode: "iterative",
      schedulerVersion: 1,
      compiledDispatchEnabled: false,
      shadowReadyNodeIds: dagTrackers
        ? [...dagTrackers.values()]
            .filter((tracker) => supervisorDagTrackerReady(tracker, dagTrackers))
            .map((tracker) => tracker.node.nodeId)
        : []
    },
    limits: { ...value.policy.limits },
    dag: supervisorDagSnapshot(dagTrackers),
    gates: gateSnapshot(trackers),
    impact: impact ? impact as unknown as JsonValue : null,
    history: history.map((entry) => structuredClone(entry))
  };
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function supervisorResumeState(input: {
  round: number;
  delegations: number;
  planRevision: number;
  latestNodeIds: string[];
  deadlineAt?: number;
  history: JsonValue[];
  dynamicTodos?: Map<string, SupervisorTodo>;
  dagTrackers?: Map<string, SupervisorDagNodeTracker>;
  gateTrackers: Map<string, GateTracker>;
  memberSessions: Map<string, MemberSessionState>;
  delegationLedger: DelegationRecord[];
  gateSequence: number;
  impact?: SupervisorImpactAssessment;
}): JsonObject {
  return jsonObject({
    schemaVersion: 1,
    round: input.round,
    delegations: input.delegations,
    planRevision: input.planRevision,
    latestNodeIds: input.latestNodeIds,
    remainingDurationMs: input.deadlineAt === undefined ? null : Math.max(0, input.deadlineAt - Date.now()),
    history: input.history,
    dynamicTodos: input.dynamicTodos ? [...input.dynamicTodos.values()] : null,
    dagTrackers: input.dagTrackers ? [...input.dagTrackers.values()].map((tracker) => ({
      nodeId: tracker.node.nodeId,
      status: tracker.status,
      executions: tracker.executions,
      passedExecutionNodeId: tracker.passedExecutionNodeId ?? null
    })) : null,
    gates: [...input.gateTrackers.values()].map((tracker) => ({
      gateId: tracker.gate.id,
      status: tracker.status,
      activations: [...tracker.activations.values()],
      passed: [...tracker.passed],
      executions: tracker.executions,
      reason: tracker.reason ?? null,
      noExecutor: tracker.noExecutor
    })),
    memberSessions: [...input.memberSessions.values()],
    delegationLedger: input.delegationLedger,
    gateSequence: input.gateSequence,
    impact: input.impact ?? null
  });
}

function recordValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : undefined;
}

function restoreSupervisorResumeState(input: {
  resume: JsonObject | undefined;
  context: ArchitectureExecutionContext;
  value: SupervisorWorkflowConfig;
  members: ReadonlyMap<string, SupervisorTeamMemberConfig>;
  gateTrackers: Map<string, GateTracker>;
}): {
  round: number;
  delegations: number;
  planRevision: number;
  latestNodeIds: string[];
  deadlineAt?: number;
  history: JsonValue[];
  dynamicTodos?: Map<string, SupervisorTodo>;
  dagTrackers?: Map<string, SupervisorDagNodeTracker>;
  memberSessions: MemberSessionState[];
  delegationLedger: DelegationRecord[];
  gateSequence: number;
  impact?: SupervisorImpactAssessment;
} | undefined {
  const resume = input.resume;
  if (!resume) return undefined;
  if (resume.schemaVersion !== 1) {
    throw new Error(`unsupported durable Supervisor resume schema: ${String(resume.schemaVersion)}`);
  }
  const round = resume.round;
  const delegations = resume.delegations;
  const planRevision = resume.planRevision;
  const latestNodeIds = stringArray(resume.latestNodeIds);
  const history = Array.isArray(resume.history) ? structuredClone(resume.history) : undefined;
  if (!Number.isInteger(round) || Number(round) < 1
    || !Number.isInteger(delegations) || Number(delegations) < 0
    || !Number.isInteger(planRevision) || Number(planRevision) < 0
    || !latestNodeIds || !history) {
    throw new Error("durable Supervisor resume state has invalid counters, dependencies, or history");
  }
  const impactValue = resume.impact === null ? undefined : recordValue(resume.impact);
  const impact = impactValue as unknown as SupervisorImpactAssessment | undefined;
  const hasStaticDag = Boolean(input.value.flow.dag);
  let dynamicTodos: Map<string, SupervisorTodo> | undefined;
  let dagConfig = input.value.flow.dag;
  if (!hasStaticDag && resume.dynamicTodos !== null) {
    if (!Array.isArray(resume.dynamicTodos) || !impact) {
      throw new Error("durable Supervisor resume state has an invalid dynamic TODO plan");
    }
    const parsed = decision({
      action: "plan-todos",
      summary: "durable Supervisor resume",
      impact: impactValue!,
      todos: resume.dynamicTodos
    });
    if (!parsed || parsed.action !== "plan-todos") {
      throw new Error("durable Supervisor resume state failed dynamic TODO schema validation");
    }
    const issues = dynamicTodoPlanIssues(
      input.context.plan.workflow,
      parsed.todos,
      input.members,
      input.value.policy.limits.maxDelegations,
      parsed.impact
    );
    if (issues.length > 0) throw new Error(`durable Supervisor resume plan is invalid: ${issues.join("; ")}`);
    dynamicTodos = new Map(parsed.todos.map((todo) => [todo.id, todo]));
    dagConfig = todoDag(parsed.todos);
  }
  let dagTrackers: Map<string, SupervisorDagNodeTracker> | undefined;
  if (dagConfig) {
    if (!Array.isArray(resume.dagTrackers)) {
      throw new Error("durable Supervisor resume state is missing DAG trackers");
    }
    const saved = new Map<string, JsonObject>();
    for (const raw of resume.dagTrackers) {
      const entry = recordValue(raw);
      if (!entry || typeof entry.nodeId !== "string" || saved.has(entry.nodeId)) {
        throw new Error("durable Supervisor resume state has an invalid or duplicate DAG tracker");
      }
      saved.set(entry.nodeId, entry);
    }
    if (saved.size !== dagConfig.nodes.length || dagConfig.nodes.some((node) => !saved.has(node.nodeId))) {
      throw new Error("durable Supervisor resume DAG does not match the pinned plan");
    }
    dagTrackers = new Map(dagConfig.nodes.map((node): [string, SupervisorDagNodeTracker] => {
      const entry = saved.get(node.nodeId)!;
      const status = entry.status;
      if (typeof status !== "string" || !["pending", "running", "passed", "blocked", "failed", "skipped"].includes(status)) {
        throw new Error(`durable Supervisor resume node ${node.nodeId} has invalid status ${String(status)}`);
      }
      const executions = Array.isArray(entry.executions)
        ? entry.executions as unknown as SupervisorDagNodeTracker["executions"]
        : undefined;
      if (!executions) throw new Error(`durable Supervisor resume node ${node.nodeId} has invalid executions`);
      return [node.nodeId, {
        node,
        // A crashed process cannot still own running work. Replaying the same safe round lets the
        // Runner either reuse a durable terminal result or retry the interrupted node.
        status: status === "running" ? "pending" : status as SupervisorDagNodeTracker["status"],
        executions: structuredClone(executions),
        ...(typeof entry.passedExecutionNodeId === "string"
          ? { passedExecutionNodeId: entry.passedExecutionNodeId }
          : {})
      }];
    }));
  } else if (resume.dagTrackers !== null) {
    throw new Error("durable Supervisor resume state contains a DAG without a pinned plan");
  }
  if (!Array.isArray(resume.gates)) throw new Error("durable Supervisor resume state has invalid Gates");
  const savedGates = new Map<string, JsonObject>();
  for (const raw of resume.gates) {
    const entry = recordValue(raw);
    if (!entry || typeof entry.gateId !== "string" || savedGates.has(entry.gateId)) {
      throw new Error("durable Supervisor resume state has an invalid or duplicate Gate");
    }
    savedGates.set(entry.gateId, entry);
  }
  if (savedGates.size !== input.gateTrackers.size) {
    throw new Error("durable Supervisor resume Gates do not match the pinned plan");
  }
  for (const tracker of input.gateTrackers.values()) {
    const entry = savedGates.get(tracker.gate.id);
    if (!entry || typeof entry.status !== "string" || !["pending", "passed", "blocked", "skipped"].includes(entry.status)) {
      throw new Error(`durable Supervisor resume Gate ${tracker.gate.id} is invalid`);
    }
    tracker.status = entry.status as GateRunStatus;
    tracker.activations.clear();
    if (!Array.isArray(entry.activations)) throw new Error(`durable Supervisor resume Gate ${tracker.gate.id} has invalid activations`);
    for (const rawActivation of entry.activations) {
      const activation = recordValue(rawActivation);
      const sourceNodeIds = activation ? stringArray(activation.sourceNodeIds) : undefined;
      if (!activation || typeof activation.key !== "string" || !sourceNodeIds) {
        throw new Error(`durable Supervisor resume Gate ${tracker.gate.id} has an invalid activation`);
      }
      tracker.activations.set(activation.key, { key: activation.key, sourceNodeIds });
    }
    const passed = stringArray(entry.passed);
    if (!passed || passed.some((key) => !tracker.activations.has(key))) {
      throw new Error(`durable Supervisor resume Gate ${tracker.gate.id} has invalid passed activations`);
    }
    tracker.passed = new Set(passed);
    if (!Array.isArray(entry.executions)) throw new Error(`durable Supervisor resume Gate ${tracker.gate.id} has invalid executions`);
    tracker.executions = structuredClone(entry.executions) as unknown as GateExecutionRecord[];
    tracker.reason = typeof entry.reason === "string" ? entry.reason : undefined;
    tracker.noExecutor = entry.noExecutor === true;
  }
  const memberSessions = Array.isArray(resume.memberSessions)
    ? resume.memberSessions.map((raw) => recordValue(raw) as unknown as MemberSessionState)
    : undefined;
  if (!memberSessions || memberSessions.some((session) => !session || typeof session.key !== "string" || !Array.isArray(session.turns))) {
    throw new Error("durable Supervisor resume state has invalid member Sessions");
  }
  const delegationLedger = Array.isArray(resume.delegationLedger)
    ? structuredClone(resume.delegationLedger) as unknown as DelegationRecord[]
    : undefined;
  if (!delegationLedger || delegationLedger.some((record) => (
    !record || typeof record.assignment?.roleId !== "string" || typeof record.worker?.id !== "string"
    || typeof record.result?.status !== "string"
    || !input.context.plan.nodes.some((node) => node.id === record.worker.id)
  ))) {
    throw new Error("durable Supervisor resume state has an invalid delegation ledger");
  }
  const gateSequence = resume.gateSequence;
  if (!Number.isInteger(gateSequence) || Number(gateSequence) < 0) {
    throw new Error("durable Supervisor resume state has an invalid Gate sequence");
  }
  const remainingDurationMs = resume.remainingDurationMs === null ? undefined : resume.remainingDurationMs;
  if (remainingDurationMs !== undefined
    && (typeof remainingDurationMs !== "number" || !Number.isFinite(remainingDurationMs) || remainingDurationMs < 0)) {
    throw new Error("durable Supervisor resume state has an invalid remaining duration");
  }
  return {
    round: Number(round),
    delegations: Number(delegations),
    planRevision: Number(planRevision),
    latestNodeIds,
    deadlineAt: remainingDurationMs === undefined ? undefined : Date.now() + remainingDurationMs,
    history,
    dynamicTodos,
    dagTrackers,
    memberSessions,
    delegationLedger,
    gateSequence: Number(gateSequence),
    ...(impact ? { impact } : {})
  };
}

function approvedCandidateUrl(input: JsonObject, decision?: { candidateUrl?: string; comment?: string }): string | undefined {
  const explicit = typeof input.candidateUrl === "string" ? input.candidateUrl.trim() : "";
  if (explicit) return explicit;
  if (decision?.candidateUrl?.trim()) return decision.candidateUrl.trim();
  const urls = decision?.comment?.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  if (urls.length === 1) return urls[0]!.replace(/[),.;]+$/, "");
  return undefined;
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
    metadata: {
      kind: "supervisor", roleId: "supervisor", round,
      employeeId: value.supervisor.employeeId ?? "",
      principalId: value.supervisor.principalId ?? value.supervisor.employeeId ?? "",
      workInstanceId: `supervisor-r${round}`
    }
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
  if (
    candidate.action === "plan-todos"
    && typeof candidate.summary === "string"
    && typeof candidate.impact === "object"
    && candidate.impact !== null
    && !Array.isArray(candidate.impact)
    && Array.isArray(candidate.todos)
  ) {
    return candidate as unknown as SupervisorDecision;
  }
  if (candidate.action === "delegate" && Array.isArray(candidate.assignments)) return candidate as unknown as SupervisorDecision;
  if (
    candidate.action === "request-human-decision"
    && typeof candidate.riskCategory === "string"
    && typeof candidate.summary === "string"
    && Array.isArray(candidate.assignments)
  ) {
    return candidate as unknown as SupervisorDecision;
  }
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

function todoNodeKind(workKind: SupervisorWorkKind): import("./supervisorDag.js").SupervisorDagNodeKind {
  if (workKind === "test") return "test";
  if (workKind === "audit") return "review";
  if (workKind === "integration") return "integration";
  return "task";
}

function todoDag(todos: SupervisorTodo[]): SupervisorDagConfig {
  return {
    nodes: todos.map((todo) => ({
      nodeId: todo.id,
      roleId: todo.roleId,
      needs: [...todo.needs],
      ...(todo.needsWhen ? { needsWhen: todo.needsWhen.map((condition) => ({ nodeId: condition.nodeId, statuses: [...condition.statuses] })) } : {}),
      kind: todoNodeKind(todo.workKind),
      task: todo.task,
      requiredCapabilities: [...(todo.requiredCapabilities ?? [])],
      workKind: todo.workKind,
      ...(todo.changeSet ? { changeSet: todo.changeSet } : {}),
      required: true
    }))
  };
}

function dynamicTodoPlanIssues(
  workflowId: string,
  todos: SupervisorTodo[],
  members: ReadonlyMap<string, SupervisorTeamMemberConfig>,
  maxDelegations: number,
  impact: SupervisorImpactAssessment
): string[] {
  const issues = supervisorDagIssues(workflowId, todoDag(todos), new Set(members.keys()));
  if (todos.length < 2) issues.push("dynamic TODO plan must contain at least two bounded items");
  if (todos.length > maxDelegations) {
    issues.push(`dynamic TODO plan has ${todos.length} items but the policy allows only ${maxDelegations} delegations`);
  }
  const sessions = new Map<string, SupervisorTodo[]>();
  for (const todo of todos) {
    if (!todo.sessionKey) continue;
    const prior = sessions.get(todo.sessionKey) ?? [];
    const first = prior[0];
    if (first && (first.roleId !== todo.roleId || (first.changeSet ?? "") !== (todo.changeSet ?? ""))) {
      issues.push(`member session ${todo.sessionKey} must keep one roleId and changeSet`);
    }
    const previous = prior.at(-1);
    if (previous && !todo.needs.includes(previous.id)) {
      issues.push(`TODO ${todo.id} must directly depend on prior member-session TODO ${previous.id}`);
    }
    prior.push(todo);
    sessions.set(todo.sessionKey, prior);
  }
  issues.push(...supervisorValidationShardIssues(impact, todos));
  return issues;
}

/**
 * A single validation TODO is a useful bounded unit for targeted work, but it becomes a
 * pathological long-lived Work Instance once a package/full assessment already names four or
 * more independent checks. The orchestration prompt asks the leader to shard that work; this
 * guard makes the contract fail closed when the provider ignores it. Plans with no explicit test
 * TODO remain valid because configured quality Gates may own all downstream validation.
 */
export function supervisorValidationShardIssues(
  impact: SupervisorImpactAssessment,
  todos: SupervisorTodo[]
): string[] {
  const testTodos = todos.filter((todo) => todo.workKind === "test");
  const broadValidation = impact.regressionScope === "package" || impact.regressionScope === "full";
  if (!broadValidation || impact.requiredChecks.length < 4 || testTodos.length !== 1) return [];
  return [
    `oversized validation has ${impact.requiredChecks.length} required checks at ${impact.regressionScope} scope; split the single test TODO into dependency-aware validation groups sized from the actual check list, or omit explicit test TODOs and let configured quality Gates validate the recorded scope`
  ];
}

function validLeaderValidationGroups(impact: SupervisorImpactAssessment): SupervisorValidationGroup[] | undefined {
  const groups = impact.validationGroups;
  if (!groups || groups.length < 2 || groups.some((group) => group.requiredChecks.length === 0)) return undefined;
  const required = new Set(impact.requiredChecks);
  const grouped = groups.flatMap((group) => group.requiredChecks);
  if (grouped.length !== required.size || new Set(grouped).size !== grouped.length) return undefined;
  if (grouped.some((check) => !required.has(check))) return undefined;
  return groups.map((group) => ({
    id: group.id,
    requiredChecks: [...group.requiredChecks],
    ...(group.impactedFiles?.length ? { impactedFiles: [...group.impactedFiles] } : {})
  }));
}

/**
 * Prefer semantic test domains from the leader when they cover every required check exactly once.
 * Otherwise derive as many bounded shards as the checklist needs. There is deliberately no fixed
 * shard-count ceiling: ten checks become five two-check shards, one hundred become fifty.
 */
export function supervisorValidationCheckGroups(impact: SupervisorImpactAssessment): SupervisorValidationGroup[] {
  const leaderGroups = validLeaderValidationGroups(impact);
  if (leaderGroups) return leaderGroups;
  const checks = [...new Set(impact.requiredChecks)];
  const broadValidation = impact.regressionScope === "package" || impact.regressionScope === "full";
  if (!broadValidation || checks.length < 4) {
    return checks.length > 0 ? [{ id: "all", requiredChecks: checks }] : [];
  }
  const targetChecksPerShard = 2;
  return Array.from({ length: Math.ceil(checks.length / targetChecksPerShard) }, (_, index) => ({
    id: `auto-${index + 1}`,
    requiredChecks: checks.slice(index * targetChecksPerShard, (index + 1) * targetChecksPerShard)
  }));
}

function memberSessionSnapshot(session: MemberSessionState | undefined): JsonValue {
  if (!session) return null;
  return {
    id: session.id,
    key: session.key,
    roleId: session.roleId,
    changeSet: session.changeSet ?? null,
    status: session.status,
    turns: session.turns.map((turn) => ({ ...turn }))
  };
}

const MEMBER_HANDOFF_MAX_CHARS = 8000;

function memberHandoffPath(context: ArchitectureExecutionContext, sessionKey: string): string {
  const sanitized = sessionKey.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return path.join(context.executionRoot(), ".multi-agent", "handoff", `${sanitized}.md`);
}

function latestMemberHandoff(session: MemberSessionState | undefined): string {
  return session?.turns.at(-1)?.handoff ?? "";
}

/** Best-effort read of a member's handoff file; a missing or unreadable file yields null and never fails the Run. */
async function readMemberHandoff(context: ArchitectureExecutionContext, sessionKey: string): Promise<string | null> {
  try {
    const content = await fs.promises.readFile(memberHandoffPath(context, sessionKey), "utf8");
    if (content.length > MEMBER_HANDOFF_MAX_CHARS) {
      return `${content.slice(0, MEMBER_HANDOFF_MAX_CHARS)}\n…[truncated]`;
    }
    return content;
  } catch {
    return null;
  }
}

interface MemberHandoffInspection {
  content: string | null;
  /** True when no handoff was left: the file is absent, empty, or unreadable. */
  missing: boolean;
  /** Raw byte size of the handoff file (0 when absent). */
  bytes: number;
}

/** Best-effort handoff inspection: existence, byte count, and truncated content. Never fails the Run. */
async function inspectMemberHandoff(context: ArchitectureExecutionContext, sessionKey: string): Promise<MemberHandoffInspection> {
  try {
    const stats = await fs.promises.stat(memberHandoffPath(context, sessionKey));
    if (!stats.isFile() || stats.size === 0) return { content: null, missing: true, bytes: 0 };
    const content = await readMemberHandoff(context, sessionKey);
    return { content, missing: content === null, bytes: stats.size };
  } catch {
    return { content: null, missing: true, bytes: 0 };
  }
}

/**
 * Opt-in hard gate (default off): a sessionKey delegation attempt that leaves no handoff file is
 * treated as incomplete (blocked) and rides the existing worker-failure machinery. Enabled via the
 * run execution config (ArchitectureExecutionContext.requireMemberHandoff) or the
 * MULTI_AGENT_REQUIRE_MEMBER_HANDOFF environment switch for daemon-launched Runs.
 */
function memberHandoffGateEnforced(context: ArchitectureExecutionContext): boolean {
  if (context.requireMemberHandoff === true) return true;
  const env = process.env.MULTI_AGENT_REQUIRE_MEMBER_HANDOFF?.trim().toLowerCase();
  return env === "1" || env === "true";
}

function handoffMissingError(sessionKey: string): string {
  return `member handoff required by execution config was not written for session ${sessionKey}`;
}

const REGRESSION_LEVEL_ORDER: Record<RegressionRiskLevel, number> = { low: 0, medium: 1, high: 2 };
const REGRESSION_SCOPE_ORDER: Record<RegressionScope, number> = { none: 0, targeted: 1, package: 2, full: 3 };

function mergeRegressionImpacts(impacts: SupervisorImpactAssessment[]): SupervisorImpactAssessment | undefined {
  if (impacts.length === 0) return undefined;
  const highestLevel = impacts.reduce((current, impact) => (
    REGRESSION_LEVEL_ORDER[impact.level] > REGRESSION_LEVEL_ORDER[current] ? impact.level : current
  ), impacts[0]!.level);
  const widestScope = impacts.reduce((current, impact) => (
    REGRESSION_SCOPE_ORDER[impact.regressionScope] > REGRESSION_SCOPE_ORDER[current]
      ? impact.regressionScope
      : current
  ), impacts[0]!.regressionScope);
  const requiredChecks = [...new Set(impacts.flatMap((impact) => impact.requiredChecks))];
  const validationGroups = impacts
    .map((impact) => impact.validationGroups)
    .find((groups) => groups && groups.flatMap((group) => group.requiredChecks).length === requiredChecks.length
      && new Set(groups.flatMap((group) => group.requiredChecks)).size === requiredChecks.length
      && requiredChecks.every((check) => groups.some((group) => group.requiredChecks.includes(check))));
  return {
    level: highestLevel,
    regressionScope: widestScope,
    affectedAreas: [...new Set(impacts.flatMap((impact) => impact.affectedAreas))],
    reasons: [...new Set(impacts.flatMap((impact) => impact.reasons))],
    requiredChecks,
    ...(validationGroups ? { validationGroups } : {})
  };
}

function sourceRegressionImpact(context: ArchitectureExecutionContext, sourceNodeIds: string[]): SupervisorImpactAssessment | undefined {
  const impacts = sourceNodeIds.flatMap((sourceNodeId) => {
    const source = context.plan.nodes.find((candidate) => candidate.id === sourceNodeId);
    const impact = source?.with.__regressionImpact;
    return impact && typeof impact === "object" && !Array.isArray(impact)
      ? [impact as unknown as SupervisorImpactAssessment]
      : [];
  });
  return mergeRegressionImpacts(impacts);
}

function scopedGateInstructions(instructions: string, impact: SupervisorImpactAssessment | undefined): string {
  if (!impact) return instructions;
  const scopeRule = impact.regressionScope === "full"
    ? "Full regression is justified by the recorded impact assessment."
    : impact.regressionScope === "package"
      ? "Run affected-package regression plus the listed checks; do not widen to repository-wide regression without new contradictory evidence."
      : impact.regressionScope === "targeted"
        ? "Run only changed-path and directly related regression checks; do not run package-wide or repository-wide suites without new contradictory evidence."
        : "Do not repeat automated regression; validate only the explicit no-regression rationale and required checks.";
  return [
    instructions,
    "",
    "Runtime regression-impact assessment:",
    JSON.stringify(impact),
    scopeRule,
    "If observed evidence requires a wider scope, stop and return the concrete reason to the leader instead of silently expanding the workload."
  ].join("\n");
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
  gate: SupervisorGateConfig,
  excludedRuntimeRoles: ReadonlySet<string> = new Set()
): { roleId: string; role: string } | undefined {
  if (value.policy.execution?.isolation === "worktree" && gate.requiredCapability === "quality.audit") {
    const independentAuditor = value.members.find((candidate) => (
      candidate.capabilities.includes("quality.audit")
      && !excludedRuntimeRoles.has(candidate.role)
    ));
    return independentAuditor
      ? { roleId: independentAuditor.roleId, role: independentAuditor.role }
      : undefined;
  }
  // Prefer a member that explicitly advertises the Gate capability. The fallback is a control-flow
  // contract, not a hint: "supervisor" delegates the check to the leader, while "block" must fail
  // closed when no capable member exists. Routing a blocking Gate to an arbitrary member would make
  // the persisted policy and the Run evidence disagree about who was qualified to validate the work.
  const hinted = value.members.find((candidate) => candidate.capabilities.includes(gate.requiredCapability));
  if (hinted) return { roleId: hinted.roleId, role: hinted.role };
  if (gate.fallback === "supervisor") {
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
  deadlineAt: number | undefined,
  sequence: number,
  upstreamEvidenceNodeIds: string[] = []
): Promise<string[]> {
  tracker.activations.set(activation.key, activation);
  if (tracker.passed.has(activation.key)) return [];
  const sourceRuntimeRoles = new Set(
    activation.sourceNodeIds.flatMap((sourceNodeId) => {
      const source = context.plan.nodes.find((candidate) => candidate.id === sourceNodeId);
      return source ? [source.role] : [];
    })
  );
  const strictAudit = value.policy.execution?.isolation === "worktree"
    && tracker.gate.requiredCapability === "quality.audit";
  const executor = strictAudit && activation.sourceNodeIds.length === 0
    ? undefined
    : resolveGateExecutor(value, tracker.gate, sourceRuntimeRoles);
  if (!executor) {
    tracker.noExecutor = true;
    tracker.reason = strictAudit
      ? activation.sourceNodeIds.length === 0
        ? `gate ${tracker.gate.id} requires an independent quality.audit executor, but no code or integration source node is available to audit`
        : `gate ${tracker.gate.id} requires an independent quality.audit member whose runtime role differs from every reviewed code or integration source; no eligible auditor is available`
      : `gate ${tracker.gate.id} requires capability ${tracker.gate.requiredCapability}, but no eligible member or supervisor fallback has it`;
    tracker.executions.push({
      nodeId: `gate-${tracker.gate.id}-blocked-r${round}-${sequence}`,
      executorRoleId: "none",
      executorRuntimeRole: "none",
      activation: activation.key,
      sourceNodeIds: activation.sourceNodeIds,
      status: "blocked",
      evidence: {
        reason: tracker.reason,
        excludedRuntimeRoles: [...sourceRuntimeRoles]
      },
      error: tracker.reason
    });
    trackerStatus(tracker);
    await context.emit("gate.blocked", undefined, {
      gateId: tracker.gate.id,
      requiredCapability: tracker.gate.requiredCapability,
      reason: tracker.reason
    });
    await context.persist();
    return [];
  }
  const role = context.loaded.manifest.roles[executor.role];
  if (!role) throw new Error(`gate executor runtime role not found: ${executor.role}`);
  const declaredRegressionImpact = sourceRegressionImpact(context, activation.sourceNodeIds);
  const candidateUrl = approvedCandidateUrl(context.input);
  const declaredCandidateRevision = typeof context.input.candidateRevision === "string" ? context.input.candidateRevision.trim() : "";
  let workspaceCandidate: Awaited<ReturnType<ArchitectureExecutionContext["candidateSnapshot"]>> | undefined;
  let candidateSnapshotError: string | undefined;
  try {
    workspaceCandidate = await context.candidateSnapshot();
  } catch (error) {
    candidateSnapshotError = error instanceof Error ? error.message : String(error);
  }
  const candidateRevision = declaredCandidateRevision || workspaceCandidate?.revision || context.run.isolation?.baseCommit || activation.key;
  const candidateIdentity = gateCandidateIdentity({
    candidateRevision,
    sourceNodeIds: activation.sourceNodeIds,
    changeSet: activation.key,
    candidateUrl: candidateUrl ?? ""
  });
  type GovernanceArtifact = {
    version: 1;
    preflights: Record<string, Awaited<ReturnType<typeof preflightGateCandidate>>>;
    circuits: Record<string, EnvironmentCircuitState>;
    shards: GateShardEvidence[];
    impactManifests?: Record<string, RuntimeImpactManifest>;
    events: JsonValue[];
  };
  const governance = await context.readArtifact<GovernanceArtifact>("gate-governance.json") ?? {
    version: 1, preflights: {}, circuits: {}, shards: [], events: []
  };
  const runtimeImpact = reconcileRuntimeImpact({
    ...(declaredRegressionImpact ? { declared: declaredRegressionImpact } : {}),
    changedFiles: workspaceCandidate?.changedFiles ?? [],
    snapshotAvailable: Boolean(workspaceCandidate),
    packageScripts: await context.executionPackageScripts()
  });
  const regressionImpact = runtimeImpact.impact as SupervisorImpactAssessment | undefined;
  governance.impactManifests ??= {};
  governance.impactManifests[candidateIdentity] = runtimeImpact.manifest;
  governance.events.push({
    type: "impact.reconciled",
    gateId: tracker.gate.id,
    candidateIdentity,
    manifest: runtimeImpact.manifest as unknown as JsonValue
  });
  await context.writeArtifact("gate-governance.json", governance);
  await context.emit("supervisor.impact.reconciled", undefined, {
    gateId: tracker.gate.id,
    candidateIdentity,
    manifest: runtimeImpact.manifest as unknown as JsonValue
  });
  const versionedCandidateFlow = context.run.isolation?.mode === "worktree" || Boolean(declaredCandidateRevision);
  const browserGate = Boolean(candidateUrl && versionedCandidateFlow)
    && (tracker.gate.requiredCapability === "quality.test" || tracker.gate.requiredCapability === "quality.audit");
  if (browserGate && !declaredCandidateRevision && !workspaceCandidate) {
    tracker.reason = `candidate preflight blocked: execution worktree revision is unavailable${candidateSnapshotError ? ` (${candidateSnapshotError})` : ""}`;
    governance.events.push({ type: "gate.preflight.blocked", gateId: tracker.gate.id, candidateIdentity, reason: tracker.reason });
    await context.writeArtifact("gate-governance.json", governance);
    await context.emit("gate.preflight.blocked", undefined, { gateId: tracker.gate.id, candidateIdentity, reason: tracker.reason });
    trackerStatus(tracker);
    await context.persist();
    return [];
  }
  const circuitKey = `${candidateIdentity}:MIDSCENE_ENVIRONMENT_BLOCKED`;
  if (browserGate && governance.circuits[circuitKey]?.opened) {
    tracker.reason = `browser environment circuit is open for candidate ${candidateRevision}; repeated Gate execution was suppressed`;
    governance.events.push({ type: "gate.circuit.short-circuited", gateId: tracker.gate.id, candidateIdentity });
    await context.writeArtifact("gate-governance.json", governance);
    await context.emit("gate.circuit.short-circuited", undefined, { gateId: tracker.gate.id, candidateIdentity });
    trackerStatus(tracker);
    await context.persist();
    return [];
  }
  if (browserGate && !governance.preflights[candidateIdentity]) {
    const preflight = await preflightGateCandidate({
      candidateUrl: candidateUrl!,
      candidateRevision,
      probe: async (url) => {
        try {
          const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5_000) });
          return {
            reachable: response.ok,
            revision: response.headers.get("x-multi-agent-candidate-revision") ?? undefined,
            reason: response.ok ? undefined : `candidate returned HTTP ${response.status}`
          };
        } catch (error) {
          return { reachable: false, reason: error instanceof Error ? error.message : String(error) };
        }
      }
    });
    governance.preflights[candidateIdentity] = preflight;
    governance.events.push({ type: preflight.status === "passed" ? "gate.preflight.passed" : "gate.preflight.blocked", gateId: tracker.gate.id, candidateIdentity });
    await context.writeArtifact("gate-governance.json", governance);
    await context.emit(preflight.status === "passed" ? "gate.preflight.passed" : "gate.preflight.blocked", undefined, {
      gateId: tracker.gate.id, candidateIdentity, checks: preflight.checks
    });
    if (preflight.status === "blocked") {
      tracker.reason = `candidate preflight blocked: ${preflight.checks.filter((check) => check.status === "blocked").map((check) => check.reason).join("; ")}`;
      trackerStatus(tracker);
      await context.persist();
      return [];
    }
  } else if (browserGate && governance.preflights[candidateIdentity]?.status === "blocked") {
    tracker.reason = "candidate preflight remains blocked";
    trackerStatus(tracker);
    return [];
  }
  const baseGateTask = [
    scopedGateInstructions(tracker.gate.instructions, regressionImpact),
    ...(candidateUrl ? [
      "",
      `Approved candidate URL: ${candidateUrl}`,
      "This candidate URL overrides every default or main-dashboard URL. For browser validation, connect/open this exact address directly with Midscene; do not probe it with shell commands and do not fall back to another origin."
    ] : []),
    ...(tracker.gate.requiredCapability === "quality.audit" && upstreamEvidenceNodeIds.length > 0
      ? [
          "",
          "Upstream quality Gate evidence is attached in `needs`.",
          "Audit the requirement, candidate diff, test scope, and recorded evidence. Do not repeat browser or automated regression that already passed against the same candidate unless you identify a concrete uncovered risk; run only the smallest targeted check needed to resolve that risk."
        ]
      : [])
  ].join("\n");
  const evidenceNeeds = [...new Set([...activation.sourceNodeIds, ...upstreamEvidenceNodeIds])];
  const validationGroups = (tracker.gate.requiredCapability === "quality.test"
    || tracker.gate.requiredCapability === "quality.audit") && regressionImpact
    ? supervisorValidationCheckGroups(regressionImpact)
    : [];
  const executionGroups = validationGroups.length > 1 ? validationGroups : [{ id: "all", requiredChecks: [] }];
  const gateMemberSession: MemberSessionState | undefined = executionGroups.length > 1
    ? {
        id: `member-session-gate-${tracker.gate.id}-r${round}-${sequence}`,
        key: `gate-${tracker.gate.id}-r${round}-${sequence}`,
        roleId: executor.roleId,
        status: "open",
        turns: []
      }
    : undefined;
  const nodes = executionGroups.map((group, index): ExecutionPlanNode => {
    const shard = executionGroups.length > 1
      ? { id: group.id, index: index + 1, total: executionGroups.length, requiredChecks: group.requiredChecks }
      : undefined;
    const gateTask = shard
      ? [
          baseGateTask,
          "",
          `Quality Gate shard ${shard.index}/${shard.total}. Execute only these checks:`,
          ...shard.requiredChecks.map((check) => `- ${check}`),
          "Do not execute checks assigned to another shard; return this shard's own reproducible evidence."
        ].join("\n")
      : baseGateTask;
    const node: ExecutionPlanNode = {
      id: `gate-${tracker.gate.id}-r${round}-${sequence}${shard ? `-s${shard.index}` : ""}`,
      role: executor.role,
      provider: role.provider,
      needs: evidenceNeeds,
      with: {
        __delegatedRoleId: executor.roleId,
        __todoId: "",
        __delegatedTask: gateTask,
        // Filled immediately before this serial shard executes so it includes every prior turn.
        __memberSession: gateMemberSession ? memberSessionSnapshot(gateMemberSession) : null,
        __memberSessionHandoffPath: gateMemberSession ? memberHandoffPath(context, gateMemberSession.key) : "",
        __memberSessionHandoff: latestMemberHandoff(gateMemberSession),
        __requiredCapabilities: [tracker.gate.requiredCapability],
        __workKind: gateWorkKind(tracker.gate),
        __changeSet: "",
        __regressionImpact: regressionImpact ? regressionImpact as unknown as JsonValue : null,
        __delegatedContext: {
          ...(candidateUrl ? { candidateUrl, candidateUrlSource: "workflow-input-or-human-approval" } : {}),
          ...(regressionImpact ? { regressionImpact: regressionImpact as unknown as JsonValue } : {}),
          ...(upstreamEvidenceNodeIds.length > 0 ? { upstreamGateEvidenceNodeIds: upstreamEvidenceNodeIds } : {}),
          ...(shard ? { gateShard: shard } : {})
        },
        __supervisorSummary: `Execute required workflow Gate ${tracker.gate.id}.`,
        ...supervisorWith(value, round, [], gateSnapshot(new Map([[tracker.gate.id, tracker]])))
      },
      metadata: {
        kind: "gate",
        roleId: executor.roleId,
        round,
        parentNodeId,
        gateId: tracker.gate.id,
        requiredCapability: tracker.gate.requiredCapability,
        activation: activation.key,
        ...(shard ? { gateShardIndex: shard.index, gateShardTotal: shard.total } : {}),
        ...(gateMemberSession ? {
          todoId: group.id,
          memberSessionId: gateMemberSession.id,
          memberSessionKey: gateMemberSession.key,
          memberSessionRetained: index < executionGroups.length - 1
        } : {})
      }
    };
    // supervisorWith supplies a null default; Gate execution must win after common context assembly.
    node.with.__gateExecution = {
      gateId: tracker.gate.id,
      requiredCapability: tracker.gate.requiredCapability,
      mode: tracker.gate.mode,
      required: tracker.gate.required,
      instructions: tracker.gate.instructions,
      regressionImpact: regressionImpact ? regressionImpact as unknown as JsonValue : null,
      activation: activation.key,
      sourceNodeIds: activation.sourceNodeIds,
      upstreamEvidenceNodeIds,
      ...(candidateUrl ? { candidateUrl, candidateUrlSource: "workflow-input-or-human-approval" } : {}),
      ...(shard ? { shard } : {})
    };
    return node;
  });
  // Deliberately advance broad validation one bounded shard at a time. This avoids turning one
  // package-wide request into a provider/resource burst and leaves an individual durable node
  // checkpoint after every completed shard. The same logical member Session is retained between
  // shards, so the tester receives the prior bounded evidence instead of being recreated cold.
  const results: Array<{ node: ExecutionPlanNode; result: NodeRunResult }> = [];
  // Charge only an activation that is about to execute. Fast-path replays and
  // missing-executor blocks above do not consume Provider-side Gate quota.
  let gateCharged = false;
  let circuitOpened = false;
  let reusedShardCount = 0;
  for (const [index, node] of nodes.entries()) {
    const group = executionGroups[index]!;
    const cached = governance.shards.find((evidence) => reusableGateShard(evidence, {
      candidateIdentity, candidateRevision, gateId: tracker.gate.id, shardId: group.id,
      checks: group.requiredChecks, changedFiles: workspaceCandidate?.changedFiles ?? []
    }));
    if (cached) {
      const inherited = cached.candidateIdentity !== candidateIdentity;
      const reused = inherited ? { ...cached, candidateIdentity, candidateRevision, inheritedFromCandidateIdentity: cached.candidateIdentity } : cached;
      if (inherited) governance.shards.push(reused);
      governance.events.push({ type: "gate.shard.reused", gateId: tracker.gate.id, shardId: group.id, candidateIdentity,
        ...(inherited ? { inheritedFromCandidateIdentity: cached.candidateIdentity } : {}) });
      await context.writeArtifact("gate-governance.json", governance);
      await context.emit("gate.shard.reused", undefined, { gateId: tracker.gate.id, shardId: group.id, candidateIdentity });
      tracker.executions.push({ nodeId: cached.artifactPath, executorRoleId: executor.roleId, executorRuntimeRole: executor.role,
        activation: activation.key, sourceNodeIds: activation.sourceNodeIds, status: "passed", evidence: cached as unknown as JsonValue, error: null });
      reusedShardCount += 1;
      continue;
    }
    if (!gateCharged) {
      context.budget?.reserve("gates").commit();
      gateCharged = true;
    }
    if (gateMemberSession) {
      node.with.__memberSession = memberSessionSnapshot(gateMemberSession);
      node.with.__memberSessionHandoffPath = memberHandoffPath(context, gateMemberSession.key);
      node.with.__memberSessionHandoff = latestMemberHandoff(gateMemberSession);
      await context.emit(index === 0 ? "supervisor.member-session.opened" : "supervisor.member-session.continued", node.id, {
        memberSessionId: gateMemberSession.id,
        sessionKey: gateMemberSession.key,
        roleId: gateMemberSession.roleId,
        todoId: executionGroups[index]!.id,
        priorTurns: gateMemberSession.turns.length,
        handoff: Boolean(latestMemberHandoff(gateMemberSession))
      });
    }
    await context.scheduleNode(node);
    const result = await context.executeNode(node, { dependencyFailure: "observe", deadlineAt });
    const serialized = JSON.stringify(result.output ?? result.error ?? null);
    if (serialized.includes("MIDSCENE_ENVIRONMENT_BLOCKED")) {
      const circuit = recordEnvironmentFailure(governance.circuits[circuitKey], {
        candidateRevision, candidateUrl: candidateUrl ?? "", errorClass: "MIDSCENE_ENVIRONMENT_BLOCKED",
        reason: result.error ?? "structured Gate evidence classified the browser environment as blocked"
      });
      governance.circuits[circuitKey] = circuit;
      governance.events.push({ type: circuit.opened ? "gate.circuit.opened" : "gate.circuit.recovery-allowed", gateId: tracker.gate.id, shardId: group.id, candidateIdentity });
      await context.writeArtifact("gate-governance.json", governance);
      await context.emit(circuit.opened ? "gate.circuit.opened" : "gate.circuit.recovery-allowed", node.id, { gateId: tracker.gate.id, candidateIdentity, failures: circuit.failures });
      if (circuit.opened) {
        circuitOpened = true;
        break;
      }
    }
    let effectiveResult = result;
    if (gateMemberSession) {
      const handoff = await inspectMemberHandoff(context, gateMemberSession.key);
      if (handoff.missing) {
        await context.emit("supervisor.member-session.handoff-missing", node.id, {
          memberSessionId: gateMemberSession.id,
          sessionKey: gateMemberSession.key,
          todoId: executionGroups[index]!.id,
          bytes: handoff.bytes
        });
        if (memberHandoffGateEnforced(context)) {
          effectiveResult = {
            ...result,
            status: "blocked" as const,
            error: handoffMissingError(gateMemberSession.key)
          };
        }
      }
      gateMemberSession.turns.push({
        todoId: executionGroups[index]!.id,
        nodeId: node.id,
        task: String(node.with.__delegatedTask ?? ""),
        status: effectiveResult.status,
        output: effectiveResult.output ?? null,
        error: effectiveResult.error ?? null,
        handoff: handoff.content,
        ...(handoff.missing ? { handoffMissing: true } : {})
      });
      if (index === nodes.length - 1) {
        gateMemberSession.status = "closed";
        await context.emit("supervisor.member-session.closed", node.id, {
          memberSessionId: gateMemberSession.id,
          sessionKey: gateMemberSession.key,
          turns: gateMemberSession.turns.length,
          finalStatus: effectiveResult.status
        });
      }
    }
    results.push({ node, result: effectiveResult });
  }
  let activationPassed = !circuitOpened && results.length + reusedShardCount === nodes.length;
  const errors: string[] = [];
  for (const { node, result } of results) {
    const gateDecision = executor.roleId === "supervisor" ? decision(result.output) : undefined;
    const semanticEvidence = executor.roleId === "supervisor" && gateDecision?.action === "satisfy-gate"
      ? gateDecision.evidence
      : result.output ?? null;
    let passed = result.status === "passed";
    if (passed && executor.roleId === "supervisor") {
      passed = gateDecision?.action === "satisfy-gate" && gateDecision.gateId === tracker.gate.id;
    }
    let validatorReason: string | undefined;
    if (passed) {
      const validator = resolveGateValidator(tracker.gate);
      if (validator) {
        const verdict = validator(tracker.gate, semanticEvidence);
        if (!verdict.passed) { passed = false; validatorReason = verdict.reason; }
      }
    }
    const error = passed
      ? null
      : validatorReason ?? result.error ?? (executor.roleId === "supervisor" ? "supervisor fallback did not return satisfy-gate" : null);
    if (!passed) {
      activationPassed = false;
      if (error) errors.push(error);
    }
    tracker.executions.push({
      nodeId: node.id,
      executorRoleId: executor.roleId,
      executorRuntimeRole: executor.role,
      activation: activation.key,
      sourceNodeIds: activation.sourceNodeIds,
      status: passed ? "passed" : result.status === "passed" ? "blocked" : result.status,
      evidence: semanticEvidence,
      error
    });
    if (passed) {
      const group = executionGroups[nodes.indexOf(node)]!;
      const evidence: GateShardEvidence = {
        candidateIdentity, candidateRevision, gateId: tracker.gate.id, shardId: group.id,
        checks: group.requiredChecks, impactedFiles: group.impactedFiles ?? [], status: "passed",
        artifactPath: `nodes/${node.id}`, artifactDigest: artifactDigest(semanticEvidence), sourceNodeIds: activation.sourceNodeIds
      };
      governance.shards = governance.shards.filter((item) => !(item.candidateIdentity === candidateIdentity && item.gateId === tracker.gate.id && item.shardId === group.id));
      governance.shards.push(evidence);
      await context.writeArtifact("gate-governance.json", governance);
    }
    if (nodes.length > 1) {
      await context.emit(passed ? "gate.shard.passed" : "gate.shard.unsatisfied", node.id, {
        gateId: tracker.gate.id,
        activation: activation.key,
        executorRoleId: executor.roleId,
        status: result.status
      });
    }
  }
  if (activationPassed) tracker.passed.add(activation.key);
  else tracker.reason = errors.join("; ") || `gate ${tracker.gate.id} activation ${activation.key} has not passed`;
  trackerStatus(tracker);
  await context.emit(activationPassed ? "gate.passed" : "gate.unsatisfied", nodes.at(-1)?.id, {
    gateId: tracker.gate.id,
    activation: activation.key,
    executorRoleId: executor.roleId,
    status: activationPassed ? "passed" : "blocked",
    shards: nodes.length
  });
  await context.persist();
  return nodes.map((node) => node.id);
}

async function runAfterDelegationGates(
  context: ArchitectureExecutionContext,
  value: SupervisorWorkflowConfig,
  trackers: Map<string, GateTracker>,
  completed: DelegationRecord[],
  allDelegations: DelegationRecord[],
  round: number,
  parentNodeId: string,
  deadlineAt: number | undefined,
  sequence: { value: number }
): Promise<string[]> {
  const nodeIds: string[] = [];
  for (const tracker of trackers.values()) {
    if (tracker.gate.mode !== "after-each-delegation") continue;
    if (tracker.gate.requiredCapability === "code.integration") {
      const changeSets = codeChangeSetRecords(allDelegations);
      if (changeSets.length < 2) continue;
      const key = `change-sets:${changeSets.map((record) => record.assignment.changeSet!).sort().join(",")}`;
      const executedNodeIds = await executeGateActivation(
        context,
        value,
        tracker,
        { key, sourceNodeIds: changeSets.map((record) => record.worker.id) },
        round,
        parentNodeId,
        deadlineAt,
        ++sequence.value
      );
      nodeIds.push(...executedNodeIds);
      continue;
    }
    for (const record of completed) {
      if (record.result.status !== "passed" || !gateMatchesAssignment(tracker.gate, record.assignment)) continue;
      const executedNodeIds = await executeGateActivation(
        context,
        value,
        tracker,
        { key: `delegation:${record.worker.id}`, sourceNodeIds: [record.worker.id] },
        round,
        parentNodeId,
        deadlineAt,
        ++sequence.value
      );
      nodeIds.push(...executedNodeIds);
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
  deadlineAt: number | undefined,
  sequence: { value: number }
): Promise<string[]> {
  const nodeIds: string[] = [];
  const upstreamEvidenceNodeIds: string[] = [];
  for (const tracker of trackers.values()) {
    if (tracker.gate.mode === "after-each-delegation") {
      for (const activation of tracker.activations.values()) {
        if (tracker.passed.has(activation.key)) continue;
        const executedNodeIds = await executeGateActivation(
          context, value, tracker, activation, round, parentNodeId, deadlineAt, ++sequence.value
        );
        nodeIds.push(...executedNodeIds);
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
      const matching = completionGateRecords(delegations, tracker.gate);
      const capabilityHasWorkCondition = tracker.gate.requiredCapability === "quality.test"
        || tracker.gate.requiredCapability === "quality.audit"
        || tracker.gate.requiredCapability.startsWith("code.");
      const strictQualityGate = value.policy.execution?.isolation === "worktree"
        && (tracker.gate.requiredCapability === "quality.test" || tracker.gate.requiredCapability === "quality.audit");
      if (matching.length > 0 || !capabilityHasWorkCondition || strictQualityGate) {
        activation = {
          key: matching.length > 0
            ? `completion:${matching.map(({ key }) => key).join(",")}`
            : strictQualityGate ? "completion:no-code-source" : "completion",
          sourceNodeIds: matching.map(({ record }) => record.worker.id)
        };
      }
    }
    if (!activation) continue;
    const executedNodeIds = await executeGateActivation(
      context,
      value,
      tracker,
      activation,
      round,
      parentNodeId,
      deadlineAt,
      ++sequence.value,
      upstreamEvidenceNodeIds
    );
    nodeIds.push(...executedNodeIds);
    // Completion Gates are ordered policy. A required upstream quality Gate that did not
    // pass makes a before-completion audit of the same candidate redundant and misleading.
    if (tracker.gate.required && tracker.gate.requiredCapability === "quality.test" && tracker.status !== "passed") {
      await context.emit("gate.downstream.short-circuited", undefined, {
        gateId: tracker.gate.id,
        reason: "required quality-test did not pass"
      });
      break;
    }
    if (tracker.status === "passed") upstreamEvidenceNodeIds.push(...executedNodeIds);
  }
  return nodeIds;
}

function requiredGateIssues(trackers: Map<string, GateTracker>): GateTracker[] {
  return [...trackers.values()].filter(
    (tracker) => tracker.gate.required && tracker.activations.size > 0 && tracker.status !== "passed"
  );
}

function completionGateRecords(
  delegations: DelegationRecord[],
  gate: SupervisorGateConfig
): Array<{ key: string; record: DelegationRecord }> {
  const latest = new Map<string, DelegationRecord>();
  for (const record of delegations) {
    if (record.result.status !== "passed" || !gateMatchesAssignment(gate, record.assignment)) continue;
    const key = record.assignment.changeSet?.trim()
      || record.assignment.nodeId?.trim()
      || record.worker.id;
    latest.set(key, record);
  }
  return [...latest.entries()].map(([key, record]) => ({ key, record }));
}

function invalidateCompletionGatesForRemediation(
  trackers: Map<string, GateTracker>,
  assignment: SupervisorAssignment
): string[] {
  const invalidated: string[] = [];
  for (const tracker of trackers.values()) {
    if (!tracker.gate.required || !gateMatchesAssignment(tracker.gate, assignment)) continue;
    tracker.passed.clear();
    tracker.status = "pending";
    tracker.reason = "code remediation changed the reviewed candidate; rerun this Gate against the latest change-set evidence";
    invalidated.push(tracker.gate.id);
  }
  return invalidated;
}

async function executeSupervisor(context: ArchitectureExecutionContext): Promise<ArchitectureExecutionResult> {
  const value = planConfig(context.plan);
  const members = new Map(value.members.map((member) => [member.roleId, member]));
  const hasStaticDag = Boolean(value.flow.dag);
  let dagTrackers = value.flow.dag
    ? new Map(value.flow.dag.nodes.map((node): [string, SupervisorDagNodeTracker] => [node.nodeId, {
        node,
        status: "pending",
        executions: []
    }]))
    : undefined;
  let dynamicTodos: Map<string, SupervisorTodo> | undefined;
  let regressionImpact: SupervisorImpactAssessment | undefined;
  const memberSessions = new Map<string, MemberSessionState>();
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
  let planRevision = hasStaticDag ? 1 : 0;
  let latestNodeIds: string[] = [];
  // Absolute wall-clock ceiling is optional. When the policy omits maxDurationMs the run has no
  // fixed deadline: it keeps going while nodes make progress and is bounded only by per-node idle
  // timeouts and the round/delegation limits. A value still acts as a hard safety ceiling.
  let deadlineAt = value.policy.limits.maxDurationMs === undefined
    ? undefined
    : startedAt + value.policy.limits.maxDurationMs;
  const durableResumeState = await context.readArtifact<JsonObject>("supervisor-state.json");
  const restored = restoreSupervisorResumeState({
    resume: durableResumeState,
    context,
    value,
    members,
    gateTrackers: trackers
  });
  if (restored) {
    round = restored.round;
    delegationCount = restored.delegations;
    planRevision = restored.planRevision;
    latestNodeIds = restored.latestNodeIds;
    deadlineAt = restored.deadlineAt;
    history.push(...restored.history);
    dynamicTodos = restored.dynamicTodos;
    dagTrackers = restored.dagTrackers;
    regressionImpact = restored.impact;
    for (const session of restored.memberSessions) memberSessions.set(session.key, session);
    delegationLedger.push(...restored.delegationLedger);
    workerResults.push(...restored.delegationLedger.map(({ result }) => ({ status: result.status })));
    gateSequence.value = restored.gateSequence;
  }
  const durationExceeded = () => deadlineAt !== undefined && Date.now() >= deadlineAt;
  const currentResumeState = (): JsonObject => supervisorResumeState({
    round,
    delegations: delegationCount,
    planRevision,
    latestNodeIds,
    deadlineAt,
    history,
    dynamicTodos,
    dagTrackers,
    gateTrackers: trackers,
    memberSessions,
    delegationLedger,
    gateSequence: gateSequence.value,
    impact: regressionImpact
  });
  const syncSupervisorState = (): void => updateSupervisorRunState(
    context,
    value,
    round,
    delegationCount,
    history,
    trackers,
    dagTrackers,
    regressionImpact,
    planRevision
  );

  const settleConditionalSkips = async (): Promise<void> => {
    if (!dagTrackers) return;
    let changed = false;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const tracker of dagTrackers.values()) {
        if (tracker.status !== "pending") continue;
        const terminalBranchMismatch = tracker.node.needs.some((need) => {
          const dependencyStatus = dagTrackers!.get(need)?.status ?? "pending";
          if (dependencyStatus === "pending" || dependencyStatus === "running") return false;
          const hasExplicitCondition = tracker.node.needsWhen?.some((condition) => condition.nodeId === need) ?? false;
          if (hasExplicitCondition) {
            return !supervisorDagDependencyMatches(tracker.node, need, dependencyStatus);
          }
          // Preserve the ordinary passed-only failure boundary: blocked/failed dependencies remain
          // visible and do not silently disappear. Only a branch already skipped by an explicit
          // condition propagates that convergence through an ordinary downstream edge.
          return dependencyStatus === "skipped";
        });
        if (!terminalBranchMismatch) continue;
        tracker.status = "skipped";
        progressed = true;
        changed = true;
      }
    }
    if (changed) {
      syncSupervisorState();
      await context.emit("supervisor.dag.updated", context.plan.nodes[0]!.id, { dag: supervisorDagSnapshot(dagTrackers) });
      await context.persist();
    }
  };

  supervisorLoop: while (true) {
    await settleConditionalSkips();
    if (durationExceeded()) {
      return blocked("management policy duration limit reached before convergence", round - 1, delegationCount, trackers, dagTrackers);
    }
    const roundReservation = context.budget?.reserve("depth");
    roundReservation?.commit();
    const node = round === 1
      ? context.plan.nodes[0]!
      : supervisorNode(value, round, latestNodeIds, history, gateSnapshot(trackers), dagTrackers);
    const compactedHistory = compactSupervisorHistory(history, round, supervisorHistoryKeepRounds(context));
    if (compactedHistory.compactedEntries > 0) {
      await context.emit("supervisor.history-compacted", node.id, {
        keepRounds: compactedHistory.keepRounds,
        compactedRounds: compactedHistory.compactedRounds,
        compactedEntries: compactedHistory.compactedEntries,
        charsSaved: compactedHistory.charsSaved
      });
    }
    node.with = supervisorWith(value, round, compactedHistory.entries, gateSnapshot(trackers), dagTrackers);
    const supervisorRole = context.loaded.manifest.roles[node.role];
    if (!supervisorRole) throw new Error(`supervisor runtime role not found: ${node.role}`);
    node.provider = supervisorRole.provider;
    syncSupervisorState();
    await context.writeArtifact("supervisor-state.json", currentResumeState());
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
    let next = decision(supervisorResult.output);
    if (!next) {
      return {
        status: "failed",
        output: output("supervisor returned an invalid decision", round, delegationCount, trackers, undefined, dagTrackers)
      };
    }

    if (next.action === "plan-todos") {
      if (hasStaticDag) {
        return {
          status: "failed",
          output: output("plan-todos is unavailable because this workflow already declares a static DAG", round, delegationCount, trackers, undefined, dagTrackers)
        };
      }
      if (dynamicTodos) {
        const recoverableReason = requiredGateIssues(trackers).length > 0
          ? "an active dynamic TODO plan already exists; remediate the blocked required Gate by delegating an existing passed code or integration todoId so the runtime can reopen it"
          : "an active dynamic TODO plan already exists; delegate a ready todoId from that plan instead of replacing it";
        history.push({ round, supervisorNodeId: node.id, decision: next as unknown as JsonValue, decisionRejected: recoverableReason });
        await context.emit("supervisor.todos.rejected", node.id, {
          issues: [recoverableReason], recoverable: true, activeTodoIds: [...dynamicTodos.keys()]
        });
        if (round >= value.policy.limits.maxRounds) {
          return blocked(recoverableReason, round, delegationCount, trackers, dagTrackers);
        }
        latestNodeIds = [node.id];
        round += 1;
        continue;
      }
      const issues = dynamicTodoPlanIssues(
        context.plan.workflow,
        next.todos,
        members,
        value.policy.limits.maxDelegations,
        next.impact
      );
      if (next.impact) {
        const scripts = await context.executionPackageScripts();
        const normalized = normalizeValidationGroups(next.impact.requiredChecks, next.impact.validationGroups, supportedRequiredChecks(scripts));
        if (normalized.status === "configuration-issue") issues.push(...normalized.issues);
        else next.impact = { ...next.impact, requiredChecks: normalized.requiredChecks, validationGroups: normalized.validationGroups };
      }
      if (issues.length > 0) {
        history.push({
          round,
          supervisorNodeId: node.id,
          decision: next as unknown as JsonValue,
          decisionRejected: issues.join("; ")
        });
        await context.emit("supervisor.todos.rejected", node.id, { issues });
        if (round >= value.policy.limits.maxRounds) {
          return blocked(`dynamic TODO plan is invalid: ${issues.join("; ")}`, round, delegationCount, trackers, dagTrackers);
        }
        latestNodeIds = [node.id];
        round += 1;
        continue;
      }
      regressionImpact = next.impact;
      dynamicTodos = new Map(next.todos.map((todo) => [todo.id, todo]));
      planRevision += 1;
      const plannedDag = todoDag(next.todos);
      dagTrackers = new Map(plannedDag.nodes.map((todo): [string, SupervisorDagNodeTracker] => [todo.nodeId, {
        node: todo,
        status: "pending",
        executions: []
      }]));
      history.push({
        round,
        supervisorNodeId: node.id,
        decision: next as unknown as JsonValue,
        todoPlanAccepted: true
      });
      await context.emit("supervisor.todos.planned", node.id, {
        summary: next.summary,
        impact: next.impact as unknown as JsonValue,
        todos: next.todos as unknown as JsonValue
      });
      syncSupervisorState();
      await context.persist();
      if (round >= value.policy.limits.maxRounds) {
        return blocked("management policy round limit reached after TODO planning", round, delegationCount, trackers, dagTrackers);
      }
      latestNodeIds = [node.id];
      round += 1;
      continue;
    }

    if (next.action === "request-human-decision") {
      if (dynamicTodos && dagTrackers) {
        const issues = supervisorHumanDecisionPlanIssues(next.assignments, dagTrackers);
        if (issues.length > 0) {
          const reason = issues.join("; ");
          history.push({ round, supervisorNodeId: node.id, decision: next as unknown as JsonValue, decisionRejected: reason });
          await context.emit("supervisor.delegation.rejected", node.id, {
            reason,
            recoverable: true,
            beforeHumanDecision: true
          });
          if (round >= value.policy.limits.maxRounds) {
            return blocked(reason, round, delegationCount, trackers, dagTrackers);
          }
          latestNodeIds = [node.id];
          round += 1;
          continue;
        }
      }
      if (!context.requestHumanDecision) {
        return {
          status: "failed",
          output: output(
            "supervisor requested a human decision, but no human-decision control plane is available",
            round,
            delegationCount,
            trackers,
            undefined,
            dagTrackers
          )
        };
      }
      const requested = next;
      const waitingStartedAt = Date.now();
      const humanDecision = await context.requestHumanDecision({
        nodeId: node.id,
        round,
        riskCategory: requested.riskCategory,
        summary: requested.summary,
        proposedAction: {
          action: "delegate",
          summary: requested.summary,
          assignments: requested.assignments as unknown as JsonValue
        }
      });
      // A human pause is control-plane latency, not active execution time. Preserve the configured
      // runtime budget by moving its deadline forward by the exact wait duration.
      if (deadlineAt !== undefined) deadlineAt += Date.now() - waitingStartedAt;
      if (humanDecision.decision === "approved") {
        const candidateUrl = approvedCandidateUrl(context.input, humanDecision);
        if (candidateUrl) context.input.candidateUrl = candidateUrl;
      }
      history.push({
        round,
        supervisorNodeId: node.id,
        decision: requested as unknown as JsonValue,
        humanDecision: {
          requestId: humanDecision.requestId,
          decision: humanDecision.decision,
          decidedBy: humanDecision.decidedBy ?? null,
          comment: humanDecision.comment ?? null,
          candidateUrl: humanDecision.candidateUrl ?? context.input.candidateUrl ?? null
        }
      });
      if (humanDecision.decision === "rejected") {
        if (round >= value.policy.limits.maxRounds) {
          return blocked(
            "human rejected the proposed high-risk action at the management policy round limit",
            round,
            delegationCount,
            trackers,
            dagTrackers
          );
        }
        latestNodeIds = [node.id];
        round += 1;
        continue;
      }
      next = {
        action: "delegate",
        summary: requested.summary,
        ...(requested.impact ? { impact: requested.impact } : {}),
        assignments: requested.assignments
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
      const validator = resolveGateValidator(tracker.gate);
      const validation = validator?.(tracker.gate, next.evidence);
      if (validation && !validation.passed) {
        const reason = validation.reason ?? `gate ${next.gateId} evidence validation failed`;
        for (const activation of pending) {
          tracker.executions.push({
            nodeId: node.id,
            executorRoleId: "supervisor",
            executorRuntimeRole: value.supervisor.role,
            activation: activation.key,
            sourceNodeIds: activation.sourceNodeIds,
            status: "blocked",
            evidence: next.evidence,
            error: reason
          });
        }
        tracker.reason = reason;
        trackerStatus(tracker);
        history.push({
          round,
          supervisorNodeId: node.id,
          decision: next as unknown as JsonValue,
          decisionRejected: reason
        });
        await context.emit("gate.unsatisfied", node.id, { gateId: next.gateId, reason, status: "blocked" });
        if (round >= value.policy.limits.maxRounds) {
          return blocked(reason, round, delegationCount, trackers, dagTrackers);
        }
        latestNodeIds = [node.id];
        round += 1;
        continue;
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

    // A planned TODO graph is the immutable execution contract. Once all required nodes have
    // passed, a late ad-hoc delegation (most often a duplicate test assignment without todoId)
    // cannot add legitimate implementation work. Safely ignore it and advance through the
    // configured completion Gates instead of consuming another delegation slot or blocking a
    // successfully completed Run on a leader formatting mistake.
    if (
      next.action === "delegate"
      && dynamicTodos
      && dagTrackers
      && [...dagTrackers.values()].every((tracker) => !tracker.node.required || tracker.status === "passed")
      && requiredGateIssues(trackers).length === 0
      && next.assignments.some((assignment) => typeof assignment.todoId !== "string" || !assignment.todoId.trim())
    ) {
      const reason = "ignored unplanned delegation after every required dynamic TODO passed";
      history.push({
        round,
        supervisorNodeId: node.id,
        decision: next as unknown as JsonValue,
        decisionRejected: reason,
        completionRecovered: true
      });
      await context.emit("supervisor.delegation.rejected", node.id, { reason, recoverable: true, advancedToGates: true });
      next = {
        action: "finish",
        summary: "All planned TODOs passed; the runtime ignored an unplanned late delegation and advanced the configured quality Gates.",
        result: { delivered: true, recoveredFromUnplannedDelegation: true }
      };
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
        ? [...dagTrackers.values()].filter((tracker) => tracker.node.required && tracker.status !== "passed" && tracker.status !== "skipped")
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

    if (next.impact) regressionImpact = next.impact;

    if (round >= value.policy.limits.maxRounds) {
      const unresolved = dagTrackers
        ? [...dagTrackers.values()].find((tracker) => tracker.status === "blocked" || tracker.status === "failed")
        : undefined;
      const latestExecution = unresolved?.executions.at(-1);
      const lastHistory = history.at(-1);
      const lastRejected = lastHistory
        && typeof lastHistory === "object"
        && !Array.isArray(lastHistory)
        && typeof lastHistory.decisionRejected === "string"
        ? lastHistory.decisionRejected
        : undefined;
      const detail = unresolved
        ? `planned node ${unresolved.node.nodeId} remains ${unresolved.status}: ${latestExecution?.error ?? JSON.stringify(latestExecution?.output ?? null)}`
        : lastRejected
          ? `last rejected decision: ${lastRejected}`
          : undefined;
      const reason = `management policy round limit reached before convergence${detail ? `; ${detail}` : ""}`;
      if (dagTrackers && (unresolved || lastRejected)) {
        await context.emit("supervisor.dag.blocked", node.id, {
          reason,
          dag: supervisorDagSnapshot(dagTrackers)
        });
        await context.persist();
      }
      return blocked(
        reason,
        round,
        delegationCount,
        trackers,
        dagTrackers
      );
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

    const openCircuit = next.assignments
      .map((assignment) => ({ assignment, reason: technicalCircuitReason(assignment, delegationLedger) }))
      .find((candidate) => candidate.reason);
    if (openCircuit?.reason) {
      history.push({
        round,
        supervisorNodeId: node.id,
        decision: next as unknown as JsonValue,
        decisionRejected: openCircuit.reason
      });
      await context.emit("supervisor.delegation.rejected", node.id, {
        reason: openCircuit.reason,
        roleId: openCircuit.assignment.roleId,
        circuitOpen: true
      });
      return blocked(openCircuit.reason, round, delegationCount, trackers, dagTrackers);
    }

    const terminalDagBlock = async (reason: string): Promise<ArchitectureExecutionResult> => {
      await context.emit("supervisor.dag.blocked", node.id, {
        reason,
        dag: supervisorDagSnapshot(dagTrackers)
      });
      await context.persist();
      return blocked(reason, round, delegationCount, trackers, dagTrackers);
    };
    const recoverableDagDecision = async (reason: string): Promise<ArchitectureExecutionResult | undefined> => {
      history.push({
        round,
        supervisorNodeId: node.id,
        decision: next as unknown as JsonValue,
        decisionRejected: reason
      });
      await context.emit("supervisor.dag.rejected", node.id, {
        reason,
        recoverable: true,
        dag: supervisorDagSnapshot(dagTrackers)
      });
      await context.emit("supervisor.delegation.rejected", node.id, { reason, recoverable: true });
      if (round >= value.policy.limits.maxRounds) {
        return terminalDagBlock(reason);
      }
      latestNodeIds = [node.id];
      round += 1;
      return undefined;
    };
    const remediationRequiredGates = requiredGateIssues(trackers);
    const invalidatedGateIds = new Set<string>();
    const scheduled: Array<{
      assignment: SupervisorAssignment;
      worker: ExecutionPlanNode;
      memberSession?: MemberSessionState;
      retainMemberSession: boolean;
    }> = [];
    const scheduledDagNodes = new Set<string>();
    for (let index = 0; index < next.assignments.length; index += 1) {
      const assignment = next.assignments[index]!;
      const requestedFlowNodeId = assignment.nodeId ?? assignment.todoId;
      let reopeningAfterGateFailure = false;
      let reopeningAfterCandidateEvidence = false;
      let reopeningAfterConditionalEvidence = false;
      let reopeningAfterRecoveryEvidence = false;
      let remediationGateEvidenceNodeIds: string[] = [];
      let candidateEvidenceNodeIds: string[] = [];
      let recoveryEvidenceNodeIds: string[] = [];
      const dagTracker = dagTrackers && typeof requestedFlowNodeId === "string"
        ? dagTrackers.get(requestedFlowNodeId)
        : undefined;
      const activeDagTrackers = dagTrackers;
      if (!activeDagTrackers && typeof assignment.todoId === "string" && assignment.todoId.trim()) {
        const rejected = await recoverableDagDecision(
          `supervisor delegated todoId ${assignment.todoId} without an accepted dynamic TODO plan; emit plan-todos again and address the recorded plan validation issues`
        );
        if (rejected) return rejected;
        continue supervisorLoop;
      }
      if (activeDagTrackers) {
        if (typeof requestedFlowNodeId !== "string" || !requestedFlowNodeId.trim()) {
          const rejected = await recoverableDagDecision(dynamicTodos
            ? "dynamic TODO delegation must specify todoId"
            : "supervisor DAG delegation must specify nodeId");
          if (rejected) return rejected;
          continue supervisorLoop;
        }
        if (!dagTracker) {
          const rejected = await recoverableDagDecision(hasStaticDag
            ? `supervisor delegated outside the declared DAG: ${requestedFlowNodeId}`
            : `supervisor delegated outside the active TODO plan: ${requestedFlowNodeId}`);
          if (rejected) return rejected;
          continue supervisorLoop;
        }
        if (scheduledDagNodes.has(requestedFlowNodeId)) {
          const rejected = await recoverableDagDecision(`supervisor delegated planned node ${requestedFlowNodeId} more than once in the same round`);
          if (rejected) return rejected;
          continue supervisorLoop;
        }
        scheduledDagNodes.add(requestedFlowNodeId);
        const repairingAfterGateFailure = Boolean(
          dynamicTodos
          && remediationRequiredGates.length > 0
          && (dagTracker.node.workKind === "code" || dagTracker.node.workKind === "integration")
        );
        reopeningAfterGateFailure = dagTracker.status === "passed" && repairingAfterGateFailure;
        candidateEvidenceNodeIds = supervisorDagCandidateEvidenceNodeIds(activeDagTrackers);
        reopeningAfterCandidateEvidence = dagTracker.status === "passed"
          && supervisorDagHasFreshCandidateEvidence(dagTracker, activeDagTrackers);
        reopeningAfterConditionalEvidence = dagTracker.status === "passed"
          && supervisorDagHasFreshDependencyEvidence(dagTracker, activeDagTrackers);
        if (
          dagTracker.status === "passed"
          && !reopeningAfterGateFailure
          && !reopeningAfterCandidateEvidence
          && !reopeningAfterConditionalEvidence
        ) {
          const rejected = await recoverableDagDecision(`supervisor cannot delegate planned node ${requestedFlowNodeId} because it already passed`);
          if (rejected) return rejected;
          continue supervisorLoop;
        }
        if (reopeningAfterGateFailure || reopeningAfterCandidateEvidence || reopeningAfterConditionalEvidence) {
          dagTracker.status = "pending";
          delete dagTracker.passedExecutionNodeId;
        }
        if (reopeningAfterGateFailure) {
          remediationGateEvidenceNodeIds = [...new Set(remediationRequiredGates.flatMap((tracker) => {
            const latestExecution = tracker.executions.at(-1);
            return latestExecution && context.plan.nodes.some((candidate) => candidate.id === latestExecution.nodeId)
              ? [latestExecution.nodeId]
              : [];
          }))];
          for (const gateId of invalidateCompletionGatesForRemediation(trackers, {
            ...assignment,
            workKind: dagTracker.node.workKind,
            ...(dagTracker.node.changeSet ? { changeSet: dagTracker.node.changeSet } : {})
          })) invalidatedGateIds.add(gateId);
        }
        if (dagTracker.status === "blocked" || dagTracker.status === "failed") {
          const pendingFailureHandlers = [...activeDagTrackers.values()].filter((candidate) => (
            candidate.node.needsWhen?.some((condition) => (
              condition.nodeId === requestedFlowNodeId
              && supervisorDagDependencyMatches(candidate.node, requestedFlowNodeId, dagTracker.status)
            ))
            && candidate.status !== "passed"
            && candidate.status !== "skipped"
          ));
          if (pendingFailureHandlers.length > 0) {
            const reason = `supervisor cannot retry planned node ${requestedFlowNodeId} before conditional failure handlers pass: ${pendingFailureHandlers.map((candidate) => `${candidate.node.nodeId} (${candidate.status})`).join(", ")}`;
            const rejected = await recoverableDagDecision(reason);
            if (rejected) return rejected;
            continue supervisorLoop;
          }
          if (dagTracker.status === "blocked") {
            const latestExecution = dagTracker.executions.at(-1);
            recoveryEvidenceNodeIds = [...activeDagTrackers.values()].flatMap((candidate) => {
              const consumesFailure = candidate.node.needsWhen?.some((condition) => (
                condition.nodeId === requestedFlowNodeId
                && supervisorDagDependencyMatches(candidate.node, requestedFlowNodeId, dagTracker.status)
              ));
              const recoveryExecution = candidate.executions.at(-1);
              return consumesFailure
                && candidate.status === "passed"
                && recoveryExecution?.status === "passed"
                && latestExecution
                && recoveryExecution.dependencyNodeIds?.includes(latestExecution.nodeId)
                ? [recoveryExecution.nodeId]
                : [];
            });
            reopeningAfterRecoveryEvidence = recoveryEvidenceNodeIds.length > 0;
            if (reopeningAfterRecoveryEvidence) {
              dagTracker.status = "pending";
              delete dagTracker.passedExecutionNodeId;
            } else {
              const rootCause = latestExecution?.error ?? JSON.stringify(latestExecution?.output ?? null);
              return terminalDagBlock(
                `planned node ${requestedFlowNodeId} remains blocked without new prerequisite evidence: ${rootCause}`
              );
            }
          }
        }
        if (assignment.roleId !== dagTracker.node.roleId) {
          const rejected = await recoverableDagDecision(
            `supervisor delegated planned node ${requestedFlowNodeId} to role ${assignment.roleId}; expected ${dagTracker.node.roleId}`
          );
          if (rejected) return rejected;
          continue supervisorLoop;
        }
        // Gate remediation is a continuation of a TODO whose dependencies were already
        // satisfied for its passed execution. A conditional repair may have depended on an
        // earlier blocked validation that is now passed precisely because the repair worked;
        // re-evaluating needsWhen here would make the completed repair impossible to reopen.
        const unmetNeeds = reopeningAfterGateFailure
          || reopeningAfterCandidateEvidence
          || reopeningAfterConditionalEvidence
          || supervisorDagNodeReady(dagTracker.node, activeDagTrackers)
          ? []
          : dagTracker.node.needs.filter((need) => {
              const dependency = activeDagTrackers.get(need);
              const condition = dagTracker.node.needsWhen?.find((candidate) => candidate.nodeId === need);
              if (!condition) return dependency?.status !== "passed";
              return dependency?.status === "pending" || dependency?.status === "running"
                || (!condition.statuses.includes("terminal") && !condition.statuses.includes(dependency?.status ?? "pending" as never));
            });
        if (unmetNeeds.length > 0) {
          const rejected = await recoverableDagDecision(
            `supervisor delegated planned node ${requestedFlowNodeId} before dependencies passed: ${unmetNeeds.map((need) => `${need} (${activeDagTrackers.get(need)?.status ?? "unknown"})`).join(", ")}`
          );
          if (rejected) return rejected;
          continue supervisorLoop;
        }
      }
      const member = members.get(assignment.roleId);
      if (!member) {
        const reason = `supervisor delegated to unbound role ${assignment.roleId}`;
        if (!dagTrackers) return blocked(reason, round, delegationCount, trackers);
        const rejected = await recoverableDagDecision(reason);
        if (rejected) return rejected;
        continue supervisorLoop;
      }
      if (dagTracker && assignment.workKind !== undefined && assignment.workKind !== dagTracker.node.workKind) {
        const reason = `supervisor delegated planned node ${requestedFlowNodeId} with workKind ${assignment.workKind}; expected ${dagTracker.node.workKind}`;
        const rejected = await recoverableDagDecision(reason);
        if (rejected) return rejected;
        continue supervisorLoop;
      }
      if (dagTracker && assignment.changeSet !== undefined && assignment.changeSet !== dagTracker.node.changeSet) {
        const reason = `supervisor delegated planned node ${requestedFlowNodeId} with changeSet ${assignment.changeSet}; expected ${dagTracker.node.changeSet ?? "none"}`;
        const rejected = await recoverableDagDecision(reason);
        if (rejected) return rejected;
        continue supervisorLoop;
      }
      // requiredCapabilities are advisory hints the supervisor may attach; they travel with the
      // delegation as context but are NOT a hard gate. The supervisor picks who fits from each
      // member's profile (responsibilities + skill summaries), so capability tags never block work.
      const requiredCapabilities = [...new Set([
        ...(dagTracker?.node.requiredCapabilities ?? []),
        ...(assignment.requiredCapabilities ?? [])
      ])];
      const role = context.loaded.manifest.roles[member.role];
      if (!role) throw new Error(`supervisor member runtime role not found: ${member.role}`);
      const plannedTodo = dynamicTodos && requestedFlowNodeId ? dynamicTodos.get(requestedFlowNodeId) : undefined;
      const baseDelegatedTask = dagTracker?.node.task ?? assignment.task?.trim();
      if (!baseDelegatedTask) {
        if (!dagTrackers) {
          return { status: "failed", output: output("delegate assignment task is missing", round, delegationCount, trackers) };
        }
        const rejected = await recoverableDagDecision(`supervisor planned node ${requestedFlowNodeId} has no delegated task`);
        if (rejected) return rejected;
        continue supervisorLoop;
      }
      const remediationGateIds = reopeningAfterGateFailure
        ? remediationRequiredGates.map((tracker) => tracker.gate.id)
        : [];
      const delegatedTask = reopeningAfterGateFailure
        ? [
            baseDelegatedTask,
            "",
            "## Required Gate remediation activation",
            `Required Gate(s) ${remediationGateIds.join(", ")} blocked after this TODO previously passed. This retry is a continuation of the accepted TODO for the reviewed candidate, not a first-time conditional activation.`,
            "For this retry, the Gate remediation activation supersedes the original needsWhen trigger wording. Do not skip merely because the original upstream validation is now passed; that changed status is expected after the earlier repair succeeded.",
            "Read the blocking Gate's structured output from Dependency evidence, address every concrete finding within the existing change set, and return fresh implementation and validation evidence."
          ].join("\n")
        : reopeningAfterCandidateEvidence
          ? [
              baseDelegatedTask,
              "",
              "## Candidate revalidation activation",
              "This validation previously passed, but newer passed code or integration execution evidence changed the candidate afterward.",
              "Read the fresh candidate evidence from Dependency evidence, rerun this TODO against the updated candidate, and return new validation evidence. The same candidate evidence may activate this validation only once."
            ].join("\n")
          : reopeningAfterRecoveryEvidence
            ? [
                baseDelegatedTask,
                "",
                "## Conditional recovery validation",
                "A declared conditional recovery node passed after this TODO blocked.",
                "Read that fresh recovery evidence from Dependency evidence and validate the repaired candidate."
              ].join("\n")
          : baseDelegatedTask;
      const workKind = dagTracker?.node.workKind ?? assignment.workKind ?? "other";
      const changeSet = dagTracker?.node.changeSet ?? assignment.changeSet;
      const sod = value.separationOfDuties;
      if (sod?.approverRoleIds.includes(assignment.roleId)) {
        const producerEvidence = delegationLedger.filter((record) => (
          sod.producerRoleIds.includes(record.assignment.roleId) && record.result.status === "passed"
        ));
        const conflictingProducer = producerEvidence.find((record) => {
          const producer = members.get(record.assignment.roleId);
          return sod.mustDifferEmployee === true
            && producer?.employeeId !== undefined
            && producer.employeeId === member.employeeId;
        });
        const approverSessionKey = plannedTodo?.sessionKey;
        const conflictingSession = sod.sameSessionForbidden === true && approverSessionKey
          ? producerEvidence.find((record) => record.worker.metadata?.memberSessionKey === approverSessionKey)
          : undefined;
        const missingEvidence = sod.independentEvidenceRequired === true
          && !producerEvidence.some((record) => record.result.output !== undefined && record.result.output !== null);
        if (conflictingProducer || conflictingSession || missingEvidence) {
          const reason = conflictingProducer
            ? `separation-of-duties gate blocked: producer and approver resolve to Employee ${member.employeeId}`
            : conflictingSession
              ? `separation-of-duties gate blocked: producer and approver share member Session ${approverSessionKey}`
              : "separation-of-duties gate blocked: independent producer evidence is required";
          await context.emit("supervisor.sod.blocked", node.id, {
            reason,
            producerEmployeeId: conflictingProducer ? members.get(conflictingProducer.assignment.roleId)?.employeeId ?? null : null,
            approverEmployeeId: member.employeeId ?? null,
            approverRoleId: assignment.roleId
          });
          return blocked(reason, round, delegationCount, trackers, dagTrackers);
        }
      }
      const effectiveAssignment: SupervisorAssignment = {
        ...assignment,
        ...(requestedFlowNodeId ? { nodeId: requestedFlowNodeId } : {}),
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
        ? dagTracker.node.needs.map((need) => {
            const dependency = dagTrackers!.get(need)!;
            return dependency.executions.at(-1)?.nodeId;
          }).filter((nodeId): nodeId is string => Boolean(nodeId))
        : [];
      const observesDependencyFailure = reopeningAfterGateFailure || Boolean(dagTracker?.node.needsWhen?.some((condition) =>
        condition.statuses.some((status) => status !== "passed")
      ));
      let memberSession: MemberSessionState | undefined;
      let retainMemberSession = false;
      if (plannedTodo?.sessionKey) {
        const plannedTrackers = dagTrackers;
        if (!plannedTrackers) throw new Error("dynamic TODO member session requires active trackers");
        const existingSession = memberSessions.get(plannedTodo.sessionKey);
        memberSession = existingSession ?? {
          id: `member-session-${plannedTodo.sessionKey}`,
          key: plannedTodo.sessionKey,
          roleId: plannedTodo.roleId,
          ...(plannedTodo.changeSet ? { changeSet: plannedTodo.changeSet } : {}),
          status: "open",
          turns: []
        };
        if (!existingSession) {
          memberSessions.set(plannedTodo.sessionKey, memberSession);
          await context.emit("supervisor.member-session.opened", node.id, {
            memberSessionId: memberSession.id,
            sessionKey: memberSession.key,
            roleId: memberSession.roleId,
            changeSet: memberSession.changeSet ?? null
          });
        } else {
          await context.emit("supervisor.member-session.continued", node.id, {
            memberSessionId: memberSession.id,
            sessionKey: memberSession.key,
            todoId: plannedTodo.id,
            priorTurns: memberSession.turns.length,
            handoff: Boolean(latestMemberHandoff(memberSession))
          });
        }
        const hasFutureSessionTodo = [...dynamicTodos!.values()].some((todo) => (
          todo.id !== plannedTodo.id
          && todo.sessionKey === plannedTodo.sessionKey
          && plannedTrackers.get(todo.id)?.status !== "passed"
        ));
        const mayNeedGateRemediation = (workKind === "code" || workKind === "integration")
          && [...trackers.values()].some((tracker) => (
            tracker.gate.required
            && tracker.status !== "passed"
            && gateMatchesAssignment(tracker.gate, effectiveAssignment)
          ));
        retainMemberSession = hasFutureSessionTodo || mayNeedGateRemediation;
      }
      scheduled.push({
        assignment: effectiveAssignment,
        memberSession,
        retainMemberSession,
        worker: {
          id: workerId,
          role: member.role,
          provider: role.provider,
          needs: [...new Set([
            node.id,
            ...dependencyNodeIds,
            ...remediationGateEvidenceNodeIds,
            ...(reopeningAfterCandidateEvidence ? candidateEvidenceNodeIds : []),
            ...recoveryEvidenceNodeIds
          ])],
          with: {
            __delegatedRoleId: member.roleId,
            __todoId: plannedTodo?.id ?? "",
            __delegatedTask: delegatedTask,
            __memberSession: memberSessionSnapshot(memberSession),
            __memberSessionHandoffPath: memberSession ? memberHandoffPath(context, memberSession.key) : "",
            __memberSessionHandoff: latestMemberHandoff(memberSession),
            __requiredCapabilities: requiredCapabilities,
            __workKind: workKind,
            __changeSet: changeSet ?? "",
            __regressionImpact: regressionImpact ? regressionImpact as unknown as JsonValue : null,
            __gateExecution: null,
            __delegatedContext: {
              ...(plannedTodo?.context ?? {}),
              ...(assignment.context ?? {}),
              ...(regressionImpact ? { regressionImpact: regressionImpact as unknown as JsonValue } : {}),
              ...(reopeningAfterGateFailure ? {
                gateRemediation: {
                  gateIds: remediationGateIds,
                  evidenceNodeIds: remediationGateEvidenceNodeIds,
                  supersedesInitialNeedsWhen: true
                }
              } : {}),
              ...(reopeningAfterCandidateEvidence ? {
                candidateRevalidation: {
                  evidenceNodeIds: candidateEvidenceNodeIds,
                  supersedesPassedResult: true
                }
              } : {}),
              ...(reopeningAfterRecoveryEvidence ? {
                conditionalRecovery: {
                  evidenceNodeIds: recoveryEvidenceNodeIds,
                  supersedesBlockedResult: true
                }
              } : {})
            },
            __supervisorSummary: next.summary ?? "",
            __previousAttemptError: ""
          },
          metadata: {
            kind: "member",
            roleId: member.roleId,
            employeeId: member.employeeId ?? "",
            principalId: member.principalId ?? member.employeeId ?? "",
            workInstanceId: workerId,
            round,
            parentNodeId: node.id,
            workKind,
            changeSet: changeSet ?? "",
            requiredCapabilities,
            observesDependencyFailure,
            ...(reopeningAfterGateFailure ? {
              gateRemediation: true,
              gateRemediationGateIds: remediationGateIds,
              gateRemediationEvidenceNodeIds: remediationGateEvidenceNodeIds
            } : {}),
            ...(reopeningAfterCandidateEvidence ? {
              candidateRevalidation: true,
              candidateRevalidationEvidenceNodeIds: candidateEvidenceNodeIds
            } : {}),
            ...(plannedTodo ? { todoId: plannedTodo.id } : {}),
            ...(memberSession ? {
              memberSessionId: memberSession.id,
              memberSessionKey: memberSession.key,
              memberSessionRetained: retainMemberSession
            } : {}),
            ...(dagTracker ? {
              flowNodeId: dagTracker.node.nodeId,
              flowNodeKind: dagTracker.node.kind,
              flowNodeRequired: dagTracker.node.required,
              flowNodeExecution: executionNumber,
              dependencyNodeIds,
              candidateNodeIds: candidateEvidenceNodeIds
            } : {})
          }
        }
      });
    }
    if (invalidatedGateIds.size > 0) {
      await context.emit("gate.invalidated", node.id, {
        gateIds: [...invalidatedGateIds],
        reason: "planned code remediation changed the reviewed candidate"
      });
      await context.persist();
    }
    // Reserve the whole fan-out atomically before scheduling or invoking any
    // worker. A quota failure therefore cannot produce a partial delegation.
    const delegationReservation = scheduled.length > 0
      ? context.budget?.reserve("delegations", scheduled.length)
      : undefined;
    let completed: DelegationRecord[] = [];
    try {
      if (dagTrackers) {
        for (const { assignment } of scheduled) {
          const tracker = assignment.nodeId ? dagTrackers.get(assignment.nodeId) : undefined;
          if (tracker) tracker.status = "running";
        }
        syncSupervisorState();
        await context.persist();
      }
      for (const item of scheduled) await context.scheduleNode(item.worker);
      completed = await Promise.all(scheduled.map(async ({ assignment, worker }): Promise<DelegationRecord> => ({
        assignment,
        worker,
        result: await context.executeNode(worker, {
          deadlineAt,
          retryValidation: true,
          ...(worker.metadata?.observesDependencyFailure === true ? { dependencyFailure: "observe" } : {})
        })
      })));
      delegationReservation?.commit();
    } catch (error) {
      delegationReservation?.release();
      throw error;
    }
    for (const record of completed) {
      const sessionId = typeof record.worker.metadata?.memberSessionId === "string"
        ? record.worker.metadata.memberSessionId
        : undefined;
      if (!sessionId) continue;
      const session = [...memberSessions.values()].find((candidate) => candidate.id === sessionId);
      if (!session) continue;
      const handoff = await inspectMemberHandoff(context, session.key);
      const todoId = typeof record.worker.metadata?.todoId === "string" ? record.worker.metadata.todoId : record.worker.id;
      if (handoff.missing) {
        await context.emit("supervisor.member-session.handoff-missing", record.worker.id, {
          memberSessionId: session.id,
          sessionKey: session.key,
          todoId,
          bytes: handoff.bytes
        });
        if (memberHandoffGateEnforced(context)) {
          record.result = {
            ...record.result,
            status: "blocked" as const,
            error: handoffMissingError(session.key)
          };
        }
      }
      session.turns.push({
        todoId,
        nodeId: record.worker.id,
        task: record.assignment.task ?? "",
        status: record.result.status,
        output: record.result.output ?? null,
        error: record.result.error ?? null,
        handoff: handoff.content,
        ...(handoff.missing ? { handoffMissing: true } : {})
      });
      if (record.worker.metadata?.memberSessionRetained !== true) {
        session.status = "closed";
        await context.emit("supervisor.member-session.closed", record.worker.id, {
          memberSessionId: session.id,
          sessionKey: session.key,
          turns: session.turns.length,
          finalStatus: record.result.status
        });
      }
    }
    if (dagTrackers) {
      for (const record of completed) {
        const tracker = record.assignment.nodeId ? dagTrackers.get(record.assignment.nodeId) : undefined;
        if (!tracker) continue;
        tracker.status = record.result.status;
        tracker.executions.push({
          nodeId: record.worker.id,
          status: record.result.status,
          output: record.result.output ?? null,
          error: record.result.error ?? null,
          dependencyNodeIds: Array.isArray(record.worker.metadata?.dependencyNodeIds)
            ? record.worker.metadata.dependencyNodeIds.filter((nodeId): nodeId is string => typeof nodeId === "string")
            : [],
          candidateNodeIds: Array.isArray(record.worker.metadata?.candidateNodeIds)
            ? record.worker.metadata.candidateNodeIds.filter((nodeId): nodeId is string => typeof nodeId === "string")
            : []
        });
        if (record.result.status === "passed") tracker.passedExecutionNodeId = record.worker.id;
        else delete tracker.passedExecutionNodeId;
      }
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
    if (dagTrackers) {
      syncSupervisorState();
      await context.emit("supervisor.dag.updated", node.id, { dag: supervisorDagSnapshot(dagTrackers) });
      await context.persist();
    }
    const gateNodeIds = await runAfterDelegationGates(
      context, value, trackers, completed, delegationLedger, round, node.id, deadlineAt, gateSequence
    );
    syncSupervisorState();
    await context.persist();
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
