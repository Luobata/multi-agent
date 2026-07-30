import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PropsWithChildren,
  type ReactNode
} from "react";

export type StampStatus = "active" | "archived" | "running" | "passed" | "completed" | "blocked" | "failed" | "skipped" | "pending";
export type DaemonStatus = "checking" | "online" | "offline";
export const DEFAULT_EMPLOYEE_ACCENT = "var(--stamp-red)";

export function defaultEmployeeAccentInput(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--employee-accent-data").trim();
}

const labels: Record<StampStatus, string> = {
  active: "在册",
  archived: "归档",
  running: "执行中",
  passed: "完成",
  completed: "完成",
  blocked: "阻塞",
  failed: "故障",
  skipped: "跳过",
  pending: "待办"
};

const DaemonContext = createContext<DaemonStatus>("online");

export function DaemonGate({ status, children }: PropsWithChildren<{ status: DaemonStatus }>) {
  return <DaemonContext.Provider value={status}>
    <div className="daemon-gate" aria-busy={status === "checking"}>
      {status !== "online" && <div className="daemon-gate-notice" role="status">
        <Stamp status="blocked" label={status === "checking" ? "正在连接" : "暂不可写"} />
        <span>{status === "checking" ? "正在核对本地档案服务；读取界面保持可用。" : "本地档案服务未连接 — 写入与运行暂不可用，已有档案仍可查阅。"}</span>
      </div>}
      {children}
    </div>
  </DaemonContext.Provider>;
}

export function useDaemonAvailable(): boolean {
  return useContext(DaemonContext) === "online";
}

function StampMark({ status }: { status: StampStatus }) {
  if (status === "active") return <circle cx="8" cy="8" r="4" />;
  if (status === "archived") return <rect x="4" y="4" width="8" height="8" />;
  if (status === "running") return <><path d="M4 4v8M8 4v8M12 4v8" /><path d="M3 12h10" /></>;
  if (status === "passed" || status === "completed") return <path d="m3.5 8.2 2.8 2.8 6.2-6.2" />;
  if (status === "blocked") return <path d="M8 3.2 13 12H3L8 3.2Z" />;
  if (status === "failed") return <path d="m4 4 8 8m0-8-8 8" />;
  if (status === "skipped") return <path d="M3 8h10" />;
  return <rect x="3.5" y="3.5" width="9" height="9" strokeDasharray="2 2" />;
}

export function UtilityIcon({ name }: { name: "add" | "close" | "toggle" }) {
  return <svg className={`utility-icon utility-icon--${name}`} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
    {name === "close" ? <path d="M4 4l8 8M12 4l-8 8" /> : <><path d="M3 8h10" /><path className={name === "toggle" ? "toggle-vertical" : undefined} d="M8 3v10" /></>}
  </svg>;
}

export function scrollRecordIntoView(id: string) {
  document.getElementById(id)?.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start"
  });
}

export function Stamp({ status, label }: { status: StampStatus; label?: string }) {
  return <span className={`stamp stamp--${status}`}>
    <svg className="stamp-mark" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter"><StampMark status={status} /></svg>
    {label ?? labels[status]}
  </span>;
}

export function DossierSection({ number, title, action, children }: PropsWithChildren<{
  number: string;
  title: string;
  action?: ReactNode;
}>) {
  return <section className="dossier-section">
    <header className="section-rule">
      <div className="section-meta"><span className="section-number">{number}</span>{action && <div className="section-action">{action}</div>}</div>
      <h3>{title}</h3>
    </header>
    <div className="section-body">{children}</div>
  </section>;
}

export function EmptyState({ title, children, action }: PropsWithChildren<{
  title: string;
  action?: ReactNode;
}>) {
  return <section className="empty-state" aria-label={title}>
    <h2>{title}</h2>
    <div className="empty-copy">{children}</div>
    {action && <div className="empty-action">{action}</div>}
  </section>;
}

export function Modal({ title, eyebrow, children, onClose, wide = false }: PropsWithChildren<{
  title: string;
  eyebrow?: string;
  onClose: () => void;
  wide?: boolean;
}>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => {
      const first = dialog.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), select:not([disabled]), .command-list button:not([disabled]), button:not(.icon-button):not([disabled])");
      (first ?? dialog.querySelector<HTMLElement>(".icon-button"))?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
      previousFocus?.focus();
    };
  }, []);

  return <dialog
    ref={dialogRef}
    className={`modal-sheet ${wide ? "modal-sheet--wide" : ""}`}
    aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); closeRef.current(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeRef.current();
    }}
  >
    <section className="modal-frame">
      <header className="modal-header">
        <div>
          {eyebrow && <p className="record-meta">{eyebrow}</p>}
          <h2 id={titleId}>{title}</h2>
        </div>
        <button className="icon-button" type="button" onClick={() => closeRef.current()} aria-label="关闭弹窗"><UtilityIcon name="close" /></button>
      </header>
      {children}
    </section>
  </dialog>;
}

export function Field({ label, hint, children, className = "" }: PropsWithChildren<{
  label: string;
  hint?: string;
  className?: string;
}>) {
  return <label className={`field ${className}`}>
    <span className="field-label">{label}</span>
    {children}
    <span className="field-hint" aria-hidden={!hint}>{hint ?? "\u00a0"}</span>
  </label>;
}

export function ReadonlyEvidence({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  };
  return <div className={`evidence-block ${mono ? "terminal-evidence" : ""}`}>
    <header><span>{label}</span><button className="text-button" type="button" onClick={() => void copy()} aria-live="polite">{copied ? "已复制" : "复制"}</button></header>
    <pre className={mono ? "mono" : ""}>{value || "—"}</pre>
  </div>;
}

export function formatTime(value?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function initials(displayName: string, configured?: string): string {
  return configured?.trim().slice(0, 2).toUpperCase() || displayName.trim().slice(0, 2).toUpperCase() || "AG";
}

export function EmployeeAvatar({ displayName, presentation, className = "", title }: {
  displayName: string;
  presentation?: { accent?: string; initials?: string; avatarUrl?: string };
  className?: string;
  title?: string;
}) {
  const avatarUrl = presentation?.avatarUrl?.trim();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatarUrl]);
  const hasAvatar = Boolean(avatarUrl && !failed);
  return <span
    className={`employee-initials ${hasAvatar ? "has-avatar" : ""} ${className}`.trim()}
    style={{ "--accent": presentation?.accent ?? DEFAULT_EMPLOYEE_ACCENT } as CSSProperties}
    title={title}
  >
    {hasAvatar
      ? <img src={avatarUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : initials(displayName, presentation?.initials)}
  </span>;
}

export function Icon({ name }: { name: "employees" | "skills" | "workflows" | "runs" | "publications" | "command" }) {
  const paths = {
    employees: <><path d="M5 20v-2.2A3.8 3.8 0 0 1 8.8 14h6.4a3.8 3.8 0 0 1 3.8 3.8V20"/><circle cx="12" cy="7" r="4"/></>,
    skills: <><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v17H7.5A2.5 2.5 0 0 0 5 21.5z"/><path d="M5 4.5v17M9 7h6M9 11h6"/></>,
    workflows: <><rect x="3" y="3" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/><path d="M9 6h4a4 4 0 0 1 4 4v5M17 15l-2-2m2 2 2-2"/></>,
    runs: <><path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
    publications: <><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 13v7h14v-7"/></>,
    command: <><path d="m5 7 4 5-4 5M11 17h8"/></>
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter">{paths[name]}</svg>;
}
