/** 归档中心：归档记录列表 + 恢复。恢复是安全操作，直接执行并回到空间树。 */
import { EmptyState, Stamp, formatTime, useDaemonAvailable } from "./components";
import { dashboardService, type DashboardService } from "./dashboard/service";
import type { ArchiveRecord } from "./dashboard/types";
import { ErrorBlock, OfflineNotice, PageHeader, SkeletonBlock, useServiceData } from "./dashboard/view";

export function ArchivePage({ go, notify, service = dashboardService }: {
  go: (hash: string) => void;
  notify: (message: string, kind?: "success" | "error") => void;
  service?: DashboardService;
}) {
  const daemonAvailable = useDaemonAvailable();
  const { state, reload, setData } = useServiceData<ArchiveRecord[]>(() => service.listArchive(), [service]);

  const records = state.status === "ready" ? state.data ?? [] : [];

  const restore = async (record: ArchiveRecord) => {
    try {
      const restored = await service.restoreArchived(record.id);
      setData(records.filter((candidate) => candidate.id !== record.id));
      notify(record.kind === "requirement" ? `「${record.name}」已恢复到原项目看板` : `「${record.name}」已恢复到空间树`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  return <main className="dash-page">
    <PageHeader eyebrow="ARCHIVE / RECOVERABLE" title="归档中心" description="文件夹与需求可恢复；已接入项目保留完整历史，恢复入口等待运行核心补齐。" actions={<button type="button" className="button secondary" onClick={() => go("projects")}>← 返回项目</button>} />
    <OfflineNotice />
    {state.status === "loading" && <SkeletonBlock rows={3} label="正在加载归档中心" />}
    {state.status === "error" && <ErrorBlock message={state.error ?? "加载失败"} onRetry={reload} />}
    {state.status === "ready" && records.length === 0 && <EmptyState title="归档中心是空的" action={<button type="button" className="button secondary" onClick={() => go("projects")}>前往项目</button>}>
      <p>归档的文件夹、项目与需求会列在这里，随时可恢复。</p>
    </EmptyState>}
    {state.status === "ready" && records.length > 0 && <ul className="archive-list" aria-label="归档记录">
      {records.map((record) => <li key={record.id} className="archive-row">
        <span className={`space-kind space-kind--${record.kind}`} aria-hidden="true">{record.kind === "folder" ? "夹" : record.kind === "project" ? "项" : "需"}</span>
        <div className="archive-main">
          <strong>{record.name}</strong>
          <span>{record.breadcrumb}</span>
          <small>归档于 {formatTime(record.archivedAt)} · 操作人 {record.archivedBy}</small>
        </div>
        <Stamp status="archived" />
        <button type="button" className="button secondary" disabled={!daemonAvailable || Boolean(record.restoreDisabledReason)} title={record.restoreDisabledReason} onClick={() => void restore(record)}>恢复</button>
        {record.restoreDisabledReason && <small className="archive-disabled-reason">{record.restoreDisabledReason}</small>}
      </li>)}
    </ul>}
  </main>;
}
