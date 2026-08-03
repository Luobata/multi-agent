import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  KnowledgePage,
  KnowledgeProfilePolicyEditor,
  KnowledgeReviewBoard,
  KnowledgeStewardConsole,
  UrlImportModal,
  buildGrantReviewSetPayload,
  buildWikiDirectory,
  buildWikiTree,
  filterWikiDirectory,
  findKnowledgeStewardProjects,
  findWikiDirectoryPath,
  listKnowledgeStewardSessions,
  resolveReviewSubject
} from "./KnowledgePage";
import {
  KnowledgePerspectiveView,
  grantScheduleCopy,
  grantSourceCopy,
  reviewStatusCopy
} from "./knowledgePerspective";
import type {
  Bootstrap,
  Employee,
  KnowledgeChangeRequest,
  KnowledgeCollection,
  KnowledgePerspective,
  KnowledgeWikiDocument,
  Project,
  ProjectBinding,
  Session
} from "./types";

const timestamp = "2026-08-01T00:00:00.000Z";

const bootstrap: Bootstrap = {
  providers: [],
  skills: [],
  knowledgeBases: [{
    id: "workbench-handbook",
    version: 4,
    status: "active",
    displayName: "Workbench Handbook",
    description: "Versioned operating knowledge.",
    domain: "workbench",
    classification: "internal",
    collections: [{ id: "quality", displayName: "Quality", description: "Quality evidence.", authority: "canonical", tags: ["quality"] }],
    sources: [{ id: "quality-docs", kind: "directory", location: "/tmp/docs", collectionId: "quality" }],
    latestRevision: 2,
    publishedRevision: 1,
    syncStatus: "idle",
    qualityStatus: "healthy",
    createdAt: timestamp,
    updatedAt: timestamp
  }],
  knowledgeProfiles: [],
  architectureTemplates: [],
  employees: [],
  workflows: [],
  sessions: [],
  publications: [],
  projects: [],
  projectBindings: [],
  activity: { invocations: [], instances: [] }
};

describe("Knowledge control plane page", () => {
  it("opens as a complete governance console with separate operational tabs", () => {
    const html = renderToStaticMarkup(<KnowledgePage data={bootstrap} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("知识控制台");
    expect(html).toContain("总览");
    expect(html).toContain("知识目录");
    expect(html).toContain("全量 Wiki");
    expect(html).toContain("发布车道");
    expect(html).toContain("知识 Profile");
    expect(html).not.toContain("员工 Profile");
    expect(html).toContain("影响与授权");
    expect(html).toContain("授权复核");
    expect(html).toContain("从链接导入");
    expect(html).toContain("Workbench Handbook");
    expect(html).toContain("Published R1");
    expect(html).toContain("Latest R2");
    expect(html).toContain("待发布");
    expect(html).toContain("一条受控发布链");
  });

  it("renders every Profile rule as an editable policy instead of hiding later rules", () => {
    const profile = {
      id: "engineering-knowledge",
      version: 2,
      status: "active" as const,
      displayName: "工程知识",
      description: "Engineering policy.",
      rules: [{
        id: "engineering-core",
        selector: { knowledgeBaseIds: ["workbench-handbook"], collectionIds: ["quality"], authorities: ["canonical" as const], maxClassification: "internal" as const },
        activation: "core" as const,
        priority: 20,
        required: false,
        budget: { maxCollections: 1, maxChunks: 4, maxTokens: 2000 }
      }, {
        id: "foundation-demand",
        selector: { domains: ["workbench"], authorities: ["canonical" as const], maxClassification: "internal" as const },
        activation: "on-demand" as const,
        priority: 5,
        required: false,
        budget: { maxCollections: 2, maxChunks: 3, maxTokens: 1200 }
      }],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const html = renderToStaticMarkup(<KnowledgeProfilePolicyEditor profile={profile} knowledgeBases={bootstrap.knowledgeBases ?? []} onClose={vi.fn()} onSaved={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("engineering-core");
    expect(html).toContain("foundation-demand");
    expect(html).toContain("选择与激活规则 · 2");
    expect(html).toContain("增加规则");
  });

  it("exposes the AI 管理 tab in the console navigation", () => {
    const html = renderToStaticMarkup(<KnowledgePage data={bootstrap} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("AI 管理");
  });
});

const stewardProject: Project = {
  id: "local-agent-workbench",
  version: 3,
  status: "active",
  name: "Local Agent Workbench",
  description: "Local workbench.",
  scope: "repository",
  rootPath: "/repo",
  descriptorPath: "/repo/project.json",
  connector: { kind: "local", config: {} },
  roles: [{
    id: "knowledge-steward",
    displayName: "知识管家",
    description: "Project knowledge steward.",
    requiredSkills: [],
    optionalSkills: [],
    instructions: "Guard knowledge changes."
  }],
  createdAt: timestamp,
  updatedAt: timestamp
};

const stewardBinding: ProjectBinding = {
  projectId: "local-agent-workbench",
  projectVersion: 3,
  version: 3,
  roles: [{
    roleId: "knowledge-steward",
    employeeId: "local-agent-workbench-knowledge-steward",
    employeeVersion: 1,
    skills: [],
    skillVersions: {},
    updatePolicy: "locked"
  }],
  createdAt: timestamp,
  updatedAt: timestamp
};

const stewardSession: Session = {
  id: "session-steward-1",
  employeeId: "local-agent-workbench-knowledge-steward",
  employeeVersion: 1,
  assignment: { projectId: "local-agent-workbench", projectVersion: 3, projectBindingVersion: 3, roleId: "knowledge-steward" },
  title: "同步运营文档",
  status: "active",
  messages: [
    { id: "m1", role: "user", content: "同步运营知识库", at: timestamp },
    { id: "m2", role: "employee", content: "已生成同步提案，请在右侧批准。", at: timestamp, runId: "run-steward-1" }
  ],
  createdAt: timestamp,
  updatedAt: "2026-08-01T01:00:00.000Z"
};

const awaitingChange: KnowledgeChangeRequest = {
  id: "kc-1",
  status: "awaiting-approval",
  title: "同步运营知识库",
  reason: "来源文档已更新",
  requestedBy: "knowledge-steward",
  operation: { type: "knowledge-base.sync", targetId: "operations-handbook" },
  risk: "high",
  preview: {
    summary: "同步来源并生成新的草稿 Revision。",
    warnings: ["Collection operations 配置了来源，但上次同步没有文档"],
    impact: {
      knowledgeBaseIds: ["operations-handbook"],
      profileIds: ["ops-profile"],
      employeeIds: ["mihuhu-frontend-engineer"],
      projectRoles: ["local-agent-workbench/frontend-developer"]
    }
  },
  planHash: "abc123def4567890",
  createdAt: timestamp,
  updatedAt: timestamp
};

const reapprovalChange: KnowledgeChangeRequest = {
  ...awaitingChange,
  id: "kc-2",
  status: "needs-reapproval",
  title: "发布运营 Revision 3",
  operation: { type: "knowledge-revision.publish", targetId: "operations-handbook", expectedVersion: 3 },
  risk: "critical",
  error: "knowledge change impact or validation result changed; create a fresh proposal"
};

function stewardBootstrap(): Bootstrap {
  return {
    ...bootstrap,
    projects: [stewardProject],
    projectBindings: [stewardBinding],
    sessions: [stewardSession],
    knowledgeChanges: [awaitingChange, reapprovalChange]
  };
}

describe("Knowledge steward AI console", () => {
  it("only accepts active projects that declare and bind the knowledge-steward role", () => {
    expect(findKnowledgeStewardProjects(stewardBootstrap())).toHaveLength(1);
    expect(findKnowledgeStewardProjects({ ...stewardBootstrap(), projectBindings: [] })).toHaveLength(0);
    expect(findKnowledgeStewardProjects({ ...stewardBootstrap(), projects: [{ ...stewardProject, status: "archived" }] })).toHaveLength(0);
  });

  it("lists only knowledge-steward sessions, newest first", () => {
    const foreign: Session = { ...stewardSession, id: "session-other", assignment: { projectId: "local-agent-workbench", projectVersion: 3, projectBindingVersion: 3, roleId: "frontend-developer" }, updatedAt: "2026-08-01T02:00:00.000Z" };
    const older: Session = { ...stewardSession, id: "session-old", updatedAt: "2026-07-30T00:00:00.000Z" };
    const sessions = listKnowledgeStewardSessions({ ...stewardBootstrap(), sessions: [foreign, older, stewardSession] });
    expect(sessions.map((session) => session.id)).toEqual(["session-steward-1", "session-old"]);
  });

  it("renders the session rail, latest transcript, and standard change cards with human actions", () => {
    const html = renderToStaticMarkup(<KnowledgeStewardConsole data={stewardBootstrap()} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("知识会话");
    expect(html).toContain("同步运营文档");
    expect(html).toContain("steward-session-item selected");
    expect(html).toContain("变更提案");
    expect(html).toContain("待人工批准");
    expect(html).toContain("风险 高");
    expect(html).toContain("风险 严重");
    expect(html).toContain("同步来源并生成新的草稿 Revision。");
    expect(html).toContain("Collection operations 配置了来源，但上次同步没有文档");
    expect(html).toContain("operations-handbook");
    expect(html).toContain("ops-profile");
    expect(html).toContain("abc123def4567890");
    expect(html).toContain("需重新提案");
    expect(html).toContain("批准并执行");
    expect(html).toContain("拒绝");
    expect(html).toContain("取消提案");
  });

  it("shows the welcome state with quick prompts when starting a fresh session", () => {
    const html = renderToStaticMarkup(<KnowledgeStewardConsole data={{ ...stewardBootstrap(), sessions: [] }} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("新的知识会话");
    expect(html).toContain("你好，我是本项目的知识管家");
    expect(html).toContain("对话内容不会自动批准任何变更");
    expect(html).toContain("检查所有待发布草稿的质检结果和影响范围");
    expect(html).toContain("尚无知识会话");
  });

  it("keeps session history visible from bootstrap data after a refresh", () => {
    const html = renderToStaticMarkup(<KnowledgeStewardConsole data={stewardBootstrap()} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("同步运营知识库");
    expect(html).toContain("已生成同步提案，请在右侧批准。");
  });

  it("shows an explicit empty state instead of calling employees directly when no steward is bound", () => {
    const html = renderToStaticMarkup(<KnowledgeStewardConsole data={bootstrap} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("还没有项目接入知识管家");
    expect(html).toContain("knowledge-steward");
    expect(html).not.toContain("批准并执行");
  });
});

const wikiEntry = (id: string, parentId?: string, overrides: Partial<KnowledgeWikiDocument["document"]> = {}): KnowledgeWikiDocument => ({
  document: {
    id,
    title: `文档 ${id}`,
    content: `正文 ${id}`,
    collectionId: "quality",
    updatedAt: timestamp,
    ...(parentId ? { parentId } : {}),
    ...overrides
  },
  outgoingReferences: [],
  backlinks: [],
  candidateRelations: []
});

describe("全量 Wiki 树", () => {
  it("groups children under their parents and keeps unknown parents as roots", () => {
    const roots = buildWikiTree([wikiEntry("root"), wikiEntry("child", "root"), wikiEntry("grand", "child"), wikiEntry("orphan", "missing")]);

    expect(roots.map((node) => node.entry.document.id)).toEqual(["root", "orphan"]);
    expect(roots[0].children.map((node) => node.entry.document.id)).toEqual(["child"]);
    expect(roots[0].children[0].children.map((node) => node.entry.document.id)).toEqual(["grand"]);
  });

  it("derives Collection, source folders and explicit document parents without exposing a flat ID list", () => {
    const collections: KnowledgeCollection[] = [
      { id: "quality", displayName: "质量与证据", description: "Quality", authority: "canonical", tags: [] },
      { id: "empty", displayName: "空分区", description: "Empty", authority: "reference", tags: [] }
    ];
    const entries = [
      wikiEntry("colors", undefined, { title: "colors.md", sourceId: "docs", sourceRef: "/repo/guides/design/colors.md", metadata: { relativePath: "guides/design/colors.md" } }),
      wikiEntry("manual", undefined, { title: "人工说明" }),
      wikiEntry("child", "manual", { title: "子条目" }),
      wikiEntry("legacy", undefined, { title: "legacy.md", collectionId: "legacy", metadata: { relativePath: "archive/legacy.md" } })
    ];

    const tree = buildWikiDirectory(collections, entries);
    const quality = tree.find((node) => node.collectionId === "quality")!;
    const guides = quality.children.find((node) => node.label === "guides")!;
    const design = guides.children.find((node) => node.label === "design")!;
    const unclassified = quality.children.find((node) => node.kind === "unclassified")!;

    expect(tree.map((node) => node.label)).toEqual(["质量与证据", "空分区", "未识别 Collection · legacy"]);
    expect(quality.documentCount).toBe(3);
    expect(design.children[0]).toMatchObject({ kind: "document", label: "colors.md", entry: { document: { id: "colors" } } });
    expect(unclassified.children[0]).toMatchObject({ label: "人工说明", children: [{ label: "子条目" }] });
    expect(tree[1]).toMatchObject({ label: "空分区", documentCount: 0, children: [] });
    expect(findWikiDirectoryPath(tree, "colors")).toEqual(["质量与证据", "guides", "design", "colors.md"]);
    expect(findWikiDirectoryPath(tree, "child")).toEqual(["质量与证据", "未编目条目", "人工说明", "子条目"]);
  });

  it("searches title, path, source reference and hidden ID while retaining only matching ancestors", () => {
    const collection: KnowledgeCollection = { id: "quality", displayName: "质量", description: "Quality", authority: "canonical", tags: [] };
    const tree = buildWikiDirectory([collection], [
      wikiEntry("colors", undefined, { title: "colors.md", sourceRef: "/repo/guides/colors.md", metadata: { relativePath: "guides/colors.md" } }),
      wikiEntry("doc-internal-42", undefined, { title: "tests.md", sourceRef: "/repo/checks/tests.md", metadata: { relativePath: "checks/tests.md" } })
    ]);

    expect(filterWikiDirectory(tree, "guides")[0]?.children[0]).toMatchObject({ label: "guides", documentCount: 1 });
    expect(filterWikiDirectory(tree, "/repo/checks")[0]?.children[0]).toMatchObject({ label: "checks", documentCount: 1 });
    expect(filterWikiDirectory(tree, "internal-42")[0]?.children[0]?.children[0]).toMatchObject({ entry: { document: { id: "doc-internal-42" } } });
    expect(filterWikiDirectory(tree, "missing")).toEqual([]);
  });
});

const reviewEmployee: Employee = {
  id: "frontend-developer",
  version: 3,
  status: "active",
  identity: { displayName: "Frontend", background: "UI", responsibilities: ["Build UI"] },
  description: "Builds UI.",
  systemPrompt: "prompt",
  requestPrompt: "request",
  capabilities: [],
  scope: { kind: "global" },
  skills: [],
  skillVersions: {},
  knowledgeProfileIds: ["frontend-knowledge", "shared-knowledge"],
  providerId: "mock",
  outputSchema: { type: "object" },
  maxAttempts: 1,
  permissions: { write: "none", tools: [] },
  contextPolicy: { historyLimit: 20 },
  presentation: {},
  createdAt: timestamp,
  updatedAt: timestamp
};

const reviewBinding: ProjectBinding = {
  ...stewardBinding,
  roles: [{
    roleId: "frontend-developer",
    employeeId: "frontend-developer",
    employeeVersion: 3,
    knowledgeProfileIds: ["shared-knowledge"],
    skills: [],
    skillVersions: {},
    updatePolicy: "locked"
  }]
};

const reviewItem = {
  id: "review-1",
  subject: { kind: "employee" as const, employeeId: "frontend-developer" },
  grant: {
    profileId: "frontend-knowledge",
    reason: "岗位需要",
    grantedBy: "local-owner",
    grantedAt: timestamp,
    source: "explicit" as const
  },
  status: "due-soon" as const,
  reasons: [],
  reminderOnly: true as const
};

describe("授权复核台账", () => {
  it("resolves employee and project-role subjects against bootstrap data", () => {
    const data: Bootstrap = { ...bootstrap, employees: [reviewEmployee], projectBindings: [reviewBinding] };

    expect(resolveReviewSubject(data, reviewItem)).toEqual({ profileIds: ["frontend-knowledge", "shared-knowledge"], expectedVersion: 3 });
    expect(resolveReviewSubject(data, { ...reviewItem, subject: { kind: "project-role", employeeId: "frontend-developer", projectId: "local-agent-workbench", roleId: "frontend-developer" } }))
      .toEqual({ profileIds: ["shared-knowledge"], expectedVersion: reviewBinding.version });

    const missing = resolveReviewSubject(data, { ...reviewItem, subject: { kind: "employee", employeeId: "ghost" } });
    expect(missing.profileIds).toEqual([]);
    expect(missing.expectedVersion).toBeUndefined();
    expect(missing.problem).toContain("无法安全构造提案");
  });

  it("shows a loading state before the ledger response and never renders write shortcuts", () => {
    const html = renderToStaticMarkup(<KnowledgeReviewBoard data={bootstrap} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("授权复核台账");
    expect(html).toContain("只提醒、不自动改权");
    expect(html).toContain("正在读取授权复核台账");
    expect(html).toContain("已逾期");
    expect(html).toContain("临近到期");
  });
});

describe("授权复核提案 payload", () => {
  const base = {
    reviewedProfileId: "frontend-knowledge",
    profileIds: ["frontend-knowledge", "shared-knowledge"],
    reason: "复核后保留 frontend-knowledge 授权",
    grantedBy: "local-owner"
  };

  it("retain 只对复核对象下发 grantOverride，并写入提交时刻 lastReviewedAt，不改 grantedAt", () => {
    const payload = buildGrantReviewSetPayload({
      ...base,
      mode: "retain",
      reviewCycleDays: "90",
      expiresAtDate: "2026-11-01",
      now: "2026-08-02T10:30:00.000Z"
    });

    expect(payload.profileIds).toEqual(["frontend-knowledge", "shared-knowledge"]);
    expect(payload.grantOverrides).toHaveLength(1);
    expect(payload.grantOverrides?.[0]).toEqual({
      profileId: "frontend-knowledge",
      reason: "复核后保留 frontend-knowledge 授权",
      grantedBy: "local-owner",
      lastReviewedAt: "2026-08-02T10:30:00.000Z",
      expiresAt: "2026-11-01T00:00:00.000Z",
      reviewCycleDays: 90
    });
    expect(payload.grantOverrides?.[0]).not.toHaveProperty("grantedAt");
    expect(payload).not.toHaveProperty("reason");
    expect(payload).not.toHaveProperty("expiresAt");
  });

  it("retain 未填到期与复核周期时不携带可选字段", () => {
    const payload = buildGrantReviewSetPayload({
      ...base,
      mode: "retain",
      reviewCycleDays: "",
      expiresAtDate: "",
      now: "2026-08-02T10:30:00.000Z"
    });

    expect(payload.grantOverrides?.[0]).toEqual({
      profileId: "frontend-knowledge",
      reason: "复核后保留 frontend-knowledge 授权",
      grantedBy: "local-owner",
      lastReviewedAt: "2026-08-02T10:30:00.000Z"
    });
    expect(payload.grantOverrides?.[0]).not.toHaveProperty("expiresAt");
    expect(payload.grantOverrides?.[0]).not.toHaveProperty("reviewCycleDays");
  });

  it("narrow 只改变 profileIds，不传 grantOverrides", () => {
    const payload = buildGrantReviewSetPayload({ ...base, mode: "narrow", keepIds: ["shared-knowledge"] });

    expect(payload).toEqual({ profileIds: ["shared-knowledge"] });
    expect(payload).not.toHaveProperty("grantOverrides");
  });

  it("revoke 只移除复核对象，不传 grantOverrides", () => {
    const payload = buildGrantReviewSetPayload({ ...base, mode: "revoke" });

    expect(payload).toEqual({ profileIds: ["shared-knowledge"] });
    expect(payload).not.toHaveProperty("grantOverrides");
  });

  it("retain 未注入 now 时默认使用当前时间", () => {
    const before = Date.now();
    const payload = buildGrantReviewSetPayload({ ...base, mode: "retain" });
    const after = Date.now();
    const reviewedAt = Date.parse(payload.grantOverrides?.[0]?.lastReviewedAt ?? "");

    expect(reviewedAt).toBeGreaterThanOrEqual(before);
    expect(reviewedAt).toBeLessThanOrEqual(after);
  });
});

describe("员工知识视角", () => {
  const candidate = {
    knowledgeBaseId: "workbench-handbook",
    knowledgeBaseVersion: 4,
    revision: 1,
    knowledgeBaseName: "Workbench Handbook",
    domain: "workbench",
    classification: "internal" as const,
    collection: { id: "quality", displayName: "Quality", description: "Quality evidence.", authority: "canonical" as const, tags: ["quality"] },
    matches: [{
      profileId: "frontend-knowledge",
      profileVersion: 2,
      ruleId: "quality-core",
      activation: "core" as const,
      priority: 20,
      required: false,
      budget: { maxCollections: 1, maxChunks: 4, maxTokens: 2000 },
      reason: "核心规则始终参与"
    }]
  };
  const perspective: KnowledgePerspective = {
    employee: {
      id: "frontend-developer",
      version: 3,
      knowledgeProfileIds: ["frontend-knowledge"],
      grants: [{
        profileId: "frontend-knowledge",
        reason: "岗位需要",
        grantedBy: "local-owner",
        grantedAt: timestamp,
        reviewCycleDays: 90,
        source: "explicit"
      }]
    },
    context: { request: "检查前端知识", taskTags: [] },
    eligible: [candidate],
    activated: [candidate],
    selected: [{
      knowledgeBaseId: "workbench-handbook",
      knowledgeBaseVersion: 4,
      revision: 1,
      collectionId: "quality",
      collectionName: "Quality",
      profileId: "frontend-knowledge",
      ruleId: "quality-core",
      activation: "core",
      priority: 20,
      reason: "核心规则始终参与",
      query: "检查前端知识",
      budget: { maxCollections: 1, maxChunks: 4, maxTokens: 2000 }
    }],
    exclusions: [],
    recentEvidence: [],
    evidenceWindow: { policy: "recent-work-instances-v1", limit: 40, scannedInstances: 0, matchedRuns: 0 }
  };

  it("renders the three stages with grant metadata and rule explanations", () => {
    const html = renderToStaticMarkup(<KnowledgePerspectiveView perspective={perspective} />);

    expect(html).toContain("授权档案 · frontend-developer v3");
    expect(html).toContain("已授权 eligible");
    expect(html).toContain("当前任务 activated");
    expect(html).toContain("实际 selected");
    expect(html).toContain("frontend-knowledge");
    expect(html).toContain("quality-core");
    expect(html).toContain("核心规则始终参与");
    expect(html).toContain("显式授权");
    expect(html).toContain("每 90 天复核");
    expect(html).toContain("近期 Run 中没有留存的知识证据");
  });

  it("explains grant source and schedule copy", () => {
    expect(grantSourceCopy("explicit")).toBe("显式授权");
    expect(grantSourceCopy("legacy")).toBe("历史遗留授权");
    expect(grantScheduleCopy({ profileId: "p", reason: "r", grantedBy: "g", grantedAt: timestamp, source: "legacy" })).toBe("未排期复核");
    expect(reviewStatusCopy("overdue")).toBe("已逾期");
    expect(reviewStatusCopy("due-soon")).toBe("临近到期");
    expect(reviewStatusCopy("current")).toBe("复核期内");
    expect(reviewStatusCopy("unscheduled")).toBe("未排期");
  });
});

describe("从链接导入", () => {
  it("opens on the target step with base and collection pickers and proposal-only copy", () => {
    const html = renderToStaticMarkup(<UrlImportModal knowledgeBases={bootstrap.knowledgeBases ?? []} notify={vi.fn()} onClose={vi.fn()} onProposed={vi.fn()} />);

    expect(html).toContain("从链接导入知识");
    expect(html).toContain("选择目标与链接");
    expect(html).toContain("核对冻结预览");
    expect(html).toContain("确认关联并提案");
    expect(html).toContain("目标知识库");
    expect(html).toContain("目标 Collection");
    expect(html).toContain("生成冻结预览");
    expect(html).toContain("不会写入任何知识内容");
  });

  it("explains the empty state when no active knowledge base exists", () => {
    const html = renderToStaticMarkup(<UrlImportModal knowledgeBases={[{ ...(bootstrap.knowledgeBases ?? [])[0], status: "archived" as const }]} notify={vi.fn()} onClose={vi.fn()} onProposed={vi.fn()} />);

    expect(html).toContain("没有活动知识库");
  });
});
