import { useState, type FormEvent } from "react";
import { api, writeBody } from "../api";
import {
  DossierSection,
  Field,
  Modal,
  SelectControl,
  useDaemonAvailable
} from "../components";
import type {
  Bootstrap,
  KnowledgeAuthority,
  KnowledgeBase,
  KnowledgeBaseDetail,
  KnowledgeClassification,
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeSource
} from "../types";

export interface PageProps {
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

export function list(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function KnowledgeBaseEditor({ knowledgeBase, onClose, onSaved, notify }: {
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

export function RevisionEditor({ detail, onClose, onSaved, notify }: {
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
