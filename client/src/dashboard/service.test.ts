/** service adapter 边界单测：正常路径 + 中文三段式错误路径 + demo:true 数据驱动断言。 */
import { describe, expect, it } from "vitest";
import { DASHBOARD_STORAGE_KEY, createDashboardService, mcpCatalogNodeId, type DashboardService } from "./service";
import { REQUIREMENT_LANES } from "./types";
import type { PassiveProjectAccess, Project } from "../types";

const FIXED_NOW = new Date("2026-08-09T06:00:00.000Z");

function makeService(): DashboardService {
  let counter = 0;
  return createDashboardService({
    delayMs: () => 0,
    now: () => FIXED_NOW,
    idSeed: (prefix) => `${prefix}-test-${++counter}`,
    initialData: "demo"
  });
}

function memoryStorage(initial = new Map<string, string>()) {
  return {
    values: initial,
    getItem: (key: string) => initial.get(key) ?? null,
    setItem: (key: string, value: string) => { initial.set(key, value); },
    removeItem: (key: string) => { initial.delete(key); }
  };
}

describe("empty production board and versioned persistence", () => {
  it("starts without demo nodes, requirements, activities, or archive records", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    expect(await service.listSpaces()).toEqual([]);
    expect(await service.listBoard()).toEqual([]);
    expect(await service.listArchive()).toEqual([]);
    expect(await service.getDashboardSummary()).toMatchObject({
      projects: { total: 0, active: 0 },
      requirements: { total: 0, active: 0 },
      activities: []
    });
  });

  it("deletes the pre-launch v1 test board and starts the v2 production board empty", async () => {
    const legacyKey = "local-agent-workbench.requirement-board.v1";
    const storage = memoryStorage(new Map([[legacyKey, JSON.stringify({ version: 1, store: { nodes: [], requirements: [{ id: "test-data" }], activities: [], archive: [] } })]]));
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", storage });
    expect(storage.values.has(legacyKey)).toBe(false);
    expect(await service.listBoard()).toEqual([]);
    expect(storage.values.has(DASHBOARD_STORAGE_KEY)).toBe(true);
  });

  it("persists a confirmed requirement across service recreation without restoring demo data", async () => {
    const storage = memoryStorage();
    const first = createDashboardService({ delayMs: () => 0, initialData: "empty", storage });
    first.syncConnectedProjects([connectedProject("connected-a")]);
    const created = await first.createRequirement({
      projectId: "connected-a",
      title: "首条真实需求",
      summary: "由用户确认创建",
      priority: "high",
      rawRequirement: "保留我的原话",
      acceptanceCriteria: ["可以独立验收"]
    });
    expect(storage.values.has(DASHBOARD_STORAGE_KEY)).toBe(true);

    const restored = createDashboardService({ delayMs: () => 0, initialData: "empty", storage });
    restored.syncConnectedProjects([connectedProject("connected-a")]);
    expect(await restored.listBoard()).toEqual([expect.objectContaining({ id: created.id, title: "首条真实需求" })]);
    expect(await restored.getRequirement(created.id)).toMatchObject({ rawRequirement: "保留我的原话" });
    expect((await restored.listSpaces()).filter((node) => node.kind === "project")).toHaveLength(1);
  });

  it("does not reuse a persisted requirement id after the browser service is recreated", async () => {
    const storage = memoryStorage();
    const first = createDashboardService({ delayMs: () => 0, initialData: "empty", storage });
    first.syncConnectedProjects([connectedProject("connected-a")]);
    const original = await first.createRequirement({
      projectId: "connected-a",
      title: "首条需求",
      summary: "保留 id",
      priority: "medium",
      rawRequirement: "首条",
      acceptanceCriteria: ["可验收"]
    });

    const restored = createDashboardService({ delayMs: () => 0, initialData: "empty", storage });
    restored.syncConnectedProjects([connectedProject("connected-a")]);
    const next = await restored.createRequirement({
      projectId: "connected-a",
      title: "重载后创建",
      summary: "必须获得新 id",
      priority: "medium",
      rawRequirement: "第二条",
      acceptanceCriteria: ["可并发"]
    });
    expect(next.id).not.toBe(original.id);
    expect(new Set((await restored.listBoard()).map((requirement) => requirement.id)).size).toBe(2);
  });

  it("reconciles a persisted waiting Run from the legacy running lane into confirmation", async () => {
    const storage = memoryStorage();
    const first = createDashboardService({ delayMs: () => 0, initialData: "empty", storage });
    first.syncConnectedProjects([connectedProject("connected-a")]);
    const created = await first.createRequirement({
      projectId: "connected-a",
      title: "等待高风险决定",
      summary: "旧版仍显示在执行中",
      priority: "high",
      rawRequirement: "执行到高风险修改前暂停",
      acceptanceCriteria: ["人工决定后继续原 Run"]
    });
    const config = { entrancePolicyId: "default-task-entrance-policy", autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await first.reserveRequirementAdvancement(created.id, config, "human");
    await first.syncRequirementAdvancement(created.id, reserved.idempotencyKey, {
      invocationId: "inv-confirmation",
      runId: "run-confirmation",
      status: "awaiting-human-decision",
      observedAt: "2026-08-10T02:00:00.000Z"
    }, config.pollIntervalMs);

    const envelope = JSON.parse(storage.values.get(DASHBOARD_STORAGE_KEY)!) as {
      version: number;
      store: { requirements: Array<{ id: string; lane: string }> };
    };
    envelope.store.requirements.find((requirement) => requirement.id === created.id)!.lane = "running";
    storage.values.set(DASHBOARD_STORAGE_KEY, JSON.stringify(envelope));

    const restored = createDashboardService({ delayMs: () => 0, initialData: "empty", storage });
    restored.syncConnectedProjects([connectedProject("connected-a")]);
    expect(await restored.getRequirement(created.id)).toMatchObject({
      lane: "confirmation",
      advancement: { status: "awaiting-human-decision", invocationId: "inv-confirmation" }
    });
    const repairedEnvelope = JSON.parse(storage.values.get(DASHBOARD_STORAGE_KEY)!) as typeof envelope;
    expect(repairedEnvelope.store.requirements.find((requirement) => requirement.id === created.id)?.lane).toBe("confirmation");
  });

  it("repairs legacy duplicate requirement ids without attaching one Run to two cards", async () => {
    const storage = memoryStorage();
    let id = 0;
    let minute = 0;
    const first = createDashboardService({
      delayMs: () => 0,
      initialData: "empty",
      storage,
      idSeed: (prefix) => `${prefix}-legacy-${++id}`,
      now: () => new Date(`2026-08-10T01:${String(minute++).padStart(2, "0")}:00.000Z`)
    });
    first.syncConnectedProjects([connectedProject("connected-a")]);
    const older = await first.createRequirement({
      projectId: "connected-a",
      title: "已经推进的旧需求",
      summary: "应保留 Run",
      priority: "medium",
      rawRequirement: "旧需求",
      acceptanceCriteria: ["可验收"]
    });
    const config = { entrancePolicyId: "default-task-entrance-policy", autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await first.reserveRequirementAdvancement(older.id, config, "human");
    await first.syncRequirementAdvancement(older.id, reserved.idempotencyKey, {
      invocationId: "inv-old",
      runId: "run-old",
      status: "running",
      observedAt: "2026-08-10T01:10:00.000Z"
    }, config.pollIntervalMs);
    const newer = await first.createRequirement({
      projectId: "connected-a",
      title: "误用旧 id 的新需求",
      summary: "不应继承 Run",
      priority: "medium",
      rawRequirement: "新需求",
      acceptanceCriteria: ["可并发"]
    });

    const envelope = JSON.parse(storage.values.get(DASHBOARD_STORAGE_KEY)!) as {
      store: { requirements: Array<{ id: string; title: string; lane: string; advancement?: unknown }> };
    };
    const persistedNewer = envelope.store.requirements.find((requirement) => requirement.title === newer.title)!;
    persistedNewer.id = older.id;
    persistedNewer.lane = "running";
    persistedNewer.advancement = envelope.store.requirements.find((requirement) => requirement.title === older.title)!.advancement;
    storage.values.set(DASHBOARD_STORAGE_KEY, JSON.stringify({ version: 2, store: envelope.store }));

    const repaired = createDashboardService({ delayMs: () => 0, initialData: "empty", storage });
    repaired.syncConnectedProjects([connectedProject("connected-a")]);
    const board = await repaired.listBoard();
    expect(new Set(board.map((requirement) => requirement.id)).size).toBe(2);
    expect(board.find((requirement) => requirement.title === older.title)).toMatchObject({
      id: older.id,
      lane: "running",
      advancement: { invocationId: "inv-old", runId: "run-old" }
    });
    const repairedNewer = board.find((requirement) => requirement.title === newer.title)!;
    expect(repairedNewer.lane).toBe("inbox");
    expect(repairedNewer.advancement).toBeUndefined();
  });

  it("ignores corrupt or unsupported persisted data and safely falls back to empty", async () => {
    const storage = memoryStorage(new Map([[DASHBOARD_STORAGE_KEY, JSON.stringify({ version: 99, store: { nodes: [{ id: "bad" }] } })]]));
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", storage });
    expect(await service.listSpaces()).toEqual([]);
    expect(await service.listBoard()).toEqual([]);
  });
});

describe("requirement advancement persistence", () => {
  const config = { entrancePolicyId: "default-task-entrance-policy", autoPollEnabled: false, pollIntervalMs: 15_000 };

  it("keeps queued, running and confirmation lanes runtime-controlled", async () => {
    const service = makeService();
    expect(await expectFailure(service.updateRequirementLane("req-103", "queued"))).toContain("只能由真实 Run 更新");
    expect(await expectFailure(service.updateRequirementLane("req-103", "confirmation"))).toContain("只能由真实 Run 更新");
    const reserved = await service.reserveRequirementAdvancement("req-103", config, "human");
    expect(await expectFailure(service.updateRequirementLane("req-103", "planned"))).toContain("仍有进行中的真实 Run");
    expect(reserved.idempotencyKey).toMatch(/^requirement:prj-workbench:req-103:advance:1:/);
  });

  it("moves one Run from execution to confirmation and back after the human decides", async () => {
    const service = makeService();
    const reserved = await service.reserveRequirementAdvancement("req-103", config, "human");
    expect(reserved).toMatchObject({ cycle: 1, status: "dispatching" });
    expect(reserved.idempotencyKey).toMatch(/^requirement:prj-workbench:req-103:advance:1:/);

    const queued = await service.syncRequirementAdvancement("req-103", reserved.idempotencyKey, {
      invocationId: "inv-1",
      runId: "run-1",
      leaderSessionId: "session-1",
      status: "queued",
      observedAt: "2026-08-09T06:00:01.000Z"
    }, config.pollIntervalMs);
    expect(queued).toMatchObject({ lane: "queued", advancement: { invocationId: "inv-1", runId: "run-1", nextCheckAt: "2026-08-09T06:00:16.000Z" } });

    const running = await service.syncRequirementAdvancement("req-103", reserved.idempotencyKey, {
      invocationId: "inv-1",
      runId: "run-1",
      status: "running",
      observedAt: "2026-08-09T06:00:16.000Z"
    }, config.pollIntervalMs);
    expect(running).toMatchObject({ lane: "running", exception: null, advancement: { status: "running" } });

    const awaitingDecision = await service.syncRequirementAdvancement("req-103", reserved.idempotencyKey, {
      invocationId: "inv-1",
      runId: "run-1",
      status: "awaiting-human-decision",
      observedAt: "2026-08-09T06:00:31.000Z"
    }, config.pollIntervalMs);
    expect(awaitingDecision).toMatchObject({ lane: "confirmation", exception: null, advancement: { status: "awaiting-human-decision" } });

    const resumed = await service.syncRequirementAdvancement("req-103", reserved.idempotencyKey, {
      invocationId: "inv-1",
      runId: "run-1",
      status: "running",
      observedAt: "2026-08-09T06:00:46.000Z"
    }, config.pollIntervalMs);
    expect(resumed).toMatchObject({ lane: "running", advancement: { status: "running" } });
  });

  it("keeps the same cycle available for a safe retry when dispatch has no receipt", async () => {
    const service = makeService();
    const first = await service.reserveRequirementAdvancement("req-103", config, "human");
    const failed = await service.failRequirementAdvancement("req-103", first.idempotencyKey, "响应中断");
    expect(failed).toMatchObject({ exception: "failed", advancement: { status: "failed" } });
    expect(failed.advancement?.invocationId).toBeUndefined();
    const retried = await service.reserveRequirementAdvancement("req-103", config, "human");
    expect(retried.idempotencyKey).toBe(first.idempotencyKey);
    expect(retried.cycle).toBe(1);
  });
});

function connectedProject(id: string, status: Project["status"] = "active"): Project {
  return {
    id,
    version: 2,
    status,
    name: id === "connected-a" ? "正式项目 A" : "正式项目 B",
    description: "测试接入项目",
    scope: "repository",
    rootPath: `/workspace/${id}`,
    descriptorPath: `/workspace/${id}/multi-agent.project.yaml`,
    connector: { kind: "repository-development", config: {} },
    roles: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z"
  };
}

function passiveProjectAccess(overrides: Partial<PassiveProjectAccess> = {}): PassiveProjectAccess {
  return {
    id: "access-a",
    rootPath: "/workspace/mcp-project",
    projectKeys: ["mcp-project", "client-a"],
    displayName: "MCP 发现项目",
    transport: "mcp",
    requestCount: 6,
    firstSeenAt: "2026-08-07T00:00:00.000Z",
    lastSeenAt: "2026-08-09T02:30:00.000Z",
    ...overrides
  };
}

/** 中文三段式：发生了什么；怎么办；数据是否安全。 */
function expectThreePart(error: unknown): string {
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message.split("；")).toHaveLength(3);
  return message;
}

async function expectFailure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => { throw new Error("expected rejection, got resolution"); },
    (rejection: unknown) => rejection
  );
  return expectThreePart(error);
}

describe("createFolder", () => {
  it("在根层与文件夹内创建，名称去空格并写入活动时间", async () => {
    const service = makeService();
    const root = await service.createFolder({ parentId: null, name: "  新方向  " });
    expect(root.kind).toBe("folder");
    expect(root.name).toBe("新方向");
    expect(root.parentId).toBeNull();
    expect(root.createdAt).toBe(FIXED_NOW.toISOString());
    const nested = await service.createFolder({ parentId: "fld-product", name: "子文件夹" });
    expect(nested.parentId).toBe("fld-product");
  });

  it("拒绝空名、超长名与同级重名，message 为中文三段式", async () => {
    const service = makeService();
    expect(await expectFailure(service.createFolder({ parentId: null, name: "   " }))).toContain("名称不能为空");
    expect(await expectFailure(service.createFolder({ parentId: null, name: "长".repeat(41) }))).toContain("40 个字符");
    expect(await expectFailure(service.createFolder({ parentId: null, name: "产品线" }))).toContain("同一层级已存在");
  });

  it("拒绝非文件夹父级与已归档父级", async () => {
    const service = makeService();
    expect(await expectFailure(service.createFolder({ parentId: "prj-workbench", name: "挂错位置" }))).toContain("目标位置不是文件夹");
    expect(await expectFailure(service.createFolder({ parentId: "missing", name: "孤儿" }))).toContain("目标位置不是文件夹");
  });
});

describe("createProject", () => {
  it("默认分支缺省为 main，Repository path 仅保存配置", async () => {
    const service = makeService();
    const project = await service.createProject({ parentId: "fld-infra", name: "审计服务", repositoryPath: " ~/dev/audit " });
    expect(project.kind).toBe("project");
    expect(project.repositoryPath).toBe("~/dev/audit");
    expect(project.defaultBranch).toBe("main");
    const custom = await service.createProject({ parentId: null, name: "数据管道", repositoryPath: "~/dev/pipeline", defaultBranch: "trunk" });
    expect(custom.defaultBranch).toBe("trunk");
  });

  it("拒绝空 Repository path，安全段声明不移动磁盘文件", async () => {
    const service = makeService();
    const message = await expectFailure(service.createProject({ parentId: null, name: "无路径", repositoryPath: "  " }));
    expect(message).toContain("Repository path 不能为空");
    expect(message).toContain("仅保存配置，不会移动磁盘上的文件");
  });

  it("拒绝同级重名项目", async () => {
    const service = makeService();
    expect(await expectFailure(service.createProject({ parentId: "fld-product", name: "多智能体工作台", repositoryPath: "~/dev/x" }))).toContain("同一层级已存在");
  });
});

describe("syncConnectedProjects", () => {
  it("以 bootstrap active Project 替换 mock 项目，并把演示需求稳定映射到正式项目", async () => {
    const service = makeService();
    service.syncConnectedProjects([connectedProject("connected-a"), connectedProject("connected-b")]);
    const nodes = await service.listSpaces();
    const projects = nodes.filter((node) => node.kind === "project");
    expect(projects.map((project) => project.id)).toEqual(["connected-a", "connected-b"]);
    expect(projects.map((project) => project.repositoryPath)).toEqual(["/workspace/connected-a", "/workspace/connected-b"]);
    expect(projects.every((project) => project.parentId === null && !project.favorite)).toBe(true);
    expect((await service.listBoard()).every((requirement) => ["connected-a", "connected-b"].includes(requirement.projectId))).toBe(true);
  });

  it("只有正式接入且 active 的项目可以承接需求，归档项目恢复入口保持禁用说明", async () => {
    const service = makeService();
    service.syncConnectedProjects([connectedProject("connected-a"), connectedProject("connected-b", "archived")]);
    const input = { title: "接入后需求", summary: "", priority: "medium" as const, rawRequirement: "说明", acceptanceCriteria: [] };
    await expect(service.createRequirement({ ...input, projectId: "connected-a" })).resolves.toMatchObject({ projectId: "connected-a" });
    expect(await expectFailure(service.createRequirement({ ...input, projectId: "connected-b" }))).toContain("尚未正式接入或已归档");
    expect(await expectFailure(service.createRequirement({ ...input, projectId: "prj-workbench" }))).toContain("尚未正式接入或已归档");
    const archived = (await service.listArchive()).find((record) => record.nodeId === "connected-b");
    expect(archived?.restoreDisabledReason).toContain("尚未提供项目恢复入口");
    expect(await expectFailure(service.restoreArchived(archived!.id))).toContain("尚未提供项目恢复入口");
  });

  it("把未关联的 MCP 发现记录放入同一目录，并允许移动与收藏", async () => {
    const service = makeService();
    const access = passiveProjectAccess();
    service.syncConnectedProjects([connectedProject("connected-a")], [access]);

    const observed = (await service.listSpaces()).find((node) => node.id === mcpCatalogNodeId(access.id));
    expect(observed).toMatchObject({
      kind: "mcp-observed",
      accessId: access.id,
      name: "MCP 发现项目",
      rootPath: "/workspace/mcp-project",
      projectKeys: ["mcp-project", "client-a"],
      historical: false,
      parentId: null,
      favorite: false
    });

    const moved = await service.moveNode(mcpCatalogNodeId(access.id), "fld-product");
    expect(moved.parentId).toBe("fld-product");
    const favorite = await service.toggleFavorite(mcpCatalogNodeId(access.id));
    expect(favorite.favorite).toBe(true);
  });

  it("关联正式项目后去重 MCP 行，并迁移目录位置、收藏和接入证据", async () => {
    const service = makeService();
    const access = passiveProjectAccess();
    service.syncConnectedProjects([], [access]);
    await service.moveNode(mcpCatalogNodeId(access.id), "fld-infra");
    await service.toggleFavorite(mcpCatalogNodeId(access.id));

    service.syncConnectedProjects([connectedProject("connected-a")], [{ ...access, linkedProjectId: "connected-a", requestCount: 9 }]);
    const nodes = await service.listSpaces();
    expect(nodes.some((node) => node.kind === "mcp-observed")).toBe(false);
    expect(nodes.find((node) => node.id === "connected-a")).toMatchObject({
      kind: "project",
      parentId: "fld-infra",
      favorite: true,
      mcpAccess: {
        accessId: "access-a",
        projectKeys: ["mcp-project", "client-a"],
        requestCount: 9,
        lastSeenAt: "2026-08-09T02:30:00.000Z"
      }
    });
  });

  it("MCP 发现记录不能承接需求、重命名或归档，历史记录保留缺目录状态", async () => {
    const service = makeService();
    const access = passiveProjectAccess({ rootPath: undefined, projectKeys: ["legacy-key"] });
    service.syncConnectedProjects([], [access]);
    const nodeId = mcpCatalogNodeId(access.id);
    const observed = (await service.listSpaces()).find((node) => node.id === nodeId);
    expect(observed).toMatchObject({ kind: "mcp-observed", historical: true, rootPath: undefined });
    const input = { title: "不应创建", summary: "", priority: "medium" as const, rawRequirement: "说明", acceptanceCriteria: [] };
    expect(await expectFailure(service.createRequirement({ ...input, projectId: nodeId }))).toContain("尚未正式接入或已归档");
    expect(await expectFailure(service.renameNode(nodeId, "改名"))).toContain("MCP 发现记录不能重命名");
    expect(await expectFailure(service.archiveNode(nodeId))).toContain("MCP 发现记录不能归档");
  });
});

describe("renameNode", () => {
  it("重命名并刷新 updatedAt", async () => {
    const service = makeService();
    const renamed = await service.renameNode("prj-console", "运营控制台 v2");
    expect(renamed.name).toBe("运营控制台 v2");
    expect(renamed.updatedAt).toBe(FIXED_NOW.toISOString());
  });

  it("拒绝不存在的节点与已归档节点", async () => {
    const service = makeService();
    expect(await expectFailure(service.renameNode("missing", "名字"))).toContain("没有找到这个空间节点");
    expect(await expectFailure(service.renameNode("prj-legacy-site", "旧官网改名"))).toContain("已归档节点不能重命名");
  });

  it("允许改成自己的名字，拒绝同级重名", async () => {
    const service = makeService();
    const same = await service.renameNode("fld-infra", "fld-infra".replace("fld-infra", "基础设施"));
    expect(same.name).toBe("基础设施");
    expect(await expectFailure(service.renameNode("fld-infra", "产品线"))).toContain("同一层级已存在");
  });
});

describe("moveNode", () => {
  it("移动到文件夹与回到根层", async () => {
    const service = makeService();
    const moved = await service.moveNode("prj-console", "fld-infra");
    expect(moved.parentId).toBe("fld-infra");
    const rooted = await service.moveNode("prj-console", null);
    expect(rooted.parentId).toBeNull();
  });

  it("拒绝移动到自身或自己的子层级", async () => {
    const service = makeService();
    expect(await expectFailure(service.moveNode("fld-infra", "fld-infra"))).toContain("自己的子层级");
    expect(await expectFailure(service.moveNode("fld-infra", "fld-legacy"))).toContain("自己的子层级");
  });

  it("拒绝已归档节点、非文件夹目标与目标层级重名", async () => {
    const service = makeService();
    expect(await expectFailure(service.moveNode("prj-legacy-site", null))).toContain("已归档节点不能移动");
    expect(await expectFailure(service.moveNode("prj-console", "prj-gateway"))).toContain("目标位置不是文件夹");
    const duplicate = await service.createProject({ parentId: "fld-infra", name: "多智能体工作台", repositoryPath: "~/dev/duplicate" });
    expect(await expectFailure(service.moveNode(duplicate.id, "fld-product"))).toContain("同一层级已存在");
  });
});

describe("toggleFavorite", () => {
  it("往返切换收藏状态", async () => {
    const service = makeService();
    const off = await service.toggleFavorite("prj-workbench");
    expect(off.favorite).toBe(false);
    const on = await service.toggleFavorite("prj-workbench");
    expect(on.favorite).toBe(true);
  });

  it("拒绝已归档节点与不存在的节点", async () => {
    const service = makeService();
    expect(await expectFailure(service.toggleFavorite("prj-legacy-site"))).toContain("已归档节点不能收藏");
    expect(await expectFailure(service.toggleFavorite("missing"))).toContain("没有找到这个空间节点");
  });
});

describe("archiveNode / restoreArchived", () => {
  it("归档项目生成含面包屑的记录，恢复后回到空间树", async () => {
    const service = makeService();
    const record = await service.archiveNode("prj-gateway");
    expect(record.nodeId).toBe("prj-gateway");
    expect(record.breadcrumb).toBe("基础设施 / 接入网关");
    expect((await service.listArchive()).some((entry) => entry.id === record.id)).toBe(true);
    const restored = await service.restoreArchived(record.id);
    expect(restored.archivedAt).toBeNull();
    expect("parentId" in restored).toBe(true);
    if (!("parentId" in restored)) throw new Error("expected a restored space node");
    expect(restored.parentId).toBe("fld-infra");
    expect((await service.listArchive()).some((entry) => entry.id === record.id)).toBe(false);
  });

  it("父级不可用时恢复回根层，不丢节点", async () => {
    const service = makeService();
    const child = await service.createProject({ parentId: "fld-legacy", name: "迁移验证", repositoryPath: "~/dev/migration-check" });
    const again = await service.archiveNode(child.id);
    await service.archiveNode("fld-legacy");
    const restored = await service.restoreArchived(again.id);
    if (!("parentId" in restored)) throw new Error("expected a restored space node");
    expect(restored.parentId).toBeNull();
  });

  it("拒绝重复归档与含未归档内容的文件夹", async () => {
    const service = makeService();
    expect(await expectFailure(service.archiveNode("prj-legacy-site"))).toContain("已经在归档中心");
    expect(await expectFailure(service.archiveNode("fld-product"))).toContain("还有未归档的内容");
  });

  it("拒绝恢复不存在的归档记录", async () => {
    const service = makeService();
    const message = await expectFailure(service.restoreArchived("arc-missing"));
    expect(message).toContain("没有找到这条归档记录");
    expect(message).toContain("归档内容仍然完整保留");
  });
});

describe("listBoard / getRequirement / updateRequirementLane", () => {
  it("创建需求进入收件箱，随后可归档并从归档中心恢复", async () => {
    const service = makeService();
    const created = await service.createRequirement({ projectId: "prj-console", title: "  新需求  ", summary: "摘要", priority: "high", rawRequirement: "原始说明", acceptanceCriteria: [" 可验收 ", ""] });
    expect(created.title).toBe("新需求");
    expect(created.lane).toBe("inbox");
    const detail = await service.getRequirement(created.id);
    expect(detail.acceptanceCriteria).toEqual(["可验收"]);
    const archived = await service.archiveRequirement(created.id);
    expect(archived.kind).toBe("requirement");
    expect((await service.listBoard("prj-console")).some((item) => item.id === created.id)).toBe(false);
    await service.restoreArchived(archived.id);
    expect((await service.listBoard("prj-console")).some((item) => item.id === created.id)).toBe(true);
  });

  it("拒绝给归档或未知项目创建需求", async () => {
    const service = makeService();
    const input = { title: "新需求", summary: "", priority: "medium" as const, rawRequirement: "说明", acceptanceCriteria: [] };
    expect(await expectFailure(service.createRequirement({ ...input, projectId: "prj-legacy-site" }))).toContain("尚未正式接入或已归档");
    expect(await expectFailure(service.createRequirement({ ...input, projectId: "missing" }))).toContain("尚未正式接入或已归档");
  });

  it("看板九列契约完整，按项目过滤且去掉详情字段", async () => {
    const service = makeService();
    expect(REQUIREMENT_LANES.map((lane) => lane.id)).toEqual([
      "inbox", "clarify", "planned", "queued", "running", "confirmation", "acceptance", "merging", "done"
    ]);
    const all = await service.listBoard();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((requirement) => REQUIREMENT_LANES.some((lane) => lane.id === requirement.lane))).toBe(true);
    expect(all[0]).not.toHaveProperty("dag");
    const scoped = await service.listBoard("prj-workbench");
    expect(scoped.every((requirement) => requirement.projectId === "prj-workbench")).toBe(true);
  });

  it("已归档项目的看板进入只读保护，未知项目报三段式", async () => {
    const service = makeService();
    expect(await expectFailure(service.listBoard("prj-legacy-site"))).toContain("只读保护");
    expect(await expectFailure(service.listBoard("missing"))).toContain("没有找到这个项目");
  });

  it("需求详情的 dag / timeline / resourceOverview 均带 demo:true 字面量", async () => {
    const service = makeService();
    const detail = await service.getRequirement("req-101");
    expect(detail.dag.demo).toBe(true);
    expect(detail.timeline.demo).toBe(true);
    expect(detail.resourceOverview.demo).toBe(true);
    expect(detail.dag.nodes.length).toBeGreaterThan(0);
    expect(detail.timeline.entries.length).toBeGreaterThan(0);
  });

  it("工作台资源概览同样由 demo:true 驱动", async () => {
    const service = makeService();
    const summary = await service.getDashboardSummary();
    expect(summary.resourceOverview.demo).toBe(true);
  });

  it("迁移列成功并写入活动，目标列相同则原样返回", async () => {
    const service = makeService();
    const moved = await service.updateRequirementLane("req-102", "clarify");
    expect(moved.lane).toBe("clarify");
    expect(moved).not.toHaveProperty("dag");
    const summary = await service.getDashboardSummary();
    expect(summary.activities[0]?.action).toBe("迁移需求列");
    const same = await service.updateRequirementLane("req-102", "clarify");
    expect(same.lane).toBe("clarify");
  });

  it("fail-closed：普通列迁移不能绕过 Run 验收快照", async () => {
    const service = makeService();
    const message = await expectFailure(service.updateRequirementLane("req-102", "acceptance"));
    expect(message).toContain("缺少验收证据：Run 验收快照");
    expect((await service.getRequirement("req-102")).lane).toBe("planned");
  });

  it("fail-closed：eligible 或 test / audit / 交付证据缺失时原子提交不落半份数据", async () => {
    const service = makeService();
    const message = await expectFailure(service.submitRequirementForAcceptance("req-102", {
      runId: "run-incomplete",
      eligible: false,
      worktreePath: "/repo/.multi-agent/worktrees/run-incomplete",
      mediaCount: 0,
      structuredE2eCount: 0,
      diffFiles: [],
      capturedAt: FIXED_NOW.toISOString()
    }));
    expect(message).toContain("交付门禁 eligible");
    expect(message).toContain("quality.test");
    expect(message).toContain("quality.audit");
    expect(message).toContain("截图、录屏或结构化 E2E");
    expect(message).toContain("Diff 文件清单");
    const detail = await service.getRequirement("req-102");
    expect(detail.lane).toBe("planned");
    expect(detail.evidence.acceptance).toBeUndefined();
  });

  it("双门禁和真实证据齐全后，固定 Run 快照并迁移到待验收", async () => {
    const service = makeService();
    const snapshot = {
      runId: "run-acceptance-102",
      eligible: true,
      worktreePath: "/repo/.multi-agent/worktrees/run-acceptance-102",
      testGate: { gateId: "quality-test", status: "passed" },
      reviewGate: { gateId: "independent-review", status: "passed" },
      mediaCount: 1,
      structuredE2eCount: 2,
      diffFiles: ["client/src/RunsPage.tsx"],
      capturedAt: FIXED_NOW.toISOString()
    };
    const submitted = await service.submitRequirementForAcceptance("req-102", snapshot);
    expect(submitted.lane).toBe("acceptance");
    const detail = await service.getRequirement("req-102");
    expect(detail.evidence.acceptance).toEqual(snapshot);
    expect(detail.evidence.testReport).toContain("quality-test");
    expect(detail.evidence.reviewNotes).toContain("independent-review");
  });

  it("只用同一验收 Run 的交付状态驱动待合入、完成与异常退回", async () => {
    const service = makeService();
    const runId = "run-merge-queue-102";
    await service.submitRequirementForAcceptance("req-102", {
      runId,
      eligible: true,
      worktreePath: `/repo/.multi-agent/worktrees/${runId}`,
      testGate: { gateId: "quality-test", status: "passed" },
      reviewGate: { gateId: "independent-review", status: "passed" },
      mediaCount: 1,
      structuredE2eCount: 1,
      diffFiles: ["client/src/RunsPage.tsx"],
      capturedAt: FIXED_NOW.toISOString()
    });
    expect((await service.syncRequirementDelivery("req-102", runId, "queued-for-merge")).lane).toBe("merging");
    expect((await service.syncRequirementDelivery("req-102", runId, "returned-to-acceptance")).lane).toBe("acceptance");
    expect((await service.syncRequirementDelivery("req-102", runId, "merged")).lane).toBe("done");
    expect(await expectFailure(service.syncRequirementDelivery("req-102", "run-other", "merged"))).toContain("不一致");
  });

  it("拒绝未知需求、非法目标列与已取消需求", async () => {
    const service = makeService();
    expect(await expectFailure(service.updateRequirementLane("missing", "done"))).toContain("没有找到这条需求");
    expect(await expectFailure(service.updateRequirementLane("req-101", "nowhere" as never))).toContain("目标列不存在");
    expect(await expectFailure(service.updateRequirementLane("req-110", "done"))).toContain("已取消的需求不能迁移列");
  });

  it("详情查询拒绝未知需求", async () => {
    const service = makeService();
    expect(await expectFailure(service.getRequirement("missing"))).toContain("没有找到这条需求");
  });
});

describe("getSettingsSnapshot", () => {
  it("声明 Run 证据、人工合并门禁与 Repository path 安全策略", async () => {
    const service = makeService();
    const snapshot = await service.getSettingsSnapshot();
    const scheduler = snapshot.sections.find((section) => section.id === "scheduler");
    expect(scheduler?.entries.some((entry) => entry.value.includes("Run 证据已接入"))).toBe(true);
    const workspace = snapshot.sections.find((section) => section.id === "workspace");
    expect(workspace?.entries.some((entry) => entry.hint?.includes("仅保存配置，不会移动磁盘上的文件"))).toBe(true);
    const execution = snapshot.sections.find((section) => section.id === "execution");
    expect(execution?.entries.map((entry) => entry.label)).toEqual(expect.arrayContaining(["Provider", "最大并发", "Worktree 隔离", "Quality Gates"]));
  });
});

describe("project profile / repository bindings", () => {
  it("集中返回成员、Skills、知识和多个仓库，并可新增路径绑定", async () => {
    const service = makeService();
    const profile = await service.getProjectProfile("prj-workbench");
    expect(profile.members.length).toBeGreaterThan(0);
    expect(profile.skills.length).toBeGreaterThan(0);
    expect(profile.knowledge.length).toBeGreaterThan(0);
    expect(profile.project.repositories).toHaveLength(2);
    const updated = await service.bindRepository({ projectId: "prj-workbench", label: "服务端", path: "~/dev/backend", defaultBranch: "trunk" });
    expect(updated.repositories.at(-1)).toMatchObject({ label: "服务端", path: "~/dev/backend", defaultBranch: "trunk", primary: false });
  });

  it("拒绝重复路径，错误安全段声明不修改磁盘", async () => {
    const service = makeService();
    const message = await expectFailure(service.bindRepository({ projectId: "prj-workbench", label: "重复", path: "~/dev/multi-agent" }));
    expect(message).toContain("已绑定");
    expect(message).toContain("不会移动或修改磁盘文件");
  });
});
