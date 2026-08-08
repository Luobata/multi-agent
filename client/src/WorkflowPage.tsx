import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArchitectureTemplatePicker } from "./ArchitectureTemplatePicker";
import { api, writeBody } from "./api";
import { DossierSection, EmployeeAvatar, EmptyState, Field, Modal, SelectControl, Stamp, UtilityIcon, formatTime, scrollRecordIntoView, useDaemonAvailable } from "./components";
import { layoutTopology } from "./topology";
import { automaticCanvasPositions, WorkflowCanvas, type CanvasPositions } from "./WorkflowCanvas";
import { ManagementPolicyPage } from "./ManagementPolicyPage";
import { EntrancePolicyPage } from "./EntrancePolicyPage";
import { SupervisorWorkflowPage } from "./SupervisorWorkflowPage";
import { WorkflowChangePage } from "./WorkflowChangePage";
import { WorkflowSessionGuide } from "./WorkflowSessionGuide";
import { activeWorkflowPublications, buildWorkflowSessionPrompts } from "./workflowSessionPrompts";
import type { Bootstrap, Employee, GraphWorkflow, InstantiatedArchitectureTemplate, InvocationRecord, JsonObject, Workflow, WorkflowNode } from "./types";

interface PageProps {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
}

interface NodeDraft {
  id: string;
  employeeId: string;
  needs: string[];
  withText: string;
}

interface WorkflowDraft {
  id: string;
  description: string;
  patternId?: string;
  nodes: NodeDraft[];
  positions: CanvasPositions;
  maxConcurrency: number;
  failFast: boolean;
  inputSchema: string;
}

function parseObject(value: string, label: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 对象`);
  return parsed as JsonObject;
}

function nodeDraft(node: WorkflowNode): NodeDraft {
  return { id: node.id, employeeId: node.employeeId, needs: [...node.needs], withText: JSON.stringify(node.with, null, 2) };
}

/** Receipt returned by POST /api/workflows/:id/start (HTTP 202); the workflow itself keeps running asynchronously. */
interface WorkflowStartReceipt {
  invocation: InvocationRecord;
  runId: string;
  statusUrl: string;
  streamUrl: string;
}

function workflowDraft(workflow?: GraphWorkflow, employees: Employee[] = []): WorkflowDraft {
  const initialNodes: WorkflowNode[] = workflow?.nodes ?? [{ id: "step-1", employeeId: employees.find((item) => item.status === "active")?.id ?? "", needs: [], with: {} }];
  return {
    id: workflow?.id ?? "",
    description: workflow?.description ?? "",
    patternId: workflow?.patternId,
    nodes: initialNodes.map(nodeDraft),
    positions: workflow?.presentation?.positions ?? automaticCanvasPositions(initialNodes),
    maxConcurrency: workflow?.maxConcurrency ?? 4,
    failFast: workflow?.failFast ?? false,
    inputSchema: JSON.stringify(workflow?.inputSchema ?? {}, null, 2)
  };
}

function draftNodes(draft: WorkflowDraft): WorkflowNode[] {
  return draft.nodes.map((node) => ({
    id: node.id.trim(),
    employeeId: node.employeeId,
    needs: node.needs,
    with: parseObject(node.withText || "{}", `节点 ${node.id} 的 with`)
  }));
}

function Topology({ nodes, employees }: { nodes: WorkflowNode[]; employees: Employee[] }) {
  const layout = useMemo(() => layoutTopology(nodes), [nodes]);
  if (nodes.length === 0) return <div className="topology-empty">尚无节点。</div>;
  return <div className="topology-scroll"><svg className="topology" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Workflow 依赖拓扑">
    <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path className="topology-arrow" d="M0,0 L8,4 L0,8 Z" /></marker></defs>
    {layout.edges.map((edge) => { const startX = edge.from.x + 168; const startY = edge.from.y + 35; const endX = edge.to.x; const endY = edge.to.y + 35; const bend = (startX + endX) / 2; return <path className="topology-edge" key={`${edge.from.id}-${edge.to.id}`} d={`M${startX} ${startY} H${bend} V${endY} H${endX}`} markerEnd="url(#arrow)" />; })}
    {layout.nodes.map((node) => { const employee = employees.find((item) => item.id === node.employeeId); return <g className="topology-node" key={node.id} transform={`translate(${node.x} ${node.y})`}><rect width="168" height="70" /><text x="14" y="22" className="topology-id">{node.id}</text><text x="14" y="45" className="topology-name">{employee?.identity.displayName ?? node.employeeId}</text><text x="150" y="45" textAnchor="end" className="topology-version">v{node.employeeVersion ?? employee?.version ?? "—"}</text></g>; })}
    {layout.cyclic && <text x="28" y={layout.height - 18} className="topology-warning">检测到循环依赖；保存前必须修正</text>}
  </svg></div>;
}

function WorkflowEditor({ workflow, data, onClose, onSaved, notify }: {
  workflow?: GraphWorkflow;
  data: Bootstrap;
  onClose: () => void;
  onSaved: (workflow: GraphWorkflow) => void;
  notify: PageProps["notify"];
}) {
  const [draft, setDraft] = useState(() => workflowDraft(workflow, data.employees));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const daemonAvailable = useDaemonAvailable();
  const activeEmployees = data.employees.filter((item) => item.status === "active");
  let previewNodes: WorkflowNode[];
  try { previewNodes = draftNodes(draft); }
  catch { previewNodes = draft.nodes.map((node) => ({ id: node.id.trim(), employeeId: node.employeeId, needs: node.needs, with: {} })); }
  const topology = layoutTopology(previewNodes);
  const duplicateIds = previewNodes.filter((node, index) => previewNodes.findIndex((candidate) => candidate.id === node.id) !== index).map((node) => node.id);
  const missingDependencies = previewNodes.flatMap((node) => node.needs.filter((need) => !previewNodes.some((candidate) => candidate.id === need)));
  const unassignedNodes = previewNodes.filter((node) => !node.employeeId).map((node) => node.id || "未命名节点");
  const graphIssues = [...new Set([
    ...(duplicateIds.length ? [`重复节点：${duplicateIds.join(", ")}`] : []),
    ...(missingDependencies.length ? [`未知依赖：${missingDependencies.join(", ")}`] : []),
    ...(unassignedNodes.length ? [`未分派员工：${unassignedNodes.join(", ")}`] : []),
    ...(topology.cyclic ? ["存在循环依赖"] : [])
  ])];
  const selectedNode = draft.nodes[selectedIndex] ?? draft.nodes[0];

  const setNode = (index: number, patch: Partial<NodeDraft>) => setDraft((current) => ({ ...current, nodes: current.nodes.map((node, nodeIndex) => nodeIndex === index ? { ...node, ...patch } : node) }));
  const renameNode = (index: number, id: string) => setDraft((current) => {
    const oldId = current.nodes[index]?.id ?? "";
    const positions = { ...current.positions };
    if (oldId !== id && positions[oldId]) { positions[id] = positions[oldId]; delete positions[oldId]; }
    return { ...current, positions, nodes: current.nodes.map((node, nodeIndex) => ({ ...node, id: nodeIndex === index ? id : node.id, needs: node.needs.map((need) => need === oldId ? id : need) })) };
  });
  const addNode = () => {
    const used = new Set(draft.nodes.map((node) => node.id));
    let count = draft.nodes.length + 1;
    while (used.has(`step-${count}`)) count += 1;
    const id = `step-${count}`;
    setDraft((current) => ({ ...current, nodes: [...current.nodes, { id, employeeId: activeEmployees[0]?.id ?? "", needs: [], withText: "{}" }], positions: { ...current.positions, [id]: { x: 32 + (current.nodes.length % 3) * 220, y: 48 + Math.floor(current.nodes.length / 3) * 120 } } }));
    setSelectedIndex(draft.nodes.length);
  };
  const removeNode = (index: number) => setDraft((current) => {
    const id = current.nodes[index]?.id;
    const positions = { ...current.positions }; if (id) delete positions[id];
    return { ...current, positions, nodes: current.nodes.filter((_, nodeIndex) => nodeIndex !== index).map((node) => ({ ...node, needs: node.needs.filter((need) => need !== id) })) };
  });
  const applyTemplate = (value: InstantiatedArchitectureTemplate) => {
    setDraft((current) => ({ ...current, patternId: value.patternId, description: current.description.trim() && workflow ? current.description : value.description, nodes: value.nodes.map(nodeDraft), positions: automaticCanvasPositions(value.nodes), maxConcurrency: value.maxConcurrency, failFast: value.failFast }));
    setSelectedIndex(0);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = { id: draft.id.trim(), description: draft.description.trim(), patternId: draft.patternId, nodes: draftNodes(draft), presentation: { positions: draft.positions }, maxConcurrency: Number(draft.maxConcurrency), failFast: draft.failFast, inputSchema: parseObject(draft.inputSchema || "{}", "Input Schema") };
      const saved = workflow ? await api<GraphWorkflow>(`/api/workflows/${workflow.id}`, writeBody(payload, "PATCH")) : await api<GraphWorkflow>("/api/workflows", writeBody(payload));
      notify(workflow ? `协作编排已另存为 v${saved.version}` : `协作编排 ${saved.id} 已建立`);
      onSaved(saved);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setSaving(false); }
  };

  return <Modal title={workflow ? `修订 ${workflow.id}` : "建立协作编排"} eyebrow="TEMPLATE → DRAFT → VALIDATE" onClose={onClose} wide>
    <form className="editor-form workflow-editor-v2" onSubmit={submit}>
      <fieldset className="daemon-write-surface" disabled={!daemonAvailable}>
        <details className="architecture-template-section" open={!workflow}><summary><span><b>01</b>选择常用架构并映射员工</span><small>{draft.patternId ? data.architectureTemplates.find((template) => template.id === draft.patternId)?.displayName ?? draft.patternId : "空白 Graph"}</small></summary><ArchitectureTemplatePicker templates={data.architectureTemplates} employees={data.employees} currentPatternId={draft.patternId} onApply={applyTemplate} notify={notify} /></details>
        <section className="workflow-basics"><div className="section-kicker"><b>02</b><span>定义编排</span></div><div className="form-grid workflow-basics-grid"><Field label="Workflow ID"><input required pattern="[a-z][a-z0-9-]*" disabled={Boolean(workflow)} value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></Field><Field label="说明"><input required value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field><Field label="并发上限"><input type="number" min={1} max={32} value={draft.maxConcurrency} onChange={(event) => setDraft({ ...draft, maxConcurrency: Number(event.target.value) })} /></Field></div><label className="check-line"><input type="checkbox" checked={draft.failFast} onChange={(event) => setDraft({ ...draft, failFast: event.target.checked })} />技术故障后停止调度未开始节点（failFast）</label></section>
        <section className="workflow-builder"><header className="workflow-builder-toolbar"><div><p className="record-meta">03 / VISUAL COMPOSER</p><h3>拖动画布</h3></div><div className="canvas-actions"><button type="button" className="button ghost" onClick={() => setDraft({ ...draft, positions: automaticCanvasPositions(previewNodes) })}>自动排版</button><button type="button" className="button secondary" onClick={addNode}><UtilityIcon name="add" />添加节点</button></div></header>
          <div className="workflow-builder-grid"><div className="canvas-column"><div className="canvas-status"><span>拖动只调整展示位置；依赖关系在右侧检查器修改。</span><Stamp status={graphIssues.length ? "blocked" : "passed"} label={graphIssues.length ? `${graphIssues.length} 项待修正` : "草稿通过预检"} /></div><WorkflowCanvas nodes={previewNodes} employees={data.employees} positions={draft.positions} selectedId={selectedNode?.id} onSelect={(nodeId) => setSelectedIndex(Math.max(0, draft.nodes.findIndex((node) => node.id === nodeId)))} onPositionsChange={(positions) => setDraft((current) => ({ ...current, positions }))} />{graphIssues.length > 0 && <div className="canvas-issues" role="alert">{graphIssues.map((issue) => <span key={issue}>{issue}</span>)}</div>}</div>
            <aside className="node-inspector">{selectedNode ? <><header><div><p className="record-meta">NODE INSPECTOR</p><h4>{selectedNode.id || "未命名节点"}</h4></div><button type="button" className="text-button danger-text" disabled={draft.nodes.length === 1} onClick={() => { removeNode(selectedIndex); setSelectedIndex(Math.max(0, selectedIndex - 1)); }}>移除</button></header><Field label="Node ID"><input required pattern="[a-z][a-z0-9-]*" value={selectedNode.id} onChange={(event) => renameNode(selectedIndex, event.target.value)} /></Field><Field label="Employee"><SelectControl ariaLabel={`${selectedNode.id || "当前节点"}分派员工`} value={selectedNode.employeeId} invalid={!selectedNode.employeeId} errorMessage={!selectedNode.employeeId ? "请为节点分派一位员工。" : undefined} options={[{ value: "", label: activeEmployees.length ? "选择在册员工" : "暂无在册员工", description: activeEmployees.length ? "节点必须分派一位员工" : "请先建立或恢复员工档案", disabled: activeEmployees.length === 0 }, ...activeEmployees.map((employee) => ({ value: employee.id, label: employee.identity.displayName, description: `${employee.providerId} · v${employee.version}` }))]} onChange={(employeeId) => setNode(selectedIndex, { employeeId })} /></Field><fieldset className="dependency-checks"><legend>依赖节点</legend>{draft.nodes.map((candidate, candidateIndex) => candidateIndex === selectedIndex ? null : <label key={`${candidate.id}-${candidateIndex}`}><input type="checkbox" checked={selectedNode.needs.includes(candidate.id)} onChange={(event) => setNode(selectedIndex, { needs: event.target.checked ? [...selectedNode.needs, candidate.id] : selectedNode.needs.filter((need) => need !== candidate.id) })} /><span><b>{candidate.id || "未命名"}</b><small>{candidate.employeeId}</small></span></label>)}{draft.nodes.length === 1 && <span className="muted">只有一个节点，无上游依赖。</span>}</fieldset><Field label="with (JSON)"><textarea className="mono" rows={7} value={selectedNode.withText} onChange={(event) => setNode(selectedIndex, { withText: event.target.value })} /></Field></> : <div className="mini-empty">选择一个节点开始编辑。</div>}</aside>
          </div>
        </section>
        <section className="workflow-contract"><div className="section-kicker"><b>04</b><span>输入契约</span></div><Field label="Input JSON Schema"><textarea className="mono" rows={6} value={draft.inputSchema} onChange={(event) => setDraft({ ...draft, inputSchema: event.target.value })} /></Field></section>
      </fieldset>
      <div className="editor-savebar"><span className="editor-save-note">保存时由 TypeScript Graph 核心再次校验依赖、环路与员工版本。</span><button type="button" className="button secondary" onClick={onClose}>放弃修改</button><button className="button primary" disabled={saving || !daemonAvailable || graphIssues.length > 0}>{saving ? "校验中…" : workflow ? `校验并另存为 v${workflow.version + 1}` : "校验并建立"}</button></div>
    </form>
  </Modal>;
}

function GraphWorkflowPage({ data, refresh, notify }: PageProps) {
  const daemonAvailable = useDaemonAvailable();
  const visible = data.workflows.filter((workflow): workflow is GraphWorkflow => workflow.architecture === "graph");
  const [selectedId, setSelectedId] = useState(visible.find((item) => item.status === "active")?.id ?? visible[0]?.id ?? "");
  const selected = visible.find((item) => item.id === selectedId) ?? visible[0];
  const [versions, setVersions] = useState<GraphWorkflow[]>([]);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [runInput, setRunInput] = useState("{\n  \"message\": \"请完成这项协作任务\"\n}");
  const [running, setRunning] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const workflowPublications = useMemo(
    () => selected ? activeWorkflowPublications(selected.id, data.publications) : [],
    [data.publications, selected?.id]
  );
  const [publicationId, setPublicationId] = useState("");
  useEffect(() => { if (!selected) { setVersions([]); return; } api<{ versions: Workflow[] }>(`/api/workflows/${selected.id}`).then((detail) => setVersions(detail.versions.filter((version): version is GraphWorkflow => version.architecture === "graph"))).catch(() => setVersions([selected])); }, [selected?.id, selected?.version]);
  useEffect(() => {
    setPublicationId((current) => workflowPublications.some((publication) => publication.id === current)
      ? current
      : workflowPublications[0]?.id ?? "");
  }, [workflowPublications]);
  const selectedPublication = workflowPublications.find((publication) => publication.id === publicationId) ?? workflowPublications[0];
  const sessionPrompts = useMemo(
    () => selected ? buildWorkflowSessionPrompts(selected, selectedPublication) : undefined,
    [selected, selectedPublication]
  );

  const run = async () => {
    if (!selected) return; setRunning(true);
    try {
      const input = parseObject(runInput, "Workflow 输入");
      const receipt = await api<WorkflowStartReceipt>(`/api/workflows/${selected.id}/start`, { ...writeBody(input), headers: { "x-multi-agent-source": "workbench", "x-multi-agent-source-label": "编排调试台" } });
      notify(`运行工单已受理 · Run ${receipt.runId}（工单 ${receipt.invocation.id}）；进度可到运行卷宗或员工大厅继续观察`);
      await refresh();
    }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setRunning(false); }
  };
  const archive = async () => {
    if (!selected) return;
    try { await api(`/api/workflows/${selected.id}/archive`, writeBody({})); notify(`Workflow ${selected.id} 已归档`); setArchiveOpen(false); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const selectedTemplate = data.architectureTemplates.find((template) => template.id === selected?.patternId);

  return <div className="page-grid page-grid--workflows">
    <aside className="record-list"><header className="list-header"><h1>协作编排</h1><button className="square-action" disabled={!daemonAvailable} onClick={() => setEditor("new")} aria-label="新建 Workflow"><UtilityIcon name="add" /></button></header><div className="architecture-summary"><span>{data.architectureTemplates.length} 个常用模板</span><small>统一编译为 Graph</small></div><div className="record-scroll workflow-list">{visible.map((workflow) => { const template = data.architectureTemplates.find((candidate) => candidate.id === workflow.patternId); return <button className={`workflow-card ${selected?.id === workflow.id ? "selected" : ""}`} key={workflow.id} onClick={() => setSelectedId(workflow.id)}><div><strong>{workflow.id}</strong><span>{workflow.description}</span><small>{template?.displayName ?? "自定义 Graph"} · {workflow.nodes.length} 节点</small></div><Stamp status={workflow.status} /></button>; })}{visible.length === 0 && <div className="mini-empty">尚无协作编排。</div>}</div><footer className="list-footer"><span>{visible.length} 份编排</span><span>GRAPH v1</span></footer></aside>
    <main className="detail-pane">{!selected ? <EmptyState title="用常用架构建立第一份编排" action={<button className="button primary" disabled={!daemonAvailable} onClick={() => setEditor("new")}>选择架构模板</button>}>从顺序流水线、并行汇总、评审委员会或计划执行模板开始，映射员工后可在画布继续拖动和修改依赖。</EmptyState> : <div className="dossier workflow-dossier">
      <header className="dossier-cover"><div className="file-index"><span>GRAPH WORKFLOW RECORD</span><code>No. {selected.id.toUpperCase()}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">织</div><div><h2>{selected.id}</h2><p>{selected.description}</p></div><Stamp status={selected.status} /></div><div className="dossier-actions"><button className="button primary" disabled={!daemonAvailable || running || selected.status === "archived"} onClick={() => scrollRecordIntoView("run-workflow")}>运行编排</button><button className="button secondary" disabled={!daemonAvailable} onClick={() => setEditor("edit")}>可视化修订</button><button className="button danger" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setArchiveOpen(true)}>归档</button></div></header>
      <DossierSection number="01" title="执行政策"><dl className="ledger horizontal"><dt>Runtime</dt><dd><code>{selected.architecture}</code></dd><dt>模式模板</dt><dd>{selectedTemplate?.displayName ?? "自定义 Graph"}</dd><dt>并发上限</dt><dd>{selected.maxConcurrency}</dd><dt>故障策略</dt><dd>{selected.failFast ? "fail fast" : "保留独立证据后继续"}</dd></dl></DossierSection>
      <DossierSection number="02" title="节点清册"><div className="node-ledger">{selected.nodes.map((node, index) => { const employee = data.employees.find((item) => item.id === node.employeeId); return <article key={node.id}><span className="node-number">{String(index + 1).padStart(2, "0")}</span><EmployeeAvatar className="small" displayName={employee?.identity.displayName ?? node.employeeId} presentation={employee?.presentation} /><div><strong>{node.id}</strong><span>{employee?.identity.displayName ?? node.employeeId} · v{node.employeeVersion ?? employee?.version ?? "—"}</span></div><code>{node.needs.length ? `← ${node.needs.join(", ")}` : "并行起点"}</code></article>; })}</div></DossierSection>
      <DossierSection number="03" title="依赖拓扑"><Topology nodes={selected.nodes} employees={data.employees} /></DossierSection>
      <DossierSection number="04" title="版本"><div className="version-strip">{versions.map((version) => <div key={version.version} className={version.version === selected.version ? "current" : ""}><code>v{version.version}</code><span>{version.version === selected.version ? "当前" : version.status === "archived" ? "归档" : "历史"}</span><time>{formatTime(version.updatedAt)}</time></div>)}</div></DossierSection>
      {sessionPrompts && <DossierSection
        number="05"
        title="其他会话使用"
        action={<Stamp
          status={selected.status === "archived" ? "archived" : selectedPublication ? "active" : "pending"}
          label={selected.status === "archived" ? "历史示例" : selectedPublication ? "稳定调用包" : "调试入口"}
        />}
      >
        <div className={`workflow-session-route workflow-session-route--${sessionPrompts.mode}`}>
          <div className="workflow-session-route-copy">
            <span>{sessionPrompts.mode === "publication" ? "PUBLICATION → MCP" : "WORKFLOW → MCP"}</span>
            <strong>{selectedPublication?.name ?? selected.id}</strong>
            <p>{selected.status === "archived"
              ? "此编排已归档，以下内容仅供历史参考，当前不可调用。"
              : selectedPublication
                ? <>其他会话使用 Publication ID <code>{selectedPublication.id}</code>，无需了解内部节点与 Prompt。</>
                : "尚未建立活动调用包；以下示例使用 run_workflow 直接调试该编排。"}</p>
          </div>
          {workflowPublications.length > 1
            ? <label className="workflow-publication-select"><span>选择调用包</span><SelectControl ariaLabel="选择 Workflow 调用包" value={selectedPublication?.id ?? ""} options={workflowPublications.map((publication) => ({ value: publication.id, label: publication.name, description: `${publication.id} · v${publication.version}` }))} onChange={setPublicationId} /></label>
            : !selectedPublication && <a className="text-button workflow-publication-link" href="#publications">前往调用包建立稳定入口</a>}
        </div>
        <WorkflowSessionGuide prompts={sessionPrompts} />
      </DossierSection>}
      <section id="run-workflow" className="run-order"><header><div><p className="record-meta">{selected.id} · v{selected.version}</p><h3>签发运行工单</h3></div><Stamp status={running ? "running" : "pending"} label={running ? "提交回执" : "待签发"} /></header><Field label="Workflow 输入 (JSON)"><textarea className="mono" rows={8} disabled={!daemonAvailable} value={runInput} onChange={(event) => setRunInput(event.target.value)} /></Field><div className="run-actions"><span>签发后立即返回受理回执，不等待运行完成；输入、计划、节点 Prompt 与状态事件保存在运行卷宗，也可到员工大厅实时观察。</span><button className="button primary" disabled={!daemonAvailable || running || selected.status === "archived"} onClick={() => void run()}>{running ? "提交回执…" : "签发并运行"}</button></div></section>
    </div>}</main>
    {editor && <WorkflowEditor workflow={editor === "edit" ? selected : undefined} data={data} notify={notify} onClose={() => setEditor(null)} onSaved={async (saved) => { setEditor(null); setSelectedId(saved.id); await refresh(); }} />}
    {archiveOpen && selected && <Modal title="归档协作编排" eyebrow={`${selected.id} · 保留历史`} onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>历史版本与 Run 证据会继续保留。</b><p>归档后不能发起新的运行；已存在的档案与节点输出仍可查阅。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveOpen(false)}>取消</button><button className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive()}>确认归档</button></div></div></Modal>}
  </div>;
}

export function WorkflowPage(props: PageProps) {
  const [section, setSection] = useState<"entrance" | "graph" | "supervisor" | "policies" | "gate-changes">("supervisor");
  const graphCount = props.data.workflows.filter((workflow) => workflow.architecture === "graph").length;
  const supervisorCount = props.data.workflows.filter((workflow) => workflow.architecture === "supervisor").length;
  const policyCount = props.data.managementPolicies?.length ?? 0;
  const entranceCount = props.data.entrancePolicies?.length ?? 0;
  const gateChangeCount = props.data.workflowChanges?.length ?? 0;
  return <div className="orchestration-workspace">
    <header className="orchestration-switcher" aria-label="协作编排类型">
      <div><span>WORKFLOW CONTROL PLANE</span><strong>默认继续讨论；明确交给员工或启动协作编排后，才创建工单与运行</strong></div>
      <nav>
        <button type="button" className={section === "entrance" ? "active" : ""} aria-pressed={section === "entrance"} onClick={() => setSection("entrance")}>开始一项工作 <small>{entranceCount}</small></button>
        <button type="button" className={section === "graph" ? "active" : ""} aria-pressed={section === "graph"} onClick={() => setSection("graph")}>Graph 编排 <small>{graphCount}</small></button>
        <button type="button" className={section === "supervisor" ? "active" : ""} aria-pressed={section === "supervisor"} onClick={() => setSection("supervisor")}>协作编排 <small>{supervisorCount}</small></button>
        <button type="button" className={section === "policies" ? "active" : ""} aria-pressed={section === "policies"} onClick={() => setSection("policies")}>管理策略库 <small>{policyCount}</small></button>
        <button type="button" className={section === "gate-changes" ? "active" : ""} aria-pressed={section === "gate-changes"} onClick={() => setSection("gate-changes")}>门禁变更 <small>{gateChangeCount}</small></button>
      </nav>
    </header>
    {section === "entrance" && <EntrancePolicyPage {...props} />}
    {section === "graph" && <GraphWorkflowPage {...props} />}
    {section === "supervisor" && <SupervisorWorkflowPage {...props} />}
    {section === "policies" && <ManagementPolicyPage {...props} />}
    {section === "gate-changes" && <WorkflowChangePage data={props.data} />}
  </div>;
}
