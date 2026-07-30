import { useEffect, useState, type FormEvent } from "react";
import { api, writeBody } from "./api";
import { DossierSection, EmptyState, Field, Modal, ReadonlyEvidence, Stamp, UtilityIcon, formatTime, useDaemonAvailable } from "./components";
import type { Bootstrap, Publication } from "./types";

interface PageProps {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
}

export function PublicationsPage({ data, refresh, notify }: PageProps) {
  const daemonAvailable = useDaemonAvailable();
  const [selectedId, setSelectedId] = useState(data.publications.find((item) => item.status === "active")?.id ?? data.publications[0]?.id ?? "");
  const selected = data.publications.find((item) => item.id === selectedId) ?? data.publications[0];
  const [card, setCard] = useState<unknown>();
  const [createOpen, setCreateOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [draft, setDraft] = useState({ id: "", name: "", description: "", kind: "employee" as "employee" | "workflow", targetId: "" });
  const origin = window.location.origin;
  useEffect(() => {
    if (!selected) { setCard(undefined); return; }
    api(`/api/publications/${selected.id}/card`).then(setCard).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
  }, [selected?.id, selected?.version, notify]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const saved = await api<Publication>("/api/publications", writeBody({ id: draft.id, name: draft.name, description: draft.description, target: { kind: draft.kind, id: draft.targetId } }));
      notify(`A2A 发布 ${saved.id} 已建立`); setSelectedId(saved.id); setCreateOpen(false); await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const archive = async () => {
    if (!selected) return;
    try { await api(`/api/publications/${selected.id}/archive`, writeBody({})); notify(`发布 ${selected.id} 已归档`); setArchiveOpen(false); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const targets = draft.kind === "employee" ? data.employees.filter((item) => item.status === "active") : data.workflows.filter((item) => item.status === "active");

  return <div className="page-grid">
    <aside className="record-list"><header className="list-header"><h1>对外发布</h1><button className="square-action" disabled={!daemonAvailable} onClick={() => setCreateOpen(true)} aria-label="新建发布"><UtilityIcon name="add" /></button></header><div className="record-scroll publication-list">{data.publications.map((publication) => <button key={publication.id} className={`publication-card ${selected?.id === publication.id ? "selected" : ""}`} onClick={() => setSelectedId(publication.id)}><div><strong>{publication.name}</strong><code>{publication.id} · v{publication.version}</code><small>{publication.target.kind} / {publication.target.id}</small></div><Stamp status={publication.status} /></button>)}{data.publications.length === 0 && <div className="mini-empty">尚未发布任何入口。</div>}</div><footer className="list-footer"><span>{data.publications.length} 个入口</span><span>A2A v1</span></footer></aside>
    <main className="detail-pane">{!selected ? <EmptyState title="发布一个统一对外入口" action={<button className="button primary" disabled={!daemonAvailable} onClick={() => setCreateOpen(true)}>新建发布</button>}>选择一位 Employee 或一份 Workflow，由 A2A v1 Agent Card 与 JSON-RPC 入口对外呈现；内部提示词和协作结构保持不透明。</EmptyState> : <div className="dossier publication-dossier">
      <div className="safety-banner"><Stamp status="blocked" label="本机限定" /><div><b>本机回环安全边界</b><p>当前仅监听本机回环地址；无认证能力，不得直接暴露到局域网或公网。</p></div></div>
      <header className="dossier-cover"><div className="file-index"><span>A2A PUBLICATION RECORD</span><code>No. {selected.id.toUpperCase()}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">发</div><div><h2>{selected.name}</h2><p>{selected.description}</p></div><Stamp status={selected.status} /></div><div className="dossier-actions"><button className="button danger" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setArchiveOpen(true)}>归档入口</button></div></header>
      <DossierSection number="01" title="发布目标"><dl className="ledger"><dt>Target kind</dt><dd>{selected.target.kind}</dd><dt>Target ID</dt><dd><code>{selected.target.id}</code></dd><dt>版本</dt><dd>v{selected.version}</dd><dt>更新时间</dt><dd>{formatTime(selected.updatedAt)}</dd></dl></DossierSection>
      <DossierSection number="02" title="调用地址"><ReadonlyEvidence label="JSON-RPC endpoint" value={`${origin}/a2a/${selected.id}`} mono /><ReadonlyEvidence label="Agent Card" value={`${origin}/a2a/${selected.id}/.well-known/agent-card.json`} mono /></DossierSection>
      <DossierSection number="03" title="Agent Card"><ReadonlyEvidence label="A2A v1 · read only" value={card ? JSON.stringify(card, null, 2) : "正在生成 Agent Card…"} mono /></DossierSection>
    </div>}</main>
    {createOpen && <Modal title="建立 A2A 发布" eyebrow="本机回环 · A2A v1" onClose={() => setCreateOpen(false)}><form className="modal-body compact-form" onSubmit={create}><fieldset className="daemon-write-surface" disabled={!daemonAvailable}><div className="safety-banner compact"><Stamp status="blocked" label="本机限定" /><p>v1 只允许本机回环访问，不包含公网认证。</p></div><Field label="Publication ID"><input required pattern="[a-z][a-z0-9-]*" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} /></Field><Field label="对外名称"><input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="说明"><textarea required rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field><div className="form-grid two"><Field label="目标类型"><select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as "employee" | "workflow", targetId: "" })}><option value="employee">Employee</option><option value="workflow">Workflow</option></select></Field><Field label="目标"><select required value={draft.targetId} onChange={(e) => setDraft({ ...draft, targetId: e.target.value })}><option value="">选择目标</option>{targets.map((target) => <option key={target.id} value={target.id}>{"identity" in target ? target.identity.displayName : target.id}</option>)}</select></Field></div></fieldset><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setCreateOpen(false)}>取消</button><button className="button primary" disabled={!daemonAvailable}>建立发布</button></div></form></Modal>}
    {archiveOpen && selected && <Modal title="归档 A2A 入口" eyebrow={`${selected.id} · 保留目标`} onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>Agent Card 与调用入口将停止工作。</b><p>目标 Employee/Workflow 及已有 Run 不受影响。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveOpen(false)}>取消</button><button className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive()}>确认归档</button></div></div></Modal>}
  </div>;
}
