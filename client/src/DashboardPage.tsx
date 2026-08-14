import { formatTime } from "./components";
import { dashboardService, type DashboardService } from "./dashboard/service";
import type { DashboardSummary, Requirement } from "./dashboard/types";
import { ErrorBlock, PageHeader, SectionShell, SkeletonBlock, useServiceData } from "./dashboard/view";
import type { Bootstrap, InvocationRecord } from "./types";

type QueueItem = {
  id: string;
  status: string;
  title: string;
  next: string;
  meta: string[];
  hash: string;
  updatedAt: string;
};

const priority: Record<string, number> = {
  "awaiting-human-decision": 0,
  failed: 1,
  blocked: 2,
  "awaiting-acceptance": 3,
  running: 4
};

function invocationQueue(invocations: InvocationRecord[], bootstrap: Bootstrap): QueueItem[] {
  return invocations.flatMap((invocation) => {
    if (!(invocation.status in priority)) return [];
    const employeeIds = invocation.instanceIds
      .map((id) => bootstrap.activity.instances.find((instance) => instance.id === id)?.employeeId)
      .filter((id): id is string => Boolean(id));
    const projectId = invocation.source.targetProject ?? invocation.source.project;
    return [{
      id: invocation.id,
      status: invocation.status,
      title: invocation.requestSummary || invocation.taskDescription || "未命名工作",
      next: invocation.status === "awaiting-human-decision" ? "补充决策" : invocation.status === "running" ? "查看进度" : "查看错误并恢复",
      meta: [...new Set([...employeeIds.map((id) => `Employee ${id}`), ...(projectId ? [`Project ${projectId}`] : []), `${invocation.target.kind === "workflow" ? "Workflow" : "Employee"} ${invocation.target.id}`, `Run ${invocation.runId}`])],
      hash: `runs/${encodeURIComponent(invocation.runId)}`,
      updatedAt: invocation.updatedAt
    }];
  });
}

export function DashboardPage({ go, bootstrap, daemon, service = dashboardService }: {
  go: (hash: string) => void;
  bootstrap: Bootstrap;
  daemon: "checking" | "online" | "offline";
  service?: DashboardService;
}) {
  const { state, reload } = useServiceData<{ summary: DashboardSummary; requirements: Requirement[] }>(async () => {
    const [summary, requirements] = await Promise.all([service.getDashboardSummary(), service.listBoard()]);
    return { summary, requirements };
  }, [service]);

  return <main className="dash-page">
    <PageHeader eyebrow="NEXT ACTION / WORKBENCH" title="现在做什么" description="先处理需要你关注的工作，再从运行卷宗核对交付证据。" />
    {daemon === "offline" && <div className="dash-offline" role="status"><strong>当前为只读离线状态</strong><span>已保留的任务仍可查看；启动本地运行核心后可继续创建、运行和重试。</span></div>}
    {(daemon === "checking" || state.status === "loading") && <SkeletonBlock rows={5} label="正在整理继续工作队列" />}
    {state.status === "error" && <ErrorBlock message={state.error ?? "工作台加载失败"} onRetry={reload} />}
    {state.status === "ready" && state.data && (() => {
      const { summary, requirements } = state.data;
      const acceptance = requirements.filter((item) => item.lane === "acceptance" && !item.archivedAt).map((item): QueueItem => ({
        id: item.id, status: "awaiting-acceptance", title: item.title, next: "核对验收证据", meta: [`Project ${item.projectId}`, `Requirement ${item.code}`], hash: `requirements/${encodeURIComponent(item.id)}?section=acceptance`, updatedAt: item.updatedAt
      }));
      const queue = [...invocationQueue(bootstrap.activity.invocations, bootstrap), ...acceptance]
        .sort((a, b) => priority[a.status]! - priority[b.status]! || b.updatedAt.localeCompare(a.updatedAt));
      return <div className="task-dashboard">
        <SectionShell title="继续工作" meta={<span aria-live="polite">{queue.length} 项需要关注</span>}>
          {queue.length ? <ol className="continue-queue">
            {queue.map((item) => <li key={`${item.status}:${item.id}`}>
              <button type="button" onClick={() => go(item.hash)}>
                <span className={`queue-status queue-status--${item.status}`}>{item.status}</span>
                <strong>{item.title}</strong>
                <span className="queue-next">下一步：{item.next} →</span>
                <small>{item.meta.join(" · ")}</small>
              </button>
            </li>)}
          </ol> : <div className="getting-started">
            <div><strong>01 创建或完善员工</strong><span>准备一个能承担工作的成员档案。</span><button type="button" disabled={daemon !== "online"} onClick={() => go("employees")}>打开员工档案</button></div>
            <div><strong>02 接入项目</strong><span>告诉工作台代码在哪里、需要哪些职责。</span><button type="button" disabled={daemon !== "online"} onClick={() => go("projects")}>接入项目</button></div>
            <div><strong>03 启动团队或需求</strong><span>从需求看板发起一次真实工作。</span><button type="button" disabled={daemon !== "online"} onClick={() => go("board")}>打开需求看板</button></div>
            <div><strong>04 查看交付证据</strong><span>从 Run Receipt 核对输出、测试与状态变化。</span><button type="button" onClick={() => go("runs")}>查看运行卷宗</button></div>
          </div>}
        </SectionShell>
        <SectionShell title="概览与最近活动" meta={<span>{formatTime(summary.generatedAt)} 更新</span>}>
          <div className="dashboard-secondary-stats"><span>活跃项目 <strong>{summary.projects.active}</strong></span><span>进行中需求 <strong>{summary.requirements.active}</strong></span><span>异常 <strong>{summary.requirements.exceptions}</strong></span><span>待验收 <strong>{summary.tasks.acceptance}</strong></span></div>
          {summary.activities.length === 0 ? <p className="dash-empty-line">暂无活动记录。</p> : <ol className="dash-activity-list">{summary.activities.slice(0, 5).map((item) => <li key={item.id}><time>{formatTime(item.at)}</time><div><strong>{item.actor} · {item.action}</strong><span>{item.target} — {item.detail}</span></div></li>)}</ol>}
        </SectionShell>
      </div>;
    })()}
  </main>;
}
