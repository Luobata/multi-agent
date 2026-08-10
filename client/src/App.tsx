import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ArchivePage } from "./ArchivePage";
import { BoardPage } from "./BoardPage";
import { DashboardPage } from "./DashboardPage";
import { EmployeePage } from "./EmployeePage";
import { KnowledgePage } from "./KnowledgePage";
import { MemoryPage } from "./MemoryPage";
import { DaemonGate, Icon, Modal } from "./components";
import { OfficePage } from "./OfficePage";
import { ProjectDetailPage } from "./ProjectDetailPage";
import { ProjectsHubPage } from "./ProjectsHubPage";
import { PublicationsPage } from "./PublicationsPage";
import { RequirementDetailPage } from "./RequirementDetailPage";
import { RunsPage } from "./RunsPage";
import { SettingsPage } from "./SettingsPage";
import { SkillsPage } from "./SkillsPage";
import { dashboardService } from "./dashboard/service";
import { ErrorBlock, SkeletonBlock } from "./dashboard/view";
import type { ActivityEvent, ActivitySnapshot, Bootstrap } from "./types";
import { WorkflowPage } from "./WorkflowPage";
import { applyTheme, DEFAULT_THEME, readTheme, type ThemeName } from "./theme";

type Page = "office" | "employees" | "projects" | "skills" | "knowledge" | "workflows" | "runs" | "publications" | "memory" | "dashboard" | "project" | "board" | "requirement" | "archive" | "settings";

export interface PageRoute {
  page: Page;
  spaceId?: string;
  requirementId?: string;
}

const TOP_LEVEL_PAGES: Page[] = ["office", "employees", "projects", "skills", "knowledge", "workflows", "runs", "publications", "memory", "dashboard", "board", "archive", "settings"];
const emptyBootstrap: Bootstrap = { providers: [], skills: [], knowledgeBases: [], knowledgeProfiles: [], architectureTemplates: [], gateValidators: [], employees: [], managementPolicies: [], entrancePolicies: [], workflows: [], sessions: [], publications: [], projects: [], projectBindings: [], activity: { invocations: [], instances: [] } };

/** 二级 hash：#projects/<id>、#projects/<id>/board、#requirements/<id>；旧 #spaces 路由兼容收敛到项目。 */
export function pageFromHash(hash = window.location.hash): PageRoute {
  const segments = hash.replace(/^#/, "").split("/").filter(Boolean);
  const [head, second, third] = segments;
  if ((head === "projects" || head === "spaces") && second) {
    return third === "board" ? { page: "board", spaceId: decodeURIComponent(second) } : { page: "project", spaceId: decodeURIComponent(second) };
  }
  if (head === "spaces") return { page: "projects" };
  if (head === "requirements" && second) return { page: "requirement", requirementId: decodeURIComponent(second) };
  return TOP_LEVEL_PAGES.includes(head as Page) ? { page: head as Page } : { page: "office" };
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) return [value, ...items];
  const next = [...items];
  next[index] = value;
  return next;
}

function mergeRecordsByRevision<T extends { id: string; updatedAt: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of incoming) byId.set(item.id, item);
  for (const item of current) {
    const existing = byId.get(item.id);
    if (!existing || item.updatedAt > existing.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/**
 * A bootstrap snapshot is older evidence than any live activity event that
 * arrived while its request was in flight, so keep the newer record per id.
 */
export function mergeActivity(current: ActivitySnapshot, incoming: ActivitySnapshot): ActivitySnapshot {
  return {
    invocations: mergeRecordsByRevision(current.invocations, incoming.invocations),
    instances: mergeRecordsByRevision(current.instances, incoming.instances)
  };
}

export function assertKnowledgeControlPlane(bootstrap: Bootstrap): void {
  if (!Array.isArray(bootstrap.knowledgeBases) || !Array.isArray(bootstrap.knowledgeProfiles)) {
    throw new Error("本地运行核心版本早于知识控制台，请重启 Workbench 后重试；现有知识和员工绑定不会丢失。");
  }
  if (!Array.isArray(bootstrap.entrancePolicies)) {
    throw new Error("本地运行核心版本早于工作启动策略，请重新构建并重启 Workbench 后重试；现有编排、策略和运行证据不会丢失。");
  }
}

export function AppNotice({ notice, onClose, onRetry }: {
  notice: { message: string; kind: "success" | "error" };
  onClose: () => void;
  onRetry?: () => void;
}) {
  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = noticeRef.current;
    if (!element || typeof element.showPopover !== "function") return;
    try {
      // A popover participates in the browser top layer, so feedback remains
      // visible above a native <dialog>. Unsupported browsers keep the fixed fallback.
      element.showPopover();
    } catch {
      // Rendering the notice is still useful when the Popover API is unavailable.
    }
    return () => {
      if (typeof element.hidePopover !== "function") return;
      try { element.hidePopover(); } catch { /* already hidden */ }
    };
  }, [notice.kind, notice.message]);

  return <div
    ref={noticeRef}
    className={`toast toast--${notice.kind}`}
    popover="manual"
    role={notice.kind === "error" ? "alert" : "status"}
    aria-live={notice.kind === "error" ? "assertive" : "polite"}
    aria-atomic="true"
  >
    <div className="toast-copy">
      <strong>{notice.kind === "error" ? "操作没有完成" : "操作已完成"}</strong>
      <span>{notice.message}</span>
    </div>
    {notice.kind === "error" && <div className="toast-actions">
      {onRetry && <button type="button" onClick={onRetry}>重新同步</button>}
      <button type="button" onClick={onClose}>关闭提示</button>
    </div>}
  </div>;
}

export function App() {
  const [route, setRoute] = useState<PageRoute>(pageFromHash);
  const page = route.page;
  const [data, setData] = useState<Bootstrap>(emptyBootstrap);
  const [daemon, setDaemon] = useState<"checking" | "online" | "offline">("checking");
  const [activityStream, setActivityStream] = useState<"connecting" | "live" | "reconnecting" | "offline">("connecting");
  const [notice, setNotice] = useState<{ message: string; kind: "success" | "error"; retryRefresh?: boolean }>();
  const [commandOpen, setCommandOpen] = useState(false);
  const [pendingRunId, setPendingRunId] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(() => (typeof window === "undefined" ? DEFAULT_THEME : readTheme()));
  useEffect(() => { applyTheme(theme); }, [theme]);
  const bootstrapRequestSeq = useRef(0);
  const bootstrapLoaded = useRef(false);

  const notify = useCallback((message: string, kind: "success" | "error" = "success") => {
    setNotice({ message, kind });
    if (kind === "success") {
      window.setTimeout(() => setNotice((current) => current?.message === message ? undefined : current), 4200);
    }
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++bootstrapRequestSeq.current;
    setSyncing(true);
    try {
      const bootstrap = await api<Bootstrap>("/api/bootstrap");
      if (seq !== bootstrapRequestSeq.current) return; // a newer navigation already superseded this response
      assertKnowledgeControlPlane(bootstrap);
      dashboardService.syncConnectedProjects(bootstrap.projects, bootstrap.passiveProjectAccesses ?? []);
      // Live SSE events that arrived while this request was in flight are newer
      // evidence than the snapshot: merge by id + updatedAt so they survive.
      setData((current) => ({ ...bootstrap, activity: mergeActivity(current.activity, bootstrap.activity) }));
      bootstrapLoaded.current = true;
      setDaemon("online");
    } catch (error) {
      if (seq !== bootstrapRequestSeq.current) return; // stale failures must not flip daemon state either
      // Only an app that never loaded a bootstrap goes read-only offline. A failed
      // background refresh keeps the data, the online daemon and the activity stream.
      if (!bootstrapLoaded.current) setDaemon("offline");
      throw error;
    } finally {
      if (seq === bootstrapRequestSeq.current) setSyncing(false);
    }
  }, []);

  const refreshQuietly = useCallback(() => {
    refresh().catch((error: unknown) => setNotice({
      message: error instanceof Error ? error.message : String(error),
      kind: "error",
      retryRefresh: true
    }));
  }, [refresh]);

  // First load and every page entry (side nav, command palette, browser back/forward)
  // fetch the latest bootstrap. navigate() and the hashchange listener agree on the
  // same page value, so React runs this effect exactly once per navigation.
  useEffect(() => { refreshQuietly(); }, [page, refreshQuietly]);
  useEffect(() => {
    if (daemon !== "online") { setActivityStream("offline"); return; }
    setActivityStream("connecting");
    const stream = new EventSource("/api/activity/stream");
    const receiveSnapshot = (event: MessageEvent<string>) => {
      const activity = JSON.parse(event.data) as ActivitySnapshot;
      setData((current) => ({ ...current, activity }));
      setActivityStream("live");
    };
    const receiveActivity = (event: MessageEvent<string>) => {
      const update = JSON.parse(event.data) as ActivityEvent;
      setData((current) => ({
        ...current,
        activity: update.type === "invocation.changed"
          ? { ...current.activity, invocations: upsertById(current.activity.invocations, update.invocation) }
          : { ...current.activity, instances: upsertById(current.activity.instances, update.instance) }
      }));
    };
    stream.addEventListener("snapshot", receiveSnapshot as EventListener);
    stream.addEventListener("activity", receiveActivity as EventListener);
    stream.onopen = () => setActivityStream("live");
    stream.onerror = () => setActivityStream("reconnecting");
    return () => stream.close();
  }, [daemon]);
  useEffect(() => {
    const update = () => setRoute(pageFromHash());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [page]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === "Escape") setCommandOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // Clicking the already-active tab is an explicit "give me fresh data" gesture.
  const navigate = (next: Page) => {
    if (next === page) { refreshQuietly(); return; }
    window.location.hash = next;
    setRoute({ page: next });
  };
  /** Dashboard 子路由（项目详情 / 项目看板 / 需求详情）只换 hash，由 hashchange 统一收编。 */
  const go = (hash: string) => { window.location.hash = hash; };
  const invocationRevision = data.activity.invocations.reduce((latest, invocation) => invocation.updatedAt > latest ? invocation.updatedAt : latest, "");
  const activityRevision = data.activity.instances.reduce((latest, instance) => instance.updatedAt > latest ? instance.updatedAt : latest, invocationRevision);
  const nav = [
    { id: "office" as const, label: "员工大厅", icon: "office" as const },
    { id: "dashboard" as const, label: "工作台", icon: "dashboard" as const },
    { id: "projects" as const, label: "项目", icon: "projects" as const },
    { id: "board" as const, label: "需求看板", icon: "board" as const },
    { id: "employees" as const, label: "员工档案", icon: "employees" as const },
    { id: "skills" as const, label: "技能台账", icon: "skills" as const },
    { id: "knowledge" as const, label: "知识控制台", icon: "knowledge" as const },
    { id: "workflows" as const, label: "协作编排", icon: "workflows" as const },
    { id: "runs" as const, label: "运行卷宗", icon: "runs" as const },
    { id: "memory" as const, label: "记忆档案", icon: "memory" as const },
    { id: "publications" as const, label: "调用包", icon: "publications" as const }
  ];
  const utilityNav = [
    { id: "archive" as const, label: "归档中心", icon: "archive" as const },
    { id: "settings" as const, label: "设置·集成", icon: "settings" as const }
  ];
  // 项目详情归入统一项目入口，需求详情归入需求看板。
  const activeNav: Page = page === "project" ? "projects" : page === "requirement" ? "board" : page;
  const [moreOpen, setMoreOpen] = useState(false);
  const commandItems = [...nav, ...utilityNav];

  return <div className={`app-shell app-shell--${page}`}>
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
      <filter id="crayon-edge" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.015" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.4" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
    <a className="skip-link" href="#main-content">跳到主内容</a>
    <header className={`daemon-strip daemon-strip--${daemon}`} aria-live="polite">
      <div><span className="daemon-dot" aria-hidden="true" /><strong>{daemon === "online" ? "小镇运行核心已连接" : daemon === "offline" ? "小镇运行核心未连接" : "正在核对小镇运行核心"}</strong><code>127.0.0.1 · LOOPBACK</code></div>
      <span>{daemon === "offline" ? "READ ONLY · 写入与运行暂不可用" : syncing ? "SYNCING · 正在同步最新档案" : "LOCAL GARDEN · EVIDENCE ON"}</span>
    </header>
    <nav className="side-nav" aria-label="主要导航">
      <div className="brand-mark"><span className="brand-sprite" aria-hidden="true"><i /></span><div><strong>双叶幼儿园</strong><small>CRAYON KINDERGARTEN DOSSIER</small></div></div>
      <div className="nav-items">{nav.map((item) => <button type="button" className={activeNav === item.id ? "active" : ""} aria-current={activeNav === item.id ? "page" : undefined} title={item.label} key={item.id} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</div>
      <div className="nav-items nav-utility">{utilityNav.map((item) => <button type="button" className={activeNav === item.id ? "active" : ""} aria-current={activeNav === item.id ? "page" : undefined} title={item.label} key={item.id} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</div>
      <button type="button" className="mobile-more" aria-expanded={moreOpen} onClick={() => setMoreOpen(true)}><Icon name="command" /><span>更多</span></button>
      <button type="button" className="command-hint" title="命令入口" onClick={() => setCommandOpen(true)}><Icon name="command" /><span>命令面板</span><kbd>⌘K</kbd></button>
      <button type="button" className="theme-toggle" onClick={() => setTheme(theme === "crayon" ? "pixel" : "crayon")} title={theme === "crayon" ? "切换到治愈像素主题" : "切换到蜡笔小新主题"} aria-label={theme === "crayon" ? "切换到治愈像素主题" : "切换到蜡笔小新主题"}><span className="theme-toggle-dot" aria-hidden="true" /><span>{theme === "crayon" ? "蜡笔小新" : "治愈像素"}</span><small>{theme === "crayon" ? "CRAYON" : "PIXEL"}</small></button>
      <div className="nav-foot"><span>KG</span><div><strong>Kindergarten Workbench</strong><small>班级在册 · A2A 1.0</small></div></div>
    </nav>
    <DaemonGate status={daemon}><div id="main-content" className="app-content" tabIndex={-1}>
      {page === "office" && <OfficePage data={data} streamStatus={activityStream} />}
      {page === "employees" && <EmployeePage data={data} refresh={refresh} notify={notify} />}
      {page === "projects" && (daemon === "online"
        ? <ProjectsHubPage data={data} refresh={refresh} go={go} notify={notify} />
        : daemon === "checking"
          ? <main className="dash-page"><SkeletonBlock rows={5} label="正在同步已接入项目" /></main>
          : <main className="dash-page"><ErrorBlock message="项目目录同步失败；请确认本地运行核心已启动后重试。" onRetry={refreshQuietly} /></main>)}
      {page === "skills" && <SkillsPage data={data} refresh={refresh} notify={notify} />}
      {page === "knowledge" && <KnowledgePage data={data} refresh={refresh} notify={notify} />}
      {page === "workflows" && <WorkflowPage data={data} refresh={refresh} notify={notify} />}
      {page === "runs" && <RunsPage notify={notify} activityRevision={activityRevision} pendingRunId={pendingRunId} onConsumePending={() => setPendingRunId("")} dashboard={dashboardService} />}
      {page === "memory" && <MemoryPage notify={notify} onOpenRun={(runId) => { setPendingRunId(runId); navigate("runs"); }} />}
      {page === "publications" && <PublicationsPage data={data} refresh={refresh} notify={notify} />}
      {page === "dashboard" && <DashboardPage go={go} />}
      {page === "project" && route.spaceId && <ProjectDetailPage spaceId={route.spaceId} go={go} notify={notify} catalogRevision={data.projects.map((project) => `${project.id}:${project.version}:${project.status}`).join("|")} />}
      {page === "board" && <BoardPage
        spaceId={route.spaceId}
        go={go}
        notify={notify}
        catalogRevision={data.projects.map((project) => `${project.id}:${project.version}:${project.status}`).join("|")}
        projects={data.projects}
        invocations={data.activity.invocations}
        onOpenRun={(runId) => { setPendingRunId(runId); navigate("runs"); }}
      />}
      {page === "requirement" && route.requirementId && <RequirementDetailPage
        requirementId={route.requirementId}
        go={go}
        notify={notify}
        projects={data.projects}
        entrancePolicies={data.entrancePolicies ?? []}
        workflows={data.workflows}
        managementPolicies={data.managementPolicies ?? []}
        invocations={data.activity.invocations}
        onOpenRun={(runId) => { setPendingRunId(runId); navigate("runs"); }}
      />}
      {page === "archive" && <ArchivePage go={go} notify={notify} />}
      {page === "settings" && <SettingsPage />}
    </div></DaemonGate>
    {notice && <AppNotice
      notice={notice}
      onClose={() => setNotice(undefined)}
      onRetry={notice.retryRefresh ? () => {
        setNotice(undefined);
        refreshQuietly();
      } : undefined}
    />}
    {commandOpen && <Modal title="命令面板" eyebrow="TOWN MENU · ⌘K" onClose={() => setCommandOpen(false)}><div className="command-list" onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
      const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
      const next = event.key === "ArrowDown" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>{commandItems.map((item, index) => <button type="button" key={item.id} onClick={() => { navigate(item.id); setCommandOpen(false); }}><Icon name={item.icon} /><strong>{item.label}</strong><kbd>{String(index + 1).padStart(2, "0")}</kbd></button>)}</div></Modal>}
    {moreOpen && <Modal title="更多功能" eyebrow="WORKBENCH · NAVIGATION" onClose={() => setMoreOpen(false)}>
      <div className="command-list mobile-more-list">{commandItems.slice(4).map((item) => <button type="button" key={item.id} onClick={() => { navigate(item.id); setMoreOpen(false); }}><Icon name={item.icon} /><strong>{item.label}</strong></button>)}</div>
    </Modal>}
  </div>;
}
