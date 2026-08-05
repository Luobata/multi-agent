/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./ProjectPage";
import type { Bootstrap, WorkInstanceRecord, WorkInstanceStatus } from "./types";

const timestamp = "2026-08-01T00:00:00.000Z";

function workInstance(id: string, status: WorkInstanceStatus, updatedAt = timestamp): WorkInstanceRecord {
  return {
    id,
    invocationId: `inv-${id}`,
    employeeId: "xiaomixiang-tester",
    employeeVersion: 1,
    workflowId: "town-flow",
    workflowVersion: 1,
    nodeId: "node-1",
    runId: `run-${id}`,
    providerId: "mock",
    source: { kind: "mcp", label: "测试会话" },
    status,
    phase: "执行",
    createdAt: timestamp,
    updatedAt,
    transitions: []
  };
}

function mount(data: Bootstrap): { container: HTMLElement; root: Root } {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  // roleDrafts are seeded from the saved binding in an effect, so render for real.
  act(() => root.render(<ProjectPage data={data} refresh={vi.fn()} notify={vi.fn()} />));
  return { container, root };
}

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
    owner: "user",
    injection: "none",
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
    capabilities: [],
    scope: { kind: "global" },
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
    expect(html).toContain("本项目临时追加的知识 Profile");
    expect(html).toContain("Workbench · 质量知识");
    expect(html).toContain("invoke_project_role");
  });

  it("shows MCP-triggered passive access separately and links matching roots to formal projects", () => {
    const data: Bootstrap = {
      ...bootstrap,
      passiveProjectAccesses: [{
        id: "mcp-external",
        rootPath: "/tmp/external-project",
        projectKeys: [],
        displayName: "external-project",
        transport: "mcp",
        requestCount: 3,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp
      }, {
        id: "mcp-cart-review",
        rootPath: "/tmp/cart-review",
        projectKeys: ["cart-review"],
        displayName: "cart-review",
        transport: "mcp",
        requestCount: 5,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        linkedProjectId: "cart-review"
      }]
    };

    const html = renderToStaticMarkup(<ProjectPage data={data} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("MCP 被动接入");
    expect(html).toContain("external-project");
    expect(html).toContain("/tmp/external-project");
    expect(html).toContain("3 次 Workbench 请求");
    expect(html).toContain("MCP 最近触发");
    expect(html).toContain("5 次请求");
    expect(html.match(/passive-project-card/g)).toHaveLength(1);
  });

  it("shows a migrated MCP project key when historical evidence has no root path", () => {
    const data: Bootstrap = {
      ...bootstrap,
      passiveProjectAccesses: [{
        id: "mcp-vibe-docing",
        projectKeys: ["vibe-docing"],
        displayName: "vibe-docing",
        transport: "mcp",
        requestCount: 2,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp
      }]
    };

    const html = renderToStaticMarkup(<ProjectPage data={data} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("vibe-docing");
    expect(html).toContain("未记录工作目录（历史调用）");
    expect(html).toContain("项目标识 vibe-docing");
    expect(html).toContain("2 次 Workbench 请求");
  });

  it("shows the bound employee runtime status on the role card", () => {
    const data: Bootstrap = { ...bootstrap, activity: { invocations: [], instances: [workInstance("i-1", "running")] } };
    const { container, root } = mount(data);

    const preview = container.querySelector(".project-employee-preview");
    expect(preview).not.toBeNull();
    expect(preview?.querySelector(".project-employee-flags .runtime-chip--running")?.textContent).toContain("工作中");
    // 档案 Stamp 与运行 Chip 分别存在
    expect(container.querySelector(".project-role-row .stamp")).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it("omits the runtime chip on the role card while the bound employee is idle", () => {
    const { container, root } = mount(bootstrap);

    const preview = container.querySelector(".project-employee-preview");
    expect(preview).not.toBeNull();
    // 大厅席位之外不做静态噪声：idle 时不渲染运行 Chip，角色 Stamp 独立保留。
    expect(preview?.querySelector(".runtime-chip")).toBeNull();
    expect(container.querySelector(".project-role-row .stamp")).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it("fades the completed chip on the role card through the page clock", () => {
    vi.useFakeTimers();
    const data: Bootstrap = { ...bootstrap, activity: { invocations: [], instances: [workInstance("i-1", "completed", new Date().toISOString())] } };
    const { container, root } = mount(data);
    let unmounted = false;
    try {
      const preview = container.querySelector(".project-employee-preview");
      expect(preview?.querySelector(".runtime-chip--completed")?.textContent).toContain("已完成");

      act(() => { vi.advanceTimersByTime(21_000); });

      // The dwell elapsed while staying on the page: the chip fades to idle and hides.
      expect(container.querySelector(".project-employee-preview .runtime-chip")).toBeNull();

      const timersBeforeUnmount = vi.getTimerCount();
      act(() => { root.unmount(); unmounted = true; });
      expect(vi.getTimerCount()).toBeLessThan(timersBeforeUnmount);
    } finally {
      if (!unmounted) act(() => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });
});
