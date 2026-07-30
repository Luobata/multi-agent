import { useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { DEFAULT_EMPLOYEE_ACCENT, EmployeeAvatar } from "./components";
import { layoutTopology } from "./topology";
import type { Employee, WorkflowNode } from "./types";

export type CanvasPositions = Record<string, { x: number; y: number }>;

export function automaticCanvasPositions(nodes: WorkflowNode[]): CanvasPositions {
  return Object.fromEntries(layoutTopology(nodes).nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
}

export function WorkflowCanvas({ nodes, employees, positions, selectedId, onSelect, onPositionsChange }: {
  nodes: WorkflowNode[];
  employees: Employee[];
  positions: CanvasPositions;
  selectedId?: string;
  onSelect: (nodeId: string) => void;
  onPositionsChange: (positions: CanvasPositions) => void;
}) {
  const drag = useRef<{ id: string; clientX: number; clientY: number; x: number; y: number; active: boolean } | undefined>(undefined);
  const fallback = useMemo(() => automaticCanvasPositions(nodes), [nodes]);
  const resolved = Object.fromEntries(nodes.map((node) => [node.id, positions[node.id] ?? fallback[node.id] ?? { x: 32, y: 32 }]));
  const width = Math.max(680, ...Object.values(resolved).map((position) => position.x + 230));
  const height = Math.max(380, ...Object.values(resolved).map((position) => position.y + 140));
  const cyclic = layoutTopology(nodes).cyclic;

  const moveNode = (nodeId: string, x: number, y: number) => {
    onPositionsChange({ ...resolved, [nodeId]: { x: Math.max(16, Math.min(width - 210, x)), y: Math.max(16, Math.min(height - 100, y)) } });
  };
  const keyMove = (event: KeyboardEvent<HTMLButtonElement>, nodeId: string) => {
    const delta = event.shiftKey ? 24 : 8;
    const position = resolved[nodeId]!;
    if (event.key === "ArrowLeft") moveNode(nodeId, position.x - delta, position.y);
    else if (event.key === "ArrowRight") moveNode(nodeId, position.x + delta, position.y);
    else if (event.key === "ArrowUp") moveNode(nodeId, position.x, position.y - delta);
    else if (event.key === "ArrowDown") moveNode(nodeId, position.x, position.y + delta);
    else return;
    event.preventDefault();
  };
  const pointerDown = (event: PointerEvent<HTMLButtonElement>, nodeId: string) => {
    const position = resolved[nodeId]!;
    drag.current = { id: nodeId, clientX: event.clientX, clientY: event.clientY, x: position.x, y: position.y, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(nodeId);
  };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.id !== event.currentTarget.dataset.nodeId) return;
    if (!drag.current.active) {
      if (Math.hypot(event.clientX - drag.current.clientX, event.clientY - drag.current.clientY) < 4) return;
      drag.current.active = true;
    }
    moveNode(drag.current.id, drag.current.x + event.clientX - drag.current.clientX, drag.current.y + event.clientY - drag.current.clientY);
  };

  if (nodes.length === 0) return <div className="canvas-empty">添加节点或应用模板后开始编排。</div>;
  return <div className="workflow-canvas-scroll" aria-label="可拖动 Workflow 画布">
    <div className={`workflow-canvas-stage ${cyclic ? "has-cycle" : ""}`} style={{ width, height }}>
      <svg className="workflow-canvas-edges" width={width} height={height} aria-hidden="true">
        <defs><marker id="canvas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>
        {nodes.flatMap((node) => node.needs.map((dependency) => {
          const from = resolved[dependency];
          const to = resolved[node.id];
          if (!from || !to) return null;
          const startX = from.x + 188;
          const startY = from.y + 38;
          const endX = to.x;
          const endY = to.y + 38;
          const bend = Math.max(startX + 28, (startX + endX) / 2);
          return <path key={`${dependency}-${node.id}`} d={`M${startX} ${startY} H${bend} V${endY} H${endX}`} markerEnd="url(#canvas-arrow)" />;
        }))}
      </svg>
      {nodes.map((node, index) => {
        const employee = employees.find((candidate) => candidate.id === node.employeeId);
        const position = resolved[node.id]!;
        return <button
          type="button"
          className={`workflow-canvas-node ${selectedId === node.id ? "selected" : ""}`}
          data-node-id={node.id}
          style={{ transform: `translate(${position.x}px, ${position.y}px)`, "--node-accent": employee?.presentation.accent ?? DEFAULT_EMPLOYEE_ACCENT } as React.CSSProperties}
          key={`${node.id}-${index}`}
          aria-label={`${node.id}，${employee?.identity.displayName ?? node.employeeId}。拖动或用方向键调整位置。`}
          onClick={() => onSelect(node.id)}
          onKeyDown={(event) => keyMove(event, node.id)}
          onPointerDown={(event) => pointerDown(event, node.id)}
          onPointerMove={pointerMove}
          onPointerUp={() => { drag.current = undefined; }}
          onPointerCancel={() => { drag.current = undefined; }}
        >
          <span className="canvas-node-index">{String(index + 1).padStart(2, "0")}</span>
          <EmployeeAvatar className="canvas-node-avatar" displayName={employee?.identity.displayName ?? node.employeeId} presentation={employee?.presentation} />
          <span className="canvas-node-copy"><strong>{node.id}</strong><small>{employee?.identity.displayName ?? node.employeeId}</small></span>
          <span className="canvas-node-port" aria-hidden="true" />
        </button>;
      })}
      {cyclic && <div className="canvas-cycle-warning" role="alert">检测到循环依赖；请在节点检查器中修正。</div>}
    </div>
  </div>;
}
