import type { RunNode } from "./types";

const NODE_WIDTH = 184;
const ROUND_GAP = 270;

const statusLabels: Record<RunNode["status"], string> = {
  pending: "○ pending",
  running: "▶ running",
  passed: "✓ passed",
  blocked: "! blocked",
  failed: "× failed",
  skipped: "— skipped"
};

function compactLabel(value: string, maximum = 24): string {
  if (value.length <= maximum) return value;
  const tail = 7;
  return `${value.slice(0, maximum - tail - 1)}…${value.slice(-tail)}`;
}

export interface SupervisorRunLayoutNode {
  id: string;
  roleId: string;
  kind: "supervisor" | "member";
  round: number;
  flowNodeId?: string;
  flowNodeKind?: string;
  flowNodeExecution?: number;
  x: number;
  y: number;
  status: RunNode["status"];
}

export interface SupervisorRunLayoutEdge {
  from: string;
  to: string;
  /** dependency = durable consumed-artifact edge; delegation = this round's assignment; sequence = schematic round order. */
  kind: "dependency" | "delegation" | "sequence";
}

export interface SupervisorRunLayout {
  width: number;
  height: number;
  nodes: SupervisorRunLayoutNode[];
  edges: SupervisorRunLayoutEdge[];
  /**
   * "real" when at least one member carries durable dependency evidence
   * (metadata.dependencyNodeIds written by the Supervisor runtime). Otherwise the
   * round arrows are a schematic reading aid and must be labeled as such.
   */
  edgeMode: "real" | "schematic";
  rounds: number;
}

function metadataKind(node: RunNode): "supervisor" | "member" {
  return node.metadata?.kind === "member" ? "member" : "supervisor";
}

function metadataRound(node: RunNode): number {
  const value = node.metadata?.round;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  const match = /-r(\d+)/.exec(node.nodeId);
  return match?.[1] ? Number(match[1]) : 1;
}

interface DagFlowMetadata {
  flowNodeId?: string;
  flowNodeKind?: string;
  flowNodeExecution?: number;
}

/** DAG runs tag member nodes with the declared logical node; one role slot may own several distinct DAG nodes. */
function dagFlowMetadata(node: RunNode): DagFlowMetadata {
  const metadata = node.metadata;
  if (!metadata || metadata.kind !== "member") return {};
  return {
    ...(typeof metadata.flowNodeId === "string" ? { flowNodeId: metadata.flowNodeId } : {}),
    ...(typeof metadata.flowNodeKind === "string" ? { flowNodeKind: metadata.flowNodeKind } : {}),
    ...(typeof metadata.flowNodeExecution === "number" ? { flowNodeExecution: metadata.flowNodeExecution } : {})
  };
}

export function layoutSupervisorRun(nodes: RunNode[]): SupervisorRunLayout {
  const normalized = nodes.map((node) => ({ node, kind: metadataKind(node), round: metadataRound(node) }));
  const rounds = Math.max(1, ...normalized.map((item) => item.round));
  const layoutNodes: SupervisorRunLayoutNode[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const inRound = normalized.filter((item) => item.round === round);
    const supervisor = inRound.find((item) => item.kind === "supervisor");
    const members = inRound.filter((item) => item.kind === "member");
    if (supervisor) layoutNodes.push({
      id: supervisor.node.nodeId,
      roleId: supervisor.node.roleId,
      kind: "supervisor",
      round,
      x: 40 + (round - 1) * ROUND_GAP,
      y: 34,
      status: supervisor.node.status
    });
    members.forEach((member, index) => layoutNodes.push({
      id: member.node.nodeId,
      roleId: member.node.roleId,
      kind: "member",
      round,
      ...dagFlowMetadata(member.node),
      x: 40 + (round - 1) * ROUND_GAP,
      y: 136 + index * 86,
      status: member.node.status
    }));
  }
  const nodeIds = new Set(layoutNodes.map((node) => node.id));
  // Real dependency evidence: the Supervisor runtime records which execution nodes a
  // DAG member actually consumed (metadata.dependencyNodeIds). Dedupe and drop dangling
  // references so a partially persisted run can never draw an edge to nowhere.
  const dependencyEdges: SupervisorRunLayoutEdge[] = [];
  const seenDependency = new Set<string>();
  for (const item of normalized) {
    const raw = item.node.metadata?.dependencyNodeIds;
    if (!Array.isArray(raw)) continue;
    for (const value of raw) {
      if (typeof value !== "string" || value === item.node.nodeId || !nodeIds.has(value)) continue;
      const key = `${value}->${item.node.nodeId}`;
      if (seenDependency.has(key)) continue;
      seenDependency.add(key);
      dependencyEdges.push({ from: value, to: item.node.nodeId, kind: "dependency" });
    }
  }
  const edgeMode: SupervisorRunLayout["edgeMode"] = dependencyEdges.length > 0 ? "real" : "schematic";
  const edges: SupervisorRunLayoutEdge[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const supervisor = layoutNodes.find((node) => node.round === round && node.kind === "supervisor");
    const members = layoutNodes.filter((node) => node.round === round && node.kind === "member");
    if (supervisor) members.forEach((member) => edges.push({ from: supervisor.id, to: member.id, kind: "delegation" }));
    if (edgeMode === "schematic") {
      const nextSupervisor = layoutNodes.find((node) => node.round === round + 1 && node.kind === "supervisor");
      if (nextSupervisor) {
        (members.length ? members : supervisor ? [supervisor] : []).forEach((source) => edges.push({ from: source.id, to: nextSupervisor.id, kind: "sequence" }));
      }
    }
  }
  edges.push(...dependencyEdges);
  const memberPeak = Math.max(1, ...Array.from({ length: rounds }, (_, index) => layoutNodes.filter((node) => node.round === index + 1 && node.kind === "member").length));
  return { width: Math.max(680, rounds * ROUND_GAP + 80), height: 220 + (memberPeak - 1) * 86, nodes: layoutNodes, edges, edgeMode, rounds };
}

export function SupervisorRunTopology({ nodes }: { nodes: RunNode[] }) {
  const layout = layoutSupervisorRun(nodes);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  if (layout.nodes.length === 0) return <div className="mini-empty">领队运行尚未产生执行节点。</div>;
  const note = layout.edgeMode === "real"
    ? "实线＝真实依赖（按实际消费的执行节点）；虚线＝当轮委派关系。"
    : "示意布局：边仅表示轮次先后顺序，不代表真实依赖关系。";
  const ariaLabel = `领队运行时动态执行图：共 ${layout.rounds} 轮、${layout.nodes.length} 个节点，${layout.edgeMode === "real" ? "含真实依赖边" : "边为轮次示意"}；逐步状态见下方执行步骤表。`;
  return <div className="supervisor-run-topology-wrap">
    <p className={`supervisor-run-topology-note supervisor-run-topology-note--${layout.edgeMode}`}>{note}</p>
    <div className="supervisor-run-topology-scroll"><svg className="supervisor-run-topology" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={ariaLabel}>
    <defs><marker id="supervisor-run-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>
    {layout.edges.map((edge) => {
      const from = byId.get(edge.from)!;
      const to = byId.get(edge.to)!;
      const startX = from.x + NODE_WIDTH;
      const startY = from.y + 30;
      const endX = to.x;
      const endY = to.y + 30;
      const bend = startX === endX ? startX + 24 : (startX + endX) / 2;
      return <path key={`${edge.from}-${edge.to}-${edge.kind}`} className={`supervisor-run-edge supervisor-run-edge--${edge.kind}`} d={`M${startX} ${startY} H${bend} V${endY} H${endX}`} markerEnd="url(#supervisor-run-arrow)" />;
    })}
    {layout.nodes.map((node) => {
      const primaryLabel = node.kind === "supervisor" ? `领队 · Round ${node.round}` : node.flowNodeId ?? node.roleId;
      const secondaryLabel = node.kind === "supervisor"
        ? node.id
        : node.flowNodeId
          ? `${node.roleId} · ${node.flowNodeKind ?? "dag"}${node.flowNodeExecution && node.flowNodeExecution > 1 ? ` · 第 ${node.flowNodeExecution} 次执行` : ""}`
          : node.id;
      return <g key={node.id} className={`supervisor-run-node supervisor-run-node--${node.kind} status-${node.status}`} transform={`translate(${node.x} ${node.y})`}>
        <title>{`${node.kind === "supervisor" ? `领队 Round ${node.round}` : node.roleId}${node.flowNodeId ? ` · 环节 ${node.flowNodeId} [${node.flowNodeKind ?? "dag"}]` : ""} · ${node.id} · ${node.status}`}</title>
        <rect width={NODE_WIDTH} height="60" />
        <text x="12" y="21">{compactLabel(primaryLabel, 18)}</text>
        <text x={NODE_WIDTH - 12} y="21" textAnchor="end" className="supervisor-run-node-status">{statusLabels[node.status]}</text>
        <text x="12" y="43" className="supervisor-run-node-id">{compactLabel(secondaryLabel)}</text>
      </g>;
    })}
  </svg></div></div>;
}
