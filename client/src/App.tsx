import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { Breadcrumb, DaemonGate, Icon, Modal, type BreadcrumbItem } from "./components";
import { dashboardService } from "./dashboard/service";
import { ErrorBlock, SkeletonBlock } from "./dashboard/view";
import type { ActivityEvent, ActivitySnapshot, Bootstrap, HumanDecisionRequest } from "./types";
import { applyTheme, DEFAULT_THEME, readTheme, type ThemeName } from "./theme";
import { ActivityStreamContext, type ActivityStreamValue } from "./ActivityStream";

const ArchivePage = lazy(() => import("./ArchivePage").then((module) => ({ default: module.ArchivePage })));
const BoardPage = lazy(() => import("./BoardPage").then((module) => ({ default: module.BoardPage })));
const DashboardPage = lazy(() => import("./DashboardPage").then((module) => ({ default: module.DashboardPage })));
const EmployeePage = lazy(() => import("./EmployeePage").then((module) => ({ default: module.EmployeePage })));
const KnowledgePage = lazy(() => import("./KnowledgePage").then((module) => ({ default: module.KnowledgePage })));
const MemoryPage = lazy(() => import("./MemoryPage").then((module) => ({ default: module.MemoryPage })));
const OfficePage = lazy(() => import("./OfficePage").then((module) => ({ default: module.OfficePage })));
const ProjectDetailPage = lazy(() => import("./ProjectDetailPage").then((module) => ({ default: module.ProjectDetailPage })));
const ProjectsHubPage = lazy(() => import("./ProjectsHubPage").then((module) => ({ default: module.ProjectsHubPage })));
const PublicationsPage = lazy(() => import("./PublicationsPage").then((module) => ({ default: module.PublicationsPage })));
const RequirementDetailPage = lazy(() => import("./RequirementDetailPage").then((module) => ({ default: module.RequirementDetailPage })));
const RunsPage = lazy(() => import("./RunsPage").then((module) => ({ default: module.RunsPage })));
const SettingsPage = lazy(() => import("./SettingsPage").then((module) => ({ default: module.SettingsPage })));
const SkillsPage = lazy(() => import("./SkillsPage").then((module) => ({ default: module.SkillsPage })));
const WorkflowPage = lazy(() => import("./WorkflowPage").then((module) => ({ default: module.WorkflowPage })));

type Page = "office" | "employees" | "projects" | "skills" | "knowledge" | "workflows" | "runs" | "publications" | "memory" | "dashboard" | "project" | "board" | "requirement" | "archive" | "settings";

export interface PageRoute {
  page: Page;
  spaceId?: string;
  requirementId?: string;
  runId?: string;
  recordId?: string;
  section?: "overview" | "run" | "acceptance";
}

const TOP_LEVEL_PAGES: Page[] = ["office", "employees", "projects", "skills", "knowledge", "workflows", "runs", "publications", "memory", "dashboard", "board", "archive", "settings"];
const NAVIGATION_MEMORY_KEY = "local-agent-workbench.navigation.v1";
const SCROLL_MEMORY_PREFIX = "local-agent-workbench.scroll.v1:";
const emptyBootstrap: Bootstrap = { providers: [], skills: [], knowledgeBases: [], knowledgeProfiles: [], architectureTemplates: [], gateValidators: [], employees: [], managementPolicies: [], entrancePolicies: [], workflows: [], sessions: [], publications: [], projects: [], projectBindings: [], activity: { invocations: [], instances: [] } };

function navigationGroup(page: Page): Page {
  if (page === "project") return "projects";
  return page;
}

export function readNavigationMemory(storage: Pick<Storage, "getItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage): Partial<Record<Page, string>> {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(NAVIGATION_MEMORY_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([page, hash]) => {
      if (!TOP_LEVEL_PAGES.includes(page as Page) || typeof hash !== "string" || hash.length === 0) return false;
      // Older builds grouped requirement dossiers under the board navigation
      // memory. Reject those stale cross-route entries so the sidebar's board
      // button always opens an actual board.
      return navigationGroup(pageFromHash(`#${hash}`).page) === page;
    })) as Partial<Record<Page, string>>;
  } catch {
    return {};
  }
}

export function rememberNavigationHash(
  memory: Partial<Record<Page, string>>,
  route: PageRoute,
  hash: string,
  storage: Pick<Storage, "setItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage
): Partial<Record<Page, string>> {
  const group = navigationGroup(route.page);
  // Nested dossiers own their URL but never replace a top-level sidebar target.
  // This keeps requirement detail as a true sibling route instead of a remembered
  // board sub-view.
  if (!TOP_LEVEL_PAGES.includes(group)) return memory;
  const next = { ...memory, [group]: hash.replace(/^#/, "") || group };
  try { storage?.setItem(NAVIGATION_MEMORY_KEY, JSON.stringify(next)); } catch { /* private mode keeps in-memory navigation */ }
  return next;
}

/** 二级 hash：#projects/<id>、#projects/<id>/board、#requirements/<id>；旧 #spaces 路由兼容收敛到项目。 */
export function pageFromHash(hash = window.location.hash): PageRoute {
  const [path, query = ""] = hash.replace(/^#/, "").split("?", 2);
  const params = new URLSearchParams(query);
  const segments = path.split("/").filter(Boolean);
  const [head, second, third] = segments;
  if ((head === "projects" || head === "spaces") && second) {
    return third === "board" ? { page: "board", spaceId: decodeURIComponent(second) } : { page: "project", spaceId: decodeURIComponent(second) };
  }
  if (head === "spaces") return { page: "projects" };
  if (head === "requirements" && second) {
    const section = params.get("section");
    return { page: "requirement", requirementId: decodeURIComponent(second), ...(section === "overview" || section === "run" || section === "acceptance" ? { section } : {}) };
  }
  if (head === "runs") {
    const runId = second ? decodeURIComponent(second) : params.get("run");
    return { page: "runs", ...(runId ? { runId } : {}) };
  }
  return TOP_LEVEL_PAGES.includes(head as Page)
    ? { page: head as Page, ...(params.get("item") ? { recordId: params.get("item")! } : {}) }
    : { page: "dashboard" };
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
  const routeKey = [page, route.spaceId, route.requirementId, route.runId, route.recordId, route.section].map((part) => part ?? "").join("|");
  const previousRouteKey = useRef(routeKey);
  const mainContentRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Bootstrap>(emptyBootstrap);
  const [daemon, setDaemon] = useState<"checking" | "online" | "offline">("checking");
  const [activityStream, setActivityStream] = useState<"connecting" | "live" | "reconnecting" | "offline">("connecting");
  const [notice, setNotice] = useState<{ message: string; kind: "success" | "error"; retryRefresh?: boolean }>();
  const [commandOpen, setCommandOpen] = useState(false);
  const lastHashByPage = useRef<Partial<Record<Page, string>>>(readNavigationMemory());
  const [pendingRunId, setPendingRunId] = useState("");
  const studioOrigin = useRef<{ scrollY: number; cardRunId: string } | undefined>((() => {
    if (typeof window === "undefined") return undefined;
    try {
      const value = window.sessionStorage.getItem("workbench.studioRunOrigin");
      return value ? JSON.parse(value) as { scrollY: number; cardRunId: string } : undefined;
    } catch { return undefined; }
  })());
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
      dashboardService.syncConnectedProjects(bootstrap.projects, bootstrap.passiveProjectAccesses ?? [], {
        projectBindings: bootstrap.projectBindings,
        employees: bootstrap.employees,
        skills: bootstrap.skills,
        knowledgeProfiles: bootstrap.knowledgeProfiles ?? []
      });
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
    const initial = pageFromHash();
    lastHashByPage.current = rememberNavigationHash(lastHashByPage.current, initial, window.location.hash);
    const update = () => {
      const next = pageFromHash();
      lastHashByPage.current = rememberNavigationHash(lastHashByPage.current, next, window.location.hash);
      setRoute(next);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    if (previousRouteKey.current === routeKey) return;
    previousRouteKey.current = routeKey;
    const mainContent = mainContentRef.current;
    if (!mainContent) return;
    try {
      mainContent.focus({ preventScroll: true });
    } catch {
      // Older browsers only support the parameterless focus() overload.
      mainContent.focus();
    }
  }, [routeKey]);
  useEffect(() => {
    const hash = window.location.hash || "#dashboard";
    const key = `${SCROLL_MEMORY_PREFIX}${hash}`;
    let restored = 0;
    try { restored = Number(window.sessionStorage.getItem(key) ?? 0) || 0; } catch { /* keep the default */ }
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
    const restore = () => {
      if ((window.location.hash || "#dashboard") === hash) window.scrollTo({ top: restored, behavior: "auto" });
    };
    const frame = window.requestAnimationFrame(restore);
    // Dossiers load asynchronously; repeat after their height becomes available.
    const timers = [window.setTimeout(restore, 240), window.setTimeout(restore, 800)];
    let scheduled = false;
    const remember = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        try { window.sessionStorage.setItem(key, String(window.scrollY)); } catch { /* view memory is best-effort */ }
      });
    };
    window.addEventListener("scroll", remember, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("scroll", remember);
      try { window.sessionStorage.setItem(key, String(window.scrollY)); } catch { /* view memory is best-effort */ }
    };
  }, [page, route.spaceId, route.requirementId, route.runId, route.recordId, route.section]);
  useEffect(() => {
    if (page !== "office" || !studioOrigin.current) return;
    const origin = studioOrigin.current;
    studioOrigin.current = undefined;
    window.sessionStorage.removeItem("workbench.studioRunOrigin");
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: origin.scrollY, behavior: "auto" });
      const card = document.querySelector<HTMLElement>(`.studio-card[data-run-id="${origin.cardRunId}"]`);
      (card ?? document.querySelector<HTMLElement>("#office-studio-heading"))?.focus();
      if (!card) notify("原运行已移出当前工作室，可在运行卷宗继续查阅。", "success");
    });
  }, [page, data.activity.invocations, notify]);
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
    setSyncing(true);
    const target = lastHashByPage.current[next] ?? next;
    window.location.hash = target;
    setRoute(pageFromHash(`#${target}`));
  };
  /** Dashboard 子路由（项目详情 / 项目看板 / 需求详情）只换 hash，由 hashchange 统一收编。 */
  const go = (hash: string) => { window.location.hash = hash; };
  const invocationRevision = data.activity.invocations.reduce((latest, invocation) => invocation.updatedAt > latest ? invocation.updatedAt : latest, "");
  const activityRevision = data.activity.instances.reduce((latest, instance) => instance.updatedAt > latest ? instance.updatedAt : latest, invocationRevision);
  // Requirement cards are a browser-local projection, but Invocation activity is
  // durable. Reconcile it at the App boundary so terminal/decision changes are not
  // dependent on the Board page being mounted.
  useEffect(() => {
    if (daemon !== "online" || !invocationRevision) return;
    let current = true;
    void dashboardService.listBoard().then(async (requirements) => {
      const invocationById = new Map(data.activity.invocations.map((invocation) => [invocation.id, invocation]));
      const work = requirements.flatMap((requirement) => {
        const advancement = requirement.advancement;
        if (!advancement?.invocationId) return [];
        const prior = invocationById.get(advancement.invocationId);
        if (!prior) return [];
        const successor = ["blocked", "failed", "cancelled"].includes(advancement.status)
          ? data.activity.invocations
              .filter((candidate) => candidate.id !== prior.id
                && candidate.source.project === prior.source.project
                && candidate.source.taskId === prior.source.taskId
                && candidate.source.contextId === prior.source.contextId
                && candidate.createdAt > prior.createdAt)
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
          : undefined;
        const invocation = successor ?? prior;
        if (invocation.id === advancement.invocationId && invocation.status === advancement.status) return [];
        return [dashboardService.syncRequirementAdvancement(requirement.id, advancement.idempotencyKey, {
          invocationId: invocation.id,
          runId: invocation.runId,
          leaderSessionId: invocation.sessionId,
          status: invocation.status,
          observedAt: invocation.updatedAt,
          error: invocation.error,
          ...(invocation.id !== advancement.invocationId ? { replacesInvocationId: advancement.invocationId } : {})
        }, 15_000)];
      });
      const results = await Promise.allSettled(work);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (current && failed) notify(`需求状态自动同步失败：${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}`, "error");
    }).catch((error: unknown) => {
      if (current) notify(`需求状态自动同步失败：${error instanceof Error ? error.message : String(error)}`, "error");
    });
    return () => { current = false; };
  }, [daemon, invocationRevision, data.activity.invocations, notify]);
  const awaitingDecisionRevision = data.activity.invocations
    .filter((invocation) => invocation.status === "awaiting-human-decision")
    .map((invocation) => `${invocation.id}:${invocation.updatedAt}`)
    .sort()
    .join("|");
  useEffect(() => {
    if (daemon !== "online" || !awaitingDecisionRevision) return;
    let current = true;
    api<HumanDecisionRequest[]>("/api/human-decision-requests")
      .then((requests) => {
        if (current) setData((snapshot) => ({ ...snapshot, humanDecisionRequests: requests }));
      })
      .catch(() => {
        // Invocation state still keeps the board correct; decision metadata is progressive disclosure.
      });
    return () => { current = false; };
  }, [awaitingDecisionRevision, daemon]);
  const pendingDecisionInvocations = data.activity.invocations
    .filter((invocation) => invocation.status === "awaiting-human-decision")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const pendingDecisionCount = pendingDecisionInvocations.length;
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
  const topLabel = page === "employees" ? "员工档案" : page === "projects" ? "项目" : page === "skills" ? "Skills" : page === "workflows" ? "协作编排" : page === "runs" ? "运行卷宗" : page === "publications" ? "调用包" : nav.find((item) => item.id === page)?.label ?? page;
  const recordLabel = route.recordId && (page === "employees" ? data.employees.find((item) => item.id === route.recordId)?.identity.displayName : page === "skills" ? data.skills.find((item) => item.id === route.recordId)?.displayName : page === "publications" ? data.publications.find((item) => item.id === route.recordId)?.name : route.recordId);
  const projectLabel = route.spaceId && data.projects.find((item) => item.id === route.spaceId)?.name;
  const breadcrumbItems: BreadcrumbItem[] = page === "project"
    ? [{ label: "项目", href: "#projects" }, { label: projectLabel ?? route.spaceId!, current: true }]
    : page === "board" ? [{ label: "项目", href: "#projects" }, { label: projectLabel ?? route.spaceId ?? "项目不可用", ...(route.spaceId ? { href: `#projects/${encodeURIComponent(route.spaceId)}` } : { unavailableReason: "缺少项目 ID" }) }, { label: "需求看板", current: true }]
    : page === "requirement" ? [{ label: "项目", href: "#projects" }, { label: "项目不可用", unavailableReason: "需求数据尚未提供所属项目" }, { label: "需求看板", unavailableReason: "无法确定所属项目的需求看板" }, { label: route.requirementId!, current: true }]
    : page === "runs" && route.runId ? [{ label: topLabel, href: "#runs" }, { label: route.runId, current: true }]
    : route.recordId && ["employees", "skills", "workflows", "publications"].includes(page) ? [{ label: topLabel, href: `#${page}` }, { label: recordLabel ?? route.recordId, current: true }]
    : [{ label: topLabel, current: true }];

  // 共享 SSE 快照通过 context 下发；memo 避免无关渲染（通知、弹窗）波及所有消费方。
  const activityStreamValue = useMemo<ActivityStreamValue>(
    () => ({ activity: data.activity, status: activityStream }),
    [data.activity, activityStream]
  );

  return <ActivityStreamContext.Provider value={activityStreamValue}><div className={`app-shell app-shell--${page}`}>
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
      <filter id="crayon-edge" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.015" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.4" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
    <a className="skip-link" href="#main-content">跳到主内容</a>
    <header className={`daemon-strip daemon-strip--${daemon}`} aria-live="polite">
      <div><span className="daemon-dot" aria-hidden="true" /><strong>{daemon === "online" ? "本地运行核心已连接" : daemon === "offline" ? "本地运行核心未连接" : "正在核对本地运行核心"}</strong><code>127.0.0.1 · LOOPBACK</code></div>
      <span>{daemon === "offline" ? "READ ONLY · 写入与运行暂不可用" : syncing ? "SYNCING · 正在同步最新档案" : "LOCAL GARDEN · EVIDENCE ON"}</span>
    </header>
    <DaemonGate status={daemon}><div ref={mainContentRef} id="main-content" className="app-content" tabIndex={-1}>
      <Breadcrumb items={breadcrumbItems} />
      <Suspense fallback={<main className="dash-page" aria-live="polite"><SkeletonBlock rows={5} label="正在打开档案页面" /></main>}>
      {page === "office" && <OfficePage data={data} streamStatus={activityStream} onOpenRun={(runId) => {
        studioOrigin.current = { scrollY: window.scrollY, cardRunId: runId };
        window.sessionStorage.setItem("workbench.studioRunOrigin", JSON.stringify(studioOrigin.current));
        setPendingRunId(runId);
        window.location.hash = `runs/${encodeURIComponent(runId)}`;
      }} />}
      {page === "employees" && <EmployeePage data={data} refresh={refresh} notify={notify} focusedEmployeeId={route.recordId} onSelectEmployee={(employeeId) => go(`employees?item=${encodeURIComponent(employeeId)}`)} />}
      {page === "projects" && (daemon === "online"
        ? <ProjectsHubPage data={data} refresh={refresh} go={go} notify={notify} />
        : daemon === "checking"
          ? <main className="dash-page"><SkeletonBlock rows={5} label="正在同步已接入项目" /></main>
          : <main className="dash-page"><ErrorBlock message="项目目录同步失败；请确认本地运行核心已启动后重试。" onRetry={refreshQuietly} /></main>)}
      {page === "skills" && <SkillsPage data={data} refresh={refresh} notify={notify} />}
      {page === "knowledge" && <KnowledgePage data={data} refresh={refresh} notify={notify} />}
      {page === "workflows" && <WorkflowPage data={data} refresh={refresh} notify={notify} />}
      {page === "runs" && <RunsPage notify={notify} activityRevision={activityRevision} focusedRunId={route.runId} pendingRunId={route.runId ?? pendingRunId} onConsumePending={() => setPendingRunId("")} onSelectRun={(runId) => go(`runs/${encodeURIComponent(runId)}`)} onOpenRequirement={(requirementId, section = "overview") => go(`requirements/${encodeURIComponent(requirementId)}${section === "overview" ? "" : `?section=${section}`}`)} dashboard={dashboardService} fromStudio={Boolean(studioOrigin.current && (route.runId ?? pendingRunId))} onReturnOffice={() => { if (studioOrigin.current && window.history.length > 1) window.history.back(); else window.location.hash = "office"; }} />}
      {page === "memory" && <MemoryPage notify={notify} onOpenRun={(runId) => go(`runs/${encodeURIComponent(runId)}`)} />}
      {page === "publications" && <PublicationsPage data={data} refresh={refresh} notify={notify} />}
      {page === "dashboard" && <DashboardPage go={go} bootstrap={data} daemon={daemon} />}
      {page === "project" && route.spaceId && <ProjectDetailPage spaceId={route.spaceId} go={go} notify={notify} catalogRevision={[
        ...data.projects.map((project) => `${project.id}:${project.version}:${project.status}`),
        ...data.projectBindings.map((binding) => `${binding.projectId}:${binding.projectVersion}:${binding.version}`)
      ].join("|")} />}
      {page === "board" && <BoardPage
        spaceId={route.spaceId}
        go={go}
        notify={notify}
        sourceReady={daemon === "online" && !syncing}
        sourceError={daemon === "offline" ? "最新需求状态同步失败；未展示浏览器中的旧看板缓存。请确认本地运行核心已启动后重试。" : undefined}
        onRetrySource={refreshQuietly}
        catalogRevision={data.projects.map((project) => `${project.id}:${project.version}:${project.status}`).join("|")}
        projects={data.projects}
        projectBindings={data.projectBindings}
        invocations={data.activity.invocations}
        humanDecisionRequests={data.humanDecisionRequests ?? []}
        onOpenRun={(runId) => go(`runs/${encodeURIComponent(runId)}`)}
      />}
      {page === "requirement" && route.requirementId && <RequirementDetailPage
        requirementId={route.requirementId}
        section={route.section ?? "overview"}
        go={go}
        notify={notify}
        projects={data.projects}
        entrancePolicies={data.entrancePolicies ?? []}
        workflows={data.workflows}
        managementPolicies={data.managementPolicies ?? []}
        invocations={data.activity.invocations}
        onOpenRun={() => go(`requirements/${encodeURIComponent(route.requirementId!)}?section=run`)}
      />}
      {page === "archive" && <ArchivePage go={go} notify={notify} />}
      {page === "settings" && <SettingsPage />}
      </Suspense>
    </div></DaemonGate>
    <nav className="side-nav" aria-label="主要导航">
      <div className="brand-mark"><span className="brand-sprite" aria-hidden="true"><i /></span><div><strong>双叶幼儿园</strong><small>CRAYON KINDERGARTEN DOSSIER</small></div></div>
      <button type="button" className="theme-toggle" data-testid="theme-toggle" data-theme-target={theme === "crayon" ? "pixel" : "crayon"} onClick={() => setTheme(theme === "crayon" ? "pixel" : "crayon")} title={theme === "crayon" ? "切换到治愈像素主题" : "切换到蜡笔小新主题"} aria-label={theme === "crayon" ? "切换到治愈像素主题" : "切换到蜡笔小新主题"}><span className="theme-toggle-dot" aria-hidden="true" /><span>{theme === "crayon" ? "蜡笔小新" : "治愈像素"}</span><small>{theme === "crayon" ? "CRAYON" : "PIXEL"}</small></button>
      <div className="nav-items">{nav.map((item) => <button type="button" className={activeNav === item.id ? "active" : ""} aria-current={activeNav === item.id ? "page" : undefined} title={pendingDecisionCount > 0 && item.id === "dashboard" ? `${item.label} · ${pendingDecisionCount} 项待你决定` : item.label} key={item.id} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span>{pendingDecisionCount > 0 && item.id === "dashboard" && <span className="nav-attention-badge" aria-label={`${pendingDecisionCount} 项待你决定`}>{pendingDecisionCount}</span>}</button>)}</div>
      <div className="nav-items nav-utility">{utilityNav.map((item) => <button type="button" className={activeNav === item.id ? "active" : ""} aria-current={activeNav === item.id ? "page" : undefined} title={item.label} key={item.id} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</div>
      <button type="button" className="mobile-more" aria-expanded={moreOpen} onClick={() => setMoreOpen(true)}><Icon name="command" /><span>更多</span></button>
      <button type="button" className="command-hint" title="命令入口" onClick={() => setCommandOpen(true)}><Icon name="command" /><span>命令面板</span><kbd>⌘K</kbd></button>
      <div className="nav-foot"><span>KG</span><div><strong>Kindergarten Workbench</strong><small>班级在册 · A2A 1.0</small></div></div>
    </nav>
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
  </div></ActivityStreamContext.Provider>;
}
