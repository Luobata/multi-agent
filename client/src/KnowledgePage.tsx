import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, writeBody } from "./api";
import {
  ConversationComposer,
  ConversationMessageEvidence,
  type ComposerDraft
} from "./ConversationComposer";
import {
  DossierSection,
  EmptyState,
  Field,
  Modal,
  SelectControl,
  Stamp,
  UtilityIcon,
  formatTime,
  useDaemonAvailable,
  type StampStatus
} from "./components";
import type {
  Bootstrap,
  KnowledgeActivation,
  KnowledgeAuthority,
  KnowledgeBase,
  KnowledgeBaseDetail,
  KnowledgeChangeOperationType,
  KnowledgeChangeRequest,
  KnowledgeChangeStatus,
  KnowledgeClassification,
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeGrantReviewItem,
  KnowledgeGrantReviewLedger,
  KnowledgeImpactSnapshot,
  KnowledgeProfile,
  KnowledgeReferenceType,
  KnowledgeRevisionAssessment,
  KnowledgeRevisionPreview,
  KnowledgeSource,
  KnowledgeUrlPreview,
  KnowledgeWikiDocument,
  KnowledgeWikiView,
  Project,
  Session
} from "./types";
import {
  KnowledgePerspectiveExplorer,
  ReviewStamp,
  grantScheduleCopy,
  grantSourceCopy,
  reviewSubjectLabel
} from "./knowledgePerspective";

interface PageProps {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: "success" | "error") => void;
}

interface KnowledgeBaseDraft {
  id: string;
  displayName: string;
  description: string;
  domain: string;
  product: string;
  projectId: string;
  classification: KnowledgeClassification;
  collections: KnowledgeCollection[];
  sources: KnowledgeSource[];
  initialTitle: string;
  initialContent: string;
}

function emptyCollection(index = 1): KnowledgeCollection {
  return {
    id: index === 1 ? "general" : `collection-${index}`,
    displayName: index === 1 ? "通用资料" : `资料分区 ${index}`,
    description: "这组资料服务的主题和边界。",
    authority: "canonical",
    tags: []
  };
}

function baseDraft(knowledgeBase?: KnowledgeBase): KnowledgeBaseDraft {
  return {
    id: knowledgeBase?.id ?? "",
    displayName: knowledgeBase?.displayName ?? "",
    description: knowledgeBase?.description ?? "",
    domain: knowledgeBase?.domain ?? "general",
    product: knowledgeBase?.product ?? "",
    projectId: knowledgeBase?.projectId ?? "",
    classification: knowledgeBase?.classification ?? "internal",
    collections: knowledgeBase?.collections.map((collection) => ({ ...collection, tags: [...collection.tags] })) ?? [emptyCollection()],
    sources: knowledgeBase?.sources.map((source) => ({ ...source })) ?? [],
    initialTitle: "",
    initialContent: ""
  };
}

function list(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function KnowledgeBaseEditor({ knowledgeBase, onClose, onSaved, notify }: {
  knowledgeBase?: KnowledgeBase;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
  notify: PageProps["notify"];
}) {
  const daemonAvailable = useDaemonAvailable();
  const [draft, setDraft] = useState(() => baseDraft(knowledgeBase));
  const [saving, setSaving] = useState(false);
  const patchCollection = (index: number, patch: Partial<KnowledgeCollection>) => setDraft((current) => ({
    ...current,
    collections: current.collections.map((collection, candidate) => candidate === index ? { ...collection, ...patch } : collection)
  }));
  const patchSource = (index: number, patch: Partial<KnowledgeSource>) => setDraft((current) => ({
    ...current,
    sources: current.sources.map((source, candidate) => candidate === index ? { ...source, ...patch } : source)
  }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        id: draft.id.trim(),
        displayName: draft.displayName.trim(),
        description: draft.description.trim(),
        domain: draft.domain.trim(),
        product: draft.product.trim() || undefined,
        projectId: draft.projectId.trim() || undefined,
        classification: draft.classification,
        collections: draft.collections.map((collection) => ({
          ...collection,
          id: collection.id.trim(),
          displayName: collection.displayName.trim(),
          description: collection.description.trim(),
          tags: collection.tags
        })),
        sources: draft.sources.filter((source) => source.location.trim()).map((source) => ({
          ...source,
          id: source.id.trim(),
          location: source.location.trim(),
          collectionId: source.collectionId || draft.collections[0]?.id
        })),
        documents: !knowledgeBase && draft.initialContent.trim() ? [{
          id: "first-note",
          title: draft.initialTitle.trim() || draft.displayName.trim(),
          content: draft.initialContent.trim(),
          collectionId: draft.collections[0]?.id
        }] : undefined,
        publish: false
      };
      const saved = await api<KnowledgeBase>(
        knowledgeBase ? `/api/knowledge-bases/${knowledgeBase.id}` : "/api/knowledge-bases",
        writeBody(payload, knowledgeBase ? "PATCH" : "POST")
      );
      notify(knowledgeBase ? `${saved.displayName} 已修订为定义 v${saved.version}` : `${saved.displayName} 已建立`);
      await onSaved(saved.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };

  return <Modal title={knowledgeBase ? `修订 ${knowledgeBase.displayName}` : "建立知识库"} eyebrow="KNOWLEDGE CATALOG · VERSIONED" onClose={onClose} wide>
    <form className="editor-form knowledge-editor" onSubmit={submit}>
      <fieldset className="daemon-write-surface" disabled={!daemonAvailable}>
        <DossierSection number="01" title="目录身份"><div className="form-grid two"><Field label="知识库 ID"><input required disabled={Boolean(knowledgeBase)} pattern="[a-z][a-z0-9-]*" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></Field><Field label="显示名"><input required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field></div><Field label="边界说明"><textarea required rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field><div className="form-grid three"><Field label="领域"><input required pattern="[a-z][a-z0-9-]*" value={draft.domain} onChange={(event) => setDraft({ ...draft, domain: event.target.value })} /></Field><Field label="产品（可选）"><input pattern="[a-z][a-z0-9-]*" value={draft.product} onChange={(event) => setDraft({ ...draft, product: event.target.value })} /></Field><Field label="项目（可选）"><input pattern="[a-z][a-z0-9-]*" value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.target.value })} /></Field></div><Field label="敏感度"><SelectControl ariaLabel="知识库敏感度" value={draft.classification} options={[{ value: "internal", label: "内部", description: "普通内部资料" }, { value: "confidential", label: "机密", description: "需要受控 Profile" }, { value: "restricted", label: "严格受限", description: "仅显式规则可用" }]} onChange={(classification) => setDraft({ ...draft, classification: classification as KnowledgeClassification })} /></Field></DossierSection>
        <DossierSection number="02" title="Collection 分区" action={<button type="button" className="text-button" onClick={() => setDraft({ ...draft, collections: [...draft.collections, emptyCollection(draft.collections.length + 1)] })}>增加分区</button>}><div className="knowledge-form-stack">{draft.collections.map((collection, index) => <article className="knowledge-form-card" key={`${collection.id}-${index}`}><div className="form-grid three"><Field label="Collection ID"><input required pattern="[a-z][a-z0-9-]*" value={collection.id} onChange={(event) => patchCollection(index, { id: event.target.value })} /></Field><Field label="名称"><input required value={collection.displayName} onChange={(event) => patchCollection(index, { displayName: event.target.value })} /></Field><Field label="权威级别"><SelectControl ariaLabel={`${collection.displayName}权威级别`} value={collection.authority} options={[{ value: "canonical", label: "正式依据" }, { value: "reference", label: "参考资料" }, { value: "experimental", label: "实验材料" }]} onChange={(authority) => patchCollection(index, { authority: authority as KnowledgeAuthority })} /></Field></div><Field label="说明"><input required value={collection.description} onChange={(event) => patchCollection(index, { description: event.target.value })} /></Field><Field label="检索标签" hint="逗号分隔；只使用受控、稳定的主题词。"><input value={collection.tags.join(", ")} onChange={(event) => patchCollection(index, { tags: list(event.target.value) })} /></Field>{draft.collections.length > 1 && <button type="button" className="text-button danger-text" onClick={() => setDraft({ ...draft, collections: draft.collections.filter((_, candidate) => candidate !== index), sources: draft.sources.filter((source) => source.collectionId !== collection.id) })}>移除分区</button>}</article>)}</div></DossierSection>
        <DossierSection number="03" title="同步来源" action={<button type="button" className="text-button" onClick={() => setDraft({ ...draft, sources: [...draft.sources, { id: `source-${draft.sources.length + 1}`, kind: "directory", location: "", collectionId: draft.collections[0]?.id ?? "general" }] })}>增加来源</button>}><div className="knowledge-form-stack">{draft.sources.length ? draft.sources.map((source, index) => <article className="knowledge-form-card compact" key={`${source.id}-${index}`}><div className="form-grid three"><Field label="Source ID"><input required pattern="[a-z][a-z0-9-]*" value={source.id} onChange={(event) => patchSource(index, { id: event.target.value })} /></Field><Field label="类型"><SelectControl ariaLabel={`${source.id}来源类型`} value={source.kind} options={[{ value: "directory", label: "本地目录" }, { value: "file", label: "单个文件" }]} onChange={(kind) => patchSource(index, { kind: kind as KnowledgeSource["kind"] })} /></Field><Field label="进入分区"><SelectControl ariaLabel={`${source.id}目标分区`} value={source.collectionId} options={draft.collections.map((collection) => ({ value: collection.id, label: collection.displayName }))} onChange={(collectionId) => patchSource(index, { collectionId })} /></Field></div><Field label="本地绝对路径"><input required value={source.location} onChange={(event) => patchSource(index, { location: event.target.value })} /></Field><button type="button" className="text-button danger-text" onClick={() => setDraft({ ...draft, sources: draft.sources.filter((_, candidate) => candidate !== index) })}>移除来源</button></article>) : <p className="muted">可以先建立人工知识，稍后再关联文件或目录。</p>}</div></DossierSection>
        {!knowledgeBase && <DossierSection number="04" title="首份人工知识"><Field label="标题"><input value={draft.initialTitle} onChange={(event) => setDraft({ ...draft, initialTitle: event.target.value })} /></Field><Field label="正文" hint="填写后创建草稿 Revision 1；完成质检和影响确认后再显式发布。"><textarea rows={8} value={draft.initialContent} onChange={(event) => setDraft({ ...draft, initialContent: event.target.value })} /></Field></DossierSection>}
      </fieldset>
      <div className="editor-savebar"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!daemonAvailable || saving}>{saving ? "保存中…" : knowledgeBase ? `保存为定义 v${knowledgeBase.version + 1}` : "建立知识库"}</button></div>
    </form>
  </Modal>;
}

function RevisionEditor({ detail, onClose, onSaved, notify }: {
  detail: KnowledgeBaseDetail;
  onClose: () => void;
  onSaved: () => Promise<void>;
  notify: PageProps["notify"];
}) {
  const daemonAvailable = useDaemonAvailable();
  const [documents, setDocuments] = useState<KnowledgeDocument[]>(() => detail.latestRevision?.documents.map((document) => ({ ...document })) ?? []);
  const [selectedId, setSelectedId] = useState(documents[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const selected = documents.find((document) => document.id === selectedId);
  const add = () => {
    let index = documents.length + 1;
    while (documents.some((document) => document.id === `note-${index}`)) index += 1;
    const document: KnowledgeDocument = { id: `note-${index}`, title: "新知识条目", content: "", collectionId: detail.knowledgeBase.collections[0]?.id ?? "general", updatedAt: new Date().toISOString() };
    setDocuments([...documents, document]);
    setSelectedId(document.id);
  };
  const patch = (value: Partial<KnowledgeDocument>) => setDocuments((current) => current.map((document) => document.id === selectedId ? { ...document, ...value } : document));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const revision = await api<{ revision: number }>(`/api/knowledge-bases/${detail.knowledgeBase.id}/revisions`, writeBody({ documents }));
      notify(`已生成 Revision ${revision.revision}；发布前不会影响员工`);
      await onSaved();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setSaving(false); }
  };
  return <Modal title="改进知识内容" eyebrow={`${detail.knowledgeBase.id} · DRAFT REVISION`} onClose={onClose} wide><form className="editor-form revision-editor" onSubmit={submit}><fieldset disabled={!daemonAvailable}><div className="revision-editor-grid"><aside><button type="button" className="button secondary full" onClick={add}>新增人工条目</button>{documents.map((document) => <button type="button" className={document.id === selectedId ? "selected" : ""} key={document.id} onClick={() => setSelectedId(document.id)}><strong>{document.title}</strong><code>{document.id}</code><small>{document.sourceId ? `同步自 ${document.sourceId}` : "人工维护"}</small></button>)}</aside><section>{selected ? <><div className="form-grid two"><Field label="Document ID"><input required pattern="[a-z][a-z0-9-]*" value={selected.id} onChange={(event) => { const previous = selected.id; const id = event.target.value; setDocuments((current) => current.map((document) => document.id === previous ? { ...document, id } : document)); setSelectedId(id); }} /></Field><Field label="Collection"><SelectControl ariaLabel="知识条目分区" value={selected.collectionId} options={detail.knowledgeBase.collections.map((collection) => ({ value: collection.id, label: collection.displayName }))} onChange={(collectionId) => patch({ collectionId })} /></Field></div><Field label="标题"><input required value={selected.title} onChange={(event) => patch({ title: event.target.value })} /></Field><Field label="正文"><textarea required rows={16} value={selected.content} onChange={(event) => patch({ content: event.target.value })} /></Field><button type="button" className="text-button danger-text" onClick={() => { const remaining = documents.filter((document) => document.id !== selected.id); setDocuments(remaining); setSelectedId(remaining[0]?.id ?? ""); }}>移除条目</button></> : <div className="mini-empty">新增一条人工知识开始编辑。</div>}</section></div></fieldset><div className="editor-savebar"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={saving || !documents.length}>{saving ? "生成中…" : "生成草稿 Revision"}</button></div></form></Modal>;
}

type KnowledgeConsoleTab = "overview" | "catalog" | "wiki" | "releases" | "profiles" | "impact" | "reviews" | "assistant";

const REFERENCE_TYPE_COPY: Record<KnowledgeReferenceType, string> = {
  related: "相关",
  supports: "支持",
  contradicts: "矛盾",
  "depends-on": "依赖",
  supersedes: "取代"
};

function assessmentCopy(status: KnowledgeRevisionAssessment["status"] | undefined): string {
  if (status === "ready") return "可发布";
  if (status === "attention") return "需确认";
  if (status === "blocked") return "阻塞";
  return "未检查";
}

function assessmentStamp(status: KnowledgeRevisionAssessment["status"] | undefined): "active" | "pending" | "blocked" {
  if (status === "ready") return "active";
  if (status === "blocked") return "blocked";
  return "pending";
}

function AssessmentPanel({ assessment }: { assessment?: KnowledgeRevisionAssessment }) {
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

function RevisionPreviewModal({ knowledgeBase, revision, onClose, notify }: {
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

function PublishReviewModal({ knowledgeBase, revision, impact, onClose, onPublished, notify }: {
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

interface ProfilePolicyRuleDraft {
  id: string;
  activation: KnowledgeActivation;
  knowledgeBaseIds: string[];
  domains: string;
  products: string;
  scopeProjectIds: string;
  collectionIds: string;
  authorities: KnowledgeAuthority[];
  maxClassification: KnowledgeClassification;
  conditionProjectIds: string;
  projectRoleIds: string;
  taskTags: string;
  requestTerms: string;
  priority: number;
  required: boolean;
  maxCollections: number;
  maxChunks: number;
  maxTokens: number;
}

interface ProfilePolicyDraft {
  id: string;
  displayName: string;
  description: string;
  rules: ProfilePolicyRuleDraft[];
}

function policyRuleDraft(rule?: KnowledgeProfile["rules"][number], index = 0): ProfilePolicyRuleDraft {
  return {
    id: rule?.id ?? `rule-${index + 1}`,
    activation: rule?.activation ?? "on-demand",
    knowledgeBaseIds: [...(rule?.selector.knowledgeBaseIds ?? [])],
    domains: rule?.selector.domains?.join(", ") ?? "",
    products: rule?.selector.products?.join(", ") ?? "",
    scopeProjectIds: rule?.selector.projectIds?.join(", ") ?? "",
    collectionIds: rule?.selector.collectionIds?.join(", ") ?? "",
    authorities: [...(rule?.selector.authorities ?? ["canonical", "reference"])],
    maxClassification: rule?.selector.maxClassification ?? "internal",
    conditionProjectIds: rule?.conditions?.projectIds?.join(", ") ?? "",
    projectRoleIds: rule?.conditions?.projectRoleIds?.join(", ") ?? "",
    taskTags: rule?.conditions?.taskTags?.join(", ") ?? "",
    requestTerms: rule?.conditions?.requestTerms?.join(", ") ?? "",
    priority: rule?.priority ?? 0,
    required: rule?.required ?? false,
    maxCollections: rule?.budget.maxCollections ?? 3,
    maxChunks: rule?.budget.maxChunks ?? 4,
    maxTokens: rule?.budget.maxTokens ?? 2000
  };
}

function policyDraft(profile?: KnowledgeProfile): ProfilePolicyDraft {
  return {
    id: profile?.id ?? "",
    displayName: profile?.displayName ?? "",
    description: profile?.description ?? "",
    rules: profile?.rules.length ? profile.rules.map(policyRuleDraft) : [policyRuleDraft()]
  };
}

function ruleHasCatalogScope(rule: ProfilePolicyRuleDraft): boolean {
  return rule.knowledgeBaseIds.length > 0
    || list(rule.domains).length > 0
    || list(rule.products).length > 0
    || list(rule.scopeProjectIds).length > 0
    || list(rule.collectionIds).length > 0;
}

export function KnowledgeProfilePolicyEditor({ profile, knowledgeBases, onClose, onSaved, notify }: {
  profile?: KnowledgeProfile;
  knowledgeBases: KnowledgeBase[];
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
  notify: PageProps["notify"];
}) {
  const daemonAvailable = useDaemonAvailable();
  const [draft, setDraft] = useState(() => policyDraft(profile));
  const [saving, setSaving] = useState(false);
  const patchRule = (index: number, patch: Partial<ProfilePolicyRuleDraft>) => setDraft((current) => ({
    ...current,
    rules: current.rules.map((rule, candidate) => candidate === index ? { ...rule, ...patch } : rule)
  }));
  const valid = draft.rules.length > 0
    && draft.rules.every((rule) => ruleHasCatalogScope(rule) && rule.authorities.length > 0)
    && new Set(draft.rules.map((rule) => rule.id)).size === draft.rules.length;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) {
      notify("每条规则都需要唯一 ID、明确的目录范围和至少一个权威级别", "error");
      return;
    }
    setSaving(true);
    try {
      const rules = draft.rules.map((rule) => ({
        id: rule.id.trim(),
        selector: {
          knowledgeBaseIds: rule.knowledgeBaseIds.length ? rule.knowledgeBaseIds : undefined,
          domains: list(rule.domains).length ? list(rule.domains) : undefined,
          products: list(rule.products).length ? list(rule.products) : undefined,
          projectIds: list(rule.scopeProjectIds).length ? list(rule.scopeProjectIds) : undefined,
          collectionIds: list(rule.collectionIds).length ? list(rule.collectionIds) : undefined,
          authorities: rule.authorities,
          maxClassification: rule.maxClassification
        },
        activation: rule.activation,
        conditions: {
          projectIds: list(rule.conditionProjectIds).length ? list(rule.conditionProjectIds) : undefined,
          projectRoleIds: list(rule.projectRoleIds).length ? list(rule.projectRoleIds) : undefined,
          taskTags: list(rule.taskTags).length ? list(rule.taskTags) : undefined,
          requestTerms: list(rule.requestTerms).length ? list(rule.requestTerms) : undefined
        },
        priority: rule.priority,
        required: rule.required,
        budget: { maxCollections: rule.maxCollections, maxChunks: rule.maxChunks, maxTokens: rule.maxTokens }
      }));
      const payload = { id: draft.id.trim(), displayName: draft.displayName.trim(), description: draft.description.trim(), rules };
      const saved = await api<KnowledgeProfile>(profile ? `/api/knowledge-profiles/${profile.id}` : "/api/knowledge-profiles", writeBody(payload, profile ? "PATCH" : "POST"));
      notify(profile ? `${saved.displayName} 已更新为 v${saved.version}` : `${saved.displayName} 已建立`);
      await onSaved(saved.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };
  return <Modal title={profile ? `修订 ${profile.displayName}` : "建立知识 Profile"} eyebrow="REUSABLE KNOWLEDGE POLICY · MULTI RULE" onClose={onClose} wide>
    <form className="editor-form profile-policy-editor" onSubmit={submit}>
      <fieldset disabled={!daemonAvailable}>
        <DossierSection number="01" title="策略身份"><div className="form-grid two"><Field label="Profile ID"><input required disabled={Boolean(profile)} pattern="[a-z][a-z0-9-]*" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></Field><Field label="显示名"><input required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field></div><Field label="适用边界"><textarea required rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field></DossierSection>
        <DossierSection number="02" title={`选择与激活规则 · ${draft.rules.length}`} action={<button type="button" className="text-button" onClick={() => setDraft({ ...draft, rules: [...draft.rules, policyRuleDraft(undefined, draft.rules.length)] })}>增加规则</button>}>
          <div className="profile-policy-rules">{draft.rules.map((rule, index) => <article className={!ruleHasCatalogScope(rule) || rule.authorities.length === 0 ? "invalid" : ""} key={`${index}-${rule.id}`}>
            <header><div><span>{String(index + 1).padStart(2, "0")}</span><Field label="规则 ID"><input required pattern="[a-z][a-z0-9-]*" value={rule.id} onChange={(event) => patchRule(index, { id: event.target.value })} /></Field></div>{draft.rules.length > 1 && <button type="button" className="text-button danger-text" onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, candidate) => candidate !== index) })}>删除规则</button>}</header>
            <section><h3>目录范围</h3><div className="form-grid two"><Field label="领域" hint="逗号分隔；匹配新知识库时会自动进入候选。"><input value={rule.domains} onChange={(event) => patchRule(index, { domains: event.target.value })} /></Field><Field label="Collection ID"><input value={rule.collectionIds} onChange={(event) => patchRule(index, { collectionIds: event.target.value })} /></Field><Field label="产品 ID"><input value={rule.products} onChange={(event) => patchRule(index, { products: event.target.value })} /></Field><Field label="知识所属项目"><input value={rule.scopeProjectIds} onChange={(event) => patchRule(index, { scopeProjectIds: event.target.value })} /></Field></div><fieldset className="knowledge-base-choices"><legend>显式知识库</legend>{knowledgeBases.filter((item) => item.status === "active" || rule.knowledgeBaseIds.includes(item.id)).map((item) => <label key={item.id}><input type="checkbox" checked={rule.knowledgeBaseIds.includes(item.id)} onChange={(event) => patchRule(index, { knowledgeBaseIds: event.target.checked ? [...rule.knowledgeBaseIds, item.id] : rule.knowledgeBaseIds.filter((id) => id !== item.id) })} /><span><strong>{item.displayName}</strong><small>{item.domain} · Published R{item.publishedRevision ?? "—"}</small></span></label>)}</fieldset>{!ruleHasCatalogScope(rule) && <p className="inline-error">至少限定知识库、领域、产品、项目或 Collection 之一。</p>}</section>
            <section><h3>信任边界</h3><div className="form-grid two"><Field label="最高敏感度"><SelectControl ariaLabel={`规则 ${rule.id} 最高敏感度`} value={rule.maxClassification} options={[{ value: "internal", label: "内部" }, { value: "confidential", label: "机密" }, { value: "restricted", label: "严格受限" }]} onChange={(maxClassification) => patchRule(index, { maxClassification: maxClassification as KnowledgeClassification })} /></Field><fieldset className="profile-authority-choices"><legend>允许权威级别</legend>{(["canonical", "reference", "experimental"] as KnowledgeAuthority[]).map((authority) => <label key={authority}><input type="checkbox" checked={rule.authorities.includes(authority)} onChange={(event) => patchRule(index, { authorities: event.target.checked ? [...rule.authorities, authority] : rule.authorities.filter((item) => item !== authority) })} />{authority}</label>)}</fieldset></div>{rule.authorities.length === 0 && <p className="inline-error">至少允许一个权威级别。</p>}</section>
            <section><h3>激活上下文</h3><div className="form-grid three"><Field label="模式"><SelectControl ariaLabel={`规则 ${rule.id} 激活模式`} value={rule.activation} options={[{ value: "core", label: "Core", description: "每次有资格参与" }, { value: "conditional", label: "Conditional", description: "条件匹配后参与" }, { value: "on-demand", label: "On demand", description: "相关时才参与" }]} onChange={(activation) => patchRule(index, { activation: activation as KnowledgeActivation })} /></Field><Field label="优先级"><input type="number" min={-100} max={100} value={rule.priority} onChange={(event) => patchRule(index, { priority: Number(event.target.value) })} /></Field><label className="plain-check policy-required"><input type="checkbox" checked={rule.required} onChange={(event) => patchRule(index, { required: event.target.checked })} />预算冲突时优先保留</label></div><div className="form-grid two"><Field label="调用项目"><input value={rule.conditionProjectIds} onChange={(event) => patchRule(index, { conditionProjectIds: event.target.value })} /></Field><Field label="项目角色"><input value={rule.projectRoleIds} onChange={(event) => patchRule(index, { projectRoleIds: event.target.value })} /></Field><Field label="任务标签"><input value={rule.taskTags} onChange={(event) => patchRule(index, { taskTags: event.target.value })} /></Field><Field label="请求词项"><input value={rule.requestTerms} onChange={(event) => patchRule(index, { requestTerms: event.target.value })} /></Field></div></section>
            <section><h3>单次容量预算</h3><div className="form-grid three"><Field label="最多 Collection"><input type="number" min={1} max={12} value={rule.maxCollections} onChange={(event) => patchRule(index, { maxCollections: Number(event.target.value) })} /></Field><Field label="最多 Chunk"><input type="number" min={1} max={20} value={rule.maxChunks} onChange={(event) => patchRule(index, { maxChunks: Number(event.target.value) })} /></Field><Field label="最多 Token"><input type="number" min={128} max={16000} value={rule.maxTokens} onChange={(event) => patchRule(index, { maxTokens: Number(event.target.value) })} /></Field></div></section>
          </article>)}</div>
        </DossierSection>
      </fieldset>
      <div className="editor-savebar"><span className="policy-save-summary">{draft.rules.length} 条规则 · {draft.rules.filter(ruleHasCatalogScope).length} 条范围完整</span><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!daemonAvailable || saving || !valid}>{saving ? "保存中…" : profile ? `保存为 v${profile.version + 1}` : "建立 Profile"}</button></div>
    </form>
  </Modal>;
}

export const KNOWLEDGE_STEWARD_ROLE_ID = "knowledge-steward";

export function findKnowledgeStewardProjects(data: Bootstrap): Project[] {
  const boundRoles = new Map<string, Set<string>>();
  for (const binding of data.projectBindings) {
    boundRoles.set(binding.projectId, new Set(binding.roles.map((role) => role.roleId)));
  }
  return data.projects.filter((project) =>
    project.status === "active"
    && project.roles.some((role) => role.id === KNOWLEDGE_STEWARD_ROLE_ID)
    && (boundRoles.get(project.id)?.has(KNOWLEDGE_STEWARD_ROLE_ID) ?? false)
  );
}

export function listKnowledgeStewardSessions(data: Bootstrap): Session[] {
  return data.sessions
    .filter((session) => session.assignment?.roleId === KNOWLEDGE_STEWARD_ROLE_ID)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

const CHANGE_STATUS_COPY: Record<KnowledgeChangeStatus, string> = {
  "awaiting-approval": "待人工批准",
  applying: "执行中",
  applied: "已应用",
  rejected: "已拒绝",
  cancelled: "已取消",
  failed: "执行失败",
  "needs-reapproval": "需重新提案"
};

export function knowledgeChangeStamp(status: KnowledgeChangeStatus): { status: StampStatus; label: string } {
  switch (status) {
    case "awaiting-approval": return { status: "pending", label: CHANGE_STATUS_COPY[status] };
    case "applying": return { status: "running", label: CHANGE_STATUS_COPY[status] };
    case "applied": return { status: "passed", label: CHANGE_STATUS_COPY[status] };
    case "rejected": return { status: "blocked", label: CHANGE_STATUS_COPY[status] };
    case "cancelled": return { status: "archived", label: CHANGE_STATUS_COPY[status] };
    case "failed": return { status: "failed", label: CHANGE_STATUS_COPY[status] };
    case "needs-reapproval": return { status: "blocked", label: CHANGE_STATUS_COPY[status] };
  }
}

const OPERATION_COPY: Record<KnowledgeChangeOperationType, string> = {
  "knowledge-base.create": "建立知识库",
  "knowledge-base.update": "修订知识库",
  "knowledge-base.sync": "同步知识库来源",
  "knowledge-base.archive": "归档知识库",
  "knowledge-base.restore": "恢复知识库",
  "knowledge-revision.create": "生成知识 Revision",
  "knowledge-revision.publish": "发布 / 回滚 Revision",
  "knowledge-profile.create": "建立知识 Profile",
  "knowledge-profile.update": "修订知识 Profile",
  "knowledge-profile.archive": "归档知识 Profile",
  "knowledge-profile.restore": "恢复知识 Profile",
  "employee-profiles.set": "调整员工知识 Profile 授权",
  "project-role-profiles.set": "调整项目角色知识 Profile 授权"
};

const RISK_COPY: Record<KnowledgeChangeRequest["risk"], string> = {
  medium: "中",
  high: "高",
  critical: "严重"
};

type ChangeDecisionKind = "approve" | "reject" | "cancel";

interface ChangeDecision {
  kind: ChangeDecisionKind;
  change: KnowledgeChangeRequest;
}

const DECISION_COPY: Record<ChangeDecisionKind, { title: string; note: string; confirm: string }> = {
  approve: {
    title: "批准变更提案",
    note: "批准后 Core 会重新校验目标版本、质量与影响；任何变化都会让提案转为“需重新提案”，旧审批不会继续生效。",
    confirm: "确认批准并执行"
  },
  reject: {
    title: "拒绝变更提案",
    note: "拒绝只关闭这份提案，不会修改任何知识内容、发布指针或授权关系。",
    confirm: "确认拒绝"
  },
  cancel: {
    title: "取消变更提案",
    note: "取消后提案关闭；知识管家可以基于当前状态重新生成一份新提案。",
    confirm: "确认取消提案"
  }
};

function KnowledgeChangeCard({ change, busy, onDecide }: {
  change: KnowledgeChangeRequest;
  busy: boolean;
  onDecide: (decision: ChangeDecision) => void;
}) {
  const daemonAvailable = useDaemonAvailable();
  const stamp = knowledgeChangeStamp(change.status);
  const awaiting = change.status === "awaiting-approval";
  const actionable = awaiting || change.status === "needs-reapproval";
  const impactGroups: Array<{ label: string; ids: string[] }> = [
    { label: "知识库", ids: change.preview.impact.knowledgeBaseIds },
    { label: "Profile", ids: change.preview.impact.profileIds },
    { label: "员工", ids: change.preview.impact.employeeIds },
    { label: "项目角色", ids: change.preview.impact.projectRoles }
  ];
  return <article className="change-card" data-status={change.status}>
    <header className="change-card-head">
      <div className="change-card-title">
        <span className="change-kind">{OPERATION_COPY[change.operation.type]}</span>
        <h3>{change.title}</h3>
        <code>{change.id}</code>
      </div>
      <div className="change-card-badges">
        <span className={`change-risk change-risk--${change.risk}`}>风险 {RISK_COPY[change.risk]}</span>
        <Stamp status={stamp.status} label={stamp.label} />
      </div>
    </header>
    <p className="change-summary">{change.preview.summary}</p>
    <p className="change-reason"><span>理由</span>{change.reason}</p>
    {change.preview.warnings.length > 0 && <ul className="change-warnings">
      {change.preview.warnings.map((warning) => <li key={warning}><strong>提醒</strong>{warning}</li>)}
    </ul>}
    <div className="change-impact">
      <span className="change-impact-title">影响范围</span>
      <div className="change-impact-grid">{impactGroups.map((group) => <div className="change-impact-group" key={group.label}>
        <span>{group.label} · {group.ids.length}</span>
        <code>{group.ids.length ? group.ids.join("、") : "无直接影响"}</code>
      </div>)}</div>
    </div>
    <dl className="change-ledger">
      <dt>目标</dt><dd>{change.operation.targetId ?? "（新建目标）"}</dd>
      {change.operation.projectId && <><dt>项目角色</dt><dd>{change.operation.projectId}/{change.operation.roleId ?? "—"}</dd></>}
      {change.preview.expectedVersion !== undefined && <><dt>版本基准</dt><dd>v{change.preview.beforeVersion ?? "—"} → v{change.preview.expectedVersion}</dd></>}
      <dt>计划哈希</dt><dd><code>{change.planHash}</code></dd>
      <dt>发起</dt><dd>{change.requestedBy} · {formatTime(change.createdAt)}</dd>
      {change.appliedAt && <><dt>应用时间</dt><dd>{formatTime(change.appliedAt)}</dd></>}
    </dl>
    {change.approval && <p className={`change-approval change-approval--${change.approval.decision}`}>
      <strong>{change.approval.decision === "approved" ? "人工批准" : "人工拒绝"}</strong>
      <span>{change.approval.actor} · {formatTime(change.approval.at)}{change.approval.comment ? ` · ${change.approval.comment}` : ""}</span>
    </p>}
    {change.error && <p className="inline-error change-error">{change.error}</p>}
    {change.status === "needs-reapproval" && <p className="change-reapproval-note">目标版本或影响范围已变化，旧审批已失效。请取消此提案，并让知识管家基于当前状态重新生成。</p>}
    {actionable && <footer className="change-actions">
      {awaiting && <>
        <button type="button" className="button primary" disabled={!daemonAvailable || busy} onClick={() => onDecide({ kind: "approve", change })}>批准并执行</button>
        <button type="button" className="button danger" disabled={!daemonAvailable || busy} onClick={() => onDecide({ kind: "reject", change })}>拒绝</button>
      </>}
      <button type="button" className="button ghost" disabled={!daemonAvailable || busy} onClick={() => onDecide({ kind: "cancel", change })}>取消提案</button>
    </footer>}
  </article>;
}

const STEWARD_QUICK_PROMPTS = [
  "检查所有待发布草稿的质检结果和影响范围",
  "同步运营文档知识库并生成发布提案",
  "解释哪些员工和项目角色目前能看到机密知识"
];

export function KnowledgeStewardConsole({ data, refresh, notify }: PageProps) {
  const daemonAvailable = useDaemonAvailable();
  const stewardProjects = useMemo(() => findKnowledgeStewardProjects(data), [data]);
  const sessions = useMemo(() => listKnowledgeStewardSessions(data), [data]);
  const changes = useMemo(() => data.knowledgeChanges ?? [], [data]);
  const pendingChanges = changes.filter((change) => change.status === "awaiting-approval" || change.status === "needs-reapproval");
  const [sessionId, setSessionId] = useState("");
  const [freshSession, setFreshSession] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [decision, setDecision] = useState<ChangeDecision>();
  const [comment, setComment] = useState("");
  const [deciding, setDeciding] = useState(false);
  // 默认打开最新会话，刷新后历史立即可见；显式点击“新会话”才进入欢迎态。
  const selectedSession = freshSession ? undefined : sessions.find((session) => session.id === sessionId) ?? sessions[0];
  const stewardProject = stewardProjects.find((project) => project.id === selectedSession?.assignment?.projectId) ?? stewardProjects[0];
  const stewardRole = stewardProject?.roles.find((role) => role.id === KNOWLEDGE_STEWARD_ROLE_ID);
  const stewardName = stewardRole?.displayName ?? "知识管家";

  useEffect(() => {
    if (!freshSession && sessionId && !sessions.some((session) => session.id === sessionId)) setSessionId("");
  }, [sessions, sessionId, freshSession]);

  const send = async (draft: ComposerDraft): Promise<boolean> => {
    if (!stewardProject) return false;
    try {
      const result = await api<{ session: Session; runId: string; status: string; message: string }>(
        `/api/projects/${stewardProject.id}/roles/${KNOWLEDGE_STEWARD_ROLE_ID}/invoke`,
        {
          ...writeBody({
            message: draft.message,
            sessionId: freshSession ? undefined : selectedSession?.id,
            ...(draft.attachments.length > 0 ? { attachments: draft.attachments } : {})
          }),
          headers: {
            "x-multi-agent-source": "workbench",
            "x-multi-agent-source-label": "知识控制台 · AI 管理",
            "x-multi-agent-project": stewardProject.id
          }
        }
      );
      setSessionId(result.session.id);
      setFreshSession(false);
      notify(result.status === "blocked" ? "知识管家给出了业务阻塞结论" : `知识管家已完成回复 · ${result.runId}`);
      await refresh();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      return false;
    }
  };

  const submitDecision = async (event: FormEvent) => {
    event.preventDefault();
    if (!decision) return;
    setDeciding(true);
    try {
      const updated = await api<KnowledgeChangeRequest>(
        `/api/knowledge-changes/${decision.change.id}/${decision.kind}`,
        writeBody(decision.kind === "cancel" ? {} : { comment: comment.trim() || undefined })
      );
      if (decision.kind === "approve") {
        notify(updated.status === "applied" ? `「${updated.title}」已批准并应用` : `「${updated.title}」已批准，但执行失败：${updated.error ?? "未知错误"}`, updated.status === "applied" ? "success" : "error");
      } else {
        notify(decision.kind === "reject" ? `「${updated.title}」已拒绝；知识状态未修改` : `「${updated.title}」已取消`);
      }
      setDecision(undefined);
      setComment("");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      await refresh();
    } finally {
      setDeciding(false);
    }
  };

  return <div className="knowledge-console-workspace page-grid steward-console" role="tabpanel">
    <aside className="record-list steward-session-list">
      <header className="list-header"><h2>知识会话</h2><button className="square-action" disabled={!daemonAvailable || !stewardProjects.length} onClick={() => { setSessionId(""); setFreshSession(true); }} aria-label="新的知识会话"><UtilityIcon name="add" /></button></header>
      <div className="record-scroll">
        {sessions.map((session) => <button type="button" className={`steward-session-item ${session.id === selectedSession?.id ? "selected" : ""}`} key={session.id} onClick={() => { setSessionId(session.id); setFreshSession(false); }}>
          <span><strong>{session.title}</strong><code>{session.id}</code><small>{session.assignment?.projectId} · {session.messages.length} 条 · {formatTime(session.updatedAt)}</small></span>
        </button>)}
        {!sessions.length && <p className="steward-session-empty">尚无知识会话。发送第一条消息后会自动建立，并固定当前项目任用版本。</p>}
      </div>
      <footer className="list-footer"><span>{sessions.length} 个会话</span><span>STEWARD</span></footer>
    </aside>
    <main className="detail-pane steward-main">
      {!stewardProject ? <EmptyState title="还没有项目接入知识管家">
        AI 管理只通过已连接且已绑定 <code>{KNOWLEDGE_STEWARD_ROLE_ID}</code> 项目角色工作。请先在项目接入页完成任用，再回到这里开始会话；这里不会直接调用任何 Employee。
      </EmptyState> : <>
        <header className="steward-header">
          <div><span className="console-kicker">KNOWLEDGE STEWARD · PROJECT ROLE</span><h2>{stewardName}</h2><p>{stewardProject.name} · {stewardProject.id} · 会话固定项目任用版本，读取即时返回，变更必须人工批准。</p></div>
          <div className="steward-header-vitals"><span><b>{sessions.length}</b>会话</span><span><b>{pendingChanges.length}</b>待批提案</span></div>
        </header>
        <div className="steward-body">
          <section className="steward-chat">
            <header className="steward-chat-header"><div><span>SESSION TRANSCRIPT</span><h3>{selectedSession ? selectedSession.title : "新的知识会话"}</h3></div>{selectedSession && <code>{selectedSession.id}</code>}</header>
            <div className="steward-transcript" aria-live="polite">
              {(!selectedSession || selectedSession.messages.length === 0) && !sending && <div className="steward-welcome">
                <span className="console-kicker">WELCOME · {stewardProject.id}</span>
                <h3>你好，我是本项目的知识管家</h3>
                <p>我可以查询知识库与 Revision 质检、试跑草稿检索、解释 Profile 授权链；需要长期变更时，我会先生成标准提案卡，由你在右侧审批栏显式决定。</p>
                <div className="steward-prompt-chips">{STEWARD_QUICK_PROMPTS.map((prompt) => <button type="button" key={prompt} disabled={!daemonAvailable || sending} onClick={() => setMessage(prompt)}>{prompt}</button>)}</div>
                <p className="steward-welcome-note">对话内容不会自动批准任何变更。新增、修改、同步、发布、回滚、归档和授权调整都会先进入右侧待批卡片，只有显式批准才会执行。</p>
              </div>}
              {selectedSession?.messages.map((item) => <article className={`steward-message steward-message--${item.role}`} key={item.id}>
                <div className="steward-message-meta"><span>{item.role === "user" ? "我" : item.role === "employee" ? stewardName : "系统"}</span><time>{formatTime(item.at)}</time>{item.runId && <code>{item.runId}</code>}</div>
                <p className="steward-message-bubble">{item.content}</p>
                <ConversationMessageEvidence attachments={item.attachments} documents={item.documents} />
              </article>)}
              {sending && <article className="steward-message steward-message--employee steward-message--pending">
                <div className="steward-message-meta"><span>{stewardName}</span><span>处理中</span></div>
                <p className="steward-message-bubble">正在通过项目角色调用知识管家；回复、Prompt 与 Run 证据会一起留存…</p>
              </article>}
            </div>
            <ConversationComposer
              className="steward-composer"
              ariaLabel="发给知识管家的消息"
              placeholder="询问知识现状、要求试跑或提出变更……"
              disabled={!daemonAvailable}
              message={message}
              onMessageChange={setMessage}
              onSend={send}
              onPendingChange={setSending}
              sendingLabel="知识管家处理中…"
            />
          </section>
          <section className="steward-changes">
            <header><div><span className="console-kicker">CHANGE PROPOSALS · HUMAN APPROVAL</span><h3>变更提案</h3></div><strong>{pendingChanges.length} 待批</strong></header>
            <div className="steward-changes-scroll">
              {changes.map((change) => <KnowledgeChangeCard change={change} busy={deciding} key={change.id} onDecide={(next) => { setComment(""); setDecision(next); }} />)}
              {!changes.length && <div className="steward-changes-empty"><strong>暂无变更提案</strong><span>对话中提出的长期变更会在这里形成标准提案卡；批准、拒绝与取消只能由人工按钮完成。</span></div>}
            </div>
          </section>
        </div>
      </>}
    </main>
    {decision && <Modal title={`${DECISION_COPY[decision.kind].title} · ${decision.change.title}`} eyebrow={`${decision.change.id} · HUMAN DECISION REQUIRED`} onClose={() => { setDecision(undefined); setComment(""); }}>
      <form className="modal-body compact-form" onSubmit={submitDecision}>
        <div className="project-connect-note"><strong>{DECISION_COPY[decision.kind].note}</strong><p>提案卡与对话文案都不是授权凭证；这次点击会作为人工决定写入审批记录。</p></div>
        {decision.kind !== "cancel" && <Field label={decision.kind === "approve" ? "批准批注（可选）" : "拒绝原因（可选）"}><textarea rows={3} disabled={!daemonAvailable || deciding} value={comment} onChange={(event) => setComment(event.target.value)} /></Field>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={() => { setDecision(undefined); setComment(""); }}>返回</button>
          <button className={decision.kind === "reject" ? "button danger-filled" : "button primary"} disabled={!daemonAvailable || deciding}>{deciding ? "提交中…" : DECISION_COPY[decision.kind].confirm}</button>
        </div>
      </form>
    </Modal>}
  </div>;
}

export interface WikiTreeNode {
  entry: KnowledgeWikiDocument;
  children: WikiTreeNode[];
}

export function buildWikiTree(entries: KnowledgeWikiDocument[]): WikiTreeNode[] {
  const nodes = new Map(entries.map((entry) => [entry.document.id, { entry, children: [] as WikiTreeNode[] }]));
  const roots: WikiTreeNode[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.document.id);
    if (!node) continue;
    const parent = entry.document.parentId ? nodes.get(entry.document.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export type WikiDirectoryNodeKind = "collection" | "folder" | "unclassified" | "document";

export interface WikiDirectoryNode {
  id: string;
  kind: WikiDirectoryNodeKind;
  label: string;
  collectionId: string;
  path: string[];
  documentCount: number;
  authority?: KnowledgeAuthority;
  entry?: KnowledgeWikiDocument;
  children: WikiDirectoryNode[];
}

interface WikiDirectoryRow {
  node: WikiDirectoryNode;
  level: number;
  posInSet: number;
  setSize: number;
}

const wikiDirectoryCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function wikiRelativePath(document: KnowledgeDocument): string | undefined {
  const value = document.metadata?.relativePath;
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== ".")
    .join("/");
  return normalized || undefined;
}

function finalizeWikiDirectoryNode(node: WikiDirectoryNode, parentPath: string[] = []): WikiDirectoryNode {
  const path = [...parentPath, node.label];
  const kindOrder: Record<WikiDirectoryNodeKind, number> = { collection: 0, folder: 0, unclassified: 1, document: 2 };
  const children = node.children
    .map((child) => finalizeWikiDirectoryNode(child, path))
    .sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind]
      || wikiDirectoryCollator.compare(left.label, right.label)
      || wikiDirectoryCollator.compare(left.id, right.id));
  return {
    ...node,
    path,
    children,
    documentCount: node.kind === "document"
      ? 1 + children.reduce((total, child) => total + child.documentCount, 0)
      : children.reduce((total, child) => total + child.documentCount, 0)
  };
}

/**
 * Build a read-only navigation projection without persisting a second Wiki model.
 * Explicit parentId remains authoritative; otherwise source relativePath supplies
 * folder hierarchy. Documents with neither signal stay visible under 未编目条目.
 */
export function buildWikiDirectory(collections: KnowledgeCollection[], entries: KnowledgeWikiDocument[]): WikiDirectoryNode[] {
  const roots = collections.map<WikiDirectoryNode>((collection) => ({
    id: `collection:${collection.id}`,
    kind: "collection",
    label: collection.displayName,
    collectionId: collection.id,
    path: [],
    documentCount: 0,
    authority: collection.authority,
    children: []
  }));
  const rootsByCollection = new Map(roots.map((root) => [root.collectionId, root]));
  const unknownCollectionIds = [...new Set(entries
    .map((entry) => entry.document.collectionId)
    .filter((collectionId) => !rootsByCollection.has(collectionId)))]
    .sort(wikiDirectoryCollator.compare);
  for (const collectionId of unknownCollectionIds) {
    const root: WikiDirectoryNode = {
      id: `collection:${collectionId}`,
      kind: "collection",
      label: `未识别 Collection · ${collectionId}`,
      collectionId,
      path: [],
      documentCount: 0,
      children: []
    };
    roots.push(root);
    rootsByCollection.set(collectionId, root);
  }

  const entriesById = new Map(entries.map((entry) => [entry.document.id, entry]));
  const childrenByParent = new Map<string, KnowledgeWikiDocument[]>();
  const rootEntries: KnowledgeWikiDocument[] = [];
  const hasUsableParent = (entry: KnowledgeWikiDocument): boolean => {
    const parentId = entry.document.parentId;
    if (!parentId) return false;
    const immediateParent = entriesById.get(parentId);
    if (!immediateParent || immediateParent.document.collectionId !== entry.document.collectionId) return false;
    const seen = new Set([entry.document.id]);
    let current: KnowledgeWikiDocument | undefined = immediateParent;
    while (current) {
      if (seen.has(current.document.id)) return false;
      seen.add(current.document.id);
      const nextId = current.document.parentId;
      if (!nextId) return true;
      const next = entriesById.get(nextId);
      if (!next || next.document.collectionId !== entry.document.collectionId) return true;
      current = next;
    }
    return true;
  };

  for (const entry of entries) {
    if (hasUsableParent(entry)) {
      const parentId = entry.document.parentId!;
      childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), entry]);
    } else {
      rootEntries.push(entry);
    }
  }

  const documentNode = (entry: KnowledgeWikiDocument, label = entry.document.title): WikiDirectoryNode => ({
    id: `document:${entry.document.id}`,
    kind: "document",
    label,
    collectionId: entry.document.collectionId,
    path: [],
    documentCount: 1,
    entry,
    children: (childrenByParent.get(entry.document.id) ?? []).map((child) => documentNode(child))
  });

  for (const entry of rootEntries) {
    const root = rootsByCollection.get(entry.document.collectionId);
    if (!root) continue;
    const relativePath = wikiRelativePath(entry.document);
    let parent = root;
    let label = entry.document.title;
    if (relativePath) {
      const segments = relativePath.split("/");
      label = segments.at(-1) || entry.document.title;
      const traversed: string[] = [];
      for (const segment of segments.slice(0, -1)) {
        traversed.push(segment);
        const folderId = `${root.id}/folder:${traversed.map(encodeURIComponent).join("/")}`;
        let folder = parent.children.find((candidate) => candidate.id === folderId);
        if (!folder) {
          folder = {
            id: folderId,
            kind: "folder",
            label: segment,
            collectionId: entry.document.collectionId,
            path: [],
            documentCount: 0,
            children: []
          };
          parent.children.push(folder);
        }
        parent = folder;
      }
    } else {
      const unclassifiedId = `${root.id}/unclassified`;
      let unclassified = root.children.find((candidate) => candidate.id === unclassifiedId);
      if (!unclassified) {
        unclassified = {
          id: unclassifiedId,
          kind: "unclassified",
          label: "未编目条目",
          collectionId: entry.document.collectionId,
          path: [],
          documentCount: 0,
          children: []
        };
        root.children.push(unclassified);
      }
      parent = unclassified;
    }
    parent.children.push(documentNode(entry, label));
  }

  return roots.map((root) => finalizeWikiDirectoryNode(root));
}

export function filterWikiDirectory(nodes: WikiDirectoryNode[], query: string): WikiDirectoryNode[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return nodes;
  const visit = (node: WikiDirectoryNode): WikiDirectoryNode | undefined => {
    let selfMatches = false;
    if (node.kind === "document") {
      const document = node.entry?.document;
      const haystack = [
        node.label,
        node.path.join("/"),
        document?.title,
        document?.id,
        document?.sourceRef,
        document ? wikiRelativePath(document) : undefined
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      selfMatches = haystack.includes(normalized);
    }
    const children = node.children.map(visit).filter((child): child is WikiDirectoryNode => Boolean(child));
    if (!selfMatches && !children.length) return undefined;
    return {
      ...node,
      children,
      documentCount: node.kind === "document" ? 1 + children.reduce((total, child) => total + child.documentCount, 0) : children.reduce((total, child) => total + child.documentCount, 0)
    };
  };
  return nodes.map(visit).filter((node): node is WikiDirectoryNode => Boolean(node));
}

export function findWikiDirectoryPath(nodes: WikiDirectoryNode[], documentId: string): string[] {
  const targetId = `document:${documentId}`;
  const visit = (node: WikiDirectoryNode): string[] | undefined => {
    if (node.id === targetId) return node.path;
    for (const child of node.children) {
      const path = visit(child);
      if (path) return path;
    }
    return undefined;
  };
  for (const node of nodes) {
    const path = visit(node);
    if (path) return path;
  }
  return [];
}

function collectWikiDirectoryExpandableIds(nodes: WikiDirectoryNode[]): string[] {
  return nodes.flatMap((node) => node.children.length ? [node.id, ...collectWikiDirectoryExpandableIds(node.children)] : []);
}

function flattenWikiDirectory(nodes: WikiDirectoryNode[], expanded: Set<string>, forceExpanded: boolean, level = 1): WikiDirectoryRow[] {
  return nodes.flatMap((node, index) => {
    const row = { node, level, posInSet: index + 1, setSize: nodes.length };
    if (!node.children.length || (!forceExpanded && !expanded.has(node.id))) return [row];
    return [row, ...flattenWikiDirectory(node.children, expanded, forceExpanded, level + 1)];
  });
}

function findWikiDirectoryAncestorIds(nodes: WikiDirectoryNode[], documentId: string): string[] {
  const targetId = `document:${documentId}`;
  const visit = (node: WikiDirectoryNode, ancestors: string[]): string[] | undefined => {
    if (node.id === targetId) return ancestors;
    for (const child of node.children) {
      const found = visit(child, [...ancestors, node.id]);
      if (found) return found;
    }
    return undefined;
  };
  for (const node of nodes) {
    const found = visit(node, []);
    if (found) return found;
  }
  return [];
}

export function WikiDirectoryTree({ nodes, selectedId, onSelect }: {
  nodes: WikiDirectoryNode[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const treeRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState("");
  const filteredNodes = useMemo(() => filterWikiDirectory(nodes, query), [nodes, query]);
  const forceExpanded = Boolean(query.trim());
  const rows = useMemo(() => flattenWikiDirectory(filteredNodes, expanded, forceExpanded), [expanded, filteredNodes, forceExpanded]);
  const expandableIds = useMemo(() => collectWikiDirectoryExpandableIds(nodes), [nodes]);
  const documentCount = nodes.reduce((total, node) => total + node.documentCount, 0);

  useEffect(() => {
    setExpanded(new Set(nodes.map((node) => node.id)));
    setActiveId(nodes[0]?.id ?? "");
    setQuery("");
  }, [nodes]);

  useEffect(() => {
    if (!selectedId) return;
    const selectedNodeId = `document:${selectedId}`;
    setExpanded((current) => new Set([...current, ...findWikiDirectoryAncestorIds(nodes, selectedId)]));
    setActiveId(selectedNodeId);
  }, [nodes, selectedId]);

  useEffect(() => {
    if (rows.some((row) => row.node.id === activeId)) return;
    const selectedNodeId = selectedId ? `document:${selectedId}` : "";
    setActiveId(rows.find((row) => row.node.id === selectedNodeId)?.node.id ?? rows[0]?.node.id ?? "");
  }, [activeId, rows, selectedId]);

  const toggle = (id: string, next?: boolean) => setExpanded((current) => {
    const updated = new Set(current);
    const shouldExpand = next ?? !updated.has(id);
    if (shouldExpand) updated.add(id);
    else updated.delete(id);
    return updated;
  });
  const focusRow = (index: number) => {
    const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
    if (!row) return;
    setActiveId(row.node.id);
    treeRef.current?.querySelectorAll<HTMLButtonElement>("[role='treeitem']")[Math.min(Math.max(index, 0), rows.length - 1)]?.focus();
  };
  const activate = (row: WikiDirectoryRow) => {
    if (row.node.kind === "document" && row.node.entry) onSelect(row.node.entry.document.id);
    else if (row.node.children.length && !forceExpanded) toggle(row.node.id);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const row = rows[index];
    if (!row) return;
    const isExpanded = forceExpanded || expanded.has(row.node.id);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(index + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusRow(event.key === "Home" ? 0 : rows.length - 1);
      return;
    }
    if (event.key === "ArrowRight" && row.node.children.length) {
      event.preventDefault();
      if (!isExpanded) toggle(row.node.id, true);
      else if (rows[index + 1]?.level === row.level + 1) focusRow(index + 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.node.children.length && isExpanded && !forceExpanded) {
        toggle(row.node.id, false);
        return;
      }
      for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
        if (rows[candidate]!.level < row.level) {
          focusRow(candidate);
          return;
        }
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(row);
    }
  };
  const glyph = (node: WikiDirectoryNode): { text: string; className: string } => {
    if (node.kind === "collection") {
      const text = node.authority === "canonical" ? "正" : node.authority === "reference" ? "参" : node.authority === "experimental" ? "试" : "集";
      return { text, className: "collection" };
    }
    if (node.kind === "folder") return { text: "", className: "folder" };
    if (node.kind === "unclassified") return { text: "", className: "unclassified" };
    return { text: "", className: node.entry?.document.sourceId ? "synced" : "manual" };
  };

  return <>
    <div className="wiki-directory-tools">
      <label className="sr-only" htmlFor="wiki-directory-search">搜索当前 Wiki 的文档或路径</label>
      <input id="wiki-directory-search" type="search" placeholder="搜索文档或路径…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }} />
      <div><button type="button" disabled={!expandableIds.length || forceExpanded} onClick={() => setExpanded(new Set(expandableIds))}>全部展开</button><button type="button" disabled={!expandableIds.length || forceExpanded} onClick={() => setExpanded(new Set())}>全部折叠</button></div>
    </div>
    <div className="wiki-directory-summary"><span>{documentCount} 篇</span><span>{nodes.length} 个 Collection</span></div>
    {forceExpanded && !rows.length && <div className="wiki-tree-empty"><strong>没有匹配的文档或路径</strong><span>缩短关键词，或按 Escape 清空搜索。</span></div>}
    {rows.length > 0 && <div ref={treeRef} className="wiki-directory-tree" role="tree" aria-label="Wiki 内容目录">
      {rows.map((row, index) => {
        const expandable = row.node.children.length > 0;
        const isExpanded = forceExpanded || expanded.has(row.node.id);
        const selected = row.node.kind === "document" && row.node.entry?.document.id === selectedId;
        const rowGlyph = glyph(row.node);
        return <button
          type="button"
          role="treeitem"
          aria-level={row.level}
          aria-posinset={row.posInSet}
          aria-setsize={row.setSize}
          aria-expanded={expandable ? isExpanded : undefined}
          aria-selected={selected}
          aria-current={selected ? "page" : undefined}
          className={`wiki-directory-row kind-${row.node.kind} ${selected ? "selected" : ""}`}
          style={{ paddingInlineStart: `calc(var(--space-2) + ${(row.level - 1) * 16}px)` }}
          tabIndex={(activeId ? activeId === row.node.id : index === 0) ? 0 : -1}
          title={row.node.path.join(" / ")}
          key={row.node.id}
          onFocus={() => setActiveId(row.node.id)}
          onClick={() => { setActiveId(row.node.id); activate(row); }}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {row.level > 1 && <span className="wiki-directory-guides" aria-hidden="true">{Array.from({ length: row.level - 1 }, (_, depth) => <i key={depth} style={{ insetInlineStart: `calc(var(--space-2) + ${depth * 16 + 8}px)` }} />)}</span>}
          <span className="wiki-directory-caret" aria-hidden="true" />
          <span className={`wiki-directory-glyph glyph-${rowGlyph.className}`} aria-hidden="true">{rowGlyph.text}</span>
          <span className="wiki-directory-label">{row.node.label}</span>
          {row.node.kind !== "document" && <span className="wiki-directory-count">{row.node.documentCount}</span>}
        </button>;
      })}
    </div>}
    {!forceExpanded && documentCount === 0 && <div className="wiki-directory-empty"><strong>当前 Revision 没有文档</strong><span>空 Collection 仍显示，便于核对分类边界。</span></div>}
  </>;
}

export function KnowledgeWikiBrowser({ knowledgeBases, notify }: {
  knowledgeBases: KnowledgeBase[];
  notify: PageProps["notify"];
}) {
  const [baseId, setBaseId] = useState(knowledgeBases[0]?.id ?? "");
  const base = knowledgeBases.find((item) => item.id === baseId) ?? knowledgeBases[0];
  const [revisionChoice, setRevisionChoice] = useState<"published" | "latest">("published");
  const [wiki, setWiki] = useState<KnowledgeWikiView>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const revisionValue = base
    ? (revisionChoice === "published" ? base.publishedRevision : base.latestRevision) ?? base.publishedRevision ?? base.latestRevision
    : undefined;

  useEffect(() => {
    if (!base || revisionValue === undefined) { setWiki(undefined); setError(""); return; }
    let cancelled = false;
    setLoading(true);
    setWiki(undefined);
    setError("");
    api<KnowledgeWikiView>(`/api/knowledge-bases/${base.id}/wiki?revision=${revisionValue}`)
      .then((view) => {
        if (cancelled) return;
        setWiki(view);
        setSelectedId((current) => view.documents.some((entry) => entry.document.id === current) ? current : view.documents[0]?.document.id ?? "");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setWiki(undefined);
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        notify(message, "error");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [base?.id, revisionValue, notify]);

  const selected = wiki?.documents.find((entry) => entry.document.id === selectedId) ?? wiki?.documents[0];
  const titleOf = (id: string) => wiki?.documents.find((entry) => entry.document.id === id)?.document.title ?? id;
  const directory = useMemo(() => buildWikiDirectory(base?.collections ?? [], wiki?.documents ?? []), [base?.collections, wiki?.documents]);
  const selectedPath = useMemo(() => selected ? findWikiDirectoryPath(directory, selected.document.id) : [], [directory, selected]);

  return <div className="knowledge-wiki-browser" role="tabpanel">
    <aside className="wiki-tree">
      <header className="wiki-tree-header">
        <span className="console-kicker">FULL WIKI · READ ONLY</span>
        <Field label="知识库">
          <SelectControl ariaLabel="选择 Wiki 知识库" value={base?.id ?? ""} emptyLabel="尚无知识库" options={knowledgeBases.map((item) => ({ value: item.id, label: item.displayName, description: `${item.id} · ${item.status === "archived" ? "已归档" : `Published R${item.publishedRevision ?? "—"}`}` }))} onChange={(id) => { setBaseId(id); setSelectedId(""); }} />
        </Field>
        <Field label="Revision">
          <SelectControl ariaLabel="选择 Wiki Revision" value={revisionChoice} disabled={!base || (!base.publishedRevision && !base.latestRevision)} options={[
            { value: "published", label: `员工发布 R${base?.publishedRevision ?? "—"}`, description: "员工当前读取的版本", disabled: !base?.publishedRevision },
            { value: "latest", label: `最新草稿 R${base?.latestRevision ?? "—"}`, description: "尚未发布的最新内容", disabled: !base?.latestRevision }
          ]} onChange={(choice) => setRevisionChoice(choice as "published" | "latest")} />
        </Field>
      </header>
      <div className="wiki-tree-scroll">
        {wiki && <WikiDirectoryTree nodes={directory} selectedId={selected?.document.id ?? ""} onSelect={setSelectedId} />}
        {!wiki && !error && revisionValue !== undefined && <div className="wiki-tree-empty" role="status"><strong>正在生成 Wiki 视图…</strong><span>读取所选 Revision 的目录和文档。</span></div>}
        {!wiki && !error && revisionValue === undefined && <p className="wiki-tree-empty">这座知识库还没有 Revision；生成草稿或发布后这里会出现全量 Wiki。</p>}
        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>
      <footer className="list-footer"><span>{wiki ? `${wiki.documents.length} 篇文档` : "—"}</span><span>{wiki ? `R${wiki.revision}` : "WIKI"}</span></footer>
    </aside>
    <main className="wiki-reader" aria-busy={loading}>
      {selected ? <article className="wiki-document">
        {selectedPath.length > 0 && <nav className="wiki-document-breadcrumb" aria-label="文档位置"><ol>{selectedPath.map((segment, index) => <li key={`${segment}-${index}`} title={segment}>{segment}</li>)}</ol></nav>}
        <header className="wiki-document-head">
          <div className="file-index"><span>WIKI DOCUMENT</span><code>{selected.document.id}</code></div>
          <div className="wiki-document-title-row"><h2>{selected.document.title}</h2><Stamp status={wiki?.visibility === "published" ? "passed" : "pending"} label={wiki?.visibility === "published" ? "员工发布版" : "草稿版"} /></div>
          <div className="wiki-document-meta"><span>{selected.document.collectionId}</span><span>{selected.document.sourceId ? `同步自 ${selected.document.sourceId}` : "人工维护"}</span>{selected.document.sourceRef && <code>{selected.document.sourceRef}</code>}{wiki && <span>生成于 {formatTime(wiki.generatedAt)}</span>}</div>
        </header>
        <div className="wiki-document-content">{selected.document.content}</div>
        {selected.document.parentId && <p className="wiki-document-parent">上级文档：<button type="button" className="text-button" onClick={() => setSelectedId(selected.document.parentId ?? "")}>{titleOf(selected.document.parentId)}</button></p>}
      </article> : <div className="wiki-reader-empty"><strong>{loading ? "正在生成 Wiki 视图…" : "选择左侧文档开始阅读"}</strong><span>{error ? "加载失败，请切换 Revision 或知识库重试。" : "正文按纯文本安全渲染，保留换行，不执行任何标记。"}</span></div>}
    </main>
    <aside className="wiki-meta">
      {selected ? <>
        <section className="wiki-meta-section"><header><span>METADATA</span><h3>文档元数据</h3></header><dl className="ledger">
          <dt>Document ID</dt><dd><code>{selected.document.id}</code></dd>
          <dt>Collection</dt><dd>{selected.document.collectionId}</dd>
          <dt>排序</dt><dd>{selected.document.order ?? "—"}</dd>
          <dt>上级</dt><dd>{selected.document.parentId ?? "（根文档）"}</dd>
          <dt>更新时间</dt><dd>{formatTime(selected.document.updatedAt)}</dd>
          {Object.entries(selected.document.metadata ?? {}).map(([key, value]) => <Fragment key={key}><dt>{key}</dt><dd><code>{JSON.stringify(value)}</code></dd></Fragment>)}
        </dl></section>
        <section className="wiki-meta-section"><header><span>EXPLICIT REFERENCES</span><h3>显式引用 · {selected.outgoingReferences.length}</h3></header>
          {selected.outgoingReferences.length ? <div className="wiki-ref-list">{selected.outgoingReferences.map((reference) => <button type="button" key={`${reference.targetDocumentId}-${reference.type}`} onClick={() => setSelectedId(reference.targetDocumentId)}>
            <b>{REFERENCE_TYPE_COPY[reference.type]}</b><span><strong>{titleOf(reference.targetDocumentId)}</strong><code>{reference.targetDocumentId}</code>{reference.note && <small>{reference.note}</small>}</span>
          </button>)}</div> : <p className="muted">这篇文档没有人工确认的显式引用。</p>}
        </section>
        <section className="wiki-meta-section"><header><span>BACKLINKS</span><h3>反向引用 · {selected.backlinks.length}</h3></header>
          {selected.backlinks.length ? <div className="wiki-ref-list">{selected.backlinks.map((reference) => <button type="button" key={`${reference.sourceDocumentId}-${reference.type}`} onClick={() => setSelectedId(reference.sourceDocumentId)}>
            <b>{REFERENCE_TYPE_COPY[reference.type]}</b><span><strong>{titleOf(reference.sourceDocumentId)}</strong><code>{reference.sourceDocumentId}</code>{reference.note && <small>{reference.note}</small>}</span>
          </button>)}</div> : <p className="muted">没有其他文档显式引用这篇文档。</p>}
        </section>
        <section className="wiki-meta-section"><header><span>WEAK CANDIDATES · ≤ 5</span><h3>弱关联候选 · {selected.candidateRelations.slice(0, 5).length}</h3></header>
          <p className="wiki-candidate-note">候选只基于元数据信号推导，不会持久化；需要人工在导入或编辑流程中确认后才会变成显式引用。</p>
          {selected.candidateRelations.length ? <div className="wiki-candidate-list">{selected.candidateRelations.slice(0, 5).map((candidate) => <article key={candidate.id}>
            <header><strong>{titleOf(candidate.targetDocumentId)}</strong><code>score {candidate.score.toFixed(1)}</code></header>
            <code>{candidate.targetDocumentId}</code>
            <ul>{candidate.signals.map((signal) => <li key={signal}>{signal}</li>)}</ul>
          </article>)}</div> : <p className="muted">当前没有弱关联候选。</p>}
        </section>
      </> : <div className="wiki-meta-empty"><strong>元数据与引用</strong><span>选择文档后显示元数据、显式引用、反向引用和最多 5 条弱关联候选。</span></div>}
    </aside>
  </div>;
}

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

export function KnowledgePage({ data, refresh, notify }: PageProps) {
  const daemonAvailable = useDaemonAvailable();
  const knowledgeBases = data.knowledgeBases ?? [];
  const profiles = data.knowledgeProfiles ?? [];
  const [tab, setTab] = useState<KnowledgeConsoleTab>("overview");
  const [search, setSearch] = useState("");
  const [selectedBaseId, setSelectedBaseId] = useState(knowledgeBases[0]?.id ?? "");
  const [selectedProfileId, setSelectedProfileId] = useState(profiles[0]?.id ?? "");
  const [detail, setDetail] = useState<KnowledgeBaseDetail>();
  const [impact, setImpact] = useState<KnowledgeImpactSnapshot>();
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [profileEditor, setProfileEditor] = useState<"new" | "edit" | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<"base" | "profile" | null>(null);
  const [previewRevision, setPreviewRevision] = useState<number>();
  const [publishRevision, setPublishRevision] = useState<number>();
  const [importOpen, setImportOpen] = useState(false);
  const [perspectiveEmployeeId, setPerspectiveEmployeeId] = useState("");
  const [busy, setBusy] = useState("");
  const selectedBase = knowledgeBases.find((item) => item.id === selectedBaseId) ?? knowledgeBases[0];
  const selectedProfile = profiles.find((item) => item.id === selectedProfileId) ?? profiles[0];
  const filteredBases = useMemo(() => knowledgeBases.filter((item) => `${item.id} ${item.displayName} ${item.domain} ${item.description}`.toLowerCase().includes(search.toLowerCase())), [knowledgeBases, search]);
  const filteredProfiles = useMemo(() => profiles.filter((item) => `${item.id} ${item.displayName} ${item.description}`.toLowerCase().includes(search.toLowerCase())), [profiles, search]);
  const impactRevision = `${knowledgeBases.map((item) => `${item.id}:${item.version}`).join("|")}/${profiles.map((item) => `${item.id}:${item.version}`).join("|")}/${data.employees.map((item) => `${item.id}:${item.version}`).join("|")}/${data.projectBindings.map((item) => `${item.projectId}:${item.version}`).join("|")}`;

  useEffect(() => {
    if (!selectedBase) { setDetail(undefined); return; }
    api<KnowledgeBaseDetail>(`/api/knowledge-bases/${selectedBase.id}`).then(setDetail).catch(() => setDetail(undefined));
  }, [selectedBase?.id, selectedBase?.version]);
  useEffect(() => {
    api<KnowledgeImpactSnapshot>("/api/knowledge/impact").then(setImpact).catch(() => setImpact(undefined));
  }, [impactRevision]);

  const reloadDetail = async () => {
    await refresh();
    if (selectedBaseId) setDetail(await api<KnowledgeBaseDetail>(`/api/knowledge-bases/${selectedBaseId}`));
    setImpact(await api<KnowledgeImpactSnapshot>("/api/knowledge/impact"));
  };
  const act = async (label: string, operation: () => Promise<unknown>, success: string) => {
    setBusy(label);
    try { await operation(); notify(success); await reloadDetail(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setBusy(""); }
  };
  const archiveSelected = async () => {
    if (archiveTarget === "base" && selectedBase) {
      await act("archive", () => api(`/api/knowledge-bases/${selectedBase.id}/archive`, writeBody({})), `${selectedBase.displayName} 已归档；Revision 与运行证据保留`);
    }
    if (archiveTarget === "profile" && selectedProfile) {
      setBusy("archive");
      try {
        await api(`/api/knowledge-profiles/${selectedProfile.id}/archive`, writeBody({}));
        notify(`${selectedProfile.displayName} 已归档；员工后续运行会明确排除该 Profile`);
        await reloadDetail();
      } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
      finally { setBusy(""); }
    }
    setArchiveTarget(null);
  };
  const restoreSelected = async (target: "base" | "profile") => {
    if (target === "base" && selectedBase) {
      await act("restore", () => api(`/api/knowledge-bases/${selectedBase.id}/restore`, writeBody({})), `${selectedBase.displayName} 已恢复`);
      return;
    }
    if (target === "profile" && selectedProfile) {
      await act("restore", () => api(`/api/knowledge-profiles/${selectedProfile.id}/restore`, writeBody({})), `${selectedProfile.displayName} 已恢复；后续调用会重新参与 Resolver`);
    }
  };

  const draftAhead = knowledgeBases.filter((item) => item.latestRevision && item.latestRevision !== item.publishedRevision);
  const unpublished = knowledgeBases.filter((item) => !item.publishedRevision);
  const unhealthy = knowledgeBases.filter((item) => item.qualityStatus !== "healthy" || item.syncStatus === "failed");
  const activeProfiles = profiles.filter((item) => item.status === "active");
  const assignedProfileIds = new Set([
    ...data.employees.flatMap((employee) => employee.knowledgeProfileIds ?? []),
    ...data.projectBindings.flatMap((binding) => binding.roles.flatMap((role) => role.knowledgeProfileIds ?? []))
  ]);
  const unassignedProfiles = activeProfiles.filter((profile) => !assignedProfileIds.has(profile.id));
  const pendingChangeCount = (data.knowledgeChanges ?? []).filter((change) => change.status === "awaiting-approval" || change.status === "needs-reapproval").length;
  const perspectiveCandidates = data.employees.filter((employee) => employee.status === "active");
  const perspectiveEmployee = perspectiveCandidates.find((employee) => employee.id === perspectiveEmployeeId) ?? perspectiveCandidates[0];
  const selectedBaseImpact = impact?.knowledgeBases.find((item) => item.knowledgeBaseId === selectedBase?.id);
  const selectedProfileImpact = impact?.profiles.find((item) => item.profileId === selectedProfile?.id);
  const assignedEmployees = selectedProfile ? data.employees.filter((employee) => (employee.knowledgeProfileIds ?? []).includes(selectedProfile.id)) : [];
  const assignedRoles = selectedProfile ? data.projectBindings.flatMap((binding) => binding.roles.filter((role) => (role.knowledgeProfileIds ?? []).includes(selectedProfile.id)).map((role) => `${binding.projectId}/${role.roleId}`)) : [];
  const tabs: Array<{ id: KnowledgeConsoleTab; label: string; meta: string }> = [
    { id: "overview", label: "总览", meta: `${draftAhead.length + unhealthy.length} 待办` },
    { id: "catalog", label: "知识目录", meta: `${knowledgeBases.length} 座` },
    { id: "wiki", label: "全量 Wiki", meta: "只读" },
    { id: "releases", label: "发布车道", meta: `${draftAhead.length} 草稿` },
    { id: "profiles", label: "知识 Profile", meta: `${profiles.length} 份` },
    { id: "impact", label: "影响与授权", meta: `${impact?.danglingAssignments.length ?? 0} 异常` },
    { id: "reviews", label: "授权复核", meta: "提醒制" },
    { id: "assistant", label: "AI 管理", meta: `${pendingChangeCount} 待批` }
  ];

  return <div className="knowledge-console">
    <header className="knowledge-console-header">
      <div className="knowledge-console-title"><span>KNOWLEDGE CONTROL PLANE</span><h1>知识控制台</h1><p>独立维护内容、版本与索引，通过少量 Profile 把经过筛选的证据交给员工。</p></div>
      <div className="knowledge-console-actions"><button className="button secondary" disabled={!daemonAvailable} onClick={() => { setTab("profiles"); setProfileEditor("new"); }}>建立 Profile</button><button className="button secondary" disabled={!daemonAvailable || !knowledgeBases.some((item) => item.status === "active")} onClick={() => setImportOpen(true)}>从链接导入</button><button className="button primary" disabled={!daemonAvailable} onClick={() => { setTab("catalog"); setEditor("new"); }}>建立知识库</button></div>
      <div className="knowledge-console-vitals"><span><b>{knowledgeBases.filter((item) => item.status === "active").length}</b>活动知识库</span><span><b>{activeProfiles.length}</b>活动 Profile</span><span><b>{draftAhead.length}</b>待发布草稿</span><span><b>{unhealthy.length + (impact?.danglingAssignments.length ?? 0)}</b>治理提醒</span></div>
    </header>
    <nav className="knowledge-console-tabs" role="tablist" aria-label="知识控制台分区">{tabs.map((item) => <button type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : ""} key={item.id} onClick={() => setTab(item.id)}><strong>{item.label}</strong><small>{item.meta}</small></button>)}</nav>

    {tab === "overview" && <main className="knowledge-overview" role="tabpanel">
      <section className="knowledge-overview-grid">
        <article className="knowledge-overview-lead"><span className="console-kicker">OPERATING MODEL</span><h2>一条受控发布链，而不是员工与知识库的关系网。</h2><p>内容负责人维护 Revision，Profile 负责人维护授权策略，员工负责人只分配少量 Profile。Router 每次运行继续做减法。</p><div className="knowledge-flow"><span>建库</span><i>→</i><span>草稿</span><i>→</i><span>质检</span><i>→</i><span>发布</span><i>→</i><span>Profile</span><i>→</i><span>员工</span></div></article>
        <article className="knowledge-overview-card"><span>发布准备</span><strong>{draftAhead.length}</strong><p>{draftAhead.length ? "座知识库有新 Revision 等待试跑与影响确认。" : "所有已发布知识库都与最新 Revision 一致。"}</p><button type="button" className="text-button" onClick={() => setTab("releases")}>打开发布车道</button></article>
        <article className="knowledge-overview-card"><span>授权复用</span><strong>{assignedProfileIds.size}</strong><p>{unassignedProfiles.length ? `${unassignedProfiles.length} 份活动 Profile 尚未分配。` : "活动 Profile 都已有明确使用方。"}</p><button type="button" className="text-button" onClick={() => setTab("profiles")}>检查 Profile</button></article>
      </section>
      <section className="knowledge-attention-board"><header><div><span>治理队列</span><h2>需要处理的事项</h2></div><strong>{draftAhead.length + unpublished.length + unhealthy.length + unassignedProfiles.length + (impact?.danglingAssignments.length ?? 0)}</strong></header><div>
        {impact?.danglingAssignments.map((item) => <article className="critical" key={`${item.source}-${item.profileId}-${item.employeeId}`}><span>引用缺失</span><div><strong>{item.profileId}</strong><p>{item.source === "employee" ? `员工 ${item.employeeId}` : `${item.projectId}/${item.roleId}`} 仍引用不存在的 Profile。</p></div><button type="button" onClick={() => setTab("impact")}>查看</button></article>)}
        {unhealthy.map((item) => <article className="critical" key={`health-${item.id}`}><span>同步异常</span><div><strong>{item.displayName}</strong><p>{item.lastSyncError ?? `当前质量状态为 ${item.qualityStatus}`}</p></div><button type="button" onClick={() => { setSelectedBaseId(item.id); setTab("catalog"); }}>处理</button></article>)}
        {draftAhead.map((item) => <article key={`draft-${item.id}`}><span>待发布</span><div><strong>{item.displayName}</strong><p>Published R{item.publishedRevision ?? "—"} → Latest R{item.latestRevision}</p></div><button type="button" onClick={() => { setSelectedBaseId(item.id); setTab("releases"); }}>检查</button></article>)}
        {unpublished.filter((item) => !draftAhead.some((draft) => draft.id === item.id)).map((item) => <article key={`empty-${item.id}`}><span>未开放</span><div><strong>{item.displayName}</strong><p>尚无已发布 Revision，不会进入员工检索。</p></div><button type="button" onClick={() => { setSelectedBaseId(item.id); setTab("catalog"); }}>补内容</button></article>)}
        {unassignedProfiles.map((item) => <article key={`profile-${item.id}`}><span>未分配</span><div><strong>{item.displayName}</strong><p>策略已建立，但没有员工或项目角色使用。</p></div><button type="button" onClick={() => { setSelectedProfileId(item.id); setTab("profiles"); }}>查看</button></article>)}
        {draftAhead.length + unpublished.length + unhealthy.length + unassignedProfiles.length + (impact?.danglingAssignments.length ?? 0) === 0 && <div className="knowledge-all-clear"><strong>当前没有治理待办</strong><span>内容版本、授权关系和运行入口均处于稳定状态。</span></div>}
      </div></section>
      <section className="knowledge-coverage-strip"><header><span>PROFILE COVERAGE</span><h2>知识通过 Profile 复用</h2></header><div>{impact?.profiles.map((profileImpact) => { const profile = profiles.find((item) => item.id === profileImpact.profileId); return <article key={profileImpact.profileId}><strong>{profile?.displayName ?? profileImpact.profileId}</strong><code>{profileImpact.profileId}</code><dl><dt>知识库</dt><dd>{profileImpact.knowledgeBases.length}</dd><dt>员工</dt><dd>{profileImpact.employees.length}</dd><dt>项目角色</dt><dd>{profileImpact.projectRoles.length}</dd></dl></article>; })}{!impact?.profiles.length && <p className="muted">尚无 Profile，先从一个明确边界的知识策略开始。</p>}</div></section>
    </main>}

    {tab === "catalog" && <div className="knowledge-console-workspace page-grid page-grid--knowledge" role="tabpanel">
      <aside className="record-list knowledge-record-list"><header className="list-header"><h2>知识目录</h2><button className="square-action" disabled={!daemonAvailable} onClick={() => setEditor("new")} aria-label="建立知识库"><UtilityIcon name="add" /></button></header><div className="list-tools"><input type="search" placeholder="检索知识库…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><div className="record-scroll">{filteredBases.map((item) => <button type="button" className={`knowledge-card ${selectedBase?.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelectedBaseId(item.id)}><span className="knowledge-card-mark" aria-hidden="true">知</span><span><strong>{item.displayName}</strong><code>{item.id} · R{item.publishedRevision ?? "—"}</code><small>{item.domain} · {item.collections.length} 个 Collection</small></span><Stamp status={item.status} /></button>)}</div><footer className="list-footer"><span>{knowledgeBases.length} 个知识库</span><span>CATALOG</span></footer></aside>
      <main className="detail-pane">{!selectedBase ? <EmptyState title="建立第一座知识花圃" action={<button className="button primary" disabled={!daemonAvailable} onClick={() => setEditor("new")}>建立知识库</button>}>先定义清晰的领域与 Collection，再导入资料并发布 Revision。</EmptyState> : <div className="dossier knowledge-dossier"><header className="dossier-cover knowledge-cover"><div className="file-index"><span>KNOWLEDGE CATALOG RECORD</span><code>No. {selectedBase.id.toUpperCase()}</code></div><div className="dossier-title-row"><div className="knowledge-seal" aria-hidden="true">知</div><div><h2>{selectedBase.displayName}</h2><p>{selectedBase.description}</p></div><Stamp status={selectedBase.status} /></div><div className="knowledge-health-line"><span className={`health-dot health-${selectedBase.qualityStatus}`} />质量 {selectedBase.qualityStatus}<span>定义 v{selectedBase.version}</span><span>Published R{selectedBase.publishedRevision ?? "—"}</span><span>Latest R{selectedBase.latestRevision ?? "—"}</span><span>{selectedBaseImpact?.profileMatches.length ?? 0} Profiles 可见</span></div><div className="dossier-actions">
        {selectedBase.status === "archived" ? <button className="button primary" disabled={!daemonAvailable || Boolean(busy)} onClick={() => void restoreSelected("base")}>恢复知识库</button> : <><button className="button primary" disabled={!daemonAvailable || !selectedBase.latestRevision || selectedBase.latestRevision === selectedBase.publishedRevision || Boolean(busy)} onClick={() => setPublishRevision(selectedBase.latestRevision)}>发布最新 Revision</button><button className="button secondary" disabled={!daemonAvailable || !selectedBase.latestRevision} onClick={() => selectedBase.latestRevision && setPreviewRevision(selectedBase.latestRevision)}>草稿试跑</button><button className="button secondary" disabled={!daemonAvailable || !selectedBase.sources.length || Boolean(busy)} onClick={() => void act("sync", () => api(`/api/knowledge-bases/${selectedBase.id}/sync`, writeBody({})), "同步完成，已生成待发布 Revision")}>{busy === "sync" ? "同步中…" : "同步来源"}</button><button className="button secondary" disabled={!daemonAvailable} onClick={() => setRevisionOpen(true)}>改进内容</button><button className="button secondary" disabled={!daemonAvailable} onClick={() => setImportOpen(true)}>从链接导入</button><button className="button secondary" disabled={!daemonAvailable} onClick={() => setEditor("edit")}>修订目录</button><button className="button danger" disabled={!daemonAvailable || Boolean(busy)} onClick={() => setArchiveTarget("base")}>归档</button></>}
      </div></header><DossierSection number="01" title="发布状态"><div className="knowledge-lane"><article className={selectedBase.latestRevision !== selectedBase.publishedRevision ? "current" : "complete"}><span>最新草稿</span><strong>R{selectedBase.latestRevision ?? "—"}</strong><small>{selectedBase.latestRevision === selectedBase.publishedRevision ? "与员工版本一致" : "等待质检、试跑和发布"}</small></article><i aria-hidden="true" /><article className="complete"><span>员工使用</span><strong>R{selectedBase.publishedRevision ?? "—"}</strong><small>{selectedBase.publishedRevision ? "后续运行固定此版本" : "尚未开放给员工"}</small></article></div>{selectedBase.lastSyncError && <div className="inline-error">最近同步失败：{selectedBase.lastSyncError}</div>}<AssessmentPanel assessment={detail?.latestAssessment} /></DossierSection><DossierSection number="02" title="Collection"><div className="knowledge-collection-grid">{selectedBase.collections.map((collection) => { const assessment = detail?.latestAssessment?.collections.find((item) => item.collectionId === collection.id); return <article key={collection.id}><header><span>{collection.authority === "canonical" ? "正" : collection.authority === "reference" ? "参" : "试"}</span><div><strong>{collection.displayName}</strong><code>{collection.id}</code></div></header><p>{collection.description}</p><div className="tag-row">{collection.tags.map((tag) => <code className="paper-tag" key={tag}>{tag}</code>)}</div><footer>{assessment?.documentCount ?? 0} 文档 · {assessment?.sourceDocumentCount ?? 0} 同步</footer></article>; })}</div></DossierSection><div className="dossier-columns"><DossierSection number="03" title="同步来源"><div className="knowledge-source-list">{selectedBase.sources.length ? selectedBase.sources.map((source) => <article key={source.id}><span>{source.kind === "directory" ? "DIR" : "FILE"}</span><div><strong>{source.id}</strong><code>{source.location}</code><small>→ {source.collectionId}</small></div></article>) : <p className="muted">仅人工维护，尚未配置同步来源。</p>}</div></DossierSection><DossierSection number="04" title="内容与同步"><dl className="ledger"><dt>最新文档</dt><dd>{detail?.latestRevision?.documents.length ?? 0}</dd><dt>发布文档</dt><dd>{detail?.publishedRevision?.documents.length ?? 0}</dd><dt>最近同步</dt><dd>{formatTime(selectedBase.lastSyncedAt)}</dd><dt>同步状态</dt><dd>{selectedBase.syncStatus}</dd><dt>敏感度</dt><dd>{selectedBase.classification}</dd><dt>授权 Profile</dt><dd>{selectedBaseImpact?.profileMatches.length ?? 0}</dd></dl></DossierSection></div><DossierSection number="05" title="最近内容"><div className="knowledge-document-ledger">{detail?.latestRevision?.documents.slice(0, 12).map((document) => <article key={document.id}><span>{document.sourceId ? "源" : "写"}</span><div><strong>{document.title}</strong><code>{document.id} · {document.collectionId}</code></div><small>{document.sourceRef ?? "人工维护"}</small></article>)}{!detail?.latestRevision?.documents.length && <p className="muted">暂无内容。可以添加人工条目或同步来源。</p>}</div></DossierSection></div>}</main>
    </div>}

    {tab === "wiki" && <KnowledgeWikiBrowser knowledgeBases={knowledgeBases} notify={notify} />}

    {tab === "releases" && <main className="knowledge-release-console" role="tabpanel">
      <section className="knowledge-release-list"><header><div><span>REVISION LANES</span><h2>发布车道</h2><p>草稿可以独立试跑；只有显式发布才会改变员工读取版本。</p></div><strong>{draftAhead.length}</strong></header><div>{knowledgeBases.map((item) => <article className={selectedBase?.id === item.id ? "selected" : ""} key={item.id} onClick={() => setSelectedBaseId(item.id)}><div className="release-base-name"><span className={`health-dot health-${item.qualityStatus}`} /><div><strong>{item.displayName}</strong><code>{item.id}</code></div></div><div className="release-lane-mini"><span>草稿 <b>R{item.latestRevision ?? "—"}</b></span><i /><span>发布 <b>R{item.publishedRevision ?? "—"}</b></span></div><div className="release-row-actions"><Stamp status={item.status} /><button type="button" className="button secondary" disabled={!item.latestRevision || item.status === "archived"} onClick={(event) => { event.stopPropagation(); setSelectedBaseId(item.id); if (item.latestRevision) setPreviewRevision(item.latestRevision); }}>试跑</button><button type="button" className="button primary" disabled={!item.latestRevision || item.latestRevision === item.publishedRevision || item.status === "archived"} onClick={(event) => { event.stopPropagation(); setSelectedBaseId(item.id); if (item.latestRevision) setPublishRevision(item.latestRevision); }}>检查发布</button></div></article>)}</div></section>
      <section className="knowledge-release-detail">{selectedBase ? <><header><div><span>SELECTED LANE</span><h2>{selectedBase.displayName}</h2><code>{selectedBase.id} · Published R{selectedBase.publishedRevision ?? "—"}</code></div><button type="button" className="button secondary" onClick={() => { setTab("catalog"); }}>打开目录档案</button></header><AssessmentPanel assessment={detail?.latestAssessment} /><div className="knowledge-revision-history"><header><span>Revision</span><span>内容</span><span>质量</span><span>状态</span><span>操作</span></header>{detail?.revisionHistory.map((revision) => <article key={revision.revision}><strong>R{revision.revision}</strong><span>{revision.documentCount} 文档<small>{revision.sourceDocumentCount} 同步 · {revision.manualDocumentCount} 人工</small></span><Stamp status={assessmentStamp(revision.assessmentStatus)} label={assessmentCopy(revision.assessmentStatus)} /><span className="revision-flags">{revision.isLatest && <b>最新</b>}{revision.isPublished && <b>员工使用</b>}</span><div><button type="button" className="text-button" onClick={() => setPreviewRevision(revision.revision)}>试跑</button>{!revision.isPublished && <button type="button" className="text-button" disabled={selectedBase.status === "archived" || revision.assessmentStatus === "blocked"} onClick={() => setPublishRevision(revision.revision)}>{revision.revision < (selectedBase.publishedRevision ?? 0) ? "回滚到此版" : "发布此版"}</button>}</div></article>)}{!detail?.revisionHistory.length && <p className="muted">尚无 Revision。</p>}</div></> : <div className="knowledge-release-empty">选择一座知识库查看发布历史。</div>}</section>
    </main>}

    {tab === "profiles" && <div className="knowledge-console-workspace page-grid page-grid--knowledge" role="tabpanel">
      <aside className="record-list knowledge-record-list"><header className="list-header"><h2>知识 Profile</h2><button className="square-action" disabled={!daemonAvailable} onClick={() => setProfileEditor("new")} aria-label="建立知识 Profile"><UtilityIcon name="add" /></button></header><div className="list-tools"><input type="search" placeholder="检索 Profile…" value={search} onChange={(event) => setSearch(event.target.value)} /><p className="muted list-note">知识 Profile 是可复用的知识授权策略：员工与项目角色只引用少量 Profile，运行时再由 Resolver 与 Router 做减法。</p></div><div className="record-scroll">{filteredProfiles.map((item) => <button type="button" className={`knowledge-card profile-card ${selectedProfile?.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelectedProfileId(item.id)}><span className="knowledge-card-mark" aria-hidden="true">档</span><span><strong>{item.displayName}</strong><code>{item.id} · v{item.version}</code><small>{item.rules.length} 条选择规则</small></span><Stamp status={item.status} /></button>)}</div><footer className="list-footer"><span>{profiles.length} 个 Profile</span><span>POLICY</span></footer></aside>
      <main className="detail-pane">{!selectedProfile ? <EmptyState title="建立可复用的知识 Profile" action={<button className="button primary" disabled={!daemonAvailable} onClick={() => setProfileEditor("new")}>建立 Profile</button>}>员工只绑定少量 Profile；Profile 决定目录范围、信任边界、激活条件和单次预算。</EmptyState> : <div className="dossier knowledge-dossier profile-dossier"><header className="dossier-cover"><div className="file-index"><span>REUSABLE KNOWLEDGE POLICY</span><code>No. {selectedProfile.id.toUpperCase()}</code></div><div className="dossier-title-row"><div className="knowledge-seal profile" aria-hidden="true">档</div><div><h2>{selectedProfile.displayName}</h2><p>{selectedProfile.description}</p></div><Stamp status={selectedProfile.status} /></div><div className="knowledge-health-line"><span>{selectedProfileImpact?.knowledgeBases.length ?? 0} 知识库</span><span>{assignedEmployees.length} 员工</span><span>{assignedRoles.length} 项目角色</span><span>策略 v{selectedProfile.version}</span></div><div className="dossier-actions">{selectedProfile.status === "archived" ? <button className="button primary" disabled={!daemonAvailable || Boolean(busy)} onClick={() => void restoreSelected("profile")}>恢复 Profile</button> : <><button className="button primary" disabled={!daemonAvailable} onClick={() => setProfileEditor("edit")}>修订 Profile</button><button className="button secondary" onClick={() => setTab("impact")}>查看影响范围</button><button className="button danger" disabled={!daemonAvailable || Boolean(busy)} onClick={() => setArchiveTarget("profile")}>归档</button></>}</div></header><DossierSection number="01" title="选择与激活规则"><div className="knowledge-rule-list">{selectedProfile.rules.map((rule) => <article key={rule.id}><header><div><code>{rule.id}</code><strong>{rule.activation}</strong></div><span>优先级 {rule.priority}</span></header><dl><dt>知识库</dt><dd>{rule.selector.knowledgeBaseIds?.join(", ") || "按元数据自动选择"}</dd><dt>领域 / 产品</dt><dd>{[...(rule.selector.domains ?? []), ...(rule.selector.products ?? [])].join(", ") || "不限"}</dd><dt>Collection</dt><dd>{rule.selector.collectionIds?.join(", ") || "不限"}</dd><dt>项目 / 角色</dt><dd>{[...(rule.conditions?.projectIds ?? []), ...(rule.conditions?.projectRoleIds ?? [])].join(", ") || "不限"}</dd><dt>权威 / 敏感度</dt><dd>{rule.selector.authorities?.join(", ") || "不限"} · ≤ {rule.selector.maxClassification ?? "restricted"}</dd><dt>预算</dt><dd>{rule.budget.maxCollections} Collections · {rule.budget.maxChunks} Chunks · {rule.budget.maxTokens} Tokens</dd></dl></article>)}</div></DossierSection><DossierSection number="02" title="当前匹配的知识库"><div className="knowledge-profile-base-list">{selectedProfileImpact?.knowledgeBases.map((item) => <article key={item.knowledgeBaseId}><span>{item.rules.some((rule) => rule.matchMode === "metadata") ? "自" : "显"}</span><div><strong>{item.knowledgeBaseName}</strong><code>{item.knowledgeBaseId} · R{item.publishedRevision ?? "—"}</code><small>{item.rules.flatMap((rule) => rule.collectionIds).join("、")}</small></div><Stamp status={item.knowledgeBaseStatus} /></article>)}{!selectedProfileImpact?.knowledgeBases.length && <p className="muted">当前目录中没有知识库匹配这份 Profile。</p>}</div></DossierSection><div className="dossier-columns"><DossierSection number="03" title="员工继承"><div className="knowledge-assignment-list">{assignedEmployees.length ? assignedEmployees.map((employee) => <article key={employee.id}><strong>{employee.identity.displayName}</strong><code>{employee.id} · v{employee.version}</code></article>) : <p className="muted">尚未分配给员工。</p>}</div></DossierSection><DossierSection number="04" title="项目角色叠加"><div className="knowledge-assignment-list">{assignedRoles.length ? assignedRoles.map((role) => <article key={role}><strong>{role}</strong><small>仅在项目任用中生效</small></article>) : <p className="muted">尚未由项目角色追加。</p>}</div></DossierSection></div><DossierSection number="05" title="运行原则"><div className="knowledge-principle"><span>授权候选</span><i>→</i><span>条件激活</span><i>→</i><span>路由缩小</span><i>→</i><span>证据注入</span></div><p className="muted">Router 只能从这份 Profile 允许的范围中做减法。每次实际选择会作为 Knowledge Plan 保存到 Run。</p></DossierSection></div>}</main>
    </div>}

    {tab === "impact" && <main className="knowledge-impact-console" role="tabpanel">
      <header className="knowledge-impact-header"><div><span>ACCESS GRAPH · EXPLAINABLE</span><h2>影响与授权</h2><p>展示知识库将通过哪些 Profile 到达员工和项目角色；这里只呈现确定性匹配，不让 Agent 猜权限。</p></div><div className="impact-legend"><span><b>显</b>显式知识库</span><span><b>自</b>领域 / 产品 / 项目自动匹配</span></div></header>
      {impact?.danglingAssignments.length ? <section className="knowledge-dangling"><header><strong>{impact.danglingAssignments.length} 条失效引用</strong><span>这些引用会在 Resolver 中被排除。</span></header>{impact.danglingAssignments.map((item) => <article key={`${item.source}-${item.profileId}-${item.employeeId}`}><Stamp status="blocked" /><strong>{item.profileId}</strong><span>{item.source === "employee" ? `员工 ${item.employeeId}` : `${item.projectId}/${item.roleId} · 员工 ${item.employeeId}`}</span></article>)}</section> : <section className="knowledge-impact-ok"><strong>授权引用完整</strong><span>没有员工或项目角色引用缺失的 Profile。</span></section>}
      <section className="knowledge-impact-map"><header><span>知识库</span><span>Profile 通道</span><span>最终使用方</span></header>{impact?.knowledgeBases.map((baseImpact) => { const base = knowledgeBases.find((item) => item.id === baseImpact.knowledgeBaseId); return <article key={baseImpact.knowledgeBaseId}><div className="impact-base"><span className="knowledge-card-mark">知</span><div><strong>{base?.displayName ?? baseImpact.knowledgeBaseId}</strong><code>{baseImpact.knowledgeBaseId} · {base?.classification ?? "—"}</code><small>Published R{base?.publishedRevision ?? "—"}</small></div></div><div className="impact-profiles">{baseImpact.profileMatches.length ? baseImpact.profileMatches.map((profile) => <button type="button" key={profile.profileId} onClick={() => { setSelectedProfileId(profile.profileId); setTab("profiles"); }}><b>{profile.rules.some((rule) => rule.matchMode === "metadata") ? "自" : "显"}</b><span><strong>{profile.profileName}</strong><small>{profile.rules.flatMap((rule) => rule.collectionIds).join("、")}</small></span></button>) : <span className="impact-none">没有 Profile 纳入</span>}</div><div className="impact-consumers"><span><b>{baseImpact.employees.length}</b>员工</span><span><b>{baseImpact.projectRoles.length}</b>项目角色</span>{baseImpact.employees.slice(0, 3).map((employee) => <small key={employee.employeeId}>{employee.employeeName}</small>)}</div></article>; })}{!impact?.knowledgeBases.length && <div className="knowledge-all-clear"><strong>尚无知识库</strong><span>建立知识库和 Profile 后，这里会形成可解释的授权链。</span></div>}</section>
      <section className="knowledge-profile-governance"><header><div><span>PROFILE GOVERNANCE</span><h2>策略负载</h2></div></header><div>{impact?.profiles.map((profileImpact) => { const profile = profiles.find((item) => item.id === profileImpact.profileId); return <article key={profileImpact.profileId}><header><div><strong>{profile?.displayName ?? profileImpact.profileId}</strong><code>{profileImpact.profileId} · v{profile?.version ?? "—"}</code></div><Stamp status={profile?.status ?? "blocked"} /></header><dl><dt>候选知识库</dt><dd>{profileImpact.knowledgeBases.length}</dd><dt>直接员工</dt><dd>{profileImpact.employees.length}</dd><dt>项目角色</dt><dd>{profileImpact.projectRoles.length}</dd><dt>自动匹配</dt><dd>{profileImpact.knowledgeBases.filter((base) => base.rules.some((rule) => rule.matchMode === "metadata")).length}</dd></dl><button type="button" className="text-button" onClick={() => { setSelectedProfileId(profileImpact.profileId); setTab("profiles"); }}>打开策略档案</button></article>; })}</div></section>
      <section className="knowledge-perspective-console"><header><div><span>EMPLOYEE PERSPECTIVE · EXPLAINABLE</span><h2>员工知识视角</h2><p>选择一名员工，按模拟任务上下文查看 eligible（已授权）、activated（当前任务激活）与 selected（实际入选）三层差异，以及每条 Profile / rule / reason / matches 解释和授权元数据。</p></div><Field label="选择员工"><SelectControl ariaLabel="选择知识视角员工" value={perspectiveEmployee?.id ?? ""} emptyLabel="尚无活动员工" options={perspectiveCandidates.map((employee) => ({ value: employee.id, label: employee.identity.displayName, description: `${employee.id} · v${employee.version}` }))} onChange={setPerspectiveEmployeeId} /></Field></header>
        {perspectiveEmployee ? <KnowledgePerspectiveExplorer employee={perspectiveEmployee} bindings={data.projectBindings} notify={notify} /> : <div className="knowledge-all-clear"><strong>没有可查看的员工</strong><span>建立或恢复一名员工后，这里可以检查他的知识视角。</span></div>}
      </section>
    </main>}

    {tab === "reviews" && <KnowledgeReviewBoard data={data} refresh={refresh} notify={notify} />}

    {tab === "assistant" && <KnowledgeStewardConsole data={data} refresh={refresh} notify={notify} />}

    {editor && <KnowledgeBaseEditor knowledgeBase={editor === "edit" ? selectedBase : undefined} notify={notify} onClose={() => setEditor(null)} onSaved={async (id) => { setEditor(null); setSelectedBaseId(id); await reloadDetail(); }} />}
    {revisionOpen && detail && <RevisionEditor detail={detail} notify={notify} onClose={() => setRevisionOpen(false)} onSaved={async () => { setRevisionOpen(false); await reloadDetail(); }} />}
    {profileEditor && <KnowledgeProfilePolicyEditor profile={profileEditor === "edit" ? selectedProfile : undefined} knowledgeBases={knowledgeBases} notify={notify} onClose={() => setProfileEditor(null)} onSaved={async (id) => { setProfileEditor(null); setSelectedProfileId(id); await reloadDetail(); }} />}
    {previewRevision && selectedBase && <RevisionPreviewModal knowledgeBase={selectedBase} revision={previewRevision} notify={notify} onClose={() => setPreviewRevision(undefined)} />}
    {publishRevision && selectedBase && <PublishReviewModal knowledgeBase={selectedBase} revision={publishRevision} impact={impact} notify={notify} onPublished={reloadDetail} onClose={() => setPublishRevision(undefined)} />}
    {archiveTarget && <Modal title={archiveTarget === "base" ? "归档知识库" : "归档知识 Profile"} eyebrow="SOFT ARCHIVE · HISTORY KEPT" onClose={() => setArchiveTarget(null)}><div className="modal-body"><div className="danger-notice"><b>后续运行将不再使用这项知识配置。</b><p>{archiveTarget === "base" ? "所有 Revision、索引、发布指针和历史 Run 引用都会保留。引用它的 Profile 会在 Knowledge Plan 中记录排除原因。" : "Profile 版本和现有员工引用会保留；后续调用会在 Knowledge Plan 中明确记录它已归档。"}</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setArchiveTarget(null)}>取消</button><button className="button danger-filled" disabled={!daemonAvailable || Boolean(busy)} onClick={() => void archiveSelected()}>{busy === "archive" ? "归档中…" : "确认归档"}</button></div></div></Modal>}
  </div>;
}
