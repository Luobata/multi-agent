import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { EmployeeAvatar, UtilityIcon, formatTime } from "./components";
import type {
  Bootstrap,
  Employee,
  InvocationRecord,
  InvocationStatus,
  WorkInstanceRecord,
  WorkInstanceStatus
} from "./types";

interface OfficePageProps {
  data: Bootstrap;
  streamStatus: "connecting" | "live" | "reconnecting" | "offline";
}

const activeInstanceStatuses = new Set<WorkInstanceStatus>(["queued", "waiting", "running"]);

const statusLabels: Record<WorkInstanceStatus | InvocationStatus | "idle", string> = {
  idle: "空闲待命",
  queued: "排队中",
  waiting: "等待中",
  running: "工作中",
  completed: "已完成",
  blocked: "已阻塞",
  failed: "故障",
  skipped: "已跳过",
  cancelled: "已取消"
};

function runtimeState(instances: WorkInstanceRecord[]): WorkInstanceStatus | "idle" {
  if (instances.some((instance) => instance.status === "running")) return "running";
  if (instances.some((instance) => instance.status === "waiting")) return "waiting";
  if (instances.some((instance) => instance.status === "queued")) return "queued";
  return "idle";
}

function sourceName(instance: WorkInstanceRecord | InvocationRecord): string {
  const { source } = instance;
  if (source.project) return source.project;
  if (source.label) return source.label;
  if (source.kind === "a2a") return "A2A 会话";
  if (source.kind === "mcp") return "MCP 会话";
  if (source.kind === "workbench") return "本地调试台";
  return "HTTP 调用";
}

function sourceCode(instance: WorkInstanceRecord | InvocationRecord): string {
  const { source } = instance;
  return source.publicationId ? `PACKAGE / ${source.publicationId}` : source.kind.toUpperCase();
}

function elapsed(startedAt: string | undefined, completedAt: string | undefined, clock: number): string {
  if (!startedAt) return "尚未开始";
  const end = completedAt ? new Date(completedAt).getTime() : clock;
  const seconds = Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds < 3600 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function employeeRole(employee: Employee): string {
  return employee.identity.responsibilities[0] ?? employee.description;
}

function invocationInstances(invocation: InvocationRecord, instances: WorkInstanceRecord[]): WorkInstanceRecord[] {
  const ids = new Set(invocation.instanceIds);
  return instances.filter((instance) => ids.has(instance.id));
}

function RuntimeBadge({ status, count }: { status: WorkInstanceStatus | "idle"; count?: number }) {
  return <span className={`runtime-badge runtime-badge--${status}`}>
    <i aria-hidden="true" />
    {statusLabels[status]}{count && count > 1 ? ` ×${count}` : ""}
  </span>;
}

function WorkInstanceCard({ instance, invocation, clock }: {
  instance: WorkInstanceRecord;
  invocation?: InvocationRecord;
  clock: number;
}) {
  return <article className={`instance-card instance-card--${instance.status}`}>
    <header>
      <div><span>{sourceCode(instance)}</span><strong>{sourceName(instance)}</strong></div>
      <RuntimeBadge status={instance.status} />
    </header>
    <p>{invocation?.requestSummary ?? "调用上下文已固定到对应 Run。"}</p>
    <dl>
      <dt>流程 / 节点</dt><dd><code>{instance.workflowId} / {instance.nodeId}</code></dd>
      <dt>员工快照</dt><dd><code>{instance.employeeId} · v{instance.employeeVersion}</code></dd>
      <dt>Provider</dt><dd><code>{instance.providerId} · {instance.model ?? "默认模型"}</code></dd>
      <dt>调用方</dt><dd><code>{instance.source.caller ?? sourceName(instance)}</code></dd>
      <dt>上下文</dt><dd><code>{instance.source.contextId ?? instance.sessionId ?? "独立调用"}</code></dd>
      <dt>运行时间</dt><dd>{elapsed(instance.startedAt, instance.completedAt, clock)}</dd>
      <dt>Run</dt><dd><code>{instance.runId}</code></dd>
    </dl>
    {instance.error && <div className="instance-error">{instance.error}</div>}
    <footer>
      <span>{instance.phase}</span>
      <button type="button" onClick={() => { window.location.hash = "runs"; }}>查看运行证据 →</button>
    </footer>
  </article>;
}

function EmployeeActivityDrawer({ employee, data, clock, onClose }: {
  employee: Employee;
  data: Bootstrap;
  clock: number;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, []);
  const instances = data.activity.instances.filter((instance) => instance.employeeId === employee.id);
  const active = instances.filter((instance) => activeInstanceStatuses.has(instance.status));
  const state = runtimeState(active);
  return <div className="activity-drawer-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="employee-activity-drawer" role="dialog" aria-modal="true" aria-label={`${employee.identity.displayName} 实时工作台`}>
      <header className="activity-drawer-header">
        <div className={`drawer-avatar runtime-${state}`}><EmployeeAvatar displayName={employee.identity.displayName} presentation={employee.presentation} /></div>
        <div><p>EMPLOYEE LIVE CONSOLE</p><h2>{employee.identity.displayName}</h2><span>{employee.description}</span></div>
        <button type="button" className="icon-button" aria-label="关闭实时工作台" autoFocus onClick={onClose}><UtilityIcon name="close" /></button>
      </header>
      <section className="drawer-capacity">
        <RuntimeBadge status={state} count={active.length} />
        <div><span>当前出勤</span><strong>{active.length}</strong></div>
        <div><span>累计实例</span><strong>{instances.length}</strong></div>
        <div><span>当前档案</span><strong>v{employee.version}</strong></div>
      </section>
      <section className="drawer-model-strip">
        <span>启动配置</span><code>{employee.providerId}</code><code>{data.providers.find((provider) => provider.id === employee.providerId)?.definition.model ?? "默认模型"}</code>
      </section>
      <section className="drawer-instance-section">
        <header><div><span>01</span><h3>实时与最近出勤</h3></div><small>每次调用隔离上下文，共享员工身份快照</small></header>
        <div className="drawer-instance-list">
          {instances.length > 0 ? instances.slice(0, 20).map((instance) => <WorkInstanceCard
            key={instance.id}
            instance={instance}
            invocation={data.activity.invocations.find((invocation) => invocation.id === instance.invocationId)}
            clock={clock}
          />) : <div className="drawer-empty">尚无出勤记录。员工已在册，等待调用包或外部会话调度。</div>}
        </div>
      </section>
    </aside>
  </div>;
}

export function OfficePage({ data, streamStatus }: OfficePageProps) {
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>();
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeEmployees = data.employees.filter((employee) => employee.status === "active");
  const activeInstances = data.activity.instances.filter((instance) => activeInstanceStatuses.has(instance.status));
  const selected = data.employees.find((employee) => employee.id === selectedEmployeeId);
  const recentInvocations = useMemo(
    () => [...data.activity.invocations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 12),
    [data.activity.invocations]
  );

  return <main className="office-page">
    <header className="office-header">
      <div><p>OPERATIONS FLOOR / LIVE</p><h1>员工大厅</h1><span>这里负责打包与观测；任务主要由其他会话通过 MCP、A2A 或 HTTP 调用。</span></div>
      <div className="office-metrics">
        <div><span>在册员工</span><strong>{activeEmployees.length}</strong></div>
        <div className={activeInstances.length ? "metric-live" : ""}><span>出勤实例</span><strong>{activeInstances.length}</strong></div>
        <div><span>可调用包</span><strong>{data.publications.filter((publication) => publication.status === "active").length}</strong></div>
      </div>
    </header>

    <div className="office-layout">
      <section className="office-floor" aria-label="员工实时状态">
        <header className="office-floor-heading"><div><span>SHIFT A</span><h2>本地员工席位</h2></div><p className={`stream-${streamStatus}`}><i /> {streamStatus === "live" ? "实时状态流已连接" : streamStatus === "reconnecting" ? "状态流重连中" : streamStatus === "offline" ? "状态流离线" : "正在连接状态流"}</p></header>
        <div className="office-roster">
          {activeEmployees.map((employee, index) => {
            const instances = activeInstances.filter((instance) => instance.employeeId === employee.id);
            const state = runtimeState(instances);
            const latest = instances[0];
            const provider = data.providers.find((entry) => entry.id === employee.providerId);
            const packageCount = data.publications.filter((publication) => {
              if (publication.status !== "active") return false;
              if (publication.target.kind === "employee") return publication.target.id === employee.id;
              return data.workflows.find((workflow) => workflow.id === publication.target.id)?.nodes.some((node) => node.employeeId === employee.id);
            }).length;
            return <button
              type="button"
              className={`office-employee runtime-${state}`}
              key={employee.id}
              style={{ "--seat-index": index } as CSSProperties}
              onClick={() => setSelectedEmployeeId(employee.id)}
            >
              <div className="office-seat-top"><span>SEAT {String(index + 1).padStart(2, "0")}</span><RuntimeBadge status={state} count={instances.length} /></div>
              <div className="office-character-stage">
                <div className="office-character"><EmployeeAvatar displayName={employee.identity.displayName} presentation={employee.presentation} /></div>
                <i className="character-shadow" aria-hidden="true" />
                {instances.length > 1 && <span className="instance-count">×{instances.length}</span>}
                <div className="instance-tokens" aria-label={`${instances.length} 个工作实例`}>
                  {instances.slice(0, 4).map((instance) => <i key={instance.id} title={`${sourceName(instance)} · ${instance.nodeId}`} />)}
                </div>
              </div>
              <div className="office-employee-copy">
                <span>{employee.id} · v{employee.version}</span>
                <h3>{employee.identity.displayName}</h3>
                <p>{employeeRole(employee)}</p>
              </div>
              <div className="office-assignment">
                {latest ? <><span>{sourceCode(latest)}</span><strong>{sourceName(latest)}</strong><small>{latest.workflowId} / {latest.nodeId} · {elapsed(latest.startedAt, latest.completedAt, clock)}</small></> : <><span>STANDBY</span><strong>等待外部会话调度</strong><small>{packageCount} 个调用包可触达</small></>}
              </div>
              <footer><code>{employee.providerId}</code><code>{provider?.definition.model ?? "默认模型"}</code><span>查看实时台 →</span></footer>
            </button>;
          })}
          {activeEmployees.length === 0 && <div className="office-empty">没有在册员工。先在员工档案中建立身份，再将其发布成调用包。</div>}
        </div>
      </section>

      <aside className="dispatch-board" aria-label="实时调用记录">
        <header><div><p>INBOUND TRAFFIC</p><h2>调用调度板</h2></div><span className={streamStatus === "live" ? "live-lamp active" : "live-lamp"}>{streamStatus === "live" ? "LIVE" : "SYNC"}</span></header>
        <div className="dispatch-list">
          {recentInvocations.map((invocation) => {
            const children = invocationInstances(invocation, data.activity.instances);
            return <button type="button" key={invocation.id} className={`dispatch-ticket dispatch-ticket--${invocation.status}`} onClick={() => setSelectedEmployeeId(children[0]?.employeeId)}>
              <div className="dispatch-ticket-top"><span>{sourceCode(invocation)}</span><time>{formatTime(invocation.createdAt)}</time></div>
              <strong>{sourceName(invocation)}</strong>
              <p>{invocation.requestSummary}</p>
              <div className="dispatch-route"><code>{invocation.target.kind} / {invocation.target.id}</code><span>→</span><b>{children.length} 实例</b></div>
              <footer><span className={`ticket-status ticket-status--${invocation.status}`}><i />{statusLabels[invocation.status]}</span><code>{elapsed(invocation.startedAt, invocation.completedAt, clock)}</code></footer>
            </button>;
          })}
          {recentInvocations.length === 0 && <div className="dispatch-empty"><strong>线路安静</strong><p>从其他会话调用一个 Publication 后，这里会实时出现工单和员工出勤实例。</p></div>}
        </div>
      </aside>
    </div>

    {selected && <EmployeeActivityDrawer employee={selected} data={data} clock={clock} onClose={() => setSelectedEmployeeId(undefined)} />}
  </main>;
}
