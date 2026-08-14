/** 看板各视图共享的加载 / 错误 / 离线 / 撤销反馈骨架。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PropsWithChildren, type ReactNode } from "react";
import { Stamp, useDaemonAvailable } from "../components";

export interface LoadState<T> {
  status: "loading" | "error" | "ready";
  data?: T;
  error?: string;
}

/** 区块级数据加载：序号牌防旧响应覆盖，重试走同一入口。 */
export function useServiceData<T>(loader: () => Promise<T>, deps: ReadonlyArray<unknown>, options: { enabled?: boolean } = {}): { state: LoadState<T>; reload: () => void; setData: (value: T) => void } {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const seq = useRef(0);
  const loaderRef = useRef(loader);
  const enabled = options.enabled ?? true;
  loaderRef.current = loader;
  const reload = useCallback(() => {
    const id = ++seq.current;
    setState({ status: "loading" });
    if (!enabled) return;
    loaderRef.current()
      .then((data) => { if (id === seq.current) setState({ status: "ready", data }); })
      .catch((error: unknown) => {
        if (id === seq.current) setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);
  // Close the interaction window before paint when a source revision changes.
  // This prevents consumers from briefly committing controls backed by the prior revision.
  useLayoutEffect(() => { reload(); }, [reload]);
  const setData = useCallback((value: T) => setState({ status: "ready", data: value }), []);
  return { state, reload, setData };
}

/** 加载态一律骨架块，不用 spinner。 */
export function SkeletonBlock({ rows = 3, label = "正在加载" }: { rows?: number; label?: string }) {
  return <div className="dash-skeleton" aria-busy="true">
    <span className="sr-only">{label}</span>
    {Array.from({ length: rows }, (_, index) => <i key={index} />)}
  </div>;
}

/** 区块级错误 + 重试，不清空页面其余部分。 */
export function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="dash-error" role="alert">
    <Stamp status="failed" label="加载失败" />
    <p>{message}</p>
    <button type="button" className="button secondary" onClick={onRetry}>重试</button>
  </div>;
}

/** Daemon 离线时：演示数据仍可浏览，写入一律禁用。 */
export function OfflineNotice() {
  const available = useDaemonAvailable();
  if (available) return null;
  return <div className="dash-offline" role="status">
    <Stamp status="blocked" label="离线只读" />
    <span>本地运行核心未连接 — 已加载的本地界面仍可浏览，新建 / 迁移 / 归档等写入暂不可用。</span>
  </div>;
}

/** 移动 / 收藏的乐观更新反馈：Toast 6s 内可撤销。 */
export const UNDO_TOAST_MS = 6000;

export function UndoToast({ message, onUndo, onClose }: { message: string; onUndo: () => void; onClose: () => void }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const timer = globalThis.setTimeout(() => closeRef.current(), UNDO_TOAST_MS);
    return () => globalThis.clearTimeout(timer);
  }, [message]);
  return <div className="toast toast--success undo-toast" role="status" aria-live="polite" aria-atomic="true">
    <span>{message}</span>
    <div className="toast-actions">
      <button type="button" onClick={onUndo}>撤销</button>
      <button type="button" onClick={onClose}>关闭</button>
    </div>
  </div>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="dash-header">
    <div><p>{eyebrow}</p><h1>{title}</h1>{description && <span>{description}</span>}</div>
    {actions && <div className="dash-header-actions">{actions}</div>}
  </header>;
}

export function SectionShell({ title, meta, children }: PropsWithChildren<{ title: string; meta?: ReactNode }>) {
  return <section className="dash-panel" aria-label={title}>
    <header className="dash-panel-head"><h2>{title}</h2>{meta}</header>
    {children}
  </section>;
}

/** 统一子 Tab 的 tab / tabpanel id 约定：调用方按这两个辅助函数渲染配对的 section[role=tabpanel]。 */
export const dashTabId = (baseId: string, tabId: string) => `${baseId}-tab-${tabId}`;
export const dashTabPanelId = (baseId: string, tabId: string) => `${baseId}-panel-${tabId}`;

export interface DashTab {
  id: string;
  label: string;
  /** 长标签被 ellipsis 截断时，完整名走 aria-label。 */
  ariaLabel?: string;
  disabled?: boolean;
  /** disabled 必须带文字原因（title 悬浮说明）。 */
  disabledReason?: string;
}

/** §三 · 统一子 Tab：标准 ARIA tablist；roving tabindex；ArrowLeft/Right 循环并即时激活（纯展示分段），
 *  Home/End 跳首末；方向键移动后 scrollIntoView({ block: "nearest", inline: "nearest" }) 防跳动；
 *  视觉（纸签贴纸激活态、容器内横滚）全部在 styles.css 的 .dash-tabs 区块。 */
export function DashTabs({ baseId, ariaLabel, tabs, activeTab, onChange }: {
  baseId: string;
  ariaLabel: string;
  tabs: DashTab[];
  activeTab: string;
  onChange: (tabId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const activate = (tab: DashTab) => {
    onChange(tab.id);
    const targetId = dashTabId(baseId, tab.id);
    const button = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']") ?? [])].find((candidate) => candidate.id === targetId);
    button?.focus();
    button?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = tabs.filter((tab) => !tab.disabled);
    if (enabled.length === 0) return;
    const currentIndex = Math.max(0, enabled.findIndex((tab) => tab.id === activeTab));
    let next: DashTab | undefined;
    if (event.key === "ArrowRight") next = enabled[(currentIndex + 1) % enabled.length];
    else if (event.key === "ArrowLeft") next = enabled[(currentIndex - 1 + enabled.length) % enabled.length];
    else if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled[enabled.length - 1];
    if (!next) return;
    event.preventDefault();
    activate(next);
  };
  return <div ref={listRef} className="dash-tabs" role="tablist" aria-label={ariaLabel} onKeyDown={handleKeyDown}>
    {tabs.map((tab) => <button
      key={tab.id}
      id={dashTabId(baseId, tab.id)}
      type="button"
      role="tab"
      aria-selected={tab.id === activeTab}
      aria-controls={dashTabPanelId(baseId, tab.id)}
      aria-label={tab.ariaLabel}
      tabIndex={tab.id === activeTab ? 0 : -1}
      disabled={tab.disabled}
      title={tab.disabled ? tab.disabledReason : undefined}
      onClick={() => activate(tab)}
    >{tab.label}</button>)}
  </div>;
}
