/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OfficePage } from "./OfficePage";
import type { Bootstrap, Employee, WorkInstanceRecord, WorkInstanceStatus } from "./types";

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
