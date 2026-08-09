/** service adapter 边界单测：正常路径 + 中文三段式错误路径 + demo:true 数据驱动断言。 */
import { describe, expect, it } from "vitest";
import { createDashboardService, type DashboardService } from "./service";
import { REQUIREMENT_LANES } from "./types";
import type { Project } from "../types";

const FIXED_NOW = new Date("2026-08-09T06:00:00.000Z");

function makeService(): DashboardService {
  let counter = 0;
  return createDashboardService({
    delayMs: () => 0,
    now: () => FIXED_NOW,
    idSeed: (prefix) => `${prefix}-test-${++counter}`
  });
}

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

  it("看板七列契约完整，按项目过滤且去掉详情字段", async () => {
    const service = makeService();
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
    const moved = await service.updateRequirementLane("req-102", "queued");
    expect(moved.lane).toBe("queued");
    expect(moved).not.toHaveProperty("dag");
    const summary = await service.getDashboardSummary();
    expect(summary.activities[0]?.action).toBe("迁移需求列");
    const same = await service.updateRequirementLane("req-102", "queued");
    expect(same.lane).toBe("queued");
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
  it("调度器集成区声明未接入，Repository path 策略固定文案", async () => {
    const service = makeService();
    const snapshot = await service.getSettingsSnapshot();
    const scheduler = snapshot.sections.find((section) => section.id === "scheduler");
    expect(scheduler?.entries.some((entry) => entry.value.includes("尚未接入调度器"))).toBe(true);
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
