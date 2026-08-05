import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { EmployeeAvatar } from "./components";
import {
  DAG_NODE_HEIGHT,
  DAG_NODE_WIDTH,
  dagIssueTargetsNode,
  dagNodeKindLabels,
  layoutSupervisorDag,
  resolveDagPositions,
  type DagNodeDraft,
  type DagNodePositions
} from "./supervisorDag";
import type { Employee } from "./types";

const ROLE_ACCENTS = [
  "var(--season-winter)",
  "var(--season-spring)",
  "var(--season-rose)",
  "var(--seal-amber)",
  "var(--season-run)",
  "var(--seal-blue)"
];

function compactLabel(value: string, maximum = 24): string {
  if (value.length <= maximum) return value;
  const tail = 8;
  return `${value.slice(0, maximum - tail - 1)}…${value.slice(-tail)}`;
}

function roleAccent(roleId: string): string {
  let hash = 0;
  for (const character of roleId) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return ROLE_ACCENTS[Math.abs(hash) % ROLE_ACCENTS.length]!;
}

/**
 * Graph-style editor for the Supervisor-owned DAG. It only edits presentation.positions and
 * node.needs; scheduling remains entirely in the Supervisor runtime.
 */
export function SupervisorDagEditorCanvas({ nodes, positions, selectedIndex, issues = [], onSelect, onPositionsChange, onConnect, roleVisual }: {
  nodes: DagNodeDraft[];
  positions: DagNodePositions;
  selectedIndex?: number;
  issues?: string[];
  onSelect: (nodeIndex: number) => void;
  onPositionsChange: (positions: DagNodePositions) => void;
  onConnect: (sourceIndex: number, targetIndex: number) => void;
  roleVisual?: (roleId: string) => { displayName: string; presentation?: Employee["presentation"] } | undefined;
}) {
  const drag = useRef<{ nodeIndex: number; nodeId: string; clientX: number; clientY: number; x: number; y: number; active: boolean } | undefined>(undefined);
  const [connection, setConnection] = useState<{ sourceIndex: number; x: number; y: number }>();
  const resolved = useMemo(() => resolveDagPositions(nodes, positions), [nodes, positions]);
  const cyclic = useMemo(() => layoutSupervisorDag(nodes).cyclic, [nodes]);
  const width = Math.max(760, ...Object.values(resolved).map((position) => position.x + DAG_NODE_WIDTH + 72));
  const height = Math.max(400, ...Object.values(resolved).map((position) => position.y + DAG_NODE_HEIGHT + 48));

  const moveNode = (nodeId: string, x: number, y: number) => {
    onPositionsChange({
      ...resolved,
      [nodeId]: {
        x: Math.max(24, Math.min(width - DAG_NODE_WIDTH - 24, x)),
        y: Math.max(24, Math.min(height - DAG_NODE_HEIGHT - 24, y))
      }
    });
  };
  const keyMove = (event: KeyboardEvent<HTMLButtonElement>, nodeId: string) => {
    const delta = event.shiftKey ? 24 : 8;
    const position = resolved[nodeId];
    if (!position) return;
    if (event.key === "ArrowLeft") moveNode(nodeId, position.x - delta, position.y);
    else if (event.key === "ArrowRight") moveNode(nodeId, position.x + delta, position.y);
    else if (event.key === "ArrowUp") moveNode(nodeId, position.x, position.y - delta);
    else if (event.key === "ArrowDown") moveNode(nodeId, position.x, position.y + delta);
    else return;
    event.preventDefault();
  };
  const pointerDown = (event: PointerEvent<HTMLButtonElement>, nodeIndex: number, nodeId: string) => {
    const position = resolved[nodeId];
    if (!position) return;
    drag.current = { nodeIndex, nodeId, clientX: event.clientX, clientY: event.clientY, x: position.x, y: position.y, active: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* jsdom does not implement pointer capture */ }
    onSelect(nodeIndex);
  };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.nodeIndex !== Number(event.currentTarget.dataset.nodeIndex)) return;
    if (!drag.current.active) {
      if (Math.hypot(event.clientX - drag.current.clientX, event.clientY - drag.current.clientY) < 4) return;
      drag.current.active = true;
    }
    moveNode(drag.current.nodeId, drag.current.x + event.clientX - drag.current.clientX, drag.current.y + event.clientY - drag.current.clientY);
  };
  const beginConnection = (sourceIndex: number) => {
    const source = nodes[sourceIndex];
    const position = source ? resolved[source.nodeId] : undefined;
    if (!source || !position) return;
    setConnection({ sourceIndex, x: position.x + DAG_NODE_WIDTH, y: position.y + DAG_NODE_HEIGHT / 2 });
    onSelect(sourceIndex);
  };
  const finishConnection = (targetIndex: number) => {
    if (connection && connection.sourceIndex !== targetIndex) onConnect(connection.sourceIndex, targetIndex);
    setConnection(undefined);
  };

  if (nodes.length === 0) return <div className="canvas-empty">添加环节或填入示例骨架后开始编排 DAG。</div>;
  return <div className="workflow-canvas-scroll supervisor-dag-editor-scroll" aria-label="可拖动并连线的 Supervisor DAG 画布">
    <div
      className={`workflow-canvas-stage supervisor-dag-editor-stage ${cyclic ? "has-cycle" : ""}`}
      style={{ width, height }}
      onPointerMove={(event) => {
        if (!connection) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        setConnection({ ...connection, x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      }}
      onPointerUp={(event) => {
        if (!(event.target as Element).closest(".supervisor-dag-port--input")) setConnection(undefined);
      }}
      onPointerLeave={() => { if (connection) setConnection(undefined); }}
    >
      <svg className="workflow-canvas-edges" width={width} height={height} aria-hidden="true">
        <defs><marker id="supervisor-dag-editor-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>
        {nodes.flatMap((node, targetIndex) => node.needs.flatMap((need) => {
          const sourceIndex = nodes.findIndex((candidate) => candidate.nodeId === need);
          const from = resolved[need];
          const to = resolved[node.nodeId];
          if (!from || !to || need === node.nodeId) return [];
          const startX = from.x + DAG_NODE_WIDTH;
          const startY = from.y + DAG_NODE_HEIGHT / 2;
          const endX = to.x;
          const endY = to.y + DAG_NODE_HEIGHT / 2;
          const bend = Math.max(startX + 28, (startX + endX) / 2);
          return [<path className={selectedIndex === sourceIndex || selectedIndex === targetIndex ? "selected-edge" : ""} key={`${need}-${node.nodeId}`} d={`M${startX} ${startY} H${bend} V${endY} H${endX}`} markerEnd="url(#supervisor-dag-editor-arrow)" />];
        }))}
        {connection && (() => {
          const source = nodes[connection.sourceIndex];
          const from = source ? resolved[source.nodeId] : undefined;
          if (!from) return null;
          return <path className="connection-preview" d={`M${from.x + DAG_NODE_WIDTH} ${from.y + DAG_NODE_HEIGHT / 2} L${connection.x} ${connection.y}`} markerEnd="url(#supervisor-dag-editor-arrow)" />;
        })()}
      </svg>
      {nodes.map((node, index) => {
        const position = resolved[node.nodeId];
        if (!position) return null;
        const visual = roleVisual?.(node.roleId);
        const roleName = visual?.displayName;
        const assigneeName = roleName ?? (node.roleId || "未分派");
        const invalid = issues.some((issue) => dagIssueTargetsNode(issue, node.nodeId));
        return <div
          className={`supervisor-dag-editor-node supervisor-dag-editor-node--${node.kind} ${selectedIndex === index ? "selected" : ""} ${invalid ? "invalid" : ""}`}
          style={{ transform: `translate(${position.x}px, ${position.y}px)`, "--role-accent": visual?.presentation?.accent ?? roleAccent(node.roleId) } as CSSProperties}
          key={`${node.nodeId}-${index}`}
        >
          <button
            type="button"
            className="supervisor-dag-node-body"
            data-node-index={index}
            aria-label={`${node.nodeId || "未命名节点"}，${dagNodeKindLabels[node.kind]}，角色槽 ${node.roleId || "未分派"}。拖动或用方向键调整位置。`}
            onClick={() => onSelect(index)}
            onKeyDown={(event) => keyMove(event, node.nodeId)}
            onPointerDown={(event) => pointerDown(event, index, node.nodeId)}
            onPointerMove={pointerMove}
            onPointerUp={() => { drag.current = undefined; }}
            onPointerCancel={() => { drag.current = undefined; }}
          >
            <span className="supervisor-dag-editor-node-index">{String(index + 1).padStart(2, "0")}</span>
            <EmployeeAvatar
              className="small supervisor-dag-node-avatar"
              displayName={assigneeName}
              presentation={visual?.presentation}
              title={roleName ? `${roleName} · ${node.roleId}` : node.roleId || "未分派角色"}
            />
            <span className="supervisor-dag-editor-node-copy">
              <em className="supervisor-dag-editor-node-kind">{dagNodeKindLabels[node.kind]}{node.required ? "" : " · 可选"}</em>
              <strong>{compactLabel(node.nodeId || "未命名节点")}</strong>
              <small className="supervisor-dag-role-badge">{roleName ? <><b>{compactLabel(roleName, 12)}</b><span>· {compactLabel(node.roleId || "未分派", 14)}</span></> : compactLabel(node.roleId || "未分派", 18)}</small>
            </span>
            {invalid && <span className="supervisor-dag-node-error" title="此节点有待修正问题" aria-label="此节点有待修正问题">!</span>}
          </button>
          <button type="button" className="supervisor-dag-port supervisor-dag-port--input" aria-label={`连接到 ${node.nodeId || "未命名节点"}`} title="依赖输入：松开以建立连线" onPointerUp={(event) => { event.stopPropagation(); finishConnection(index); }} onClick={() => finishConnection(index)} />
          <button type="button" className={`supervisor-dag-port supervisor-dag-port--output ${connection?.sourceIndex === index ? "connecting" : ""}`} aria-label={`从 ${node.nodeId || "未命名节点"} 开始连线`} title="依赖输出：拖向下游节点左侧端口" onPointerDown={(event) => { event.stopPropagation(); beginConnection(index); }} onClick={(event) => { event.stopPropagation(); connection?.sourceIndex === index ? setConnection(undefined) : beginConnection(index); }} />
        </div>;
      })}
      {cyclic && <div className="canvas-cycle-warning" role="alert">检测到循环依赖；请断开冲突连线或在右侧检查器中修正。</div>}
      {connection && <div className="canvas-connect-hint" role="status">拖到下游节点左侧端口，或点击目标端口</div>}
    </div>
  </div>;
}
