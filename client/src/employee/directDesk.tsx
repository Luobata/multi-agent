import { useEffect, useRef, useState } from "react";
import { cancelInvocation, getSession, monitorInvocation, startInvocation, type InvocationStartReceipt } from "../api";
import { SelectControl, formatTime, useDaemonAvailable } from "../components";
import {
  ConversationComposer,
  ConversationMessageEvidence,
  type ComposerDraft
} from "../ConversationComposer";
import type { Employee, Session } from "../types";
import type { PageProps } from "../EmployeePage";

interface PendingTurn {
  receipt: InvocationStartReceipt;
  message: string;
  startedAt: number;
  cursor: string;
  phase: "waiting" | "cancelling" | "interrupted";
  /** False once the monitor loop has died (interrupted); remount sets it back. */
  monitorLive: boolean;
  lastReason?: "changed" | "heartbeat";
  lastUpdateAt?: string;
  lastStatus?: string;
  lastPhase?: string;
  error?: string;
}

function formatElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function DirectDesk({ employee, sessions, refresh, notify, onContext }: {
  employee: Employee;
  sessions: Session[];
  refresh: () => Promise<void>;
  notify: PageProps["notify"];
  onContext: (sessionId?: string) => void;
}) {
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
  const [liveSession, setLiveSession] = useState<Session>();
  const [pending, setPending] = useState<PendingTurn>();
  const [now, setNow] = useState(() => Date.now());
  const daemonAvailable = useDaemonAvailable();
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    setPending(undefined);
    setLiveSession(undefined);
    setSessionId(sessions[0]?.id ?? "");
  }, [employee.id]);
  useEffect(() => {
    // Unmount or employee switch abandons the in-flight monitor; the server
    // keeps the invocation and its receipt evidence regardless.
    return () => {
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
  }, [employee.id]);
  useEffect(() => {
    if (sessionId && !sessions.some((session) => session.id === sessionId) && liveSession?.id !== sessionId) setSessionId(sessions[0]?.id ?? "");
  }, [sessions, sessionId, liveSession]);
  const session = sessions.find((candidate) => candidate.id === sessionId) ?? (liveSession?.id === sessionId ? liveSession : undefined);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending?.startedAt]);

  const runMonitor = async (receipt: InvocationStartReceipt, cursor: string, generation: number, controller: AbortController) => {
    try {
      const terminal = await monitorInvocation(receipt, {
        signal: controller.signal,
        startCursor: cursor,
        onUpdate: (result) => {
          if (generationRef.current !== generation) return;
          setPending((current) => current && current.receipt.invocation.id === receipt.invocation.id ? {
            ...current,
            cursor: result.nextCursor,
            lastReason: result.reason === "terminal" ? current.lastReason : result.reason,
            lastUpdateAt: result.progress.updatedAt,
            lastStatus: result.progress.status,
            lastPhase: result.progress.phase
          } : current);
        }
      });
      if (!terminal || generationRef.current !== generation) return;
      const status = terminal.progress.status;
      if (receipt.invocation.sessionId) {
        try {
          const hydrated = await getSession(receipt.invocation.sessionId);
          if (generationRef.current !== generation) return;
          setLiveSession(hydrated);
          setSessionId(hydrated.id);
        } catch {
          // 终态已知但会话快照拉取失败：仍按真实终态汇报，证据保留在运行卷宗。
        }
      }
      if (generationRef.current !== generation) return;
      setPending(undefined);
      if (status === "completed") notify(`工单已完成 · ${receipt.runId}`);
      else if (status === "blocked") notify("请求完成，员工给出业务阻塞结论");
      else if (status === "cancelled") notify("工单已取消，证据保留在运行卷宗");
      else notify(`工单未成功（${status}）；证据已保留，请打开运行卷宗核对`, "error");
      await refresh();
    } catch (error) {
      if (controller.signal.aborted || generationRef.current !== generation) return;
      setPending((current) => current ? {
        ...current,
        phase: current.phase === "cancelling" ? "cancelling" : "interrupted",
        monitorLive: false,
        error: `监听通道中断（${error instanceof Error ? error.message : String(error)}）`
      } : current);
    }
  };

  const send = async (draft: ComposerDraft): Promise<boolean> => {
    // 同一时刻只允许一张在途工单；控件已禁用，这里再做代码级兜底。
    if (pending) return false;
    let receipt: InvocationStartReceipt;
    try {
      receipt = await startInvocation(`/api/employees/${employee.id}/start`, {
        message: draft.message,
        sessionId: sessionId || undefined,
        ...(draft.attachments.length > 0 ? { attachments: draft.attachments } : {})
      }, { "x-multi-agent-source": "workbench", "x-multi-agent-source-label": "直接交办调试台" });
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      return false;
    }
    const generation = ++generationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPending({ receipt, message: draft.message, startedAt: Date.now(), cursor: receipt.monitor.initialCursor, phase: "waiting", monitorLive: true });
    void runMonitor(receipt, receipt.monitor.initialCursor, generation, controller);
    return true;
  };

  const cancelPending = async () => {
    if (!pending || pending.phase === "cancelling") return;
    try {
      await cancelInvocation(pending.receipt.invocation.id);
      setPending((current) => current ? { ...current, phase: "cancelling", error: undefined } : current);
    } catch (error) {
      setPending((current) => current ? { ...current, error: `取消请求未送达（${error instanceof Error ? error.message : String(error)}）；工单仍在等待终态` } : current);
    }
  };

  const remountMonitor = () => {
    if (!pending || pending.monitorLive) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const receipt = pending.receipt;
    const cursor = pending.cursor;
    setPending({ ...pending, phase: pending.phase === "interrupted" ? "waiting" : pending.phase, monitorLive: true, error: undefined });
    void runMonitor(receipt, cursor, generationRef.current, controller);
  };

  const selectSession = (value: string) => {
    setLiveSession(undefined);
    setSessionId(value);
  };

  const pendingStatusLine = (turn: PendingTurn): string => {
    if (turn.phase === "interrupted") return "监听通道中断（网络或服务暂时不可达）；工单回执与进度仍保留在服务端";
    if (turn.phase === "cancelling") return turn.monitorLive ? "取消请求已送达，等待服务端确认终态…" : "取消请求已送达；监听未挂载，可重新挂载以观察取消终态";
    if (turn.lastReason === "heartbeat") return `心跳 · 最近更新 ${formatTime(turn.lastUpdateAt)}`;
    if (turn.lastStatus || turn.lastPhase) return `${turn.lastStatus ?? "等待"} · ${turn.lastPhase ?? "排队中"}`;
    return "已受理，等待服务端进度…";
  };

  return <div className="work-order">
    <header className="work-order-header"><div><p className="record-meta">{employee.id} · v{employee.version}</p><h3>直接交办</h3></div><div className="session-controls"><SelectControl ariaLabel="选择会话" value={sessionId} disabled={Boolean(pending)} options={[{ value: "", label: "新会话", description: `固定员工 v${employee.version}` }, ...sessions.map((item) => ({ value: item.id, label: item.title, description: `员工 v${item.employeeVersion} · ${formatTime(item.updatedAt)}` }))]} onChange={selectSession} /><button type="button" className="button ghost" disabled={Boolean(pending)} onClick={() => { selectSession(""); notify(`下一次请求将新建 v${employee.version} 会话`); }}>新会话</button><button type="button" className="button ghost" onClick={() => onContext(sessionId || undefined)}>检查上下文</button></div></header>
    <div className="transcript" aria-live="polite">
      {!session?.messages.length ? <div className="transcript-empty"><span>工单尚未填写</span><p>提交第一项请求后，原始请求、处理结果与 Run 编号会留存在这里。</p></div> : session.messages.map((item) => <article className={`transcript-row transcript-row--${item.role}`} key={item.id}>
        <div className="transcript-meta"><span>{item.role === "user" ? "请求" : item.role === "employee" ? "处理结果" : "系统记录"}</span><time>{formatTime(item.at)}</time>{item.runId && <code>{item.runId}</code>}</div>
        <p>{item.content}</p>
        <ConversationMessageEvidence attachments={item.attachments} documents={item.documents} />
      </article>)}
      {pending && <article className="transcript-row transcript-row--pending" aria-live="polite" aria-label="工单执行中">
        <div className="transcript-meta"><span>本次工单</span><time>{formatElapsedMs(now - pending.startedAt)}</time><code>{pending.receipt.runId}</code></div>
        <div className="pending-turn">
          <p className="pending-turn-message">{pending.message}</p>
          <p className="pending-turn-status" role="status">{pendingStatusLine(pending)}</p>
          <div className="pending-turn-actions">
            <a className="pending-turn-evidence" href={`#runs/${encodeURIComponent(pending.receipt.runId)}`}>打开运行卷宗 #{pending.receipt.runId}</a>
            {!pending.monitorLive && <button type="button" className="button secondary" onClick={remountMonitor}>重新挂载监听</button>}
            <button type="button" className="button secondary" disabled={pending.phase === "cancelling"} onClick={() => void cancelPending()}>取消</button>
          </div>
          {pending.error && <p className="pending-turn-error" role="alert">{pending.error}</p>}
        </div>
      </article>}
    </div>
    <ConversationComposer
      key={employee.id}
      ariaLabel="交办事项"
      placeholder="写下要交办的事项……"
      disabled={!daemonAvailable || Boolean(pending)}
      offlineHint={pending ? "工单执行中，完成后才能提交下一项" : undefined}
      submitLabel="提交请求"
      sendingLabel="执行中…"
      hint="⌘ / Ctrl + Enter"
      onSend={send}
    />
  </div>;
}
