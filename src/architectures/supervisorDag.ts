import type { JsonValue, NodeRunStatus } from "../core/types.js";

export type SupervisorDagNodeKind =
  | "task"
  | "review"
  | "test"
  | "approval"
  | "merge"
  | "integration"
  | "integration-test"
  | "delivery"
  | "other";
export type SupervisorDagWorkKind = "discussion" | "code" | "test" | "audit" | "integration" | "other";
export type SupervisorDagDependencyStatus = Exclude<NodeRunStatus, "pending" | "running"> | "terminal";
const SUPERVISOR_DAG_DEPENDENCY_STATUSES = new Set<SupervisorDagDependencyStatus>([
  "passed",
  "blocked",
  "failed",
  "skipped",
  "terminal"
]);
export interface SupervisorDagNeedCondition {
  nodeId: string;
  statuses: SupervisorDagDependencyStatus[];
}

export interface SupervisorDagNodeConfig {
  nodeId: string;
  roleId: string;
  roleRef?: string;
  needs: string[];
  needsWhen?: SupervisorDagNeedCondition[];
  kind: SupervisorDagNodeKind;
  task: string;
  requiredCapabilities: string[];
  workKind: SupervisorDagWorkKind;
  changeSet?: string;
  required: boolean;
}

export interface SupervisorDagConfig {
  nodes: SupervisorDagNodeConfig[];
}

export interface SupervisorDagExecutionRecord {
  nodeId: string;
  status: NodeRunStatus;
  output: JsonValue;
  error: string | null;
  dependencyNodeIds?: string[];
  candidateNodeIds?: string[];
}

export interface SupervisorDagNodeTracker {
  node: SupervisorDagNodeConfig;
  status: "pending" | NodeRunStatus;
  executions: SupervisorDagExecutionRecord[];
  passedExecutionNodeId?: string;
}

export function normalizeSupervisorDagConfig(dag: SupervisorDagConfig | undefined): SupervisorDagConfig | undefined {
  if (!dag) return undefined;
  return {
    nodes: dag.nodes.map((node) => ({
      ...node,
      roleId: node.roleId ?? node.roleRef ?? "",
      needs: [...node.needs],
      ...(node.needsWhen ? { needsWhen: node.needsWhen.map((condition) => ({ nodeId: condition.nodeId, statuses: [...condition.statuses] })) } : {}),
      requiredCapabilities: [...(node.requiredCapabilities ?? [])],
      workKind: node.workKind ?? supervisorDagWorkKind(node.kind),
      required: node.required ?? true
    }))
  };
}

export function supervisorDagIssues(
  workflowId: string,
  dag: SupervisorDagConfig | undefined,
  memberRoleIds: ReadonlySet<string>
): string[] {
  if (!dag) return [];
  const issues: string[] = [];
  const byId = new Map<string, SupervisorDagNodeConfig>();
  for (const node of dag.nodes) {
    if (byId.has(node.nodeId)) issues.push(`workflow ${workflowId} has duplicate supervisor dag node ${node.nodeId}`);
    if (/^supervisor-r\d+$/.test(node.nodeId) || node.nodeId.startsWith("gate-")) {
      issues.push(`workflow ${workflowId} supervisor dag node ${node.nodeId} conflicts with a reserved runtime node id`);
    }
    if (node.roleRef && node.roleId !== node.roleRef) {
      issues.push(`workflow ${workflowId} supervisor dag node ${node.nodeId} roleId and roleRef must match`);
    }
    if (!memberRoleIds.has(node.roleId)) {
      issues.push(`workflow ${workflowId} supervisor dag node ${node.nodeId} references unknown member role ${node.roleId}`);
    }
    if (new Set(node.needs).size !== node.needs.length) {
      issues.push(`workflow ${workflowId} supervisor dag node ${node.nodeId} has duplicate needs`);
    }
    if (node.needsWhen) {
      const conditionIds = node.needsWhen.map((condition) => condition.nodeId);
      if (new Set(conditionIds).size !== conditionIds.length) issues.push(`workflow ${workflowId} supervisor dag node ${node.nodeId} has duplicate needsWhen nodes`);
      for (const condition of node.needsWhen) {
        if (!node.needs.includes(condition.nodeId)) issues.push(`workflow ${workflowId} supervisor dag node ${node.nodeId} needsWhen ${condition.nodeId} must reference a needs node`);
        if (!Array.isArray(condition.statuses) || condition.statuses.length === 0) {
          issues.push(`workflow ${workflowId} supervisor dag node ${node.nodeId} needsWhen ${condition.nodeId} statuses must not be empty`);
          continue;
        }
        if (new Set(condition.statuses).size !== condition.statuses.length) {
          issues.push(`workflow ${workflowId} supervisor dag node ${node.nodeId} needsWhen ${condition.nodeId} has duplicate statuses`);
        }
        for (const status of condition.statuses) {
          if (!SUPERVISOR_DAG_DEPENDENCY_STATUSES.has(status)) {
            issues.push(`workflow ${workflowId} supervisor dag node ${node.nodeId} needsWhen ${condition.nodeId} has unsupported status ${String(status)}`);
          }
        }
      }
    }
    byId.set(node.nodeId, node);
  }
  for (const node of dag.nodes) {
    for (const need of node.needs) {
      if (!byId.has(need)) issues.push(`workflow ${workflowId} supervisor dag node ${node.nodeId} needs unknown node ${need}`);
      if (need === node.nodeId) issues.push(`workflow ${workflowId} supervisor dag node ${node.nodeId} cannot depend on itself`);
    }
    if (node.kind === "merge") {
      if (node.needs.length < 2 || node.needs.some((need) => byId.get(need)?.kind !== "test")) {
        issues.push(`workflow ${workflowId} supervisor dag merge node ${node.nodeId} must directly depend on at least two test nodes`);
      }
    }
    if (node.kind === "integration-test" && !node.needs.some((need) => byId.get(need)?.kind === "merge")) {
      issues.push(`workflow ${workflowId} supervisor dag integration-test node ${node.nodeId} must directly depend on a merge node`);
    }
  }
  const remaining = new Set(byId.keys());
  while (remaining.size > 0) {
    const ready = [...remaining].filter((nodeId) => byId.get(nodeId)!.needs.every((need) => !remaining.has(need)));
    if (ready.length === 0) {
      issues.push(`workflow ${workflowId} supervisor dag contains a cycle among: ${[...remaining].join(", ")}`);
      break;
    }
    for (const nodeId of ready) remaining.delete(nodeId);
  }
  return issues;
}

export function supervisorDagSnapshot(trackers: Map<string, SupervisorDagNodeTracker> | undefined): JsonValue {
  if (!trackers) return null;
  return {
    nodes: [...trackers.values()].map((tracker) => ({
      nodeId: tracker.node.nodeId,
      roleId: tracker.node.roleId,
      needs: tracker.node.needs,
      ...(tracker.node.needsWhen ? { needsWhen: tracker.node.needsWhen.map((condition) => ({
        nodeId: condition.nodeId,
        statuses: [...condition.statuses]
      })) } : {}),
      kind: tracker.node.kind,
      task: tracker.node.task,
      requiredCapabilities: tracker.node.requiredCapabilities,
      workKind: tracker.node.workKind,
      changeSet: tracker.node.changeSet ?? null,
      required: tracker.node.required,
      status: tracker.status,
      ready: tracker.status !== "skipped" && (
        (tracker.status !== "passed" && supervisorDagNodeReady(tracker.node, trackers))
        || (tracker.status === "passed" && supervisorDagHasFreshDependencyEvidence(tracker, trackers))
        || (tracker.status === "passed" && supervisorDagHasFreshCandidateEvidence(tracker, trackers))
      ),
      executions: tracker.executions.map((execution) => ({ ...execution }))
    }))
  };
}

export function supervisorDagDependencyMatches(node: SupervisorDagNodeConfig, dependencyId: string, status: NodeRunStatus): boolean {
  const condition = node.needsWhen?.find((candidate) => candidate.nodeId === dependencyId);
  if (!condition) return status === "passed";
  if (status === "pending" || status === "running") return false;
  return condition.statuses.includes(status) || condition.statuses.includes("terminal");
}

export function supervisorDagNodeReady(node: SupervisorDagNodeConfig, trackers: ReadonlyMap<string, SupervisorDagNodeTracker>): boolean {
  return node.needs.every((need) => supervisorDagDependencyMatches(node, need, trackers.get(need)?.status ?? "pending"));
}

export function supervisorDagHasFreshDependencyEvidence(
  tracker: SupervisorDagNodeTracker,
  trackers: ReadonlyMap<string, SupervisorDagNodeTracker>
): boolean {
  if (!tracker.node.needsWhen?.length || !supervisorDagNodeReady(tracker.node, trackers)) return false;
  const consumedDependencyNodeIds = tracker.executions.at(-1)?.dependencyNodeIds;
  if (!consumedDependencyNodeIds || consumedDependencyNodeIds.length !== tracker.node.needs.length) return false;
  const latestDependencyNodeIds = tracker.node.needs.map((need) => trackers.get(need)?.executions.at(-1)?.nodeId);
  if (latestDependencyNodeIds.some((nodeId) => !nodeId)) return false;
  return latestDependencyNodeIds.some((nodeId, index) => nodeId !== consumedDependencyNodeIds[index]);
}

export function supervisorDagCandidateEvidenceNodeIds(
  trackers: ReadonlyMap<string, SupervisorDagNodeTracker>
): string[] {
  return [...trackers.values()].flatMap((candidate) => {
    if (candidate.node.workKind !== "code" && candidate.node.workKind !== "integration") return [];
    if (candidate.status !== "passed") return [];
    const latestExecution = candidate.executions.at(-1);
    return latestExecution?.status === "passed" ? [latestExecution.nodeId] : [];
  });
}

export function supervisorDagHasFreshCandidateEvidence(
  tracker: SupervisorDagNodeTracker,
  trackers: ReadonlyMap<string, SupervisorDagNodeTracker>
): boolean {
  if (tracker.node.workKind !== "test" && tracker.node.workKind !== "audit") return false;
  const consumedCandidateNodeIds = tracker.executions.at(-1)?.candidateNodeIds;
  if (!consumedCandidateNodeIds) return false;
  return supervisorDagCandidateEvidenceNodeIds(trackers)
    .some((nodeId) => !consumedCandidateNodeIds.includes(nodeId));
}

export function supervisorDagWorkKind(kind: SupervisorDagNodeKind): SupervisorDagWorkKind {
  if (kind === "test" || kind === "integration-test") return "test";
  if (kind === "review" || kind === "approval") return "audit";
  if (kind === "merge" || kind === "integration") return "integration";
  return "other";
}
