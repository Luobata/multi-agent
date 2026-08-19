/** @vitest-environment jsdom */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityStreamContext, type ActivityStreamStatus, type ActivityStreamValue } from "./ActivityStream";
import { LiveAgentWorkbench } from "./LiveAgentWorkbench";
import type { ActivitySnapshot, InvocationProgress, WorkInstanceRecord } from "./types";

class FakeEventSource {
  static urls: string[] = [];
  constructor(url: string) {
    FakeEventSource.urls.push(url);
  }
  addEventListener(): void { /* no-op: the workbench must never open its own stream */ }
  close(): void { /* no-op */ }
}

function progressSnapshot(overrides: Partial<InvocationProgress> = {}): InvocationProgress {
  return {
    invocationId: "inv-1",
    runId: "run-1",
    workflowId: "safe-supervisor",
    architecture: "supervisor",
    status: "running",
    phase: "round-1",
    terminal: false,
    updatedAt: "2026-08-17T01:00:10.000Z",
    round: 1,
    tally: { queued: 0, waiting: 0, running: 1, "cancellation-requested": 0, completed: 1, blocked: 0, failed: 0, skipped: 0, cancelled: 0 },
    steps: [
      { nodeId: "node-leader", roleId: "leader", kind: "supervisor", round: 1, employeeId: "mihuhu-leader", status: "completed", phase: "完成第 1 轮规划", startedAt: "2026-08-17T01:00:00.000Z", completedAt: "2026-08-17T01:00:05.000Z" },
      { nodeId: "node-frontend", roleId: "frontend", kind: "member", round: 1, employeeId: "yaoxi-programmer", status: "running", phase: "实现登录表单", startedAt: "2026-08-17T01:00:06.000Z" }
    ],
    leaderReport: {
      available: true,
      rounds: 1,
      delegations: 1,
      entries: [
        { round: 1, action: "delegate", summary: "把登录表单拆给前端", assignments: [{ roleId: "frontend", task: "实现登录表单", workKind: "code" }], status: "running" }
      ],
      gates: [{ gateId: "quality-test", status: "pending" }]
    },
    ...overrides
  };
}

function instanceRecord(overrides: Partial<WorkInstanceRecord> = {}): WorkInstanceRecord {
  return {
    id: "wi-frontend",
    invocationId: "inv-1",
    employeeId: "yaoxi-programmer",
    employeeVersion: 1,
    workflowId: "safe-supervisor",
    workflowVersion: 10,
    nodeId: "node-frontend",
    roleId: "frontend",
    kind: "member",
    round: 1,
    memberSessionKey: "session-member-1",
    runId: "run-1",
    providerId: "mock",
    source: { kind: "workbench" },
    status: "running",
    phase: "实现登录表单",
    createdAt: "2026-08-17T01:00:06.000Z",
    startedAt: "2026-08-17T01:00:06.000Z",
    updatedAt: "2026-08-17T01:00:06.000Z",
    transitions: [],
    ...overrides
  } as WorkInstanceRecord;
}

function streamValue(activity: Partial<ActivitySnapshot> = {}, status: ActivityStreamStatus = "live"): ActivityStreamValue {
  return { activity: { invocations: [], instances: [], ...activity }, status };
}

describe("LiveAgentWorkbench", () => {
  let container: HTMLDivElement;
  let root: Root;

  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    if (url === "/api/invocations/inv-1/progress") {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: progressSnapshot() }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
  });

  const flush = async (ms = 10) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };

  const renderWithStream = (ui: ReactElement, stream: ActivityStreamValue = streamValue()) => {
    act(() => root.render(<ActivityStreamContext.Provider value={stream}>{ui}</ActivityStreamContext.Provider>));
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    FakeEventSource.urls = [];
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("renders agent cards from the progress snapshot with role, employee, status and phase", async () => {
    renderWithStream(<LiveAgentWorkbench invocationId="inv-1" runId="run-1" />);
    await flush();

    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/invocations/inv-1/progress")).toBe(true);
    const cards = [...container.querySelectorAll<HTMLElement>(".live-agent-card")];
    expect(cards).toHaveLength(2);
    const frontend = cards.find((card) => card.dataset.nodeId === "node-frontend")!;
    expect(frontend.textContent).toContain("frontend");
    expect(frontend.textContent).toContain("yaoxi-programmer");
    expect(frontend.textContent).toContain("实现登录表单");
    expect(frontend.querySelector(".stamp--running")).toBeTruthy();
  });

  it("marks running cards with the running visual class and completed cards with the passed class", async () => {
    renderWithStream(<LiveAgentWorkbench invocationId="inv-1" runId="run-1" />);
    await flush();

    const frontend = container.querySelector('[data-node-id="node-frontend"]');
    const leader = container.querySelector('[data-node-id="node-leader"]');
    expect(frontend?.className).toContain("live-agent-card--running");
    expect(frontend?.getAttribute("data-status")).toBe("running");
    expect(leader?.className).toContain("live-agent-card--passed");
    expect(leader?.getAttribute("data-status")).toBe("passed");
  });

  it("renders the leader timeline with rounds, summary and assignments", async () => {
    renderWithStream(<LiveAgentWorkbench invocationId="inv-1" runId="run-1" />);
    await flush();

    const timeline = container.querySelector(".live-leader-timeline");
    expect(timeline?.textContent).toContain("R1");
    expect(timeline?.textContent).toContain("delegate");
    expect(timeline?.textContent).toContain("把登录表单拆给前端");
    const assignment = timeline?.querySelector(".live-leader-assignments li");
    expect(assignment?.textContent).toContain("frontend");
    expect(assignment?.textContent).toContain("实现登录表单");
    expect(container.querySelector(".live-leader-entry--latest")).toBeTruthy();
  });

  it("updates a card when the shared activity snapshot carries a newer instance for this invocation", async () => {
    const workbench = <LiveAgentWorkbench invocationId="inv-1" runId="run-1" />;
    renderWithStream(workbench);
    await flush();

    renderWithStream(workbench, streamValue({
      instances: [instanceRecord({ status: "completed", phase: "登录表单已完成", completedAt: "2026-08-17T01:01:00.000Z", updatedAt: "2026-08-17T01:01:00.000Z" })]
    }));
    await flush();

    const frontend = container.querySelector('[data-node-id="node-frontend"]');
    expect(frontend?.className).toContain("live-agent-card--passed");
    expect(frontend?.textContent).toContain("登录表单已完成");
    expect(frontend?.textContent).toContain("session-member-1");

    // 其他 invocation 的实例不影响本工作台。
    renderWithStream(workbench, streamValue({
      instances: [instanceRecord({ id: "wi-other", invocationId: "inv-other", nodeId: "node-other", status: "failed", phase: "无关实例" })]
    }));
    await flush();
    expect(container.querySelector('[data-node-id="node-other"]')).toBeNull();
    expect(container.textContent).not.toContain("无关实例");

    // 共享流由 App 持有：本组件从不自建 EventSource。
    expect(FakeEventSource.urls).toHaveLength(0);
  });

  it("shows the guidance copy when no invocation is bound yet", async () => {
    act(() => root.render(<LiveAgentWorkbench />));
    await flush();

    expect(container.querySelector(".live-workbench--empty")).toBeTruthy();
    expect(container.textContent).toContain("推进需求后这里会实时展示 agent 工作细节");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeEventSource.urls).toHaveLength(0);
  });

  it("shows the terminal outcome and error summary when the invocation failed", async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === "/api/invocations/inv-1/progress") {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: progressSnapshot({
          status: "failed",
          terminal: true,
          phase: "failed",
          outcome: { status: "failed", reason: "worktree setup failed" },
          steps: [
            { nodeId: "node-frontend", roleId: "frontend", kind: "member", round: 1, employeeId: "yaoxi-programmer", status: "failed", phase: "准备 worktree", error: "worktree setup failed", startedAt: "2026-08-17T01:00:06.000Z", completedAt: "2026-08-17T01:00:30.000Z" }
          ]
        }) }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    });

    renderWithStream(<LiveAgentWorkbench invocationId="inv-1" runId="run-1" />);
    await flush();

    expect(container.querySelector(".live-workbench--terminal")).toBeTruthy();
    expect(container.querySelector(".live-workbench-outcome")?.textContent).toContain("worktree setup failed");
    const failed = container.querySelector('[data-node-id="node-frontend"]');
    expect(failed?.className).toContain("live-agent-card--failed");
    expect(failed?.querySelector(".live-agent-card-error")?.textContent).toContain("worktree setup failed");
  });

  it("falls back to polling when the shared stream reports offline", async () => {
    renderWithStream(<LiveAgentWorkbench invocationId="inv-1" runId="run-1" />, streamValue({}, "offline"));
    await flush();

    expect(container.querySelector(".live-workbench-feed--polling")?.textContent).toContain("轮询刷新");
    expect(FakeEventSource.urls).toHaveLength(0);
  });
});
