/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowPage } from "./WorkflowPage";
import type { Bootstrap, Employee, InvocationRecord, Workflow } from "./types";

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

const workflow: Workflow = {
  id: "town-flow",
  version: 2,
  status: "active",
  architecture: "graph",
  description: "Two-step town workflow.",
  nodes: [
    { id: "draft", employeeId: "mihuhu-frontend-engineer", needs: [], with: {} },
    { id: "review", employeeId: "xiaomixiang-tester", needs: ["draft"], with: {} }
  ],
  maxConcurrency: 2,
  failFast: false,
  createdAt: timestamp,
  updatedAt: timestamp
};

function bootstrapWith(overrides: Partial<Bootstrap>): Bootstrap {
  return {
    providers: [{ id: "mock", definition: { adapter: "mock", model: "deterministic-mock" } }],
    skills: [],
    knowledgeBases: [],
    knowledgeProfiles: [],
    architectureTemplates: [],
    employees: [],
    workflows: [workflow],
    sessions: [],
    publications: [],
    projects: [],
    projectBindings: [],
    activity: { invocations: [], instances: [] },
    ...overrides
  };
}

function invocation(id: string, runId: string): InvocationRecord {
  return {
    id,
    target: { kind: "workflow", id: workflow.id, version: workflow.version },
    source: { kind: "workbench", label: "编排调试台" },
    status: "queued",
    phase: "排队",
    requestSummary: "Workflow 输入",
    runId,
    instanceIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    transitions: []
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

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function receipt(invocationId: string, runId: string): MockResponse {
  return {
    ok: true,
    status: 202,
    json: async () => ({
      data: {
        invocation: invocation(invocationId, runId),
        runId,
        statusUrl: `/api/invocations/${invocationId}`,
        streamUrl: "/api/activity/stream"
      }
    })
  };
}

describe("WorkflowPage async run order", () => {
  let container: HTMLElement;
  let root: Root;
  let startRequests: Array<Deferred<MockResponse>>;
  let notify: ReturnType<typeof vi.fn>;
  let refresh: ReturnType<typeof vi.fn>;

  const fetchMock = vi.fn((input: unknown, _init?: RequestInit): Promise<MockResponse> => {
    const url = String(input);
    if (url === `/api/workflows/${workflow.id}/start`) {
      const request = deferred<MockResponse>();
      startRequests.push(request);
      return request.promise;
    }
    // Version history read on selection resolves with an inert envelope.
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { versions: [workflow] } }) });
  });

  const flush = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const click = (element: Element) => {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  };
  const signButton = (): HTMLButtonElement => {
    const button = container.querySelector<HTMLButtonElement>("#run-workflow .run-actions button");
    if (!button) throw new Error("签发按钮未找到");
    return button;
  };
  const startCalls = () => fetchMock.mock.calls.filter(([input]) => String(input) === `/api/workflows/${workflow.id}/start`);

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.location.hash = "";
    startRequests = [];
    notify = vi.fn();
    refresh = vi.fn(async () => undefined);
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const data = bootstrapWith({
      employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端"), employee("xiaomixiang-tester", "小米象 · 测试")]
    });
    act(() => root.render(<WorkflowPage data={data} refresh={refresh} notify={notify} />));
    await flush(); // lets the version-history read settle inside act
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("posts the signed order to the async /start endpoint with debug-desk metadata", async () => {
    click(signButton());
    expect(startRequests).toHaveLength(1);

    const [url, init] = startCalls()[0] ?? [];
    expect(String(url)).toBe(`/api/workflows/${workflow.id}/start`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ message: "请完成这项协作任务" });
    const headers = init?.headers as Headers;
    expect(headers.get("x-multi-agent-source")).toBe("workbench");
    expect(headers.get("x-multi-agent-source-label")).toBe(`utf8:${encodeURIComponent("编排调试台")}`);
    // The legacy synchronous endpoint is no longer used.
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/workflows/${workflow.id}/run`)).toBe(false);

    startRequests[0]?.resolve(receipt("inv-1", "run-1"));
    await flush();
  });

  it("clears the submitting state on the 202 receipt without waiting for workflow completion", async () => {
    click(signButton());
    // While the receipt is pending the button is disabled and labelled as submitting.
    expect(signButton().disabled).toBe(true);
    expect(signButton().textContent).toContain("提交回执…");
    expect(container.querySelector("#run-workflow")?.textContent).toContain("提交回执");

    startRequests[0]?.resolve(receipt("inv-42", "run-42"));
    await flush();

    // The receipt alone re-enables the form; the client never polls the invocation status.
    expect(signButton().disabled).toBe(false);
    expect(signButton().textContent).toContain("签发并运行");
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, kind] = notify.mock.calls[0] ?? [];
    expect(kind).toBeUndefined();
    expect(String(message)).toContain("已受理");
    expect(String(message)).toContain("run-42");
    expect(String(message)).toContain("运行卷宗");
    expect(String(message)).toContain("员工大厅");
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/invocations/"))).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps failure feedback and restores the form after a rejected submission", async () => {
    click(signButton());
    expect(signButton().disabled).toBe(true);

    startRequests[0]?.resolve({ ok: false, status: 500, json: async () => ({ error: { message: "协作编排校验失败" } }) });
    await flush();

    expect(notify).toHaveBeenCalledTimes(1);
    const [message, kind] = notify.mock.calls[0] ?? [];
    expect(String(message)).toContain("协作编排校验失败");
    expect(kind).toBe("error");
    // The form recovers: the button is enabled again and a retry issues a new request.
    expect(signButton().disabled).toBe(false);
    expect(signButton().textContent).toContain("签发并运行");

    click(signButton());
    expect(startRequests).toHaveLength(2);
    startRequests[1]?.resolve(receipt("inv-2", "run-2"));
    await flush();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(String(notify.mock.calls[1]?.[0])).toContain("run-2");
  });
});
