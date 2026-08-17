/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
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
    if (url.startsWith("/api/runs") || url === "/api/human-decision-requests") {
      return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
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
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
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
  const breadcrumb = () => container.querySelector<HTMLElement>(".app-breadcrumb")!;
  const breadcrumbState = () => ({
    links: Array.from(breadcrumb().querySelectorAll<HTMLAnchorElement>("a")).map((link) => [link.textContent, link.getAttribute("href")]),
    current: breadcrumb().querySelector("[aria-current='page']")?.textContent,
    plain: Array.from(breadcrumb().querySelectorAll("span:not([aria-current])")).map((item) => item.textContent)
  });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    FakeEventSource.urls = [];
    FakeEventSource.closedCount = 0;
    FakeEventSource.active = [];
    bootstrapRequests = [];
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
    try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* jsdom storage may be disabled */ }
    window.location.hash = "#office";
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
    // This assertion covers bootstrap freshness, not route-chunk loading. Preload
    // the lazy Office page so parallel full-suite transforms cannot leave the
    // test observing Suspense's fallback after the bootstrap already settled.
    await import("./OfficePage");
    act(() => root.render(<App />));
    expect(bootstrapRequests).toHaveLength(1);

    respond(0, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端")] }));
    await flush();

    expect(container.textContent).toContain("本地运行核心已连接");
    expect(container.textContent).toContain("米糊糊 · 前端");
    expect(bootstrapRequests).toHaveLength(1);
  });

  it("opens the task-oriented dashboard for a new empty hash and exposes the lazy fallback", async () => {
    window.history.replaceState(null, "", window.location.pathname);
    act(() => root.render(<App />));
    expect(container.textContent).toContain("正在打开档案页面");
    respond(0, bootstrapWith({}));
    await flush();
    expect(container.textContent).toContain("现在做什么");
    expect(container.textContent).toContain("继续工作");
  });

  it("refetches exactly once when entering another page through the side nav", async () => {
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    click(navButton("员工档案"));
    expect(bootstrapRequests).toHaveLength(2);
    respond(1, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端")] }));
    await flush(); // lets the hashchange listener settle after navigate()
    await flush(); // lets the route chunk resolve independently from bootstrap

    expect(window.location.hash).toBe("#employees");
    // navigate() and the hashchange listener agree on the page: a single request per navigation.
    expect(bootstrapRequests).toHaveLength(2);
    expect(container.querySelector(".app-content")?.textContent).toContain("员工档案");
  });

  it("does not leave the shell syncing when only a detail section changes inside the same page", async () => {
    window.location.hash = "#requirements/req-local-1?section=overview";
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();
    expect(container.textContent).not.toContain("SYNCING · 正在同步最新档案");

    act(() => {
      window.history.pushState(null, "", "#requirements/req-local-1?section=run");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await flush();

    expect(bootstrapRequests).toHaveLength(1);
    expect(container.textContent).not.toContain("SYNCING · 正在同步最新档案");
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

    click(navButton("项目")); // request 1
    click(navButton("员工档案")); // request 2 supersedes request 1
    expect(bootstrapRequests).toHaveLength(3);

    respond(2, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "新数据员工")] }));
    await flush();
    respond(1, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "旧数据员工")] }));
    await flush();

    expect(container.textContent).toContain("新数据员工");
    expect(container.textContent).not.toContain("旧数据员工");
  });

  it("exposes one project entry instead of separate project-space and onboarding entries", async () => {
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    const labels = Array.from(container.querySelectorAll<HTMLButtonElement>(".side-nav .nav-items button"))
      .map((button) => button.textContent?.trim());
    expect(labels.filter((label) => label === "项目")).toHaveLength(1);
    expect(labels).not.toContain("项目空间");
    expect(labels).not.toContain("项目接入");
  });

  it("keeps the pending-decision attention signal on the dashboard nav only", async () => {
    await import("./OfficePage");
    await import("./BoardPage");
    await import("./RunsPage");
    const awaiting: InvocationRecord = {
      id: "inv-global-decision",
      target: { kind: "workflow", id: "team-flow", version: 1 },
      source: { kind: "workbench" },
      status: "awaiting-human-decision",
      phase: "awaiting-human-decision",
      requestSummary: "需要用户批准",
      runId: "run-global-decision",
      instanceIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      transitions: []
    };
    const run = { id: "run-global-decision", workflow: "team-flow", architecture: "graph", artifactDir: "/run", status: "running", createdAt: timestamp, nodes: {} };
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        const request = deferred<unknown>();
        bootstrapRequests.push(request);
        return request.promise;
      }
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, json: async () => ({ data: [run] }) });
      if (url === "/api/runs/run-global-decision") return Promise.resolve({ ok: true, json: async () => ({ data: run }) });
      if (url.endsWith("/merge-preview")) return Promise.resolve({ ok: true, json: async () => ({ data: {
        runId: "run-global-decision", status: "not-ready", eligible: false, reasons: [],
        acceptanceReadiness: { ready: false, reasons: [] }, targetClean: false,
        changes: { files: [], fileCount: 0, summary: "", unifiedDiff: { text: "", truncated: false, maxBytes: 262_144 } },
        safeGitCommands: [], evidence: { assets: [], structuredE2eCount: 0, acceptedVerdict: false, gates: [] },
        confirmationToken: "MERGE run-global-decision", discardConfirmationToken: "DISCARD run-global-decision"
      } }) });
      return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
    });
    act(() => root.render(<App />));
    respond(0, bootstrapWith({ activity: { invocations: [awaiting], instances: [] } }));
    await flush();

    // 工作台独占关注信号：badge 与 title 只挂在工作台导航项上。
    const dashboardButton = navButton("工作台");
    expect(dashboardButton.querySelector(".nav-attention-badge")?.textContent).toBe("1");
    expect(dashboardButton.getAttribute("title")).toContain("1 项待你决定");
    expect(navButton("需求看板").querySelector(".nav-attention-badge")).toBeNull();
    expect(navButton("需求看板").getAttribute("title")).toBe("需求看板");
    expect(navButton("运行卷宗").querySelector(".nav-attention-badge")).toBeNull();
    expect(navButton("运行卷宗").getAttribute("title")).toBe("运行卷宗");

    // 看板与卷宗导航保持平直跳转，不再劫持到某个具体 Run。
    click(navButton("需求看板"));
    respond(1, bootstrapWith({ activity: { invocations: [awaiting], instances: [] } }));
    await flush();
    expect(window.location.hash).toBe("#board");

    click(navButton("运行卷宗"));
    respond(2, bootstrapWith({ activity: { invocations: [awaiting], instances: [] } }));
    await flush();
    await flush();
    expect(window.location.hash).toBe("#runs");
    expect(window.location.hash).not.toContain("run-global-decision");

    // 聚焦链接仍然直达指定 Run 卷宗。
    act(() => {
      window.history.pushState(null, "", "#runs/run-global-decision");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await flush();
    expect(window.location.hash).toBe("#runs/run-global-decision");
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/runs/run-global-decision")).toBe(true);
  });

  it("enters read-only offline only when the very first bootstrap fails", async () => {
    window.location.hash = "#projects";
    act(() => root.render(<App />));
    respondError(0, "连接中断，请检查本地核心");
    await flush();

    expect(container.textContent).toContain("本地运行核心未连接");
    expect(container.textContent).toContain("READ ONLY");
    expect(container.textContent).toContain("项目目录同步失败");
    expect(container.textContent).not.toContain("正在同步已接入项目");
    expect(Array.from(container.querySelectorAll("[role='alert']")).some((alert) => alert.textContent?.includes("连接中断，请检查本地核心"))).toBe(true);
  });

  it("keeps daemon online, data and the live stream when a background refresh fails", async () => {
    act(() => root.render(<App />));
    respond(0, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端")] }));
    await flush();
    expect(container.textContent).toContain("本地运行核心已连接");
    expect(FakeEventSource.urls).toEqual(["/api/activity/stream"]);

    click(navButton("员工大厅")); // active-tab refresh
    respondError(1, "连接中断，请检查本地核心");
    await flush();

    // A failed background refresh must not flip the online daemon offline...
    expect(container.textContent).toContain("本地运行核心已连接");
    expect(container.textContent).not.toContain("READ ONLY");
    expect(container.textContent).toContain("米糊糊 · 前端"); // old data stays on screen
    // ...and must not tear down the existing activity stream.
    expect(FakeEventSource.closedCount).toBe(0);
    expect(FakeEventSource.urls).toEqual(["/api/activity/stream"]);
    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("连接中断，请检查本地核心");
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "重新同步");
    expect(retry).toBeDefined();

    click(retry as HTMLButtonElement);
    expect(bootstrapRequests).toHaveLength(3);
    respond(2, bootstrapWith({ employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端")] }));
    await flush();
    expect(container.querySelector("[role='alert']")).toBeNull(); // retry success clears the error
    expect(container.textContent).toContain("本地运行核心已连接");
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

  it("shows the 记忆档案 nav item after the 运行卷宗 entry", async () => {
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    const labels = Array.from(container.querySelectorAll<HTMLButtonElement>(".side-nav .nav-items button"))
      .map((button) => button.textContent ?? "");
    expect(navButton("记忆档案")).toBeTruthy();
    const runsIndex = labels.findIndex((label) => label.includes("运行卷宗"));
    const memoryIndex = labels.findIndex((label) => label.includes("记忆档案"));
    expect(memoryIndex).toBe(runsIndex + 1);
  });

  it("shows the Futaba Kindergarten brand name", async () => {
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    const brand = container.querySelector(".brand-mark strong");
    expect(brand?.textContent).toBe("双叶幼儿园");
  });

  it("defaults to the crayon theme on the document element", async () => {
    localStorage.removeItem("workbench-theme");
    document.documentElement.removeAttribute("data-theme");
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    expect(document.documentElement.getAttribute("data-theme")).toBe("crayon");
  });

  it("toggles to the pixel theme via the sidebar control", async () => {
    localStorage.removeItem("workbench-theme");
    document.documentElement.removeAttribute("data-theme");
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    const toggle = container.querySelector<HTMLButtonElement>(".side-nav .theme-toggle");
    const sidebar = container.querySelector<HTMLElement>(".side-nav")!;
    const brand = sidebar.querySelector<HTMLElement>(":scope > .brand-mark")!;
    const primaryNav = sidebar.querySelector<HTMLElement>(":scope > .nav-items")!;
    expect(sidebar.querySelectorAll(":scope > .theme-toggle")).toHaveLength(1);
    expect(brand.nextElementSibling).toBe(toggle);
    expect(toggle?.nextElementSibling).toBe(primaryNav);
    expect(toggle?.getAttribute("aria-label")).toBe("切换到治愈像素主题");
    expect(toggle?.dataset.testid).toBe("theme-toggle");
    expect(toggle?.dataset.themeTarget).toBe("pixel");
    click(toggle!);
    await flush();

    expect(document.documentElement.getAttribute("data-theme")).toBe("pixel");
    expect(localStorage.getItem("workbench-theme")).toBe("pixel");
    expect(toggle?.dataset.themeTarget).toBe("crayon");
  });

  it.each([
    ["#employees", "员工档案"],
    ["#projects", "项目"],
    ["#skills", "Skills"],
    ["#workflows", "协作编排"],
    ["#runs", "运行卷宗"],
    ["#publications", "调用包"]
  ])("renders %s as a current non-link root breadcrumb", async (hash, label) => {
    window.location.hash = hash;
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();
    expect(breadcrumbState()).toEqual({ links: [], current: label, plain: [] });
  });

  it.each([
    ["#employees?item=employee-1", "员工档案", "#employees", "employee-1"],
    ["#skills?item=skill-1", "Skills", "#skills", "skill-1"],
    ["#workflows?item=workflow-1", "协作编排", "#workflows", "workflow-1"],
    ["#runs/run-1", "运行卷宗", "#runs", "run-1"],
    ["#publications?item=publication-1", "调用包", "#publications", "publication-1"]
  ])("maps detail route %s to its parent destination", async (hash, parent, href, current) => {
    window.location.hash = hash;
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();
    expect(breadcrumbState()).toEqual({ links: [[parent, href]], current, plain: [] });
  });

  it.each([
    ["#projects/project-1", [["项目", "#projects"]], "project-1", []],
    ["#projects/project-1/board", [["项目", "#projects"], ["project-1", "#projects/project-1"]], "需求看板", []],
    ["#requirements/REQ-101", [["项目", "#projects"]], "REQ-101", ["项目不可用", "需求看板"]]
  ])("maps nested route %s without creating uncertain dead links", async (hash, links, current, plain) => {
    window.location.hash = hash;
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();
    expect(breadcrumbState()).toEqual({ links, current, plain });
  });

  it.each(["checking", "offline"])("keeps breadcrumb read navigation enabled while daemon is %s", async (status) => {
    window.location.hash = "#employees?item=employee-1";
    act(() => root.render(<App />));
    if (status === "offline") {
      respondError(0, "offline");
      await flush();
    }
    const link = breadcrumb().querySelector<HTMLAnchorElement>("a")!;
    expect(link.tabIndex).toBe(0);
    expect(link.getAttribute("aria-disabled")).toBeNull();
    expect(link.closest("[disabled], .daemon-write-surface")).toBeNull();
    link.focus();
    expect(document.activeElement).toBe(link);
    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    expect(link.dispatchEvent(clickEvent)).toBe(false);
    expect(link.getAttribute("href")).toBe("#employees");
  });

  it("places the detail breadcrumb before sidebar and main-content controls in the tab order", async () => {
    window.location.hash = "#projects/project-1";
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    const focusable = Array.from(container.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
    const breadcrumbLink = breadcrumb().querySelector<HTMLAnchorElement>("a")!;
    const sidebarControl = container.querySelector<HTMLButtonElement>(".side-nav button")!;
    const mainControl = container.querySelector<HTMLElement>("#main-content button, #main-content input, #main-content select, #main-content textarea")!;
    expect(focusable.slice(0, 2)).toEqual([container.querySelector(".skip-link"), breadcrumbLink]);
    expect(focusable.indexOf(breadcrumbLink)).toBeLessThan(focusable.indexOf(sidebarControl));
    expect(focusable.indexOf(breadcrumbLink)).toBeLessThan(focusable.indexOf(mainControl));
  });

  it("does not move focus on the initial render", async () => {
    window.location.hash = "#projects";
    const beforeApp = document.createElement("button");
    document.body.prepend(beforeApp);
    beforeApp.focus();

    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    expect(document.activeElement).toBe(beforeApp);
  });

  it("focuses main content after a route change and exposes the parent breadcrumb as the next tab stop", async () => {
    window.location.hash = "#projects";
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    act(() => {
      window.location.hash = "#projects/project-1";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await flush();

    const mainContent = container.querySelector<HTMLElement>("#main-content")!;
    const parentBreadcrumb = breadcrumb().querySelector<HTMLAnchorElement>("a[href='#projects']")!;
    const tabbableInMain = Array.from(mainContent.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
    expect(document.activeElement).toBe(mainContent);
    expect(tabbableInMain[0]).toBe(parentBreadcrumb);

    // jsdom does not perform native Tab traversal; focusing the proven first
    // tabbable descendant is the deterministic equivalent of one Tab here.
    parentBreadcrumb.focus();
    expect(document.activeElement).toBe(parentBreadcrumb);
  });

  it("writes the canonical #runs/<id> hash when the operator selects a run from the list", async () => {
    await import("./OfficePage");
    await import("./RunsPage");
    const runA = { id: "run-a", workflow: "wf-a", architecture: "graph", artifactDir: "/a", status: "passed", createdAt: timestamp, nodes: {} };
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        const request = deferred<unknown>();
        bootstrapRequests.push(request);
        return request.promise;
      }
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, json: async () => ({ data: [runA] }) });
      if (url === "/api/runs/run-a") return Promise.resolve({ ok: true, json: async () => ({ data: runA }) });
      if (url.endsWith("/merge-preview")) return Promise.resolve({ ok: true, json: async () => ({ data: {
        runId: "run-a", status: "not-ready", eligible: false, reasons: [],
        acceptanceReadiness: { ready: false, reasons: [] }, targetClean: false,
        changes: { files: [], fileCount: 0, summary: "", unifiedDiff: { text: "", truncated: false, maxBytes: 262_144 } },
        safeGitCommands: [], evidence: { assets: [], structuredE2eCount: 0, acceptedVerdict: false, gates: [] },
        confirmationToken: "MERGE run-a", discardConfirmationToken: "DISCARD run-a"
      } }) });
      return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
    });
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    click(navButton("运行卷宗"));
    await flush();
    const card = container.querySelector<HTMLButtonElement>("#run-a");
    expect(card).toBeTruthy();
    click(card!);
    await flush();

    expect(window.location.hash).toBe("#runs/run-a");
    expect(window.location.hash).not.toContain("?run=");
  });

  it("opens the exact Run from memory with a canonical hash, ignoring any remembered older Run", async () => {
    await import("./OfficePage");
    await import("./MemoryPage");
    await import("./RunsPage");
    const runOld = { id: "run-old", workflow: "wf-old", architecture: "graph", artifactDir: "/old", status: "passed", createdAt: timestamp, nodes: {} };
    const memoryRecord = {
      id: "rec-1",
      scope: { employeeId: "mihuhu-frontend-engineer", employeeVersion: 1 },
      kind: "run-summary",
      title: "运行记忆",
      content: "一次完成的运行。",
      provenance: { runId: "run-new", traceId: "trace-1" },
      status: "active",
      tokens: 10,
      createdAt: timestamp,
      supersedesId: null
    };
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        const request = deferred<unknown>();
        bootstrapRequests.push(request);
        return request.promise;
      }
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, json: async () => ({ data: [runOld] }) });
      if (url.startsWith("/api/runs/") && url.endsWith("/merge-preview")) return Promise.resolve({ ok: true, json: async () => ({ data: {
        runId: "run-old", status: "not-ready", eligible: false, reasons: [],
        acceptanceReadiness: { ready: false, reasons: [] }, targetClean: false,
        changes: { files: [], fileCount: 0, summary: "", unifiedDiff: { text: "", truncated: false, maxBytes: 262_144 } },
        safeGitCommands: [], evidence: { assets: [], structuredE2eCount: 0, acceptedVerdict: false, gates: [] },
        confirmationToken: "MERGE run-old", discardConfirmationToken: "DISCARD run-old"
      } }) });
      if (url.startsWith("/api/runs/")) return Promise.resolve({ ok: true, json: async () => ({ data: runOld }) });
      if (url === "/api/memory/scopes") return Promise.resolve({ ok: true, json: async () => ({ data: { scopes: [{ scopeKey: "employee:mihuhu-frontend-engineer", count: 1 }] } }) });
      if (url.startsWith("/api/memory/scope")) return Promise.resolve({ ok: true, json: async () => ({ data: { records: [memoryRecord] } }) });
      return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
    });
    act(() => root.render(<App />));
    respond(0, bootstrapWith({}));
    await flush();

    // 先看一份旧卷宗，让 runs 分组记住 run-old。
    click(navButton("运行卷宗"));
    await flush();
    click(container.querySelector<HTMLButtonElement>("#run-old")!);
    await flush();
    expect(window.location.hash).toBe("#runs/run-old");

    click(navButton("记忆档案"));
    await flush();
    const scope = [...container.querySelectorAll<HTMLButtonElement>(".memory-scope-card")]
      .find((candidate) => candidate.textContent?.includes("employee:mihuhu-frontend-engineer"));
    expect(scope).toBeTruthy();
    click(scope!);
    await flush();
    const record = [...container.querySelectorAll<HTMLButtonElement>(".memory-record-card")]
      .find((candidate) => candidate.textContent?.includes("运行记忆"));
    expect(record).toBeTruthy();
    click(record!);
    await flush();
    const expand = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.includes("展开完整详情"));
    click(expand!);
    await flush();
    const link = container.querySelector<HTMLButtonElement>('[data-testid="memory-run-link"]');
    expect(link?.textContent).toBe("run-new");
    click(link!);
    await flush();

    // 记忆档案的选择必须直达 run-new，不能被记住的旧 Run 覆盖。
    expect(window.location.hash).toBe("#runs/run-new");
  });
});
