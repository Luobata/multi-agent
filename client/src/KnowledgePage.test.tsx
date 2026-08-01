import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  KnowledgePage,
  KnowledgeProfilePolicyEditor,
  KnowledgeStewardConsole,
  findKnowledgeStewardProjects,
  listKnowledgeStewardSessions
} from "./KnowledgePage";
import type { Bootstrap, KnowledgeChangeRequest, Project, ProjectBinding, Session } from "./types";

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
    expect(html).toContain("发布车道");
    expect(html).toContain("员工 Profile");
    expect(html).toContain("影响与授权");
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
