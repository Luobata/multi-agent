import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { EmployeePage } from "./EmployeePage";
import { DaemonGate, Icon, Modal } from "./components";
import { OfficePage } from "./OfficePage";
import { PublicationsPage } from "./PublicationsPage";
import { RunsPage } from "./RunsPage";
import { SkillsPage } from "./SkillsPage";
import type { ActivityEvent, ActivitySnapshot, Bootstrap } from "./types";
import { WorkflowPage } from "./WorkflowPage";

type Page = "office" | "employees" | "skills" | "workflows" | "runs" | "publications";
const emptyBootstrap: Bootstrap = { providers: [], skills: [], architectureTemplates: [], employees: [], workflows: [], sessions: [], publications: [], activity: { invocations: [], instances: [] } };

function pageFromHash(): Page {
  const value = window.location.hash.replace("#", "");
  return ["office", "employees", "skills", "workflows", "runs", "publications"].includes(value) ? value as Page : "office";
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) return [value, ...items];
  const next = [...items];
  next[index] = value;
  return next;
}

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [data, setData] = useState<Bootstrap>(emptyBootstrap);
  const [daemon, setDaemon] = useState<"checking" | "online" | "offline">("checking");
  const [activityStream, setActivityStream] = useState<"connecting" | "live" | "reconnecting" | "offline">("connecting");
  const [notice, setNotice] = useState<{ message: string; kind: "success" | "error" }>();
  const [commandOpen, setCommandOpen] = useState(false);

  const notify = useCallback((message: string, kind: "success" | "error" = "success") => {
    setNotice({ message, kind });
    if (kind === "success") {
      window.setTimeout(() => setNotice((current) => current?.message === message ? undefined : current), 4200);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const bootstrap = await api<Bootstrap>("/api/bootstrap");
      setData(bootstrap);
      setDaemon("online");
    } catch (error) {
      setDaemon("offline");
      throw error;
    }
  }, []);

  useEffect(() => { refresh().catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error")); }, [refresh, notify]);
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

  const navigate = (next: Page) => { window.location.hash = next; setPage(next); };
  const invocationRevision = data.activity.invocations.reduce((latest, invocation) => invocation.updatedAt > latest ? invocation.updatedAt : latest, "");
  const activityRevision = data.activity.instances.reduce((latest, instance) => instance.updatedAt > latest ? instance.updatedAt : latest, invocationRevision);
  const nav = [
    { id: "office" as const, label: "员工大厅", icon: "office" as const },
    { id: "employees" as const, label: "员工档案", icon: "employees" as const },
    { id: "skills" as const, label: "技能台账", icon: "skills" as const },
    { id: "workflows" as const, label: "协作编排", icon: "workflows" as const },
    { id: "runs" as const, label: "运行卷宗", icon: "runs" as const },
    { id: "publications" as const, label: "调用包", icon: "publications" as const }
  ];

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">跳到主内容</a>
    <header className={`daemon-strip daemon-strip--${daemon}`} aria-live="polite">
      <div><span className="daemon-dot" aria-hidden="true" /><strong>{daemon === "online" ? "本地运行核心已连接" : daemon === "offline" ? "本地运行核心未连接" : "正在核对本地运行核心"}</strong><code>127.0.0.1 · LOOPBACK</code></div>
      <span>{daemon === "offline" ? "READ ONLY · 写入与运行暂不可用" : "LOCAL MODE · EVIDENCE ON"}</span>
    </header>
    <nav className="side-nav" aria-label="主要导航">
      <div className="brand-mark"><span aria-hidden="true">档</span><div><strong>档案室</strong><small>DOSSIER OFFICE</small></div></div>
      <div className="nav-items">{nav.map((item) => <button type="button" className={page === item.id ? "active" : ""} aria-current={page === item.id ? "page" : undefined} title={item.label} key={item.id} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</div>
      <button type="button" className="command-hint" title="命令入口" onClick={() => setCommandOpen(true)}><Icon name="command" /><span>命令面板</span><kbd>⌘K</kbd></button>
      <div className="nav-foot"><span>MA</span><div><strong>Local Workbench</strong><small>v0.1 · A2A 1.0</small></div></div>
    </nav>
    <DaemonGate status={daemon}><div id="main-content" className="app-content" tabIndex={-1}>
      {page === "office" && <OfficePage data={data} streamStatus={activityStream} />}
      {page === "employees" && <EmployeePage data={data} refresh={refresh} notify={notify} />}
      {page === "skills" && <SkillsPage data={data} refresh={refresh} notify={notify} />}
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
    {commandOpen && <Modal title="命令面板" eyebrow="SYSTEM MENU · ⌘K" onClose={() => setCommandOpen(false)}><div className="command-list" onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
      const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
      const next = event.key === "ArrowDown" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>{nav.map((item, index) => <button type="button" key={item.id} onClick={() => { navigate(item.id); setCommandOpen(false); }}><Icon name={item.icon} /><strong>{item.label}</strong><kbd>0{index + 1}</kbd></button>)}</div></Modal>}
  </div>;
}
