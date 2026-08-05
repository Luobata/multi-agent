/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowPage } from "./WorkflowPage";
import type { Bootstrap, Employee, EntrancePolicy, InvocationRecord, ManagementPolicy, SupervisorWorkflow, Workflow } from "./types";

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

const managementPolicy: ManagementPolicy = {
  id: "review-policy",
  version: 3,
  status: "active",
  displayName: "评审领队策略",
  description: "先研究，再审查并收敛。",
  allowedRoleIds: ["researcher", "reviewer"],
  instructions: "按证据派单。",
  limits: { maxRounds: 5, maxDelegations: 8, maxParallelDelegations: 2, maxDurationMs: 600_000 },
  failure: { workerFailure: "observe-and-replan" },
  completion: { requireDelegation: true, requireAllDelegationsSuccessful: false },
  createdAt: timestamp,
  updatedAt: timestamp
};

const managementPolicyV2: ManagementPolicy = {
  ...managementPolicy,
  version: 2,
  instructions: "旧版证据派单策略。"
};

const supervisorWorkflow: SupervisorWorkflow = {
  id: "review-supervisor",
  version: 1,
  status: "active",
  architecture: "supervisor",
  description: "动态组织评审成员。",
  supervisor: { employeeId: "team-manager", employeeVersion: 1 },
  orchestrationSkill: { id: "team-orchestration", version: 1 },
  managementPolicy: { id: managementPolicy.id, version: 2 },
  members: [
    { roleId: "researcher", description: "收集证据", employeeId: "mihuhu-frontend-engineer", employeeVersion: 1 },
    { roleId: "reviewer", description: "独立审查", employeeId: "xiaomixiang-tester", employeeVersion: 1 }
  ],
  flow: {
    version: 1,
    stages: [
      { id: "plan", kind: "supervisor", title: "计划" },
      { id: "delegation-loop", kind: "delegation-loop", title: "动态分工" },
      { id: "delivery", kind: "delivery", title: "交付" }
    ],
    gates: []
  },
  createdAt: timestamp,
  updatedAt: timestamp
};

const entrancePolicy: EntrancePolicy = {
  id: "default-task-entrance",
  version: 2,
  status: "active",
  displayName: "默认请求分流策略",
  description: "按结构化信号选择专家或领队。",
  direct: { mode: "employee", employeeId: "xiaomixiang-tester", employeeVersion: 1 },
  specialists: {
    frontend: {
      kind: "project-role",
      projectId: "local-agent-workbench",
      projectVersion: 4,
      projectBindingVersion: 5,
      roleId: "frontend-developer",
      employeeId: "mihuhu-frontend-engineer",
      employeeVersion: 1
    },
    reviewer: { kind: "employee", employeeId: "xiaomixiang-tester", employeeVersion: 1 },
    graph: { kind: "graph-workflow", workflowId: workflow.id, workflowVersion: workflow.version }
  },
  leader: { kind: "supervisor-workflow", workflowId: supervisorWorkflow.id, workflowVersion: 1 },
  rules: [{
    id: "multi-role",
    when: { signals: { requiredRoleCount: { gte: 2 } } },
    result: { route: "leader" }
  }],
  default: { route: "direct" },
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
    if (url === `/api/management-policies/${managementPolicy.id}`) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: { policy: managementPolicy, versions: [managementPolicy, managementPolicyV2] } })
      });
    }
    if (url === `/api/entrance-policies/${entrancePolicy.id}/evaluate`) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: {
          policyId: entrancePolicy.id,
          policyVersion: entrancePolicy.version,
          result: { route: "direct" },
          decidedBy: "default",
          target: { kind: "caller" },
          executable: false,
          warnings: ["direct caller route returns control without creating an Invocation or Run"]
        } })
      });
    }
    if (url === `/api/entrance-policies/${entrancePolicy.id}` && _init?.method === "PATCH") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: entrancePolicy })
      });
    }
    if (url === `/api/entrance-policies/${entrancePolicy.id}`) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: { policy: entrancePolicy, versions: [entrancePolicy] } })
      });
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
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) { this.setAttribute("open", ""); }
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) { this.removeAttribute("open"); }
    });
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
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
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

  it("separates request routing, Graph, Supervisor, and the Management Policy resource registry", async () => {
    const manager = employee("team-manager", "领队员工");
    act(() => root.render(<WorkflowPage data={bootstrapWith({
      employees: [manager, employee("mihuhu-frontend-engineer", "米糊糊 · 前端"), employee("xiaomixiang-tester", "小米象 · 测试")],
      managementPolicies: [managementPolicy],
      entrancePolicies: [entrancePolicy],
      workflows: [workflow, supervisorWorkflow]
    })} refresh={refresh} notify={notify} />));
    await flush();

    const supervisorTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".orchestration-switcher button"))
      .find((button) => button.textContent?.includes("协作编排"));
    if (!supervisorTab) throw new Error("Supervisor tab not found");
    click(supervisorTab);
    await flush();
    expect(container.textContent).toContain("LEAD TEAM WORKFLOW RECORD");
    expect(container.textContent).toContain("固定 v2 · 最新 v3");
    expect(container.textContent).toContain("固定流程与动态分工");
    expect(container.textContent).toContain("领队生成计划");
    expect(container.textContent).toContain("动态分工");
    expect(container.textContent).toContain("team-orchestration");
    expect(container.textContent).toContain("researcher");

    const editSupervisor = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("修订团队"));
    if (!editSupervisor) throw new Error("Supervisor edit button not found");
    click(editSupervisor);
    await flush();
    expect(container.querySelector<HTMLButtonElement>('[aria-label="选择管理策略固定版本"]')?.textContent).toContain("v2 · 历史");
    expect(container.textContent).toContain("升级会按新版本角色槽重建成员清册");
    expect(container.textContent).toContain("固定流程与交付门禁");
    expect(container.textContent).toContain("添加能力门禁");
    expect(container.querySelector("select")).toBeNull();
    const dagSwitch = container.querySelector<HTMLInputElement>('[role="switch"][aria-label="启用 DAG 编排"]');
    expect(dagSwitch?.checked).toBe(false);
    expect(container.querySelector(".dag-enable-switch .switch-state-label")?.textContent).toBe("未启用");
    if (!dagSwitch) throw new Error("DAG switch not found");
    click(dagSwitch);
    expect(dagSwitch.checked).toBe(true);
    expect(container.querySelector(".dag-enable-switch .switch-state-label")?.textContent).toBe("已启用");
    const closeModal = container.querySelector<HTMLButtonElement>('[aria-label="关闭弹窗"]');
    if (closeModal) click(closeModal);

    const policyTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".orchestration-switcher button"))
      .find((button) => button.textContent?.includes("管理策略库"));
    if (!policyTab) throw new Error("Policy tab not found");
    click(policyTab);
    await flush();
    expect(container.textContent).toContain("MANAGEMENT POLICY RECORD");
    expect(container.textContent).toContain("资源 · 不是 Architecture");
    expect(container.textContent).toContain("review-supervisor");

    const entranceTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".orchestration-switcher button"))
      .find((button) => button.textContent?.includes("开始一项工作"));
    if (!entranceTab) throw new Error("Entrance Policy tab not found");
    expect(container.querySelectorAll(".orchestration-switcher nav button")).toHaveLength(4);
    click(entranceTab);
    await flush();
    expect(container.textContent).toContain("REQUEST ROUTING POLICY RECORD");
    expect(container.textContent).toContain("讨论是默认状态");
    expect(container.textContent).toContain("继续讨论");
    expect(container.textContent).toContain("交给一位员工");
    expect(container.textContent).toContain("开始协作编排");
    expect(container.querySelector(".entrance-advanced")).not.toBeNull();
    expect(container.querySelector(".entrance-target-cards")).not.toBeNull();

    const employeeIntent = Array.from(container.querySelectorAll<HTMLButtonElement>(".work-intent-grid button"))
      .find((button) => button.textContent?.includes("交给一位员工"));
    if (!employeeIntent) throw new Error("Single Employee intent not found");
    click(employeeIntent);
    const evaluateButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("预览工作去向"));
    if (!evaluateButton) throw new Error("Evaluate Entrance Policy button not found");
    click(evaluateButton);
    await flush();
    const evaluationCall = fetchMock.mock.calls.find(([input]) => String(input) === `/api/entrance-policies/${entrancePolicy.id}/evaluate`);
    expect(evaluationCall?.[1]?.method).toBe("POST");
    const evaluationBody = JSON.parse(String(evaluationCall?.[1]?.body)) as Record<string, unknown>;
    expect(evaluationBody).toMatchObject({ route: "specialist", specialistKey: "frontend", tags: [], signals: {}, source: { kind: "workbench" } });
    expect(evaluationBody).not.toHaveProperty("message");
    expect(container.textContent).toContain("不会创建内部工单或运行，也不会静默升级给领队");

    const editRouting = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("修订分流策略"));
    if (!editRouting) throw new Error("Request routing edit button not found");
    click(editRouting);
    await flush();
    expect(container.querySelector(".entrance-identity-grid")).not.toBeNull();
    expect(container.querySelectorAll(".entrance-specialist-editor article")).toHaveLength(3);
    expect(container.querySelectorAll(".entrance-rule-editor article")).toHaveLength(1);

    const whenEditor = container.querySelector<HTMLTextAreaElement>(".entrance-rule-editor textarea");
    if (!whenEditor) throw new Error("Rule condition editor not found");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(whenEditor, "{");
      whenEditor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(whenEditor.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector<HTMLButtonElement>(".editor-savebar .button.primary")?.disabled).toBe(true);
    expect(container.querySelector(".entrance-rule-editor [role='alert']")?.textContent).toContain("JSON");
  });

  it("keeps every unchanged request-routing target pinned in the editor payload", async () => {
    const manager = employee("team-manager", "领队员工");
    act(() => root.render(<WorkflowPage data={bootstrapWith({
      employees: [manager, employee("mihuhu-frontend-engineer", "米糊糊 · 前端"), employee("xiaomixiang-tester", "小米象 · 测试")],
      managementPolicies: [managementPolicy],
      entrancePolicies: [entrancePolicy],
      workflows: [workflow, supervisorWorkflow]
    })} refresh={refresh} notify={notify} />));
    await flush();

    const entranceTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".orchestration-switcher button"))
      .find((button) => button.textContent?.includes("开始一项工作"));
    if (!entranceTab) throw new Error("Request Routing tab not found");
    click(entranceTab);
    await flush();
    const editRouting = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("修订分流策略"));
    if (!editRouting) throw new Error("Request routing edit button not found");
    click(editRouting);
    await flush();

    const save = container.querySelector<HTMLButtonElement>(".editor-savebar .button.primary");
    if (!save) throw new Error("Request routing save button not found");
    expect(save.disabled).toBe(false);
    const form = save.closest("form");
    if (!form) throw new Error("Request routing editor form not found");
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await flush();

    const patchCall = fetchMock.mock.calls.find(([input, init]) => String(input) === `/api/entrance-policies/${entrancePolicy.id}` && init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(String(patchCall?.[1]?.body)) as {
      direct: Record<string, unknown>;
      specialists: Record<string, Record<string, unknown>>;
      leader: Record<string, unknown>;
    };
    expect(body.direct).toMatchObject({ mode: "employee", employeeId: "xiaomixiang-tester", employeeVersion: 1 });
    expect(body.specialists.frontend).toMatchObject({ kind: "project-role", projectId: "local-agent-workbench", roleId: "frontend-developer", projectVersion: 4, projectBindingVersion: 5 });
    expect(body.specialists.reviewer).toMatchObject({ kind: "employee", employeeId: "xiaomixiang-tester", employeeVersion: 1 });
    expect(body.specialists.graph).toMatchObject({ kind: "graph-workflow", workflowId: workflow.id, workflowVersion: workflow.version });
    expect(body.leader).toMatchObject({ workflowId: supervisorWorkflow.id, workflowVersion: supervisorWorkflow.version });
  });
});
