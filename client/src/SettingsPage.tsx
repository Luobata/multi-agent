/** 设置 / 集成：第一阶段只读占位，快照全部来自 service adapter。 */
import { DemoBadge, ReadonlyEvidence, formatTime } from "./components";
import { dashboardService, type DashboardService } from "./dashboard/service";
import type { SettingsSnapshot } from "./dashboard/types";
import { ErrorBlock, OfflineNotice, PageHeader, SkeletonBlock, useServiceData } from "./dashboard/view";

export function SettingsPage({ service = dashboardService }: { service?: DashboardService }) {
  const { state, reload } = useServiceData<SettingsSnapshot>(() => service.getSettingsSnapshot(), [service]);

  return <main className="dash-page">
    <PageHeader eyebrow="SETTINGS / READ ONLY" title="设置·集成" description="第一阶段为只读占位：展示配置策略与集成状态，不提供编辑入口。" />
    <OfflineNotice />
    {state.status === "loading" && <SkeletonBlock rows={3} label="正在加载设置快照" />}
    {state.status === "error" && <ErrorBlock message={state.error ?? "加载失败"} onRetry={reload} />}
    {state.status === "ready" && state.data && <div className="dash-dossier">
      <p className="dash-hint-line">快照生成于 {formatTime(state.data.generatedAt)} · 全部内容只读。</p>
      {state.data.sections.map((section, index) => <section className="dash-panel" key={section.id} aria-label={section.title}>
        <header className="dash-panel-head">
          <h2>{String(index + 1).padStart(2, "0")} · {section.title}</h2>
          {section.id === "scheduler" && <DemoBadge />}
        </header>
        <p className="dash-hint-line">{section.description}</p>
        <div className="dash-settings-grid">
          {section.entries.map((entry) => <ReadonlyEvidence key={entry.label} label={entry.hint ? `${entry.label}（${entry.hint}）` : entry.label} value={entry.value} />)}
        </div>
      </section>)}
    </div>}
  </main>;
}
