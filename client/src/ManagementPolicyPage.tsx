import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, writeBody } from "./api";
import { DossierSection, EmptyState, Field, Modal, SelectControl, Stamp, UtilityIcon, formatTime, useDaemonAvailable } from "./components";
import type { Bootstrap, ManagementPolicy, SupervisorWorkflow } from "./types";

interface PageProps {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
}

interface PolicyDraft {
  id: string;
  displayName: string;
  description: string;
  allowedRoleIds: string;
  instructions: string;
  maxRounds: number;
  maxDelegations: number;
  maxParallelDelegations: number;
  maxDurationSeconds: number;
  workerFailure: "observe-and-replan" | "fail-fast";
  requireDelegation: boolean;
  requireAllDelegationsSuccessful: boolean;
}

function policyDraft(policy?: ManagementPolicy): PolicyDraft {
  return {
    id: policy?.id ?? "",
    displayName: policy?.displayName ?? "",
    description: policy?.description ?? "",
    allowedRoleIds: policy?.allowedRoleIds.join(", ") ?? "researcher, developer, reviewer",
    instructions: policy?.instructions ?? "根据任务与已有证据分派合适的成员；证据充分后给出最终结论。",
    maxRounds: policy?.limits.maxRounds ?? 6,
    maxDelegations: policy?.limits.maxDelegations ?? 12,
    maxParallelDelegations: policy?.limits.maxParallelDelegations ?? 3,
    maxDurationSeconds: Math.round((policy?.limits.maxDurationMs ?? 600_000) / 1000),
    workerFailure: policy?.failure.workerFailure ?? "observe-and-replan",
    requireDelegation: policy?.completion.requireDelegation ?? false,
    requireAllDelegationsSuccessful: policy?.completion.requireAllDelegationsSuccessful ?? false
  };
}

function PolicyEditor({ policy, onClose, onSaved, notify }: {
  policy?: ManagementPolicy;
  onClose: () => void;
  onSaved: (policy: ManagementPolicy) => void;
  notify: PageProps["notify"];
}) {
  const daemonAvailable = useDaemonAvailable();
  const [draft, setDraft] = useState(() => policyDraft(policy));
  const [saving, setSaving] = useState(false);
  const parsedRoleIds = [...new Set(draft.allowedRoleIds.split(",").map((value) => value.trim()).filter(Boolean))];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        id: draft.id.trim(),
        displayName: draft.displayName.trim(),
        description: draft.description.trim(),
        allowedRoleIds: [...new Set(draft.allowedRoleIds.split(",").map((value) => value.trim()).filter(Boolean))],
        instructions: draft.instructions.trim(),
        limits: {
          maxRounds: Number(draft.maxRounds),
          maxDelegations: Number(draft.maxDelegations),
          maxParallelDelegations: Number(draft.maxParallelDelegations),
          maxDurationMs: Number(draft.maxDurationSeconds) * 1000
        },
        failure: { workerFailure: draft.workerFailure },
        completion: {
          requireDelegation: draft.requireDelegation,
          requireAllDelegationsSuccessful: draft.requireAllDelegationsSuccessful
        }
      };
      const saved = policy
        ? await api<ManagementPolicy>(`/api/management-policies/${policy.id}`, writeBody(payload, "PATCH"))
        : await api<ManagementPolicy>("/api/management-policies", writeBody(payload));
      notify(policy ? `管理策略已另存为 v${saved.version}` : `管理策略 ${saved.id} 已登记`);
      onSaved(saved);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };
  return <Modal title={policy ? `修订 ${policy.displayName}` : "登记管理策略"} eyebrow="POLICY → VERSION → PIN" onClose={onClose} wide>
    <form className="editor-form policy-editor" onSubmit={submit}>
      <fieldset className="daemon-write-surface" disabled={!daemonAvailable}>
        <section className="workflow-basics"><div className="section-kicker"><b>01</b><span>策略身份</span></div><div className="form-grid workflow-basics-grid">
          <Field label="Policy ID"><input required pattern="[a-z][a-z0-9-]*" disabled={Boolean(policy)} value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></Field>
          <Field label="显示名"><input required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
          <Field label="说明"><input required value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field>
        </div></section>
        <section className="workflow-contract"><div className="section-kicker"><b>02</b><span>领队规则</span></div>
          <Field label="允许派单的角色槽（英文逗号分隔）"><input required value={draft.allowedRoleIds} onChange={(event) => setDraft({ ...draft, allowedRoleIds: event.target.value })} /></Field>
          <div className="policy-role-chips policy-role-preview" aria-label="角色槽解析预览">{parsedRoleIds.map((roleId) => <code key={roleId}>{roleId}</code>)}</div>
          <Field label="管理指引"><textarea required rows={7} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></Field>
        </section>
        <section className="workflow-contract"><div className="section-kicker"><b>03</b><span>硬限制</span></div><div className="form-grid policy-limit-grid">
          <Field label="最多轮次"><input type="number" min={1} max={32} value={draft.maxRounds} onChange={(event) => setDraft({ ...draft, maxRounds: Number(event.target.value) })} /></Field>
          <Field label="最多派单"><input type="number" min={1} max={256} value={draft.maxDelegations} onChange={(event) => setDraft({ ...draft, maxDelegations: Number(event.target.value) })} /></Field>
          <Field label="单轮并行"><input type="number" min={1} max={32} value={draft.maxParallelDelegations} onChange={(event) => setDraft({ ...draft, maxParallelDelegations: Number(event.target.value) })} /></Field>
          <Field label="最长秒数"><input type="number" min={1} max={86400} value={draft.maxDurationSeconds} onChange={(event) => setDraft({ ...draft, maxDurationSeconds: Number(event.target.value) })} /></Field>
          <Field label="成员技术失败"><SelectControl ariaLabel="选择成员技术失败处理方式" value={draft.workerFailure} options={[{ value: "observe-and-replan", label: "交给领队观察并重规划", description: "保留失败证据，由领队决定是否重派或调整计划" }, { value: "fail-fast", label: "立即技术失败", description: "成员失败后不再继续创建新的工作" }]} onChange={(workerFailure) => setDraft({ ...draft, workerFailure: workerFailure as PolicyDraft["workerFailure"] })} /></Field>
        </div><label className="check-line"><input type="checkbox" checked={draft.requireDelegation} onChange={(event) => setDraft({ ...draft, requireDelegation: event.target.checked })} />结束前至少派单一次</label><label className="check-line"><input type="checkbox" checked={draft.requireAllDelegationsSuccessful} onChange={(event) => setDraft({ ...draft, requireAllDelegationsSuccessful: event.target.checked })} />所有派单必须技术成功才能结束</label></section>
      </fieldset>
      <div className="editor-savebar"><span className="editor-save-note">修改会创建新版本；已有领队团队继续固定旧版本。</span><button type="button" className="button secondary" onClick={onClose}>放弃修改</button><button className="button primary" disabled={!daemonAvailable || saving}>{saving ? "保存中…" : policy ? `另存为 v${policy.version + 1}` : "登记策略"}</button></div>
    </form>
  </Modal>;
}

export function ManagementPolicyPage({ data, refresh, notify }: PageProps) {
  const daemonAvailable = useDaemonAvailable();
  const policies = data.managementPolicies ?? [];
  const [selectedId, setSelectedId] = useState(policies.find((policy) => policy.status === "active")?.id ?? policies[0]?.id ?? "");
  const selected = policies.find((policy) => policy.id === selectedId) ?? policies[0];
  const [versions, setVersions] = useState<ManagementPolicy[]>([]);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  useEffect(() => {
    if (!selected) { setVersions([]); return; }
    api<{ versions: ManagementPolicy[] }>(`/api/management-policies/${selected.id}`)
      .then((detail) => setVersions(detail.versions))
      .catch(() => setVersions([selected]));
  }, [selected?.id, selected?.version]);
  const references = useMemo(() => data.workflows.filter(
    (workflow): workflow is SupervisorWorkflow => workflow.architecture === "supervisor" && workflow.managementPolicy.id === selected?.id
  ), [data.workflows, selected?.id]);
  const archive = async () => {
    if (!selected) return;
    try {
      await api(`/api/management-policies/${selected.id}/archive`, writeBody({}));
      notify(`管理策略 ${selected.id} 已归档`);
      setArchiveOpen(false);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const restore = async () => {
    if (!selected) return;
    try {
      await api(`/api/management-policies/${selected.id}/restore`, writeBody({}));
      notify(`管理策略 ${selected.id} 已恢复`);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  return <div className="page-grid page-grid--workflows">
    <aside className="record-list"><header className="list-header"><h1>管理策略库</h1><button className="square-action" disabled={!daemonAvailable} onClick={() => setEditor("new")} aria-label="登记管理策略"><UtilityIcon name="add" /></button></header><div className="architecture-summary"><span>{policies.filter((policy) => policy.status === "active").length} 条活动策略</span><small>资源 · 不是 Architecture</small></div><div className="record-scroll workflow-list">{policies.map((policy) => <button className={`workflow-card ${selected?.id === policy.id ? "selected" : ""}`} key={policy.id} onClick={() => setSelectedId(policy.id)}><div><strong>{policy.displayName}</strong><span>{policy.description}</span><small>{policy.id} · v{policy.version} · {policy.allowedRoleIds.length} 个角色槽</small></div><Stamp status={policy.status} /></button>)}{policies.length === 0 && <div className="mini-empty">尚无管理策略。</div>}</div><footer className="list-footer"><span>{policies.length} 条策略</span><span>VERSION PINNED</span></footer></aside>
    <main className="detail-pane">{!selected ? <EmptyState title="建立第一条管理策略" action={<button className="button primary" disabled={!daemonAvailable} onClick={() => setEditor("new")}>登记策略</button>}>策略定义领队能派谁、最多运行几轮以及失败和结束条件；它本身不能运行或发布。</EmptyState> : <div className="dossier workflow-dossier">
      <header className="dossier-cover"><div className="file-index"><span>MANAGEMENT POLICY RECORD</span><code>No. {selected.id.toUpperCase()}</code></div><div className="dossier-title-row"><div className="workflow-mark" aria-hidden="true">策</div><div><h2>{selected.displayName}</h2><p>{selected.description}</p></div><Stamp status={selected.status} /></div><div className="dossier-actions"><button className="button primary" disabled={!daemonAvailable || selected.status === "archived"} onClick={() => setEditor("edit")}>修订策略</button>{selected.status === "active" ? <button className="button danger" disabled={!daemonAvailable} onClick={() => setArchiveOpen(true)}>归档</button> : <button className="button secondary" disabled={!daemonAvailable} onClick={() => void restore()}>恢复并创建 v{selected.version + 1}</button>}</div></header>
      <DossierSection number="01" title="硬限制"><dl className="ledger horizontal"><dt>最多轮次</dt><dd>{selected.limits.maxRounds}</dd><dt>最多派单</dt><dd>{selected.limits.maxDelegations}</dd><dt>单轮并行</dt><dd>{selected.limits.maxParallelDelegations}</dd><dt>最长时间</dt><dd>{Math.round(selected.limits.maxDurationMs / 1000)} 秒</dd><dt>成员失败</dt><dd>{selected.failure.workerFailure}</dd></dl></DossierSection>
      <DossierSection number="02" title="允许角色与管理指引"><div className="policy-role-chips">{selected.allowedRoleIds.map((roleId) => <code key={roleId}>{roleId}</code>)}</div><pre className="result-json policy-instructions">{selected.instructions}</pre></DossierSection>
      <DossierSection number="03" title="引用关系"><div className="node-ledger">{references.map((workflow, index) => <article key={workflow.id}><span className="node-number">{String(index + 1).padStart(2, "0")}</span><div><strong>{workflow.id}</strong><span>领队团队 v{workflow.version}</span></div><code>固定策略 v{workflow.managementPolicy.version}</code></article>)}{references.length === 0 && <div className="mini-empty">当前没有 Workflow 引用这条策略。</div>}</div></DossierSection>
      <DossierSection number="04" title="版本"><div className="version-strip">{versions.map((version) => <div key={version.version} className={version.version === selected.version ? "current" : ""}><code>v{version.version}</code><span>{version.version === selected.version ? "当前" : version.status === "archived" ? "归档" : "历史"}</span><time>{formatTime(version.updatedAt)}</time></div>)}</div></DossierSection>
    </div>}</main>
    {editor && <PolicyEditor policy={editor === "edit" ? selected : undefined} notify={notify} onClose={() => setEditor(null)} onSaved={async (saved) => { setEditor(null); setSelectedId(saved.id); await refresh(); }} />}
    {archiveOpen && selected && <Modal title="归档管理策略" eyebrow={`${selected.id} · 引用检查`} onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>活动领队团队会阻止归档。</b><p>请先归档引用它的 Workflow；历史版本和 Run 证据始终保留。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveOpen(false)}>取消</button><button className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive()}>确认归档</button></div></div></Modal>}
  </div>;
}
