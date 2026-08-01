import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./ProjectPage";
import type { Bootstrap } from "./types";

const timestamp = "2026-08-01T00:00:00.000Z";

const bootstrap: Bootstrap = {
  providers: [{ id: "mock", definition: { adapter: "mock" } }],
  skills: [{
    id: "browser-e2e-validation",
    version: 1,
    status: "active",
    displayName: "浏览器与 E2E 验收",
    description: "Validate browser behavior.",
    instructions: "Validate in a browser.",
    tools: [],
    createdAt: timestamp,
    updatedAt: timestamp
  }],
  knowledgeProfiles: [{
    id: "workbench-quality-knowledge",
    version: 1,
    status: "active",
    displayName: "Workbench · 质量知识",
    description: "Quality evidence.",
    rules: [{
      id: "quality",
      selector: { domains: ["workbench"] },
      activation: "core",
      priority: 10,
      required: false,
      budget: { maxCollections: 1, maxChunks: 3, maxTokens: 1200 }
    }],
    createdAt: timestamp,
    updatedAt: timestamp
  }],
  architectureTemplates: [],
  employees: [{
    id: "xiaomixiang-tester",
    version: 1,
    status: "active",
    identity: { displayName: "小米象 · 测试工程师", background: "Independent QA", responsibilities: ["Verify behavior"] },
    description: "Independent tester.",
    systemPrompt: "Test.",
    requestPrompt: "Return evidence.",
    skills: ["browser-e2e-validation"],
    skillVersions: { "browser-e2e-validation": 1 },
    providerId: "mock",
    outputSchema: { type: "object" },
    maxAttempts: 1,
    permissions: { write: "none", tools: [] },
    contextPolicy: { historyLimit: 20 },
    presentation: { avatarUrl: "/avatars/xiaomixiang-tester.png" },
    createdAt: timestamp,
    updatedAt: timestamp
  }],
  workflows: [],
  sessions: [],
  publications: [],
  projects: [{
    id: "cart-review",
    version: 1,
    status: "active",
    name: "Cart Review",
    description: "Connected project.",
    scope: "repository",
    rootPath: "/tmp/cart-review",
    descriptorPath: "/tmp/cart-review/multi-agent.project.yaml",
    connector: { kind: "worktree-review", config: {} },
    roles: [{
      id: "tester",
      displayName: "测试验收",
      description: "Browser acceptance.",
      requiredSkills: ["browser-e2e-validation"],
      optionalSkills: [],
      knowledgeProfileIds: ["workbench-quality-knowledge"],
      instructions: "Project policy."
    }],
    createdAt: timestamp,
    updatedAt: timestamp
  }],
  projectBindings: [{
    projectId: "cart-review",
    projectVersion: 1,
    version: 1,
    roles: [{
      roleId: "tester",
      employeeId: "xiaomixiang-tester",
      employeeVersion: 1,
      skills: ["browser-e2e-validation"],
      skillVersions: { "browser-e2e-validation": 1 },
      knowledgeProfileIds: ["workbench-quality-knowledge"],
      updatePolicy: "compatible"
    }],
    createdAt: timestamp,
    updatedAt: timestamp
  }],
  activity: { invocations: [], instances: [] }
};

describe("Project connection page", () => {
  it("explains descriptor-based connection and offers Employee assignment", () => {
    const html = renderToStaticMarkup(<ProjectPage data={bootstrap} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("项目声明");
    expect(html).toContain("角色与员工关联");
    expect(html).toContain("aria-label=\"测试验收分派员工\"");
    expect(html).not.toContain("<select");
    expect(html).toContain("项目不需要复制 Prompt");
    expect(html).toContain("本项目临时追加的 Knowledge Profile");
    expect(html).toContain("Workbench · 质量知识");
    expect(html).toContain("invoke_project_role");
  });
});
