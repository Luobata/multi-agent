import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { DossierSection, EmptyState, SelectControl, Stamp, formatTime, scrollRecordIntoView } from "./components";
import { SupervisorRunTopology } from "./SupervisorRunTopology";
import { EffectiveProfileView } from "./EffectiveProfileView";
import type { JsonValue, Run, RunNode } from "./types";

const CATEGORY_LABELS: Record<"single" | "graph" | "supervisor", string> = {
  single: "单任务",
  graph: "Graph 编排",
  supervisor: "领队协作"
};

export function filterRuns(
  runs: Run[],
  filters: { category: "all" | "single" | "graph" | "supervisor"; project: "all" | "none" | string }
): Run[] {
  return runs.filter((run) => {
    if (filters.category !== "all" && (run.category ?? "graph") !== filters.category) return false;
    if (filters.project === "none") return !run.project;
    if (filters.project !== "all" && run.project !== filters.project) return false;
    return true;
  });
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

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

interface E2eEvidenceEntry {
  method?: string;
  steps?: string;
  observed?: string;
}

/** Reads a structured `e2eEvidence` array off any output object; tolerant of missing/oddly-typed fields. */
function e2eEvidenceEntries(value: JsonValue | undefined): E2eEvidenceEntry[] {
  const raw = objectValue(value)?.e2eEvidence;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => objectValue(item))
    .filter((item): item is Record<string, JsonValue> => item !== undefined)
    .map((item) => ({
      method: typeof item.method === "string" ? item.method : undefined,
      steps: typeof item.steps === "string" ? item.steps : undefined,
      observed: typeof item.observed === "string" ? item.observed : undefined
    }))
    .filter((entry) => entry.method || entry.steps || entry.observed);
}

function E2eEvidenceList({ entries }: { entries: E2eEvidenceEntry[] }) {
  if (entries.length === 0) return null;
  return <ul className="run-e2e-evidence">{entries.map((entry, index) => <li key={index}>
    {entry.method && <code className="run-e2e-method">{entry.method}</code>}
    {entry.steps && <span className="run-e2e-steps">{entry.steps}</span>}
    {entry.observed && <><span className="run-e2e-arrow" aria-hidden="true">→</span><span className="run-e2e-observed">{entry.observed}</span></>}
  </li>)}</ul>;
}

const GATE_STATUS_LABELS: Record<string, string> = {
  passed: "通过",
  blocked: "未通过",
  pending: "待判定",
  skipped: "跳过"
};

interface GateVerdict {
  gateId: string;
  status: string;
  reason?: string;
  requiredCapability?: string;
}

/** Reads the supervisor gate snapshot off `run.output.gates`; safe when absent or malformed. */
function gateVerdicts(value: JsonValue | undefined): GateVerdict[] {
  const raw = objectValue(value)?.gates;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => objectValue(item))
    .filter((item): item is Record<string, JsonValue> => item !== undefined && typeof item.gateId === "string")
    .map((item) => ({
      gateId: String(item.gateId),
      status: typeof item.status === "string" ? item.status : "unknown",
      reason: typeof item.reason === "string" ? item.reason : undefined,
      requiredCapability: typeof item.requiredCapability === "string" ? item.requiredCapability : undefined
    }));
}

function GateVerdictList({ gates }: { gates: GateVerdict[] }) {
  if (gates.length === 0) return null;
  return <ul className="run-gate-list">{gates.map((gate) => <li key={gate.gateId} className={`run-gate-item run-gate-item--${gate.status}`}>
    <div className="run-gate-head"><code>{gate.gateId}</code><span className={`gate-status gate-status--${gate.status}`}>{GATE_STATUS_LABELS[gate.status] ?? gate.status}</span>{gate.requiredCapability && <small>{gate.requiredCapability}</small>}</div>
    {gate.status !== "passed" && gate.reason && <p className="gate-reason">{gate.reason}</p>}
  </li>)}</ul>;
}

function dagFlowTag(node: RunNode): string {
  if (node.metadata?.kind !== "member" || typeof node.metadata.flowNodeId !== "string") return "";
  const kind = typeof node.metadata.flowNodeKind === "string" ? node.metadata.flowNodeKind : "dag";
  const execution = typeof node.metadata.flowNodeExecution === "number" && node.metadata.flowNodeExecution > 1
    ? ` · 第 ${node.metadata.flowNodeExecution} 次执行`
    : "";
  return ` · 环节 ${node.metadata.flowNodeId} [${kind}]${execution}`;
}

export function RunsPage({ notify, activityRevision = "", pendingRunId = "", onConsumePending }: {
  notify: (message: string, kind?: "success" | "error") => void;
  activityRevision?: string;
  pendingRunId?: string;
  onConsumePending?: () => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Run>();
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<"all" | "single" | "graph" | "supervisor">("all");
  const [projectFilter, setProjectFilter] = useState<"all" | "none" | string>("all");
  useEffect(() => {
    let current = true;
    api<Run[]>("/api/runs?limit=100").then((value) => {
      if (!current) return;
      setRuns(value);
      setSelectedId((selected) => selected || value[0]?.id || "");
      // A memory detail can hand us a run to open. Select and reveal it once the
      // list confirms the run exists; silently ignore ids absent from the list.
      if (pendingRunId && value.some((run) => run.id === pendingRunId)) {
        setSelectedId(pendingRunId);
        scrollRecordIntoView(pendingRunId);
        onConsumePending?.();
      }
    }).catch((error: unknown) => {
      if (current) notify(error instanceof Error ? error.message : String(error), "error");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [notify, activityRevision, pendingRunId, onConsumePending]);
  useEffect(() => {
    if (!selectedId) { setDetail(undefined); return; }
    let current = true;
    setDetail(undefined);
    api<Run>(`/api/runs/${encodeURIComponent(selectedId)}`)
      .then((value) => { if (current) setDetail(value); })
      .catch((error: unknown) => { if (current) notify(error instanceof Error ? error.message : String(error), "error"); });
    return () => { current = false; };
  }, [selectedId, notify, activityRevision]);
  const projectOptions = useMemo(
    () => [...new Set(runs.map((run) => run.project).filter((project): project is string => Boolean(project)))].sort(),
    [runs]
  );
  const visibleRuns = useMemo(
    () => filterRuns(runs, { category: categoryFilter, project: projectFilter }),
    [runs, categoryFilter, projectFilter]
  );
  const summary = visibleRuns.find((run) => run.id === selectedId) ?? visibleRuns[0];
  const selected = detail?.id === summary?.id ? detail : summary;
  const profileEntries = Object.entries(selected?.effectiveProfiles ?? {});
  return <div className="page-grid page-grid--runs">
    <aside className="record-list"><header className="list-header"><h1>运行卷宗</h1></header><div className="run-filter-bar"><div data-testid="run-type-filter"><SelectControl ariaLabel="按类型筛选运行卷宗" value={categoryFilter} options={[{ value: "all", label: "全部类型" }, { value: "single", label: "单任务" }, { value: "graph", label: "Graph 编排" }, { value: "supervisor", label: "领队协作" }]} onChange={(value) => setCategoryFilter(value as typeof categoryFilter)} /></div><div data-testid="run-project-filter"><SelectControl ariaLabel="按项目筛选运行卷宗" value={projectFilter} options={[{ value: "all", label: "全部项目" }, { value: "none", label: "无项目" }, ...projectOptions.map((project) => ({ value: project, label: project }))]} onChange={(value) => setProjectFilter(value)} /></div></div><div className="record-scroll run-list">{visibleRuns.map((run) => <button key={run.id} id={run.id} className={`run-card ${selected?.id === run.id ? "selected" : ""}`} onClick={() => setSelectedId(run.id)}><div><code>{run.id}</code><strong>{run.workflow}</strong><small>{formatTime(run.createdAt)} · {run.architecture} · {Object.keys(run.nodes).length} 节点</small><div className="run-card-tags">{run.category && <span className={`run-category-tag run-category-tag--${run.category}`}>{CATEGORY_LABELS[run.category]}</span>}{run.project && <span className="run-project-chip">{run.project}</span>}</div></div><Stamp status={run.status} /></button>)}{!loading && visibleRuns.length === 0 && <div className="mini-empty">{runs.length === 0 ? "还没有 Run 证据。" : "没有符合筛选条件的卷宗。"}</div>}</div><footer className="list-footer"><span>{visibleRuns.length}/{runs.length} 份卷宗</span><span>READ ONLY</span></footer></aside>
    <main className="detail-pane">{loading ? <div className="skeleton-page" aria-label="正在调取运行卷宗"><i /><i /><i /></div> : !selected ? <EmptyState title="尚无运行卷宗">直接交办员工或签发一次 Workflow 后，这里会出现不可变的执行记录。</EmptyState> : <div className="dossier run-dossier">
      <header className="dossier-cover"><div className="file-index"><span>RUN EVIDENCE RECORD</span><code>{selected.id}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">证</div><div><h2>{selected.workflow}</h2><p>{selected.status === "blocked" ? "流程已完成，但存在业务阻塞结论。" : selected.status === "failed" ? "执行发生技术故障，可查看原始输出与错误证据。" : selected.status === "running" ? "执行仍在进行。" : "流程完成，证据已归档。"}</p></div><Stamp status={selected.status} /></div></header>
      <DossierSection number="01" title="运行元数据"><dl className="ledger"><dt>Run ID</dt><dd><code>{selected.id}</code></dd><dt>Architecture</dt><dd>{selected.architecture}</dd><dt>创建时间</dt><dd>{formatTime(selected.createdAt)}</dd><dt>完成时间</dt><dd>{formatTime(selected.completedAt)}</dd><dt>证据目录</dt><dd><code className="path-code">{selected.artifactDir}</code></dd></dl></DossierSection>
      {profileEntries.length > 0 && <DossierSection number="02" title="有效执行配置与来源"><div className="run-profile-list">{profileEntries.map(([nodeId, profile]) => <details key={nodeId} open={profileEntries.length === 1}><summary><strong>{nodeId}</strong><span>{profile.employee.displayName} · v{profile.employee.version}</span></summary><EffectiveProfileView profile={profile} /></details>)}</div></DossierSection>}
      {selected.architecture === "supervisor" && <DossierSection number={profileEntries.length > 0 ? "03" : "02"} title="动态执行图"><SupervisorRunTopology nodes={Object.values(selected.nodes)} /></DossierSection>}
      <DossierSection number={profileEntries.length > 0 ? (selected.architecture === "supervisor" ? "04" : "03") : (selected.architecture === "supervisor" ? "03" : "02")} title="节点结果"><div className="run-node-list">{Object.values(selected.nodes).map((node, index) => { const decision = supervisorDecision(node); return <article key={node.nodeId}><div className="run-node-head"><span className="node-number">{String(index + 1).padStart(2, "0")}</span><div><strong>{node.nodeId}</strong><code>{node.roleId}{node.metadata?.kind === "supervisor" ? ` · 领队 Round ${node.metadata.round ?? "—"}` : node.metadata?.kind === "member" ? ` · 成员 Round ${node.metadata.round ?? "—"}` : ""}{dagFlowTag(node)}</code></div><Stamp status={node.status} /></div><dl className="ledger horizontal"><dt>尝试</dt><dd>{node.attempts}</dd><dt>开始</dt><dd>{formatTime(node.startedAt)}</dd><dt>结束</dt><dd>{formatTime(node.completedAt)}</dd></dl>{decision && <div className="supervisor-decision-summary"><code>{decision.action.toUpperCase()}</code><span>{decision.summary ?? "领队未提供本轮摘要。"}</span></div>}{node.error && <div className="inline-error">{node.error}</div>}{node.output !== undefined && <><E2eEvidenceList entries={e2eEvidenceEntries(node.output)} /><pre className="result-json">{JSON.stringify(node.output, null, 2)}</pre></>}<code className="artifact-path">{node.artifactDir}</code></article>; })}</div></DossierSection>
      {selected.output !== undefined && <DossierSection number={profileEntries.length > 0 ? (selected.architecture === "supervisor" ? "05" : "04") : (selected.architecture === "supervisor" ? "04" : "03")} title="Workflow 最终输出">{finalSummary(selected) && <p className="workflow-final-summary">{finalSummary(selected)}</p>}<GateVerdictList gates={gateVerdicts(selected.output)} /><E2eEvidenceList entries={e2eEvidenceEntries(selected.output)} /><pre className="result-json">{JSON.stringify(selected.output, null, 2)}</pre></DossierSection>}
    </div>}</main>
  </div>;
}
