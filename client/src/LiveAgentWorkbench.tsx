import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { Stamp, formatTime, type StampStatus } from "./components";
import type { ActivityEvent, InvocationProgress, InvocationStatus, WorkInstanceRecord, WorkInstanceStatus } from "./types";

/**
 * 实时 Agent 工作台：需求详情 Run 分区的只读可视化增量。
 * 首次用 /api/invocations/:id/progress 快照填充，随后由 /api/activity/stream 的
 * invocation.changed / instance.changed 事件增量驱动；SSE 不可用时降级为 5s 轮询，
 * 页面不可见时暂停。没有任何输入或操作控件。
 */

type FeedState = "connecting" | "live" | "polling" | "paused";

/** 卡片视觉状态：合同要求 running 脉冲 / passed 绿 / failed 红 / blocked 黄 / pending·skipped 灰。 */
type CardVisual = "running" | "passed" | "failed" | "blocked" | "pending" | "skipped";

interface AgentCardModel {
  nodeId: string;
  roleId?: string;
  employeeId: string;
  kind?: string;
  round?: number;
  status: WorkInstanceStatus;
  phase: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  sessionLabel?: string;
  todoId?: string;
}

const TERMINAL_INVOCATION_STATUSES: InvocationStatus[] = ["completed", "blocked", "failed", "cancelled"];

function cardVisual(status: WorkInstanceStatus): CardVisual {
  switch (status) {
    case "running": return "running";
    case "completed": return "passed";
    case "failed": return "failed";
    case "blocked": return "blocked";
    case "skipped":
    case "cancelled": return "skipped";
    default: return "pending";
  }
}

function cardStamp(status: WorkInstanceStatus): StampStatus {
  switch (status) {
    case "running": return "running";
    case "completed": return "passed";
    case "failed": return "failed";
    case "blocked": return "blocked";
    case "skipped":
    case "cancelled": return "skipped";
    default: return "pending";
  }
}

function invocationStamp(status: InvocationStatus): StampStatus {
  switch (status) {
    case "running": return "running";
    case "completed": return "passed";
    case "failed": return "failed";
    case "blocked": return "blocked";
    case "cancelled": return "skipped";
    default: return "pending";
  }
}

const INVOCATION_STATUS_LABELS: Record<InvocationStatus, string> = {
  queued: "排队中",
  running: "执行中",
  "awaiting-human-decision": "等待人工决策",
  "cancellation-requested": "取消中",
  completed: "已完成",
  blocked: "阻塞",
  failed: "失败",
  cancelled: "已取消"
};

function formatElapsed(startedAt: string | undefined, end: number): string {
  if (!startedAt) return "—";
  const ms = Math.max(0, end - new Date(startedAt).getTime());
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** 快照可能来自测试兜底或旧版本服务；形状不符时视为无数据而不是崩溃。 */
function asProgress(value: unknown): InvocationProgress | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<InvocationProgress>;
  if (typeof candidate.invocationId !== "string" || !Array.isArray(candidate.steps)) return undefined;
  return candidate as InvocationProgress;
}

function mergeCards(progress: InvocationProgress | undefined, live: Map<string, WorkInstanceRecord>): AgentCardModel[] {
  const cards = new Map<string, AgentCardModel>();
  for (const step of progress?.steps ?? []) {
    cards.set(step.nodeId, {
      nodeId: step.nodeId,
      roleId: step.roleId,
      employeeId: step.employeeId,
      kind: step.kind,
      round: step.round,
      status: step.status,
      phase: step.phase,
      error: step.error,
      startedAt: step.startedAt,
      completedAt: step.completedAt
    });
  }
  for (const record of live.values()) {
    const base = cards.get(record.nodeId);
    cards.set(record.nodeId, {
      ...base,
      nodeId: record.nodeId,
      roleId: record.roleId ?? base?.roleId,
      employeeId: record.employeeId || base?.employeeId || record.nodeId,
      kind: record.kind ?? base?.kind,
      round: record.round ?? base?.round,
      status: record.status,
      phase: record.phase || base?.phase || "",
      error: record.error ?? base?.error,
      startedAt: record.startedAt ?? base?.startedAt,
      completedAt: record.completedAt ?? base?.completedAt,
      sessionLabel: record.memberSessionKey ?? record.memberSessionId ?? base?.sessionLabel,
      todoId: record.todoId ?? base?.todoId
    });
  }
  return [...cards.values()].sort((a, b) =>
    (a.round ?? Number.MAX_SAFE_INTEGER) - (b.round ?? Number.MAX_SAFE_INTEGER)
    || (a.startedAt ?? "").localeCompare(b.startedAt ?? "")
    || a.nodeId.localeCompare(b.nodeId));
}

export function LiveAgentWorkbench({ invocationId, runId }: { invocationId?: string; runId?: string }) {
  const [progress, setProgress] = useState<InvocationProgress | undefined>(undefined);
  const [liveInstances, setLiveInstances] = useState<Map<string, WorkInstanceRecord>>(new Map());
  const [feed, setFeed] = useState<FeedState>("connecting");
  const [loadError, setLoadError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const timelineEndRef = useRef<HTMLLIElement | null>(null);
  const seenRoundsRef = useRef(0);

  const terminal = Boolean(progress && (progress.terminal || TERMINAL_INVOCATION_STATUSES.includes(progress.status)));

  useEffect(() => {
    if (!invocationId) return undefined;
    let disposed = false;
    let stream: EventSource | undefined;
    let pollTimer: number | undefined;
    let mode: "sse" | "polling" = "sse";

    const loadSnapshot = () => {
      api<InvocationProgress>(`/api/invocations/${encodeURIComponent(invocationId)}/progress`)
        .then((snapshot) => {
          if (disposed) return;
          const valid = asProgress(snapshot);
          if (valid) {
            setProgress(valid);
            setLoadError("");
          }
        })
        .catch((error: unknown) => {
          if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
        });
    };

    const stopStreaming = () => {
      stream?.close();
      stream = undefined;
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    const startPolling = () => {
      if (disposed || pollTimer !== undefined) return;
      mode = "polling";
      stream?.close();
      stream = undefined;
      setFeed("polling");
      pollTimer = window.setInterval(loadSnapshot, 5000);
    };

    const receiveActivity = (event: MessageEvent<string>) => {
      if (disposed) return;
      let update: ActivityEvent;
      try {
        update = JSON.parse(event.data) as ActivityEvent;
      } catch {
        return;
      }
      if (update.type === "instance.changed" && update.instance.invocationId === invocationId) {
        const record = update.instance;
        setLiveInstances((current) => {
          const next = new Map(current);
          next.set(record.nodeId, record);
          return next;
        });
      } else if (update.type === "invocation.changed" && update.invocation.id === invocationId) {
        const invocation = update.invocation;
        setProgress((current) => current
          ? { ...current, status: invocation.status, phase: invocation.phase, terminal: TERMINAL_INVOCATION_STATUSES.includes(invocation.status), updatedAt: invocation.updatedAt }
          : current);
      }
    };

    const connect = () => {
      if (disposed || mode === "polling") return;
      if (typeof EventSource === "undefined") {
        startPolling();
        return;
      }
      try {
        stream = new EventSource("/api/activity/stream");
      } catch {
        startPolling();
        return;
      }
      stream.addEventListener("activity", receiveActivity as EventListener);
      stream.onopen = () => { if (!disposed) setFeed("live"); };
      stream.onerror = () => { if (!disposed) startPolling(); };
    };

    const onVisibility = () => {
      if (disposed) return;
      if (document.hidden) {
        stopStreaming();
        setFeed("paused");
      } else {
        loadSnapshot();
        if (mode === "polling") {
          pollTimer = window.setInterval(loadSnapshot, 5000);
          setFeed("polling");
        } else {
          setFeed("connecting");
          connect();
        }
      }
    };

    setProgress(undefined);
    setLiveInstances(new Map());
    setLoadError("");
    loadSnapshot();
    connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      stopStreaming();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [invocationId]);

  const cards = useMemo(() => mergeCards(progress, liveInstances), [progress, liveInstances]);
  const hasRunning = !terminal && cards.some((card) => card.status === "running");

  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  const leaderEntries = progress?.leaderReport?.available ? progress.leaderReport.entries : [];
  useEffect(() => {
    if (leaderEntries.length > seenRoundsRef.current) {
      seenRoundsRef.current = leaderEntries.length;
      timelineEndRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    }
  }, [leaderEntries.length]);

  if (!invocationId) {
    return <section className="live-workbench live-workbench--empty" aria-label="实时 Agent 工作台">
      <div className="live-workbench-head">
        <h2>实时 Agent 工作台</h2>
      </div>
      <p className="live-workbench-guidance">推进需求后这里会实时展示 agent 工作细节：谁在跑、跑什么任务、领队每轮决策了什么。</p>
    </section>;
  }

  return <section className={`live-workbench${terminal ? " live-workbench--terminal" : ""}`} aria-label="实时 Agent 工作台">
    <div className="live-workbench-head">
      <h2>实时 Agent 工作台</h2>
      <div className="live-workbench-head-meta">
        <span className={`live-workbench-feed live-workbench-feed--${feed}`} role="status">
          {feed === "live" ? "实时连接" : feed === "polling" ? "轮询刷新（5s）" : feed === "paused" ? "已暂停（页面不可见）" : "连接中…"}
        </span>
        {progress && <Stamp status={invocationStamp(progress.status)} label={INVOCATION_STATUS_LABELS[progress.status] ?? progress.status} />}
        {progress && progress.round > 0 && <span className="live-workbench-round">R{progress.round}</span>}
      </div>
    </div>
    {loadError && !progress && <p className="live-workbench-error" role="alert">进度快照暂时不可用：{loadError}</p>}
    {terminal && progress?.outcome && <p className="live-workbench-outcome">
      {progress.outcome.summary ?? progress.outcome.reason ?? `本轮结束：${INVOCATION_STATUS_LABELS[progress.status] ?? progress.status}`}
    </p>}
    <div className="live-workbench-body">
      <ul className="live-workbench-grid" aria-label="Agent 卡片">
        {cards.map((card) => {
          const visual = cardVisual(card.status);
          return <li key={card.nodeId} className={`live-agent-card live-agent-card--${visual}`} data-node-id={card.nodeId} data-status={visual}>
            <div className="live-agent-card-head">
              <Stamp status={cardStamp(card.status)} />
              <span className="live-agent-card-round">{card.round ? `R${card.round}` : "—"}</span>
            </div>
            <strong className="live-agent-card-role">{card.roleId ?? card.employeeId}</strong>
            <span className="live-agent-card-employee">{card.employeeId}{card.kind ? ` · ${card.kind}` : ""}</span>
            <p className="live-agent-card-phase">{card.phase || "等待调度"}</p>
            <dl className="live-agent-card-meta">
              <dt>时长</dt>
              <dd>{card.status === "running" ? formatElapsed(card.startedAt, now) : formatElapsed(card.startedAt, card.completedAt ? new Date(card.completedAt).getTime() : now)}</dd>
              {card.sessionLabel && <><dt>会话</dt><dd><code>{card.sessionLabel}</code></dd></>}
              {card.todoId && <><dt>TODO</dt><dd><code>{card.todoId}</code></dd></>}
            </dl>
            {card.error && <p className="live-agent-card-error">{card.error}</p>}
          </li>;
        })}
        {cards.length === 0 && <li className="live-workbench-no-agents">快照里还没有 work instance；调度开始后卡片会实时出现在这里。</li>}
      </ul>
      <aside className="live-workbench-leader" aria-label="领队时间线">
        <h3>领队决策时间线</h3>
        {leaderEntries.length === 0 && <p className="live-workbench-leader-empty">领队还没有产生决策记录。</p>}
        <ol className="live-leader-timeline">
          {leaderEntries.map((entry, index) => {
            const latest = index === leaderEntries.length - 1;
            return <li key={`${entry.round}-${index}`} ref={latest ? timelineEndRef : undefined} className={latest ? "live-leader-entry live-leader-entry--latest" : "live-leader-entry"}>
              <span className="live-leader-round" aria-label={`第 ${entry.round} 轮`}>R{entry.round}</span>
              <div className="live-leader-body">
                <div className="live-leader-action">
                  <strong>{entry.action}</strong>
                  <Stamp status={entry.status === "pending" ? "pending" : cardStamp(entry.status)} />
                </div>
                {entry.summary && <p>{entry.summary}</p>}
                {entry.assignments.length > 0 && <ul className="live-leader-assignments">
                  {entry.assignments.map((assignment, assignmentIndex) => <li key={assignmentIndex}>
                    <code>{assignment.roleId ?? "member"}</code>
                    <span>{assignment.task ?? assignment.workKind ?? "未命名任务"}</span>
                  </li>)}
                </ul>}
              </div>
            </li>;
          })}
        </ol>
        {progress?.leaderReport?.available && progress.leaderReport.gates.length > 0 && <p className="live-workbench-gates">
          Gates：{progress.leaderReport.gates.map((gate) => `${gate.gateId}=${gate.status}`).join(" · ")}
        </p>}
      </aside>
    </div>
    {progress && <p className="live-workbench-foot">更新于 {formatTime(progress.updatedAt)}{runId ? <> · Run <code>{runId}</code></> : null}</p>}
  </section>;
}
