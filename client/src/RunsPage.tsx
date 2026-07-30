import { useEffect, useState } from "react";
import { api } from "./api";
import { DossierSection, EmptyState, Stamp, formatTime } from "./components";
import type { Run } from "./types";

export function RunsPage({ notify }: { notify: (message: string, kind?: "success" | "error") => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api<Run[]>("/api/runs?limit=100").then((value) => { setRuns(value); setSelectedId((current) => current || value[0]?.id || ""); }).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error")).finally(() => setLoading(false));
  }, [notify]);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  return <div className="page-grid">
    <aside className="record-list"><header className="list-header"><h1>运行卷宗</h1></header><div className="record-scroll run-list">{runs.map((run) => <button key={run.id} className={`run-card ${selected?.id === run.id ? "selected" : ""}`} onClick={() => setSelectedId(run.id)}><div><code>{run.id}</code><strong>{run.workflow}</strong><small>{formatTime(run.createdAt)} · {Object.keys(run.nodes).length} 节点</small></div><Stamp status={run.status} /></button>)}{!loading && runs.length === 0 && <div className="mini-empty">还没有 Run 证据。</div>}</div><footer className="list-footer"><span>{runs.length} 份卷宗</span><span>READ ONLY</span></footer></aside>
    <main className="detail-pane">{loading ? <div className="skeleton-page" aria-label="正在调取运行卷宗"><i /><i /><i /></div> : !selected ? <EmptyState title="尚无运行卷宗">直接交办员工或签发一次 Workflow 后，这里会出现不可变的执行记录。</EmptyState> : <div className="dossier run-dossier">
      <header className="dossier-cover"><div className="file-index"><span>RUN EVIDENCE RECORD</span><code>{selected.id}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">证</div><div><h2>{selected.workflow}</h2><p>{selected.status === "blocked" ? "流程已完成，但存在业务阻塞结论。" : selected.status === "failed" ? "执行发生技术故障，可查看原始输出与错误证据。" : selected.status === "running" ? "执行仍在进行。" : "流程完成，证据已归档。"}</p></div><Stamp status={selected.status} /></div></header>
      <DossierSection number="01" title="运行元数据"><dl className="ledger"><dt>Run ID</dt><dd><code>{selected.id}</code></dd><dt>Architecture</dt><dd>{selected.architecture}</dd><dt>创建时间</dt><dd>{formatTime(selected.createdAt)}</dd><dt>完成时间</dt><dd>{formatTime(selected.completedAt)}</dd><dt>证据目录</dt><dd><code className="path-code">{selected.artifactDir}</code></dd></dl></DossierSection>
      <DossierSection number="02" title="节点结果"><div className="run-node-list">{Object.values(selected.nodes).map((node, index) => <article key={node.nodeId}><div className="run-node-head"><span className="node-number">{String(index + 1).padStart(2, "0")}</span><div><strong>{node.nodeId}</strong><code>{node.roleId}</code></div><Stamp status={node.status} /></div><dl className="ledger horizontal"><dt>尝试</dt><dd>{node.attempts}</dd><dt>开始</dt><dd>{formatTime(node.startedAt)}</dd><dt>结束</dt><dd>{formatTime(node.completedAt)}</dd></dl>{node.error && <div className="inline-error">{node.error}</div>}{node.output !== undefined && <pre className="result-json">{JSON.stringify(node.output, null, 2)}</pre>}<code className="artifact-path">{node.artifactDir}</code></article>)}</div></DossierSection>
    </div>}</main>
  </div>;
}
