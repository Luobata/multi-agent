/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupervisorWorkflowPage } from "./SupervisorWorkflowPage";
import type { Bootstrap, Employee, ManagementPolicy, SupervisorWorkflow } from "./types";

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
  updatePolicy: "latest",
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

const policyRejection = "supervisor member role member-3 is not allowed by management policy review-policy v2";

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function ok(data: unknown): MockResponse {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

describe("SupervisorWorkflowPage editor", () => {
  let container: HTMLElement;
  let root: Root;
  let notify: ReturnType<typeof vi.fn>;
  let refresh: ReturnType<typeof vi.fn>;
  let patchBehavior: "success" | "reject";

  const fetchMock = vi.fn((input: unknown, init?: RequestInit): Promise<MockResponse> => {
    const url = String(input);
    if (url === `/api/workflows/${supervisorWorkflow.id}` && init?.method === "PATCH") {
      if (patchBehavior === "reject") {
        return Promise.resolve({ ok: false, status: 422, json: async () => ({ error: { message: policyRejection } }) });
      }
      return Promise.resolve(ok({ ...supervisorWorkflow, version: supervisorWorkflow.version + 1 }));
    }
    if (url === `/api/workflows/${supervisorWorkflow.id}`) {
      return Promise.resolve(ok({ versions: [supervisorWorkflow] }));
    }
    if (url === `/api/management-policies/${managementPolicy.id}`) {
      return Promise.resolve(ok({ policy: managementPolicy, versions: [managementPolicy, managementPolicyV2] }));
    }
    return Promise.resolve(ok({}));
  });

  const flush = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const click = (element: Element) => {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  };
  const typeInto = (input: HTMLInputElement, value: string) => {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const dialog = (): HTMLElement => {
    const element = container.querySelector<HTMLElement>("dialog");
    if (!element) throw new Error("编辑弹窗未打开");
    return element;
  };
  const openEditor = async () => {
    const editButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("修订团队"));
    if (!editButton) throw new Error("修订团队按钮未找到");
    click(editButton);
    await flush(); // 等待管理策略版本清册加载，固定版本的角色槽校验才可用
  };
  const memberArticles = () => Array.from(dialog().querySelectorAll<HTMLElement>(".supervisor-member-editor article"));
  const descriptionInput = (index: number): HTMLInputElement => {
    // 角色槽已改为选择框，成员条目里唯一的 <input> 是职责字段。
    const input = memberArticles()[index]?.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error(`成员 ${index + 1} 的职责输入框未找到`);
    return input;
  };
  const roleTrigger = (index: number): HTMLButtonElement => {
    const trigger = memberArticles()[index]?.querySelector<HTMLButtonElement>(`[aria-label="选择成员 ${index + 1} 的角色槽"]`);
    if (!trigger) throw new Error(`成员 ${index + 1} 的角色槽选择器未找到`);
    return trigger;
  };
  const roleOptionLabels = (index: number): string[] => {
    click(roleTrigger(index));
    const listId = roleTrigger(index).getAttribute("aria-controls");
    const listbox = listId ? document.getElementById(listId) : null;
    return Array.from(listbox?.querySelectorAll<HTMLElement>(".select-option strong") ?? []).map((element) => element.textContent ?? "");
  };
  const addRoleButton = (): HTMLButtonElement | undefined => Array.from(dialog().querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.includes("添加角色槽"));
  const saveButton = (): HTMLButtonElement => {
    const button = dialog().querySelector<HTMLButtonElement>(".editor-savebar .button.primary");
    if (!button) throw new Error("保存按钮未找到");
    return button;
  };
  const submitForm = () => {
    const form = dialog().querySelector("form");
    if (!form) throw new Error("编辑表单未找到");
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  };
  const writeCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH" || init?.method === "POST");

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
    notify = vi.fn();
    refresh = vi.fn(async () => undefined);
    patchBehavior = "success";
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const data: Bootstrap = {
      providers: [{ id: "mock", definition: { adapter: "mock", model: "deterministic-mock" } }],
      skills: [],
      knowledgeBases: [],
      knowledgeProfiles: [],
      architectureTemplates: [],
      employees: [
        employee("team-manager", "领队员工"),
        employee("mihuhu-frontend-engineer", "米糊糊 · 前端"),
        employee("xiaomixiang-tester", "小米象 · 测试")
      ],
      workflows: [supervisorWorkflow],
      sessions: [],
      publications: [],
      projects: [],
      projectBindings: [],
      managementPolicies: [managementPolicy],
      activity: { invocations: [], instances: [] }
    };
    act(() => root.render(<SupervisorWorkflowPage data={data} refresh={refresh} notify={notify} />));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    vi.unstubAllGlobals();
  });

  it("keeps focus in the member description input while typing multiple characters", async () => {
    await openEditor();
    const input = descriptionInput(0);
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    for (const char of ["x", "y", "z"]) {
      typeInto(input, input.value + char);
      expect(document.activeElement).toBe(input);
    }
    // 同一个 DOM 节点贯穿多次编辑，说明列表 key 不随可编辑字段变化。
    expect(descriptionInput(0)).toBe(input);
  });

  it("constrains the member role slot to policy-allowed, not-yet-used roles", async () => {
    await openEditor();
    // 第一个成员当前是 researcher；可选项应含自身，且不含已被第二个成员占用的 reviewer。
    const first = roleOptionLabels(0);
    expect(first).toContain("researcher");
    expect(first).not.toContain("reviewer");
    // 自由文本已不存在——成员条目内唯一的 input 是职责字段而非角色槽。
    expect(memberArticles()[0]?.querySelectorAll("input")).toHaveLength(1);
    // 两个成员用尽了策略声明的两个角色槽，添加按钮禁用。
    expect(addRoleButton()?.disabled).toBe(true);
  });

  it("surfaces server policy rejection inside the modal above the save bar", async () => {
    patchBehavior = "reject";
    await openEditor();
    expect(saveButton().disabled).toBe(false);
    submitForm();
    await flush();
    await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });

    const error = dialog().querySelector<HTMLElement>(".editor-submit-error");
    expect(error).not.toBeNull();
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.tabIndex).toBe(-1);
    // 中文摘要 + 原始服务端信息同时可读。
    expect(error?.textContent).toContain("成员角色槽 member-3 未被管理策略 review-policy v2 允许");
    expect(error?.textContent).toContain(policyRejection);
    // 位于固定保存栏上方，并接过焦点便于键盘与读屏用户定位。
    expect(error?.nextElementSibling?.classList.contains("editor-savebar")).toBe(true);
    expect(document.activeElement).toBe(error);
    // 错误只在弹窗内呈现，不再透传到底层页面的全局通知。
    expect(notify).not.toHaveBeenCalled();
    // 弹窗保持打开，允许就地修正。
    expect(saveButton().disabled).toBe(false);

    const patchCall = writeCalls().find(([input]) => String(input) === `/api/workflows/${supervisorWorkflow.id}`);
    expect(patchCall).toBeDefined();
  });

  it("saves normally when every member role is allowed by the pinned policy", async () => {
    await openEditor();
    typeInto(descriptionInput(0), "收集并核对证据");
    submitForm();
    await flush();

    const patchCall = writeCalls().find(([input]) => String(input) === `/api/workflows/${supervisorWorkflow.id}`);
    expect(patchCall).toBeDefined();
    const body = JSON.parse(String(patchCall?.[1]?.body)) as { members: Array<{ roleId: string }>; managementPolicy: { id: string; version: number } };
    expect(body.managementPolicy).toEqual({ id: "review-policy", version: 2 });
    expect(body.members.map((member) => member.roleId)).toEqual(["researcher", "reviewer"]);
    expect(notify).toHaveBeenCalledWith("领队团队已另存为 v2");
    expect(refresh).toHaveBeenCalled();
    expect(container.querySelector(".editor-submit-error")).toBeNull();
    // 保存成功后弹窗关闭。
    expect(container.querySelector("dialog")).toBeNull();
  });
});
