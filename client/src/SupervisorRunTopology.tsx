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
  x: number;
  y: number;
  status: RunNode["status"];
}

export interface SupervisorRunLayout {
  width: number;
  height: number;
  nodes: SupervisorRunLayoutNode[];
  edges: Array<{ from: string; to: string }>;
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
      x: 40 + (round - 1) * ROUND_GAP,
      y: 136 + index * 86,
      status: member.node.status
    }));
  }
  const edges: Array<{ from: string; to: string }> = [];
  for (let round = 1; round <= rounds; round += 1) {
    const supervisor = layoutNodes.find((node) => node.round === round && node.kind === "supervisor");
    const members = layoutNodes.filter((node) => node.round === round && node.kind === "member");
    if (supervisor) members.forEach((member) => edges.push({ from: supervisor.id, to: member.id }));
    const nextSupervisor = layoutNodes.find((node) => node.round === round + 1 && node.kind === "supervisor");
    if (nextSupervisor) {
      (members.length ? members : supervisor ? [supervisor] : []).forEach((source) => edges.push({ from: source.id, to: nextSupervisor.id }));
    }
  }
  const memberPeak = Math.max(1, ...Array.from({ length: rounds }, (_, index) => layoutNodes.filter((node) => node.round === index + 1 && node.kind === "member").length));
  return { width: Math.max(680, rounds * ROUND_GAP + 80), height: 220 + (memberPeak - 1) * 86, nodes: layoutNodes, edges };
}

export function SupervisorRunTopology({ nodes }: { nodes: RunNode[] }) {
  const layout = layoutSupervisorRun(nodes);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  if (layout.nodes.length === 0) return <div className="mini-empty">领队运行尚未产生执行节点。</div>;
  return <div className="supervisor-run-topology-scroll"><svg className="supervisor-run-topology" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="领队运行时动态执行图">
    <defs><marker id="supervisor-run-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>
    {layout.edges.map((edge) => {
      const from = byId.get(edge.from)!;
      const to = byId.get(edge.to)!;
      const startX = from.x + NODE_WIDTH;
      const startY = from.y + 30;
      const endX = to.x;
      const endY = to.y + 30;
      const bend = startX === endX ? startX + 24 : (startX + endX) / 2;
      return <path key={`${edge.from}-${edge.to}`} className="supervisor-run-edge" d={`M${startX} ${startY} H${bend} V${endY} H${endX}`} markerEnd="url(#supervisor-run-arrow)" />;
    })}
    {layout.nodes.map((node) => <g key={node.id} className={`supervisor-run-node supervisor-run-node--${node.kind} status-${node.status}`} transform={`translate(${node.x} ${node.y})`}>
      <title>{`${node.kind === "supervisor" ? `领队 Round ${node.round}` : node.roleId} · ${node.id} · ${node.status}`}</title>
      <rect width={NODE_WIDTH} height="60" />
      <text x="12" y="21">{compactLabel(node.kind === "supervisor" ? `领队 · Round ${node.round}` : node.roleId, 18)}</text>
      <text x={NODE_WIDTH - 12} y="21" textAnchor="end" className="supervisor-run-node-status">{statusLabels[node.status]}</text>
      <text x="12" y="43" className="supervisor-run-node-id">{compactLabel(node.id)}</text>
    </g>)}
  </svg></div>;
}
