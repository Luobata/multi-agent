/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
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

function workInstance(id: string, employeeId: string, status: WorkInstanceStatus, updatedAt: string): WorkInstanceRecord {
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
    entrancePolicies: [],
    workflows: [],
    sessions: [],
    publications: [],
    projects: [],
    projectBindings: [],
    activity: { invocations: [], instances: [] },
    ...overrides
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeEventSource {
  static urls: string[] = [];
  static closedCount = 0;
  static active: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, EventListener>();
  constructor(url: string) {
    FakeEventSource.urls.push(url);
    FakeEventSource.active.push(this);
  }
  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }
  emit(type: string, payload: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }
  close(): void { FakeEventSource.closedCount += 1; }
}

describe("App navigation freshness", () => {
  let container: HTMLElement;
  let root: Root;
  let bootstrapRequests: Array<Deferred<unknown>>;

  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    if (url === "/api/bootstrap") {
      const request = deferred<unknown>();
      bootstrapRequests.push(request);
      return request.promise;
    }
    // Secondary reads (e.g. employee version history) resolve with an inert envelope.
    return Promise.resolve({ ok: true, json: async () => ({ data: { versions: [] } }) });
  });

  const respond = (index: number, data: Bootstrap) => {
    bootstrapRequests[index]?.resolve({ ok: true, json: async () => ({ data }) });
  };
  const respondError = (index: number, message: string) => {
    bootstrapRequests[index]?.resolve({ ok: false, status: 503, json: async () => ({ error: { message } }) });
  };
  const flush = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const click = (element: Element) => {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  };
  const navButton = (label: string): HTMLButtonElement => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>(".side-nav .nav-items button"))
      .find((candidate) => candidate.textContent?.includes(label));
    if (!button) throw new Error(`nav button not found: ${label}`);
    return button;
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    FakeEventSource.urls = [];
    FakeEventSource.closedCount = 0;
    FakeEventSource.active = [];
    bootstrapRequests = [];
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
    window.location.hash = "";
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches the latest bootstrap on first load", async () => {
    act(() => root.render(<App />));
    expect(bootstrapRequests).toHaveLength(1);

    respond(0, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端")] }));
    await flush();

    expect(container.textContent).toContain("小镇运行核心已连接");
    expect(container.textContent).toContain("米糊糊 · 前端");
    expect(bootstrapRequests).toHaveLength(1);
  });

  it("refetches exactly once when entering another page through the side nav", async () => {
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    click(navButton("员工档案"));
    expect(bootstrapRequests).toHaveLength(2);
    respond(1, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端")] }));
    await flush(); // lets the hashchange listener settle after navigate()

    expect(window.location.hash).toBe("#employees");
    // navigate() and the hashchange listener agree on the page: a single request per navigation.
    expect(bootstrapRequests).toHaveLength(2);
    expect(container.textContent).toContain("米糊糊 · 前端");
  });

  it("refetches when clicking the already-active tab without moving the hash", async () => {
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();
    const hashBefore = window.location.hash;

    click(navButton("员工大厅"));
    expect(bootstrapRequests).toHaveLength(2);
    respond(1, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端")] }));
    await flush();

    expect(window.location.hash).toBe(hashBefore);
    expect(container.textContent).toContain("米糊糊 · 前端");
  });

  it("keeps the newest navigation data when an older response resolves late", async () => {
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    click(navButton("项目接入")); // request 1
    click(navButton("员工档案")); // request 2 supersedes request 1
    expect(bootstrapRequests).toHaveLength(3);

    respond(2, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "新数据员工")] }));
    await flush();
    respond(1, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "旧数据员工")] }));
    await flush();

    expect(container.textContent).toContain("新数据员工");
    expect(container.textContent).not.toContain("旧数据员工");
  });

  it("enters read-only offline only when the very first bootstrap fails", async () => {
    act(() => root.render(<App />));
    respondError(0, "连接中断，请检查本地核心");
    await flush();

    expect(container.textContent).toContain("小镇运行核心未连接");
    expect(container.textContent).toContain("READ ONLY");
    expect(container.querySelector("[role='alert']")?.textContent).toContain("连接中断，请检查本地核心");
  });

  it("keeps daemon online, data and the live stream when a background refresh fails", async () => {
    act(() => root.render(<App />));
    respond(0, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端")] }));
    await flush();
    expect(container.textContent).toContain("小镇运行核心已连接");
    expect(FakeEventSource.urls).toEqual(["/api/activity/stream"]);

    click(navButton("员工大厅")); // active-tab refresh
    respondError(1, "连接中断，请检查本地核心");
    await flush();

    // A failed background refresh must not flip the online daemon offline...
    expect(container.textContent).toContain("小镇运行核心已连接");
    expect(container.textContent).not.toContain("READ ONLY");
    expect(container.textContent).toContain("米糊糊 · 前端"); // old data stays on screen
    // ...and must not tear down the existing activity stream.
    expect(FakeEventSource.closedCount).toBe(0);
    expect(FakeEventSource.urls).toEqual(["/api/activity/stream"]);
    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("连接中断，请检查本地核心");
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "重试连接");
    expect(retry).toBeDefined();

    click(retry as HTMLButtonElement);
    expect(bootstrapRequests).toHaveLength(3);
    respond(2, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端")] }));
    await flush();
    expect(container.querySelector("[role='alert']")).toBeNull(); // retry success clears the error
    expect(container.textContent).toContain("小镇运行核心已连接");
    expect(container.textContent).toContain("米糊糊 · 前端");
    // The retry recovered without duplicating the stream.
    expect(FakeEventSource.urls).toEqual(["/api/activity/stream"]);
    expect(FakeEventSource.closedCount).toBe(0);
  });

  it("keeps live SSE updates that arrived while a bootstrap refresh was in flight", async () => {
    const staleInstance = workInstance("i-1", "mihuhu-frontend-engineer", "running", new Date(Date.now() - 60_000).toISOString());
    act(() => root.render(<App />));
    respond(0, bootstrapWith({
      employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端")],
      activity: { invocations: [], instances: [staleInstance] }
    }));
    await flush();
    expect(container.textContent).toContain("工作中");

    click(navButton("员工大厅")); // background refresh now pending
    expect(bootstrapRequests).toHaveLength(2);

    // The live stream reports the instance completing while the request is in flight.
    const liveInstance: WorkInstanceRecord = { ...staleInstance, status: "completed", updatedAt: new Date().toISOString() };
    act(() => FakeEventSource.active[0]?.emit("activity", { type: "instance.changed", at: liveInstance.updatedAt, instance: liveInstance }));
    await flush();
    expect(container.textContent).toContain("已完成");

    // The older snapshot resolves last and must not clobber the newer live event.
    respond(1, bootstrapWith({
      employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端")],
      activity: { invocations: [], instances: [staleInstance] }
    }));
    await flush();

    expect(container.textContent).toContain("已完成");
    expect(container.textContent).not.toContain("工作中");
  });

  it("keeps a single activity stream across repeated navigations", async () => {
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    click(navButton("员工档案"));
    respond(1, bootstrapWith({}));
    await flush();
    click(navButton("员工大厅"));
    respond(2, bootstrapWith({}));
    await flush();

    expect(FakeEventSource.urls).toEqual(["/api/activity/stream"]);
  });
});
