/** 统一项目目录：正式 Project 与 MCP 发现证据共用一棵虚拟树。 */
import { useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { EmptyState, Field, Modal, SelectControl, Stamp, formatTime, useDaemonAvailable } from "./components";
import { dashboardService, type DashboardService } from "./dashboard/service";
import type { FolderNode, McpObservedProject, SpaceNode } from "./dashboard/types";
import { ErrorBlock, OfflineNotice, PageHeader, SkeletonBlock, UndoToast, useServiceData } from "./dashboard/view";

type SpaceFilter = "all" | "favorite" | "folder" | "project" | "mcp";

interface UndoState {
  message: string;
  revert: () => Promise<SpaceNode>;
}

const FILTER_OPTIONS = [
  { value: "all", label: "全部节点" },
  { value: "favorite", label: "仅收藏" },
  { value: "folder", label: "仅文件夹" },
  { value: "project", label: "仅正式项目" },
  { value: "mcp", label: "仅 MCP 发现" }
];

function isDescendantOf(nodes: SpaceNode[], ancestorId: string, candidateId: string): boolean {
  let cursor = nodes.find((node) => node.id === candidateId);
  while (cursor?.parentId) {
    if (cursor.parentId === ancestorId) return true;
    cursor = nodes.find((node) => node.id === cursor?.parentId);
  }
  return false;
}

export function SpacesPage({ go, notify, service = dashboardService, embedded = false, onConnect, onReadDescriptor, onOpenAccess, onCompleteMcp, catalogRevision = "" }: {
  go: (hash: string) => void;
  notify: (message: string, kind?: "success" | "error") => void;
  service?: DashboardService;
  embedded?: boolean;
  /** 打开 MCP 主接入说明。 */
  onConnect?: () => void;
  /** 打开声明文件兜底接入。 */
  onReadDescriptor?: () => void;
  onOpenAccess?: (projectId: string) => void;
  onCompleteMcp?: (accessId: string) => void;
  catalogRevision?: string;
}) {
  const daemonAvailable = useDaemonAvailable();
  const { state, reload, setData } = useServiceData<SpaceNode[]>(() => service.listSpaces(), [service, catalogRevision]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SpaceFilter>("all");
  const [createKind, setCreateKind] = useState<"folder" | null>(null);
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingName, setEditingName] = useState("");
  const [movingNode, setMovingNode] = useState<SpaceNode | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [archivingNode, setArchivingNode] = useState<SpaceNode | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);

  const nodes = state.status === "ready" ? state.data ?? [] : [];
  const liveNodes = useMemo(() => nodes.filter((node) => !node.archivedAt), [nodes]);
  const folders = useMemo(() => liveNodes.filter((node): node is FolderNode => node.kind === "folder"), [liveNodes]);
  const browsing = query.trim() !== "" || filter !== "all";

  const visibleNodes = useMemo(() => {
    const term = query.trim().toLowerCase();
    return liveNodes.filter((node) => {
      if (filter === "favorite" && !node.favorite) return false;
      if (filter === "folder" && node.kind !== "folder") return false;
      if (filter === "project" && node.kind !== "project") return false;
      if (filter === "mcp" && node.kind !== "mcp-observed") return false;
      if (!term) return true;
      const searchable = node.kind === "project"
        ? `${node.repositoryPath} ${node.mcpAccess?.projectKeys.join(" ") ?? ""}`
        : node.kind === "mcp-observed"
          ? `${node.rootPath ?? ""} ${node.projectKeys.join(" ")}`
          : "";
      return node.name.toLowerCase().includes(term) || searchable.toLowerCase().includes(term);
    });
  }, [liveNodes, query, filter]);

  const childrenOf = (parentId: string | null): SpaceNode[] =>
    liveNodes
      .filter((node) => (node.parentId ?? null) === parentId)
      .sort((left, right) => {
        const rank = { folder: 0, project: 1, "mcp-observed": 2 } as const;
        return rank[left.kind] === rank[right.kind]
          ? left.name.localeCompare(right.name, "zh-CN")
          : rank[left.kind] - rank[right.kind];
      });

  const replaceNode = (updated: SpaceNode) => setData(nodes.map((node) => (node.id === updated.id ? updated : node)));
  const fail = (error: unknown) => notify(error instanceof Error ? error.message : String(error), "error");

  const submitCreate = async () => {
    setSaving(true);
    setFormError("");
    try {
      const folder = await service.createFolder({ parentId: createParentId, name: createName });
      setData([...nodes, folder]);
      notify(`文件夹「${folder.name}」已建好`);
      setCreateKind(null);
      setCreateName("");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const submitRename = async (node: SpaceNode) => {
    const next = editingName.trim();
    setEditingId("");
    if (!next || next === node.name) return;
    try {
      const updated = await service.renameNode(node.id, next);
      replaceNode(updated);
      notify(`已重命名为「${updated.name}」`);
    } catch (error) {
      fail(error);
    }
  };

  /** 移动 / 收藏：先乐观更新，失败回滚；成功后给出 6s 撤销 Toast。 */
  const optimistic = (updated: SpaceNode, message: string, apply: () => Promise<SpaceNode>, revert: () => Promise<SpaceNode>) => {
    const snapshot = nodes;
    replaceNode(updated);
    setUndo({
      message,
      revert: async () => {
        try {
          return await revert();
        } catch (error) {
          setData(snapshot);
          fail(error);
          throw error;
        }
      }
    });
    apply()
      .then(replaceNode)
      .catch((error: unknown) => { setData(snapshot); setUndo(null); fail(error); });
  };

  const favorite = (node: SpaceNode) => {
    if (!daemonAvailable) return;
    optimistic(
      { ...node, favorite: !node.favorite },
      node.favorite ? `已取消收藏「${node.name}」` : `已收藏「${node.name}」`,
      () => service.toggleFavorite(node.id),
      () => service.toggleFavorite(node.id)
    );
  };

  const move = () => {
    if (!movingNode) return;
    const node = movingNode;
    const target = moveTarget === "root" ? null : moveTarget;
    const previousParent = node.parentId;
    setMovingNode(null);
    optimistic(
      { ...node, parentId: target },
      `已把「${node.name}」移动到新位置`,
      () => service.moveNode(node.id, target),
      () => service.moveNode(node.id, previousParent)
    );
  };

  const archive = async () => {
    if (!archivingNode) return;
    const node = archivingNode;
    setArchivingNode(null);
    try {
      await service.archiveNode(node.id);
      setData(nodes.map((candidate) => (candidate.id === node.id ? { ...candidate, archivedAt: new Date().toISOString() } : candidate)));
      notify(`「${node.name}」已归档；可在归档中心恢复，磁盘文件不动`);
    } catch (error) {
      fail(error);
    }
  };

  const moveOptions = [
    { value: "root", label: "根层（不归入文件夹）" },
    ...folders
      .filter((folder) => !movingNode || (folder.id !== movingNode.id && !isDescendantOf(nodes, movingNode.id, folder.id)))
      .map((folder) => ({ value: folder.id, label: folder.name }))
  ];

  const renderRow = (node: SpaceNode, depth: number): ReactElement => {
    const editing = editingId === node.id;
    const observed = node.kind === "mcp-observed" ? node : undefined;
    const kindLabel = node.kind === "folder" ? "夹" : node.kind === "project" ? "项" : "M";
    return <div className="space-row" style={{ "--depth": depth } as CSSProperties}>
      <span className={`space-kind space-kind--${node.kind}`} aria-hidden="true">{kindLabel}</span>
      <span className="space-primary">{editing
        ? <input
            className="space-rename-input"
            aria-label={`重命名 ${node.name}`}
            value={editingName}
            autoFocus
            maxLength={40}
            onChange={(event) => setEditingName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void submitRename(node); }
              if (event.key === "Escape") { event.preventDefault(); setEditingId(""); }
            }}
            onBlur={() => setEditingId("")}
          />
        : node.kind === "project"
          ? <button type="button" className="space-name" onClick={() => go(`projects/${node.id}`)} title="打开项目详情">
              {node.name}{node.favorite && <span className="space-fav" aria-label="已收藏">★</span>}
            </button>
          : <span className="space-name space-name--static" title={node.name}>{node.name}{node.favorite && <span className="space-fav" aria-label="已收藏">★</span>}</span>}
        {node.kind === "project" && node.mcpAccess && <span className="space-access-badge is-linked">MCP 已接通</span>}
        {observed && <span className="space-access-badge">{observed.historical ? "历史调用 · 缺根目录" : "MCP 已发现 · 待完善"}</span>}
      </span>
      {node.kind === "project" && <span className="space-meta"><code className="space-path" title="仅保存配置，不会移动磁盘上的文件">{node.repositoryPath}</code>{node.mcpAccess && <small>最近调用 {formatTime(node.mcpAccess.lastSeenAt)} · {node.mcpAccess.requestCount} 次</small>}</span>}
      {observed && <span className="space-meta"><code className="space-path">{observed.rootPath ?? "未记录工作目录"}</code><small>{observed.projectKeys.length > 0 ? `项目标识 ${observed.projectKeys.join(" · ")}` : "等待补全项目标识"} · 最近 {formatTime(observed.lastSeenAt)}</small></span>}
      {node.kind === "folder" && <span className="space-meta"><small>虚拟分类 · 不移动磁盘目录</small></span>}
      <span className="space-actions">
        {node.kind === "project" && <button type="button" className="text-button" onClick={() => go(`projects/${node.id}/board`)}>看板</button>}
        {node.kind === "project" && <button type="button" className="text-button" onClick={() => onOpenAccess?.(node.id)}>接入配置</button>}
        {observed && <button type="button" className="text-button space-complete-action" disabled={!daemonAvailable} onClick={() => onCompleteMcp?.(observed.accessId)}>{observed.historical ? "补全路径并接入" : "完善接入"}</button>}
        {node.kind === "folder" && <button type="button" className="text-button" disabled={!daemonAvailable} onClick={() => { setEditingId(node.id); setEditingName(node.name); }}>重命名</button>}
        <button type="button" className="text-button" disabled={!daemonAvailable} onClick={() => { setMovingNode(node); setMoveTarget(node.parentId ?? "root"); }}>移动</button>
        <button type="button" className="text-button" disabled={!daemonAvailable} aria-pressed={node.favorite} onClick={() => favorite(node)}>{node.favorite ? "取消收藏" : "收藏"}</button>
        {node.kind === "folder" && <button type="button" className="text-button space-danger" disabled={!daemonAvailable} onClick={() => setArchivingNode(node)}>归档</button>}
      </span>
    </div>;
  };

  const renderNode = (node: SpaceNode, depth: number): ReactElement => {
    const children = node.kind === "folder" ? childrenOf(node.id) : [];
    return <li key={node.id}>
      {renderRow(node, depth)}
      {children.length > 0 && <ul className="space-children">{children.map((child) => renderNode(child, depth + 1))}</ul>}
    </li>;
  };

  const rootNodes = childrenOf(null);

  return <section className={embedded ? "projects-hub-panel" : "dash-page"} aria-label={embedded ? "项目目录" : undefined}>
    {!embedded && <PageHeader eyebrow="PROJECTS / MCP CATALOG" title="项目" description="MCP 调用自动发现项目；完善为正式项目后才可承接需求。虚拟文件夹不会移动磁盘代码。" actions={<>
      <button type="button" className="button secondary" disabled={!daemonAvailable} onClick={() => { setCreateKind("folder"); setCreateParentId(null); setFormError(""); }}>新建文件夹</button>
      <button type="button" className="button primary" onClick={onConnect}>MCP 接入说明</button>
    </>} />}
    <OfflineNotice />

    {embedded && <div className="projects-directory-intro"><div><strong>MCP 项目目录</strong><span>其它仓库首次实际调用 MCP tool 后会自动出现；移动和收藏只改虚拟分类，不改 Repository path。</span></div><div><button type="button" className="button secondary" disabled={!daemonAvailable} onClick={() => { setCreateKind("folder"); setCreateParentId(null); setFormError(""); }}>新建文件夹</button><button type="button" className="button secondary" onClick={onReadDescriptor}>读取声明</button><button type="button" className="button primary" onClick={onConnect}>MCP 接入说明</button></div></div>}

    <div className="space-toolbar">
      <label className="space-search"><span className="sr-only">搜索节点</span><input placeholder="搜索名称或 Repository path…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <SelectControl ariaLabel="筛选节点" value={filter} options={FILTER_OPTIONS} onChange={(value) => setFilter(value as SpaceFilter)} className="space-filter" />
    </div>

    {state.status === "loading" && <SkeletonBlock rows={5} label="正在加载空间树" />}
    {state.status === "error" && <ErrorBlock message={state.error ?? "加载失败"} onRetry={reload} />}
    {state.status === "ready" && ((browsing ? visibleNodes : rootNodes).length === 0
      ? <EmptyState title={browsing ? "没有匹配的节点" : "还没有发现项目"} action={!browsing ? <button type="button" className="button primary" onClick={onConnect}>查看 MCP 接入</button> : undefined}>
        <p>{browsing ? "换个关键词或清除筛选后再试。" : "从其它本地仓库实际调用一次 MCP tool，项目会自动进入这里；也可以读取项目声明作为兜底。"}</p>
      </EmptyState>
      : browsing
        ? <ul className="space-tree space-tree--flat" aria-label="匹配节点">{visibleNodes.map((node) => <li key={node.id}>{renderRow(node, 0)}</li>)}</ul>
        : <ul className="space-tree" aria-label="空间树">{rootNodes.map((node) => renderNode(node, 0))}</ul>)}

    {state.status === "ready" && liveNodes.length > 0 && <p className="space-count"><Stamp status="active" label={`${liveNodes.filter((node) => node.kind === "project").length} 个正式项目 · ${liveNodes.filter((node) => node.kind === "mcp-observed").length} 个 MCP 待完善`} /></p>}

    {createKind && <Modal title="新建虚拟文件夹" eyebrow="FOLDER · UI CONFIG ONLY" onClose={() => setCreateKind(null)}>
      <form className="modal-body compact-form" onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
        <Field label="名称"><input required maxLength={40} disabled={saving} value={createName} onChange={(event) => setCreateName(event.target.value)} /></Field>
        <Field label="父级文件夹" hint="不选则放到空间树根层。">
          <SelectControl ariaLabel="父级文件夹" value={createParentId ?? "root"} onChange={(value) => setCreateParentId(value === "root" ? null : value)}
            options={[{ value: "root", label: "根层（不归入文件夹）" }, ...folders.map((folder) => ({ value: folder.id, label: folder.name }))]} />
        </Field>
        {formError && <p className="dash-form-error" role="alert">{formError}</p>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={() => setCreateKind(null)}>取消</button>
          <button type="submit" className="button primary" disabled={saving}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </form>
    </Modal>}

    {movingNode && <Modal title={`移动「${movingNode.name}」`} eyebrow="OPTIMISTIC · UNDO 6S" onClose={() => setMovingNode(null)}>
      <div className="modal-body">
        <p className="dash-hint-line">移动立即生效，6 秒内可在 Toast 中撤销；仅改变空间树配置。</p>
        <Field label="目标位置"><SelectControl ariaLabel="目标位置" value={moveTarget} options={moveOptions} onChange={setMoveTarget} /></Field>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={() => setMovingNode(null)}>取消</button>
          <button type="button" className="button primary" onClick={move}>确认移动</button>
        </div>
      </div>
    </Modal>}

    {archivingNode && <Modal title={`归档「${archivingNode.name}」`} eyebrow="ARCHIVE · RECOVERABLE" onClose={() => setArchivingNode(null)}>
      <div className="modal-body">
        <div className="danger-notice"><b>归档后从空间树隐藏，看板进入只读保护。</b>
          <p>归档后可在归档中心恢复；不会删除磁盘上的文件。</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={() => setArchivingNode(null)}>取消</button>
          <button type="button" className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive()}>确认归档</button>
        </div>
      </div>
    </Modal>}

    {undo && <UndoToast message={undo.message}
      onUndo={() => { const current = undo; setUndo(null); void current.revert().then((reverted) => { replaceNode(reverted); notify("已撤销"); }).catch(() => undefined); }}
      onClose={() => setUndo(null)} />}
  </section>;
}
