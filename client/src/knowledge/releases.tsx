import { useEffect, useState, type FormEvent } from "react";
import { api, writeBody } from "../api";
import {
  Field,
  Modal,
  Stamp,
  useDaemonAvailable
} from "../components";
import type {
  KnowledgeBase,
  KnowledgeImpactSnapshot,
  KnowledgeRevisionAssessment,
  KnowledgeRevisionPreview
} from "../types";
import type { PageProps } from "./editors";

export function assessmentCopy(status: KnowledgeRevisionAssessment["status"] | undefined): string {
  if (status === "ready") return "可发布";
  if (status === "attention") return "需确认";
  if (status === "blocked") return "阻塞";
  return "未检查";
}

export function assessmentStamp(status: KnowledgeRevisionAssessment["status"] | undefined): "active" | "pending" | "blocked" {
  if (status === "ready") return "active";
  if (status === "blocked") return "blocked";
  return "pending";
}

export function AssessmentPanel({ assessment }: { assessment?: KnowledgeRevisionAssessment }) {
  if (!assessment) return <div className="knowledge-assessment-empty">尚无 Revision，先添加人工内容或同步来源。</div>;
  return <div className={`knowledge-assessment assessment-${assessment.status}`}>
    <header>
      <div><span>REVISION QUALITY GATE</span><strong>R{assessment.revision} · {assessmentCopy(assessment.status)}</strong></div>
      <Stamp status={assessmentStamp(assessment.status)} label={assessmentCopy(assessment.status)} />
    </header>
    <div className="knowledge-assessment-metrics">
      <span><b>{assessment.documentCount}</b>文档</span>
      <span><b>{assessment.sourceDocumentCount}</b>同步</span>
      <span><b>{assessment.manualDocumentCount}</b>人工</span>
      <span><b>{assessment.collections.filter((item) => item.documentCount > 0).length}/{assessment.collections.length}</b>分区覆盖</span>
    </div>
    {assessment.warnings.length > 0 && <ul>{assessment.warnings.map((warning) => <li key={`${warning.code}-${warning.collectionId ?? "all"}`}><strong>{warning.severity === "blocker" ? "阻塞" : "提醒"}</strong>{warning.message}</li>)}</ul>}
  </div>;
}

export function RevisionPreviewModal({ knowledgeBase, revision, onClose, notify }: {
  knowledgeBase: KnowledgeBase;
  revision: number;
  onClose: () => void;
  notify: PageProps["notify"];
}) {
  const daemonAvailable = useDaemonAvailable();
  const [message, setMessage] = useState(`${knowledgeBase.displayName} 的核心规则、使用边界和最新变化`);
  const [collectionIds, setCollectionIds] = useState(knowledgeBase.collections.map((collection) => collection.id));
  const [result, setResult] = useState<KnowledgeRevisionPreview>();
  const [loading, setLoading] = useState(false);
  const preview = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      setResult(await api<KnowledgeRevisionPreview>(`/api/knowledge-bases/${knowledgeBase.id}/preview`, writeBody({
        message,
        revision,
        collectionIds,
        maxChunks: 12,
        maxTokens: 6000
      })));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setLoading(false);
    }
  };
  return <Modal title={`草稿检索试跑 · R${revision}`} eyebrow={`${knowledgeBase.id} · NO EMPLOYEE / NO PROVIDER`} onClose={onClose} wide>
    <form className="modal-body knowledge-revision-preview" onSubmit={preview}>
      <div className="project-connect-note"><strong>直接检查这个 Revision 的检索质量。</strong><p>不会修改发布指针，也不会扩成员工权限；它只验证内容是否能被预期问题命中。</p></div>
      <Field label="模拟问题"><textarea required rows={4} disabled={!daemonAvailable || loading} value={message} onChange={(event) => setMessage(event.target.value)} /></Field>
      <fieldset className="knowledge-preview-collections"><legend>参与试跑的 Collection</legend>{knowledgeBase.collections.map((collection) => <label key={collection.id}><input type="checkbox" checked={collectionIds.includes(collection.id)} onChange={(event) => setCollectionIds(event.target.checked ? [...collectionIds, collection.id] : collectionIds.filter((id) => id !== collection.id))} /><span><strong>{collection.displayName}</strong><small>{collection.id} · {collection.authority}</small></span></label>)}</fieldset>
      {result && <section className="knowledge-preview-output">
        <header><div><span>命中证据</span><strong>{result.evidence.length} 条</strong></div><code>R{result.revision} · {result.collectionIds.length} Collections</code></header>
        {result.evidence.length ? <div className="knowledge-preview-evidence">{result.evidence.map((evidence) => <article key={evidence.citationId}><header><span>{evidence.citationId}</span><strong>{evidence.title}</strong><code>{evidence.score.toFixed(3)}</code></header><p>{evidence.content}</p><footer>{evidence.collectionId} · {evidence.sourceRef ?? evidence.documentId}</footer></article>)}</div> : <div className="knowledge-zero-result"><strong>没有内容达到相关度门槛</strong><span>检查 Collection 标签、文档标题、正文措辞，或换一个更接近真实任务的问题。</span></div>}
      </section>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>关闭</button><button className="button primary" disabled={!daemonAvailable || loading || collectionIds.length === 0}>{loading ? "检索中…" : result ? "重新试跑" : "开始试跑"}</button></div>
    </form>
  </Modal>;
}

export function PublishReviewModal({ knowledgeBase, revision, impact, onClose, onPublished, notify }: {
  knowledgeBase: KnowledgeBase;
  revision: number;
  impact?: KnowledgeImpactSnapshot;
  onClose: () => void;
  onPublished: () => Promise<void>;
  notify: PageProps["notify"];
}) {
  const daemonAvailable = useDaemonAvailable();
  const [assessment, setAssessment] = useState<KnowledgeRevisionAssessment>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<KnowledgeRevisionAssessment>(`/api/knowledge-bases/${knowledgeBase.id}/assessment?revision=${revision}`)
      .then(setAssessment)
      .catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
  }, [knowledgeBase.id, revision, notify]);
  const baseImpact = impact?.knowledgeBases.find((item) => item.knowledgeBaseId === knowledgeBase.id);
  const isRollback = Boolean(knowledgeBase.publishedRevision && revision < knowledgeBase.publishedRevision);
  const publish = async () => {
    setBusy(true);
    try {
      await api(`/api/knowledge-bases/${knowledgeBase.id}/publish`, writeBody({ revision }));
      notify(isRollback ? `发布指针已切换到 Revision ${revision}` : `Revision ${revision} 已发布`);
      await onPublished();
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return <Modal title={isRollback ? `回滚到 Revision ${revision}` : `发布 Revision ${revision}`} eyebrow="CONTROLLED RELEASE · IMPACT REVIEW" onClose={onClose} wide>
    <div className="modal-body knowledge-publish-review">
      <div className="knowledge-release-route"><span>草稿 R{knowledgeBase.latestRevision ?? "—"}</span><i>→</i><strong>员工读取 R{revision}</strong></div>
      <AssessmentPanel assessment={assessment} />
      <section className="knowledge-impact-confirm">
        <header><div><span>授权影响</span><strong>{baseImpact?.profileMatches.length ?? 0} Profiles · {baseImpact?.employees.length ?? 0} 员工 · {baseImpact?.projectRoles.length ?? 0} 项目角色</strong></div></header>
        {baseImpact?.profileMatches.length ? <div className="impact-chip-list">{baseImpact.profileMatches.map((profile) => <span key={profile.profileId}><b>{profile.profileName}</b><small>{profile.rules.some((rule) => rule.matchMode === "metadata") ? "元数据自动匹配" : "显式纳入"}</small></span>)}</div> : <p className="muted">当前没有 Profile 会选择这座知识库。发布后内容仍不会进入员工上下文。</p>}
      </section>
      <label className="knowledge-release-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><strong>我已核对内容质量和影响范围</strong><small>{isRollback ? "这会让后续运行使用旧 Revision；历史 Run 不受影响。" : "发布只影响后续运行；每次 Run 仍会固定实际 Revision 并保存证据。"}</small></span></label>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button type="button" className="button primary" disabled={!daemonAvailable || busy || !assessment || assessment.status === "blocked" || !confirmed} onClick={() => void publish()}>{busy ? "切换中…" : isRollback ? `确认回滚到 R${revision}` : `确认发布 R${revision}`}</button></div>
    </div>
  </Modal>;
}
