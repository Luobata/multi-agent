import { useEffect, useState, type FormEvent } from "react";
import { api, writeBody } from "./api";
import { DossierSection, EmptyState, Field, Modal, ReadonlyEvidence, SelectControl, Stamp, UtilityIcon, formatTime, useDaemonAvailable } from "./components";
import { isSystemEmployee } from "./employeeAccess";
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
  const targets = draft.kind === "employee"
    ? data.employees.filter((item) => item.status === "active" && !isSystemEmployee(item))
    : data.workflows.filter((item) => item.status === "active");
  const targetError = draft.id && draft.name && draft.description && !draft.targetId
    ? targets.length
      ? "请选择一个调用目标。"
      : draft.kind === "employee"
        ? "暂无对外可调用的在册员工；系统级员工不能发布，请先建立或恢复普通员工档案。"
        : "暂无在用编排，请先建立或恢复协作编排。"
    : undefined;
  const targetOptions = [
    {
      value: "",
      label: targets.length ? "选择目标" : "暂无可调用目标",
      description: targets.length
        ? draft.kind === "employee" ? "选择一位在册员工" : "选择一份在用编排"
        : draft.kind === "employee" ? "系统级员工不可发布；请先建立或恢复普通员工档案" : "请先建立或恢复协作编排",
      disabled: targets.length === 0
    },
    ...targets.map((target) => ({
      value: target.id,
      label: "identity" in target ? target.identity.displayName : target.id,
      description: `${target.id} · v${target.version}`
    }))
  ];
  const externalTool = selected?.target.kind === "workflow" ? "start_publication" : "invoke_publication";
  const externalPath = selected?.target.kind === "workflow" ? "start" : "invoke";

  return <div className="page-grid page-grid--publications">
    <aside className="record-list"><header className="list-header"><h1>调用包</h1><button className="square-action" disabled={!daemonAvailable} onClick={() => setCreateOpen(true)} aria-label="新建调用包"><UtilityIcon name="add" /></button></header><div className="record-scroll publication-list">{data.publications.map((publication) => <button key={publication.id} className={`publication-card ${selected?.id === publication.id ? "selected" : ""}`} onClick={() => setSelectedId(publication.id)}><div><strong>{publication.name}</strong><code>{publication.id} · v{publication.version}</code><small>{publication.target.kind === "employee" ? "单 Agent" : "多 Agent 团队"} / {publication.target.id}</small></div><Stamp status={publication.status} /></button>)}{data.publications.length === 0 && <div className="mini-empty">尚未建立可调用包。</div>}</div><footer className="list-footer"><span>{data.publications.length} 个调用包</span><span>MCP · A2A</span></footer></aside>
    <main className="detail-pane">{!selected ? <EmptyState title="打包一个统一调用入口" action={<button className="button primary" disabled={!daemonAvailable} onClick={() => setCreateOpen(true)}>新建调用包</button>}>把一位 Employee 或一份 Workflow 包成稳定入口。其他会话只需要知道 Publication ID，不需要理解内部提示词、Skill 或协作图。</EmptyState> : <div className="dossier publication-dossier">
      <div className="safety-banner"><Stamp status="blocked" label="本机限定" /><div><b>本机回环安全边界</b><p>当前仅监听本机回环地址；无认证能力，不得直接暴露到局域网或公网。</p></div></div>
      <header className="dossier-cover"><div className="file-index"><span>A2A PUBLICATION RECORD</span><code>No. {selected.id.toUpperCase()}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">发</div><div><h2>{selected.name}</h2><p>{selected.description}</p></div><Stamp status={selected.status} /></div><div className="dossier-actions"><button className="button danger" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setArchiveOpen(true)}>归档入口</button></div></header>
      <DossierSection number="01" title="调用包目标"><dl className="ledger"><dt>Package kind</dt><dd>{selected.target.kind === "employee" ? "Single Agent" : "Multi-Agent Team"}</dd><dt>Target ID</dt><dd><code>{selected.target.id}</code></dd><dt>版本</dt><dd>v{selected.version}</dd><dt>更新时间</dt><dd>{formatTime(selected.updatedAt)}</dd></dl></DossierSection>
      <DossierSection number="02" title="其他会话调用"><ReadonlyEvidence label="MCP tool · 推荐" value={JSON.stringify({ tool: externalTool, arguments: { publicationId: selected.id, input: { message: "在这里填写任务" }, project: "调用方项目名", contextId: "可选的会话 ID" } }, null, 2)} mono />{selected.target.kind === "workflow" && <ReadonlyEvidence label="持续监听 · 必须循环" value="保存启动回执中的 invocation.id、runId 与 monitor.initialCursor；循环调用 wait_workflow_progress，每次使用 nextCursor 继续。terminal=false 不得结束当前回合，terminal=true 才交付；断线后用 resume_workflow_monitor(runId) 重挂。" />}<ReadonlyEvidence label="Loopback HTTP" value={`POST ${origin}/api/publications/${selected.id}/${externalPath}\nContent-Type: application/json\nX-Multi-Agent-Project: 调用方项目名\n\n{\"message\":\"在这里填写任务\"}`} mono /></DossierSection>
      <DossierSection number="03" title="A2A 入口"><ReadonlyEvidence label="JSON-RPC endpoint" value={`${origin}/a2a/${selected.id}`} mono /><ReadonlyEvidence label="Agent Card" value={`${origin}/a2a/${selected.id}/.well-known/agent-card.json`} mono /></DossierSection>
      <DossierSection number="04" title="Agent Card"><ReadonlyEvidence label="A2A v1 · read only" value={card ? JSON.stringify(card, null, 2) : "正在生成 Agent Card…"} mono /></DossierSection>
    </div>}</main>
    {createOpen && <Modal title="建立调用包" eyebrow="本机回环 · MCP / A2A" onClose={() => setCreateOpen(false)}><form className="modal-body compact-form" onSubmit={create}><fieldset className="daemon-write-surface" disabled={!daemonAvailable}><div className="safety-banner compact"><Stamp status="blocked" label="本机限定" /><p>v1 只允许本机回环访问，不包含公网认证。</p></div><Field label="Publication ID"><input required pattern="[a-z][a-z0-9-]*" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} /></Field><Field label="调用包名称"><input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="说明"><textarea required rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field><div className="form-grid two"><Field label="打包形态"><SelectControl ariaLabel="调用包打包形态" value={draft.kind} options={[{ value: "employee", label: "单 Agent", description: "调用一位员工" }, { value: "workflow", label: "多 Agent 团队", description: "调用一份协作编排" }]} onChange={(kind) => setDraft({ ...draft, kind: kind as "employee" | "workflow", targetId: "" })} /></Field><Field label="目标"><SelectControl ariaLabel="调用包目标" value={draft.targetId} invalid={Boolean(targetError)} errorMessage={targetError} options={targetOptions} onChange={(targetId) => setDraft({ ...draft, targetId })} /></Field></div></fieldset><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setCreateOpen(false)}>取消</button><button className="button primary" disabled={!daemonAvailable || !draft.targetId}>建立调用包</button></div></form></Modal>}
    {archiveOpen && selected && <Modal title="归档 A2A 入口" eyebrow={`${selected.id} · 保留目标`} onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>Agent Card 与调用入口将停止工作。</b><p>目标 Employee/Workflow 及已有 Run 不受影响。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveOpen(false)}>取消</button><button className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive()}>确认归档</button></div></div></Modal>}
  </div>;
}
