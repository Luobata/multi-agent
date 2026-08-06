import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "./api";
import { EmployeeAvatar, RuntimeStatusChip, UtilityIcon, employeeRuntimeStatus, formatTime } from "./components";
import { isSystemEmployee, systemEmployeeScope } from "./employeeAccess";
import { activeSupervisorInvocations, completionRatio, progressTone } from "./officeStudio";
import type {
  Bootstrap,
  Employee,
  InvocationProgress,
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

const phaseLabels: Record<string, string> = {
  provider: "Provider 执行中",
  "making-progress": "持续产生进展",
  "long-running": "长任务持续执行",
  "idle-timeout": "长时间无进展",
  "hard-timeout": "达到安全上限",
  retrying: "正在重试",
  done: "已结束",
  error: "执行失败",
  queued: "等待调度",
  waiting: "等待依赖",
  "waiting-session": "等待会话"
};

function phaseLabel(phase: string): string {
  return phaseLabels[phase] ?? phase;
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
  if (source.projectRole) return `PROJECT / ${source.projectRole}`;
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

function WorkInstanceCard({ instance, invocation, clock }: {
  instance: WorkInstanceRecord;
  invocation?: InvocationRecord;
  clock: number;
}) {
  return <article className={`instance-card instance-card--${instance.status}`}>
    <header>
      <div><span>{sourceCode(instance)}</span><strong>{sourceName(instance)}</strong></div>
      <RuntimeStatusChip status={instance.status} />
    </header>
    <p>{invocation?.requestSummary ?? "调用上下文已固定到对应 Run。"}</p>
    <dl>
      <dt>流程 / 节点</dt><dd><code>{instance.workflowId} / {instance.nodeId}</code></dd>
      <dt>员工快照</dt><dd><code>{instance.employeeId} · v{instance.employeeVersion}</code></dd>
      <dt>Provider</dt><dd><code>{instance.providerId} · {instance.model ?? "由 Provider 决定"}</code></dd>
      <dt>调用方</dt><dd><code>{instance.source.caller ?? sourceName(instance)}</code></dd>
      <dt>上下文</dt><dd><code>{instance.source.contextId ?? instance.sessionId ?? "独立调用"}</code></dd>
      <dt>运行时间</dt><dd>{elapsed(instance.startedAt, instance.completedAt, clock)}</dd>
      <dt>Run</dt><dd><code>{instance.runId}</code></dd>
    </dl>
    {instance.error && <div className="instance-error">{instance.error}</div>}
    {instance.status === "failed" && <div className="instance-evidence">
      <button type="button" className="instance-evidence-action" onClick={() => { window.location.hash = "runs"; }}>查看运行证据 →</button>
    </div>}
    <footer>
      <span>{phaseLabel(instance.phase)}</span>
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
  const state = employeeRuntimeStatus(instances, clock);
  return <div className="activity-drawer-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="employee-activity-drawer" role="dialog" aria-modal="true" aria-label={`${employee.identity.displayName} 实时工作台`}>
      <header className="activity-drawer-header">
        <div className={`drawer-avatar runtime-${state}`}><EmployeeAvatar displayName={employee.identity.displayName} presentation={employee.presentation} /></div>
        <div><p>EMPLOYEE LIVE CONSOLE</p><h2>{employee.identity.displayName}</h2><span>{employee.description}</span></div>
        <button type="button" className="icon-button" aria-label="关闭实时工作台" autoFocus onClick={onClose}><UtilityIcon name="close" /></button>
      </header>
      <section className="drawer-capacity">
        <RuntimeStatusChip status={state} count={active.length} />
        <div><span>当前出勤</span><strong>{active.length}</strong></div>
        <div><span>累计实例</span><strong>{instances.length}</strong></div>
        <div><span>当前档案</span><strong>v{employee.version}</strong></div>
      </section>
      <section className="drawer-model-strip">
        <span>启动配置</span><code>{employee.providerId}</code><code>{data.providers.find((provider) => provider.id === employee.providerId)?.definition.model ?? "由 Provider 决定"}</code>
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
  const [migrationNotice, setMigrationNotice] = useState("");
  const seenInstanceStatuses = useRef(new Map<string, WorkInstanceStatus>());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // Announce real status migrations only: keyed and deduped by instance id + status,
  // so the per-second elapsed-time clock never re-triggers a broadcast.
  useEffect(() => {
    const seen = seenInstanceStatuses.current;
    const names = new Map(data.employees.map((employee) => [employee.id, employee.identity.displayName]));
    const messages: string[] = [];
    for (const instance of data.activity.instances) {
      const previous = seen.get(instance.id);
      if (previous === instance.status) continue;
      seen.set(instance.id, instance.status);
      if (previous === undefined) continue; // first sighting is a snapshot, not a migration
      const name = names.get(instance.employeeId);
      if (!name) continue;
      messages.push(`${name} 的工作实例${statusLabels[instance.status]}`);
    }
    if (messages.length > 0) setMigrationNotice(messages.join("；"));
  }, [data.activity.instances, data.employees]);

  const activeEmployees = data.employees.filter((employee) => employee.status === "active");
  const externalEmployees = activeEmployees.filter((employee) => !isSystemEmployee(employee));
  const systemEmployees = activeEmployees.filter(isSystemEmployee);
  const activeInstances = data.activity.instances.filter((instance) => activeInstanceStatuses.has(instance.status));
  const selected = data.employees.find((employee) => employee.id === selectedEmployeeId);
  const recentInvocations = useMemo(
    () => [...data.activity.invocations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 12),
    [data.activity.invocations]
  );
  const [progressById, setProgressById] = useState<Record<string, InvocationProgress>>({});
  const activeSupervisors = useMemo(
    () => activeSupervisorInvocations(data.activity.invocations),
    [data.activity.invocations]
  );
  const activeSupervisorKey = activeSupervisors.map((invocation) => invocation.id).join(",");
  useEffect(() => {
    if (activeSupervisors.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      await Promise.all(activeSupervisors.map(async (invocation) => {
        try {
          const value = await api<InvocationProgress>(`/api/invocations/${encodeURIComponent(invocation.id)}/progress`);
          if (!cancelled) setProgressById((current) => ({ ...current, [invocation.id]: value }));
        } catch {
          // transient; next tick retries
        }
      }));
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeSupervisorKey]);
  const renderRoster = (employees: Employee[], systemLevel: boolean) => employees.map((employee, index) => {
    const employeeInstances = data.activity.instances.filter((instance) => instance.employeeId === employee.id);
    const active = employeeInstances.filter((instance) => activeInstanceStatuses.has(instance.status));
    const state = employeeRuntimeStatus(employeeInstances, clock);
    const terminalLatest = state === "failed" || state === "blocked" || state === "completed"
      ? [...employeeInstances].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
      : undefined;
    const latest = active[0] ?? terminalLatest;
    const provider = data.providers.find((entry) => entry.id === employee.providerId);
    const publicationCount = data.publications.filter((publication) => {
      if (publication.status !== "active") return false;
      if (publication.target.kind === "employee") return publication.target.id === employee.id;
      const workflow = data.workflows.find((candidate) => candidate.id === publication.target.id);
      return workflow?.architecture === "graph"
        ? workflow.nodes.some((node) => node.employeeId === employee.id)
        : workflow?.supervisor.employeeId === employee.id || workflow?.members.some((member) => member.employeeId === employee.id);
    }).length;
    const projectRoleCount = data.projectBindings.reduce(
      (count, projectBinding) => count + projectBinding.roles.filter((role) => role.employeeId === employee.id).length,
      0
    );
    const entryCount = systemLevel ? projectRoleCount : publicationCount + projectRoleCount;
    const scope = systemLevel ? systemEmployeeScope(employee) : undefined;
    return <button
      type="button"
      className={`office-employee${systemLevel ? " office-employee--system" : ""} runtime-${state}`}
      key={employee.id}
      style={{ "--seat-index": index } as CSSProperties}
      onClick={() => setSelectedEmployeeId(employee.id)}
    >
      <i className="seat-status-bar" aria-hidden="true" />
      <div className="office-seat-top"><span>{systemLevel ? "SYSTEM" : "SEAT"} {String(index + 1).padStart(2, "0")}</span>{systemLevel && <span className="system-level-badge">系统级</span>}<RuntimeStatusChip status={state} count={active.length} /></div>
      <div className="office-character-stage">
        <div className="office-character"><EmployeeAvatar displayName={employee.identity.displayName} presentation={employee.presentation} /></div>
        <i className="character-shadow" aria-hidden="true" />
        {active.length > 1 && <span className="instance-count">×{active.length}</span>}
        <div className="instance-tokens" aria-label={`${active.length} 个工作实例`}>
          {active.slice(0, 4).map((instance) => <i key={instance.id} title={`${sourceName(instance)} · ${instance.nodeId}`} />)}
        </div>
      </div>
      <div className="office-employee-copy">
        <span>{employee.id} · v{employee.version}</span>
        <h3>{employee.identity.displayName}</h3>
        <p>{employeeRole(employee)}</p>
      </div>
      <div className="office-assignment">
        {latest ? <><span>{sourceCode(latest)}</span><strong>{sourceName(latest)}</strong><small>{latest.status === "failed" ? `故障：${latest.error ?? "执行失败"} · 打开实时台查看运行证据` : `${latest.workflowId} / ${latest.nodeId} · ${elapsed(latest.startedAt, latest.completedAt, clock)}`}</small></> : systemLevel ? <><span>INTERNAL ONLY</span><strong>仅接受内部项目角色调度</strong><small>内部项目 {scope?.projectId}{scope?.roleId ? ` · 角色 ${scope.roleId}` : ""} · {entryCount} 个项目角色可触达</small></> : <><span>STANDBY</span><strong>等待外部会话调度</strong><small>{entryCount} 个项目/调用包入口可触达</small></>}
      </div>
      <footer><code>{employee.providerId}</code><code>{provider?.definition.model ?? "由 Provider 决定"}</code><span>查看实时台 →</span></footer>
    </button>;
  });

  return <main className="office-page">
    <header className="office-header">
      <div><p>OPERATIONS FLOOR / LIVE</p><h1>员工大厅</h1><span>外部可调用员工负责接单；系统级员工仅供内部项目角色调度与管理。</span></div>
      <div className="office-metrics">
        <div><span>外部员工</span><strong>{externalEmployees.length}</strong></div>
        <div><span>系统级员工</span><strong>{systemEmployees.length}</strong></div>
        <div className={activeInstances.length ? "metric-live" : ""}><span>出勤实例</span><strong>{activeInstances.length}</strong></div>
        <div><span>调用入口</span><strong>{data.publications.filter((publication) => publication.status === "active").length + data.projectBindings.reduce((count, binding) => count + binding.roles.length, 0)}</strong></div>
      </div>
    </header>

    <div className="office-layout">
      {activeSupervisors.length > 0 && <section className="office-studio" aria-label="团队作战室">
        <header className="office-studio-heading"><div><span>TEAM WAR ROOM</span><h2>领队工作室</h2></div><p>{activeSupervisors.length} 个团队正在运行</p></header>
        <div className="studio-grid">
          {activeSupervisors.map((invocation) => {
            const progress = progressById[invocation.id];
            const ratio = progress ? completionRatio(progress.tally) : 0;
            const tone = progressTone(invocation.status);
            const latestEntry = progress?.leaderReport.entries.at(-1);
            const leaderEmployeeId = invocation.executionSnapshot?.employees[0]?.employeeId;
            const leader = data.employees.find((employee) => employee.id === leaderEmployeeId);
            return <article key={invocation.id} className={`studio-card studio-card--${tone}`}>
              <header className="studio-card-head">
                <div><span>{invocation.executionSnapshot?.workflow.id ?? invocation.target.id}</span><strong>{invocation.requestSummary}</strong></div>
                <span className="studio-round">Round {progress?.round ?? invocation.executionSnapshot?.workflow.version ?? 1}</span>
              </header>
              <div className={`studio-progress ${tone === "running" ? "studio-progress--live" : ""}`}>
                <i className="studio-progress-fill" style={{ width: `${Math.round(ratio * 100)}%` }} aria-hidden="true" />
              </div>
              <div className="studio-progress-legend"><span>{Math.round(ratio * 100)}% 完成</span>{progress && <span>{progress.tally.completed}/{Object.values(progress.tally).reduce((sum, count) => sum + count, 0)} 步</span>}</div>
              {latestEntry && <p className="studio-leader-note"><code>{latestEntry.action.toUpperCase()}</code>{latestEntry.summary ?? "领队正在决策。"}</p>}
              <div className="studio-team">
                <div className="studio-leader"><EmployeeAvatar displayName={leader?.identity.displayName ?? leaderEmployeeId ?? "领队"} presentation={leader?.presentation} /><span>领队</span></div>
                <div className="studio-members">
                  {(latestEntry?.assignments ?? []).map((assignment, index) => {
                    const member = data.employees.find((employee) => employee.identity.displayName === assignment.roleId) ?? undefined;
                    return <div className="studio-member" key={`${assignment.roleId ?? "role"}-${index}`}><EmployeeAvatar className="small" displayName={assignment.roleId ?? "成员"} presentation={member?.presentation} /><small>{assignment.roleId}</small><span>{assignment.task ?? "待指派"}</span></div>;
                  })}
                  {(latestEntry?.assignments ?? []).length === 0 && <span className="studio-empty">领队尚未在本轮分派成员。</span>}
                </div>
              </div>
              {progress && progress.leaderReport.gates.length > 0 && <div className="studio-gates">{progress.leaderReport.gates.map((gate) => <span key={gate.gateId} className={`studio-gate studio-gate--${gate.status}`}>{gate.gateId} · {gate.status}</span>)}</div>}
            </article>;
          })}
        </div>
      </section>}
      <section className="office-floor" aria-label="员工实时状态">
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{migrationNotice}</p>
        <header className="office-floor-heading"><div><span>SHIFT A</span><h2>实时员工席位</h2></div><p className={`stream-${streamStatus}`}><i /> {streamStatus === "live" ? "实时状态流已连接" : streamStatus === "reconnecting" ? "状态流重连中" : streamStatus === "offline" ? "状态流离线" : "正在连接状态流"}</p></header>
        <section className="office-roster-section office-roster-section--external" aria-labelledby="office-external-heading">
          <header><div><span>EXTERNAL ROSTER</span><h3 id="office-external-heading">外部可调用员工</h3></div><p>可由直接交办、调用包、MCP、A2A 或全局编排触达</p></header>
          <div className="office-roster">{renderRoster(externalEmployees, false)}</div>
          {externalEmployees.length === 0 && <div className="office-empty">暂无外部可调用员工。可在员工档案中建立普通员工。</div>}
        </section>
        <section className="office-roster-section office-roster-section--system" aria-labelledby="office-system-heading">
          <header><div><span>INTERNAL CONTROL</span><h3 id="office-system-heading">系统级员工</h3></div><p>不能被外部直接调用，仅接受匹配的内部项目角色调度</p></header>
          <div className="office-roster">{renderRoster(systemEmployees, true)}</div>
          {systemEmployees.length === 0 && <div className="office-empty">暂无系统级员工。</div>}
        </section>
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
