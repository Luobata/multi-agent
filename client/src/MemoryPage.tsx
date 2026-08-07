import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { DossierSection, EmptyState, ReadonlyEvidence, SelectControl, Stamp, formatTime } from "./components";
import type { MemoryEvidence, MemoryKind, MemoryRecord, MemoryScopeSummary } from "./types";

const KIND_LABELS: Record<MemoryKind, string> = {
  "run-summary": "运行摘要",
  "node-detail": "节点细节",
  preference: "偏好"
};

type StatusFilter = "active" | "archived" | "all";

/** Middle-pane row: a `MemoryRecord` plus the optional relevance score carried by search hits. */
type MemoryRow = MemoryRecord & { score?: number };

/**
 * Search hits are `MemoryEvidence` (title/content/traceId/score only) — they never carry the
 * `provenance.runId` a full scope-list record has. Projecting them onto a `MemoryRecord`-shaped
 * row keeps the middle/right panes uniform; the empty runId is what suppresses the run jump.
 */
function evidenceToRecord(evidence: MemoryEvidence): MemoryRow {
  return {
    id: evidence.memoryId,
    scope: { employeeId: "", employeeVersion: 0 },
    kind: evidence.kind,
    title: evidence.title,
    content: evidence.content,
    provenance: { runId: "", traceId: evidence.traceId },
    status: "active",
    tokens: 0,
    createdAt: evidence.createdAt,
    supersedesId: null,
    score: evidence.score
  };
}

function scopeParts(scopeKey: string): { dimension: string; id: string } {
  const [dimension = "", ...rest] = scopeKey.split(":");
  return { dimension, id: rest.join(":") };
}

export function MemoryPage({ notify, onOpenRun }: {
  notify: (message: string, kind?: "success" | "error") => void;
  onOpenRun: (runId: string) => void;
}) {
  const [scopes, setScopes] = useState<MemoryScopeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedScope, setSelectedScope] = useState("");
  const [records, setRecords] = useState<MemoryRow[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [selectedId, setSelectedId] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let current = true;
    api<{ scopes: MemoryScopeSummary[] }>("/api/memory/scopes")
      .then((value) => { if (current) setScopes(value.scopes); })
      .catch((error: unknown) => { if (current) notify(error instanceof Error ? error.message : String(error), "error"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [notify]);

  useEffect(() => {
    if (!selectedScope) { setRecords([]); return; }
    let current = true;
    const trimmed = query.trim();
    if (trimmed) {
      const { dimension, id } = scopeParts(selectedScope);
      const body = {
        query: trimmed,
        employeeId: dimension === "employee" ? id : undefined,
        projectId: dimension === "project" ? id : undefined,
        limit: 40
      };
      api<{ evidence: MemoryEvidence[] }>("/api/memory/search", { method: "POST", body: JSON.stringify(body) })
        .then((value) => { if (current) setRecords(value.evidence.map(evidenceToRecord)); })
        .catch((error: unknown) => { if (current) notify(error instanceof Error ? error.message : String(error), "error"); });
    } else {
      api<{ records: MemoryRecord[] }>(`/api/memory/scope?key=${encodeURIComponent(selectedScope)}`)
        .then((value) => { if (current) setRecords(value.records); })
        .catch((error: unknown) => { if (current) notify(error instanceof Error ? error.message : String(error), "error"); });
    }
    return () => { current = false; };
  }, [selectedScope, query, notify]);

  const searching = query.trim().length > 0;
  const visible = useMemo(
    // Search hits are always active; the active/archived filter only applies to full scope records.
    () => searching ? records : records.filter((record) => statusFilter === "all" || record.status === statusFilter),
    [records, statusFilter, searching]
  );
  const detail = visible.find((record) => record.id === selectedId);
  const employeeScopes = useMemo(() => scopes.filter((scope) => scope.scopeKey.startsWith("employee:")), [scopes]);
  const projectScopes = useMemo(() => scopes.filter((scope) => scope.scopeKey.startsWith("project:")), [scopes]);
  const totalRecords = scopes.reduce((sum, scope) => sum + scope.count, 0);

  const selectScope = (scopeKey: string) => {
    setSelectedScope(scopeKey);
    setQuery("");
    setSelectedId("");
    setExpanded(false);
  };
  const selectRecord = (id: string) => {
    setSelectedId(id);
    setExpanded(false);
  };

  if (!loading && scopes.length === 0) {
    return <div className="page-grid page-grid--runs">
      <main className="detail-pane">
        <EmptyState title="还没有任何记忆档案">
          记忆会在员工运行结束后自动提炼产生——一次多节点或有明确结论的运行完成后，才会在这里留下可查阅的档案。
        </EmptyState>
      </main>
    </div>;
  }

  const renderScopeGroup = (label: string, group: MemoryScopeSummary[]) => group.length > 0 && <div className="memory-scope-group">
    <p className="record-meta">{label}</p>
    {group.map((scope) => <button
      key={scope.scopeKey}
      type="button"
      className={`memory-scope-card run-card ${selectedScope === scope.scopeKey ? "selected" : ""}`}
      onClick={() => selectScope(scope.scopeKey)}
    >
      <div><strong>{scope.scopeKey}</strong><small>{scope.count} 条记忆</small></div>
    </button>)}
  </div>;

  return <div className="page-grid page-grid--runs" style={{ gridTemplateColumns: "var(--list-width) minmax(320px, 1fr) minmax(300px, 1.15fr)" }}>
    <aside className="record-list">
      <header className="list-header"><h1>记忆档案</h1></header>
      <div className="record-scroll">
        {loading && <div className="mini-empty">正在调取记忆档案…</div>}
        {renderScopeGroup("员工记忆", employeeScopes)}
        {renderScopeGroup("项目记忆", projectScopes)}
      </div>
      <footer className="list-footer"><span>{scopes.length} 个范围 · {totalRecords} 条</span><span>READ ONLY</span></footer>
    </aside>

    <section className="record-list memory-record-column">
      <div className="list-tools">
        <input
          type="search"
          value={query}
          placeholder="按关键词检索该范围的记忆"
          aria-label="检索记忆"
          disabled={!selectedScope}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="memory-status-filter" data-testid="memory-status-filter">
          <SelectControl
            ariaLabel="按状态筛选记忆"
            value={statusFilter}
            options={[{ value: "active", label: "在册" }, { value: "archived", label: "归档" }, { value: "all", label: "全部" }]}
            onChange={(value) => setStatusFilter(value as StatusFilter)}
            disabled={searching}
          />
        </div>
      </div>
      <div className="record-scroll">
        {!selectedScope
          ? <div className="mini-empty">先在左侧选择一个记忆范围。</div>
          : visible.length === 0
            ? <div className="mini-empty">{searching ? "没有匹配的记忆。" : "该范围下暂无符合筛选条件的记忆。"}</div>
            : visible.map((record) => <button
              key={record.id}
              type="button"
              className={`memory-record-card run-card ${selectedId === record.id ? "selected" : ""}`}
              onClick={() => selectRecord(record.id)}
            >
              <div>
                <strong>{record.title}</strong>
                <small>{KIND_LABELS[record.kind] ?? record.kind} · {formatTime(record.createdAt)}{typeof record.score === "number" ? ` · 相关度 ${record.score.toFixed(2)}` : ""}</small>
              </div>
              <Stamp status={record.status} />
            </button>)}
      </div>
      <footer className="list-footer"><span>{visible.length} 条记忆</span><span>{searching ? "SEARCH" : "SCOPE"}</span></footer>
    </section>

    <main className="detail-pane">
      {!detail
        ? <EmptyState title="尚未选择记忆">在中栏选择一条记忆，即可查看摘要与完整溯源。</EmptyState>
        : <div className="dossier">
          <header className="dossier-cover">
            <div className="file-index"><span>MEMORY RECORD</span><code>{detail.id}</code></div>
            <div className="dossier-title-row">
              <div><h2>{detail.title}</h2><p>{KIND_LABELS[detail.kind] ?? detail.kind}</p></div>
              <Stamp status={detail.status} />
            </div>
          </header>
          <DossierSection number="01" title="记忆摘要">
            <p className="memory-summary">{detail.content}</p>
          </DossierSection>
          <DossierSection
            number="02"
            title="溯源与完整详情"
            action={<button type="button" className="text-button" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起详情" : "展开完整详情"}</button>}
          >
            {expanded
              ? <>
                <dl className="ledger">
                  <dt>类型</dt><dd>{KIND_LABELS[detail.kind] ?? detail.kind}</dd>
                  <dt>创建时间</dt><dd>{formatTime(detail.createdAt)}</dd>
                  <dt>归属范围</dt><dd><code>{selectedScope || "—"}</code></dd>
                  <dt>Trace ID</dt><dd><code className="path-code">{detail.provenance.traceId || "—"}</code></dd>
                  {detail.provenance.invocationId && <><dt>Invocation</dt><dd><code className="path-code">{detail.provenance.invocationId}</code></dd></>}
                  {typeof detail.score === "number" && <><dt>相关度</dt><dd>{detail.score.toFixed(2)}</dd></>}
                </dl>
                {detail.provenance.runId
                  ? <div className="memory-run-jump">
                    <span>对应运行卷宗</span>
                    <button type="button" className="text-button" data-testid="memory-run-link" onClick={() => onOpenRun(detail.provenance.runId)}>{detail.provenance.runId}</button>
                  </div>
                  : <p className="memory-run-missing">检索命中的记忆仅保留 trace 溯源，未附带运行卷宗跳转。</p>}
                <ReadonlyEvidence label="记忆正文" value={detail.content} />
              </>
              : <p className="memory-detail-hint">展开可查看类型、时间、归属范围与运行溯源。</p>}
          </DossierSection>
        </div>}
    </main>
  </div>;
}
