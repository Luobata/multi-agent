/** 全局工作台：统计 / 任务 / 活动 / 资源（资源为演示数据，徽标由数据驱动）。 */
import { DemoBadge, RuntimeStatusChip, formatTime } from "./components";
import { dashboardService, type DashboardService } from "./dashboard/service";
import type { DashboardSummary } from "./dashboard/types";
import { REQUIREMENT_LANES } from "./dashboard/types";
import { ErrorBlock, OfflineNotice, PageHeader, SectionShell, SkeletonBlock, useServiceData } from "./dashboard/view";

export function DashboardPage({ go, service = dashboardService }: {
  go: (hash: string) => void;
  service?: DashboardService;
}) {
  const { state, reload } = useServiceData<DashboardSummary>(() => service.getDashboardSummary(), [service]);

  return <main className="dash-page">
    <PageHeader eyebrow="PROGRAM DESK / OVERVIEW" title="工作台" description="跨项目的研发状态总览：统计、任务、活动与资源占用。" />
    <OfflineNotice />
    {state.status === "loading" && <SkeletonBlock rows={4} label="正在加载工作台统计" />}
    {state.status === "error" && <ErrorBlock message={state.error ?? "加载失败"} onRetry={reload} />}
    {state.status === "ready" && state.data && (() => {
      const summary = state.data;
      return <div className="dash-grid">
        <SectionShell title="统计" meta={<span>{formatTime(summary.generatedAt)} 更新</span>}>
          <div className="dash-stat-grid">
            <div className="dash-stat"><span>活跃项目</span><strong>{summary.projects.active}</strong><small>归档 {summary.projects.archived} · 收藏 {summary.projects.favorites}</small></div>
            <div className="dash-stat"><span>进行中需求</span><strong>{summary.requirements.active}</strong><small>总计 {summary.requirements.total}</small></div>
            <div className="dash-stat"><span>异常态需求</span><strong>{summary.requirements.exceptions}</strong><small>阻塞 / 失败 / 取消</small></div>
            <div className="dash-stat"><span>待验收</span><strong>{summary.tasks.acceptance}</strong><small>排队 {summary.tasks.queued} · 执行 {summary.tasks.running} · 待确认 {summary.tasks.confirmation}</small></div>
          </div>
        </SectionShell>

        <SectionShell title="任务" meta={<button type="button" className="text-button" onClick={() => go("board")}>打开需求看板 →</button>}>
          <div className="dash-lane-strip" role="list">
            {REQUIREMENT_LANES.map((lane) => <button type="button" role="listitem" className="dash-lane-cell" key={lane.id} onClick={() => go("board")}>
              <span>{lane.label}</span>
              <strong>{summary.requirements.byLane[lane.id]}</strong>
            </button>)}
          </div>
        </SectionShell>

        <SectionShell title="活动" meta={<span>最近 {summary.activities.length} 条</span>}>
          {summary.activities.length === 0
            ? <p className="dash-empty-line">暂无活动记录；空间树与看板操作会记录在这里。</p>
            : <ol className="dash-activity-list">
              {summary.activities.map((item) => <li key={item.id}>
                <time>{formatTime(item.at)}</time>
                <div><strong>{item.actor} · {item.action}</strong><span>{item.target} — {item.detail}</span></div>
              </li>)}
            </ol>}
        </SectionShell>

        <SectionShell title="资源" meta={summary.resourceOverview.demo ? <DemoBadge /> : undefined}>
          <div className="dash-resource-list">
            {summary.resourceOverview.agents.map((agent) => <div className="dash-resource-row" key={agent.name}>
              <div><strong>{agent.name}</strong><span>{agent.role}</span></div>
              <div className="dash-resource-meter" role="meter" aria-label={`${agent.name} 负载 ${Math.round(agent.load * 100)}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(agent.load * 100)}>
                <i style={{ width: `${Math.round(agent.load * 100)}%` }} />
              </div>
              <code>{Math.round(agent.load * 100)}%</code>
            </div>)}
          </div>
          <p className="dash-hint-line"><RuntimeStatusChip status="idle" label="调度器未接入" /> 负载为演示数据，接入调度器后展示真实占用。</p>
        </SectionShell>
      </div>;
    })()}
  </main>;
}
