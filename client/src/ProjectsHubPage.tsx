/** 统一项目入口：真实接入与虚拟目录在同一个信息架构下协作。 */
import { useCallback, useState } from "react";
import { ProjectPage } from "./ProjectPage";
import { SpacesPage } from "./SpacesPage";
import type { Bootstrap } from "./types";
import { DashTabs, PageHeader, dashTabId, dashTabPanelId, type DashTab } from "./dashboard/view";

type ProjectHubTab = "directory" | "access";

const PROJECT_TABS: DashTab[] = [
  { id: "directory", label: "项目目录", ariaLabel: "已接入项目的虚拟目录" },
  { id: "access", label: "接入与角色", ariaLabel: "项目声明、角色任用与 Skills" }
];

export function ProjectsHubPage({ data, refresh, go, notify }: {
  data: Bootstrap;
  refresh: () => Promise<void>;
  go: (hash: string) => void;
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const [activeTab, setActiveTab] = useState<ProjectHubTab>("directory");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [connectRequest, setConnectRequest] = useState(0);
  const handleConnectRequestHandled = useCallback(() => setConnectRequest(0), []);
  const tabBase = "projects-hub";
  const catalogRevision = data.projects.map((project) => `${project.id}:${project.version}:${project.status}:${project.updatedAt}`).join("|");
  const openAccess = (projectId?: string, connect = false) => {
    if (projectId) setSelectedProjectId(projectId);
    if (connect) setConnectRequest((request) => request + 1);
    setActiveTab("access");
  };

  return <main className="dash-page projects-hub">
    <PageHeader
      eyebrow="PROJECTS / CONNECTED CATALOG"
      title="项目"
      description="只有正式接入且 active 的项目可以承接需求；文件夹是虚拟分类，不会移动本地仓库。"
      actions={<button type="button" className="button primary" onClick={() => openAccess(undefined, true)}>接入项目</button>}
    />
    <DashTabs baseId={tabBase} ariaLabel="项目管理分区" tabs={PROJECT_TABS} activeTab={activeTab} onChange={(id) => setActiveTab(id as ProjectHubTab)} />

    <section id={dashTabPanelId(tabBase, "directory")} role="tabpanel" aria-labelledby={dashTabId(tabBase, "directory")} hidden={activeTab !== "directory"}>
      <SpacesPage embedded go={go} notify={notify} onConnect={() => openAccess(undefined, true)} onOpenAccess={openAccess} catalogRevision={catalogRevision} />
    </section>
    <section id={dashTabPanelId(tabBase, "access")} role="tabpanel" aria-labelledby={dashTabId(tabBase, "access")} hidden={activeTab !== "access"}>
      <ProjectPage data={data} refresh={refresh} notify={notify} initialProjectId={selectedProjectId || undefined} connectRequest={connectRequest} onConnectRequestHandled={handleConnectRequestHandled} />
    </section>
  </main>;
}
