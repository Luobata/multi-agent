/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EmployeePage } from "./EmployeePage";
import type { Bootstrap, Employee, Skill, WorkInstanceRecord, WorkInstanceStatus } from "./types";

const timestamp = "2026-07-31T00:00:00.000Z";

const humanizer: Skill = {
  id: "humanizer-zh",
  version: 1,
  status: "active",
  displayName: "Humanizer-zh",
  description: "Naturalize Chinese copy.",
  instructions: "Preserve facts and edit the copy.",
  tools: [],
  owner: "user",
  injection: "none",
  createdAt: timestamp,
  updatedAt: timestamp
};

const employee: Employee = {
  id: "product-manager",
  version: 1,
  status: "active",
  identity: {
    displayName: "Product Manager",
    background: "Product management",
    responsibilities: ["Define requirements"]
  },
  description: "Defines products.",
  systemPrompt: "Act as a product manager.",
  requestPrompt: "Return a product specification.",
  capabilities: [],
  scope: { kind: "global" },
  skills: [{ id: humanizer.id, config: {}, enabled: true }],
  skillVersions: { [humanizer.id]: 1 },
  knowledgeProfileIds: ["product-knowledge"],
  providerId: "mock",
  outputSchema: { type: "object" },
  maxAttempts: 1,
  permissions: { write: "none", tools: [] },
  contextPolicy: { historyLimit: 20 },
  presentation: {},
  createdAt: timestamp,
  updatedAt: timestamp
};

const systemEmployee: Employee = {
  ...employee,
  id: "knowledge-steward",
  identity: {
    ...employee.identity,
    displayName: "小知 · 项目知识管理员",
    metadata: {
      internalProjectId: "local-agent-workbench",
      internalProjectRoleId: "knowledge-steward"
    }
  },
  description: "系统级知识控制员工。"
};

const projectEmployee: Employee = {
  ...employee,
  id: "park-orchestration-owner",
  identity: { ...employee.identity, displayName: "乐园协作编排负责人" },
  description: "项目中的真实负责人员工。",
  capabilities: ["quality.audit"],
  scope: { kind: "project", projectId: "disney-park", projectVersion: 1 },
  template: { id: "orchestration-owner", version: 2 }
};

const bootstrap: Bootstrap = {
  providers: [{ id: "mock", definition: { adapter: "mock", model: "deterministic-mock" } }],
  skills: [humanizer],
  knowledgeProfiles: [{
    id: "product-knowledge",
    version: 1,
    status: "active",
    displayName: "产品知识",
    description: "Product evidence.",
    rules: [{
      id: "product",
      selector: { domains: ["product"] },
      activation: "core",
      priority: 10,
      required: false,
      budget: { maxCollections: 1, maxChunks: 3, maxTokens: 1200 }
    }],
    createdAt: timestamp,
    updatedAt: timestamp
  }],
  architectureTemplates: [],
  employees: [employee],
  workflows: [],
  sessions: [],
  publications: [],
  projects: [],
  projectBindings: [],
  activity: { invocations: [], instances: [] }
};

const workInstance = (id: string, status: WorkInstanceStatus, error?: string): WorkInstanceRecord => ({
  id,
  invocationId: `inv-${id}`,
  employeeId: employee.id,
  employeeVersion: 1,
  workflowId: "town-flow",
  workflowVersion: 1,
  nodeId: "node-1",
  runId: `run-${id}`,
  providerId: "mock",
  source: { kind: "mcp", label: "测试会话" },
  status,
  phase: "执行",
  error,
  createdAt: timestamp,
  updatedAt: timestamp,
  transitions: []
});

describe("Employee Skill actions", () => {
  it("exposes separate add-from-pool and manage-binding entries", () => {
    const html = renderToStaticMarkup(<EmployeePage data={bootstrap} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("从技能池添加");
    expect(html).toContain("管理绑定");
    expect(html).toContain("知识授权");
    expect(html).toContain("产品知识");
    expect(html).toContain("知识试跑");
    expect(html).toContain("调整授权");
  });

  it("offers the employee knowledge perspective entry from the dossier", () => {
    const html = renderToStaticMarkup(<EmployeePage data={bootstrap} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("知识视角");
    expect(html).toContain("查看知识视角");
  });
});

describe("Employee access grouping", () => {
  it("separates system Employees and removes their direct invocation desk while retaining management", () => {
    const data: Bootstrap = { ...bootstrap, employees: [systemEmployee] };
    const html = renderToStaticMarkup(<EmployeePage data={data} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("外部可调用员工");
    expect(html).toContain("系统级员工");
    expect(html).toContain("小知 · 项目知识管理员");
    expect(html).toContain("仅供内部管理与项目角色调用");
    expect(html).toContain("local-agent-workbench");
    expect(html).toContain("knowledge-steward");
    expect(html).not.toContain('id="direct-desk"');
    expect(html).not.toContain("<h3>直接交办</h3>");
    expect(html).toContain("修订档案");
    expect(html).toContain("管理绑定");
    expect(html).toContain("调整授权");
  });

  it("keeps project Employees distinct from system Employees and shows pinned provenance", () => {
    const data: Bootstrap = { ...bootstrap, employees: [projectEmployee] };
    const html = renderToStaticMarkup(<EmployeePage data={data} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("项目员工");
    expect(html).toContain("乐园协作编排负责人");
    expect(html).toContain("disney-park · 固定项目 v1");
    expect(html).toContain("orchestration-owner · 固定模板 v2");
    expect(html).toContain("quality.audit");
    expect(html).not.toContain("SYSTEM / INTERNAL ONLY");
  });
});

describe("Employee runtime status", () => {
  it("shows the runtime chip next to the archive stamp in roster and dossier", () => {
    const data: Bootstrap = { ...bootstrap, activity: { invocations: [], instances: [workInstance("i-1", "running")] } };
    const html = renderToStaticMarkup(<EmployeePage data={data} refresh={vi.fn()} notify={vi.fn()} />);

    // 档案 active/archived 与运行状态正交：Stamp 与 Chip 分别存在
    expect(html).toContain("stamp--active");
    expect(html).toContain("runtime-chip--running");
    expect(html).toContain("工作中");
    expect(html).toContain("employee-card-stamps");
    expect(html).toContain("dossier-stamps");
  });

  it("keeps failures visible with an entry to the run evidence", () => {
    const data: Bootstrap = { ...bootstrap, activity: { invocations: [], instances: [workInstance("i-1", "failed", "mock 输出校验失败")] } };
    const html = renderToStaticMarkup(<EmployeePage data={data} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("runtime-chip--failed");
    expect(html).toContain("故障");
    expect(html).toContain("查看故障运行证据");
  });

  it("hides the runtime chip while idle and keeps the archive stamp on its own", () => {
    const html = renderToStaticMarkup(<EmployeePage data={bootstrap} refresh={vi.fn()} notify={vi.fn()} />);

    // 大厅席位之外不做静态噪声：idle 时不渲染运行 Chip，档案 Stamp 独立保留。
    expect(html).not.toContain("runtime-chip");
    expect(html).toContain("stamp--active");
  });
});

describe("Employee runtime clock", () => {
  it("fades the completed chip after its dwell and clears the timer on unmount", () => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let unmounted = false;
    try {
      const completed = { ...workInstance("i-1", "completed"), updatedAt: new Date().toISOString() };
      const data: Bootstrap = { ...bootstrap, activity: { invocations: [], instances: [completed] } };
      act(() => root.render(<EmployeePage data={data} refresh={vi.fn()} notify={vi.fn()} />));
      expect(container.querySelector(".runtime-chip--completed")?.textContent).toContain("已完成");

      act(() => { vi.advanceTimersByTime(21_000); });

      // The dwell elapsed while staying on the page: the chip fades back to idle
      // and idle chips stay hidden outside the office floor; the stamp remains.
      expect(container.querySelector(".runtime-chip")).toBeNull();
      expect(container.querySelector(".stamp--active")).not.toBeNull();

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
