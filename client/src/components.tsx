import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PropsWithChildren,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

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

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface SelectMenuPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

export function SelectControl({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = "请选择",
  emptyLabel = "暂无可选项",
  disabled = false,
  invalid = false,
  errorMessage,
  className = ""
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  errorMessage?: string;
  className?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<SelectMenuPosition>({ left: 8, width: 180, maxHeight: 280, top: 8 });
  const selected = options.find((option) => option.value === value);
  const hasEnabledOptions = options.some((option) => !option.disabled);
  const effectivelyDisabled = disabled || !hasEnabledOptions;
  const invalidState = invalid || Boolean(errorMessage);
  const visibleLabel = options.length === 0
    ? emptyLabel
    : !hasEnabledOptions
      ? selected?.label ?? "暂无可用选项"
      : selected?.label ?? placeholder;
  const errorId = `${listboxId}-error`;

  const firstEnabled = () => options.findIndex((option) => !option.disabled);
  const lastEnabled = () => {
    for (let index = options.length - 1; index >= 0; index -= 1) if (!options[index]?.disabled) return index;
    return -1;
  };
  const selectedIndex = () => {
    const index = options.findIndex((option) => option.value === value && !option.disabled);
    return index >= 0 ? index : firstEnabled();
  };
  const updatePosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const bounds = trigger.getBoundingClientRect();
    const edge = 8;
    const gap = 6;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(Math.max(bounds.width, 180), viewportWidth - edge * 2);
    const left = Math.min(Math.max(edge, bounds.left), Math.max(edge, viewportWidth - width - edge));
    const below = viewportHeight - bounds.bottom - gap - edge;
    const above = bounds.top - gap - edge;
    if (below < 144 && above > below) {
      setPosition({ left, width, maxHeight: Math.max(96, Math.min(280, above)), bottom: viewportHeight - bounds.top + gap });
    } else {
      setPosition({ left, width, maxHeight: Math.max(96, Math.min(280, below)), top: bounds.bottom + gap });
    }
  };
  const show = () => {
    if (effectivelyDisabled) return;
    setActiveIndex(selectedIndex());
    updatePosition();
    setOpen(true);
  };
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  };
  const move = (step: 1 | -1) => {
    if (options.length === 0) return;
    let index = activeIndex >= 0 ? activeIndex : selectedIndex();
    for (let count = 0; count < options.length; count += 1) {
      index = (index + step + options.length) % options.length;
      if (!options[index]?.disabled) {
        setActiveIndex(index);
        return;
      }
    }
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (effectivelyDisabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) show();
      else move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" && open) {
      event.preventDefault();
      setActiveIndex(firstEnabled());
      return;
    }
    if (event.key === "End" && open) {
      event.preventDefault();
      setActiveIndex(lastEnabled());
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else show();
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab" && open) setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handleOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    const handleViewport = () => updatePosition();
    document.addEventListener("pointerdown", handleOutside, true);
    window.addEventListener("resize", handleViewport);
    window.addEventListener("scroll", handleViewport, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutside, true);
      window.removeEventListener("resize", handleViewport);
      window.removeEventListener("scroll", handleViewport, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const activeOption = optionRefs.current[activeIndex];
    if (typeof activeOption?.scrollIntoView === "function") activeOption.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  return <div className={`select-control ${open ? "is-open" : ""} ${invalidState ? "is-invalid" : ""} ${className}`.trim()}>
    <button
      ref={triggerRef}
      type="button"
      className="select-trigger"
      role="combobox"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-autocomplete="none"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
      aria-invalid={invalidState || undefined}
      aria-describedby={errorMessage ? errorId : undefined}
      disabled={effectivelyDisabled}
      onClick={() => open ? close() : show()}
      onKeyDown={handleKeyDown}
    >
      <span className={selected && hasEnabledOptions ? "select-value" : "select-placeholder"}>{visibleLabel}</span>
      <svg className="select-chevron" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {errorMessage && <span id={errorId} className="select-error" role="alert">{errorMessage}</span>}
    {open && typeof document !== "undefined" && createPortal(<div
      ref={menuRef}
      id={listboxId}
      className="select-popover"
      role="listbox"
      aria-label={ariaLabel}
      style={position}
    >
      {options.map((option, index) => <button
        ref={(element) => { optionRefs.current[index] = element; }}
        key={option.value || `empty-${index}`}
        id={`${listboxId}-option-${index}`}
        type="button"
        className="select-option"
        role="option"
        aria-selected={option.value === value}
        data-active={activeIndex === index || undefined}
        disabled={option.disabled}
        tabIndex={-1}
        onMouseEnter={() => !option.disabled && setActiveIndex(index)}
        onClick={() => choose(index)}
      >
        <span className="select-check" aria-hidden="true">{option.value === value && <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m3 8 3 3 7-7" /></svg>}</span>
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
      </button>)}
    </div>, triggerRef.current?.closest("dialog") ?? document.body)}
  </div>;
}

function StampMark({ status }: { status: StampStatus }) {
  if (status === "active") return <><path d="M8 13V8M8 9C8 6 5 4 3 4c0 3 2 5 5 5ZM8 8c0-3 2-5 5-5 0 3-2 5-5 5Z" /><path d="M5 13h6" /></>;
  if (status === "archived") return <><path d="M3 5h10v8H3zM3 7h10" /><path d="M7 7v3h2V7" /></>;
  if (status === "running") return <><path d="M8 2v3M8 11v3M2 8h3M11 8h3" /><path d="m4 4 2 2M10 10l2 2M12 4l-2 2M6 10l-2 2" /></>;
  if (status === "passed" || status === "completed") return <><path d="M8 13 3 8V5l2-2 3 2 3-2 2 2v3l-5 5Z" /><path d="m5.5 7.5 1.5 1.5 3-3" /></>;
  if (status === "blocked") return <path d="M8 3.2 13 12H3L8 3.2Z" />;
  if (status === "failed") return <path d="m4 4 8 8m0-8-8 8" />;
  if (status === "skipped") return <path d="M3 8h8M9 5l3 3-3 3" />;
  return <path d="m8 2 1.5 4H14l-3.5 2.5L12 13l-4-2.5L4 13l1.5-4.5L2 6h4.5L8 2Z" strokeDasharray="2 2" />;
}

export function UtilityIcon({ name }: { name: "add" | "close" | "toggle" }) {
  return <svg className={`utility-icon utility-icon--${name}`} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" shapeRendering="crispEdges">
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
    <svg className="stamp-mark" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" strokeLinejoin="miter" shapeRendering="crispEdges"><StampMark status={status} /></svg>
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
    <span className="empty-state-sprite" aria-hidden="true"><i /></span>
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
      const first = dialog.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), [role='combobox']:not([disabled]), select:not([disabled]), .command-list button:not([disabled]), button:not(.icon-button):not([disabled])");
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
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard is unavailable");
      await navigator.clipboard.writeText(value);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
    window.setTimeout(() => setCopyStatus("idle"), 2500);
  };
  return <div className={`evidence-block ${mono ? "terminal-evidence" : ""}`}>
    <header><span>{label}</span><button className="text-button" type="button" onClick={() => void copy()} aria-live="polite" aria-atomic="true">{copyStatus === "copied" ? "已复制" : copyStatus === "failed" ? "复制失败，请手动选择" : "复制"}</button></header>
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

export function Icon({ name }: { name: "office" | "employees" | "projects" | "skills" | "knowledge" | "workflows" | "runs" | "publications" | "command" }) {
  const paths = {
    office: <><path d="M3 21h18M5 21V10l7-6 7 6v11"/><path d="M9 21v-6h6v6M8 11h2M14 11h2"/><path d="M12 8V5M12 6c-2 0-3-1-3-3 2 0 3 1 3 3Zm0-1c0-2 1-3 3-3 0 2-1 3-3 3Z"/></>,
    employees: <><path d="M5 21v-3l3-3h8l3 3v3"/><path d="M8 5h8v7H8zM10 8h1M13 8h1M10 11h4"/><path d="M6 7h2M16 7h2"/></>,
    projects: <><path d="M4 7h16v13H4zM8 7V4h8v3"/><path d="M4 12h16M10 12v2h4v-2"/></>,
    skills: <><path d="M5 4h13v16H7l-2 2V4Z"/><path d="M8 8h7M8 12h5"/><path d="M16 3v4M14 5h4"/></>,
    knowledge: <><path d="M4 5h7v15H4zM13 5h7v15h-7z"/><path d="M7 8h1M7 11h1M16 8h1M16 11h1M8 3v2M16 3v2"/><path d="M11 7h2M11 17h2"/></>,
    workflows: <><path d="M3 3h6v6H3zM15 15h6v6h-6z"/><path d="M9 6h4l4 4v5M14 12l3 3 3-3"/></>,
    runs: <><path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/><path d="m16 2 .7 1.3L18 4l-1.3.7L16 6l-.7-1.3L14 4l1.3-.7L16 2Z"/></>,
    publications: <><path d="M4 10h16v11H4zM3 7h18v4H3zM12 7v14"/><path d="M12 7c-4 0-5-5-2-5 2 0 2 3 2 5Zm0 0c4 0 5-5 2-5-2 0-2 3-2 5Z"/></>,
    command: <><path d="M4 5h16v14H4zM7 9l3 3-3 3M12 15h5"/></>
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" shapeRendering="crispEdges">{paths[name]}</svg>;
}
