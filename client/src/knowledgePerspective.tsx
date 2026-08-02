import { useState, type FormEvent } from "react";
import { api, writeBody } from "./api";
import { Field, SelectControl, Stamp, formatTime, useDaemonAvailable } from "./components";
import type {
  Employee,
  KnowledgeGrantReviewItem,
  KnowledgePerspective,
  KnowledgeProfileGrant,
  ProjectBinding
} from "./types";

export const PERSPECTIVE_STAGES = [
  { key: "eligible", label: "已授权 eligible", description: "知识 Profile 与规则允许进入候选的 Collection。" },
  { key: "activated", label: "当前任务 activated", description: "按本次任务上下文（项目、角色、标签、措辞）被激活的子集。" },
  { key: "selected", label: "实际 selected", description: "Router 在预算内最终缩小、会注入证据的 Collection。" }
] as const;

export function grantSourceCopy(source: KnowledgeProfileGrant["source"]): string {
  return source === "legacy" ? "历史遗留授权" : "显式授权";
}

export function grantScheduleCopy(grant: KnowledgeProfileGrant): string {
  if (grant.expiresAt) return `到期 ${formatTime(grant.expiresAt)}`;
  if (grant.reviewCycleDays) return `每 ${grant.reviewCycleDays} 天复核`;
  return "未排期复核";
}

function GrantLedger({ grants, emptyCopy }: { grants: KnowledgeProfileGrant[]; emptyCopy: string }) {
  if (!grants.length) return <p className="muted">{emptyCopy}</p>;
  return <div className="grant-ledger">
    {grants.map((grant) => <article key={grant.profileId}>
      <header><strong>{grant.profileId}</strong><span className={`grant-source grant-source--${grant.source}`}>{grantSourceCopy(grant.source)}</span></header>
      <dl>
        <dt>授权理由</dt><dd>{grant.reason}</dd>
        <dt>授权人</dt><dd>{grant.grantedBy}</dd>
        <dt>授权时间</dt><dd>{formatTime(grant.grantedAt)}</dd>
        <dt>复核安排</dt><dd>{grantScheduleCopy(grant)}</dd>
        {grant.lastReviewedAt && <><dt>最近复核</dt><dd>{formatTime(grant.lastReviewedAt)}</dd></>}
      </dl>
    </article>)}
  </div>;
}

export function KnowledgePerspectiveView({ perspective }: { perspective: KnowledgePerspective }) {
  const stageCount = { eligible: perspective.eligible.length, activated: perspective.activated.length, selected: perspective.selected.length };
  return <div className="perspective-view">
    <section className="perspective-grants">
      <header><span>GRANT LEDGER</span><h3>授权档案 · {perspective.employee.id} v{perspective.employee.version}</h3></header>
      <GrantLedger grants={perspective.employee.grants} emptyCopy="该员工没有授权元数据；knowledgeProfileIds 会在运行时被视为历史遗留授权。" />
    </section>
    <section className="perspective-stages">
      {PERSPECTIVE_STAGES.map((stage) => <article key={stage.key} className={`perspective-stage perspective-stage--${stage.key}`}>
        <header><strong>{stage.label}</strong><b>{stageCount[stage.key]}</b></header>
        <p>{stage.description}</p>
        <div className="perspective-stage-list">
          {stage.key === "selected"
            ? perspective.selected.map((item) => <div className="perspective-item" key={`${item.knowledgeBaseId}/${item.collectionId}/${item.ruleId}`}>
              <strong>{item.collectionName}</strong>
              <code>{item.knowledgeBaseId} · R{item.revision}</code>
              <small>Profile {item.profileId} · 规则 {item.ruleId} · {item.activation} · 优先级 {item.priority}</small>
              <small>{item.reason}</small>
              <small>预算 {item.budget.maxCollections} Collections · {item.budget.maxChunks} Chunks · {item.budget.maxTokens} Tokens</small>
            </div>)
            : perspective[stage.key].map((item) => <div className="perspective-item" key={`${stage.key}-${item.knowledgeBaseId}/${item.collection.id}`}>
              <strong>{item.collection.displayName}</strong>
              <code>{item.knowledgeBaseId} · {item.knowledgeBaseName} · R{item.revision}</code>
              {item.matches.map((match) => <small key={`${match.profileId}-${match.ruleId}`}>Profile {match.profileId} v{match.profileVersion} · 规则 {match.ruleId} · {match.activation}{match.required ? " · 预算冲突优先保留" : ""} · {match.reason}</small>)}
            </div>)}
          {stageCount[stage.key] === 0 && <div className="perspective-item perspective-item--empty">{stage.key === "eligible" ? "没有授权候选；检查知识 Profile 分配与规则范围。" : stage.key === "activated" ? "本次任务上下文没有激活任何 Collection。" : "Router 最终没有选择任何 Collection；不会注入知识证据。"}</div>}
        </div>
      </article>)}
    </section>
    {perspective.exclusions.length > 0 && <section className="perspective-exclusions">
      <header><span>EXCLUSIONS</span><h3>排除原因</h3></header>
      <ul>{perspective.exclusions.map((exclusion, index) => <li key={`${exclusion.profileId ?? exclusion.knowledgeBaseId ?? "all"}-${index}`}><code>{[exclusion.profileId, exclusion.knowledgeBaseId, exclusion.collectionId].filter(Boolean).join(" / ") || "—"}</code>{exclusion.reason}</li>)}</ul>
    </section>}
    <section className="perspective-evidence">
      <header><span>RECENT RUN EVIDENCE</span><h3>近期实际使用</h3><small>扫描 {perspective.evidenceWindow.scannedInstances} 个 Work Instance（上限 {perspective.evidenceWindow.limit}），{perspective.evidenceWindow.matchedRuns} 个 Run 含知识证据。</small></header>
      {perspective.recentEvidence.length ? <div className="perspective-evidence-list">{perspective.recentEvidence.map((usage) => <article key={`${usage.runId}-${usage.nodeId}`}>
        <header><code>{usage.runId}</code><span>{usage.nodeId} · {usage.status} · {formatTime(usage.at)}</span></header>
        <p>{usage.context.request}</p>
        <footer>{usage.evidence.length} 条证据{usage.evidence.slice(0, 3).map((evidence) => <code key={evidence.citationId}>{evidence.citationId}</code>)}</footer>
      </article>)}</div> : <p className="muted">近期 Run 中没有留存的知识证据；完成一次调用后这里会出现实际引用。</p>}
    </section>
  </div>;
}

export function KnowledgePerspectiveExplorer({ employee, bindings, notify }: {
  employee: Employee;
  bindings: ProjectBinding[];
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const daemonAvailable = useDaemonAvailable();
  const assignedRoles = bindings.flatMap((binding) => binding.roles
    .filter((role) => role.employeeId === employee.id)
    .map((role) => ({ value: `${binding.projectId}/${role.roleId}`, label: `${binding.projectId} / ${role.roleId}`, description: `员工 v${role.employeeVersion}` })));
  const [message, setMessage] = useState("这名员工处理当前职责相关任务时会看到哪些知识？");
  const [taskTags, setTaskTags] = useState("");
  const [roleSelection, setRoleSelection] = useState("");
  const [perspective, setPerspective] = useState<KnowledgePerspective>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const run = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const [projectId, projectRoleId] = roleSelection ? roleSelection.split("/") : [];
      setPerspective(await api<KnowledgePerspective>(`/api/employees/${employee.id}/knowledge-perspective`, writeBody({
        message,
        taskTags: taskTags.split(",").map((tag) => tag.trim()).filter(Boolean),
        projectId: projectId || undefined,
        projectRoleId: projectRoleId || undefined
      })));
    } catch (reason) {
      setPerspective(undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  return <div className="perspective-explorer">
    <p className="perspective-legend"><span>eligible 已授权候选</span><i>→</i><span>activated 当前任务激活</span><i>→</i><span>selected 实际入选并注入证据</span></p>
    <form className="perspective-form" onSubmit={run}>
      <Field label="模拟任务"><textarea rows={3} required disabled={!daemonAvailable || loading} value={message} onChange={(event) => setMessage(event.target.value)} /></Field>
      <div className="form-grid two">
        <Field label="项目角色上下文" hint="可选；只列出已任用这名员工的项目角色。">
          <SelectControl ariaLabel="项目角色上下文" value={roleSelection} disabled={!daemonAvailable || loading} options={[{ value: "", label: "不限定项目角色" }, ...assignedRoles]} onChange={setRoleSelection} />
        </Field>
        <Field label="任务标签" hint="逗号分隔；用于条件激活规则。">
          <input disabled={!daemonAvailable || loading} value={taskTags} onChange={(event) => setTaskTags(event.target.value)} />
        </Field>
      </div>
      <div className="perspective-form-actions">
        <button className="button primary" disabled={!daemonAvailable || loading || !message.trim()}>{loading ? "解析中…" : "生成知识视角"}</button>
      </div>
    </form>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {perspective && <KnowledgePerspectiveView perspective={perspective} />}
  </div>;
}

export function reviewSubjectLabel(item: KnowledgeGrantReviewItem): string {
  return item.subject.kind === "employee"
    ? `员工 ${item.subject.employeeId}`
    : `${item.subject.projectId}/${item.subject.roleId} · 员工 ${item.subject.employeeId}`;
}

export function reviewStatusCopy(status: KnowledgeGrantReviewItem["status"]): string {
  switch (status) {
    case "overdue": return "已逾期";
    case "due-soon": return "临近到期";
    case "current": return "复核期内";
    case "unscheduled": return "未排期";
  }
}

export function reviewStatusStamp(status: KnowledgeGrantReviewItem["status"]): { status: "blocked" | "pending" | "active" | "archived"; label: string } {
  switch (status) {
    case "overdue": return { status: "blocked", label: reviewStatusCopy(status) };
    case "due-soon": return { status: "pending", label: reviewStatusCopy(status) };
    case "current": return { status: "active", label: reviewStatusCopy(status) };
    case "unscheduled": return { status: "archived", label: reviewStatusCopy(status) };
  }
}

export function ReviewStamp({ status }: { status: KnowledgeGrantReviewItem["status"] }) {
  const stamp = reviewStatusStamp(status);
  return <Stamp status={stamp.status} label={stamp.label} />;
}
