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
      notify(`调用包 ${saved.id} 已建立`); setSelectedId(saved.id); setCreateOpen(false); await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const archive = async () => {
    if (!selected) return;
    try { await api(`/api/publications/${selected.id}/archive`, writeBody({})); notify(`发布 ${selected.id} 已归档`); setArchiveOpen(false); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const targets = draft.kind === "employee" ? data.employees.filter((item) => item.status === "active") : data.workflows.filter((item) => item.status === "active");

  return <div className="page-grid">
    <aside className="record-list"><header className="list-header"><h1>调用包</h1><button className="square-action" disabled={!daemonAvailable} onClick={() => setCreateOpen(true)} aria-label="新建调用包"><UtilityIcon name="add" /></button></header><div className="record-scroll publication-list">{data.publications.map((publication) => <button key={publication.id} className={`publication-card ${selected?.id === publication.id ? "selected" : ""}`} onClick={() => setSelectedId(publication.id)}><div><strong>{publication.name}</strong><code>{publication.id} · v{publication.version}</code><small>{publication.target.kind === "employee" ? "单 Agent" : "多 Agent 团队"} / {publication.target.id}</small></div><Stamp status={publication.status} /></button>)}{data.publications.length === 0 && <div className="mini-empty">尚未建立可调用包。</div>}</div><footer className="list-footer"><span>{data.publications.length} 个调用包</span><span>MCP · A2A</span></footer></aside>
    <main className="detail-pane">{!selected ? <EmptyState title="打包一个统一调用入口" action={<button className="button primary" disabled={!daemonAvailable} onClick={() => setCreateOpen(true)}>新建调用包</button>}>把一位 Employee 或一份 Workflow 包成稳定入口。其他会话只需要知道 Publication ID，不需要理解内部提示词、Skill 或协作图。</EmptyState> : <div className="dossier publication-dossier">
      <div className="safety-banner"><Stamp status="blocked" label="本机限定" /><div><b>本机回环安全边界</b><p>当前仅监听本机回环地址；无认证能力，不得直接暴露到局域网或公网。</p></div></div>
      <header className="dossier-cover"><div className="file-index"><span>A2A PUBLICATION RECORD</span><code>No. {selected.id.toUpperCase()}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">发</div><div><h2>{selected.name}</h2><p>{selected.description}</p></div><Stamp status={selected.status} /></div><div className="dossier-actions"><button className="button danger" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setArchiveOpen(true)}>归档入口</button></div></header>
      <DossierSection number="01" title="调用包目标"><dl className="ledger"><dt>Package kind</dt><dd>{selected.target.kind === "employee" ? "Single Agent" : "Multi-Agent Team"}</dd><dt>Target ID</dt><dd><code>{selected.target.id}</code></dd><dt>版本</dt><dd>v{selected.version}</dd><dt>更新时间</dt><dd>{formatTime(selected.updatedAt)}</dd></dl></DossierSection>
      <DossierSection number="02" title="其他会话调用"><ReadonlyEvidence label="MCP tool · 推荐" value={JSON.stringify({ tool: "invoke_publication", arguments: { publicationId: selected.id, input: { message: "在这里填写任务" }, project: "调用方项目名", contextId: "可选的会话 ID" } }, null, 2)} mono /><ReadonlyEvidence label="Loopback HTTP" value={`POST ${origin}/api/publications/${selected.id}/invoke\nContent-Type: application/json\nX-Multi-Agent-Project: 调用方项目名\n\n{\"message\":\"在这里填写任务\"}`} mono /></DossierSection>
      <DossierSection number="03" title="A2A 入口"><ReadonlyEvidence label="JSON-RPC endpoint" value={`${origin}/a2a/${selected.id}`} mono /><ReadonlyEvidence label="Agent Card" value={`${origin}/a2a/${selected.id}/.well-known/agent-card.json`} mono /></DossierSection>
      <DossierSection number="04" title="Agent Card"><ReadonlyEvidence label="A2A v1 · read only" value={card ? JSON.stringify(card, null, 2) : "正在生成 Agent Card…"} mono /></DossierSection>
    </div>}</main>
    {createOpen && <Modal title="建立调用包" eyebrow="本机回环 · MCP / A2A" onClose={() => setCreateOpen(false)}><form className="modal-body compact-form" onSubmit={create}><fieldset className="daemon-write-surface" disabled={!daemonAvailable}><div className="safety-banner compact"><Stamp status="blocked" label="本机限定" /><p>v1 只允许本机回环访问，不包含公网认证。</p></div><Field label="Publication ID"><input required pattern="[a-z][a-z0-9-]*" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} /></Field><Field label="调用包名称"><input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="说明"><textarea required rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field><div className="form-grid two"><Field label="打包形态"><select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as "employee" | "workflow", targetId: "" })}><option value="employee">单 Agent</option><option value="workflow">多 Agent 团队</option></select></Field><Field label="目标"><select required value={draft.targetId} onChange={(e) => setDraft({ ...draft, targetId: e.target.value })}><option value="">选择目标</option>{targets.map((target) => <option key={target.id} value={target.id}>{"identity" in target ? target.identity.displayName : target.id}</option>)}</select></Field></div></fieldset><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setCreateOpen(false)}>取消</button><button className="button primary" disabled={!daemonAvailable}>建立调用包</button></div></form></Modal>}
    {archiveOpen && selected && <Modal title="归档 A2A 入口" eyebrow={`${selected.id} · 保留目标`} onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>Agent Card 与调用入口将停止工作。</b><p>目标 Employee/Workflow 及已有 Run 不受影响。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveOpen(false)}>取消</button><button className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive()}>确认归档</button></div></div></Modal>}
  </div>;
}
