import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, writeBody } from "./api";
import { DossierSection, EmptyState, Modal, SelectControl, Stamp, formatTime, scrollRecordIntoView } from "./components";
import { SupervisorRunTopology } from "./SupervisorRunTopology";
import { EffectiveProfileView } from "./EffectiveProfileView";
import { acceptanceSnapshotFromPreview, isRunAcceptanceReady } from "./dashboard/acceptance";
import type { DashboardService } from "./dashboard/service";
import type { Requirement } from "./dashboard/types";
import type { HumanDecisionRequest, InvocationProgress, InvocationRecord, Run, RunDeliveryActionResult, RunDeliveryRecord, RunMergePreview, RunMergeQueueResult, RunNode, RunWorktreeOpenResult } from "./types";
import { CATEGORY_LABELS, filterRuns } from "./runs/filters";
import { objectValue } from "./runs/shared";
import { E2eEvidenceList, e2eEvidenceEntries } from "./runs/evidence";
import { DecisionTimeline, GateVerdictList, RunStepsTable, SupervisorLimitsLine, gateVerdicts, supervisorLiveState } from "./runs/supervisor";
import { HumanDecisionConfirmation, HumanDecisionPanel, type HumanDecisionKind } from "./runs/humanDecisions";
import { RunDeliveryPanel, RunDiscardConfirmation, RunKeepConfirmation, RunMergeConfirmation } from "./runs/delivery";

export { acceptanceSnapshotFromPreview, isRunAcceptanceReady } from "./dashboard/acceptance";
export { filterRuns } from "./runs/filters";
export { sortHumanDecisionRequests, type HumanDecisionKind } from "./runs/humanDecisions";

function supervisorDecision(node: RunNode): { action: string; summary?: string } | undefined {
  if (node.metadata?.kind !== "supervisor") return undefined;
  const output = objectValue(node.output);
  if (typeof output?.action !== "string") return undefined;
  return { action: output.action, summary: typeof output.summary === "string" ? output.summary : undefined };
}

function finalSummary(run: Run): string | undefined {
  const output = objectValue(run.output);
  return typeof output?.summary === "string" ? output.summary : undefined;
}

function dagFlowTag(node: RunNode): string {
  if (node.metadata?.kind !== "member" || typeof node.metadata.flowNodeId !== "string") return "";
  const kind = typeof node.metadata.flowNodeKind === "string" ? node.metadata.flowNodeKind : "dag";
  const execution = typeof node.metadata.flowNodeExecution === "number" && node.metadata.flowNodeExecution > 1
    ? ` · 第 ${node.metadata.flowNodeExecution} 次执行`
    : "";
  return ` · 环节 ${node.metadata.flowNodeId} [${kind}]${execution}`;
}

/** Renders the run's worktree-isolation evidence as a `<dd>`; falls back to "普通" when absent. */
function IsolationValue({ isolation }: { isolation: Run["isolation"] }) {
  if (isolation?.mode === "worktree") {
    return <span className="run-isolation run-isolation--worktree">worktree{isolation.worktreePath && <> · <code className="path-code">{isolation.worktreePath}</code></>}</span>;
  }
  if (isolation?.fallbackReason) {
    return <span className="run-isolation run-isolation--fallback">回退 · {isolation.fallbackReason}</span>;
  }
  return <span className="run-isolation run-isolation--none">普通</span>;
}

/** Client mirror of `WorkflowProgressWaitResult` (src/workbench/invocationProgress.ts), fields optional for tolerance. */
interface ProgressWaitResult {
  nextCursor?: string;
  changed?: boolean;
  terminal?: boolean;
  progress?: InvocationProgress;
}

export function RunsPage({ notify, activityRevision = "", focusedRunId = "", pendingRunId = "", onConsumePending, onSelectRun, onDashboardSync, onOpenRequirement, mode = "full", view = "all", dashboard, fromStudio = false, onReturnOffice }: {
  notify: (message: string, kind?: "success" | "error") => void;
  activityRevision?: string;
  focusedRunId?: string;
  /** @deprecated use focusedRunId; retained for callers during the hash-routing migration. */
  pendingRunId?: string;
  onConsumePending?: () => void;
  onSelectRun?: (runId: string) => void;
  onDashboardSync?: (requirement: Requirement) => void;
  onOpenRequirement?: (requirementId: string, section?: "overview" | "run" | "acceptance") => void;
  mode?: "full" | "embedded";
  view?: "all" | "acceptance";
  fromStudio?: boolean;
  onReturnOffice?: () => void;
  /** 可选看板服务；注入后合格交付可以把验收快照原子写回需求看板。 */
  dashboard?: DashboardService;
}) {
  const requestedRunId = focusedRunId || pendingRunId;
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState(requestedRunId);
  const [detail, setDetail] = useState<Run>();
  const [detailLoading, setDetailLoading] = useState(Boolean(requestedRunId));
  const [receipt, setReceipt] = useState<Record<string, unknown>>();
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const dossierTitleRef = useRef<HTMLHeadingElement>(null);
  const [categoryFilter, setCategoryFilter] = useState<"all" | "single" | "graph" | "supervisor">("all");
  const [projectFilter, setProjectFilter] = useState<"all" | "none" | string>("all");
  const [mergePreview, setMergePreview] = useState<RunMergePreview>();
  const [mergePreviewLoading, setMergePreviewLoading] = useState(false);
  const [deliveryRevision, setDeliveryRevision] = useState(0);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeConfirmed, setMergeConfirmed] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState("");
  const [keepOpen, setKeepOpen] = useState(false);
  const [keepNote, setKeepNote] = useState("");
  const [keeping, setKeeping] = useState(false);
  const [keepError, setKeepError] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardToken, setDiscardToken] = useState("");
  const [discardNote, setDiscardNote] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState("");
  const [boardSubmitting, setBoardSubmitting] = useState(false);
  const [boardSubmitError, setBoardSubmitError] = useState("");
  const [evidenceRerunError, setEvidenceRerunError] = useState("");
  const [conflictRetrying, setConflictRetrying] = useState(false);
  const [conflictRetryError, setConflictRetryError] = useState("");
  const [openingWorktree, setOpeningWorktree] = useState(false);
  const [humanRequests, setHumanRequests] = useState<HumanDecisionRequest[]>([]);
  const [humanRequestsLoading, setHumanRequestsLoading] = useState(false);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [decisionTarget, setDecisionTarget] = useState<{ request: HumanDecisionRequest; decision: HumanDecisionKind }>();
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [decisionRevision, setDecisionRevision] = useState(0);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [progress, setProgress] = useState<InvocationProgress>();
  // Supervisor dossiers prefer the cursor long-poll; any malformed/failed wait response
  // falls back to the interval refresh below so a missing endpoint can never freeze the UI.
  const [progressChannel, setProgressChannel] = useState<"idle" | "longpoll" | "interval">("idle");
  const [acceptanceBinding, setAcceptanceBinding] = useState<{ taskId: string; runId?: string; capturedAt?: string }>();
  const [acceptanceBindingError, setAcceptanceBindingError] = useState("");
  const detailRunIdRef = useRef("");
  // A deep link should reveal its Run once when the operator enters the dossier.
  // Activity SSE updates also refresh this list; treating every refresh as a new
  // navigation would repeatedly scroll the operator away from the evidence they
  // are currently reading.
  const revealedRunIdRef = useRef("");
  // Dashboard projection callbacks are UI events, not polling inputs. Keeping the
  // latest callback in a ref prevents an inline parent callback from retriggering
  // terminal delivery/capture effects on every render.
  const onDashboardSyncRef = useRef(onDashboardSync);
  onDashboardSyncRef.current = onDashboardSync;
  // A focused Run is navigation state, so apply prop changes before the browser
  // can paint the previous dossier. This is especially important for the
  // requirement-embedded view, where acting on a stale Run could mutate the
  // wrong delivery record.
  useLayoutEffect(() => {
    if (requestedRunId) setSelectedId(requestedRunId);
  }, [requestedRunId]);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setListError("");
    api<Run[]>("/api/runs?limit=100").then((value) => {
      if (!current) return;
      setRuns(value);
      // A focused Run is authoritative. Never briefly select the newest Run
      // while its list entry is loading or when switching requirement dossiers.
      setSelectedId((selected) => requestedRunId || selected || value[0]?.id || "");
      if (requestedRunId && value.some((run) => run.id === requestedRunId)) {
        if (pendingRunId) onConsumePending?.();
      }
    }).catch((error: unknown) => {
      if (current) setListError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (current) { setLoading(false); setRetrying(false); } });
    return () => { current = false; };
  }, [notify, activityRevision, requestedRunId, pendingRunId, onConsumePending, mode]);
  useEffect(() => {
    if (!requestedRunId) {
      revealedRunIdRef.current = "";
      return;
    }
    if (mode !== "full"
      || revealedRunIdRef.current === requestedRunId
      || !runs.some((run) => run.id === requestedRunId)) return;
    revealedRunIdRef.current = requestedRunId;
    if (typeof window.matchMedia === "function") scrollRecordIntoView(requestedRunId);
  }, [mode, requestedRunId, runs]);
  useEffect(() => {
    if (!selectedId) {
      detailRunIdRef.current = "";
      setDetail(undefined);
      setDetailLoading(false);
      return;
    }
    let current = true;
    // Clear only when the operator selects another Run. Activity SSE updates refresh the same
    // dossier in the background; blanking it first changes page height and visibly jumps scroll.
    if (detailRunIdRef.current !== selectedId) {
      detailRunIdRef.current = selectedId;
      setDetail(undefined);
    }
    setDetailLoading(true);
    setDetailError("");
    api<Run>(`/api/runs/${encodeURIComponent(selectedId)}`)
      .then((value) => { if (current) { setDetail(value); setRetrying(false); } })
      .catch((error: unknown) => { if (current) { setDetailError(error instanceof Error ? error.message : String(error)); setRetrying(false); } })
      .finally(() => { if (current) setDetailLoading(false); });
    return () => { current = false; };
  }, [selectedId, activityRevision, decisionRevision, loadRevision]);
  useEffect(() => {
    if (!selectedId || !/(?:\?|&)view=receipt(?:&|$)/.test(window.location.hash)) { setReceipt(undefined); return; }
    let current = true;
    api<Record<string, unknown>>(`/api/runs/${encodeURIComponent(selectedId)}/receipt`).then(value => { if (current) setReceipt(value); }).catch(() => { if (current) setReceipt(undefined); });
    return () => { current = false; };
  }, [selectedId, activityRevision, loadRevision]);
  const projectOptions = useMemo(
    () => [...new Set(runs.map((run) => run.project).filter((project): project is string => Boolean(project)))].sort(),
    [runs]
  );
  const visibleRuns = useMemo(
    () => filterRuns(runs, { category: categoryFilter, project: projectFilter }),
    [runs, categoryFilter, projectFilter]
  );
  const directed = Boolean(requestedRunId);
  // 目标 Run 可能早于 /api/runs?limit=100 的窗口：只要详情端点能取回同 id 的卷宗，
  // 就渲染它，而不是误报「正在建立」。详情 404 时仍保留原有的建立中/重试表达。
  const targetMissing = Boolean(pendingRunId) && !loading && !listError && !runs.some((run) => run.id === pendingRunId)
    && !detailLoading && detail?.id !== pendingRunId;
  const summary = visibleRuns.find((run) => run.id === selectedId) ?? (directed ? undefined : visibleRuns[0]);
  const selected = detail?.id === selectedId ? detail : summary;
  // Running dossiers refresh every two seconds. Keep the last complete dossier interactive
  // while those background reads are in flight; the skeleton is only an initial empty state.
  const showDossierSkeleton = !selected && (loading || (directed && detailLoading));
  const acceptanceBindingLoading = Boolean(dashboard && selected?.taskId && acceptanceBinding?.taskId !== selected.taskId);
  const acceptanceRunId = acceptanceBinding && acceptanceBinding.taskId === selected?.taskId ? acceptanceBinding.runId : undefined;
  useEffect(() => {
    if (!dashboard || !selected?.taskId) {
      setAcceptanceBinding(undefined);
      setAcceptanceBindingError("");
      return;
    }
    let current = true;
    setAcceptanceBindingError("");
    dashboard.getRequirement(selected.taskId)
      .then((requirement) => {
        if (current) setAcceptanceBinding({
          taskId: selected.taskId!,
          runId: requirement.evidence.acceptance?.runId,
          capturedAt: requirement.evidence.acceptance?.capturedAt
        });
      })
      .catch(() => {
        if (current) {
          setAcceptanceBinding({ taskId: selected.taskId! });
          setAcceptanceBindingError(selected.taskId!);
        }
      });
    return () => { current = false; };
  }, [dashboard, selected?.taskId]);
  useEffect(() => {
    if (!selected?.id || targetMissing) return;
    window.scrollTo({ top: 0, behavior: "auto" });
    window.requestAnimationFrame(() => dossierTitleRef.current?.focus());
  }, [selected?.id, targetMissing]);
  useEffect(() => {
    if (!targetMissing || !pendingRunId) return;
    const timer = window.setInterval(() => setLoadRevision((value) => value + 1), 2000);
    return () => window.clearInterval(timer);
  }, [targetMissing, pendingRunId]);
  const supervisorInvocationId = selected?.architecture === "supervisor" ? selected.invocation?.id : undefined;
  useEffect(() => {
    if (!supervisorInvocationId) {
      setProgress(undefined);
      return;
    }
    let current = true;
    api<InvocationProgress>(`/api/invocations/${encodeURIComponent(supervisorInvocationId)}/progress`)
      .then((value) => { if (current) setProgress(value); })
      .catch(() => { /* the dossier still renders from the run record itself */ });
    return () => { current = false; };
  }, [supervisorInvocationId, activityRevision, loadRevision]);
  useEffect(() => {
    if (!supervisorInvocationId || selected?.status !== "running" || targetMissing) return;
    let cancelled = false;
    let cursor: string | undefined;
    setProgressChannel((channel) => channel === "longpoll" ? channel : "longpoll");
    const loop = async () => {
      while (!cancelled) {
        try {
          const result = await api<ProgressWaitResult>(`/api/invocations/${encodeURIComponent(supervisorInvocationId)}/progress/wait?timeoutMs=20000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          if (cancelled) return;
          if (!result || typeof result.nextCursor !== "string" || !result.progress) throw new Error("progress wait result is malformed");
          cursor = result.nextCursor;
          setProgress(result.progress);
          if (result.changed || result.terminal) setLoadRevision((value) => value + 1);
          if (result.terminal) return;
          // Yield between iterations so an instantly-resolving (mocked or proxied) endpoint
          // can never spin the render loop; the server normally holds this request open.
          await new Promise((resolve) => setTimeout(resolve, 250));
        } catch {
          if (!cancelled) setProgressChannel("interval");
          return;
        }
      }
    };
    void loop();
    return () => {
      cancelled = true;
      setProgressChannel((channel) => channel === "longpoll" ? "idle" : channel);
    };
  }, [supervisorInvocationId, selected?.status, targetMissing]);
  useEffect(() => {
    if (selected?.status !== "running" || targetMissing) return;
    // The interval is the documented fallback: it stays off while the long-poll channel is live.
    if (supervisorInvocationId && progressChannel === "longpoll") return;
    const timer = window.setInterval(() => setLoadRevision((value) => value + 1), 2000);
    return () => window.clearInterval(timer);
  }, [selected?.status, targetMissing, supervisorInvocationId, progressChannel]);
  const retry = () => { setRetrying(true); setLoadRevision((value) => value + 1); };
  const returnAction = onReturnOffice ? <button type="button" className="secondary-button run-return-button" onClick={onReturnOffice}>← 返回领队工作室</button> : undefined;
  useEffect(() => {
    if (!selected?.id) {
      setMergePreview(undefined);
      return;
    }
    // Form state belongs to one selected delivery. Background delivery polling must never reset
    // an open dossier or its controls.
    setMergePreview(undefined);
    setMergePreviewLoading(true);
    setMergeOpen(false);
    setMergeConfirmed(false);
    setMergeError("");
    setKeepOpen(false);
    setKeepNote("");
    setKeepError("");
    setDiscardOpen(false);
    setDiscardToken("");
    setDiscardNote("");
    setDiscardError("");
    setBoardSubmitError("");
    setEvidenceRerunError("");
    setConflictRetryError("");
  }, [selected?.id]);
  useEffect(() => {
    if (!selected?.id) return;
    let current = true;
    setMergePreviewLoading(true);
    api<RunMergePreview>(`/api/runs/${encodeURIComponent(selected.id)}/merge-preview`)
      .then((value) => { if (current) setMergePreview(value); })
      .catch((error: unknown) => { if (current) notify(error instanceof Error ? error.message : String(error), "error"); })
      .finally(() => { if (current) setMergePreviewLoading(false); });
    return () => { current = false; };
  }, [selected?.id, activityRevision, deliveryRevision, notify]);
  useEffect(() => {
    const status = mergePreview?.delivery?.status;
    const evidenceStatus = mergePreview?.delivery?.evidenceRerun?.status;
    const conflictStatus = mergePreview?.delivery?.conflictResolution?.status;
    if (!["queued-for-merge", "retesting", "merging"].includes(status ?? "")
      && !["resolving", "retesting", "leader-review"].includes(conflictStatus ?? "")
      && !["queued", "running"].includes(evidenceStatus ?? "")) return;
    const timer = window.setTimeout(() => setDeliveryRevision((value) => value + 1), 2_000);
    return () => window.clearTimeout(timer);
  }, [mergePreview?.delivery?.status, mergePreview?.delivery?.updatedAt, mergePreview?.delivery?.conflictResolution?.status, mergePreview?.delivery?.evidenceRerun?.status]);
  useEffect(() => {
    if (!dashboard || !selected?.taskId || !mergePreview?.delivery) return;
    const status = mergePreview.delivery.status;
    if (!["queued-for-merge", "retesting", "merging", "merged", "conflict", "returned-to-acceptance"].includes(status)) return;
    void dashboard.syncRequirementDelivery(
      selected.taskId,
      selected.id,
      status as "queued-for-merge" | "retesting" | "merging" | "merged" | "conflict" | "returned-to-acceptance",
      {
        serverUpdatedAt: mergePreview.delivery.updatedAt,
        ...(mergePreview.delivery.message ? { message: mergePreview.delivery.message } : {}),
        ...(mergePreview.delivery.conflictResolution ? { conflictResolution: {
          status: mergePreview.delivery.conflictResolution.status,
          ...(mergePreview.delivery.conflictResolution.failureClass ? { failureClass: mergePreview.delivery.conflictResolution.failureClass } : {}),
          ...(mergePreview.delivery.conflictResolution.message ? { message: mergePreview.delivery.conflictResolution.message } : {})
        } } : {})
      }
    ).then((updated) => onDashboardSyncRef.current?.(updated)).catch(() => undefined);
  }, [dashboard, selected?.taskId, selected?.id, mergePreview?.delivery?.status, mergePreview?.delivery?.updatedAt, mergePreview?.delivery?.message, mergePreview?.delivery?.conflictResolution?.status, mergePreview?.delivery?.conflictResolution?.failureClass, mergePreview?.delivery?.conflictResolution?.message]);
  useEffect(() => {
    const capture = mergePreview?.delivery?.evidenceRerun;
    if (!dashboard || !selected?.taskId || acceptanceRunId !== selected.id || !capture) return;
    const captureTime = new Date(capture.updatedAt).getTime();
    const acceptanceTime = new Date(acceptanceBinding?.capturedAt ?? "").getTime();
    if ((capture.status === "queued" || capture.status === "running")
      && Number.isFinite(captureTime)
      && Number.isFinite(acceptanceTime)
      && captureTime <= acceptanceTime) return;
    void dashboard.syncRequirementEvidenceCapture(selected.taskId, selected.id, {
      status: capture.status,
      updatedAt: capture.updatedAt,
      message: capture.message,
      mediaCount: mergePreview.evidence.assets.length
    }).then((updated) => onDashboardSyncRef.current?.(updated)).catch(() => undefined);
  }, [dashboard, selected?.taskId, selected?.id, acceptanceRunId, acceptanceBinding?.capturedAt, mergePreview?.delivery?.evidenceRerun?.status, mergePreview?.delivery?.evidenceRerun?.updatedAt, mergePreview?.evidence.assets.length]);
  useEffect(() => {
    if (!selected?.id) {
      setHumanRequests([]);
      return;
    }
    let current = true;
    setHumanRequestsLoading(true);
    setDecisionTarget(undefined);
    setDecisionError("");
    api<HumanDecisionRequest[]>("/api/human-decision-requests")
      .then((value) => {
        if (!current) return;
        const list = Array.isArray(value) ? value : [];
        setHumanRequests(list.filter((request) => request.runId === selected.id));
      })
      .catch((error: unknown) => { if (current) notify(error instanceof Error ? error.message : String(error), "error"); })
      .finally(() => { if (current) setHumanRequestsLoading(false); });
    return () => { current = false; };
    // The list endpoint scopes by invocation, not run; filtering by runId keeps this pinned to the open dossier.
  }, [selected?.id, activityRevision, decisionRevision, notify]);
  const openDecision = (request: HumanDecisionRequest, decision: HumanDecisionKind) => {
    if (deciding || request.status !== "pending") return;
    setDecisionError("");
    setDecisionTarget({ request, decision });
  };
  const submitDecision = async () => {
    if (!decisionTarget || deciding) return;
    const comment = (commentDrafts[decisionTarget.request.id] ?? "").trim();
    setDeciding(true);
    setDecisionError("");
    try {
      const updated = await api<HumanDecisionRequest>(
        `/api/human-decision-requests/${encodeURIComponent(decisionTarget.request.id)}/decide`,
        writeBody({
          decision: decisionTarget.decision,
          decidedBy: "workbench-operator",
          ...(comment ? { comment } : {})
        })
      );
      setHumanRequests((list) => list.map((item) => (item.id === updated.id ? updated : item)));
      setCommentDrafts((drafts) => {
        const next = { ...drafts };
        delete next[updated.id];
        return next;
      });
      setDecisionTarget(undefined);
      setDecisionRevision((value) => value + 1);
      notify(decisionTarget.decision === "approve" ? "已批准，原 Run 继续执行。" : "已拒绝，任务返回领队重新规划。", "success");
    } catch (error) {
      // Keep the modal open and the feedback draft intact so the operator can retry unchanged.
      setDecisionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeciding(false);
    }
  };
  const openMerge = () => {
    if (!mergePreview?.eligible) return;
    setMergeConfirmed(false);
    setMergeError("");
    setMergeOpen(true);
  };
  const mergeDelivery = async () => {
    if (!selected || !mergePreview?.eligible || !mergePreview.targetBranch || !mergeConfirmed || merging) return;
    setMerging(true);
    setMergeError("");
    try {
      if (dashboard && selected.taskId) {
        const updated = await dashboard.submitRequirementForAcceptance(
          selected.taskId,
          acceptanceSnapshotFromPreview(mergePreview, new Date().toISOString())
        );
        onDashboardSyncRef.current?.(updated);
      }
      const result = await api<RunMergeQueueResult>(`/api/runs/${encodeURIComponent(selected.id)}/merge-queue`, {
        method: "POST",
        body: JSON.stringify({
          confirmation: mergePreview.confirmationToken,
          targetBranch: mergePreview.targetBranch,
          actor: "workbench-operator"
        })
      });
      setMergeOpen(false);
      if (dashboard && selected.taskId) {
        const updated = await dashboard.syncRequirementDelivery(selected.taskId, selected.id, result.status, {
          serverUpdatedAt: result.delivery.updatedAt,
          ...(result.delivery.message ? { message: result.delivery.message } : {})
        });
        onDashboardSyncRef.current?.(updated);
      }
      setDeliveryRevision((value) => value + 1);
      notify(`Run ${selected.id} 已进入 ${result.delivery.targetBranch} 的待合入队列。`, "success");
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : String(error));
    } finally {
      setMerging(false);
    }
  };
  const rerunEvidence = async () => {
    if (!selected || acceptanceBindingLoading || acceptanceBindingError === selected.taskId || (selected.taskId && acceptanceRunId !== selected.id) || !mergePreview?.worktreePath) return;
    setEvidenceRerunError("");
    try {
      const delivery = await api<RunDeliveryRecord>(`/api/runs/${encodeURIComponent(selected.id)}/evidence-rerun`, writeBody({
        actor: "workbench-operator"
      }));
      if (dashboard && selected.taskId && delivery.evidenceRerun) {
        const updated = await dashboard.syncRequirementEvidenceCapture(selected.taskId, selected.id, {
          status: delivery.evidenceRerun.status,
          updatedAt: delivery.evidenceRerun.updatedAt,
          message: delivery.evidenceRerun.message,
          mediaCount: mergePreview.evidence.assets.length
        });
        onDashboardSyncRef.current?.(updated);
      }
      setDeliveryRevision((value) => value + 1);
      notify(`Run ${selected.id} 已进入独立截图验收队列。`, "success");
    } catch (error) {
      setEvidenceRerunError(error instanceof Error ? error.message : String(error));
    }
  };
  const retryConflict = async () => {
    if (!selected || conflictRetrying) return;
    setConflictRetrying(true);
    setConflictRetryError("");
    try {
      const result = await api<RunMergeQueueResult>(`/api/runs/${encodeURIComponent(selected.id)}/merge-conflict-retry`, writeBody({ actor: "workbench-operator" }));
      if (dashboard && selected.taskId) {
        const updated = await dashboard.syncRequirementDelivery(selected.taskId, selected.id, result.status, {
          serverUpdatedAt: result.delivery.updatedAt,
          ...(result.delivery.message ? { message: result.delivery.message } : {}),
          ...(result.delivery.conflictResolution ? { conflictResolution: {
            status: result.delivery.conflictResolution.status,
            ...(result.delivery.conflictResolution.failureClass ? { failureClass: result.delivery.conflictResolution.failureClass } : {}),
            ...(result.delivery.conflictResolution.message ? { message: result.delivery.conflictResolution.message } : {})
          } } : {})
        });
        onDashboardSyncRef.current?.(updated);
      }
      setDeliveryRevision((value) => value + 1);
      notify(`Run ${selected.id} 已重新进入冲突处理队列，原领队会继续使用保留的 worktree。`, "success");
    } catch (error) {
      setConflictRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setConflictRetrying(false);
    }
  };
  const keepDelivery = async () => {
    if (!selected || keeping) return;
    setKeeping(true);
    setKeepError("");
    try {
      const note = keepNote.trim();
      await api<RunDeliveryActionResult>(`/api/runs/${encodeURIComponent(selected.id)}/keep`, writeBody({
        actor: "workbench-operator",
        ...(note ? { note } : {})
      }));
      setKeepOpen(false);
      setKeepNote("");
      setDeliveryRevision((value) => value + 1);
      notify(`Run ${selected.id} 已标记为人工保留；未执行 merge 或 push。`, "success");
    } catch (error) {
      // 保留弹窗与备注草稿，操作者可原样重试。
      setKeepError(error instanceof Error ? error.message : String(error));
    } finally {
      setKeeping(false);
    }
  };
  const discardDelivery = async () => {
    if (!selected || !mergePreview || discarding) return;
    if (discardToken !== mergePreview.discardConfirmationToken) return;
    setDiscarding(true);
    setDiscardError("");
    try {
      const note = discardNote.trim();
      await api<RunDeliveryActionResult>(`/api/runs/${encodeURIComponent(selected.id)}/discard`, writeBody({
        confirmation: discardToken,
        actor: "workbench-operator",
        ...(note ? { note } : {})
      }));
      setDiscardOpen(false);
      setDiscardToken("");
      setDiscardNote("");
      setDeliveryRevision((value) => value + 1);
      notify(`Run ${selected.id} 的候选结果已丢弃；候选 worktree 已清理。`, "success");
    } catch (error) {
      setDiscardError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiscarding(false);
    }
  };
  const submitToBoard = async () => {
    if (!dashboard || !selected?.taskId || !mergePreview || !isRunAcceptanceReady(mergePreview) || boardSubmitting) return;
    setBoardSubmitting(true);
    setBoardSubmitError("");
    try {
      const snapshot = acceptanceSnapshotFromPreview(mergePreview, new Date().toISOString());
      const updated = await dashboard.submitRequirementForAcceptance(selected.taskId, snapshot);
      setAcceptanceBinding({ taskId: selected.taskId, runId: snapshot.runId, capturedAt: snapshot.capturedAt });
      onDashboardSyncRef.current?.(updated);
      notify(`${updated.code} 已提交到待验收；Run ${snapshot.runId} 验收快照已固定。`, "success");
    } catch (error) {
      setBoardSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBoardSubmitting(false);
    }
  };
  const openWorktree = async () => {
    if (!selected || openingWorktree) return;
    setOpeningWorktree(true);
    try {
      const opened = await api<RunWorktreeOpenResult>(`/api/runs/${encodeURIComponent(selected.id)}/open-worktree`, { method: "POST" });
      notify(`已在系统中打开 Run ${opened.runId} 的候选 worktree。`, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setOpeningWorktree(false);
    }
  };
  const cancelInvocation = async () => {
    const invocationId = selected?.invocation?.id;
    if (!invocationId || cancelling) return;
    setCancelling(true);
    setCancelError("");
    setDetail((current) => current?.id === selected.id && current.invocation
      ? { ...current, invocation: { ...current.invocation, status: "cancellation-requested" } }
      : current);
    try {
      await api<InvocationRecord>(`/api/invocations/${encodeURIComponent(invocationId)}/cancel`, writeBody({
        actor: "workbench-operator",
        ...(cancelReason.trim() ? { reason: cancelReason.trim() } : {})
      }));
      setCancelOpen(false);
      setCancelReason("");
      setLoadRevision((value) => value + 1);
      notify(`Run ${selected.id} 已安全停止；原始证据仍完整保留。`, "success");
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : String(error));
      setLoadRevision((value) => value + 1);
    } finally {
      setCancelling(false);
    }
  };
  const canSubmitToBoard = Boolean(
    dashboard
    && selected?.taskId
    && mergePreview
    && isRunAcceptanceReady(mergePreview)
    && !acceptanceBindingLoading
    && acceptanceBindingError !== selected.taskId
    && acceptanceRunId !== selected.id
    && !["queued-for-merge", "retesting", "merging", "discarded"].includes(mergePreview.status)
  );
  const profileEntries = Object.entries(selected?.effectiveProfiles ?? {});
  const showHumanDecisionFirst = humanRequestsLoading || humanRequests.some((request) => request.status === "pending");
  const controlActions = selected?.invocation?.control?.allowedActions ?? (
    selected?.invocation?.status === "queued" || selected?.invocation?.status === "running"
      ? ["monitor", "cancel"]
      : selected?.invocation?.status === "awaiting-human-decision" ? ["decide", "cancel"] : []
  );
  const canCancelInvocation = controlActions.includes("cancel");
  const needsGoalAction = controlActions.some((action) => action === "review-delivery"
    || action === "retry-successor" || action === "restart-successor" || action === "abandon-goal");
  // 绿色「完成」Stamp 只陈述 Run 终态；交付仍在队列/处理中时，必须补一句桥接避免误读为全部结束。
  const selectedDeliveryStatus = mergePreview && mergePreview.runId === selected?.id
    ? (mergePreview.delivery?.status ?? mergePreview.status)
    : undefined;
  const deliveryNeedsHandling = Boolean(selectedDeliveryStatus
    && ["queued-for-merge", "retesting", "merging", "conflict", "returned-to-acceptance"].includes(selectedDeliveryStatus));
  return <div className={`page-grid page-grid--runs${mode === "embedded" ? " page-grid--runs-embedded" : ""}`}>
    <aside className="record-list"><header className="list-header"><h1>运行卷宗</h1></header><div className="run-filter-bar"><div data-testid="run-type-filter"><SelectControl ariaLabel="按类型筛选运行卷宗" value={categoryFilter} options={[{ value: "all", label: "全部类型" }, { value: "single", label: "单任务" }, { value: "graph", label: "Graph 编排" }, { value: "supervisor", label: "领队协作" }]} onChange={(value) => setCategoryFilter(value as typeof categoryFilter)} /></div><div data-testid="run-project-filter"><SelectControl ariaLabel="按项目筛选运行卷宗" value={projectFilter} options={[{ value: "all", label: "全部项目" }, { value: "none", label: "无项目" }, ...projectOptions.map((project) => ({ value: project, label: project }))]} onChange={(value) => setProjectFilter(value)} /></div></div><div className="record-scroll run-list">{visibleRuns.map((run) => <button key={run.id} id={run.id} className={`run-card ${selected?.id === run.id ? "selected" : ""}`} onClick={() => { setSelectedId(run.id); onSelectRun?.(run.id); }}><div><code>{run.id}</code><strong>{run.workflow}</strong><small>{formatTime(run.createdAt)} · {run.architecture} · {Object.keys(run.nodes).length} 节点</small><div className="run-card-tags">{run.category && <span className={`run-category-tag run-category-tag--${run.category}`}>{CATEGORY_LABELS[run.category]}</span>}{run.project && <span className="run-project-chip">{run.project}</span>}</div></div><Stamp status={run.status} /></button>)}{!loading && visibleRuns.length === 0 && <div className="mini-empty">{runs.length === 0 ? "还没有 Run 证据。" : "没有符合筛选条件的卷宗。"}</div>}</div><footer className="list-footer"><span>{visibleRuns.length}/{runs.length} 份卷宗</span><span>READ ONLY</span></footer></aside>
    <main className="detail-pane">{showDossierSkeleton ? <div className="skeleton-page" aria-label="正在调取运行卷宗"><i /><i /><i /></div> : targetMissing ? <EmptyState title="运行卷宗正在建立" action={<><button type="button" disabled={retrying} onClick={retry}>{retrying ? "重试中…" : "重试"}</button>{returnAction}</>}>Run {pendingRunId} 尚未出现在本地 Run Store，可稍后重试。</EmptyState> : listError || detailError ? <section className="run-detail-error" role="alert"><h2>运行卷宗加载失败</h2><p>{listError || detailError}</p><code>Run ID · {requestedRunId || selectedId || "未提供"}</code><div><button type="button" disabled={retrying} onClick={retry}>{retrying ? "重试中…" : "重试"}</button>{returnAction}</div></section> : !selected ? <EmptyState title={directed ? "无法定位运行卷宗" : "尚无运行卷宗"}>{directed ? `无法找到目标 Run ${requestedRunId}，且不会回退到其他运行卷宗。` : "直接交办员工或签发一次 Workflow 后，这里会出现不可变的执行记录。"}</EmptyState> : <div className="dossier run-dossier">
      {fromStudio && returnAction}
      <header className="dossier-cover"><div className="file-index"><span>RUN EVIDENCE RECORD</span><code>{selected.id}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">证</div><div><h2 ref={dossierTitleRef} tabIndex={-1} aria-label={`${selected.workflow}，Run ${selected.id} 运行卷宗`}>{selected.workflow}</h2><p>{selected.status === "blocked" ? "流程已完成，但存在业务阻塞结论。" : selected.status === "failed" ? "执行发生技术故障，可查看原始输出与错误证据。" : selected.status === "running" ? "执行仍在进行。" : "流程完成，证据已归档。"}</p></div><Stamp status={selected.status} /></div></header>
      {deliveryNeedsHandling && <p className="run-delivery-bridge" role="status">Run 已完成 ≠ 交付完成；候选仍在待合入队列，需要你的处理。</p>}
      {(canCancelInvocation || needsGoalAction || selected.invocation?.status === "cancellation-requested") && <section className="run-control-bar" aria-label="本次运行的可用操作">
        <div><span>CONTROL PLANE · NEXT ACTION</span><strong>{selected.invocation?.status === "cancellation-requested"
          ? "正在安全停止"
          : controlActions.includes("review-delivery") ? "执行已结束，请核对交付"
            : controlActions.includes("restart-successor") ? "本轮已取消，请决定是否继续目标"
              : controlActions.includes("retry-successor") ? "本轮未达成，请先处理根因"
                : "运行仍在进行"}</strong><p>{selected.invocation?.status === "cancellation-requested"
          ? "系统正在作废待决请求并等待实例收尾；无需重复操作。"
          : needsGoalAction && selected.taskId ? "原 Run 是不可变证据；后续推进会创建新的执行周期。" : "你可以继续监控，或显式停止这一轮执行。"}</p></div>
        <div className="run-control-actions">
          {needsGoalAction && selected.taskId && onOpenRequirement && <button type="button" className="button primary" onClick={() => onOpenRequirement(selected.taskId!, controlActions.includes("review-delivery") ? "run" : "overview")}>{controlActions.includes("review-delivery") ? "核对交付与验收" : "回到需求处理下一步"}</button>}
          {needsGoalAction && !selected.taskId && <span className="run-control-unavailable">原 Run 不可原地重试；请从协作编排新启动一次。</span>}
          {canCancelInvocation && <button type="button" className="button danger" onClick={() => { setCancelError(""); setCancelOpen(true); }}>停止本轮运行</button>}
        </div>
      </section>}
      {receipt && <section className="dossier-section run-receipt" aria-labelledby="run-receipt-title"><h3 id="run-receipt-title">Run Receipt</h3>{Boolean(receipt.legacy) && <p className="dash-hint-line">Legacy Run：缺失字段显示 unavailable，不推断失败原因。</p>}<dl><dt>状态 / 阶段</dt><dd>{String(receipt.status)} / {String(receipt.phase)}</dd><dt>下一步</dt><dd>{String(receipt.nextAction)}</dd><dt>预算</dt><dd><code>{JSON.stringify(receipt.budget)}</code></dd><dt>目标版本</dt><dd><code>{JSON.stringify(receipt.target)}</code></dd><dt>失败分类</dt><dd><code>{JSON.stringify(receipt.failure)}</code></dd></dl></section>}
      {view === "all" && <>{showHumanDecisionFirst && <DossierSection number="待办" title="需要你的决定"><HumanDecisionPanel requests={humanRequests} loading={humanRequestsLoading} commentDrafts={commentDrafts} deciding={deciding} onCommentChange={(requestId, value) => setCommentDrafts((drafts) => ({ ...drafts, [requestId]: value }))} onOpenDecision={openDecision} /></DossierSection>}
      <DossierSection number="01" title="运行元数据"><dl className="ledger"><dt>Run ID</dt><dd><code>{selected.id}</code></dd><dt>Architecture</dt><dd>{selected.architecture}</dd><dt>创建时间</dt><dd>{formatTime(selected.createdAt)}</dd><dt>完成时间</dt><dd>{formatTime(selected.completedAt)}</dd><dt>证据目录</dt><dd><code className="path-code">{selected.artifactDir}</code></dd><dt>隔离</dt><dd><IsolationValue isolation={selected.isolation} /></dd></dl></DossierSection>
      <DossierSection number="02" title="任务与当前请求"><div className="run-request-context">{!selected.invocation?.requestText && <div className="run-context-warning" role="status">当前 Run 未保存请求全文；以下仅为调用摘要。</div>}<h3>任务描述</h3><p>{selected.invocation?.taskDescription ?? "未保存独立任务描述。"}</p><h3>当前请求全文</h3><p>{selected.invocation?.requestText ?? "请求全文不可用。"}</p><h3>请求摘要（核对用）</h3><p>{selected.invocation?.requestSummary ?? "未保存调用摘要。"}</p></div></DossierSection>
      {profileEntries.length > 0 && <DossierSection number="02" title="有效执行配置与来源"><div className="run-profile-list">{profileEntries.map(([nodeId, profile]) => <details key={nodeId} open={profileEntries.length === 1}><summary><strong>{nodeId}</strong><span>{profile.employee.displayName} · v{profile.employee.version}</span></summary><EffectiveProfileView profile={profile} /></details>)}</div></DossierSection>}
      {selected.architecture === "supervisor" && <DossierSection number={profileEntries.length > 0 ? "03" : "02"} title="动态执行图"><SupervisorRunTopology nodes={Object.values(selected.nodes)} /></DossierSection>}
      {selected.architecture === "supervisor" && <DossierSection number="进度" title="执行步骤与领队决策">
        <SupervisorLimitsLine run={selected} progress={progress} />
        <RunStepsTable run={selected} progress={progress} />
        {selected.status === "running" && (supervisorLiveState(selected, progress)?.gates?.length ?? 0) > 0 && <>
          <h3 className="run-subhead">门禁状态（进行中，服务端持久投影）</h3>
          <GateVerdictList gates={supervisorLiveState(selected, progress)?.gates ?? []} />
        </>}
        <h3 className="run-subhead">领队决策时间线</h3>
        <DecisionTimeline progress={progress} />
      </DossierSection>}
      <DossierSection number={profileEntries.length > 0 ? (selected.architecture === "supervisor" ? "04" : "03") : (selected.architecture === "supervisor" ? "03" : "02")} title="节点结果"><div className="run-node-list">{Object.values(selected.nodes).length === 0 && <p className="run-node-placeholder">{selected.status === "running" ? "节点正在建立，尚无角色输出。" : "此 Run 未记录节点输出。"}</p>}{Object.values(selected.nodes).map((node, index) => { const decision = supervisorDecision(node); return <article key={node.nodeId}><div className="run-node-head"><span className="node-number">{String(index + 1).padStart(2, "0")}</span><div><strong>{node.nodeId}</strong><code>{node.roleId}{node.metadata?.kind === "supervisor" ? ` · 领队 Round ${node.metadata.round ?? "—"}` : node.metadata?.kind === "member" ? ` · 成员 Round ${node.metadata.round ?? "—"}` : ""}{dagFlowTag(node)}</code></div><Stamp status={node.status} /></div><dl className="ledger horizontal"><dt>尝试</dt><dd>{node.attempts}</dd><dt>开始</dt><dd>{formatTime(node.startedAt)}</dd><dt>结束</dt><dd>{formatTime(node.completedAt)}</dd></dl>{decision && <div className="supervisor-decision-summary"><code>{decision.action.toUpperCase()}</code><span>{decision.summary ?? "领队未提供本轮摘要。"}</span></div>}{node.error && <div className="inline-error">{node.error}</div>}{node.output !== undefined ? <><E2eEvidenceList entries={e2eEvidenceEntries(node.output)} /><pre className="result-json">{JSON.stringify(node.output, null, 2)}</pre></> : node.status === "running" || selected.status === "running" ? <p className="run-node-placeholder">该节点正在执行，尚无输出。</p> : <p className="run-node-placeholder">该节点未记录输出。</p>}<code className="artifact-path">{node.artifactDir}</code></article>; })}</div></DossierSection>
      {selected.output !== undefined && <DossierSection number={profileEntries.length > 0 ? (selected.architecture === "supervisor" ? "05" : "04") : (selected.architecture === "supervisor" ? "04" : "03")} title="Workflow 最终输出">{finalSummary(selected) && <p className="workflow-final-summary">{finalSummary(selected)}</p>}<GateVerdictList gates={gateVerdicts(selected.output)} /><E2eEvidenceList entries={e2eEvidenceEntries(selected.output)} /><pre className="result-json">{JSON.stringify(selected.output, null, 2)}</pre></DossierSection>}
      {!showHumanDecisionFirst && <DossierSection number="人审" title="人在回路"><HumanDecisionPanel requests={humanRequests} loading={humanRequestsLoading} commentDrafts={commentDrafts} deciding={deciding} onCommentChange={(requestId, value) => setCommentDrafts((drafts) => ({ ...drafts, [requestId]: value }))} onOpenDecision={openDecision} /></DossierSection>}</>}
      <DossierSection number="交付" title="验收与合并"><RunDeliveryPanel
        preview={mergePreview?.runId === selected.id ? mergePreview : undefined}
        loading={mergePreviewLoading}
        taskId={selected.taskId}
        canSubmitToBoard={canSubmitToBoard}
        boardSubmitting={boardSubmitting}
        boardSubmitError={boardSubmitError}
        onOpenMerge={openMerge}
        onOpenWorktree={() => void openWorktree()}
        openingWorktree={openingWorktree}
        onOpenKeep={() => { setKeepError(""); setKeepOpen(true); }}
        onOpenDiscard={() => { setDiscardError(""); setDiscardToken(""); setDiscardOpen(true); }}
        onSubmitToBoard={() => void submitToBoard()}
        onRerunEvidence={() => void rerunEvidence()}
        acceptanceBindingLoading={acceptanceBindingLoading}
        acceptanceRunId={acceptanceRunId}
        acceptanceBindingError={acceptanceBindingError === selected?.taskId}
        onOpenAcceptanceRun={() => { if (acceptanceRunId) { setSelectedId(acceptanceRunId); onSelectRun?.(acceptanceRunId); } }}
        evidenceRerunError={evidenceRerunError}
        onRetryConflict={() => void retryConflict()}
        conflictRetrying={conflictRetrying}
        conflictRetryError={conflictRetryError}
      /></DossierSection>
    </div>}</main>
    {mergeOpen && mergePreview?.eligible && <RunMergeConfirmation preview={mergePreview} confirmed={mergeConfirmed} busy={merging} error={mergeError} onConfirmedChange={setMergeConfirmed} onClose={() => { if (!merging) setMergeOpen(false); }} onMerge={() => void mergeDelivery()} />}
    {keepOpen && mergePreview && <RunKeepConfirmation preview={mergePreview} note={keepNote} busy={keeping} error={keepError} onNoteChange={setKeepNote} onClose={() => { if (!keeping) setKeepOpen(false); }} onKeep={() => void keepDelivery()} />}
    {discardOpen && mergePreview && <RunDiscardConfirmation preview={mergePreview} token={discardToken} note={discardNote} busy={discarding} error={discardError} onTokenChange={setDiscardToken} onNoteChange={setDiscardNote} onClose={() => { if (!discarding) setDiscardOpen(false); }} onDiscard={() => void discardDelivery()} />}
    {decisionTarget && <HumanDecisionConfirmation target={decisionTarget} comment={(commentDrafts[decisionTarget.request.id] ?? "").trim()} busy={deciding} error={decisionError} onClose={() => { if (!deciding) setDecisionTarget(undefined); }} onConfirm={() => void submitDecision()} />}
    {cancelOpen && selected?.invocation && <Modal title="停止本轮运行" eyebrow="CANCEL ATTEMPT · EVIDENCE PRESERVED" onClose={() => { if (!cancelling) setCancelOpen(false); }}>
      <div className="modal-body compact-form"><p>这会停止当前 Invocation 的所有实例，并作废尚未处理的人工决定。Run、提示词、输出和状态迁移证据都会保留；需求本身不会被删除。</p><label><span>停止原因（可选）</span><textarea rows={3} maxLength={2000} disabled={cancelling} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="例如：推进方向偏离需求，先停止并修正范围。" /></label>{cancelError && <div className="inline-error" role="alert">{cancelError}</div>}<div className="modal-actions"><button type="button" className="button secondary" disabled={cancelling} onClick={() => setCancelOpen(false)}>继续运行</button><button type="button" className="button danger-filled" disabled={cancelling} onClick={() => void cancelInvocation()}>{cancelling ? "正在停止…" : "确认停止本轮运行"}</button></div></div>
    </Modal>}
  </div>;
}
