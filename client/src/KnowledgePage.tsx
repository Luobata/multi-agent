import { useEffect, useMemo, useState } from "react";
import { api, writeBody } from "./api";
import {
  DossierSection,
  EmptyState,
  Field,
  Modal,
  SelectControl,
  Stamp,
  UtilityIcon,
  formatTime,
  useDaemonAvailable
} from "./components";
import type {
  KnowledgeBaseDetail,
  KnowledgeImpactSnapshot
} from "./types";
import { KnowledgePerspectiveExplorer } from "./knowledgePerspective";
import { KnowledgeBaseEditor, RevisionEditor, type PageProps } from "./knowledge/editors";
import { AssessmentPanel, PublishReviewModal, RevisionPreviewModal, assessmentCopy, assessmentStamp } from "./knowledge/releases";
import { KnowledgeProfilePolicyEditor } from "./knowledge/profiles";
import { KnowledgeStewardConsole } from "./knowledge/steward";
import { KnowledgeWikiBrowser } from "./knowledge/wiki";
import { UrlImportModal } from "./knowledge/urlImport";
import { KnowledgeReviewBoard } from "./knowledge/review";

export { KnowledgeProfilePolicyEditor } from "./knowledge/profiles";
export { KNOWLEDGE_STEWARD_ROLE_ID, KnowledgeStewardConsole, findKnowledgeStewardProjects, knowledgeChangeStamp, listKnowledgeStewardSessions } from "./knowledge/steward";
export { KnowledgeWikiBrowser, WikiDirectoryTree, buildWikiDirectory, buildWikiTree, filterWikiDirectory, findWikiDirectoryPath, type WikiDirectoryNode, type WikiDirectoryNodeKind, type WikiTreeNode } from "./knowledge/wiki";
export { UrlImportModal } from "./knowledge/urlImport";
export { KnowledgeReviewBoard, buildGrantReviewSetPayload, resolveReviewSubject, type GrantReviewOverride, type GrantReviewSetPayload, type ReviewActionMode } from "./knowledge/review";

type KnowledgeConsoleTab = "overview" | "catalog" | "wiki" | "releases" | "profiles" | "impact" | "reviews" | "assistant";

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
