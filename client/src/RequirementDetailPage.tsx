/** 需求详情：原始需求 / 验收标准 / 任务 DAG / Agent 时间线 / Diff·测试·Review·交付物。
 *  DAG / 时间线 / 资源概览的演示徽标完全由数据 demo 标记驱动。列迁移走目标列 SelectControl。 */
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { DemoBadge, DossierSection, EmptyState, Modal, ReadonlyEvidence, RuntimeStatusChip, SelectControl, Stamp, formatTime, useDaemonAvailable } from "./components";
import { isActiveRequirementAdvancement, isRecoverableCancelledAdvancement, requirementAdvancementConfig, requirementOwnerLabel } from "./dashboard/advancement";
import { dashboardService, type DashboardService } from "./dashboard/service";
import type { DagTaskNode, Requirement, RequirementDetail, RequirementLane } from "./dashboard/types";
import { REQUIREMENT_EXCEPTION_LABELS, VISIBLE_REQUIREMENT_LANES, requirementLaneLabel } from "./dashboard/types";
import { ErrorBlock, OfflineNotice, PageHeader, SkeletonBlock, useServiceData } from "./dashboard/view";
import { LiveAgentWorkbench } from "./LiveAgentWorkbench";
import { RunsPage } from "./RunsPage";
import {
  buildRequirementAdvancementInput,
  parseExplicitDeliveryIntent,
  requirementAdvancementGateway,
  requirementAdvancementSafetyGaps,
  type RequirementAdvancementGateway
} from "./requirementAdvancement";
import type { EntrancePolicy, EntrancePolicyDecision, InvocationRecord, ManagementPolicy, Project, Workflow } from "./types";

interface RequirementInvocationProgress {
  status: string;
  error?: string;
  outcome?: { status: string; summary?: string; reason?: string };
  leaderReport?: { gates?: Array<{ gateId: string; status: string }> };
  steps?: Array<{ nodeId: string; roleId?: string; status: string; error?: string }>;
}

interface RequirementBlockerDetail {
  reason: string;
  explanation: string;
  gateSummary?: string;
}

function explainRequirementBlocker(reason: string): string {
  if (reason.includes("dynamic TODO delegation must specify todoId")) {
    return "领队在动态委派任务时没有指出要推进的 TODO；编排器无法安全判断依赖关系，因此在调用开发和测试 Agent 前终止了本轮。";
  }
  if (reason.includes("delegated planned node") && reason.includes("changeSet") && reason.includes("expected")) {
    return "领队委派计划节点时给出了与原计划不一致的改动集；为避免在错误的代码范围继续执行，编排器阻止了本轮。";
  }
  if (reason.includes("technical circuit opened")) {
    return "同一类技术调用连续失败后触发了熔断；系统停止重复派发，等待修复配置或人工重新推进。";
  }
  return "本轮 Run 被安全门禁终止；下面保留了运行时给出的原始原因，便于定位配置、委派或测试问题。";
}

function blockerFromProgress(
  progress: RequirementInvocationProgress | undefined,
  fallback?: string
): RequirementBlockerDetail | undefined {
  const failedStep = progress?.steps?.findLast((step) => Boolean(step.error));
  const reason = progress?.outcome?.reason ?? progress?.error ?? failedStep?.error ?? fallback;
  if (!reason) return undefined;
  const gates = progress?.leaderReport?.gates ?? [];
  const skipped = gates.filter((gate) => gate.status === "skipped").map((gate) => gate.gateId);
  const blocked = gates.filter((gate) => gate.status === "blocked").map((gate) => gate.gateId);
  const gateSummary = blocked.length > 0
    ? `阻塞门禁：${blocked.join("、")}`
    : skipped.length > 0
      ? `执行在门禁前停止；尚未执行：${skipped.join("、")}`
      : undefined;
  return { reason, explanation: explainRequirementBlocker(reason), gateSummary };
}

function dagStamp(status: DagTaskNode["status"]) {
  if (status === "completed") return <Stamp status="completed" />;
  if (status === "running") return <Stamp status="running" />;
  if (status === "blocked") return <Stamp status="blocked" />;
  if (status === "failed") return <Stamp status="failed" />;
  if (status === "skipped") return <Stamp status="skipped" />;
  return <Stamp status="pending" />;
}

const ADVANCEMENT_LABELS = {
  dispatching: "正在创建 Run",
  queued: "已排队",
  running: "Agent 正在推进",
  "awaiting-human-decision": "等待你的决定",
  "cancellation-requested": "正在安全停止",
  completed: "执行完成，等待核对交付",
  blocked: "推进已阻塞",
  failed: "推进失败",
  cancelled: "推进已取消"
} as const;

function startBlockedReason(detail: RequirementDetail, configured: boolean, policyAvailable: boolean): string | undefined {
  if (!configured) return "项目尚未配置需求推进入口";
  if (!policyAvailable) return "项目配置的入口策略不存在或已归档";
  if (detail.lane === "clarify") return "需求仍在待澄清，请先补齐关键信息";
  if (detail.lane === "acceptance" || detail.lane === "merging" || detail.lane === "done") return "该需求已经进入验收、待合入或完成阶段";
  if (detail.exception === "cancelled" && !isRecoverableCancelledAdvancement(detail)) return "已取消的需求不能开始推进";
  if (detail.acceptanceCriteria.length === 0) return "请先补齐至少一条可观察的验收标准";
  if (detail.advancement?.invocationId
    && detail.advancement.status !== "failed"
    && detail.advancement.status !== "blocked"
    && !isRecoverableCancelledAdvancement(detail)) {
    return "当前推进轮次已经产生 Run，请先处理该 Run";
  }
  return undefined;
}

export function RequirementDetailPage({
  requirementId,
  section = "overview",
  go,
  notify,
  service = dashboardService,
  projects = [],
  entrancePolicies = [],
  workflows = [],
  managementPolicies = [],
  invocations = [],
  gateway = requirementAdvancementGateway,
  onOpenRun
}: {
  requirementId: string;
  section?: "overview" | "run" | "acceptance";
  go: (hash: string) => void;
  notify: (message: string, kind?: "success" | "error") => void;
  service?: DashboardService;
  projects?: Project[];
  entrancePolicies?: EntrancePolicy[];
  workflows?: Workflow[];
  managementPolicies?: ManagementPolicy[];
  invocations?: InvocationRecord[];
  gateway?: RequirementAdvancementGateway;
  onOpenRun?: (runId: string) => void;
}) {
  const daemonAvailable = useDaemonAvailable();
  const { state, reload, setData } = useServiceData<RequirementDetail>(() => service.getRequirement(requirementId), [service, requirementId]);
  const [targetLane, setTargetLane] = useState<RequirementLane | "">("");
  const [migrating, setMigrating] = useState(false);
  const [migrateError, setMigrateError] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [launchDecision, setLaunchDecision] = useState<EntrancePolicyDecision>();
  const [evaluatingLaunch, setEvaluatingLaunch] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState("");
  const [deliveryCommand, setDeliveryCommand] = useState("");
  const [blockerProgress, setBlockerProgress] = useState<RequirementInvocationProgress>();
  const [blockerProgressLoading, setBlockerProgressLoading] = useState(false);

  const detail = state.status === "ready" ? state.data : undefined;
  const project = detail ? projects.find((candidate) => candidate.id === detail.projectId) : undefined;
  const advancementConfig = requirementAdvancementConfig(project);
  const activePolicy = advancementConfig
    ? entrancePolicies.find((policy) => policy.id === advancementConfig.entrancePolicyId && policy.status === "active")
    : undefined;
  const activeInvocation = detail?.advancement?.invocationId
    ? invocations.find((invocation) => invocation.id === detail.advancement?.invocationId)
    : undefined;
  const launchGaps = launchDecision ? requirementAdvancementSafetyGaps(launchDecision, workflows, managementPolicies) : [];
  const deliveryIntent = parseExplicitDeliveryIntent(deliveryCommand, advancementConfig?.deliveryTargets ?? []);
  const blockedStart = detail ? startBlockedReason(detail, Boolean(advancementConfig), Boolean(activePolicy)) : undefined;
  const canRestart = Boolean(detail && (detail.advancement?.status === "failed"
    || detail.advancement?.status === "blocked"
    || isRecoverableCancelledAdvancement(detail)));
  const awaitingDecision = detail?.advancement?.status === "awaiting-human-decision";
  const blockerDetail = blockerFromProgress(blockerProgress, detail?.advancement?.error);
  const syncDashboardProjection = useCallback((updated: Requirement) => {
    if (!detail || detail.id !== updated.id) return;
    // The embedded Run already has the new projection. Merge it into the open
    // dossier without returning the whole page to its loading skeleton.
    setData({ ...detail, ...updated });
  }, [detail, setData]);

  useEffect(() => {
    if (!detail?.advancement || !activeInvocation || detail.advancement.status === activeInvocation.status) return;
    let cancelled = false;
    void service.syncRequirementAdvancement(detail.id, detail.advancement.idempotencyKey, {
      invocationId: activeInvocation.id,
      runId: activeInvocation.runId,
      leaderSessionId: activeInvocation.sessionId,
      status: activeInvocation.status,
      observedAt: activeInvocation.updatedAt,
      error: activeInvocation.error
    }, advancementConfig?.pollIntervalMs ?? 15_000).then((updated) => {
      if (!cancelled) setData({ ...detail, ...updated });
    }).catch((error: unknown) => {
      if (!cancelled) setLaunchError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [activeInvocation?.id, activeInvocation?.status, activeInvocation?.updatedAt, advancementConfig?.pollIntervalMs, detail?.advancement?.idempotencyKey, detail?.advancement?.status, detail?.id, service, setData]);

  useEffect(() => {
    const advancement = detail?.advancement;
    if (!advancement?.invocationId || (advancement.status !== "blocked" && advancement.status !== "failed")) {
      setBlockerProgress(undefined);
      setBlockerProgressLoading(false);
      return;
    }
    let current = true;
    setBlockerProgress(undefined);
    setBlockerProgressLoading(true);
    api<RequirementInvocationProgress>(`/api/invocations/${encodeURIComponent(advancement.invocationId)}/progress`)
      .then((progress) => { if (current) setBlockerProgress(progress); })
      .catch(() => undefined)
      .finally(() => { if (current) setBlockerProgressLoading(false); });
    return () => { current = false; };
  }, [detail?.advancement?.invocationId, detail?.advancement?.status]);

  const evaluateLaunch = async () => {
    if (!detail || !advancementConfig || !deliveryIntent || blockedStart) return;
    setEvaluatingLaunch(true);
    setLaunchError("");
    try {
      const input = buildRequirementAdvancementInput(detail, undefined, advancementConfig, deliveryIntent);
      const evaluationInput = {
        route: input.route,
        tags: input.tags,
        signals: input.signals,
        source: input.source
      };
      let decision = await gateway.evaluate(advancementConfig.entrancePolicyId, evaluationInput);
      const evaluatedTarget = decision.target;
      if (evaluatedTarget.kind === "supervisor-workflow") {
        const currentWorkflow = workflows.find((workflow) => workflow.id === evaluatedTarget.workflowId);
        if (currentWorkflow && currentWorkflow.version !== evaluatedTarget.workflowVersion && gateway.refreshWorkflowReferences) {
          await gateway.refreshWorkflowReferences(evaluatedTarget.workflowId);
          decision = await gateway.evaluate(advancementConfig.entrancePolicyId, evaluationInput);
          notify(decision.target.kind === "supervisor-workflow"
            ? `入口策略已自动刷新到 ${decision.target.workflowId} v${decision.target.workflowVersion}`
            : "入口策略已自动刷新到最新团队");
        }
      }
      setLaunchDecision(decision);
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error));
    } finally {
      setEvaluatingLaunch(false);
    }
  };

  const launch = async () => {
    if (!detail || !advancementConfig || !launchDecision || !deliveryIntent || launchGaps.length > 0) return;
    setLaunching(true);
    setLaunchError("");
    // Only a successfully reserved cycle may be marked failed. A stale click must never
    // overwrite an already-active Invocation merely because its reservation was rejected.
    let key: string | undefined;
    try {
      const advancement = await service.reserveRequirementAdvancement(detail.id, advancementConfig, "human");
      key = advancement.idempotencyKey;
      setData({ ...detail, advancement, exception: null, updatedAt: advancement.updatedAt });
      const receipt = await gateway.dispatch(
        advancementConfig.entrancePolicyId,
        buildRequirementAdvancementInput(detail, advancement, advancementConfig, deliveryIntent)
      );
      const updated = await service.syncRequirementAdvancement(detail.id, advancement.idempotencyKey, {
        invocationId: receipt.invocation.id,
        runId: receipt.runId,
        leaderSessionId: receipt.leaderSessionId,
        status: receipt.invocation.status,
        observedAt: receipt.invocation.updatedAt,
        error: receipt.invocation.error
      }, advancementConfig.pollIntervalMs);
      setData({ ...detail, ...updated });
      setLaunchDecision(undefined);
      notify(`${detail.code} 已开始推进；Run ${receipt.runId} 已进入「${requirementLaneLabel(updated.lane)}」`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLaunchError(message);
      if (key) {
        try {
          const failed = await service.failRequirementAdvancement(detail.id, key, message);
          setData({ ...detail, ...failed });
        } catch {
          // Keep the original dispatch error visible; the persisted key remains fail-closed.
        }
      }
    } finally {
      setLaunching(false);
    }
  };

  const migrate = async () => {
    if (!detail || !targetLane) return;
    setMigrating(true);
    setMigrateError("");
    try {
      const updated = await service.updateRequirementLane(detail.id, targetLane);
      setData({ ...detail, ...updated });
      setTargetLane("");
      notify(`${detail.code} 已迁移到「${requirementLaneLabel(updated.lane)}」`);
    } catch (error) {
      setMigrateError(error instanceof Error ? error.message : String(error));
    } finally {
      setMigrating(false);
    }
  };

  const archive = async () => {
    if (!detail) return;
    setArchiveOpen(false);
    try {
      await service.archiveRequirement(detail.id);
      notify(`${detail.code} 已归档；需求证据完整保留，可在归档中心恢复`);
      go("archive");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const acceptanceRunId = detail?.evidence.acceptance?.runId;
  const focusedRunId = section === "acceptance" ? (acceptanceRunId ?? detail?.advancement?.runId) : detail?.advancement?.runId;
  const runBindingMismatch = Boolean(acceptanceRunId && detail?.advancement?.runId && acceptanceRunId !== detail.advancement.runId);

  return <main className="dash-page">
    <PageHeader eyebrow="REQUIREMENT / LIFECYCLE DOSSIER" title="需求工作卷宗" description="需求、执行、人工决策、验收证据和合入操作集中在同一份卷宗；当前分区会写入链接，刷新后仍回到这里。" actions={<button type="button" className="button secondary" onClick={() => go(detail ? `projects/${detail.projectId}/board` : "board")}>← 返回看板</button>} />
    <OfflineNotice />
    {state.status === "loading" && <SkeletonBlock rows={5} label="正在加载需求详情" />}
    {state.status === "error" && <ErrorBlock message={state.error ?? "加载失败"} onRetry={reload} />}
    {state.status === "ready" && !detail && <EmptyState title="没有找到这条需求" action={<button type="button" className="button secondary" onClick={() => go("board")}>返回需求看板</button>}><p>它可能已被移除；看板数据未受影响。</p></EmptyState>}
    {state.status === "ready" && detail && <nav className="requirement-lifecycle-nav" aria-label="需求生命周期">
      {(["overview", "run", "acceptance"] as const).map((item, index) => <button key={item} type="button" aria-current={section === item ? "page" : undefined} className={section === item ? "active" : ""} onClick={() => go(`requirements/${encodeURIComponent(detail.id)}?section=${item}`)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item === "overview" ? "需求定义" : item === "run" ? "执行与决策" : "验收与合入"}</strong><small>{item === "overview" ? requirementLaneLabel(detail.lane) : item === "run" ? detail.advancement?.runId ? "真实 Run 已绑定" : "等待启动" : detail.evidence.acceptance ? "验收快照已固定" : "等待交付"}</small></button>)}
      {focusedRunId && <button type="button" className="standalone-run-link" onClick={() => go(`runs/${encodeURIComponent(focusedRunId)}`)}>独立运行卷宗 ↗</button>}
    </nav>}
    {state.status === "ready" && detail && (detail.advancement?.status === "blocked" || detail.advancement?.status === "failed") && <section className="requirement-blocker-callout" role="alert" aria-live="polite">
      <div className="requirement-blocker-callout__head">
        <Stamp status={detail.advancement.status === "blocked" ? "blocked" : "failed"} label={detail.advancement.status === "blocked" ? "推进阻塞" : "推进失败"} />
        <strong>{blockerDetail ? "已找到本轮停止原因" : blockerProgressLoading ? "正在读取本轮停止原因…" : "本轮停止原因暂不可用"}</strong>
      </div>
      {blockerDetail && <>
        <p>{blockerDetail.explanation}</p>
        <dl>
          <dt>原始原因</dt><dd><code>{blockerDetail.reason}</code></dd>
          {blockerDetail.gateSummary && <><dt>测试状态</dt><dd>{blockerDetail.gateSummary}</dd></>}
          {detail.advancement.runId && <><dt>Run</dt><dd><code>{detail.advancement.runId}</code></dd></>}
        </dl>
      </>}
      {!blockerDetail && !blockerProgressLoading && <p>服务暂时无法返回 Run 结果；原 Run 和证据仍完整保留，可打开运行卷宗查看。</p>}
      {detail.advancement.runId && <button type="button" className="button secondary" onClick={() => go(`requirements/${encodeURIComponent(detail.id)}?section=run`)}>查看阻塞现场与完整证据 →</button>}
    </section>}
    {state.status === "ready" && detail && section === "acceptance" && runBindingMismatch && <section className="requirement-blocker-callout" role="status"><strong>验收 Run 与最新推进 Run 不同</strong><p>本区固定展示验收快照 Run <code>{acceptanceRunId}</code>；最新推进 Run 为 <code>{detail.advancement?.runId}</code>。</p></section>}
    {state.status === "ready" && detail && section === "run" && <LiveAgentWorkbench invocationId={activeInvocation?.id ?? detail.advancement?.invocationId} runId={focusedRunId} />}
    {state.status === "ready" && detail && (section === "run" || section === "acceptance") && focusedRunId && <RunsPage mode="embedded" view={section === "acceptance" ? "acceptance" : "all"} focusedRunId={focusedRunId} notify={notify} dashboard={service} onDashboardSync={syncDashboardProjection} onOpenRequirement={(requirementId, targetSection = "overview") => go(requirementId === detail.id && targetSection === "run"
      // 已在本需求卷宗内：终态 Run 的「核对交付与验收」直达验收幕，而不是绕回当前 run 幕。
      ? `requirements/${encodeURIComponent(requirementId)}?section=acceptance`
      : `requirements/${encodeURIComponent(requirementId)}${targetSection === "overview" ? "" : `?section=${targetSection}`}`)} />}
    {state.status === "ready" && detail && (section === "run" || section === "acceptance") && !focusedRunId && <EmptyState title="尚未绑定 Run">开始推进后，完整决策、证据、验收与合入操作会在这里出现。</EmptyState>}
    {state.status === "ready" && detail && section === "overview" && <div className="dash-dossier dash-dossier--overview">
      <div className="dash-panel dash-req-cover">
        <div className="dash-req-title">
          <code>{detail.code}</code>
          <h2>{detail.title}</h2>
          <div className="dash-req-chips">
            <Stamp status={detail.lane === "done" ? "completed" : detail.lane === "running" ? "running" : "pending"} label={requirementLaneLabel(detail.lane)} />
            {detail.exception === "blocked" && <Stamp status="blocked" label={REQUIREMENT_EXCEPTION_LABELS.blocked} />}
            {detail.exception === "failed" && <Stamp status="failed" label={REQUIREMENT_EXCEPTION_LABELS.failed} />}
            {detail.exception === "cancelled" && <RuntimeStatusChip status="cancelled" label={REQUIREMENT_EXCEPTION_LABELS.cancelled} />}
          </div>
        </div>
        <p>{detail.summary}</p>
        <dl className="dash-facts">
          <dt>负责人</dt><dd>{requirementOwnerLabel(detail)}</dd>
          <dt>创建</dt><dd>{formatTime(detail.createdAt)}</dd>
          <dt>最近更新</dt><dd>{formatTime(detail.updatedAt)}</dd>
        </dl>
        <section className={`dash-advance-panel${awaitingDecision ? " dash-advance-panel--confirmation" : ""}`} aria-labelledby="requirement-advance-title">
          <div className="dash-advance-ticket">
            <span>REAL RUN · CYCLE {detail.advancement?.cycle ?? 1}</span>
            <strong id="requirement-advance-title">{detail.advancement ? ADVANCEMENT_LABELS[detail.advancement.status] : "尚未启动真实推进"}</strong>
            <small>{detail.advancement?.runId
              ? `Run ${detail.advancement.runId}`
              : activePolicy
                ? `入口策略 ${activePolicy.id} · v${activePolicy.version}`
                : blockedStart ?? "先核对入口，再创建受监控的领队 Run"}</small>
          </div>
          <div className="dash-advance-actions">
            {(!detail.advancement?.runId || canRestart) && <label className="dash-delivery-command">
              <span>显式交付口令</span>
              <input
                value={deliveryCommand}
                onChange={(event) => { setDeliveryCommand(event.target.value); setLaunchDecision(undefined); }}
                placeholder="交付领队"
                aria-describedby="delivery-command-hint"
              />
              <small id="delivery-command-hint">仅接受“交付领队”{advancementConfig?.deliveryTargets?.length ? `、${advancementConfig.deliveryTargets.map((target) => `“交付${target}”`).join("、")}` : ""}；普通措辞不会启动领队。</small>
            </label>}
            {detail.advancement?.runId && <button type="button" className={`button ${awaitingDecision ? "primary" : "secondary"}`} onClick={() => onOpenRun?.(detail.advancement!.runId!)} disabled={!onOpenRun}>{awaitingDecision ? "查看问题并作决定 →" : canRestart ? "查看上次 Run" : "查看 Run 与证据"}</button>}
            {(!detail.advancement?.runId || canRestart) && <button
                  type="button"
                  className="button primary dash-start-button"
                  disabled={!daemonAvailable || !deliveryIntent || evaluatingLaunch || launching || isActiveRequirementAdvancement(detail.advancement) || Boolean(blockedStart)}
                  title={blockedStart ?? (!deliveryIntent ? "请输入项目允许的显式交付口令" : undefined)}
                  onClick={() => void evaluateLaunch()}
                >{evaluatingLaunch ? "正在核对入口…" : canRestart ? "重新推进" : detail.advancement?.status === "failed" ? "安全重试启动" : "开始推进"}</button>}
            <span>{advancementConfig?.autoPollEnabled ? "自动轮询已启用" : "自动轮询协议已预留 · 当前人工启动"}</span>
          </div>
          {awaitingDecision && <div className="dash-confirmation-guide" role="alert">
            <strong>这个 Run 已暂停，正在等你</strong>
            <span>打开运行卷宗查看 Agent 想执行的动作与风险；你可以补充反馈，然后批准继续，或拒绝并要求领队重新规划。</span>
            <ol><li>查看拟执行动作</li><li>填写反馈（可选）</li><li>批准或拒绝</li></ol>
          </div>}
          {(launchError || blockedStart) && <p className={launchError ? "dash-advance-error" : "dash-hint-line"} role={launchError ? "alert" : undefined}>{launchError || blockedStart}</p>}
        </section>
        <div className="dash-migrate" role="group" aria-label="迁移目标列">
          <SelectControl
            ariaLabel="目标列"
            placeholder="选择目标列…"
            value={targetLane}
            disabled={!daemonAvailable || migrating || detail.exception === "cancelled" || isActiveRequirementAdvancement(detail.advancement)}
            invalid={Boolean(migrateError)}
            errorMessage={migrateError || undefined}
            options={VISIBLE_REQUIREMENT_LANES.map((lane) => {
              const runtimeControlled = lane.id === "queued" || lane.id === "running" || lane.id === "confirmation" || lane.id === "merging";
              return {
                value: lane.id,
                label: lane.label,
                disabled: lane.id === detail.lane || runtimeControlled,
                description: lane.id === detail.lane ? "当前所在列" : runtimeControlled ? "由真实 Run 自动更新" : undefined
              };
            })}
            onChange={(value) => { setTargetLane(value as RequirementLane); setMigrateError(""); }}
          />
          <button type="button" className="button primary" disabled={!daemonAvailable || migrating || !targetLane || isActiveRequirementAdvancement(detail.advancement)} onClick={() => void migrate()}>{migrating ? "迁移中…" : "迁移到目标列"}</button>
          <button type="button" className="button danger" disabled={!daemonAvailable} onClick={() => setArchiveOpen(true)}>归档需求</button>
        </div>
        {isActiveRequirementAdvancement(detail.advancement) && <p className="dash-hint-line">真实 Run 进行中，排队中 / 执行中 / 待确认由系统同步；完成人工决定或处理 Run 后，系统会继续更新所在列。</p>}
        {detail.exception === "cancelled" && <p className="dash-hint-line">已取消的需求不能迁移列；如需恢复请联系领队。</p>}
      </div>

      <DossierSection number="01" title="原始需求">
        <ReadonlyEvidence label="需求原文" value={detail.rawRequirement} />
      </DossierSection>

      <DossierSection number="02" title="验收标准">
        {detail.acceptanceCriteria.length > 0 ? <ul className="dash-acceptance-list">{detail.acceptanceCriteria.map((criterion, index) => <li key={index}><Stamp status="passed" label={`AC-${index + 1}`} /><span>{criterion}</span></li>)}</ul> : <p className="dash-hint-line">尚未填写验收标准。</p>}
      </DossierSection>

      <DossierSection number="03" title="任务 DAG" action={detail.dag.demo ? <DemoBadge /> : undefined}>
        <ol className="dash-dag-list">
          {detail.dag.nodes.map((node) => <li key={node.id}>
            {dagStamp(node.status)}
            <div><strong>{node.title}</strong><small>{node.dependsOn.length > 0 ? `依赖 ${node.dependsOn.join("、")}` : "无前置依赖"}</small></div>
          </li>)}
        </ol>
        {detail.dag.nodes.length === 0 && <p className="dash-hint-line">尚未接入调度器，任务拆解将在规划后显示。</p>}
      </DossierSection>

      <DossierSection number="04" title="Agent 时间线" action={detail.timeline.demo ? <DemoBadge /> : undefined}>
        <ol className="dash-timeline-list">
          {detail.timeline.entries.map((entry) => <li key={entry.id}>
            <time>{formatTime(entry.at)}</time>
            <div><strong>{entry.agent} · {entry.action}</strong><span>{entry.detail}</span></div>
          </li>)}
        </ol>
      </DossierSection>

      <DossierSection number="05" title="资源概览" action={detail.resourceOverview.demo ? <DemoBadge /> : undefined}>
        <div className="dash-stat-grid dash-stat-grid--compact">
          <div className="dash-stat"><span>参与 Agent</span><strong>{detail.resourceOverview.agents}</strong></div>
          <div className="dash-stat"><span>累计耗时</span><strong>{detail.resourceOverview.elapsedMinutes}m</strong></div>
          <div className="dash-stat"><span>Token 消耗</span><strong>{detail.resourceOverview.tokensUsed.toLocaleString("zh-CN")}</strong></div>
        </div>
      </DossierSection>

      <DossierSection number="06" title="Diff / 测试 / Review / 交付物">
        <ReadonlyEvidence label="Diff 摘要" value={detail.evidence.diffSummary} mono />
        <ReadonlyEvidence label="测试报告" value={detail.evidence.testReport} mono />
        <ReadonlyEvidence label="Review 记录" value={detail.evidence.reviewNotes} />
        {detail.evidence.deliverables.length === 0
          ? <p className="dash-hint-line">暂无交付物；验收通过后归档于此。</p>
          : <ul className="dash-deliverable-list">{detail.evidence.deliverables.map((item) => <li key={item}><code>{item}</code></li>)}</ul>}
      </DossierSection>
    </div>}
    {launchDecision && detail && <Modal title={`开始推进 ${detail.code}`} eyebrow="REAL RUN · HUMAN CONFIRMATION" onClose={() => { if (!launching) setLaunchDecision(undefined); }}>
      <div className="modal-body dash-launch-confirm">
        <div className="dash-launch-route">
          <span>入口决策</span>
          <strong>{launchDecision.target.kind === "supervisor-workflow" ? `${launchDecision.target.workflowId} · v${launchDecision.target.workflowVersion}` : launchDecision.target.kind}</strong>
          <small>策略 {launchDecision.policyId} · v{launchDecision.policyVersion} · {launchDecision.decidedBy}</small>
        </div>
        <p>确认后会创建真实异步 Run，并自动把需求推进到排队中 / 执行中；需要你决定时会进入待确认，决定后可回到执行中继续原 Run。代码改动必须位于独立 Worktree，测试与独立 Review 通过后才会进入交付；不会自动合并或推送。</p>
        {launchGaps.length > 0
          ? <div className="danger-notice" role="alert"><b>安全门禁未通过，暂不能启动</b><ul>{launchGaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></div>
          : <div className="dash-launch-safe"><Stamp status="passed" label="启动门禁通过" /><span>Worktree、quality.test、quality.audit 与人工高风险决策约束已核对。</span></div>}
        {launchError && <p className="dash-advance-error" role="alert">{launchError}</p>}
        <div className="modal-actions">
          <button type="button" className="button secondary" disabled={launching} onClick={() => setLaunchDecision(undefined)}>先不启动</button>
          <button type="button" className="button primary" disabled={launching || launchGaps.length > 0} onClick={() => void launch()}>{launching ? "正在创建 Run…" : "确认并开始推进"}</button>
        </div>
      </div>
    </Modal>}
    {archiveOpen && detail && <Modal title={`归档 ${detail.code}`} eyebrow="ARCHIVE · RECOVERABLE" onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>需求将从看板隐藏。</b><p>原始需求、DAG、时间线与交付证据会完整保留，可在归档中心恢复。</p></div><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setArchiveOpen(false)}>取消</button><button type="button" className="button danger-filled" onClick={() => void archive()}>确认归档</button></div></div></Modal>}
  </main>;
}
