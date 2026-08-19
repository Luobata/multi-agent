import { useEffect, useState, type FormEvent } from "react";
import { api, writeBody } from "../api";
import {
  Field,
  Modal,
  Stamp,
  formatTime,
  useDaemonAvailable
} from "../components";
import type {
  Bootstrap,
  KnowledgeChangeRequest,
  KnowledgeGrantReviewItem,
  KnowledgeGrantReviewLedger
} from "../types";
import {
  ReviewStamp,
  grantScheduleCopy,
  grantSourceCopy,
  reviewSubjectLabel
} from "../knowledgePerspective";
import type { PageProps } from "./editors";

export type ReviewActionMode = "retain" | "narrow" | "revoke";

const REVIEW_ACTION_COPY: Record<ReviewActionMode, { title: string; note: string; confirm: string }> = {
  retain: {
    title: "保留授权",
    note: "保留当前知识 Profile 授权并刷新授权理由与复核安排；原始授权时间 grantedAt 不会被改写。这里只生成待审批的 KnowledgeChangeRequest，批准后由 Core 校验版本并应用。",
    confirm: "生成保留提案"
  },
  narrow: {
    title: "收窄授权",
    note: "取消勾选要从授权中移除的知识 Profile。保留授权的到期时间、复核周期等元数据由后端原样保留，这里不修改；只生成待审批提案，不会直接修改员工档案或项目任用。",
    confirm: "生成收窄提案"
  },
  revoke: {
    title: "撤销授权",
    note: "把这条知识 Profile 从授权中移除，其余授权的到期时间、复核周期等元数据由后端原样保留，这里不修改。只生成待审批提案，人工批准后才会生效。",
    confirm: "生成撤销提案"
  }
};

interface ReviewSubjectResolution {
  profileIds: string[];
  expectedVersion?: number;
  problem?: string;
}

export function resolveReviewSubject(data: Bootstrap, item: KnowledgeGrantReviewItem): ReviewSubjectResolution {
  if (item.subject.kind === "employee") {
    const employee = data.employees.find((candidate) => candidate.id === item.subject.employeeId);
    if (!employee) return { profileIds: [], problem: `当前工作台没有员工 ${item.subject.employeeId} 的档案，无法安全构造提案。` };
    return { profileIds: [...(employee.knowledgeProfileIds ?? [])], expectedVersion: employee.version };
  }
  const binding = data.projectBindings.find((candidate) => candidate.projectId === item.subject.projectId);
  const role = binding?.roles.find((candidate) => candidate.roleId === item.subject.roleId);
  if (!binding || !role) return { profileIds: [], problem: `当前工作台没有 ${item.subject.projectId}/${item.subject.roleId} 的任用记录，无法安全构造提案。` };
  return { profileIds: [...(role.knowledgeProfileIds ?? [])], expectedVersion: binding.version };
}

export type GrantReviewOverride = {
  profileId: string;
  reason: string;
  grantedBy: string;
  lastReviewedAt: string;
  expiresAt?: string;
  reviewCycleDays?: number;
};

export type GrantReviewSetPayload = {
  profileIds: string[];
  grantOverrides?: GrantReviewOverride[];
};

export function buildGrantReviewSetPayload(input: {
  mode: ReviewActionMode;
  reviewedProfileId: string;
  profileIds: string[];
  keepIds?: string[];
  reason?: string;
  grantedBy?: string;
  expiresAtDate?: string;
  reviewCycleDays?: string;
  now?: string;
}): GrantReviewSetPayload {
  // narrow / revoke 只改变 profileIds，不传 grantOverrides；剩余授权的元数据由后端原样保留。
  if (input.mode === "narrow") return { profileIds: [...(input.keepIds ?? input.profileIds)] };
  if (input.mode === "revoke") return { profileIds: input.profileIds.filter((id) => id !== input.reviewedProfileId) };
  // retain 只针对复核对象下发 grantOverride：写入本次理由与授权人、刷新 lastReviewedAt，不改写 grantedAt。
  const override: GrantReviewOverride = {
    profileId: input.reviewedProfileId,
    reason: (input.reason ?? "").trim(),
    grantedBy: (input.grantedBy ?? "").trim(),
    lastReviewedAt: input.now ?? new Date().toISOString(),
    ...(input.expiresAtDate ? { expiresAt: new Date(`${input.expiresAtDate}T00:00:00.000Z`).toISOString() } : {}),
    ...(input.reviewCycleDays?.trim() ? { reviewCycleDays: Number(input.reviewCycleDays) } : {})
  };
  return { profileIds: [...input.profileIds], grantOverrides: [override] };
}

function GrantReviewActionModal({ item, resolution, mode, onClose, onCreated, notify }: {
  item: KnowledgeGrantReviewItem;
  resolution: ReviewSubjectResolution;
  mode: ReviewActionMode;
  onClose: () => void;
  onCreated: () => Promise<void>;
  notify: PageProps["notify"];
}) {
  const daemonAvailable = useDaemonAvailable();
  const [grantedBy, setGrantedBy] = useState("local-owner");
  const [reason, setReason] = useState(() => mode === "retain"
    ? `复核后保留 ${item.grant.profileId} 授权：${item.grant.reason}`
    : mode === "narrow"
      ? `复核后收窄 ${reviewSubjectLabel(item)} 的知识 Profile 授权`
      : `复核后撤销 ${item.grant.profileId} 授权`);
  const [reviewCycleDays, setReviewCycleDays] = useState(item.grant.reviewCycleDays ? String(item.grant.reviewCycleDays) : "");
  const [expiresAt, setExpiresAt] = useState(item.grant.expiresAt ? item.grant.expiresAt.slice(0, 10) : "");
  const [keepIds, setKeepIds] = useState<string[]>(resolution.profileIds);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const nextIds = buildGrantReviewSetPayload({
    mode,
    reviewedProfileId: item.grant.profileId,
    profileIds: resolution.profileIds,
    keepIds
  }).profileIds;
  const narrowValid = mode !== "narrow" || (keepIds.length >= 1 && keepIds.length < resolution.profileIds.length);
  // grantedBy 只在 retain 时写入 grantOverride；narrow / revoke 不展示、不提交任何 grant 元数据。
  const metadataComplete = mode !== "retain" || Boolean(grantedBy.trim());
  const canSubmit = daemonAvailable && !submitting && reason.trim() && metadataComplete && narrowValid && resolution.expectedVersion !== undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (resolution.expectedVersion === undefined) return;
    setSubmitting(true);
    setError("");
    try {
      const payload: GrantReviewSetPayload = buildGrantReviewSetPayload({
        mode,
        reviewedProfileId: item.grant.profileId,
        profileIds: resolution.profileIds,
        keepIds,
        reason,
        grantedBy,
        expiresAtDate: expiresAt,
        reviewCycleDays
      });
      const operation = item.subject.kind === "employee"
        ? { type: "employee-profiles.set" as const, targetId: item.subject.employeeId, expectedVersion: resolution.expectedVersion, payload }
        : { type: "project-role-profiles.set" as const, projectId: item.subject.projectId, roleId: item.subject.roleId, expectedVersion: resolution.expectedVersion, payload };
      const change = await api<KnowledgeChangeRequest>("/api/knowledge-changes", writeBody({
        title: `${REVIEW_ACTION_COPY[mode].title} · ${reviewSubjectLabel(item)}`,
        reason: reason.trim(),
        requestedBy: "workbench-operator",
        operation
      }));
      notify(`已生成待审批提案「${change.title}」；人工批准后才会改权`);
      await onCreated();
      onClose();
    } catch (reason_) {
      setError(reason_ instanceof Error ? reason_.message : String(reason_));
    } finally {
      setSubmitting(false);
    }
  };

  return <Modal title={`${REVIEW_ACTION_COPY[mode].title} · ${item.grant.profileId}`} eyebrow={`${reviewSubjectLabel(item)} · CONTROLLED PROPOSAL ONLY`} onClose={onClose} wide>
    <form className="modal-body compact-form" onSubmit={submit}>
      <div className="project-connect-note"><strong>{REVIEW_ACTION_COPY[mode].note}</strong><p>任何改权都只通过 KnowledgeChangeRequest 走人工批准；这里不会直接 PATCH 员工档案或项目任用。</p></div>
      <dl className="ledger">
        <dt>当前授权</dt><dd>{resolution.profileIds.length ? resolution.profileIds.join("、") : "（无显式授权）"}</dd>
        <dt>提案后授权</dt><dd>{nextIds.length ? nextIds.join("、") : "（全部移除）"}</dd>
        <dt>版本基准</dt><dd>v{resolution.expectedVersion ?? "—"}</dd>
      </dl>
      {mode === "narrow" && <fieldset className="knowledge-base-choices review-narrow-choices" disabled={!daemonAvailable || submitting}>
        <legend>保留的知识 Profile（取消勾选即移除）</legend>
        {resolution.profileIds.map((profileId) => <label key={profileId}>
          <input type="checkbox" checked={keepIds.includes(profileId)} onChange={(event) => setKeepIds((current) => event.target.checked ? [...current, profileId] : current.filter((id) => id !== profileId))} />
          <span><strong>{profileId}</strong><small>{profileId === item.grant.profileId ? "本条复核对象" : "同一主体的其他授权"}</small></span>
        </label>)}
        {!narrowValid && <p className="inline-error">收窄需要至少保留一个知识 Profile 且少于当前授权；要全部移除请使用“撤销”。</p>}
      </fieldset>}
      {mode === "retain" && <>
        <div className="form-grid two">
          <Field label="授权人 grantedBy"><input required disabled={!daemonAvailable || submitting} value={grantedBy} onChange={(event) => setGrantedBy(event.target.value)} /></Field>
          <Field label="复核周期（天，可选）"><input type="number" min={1} max={3650} disabled={!daemonAvailable || submitting} value={reviewCycleDays} onChange={(event) => setReviewCycleDays(event.target.value)} /></Field>
        </div>
        <Field label="到期时间 expiresAt（可选）"><input type="date" disabled={!daemonAvailable || submitting} value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></Field>
      </>}
      {mode !== "retain" && <p className="review-card-note">其余保留授权的到期时间与复核周期由后端原样保留，本提案不修改 grant 元数据。</p>}
      <Field label="理由 reason"><textarea required rows={3} disabled={!daemonAvailable || submitting} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={submitting} onClick={onClose}>返回</button><button className="button primary" disabled={!canSubmit}>{submitting ? "生成提案中…" : REVIEW_ACTION_COPY[mode].confirm}</button></div>
    </form>
  </Modal>;
}

export function KnowledgeReviewBoard({ data, refresh, notify }: PageProps) {
  const daemonAvailable = useDaemonAvailable();
  const [ledger, setLedger] = useState<KnowledgeGrantReviewLedger>();
  const [error, setError] = useState("");
  const [action, setAction] = useState<{ mode: ReviewActionMode; item: KnowledgeGrantReviewItem; resolution: ReviewSubjectResolution }>();
  const load = async () => {
    try {
      setError("");
      setLedger(await api<KnowledgeGrantReviewLedger>("/api/knowledge/reviews"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  useEffect(() => { void load(); }, []);

  const countOf = (status: KnowledgeGrantReviewItem["status"]) => ledger?.counts[status] ?? 0;
  return <main className="knowledge-review-board" role="tabpanel">
    <header className="knowledge-review-header">
      <div><span className="console-kicker">GRANT REVIEW LEDGER · REMINDER ONLY</span><h2>授权复核台账</h2><p>只提醒、不自动改权。保留、收窄、撤销都只会生成待审批的 KnowledgeChangeRequest，人工批准后由 Core 应用；这里不会直接修改员工档案或项目任用。</p></div>
      <div className="knowledge-review-counts">
        <span className="review-count review-count--overdue"><b>{countOf("overdue")}</b>已逾期</span>
        <span className="review-count review-count--due"><b>{countOf("due-soon")}</b>临近到期</span>
        <span className="review-count review-count--current"><b>{countOf("current")}</b>复核期内</span>
        <span className="review-count review-count--unscheduled"><b>{countOf("unscheduled")}</b>未排期</span>
      </div>
    </header>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {!ledger && !error && <div className="knowledge-review-loading">正在读取授权复核台账…</div>}
    {ledger && <div className="knowledge-review-list">
      {ledger.items.map((item) => {
        const resolution = resolveReviewSubject(data, item);
        const narrowProblem = resolution.problem ?? (resolution.profileIds.length <= 1 ? "只剩一个知识 Profile，收窄等同撤销，请直接使用“撤销”。" : undefined);
        const revokeProblem = resolution.problem ?? (!resolution.profileIds.includes(item.grant.profileId) ? `当前授权列表中已经没有 ${item.grant.profileId}；无需撤销，可用“保留”刷新其余授权。` : undefined);
        const open = (mode: ReviewActionMode) => setAction({ mode, item, resolution });
        return <article className="review-card" data-status={item.status} key={item.id}>
          <header className="review-card-head">
            <div><span className="change-kind">{item.subject.kind === "employee" ? "EMPLOYEE GRANT" : "PROJECT ROLE GRANT"}</span><h3>{item.grant.profileId}</h3><code>{item.id}</code></div>
            <div className="review-card-badges">{item.grant.source === "legacy" && <span className="grant-source grant-source--legacy">历史遗留</span>}<ReviewStamp status={item.status} /></div>
          </header>
          <dl className="ledger review-card-ledger">
            <dt>授权主体</dt><dd>{reviewSubjectLabel(item)}</dd>
            <dt>授权人</dt><dd>{item.grant.grantedBy}</dd>
            <dt>授权时间</dt><dd>{formatTime(item.grant.grantedAt)}</dd>
            <dt>到期 / 复核</dt><dd>{item.dueAt ? `${formatTime(item.dueAt)} 到期` : grantScheduleCopy(item.grant)}</dd>
            {item.grant.lastReviewedAt && <><dt>最近复核</dt><dd>{formatTime(item.grant.lastReviewedAt)}</dd></>}
            <dt>授权来源</dt><dd>{grantSourceCopy(item.grant.source)}</dd>
          </dl>
          <p className="review-card-reason"><span>理由</span>{item.grant.reason}</p>
          {item.reasons.length > 0 && <ul className="change-warnings review-card-signals">{item.reasons.map((signal) => <li key={signal}><strong>提醒</strong>{signal}</li>)}</ul>}
          {resolution.problem && <p className="inline-error">{resolution.problem} 所有改权入口已禁用。</p>}
          <footer className="review-card-actions">
            <button type="button" className="button secondary" disabled={!daemonAvailable || Boolean(resolution.problem)} onClick={() => open("retain")}>保留</button>
            <button type="button" className="button secondary" disabled={!daemonAvailable || Boolean(narrowProblem)} title={narrowProblem} onClick={() => open("narrow")}>收窄</button>
            <button type="button" className="button danger" disabled={!daemonAvailable || Boolean(revokeProblem)} title={revokeProblem} onClick={() => open("revoke")}>撤销</button>
          </footer>
          {(narrowProblem && !resolution.problem) && <p className="review-card-note">{narrowProblem}</p>}
          {(revokeProblem && !resolution.problem) && <p className="review-card-note">{revokeProblem}</p>}
        </article>;
      })}
      {ledger.items.length === 0 && <div className="knowledge-all-clear"><strong>台账为空</strong><span>员工或项目角色获得知识 Profile 授权后，复核条目会出现在这里。</span></div>}
    </div>}
    <footer className="knowledge-review-footer"><span>策略 {ledger?.policy ?? "reminder-only-v1"} · 基准 {formatTime(ledger?.asOf)} · 临近窗口 {ledger?.dueSoonDays ?? "—"} 天</span><button type="button" className="text-button" onClick={() => void load()}>重新读取</button></footer>
    {action && <GrantReviewActionModal item={action.item} resolution={action.resolution} mode={action.mode} notify={notify} onClose={() => setAction(undefined)} onCreated={async () => { await refresh(); await load(); }} />}
  </main>;
}
