import { useState, type FormEvent } from "react";
import { api, writeBody } from "../api";
import {
  Field,
  Modal,
  SelectControl,
  formatTime,
  useDaemonAvailable
} from "../components";
import type {
  KnowledgeBase,
  KnowledgeChangeRequest,
  KnowledgeReferenceType,
  KnowledgeUrlPreview
} from "../types";
import type { PageProps } from "./editors";
import { REFERENCE_TYPE_COPY } from "./wiki";

type ImportStep = 1 | 2 | 3;

const IMPORT_STEPS: Array<{ step: ImportStep; label: string }> = [
  { step: 1, label: "选择目标与链接" },
  { step: 2, label: "核对冻结预览" },
  { step: 3, label: "确认关联并提案" }
];

export function UrlImportModal({ knowledgeBases, initialBaseId, onClose, onProposed, notify }: {
  knowledgeBases: KnowledgeBase[];
  initialBaseId?: string;
  onClose: () => void;
  onProposed: (change: KnowledgeChangeRequest) => Promise<void>;
  notify: PageProps["notify"];
}) {
  const daemonAvailable = useDaemonAvailable();
  const activeBases = knowledgeBases.filter((item) => item.status === "active");
  const [step, setStep] = useState<ImportStep>(1);
  const [baseId, setBaseId] = useState(() => initialBaseId && activeBases.some((item) => item.id === initialBaseId) ? initialBaseId : activeBases[0]?.id ?? "");
  const base = activeBases.find((item) => item.id === baseId);
  const [collectionId, setCollectionId] = useState(() => base?.collections[0]?.id ?? "");
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<KnowledgeUrlPreview>();
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [selectedRelations, setSelectedRelations] = useState<Record<string, { type: KnowledgeReferenceType; note: string }>>({});
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const chooseBase = (id: string) => {
    setBaseId(id);
    setCollectionId(activeBases.find((item) => item.id === id)?.collections[0]?.id ?? "");
    setPreview(undefined);
    setError("");
  };
  const candidateSourceTitle = (sourceDocumentId: string) => preview?.documents.find((document) => document.id === sourceDocumentId)?.title ?? sourceDocumentId;

  const runPreview = async (event: FormEvent) => {
    event.preventDefault();
    if (!base || !collectionId) return;
    setFetching(true);
    setError("");
    try {
      const result = await api<KnowledgeUrlPreview>("/api/knowledge/url-preview", writeBody({
        knowledgeBaseId: base.id,
        collectionId,
        url: url.trim()
      }));
      setPreview(result);
      setSelectedRelations({});
      let host = result.finalUrl;
      try { host = new URL(result.finalUrl).hostname; } catch { /* keep full URL */ }
      setTitle(`从 ${host} 导入到 ${base.displayName}`);
      setReason(`从链接 ${result.finalUrl} 导入 ${result.documents.length} 篇结构化文档到 Collection ${collectionId}（冻结预览 ${result.previewHash.slice(0, 12)}…）。`);
      setStep(2);
    } catch (reason_) {
      setPreview(undefined);
      setError(reason_ instanceof Error ? reason_.message : String(reason_));
    } finally {
      setFetching(false);
    }
  };

  const propose = async (event: FormEvent) => {
    event.preventDefault();
    if (!base || !preview) return;
    setSubmitting(true);
    setError("");
    try {
      const change = await api<KnowledgeChangeRequest>("/api/knowledge/url-proposals", writeBody({
        knowledgeBaseId: base.id,
        collectionId: preview.collectionId,
        url: url.trim(),
        previewHash: preview.previewHash,
        title: title.trim(),
        reason: reason.trim(),
        requestedBy: "workbench-operator",
        selectedRelations: Object.entries(selectedRelations).map(([candidateId, selection]) => ({
          candidateId,
          type: selection.type,
          note: selection.note.trim() || undefined
        }))
      }));
      notify(`已生成待审批提案「${change.title}」；人工批准后也只生成 draft Revision，不会自动发布`);
      await onProposed(change);
    } catch (reason_) {
      setError(reason_ instanceof Error ? reason_.message : String(reason_));
    } finally {
      setSubmitting(false);
    }
  };

  return <Modal title="从链接导入知识" eyebrow="URL IMPORT · FROZEN PREVIEW · PROPOSAL ONLY" onClose={onClose} wide>
    <div className="modal-body url-import">
      <ol className="import-steps">{IMPORT_STEPS.map((item) => <li key={item.step} className={item.step === step ? "current" : item.step < step ? "done" : ""} aria-current={item.step === step ? "step" : undefined}><b>{item.step}</b><span>{item.label}</span></li>)}</ol>
      {step === 1 && <form className="compact-form" onSubmit={runPreview}>
        <div className="project-connect-note"><strong>抓取在服务端执行，只支持 http/https。</strong><p>预览会冻结内容哈希与结构化文档；只有继续提交才会生成待审批变更提案，这里不会写入任何知识内容。</p></div>
        {!activeBases.length && <div className="inline-error">没有活动知识库；请先在“知识目录”建立或恢复知识库。</div>}
        <div className="form-grid two">
          <Field label="目标知识库"><SelectControl ariaLabel="目标知识库" value={base?.id ?? ""} emptyLabel="尚无活动知识库" options={activeBases.map((item) => ({ value: item.id, label: item.displayName, description: `${item.id} · Published R${item.publishedRevision ?? "—"}` }))} onChange={chooseBase} /></Field>
          <Field label="目标 Collection"><SelectControl ariaLabel="目标 Collection" value={collectionId} emptyLabel="知识库没有 Collection" options={(base?.collections ?? []).map((collection) => ({ value: collection.id, label: collection.displayName, description: `${collection.id} · ${collection.authority}` }))} onChange={setCollectionId} /></Field>
        </div>
        <Field label="链接 URL" hint="以 http:// 或 https:// 开头；页面会被解析为结构化文档并与当前 Revision 对比。">
          <input required type="url" placeholder="https://example.com/docs/page" disabled={!daemonAvailable || fetching} value={url} onChange={(event) => setUrl(event.target.value)} />
        </Field>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!daemonAvailable || fetching || !base || !collectionId || !url.trim()}>{fetching ? "抓取并解析中…" : "生成冻结预览"}</button></div>
      </form>}
      {step === 2 && preview && <div className="url-import-preview">
        <div className="project-connect-note"><strong>预览已冻结，内容后续变化会让提案失败并要求重新预览。</strong><p>请核对解析出的结构化文档与关联候选；确认后再进入人工勾选。</p></div>
        <dl className="ledger url-import-hash">
          <dt>预览哈希</dt><dd><code>{preview.previewHash}</code></dd>
          <dt>内容 SHA-256</dt><dd><code>{preview.contentSha256}</code></dd>
          <dt>最终 URL</dt><dd><code>{preview.finalUrl}</code></dd>
          <dt>抓取信息</dt><dd>{preview.contentType} · {preview.byteLength} B · {formatTime(preview.fetchedAt)}{preview.redirects.length ? ` · ${preview.redirects.length} 次跳转` : ""}</dd>
          <dt>目标</dt><dd>{preview.knowledgeBaseId} v{preview.knowledgeBaseVersion} · {preview.collectionId} · 基于 R{preview.baseRevision ?? "—"}</dd>
        </dl>
        <section className="url-import-docs"><header><span>PARSED DOCUMENTS</span><h3>结构化文档 · {preview.documents.length}</h3></header>
          {preview.documents.length ? preview.documents.map((document) => <article key={document.id}>
            <header><strong>{document.title}</strong><code>{document.id}</code></header>
            <p>{document.content}</p>
            <footer>{document.sourceRef ?? "—"}{document.parentId ? ` · 上级 ${document.parentId}` : ""}</footer>
          </article>) : <p className="muted">页面没有解析出可导入的文档；返回更换链接。</p>}
        </section>
        <p className="muted">检测到 {preview.relationCandidates.length} 条与现有文档的关联候选，下一步逐条人工确认。</p>
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setStep(1)}>上一步</button><button type="button" className="button primary" disabled={preview.documents.length === 0} onClick={() => setStep(3)}>下一步：人工确认关联</button></div>
      </div>}
      {step === 3 && preview && <form className="compact-form" onSubmit={propose}>
        <div className="project-connect-note"><strong>提交只生成待审批变更提案。</strong><p>即使人工批准，执行结果也只是新的 draft Revision；不会自动发布，员工读取的 Published Revision 不变。</p></div>
        <fieldset className="url-import-relations" disabled={!daemonAvailable || submitting}>
          <legend>关联候选 · 人工勾选后才会写入（已选 {Object.keys(selectedRelations).length} / {preview.relationCandidates.length}）</legend>
          {preview.relationCandidates.length === 0 && <p className="muted">没有关联候选；导入的文档将以孤立条目进入草稿。</p>}
          {preview.relationCandidates.map((candidate) => {
            const selection = selectedRelations[candidate.id];
            return <article className={selection ? "selected" : ""} key={candidate.id}>
              <label className="url-import-relation-check">
                <input type="checkbox" checked={Boolean(selection)} onChange={(event) => setSelectedRelations((current) => {
                  const next = { ...current };
                  if (event.target.checked) next[candidate.id] = { type: "related", note: "" };
                  else delete next[candidate.id];
                  return next;
                })} />
                <span><strong>{candidateSourceTitle(candidate.sourceDocumentId)}</strong><small>→ 现有文档 <code>{candidate.targetDocumentId}</code> · score {candidate.score.toFixed(1)} · {candidate.signals.join("；")}</small></span>
              </label>
              {selection && <div className="url-import-relation-form">
                <Field label="关系类型"><SelectControl ariaLabel={`候选 ${candidate.id} 关系类型`} value={selection.type} options={(Object.entries(REFERENCE_TYPE_COPY) as Array<[KnowledgeReferenceType, string]>).map(([value, label]) => ({ value, label }))} onChange={(type) => setSelectedRelations((current) => ({ ...current, [candidate.id]: { ...selection, type: type as KnowledgeReferenceType } }))} /></Field>
                <Field label="备注（可选）"><input value={selection.note} onChange={(event) => setSelectedRelations((current) => ({ ...current, [candidate.id]: { ...selection, note: event.target.value } }))} /></Field>
              </div>}
            </article>;
          })}
        </fieldset>
        <Field label="提案标题"><input required disabled={!daemonAvailable || submitting} value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
        <Field label="提案理由"><textarea required rows={3} disabled={!daemonAvailable || submitting} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" disabled={submitting} onClick={() => setStep(2)}>上一步</button><button className="button primary" disabled={!daemonAvailable || submitting || !title.trim() || !reason.trim()}>{submitting ? "生成提案中…" : "生成待审批变更提案"}</button></div>
      </form>}
    </div>
  </Modal>;
}
