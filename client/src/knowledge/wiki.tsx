import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api } from "../api";
import {
  Field,
  SelectControl,
  Stamp,
  formatTime
} from "../components";
import type {
  KnowledgeAuthority,
  KnowledgeBase,
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeReferenceType,
  KnowledgeWikiDocument,
  KnowledgeWikiView
} from "../types";
import type { PageProps } from "./editors";

export const REFERENCE_TYPE_COPY: Record<KnowledgeReferenceType, string> = {
  related: "相关",
  supports: "支持",
  contradicts: "矛盾",
  "depends-on": "依赖",
  supersedes: "取代"
};

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
