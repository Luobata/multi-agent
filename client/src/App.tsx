import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { EmployeePage } from "./EmployeePage";
import { KnowledgePage } from "./KnowledgePage";
import { DaemonGate, Icon, Modal } from "./components";
import { OfficePage } from "./OfficePage";
import { PublicationsPage } from "./PublicationsPage";
import { ProjectPage } from "./ProjectPage";
import { RunsPage } from "./RunsPage";
import { SkillsPage } from "./SkillsPage";
import type { ActivityEvent, ActivitySnapshot, Bootstrap } from "./types";
import { WorkflowPage } from "./WorkflowPage";
import { applyTheme, DEFAULT_THEME, readTheme, type ThemeName } from "./theme";

type Page = "office" | "employees" | "projects" | "skills" | "knowledge" | "workflows" | "runs" | "publications";
const emptyBootstrap: Bootstrap = { providers: [], skills: [], knowledgeBases: [], knowledgeProfiles: [], architectureTemplates: [], employees: [], managementPolicies: [], entrancePolicies: [], workflows: [], sessions: [], publications: [], projects: [], projectBindings: [], activity: { invocations: [], instances: [] } };

function pageFromHash(): Page {
  const value = window.location.hash.replace("#", "");
  return ["office", "employees", "projects", "skills", "knowledge", "workflows", "runs", "publications"].includes(value) ? value as Page : "office";
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

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [data, setData] = useState<Bootstrap>(emptyBootstrap);
  const [daemon, setDaemon] = useState<"checking" | "online" | "offline">("checking");
  const [activityStream, setActivityStream] = useState<"connecting" | "live" | "reconnecting" | "offline">("connecting");
  const [notice, setNotice] = useState<{ message: string; kind: "success" | "error" }>();
  const [commandOpen, setCommandOpen] = useState(false);
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
    refresh().catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
  }, [refresh, notify]);

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
    const update = () => setPage(pageFromHash());
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
    setPage(next);
  };
  const invocationRevision = data.activity.invocations.reduce((latest, invocation) => invocation.updatedAt > latest ? invocation.updatedAt : latest, "");
  const activityRevision = data.activity.instances.reduce((latest, instance) => instance.updatedAt > latest ? instance.updatedAt : latest, invocationRevision);
  const nav = [
    { id: "office" as const, label: "员工大厅", icon: "office" as const },
    { id: "employees" as const, label: "员工档案", icon: "employees" as const },
    { id: "projects" as const, label: "项目接入", icon: "projects" as const },
    { id: "skills" as const, label: "技能台账", icon: "skills" as const },
    { id: "knowledge" as const, label: "知识控制台", icon: "knowledge" as const },
    { id: "workflows" as const, label: "协作编排", icon: "workflows" as const },
    { id: "runs" as const, label: "运行卷宗", icon: "runs" as const },
    { id: "publications" as const, label: "调用包", icon: "publications" as const }
  ];

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
      <div className="nav-items">{nav.map((item) => <button type="button" className={page === item.id ? "active" : ""} aria-current={page === item.id ? "page" : undefined} title={item.label} key={item.id} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</div>
      <button type="button" className="command-hint" title="命令入口" onClick={() => setCommandOpen(true)}><Icon name="command" /><span>命令面板</span><kbd>⌘K</kbd></button>
      <button type="button" className="theme-toggle" onClick={() => setTheme(theme === "crayon" ? "pixel" : "crayon")} title={theme === "crayon" ? "切换到治愈像素主题" : "切换到蜡笔小新主题"} aria-label={theme === "crayon" ? "切换到治愈像素主题" : "切换到蜡笔小新主题"}><span className="theme-toggle-dot" aria-hidden="true" /><span>{theme === "crayon" ? "蜡笔小新" : "治愈像素"}</span><small>{theme === "crayon" ? "CRAYON" : "PIXEL"}</small></button>
      <div className="nav-foot"><span>KG</span><div><strong>Kindergarten Workbench</strong><small>班级在册 · A2A 1.0</small></div></div>
    </nav>
    <DaemonGate status={daemon}><div id="main-content" className="app-content" tabIndex={-1}>
      {page === "office" && <OfficePage data={data} streamStatus={activityStream} />}
      {page === "employees" && <EmployeePage data={data} refresh={refresh} notify={notify} />}
      {page === "projects" && <ProjectPage data={data} refresh={refresh} notify={notify} />}
      {page === "skills" && <SkillsPage data={data} refresh={refresh} notify={notify} />}
      {page === "knowledge" && <KnowledgePage data={data} refresh={refresh} notify={notify} />}
      {page === "workflows" && <WorkflowPage data={data} refresh={refresh} notify={notify} />}
      {page === "runs" && <RunsPage notify={notify} activityRevision={activityRevision} />}
      {page === "publications" && <PublicationsPage data={data} refresh={refresh} notify={notify} />}
    </div></DaemonGate>
    {notice && <div className={`toast toast--${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"} aria-live={notice.kind === "error" ? "assertive" : "polite"} aria-atomic="true">
      <span>{notice.message}</span>
      {notice.kind === "error" && <div className="toast-actions">
        <button type="button" onClick={() => void refresh().then(() => setNotice(undefined)).catch((error: unknown) => setNotice({ message: error instanceof Error ? error.message : String(error), kind: "error" }))}>重试连接</button>
        <button type="button" onClick={() => setNotice(undefined)}>关闭</button>
      </div>}
    </div>}
    {commandOpen && <Modal title="命令面板" eyebrow="TOWN MENU · ⌘K" onClose={() => setCommandOpen(false)}><div className="command-list" onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
      const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
      const next = event.key === "ArrowDown" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>{nav.map((item, index) => <button type="button" key={item.id} onClick={() => { navigate(item.id); setCommandOpen(false); }}><Icon name={item.icon} /><strong>{item.label}</strong><kbd>0{index + 1}</kbd></button>)}</div></Modal>}
  </div>;
}
