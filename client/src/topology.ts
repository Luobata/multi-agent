import type { WorkflowNode } from "./types.js";

export interface PositionedNode extends WorkflowNode {
  x: number;
  y: number;
  depth: number;
}

export interface TopologyLayout {
  width: number;
  height: number;
  nodes: PositionedNode[];
  edges: Array<{ from: PositionedNode; to: PositionedNode }>;
  cyclic: boolean;
}

export function layoutTopology(nodes: WorkflowNode[]): TopologyLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const depths = new Map<string, number>();
  let cyclic = false;

  const visit = (id: string): number => {
    if (visiting.has(id)) {
      cyclic = true;
      return 0;
    }
    if (visited.has(id)) return depths.get(id) ?? 0;
    visiting.add(id);
    const node = byId.get(id);
    const depth = node?.needs.length
      ? Math.max(...node.needs.map((dependency) => byId.has(dependency) ? visit(dependency) + 1 : 0))
      : 0;
    visiting.delete(id);
    visited.add(id);
    depths.set(id, depth);
    return depth;
  };
  nodes.forEach((node) => visit(node.id));

  const layers = new Map<number, WorkflowNode[]>();
  nodes.forEach((node) => {
    const depth = cyclic ? 0 : depths.get(node.id) ?? 0;
    layers.set(depth, [...(layers.get(depth) ?? []), node]);
  });
  const maxDepth = Math.max(0, ...layers.keys());
  const maxRows = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const width = Math.max(520, (maxDepth + 1) * 236 + 72);
  const height = Math.max(240, maxRows * 116 + 72);
  const positioned: PositionedNode[] = [];
  [...layers.entries()].sort(([a], [b]) => a - b).forEach(([depth, layer]) => {
    const layerHeight = layer.length * 116;
    const startY = Math.max(36, (height - layerHeight) / 2 + 10);
    layer.forEach((node, index) => positioned.push({
      ...node,
      depth,
      x: 36 + depth * 236,
      y: startY + index * 116
    }));
  });
  const positionedById = new Map(positioned.map((node) => [node.id, node]));
  const edges = positioned.flatMap((node) => node.needs.flatMap((dependency) => {
    const from = positionedById.get(dependency);
    return from ? [{ from, to: node }] : [];
  }));
  return { width, height, nodes: positioned, edges, cyclic };
}
