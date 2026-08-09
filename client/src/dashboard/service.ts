/**
 * 多项目研发后台看板 · 唯一 mock / service adapter 边界。
 * 组件禁止内联构造数据；一切读写都经过本模块。
 * 内存数据 + Promise + 80–200ms 人为延迟，用于验证各视图加载态。
 * 错误 message 一律使用中文三段式：发生了什么；怎么办；数据是否安全。
 */
import type {
  ActivityItem,
  ArchiveRecord,
  DashboardSummary,
  FolderNode,
  ManagedProject,
  ProjectProfile,
  Requirement,
  RequirementDetail,
  RequirementLane,
  SettingsSnapshot,
  SpaceNode
} from "./types";
import { REQUIREMENT_LANES, requirementLaneLabel } from "./types";
import type { Project as ConnectedProject } from "../types";

export interface DashboardService {
  /** Project 是事实源；Folder / 收藏 / 排序只是按 projectId 关联的 UI 覆盖层。 */
  syncConnectedProjects(projects: ConnectedProject[]): void;
  getDashboardSummary(): Promise<DashboardSummary>;
  listSpaces(): Promise<SpaceNode[]>;
  createFolder(input: { parentId: string | null; name: string }): Promise<FolderNode>;
  createProject(input: { parentId: string | null; name: string; repositoryPath: string; defaultBranch?: string }): Promise<ManagedProject>;
  renameNode(id: string, name: string): Promise<SpaceNode>;
  moveNode(id: string, parentId: string | null): Promise<SpaceNode>;
  toggleFavorite(id: string): Promise<SpaceNode>;
  archiveNode(id: string): Promise<ArchiveRecord>;
  restoreArchived(archiveId: string): Promise<SpaceNode | Requirement>;
  listBoard(projectId?: string): Promise<Requirement[]>;
  createRequirement(input: { projectId: string; title: string; summary: string; priority: Requirement["priority"]; rawRequirement: string; acceptanceCriteria: string[] }): Promise<Requirement>;
  getRequirement(id: string): Promise<RequirementDetail>;
  updateRequirementLane(id: string, lane: RequirementLane): Promise<Requirement>;
  archiveRequirement(id: string): Promise<ArchiveRecord>;
  getProjectProfile(id: string): Promise<ProjectProfile>;
  bindRepository(input: { projectId: string; label: string; path: string; defaultBranch?: string }): Promise<ManagedProject>;
  listArchive(): Promise<ArchiveRecord[]>;
  getSettingsSnapshot(): Promise<SettingsSnapshot>;
}

export interface DashboardServiceOptions {
  /** 测试注入 () => 0 跳过人为延迟。 */
  delayMs?: () => number;
  now?: () => Date;
  idSeed?: (prefix: string) => string;
}

interface Store {
  nodes: SpaceNode[];
  requirements: RequirementDetail[];
  activities: ActivityItem[];
  archive: ArchiveRecord[];
}

/** 中文三段式：发生了什么；怎么办；数据是否安全。 */
function failure(what: string, how: string, safe: string): Error {
  return new Error(`${what}；${how}；${safe}`);
}

const T = "2026-08-0";
const at = (day: number, hour: number, minute = 0) =>
  `${T}${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

function seed(): Store {
  const nodes: SpaceNode[] = [
    { kind: "folder", id: "fld-product", parentId: null, name: "产品线", favorite: true, archivedAt: null, createdAt: at(1, 9), updatedAt: at(3, 10) },
    { kind: "folder", id: "fld-infra", parentId: null, name: "基础设施", favorite: false, archivedAt: null, createdAt: at(1, 9, 30), updatedAt: at(2, 14) },
    { kind: "folder", id: "fld-legacy", parentId: "fld-infra", name: "历史迁移", favorite: false, archivedAt: null, createdAt: at(2, 11), updatedAt: at(2, 11) },
    { kind: "project", id: "prj-workbench", parentId: "fld-product", name: "多智能体工作台", repositoryPath: "~/dev/multi-agent", defaultBranch: "main", repositories: [
      { id: "repo-workbench", label: "主仓库", path: "~/dev/multi-agent", defaultBranch: "main", primary: true },
      { id: "repo-workbench-docs", label: "产品文档", path: "~/dev/multi-agent-docs", defaultBranch: "main", primary: false }
    ], favorite: true, archivedAt: null, createdAt: at(1, 10), updatedAt: at(6, 18) },
    { kind: "project", id: "prj-console", parentId: "fld-product", name: "运营控制台", repositoryPath: "~/dev/ops-console", defaultBranch: "main", repositories: [{ id: "repo-console", label: "主仓库", path: "~/dev/ops-console", defaultBranch: "main", primary: true }], favorite: false, archivedAt: null, createdAt: at(2, 15), updatedAt: at(5, 16) },
    { kind: "project", id: "prj-gateway", parentId: "fld-infra", name: "接入网关", repositoryPath: "~/dev/edge-gateway", defaultBranch: "trunk", repositories: [{ id: "repo-gateway", label: "主仓库", path: "~/dev/edge-gateway", defaultBranch: "trunk", primary: true }], favorite: false, archivedAt: null, createdAt: at(3, 9), updatedAt: at(4, 12) },
    { kind: "project", id: "prj-legacy-site", parentId: "fld-legacy", name: "旧官网", repositoryPath: "~/dev/legacy-site", defaultBranch: "master", repositories: [{ id: "repo-legacy", label: "主仓库", path: "~/dev/legacy-site", defaultBranch: "master", primary: true }], favorite: false, archivedAt: at(7, 10), createdAt: at(1, 8), updatedAt: at(7, 10) }
  ];
  const requirement = (partial: Omit<RequirementDetail, "rawRequirement" | "acceptanceCriteria" | "dag" | "timeline" | "resourceOverview" | "evidence"> & Partial<Pick<RequirementDetail, "rawRequirement" | "acceptanceCriteria">>): RequirementDetail => ({
    rawRequirement: `${partial.title}\n\n原始需求由产品经理登记，未经改写。`,
    acceptanceCriteria: ["关键路径可被独立验收", "失败与恢复路径有明确反馈", "不破坏既有服务端契约"],
    dag: {
      demo: true,
      nodes: [
        { id: "t1", title: "需求澄清与范围锁定", status: "completed", dependsOn: [] },
        { id: "t2", title: "交互状态矩阵与视觉落地", status: "completed", dependsOn: ["t1"] },
        { id: "t3", title: "前端实现与状态接入", status: "running", dependsOn: ["t2"] },
        { id: "t4", title: "独立行为验收", status: "pending", dependsOn: ["t3"] }
      ]
    },
    timeline: {
      demo: true,
      entries: [
        { id: "tl1", at: at(6, 9), agent: "小米汪 · 领队", action: "plan", detail: "拆分实施批次并锁定改动边界。" },
        { id: "tl2", at: at(6, 10, 30), agent: "米糊糊 · 前端", action: "delegate", detail: "接手视图实现与状态接入。" }
      ]
    },
    resourceOverview: { demo: true, agents: 3, elapsedMinutes: 128, tokensUsed: 46_200 },
    archivedAt: null,
    evidence: {
      diffSummary: "尚未产生交付 Diff；接入调度器后此处展示真实变更集。",
      testReport: "尚未产生测试报告；验收通过后归档于此。",
      reviewNotes: "尚未产生 Review 记录。",
      deliverables: []
    },
    ...partial
  });
  const requirements: RequirementDetail[] = [
    requirement({ id: "req-101", projectId: "prj-workbench", code: "REQ-101", title: "多项目研发后台看板第一阶段", summary: "工作台 / 空间树 / 看板 / 归档 / 设置占位。", lane: "running", exception: null, priority: "high", owner: "米糊糊", createdAt: at(4, 9), updatedAt: at(8, 9) }),
    requirement({ id: "req-102", projectId: "prj-workbench", code: "REQ-102", title: "看板列迁移交互", summary: "第一阶段无拖拽，经详情页目标列迁移。", lane: "planned", exception: null, priority: "medium", owner: "林墨", createdAt: at(4, 10), updatedAt: at(7, 15) }),
    requirement({ id: "req-103", projectId: "prj-workbench", code: "REQ-103", title: "调度器真实接入", summary: "DAG / 时间线 / 资源接入真实运行时。", lane: "inbox", exception: null, priority: "medium", owner: "小米汪", createdAt: at(5, 11), updatedAt: at(6, 9) }),
    requirement({ id: "req-104", projectId: "prj-workbench", code: "REQ-104", title: "归档中心恢复路径验收", summary: "恢复后回到原父节点并保留证据。", lane: "acceptance", exception: null, priority: "high", owner: "小米象", createdAt: at(3, 14), updatedAt: at(8, 8) }),
    requirement({ id: "req-105", projectId: "prj-workbench", code: "REQ-105", title: "双皮肤视觉回归", summary: "蜡笔 / 像素双主题差异核对。", lane: "done", exception: null, priority: "low", owner: "林墨", createdAt: at(2, 9), updatedAt: at(6, 17) }),
    requirement({ id: "req-106", projectId: "prj-workbench", code: "REQ-106", title: "移动端底部导航折叠", summary: "≤640 视口收纳进更多面板。", lane: "running", exception: "blocked", priority: "high", owner: "米糊糊", createdAt: at(5, 9), updatedAt: at(8, 10) }),
    requirement({ id: "req-107", projectId: "prj-console", code: "REQ-201", title: "运营指标口径澄清", summary: "与数据侧对齐统计口径。", lane: "clarify", exception: null, priority: "medium", owner: "产品经理", createdAt: at(5, 14), updatedAt: at(7, 9) }),
    requirement({ id: "req-108", projectId: "prj-console", code: "REQ-202", title: "报表导出排队策略", summary: "大报表导出排队与取消。", lane: "queued", exception: null, priority: "low", owner: "姚希", createdAt: at(6, 9), updatedAt: at(7, 12) }),
    requirement({ id: "req-109", projectId: "prj-console", code: "REQ-203", title: "登录态续期回归", summary: "续期后长连接不中断。", lane: "running", exception: "failed", priority: "high", owner: "火腿猪", createdAt: at(4, 16), updatedAt: at(8, 7) }),
    requirement({ id: "req-110", projectId: "prj-gateway", code: "REQ-301", title: "灰度发布开关", summary: "按租户灰度新路由。", lane: "planned", exception: "cancelled", priority: "medium", owner: "姚希", createdAt: at(3, 10), updatedAt: at(6, 11) }),
    requirement({ id: "req-111", projectId: "prj-console", code: "REQ-204", title: "旧版导出入口下线", summary: "已完成并归档的历史需求。", lane: "done", exception: null, priority: "low", owner: "产品经理", createdAt: at(1, 10), updatedAt: at(7, 11), archivedAt: at(7, 11) })
  ];
  const activities: ActivityItem[] = [
    { id: "act-1", at: at(8, 10), actor: "米糊糊", action: "标记阻塞", target: "REQ-106", detail: "移动端折叠依赖底部导航更多面板验收。" },
    { id: "act-2", at: at(8, 9), actor: "小米象", action: "提交验收", target: "REQ-104", detail: "恢复路径证据已固定，等待复核。" },
    { id: "act-3", at: at(7, 15), actor: "林墨", action: "更新设计", target: "REQ-102", detail: "列迁移统一走详情页 SelectControl。" },
    { id: "act-4", at: at(7, 10), actor: "小米汪", action: "归档项目", target: "旧官网", detail: "仅保留配置与证据，磁盘文件不动。" },
    { id: "act-5", at: at(6, 18), actor: "米糊糊", action: "创建需求", target: "REQ-101", detail: "第一阶段范围锁定。" }
  ];
  const archive: ArchiveRecord[] = [
    { id: "arc-1", nodeId: "prj-legacy-site", kind: "project", name: "旧官网", breadcrumb: "基础设施 / 历史迁移 / 旧官网", archivedAt: at(7, 10), archivedBy: "小米汪" },
    { id: "arc-2", nodeId: "req-111", kind: "requirement", name: "REQ-204 · 旧版导出入口下线", breadcrumb: "运营控制台 / 已完成", archivedAt: at(7, 11), archivedBy: "产品经理" }
  ];
  return { nodes, requirements, activities, archive };
}

export function createDashboardService(options: DashboardServiceOptions = {}): DashboardService {
  const delayMs = options.delayMs ?? (() => 80 + Math.floor(Math.random() * 121));
  const now = options.now ?? (() => new Date());
  let idCounter = 0;
  const nextId = options.idSeed ?? ((prefix: string) => `${prefix}-local-${++idCounter}`);
  const store = seed();
  let connectedProjectIds: Set<string> | null = null;
  let connectedCatalogIds = new Set<string>();
  let catalogSeedRemapped = false;

  const respond = <T>(produce: () => T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      globalThis.setTimeout(() => {
        try {
          resolve(produce());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }, delayMs());
    });

  const touch = () => now().toISOString();
  const findNode = (id: string): SpaceNode | undefined => store.nodes.find((node) => node.id === id);
  const liveNode = (id: string): SpaceNode => {
    const node = findNode(id);
    if (!node) throw failure("没有找到这个空间节点", "请刷新空间树后重试", "其它节点与配置均未受影响");
    return node;
  };
  const breadcrumbOf = (node: SpaceNode): string => {
    const names: string[] = [node.name];
    let cursor = node.parentId ? findNode(node.parentId) : undefined;
    while (cursor) {
      names.unshift(cursor.name);
      cursor = cursor.parentId ? findNode(cursor.parentId) : undefined;
    }
    return names.join(" / ");
  };
  const isDescendant = (ancestorId: string, candidateId: string): boolean => {
    let cursor = findNode(candidateId);
    while (cursor?.parentId) {
      if (cursor.parentId === ancestorId) return true;
      cursor = findNode(cursor.parentId);
    }
    return false;
  };
  const record = (action: string, target: string, detail: string, actor = "本地操作") => {
    store.activities.unshift({ id: nextId("act"), at: touch(), actor, action, target, detail });
    if (store.activities.length > 50) store.activities.length = 50;
  };
  const assertName = (name: string, parentId: string | null, excludeId?: string): string => {
    const trimmed = name.trim();
    if (!trimmed) throw failure("名称不能为空", "请输入 1–40 个字符的名称后重试", "未写入任何配置");
    if (trimmed.length > 40) throw failure("名称超过 40 个字符", "请缩短名称后重试", "未写入任何配置");
    const duplicate = store.nodes.some((node) => node.id !== excludeId && node.parentId === parentId && !node.archivedAt && node.name === trimmed);
    if (duplicate) throw failure(`同一层级已存在「${trimmed}」`, "请换一个名称或先整理同名节点", "未写入任何配置");
    return trimmed;
  };
  const assertParentFolder = (parentId: string | null): void => {
    if (parentId === null) return;
    const parent = findNode(parentId);
    if (!parent || parent.kind !== "folder") throw failure("目标位置不是文件夹", "请选择一个虚拟文件夹作为父级", "未写入任何配置");
    if (parent.archivedAt) throw failure("目标文件夹已归档", "请先在归档中心恢复，或改选其它文件夹", "未写入任何配置");
  };
  const copyNode = (node: SpaceNode): SpaceNode => ({ ...node });

  return {
    syncConnectedProjects(projects) {
      const previousProjects = store.nodes.filter((node): node is ManagedProject => node.kind === "project");
      const previousById = new Map(previousProjects.map((project) => [project.id, project]));
      const folders = store.nodes.filter((node): node is FolderNode => node.kind === "folder");
      const active = projects.filter((project) => project.status === "active");
      connectedProjectIds = new Set(active.map((project) => project.id));
      connectedCatalogIds = new Set(projects.map((project) => project.id));

      // 首次接入真实目录时，把演示需求稳定映射到真实 active Project；
      // 后续刷新不再改写用户已经选择过的 projectId。
      if (!catalogSeedRemapped && active.length > 0) {
        const replacement = new Map(previousProjects.map((project, index) => [project.id, active[index % active.length]!.id]));
        for (const requirement of store.requirements) {
          requirement.projectId = replacement.get(requirement.projectId) ?? requirement.projectId;
        }
        catalogSeedRemapped = true;
      }

      const mapped = projects.map((project): ManagedProject => {
        const overlay = previousById.get(project.id);
        const defaultBranch = overlay?.defaultBranch ?? "main";
        return {
          kind: "project",
          id: project.id,
          parentId: overlay?.parentId ?? null,
          name: project.name,
          repositoryPath: project.rootPath,
          defaultBranch,
          repositories: overlay?.repositories ?? [{
            id: `repo-connected-${project.id}`,
            label: "项目根目录",
            path: project.rootPath,
            defaultBranch,
            primary: true
          }],
          favorite: overlay?.favorite ?? false,
          archivedAt: project.status === "archived" ? project.updatedAt : null,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt
        };
      });
      store.nodes = [...folders, ...mapped];

      store.archive = store.archive.filter((entry) => entry.kind !== "project");
      for (const project of projects.filter((candidate) => candidate.status === "archived")) {
        store.archive.push({
          id: `arc-connected-${project.id}`,
          nodeId: project.id,
          kind: "project",
          name: project.name,
          breadcrumb: "已接入项目",
          archivedAt: project.updatedAt,
          archivedBy: "Workbench",
          restoreDisabledReason: "当前运行核心尚未提供项目恢复入口；接入历史与运行证据仍完整保留"
        });
      }
    },
    getDashboardSummary() {
      return respond(() => {
        const live = store.nodes.filter((node) => !node.archivedAt);
        const projects = live.filter((node): node is ManagedProject => node.kind === "project");
        const activeRequirements = store.requirements.filter((requirement) => !requirement.archivedAt && projects.some((project) => project.id === requirement.projectId));
        const byLane = Object.fromEntries(REQUIREMENT_LANES.map((lane) => [lane.id, 0])) as Record<RequirementLane, number>;
        for (const requirement of activeRequirements) byLane[requirement.lane] += 1;
        return {
          generatedAt: touch(),
          projects: {
            total: projects.length,
            active: projects.length,
            favorites: projects.filter((project) => project.favorite).length,
            archived: store.nodes.filter((node) => node.kind === "project" && node.archivedAt).length
          },
          requirements: {
            total: activeRequirements.length,
            active: activeRequirements.filter((requirement) => requirement.lane !== "done").length,
            exceptions: activeRequirements.filter((requirement) => requirement.exception !== null).length,
            byLane
          },
          tasks: { queued: byLane.queued, running: byLane.running, acceptance: byLane.acceptance },
          activities: store.activities.slice(0, 12).map((item) => ({ ...item })),
          resourceOverview: {
            demo: true,
            agents: [
              { name: "小米汪", role: "领队", load: 0.6 },
              { name: "米糊糊", role: "前端开发", load: 0.85 },
              { name: "小米象", role: "测试", load: 0.35 }
            ]
          }
        };
      });
    },
    listSpaces() {
      return respond(() => store.nodes.map(copyNode));
    },
    createFolder(input) {
      return respond(() => {
        assertParentFolder(input.parentId);
        const name = assertName(input.name, input.parentId);
        const stamp = touch();
        const folder: FolderNode = { kind: "folder", id: nextId("fld"), parentId: input.parentId, name, favorite: false, archivedAt: null, createdAt: stamp, updatedAt: stamp };
        store.nodes.push(folder);
        record("新建文件夹", name, "虚拟文件夹只组织空间树，不对应磁盘目录。");
        return { ...folder };
      });
    },
    createProject(input) {
      return respond(() => {
        assertParentFolder(input.parentId);
        const name = assertName(input.name, input.parentId);
        const repositoryPath = input.repositoryPath.trim();
        if (!repositoryPath) throw failure("Repository path 不能为空", "请填写项目在本机的路径后重试", "仅保存配置，不会移动磁盘上的文件");
        const stamp = touch();
        const project: ManagedProject = {
          kind: "project",
          id: nextId("prj"),
          parentId: input.parentId,
          name,
          repositoryPath,
          defaultBranch: input.defaultBranch?.trim() || "main",
          repositories: [{ id: nextId("repo"), label: "主仓库", path: repositoryPath, defaultBranch: input.defaultBranch?.trim() || "main", primary: true }],
          favorite: false,
          archivedAt: null,
          createdAt: stamp,
          updatedAt: stamp
        };
        store.nodes.push(project);
        record("新建项目", name, `Repository path 仅保存配置：${repositoryPath}`);
        return { ...project };
      });
    },
    renameNode(id, name) {
      return respond(() => {
        const node = liveNode(id);
        if (node.archivedAt) throw failure("已归档节点不能重命名", "请先在归档中心恢复后再改名", "未写入任何配置");
        const trimmed = assertName(name, node.parentId, node.id);
        node.name = trimmed;
        node.updatedAt = touch();
        record("重命名", trimmed, "空间树内联改名已保存。");
        return copyNode(node);
      });
    },
    moveNode(id, parentId) {
      return respond(() => {
        const node = liveNode(id);
        if (node.archivedAt) throw failure("已归档节点不能移动", "请先在归档中心恢复后再移动", "未写入任何配置");
        if (parentId === node.id || (parentId !== null && isDescendant(node.id, parentId))) {
          throw failure("不能把节点移动到自己的子层级里", "请选择其它文件夹作为目标位置", "未写入任何配置");
        }
        assertParentFolder(parentId);
        assertName(node.name, parentId, node.id);
        node.parentId = parentId;
        node.updatedAt = touch();
        record("移动节点", node.name, parentId ? `已移动到 ${breadcrumbOf(node)}。` : "已移动到空间树根层。");
        return copyNode(node);
      });
    },
    toggleFavorite(id) {
      return respond(() => {
        const node = liveNode(id);
        if (node.archivedAt) throw failure("已归档节点不能收藏", "请先在归档中心恢复后再收藏", "未写入任何配置");
        node.favorite = !node.favorite;
        node.updatedAt = touch();
        return copyNode(node);
      });
    },
    archiveNode(id) {
      return respond(() => {
        const node = liveNode(id);
        if (node.archivedAt) throw failure("该节点已经在归档中心", "请刷新归档列表查看最新状态", "未产生重复归档记录");
        const hasLiveChildren = store.nodes.some((candidate) => candidate.parentId === node.id && !candidate.archivedAt);
        if (node.kind === "folder" && hasLiveChildren) {
          throw failure("文件夹里还有未归档的内容", "请先移出或归档其中的项目与文件夹", "未写入任何配置");
        }
        node.archivedAt = touch();
        node.updatedAt = node.archivedAt;
        const entry: ArchiveRecord = { id: nextId("arc"), nodeId: node.id, kind: node.kind, name: node.name, breadcrumb: breadcrumbOf(node), archivedAt: node.archivedAt, archivedBy: "本地操作" };
        store.archive.unshift(entry);
        record("归档节点", node.name, "可在归档中心恢复；不会删除磁盘文件。");
        return { ...entry };
      });
    },
    restoreArchived(archiveId) {
      return respond(() => {
        const index = store.archive.findIndex((entry) => entry.id === archiveId);
        const entry = index >= 0 ? store.archive[index] : undefined;
        if (!entry) throw failure("没有找到这条归档记录", "请刷新归档中心后重试", "归档内容仍然完整保留");
        if (entry.kind === "project" && connectedCatalogIds.has(entry.nodeId)) {
          throw failure("当前运行核心尚未提供项目恢复入口", "请保留这条归档记录，待恢复能力接入后再操作", "项目声明、任用关系与运行证据仍完整保留");
        }
        if (entry.kind === "requirement") {
          const requirement = store.requirements.find((candidate) => candidate.id === entry.nodeId);
          if (!requirement) throw failure("没有找到归档需求", "请刷新归档中心后重试", "其它归档记录未受影响");
          requirement.archivedAt = null;
          requirement.updatedAt = touch();
          store.archive.splice(index, 1);
          record("恢复需求", requirement.code, "已恢复到原项目看板。");
          const { rawRequirement: _raw, acceptanceCriteria: _ac, dag: _dag, timeline: _tl, resourceOverview: _ro, evidence: _ev, ...summary } = requirement;
          return { ...summary };
        }
        const node = liveNode(entry.nodeId);
        const parent = node.parentId ? findNode(node.parentId) : undefined;
        if (!parent || parent.archivedAt) node.parentId = null; // 父级不可用时回到根层，不丢节点
        node.archivedAt = null;
        node.updatedAt = touch();
        store.archive.splice(index, 1);
        record("恢复归档", node.name, "已恢复到空间树，历史配置原样保留。");
        return copyNode(node);
      });
    },
    listBoard(projectId) {
      return respond(() => {
        if (projectId) {
          const project = findNode(projectId);
          if (!project || project.kind !== "project") throw failure("没有找到这个项目", "请回到项目页选择已正式接入的项目", "需求数据未受影响");
          if (project.archivedAt) throw failure("项目已归档，看板进入只读保护", "可在归档中心恢复后再查看与迁移需求", "需求与历史证据完整保留");
        }
        const activeProjectIds = new Set(store.nodes.filter((node) => node.kind === "project" && !node.archivedAt).map((node) => node.id));
        return store.requirements
          .filter((requirement) => !requirement.archivedAt && activeProjectIds.has(requirement.projectId) && (!projectId || requirement.projectId === projectId))
          .map(({ rawRequirement: _raw, acceptanceCriteria: _ac, dag: _dag, timeline: _tl, resourceOverview: _ro, evidence: _ev, ...requirement }) => ({ ...requirement }))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      });
    },
    createRequirement(input) {
      return respond(() => {
        const project = findNode(input.projectId);
        if (!project || project.kind !== "project" || project.archivedAt || (connectedProjectIds !== null && !connectedProjectIds.has(project.id))) {
          throw failure("目标项目尚未正式接入或已归档", "请先在项目页完成接入并确认项目处于 active 状态", "未写入任何需求");
        }
        const title = input.title.trim();
        if (!title) throw failure("需求标题不能为空", "请输入标题后重试", "未写入任何需求");
        const stamp = touch();
        const nextNumber = 100 + store.requirements.length + 1;
        const detail: RequirementDetail = {
          id: nextId("req"), projectId: project.id, code: `REQ-${nextNumber}`, title,
          summary: input.summary.trim() || "暂无摘要", lane: "inbox", exception: null, priority: input.priority,
          owner: "待分配", createdAt: stamp, updatedAt: stamp, archivedAt: null,
          rawRequirement: input.rawRequirement.trim() || title,
          acceptanceCriteria: input.acceptanceCriteria.filter((item) => item.trim()).map((item) => item.trim()),
          dag: { demo: true, nodes: [] }, timeline: { demo: true, entries: [] },
          resourceOverview: { demo: true, agents: 0, elapsedMinutes: 0, tokensUsed: 0 },
          evidence: { diffSummary: "尚未产生交付 Diff；接入调度器后此处展示真实变更集。", testReport: "尚未产生测试报告。", reviewNotes: "尚未产生 Review 记录。", deliverables: [] }
        };
        store.requirements.unshift(detail);
        record("创建需求", detail.code, `已进入${requirementLaneLabel(detail.lane)}。`);
        const { rawRequirement: _raw, acceptanceCriteria: _ac, dag: _dag, timeline: _tl, resourceOverview: _ro, evidence: _ev, ...summary } = detail;
        return { ...summary };
      });
    },
    getRequirement(id) {
      return respond(() => {
        const requirement = store.requirements.find((candidate) => candidate.id === id);
        if (!requirement || requirement.archivedAt) throw failure("没有找到这条需求", "请回到需求看板或归档中心重新选择", "看板数据未受影响");
        return JSON.parse(JSON.stringify(requirement)) as RequirementDetail;
      });
    },
    updateRequirementLane(id, lane) {
      return respond(() => {
        const requirement = store.requirements.find((candidate) => candidate.id === id);
        if (!requirement || requirement.archivedAt) throw failure("没有找到这条需求", "请回到需求看板重新选择", "未写入任何变更");
        if (!REQUIREMENT_LANES.some((entry) => entry.id === lane)) throw failure("目标列不存在", "请重新选择目标列", "未写入任何变更");
        if (requirement.exception === "cancelled") throw failure("已取消的需求不能迁移列", "请先在看板恢复其状态或联系领队", "未写入任何变更");
        if (requirement.lane === lane) return { ...requirement };
        const from = requirementLaneLabel(requirement.lane);
        requirement.lane = lane;
        requirement.updatedAt = touch();
        record("迁移需求列", requirement.code, `${from} → ${requirementLaneLabel(lane)}。`);
        const { rawRequirement: _raw, acceptanceCriteria: _ac, dag: _dag, timeline: _tl, resourceOverview: _ro, evidence: _ev, ...summary } = requirement;
        return { ...summary };
      });
    },
    archiveRequirement(id) {
      return respond(() => {
        const requirement = store.requirements.find((candidate) => candidate.id === id);
        if (!requirement) throw failure("没有找到这条需求", "请回到需求看板重新选择", "未写入任何变更");
        if (requirement.archivedAt) throw failure("该需求已经归档", "请前往归档中心查看", "未产生重复归档记录");
        const project = findNode(requirement.projectId);
        requirement.archivedAt = touch();
        requirement.updatedAt = requirement.archivedAt;
        const entry: ArchiveRecord = {
          id: nextId("arc"), nodeId: requirement.id, kind: "requirement", name: `${requirement.code} · ${requirement.title}`,
          breadcrumb: `${project?.name ?? requirement.projectId} / ${requirementLaneLabel(requirement.lane)}`,
          archivedAt: requirement.archivedAt, archivedBy: "本地操作"
        };
        store.archive.unshift(entry);
        record("归档需求", requirement.code, "可在归档中心恢复；需求证据完整保留。");
        return { ...entry };
      });
    },
    getProjectProfile(id) {
      return respond(() => {
        const node = findNode(id);
        if (!node || node.kind !== "project") throw failure("没有找到这个项目", "请回到项目页重新选择", "其它项目配置未受影响");
        return {
          project: copyNode(node) as ManagedProject,
          members: [
            { id: "member-lead", name: "小米汪", role: "产品领队", status: "active" },
            { id: "member-fe", name: "米糊糊", role: "前端开发", status: "active" },
            { id: "member-qa", name: "小米象", role: "独立测试", status: "active" }
          ],
          skills: [
            { id: "skill-react", name: "React / TypeScript", source: "项目绑定" },
            { id: "skill-ui", name: "交互状态与无障碍", source: "角色能力" }
          ],
          knowledge: [
            { id: "kb-product", title: "产品范围与验收口径", kind: "document", updatedAt: at(8, 9) },
            { id: "kb-architecture", title: "Workbench 架构边界", kind: "knowledge-base", updatedAt: at(7, 16) }
          ]
        } satisfies ProjectProfile;
      });
    },
    bindRepository(input) {
      return respond(() => {
        const node = liveNode(input.projectId);
        if (node.kind !== "project" || node.archivedAt) throw failure("项目不可绑定仓库", "请选择一个未归档项目后重试", "不会移动或修改磁盘文件");
        const path = input.path.trim();
        const label = input.label.trim();
        if (!path || !label) throw failure("仓库名称和路径不能为空", "补齐信息后重试", "不会移动或修改磁盘文件");
        if (node.repositories.some((repository) => repository.path === path)) throw failure("这个 Repository path 已绑定", "请填写另一个本地仓库路径", "不会移动或修改磁盘文件");
        node.repositories.push({ id: nextId("repo"), label, path, defaultBranch: input.defaultBranch?.trim() || "main", primary: false });
        node.updatedAt = touch();
        record("绑定仓库", node.name, `仅保存配置：${path}`);
        return copyNode(node) as ManagedProject;
      });
    },
    listArchive() {
      return respond(() => store.archive.map((entry) => ({ ...entry })));
    },
    getSettingsSnapshot() {
      return respond<SettingsSnapshot>(() => ({
        generatedAt: touch(),
        sections: [
          {
            id: "workspace",
            title: "空间与项目",
            description: "空间树与 Repository 配置的保存策略。",
            entries: [
              { label: "空间树存储", value: "本地配置库（内存演示）", hint: "第一阶段为 mock 数据，接口形状即未来服务端契约。" },
              { label: "Repository path", value: "逐项目保存", hint: "仅保存配置，不会移动磁盘上的文件。" }
            ]
          },
          {
            id: "scheduler",
            title: "调度器集成",
            description: "任务 DAG、Agent 时间线与资源占用将在接入调度器后展示真实数据。",
            entries: [
              { label: "调度器连接", value: "尚未接入调度器 · 演示数据", hint: "接入前所有 DAG / 时间线 / 资源视图以演示徽标标注。" },
              { label: "数据回写", value: "未开启", hint: "第一阶段所有写操作只落在本地 mock 适配层。" }
            ]
          },
          {
            id: "execution",
            title: "Provider 与执行策略",
            description: "后续阶段的运行参数入口，本阶段不可触发真实执行。",
            entries: [
              { label: "Provider", value: "未配置 · 占位" },
              { label: "最大并发", value: "4（只读预览）" },
              { label: "Worktree 隔离", value: "按 Run 创建（未启用）" },
              { label: "Quality Gates", value: "typecheck → test → review（未启用）" }
            ]
          },
          {
            id: "notifications",
            title: "通知与确认",
            description: "确认分级策略的只读预览。",
            entries: [
              { label: "归档确认", value: "确认 Modal", hint: "文案固定包含「可在归档中心恢复」与「不会删除磁盘文件」。" },
              { label: "移动 / 收藏", value: "乐观更新 + Toast 撤销（6s）" },
              { label: "重命名", value: "行内编辑，Enter 保存 / Escape 取消" }
            ]
          }
        ]
      }));
    }
  };
}

/** 应用级单例：页面默认经此适配层读写，测试可注入独立实例。 */
export const dashboardService = createDashboardService();
