/** 需求详情：原始需求 / 验收标准 / 任务 DAG / Agent 时间线 / Diff·测试·Review·交付物。
 *  DAG / 时间线 / 资源概览的演示徽标完全由数据 demo 标记驱动。列迁移走目标列 SelectControl。 */
import { useState } from "react";
import { DemoBadge, DossierSection, EmptyState, Modal, ReadonlyEvidence, RuntimeStatusChip, SelectControl, Stamp, formatTime, useDaemonAvailable } from "./components";
import { dashboardService, type DashboardService } from "./dashboard/service";
import type { DagTaskNode, RequirementDetail, RequirementLane } from "./dashboard/types";
import { REQUIREMENT_EXCEPTION_LABELS, REQUIREMENT_LANES, requirementLaneLabel } from "./dashboard/types";
import { ErrorBlock, OfflineNotice, PageHeader, SkeletonBlock, useServiceData } from "./dashboard/view";

function dagStamp(status: DagTaskNode["status"]) {
  if (status === "completed") return <Stamp status="completed" />;
  if (status === "running") return <Stamp status="running" />;
  if (status === "blocked") return <Stamp status="blocked" />;
  if (status === "failed") return <Stamp status="failed" />;
  if (status === "skipped") return <Stamp status="skipped" />;
  return <Stamp status="pending" />;
}

export function RequirementDetailPage({ requirementId, go, notify, service = dashboardService }: {
  requirementId: string;
  go: (hash: string) => void;
  notify: (message: string, kind?: "success" | "error") => void;
  service?: DashboardService;
}) {
  const daemonAvailable = useDaemonAvailable();
  const { state, reload, setData } = useServiceData<RequirementDetail>(() => service.getRequirement(requirementId), [service, requirementId]);
  const [targetLane, setTargetLane] = useState<RequirementLane | "">("");
  const [migrating, setMigrating] = useState(false);
  const [migrateError, setMigrateError] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);

  const detail = state.status === "ready" ? state.data : undefined;

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

  return <main className="dash-page">
    <PageHeader eyebrow="REQUIREMENT / DOSSIER" title="需求详情" description="第一阶段列迁移在此完成；DAG 与时间线展示以数据徽标为准。" actions={<button type="button" className="button secondary" onClick={() => go(detail ? `projects/${detail.projectId}/board` : "board")}>← 返回看板</button>} />
    <OfflineNotice />
    {state.status === "loading" && <SkeletonBlock rows={5} label="正在加载需求详情" />}
    {state.status === "error" && <ErrorBlock message={state.error ?? "加载失败"} onRetry={reload} />}
    {state.status === "ready" && !detail && <EmptyState title="没有找到这条需求" action={<button type="button" className="button secondary" onClick={() => go("board")}>返回需求看板</button>}><p>它可能已被移除；看板数据未受影响。</p></EmptyState>}
    {state.status === "ready" && detail && <div className="dash-dossier">
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
          <dt>负责人</dt><dd>{detail.owner}</dd>
          <dt>创建</dt><dd>{formatTime(detail.createdAt)}</dd>
          <dt>最近更新</dt><dd>{formatTime(detail.updatedAt)}</dd>
        </dl>
        <div className="dash-migrate" role="group" aria-label="迁移目标列">
          <SelectControl
            ariaLabel="目标列"
            placeholder="选择目标列…"
            value={targetLane}
            disabled={!daemonAvailable || migrating || detail.exception === "cancelled"}
            invalid={Boolean(migrateError)}
            errorMessage={migrateError || undefined}
            options={REQUIREMENT_LANES.map((lane) => ({ value: lane.id, label: lane.label, disabled: lane.id === detail.lane, description: lane.id === detail.lane ? "当前所在列" : undefined }))}
            onChange={(value) => { setTargetLane(value as RequirementLane); setMigrateError(""); }}
          />
          <button type="button" className="button primary" disabled={!daemonAvailable || migrating || !targetLane} onClick={() => void migrate()}>{migrating ? "迁移中…" : "迁移到目标列"}</button>
          <button type="button" className="button danger" disabled={!daemonAvailable} onClick={() => setArchiveOpen(true)}>归档需求</button>
        </div>
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
    {archiveOpen && detail && <Modal title={`归档 ${detail.code}`} eyebrow="ARCHIVE · RECOVERABLE" onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>需求将从看板隐藏。</b><p>原始需求、DAG、时间线与交付证据会完整保留，可在归档中心恢复。</p></div><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setArchiveOpen(false)}>取消</button><button type="button" className="button danger-filled" onClick={() => void archive()}>确认归档</button></div></div></Modal>}
  </main>;
}
