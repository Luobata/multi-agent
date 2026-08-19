import { useState } from "react";
import { Modal, Stamp, formatTime } from "../components";
import { isRunAcceptanceReady } from "../dashboard/acceptance";
import type { RunMergePreview } from "../types";
import { RunEvidenceCard } from "./evidence";
import { formatBytes } from "./shared";

/** 交付面板：合入/保留/丢弃的状态表达与动作，以及三个显式确认弹窗。 */
/** 复制按钮：剪贴板不可用时给出可见错误， busy/copied/failed 都有非颜色信号。 */
function CopyButton({ value, label, className = "button ghost" }: { value: string; label: string; className?: string }) {
  const [status, setStatus] = useState<"idle" | "busy" | "copied" | "failed">("idle");
  const copy = async () => {
    if (status === "busy") return;
    setStatus("busy");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard is unavailable");
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    window.setTimeout(() => setStatus("idle"), 2500);
  };
  return <span className="copy-control">
    <button type="button" className={className} disabled={status === "busy"} aria-busy={status === "busy"} aria-live="polite" onClick={() => void copy()}>
      {status === "busy" ? "复制中…" : status === "copied" ? "已复制" : status === "failed" ? "复制失败" : label}
    </button>
    {status === "failed" && <span className="copy-error" role="alert">剪贴板不可用，请手动选择文本复制。</span>}
  </span>;
}

/** 冲突处理失败的一句人话根因，由服务端 failureClass 派生；技术细节另走折叠区。 */
function conflictFailureRootCause(failureClass: string | undefined): string {
  if (failureClass === "environment-blocked") return "根因：候选预览环境不可用（预览服务无法访问或已停止），验收拿不到真实页面。";
  if (failureClass === "evidence-incomplete") return "根因：验收证据不完整或与当前候选不一致，系统无法证明这次交付可以放行。";
  if (failureClass === "product-failed") return "根因：冲突修复后的独立回归发现了产品问题。";
  return "根因：自动冲突处理未通过；候选 worktree 与证据已完整保留。";
}

/** 失败重试按钮文案与按钮实际行为对齐：环境阻塞时重试会重启候选预览并重跑验收。 */
function conflictRetryLabel(failureClass: string | undefined): string {
  if (failureClass === "environment-blocked") return "重启候选预览并重跑验收";
  if (failureClass === "evidence-incomplete") return "重新收集证据并验收";
  return "重新让原领队处理冲突";
}

/** 冲突处理链路上的 Run 引用一律给独立运行卷宗深链，而不是不可点击的纯文本。 */
function ConflictRunLink({ label, runId }: { label: string; runId: string }) {
  return <small>{label}<a href={`#/runs/${encodeURIComponent(runId)}`}><code>{runId}</code></a></small>;
}

export function RunDeliveryPanel({
  preview,
  loading,
  taskId,
  canSubmitToBoard,
  boardSubmitting,
  boardSubmitError,
  onOpenMerge,
  onOpenWorktree,
  openingWorktree,
  onOpenKeep,
  onOpenDiscard,
  onSubmitToBoard,
  onRerunEvidence,
  acceptanceBindingLoading,
  acceptanceRunId,
  acceptanceBindingError,
  onOpenAcceptanceRun,
  evidenceRerunError,
  onRetryConflict,
  conflictRetrying,
  conflictRetryError
}: {
  preview?: RunMergePreview;
  loading: boolean;
  taskId?: string;
  canSubmitToBoard: boolean;
  boardSubmitting: boolean;
  boardSubmitError: string;
  onOpenMerge: () => void;
  onOpenWorktree: () => void;
  openingWorktree: boolean;
  onOpenKeep: () => void;
  onOpenDiscard: () => void;
  onSubmitToBoard: () => void;
  onRerunEvidence: () => void;
  acceptanceBindingLoading: boolean;
  acceptanceRunId?: string;
  acceptanceBindingError: boolean;
  onOpenAcceptanceRun: () => void;
  evidenceRerunError: string;
  onRetryConflict: () => void;
  conflictRetrying: boolean;
  conflictRetryError: string;
}) {
  if (loading && !preview) return <p className="run-delivery-loading">正在核对 worktree 与验收证据…</p>;
  if (!preview) return null;
  const conflict = preview.status === "conflict" || preview.delivery?.status === "conflict";
  const merged = preview.status === "merged" || preview.delivery?.status === "merged";
  const kept = preview.status === "kept" || preview.delivery?.status === "kept";
  const discarded = preview.status === "discarded" || preview.delivery?.status === "discarded";
  const queued = preview.status === "queued-for-merge" || preview.delivery?.status === "queued-for-merge";
  const retesting = preview.status === "retesting" || preview.delivery?.status === "retesting";
  const merging = preview.status === "merging" || preview.delivery?.status === "merging";
  const returned = preview.status === "returned-to-acceptance" || preview.delivery?.status === "returned-to-acceptance";
  const mergeBusy = queued || retesting || merging;
  const evidenceRerun = preview.delivery?.evidenceRerun;
  const conflictResolution = preview.delivery?.conflictResolution;
  const evidenceBusy = evidenceRerun?.status === "queued" || evidenceRerun?.status === "running";
  const evidenceFailed = evidenceRerun?.status === "failed";
  const evidenceMissing = preview.evidence.assets.length === 0;
  const evidenceRecovered = !evidenceMissing
    && evidenceRerun?.status === "passed"
    && Boolean(evidenceRerun.message?.includes("恢复"));
  const evidenceNeedsAttention = evidenceMissing || evidenceFailed;
  const conflictBusy = conflict && ["resolving", "retesting", "leader-review"].includes(conflictResolution?.status ?? "");
  const actionable = !merged && !discarded && !mergeBusy && !conflictBusy && Boolean(preview.worktreePath) && (preview.status === "awaiting-acceptance" || preview.status === "conflict" || preview.status === "kept" || preview.status === "returned-to-acceptance");
  const canQueueMerge = preview.eligible && !merged && !discarded && !mergeBusy && !evidenceBusy && preview.status !== "conflict";
  const showMergeAction = isRunAcceptanceReady(preview) && !merged && !discarded && !mergeBusy && preview.status !== "conflict";
  const mergeDisabledReason = !preview.eligible
    ? (preview.reasons[0] ?? "服务端合入门禁暂未通过，请处理阻塞后重试。")
    : evidenceBusy
      ? "验收证据正在更新，完成前不能加入待合入。"
      : undefined;
  const isAcceptanceRun = !taskId || Boolean(acceptanceRunId && acceptanceRunId === preview.runId);
  const canRerunEvidence = evidenceNeedsAttention && !acceptanceBindingLoading && isAcceptanceRun && !evidenceBusy && !mergeBusy && !conflictBusy && Boolean(preview.worktreePath) && !discarded && !merged;
  const evidenceDisabledReason = acceptanceBindingLoading
    ? "正在核对该需求绑定的验收 Run，完成前不会启动补采。"
    : acceptanceBindingError
      ? "无法核对该需求绑定的验收 Run，请重试或刷新页面后再补采。"
    : taskId && !acceptanceRunId
      ? "该需求尚未提交到待验收；请先提交并固定验收 Run，再补采媒体证据。"
      : !isAcceptanceRun
        ? `当前是 Run ${preview.runId}，该需求绑定的验收 Run 是 ${acceptanceRunId}；为避免跨 Run 写入，不能在当前卷宗补采。`
        : !preview.worktreePath
          ? "绑定的验收 Run 没有可用 worktree，无法补采；请重新发起验收 Run。"
          : discarded
            ? "候选结果已丢弃，worktree 已清理，不能补采。"
            : merged
              ? "交付已经合并，当前验收 Run 不再接受补采。"
              : evidenceBusy
                ? "test-engineer 正在补采证据，请等待当前任务完成。"
                : mergeBusy
                  ? "当前合入流程正在重测或写入，不能并行启动另一轮补采。"
                  : conflictBusy
                    ? "冲突处理正在进行，不能并行启动证据补采。"
                    : undefined;
  const diff = preview.changes.unifiedDiff;
  return <div className="run-delivery-panel">
    {conflict && <div className="run-delivery-callout run-delivery-callout--conflict" role="alert">
      <strong>{conflictResolution?.status === "resolving" ? "原领队正在规划并委派冲突修复" : conflictResolution?.status === "retesting" ? "冲突已解决，正在回跑测试" : conflictResolution?.status === "leader-review" ? "测试已通过，等待原领队放行" : conflictResolution?.status === "failed" ? (conflictResolution.failureClass === "environment-blocked" ? "候选环境阻塞，可重试验收" : conflictResolution.failureClass === "evidence-incomplete" ? "候选证据不完整，不得放行" : "候选产品回归失败") : "目标分支存在合并冲突"}</strong>
      {conflictResolution?.status === "failed" && <p className="run-delivery-rootcause">{conflictFailureRootCause(conflictResolution.failureClass)}</p>}
      {conflictResolution?.status === "failed"
        ? <details className="run-delivery-tech-detail"><summary>技术详情</summary><p>{preview.delivery?.message ?? "候选仍在待合入队列，原 worktree 与证据均已保留。"}</p></details>
        : <p>{preview.delivery?.message ?? "候选仍在待合入队列，原 worktree 与证据均已保留。"}</p>}
      {conflictResolution?.leaderPlanRunId && <ConflictRunLink label="领队计划 Run：" runId={conflictResolution.leaderPlanRunId} />}
      {conflictResolution?.executionRoleId && <small>执行角色：<code>{conflictResolution.executionRoleId}</code></small>}
      {conflictResolution?.resolutionRunId && <ConflictRunLink label="工程修复 Run：" runId={conflictResolution.resolutionRunId} />}
      {conflictResolution?.testRunId && <ConflictRunLink label="复测 Run：" runId={conflictResolution.testRunId} />}
      {conflictResolution?.testedUrl && <small>受管候选：<code>{conflictResolution.testedUrl}</code></small>}
      {conflictResolution?.leaderReviewRunId && <ConflictRunLink label="领队复验 Run：" runId={conflictResolution.leaderReviewRunId} />}
      {conflictResolution?.status === "failed" && <button type="button" className="button secondary" disabled={conflictRetrying} aria-busy={conflictRetrying} onClick={onRetryConflict}>{conflictRetrying ? "正在重新排队…" : conflictRetryLabel(conflictResolution.failureClass)}</button>}
      {conflictResolution?.status === "failed" && <p className="run-delivery-escape">如果多次重试仍失败，可以{actionable ? <button type="button" className="run-delivery-escape-link" onClick={onOpenKeep}>保留候选</button> : "保留候选"}或{actionable ? <button type="button" className="run-delivery-escape-link" onClick={onOpenDiscard}>丢弃候选</button> : "丢弃候选"}结束本次交付。</p>}
      {conflictRetryError && <small className="inline-error">{conflictRetryError}</small>}
    </div>}
    {queued && <div className="run-delivery-callout run-delivery-callout--queued" role="status"><strong>已进入待合入队列</strong><p>{preview.delivery?.message ?? "同一目标分支上的候选会按批准顺序串行处理。"}</p></div>}
    {retesting && <div className="run-delivery-callout run-delivery-callout--retesting" role="status"><strong>{conflictResolution ? "冲突处理 2/3 · 正在重新验收" : "合入检查 1/2 · 目标变化后正在重测"}</strong><p>{preview.delivery?.message ?? "系统正在隔离环境执行独立回归。"}</p><small>{conflictResolution ? "当前尚未写入目标分支；独立测试通过后还需原领队复验，放行后才会自动合入。" : "当前尚未写入目标分支；独立回归通过后才会进入真正的合入阶段。"}</small></div>}
    {merging && <div className="run-delivery-callout run-delivery-callout--queued" role="status"><strong>合入处理 3/3 · 正在写入目标分支</strong><p>{preview.delivery?.message ?? "测试与复验已经通过，正在写入已批准的目标分支。"}</p></div>}
    {returned && <div className="run-delivery-callout run-delivery-callout--conflict" role="alert"><strong>自动合入已退回待验收</strong><p>{preview.delivery?.message ?? "候选 worktree 已保留，请处理异常后重新验收。"}</p></div>}
    {merged && <div className="run-delivery-callout run-delivery-callout--merged"><strong>交付已合并</strong><p>{preview.delivery?.mergeCommit ? <>Merge commit：<code>{preview.delivery.mergeCommit}</code></> : "合并记录已归档。"}</p></div>}
    {kept && <div className="run-delivery-callout run-delivery-callout--kept"><strong>交付已人工保留</strong><p>{preview.delivery?.humanDecision ? <>由 <code>{preview.delivery.humanDecision.actor}</code> 于 {formatTime(preview.delivery.humanDecision.at)} 标记保留；候选 worktree 原样保留，未执行 merge 或 push。{preview.delivery.humanDecision.note ? <> 备注:{preview.delivery.humanDecision.note}</> : null}</> : (preview.delivery?.message ?? "候选 worktree 已保留，未执行 merge 或 push。")}</p></div>}
    {discarded && <div className="run-delivery-callout run-delivery-callout--discarded" role="alert"><strong>候选结果已丢弃</strong><p>{preview.delivery?.humanDecision ? <>由 <code>{preview.delivery.humanDecision.actor}</code> 于 {formatTime(preview.delivery.humanDecision.at)} 确认丢弃；候选 worktree 已清理，合并、保留与丢弃操作均已关闭。{preview.delivery.humanDecision.note ? <> 备注:{preview.delivery.humanDecision.note}</> : null}</> : "候选 worktree 已清理，不能再合并、保留或丢弃。"}</p></div>}
    <dl className="ledger">
      <dt>目标分支</dt><dd>{preview.targetBranch ? <code>{preview.targetBranch}</code> : "—"}</dd>
      <dt>目标状态</dt><dd>{preview.targetClean ? "洁净" : "不可合并"}</dd>
      <dt>变更文件</dt><dd>{preview.changes.fileCount}</dd>
      <dt>结构化 E2E</dt><dd>{preview.evidence.structuredE2eCount} 条</dd>
      {preview.worktreePath && <><dt>候选 worktree</dt><dd className="run-delivery-path"><code className="path-code">{preview.worktreePath}</code><span className="run-delivery-path-actions"><button type="button" className="button ghost" disabled={openingWorktree || discarded} aria-busy={openingWorktree} onClick={onOpenWorktree}>{openingWorktree ? "打开中…" : "在系统中打开"}</button><CopyButton value={preview.worktreePath} label="复制路径" /></span></dd></>}
    </dl>
    {preview.reasons.length > 0 && <div className="run-delivery-reasons"><strong>当前不能合并</strong><ul>{preview.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
    {preview.changes.files.length > 0 && <div className="run-delivery-changes"><strong>代码变更</strong><ul>{preview.changes.files.map((file, index) => <li key={`${file.status}-${file.path}-${index}`}><code>{file.status}</code><span>{file.path}</span></li>)}</ul>{preview.changes.summary && <pre>{preview.changes.summary}</pre>}</div>}
    {diff.text && <details className="run-delivery-diff">
      <summary><strong>完整 unified diff</strong><span>{diff.truncated ? `已截断 · 上限 ${formatBytes(diff.maxBytes)}` : `${formatBytes(new TextEncoder().encode(diff.text).length)}`}</span></summary>
      {diff.truncated && <p className="run-delivery-diff-truncated" role="note">diff 超过 {formatBytes(diff.maxBytes)}，仅展示前半部分；完整内容请在候选 worktree 中用下方安全命令查看。</p>}
      <pre className="run-delivery-diff-text">{diff.text}</pre>
    </details>}
    {preview.safeGitCommands.length > 0 && <div className="run-delivery-git">
      <div className="run-delivery-git-head"><strong>安全 Git 检查命令</strong><CopyButton value={preview.safeGitCommands.join("\n")} label="复制全部命令" /></div>
      <p className="run-delivery-git-hint">只读命令，用于在终端自行核对候选交付；不会修改任何分支。</p>
      <ul>{preview.safeGitCommands.map((command) => <li key={command}><code>{command}</code><CopyButton value={command} label="复制" /></li>)}</ul>
    </div>}
    <div className="run-delivery-evidence">
      <div className="run-delivery-evidence-head"><strong>Evidence wall</strong><span>{preview.evidence.assets.length} 项媒体证据 · {preview.evidence.structuredE2eCount} 条结构化 E2E</span></div>
      <div className="run-delivery-evidence-summary" role="status">
        <span>结构化 E2E：{preview.evidence.structuredE2eCount} 条</span>
        <span>Required Gates：{preview.evidence.gates.filter((gate) => gate.required).length > 0
          ? preview.evidence.gates.filter((gate) => gate.required).map((gate) => `${gate.gateId} ${gate.status}`).join("；")
          : "未声明"}</span>
        {evidenceMissing && (preview.evidence.structuredE2eCount > 0 || preview.evidence.gates.some((gate) => gate.required)) && <strong>媒体 0 项不等于无验收证据</strong>}
      </div>
      {evidenceRecovered && <div className="run-delivery-evidence-attention run-delivery-evidence-attention--recovered" role="status">
        <div><strong>媒体证据已恢复，无需重复补采</strong><p>{evidenceRerun?.message ?? `daemon 中断了补采过程，但已恢复 ${preview.evidence.assets.length} 项可验收媒体；现有证据继续参与交付门禁。`}</p></div>
        <Stamp status="passed" label={`${preview.evidence.assets.length} 项可查看`} />
      </div>}
      {evidenceNeedsAttention && <div className={`run-delivery-evidence-attention${evidenceFailed ? " run-delivery-evidence-attention--interrupted" : ""}`} role="status">
        <div><strong>{evidenceFailed ? (evidenceMissing ? "截图补采失败，仍没有可查看媒体" : "截图补采失败，已保留部分媒体") : "缺少可查看的截图或录屏"}</strong><p>{evidenceFailed ? `${evidenceRerun.message ?? "上一轮补采未完整完成。"} 可以再次补采；已有媒体历史会保留。` : "结构化 E2E 已保留；媒体 0 项不等于无验收证据。是否让项目 test-engineer 重新走一遍验收路径并补采真实界面证据？"}</p></div>
        {!acceptanceBindingLoading && acceptanceRunId && !isAcceptanceRun
          ? <button type="button" className="button secondary" onClick={onOpenAcceptanceRun}>打开该需求绑定的验收 Run →</button>
          : <button type="button" className="button secondary" disabled={!canRerunEvidence} aria-busy={evidenceBusy} onClick={onRerunEvidence}>{evidenceBusy ? "test-engineer 补采中…" : evidenceFailed ? "重新运行 test-engineer 补采" : "让 test-engineer 补采证据"}</button>}
        {!canRerunEvidence && evidenceDisabledReason && <small role="note">{evidenceDisabledReason}</small>}
        {evidenceRerunError && <small className="inline-error" role="alert">{evidenceRerunError}</small>}
      </div>}
      {preview.evidence.assets.length > 0 && <div className="run-delivery-evidence-wall">{preview.evidence.assets.map((asset) => <RunEvidenceCard key={asset.id} asset={asset} />)}</div>}
    </div>
    {boardSubmitError && <div className="inline-error" role="alert">{boardSubmitError}</div>}
    {(showMergeAction || actionable || canSubmitToBoard) && !discarded && <div className="run-delivery-actions">
      {canSubmitToBoard && <button type="button" className="button secondary" disabled={boardSubmitting} aria-busy={boardSubmitting} onClick={onSubmitToBoard} title={taskId ? `写入看板需求 ${taskId} 的验收快照并迁移到待验收` : undefined}>{boardSubmitting ? "提交中…" : merged ? "补登记该需求到待验收" : "提交该需求到待验收"}</button>}
      {actionable && <button type="button" className="button danger" onClick={onOpenDiscard}>丢弃候选结果</button>}
      {actionable && <button type="button" className="button secondary" onClick={onOpenKeep}>人工保留</button>}
      {showMergeAction && <button type="button" className="button primary" disabled={!canQueueMerge} aria-describedby={!canQueueMerge && mergeDisabledReason ? "run-merge-disabled-reason" : undefined} onClick={onOpenMerge}>批准并加入待合入</button>}
      {showMergeAction && !canQueueMerge && mergeDisabledReason && <small id="run-merge-disabled-reason" role="note">暂不可合入：{mergeDisabledReason}</small>}
    </div>}
  </div>;
}

export function RunKeepConfirmation({
  preview,
  note,
  busy,
  error,
  onNoteChange,
  onClose,
  onKeep
}: {
  preview: RunMergePreview;
  note: string;
  busy: boolean;
  error: string;
  onNoteChange: (value: string) => void;
  onClose: () => void;
  onKeep: () => void;
}) {
  return <Modal title="人工保留候选交付" eyebrow="KEEP · NO MERGE · NO PUSH" onClose={onClose}>
    <div className="modal-body run-delivery-confirm">
      <div className="run-delivery-callout"><strong>只记录保留决定</strong><p>确认后服务端会把该交付标记为「人工保留」，候选 worktree 原样留在磁盘上；不会执行 merge，更不会 push。</p></div>
      <dl className="ledger">
        <dt>Run</dt><dd><code>{preview.runId}</code></dd>
        <dt>候选 worktree</dt><dd><code className="path-code">{preview.worktreePath}</code></dd>
        <dt>变更文件</dt><dd>{preview.changes.fileCount}</dd>
      </dl>
      <label className="run-delivery-note-field"><span>备注（可选，随保留决定归档）</span><textarea rows={3} maxLength={2000} value={note} disabled={busy} placeholder="例如：等待产品确认后再手动合并。" onChange={(event) => onNoteChange(event.target.value)} /></label>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="button" className="button primary" disabled={busy} onClick={onKeep}>{busy ? "提交中…" : "确认人工保留"}</button></div>
    </div>
  </Modal>;
}

export function RunDiscardConfirmation({
  preview,
  token,
  note,
  busy,
  error,
  onTokenChange,
  onNoteChange,
  onClose,
  onDiscard
}: {
  preview: RunMergePreview;
  token: string;
  note: string;
  busy: boolean;
  error: string;
  onTokenChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onClose: () => void;
  onDiscard: () => void;
}) {
  const exact = token === preview.discardConfirmationToken;
  return <Modal title="丢弃候选结果" eyebrow="DISCARD · IRREVERSIBLE" onClose={onClose}>
    <div className="modal-body run-delivery-confirm">
      <div className="danger-notice"><b>候选 worktree 将被物理清理。</b><p>确认后服务端会删除该 Run 的候选 worktree 与未合并改动，此操作不可撤销；不会触碰目标分支，也不会 push。</p></div>
      <dl className="ledger">
        <dt>Run</dt><dd><code>{preview.runId}</code></dd>
        <dt>候选 worktree</dt><dd><code className="path-code">{preview.worktreePath}</code></dd>
        <dt>变更文件</dt><dd>{preview.changes.fileCount}</dd>
      </dl>
      <label className="run-delivery-token-field"><span>输入 <code>{preview.discardConfirmationToken}</code> 以确认丢弃</span><input type="text" value={token} disabled={busy} autoComplete="off" spellCheck={false} aria-invalid={token.length > 0 && !exact} placeholder={preview.discardConfirmationToken} onChange={(event) => onTokenChange(event.target.value)} />{token.length > 0 && !exact && <small className="run-delivery-token-mismatch" role="alert">确认文字不匹配，请完整输入 {preview.discardConfirmationToken}</small>}</label>
      <label className="run-delivery-note-field"><span>备注（可选，随丢弃决定归档）</span><textarea rows={3} maxLength={2000} value={note} disabled={busy} placeholder="例如：方案作废，改由新 Run 重做。" onChange={(event) => onNoteChange(event.target.value)} /></label>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="button" className="button danger-filled" disabled={busy || !exact} onClick={onDiscard}>{busy ? "丢弃中…" : "确认丢弃候选结果"}</button></div>
    </div>
  </Modal>;
}


export function RunMergeConfirmation({
  preview,
  confirmed,
  busy,
  error,
  onConfirmedChange,
  onClose,
  onMerge
}: {
  preview: RunMergePreview;
  confirmed: boolean;
  busy: boolean;
  error: string;
  onConfirmedChange: (value: boolean) => void;
  onClose: () => void;
  onMerge: () => void;
}) {
  return <Modal title="批准并加入待合入" eyebrow="HUMAN ACCEPTANCE · SERIAL MERGE QUEUE" onClose={onClose} wide>
    <div className="modal-body run-delivery-confirm">
      <div className="run-delivery-callout"><strong>批准后由队列串行推进</strong><p>当前预览只读。确认后候选进入待合入；若前序合并改变目标分支，系统会先在临时集成 worktree 重测。冲突、重测失败或意外会保留候选并退回待验收，不会自动 push。</p></div>
      <dl className="ledger">
        <dt>Run</dt><dd><code>{preview.runId}</code></dd>
        <dt>目标分支</dt><dd><code>{preview.targetBranch}</code></dd>
        <dt>变更文件</dt><dd>{preview.changes.fileCount}</dd>
        <dt>验收媒体</dt><dd>{preview.evidence.assets.length}</dd>
        <dt>确认 token</dt><dd><code>{preview.confirmationToken}</code></dd>
      </dl>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <label className="run-delivery-confirm-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => onConfirmedChange(event.target.checked)} /><span><strong>我已核对代码变更与验收证据，并批准进入目标分支合入队列</strong><small>这次确认不会被自动化扩大到其它候选；每个需求仍需独立人工批准。</small></span></label>
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="button" className="button primary" disabled={busy || !confirmed} onClick={onMerge}>{busy ? "入队中…" : `批准并排队合入 ${preview.targetBranch}`}</button></div>
    </div>
  </Modal>;
}
