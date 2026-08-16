/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmployeePage } from "./EmployeePage";
import { DaemonGate } from "./components";
import type { Bootstrap, Employee, InvocationStatus, Session, Skill, WorkInstanceRecord, WorkInstanceStatus } from "./types";

const timestamp = "2026-07-31T00:00:00.000Z";

const humanizer: Skill = {
  id: "humanizer-zh",
  version: 1,
  status: "active",
  displayName: "Humanizer-zh",
  description: "Naturalize Chinese copy.",
  summary: "Naturalize Chinese copy.",
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

const roleSystemEmployee: Employee = {
  ...employee,
  id: "memory-summarizer",
  identity: { ...employee.identity, displayName: "小忆 · 运行经验提炼器" },
  description: "自动触发型系统员工。",
  systemRole: "automatic"
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
    expect(html).toContain("AI 对话起草");
    expect(html).toContain("高级表单");
  });

  it("offers the employee knowledge perspective entry from the dossier", () => {
    const html = renderToStaticMarkup(<EmployeePage data={bootstrap} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("知识视角");
    expect(html).toContain("查看知识视角");
  });

  it("keeps the AI proposal history entry reachable while daemon writes are offline", () => {
    const html = renderToStaticMarkup(<DaemonGate status="offline"><EmployeePage data={bootstrap} refresh={vi.fn()} notify={vi.fn()} /></DaemonGate>);
    document.body.innerHTML = html;

    const draftButton = [...document.querySelectorAll("button")].find((button) => button.textContent === "AI 对话起草");
    const advancedFormButton = [...document.querySelectorAll("button")].find((button) => button.textContent === "高级表单");
    expect(draftButton?.disabled).toBe(false);
    expect(advancedFormButton?.disabled).toBe(true);
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
    expect(html).toContain("高级表单");
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

  it("groups a systemRole-marked Employee into the system section", () => {
    const data: Bootstrap = { ...bootstrap, employees: [employee, roleSystemEmployee] };
    const html = renderToStaticMarkup(<EmployeePage data={data} refresh={vi.fn()} notify={vi.fn()} />);

    // The system section renders with a distinct heading and badge, and the
    // systemRole-marked Employee sits inside it — not in the external roster.
    expect(html).toContain("系统级员工");
    expect(html).toContain("小忆 · 运行经验提炼器");
    expect(html).toContain("system-level-badge");
    const systemGroupStart = html.indexOf("employee-roster-group--system");
    const roleEmployeeAt = html.indexOf("小忆 · 运行经验提炼器");
    const externalGroupStart = html.indexOf("employee-roster-group--external");
    expect(systemGroupStart).toBeGreaterThanOrEqual(0);
    expect(roleEmployeeAt).toBeGreaterThan(systemGroupStart);
    // The business employee stays out of the system group (before it in DOM order).
    expect(html.indexOf("Product Manager")).toBeLessThan(systemGroupStart);
    expect(html.indexOf("Product Manager")).toBeGreaterThan(externalGroupStart);
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
    const failure = { ...workInstance("i-1", "failed", "mock 输出校验失败"), updatedAt: new Date().toISOString() };
    const data: Bootstrap = { ...bootstrap, activity: { invocations: [], instances: [failure] } };
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

describe("Employee e2e-evidence output-contract toggle", () => {
  const fieldTextarea = (root: HTMLElement, label: string) => {
    const field = Array.from(root.querySelectorAll("label.field")).find((el) => el.querySelector(".field-label")?.textContent === label);
    return field?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
  };
  const fieldInput = (root: HTMLElement, label: string) => {
    const field = Array.from(root.querySelectorAll("label.field")).find((el) => el.querySelector(".field-label")?.textContent === label);
    return field?.querySelector<HTMLInputElement>("input") ?? null;
  };

  it("injects the e2e output schema and prefills verdict fields when enabled", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) { this.setAttribute("open", ""); }
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) { this.removeAttribute("open"); }
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
    const click = (element: Element) => { act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true }))); };
    let unmounted = false;
    try {
      act(() => root.render(<EmployeePage data={bootstrap} refresh={vi.fn(async () => undefined)} notify={vi.fn()} />));
      await flush();

      const openEditor = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "高级表单");
      if (!openEditor) throw new Error("高级表单 button not found");
      click(openEditor);
      await flush();

      const toggle = container.querySelector<HTMLInputElement>('[role="switch"][aria-label="要求 e2e 证据"]');
      if (!toggle) throw new Error("要求 e2e 证据 toggle not found");
      expect(toggle.checked).toBe(false);

      click(toggle);
      await flush();

      const schema = fieldTextarea(container, "输出 JSON Schema");
      expect(schema?.value).toContain("\"e2eEvidence\"");
      expect(JSON.parse(schema?.value ?? "{}").required).toEqual(["verdict", "summary", "e2eEvidence", "risks"]);
      expect(fieldInput(container, "Verdict JSON path")?.value).toBe("/verdict");
      expect(fieldInput(container, "Pass 值")?.value).toBe("pass");
      expect(fieldInput(container, "Block 值")?.value).toBe("block");

      // The derived checked-state now reads true because the schema declares e2eEvidence.
      const toggleAfter = container.querySelector<HTMLInputElement>('[role="switch"][aria-label="要求 e2e 证据"]');
      expect(toggleAfter?.checked).toBe(true);
    } finally {
      act(() => root.unmount());
      unmounted = true;
      container.remove();
      document.body.replaceChildren();
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
      if (!unmounted) act(() => root.unmount());
    }
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

describe("DirectDesk async turn", () => {
  const receipt = {
    invocation: {
      id: "inv-1",
      target: { kind: "employee", id: employee.id, version: 1 },
      source: { kind: "workbench" },
      status: "queued",
      phase: "排队",
      requestSummary: "测试工单",
      runId: "run-1",
      sessionId: "sess-1",
      instanceIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      transitions: []
    },
    runId: "run-1",
    statusUrl: "/api/invocations/inv-1",
    progressUrl: "/api/invocations/inv-1/progress",
    streamUrl: "/api/invocations/inv-1/stream",
    monitor: {
      mode: "long-poll",
      tool: "wait_workflow_progress",
      initialCursor: "inv-1:0",
      defaultTimeoutMs: 20_000,
      maxTimeoutMs: 60_000,
      instructions: "long poll",
      waitUrl: "/api/invocations/inv-1/progress/wait"
    }
  };

  const progressPayload = (status: InvocationStatus, terminal: boolean) => ({
    invocationId: "inv-1",
    runId: "run-1",
    workflowId: "wf-1",
    architecture: "graph",
    status,
    phase: "执行",
    terminal,
    updatedAt: "2026-08-15T01:00:00.000Z",
    round: 1,
    tally: {},
    steps: [],
    leaderReport: { available: false, rounds: 0, delegations: 0, entries: [], gates: [] }
  });

  const waitResponse = (overrides: Record<string, unknown>) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: {
      invocationId: "inv-1",
      nextCursor: "inv-1:1",
      changed: false,
      terminal: false,
      reason: "heartbeat",
      progressReport: "",
      progress: progressPayload("running", false),
      ...overrides
    } })
  });

  const hydratedSession: Session = {
    id: "sess-1",
    employeeId: employee.id,
    employeeVersion: 1,
    title: "测试会话",
    status: "active",
    messages: [
      { id: "m1", role: "user", content: "帮我写一份方案", at: timestamp },
      { id: "m2", role: "employee", content: "方案已完成", at: timestamp, runId: "run-1" }
    ],
    createdAt: timestamp,
    updatedAt: timestamp
  };

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

  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let waitQueue: Array<Deferred<unknown>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let refresh: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;

  const flush = async (ms = 30) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
  const click = (element: Element) => { act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true }))); };
  const setText = (control: HTMLTextAreaElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const pendingPanel = () => container.querySelector<HTMLElement>('[aria-label="工单执行中"]');
  const postCalls = () => fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "POST");
  const startCalls = () => postCalls().filter((call) => String(call[0]).endsWith(`/api/employees/${employee.id}/start`));
  const waitCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes("/progress/wait"));

  const submitMessage = async (text: string) => {
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="交办事项"]');
    if (!textarea) throw new Error("composer textarea not found");
    act(() => setText(textarea, text));
    const submit = container.querySelector<HTMLButtonElement>('.work-order .composer button[type="submit"]');
    if (!submit) throw new Error("composer submit not found");
    await act(async () => {
      submit.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    waitQueue = [];
    fetchMock = vi.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith(`/api/employees/${employee.id}/start`)) {
        return Promise.resolve({ ok: true, status: 202, json: async () => ({ data: receipt }) });
      }
      if (url.includes("/progress/wait")) {
        const request = deferred<unknown>();
        waitQueue.push(request);
        return request.promise;
      }
      if (url === "/api/sessions/sess-1") return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: hydratedSession }) });
      if (url === "/api/invocations/inv-1/cancel") {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { ...receipt.invocation, status: "cancellation-requested" } }) });
      }
      if (url === `/api/employees/${employee.id}`) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { versions: [] } }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    refresh = vi.fn(async () => undefined);
    notify = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<EmployeePage data={bootstrap} refresh={refresh as () => Promise<void>} notify={notify} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("returns the composer immediately after the receipt and shows the waiting panel with the run evidence link", async () => {
    await submitMessage("帮我写一份方案");

    expect(startCalls()).toHaveLength(1);
    expect(JSON.parse(String(startCalls()[0]?.[1]?.body))).toEqual({ message: "帮我写一份方案" });
    const headers = new Headers(startCalls()[0]?.[1]?.headers as HeadersInit);
    expect(headers.get("x-multi-agent-source")).toBe("workbench");
    expect(headers.get("x-multi-agent-source-label")).toBe(`utf8:${encodeURIComponent("直接交办调试台")}`);

    const panel = pendingPanel();
    expect(panel).toBeTruthy();
    expect(panel?.textContent).toContain("帮我写一份方案");
    const evidence = panel?.querySelector<HTMLAnchorElement>("a.pending-turn-evidence");
    expect(evidence?.getAttribute("href")).toBe("#runs/run-1");
    expect(evidence?.textContent).toBe("打开运行卷宗 #run-1");
    // composer 已清空且没有发生第二次 POST。
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="交办事项"]')?.value).toBe("");
    expect(postCalls()).toHaveLength(1);
  });

  it("keeps the surface usable on heartbeat responses with the latest state and a ticking elapsed clock", async () => {
    await submitMessage("帮我写一份方案");
    expect(pendingPanel()?.textContent).toContain("已受理，等待服务端进度");

    act(() => waitQueue[0]?.resolve(waitResponse({ nextCursor: "inv-1:1", reason: "heartbeat" })));
    await flush();

    expect(pendingPanel()?.textContent).toContain("心跳");
    expect(pendingPanel()?.textContent).toContain("取消");

    const elapsed = () => pendingPanel()?.querySelector(".transcript-meta time")?.textContent;
    expect(elapsed()).toBe("00:00");
    await flush(1100);
    expect(elapsed()).toBe("00:01");
    // 监听器带着心跳返回的新游标继续下一轮长轮询。
    expect(waitCalls().some((call) => String(call[0]).includes("cursor=inv-1%3A1"))).toBe(true);
  });

  it("hydrates the transcript from the session on a terminal result", async () => {
    await submitMessage("帮我写一份方案");
    act(() => waitQueue[0]?.resolve(waitResponse({
      nextCursor: "inv-1:9",
      terminal: true,
      reason: "terminal",
      progress: progressPayload("completed", true)
    })));
    await flush();
    await flush();

    expect(fetchMock.mock.calls.some((call) => String(call[0]) === "/api/sessions/sess-1")).toBe(true);
    expect(pendingPanel()).toBeNull();
    expect(container.querySelector(".transcript")?.textContent).toContain("方案已完成");
    expect(notify).toHaveBeenCalledWith("工单已完成 · run-1");
    expect(refresh).toHaveBeenCalled();
  });

  it("posts an operator cancellation and settles on the server-driven cancelled terminal", async () => {
    await submitMessage("帮我写一份方案");
    const cancel = [...pendingPanel()!.querySelectorAll("button")].find((button) => button.textContent === "取消");
    expect(cancel).toBeTruthy();
    await act(async () => {
      cancel!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const cancelCalls = postCalls().filter((call) => String(call[0]) === "/api/invocations/inv-1/cancel");
    expect(cancelCalls).toHaveLength(1);
    expect(JSON.parse(String(cancelCalls[0]?.[1]?.body))).toEqual({ actor: "workbench-operator" });
    expect(pendingPanel()?.textContent).toContain("取消请求已送达");

    act(() => waitQueue[0]?.resolve(waitResponse({
      nextCursor: "inv-1:9",
      terminal: true,
      reason: "terminal",
      progress: progressPayload("cancelled", true)
    })));
    await flush();
    await flush();

    expect(pendingPanel()).toBeNull();
    expect(fetchMock.mock.calls.some((call) => String(call[0]) === "/api/sessions/sess-1")).toBe(true);
    expect(notify).toHaveBeenCalledWith("工单已取消，证据保留在运行卷宗");
    // 终态后监听停止，没有继续轮询。
    expect(waitCalls()).toHaveLength(1);
  });

  it("re-attaches the monitor from the same receipt and cursor after an interruption without resubmitting", async () => {
    await submitMessage("帮我写一份方案");
    act(() => waitQueue[0]?.reject(new Error("network down")));
    await flush();

    expect(pendingPanel()?.textContent).toContain("监听通道中断（网络或服务暂时不可达）");
    // 中断态同时提供重挂与取消两个出口。
    const buttonLabels = [...pendingPanel()!.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttonLabels).toContain("重新挂载监听");
    expect(buttonLabels).toContain("取消");
    const retry = [...pendingPanel()!.querySelectorAll("button")].find((button) => button.textContent === "重新挂载监听");
    expect(retry).toBeTruthy();

    await act(async () => {
      retry!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(waitCalls()).toHaveLength(2);
    expect(String(waitCalls()[1]?.[0])).toContain("cursor=inv-1%3A0");

    act(() => waitQueue[1]?.resolve(waitResponse({
      nextCursor: "inv-1:9",
      terminal: true,
      reason: "terminal",
      progress: progressPayload("completed", true)
    })));
    await flush();
    await flush();

    expect(startCalls()).toHaveLength(1);
    const occurrences = container.textContent?.split("帮我写一份方案").length ?? 0;
    expect(occurrences - 1).toBe(1);
    expect(container.querySelector(".transcript")?.textContent).toContain("方案已完成");
  });

  it("cancels from the interrupted state on the same receipt and observes the cancelled terminal after remount", async () => {
    await submitMessage("帮我写一份方案");
    act(() => waitQueue[0]?.reject(new Error("network down")));
    await flush();
    expect(pendingPanel()?.textContent).toContain("监听通道中断");

    // 中断态取消：同一回执的 cancel POST，不产生新的 /start。
    const cancel = [...pendingPanel()!.querySelectorAll("button")].find((button) => button.textContent === "取消");
    await act(async () => {
      cancel!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const cancelCalls = postCalls().filter((call) => String(call[0]) === "/api/invocations/inv-1/cancel");
    expect(cancelCalls).toHaveLength(1);
    expect(JSON.parse(String(cancelCalls[0]?.[1]?.body))).toEqual({ actor: "workbench-operator" });
    expect(startCalls()).toHaveLength(1);

    // 取消已送达但监听未挂载：重挂按钮仍在，文案引导重挂以观察取消终态。
    expect(pendingPanel()?.textContent).toContain("取消请求已送达；监听未挂载");
    const retry = [...pendingPanel()!.querySelectorAll("button")].find((button) => button.textContent === "重新挂载监听");
    expect(retry).toBeTruthy();
    await act(async () => {
      retry!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(waitCalls()).toHaveLength(2);
    expect(String(waitCalls()[1]?.[0])).toContain("cursor=inv-1%3A0");

    act(() => waitQueue[1]?.resolve(waitResponse({
      nextCursor: "inv-1:9",
      terminal: true,
      reason: "terminal",
      progress: progressPayload("cancelled", true)
    })));
    await flush();
    await flush();

    expect(pendingPanel()).toBeNull();
    expect(fetchMock.mock.calls.some((call) => String(call[0]) === "/api/sessions/sess-1")).toBe(true);
    expect(notify).toHaveBeenCalledWith("工单已取消，证据保留在运行卷宗");
    expect(startCalls()).toHaveLength(1);
  });

  it("locks the composer and session controls to a single in-flight turn", async () => {
    await submitMessage("帮我写一份方案");

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="交办事项"]')!;
    const submit = container.querySelector<HTMLButtonElement>('.work-order .composer button[type="submit"]')!;
    expect(textarea.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="选择会话"]')?.disabled).toBe(true);
    const newSession = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "新会话");
    expect(newSession?.disabled).toBe(true);
    // 取消与证据链接保持可用。
    expect(pendingPanel()?.querySelector("a.pending-turn-evidence")).toBeTruthy();
    expect([...pendingPanel()!.querySelectorAll("button")].some((button) => button.textContent === "取消")).toBe(true);

    // 代码级兜底：强制派发提交也不会产生第二个 /start。
    await act(async () => {
      submit.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startCalls()).toHaveLength(1);
    expect(postCalls()).toHaveLength(1);
  });
});
