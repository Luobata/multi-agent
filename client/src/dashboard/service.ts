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
  McpObservedProject,
  ProjectProfile,
  Requirement,
  RequirementAdvancement,
  RequirementDetail,
  RequirementEvidenceCapture,
  RequirementLane,
  RunAcceptanceSnapshot,
  SettingsSnapshot,
  SpaceNode
} from "./types";
import { REQUIREMENT_LANES, requirementLaneLabel } from "./types";
import type { PassiveProjectAccess, Project as ConnectedProject } from "../types";
import {
  advancementLane,
  isActiveRequirementAdvancement,
  observeAdvancement,
  reserveAdvancement,
  type RequirementAdvancementConfig,
  type RequirementInvocationObservation
} from "./advancement";

export function mcpCatalogNodeId(accessId: string): string {
  return `mcp-access:${accessId}`;
}

/**
 * fail-closed 验收闸：逐项核对 Run 验收快照的真实字段，返回缺失项清单。
 * 空数组表示证据完整；任何占位字符串或缺字段都会在这里被点名。
 */
export function acceptanceSnapshotGaps(snapshot: RunAcceptanceSnapshot | undefined): string[] {
  if (!snapshot) return ["Run 验收快照"];
  const gaps: string[] = [];
  if (typeof snapshot.runId !== "string" || !snapshot.runId.trim()) gaps.push("Run ID");
  if (snapshot.eligible !== true) gaps.push("交付门禁 eligible");
  if (typeof snapshot.worktreePath !== "string" || !snapshot.worktreePath.trim()) gaps.push("候选 worktree 路径");
  if (!snapshot.testGate || snapshot.testGate.status !== "passed") gaps.push("quality.test 门禁通过");
  if (!snapshot.reviewGate || snapshot.reviewGate.status !== "passed") gaps.push("quality.audit 门禁通过");
  if (!(snapshot.mediaCount > 0) && !(snapshot.structuredE2eCount > 0)) gaps.push("截图、录屏或结构化 E2E 证据");
  if (!Array.isArray(snapshot.diffFiles) || snapshot.diffFiles.length === 0) gaps.push("Diff 文件清单");
  return gaps;
}

export interface DashboardService {
  /** Project 是事实源；MCP observed 是接入证据，Folder / 收藏 / 排序只是目录 UI 覆盖层。 */
  syncConnectedProjects(projects: ConnectedProject[], passiveAccesses?: PassiveProjectAccess[]): void;
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
  /** Reserve one durable cycle before dispatch. Button and future scanner must both call this first. */
  reserveRequirementAdvancement(id: string, config: RequirementAdvancementConfig, trigger: RequirementAdvancement["trigger"]): Promise<RequirementAdvancement>;
  syncRequirementAdvancement(
    id: string,
    idempotencyKey: string,
    observation: RequirementInvocationObservation & { leaderSessionId?: string },
    pollIntervalMs: number
  ): Promise<Requirement>;
  failRequirementAdvancement(id: string, idempotencyKey: string, message: string): Promise<Requirement>;
  /** 原子提交：验证全套 Run 验收证据后，一次性写入 evidence 并迁移到「待验收」。 */
  submitRequirementForAcceptance(requirementId: string, snapshot: RunAcceptanceSnapshot): Promise<Requirement>;
  /** 仅接受与固定验收快照同一 Run 的服务端交付状态，驱动待合入 / 完成 / 退回验收。 */
  syncRequirementDelivery(
    requirementId: string,
    runId: string,
    status: "queued-for-merge" | "retesting" | "merging" | "merged" | "conflict" | "returned-to-acceptance"
  ): Promise<Requirement>;
  /** 补采任务的持久化需求投影；不覆盖已经固定的 acceptance snapshot。 */
  syncRequirementEvidenceCapture(
    requirementId: string,
    runId: string,
    observation: Omit<RequirementEvidenceCapture, "runId">
  ): Promise<Requirement>;
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
  /** 应用单例从空白真实看板开始；单测可继续显式使用 demo fixture。 */
  initialData?: "empty" | "demo";
  /** 浏览器端可注入 localStorage；普通 createDashboardService 调用默认不共享状态。 */
  storage?: Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;
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

function seed(mode: "empty" | "demo" = "demo"): Store {
  if (mode === "empty") return { nodes: [], requirements: [], activities: [], archive: [] };
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
    requirement({ id: "req-102", projectId: "prj-workbench", code: "REQ-102", title: "看板列迁移交互", summary: "第一阶段无拖拽，经详情页目标列迁移。", lane: "planned", exception: null, priority: "medium", owner: "小狐狐", createdAt: at(4, 10), updatedAt: at(7, 15) }),
    requirement({ id: "req-103", projectId: "prj-workbench", code: "REQ-103", title: "调度器真实接入", summary: "DAG / 时间线 / 资源接入真实运行时。", lane: "inbox", exception: null, priority: "medium", owner: "小米汪", createdAt: at(5, 11), updatedAt: at(6, 9) }),
    requirement({ id: "req-104", projectId: "prj-workbench", code: "REQ-104", title: "归档中心恢复路径验收", summary: "恢复后回到原父节点并保留证据。", lane: "acceptance", exception: null, priority: "high", owner: "小米象", createdAt: at(3, 14), updatedAt: at(8, 8) }),
    requirement({ id: "req-105", projectId: "prj-workbench", code: "REQ-105", title: "双皮肤视觉回归", summary: "蜡笔 / 像素双主题差异核对。", lane: "done", exception: null, priority: "low", owner: "小狐狐", createdAt: at(2, 9), updatedAt: at(6, 17) }),
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
    { id: "act-3", at: at(7, 15), actor: "小狐狐", action: "更新设计", target: "REQ-102", detail: "列迁移统一走详情页 SelectControl。" },
    { id: "act-4", at: at(7, 10), actor: "小米汪", action: "归档项目", target: "旧官网", detail: "仅保留配置与证据，磁盘文件不动。" },
    { id: "act-5", at: at(6, 18), actor: "米糊糊", action: "创建需求", target: "REQ-101", detail: "第一阶段范围锁定。" }
  ];
  const archive: ArchiveRecord[] = [
    { id: "arc-1", nodeId: "prj-legacy-site", kind: "project", name: "旧官网", breadcrumb: "基础设施 / 历史迁移 / 旧官网", archivedAt: at(7, 10), archivedBy: "小米汪" },
    { id: "arc-2", nodeId: "req-111", kind: "requirement", name: "REQ-204 · 旧版导出入口下线", breadcrumb: "运营控制台 / 已完成", archivedAt: at(7, 11), archivedBy: "产品经理" }
  ];
  return { nodes, requirements, activities, archive };
}

const LEGACY_DASHBOARD_STORAGE_KEYS = ["local-agent-workbench.requirement-board.v1"] as const;
export const DASHBOARD_STORAGE_KEY = "local-agent-workbench.requirement-board.v2";
const DASHBOARD_STORAGE_VERSION = 2;

function persistedStore(storage: DashboardServiceOptions["storage"]): Store | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(DASHBOARD_STORAGE_KEY);
    if (!raw) return undefined;
    const envelope = JSON.parse(raw) as { version?: unknown; store?: Partial<Store> };
    if (envelope.version !== DASHBOARD_STORAGE_VERSION || !envelope.store
      || !Array.isArray(envelope.store.nodes)
      || !Array.isArray(envelope.store.requirements)
      || !Array.isArray(envelope.store.activities)
      || !Array.isArray(envelope.store.archive)) return undefined;
    return {
      nodes: envelope.store.nodes,
      requirements: envelope.store.requirements,
      activities: envelope.store.activities,
      archive: envelope.store.archive
    } as Store;
  } catch {
    return undefined;
  }
}

export function createDashboardService(options: DashboardServiceOptions = {}): DashboardService {
  const delayMs = options.delayMs ?? (() => 80 + Math.floor(Math.random() * 121));
  const now = options.now ?? (() => new Date());
  // v1 was the pre-launch test/demo board. The user explicitly requested a clean board before
  // entering real requirements, so remove it once and never migrate those records into v2.
  for (const key of LEGACY_DASHBOARD_STORAGE_KEYS) options.storage?.removeItem?.(key);
  const store = persistedStore(options.storage) ?? seed(options.initialData ?? "demo");
  const occupiedIds = new Set<string>([
    ...store.nodes.map((node) => node.id),
    ...store.nodes.flatMap((node) => node.kind === "project" ? node.repositories.map((repository) => repository.id) : []),
    ...store.requirements.map((requirement) => requirement.id),
    ...store.activities.map((activity) => activity.id),
    ...store.archive.map((entry) => entry.id)
  ]);
  let idCounter = [...occupiedIds].reduce((largest, id) => {
    const match = id.match(/-local-(\d+)(?:-|$)/);
    return match ? Math.max(largest, Number(match[1])) : largest;
  }, 0);
  const idSeed = options.idSeed ?? ((prefix: string) => `${prefix}-local-${++idCounter}`);
  const nextId = (prefix: string): string => {
    const candidate = idSeed(prefix);
    if (!occupiedIds.has(candidate)) {
      occupiedIds.add(candidate);
      return candidate;
    }
    let suffix = 2;
    while (occupiedIds.has(`${candidate}-${suffix}`)) suffix += 1;
    const unique = `${candidate}-${suffix}`;
    occupiedIds.add(unique);
    return unique;
  };

  // Early v2 builds restarted their in-memory counter at 1 after every reload.
  // A newly created requirement could therefore reuse a persisted id, making
  // two cards share one idempotency key and one Run. Repair that legacy shape
  // fail-closed: the oldest requirement keeps the correlated Run, while newer
  // duplicates receive fresh ids and return to the inbox for an explicit start.
  let repairedPersistedData = false;
  const requirementsById = new Map<string, RequirementDetail[]>();
  for (const requirement of store.requirements) {
    const group = requirementsById.get(requirement.id) ?? [];
    group.push(requirement);
    requirementsById.set(requirement.id, group);
  }
  for (const duplicates of requirementsById.values()) {
    if (duplicates.length < 2) continue;
    repairedPersistedData = true;
    const canonical = [...duplicates].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0]!;
    const latestAdvancement = duplicates
      .flatMap((requirement) => requirement.advancement ? [requirement.advancement] : [])
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (latestAdvancement) {
      canonical.advancement = { ...latestAdvancement };
      canonical.lane = advancementLane(latestAdvancement.status, canonical.lane);
      canonical.updatedAt = [canonical.updatedAt, latestAdvancement.updatedAt].sort().at(-1)!;
      canonical.exception = latestAdvancement.status === "blocked"
        ? "blocked"
        : latestAdvancement.status === "failed"
          ? "failed"
          : latestAdvancement.status === "cancelled"
            ? "cancelled"
            : null;
    }
    for (const duplicate of duplicates) {
      if (duplicate === canonical) continue;
      duplicate.id = nextId("req");
      delete duplicate.advancement;
      if (duplicate.lane === "queued" || duplicate.lane === "running" || duplicate.lane === "confirmation") duplicate.lane = "inbox";
      if (duplicate.exception === "blocked" || duplicate.exception === "failed") duplicate.exception = null;
      if (duplicate.updatedAt < duplicate.createdAt) duplicate.updatedAt = duplicate.createdAt;
    }
  }
  // `confirmation` was introduced after v2 had already persisted real requirements.
  // Reconcile every correlated record from the durable Invocation status so an
  // already-waiting Run leaves the execution lane immediately after reload.
  for (const requirement of store.requirements) {
    if (!requirement.advancement) continue;
    const reconciledLane = advancementLane(requirement.advancement.status, requirement.lane);
    if (reconciledLane === requirement.lane) continue;
    requirement.lane = reconciledLane;
    repairedPersistedData = true;
  }
  // A historical UI polling loop could append the exact same capture projection
  // repeatedly. Collapse only adjacent identical capture entries so a genuine
  // later rerun (separated by another action) remains auditable.
  const repairedActivities = store.activities.filter((activity, index, activities) => {
    if (activity.action !== "同步验收补采" || index === 0) return true;
    const previous = activities[index - 1];
    return previous?.action !== activity.action
      || previous.target !== activity.target
      || previous.detail !== activity.detail;
  });
  if (repairedActivities.length !== store.activities.length) {
    store.activities = repairedActivities;
    repairedPersistedData = true;
  }
  const persist = () => {
    try {
      options.storage?.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify({ version: DASHBOARD_STORAGE_VERSION, store }));
    } catch {
      // localStorage quota / privacy failures degrade to the current in-memory session.
    }
  };
  if (repairedPersistedData) persist();
  let connectedProjectIds: Set<string> | null = null;
  let connectedCatalogIds = new Set<string>();
  let catalogSeedRemapped = false;

  const respond = <T>(produce: () => T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      globalThis.setTimeout(() => {
        try {
          const result = produce();
          persist();
          resolve(result);
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
  const requirementSummary = (requirement: RequirementDetail): Requirement => {
    const { rawRequirement: _raw, acceptanceCriteria: _ac, dag: _dag, timeline: _tl, resourceOverview: _ro, evidence: _ev, ...summary } = requirement;
    return { ...summary };
  };

  return {
    syncConnectedProjects(projects, passiveAccesses = []) {
      const previousProjects = store.nodes.filter((node): node is ManagedProject => node.kind === "project");
      const previousById = new Map(previousProjects.map((project) => [project.id, project]));
      const previousMcpProjects = store.nodes.filter((node): node is McpObservedProject => node.kind === "mcp-observed");
      const previousMcpByAccessId = new Map(previousMcpProjects.map((project) => [project.accessId, project]));
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
        const linkedAccesses = passiveAccesses.filter((access) => access.linkedProjectId === project.id);
        const linkedAccess = linkedAccesses[0];
        // “MCP 发现 → 正式接入”后沿用用户已经整理好的目录位置和收藏状态。
        const migratedMcpOverlay = linkedAccess ? previousMcpByAccessId.get(linkedAccess.id) : undefined;
        const projectOverlay = previousById.get(project.id);
        const placementOverlay = projectOverlay ?? migratedMcpOverlay;
        const defaultBranch = projectOverlay?.defaultBranch ?? "main";
        return {
          kind: "project",
          id: project.id,
          parentId: placementOverlay?.parentId ?? null,
          name: project.name,
          repositoryPath: project.rootPath,
          defaultBranch,
          repositories: projectOverlay?.repositories ?? [{
            id: `repo-connected-${project.id}`,
            label: "项目根目录",
            path: project.rootPath,
            defaultBranch,
            primary: true
          }],
          favorite: placementOverlay?.favorite ?? false,
          archivedAt: project.status === "archived" ? project.updatedAt : null,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          mcpAccess: linkedAccess ? {
            accessId: linkedAccess.id,
            projectKeys: [...new Set(linkedAccesses.flatMap((access) => access.projectKeys))],
            requestCount: linkedAccesses.reduce((total, access) => total + access.requestCount, 0),
            firstSeenAt: linkedAccesses.map((access) => access.firstSeenAt).sort()[0] ?? linkedAccess.firstSeenAt,
            lastSeenAt: linkedAccesses.map((access) => access.lastSeenAt).sort().at(-1) ?? linkedAccess.lastSeenAt
          } : undefined
        };
      });
      const observed = passiveAccesses
        .filter((access) => !access.linkedProjectId)
        .map((access): McpObservedProject => {
          const overlay = previousMcpByAccessId.get(access.id);
          return {
            kind: "mcp-observed",
            id: mcpCatalogNodeId(access.id),
            accessId: access.id,
            parentId: overlay?.parentId ?? null,
            name: access.displayName,
            rootPath: access.rootPath,
            projectKeys: [...access.projectKeys],
            requestCount: access.requestCount,
            firstSeenAt: access.firstSeenAt,
            lastSeenAt: access.lastSeenAt,
            historical: !access.rootPath,
            favorite: overlay?.favorite ?? false,
            archivedAt: null,
            createdAt: access.firstSeenAt,
            updatedAt: access.lastSeenAt
          };
        });
      store.nodes = [...folders, ...mapped, ...observed];

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
      persist();
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
          tasks: { queued: byLane.queued, running: byLane.running, confirmation: byLane.confirmation, acceptance: byLane.acceptance },
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
        if (node.kind === "mcp-observed") throw failure("MCP 发现记录不能重命名", "请先完善接入，再修改正式项目声明中的名称", "MCP 证据与目录位置均未改变");
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
        if (node.kind === "mcp-observed") throw failure("MCP 发现记录不能归档", "请保留接入证据，或先完善为正式项目后再管理生命周期", "MCP 证据与磁盘文件均未改变");
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
        if (lane === "queued" || lane === "running" || lane === "confirmation" || lane === "merging") {
          throw failure(
            `「${requirementLaneLabel(lane)}」只能由真实 Run 更新`,
            "请在需求详情点击「开始推进」，系统会按 Invocation 状态自动迁移",
            "未创建 Run，也未改变需求所在列"
          );
        }
        if (isActiveRequirementAdvancement(requirement.advancement)) {
          throw failure(
            "当前需求仍有进行中的真实 Run",
            "请先在运行卷宗处理或取消该 Run，再人工调整需求列",
            "Run、推进记录与需求所在列均未改变"
          );
        }
        if (lane === "acceptance") {
          const gaps = acceptanceSnapshotGaps(requirement.evidence.acceptance);
          if (gaps.length > 0) {
            throw failure(
              `缺少验收证据：${gaps.join("、")}`,
              "请在运行卷宗页对合格交付使用「提交该需求到待验收」，写入真实 Run 证据后再迁移",
              "未写入任何变更"
            );
          }
        }
        const from = requirementLaneLabel(requirement.lane);
        requirement.lane = lane;
        requirement.updatedAt = touch();
        record("迁移需求列", requirement.code, `${from} → ${requirementLaneLabel(lane)}。`);
        const { rawRequirement: _raw, acceptanceCriteria: _ac, dag: _dag, timeline: _tl, resourceOverview: _ro, evidence: _ev, ...summary } = requirement;
        return { ...summary };
      });
    },
    reserveRequirementAdvancement(id, config, trigger) {
      return respond(() => {
        const requirement = store.requirements.find((candidate) => candidate.id === id);
        if (!requirement || requirement.archivedAt) {
          throw failure("没有找到这条需求", "请回到需求看板重新选择", "未启动任何执行任务");
        }
        const advancement = reserveAdvancement(requirement, config, trigger, touch());
        requirement.advancement = advancement;
        requirement.exception = null;
        requirement.updatedAt = advancement.updatedAt;
        record(
          advancement.cycle === 1 ? "准备推进" : "重试推进",
          requirement.code,
          `推进轮次 ${advancement.cycle} 已预留；入口策略 ${advancement.entrancePolicyId}；尚未重复创建 Run。`
        );
        return { ...advancement };
      });
    },
    syncRequirementAdvancement(id, idempotencyKey, observation, pollIntervalMs) {
      return respond(() => {
        const requirement = store.requirements.find((candidate) => candidate.id === id);
        if (!requirement || requirement.archivedAt) {
          throw failure("没有找到这条需求", "请回到需求看板重新选择", "Workbench 中的 Run 不会被删除");
        }
        if (!requirement.advancement || requirement.advancement.idempotencyKey !== idempotencyKey) {
          throw failure("推进回写不属于当前需求轮次", "请刷新需求详情后重试", "现有推进记录与 Run 均未被覆盖");
        }
        const previousStatus = requirement.advancement.status;
        requirement.advancement = {
          ...observeAdvancement(requirement.advancement, observation, pollIntervalMs),
          ...(observation.leaderSessionId ? { leaderSessionId: observation.leaderSessionId } : {})
        };
        requirement.lane = advancementLane(requirement.advancement.status, requirement.lane);
        requirement.exception = requirement.advancement.status === "blocked"
          ? "blocked"
          : requirement.advancement.status === "failed"
            ? "failed"
            : requirement.advancement.status === "cancelled"
              ? "cancelled"
              : null;
        requirement.updatedAt = requirement.advancement.updatedAt;
        if (previousStatus !== requirement.advancement.status || !requirement.advancement.runId) {
          record(
            "同步推进状态",
            requirement.code,
            `${previousStatus} → ${requirement.advancement.status}；Run ${requirement.advancement.runId ?? observation.runId}。`
          );
        }
        return requirementSummary(requirement);
      });
    },
    failRequirementAdvancement(id, idempotencyKey, message) {
      return respond(() => {
        const requirement = store.requirements.find((candidate) => candidate.id === id);
        if (!requirement || requirement.archivedAt) {
          throw failure("没有找到这条需求", "请回到需求看板重新选择", "Workbench 中可能已创建的 Run 不会被删除");
        }
        if (!requirement.advancement || requirement.advancement.idempotencyKey !== idempotencyKey) {
          throw failure("推进失败信息不属于当前需求轮次", "请刷新需求详情后重试", "现有推进记录未被覆盖");
        }
        const stamp = touch();
        requirement.advancement = {
          ...requirement.advancement,
          status: "failed",
          updatedAt: stamp,
          nextCheckAt: requirement.advancement.invocationId ? undefined : stamp,
          error: message.trim() || "启动推进失败"
        };
        requirement.exception = "failed";
        requirement.updatedAt = stamp;
        record("推进启动失败", requirement.code, `${requirement.advancement.error}；保留幂等键，可安全重试。`);
        return requirementSummary(requirement);
      });
    },
    submitRequirementForAcceptance(requirementId, snapshot) {
      return respond(() => {
        const requirement = store.requirements.find((candidate) => candidate.id === requirementId);
        if (!requirement || requirement.archivedAt) throw failure("没有找到这条需求", "请回到需求看板重新选择", "未写入任何变更");
        if (requirement.exception === "cancelled") throw failure("已取消的需求不能提交验收", "请先在看板恢复其状态或联系领队", "未写入任何变更");
        const gaps = acceptanceSnapshotGaps(snapshot);
        if (gaps.length > 0) {
          throw failure(
            `缺少验收证据：${gaps.join("、")}`,
            "请确认该 Run 的交付预览合格（eligible）且包含 test / audit 双门禁后再提交",
            "未写入任何变更"
          );
        }
        // 到这里快照一定完整；在同一个同步写段内固定证据并迁移列，不会出现半提交状态。
        const fixed: RunAcceptanceSnapshot = {
          ...snapshot,
          runId: snapshot.runId.trim(),
          worktreePath: snapshot.worktreePath.trim(),
          diffFiles: snapshot.diffFiles.map((file) => String(file)),
          capturedAt: snapshot.capturedAt?.trim() || touch()
        };
        requirement.evidence = {
          ...requirement.evidence,
          diffSummary: `Run ${fixed.runId} · ${fixed.diffFiles.length} 个文件：${fixed.diffFiles.join("、")}`,
          testReport: `quality.test Gate「${fixed.testGate!.gateId}」passed；结构化 E2E ${fixed.structuredE2eCount} 条。`,
          reviewNotes: `quality.audit Gate「${fixed.reviewGate!.gateId}」passed；媒体证据 ${fixed.mediaCount} 项；候选 worktree ${fixed.worktreePath}。`,
          acceptance: fixed
        };
        const from = requirementLaneLabel(requirement.lane);
        const moved = requirement.lane !== "acceptance";
        requirement.lane = "acceptance";
        requirement.updatedAt = touch();
        record("提交验收", requirement.code, moved ? `${from} → 待验收；Run ${fixed.runId} 验收快照已固定。` : `Run ${fixed.runId} 验收快照已更新。`);
        const { rawRequirement: _raw, acceptanceCriteria: _ac, dag: _dag, timeline: _tl, resourceOverview: _ro, evidence: _ev, ...summary } = requirement;
        return { ...summary };
      });
    },
    syncRequirementDelivery(requirementId, runId, status) {
      return respond(() => {
        const requirement = store.requirements.find((candidate) => candidate.id === requirementId);
        if (!requirement || requirement.archivedAt) throw failure("没有找到这条需求", "请回到需求看板重新选择", "未写入任何变更");
        const acceptedRunId = requirement.evidence.acceptance?.runId;
        if (!acceptedRunId || acceptedRunId !== runId) {
          throw failure(
            "交付状态与已固定的验收 Run 不一致",
            "请从该需求绑定的运行卷宗重新发起合入",
            "需求列和验收快照均未改变"
          );
        }
        const lane: RequirementLane = status === "merged"
          ? "done"
          : status === "returned-to-acceptance"
            ? "acceptance"
            : "merging";
        const nextException = status === "conflict" ? "blocked" : null;
        if (requirement.lane === lane
          && requirement.exception === nextException
          && requirement.delivery?.runId === runId
          && requirement.delivery.status === status) return requirementSummary(requirement);
        const from = requirementLaneLabel(requirement.lane);
        requirement.lane = lane;
        requirement.exception = nextException;
        requirement.updatedAt = touch();
        requirement.delivery = { runId, status, updatedAt: requirement.updatedAt };
        record(
          status === "merged" ? "完成合入" : status === "conflict" ? "合入冲突" : lane === "acceptance" ? "退回验收" : "进入待合入",
          requirement.code,
          `${from} → ${requirementLaneLabel(lane)}；Run ${runId} 交付状态 ${status}。`
        );
        return requirementSummary(requirement);
      });
    },
    syncRequirementEvidenceCapture(requirementId, runId, observation) {
      return respond(() => {
        const requirement = store.requirements.find((candidate) => candidate.id === requirementId);
        if (!requirement || requirement.archivedAt) throw failure("没有找到这条需求", "请回到需求看板重新选择", "未写入任何变更");
        const acceptedRunId = requirement.evidence.acceptance?.runId;
        if (!acceptedRunId || acceptedRunId !== runId) throw failure("补采状态与已固定的验收 Run 不一致", "请从该需求绑定的运行卷宗重新补采", "需求列和验收快照均未改变");
        if (requirement.evidenceCapture
          && new Date(observation.updatedAt).getTime() < new Date(requirement.evidenceCapture.updatedAt).getTime()) {
          return requirementSummary(requirement);
        }
        const lifecycleLocked = requirement.lane === "merging" || requirement.lane === "done";
        const projectedLane = lifecycleLocked
          ? requirement.lane
          : observation.status === "queued" || observation.status === "running" ? "running" : "acceptance";
        const projectedException = lifecycleLocked
          ? requirement.exception
          : observation.status === "failed" ? "failed" : null;
        const projectedMediaCount = observation.status === "passed" && observation.mediaCount !== undefined && requirement.evidence.acceptance
          ? Math.max(requirement.evidence.acceptance.mediaCount, observation.mediaCount)
          : requirement.evidence.acceptance?.mediaCount;
        const previousCapture = requirement.evidenceCapture;
        const unchanged = previousCapture?.runId === runId
          && previousCapture.status === observation.status
          && previousCapture.updatedAt === observation.updatedAt
          && previousCapture.message === observation.message
          && previousCapture.mediaCount === observation.mediaCount
          && requirement.lane === projectedLane
          && requirement.exception === projectedException
          && requirement.evidence.acceptance?.mediaCount === projectedMediaCount;
        if (unchanged) return requirementSummary(requirement);
        const from = requirementLaneLabel(requirement.lane);
        requirement.evidenceCapture = { runId, ...observation };
        // A completed merge is newer lifecycle evidence than the retained capture
        // record. Re-rendering the Run dossier must never pull a merged card back.
        if (requirement.lane !== "merging" && requirement.lane !== "done") {
          requirement.lane = projectedLane;
          requirement.exception = projectedException;
        }
        if (observation.status === "passed" && observation.mediaCount !== undefined && requirement.evidence.acceptance) {
          requirement.evidence.acceptance.mediaCount = Math.max(requirement.evidence.acceptance.mediaCount, observation.mediaCount);
          requirement.evidence.reviewNotes = `quality.audit Gate「${requirement.evidence.acceptance.reviewGate!.gateId}」passed；媒体证据 ${requirement.evidence.acceptance.mediaCount} 项；候选 worktree ${requirement.evidence.acceptance.worktreePath}。`;
        }
        requirement.updatedAt = requirement.evidenceCapture.updatedAt;
        record("同步验收补采", requirement.code, `${from} → ${requirementLaneLabel(requirement.lane)}；Run ${runId} 补采 ${observation.status}。`);
        return requirementSummary(requirement);
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
              { label: "空间树存储", value: options.storage ? "浏览器本地配置库 · v1" : "当前内存会话", hint: "正式 Project 仍来自 Workbench；需求与目录 UI 覆盖层使用版本化本地存储。" },
              { label: "Repository path", value: "逐项目保存", hint: "仅保存配置，不会移动磁盘上的文件。" }
            ]
          },
          {
            id: "scheduler",
            title: "调度器集成",
            description: "任务 DAG、Agent 时间线与资源占用将在接入调度器后展示真实数据。",
            entries: [
              { label: "调度器连接", value: "Run 证据已接入", hint: "需求执行编排仍需由项目 Workflow 绑定。" },
              { label: "数据回写", value: options.storage ? "需求看板本地持久化" : "测试隔离内存" }
            ]
          },
          {
            id: "execution",
            title: "Provider 与执行策略",
            description: "后续阶段的运行参数入口，本阶段不可触发真实执行。",
            entries: [
              { label: "Provider", value: "未配置 · 占位" },
              { label: "最大并发", value: "4（只读预览）" },
              { label: "Worktree 隔离", value: "有改动保留到人工验收" },
              { label: "Quality Gates", value: "通过 + 证据充分后才开放合并" }
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
export const dashboardService = createDashboardService({
  initialData: "empty",
  storage: typeof window === "undefined" ? undefined : window.localStorage
});
