/** 需求看板：九列数据契约、七列可见视图 + 三种正交异常态。列迁移走详情页。 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, cancelInvocation, getSession, monitorInvocation, startInvocation, type InvocationStartReceipt } from "./api";
import { ConversationComposer, ConversationMessageEvidence, type ComposerDraft } from "./ConversationComposer";
import { EmptyState, Field, Modal, RuntimeStatusChip, SelectControl, Stamp, formatTime, useDaemonAvailable } from "./components";
import { requirementAdvancementConfig, requirementOwnerLabel } from "./dashboard/advancement";
import { dashboardService, type DashboardService } from "./dashboard/service";
import type { ManagedProject, Requirement, RequirementException, RequirementPriority, SpaceNode } from "./dashboard/types";
import { acceptanceSnapshotFromPreview, isRunAcceptanceReady } from "./dashboard/acceptance";
import { REQUIREMENT_EXCEPTION_LABELS, REQUIREMENT_PRIORITY_LABELS, VISIBLE_REQUIREMENT_LANES, visibleRequirementLane } from "./dashboard/types";
import { ErrorBlock, OfflineNotice, PageHeader, SkeletonBlock, useServiceData } from "./dashboard/view";
import type { HumanDecisionRequest, InvocationRecord, JsonValue, Project, ProjectBinding, RunMergePreview, Session } from "./types";
import "./board-ai.css";

const REQUIREMENT_STEWARD_ROLE_ID = "requirement-steward";
const EMPTY_PROJECTS: Project[] = [];
const EMPTY_INVOCATIONS: InvocationRecord[] = [];
const EMPTY_HUMAN_DECISION_REQUESTS: HumanDecisionRequest[] = [];

interface AgentRequirementDraft {
  title: string;
  summary: string;
  priority: RequirementPriority;
  rawRequirement: string;
  acceptanceCriteria: string[];
}

interface RequirementStewardOutput {
  message: string;
  nextAction: "clarify" | "draft";
  draft?: AgentRequirementDraft | null;
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

export function requirementStewardOutput(value: JsonValue | undefined): RequirementStewardOutput | undefined {
  const output = objectValue(value);
  if (!output || typeof output.message !== "string" || (output.nextAction !== "clarify" && output.nextAction !== "draft")) return undefined;
  const candidate = objectValue(output.draft);
  const draft = candidate
    && typeof candidate.title === "string"
    && typeof candidate.summary === "string"
    && ["low", "medium", "high"].includes(String(candidate.priority))
    && typeof candidate.rawRequirement === "string"
    && Array.isArray(candidate.acceptanceCriteria)
    && candidate.acceptanceCriteria.every((item) => typeof item === "string")
    ? {
        title: candidate.title,
        summary: candidate.summary,
        priority: candidate.priority as RequirementPriority,
        rawRequirement: candidate.rawRequirement,
        acceptanceCriteria: candidate.acceptanceCriteria as string[]
      }
    : null;
  return { message: output.message, nextAction: output.nextAction, draft };
}

/**
 * Provider JSON occasionally contains a second, literal escaping layer. Decode only
 * line-break escapes here; React renders every resulting fragment as an escaped text
 * node, so message content can never introduce executable HTML.
 */
export function normalizeConversationLineBreaks(content: string): string {
  return content.replace(/\\r\\n|\\n|\\r/g, "\n");
}

function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*)/g).filter(Boolean).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : <Fragment key={index}>{part}</Fragment>
  );
}

export function ConversationMessageContent({ content }: { content: string }) {
  const lines = normalizeConversationLineBreaks(content).split("\n");
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const match = orderedList
          ? /^\s*\d+[.)]\s+(.+)$/.exec(lines[index]!)
          : /^\s*[-*+]\s+(.+)$/.exec(lines[index]!);
        if (!match) break;
        items.push(<li key={index}>{inlineMarkdown(match[1]!)}</li>);
        index += 1;
      }
      blocks.push(orderedList ? <ol key={`list-${index}`}>{items}</ol> : <ul key={`list-${index}`}>{items}</ul>);
      continue;
    }
    if (!line.trim()) {
      blocks.push(<div className="board-ai-message-spacer" aria-hidden="true" key={`blank-${index}`} />);
    } else {
      blocks.push(<p key={`paragraph-${index}`}>{inlineMarkdown(line)}</p>);
    }
    index += 1;
  }
  return <div className="board-ai-message-content">{blocks}</div>;
}

function exceptionChip(exception: Requirement["exception"]) {
  if (exception === "blocked") return <Stamp status="blocked" label={REQUIREMENT_EXCEPTION_LABELS.blocked} />;
  if (exception === "failed") return <Stamp status="failed" label={REQUIREMENT_EXCEPTION_LABELS.failed} />;
  if (exception === "cancelled") return <RuntimeStatusChip status="cancelled" label={REQUIREMENT_EXCEPTION_LABELS.cancelled} />;
  return null;
}

function deliveryProgressChip(requirement: Requirement) {
  if (requirement.lane !== "merging" || !requirement.delivery) return null;
  const labels: Record<NonNullable<Requirement["delivery"]>["status"], string> = {
    "queued-for-merge": "等待串行合入",
    retesting: "合入前重新验收",
    merging: "正在写入目标分支",
    merged: "合入完成",
    conflict: "冲突处理中",
    "returned-to-acceptance": "已退回验收"
  };
  const resolution = requirement.delivery.conflictResolution;
  const detail = requirement.delivery.message?.includes("目标仓库存在未提交改动") ? "等待目标仓库洁净"
    : resolution?.status === "resolving" ? "冲突处理中"
    : resolution?.status === "retesting" ? "候选复测中"
      : resolution?.status === "leader-review" ? "领队复验"
        : resolution?.status === "failed" ? (resolution.failureClass === "environment-blocked" ? "候选环境阻塞" : resolution.failureClass === "evidence-incomplete" ? "证据不完整" : resolution.failureClass === "product-failed" ? "产品回归失败" : "冲突处理失败")
          : labels[requirement.delivery.status];
  return <span className="board-evidence-capture" role="status" title={resolution?.message ?? requirement.delivery.message}>{detail}</span>;
}

interface AgentPendingTurn {
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

function formatAgentElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function BoardPage({ spaceId, go, notify, service = dashboardService, catalogRevision = "", sourceReady = true, sourceError, onRetrySource, projects: connectedProjects = EMPTY_PROJECTS, projectBindings, invocations = EMPTY_INVOCATIONS, humanDecisionRequests = EMPTY_HUMAN_DECISION_REQUESTS, onOpenRun }: {
  spaceId?: string;
  go: (hash: string) => void;
  notify: (message: string, kind?: "success" | "error") => void;
  service?: DashboardService;
  catalogRevision?: string;
  /** False while the app is fetching the authoritative bootstrap snapshot. */
  sourceReady?: boolean;
  sourceError?: string;
  onRetrySource?: () => void;
  projects?: Project[];
  /** When supplied by bootstrap, AI creation fails closed unless the required Project Role is assigned. */
  projectBindings?: ProjectBinding[];
  invocations?: InvocationRecord[];
  humanDecisionRequests?: HumanDecisionRequest[];
  onOpenRun?: (runId: string) => void;
}) {
  const daemonAvailable = useDaemonAvailable();
  const reportedAcceptanceWarnings = useRef(new Set<string>());
  const { state, reload, setData } = useServiceData<{ requirements: Requirement[]; nodes: SpaceNode[] }>(
    async () => {
      const [requirements, nodes] = await Promise.all([service.listBoard(spaceId), service.listSpaces()]);
      return { requirements, nodes };
    },
    [service, spaceId, catalogRevision],
    { enabled: sourceReady }
  );
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState(spaceId ?? "all");
  const [priority, setPriority] = useState<RequirementPriority | "all">("all");
  const [exception, setException] = useState<Exclude<RequirementException, null> | "all" | "normal">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState(spaceId ?? "");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [rawRequirement, setRawRequirement] = useState("");
  const [criteria, setCriteria] = useState("");
  const [createPriority, setCreatePriority] = useState<RequirementPriority>("medium");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [createProjectInvalid, setCreateProjectInvalid] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentProjectId, setAgentProjectId] = useState(spaceId ?? "");
  const [agentSession, setAgentSession] = useState<Session>();
  const [agentDraft, setAgentDraft] = useState<AgentRequirementDraft>();
  const [agentPhase, setAgentPhase] = useState<"idle" | "waiting" | "interrupted" | "clarify" | "draft">("idle");
  const [agentSourceMessages, setAgentSourceMessages] = useState<string[]>([]);
  const [agentError, setAgentError] = useState("");
  const [agentPending, setAgentPending] = useState<AgentPendingTurn>();
  const [agentNow, setAgentNow] = useState(() => Date.now());
  const agentGenerationRef = useRef(0);
  const agentAbortRef = useRef<AbortController | undefined>(undefined);

  const data = state.status === "ready" ? state.data : undefined;
  const project = data?.nodes.find((node) => node.id === spaceId && node.kind === "project");
  const projects = (data?.nodes ?? []).filter((node): node is ManagedProject => node.kind === "project" && !node.archivedAt);
  const requirementStewardProjectIds = new Set(
    projectBindings === undefined && connectedProjects.length === 0
      ? projects.map((candidate) => candidate.id)
      : connectedProjects.flatMap((candidate) => {
          if (candidate.status !== "active" || !candidate.roles.some((role) => role.id === REQUIREMENT_STEWARD_ROLE_ID)) return [];
          if (projectBindings === undefined) return [candidate.id];
          const binding = projectBindings
            .filter((entry) => entry.projectId === candidate.id && entry.projectVersion === candidate.version)
            .sort((left, right) => right.version - left.version)[0];
          return binding?.roles.some((role) => role.roleId === REQUIREMENT_STEWARD_ROLE_ID) ? [candidate.id] : [];
        })
  );
  // A project-scoped board must never inherit readiness from a different project.
  // Otherwise an assigned steward elsewhere makes this page's AI button appear
  // callable even though the current Project Role invocation will fail closed.
  const agentProjects = projects.filter((candidate) =>
    (!spaceId || candidate.id === spaceId) && requirementStewardProjectIds.has(candidate.id)
  );
  const defaultCreateProjectId = () => {
    const candidate = spaceId ?? (projectFilter !== "all" ? projectFilter : "");
    return projects.some((item) => item.id === candidate) ? candidate : "";
  };
  const defaultAgentProjectId = () => {
    const candidate = spaceId ?? (projectFilter !== "all" ? projectFilter : "");
    return agentProjects.some((item) => item.id === candidate) ? candidate : "";
  };
  const projectName = (projectId: string) => data?.nodes.find((node) => node.id === projectId)?.name ?? projectId;
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (data?.requirements ?? []).filter((item) => {
      if (!spaceId && projectFilter !== "all" && item.projectId !== projectFilter) return false;
      if (priority !== "all" && item.priority !== priority) return false;
      if (exception === "normal" && item.exception !== null) return false;
      if (exception !== "all" && exception !== "normal" && item.exception !== exception) return false;
      return !term || item.code.toLowerCase().includes(term) || item.title.toLowerCase().includes(term) || item.summary.toLowerCase().includes(term);
    });
  }, [data?.requirements, exception, priority, projectFilter, query, spaceId]);
  const grouped = useMemo(() => {
    const map = new Map<string, Requirement[]>(VISIBLE_REQUIREMENT_LANES.map((lane) => [lane.id, []]));
    for (const requirement of filtered) map.get(visibleRequirementLane(requirement.lane))?.push(requirement);
    return map;
  }, [filtered]);
  const actionGuidance = state.status !== "ready"
    ? "正在同步最新需求数据；同步完成后才可创建。"
    : projects.length === 0
      ? "还没有 active 项目。请先到项目页读取声明并完成接入。"
      : agentProjects.length === 0
        ? "手动创建可用；AI 需求入口需要项目声明 requirement-steward 角色，并在接入配置中完成员工分派。"
        : undefined;

  // The requirement board is a local projection; Invocation activity is the
  // durable source of truth. Reconcile whenever the app receives an SSE/bootstrap
  // update so approving or rejecting a human decision immediately moves the card
  // out of confirmation without requiring a detail-page visit or manual refresh.
  useEffect(() => {
    if (!data || invocations.length === 0) return;
    const invocationById = new Map(invocations.map((invocation) => [invocation.id, invocation]));
    const pending = data.requirements.flatMap((requirement) => {
      const advancement = requirement.advancement;
      if (!advancement?.invocationId) return [];
      const currentInvocation = invocationById.get(advancement.invocationId);
      if (!currentInvocation) return [];
      // A system/operator retry may intentionally create a fresh Invocation while preserving the
      // original browser-local requirement family (`source.contextId`). Adopt only a newer member
      // of that exact family: taskId alone is unsafe because different browser profiles may both
      // own a local `req-local-1` record.
      const invocation = (advancement.status === "blocked" || advancement.status === "failed")
        ? invocations
            .filter((candidate) => (
              candidate.id !== currentInvocation.id
              && candidate.source.project === currentInvocation.source.project
              && candidate.source.taskId === currentInvocation.source.taskId
              && candidate.source.contextId === currentInvocation.source.contextId
              && candidate.createdAt > currentInvocation.createdAt
            ))
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? currentInvocation
        : currentInvocation;
      const needsStatusSync = invocation.id !== advancement.invocationId || invocation.status !== advancement.status;
      const needsAcceptance = invocation.status === "completed"
        && requirement.lane !== "acceptance"
        && requirement.lane !== "merging"
        && requirement.lane !== "done";
      if (!needsStatusSync && !needsAcceptance) return [];
      return [{ requirement, advancement, invocation, needsStatusSync }];
    });
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      const updatedById = new Map<string, Requirement>();
      const warnings: string[] = [];
      const results = await Promise.allSettled(pending.map(async ({ requirement, advancement, invocation, needsStatusSync }) => {
        const config = requirementAdvancementConfig(
          connectedProjects.find((project) => project.id === requirement.projectId)
        );
        let updated = requirement;
        if (needsStatusSync) {
          updated = await service.syncRequirementAdvancement(requirement.id, advancement.idempotencyKey, {
            invocationId: invocation.id,
            runId: invocation.runId,
            leaderSessionId: invocation.sessionId,
            status: invocation.status,
            observedAt: invocation.updatedAt,
            error: invocation.error,
            ...(invocation.id !== advancement.invocationId ? { replacesInvocationId: advancement.invocationId } : {})
          }, config?.pollIntervalMs ?? 15_000);
        }
        if (invocation.status !== "completed" || !invocation.runId
          || updated.lane === "acceptance" || updated.lane === "merging" || updated.lane === "done") return updated;
        try {
          const preview = await api<RunMergePreview>(`/api/runs/${encodeURIComponent(invocation.runId)}/merge-preview`);
          if (preview.status === "merged" || preview.delivery?.status === "merged") {
            return service.syncRequirementDelivery(requirement.id, invocation.runId, "merged", {
              ...(preview.delivery?.updatedAt ? { serverUpdatedAt: preview.delivery.updatedAt } : {}),
              ...(preview.delivery?.message ? { message: preview.delivery.message } : {})
            });
          }
          if (!isRunAcceptanceReady(preview)) {
            const warning = `${requirement.code} 已完成，但交付证据尚未满足自动待验收门禁：${preview.reasons.join("；") || "交付预览未就绪"}`;
            const warningKey = `${requirement.id}:${invocation.runId}:${preview.status}:${warning}`;
            if (!reportedAcceptanceWarnings.current.has(warningKey)) {
              reportedAcceptanceWarnings.current.add(warningKey);
              warnings.push(warning);
            }
            return updated;
          }
          return service.submitRequirementForAcceptance(
            requirement.id,
            acceptanceSnapshotFromPreview(preview, new Date().toISOString())
          );
        } catch (error) {
          warnings.push(`${requirement.code} 自动提交待验收失败：${error instanceof Error ? error.message : String(error)}`);
          return updated;
        }
      }));
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled" && result.value !== pending[index]!.requirement) {
          updatedById.set(result.value.id, result.value);
        }
      }
      if (!cancelled && updatedById.size > 0) {
        setData({
          ...data,
          requirements: data.requirements.map((requirement) => updatedById.get(requirement.id) ?? requirement)
        });
      }
      if (!cancelled && warnings.length > 0) notify(warnings[0]!, "error");
      const rejectedIndex = results.findIndex((result) => result.status === "rejected");
      const rejected = rejectedIndex >= 0 ? results[rejectedIndex] as PromiseRejectedResult : undefined;
      if (!cancelled && rejected) {
        notify(`${pending[rejectedIndex]!.requirement.code} 需求推进状态同步失败：${rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason)}`, "error");
      }
    })();
    return () => { cancelled = true; };
  }, [connectedProjects, data, invocations, notify, service, setData]);

  useEffect(() => {
    if (!data) return;
    const pending = data.requirements.filter((requirement) => requirement.lane === "merging"
      && requirement.delivery
      && requirement.delivery.status !== "merged"
      && requirement.delivery.status !== "returned-to-acceptance"
      && requirement.delivery.conflictResolution?.status !== "failed");
    if (pending.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      const results = await Promise.allSettled(pending.map(async (requirement) => {
        const preview = await api<RunMergePreview>(`/api/runs/${encodeURIComponent(requirement.delivery!.runId)}/merge-preview`);
        const status = preview.delivery?.status ?? preview.status;
        if (!["queued-for-merge", "retesting", "merging", "merged", "conflict", "returned-to-acceptance"].includes(status)) return requirement;
        const targetBlocker = !preview.targetClean
          ? preview.reasons.find((reason) => reason.includes("目标仓库存在未提交改动"))
          : undefined;
        return service.syncRequirementDelivery(requirement.id, requirement.delivery!.runId, status as NonNullable<Requirement["delivery"]>["status"], {
          ...(preview.delivery?.updatedAt ? { serverUpdatedAt: preview.delivery.updatedAt } : {}),
          ...(targetBlocker || preview.delivery?.message ? { message: targetBlocker ?? preview.delivery!.message } : {}),
          ...(preview.delivery?.conflictResolution ? { conflictResolution: {
            status: preview.delivery.conflictResolution.status,
            ...(preview.delivery.conflictResolution.failureClass ? { failureClass: preview.delivery.conflictResolution.failureClass } : {}),
            ...(preview.delivery.conflictResolution.message ? { message: preview.delivery.conflictResolution.message } : {})
          } } : {})
        });
      }));
      if (cancelled) return;
      const updated = new Map<string, Requirement>();
      results.forEach((result, index) => {
        if (result.status === "fulfilled" && JSON.stringify(result.value.delivery) !== JSON.stringify(pending[index]?.delivery)) updated.set(result.value.id, result.value);
      });
      if (updated.size) setData({ ...data, requirements: data.requirements.map((requirement) => updated.get(requirement.id) ?? requirement) });
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [data, service, setData]);

  const openCreate = () => {
    setCreateProjectId(defaultCreateProjectId());
    setCreateProjectInvalid(false);
    setFormError("");
    setCreateOpen(true);
  };

  const stopAgentMonitor = () => {
    agentGenerationRef.current += 1;
    agentAbortRef.current?.abort();
    agentAbortRef.current = undefined;
  };

  useEffect(() => () => stopAgentMonitor(), []);

  useEffect(() => {
    if (!agentPending) return;
    const timer = window.setInterval(() => setAgentNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [agentPending?.startedAt]);

  const resetAgentConversation = (projectId = "") => {
    stopAgentMonitor();
    setAgentPending(undefined);
    setAgentProjectId(projectId);
    setAgentSession(undefined);
    setAgentDraft(undefined);
    setAgentPhase("idle");
    setAgentSourceMessages([]);
    setAgentError("");
  };

  const openAgentCreate = () => {
    // A pending turn survives close/reopen: same receipt, same cursor, reattach offered.
    if (!agentPending) resetAgentConversation(defaultAgentProjectId());
    setAgentOpen(true);
  };

  const closeAgentModal = () => {
    // Closing the window detaches the monitor only; the invocation keeps running
    // server-side and can be re-attached from the same receipt after reopening.
    if (agentPending && agentPending.monitorLive) {
      stopAgentMonitor();
      setAgentPending({ ...agentPending, phase: agentPending.phase === "cancelling" ? "cancelling" : "interrupted", monitorLive: false, error: "窗口关闭期间监听已断开；工单仍在服务端执行" });
      if (agentPending.phase !== "cancelling") setAgentPhase("interrupted");
    }
    setAgentOpen(false);
  };

  const runAgentMonitor = async (pending: AgentPendingTurn, generation: number, controller: AbortController) => {
    const { receipt } = pending;
    try {
      const terminal = await monitorInvocation(receipt, {
        signal: controller.signal,
        startCursor: pending.cursor,
        onUpdate: (result) => {
          if (agentGenerationRef.current !== generation) return;
          setAgentPending((current) => current && current.receipt.invocation.id === receipt.invocation.id ? {
            ...current,
            cursor: result.nextCursor,
            lastReason: result.reason === "terminal" ? current.lastReason : result.reason,
            lastUpdateAt: result.progress.updatedAt,
            lastStatus: result.progress.status,
            lastPhase: result.progress.phase
          } : current);
        }
      });
      if (!terminal || agentGenerationRef.current !== generation) return;
      await finishAgentTurn(pending, terminal.progress.status, generation);
    } catch (error) {
      if (controller.signal.aborted || agentGenerationRef.current !== generation) return;
      setAgentPending((current) => current ? {
        ...current,
        phase: current.phase === "cancelling" ? "cancelling" : "interrupted",
        monitorLive: false,
        error: `监听通道中断（${error instanceof Error ? error.message : String(error)}）`
      } : current);
      setAgentPhase((phase) => phase === "waiting" ? "interrupted" : phase);
    }
  };

  const finishAgentTurn = async (pending: AgentPendingTurn, status: string, generation: number) => {
    const { receipt } = pending;
    const current = () => agentGenerationRef.current === generation;
    if (status === "cancelled") {
      // 合约要求终态后仍拉取会话快照，看到什么显示什么；但取消场景后端不保证
      // 追加 Session 消息——确定保留的是 Invocation/Run 证据，文案必须指向卷宗。
      let session: Session | undefined;
      if (receipt.invocation.sessionId) {
        try {
          session = await getSession(receipt.invocation.sessionId);
        } catch {
          // 会话快照拉取失败不影响取消结论本身。
        }
      }
      if (!current()) return;
      if (session) setAgentSession(session);
      setAgentPending(undefined);
      setAgentPhase("idle");
      setAgentError(`已取消本次整理；取消与执行证据保留在运行卷宗 #${receipt.runId}`);
      return;
    }
    if (status !== "completed" && status !== "blocked") {
      if (!current()) return;
      setAgentPending(undefined);
      setAgentPhase("idle");
      setAgentError(`本次整理未成功（${status}）；证据已保留，请打开运行卷宗 #${receipt.runId} 核对`);
      return;
    }
    if (!receipt.invocation.sessionId) {
      if (!current()) return;
      setAgentPending(undefined);
      setAgentPhase("idle");
      setAgentError(`工单已结束（${status}）但回执缺少会话编号；请打开运行卷宗 #${receipt.runId} 核对证据`);
      return;
    }
    try {
      const session = await getSession(receipt.invocation.sessionId);
      if (!current()) return;
      const sourceMessages = [...agentSourceMessages, pending.message];
      setAgentPending(undefined);
      setAgentSession(session);
      setAgentSourceMessages(sourceMessages);
      const lastEmployeeMessage = [...session.messages].reverse().find((message) => message.role === "employee");
      const output = requirementStewardOutput(lastEmployeeMessage?.output);
      if (output?.nextAction === "draft" && output.draft) {
        setAgentDraft({
          ...output.draft,
          // 原始需求永远来自用户逐轮原话；Agent 无权用改写稿覆盖它。
          rawRequirement: sourceMessages.join("\n\n")
        });
        setAgentPhase("draft");
      } else if (output?.nextAction === "clarify") {
        setAgentPhase("clarify");
      }
      if (!output) {
        setAgentPhase("idle");
        setAgentError("Agent 已回复，但没有返回可识别的需求草稿；你可以继续说明，当前输入和附件证据都已保留在会话中。");
      }
    } catch (error) {
      if (!current()) return;
      setAgentPending(undefined);
      setAgentPhase("idle");
      setAgentError(`会话证据拉取失败（${error instanceof Error ? error.message : String(error)}）；请打开运行卷宗 #${receipt.runId} 核对`);
    }
  };

  const talkToRequirementSteward = async (draft: ComposerDraft): Promise<boolean> => {
    if (!agentProjectId || !requirementStewardProjectIds.has(agentProjectId)) return false;
    // 同一时刻只允许一张在途整理工单；控件已禁用，这里再做代码级兜底。
    if (agentPending) return false;
    setAgentError("");
    // A follow-up invalidates the visible draft immediately. The user must never be able to
    // confirm an older draft while the Agent is reconsidering scope or asking a new question.
    setAgentDraft(undefined);
    let receipt: InvocationStartReceipt;
    try {
      receipt = await startInvocation(
        `/api/projects/${encodeURIComponent(agentProjectId)}/conversations/${REQUIREMENT_STEWARD_ROLE_ID}/start`,
        {
          message: draft.message,
          sessionId: agentSession?.id,
          ...(draft.attachments.length > 0 ? { attachments: draft.attachments } : {})
        },
        {
          "x-multi-agent-source": "workbench",
          "x-multi-agent-source-label": "需求看板 · AI 对话创建",
          "x-multi-agent-project": agentProjectId
        }
      );
    } catch (error) {
      setAgentPhase("idle");
      setAgentError(error instanceof Error ? error.message : String(error));
      return false;
    }
    const generation = ++agentGenerationRef.current;
    agentAbortRef.current?.abort();
    const controller = new AbortController();
    agentAbortRef.current = controller;
    const pending: AgentPendingTurn = {
      receipt,
      message: draft.message,
      startedAt: Date.now(),
      cursor: receipt.monitor.initialCursor,
      phase: "waiting",
      monitorLive: true
    };
    setAgentPending(pending);
    setAgentPhase("waiting");
    void runAgentMonitor(pending, generation, controller);
    return true;
  };

  const cancelAgentTurn = async () => {
    if (!agentPending || agentPending.phase === "cancelling") return;
    try {
      await cancelInvocation(agentPending.receipt.invocation.id);
      setAgentPending((current) => current ? { ...current, phase: "cancelling", error: undefined } : current);
    } catch (error) {
      setAgentPending((current) => current ? { ...current, error: `取消请求未送达（${error instanceof Error ? error.message : String(error)}）；工单仍在等待终态` } : current);
    }
  };

  const remountAgentMonitor = () => {
    if (!agentPending || agentPending.monitorLive) return;
    agentAbortRef.current?.abort();
    const controller = new AbortController();
    agentAbortRef.current = controller;
    const pending: AgentPendingTurn = {
      ...agentPending,
      phase: agentPending.phase === "interrupted" ? "waiting" : agentPending.phase,
      monitorLive: true,
      error: undefined
    };
    setAgentPending(pending);
    setAgentPhase("waiting");
    setAgentError("");
    void runAgentMonitor(pending, agentGenerationRef.current, controller);
  };

  const confirmAgentRequirement = async () => {
    if (!data || !agentDraft || !agentProjectId) return;
    setSaving(true);
    setAgentError("");
    try {
      const created = await service.createRequirement({
        projectId: agentProjectId,
        title: agentDraft.title,
        summary: agentDraft.summary,
        priority: agentDraft.priority,
        rawRequirement: agentDraft.rawRequirement,
        acceptanceCriteria: agentDraft.acceptanceCriteria
      });
      setData({ ...data, requirements: [created, ...data.requirements] });
      setAgentOpen(false);
      resetAgentConversation();
      notify(`${created.code} 已由你确认创建并进入收件箱`);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const createRequirement = async () => {
    if (!data) return;
    if (!createProjectId) {
      setCreateProjectInvalid(true);
      setFormError("");
      window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="需求所属项目"]')?.focus());
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const created = await service.createRequirement({
        projectId: createProjectId, title, summary, priority: createPriority,
        rawRequirement, acceptanceCriteria: criteria.split("\n")
      });
      setData({ ...data, requirements: [created, ...data.requirements] });
      setCreateOpen(false);
      setTitle(""); setSummary(""); setRawRequirement(""); setCriteria(""); setCreatePriority("medium");
      notify(`${created.code} 已创建并进入收件箱`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return <main className="dash-page">
    <PageHeader
      eyebrow="BOARD / SEVEN LANES"
      title={project ? `${project.name} · 需求看板` : "需求看板"}
      description="七列流转；排队中 / 执行中 / 待确认 / 待合入只由真实 Run 自动更新。人工验收后进入串行合入队列；冲突会留在待合入并显示阻塞，由原领队规划取舍、委派工程角色在原 worktree rebase，再经独立重测与原领队复验；只有无法恢复的异常才退回待验收。"
      actions={<>{spaceId && <button type="button" className="button secondary" onClick={() => go(`projects/${spaceId}`)}>← 返回项目详情</button>}<button type="button" className="button secondary" aria-describedby={actionGuidance ? "board-action-guidance" : undefined} disabled={!daemonAvailable || state.status !== "ready" || projects.length === 0} title={state.status !== "ready" ? "正在同步最新需求数据" : projects.length === 0 ? "请先正式接入一个 active 项目" : undefined} onClick={openCreate}>手动创建</button><button type="button" className="button primary" aria-describedby={actionGuidance ? "board-action-guidance" : undefined} disabled={!daemonAvailable || state.status !== "ready" || agentProjects.length === 0} title={state.status !== "ready" ? "正在同步最新需求数据" : agentProjects.length === 0 ? "没有已分派需求管家角色的 active 项目；请先在项目接入中完成角色任用" : undefined} onClick={openAgentCreate}>和 AI 说需求</button></>}
    />
    {actionGuidance && <p id="board-action-guidance" className="dash-hint-line board-action-guidance" role="status">{actionGuidance}{state.status === "ready" && <button type="button" className="text-button" onClick={() => go("projects")}>前往项目接入 →</button>}</p>}
    <OfflineNotice />
    <div className="board-toolbar">
      <label className="space-search"><span className="sr-only">搜索需求</span><input type="search" placeholder="搜索编号、标题或摘要…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {!spaceId && <SelectControl ariaLabel="筛选项目" value={projectFilter} options={[{ value: "all", label: "全部项目" }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} onChange={setProjectFilter} />}
      <SelectControl ariaLabel="筛选优先级" value={priority} options={[{ value: "all", label: "全部优先级" }, { value: "high", label: "高优先级" }, { value: "medium", label: "中优先级" }, { value: "low", label: "低优先级" }]} onChange={(value) => setPriority(value as RequirementPriority | "all")} />
      <SelectControl ariaLabel="筛选异常状态" value={exception} options={[{ value: "all", label: "全部状态" }, { value: "normal", label: "无异常" }, { value: "blocked", label: "阻塞" }, { value: "failed", label: "失败" }, { value: "cancelled", label: "已取消" }]} onChange={(value) => setException(value as typeof exception)} />
    </div>
    {sourceError && <ErrorBlock message={sourceError} onRetry={onRetrySource ?? reload} />}
    {!sourceError && state.status === "loading" && <div className="board-scroll" role="status" aria-label="正在加载需求看板"><div className="board-grid board-grid--loading">{VISIBLE_REQUIREMENT_LANES.map((lane) => <section className="board-lane board-lane--loading" key={lane.id} aria-hidden="true"><header className="board-lane-head"><h2>{lane.label}</h2></header><SkeletonBlock rows={3} /></section>)}</div></div>}
    {!sourceError && state.status === "error" && <ErrorBlock message={state.error ?? "加载失败"} onRetry={reload} />}
    {state.status === "ready" && data && (filtered.length === 0
      ? data.requirements.length > 0
        ? <EmptyState title="无匹配需求" action={<button type="button" className="button secondary" onClick={() => { setQuery(""); setProjectFilter(spaceId ?? "all"); setPriority("all"); setException("all"); }}>清除筛选</button>}><p>当前搜索或筛选没有命中任何需求；清除后恢复完整看板，需求数据未受影响。</p></EmptyState>
        : <EmptyState title={projects.length === 0 ? "还没有可承接需求的项目" : "看板还没有需求"} action={projects.length === 0 ? <button type="button" className="button primary" onClick={() => go("projects")}>前往项目</button> : undefined}><p>{projects.length === 0 ? "只有正式接入且 active 的项目可以创建需求；被动 MCP 记录需要先升级。" : "需求会按列出现在这里；先由产品经理登记第一批需求。"}</p></EmptyState>
      : <div className="board-scroll" role="region" aria-label="需求看板（可横向滚动）" tabIndex={0}>
        <div className="board-grid">
          {VISIBLE_REQUIREMENT_LANES.map((lane) => {
            const cards = grouped.get(lane.id) ?? [];
            return <section className="board-lane" key={lane.id} aria-label={`${lane.label}（${cards.length} 条）`}>
              <header className="board-lane-head"><h2>{lane.label}</h2><span className="board-lane-count">{cards.length}</span></header>
              <div className="board-lane-body">
                {cards.map((requirement) => {
                  const advancementStatus = requirement.advancement?.status;
                  const awaitingDecision = advancementStatus === "awaiting-human-decision";
                  const endedAttempt = advancementStatus === "completed" || advancementStatus === "blocked"
                    || advancementStatus === "failed" || advancementStatus === "cancelled";
                  const runId = requirement.advancement?.runId;
                  const invocationId = requirement.advancement?.invocationId;
                  const invocationDecisions = invocationId
                    ? humanDecisionRequests.filter((request) => request.invocationId === invocationId)
                    : [];
                  const pendingDecision = invocationDecisions
                    .filter((request) => request.status === "pending")
                    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
                  const isRepeatedDecision = Boolean(pendingDecision && invocationDecisions.some((request) =>
                    request.id !== pendingDecision.id && (request.status === "approved" || request.status === "rejected")
                  ));
                  const openRequirement = () => go(`requirements/${requirement.id}`);
                  const openDecision = () => {
                    if (runId && onOpenRun) onOpenRun(runId);
                    else openRequirement();
                  };
                  const actionTitle = awaitingDecision
                    ? (isRepeatedDecision ? "新的确认请求" : "等待你的决定")
                    : advancementStatus === "completed" ? "执行已结束，核对交付"
                      : advancementStatus === "cancelled" ? "本轮已取消，选择后续动作"
                        : advancementStatus === "blocked" ? "本轮已阻塞，需要处理"
                          : advancementStatus === "failed" ? "本轮失败，需要处理" : "";
                  const actionDetail = awaitingDecision
                    ? (pendingDecision
                        ? `${isRepeatedDecision ? "上一项决定已生效；" : ""}Run 在第 ${pendingDecision.round} 轮暂停 · ${formatTime(pendingDecision.createdAt)}`
                        : "Run 已暂停，不会自行继续")
                    : advancementStatus === "completed" ? "执行完成不等于需求交付；请核对证据并决定验收、保留或丢弃。"
                      : advancementStatus === "cancelled" ? "原 Run 证据已保留；可在需求详情明确启动后继周期。"
                        : "先查看根因与原始证据，修复配置或方案后再创建后继周期。";
                  const openAttention = () => {
                    if (awaitingDecision) return openDecision();
                    go(`requirements/${requirement.id}${advancementStatus === "completed" ? "?section=run" : ""}`);
                  };
                  const actionLabel = awaitingDecision
                    ? (runId && onOpenRun ? "处理待确认 →" : "查看待确认详情 →")
                    : advancementStatus === "completed" ? "核对交付与验收 →"
                      : advancementStatus === "cancelled" ? "查看并新建后继周期 →"
                        : "查看原因并重新推进 →";
                  return <article key={requirement.id}
                    className={`board-card${awaitingDecision || endedAttempt ? " board-card--confirmation" : ""}${requirement.exception ? ` board-card--${requirement.exception}` : ""}`}>
                    <button type="button" className="board-card-main" onClick={openRequirement} aria-label={`查看需求详情：${requirement.code} ${requirement.title}`}>
                      <div className="board-card-top"><code>{requirement.code}</code>{!spaceId && <span className="board-card-project" title={projectName(requirement.projectId)}>{projectName(requirement.projectId)}</span>}</div>
                      <strong>{requirement.title}</strong>
                      <p>{requirement.summary}</p>
                      <footer>
                        <span className={`board-priority board-priority--${requirement.priority}`}>{REQUIREMENT_PRIORITY_LABELS[requirement.priority]}</span>
                        <span>{requirementOwnerLabel(requirement)}</span>
                        <time>{formatTime(requirement.updatedAt)}</time>
                        {deliveryProgressChip(requirement)}
                        {(requirement.evidenceCapture?.status === "queued" || requirement.evidenceCapture?.status === "running") && <span className="board-evidence-capture" role="status">验收补采中</span>}
                        {requirement.evidenceCapture?.status === "failed" && <span className="board-evidence-capture board-evidence-capture--failed" role="status">验收证据待处理{requirement.evidenceCapture.mediaCount ? ` · 已保留 ${requirement.evidenceCapture.mediaCount} 项` : ""}</span>}
                        {exceptionChip(requirement.exception)}
                      </footer>
                    </button>
                    {(awaitingDecision || endedAttempt) && <div className="board-card-confirmation" role="group" aria-label={actionTitle}>
                      <span>
                        <strong>{actionTitle}</strong>
                        <small>{actionDetail}</small>
                      </span>
                      <button type="button" className="button primary" onClick={openAttention}>{actionLabel}</button>
                    </div>}
                  </article>;
                })}
                {cards.length === 0 && <div className="board-lane-empty">暂无需求</div>}
              </div>
            </section>;
          })}
        </div>
      </div>)}
    <span className="sr-only" role="status">{state.status === "ready" && data ? `当前显示 ${filtered.length} 条需求` : ""}</span>

    {createOpen && <Modal title="创建需求" eyebrow="REQUIREMENT · INBOX" onClose={() => setCreateOpen(false)} wide>
      <form className="modal-body compact-form board-create-form" onSubmit={(event) => { event.preventDefault(); void createRequirement(); }}>
        <Field label="项目" hint="请先选择需求所属项目"><SelectControl ariaLabel="需求所属项目" value={createProjectId} placeholder="请选择所属项目" invalid={createProjectInvalid} errorMessage={createProjectInvalid ? "请选择需求所属项目后再创建。" : undefined} options={projects.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => { setCreateProjectId(value); setCreateProjectInvalid(false); }} /></Field>
        <Field label="优先级"><SelectControl ariaLabel="需求优先级" value={createPriority} options={[{ value: "high", label: "高" }, { value: "medium", label: "中" }, { value: "low", label: "低" }]} onChange={(value) => setCreatePriority(value as RequirementPriority)} /></Field>
        <Field label="标题"><input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
        <Field label="摘要"><input maxLength={160} value={summary} onChange={(event) => setSummary(event.target.value)} /></Field>
        <Field label="原始需求"><textarea required rows={5} value={rawRequirement} onChange={(event) => setRawRequirement(event.target.value)} /></Field>
        <Field label="验收标准" hint="每行一条"><textarea rows={4} value={criteria} onChange={(event) => setCriteria(event.target.value)} /></Field>
        {formError && <p className="dash-form-error" role="alert">{formError}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setCreateOpen(false)}>取消</button><button type="submit" className="button primary" disabled={saving || !createProjectId}>{saving ? "创建中…" : "创建并进入收件箱"}</button></div>
      </form>
    </Modal>}
    {agentOpen && <Modal title="和 AI 说需求" eyebrow="REQUIREMENT STEWARD · DRAFT ONLY" onClose={closeAgentModal} wide className="board-ai-modal">
      <div className="board-ai-layout">
        <section className="board-ai-conversation" aria-label="需求管家对话">
          <header><div><span className="ai-content-badge">AI 生成内容</span><h3>先描述，再决定怎么推进</h3></div><p>文字、粘贴图片和飞书文档都会进入同一份会话证据；Agent 只整理草稿，不会替你创建需求。</p></header>
          <Field label="所属项目"><SelectControl ariaLabel="AI 需求所属项目" value={agentProjectId} placeholder="请选择所属项目" disabled={Boolean(agentPending)} options={agentProjects.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => { if (!agentPending) resetAgentConversation(value); }} /></Field>
          {!agentProjectId && <p className="muted">请先选择归属项目，再向需求管家描述需求。</p>}
          <div className="board-ai-transcript" aria-live="polite">
            {!agentSession && <div className="board-ai-welcome"><strong>把现在知道的都说出来</strong><p>可以是零散描述、界面截图或飞书 docx / wiki 链接。信息不足时我会先追问；足够时才给出可编辑草稿。</p></div>}
            {agentSession?.messages.map((message) => <article className={`board-ai-message board-ai-message--${message.role}`} key={message.id}>
              <div><strong>{message.role === "user" ? "你" : message.role === "employee" ? "需求管家" : "系统"}</strong><time>{formatTime(message.at)}</time>{message.runId && <code>{message.runId}</code>}</div>
              <ConversationMessageContent content={message.content} />
              <ConversationMessageEvidence attachments={message.attachments} documents={message.documents} />
            </article>)}
            {(agentPhase === "waiting" || agentPhase === "interrupted") && agentPending && <article className="board-ai-message board-ai-message--employee board-ai-message--waiting" aria-live="polite" aria-label="需求管家整理中">
              <div><strong>需求管家</strong><span>{agentPending.phase === "cancelling" ? "取消中" : agentPhase === "interrupted" ? "监听中断" : "整理中"}</span><time>{formatAgentElapsedMs(agentNow - agentPending.startedAt)}</time></div>
              <div className="board-ai-waiting-dots" aria-hidden="true"><span /><span /><span /></div>
              <p className="board-ai-waiting-status" role="status">{agentPending.phase === "cancelling"
                ? agentPending.monitorLive ? "取消请求已送达，等待服务端确认终态…" : "取消请求已送达；监听未挂载，可重新挂载以观察取消终态"
                : agentPhase === "interrupted"
                  ? "监听通道中断（网络或服务暂时不可达）；工单回执与进度仍保留在服务端"
                  : agentPending.lastReason === "heartbeat"
                    ? `心跳 · 最近更新 ${formatTime(agentPending.lastUpdateAt)}`
                    : agentPending.lastStatus || agentPending.lastPhase
                      ? `${agentPending.lastStatus ?? "等待"} · ${agentPending.lastPhase ?? "排队中"}`
                      : "已受理，等待服务端进度…"}</p>
              <div className="board-ai-waiting-actions">
                <a className="board-ai-waiting-evidence" href={`#runs/${encodeURIComponent(agentPending.receipt.runId)}`}>打开运行卷宗 #{agentPending.receipt.runId}</a>
                {!agentPending.monitorLive && <button type="button" className="button secondary" onClick={remountAgentMonitor}>重新挂载监听</button>}
                <button type="button" className="button secondary" disabled={agentPending.phase === "cancelling"} onClick={() => void cancelAgentTurn()}>取消</button>
              </div>
              {agentPending.error && <p className="board-ai-waiting-error" role="alert">{agentPending.error}</p>}
            </article>}
          </div>
          {agentError && <p className="dash-form-error" role="alert">{agentError}</p>}
          <ConversationComposer
            ariaLabel="描述需求"
            placeholder="例如：购物车空态需要增加优惠推荐；这里是截图和飞书 PRD…"
            disabled={!daemonAvailable || !agentProjectId || Boolean(agentPending)}
            offlineHint={agentPending ? "需求管家整理中，结束后才能继续说明" : undefined}
            submitLabel={agentSession ? "继续说明" : "交给需求管家"}
            sendingLabel="需求管家整理中…"
            onSend={talkToRequirementSteward}
          />
        </section>
        <section className="board-ai-draft" aria-label="待确认需求草稿">
          <header><div><span>DRAFT · HUMAN CONFIRMATION</span><h3>可编辑草稿</h3></div><p>右侧字段在你点击确认前不会写入看板。原始需求固定保留你的逐轮原话。</p></header>
          {!agentDraft ? <div className="board-ai-draft-empty"><strong>{agentPhase === "waiting" ? "需求管家正在判断…" : agentPhase === "clarify" ? "需要你补充一点" : "尚未形成草稿"}</strong><p>{agentPhase === "clarify" ? "请回答左侧对话中的问题；补充内容会进入同一个会话，旧草稿已失效。" : "继续在左侧说明；需求管家会按信息完整度选择追问或起草。"}</p></div> : <div className="board-ai-draft-fields">
            <Field label="优先级"><SelectControl ariaLabel="AI 草稿优先级" value={agentDraft.priority} options={[{ value: "high", label: "高" }, { value: "medium", label: "中" }, { value: "low", label: "低" }]} onChange={(value) => setAgentDraft({ ...agentDraft, priority: value as RequirementPriority })} /></Field>
            <Field label="标题"><input required maxLength={80} value={agentDraft.title} onChange={(event) => setAgentDraft({ ...agentDraft, title: event.target.value })} /></Field>
            <Field label="摘要"><input maxLength={160} value={agentDraft.summary} onChange={(event) => setAgentDraft({ ...agentDraft, summary: event.target.value })} /></Field>
            <Field label="原始需求" hint="保留你的逐轮原话，可在确认前补充"><textarea rows={6} value={agentDraft.rawRequirement} onChange={(event) => setAgentDraft({ ...agentDraft, rawRequirement: event.target.value })} /></Field>
            <Field label="验收标准" hint="每行一条"><textarea rows={6} value={agentDraft.acceptanceCriteria.join("\n")} onChange={(event) => setAgentDraft({ ...agentDraft, acceptanceCriteria: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} /></Field>
          </div>}
          <footer className="board-ai-confirm"><span>{agentDraft ? "只有下方确认按钮会调用 createRequirement。" : agentPhase === "clarify" ? "等待你的补充；当前对话不会写入看板。" : "等待需求草稿；当前对话不会写入看板。"}</span><button type="button" className="button primary" disabled={!agentProjectId || !agentDraft || saving || !agentDraft.title.trim() || !agentDraft.rawRequirement.trim()} onClick={() => void confirmAgentRequirement()}>{saving ? "创建中…" : "确认创建并进入收件箱"}</button></footer>
        </section>
      </div>
    </Modal>}
  </main>;
}
