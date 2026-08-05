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

export interface SupervisorDagNodeConfig {
  nodeId: string;
  roleId: string;
  roleRef?: string;
  needs: string[];
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
      kind: tracker.node.kind,
      task: tracker.node.task,
      requiredCapabilities: tracker.node.requiredCapabilities,
      workKind: tracker.node.workKind,
      changeSet: tracker.node.changeSet ?? null,
      required: tracker.node.required,
      status: tracker.status,
      ready: tracker.status !== "passed"
        && tracker.node.needs.every((need) => trackers.get(need)?.status === "passed"),
      executions: tracker.executions.map((execution) => ({ ...execution }))
    }))
  };
}

export function supervisorDagWorkKind(kind: SupervisorDagNodeKind): SupervisorDagWorkKind {
  if (kind === "test" || kind === "integration-test") return "test";
  if (kind === "review" || kind === "approval") return "audit";
  if (kind === "merge" || kind === "integration") return "integration";
  return "other";
}
