import { useMemo, useState, type FormEvent } from "react";
import { api, writeBody } from "./api";
import { Field, Modal, Stamp, useDaemonAvailable } from "./components";
import type { Employee, KnowledgeChangeRequest, KnowledgeProfile } from "./types";

interface EmployeeGrantProposalInput {
  selectedProfileIds: string[];
  reason: string;
  grantedBy: string;
  expiresAtDate?: string;
  reviewCycleDays?: string;
}

export interface EmployeeGrantProposalPayload {
  profileIds: string[];
  grantOverrides?: Array<{
    profileId: string;
    reason: string;
    grantedBy: string;
    expiresAt?: string;
    reviewCycleDays?: number;
  }>;
}

export function buildEmployeeGrantProposalPayload(
  employee: Employee,
  input: EmployeeGrantProposalInput
): EmployeeGrantProposalPayload {
  const current = new Set(employee.knowledgeProfileIds ?? []);
  const profileIds = [...new Set(input.selectedProfileIds)];
  const added = profileIds.filter((profileId) => !current.has(profileId));
  if (added.length === 0) return { profileIds };
  const metadata = {
    reason: input.reason.trim(),
    grantedBy: input.grantedBy.trim(),
    ...(input.expiresAtDate
      ? { expiresAt: new Date(`${input.expiresAtDate}T00:00:00.000Z`).toISOString() }
      : {}),
    ...(input.reviewCycleDays?.trim()
      ? { reviewCycleDays: Number(input.reviewCycleDays) }
      : {})
  };
  return {
    profileIds,
    grantOverrides: added.map((profileId) => ({ profileId, ...metadata }))
  };
}

export function EmployeeKnowledgeGrantModal({ employee, knowledgeProfiles, onClose, onCreated, notify }: {
  employee: Employee;
  knowledgeProfiles: KnowledgeProfile[];
  onClose: () => void;
  onCreated: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const daemonAvailable = useDaemonAvailable();
  const currentIds = useMemo(() => employee.knowledgeProfileIds ?? [], [employee.id, employee.version]);
  const [selectedIds, setSelectedIds] = useState(() => currentIds);
  const [reason, setReason] = useState("");
  const [grantedBy, setGrantedBy] = useState("local-owner");
  const [expiresAtDate, setExpiresAtDate] = useState("");
  const [reviewCycleDays, setReviewCycleDays] = useState("90");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const currentSet = useMemo(() => new Set(currentIds), [currentIds]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const addedIds = selectedIds.filter((profileId) => !currentSet.has(profileId));
  const removedIds = currentIds.filter((profileId) => !selectedSet.has(profileId));
  const changed = addedIds.length > 0 || removedIds.length > 0;
  const reviewCycleValid = !reviewCycleDays.trim()
    || (Number.isInteger(Number(reviewCycleDays)) && Number(reviewCycleDays) >= 1 && Number(reviewCycleDays) <= 3650);
  const profileChoices: Array<{
    id: string;
    displayName: string;
    version: number | "—";
    status: "active" | "archived" | "missing";
  }> = [
    ...knowledgeProfiles
      .filter((profile) => profile.status === "active" || currentSet.has(profile.id))
      .map((profile) => ({ id: profile.id, displayName: profile.displayName, version: profile.version, status: profile.status })),
    ...currentIds
      .filter((profileId) => !knowledgeProfiles.some((profile) => profile.id === profileId))
      .map((profileId) => ({ id: profileId, displayName: profileId, version: "—" as const, status: "missing" as const }))
  ];
  const canSubmit = daemonAvailable
    && !submitting
    && changed
    && Boolean(reason.trim())
    && Boolean(grantedBy.trim())
    && reviewCycleValid;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      const payload = buildEmployeeGrantProposalPayload(employee, {
        selectedProfileIds: selectedIds,
        reason,
        grantedBy,
        expiresAtDate,
        reviewCycleDays
      });
      const change = await api<KnowledgeChangeRequest>("/api/knowledge-changes", writeBody({
        title: `调整员工知识授权 · ${employee.identity.displayName}`,
        reason: reason.trim(),
        requestedBy: grantedBy.trim(),
        operation: {
          type: "employee-profiles.set",
          targetId: employee.id,
          expectedVersion: employee.version,
          payload
        }
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

  return <Modal
    title={`调整知识授权 · ${employee.identity.displayName}`}
    eyebrow={`${employee.id} v${employee.version} · CONTROLLED PROPOSAL ONLY`}
    onClose={onClose}
    wide
  >
    <form className="modal-body compact-form" onSubmit={submit}>
      <div className="project-connect-note">
        <strong>这里只生成待人工审批的授权提案。</strong>
        <p>不会直接修改员工档案；批准时 Core 会重新核对员工版本、Profile 状态与授权元数据。未变更的授权理由、授权时间和复核安排保持原样。</p>
      </div>
      <dl className="ledger">
        <dt>当前授权</dt><dd>{currentIds.length ? currentIds.join("、") : "（无）"}</dd>
        <dt>提案后</dt><dd>{selectedIds.length ? selectedIds.join("、") : "（全部移除）"}</dd>
        <dt>新增</dt><dd>{addedIds.length ? addedIds.join("、") : "无"}</dd>
        <dt>移除</dt><dd>{removedIds.length ? removedIds.join("、") : "无"}</dd>
      </dl>
      <fieldset className="knowledge-base-choices employee-profile-choices" disabled={!daemonAvailable || submitting}>
        <legend>选择员工可以使用的知识 Profile</legend>
        {profileChoices.map((profile) => {
          const assigned = currentSet.has(profile.id);
          return <label key={profile.id}>
            <input
              type="checkbox"
              checked={selectedSet.has(profile.id)}
              onChange={(event) => setSelectedIds((current) => event.target.checked
                ? [...current, profile.id]
                : current.filter((profileId) => profileId !== profile.id))}
            />
            <span>
              <strong>{profile.displayName}</strong>
              <small>{profile.id} · v{profile.version} · {assigned ? "当前已授权" : "可申请"}</small>
            </span>
            <Stamp status={profile.status === "missing" ? "blocked" : profile.status} label={profile.status === "active" ? "可用" : profile.status === "archived" ? "已归档" : "引用缺失"} />
          </label>;
        })}
        {profileChoices.length === 0 && <p className="muted">没有可分配的活动知识 Profile；请先到知识控制台建立并启用 Profile。</p>}
      </fieldset>
      <Field label="授权理由 reason" hint="说明岗位或项目为何需要这些知识范围。">
        <textarea required rows={3} disabled={!daemonAvailable || submitting} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <div className="form-grid two">
        <Field label="提案人 / 授权负责人">
          <input required disabled={!daemonAvailable || submitting} value={grantedBy} onChange={(event) => setGrantedBy(event.target.value)} />
        </Field>
        <Field label="复核周期（天）" hint={addedIds.length ? "只写入本次新增授权；留空表示不排期。" : "本次没有新增授权，不会改写已有安排。"}>
          <input type="number" min={1} max={3650} disabled={!daemonAvailable || submitting || addedIds.length === 0} value={reviewCycleDays} onChange={(event) => setReviewCycleDays(event.target.value)} />
        </Field>
      </div>
      <Field label="到期时间（可选）" hint={addedIds.length ? "只写入本次新增授权。" : "本次没有新增授权，不会改写已有到期时间。"}>
        <input type="date" disabled={!daemonAvailable || submitting || addedIds.length === 0} value={expiresAtDate} onChange={(event) => setExpiresAtDate(event.target.value)} />
      </Field>
      {!changed && <p className="review-card-note">选择尚未变化。只有新增或移除 Profile 后才能生成提案。</p>}
      {!reviewCycleValid && <p className="inline-error">复核周期必须是 1–3650 天的整数。</p>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="button secondary" disabled={submitting} onClick={onClose}>返回</button>
        <button className="button primary" disabled={!canSubmit}>{submitting ? "生成提案中…" : "生成授权调整提案"}</button>
      </div>
    </form>
  </Modal>;
}
