import { dagNodeKindLabels, layoutSupervisorDag, DAG_NODE_HEIGHT, DAG_NODE_WIDTH } from "./supervisorDag";
import type { SupervisorDagDefinition, SupervisorDagNodeKind } from "./types";

function compactLabel(value: string, maximum = 26): string {
  if (value.length <= maximum) return value;
  const tail = 8;
  return `${value.slice(0, maximum - tail - 1)}…${value.slice(-tail)}`;
}

const KIND_ORDER: SupervisorDagNodeKind[] = ["task", "test", "merge", "integration", "integration-test", "other"];

export function SupervisorDagCanvas({ dag, roleDisplay }: {
  dag: SupervisorDagDefinition;
  /** Resolve a member role slot to a human name (e.g. bound Employee display name). */
  roleDisplay?: (roleId: string) => string | undefined;
}) {
  const layout = layoutSupervisorDag(dag.nodes);
  const byId = new Map(layout.nodes.map((item) => [item.node.nodeId, item]));
  const usedKinds = KIND_ORDER.filter((kind) => dag.nodes.some((node) => node.kind === kind));
  if (layout.nodes.length === 0) return <div className="mini-empty">DAG 尚未声明节点。</div>;
  return <div className="supervisor-dag" aria-label="声明式任务 DAG">
    <div className="supervisor-dag-legend" aria-hidden="true">
      {usedKinds.map((kind) => <span key={kind} className={`supervisor-dag-legend-item supervisor-dag-legend-item--${kind}`}>{dagNodeKindLabels[kind]}</span>)}
      {layout.cyclic && <span className="supervisor-dag-legend-item supervisor-dag-legend-item--cyclic">存在循环依赖</span>}
    </div>
    <div className="supervisor-dag-scroll"><svg className="supervisor-dag-canvas" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="任务 DAG：分支、汇合、合并与集成测试环节">
      <defs><marker id="supervisor-dag-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>
      {layout.edges.map((edge) => {
        const from = byId.get(edge.from)!;
        const to = byId.get(edge.to)!;
        const startX = from.x + DAG_NODE_WIDTH;
        const startY = from.y + DAG_NODE_HEIGHT / 2;
        const endX = to.x;
        const endY = to.y + DAG_NODE_HEIGHT / 2;
        const bend = startX === endX ? startX + 26 : (startX + endX) / 2;
        return <path key={`${edge.from}-${edge.to}`} className="supervisor-dag-edge" d={`M${startX} ${startY} H${bend} V${endY} H${endX}`} markerEnd="url(#supervisor-dag-arrow)" />;
      })}
      {layout.nodes.map((item) => {
        const node = item.node;
        const roleName = roleDisplay?.(node.roleId);
        const roleLine = roleName ? `${node.roleId} · ${roleName}` : node.roleId;
        return <g key={node.nodeId} className={`supervisor-dag-node supervisor-dag-node--${node.kind}`} transform={`translate(${item.x} ${item.y})`}>
          <title>{`${node.nodeId} · ${dagNodeKindLabels[node.kind]} · 角色槽 ${node.roleId}${roleName ? `（${roleName}）` : ""} · ${node.task}${node.required ? "" : " · 可选环节"}`}</title>
          <rect width={DAG_NODE_WIDTH} height={DAG_NODE_HEIGHT} />
          <text x="12" y="18" className="supervisor-dag-node-kind">{dagNodeKindLabels[node.kind]}{node.required ? "" : " · 可选"}</text>
          <text x="12" y="40" className="supervisor-dag-node-id">{compactLabel(node.nodeId)}</text>
          <text x="12" y="60" className="supervisor-dag-node-role">{compactLabel(roleLine, 28)}</text>
        </g>;
      })}
    </svg></div>
    <p className="supervisor-dag-note">同一角色槽可出现在多个环节：以上卡片按 nodeId 区分，角色槽只表示由谁执行。箭头为必须先行通过的依赖。</p>
  </div>;
}
