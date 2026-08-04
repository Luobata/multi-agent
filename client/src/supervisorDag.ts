import type {
  SupervisorDagDefinition,
  SupervisorDagNode,
  SupervisorDagNodeKind,
  SupervisorFlowStage,
  SupervisorGate,
  SupervisorWorkKind
} from "./types";

export const DAG_NODE_KINDS: SupervisorDagNodeKind[] = ["task", "test", "merge", "integration", "integration-test", "other"];
export const DAG_WORK_KINDS: SupervisorWorkKind[] = ["discussion", "code", "test", "audit", "integration", "other"];

export const dagNodeKindLabels: Record<SupervisorDagNodeKind, string> = {
  task: "开发任务",
  test: "分支测试",
  merge: "合并",
  integration: "集成",
  "integration-test": "集成测试",
  other: "其他"
};

export const dagWorkKindLabels: Record<SupervisorWorkKind, string> = {
  discussion: "讨论",
  code: "编码",
  test: "测试",
  audit: "审计",
  integration: "集成",
  other: "其他"
};

export interface DagNodeDraft {
  nodeId: string;
  roleId: string;
  needs: string[];
  kind: SupervisorDagNodeKind;
  task: string;
  capabilitiesText: string;
  workKind: SupervisorWorkKind;
  changeSet: string;
  required: boolean;
}

export function defaultDagWorkKind(kind: SupervisorDagNodeKind): SupervisorWorkKind {
  if (kind === "test" || kind === "integration-test") return "test";
  if (kind === "merge" || kind === "integration") return "integration";
  return "other";
}

export function dagNodeDrafts(definition: SupervisorDagDefinition | undefined): DagNodeDraft[] {
  return (definition?.nodes ?? []).map((node) => ({
    nodeId: node.nodeId,
    roleId: node.roleId,
    needs: [...node.needs],
    kind: node.kind,
    task: node.task,
    capabilitiesText: node.requiredCapabilities.join(", "),
    workKind: node.workKind,
    changeSet: node.changeSet ?? "",
    required: node.required
  }));
}

/** Resolve semantic example slots from declared capabilities without depending on product-specific role names. */
export function scaffoldDagRoleIds(candidates: Array<{ roleId: string; capabilities: readonly string[] }>): string[] {
  const roleIds = candidates.map((candidate) => candidate.roleId.trim()).filter(Boolean);
  const capable = (capability: string): string | undefined => candidates.find((candidate) => candidate.capabilities.includes(capability))?.roleId.trim() || undefined;
  const frontend = capable("code.frontend") ?? roleIds[0] ?? "";
  const backend = capable("code.backend") ?? roleIds[1] ?? frontend;
  const tester = capable("quality.test") ?? roleIds[2] ?? backend;
  const integrator = capable("code.integration") ?? roleIds[3] ?? backend;
  return [frontend, backend, tester, integrator];
}

/** Branch → per-branch tests → merge → integration-test scaffold; the same tester role may be reused across test stages. */
export function scaffoldDagDrafts(memberRoleIds: string[]): DagNodeDraft[] {
  const [frontend = "", backend = frontend, tester = backend, integrator = backend] = memberRoleIds;
  return [
    { nodeId: "frontend-task", roleId: frontend, needs: [], kind: "task", task: "完成前端分支实现。", capabilitiesText: "code.frontend", workKind: "code", changeSet: "frontend", required: true },
    { nodeId: "backend-task", roleId: backend, needs: [], kind: "task", task: "完成后端分支实现。", capabilitiesText: "code.backend", workKind: "code", changeSet: "backend", required: true },
    { nodeId: "frontend-test", roleId: tester, needs: ["frontend-task"], kind: "test", task: "验证前端分支。", capabilitiesText: "quality.test", workKind: "test", changeSet: "", required: true },
    { nodeId: "backend-test", roleId: tester, needs: ["backend-task"], kind: "test", task: "验证后端分支。", capabilitiesText: "quality.test", workKind: "test", changeSet: "", required: true },
    { nodeId: "merge", roleId: integrator, needs: ["frontend-test", "backend-test"], kind: "merge", task: "合并通过测试的分支。", capabilitiesText: "code.integration", workKind: "integration", changeSet: "", required: true },
    { nodeId: "integration-test", roleId: tester, needs: ["merge"], kind: "integration-test", task: "验证合并后的整体。", capabilitiesText: "quality.test", workKind: "test", changeSet: "", required: true }
  ];
}

export function emptyDagNodeDraft(index: number, roleId: string): DagNodeDraft {
  return {
    nodeId: `node-${index}`,
    roleId,
    needs: [],
    kind: "task",
    task: "描述这一环节要完成的工作。",
    capabilitiesText: "",
    workKind: "other",
    changeSet: "",
    required: true
  };
}

function parseCapabilities(value: string): string[] {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

/** Deterministic client-side checks mirroring the daemon DAG contract; keeps save-time feedback local. */
export function supervisorDagDraftIssues(nodes: DagNodeDraft[], memberRoleIds: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  if (nodes.length === 0) {
    issues.push("启用 DAG 后至少需要一个节点");
    return issues;
  }
  const byId = new Map<string, DagNodeDraft>();
  for (const node of nodes) {
    const nodeId = node.nodeId.trim();
    if (!nodeId) issues.push("存在未填写 nodeId 的 DAG 节点");
    else if (!/^[a-z][a-z0-9-]*$/.test(nodeId)) issues.push(`DAG 节点 ${nodeId || "(空)"} 的 nodeId 需为小写短横线格式`);
    else if (byId.has(nodeId)) issues.push(`DAG 节点 nodeId 重复：${nodeId}`);
    else if (/^supervisor-r\d+$/.test(nodeId) || nodeId.startsWith("gate-")) issues.push(`DAG 节点 ${nodeId} 与运行时保留 ID 冲突`);
    if (!node.task.trim()) issues.push(`DAG 节点 ${nodeId || "(未命名)"} 缺少任务说明`);
    if (nodeId && !byId.has(nodeId)) byId.set(nodeId, node);
    if (!memberRoleIds.has(node.roleId)) issues.push(`DAG 节点 ${nodeId || "(未命名)"} 引用了不存在的成员角色 ${node.roleId || "(空)"}`);
    if (new Set(node.needs).size !== node.needs.length) issues.push(`DAG 节点 ${nodeId} 的依赖重复`);
    if (parseCapabilities(node.capabilitiesText).length !== new Set(parseCapabilities(node.capabilitiesText)).size) {
      issues.push(`DAG 节点 ${nodeId} 的 requiredCapabilities 重复`);
    }
  }
  for (const node of nodes) {
    const nodeId = node.nodeId.trim();
    for (const need of node.needs) {
      if (!byId.has(need)) issues.push(`DAG 节点 ${nodeId} 依赖了未知节点 ${need}`);
      if (need === nodeId) issues.push(`DAG 节点 ${nodeId} 不能依赖自身`);
    }
    if (node.kind === "merge") {
      if (node.needs.length < 2 || node.needs.some((need) => byId.get(need)?.kind !== "test")) {
        issues.push(`合并节点 ${nodeId} 必须直接依赖至少两个 test 节点`);
      }
    }
    if (node.kind === "integration-test" && !node.needs.some((need) => byId.get(need)?.kind === "merge")) {
      issues.push(`集成测试节点 ${nodeId} 必须直接依赖一个 merge 节点`);
    }
  }
  const remaining = new Set(byId.keys());
  while (remaining.size > 0) {
    const ready = [...remaining].filter((nodeId) => byId.get(nodeId)!.needs.every((need) => !remaining.has(need)));
    if (ready.length === 0) {
      issues.push(`DAG 存在循环依赖：${[...remaining].join(", ")}`);
      break;
    }
    for (const nodeId of ready) remaining.delete(nodeId);
  }
  return [...new Set(issues)];
}

/** Map a human-readable validation message back to its exact node without substring collisions. */
export function dagIssueTargetsNode(issue: string, nodeId: string): boolean {
  if (!nodeId) return issue === "存在未填写 nodeId 的 DAG 节点";
  if (issue === `DAG 节点 nodeId 重复：${nodeId}`) return true;
  if (issue.startsWith(`DAG 节点 ${nodeId} `)) return true;
  if (issue.startsWith(`DAG 节点 ${nodeId} 的`)) return true;
  if (issue.startsWith(`合并节点 ${nodeId} `)) return true;
  if (issue.startsWith(`集成测试节点 ${nodeId} `)) return true;
  if (!issue.startsWith("DAG 存在循环依赖：")) return false;
  return issue.slice("DAG 存在循环依赖：".length).split(", ").includes(nodeId);
}

export function dagPayloadFromDrafts(nodes: DagNodeDraft[]): SupervisorDagDefinition {
  return {
    nodes: nodes.map((node): SupervisorDagNode => ({
      nodeId: node.nodeId.trim(),
      roleId: node.roleId,
      needs: [...node.needs],
      kind: node.kind,
      task: node.task.trim(),
      requiredCapabilities: parseCapabilities(node.capabilitiesText),
      workKind: node.workKind,
      ...(node.changeSet.trim() ? { changeSet: node.changeSet.trim() } : {}),
      required: node.required
    }))
  };
}

export function flowStages(gates: SupervisorGate[]): SupervisorFlowStage[] {
  return [
    { id: "plan", kind: "supervisor", title: "领队计划" },
    { id: "delegation-loop", kind: "delegation-loop", title: "动态拆解与分工" },
    ...gates.map((gate): SupervisorFlowStage => ({ id: `gate-${gate.id}`, kind: "gate", title: gate.id, gateId: gate.id })),
    { id: "delivery", kind: "delivery", title: "领队交付" }
  ];
}

/** Save contract: existing stages/gates stay untouched; dag is appended only when enabled. */
export function buildSupervisorFlowPayload(
  gates: SupervisorGate[],
  dag?: SupervisorDagDefinition
): { stages: SupervisorFlowStage[]; gates: SupervisorGate[]; dag?: SupervisorDagDefinition } {
  return {
    stages: flowStages(gates),
    gates: gates.map((gate) => ({ ...gate })),
    ...(dag ? { dag } : {})
  };
}

/** Minimal shape the layered layout needs; drafts and persisted nodes both satisfy it. */
export type SupervisorDagLayoutInput = Pick<SupervisorDagNode, "nodeId" | "needs">;

export interface SupervisorDagLayoutNode<T extends SupervisorDagLayoutInput = SupervisorDagNode> {
  node: T;
  depth: number;
  row: number;
  x: number;
  y: number;
}

export interface SupervisorDagLayout<T extends SupervisorDagLayoutInput = SupervisorDagNode> {
  width: number;
  height: number;
  nodes: SupervisorDagLayoutNode<T>[];
  edges: Array<{ from: string; to: string }>;
  cyclic: boolean;
}

export const DAG_NODE_WIDTH = 216;
export const DAG_NODE_HEIGHT = 78;

/** Layered left-to-right layout so branch/fan-in/merge/integration-test stages read as distinct columns. */
export function layoutSupervisorDag<T extends SupervisorDagLayoutInput>(nodes: readonly T[]): SupervisorDagLayout<T> {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const depths = new Map<string, number>();
  let cyclic = false;
  const visit = (nodeId: string): number => {
    if (visiting.has(nodeId)) { cyclic = true; return 0; }
    if (visited.has(nodeId)) return depths.get(nodeId) ?? 0;
    visiting.add(nodeId);
    const node = byId.get(nodeId);
    const depth = node?.needs.length
      ? Math.max(...node.needs.map((need) => byId.has(need) ? visit(need) + 1 : 0))
      : 0;
    visiting.delete(nodeId);
    visited.add(nodeId);
    depths.set(nodeId, depth);
    return depth;
  };
  nodes.forEach((node) => visit(node.nodeId));

  const layers = new Map<number, T[]>();
  nodes.forEach((node) => {
    const depth = cyclic ? 0 : depths.get(node.nodeId) ?? 0;
    layers.set(depth, [...(layers.get(depth) ?? []), node]);
  });
  const maxDepth = Math.max(0, ...layers.keys());
  const maxRows = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const width = Math.max(560, (maxDepth + 1) * 268 + 72);
  const rowHeight = 112;
  const height = Math.max(240, maxRows * rowHeight + 72);
  const layoutNodes: SupervisorDagLayoutNode<T>[] = [];
  [...layers.entries()].sort(([a], [b]) => a - b).forEach(([depth, layer]) => {
    const layerHeight = layer.length * rowHeight;
    const startY = Math.max(36, (height - layerHeight) / 2 + 8);
    layer.forEach((node, row) => layoutNodes.push({
      node,
      depth,
      row,
      x: 36 + depth * 268,
      y: startY + row * rowHeight
    }));
  });
  const edges = nodes.flatMap((node) => node.needs.flatMap((need) => byId.has(need) ? [{ from: need, to: node.nodeId }] : []));
  return { width, height, nodes: layoutNodes, edges, cyclic };
}

/** Manual canvas positions keyed by nodeId; persisted as workflow presentation.positions. */
export type DagNodePositions = Record<string, { x: number; y: number }>;

/** Deterministic auto-layout positions for every DAG node; the fallback before any manual drag. */
export function automaticDagPositions(nodes: readonly SupervisorDagLayoutInput[]): DagNodePositions {
  return Object.fromEntries(layoutSupervisorDag(nodes).nodes.map((item) => [item.node.nodeId, { x: item.x, y: item.y }]));
}

/**
 * Resolve one position per current node: saved positions win, nodes without one fall back to the
 * deterministic layered layout, and stale ids (renamed/removed nodes) are pruned so the save payload
 * only carries positions for nodes that still exist.
 */
export function resolveDagPositions(nodes: readonly SupervisorDagLayoutInput[], positions: DagNodePositions): DagNodePositions {
  const fallback = automaticDagPositions(nodes);
  const resolved: DagNodePositions = {};
  for (const node of nodes) {
    if (!node.nodeId || resolved[node.nodeId]) continue;
    const saved = positions[node.nodeId];
    resolved[node.nodeId] = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
      ? saved
      : fallback[node.nodeId] ?? { x: 36, y: 36 };
  }
  return resolved;
}

/** Carry a manual position across a nodeId rename so the canvas does not jump back to auto layout. */
export function renameDagPosition(positions: DagNodePositions, oldId: string, newId: string): DagNodePositions {
  if (oldId === newId || !oldId || !positions[oldId]) return positions;
  const next = { ...positions };
  next[newId] = next[oldId]!;
  delete next[oldId];
  return next;
}
