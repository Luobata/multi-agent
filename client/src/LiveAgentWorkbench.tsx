import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useActivityStream } from "./ActivityStream";
import { Stamp, formatTime, type StampStatus } from "./components";
import type { InvocationProgress, InvocationStatus, WorkInstanceRecord, WorkInstanceStatus } from "./types";

/**
 * 实时 Agent 工作台：需求详情 Run 分区的只读可视化增量。
 * 首次用 /api/invocations/:id/progress 快照填充，随后消费 App 持有的共享
 * /api/activity/stream（ActivityStreamContext）做增量更新，本组件不自建 EventSource；
 * 共享流 offline 时降级为 5s 轮询，页面不可见时暂停。没有任何输入或操作控件。
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
  const { activity, status: streamStatus } = useActivityStream();
  const [progress, setProgress] = useState<InvocationProgress | undefined>(undefined);
  const [liveInstances, setLiveInstances] = useState<Map<string, WorkInstanceRecord>>(new Map());
  const [feed, setFeed] = useState<FeedState>("connecting");
  const [loadError, setLoadError] = useState("");
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const timelineEndRef = useRef<HTMLLIElement | null>(null);
  const seenRoundsRef = useRef(0);

  const terminal = Boolean(progress && (progress.terminal || TERMINAL_INVOCATION_STATUSES.includes(progress.status)));

  const loadSnapshot = useCallback(() => {
    if (!invocationId) return;
    api<InvocationProgress>(`/api/invocations/${encodeURIComponent(invocationId)}/progress`)
      .then((snapshot) => {
        const valid = asProgress(snapshot);
        if (valid) {
          setProgress(valid);
          setLoadError("");
        }
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [invocationId]);

  // 首次进入与切换 invocation 时用 progress 快照填充；实时增量由下方 context 同步负责。
  useEffect(() => {
    if (!invocationId) return;
    setProgress(undefined);
    setLiveInstances(new Map());
    setLoadError("");
    loadSnapshot();
  }, [invocationId, loadSnapshot]);

  // 消费 App 持有的共享 SSE 快照：只挑属于当前 invocation 的 instance/invocation 合并。
  useEffect(() => {
    if (!invocationId || paused) return;
    if (streamStatus === "offline") {
      setFeed("polling");
      return;
    }
    setFeed(streamStatus === "live" ? "live" : "connecting");
    const relevant = activity.instances.filter((instance) => instance.invocationId === invocationId);
    if (relevant.length > 0) {
      setLiveInstances((current) => {
        const next = new Map(current);
        for (const record of relevant) next.set(record.nodeId, record);
        return next;
      });
    }
    const invocation = activity.invocations.find((entry) => entry.id === invocationId);
    if (invocation) {
      setProgress((current) => current
        ? { ...current, status: invocation.status, phase: invocation.phase, terminal: TERMINAL_INVOCATION_STATUSES.includes(invocation.status), updatedAt: invocation.updatedAt }
        : current);
    }
  }, [activity, streamStatus, invocationId, paused]);

  // 共享流不可用时降级为 5s 轮询，行为与上一版一致。
  useEffect(() => {
    if (feed !== "polling" || !invocationId || paused) return undefined;
    const timer = window.setInterval(loadSnapshot, 5000);
    return () => window.clearInterval(timer);
  }, [feed, invocationId, paused, loadSnapshot]);

  // 页面不可见时暂停展示更新；回到前台时立即补一次快照。
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        setPaused(true);
        setFeed("paused");
      } else {
        setPaused(false);
        loadSnapshot();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [loadSnapshot]);

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
