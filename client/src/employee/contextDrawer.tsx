import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ReadonlyEvidence, UtilityIcon } from "../components";
import { EffectiveProfileView } from "../EffectiveProfileView";
import type { ContextView, Employee } from "../types";

export function ContextDrawer({ employee, sessionId, onClose }: {
  employee: Employee;
  sessionId?: string;
  onClose: () => void;
}) {
  const [context, setContext] = useState<ContextView>();
  const [error, setError] = useState("");
  const [copiedAll, setCopiedAll] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerRef.current?.querySelector<HTMLButtonElement>(".icon-button")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab") {
        const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), summary, input:not([disabled]), textarea:not([disabled]), [role='combobox']:not([disabled]), select:not([disabled])") ?? []).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, []);
  useEffect(() => {
    api<ContextView>(`/api/employees/${employee.id}/context${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`)
      .then(setContext).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [employee.id, sessionId]);

  const copyAll = async () => {
    if (!context) return;
    await navigator.clipboard.writeText(JSON.stringify(context, null, 2));
    setCopiedAll(true);
    window.setTimeout(() => setCopiedAll(false), 2500);
  };

  return <aside ref={drawerRef} className="context-drawer" role="dialog" aria-modal="true" aria-label="上下文检查器">
    <header className="drawer-header"><div><p className="record-meta">{employee.id} · 上下文证据</p><h2>上下文检查器</h2><p className="mono muted">v{context?.employee.version ?? employee.version}</p></div><button className="icon-button" onClick={onClose} aria-label="关闭上下文检查器"><UtilityIcon name="close" /></button></header>
    {error && <div className="inline-error">{error}</div>}
    {!context ? <div className="drawer-loading">正在调取上下文证据…</div> : <div className="context-layers">
      <details><summary><b>01</b><span>身份与角色指令</span><UtilityIcon name="toggle" /></summary><ReadonlyEvidence label="Identity" value={JSON.stringify(context.layers.identity, null, 2)} mono /><ReadonlyEvidence label="System instructions" value={context.layers.systemPrompt} /></details>
      <details><summary><b>02</b><span>Skill 指令、配置与工具</span><UtilityIcon name="toggle" /></summary><ReadonlyEvidence label="Resolved skills" value={JSON.stringify(context.layers.skills, null, 2)} mono /></details>
      <details><summary><b>03</b><span>Knowledge Plan 与证据</span><UtilityIcon name="toggle" /></summary>{context.layers.knowledge ? <><ReadonlyEvidence label="Knowledge Plan" value={JSON.stringify(context.layers.knowledge.plan, null, 2)} mono /><ReadonlyEvidence label="Retrieved evidence" value={JSON.stringify(context.layers.knowledge.evidence, null, 2)} mono /></> : <p className="muted drawer-note">本次运行没有知识证据；可能尚未分配 Profile，或没有内容达到相关度阈值。</p>}</details>
      <details><summary><b>04</b><span>Session 历史</span><UtilityIcon name="toggle" /></summary><ReadonlyEvidence label="Pinned history" value={JSON.stringify(context.layers.history, null, 2)} mono /></details>
      <details><summary><b>05</b><span>当前请求与依赖结果</span><UtilityIcon name="toggle" /></summary><ReadonlyEvidence label="Current request" value={context.layers.currentRequest ?? "尚无请求"} /><ReadonlyEvidence label="Graph dependencies" value={Object.keys(context.layers.dependencyResults).length ? JSON.stringify(context.layers.dependencyResults, null, 2) : "直接调用编译为单节点 Graph；没有上游依赖。"} mono /></details>
      <details open><summary><b>06</b><span>有效执行配置与来源</span><UtilityIcon name="toggle" /></summary>{context.effectiveProfile ? <EffectiveProfileView profile={context.effectiveProfile} /> : <p className="muted drawer-note">该运行创建于来源编译功能之前；仍可查看下方最终 Prompt 证据。</p>}</details>
      <details><summary><b>07</b><span>Effective Prompt</span><UtilityIcon name="toggle" /></summary>{context.effectivePrompt ? <><ReadonlyEvidence label="Combined prompt" value={context.effectivePrompt.combined} /><ReadonlyEvidence label="System prompt" value={context.effectivePrompt.system} /><ReadonlyEvidence label="Request prompt" value={context.effectivePrompt.request} /></> : <p className="muted drawer-note">尚无有效提示词证据；完成一次调用后生成。</p>}</details>
      <details><summary><b>08</b><span>Run 元数据</span><UtilityIcon name="toggle" /></summary><ReadonlyEvidence label="Run evidence" value={context.layers.runMetadata ? JSON.stringify(context.layers.runMetadata, null, 2) : "尚无 Run"} mono /></details>
    </div>}
    <footer className="drawer-footer"><button className="button secondary" disabled={!context} onClick={() => void copyAll()} aria-live="polite">{copiedAll ? "完整上下文已复制" : "复制完整上下文"}</button></footer>
  </aside>;
}
