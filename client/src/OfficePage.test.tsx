/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficePage } from "./OfficePage";
import type { Bootstrap, Employee, InvocationRecord, WorkInstanceRecord, WorkInstanceStatus } from "./types";

const timestamp = "2026-08-01T00:00:00.000Z";

function employee(id: string, displayName: string): Employee {
  return {
    id,
    version: 1,
    status: "active",
    identity: { displayName, background: "Test background", responsibilities: ["Build UI"] },
    description: "Test employee.",
    systemPrompt: "Test.",
    requestPrompt: "Return evidence.",
    capabilities: [],
    scope: { kind: "global" },
    skills: [],
    skillVersions: {},
    providerId: "mock",
    outputSchema: { type: "object" },
    maxAttempts: 1,
    permissions: { write: "none", tools: [] },
    contextPolicy: { historyLimit: 20 },
    presentation: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function systemEmployee(id: string, displayName: string): Employee {
  const base = employee(id, displayName);
  return {
    ...base,
    identity: {
      ...base.identity,
      metadata: {
        internalProjectId: "local-agent-workbench",
        internalProjectRoleId: "knowledge-steward"
      }
    }
  };
}

function instance(id: string, employeeId: string, status: WorkInstanceStatus, updatedAt = timestamp, error?: string): WorkInstanceRecord {
  return {
    id,
    invocationId: `inv-${id}`,
    employeeId,
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
    updatedAt,
    transitions: []
  };
}

function bootstrapWith(overrides: Partial<Bootstrap>): Bootstrap {
  return {
    providers: [{ id: "mock", definition: { adapter: "mock", model: "deterministic-mock" } }],
    skills: [],
    knowledgeBases: [],
    knowledgeProfiles: [],
    architectureTemplates: [],
    employees: [],
    workflows: [],
    sessions: [],
    publications: [],
    projects: [],
    projectBindings: [],
    activity: { invocations: [], instances: [] },
    ...overrides
  };
}

describe("Office floor runtime status", () => {
  it("renders external and system Employees in separate rosters with an internal-only standby state", () => {
    const mihuhu = employee("mihuhu-frontend-engineer", "米糊糊 · 前端");
    const xiaozhi = systemEmployee("knowledge-steward", "小知 · 项目知识管理员");
    const html = renderToStaticMarkup(<OfficePage
      streamStatus="live"
      data={bootstrapWith({ employees: [mihuhu, xiaozhi] })}
    />);

    expect(html).toContain('id="office-external-heading"');
    expect(html).toContain('id="office-system-heading"');
    expect(html).toContain("外部可调用员工");
    expect(html).toContain("系统级员工");
    expect(html).toContain("office-employee--system");
    expect(html).toContain("仅接受内部项目角色调度");
    expect(html).toContain("内部项目 local-agent-workbench · 角色 knowledge-steward");
    expect(html).toContain("等待外部会话调度");
  });

  it("routes a systemRole-marked Employee into the system roster", () => {
    const mihuhu = employee("mihuhu-frontend-engineer", "米糊糊 · 前端");
    const xiaoyi = { ...employee("memory-summarizer", "小忆 · 运行经验提炼器"), systemRole: "automatic" as const };
    const html = renderToStaticMarkup(<OfficePage
      streamStatus="live"
      data={bootstrapWith({ employees: [mihuhu, xiaoyi] })}
    />);

    // The systemRole-marked Employee is rendered as a system seat, not an external one.
    expect(html).toContain("小忆 · 运行经验提炼器");
    const systemRosterAt = html.indexOf("office-roster-section--system");
    const externalRosterAt = html.indexOf("office-roster-section--external");
    expect(html.indexOf("小忆 · 运行经验提炼器")).toBeGreaterThan(systemRosterAt);
    expect(html.indexOf("米糊糊 · 前端")).toBeGreaterThan(externalRosterAt);
    expect(html.indexOf("米糊糊 · 前端")).toBeLessThan(systemRosterAt);
  });

  it("renders a permanent status rail and a runtime chip per seat", () => {
    const mihuhu = employee("mihuhu-frontend-engineer", "米糊糊 · 前端");
    const xiaomixiang = employee("xiaomixiang-tester", "小米象 · 测试");
    const html = renderToStaticMarkup(<OfficePage
      streamStatus="live"
      data={bootstrapWith({
        employees: [mihuhu, xiaomixiang],
        activity: { invocations: [], instances: [instance("i-1", mihuhu.id, "running")] }
      })}
    />);

    expect(html).toContain("seat-status-bar");
    expect(html).toContain("office-employee runtime-running");
    expect(html).toContain("runtime-chip--running");
    expect(html).toContain("工作中");
    expect(html).toContain("office-employee runtime-idle");
    expect(html).toContain("runtime-chip--idle");
    expect(html).toContain("空闲待命");
    expect(html).toContain("aria-live=\"polite\"");
  });

  it("keeps failures prominent and points to run evidence", () => {
    const mihuhu = employee("mihuhu-frontend-engineer", "米糊糊 · 前端");
    const html = renderToStaticMarkup(<OfficePage
      streamStatus="live"
      data={bootstrapWith({
        employees: [mihuhu],
        activity: { invocations: [], instances: [instance("i-1", mihuhu.id, "failed", timestamp, "mock 输出校验失败")] }
      })}
    />);

    expect(html).toContain("office-employee runtime-failed");
    expect(html).toContain("runtime-chip--failed");
    expect(html).toContain("故障");
    expect(html).toContain("打开实时台查看运行证据");
  });

  it("keeps completed visible briefly through the shared linger rule", () => {
    const mihuhu = employee("mihuhu-frontend-engineer", "米糊糊 · 前端");
    const html = renderToStaticMarkup(<OfficePage
      streamStatus="live"
      data={bootstrapWith({
        employees: [mihuhu],
        activity: { invocations: [], instances: [instance("i-1", mihuhu.id, "completed", new Date().toISOString())] }
      })}
    />);

    expect(html).toContain("runtime-chip--completed");
    expect(html).toContain("已完成");
  });
});

describe("Office floor live announcements", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.location.hash = "";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
  });

  it("gives failed drawer instances an explicit operable run-evidence entry", () => {
    const mihuhu = employee("mihuhu-frontend-engineer", "米糊糊 · 前端");
    const data = bootstrapWith({
      employees: [mihuhu],
      activity: { invocations: [], instances: [instance("i-1", mihuhu.id, "failed", timestamp, "mock 输出校验失败")] }
    });
    act(() => root.render(<OfficePage data={data} streamStatus="live" />));

    const seat = container.querySelector<HTMLButtonElement>(".office-employee");
    expect(seat).not.toBeNull();
    act(() => seat?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const drawer = container.querySelector(".employee-activity-drawer");
    expect(drawer).not.toBeNull();
    const failedCard = drawer?.querySelector(".instance-card--failed");
    expect(failedCard).not.toBeNull();
    // 失败实例必须有明确可操作的证据入口，不能只是说明文字。
    const evidenceButton = Array.from(failedCard?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent?.includes("查看运行证据"));
    expect(evidenceButton).toBeDefined();

    act(() => evidenceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(window.location.hash).toBe("#runs");
  });

  it("explains progress-aware long-running phases in the instance drawer", () => {
    const mihuhu = employee("mihuhu-frontend-engineer", "米糊糊 · 前端");
    const longRunning = { ...instance("i-1", mihuhu.id, "running"), phase: "long-running" };
    act(() => root.render(<OfficePage
      data={bootstrapWith({
        employees: [mihuhu],
        activity: { invocations: [], instances: [longRunning] }
      })}
      streamStatus="live"
    />));

    const seat = container.querySelector<HTMLButtonElement>(".office-employee");
    act(() => seat?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector(".employee-activity-drawer")?.textContent).toContain("长任务持续执行");
  });

  it("announces deduped status migrations keyed by instance id and status", () => {
    const mihuhu = employee("mihuhu-frontend-engineer", "米糊糊 · 前端");
    const running = bootstrapWith({
      employees: [mihuhu],
      activity: { invocations: [], instances: [instance("i-1", mihuhu.id, "running")] }
    });
    act(() => root.render(<OfficePage data={running} streamStatus="live" />));
    const liveRegion = () => container.querySelector<HTMLElement>(".sr-only[role='status']")!;
    // The initial snapshot is not announced as a migration.
    expect(liveRegion().textContent).toBe("");

    const completed = bootstrapWith({
      employees: [mihuhu],
      activity: { invocations: [], instances: [instance("i-1", mihuhu.id, "completed", new Date().toISOString())] }
    });
    act(() => root.render(<OfficePage data={completed} streamStatus="live" />));
    expect(liveRegion().textContent).toContain("米糊糊 · 前端 的工作实例已完成");

    // Re-rendering with unchanged statuses (e.g. elapsed-time ticks) does not re-announce.
    act(() => root.render(<OfficePage data={{ ...completed }} streamStatus="live" />));
    expect(liveRegion().textContent).toBe("米糊糊 · 前端 的工作实例已完成");
  });
});

describe("OfficePage supervisor studio", () => {
  const longLeaderSummary = "并行推进 client.fastify.integration.test.ts 与 streamAnswer/answer.ts，确认移动端布局和长标题不会撑破卡片边界。";
  const longWorkflowId = "team-flow-with-a-super-long-unbreakable-workflow-identifier";
  const longRequestSummary = "请由交付领队拆解、分工并推进不会撑破工作室卡片的完整 UX 交付标题";
  const longGateId = "quality.test-with-a-super-long-unbreakable-gate-identifier";
  const supervisorInvocation: InvocationRecord = {
    id: "inv-team-1",
    target: { kind: "workflow", id: "team-flow", version: 1 },
    source: { kind: "workbench" },
    status: "running",
    phase: "provider",
    requestSummary: longRequestSummary,
    runId: "run-team-1",
    instanceIds: [],
    executionSnapshot: { workflow: { id: longWorkflowId, version: 1, architecture: "supervisor" }, employees: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
    transitions: []
  };

  const bootstrap = {
    providers: [], skills: [], knowledgeBases: [], knowledgeProfiles: [], architectureTemplates: [],
    employees: [], managementPolicies: [], entrancePolicies: [], workflows: [], sessions: [], publications: [],
    projects: [], projectBindings: [],
    activity: { invocations: [supervisorInvocation], instances: [] }
  } as unknown as Bootstrap;

  const progress = {
    invocationId: "inv-team-1", runId: "run-team-1", workflowId: "team-flow", architecture: "supervisor",
    status: "running", phase: "provider", terminal: false, updatedAt: timestamp, round: 2,
    tally: { queued: 0, waiting: 0, running: 1, completed: 3, blocked: 0, failed: 0, skipped: 0, cancelled: 0 },
    steps: [],
    leaderReport: { available: true, rounds: 2, delegations: 2, entries: [{ round: 2, action: "delegate", summary: longLeaderSummary, assignments: [{ roleId: "researcher", task: "调研" }], status: "running" }], gates: [{ gateId: longGateId, status: "pending" }] }
  };

  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/progress")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: progress }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<OfficePage data={bootstrap} streamStatus="live" />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("renders a studio card with a progress bar for the active supervisor invocation", async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector(".studio-card")).toBeTruthy();
    const bar = container.querySelector<HTMLElement>(".studio-progress-fill");
    expect(bar).toBeTruthy();
    // 3 completed of 4 total => 75%
    expect(bar?.style.width).toBe("75%");
    expect(container.textContent).toContain("Round 2");
  });

  it("keeps long leader reports inside a dedicated clampable summary region", () => {
    const summary = container.querySelector<HTMLElement>(".studio-leader-summary");
    expect(summary?.textContent).toBe(longLeaderSummary);
    expect(summary?.title).toBe(longLeaderSummary);
    expect(summary?.parentElement?.classList.contains("studio-leader-note")).toBe(true);
    expect(container.querySelector<HTMLElement>(".studio-card-title > span")?.title).toBe(longWorkflowId);
    expect(container.querySelector<HTMLElement>(".studio-card-title > strong")?.title).toBe(longRequestSummary);
    expect(container.querySelector<HTMLElement>(".studio-gate")?.title).toBe(`${longGateId} · pending`);
  });

  it("polls the progress endpoint for the supervisor invocation", async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/invocations/inv-team-1/progress"))).toBe(true);
  });

  it("lingers a recently-completed supervisor as a settled (non-running) studio card", async () => {
    const settled: InvocationRecord = {
      ...supervisorInvocation,
      id: "inv-team-done",
      status: "completed",
      completedAt: new Date().toISOString()
    };
    const settledBootstrap = {
      ...bootstrap,
      activity: { invocations: [settled], instances: [] }
    } as unknown as Bootstrap;
    act(() => root.render(<OfficePage data={settledBootstrap} streamStatus="live" />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector(".studio-card--completed")).toBeTruthy();
    expect(container.querySelector(".studio-progress--live")).toBeNull();
  });
});
