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
  const [connectSeed, setConnectSeed] = useState<{ accessId: string; rootPath?: string }>();
  const handleConnectRequestHandled = useCallback(() => setConnectRequest(0), []);
  const tabBase = "projects-hub";
  const catalogRevision = [
    ...data.projects.map((project) => `${project.id}:${project.version}:${project.status}:${project.updatedAt}`),
    ...(data.passiveProjectAccesses ?? []).map((access) => `${access.id}:${access.rootPath ?? ""}:${access.projectKeys.join(",")}:${access.requestCount}:${access.lastSeenAt}:${access.linkedProjectId ?? ""}`)
  ].join("|");
  const openAccess = (projectId?: string) => {
    if (projectId) setSelectedProjectId(projectId);
    setActiveTab("access");
  };
  const readDescriptor = (seed?: { accessId: string; rootPath?: string }) => {
    setConnectSeed(seed);
    setConnectRequest((request) => request + 1);
    setActiveTab("access");
  };
  const completeMcp = (accessId: string) => {
    const access = (data.passiveProjectAccesses ?? []).find((candidate) => candidate.id === accessId);
    readDescriptor({ accessId, rootPath: access?.rootPath });
  };

  return <main className="dash-page projects-hub">
    <PageHeader
      eyebrow="PROJECTS / CONNECTED CATALOG"
      title="项目"
      description="MCP 首次实际调用后，项目自动进入目录；完善为 active 正式项目后才可承接需求。文件夹不会移动本地仓库。"
      actions={<><button type="button" className="button secondary" onClick={() => readDescriptor()}>读取声明</button><button type="button" className="button primary" onClick={() => openAccess()}>MCP 接入说明</button></>}
    />
    <DashTabs baseId={tabBase} ariaLabel="项目管理分区" tabs={PROJECT_TABS} activeTab={activeTab} onChange={(id) => setActiveTab(id as ProjectHubTab)} />

    <section id={dashTabPanelId(tabBase, "directory")} role="tabpanel" aria-labelledby={dashTabId(tabBase, "directory")} hidden={activeTab !== "directory"}>
      <SpacesPage embedded go={go} notify={notify} onConnect={() => openAccess()} onReadDescriptor={() => readDescriptor()} onOpenAccess={openAccess} onCompleteMcp={completeMcp} catalogRevision={catalogRevision} />
    </section>
    <section id={dashTabPanelId(tabBase, "access")} role="tabpanel" aria-labelledby={dashTabId(tabBase, "access")} hidden={activeTab !== "access"}>
      <ProjectPage data={data} refresh={refresh} notify={notify} initialProjectId={selectedProjectId || undefined} connectRequest={connectRequest} connectSeed={connectSeed} onConnectRequestHandled={handleConnectRequestHandled} />
    </section>
  </main>;
}
