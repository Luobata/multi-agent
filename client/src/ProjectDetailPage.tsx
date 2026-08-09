/** 项目详情：概览、仓库、成员 / 角色、Skills / 知识与阶段一设置。 */
import { useState } from "react";
import { DossierSection, EmptyState, Field, Modal, ReadonlyEvidence, Stamp, SwitchControl, useDaemonAvailable } from "./components";
import { dashboardService, type DashboardService } from "./dashboard/service";
import type { ManagedProject, ProjectProfile, SpaceNode } from "./dashboard/types";
import { DashTabs, ErrorBlock, OfflineNotice, PageHeader, SkeletonBlock, UndoToast, dashTabId, dashTabPanelId, type DashTab, useServiceData } from "./dashboard/view";

type ProjectDetailTab = "overview" | "repositories" | "members" | "knowledge" | "settings";

const PROJECT_DETAIL_TABS: DashTab[] = [
  { id: "overview", label: "项目概览" },
  { id: "repositories", label: "Repositories", ariaLabel: "仓库配置" },
  { id: "members", label: "成员 / 角色" },
  { id: "knowledge", label: "Skills / 知识" },
  { id: "settings", label: "项目设置" }
];

export function ProjectDetailPage({ spaceId, go, notify, service = dashboardService }: {
  spaceId: string;
  go: (hash: string) => void;
  notify: (message: string, kind?: "success" | "error") => void;
  service?: DashboardService;
}) {
  const daemonAvailable = useDaemonAvailable();
  const { state, reload, setData } = useServiceData<ProjectProfile>(() => service.getProjectProfile(spaceId), [service, spaceId]);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoLabel, setRepoLabel] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [repoBranch, setRepoBranch] = useState("main");
  const [repoError, setRepoError] = useState("");
  const [savingRepo, setSavingRepo] = useState(false);
  const [activeTab, setActiveTab] = useState<ProjectDetailTab>("overview");
  const [undo, setUndo] = useState<{ message: string; revert: () => Promise<SpaceNode> } | null>(null);

  const profile = state.status === "ready" ? state.data : undefined;
  const project = profile?.project;
  const fail = (error: unknown) => notify(error instanceof Error ? error.message : String(error), "error");
  const replaceProject = (updated: ManagedProject) => profile && setData({ ...profile, project: updated });

  const rename = async (target: ManagedProject) => {
    const next = draftName.trim();
    setEditing(false);
    if (!next || next === target.name) return;
    try {
      replaceProject(await service.renameNode(target.id, next) as ManagedProject);
      notify(`项目已重命名为「${next}」`);
    } catch (error) { fail(error); }
  };

  const favorite = (target: ManagedProject) => {
    if (!daemonAvailable || !profile) return;
    const snapshot = profile;
    replaceProject({ ...target, favorite: !target.favorite });
    setUndo({
      message: target.favorite ? `已取消收藏「${target.name}」` : `已收藏「${target.name}」`,
      revert: () => service.toggleFavorite(target.id)
    });
    service.toggleFavorite(target.id).then((updated) => replaceProject(updated as ManagedProject)).catch((error: unknown) => { setData(snapshot); setUndo(null); fail(error); });
  };

  const archive = async (target: ManagedProject) => {
    setArchiveOpen(false);
    try {
      await service.archiveNode(target.id);
      notify(`「${target.name}」已归档；可在归档中心恢复，磁盘文件不动`);
      go("archive");
    } catch (error) { fail(error); }
  };

  const bindRepository = async () => {
    if (!project) return;
    setSavingRepo(true); setRepoError("");
    try {
      replaceProject(await service.bindRepository({ projectId: project.id, label: repoLabel, path: repoPath, defaultBranch: repoBranch }));
      setRepoOpen(false); setRepoLabel(""); setRepoPath(""); setRepoBranch("main");
      notify("本地仓库路径已绑定；仅保存配置，不会移动磁盘文件");
    } catch (error) { setRepoError(error instanceof Error ? error.message : String(error)); }
    finally { setSavingRepo(false); }
  };

  return <main className="dash-page">
    <PageHeader eyebrow="SPACE / PROJECT DOSSIER" title="项目详情" description="项目管理控制面：逻辑项目与真实 Repository path 始终分离。" actions={<button type="button" className="button secondary" onClick={() => go("spaces")}>← 返回项目空间</button>} />
    <OfflineNotice />
    {state.status === "loading" && <SkeletonBlock rows={5} label="正在加载项目详情" />}
    {state.status === "error" && <ErrorBlock message={state.error ?? "加载失败"} onRetry={reload} />}
    {state.status === "ready" && !project && <EmptyState title="没有找到这个项目" action={<button type="button" className="button secondary" onClick={() => go("spaces")}>返回项目空间</button>}><p>项目可能已归档，请从归档中心恢复。</p></EmptyState>}
    {state.status === "ready" && profile && project && <div className="dash-dossier">
      <div className="dash-panel dash-project-cover">
        <div className="dash-project-title">
          {editing ? <input className="space-rename-input" aria-label="重命名项目" value={draftName} autoFocus maxLength={40} onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void rename(project); if (event.key === "Escape") setEditing(false); }} onBlur={() => setEditing(false)} /> : <h2>{project.name}</h2>}
          <Stamp status="active" label="在册项目" />
        </div>
        <div className="dash-project-actions"><button type="button" className="button primary" onClick={() => go(`spaces/${project.id}/board`)}>打开需求看板 →</button><button type="button" className="button secondary" disabled={!daemonAvailable} onClick={() => { setEditing(true); setDraftName(project.name); }}>重命名</button><button type="button" className="button danger" disabled={!daemonAvailable} onClick={() => setArchiveOpen(true)}>归档项目</button></div>
      </div>

      <DashTabs baseId={`project-${project.id}`} ariaLabel={`${project.name} 项目分区`} tabs={PROJECT_DETAIL_TABS} activeTab={activeTab} onChange={(tabId) => setActiveTab(tabId as ProjectDetailTab)} />
      <section
        id={dashTabPanelId(`project-${project.id}`, activeTab)}
        className="dash-tabpanel"
        role="tabpanel"
        aria-labelledby={dashTabId(`project-${project.id}`, activeTab)}
        tabIndex={0}
      >
        {activeTab === "overview" && <DossierSection number="01" title="项目概览">
          <div className="dash-profile-grid"><Field label="收藏" hint="即时保存，6 秒内可撤销。"><SwitchControl checked={project.favorite} disabled={!daemonAvailable} ariaLabel={`收藏 ${project.name}`} onChange={() => favorite(project)} /></Field><ReadonlyEvidence label="项目 ID" value={project.id} mono /><ReadonlyEvidence label="默认分支" value={project.defaultBranch} mono /></div>
          <p className="dash-hint-line">登记于 {project.createdAt.slice(0, 10)} · 最近更新 {project.updatedAt.slice(0, 10)}</p>
        </DossierSection>}

        {activeTab === "repositories" && <DossierSection number="02" title="Repositories" action={<button type="button" className="button secondary" disabled={!daemonAvailable} onClick={() => { setRepoError(""); setRepoOpen(true); }}>绑定本地仓库</button>}>
          <p className="dash-hint-line">绑定一个或多个本地路径；只保存配置，不移动、重命名或修改磁盘代码。</p>
          <div className="dash-repo-list">{project.repositories.map((repository) => <article key={repository.id}><div><strong>{repository.label}</strong>{repository.primary && <Stamp status="active" label="主仓库" />}</div><code>{repository.path}</code><small>默认分支 · {repository.defaultBranch}</small></article>)}</div>
        </DossierSection>}

        {activeTab === "members" && <DossierSection number="03" title="成员 / 角色">
          <div className="dash-member-grid">{profile.members.map((member) => <article key={member.id}><span>{member.name.slice(0, 2)}</span><div><strong>{member.name}</strong><small>{member.role}</small></div><Stamp status={member.status === "active" ? "active" : "pending"} /></article>)}</div>
        </DossierSection>}

        {activeTab === "knowledge" && <DossierSection number="04" title="Skills / 知识">
          <div className="dash-profile-columns"><section><h4>Skills</h4>{profile.skills.map((skill) => <div className="dash-profile-row" key={skill.id}><strong>{skill.name}</strong><small>{skill.source}</small></div>)}</section><section><h4>Knowledge / Documents</h4>{profile.knowledge.map((item) => <div className="dash-profile-row" key={item.id}><strong>{item.title}</strong><small>{item.kind === "document" ? "文档" : "知识库"} · {item.updatedAt.slice(0, 10)}</small></div>)}</section></div>
        </DossierSection>}

        {activeTab === "settings" && <DossierSection number="05" title="项目设置">
          <p className="dash-hint-line">阶段一只开放名称、收藏、仓库绑定与归档。Provider、并发、Worktree 和 Gate 在全局设置中只读展示。</p>
          <button type="button" className="text-button" onClick={() => go("settings")}>打开设置·集成 →</button>
        </DossierSection>}
      </section>
    </div>}

    {repoOpen && <Modal title="绑定本地仓库" eyebrow="REPOSITORY · CONFIG ONLY" onClose={() => setRepoOpen(false)}><form className="modal-body compact-form" onSubmit={(event) => { event.preventDefault(); void bindRepository(); }}><Field label="显示名称"><input required value={repoLabel} onChange={(event) => setRepoLabel(event.target.value)} placeholder="例如：服务端仓库" /></Field><Field label="Repository path" hint="仅保存配置，不会移动磁盘上的文件。"><input required value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="/path/to/repository" /></Field><Field label="默认分支"><input value={repoBranch} onChange={(event) => setRepoBranch(event.target.value)} /></Field>{repoError && <p className="dash-form-error" role="alert">{repoError}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setRepoOpen(false)}>取消</button><button type="submit" className="button primary" disabled={savingRepo}>{savingRepo ? "保存中…" : "保存绑定"}</button></div></form></Modal>}
    {archiveOpen && project && <Modal title={`归档「${project.name}」`} eyebrow="ARCHIVE · RECOVERABLE" onClose={() => setArchiveOpen(false)}><div className="modal-body"><div className="danger-notice"><b>归档后从空间树隐藏，看板进入只读保护。</b><p>可在归档中心恢复；不会删除磁盘上的文件。</p></div><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setArchiveOpen(false)}>取消</button><button type="button" className="button danger-filled" disabled={!daemonAvailable} onClick={() => void archive(project)}>确认归档</button></div></div></Modal>}
    {undo && <UndoToast message={undo.message} onUndo={() => { const current = undo; setUndo(null); void current.revert().then((reverted) => { if (reverted.kind === "project") replaceProject(reverted); notify("已撤销"); }).catch(fail); }} onClose={() => setUndo(null)} />}
  </main>;
}
