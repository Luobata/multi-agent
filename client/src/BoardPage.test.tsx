/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardPage, ConversationMessageContent, normalizeConversationLineBreaks, requirementStewardOutput } from "./BoardPage";
import { createDashboardService } from "./dashboard/service";
import type { HumanDecisionRequest, InvocationRecord, Project, RunMergePreview, Session } from "./types";

function connectedProject(): Project {
  return {
    id: "connected-a",
    version: 1,
    status: "active",
    name: "真实项目 A",
    description: "board test",
    scope: "repository",
    rootPath: "/workspace/connected-a",
    descriptorPath: "/workspace/connected-a/multi-agent.project.yaml",
    connector: { kind: "repository-development", config: {} },
    roles: [{ id: "requirement-steward", displayName: "需求管家", description: "draft", instructions: "Draft only.", requiredSkills: [], optionalSkills: [], knowledgeProfileIds: [], permissions: { write: "none", tools: [] } }],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z"
  };
}

function connectedProjectB(): Project {
  return { ...connectedProject(), id: "connected-b", name: "真实项目 B", rootPath: "/workspace/connected-b", descriptorPath: "/workspace/connected-b/multi-agent.project.yaml" };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  return found;
}

function setText(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

async function chooseSelect(ariaLabel: string, optionLabel: string): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${ariaLabel}"]`);
  if (!trigger) throw new Error(`select not found: ${ariaLabel}`);
  await act(async () => { trigger.click(); });
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((item) => item.textContent?.includes(optionLabel));
  if (!option) throw new Error(`option not found: ${optionLabel}`);
  await act(async () => { option.click(); });
}

describe("requirementStewardOutput", () => {
  it("accepts the strict requirement draft and rejects malformed provider output", () => {
    expect(requirementStewardOutput({
      message: "已整理",
      nextAction: "draft",
      draft: { title: "标题", summary: "摘要", priority: "high", rawRequirement: "改写", acceptanceCriteria: ["可验收"] }
    })).toMatchObject({ draft: { title: "标题", priority: "high" } });
    expect(requirementStewardOutput({ message: "missing action" })).toBeUndefined();
  });
});

describe("ConversationMessageContent", () => {
  it("decodes line breaks and safely renders paragraphs, lists and bold text", () => {
    const html = renderToStaticMarkup(<ConversationMessageContent content={'第一段\\n\\n**重点**\\n1) 第一步\\n2. 第二步\\n- 条目<script>alert("x")</script>'} />);
    expect(normalizeConversationLineBreaks("a\\n\\nb")).toBe("a\n\nb");
    expect(html).toContain("board-ai-message-spacer");
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<ol><li>第一步</li><li>第二步</li></ol>");
    expect(html).toContain("<ul><li>条目&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</li></ul>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("\\n");
  });
});

describe("BoardPage AI requirement creation", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

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
    const session: Session = {
      id: "session-requirement-1",
      employeeId: "xiaomiwang-product-manager",
      employeeVersion: 1,
      assignment: { projectId: "connected-a", projectVersion: 1, projectBindingVersion: 1, roleId: "requirement-steward" },
      title: "首条真实需求",
      status: "active",
      messages: [
        { id: "m1", role: "user", content: "购物车空态增加优惠推荐", at: "2026-08-09T00:00:00.000Z" },
        { id: "m2", role: "employee", content: "我已整理成草稿，请确认。", at: "2026-08-09T00:00:01.000Z" }
      ],
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:01.000Z"
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          session,
          runId: "run-requirement-1",
          status: "passed",
          message: "我已整理成草稿，请确认。",
          output: {
            message: "我已整理成草稿，请确认。",
            nextAction: "draft",
            draft: {
              title: "购物车空态优惠推荐",
              summary: "为空购物车提供优惠推荐",
              priority: "high",
              rawRequirement: "Agent 不应覆盖成这句",
              acceptanceCriteria: ["空态可以看到推荐", "点击可进入商品详情"]
            }
          }
        }
      })
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("snapshots the current board project independently whenever either creation entry opens", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    service.syncConnectedProjects([connectedProject(), connectedProjectB()]);
    act(() => root.render(<BoardPage go={vi.fn()} notify={vi.fn()} service={service} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    await chooseSelect("筛选项目", "真实项目 B");
    await act(async () => { button("手动创建").click(); });
    expect(document.querySelector('[aria-label="需求所属项目"]')?.textContent).toContain("真实项目 B");
    await act(async () => { button("取消").click(); });
    await chooseSelect("筛选项目", "真实项目 A");
    await act(async () => { button("手动创建").click(); });
    expect(document.querySelector('[aria-label="需求所属项目"]')?.textContent).toContain("真实项目 A");
    await act(async () => { button("取消").click(); });

    await chooseSelect("筛选项目", "真实项目 B");
    await act(async () => { button("和 AI 说需求").click(); });
    expect(document.querySelector('[aria-label="AI 需求所属项目"]')?.textContent).toContain("真实项目 B");
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="描述需求"]')!;
    act(() => setText(textarea, "项目 B 的需求"));
    await act(async () => { button("交给需求管家").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/projects/connected-b/");
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("x-multi-agent-project")).toBe("connected-b");
  });

  it("disables AI requirement creation when the declared requirement-steward role has no current binding", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    const project = connectedProject();
    service.syncConnectedProjects([project]);
    act(() => root.render(<BoardPage go={vi.fn()} notify={vi.fn()} service={service} projects={[project]} projectBindings={[]} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(button("手动创建").disabled).toBe(false);
    expect(button("和 AI 说需求").disabled).toBe(true);
    expect(button("和 AI 说需求").title).toContain("完成角色任用");
    expect(container.querySelector("#board-action-guidance")?.textContent).toContain("AI 需求入口需要项目声明 requirement-steward 角色");
    expect(button("和 AI 说需求").getAttribute("aria-describedby")).toBe("board-action-guidance");
  });

  it("does not borrow another project's steward readiness on a project-scoped board", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    const projectA = connectedProject();
    const projectB = connectedProjectB();
    service.syncConnectedProjects([projectA, projectB]);
    act(() => root.render(<BoardPage
      spaceId={projectA.id}
      go={vi.fn()}
      notify={vi.fn()}
      service={service}
      projects={[projectA, projectB]}
      projectBindings={[{
        projectId: projectB.id,
        projectVersion: projectB.version,
        version: 1,
        roles: [{
          roleId: "requirement-steward",
          employeeId: "xiaomiwang-product-manager",
          employeeVersion: 1,
          skills: [],
          skillVersions: {},
          updatePolicy: "locked"
        }],
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z"
      }]}
    />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(button("和 AI 说需求").disabled).toBe(true);
    expect(container.querySelector("#board-action-guidance")?.textContent).toContain("完成员工分派");
  });

  it("requires an explicit project in aggregate mode and restores both entries after selection", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    service.syncConnectedProjects([connectedProject(), connectedProjectB()]);
    const createSpy = vi.spyOn(service, "createRequirement");
    act(() => root.render(<BoardPage go={vi.fn()} notify={vi.fn()} service={service} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    await act(async () => { button("手动创建").click(); });
    const projectSelect = document.querySelector<HTMLButtonElement>('[aria-label="需求所属项目"]')!;
    expect(projectSelect.textContent).toContain("请选择所属项目");
    expect(container.textContent).toContain("请先选择需求所属项目");
    expect(button("创建并进入收件箱").disabled).toBe(true);
    await act(async () => { projectSelect.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(projectSelect.getAttribute("aria-invalid")).toBe("true");
    expect(projectSelect.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.activeElement).toBe(projectSelect);
    expect(container.textContent).toContain("请选择需求所属项目后再创建。");
    expect(createSpy).not.toHaveBeenCalled();
    await chooseSelect("需求所属项目", "真实项目 B");
    expect(button("创建并进入收件箱").disabled).toBe(false);
    await act(async () => { button("取消").click(); button("和 AI 说需求").click(); });

    const agentSelect = document.querySelector<HTMLButtonElement>('[aria-label="AI 需求所属项目"]')!;
    expect(agentSelect.textContent).toContain("请选择所属项目");
    expect(container.textContent).toContain("请先选择归属项目，再向需求管家描述需求。");
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="描述需求"]')?.disabled).toBe(true);
    expect(button("确认创建并进入收件箱").disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await chooseSelect("AI 需求所属项目", "真实项目 B");
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="描述需求"]')?.disabled).toBe(false);
  });

  it("uses manual and AI project overrides and clears an AI draft when its project changes", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    service.syncConnectedProjects([connectedProject(), connectedProjectB()]);
    const createSpy = vi.spyOn(service, "createRequirement");
    act(() => root.render(<BoardPage go={vi.fn()} notify={vi.fn()} service={service} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await chooseSelect("筛选项目", "真实项目 B");
    await act(async () => { button("手动创建").click(); });
    await chooseSelect("需求所属项目", "真实项目 A");
    const inputs = [...document.querySelectorAll<HTMLInputElement>("dialog input")];
    act(() => { setText(inputs[0]!, "手动需求"); setText(document.querySelector<HTMLTextAreaElement>("dialog textarea")!, "原始需求"); });
    await act(async () => { button("创建并进入收件箱").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(createSpy).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "connected-a" }));

    await act(async () => { button("和 AI 说需求").click(); });
    const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="描述需求"]')!;
    act(() => setText(composer, "AI 需求"));
    await act(async () => { button("交给需求管家").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector(".board-ai-draft-fields")).toBeTruthy();
    await chooseSelect("AI 需求所属项目", "真实项目 A");
    expect(container.querySelector(".board-ai-draft-fields")).toBeNull();
    expect(container.textContent).not.toContain("我已整理成草稿，请确认。");
    act(() => setText(composer, "切换后的 AI 需求"));
    await act(async () => { button("交给需求管家").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("/api/projects/connected-a/");
    await act(async () => { button("确认创建并进入收件箱").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(createSpy).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "connected-a" }));
  });

  it("keeps the board unchanged until the user confirms the editable Agent draft", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", now: () => new Date("2026-08-09T01:00:00.000Z") });
    service.syncConnectedProjects([connectedProject()]);
    act(() => root.render(<BoardPage spaceId="connected-a" go={vi.fn()} notify={vi.fn()} service={service} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(button("和 AI 说需求").disabled).toBe(false);
    await act(async () => {
      button("和 AI 说需求").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const agentDialog = document.querySelector("dialog.board-ai-modal");
    expect(agentDialog).toBeInstanceOf(HTMLDialogElement);
    expect(agentDialog?.querySelector(".board-ai-layout")).toBeTruthy();
    expect(agentDialog?.querySelector(".board-ai-draft-fields")).toBeNull();
    expect(agentDialog?.querySelector(".board-ai-confirm")).toBeTruthy();
    const textarea = document.querySelector('textarea[aria-label="描述需求"]');
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    act(() => setText(textarea as HTMLTextAreaElement, "购物车空态增加优惠推荐"));
    await act(async () => {
      button("交给需求管家").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/conversations/requirement-steward/invoke");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      message: "购物车空态增加优惠推荐"
    });
    expect(await service.listBoard()).toEqual([]);
    expect((document.querySelector('input[value="购物车空态优惠推荐"]') as HTMLInputElement | null)?.value).toBe("购物车空态优惠推荐");
    expect(agentDialog?.querySelector(".board-ai-draft-fields")).toBeTruthy();
    expect(agentDialog?.querySelector(".board-ai-confirm button")?.textContent).toContain("确认创建");
    const raw = [...document.querySelectorAll("textarea")].find((candidate) => candidate.value === "购物车空态增加优惠推荐");
    expect(raw).toBeTruthy();

    await act(async () => {
      button("确认创建并进入收件箱").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(await service.listBoard()).toEqual([
      expect.objectContaining({
        lane: "inbox",
        title: "购物车空态优惠推荐"
      })
    ]);
    const [created] = await service.listBoard();
    expect(await service.getRequirement(created!.id)).toMatchObject({ rawRequirement: "购物车空态增加优惠推荐" });
  });

  it("shows an animated waiting bubble only while the steward request is pending", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    service.syncConnectedProjects([connectedProject()]);
    let resolveRequest!: (value: unknown) => void;
    fetchMock.mockReset().mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    act(() => root.render(<BoardPage spaceId="connected-a" go={vi.fn()} notify={vi.fn()} service={service} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    act(() => button("和 AI 说需求").click());
    const textarea = document.querySelector('textarea[aria-label="描述需求"]') as HTMLTextAreaElement;
    act(() => setText(textarea, "等待中的需求"));
    act(() => button("交给需求管家").click());

    expect(document.querySelector('[aria-label="需求管家整理中"]')).toBeTruthy();
    expect(document.querySelector(".composer-loading")).toBeTruthy();
    expect(textarea.disabled).toBe(true);

    await act(async () => {
      resolveRequest({ ok: false, status: 500, json: async () => ({ error: "失败" }) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[aria-label="需求管家整理中"]')).toBeNull();
    expect(document.querySelector(".composer-loading")).toBeNull();
    expect(textarea.value).toBe("等待中的需求");
  });

  it("keeps an unclear requirement in the same session until the user answers the Agent question", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", now: () => new Date("2026-08-09T01:00:00.000Z") });
    service.syncConnectedProjects([connectedProject()]);
    const sessionBase = {
      id: "session-clarify-1",
      employeeId: "xiaomiwang-product-manager",
      employeeVersion: 1,
      assignment: { projectId: "connected-a", projectVersion: 1, projectBindingVersion: 1, roleId: "requirement-steward" },
      title: "做个推荐",
      status: "active" as const,
      createdAt: "2026-08-09T00:00:00.000Z"
    };
    fetchMock.mockReset()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: {
          session: {
            ...sessionBase,
            messages: [
              { id: "c1", role: "user", content: "做个推荐", at: "2026-08-09T00:00:00.000Z" },
              { id: "c2", role: "employee", content: "推荐出现在哪个页面？", at: "2026-08-09T00:00:01.000Z" }
            ],
            updatedAt: "2026-08-09T00:00:01.000Z"
          },
          runId: "run-clarify-1",
          status: "passed",
          message: "推荐出现在哪个页面？",
          output: { message: "推荐出现在哪个页面？", nextAction: "clarify", draft: null }
        } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: {
          session: {
            ...sessionBase,
            messages: [
              { id: "c1", role: "user", content: "做个推荐", at: "2026-08-09T00:00:00.000Z" },
              { id: "c2", role: "employee", content: "推荐出现在哪个页面？", at: "2026-08-09T00:00:01.000Z" },
              { id: "c3", role: "user", content: "购物车空态", at: "2026-08-09T00:00:02.000Z" },
              { id: "c4", role: "employee", content: "已经可以形成草稿。", at: "2026-08-09T00:00:03.000Z" }
            ],
            updatedAt: "2026-08-09T00:00:03.000Z"
          },
          runId: "run-clarify-2",
          status: "passed",
          message: "已经可以形成草稿。",
          output: {
            message: "已经可以形成草稿。",
            nextAction: "draft",
            draft: {
              title: "购物车空态推荐",
              summary: "空购物车展示推荐",
              priority: "medium",
              rawRequirement: "Agent rewrite",
              acceptanceCriteria: ["空态显示推荐"]
            }
          }
        } })
      });

    act(() => root.render(<BoardPage spaceId="connected-a" go={vi.fn()} notify={vi.fn()} service={service} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { button("和 AI 说需求").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const textarea = document.querySelector('textarea[aria-label="描述需求"]') as HTMLTextAreaElement;
    act(() => setText(textarea, "做个推荐"));
    await act(async () => { button("交给需求管家").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(container.textContent).toContain("需要你补充一点");
    expect(container.textContent).toContain("推荐出现在哪个页面？");
    expect(button("确认创建并进入收件箱").disabled).toBe(true);
    expect(await service.listBoard()).toEqual([]);

    const followupTextarea = document.querySelector('textarea[aria-label="描述需求"]') as HTMLTextAreaElement;
    act(() => setText(followupTextarea, "购物车空态"));
    await act(async () => { button("继续说明").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toMatchObject({
      message: "购物车空态",
      sessionId: "session-clarify-1"
    });
    expect((document.querySelector('input[value="购物车空态推荐"]') as HTMLInputElement | null)?.value).toBe("购物车空态推荐");
    const raw = [...document.querySelectorAll("textarea")].find((candidate) => candidate.value === "做个推荐\n\n购物车空态");
    expect(raw).toBeTruthy();
    expect(await service.listBoard()).toEqual([]);
  });

  it("turns a waiting confirmation card into a direct human-decision action", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", now: () => new Date("2026-08-10T03:00:00.000Z") });
    service.syncConnectedProjects([connectedProject()]);
    const requirement = await service.createRequirement({
      projectId: "connected-a",
      title: "安装浏览器依赖前确认",
      summary: "Agent 需要人工批准高风险操作",
      priority: "high",
      rawRequirement: "运行端到端测试",
      acceptanceCriteria: ["人工决定后继续同一个 Run"]
    });
    const config = { entrancePolicyId: "default-task-entrance-policy", autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await service.reserveRequirementAdvancement(requirement.id, config, "human");
    await service.syncRequirementAdvancement(requirement.id, reserved.idempotencyKey, {
      invocationId: "inv-confirmation",
      runId: "run-confirmation",
      status: "awaiting-human-decision",
      observedAt: "2026-08-10T03:00:01.000Z"
    }, config.pollIntervalMs);
    const go = vi.fn();
    const onOpenRun = vi.fn();
    const humanDecisionBase: Omit<HumanDecisionRequest, "id" | "idempotencyKey" | "round" | "status" | "createdAt" | "updatedAt"> = {
      invocationId: "inv-confirmation",
      runId: "run-confirmation",
      workflowId: "team-flow",
      workflowVersion: 1,
      supervisorNodeId: "supervisor-r2",
      riskCategory: "irreversible-other",
      summary: "需要再次确认测试环境已经恢复",
      proposedAction: { assignments: [] }
    };
    const humanDecisionRequests: HumanDecisionRequest[] = [
      {
        ...humanDecisionBase,
        id: "decision-approved",
        idempotencyKey: "decision:approved",
        round: 1,
        status: "approved",
        createdAt: "2026-08-10T03:00:00.000Z",
        updatedAt: "2026-08-10T03:00:02.000Z",
        decidedAt: "2026-08-10T03:00:02.000Z"
      },
      {
        ...humanDecisionBase,
        id: "decision-pending",
        idempotencyKey: "decision:pending",
        round: 2,
        status: "pending",
        createdAt: "2026-08-10T03:01:00.000Z",
        updatedAt: "2026-08-10T03:01:00.000Z"
      }
    ];

    act(() => root.render(<BoardPage
      spaceId="connected-a"
      go={go}
      notify={vi.fn()}
      service={service}
      humanDecisionRequests={humanDecisionRequests}
      onOpenRun={onOpenRun}
    />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(container.textContent).toContain("新的确认请求");
    expect(container.textContent).toContain("上一项决定已生效；Run 在第 2 轮暂停");
    await act(async () => { button("处理待确认").click(); });
    expect(onOpenRun).toHaveBeenCalledWith("run-confirmation");
    expect(go).not.toHaveBeenCalled();

    const detailAction = container.querySelector<HTMLButtonElement>(`[aria-label="查看需求详情：${requirement.code} ${requirement.title}"]`);
    expect(detailAction).toBeTruthy();
    await act(async () => { detailAction?.click(); });
    expect(go).toHaveBeenCalledWith(`requirements/${requirement.id}`);
  });

  it("moves a confirmed requirement back to execution from durable Invocation activity", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", now: () => new Date("2026-08-10T03:00:00.000Z") });
    const project = connectedProject();
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "人工确认后恢复执行",
      summary: "批准后应离开待确认列",
      priority: "high",
      rawRequirement: "继续原 Run",
      acceptanceCriteria: ["批准事件到达后自动回到执行中"]
    });
    const config = { entrancePolicyId: "default-task-entrance-policy", autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await service.reserveRequirementAdvancement(requirement.id, config, "human");
    await service.syncRequirementAdvancement(requirement.id, reserved.idempotencyKey, {
      invocationId: "inv-confirmation",
      runId: "run-confirmation",
      status: "awaiting-human-decision",
      observedAt: "2026-08-10T03:00:01.000Z"
    }, config.pollIntervalMs);
    const resumed: InvocationRecord = {
      id: "inv-confirmation",
      target: { kind: "workflow", id: "team-flow", version: 1 },
      source: { kind: "workbench" },
      status: "running",
      phase: "resuming-after-human-approval",
      requestSummary: "人工确认后恢复执行",
      runId: "run-confirmation",
      instanceIds: [],
      createdAt: "2026-08-10T03:00:00.000Z",
      updatedAt: "2026-08-10T03:00:02.000Z",
      transitions: []
    };

    act(() => root.render(<BoardPage
      spaceId={project.id}
      go={vi.fn()}
      notify={vi.fn()}
      service={service}
      projects={[project]}
      invocations={[resumed]}
    />));
    for (let attempt = 0; attempt < 10 && !container.querySelector<HTMLElement>('section[aria-label^="执行中"]')?.textContent?.includes(requirement.title); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }

    const runningLane = container.querySelector<HTMLElement>('section[aria-label^="执行中"]');
    expect(runningLane?.textContent).toContain(requirement.title);
    expect(container.textContent).not.toContain("Run 已暂停，不会自行继续");
    expect((await service.getRequirement(requirement.id)).advancement?.status).toBe("running");
  });

  it("hides clarify and planned columns while keeping legacy cards visible in inbox", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    const project = connectedProject();
    service.syncConnectedProjects([project]);
    const clarify = await service.createRequirement({
      projectId: project.id,
      title: "旧待澄清需求",
      summary: "兼容旧数据",
      priority: "medium",
      rawRequirement: "旧数据不能消失",
      acceptanceCriteria: ["在收件箱可见"]
    });
    const planned = await service.createRequirement({
      projectId: project.id,
      title: "旧已规划需求",
      summary: "兼容旧数据",
      priority: "medium",
      rawRequirement: "旧数据不能消失",
      acceptanceCriteria: ["在收件箱可见"]
    });
    await service.updateRequirementLane(clarify.id, "clarify");
    await service.updateRequirementLane(planned.id, "planned");

    act(() => root.render(<BoardPage spaceId={project.id} go={vi.fn()} notify={vi.fn()} service={service} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(container.querySelector('section[aria-label^="待澄清"]')).toBeNull();
    expect(container.querySelector('section[aria-label^="已规划"]')).toBeNull();
    const inbox = container.querySelector<HTMLElement>('section[aria-label^="收件箱"]');
    expect(inbox?.textContent).toContain("旧待澄清需求");
    expect(inbox?.textContent).toContain("旧已规划需求");
  });

  it("renders board data before terminal reconciliation finishes", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    const project = connectedProject();
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "旧缓存中的执行态",
      summary: "真实 Run 已完成",
      priority: "high",
      rawRequirement: "首屏不得显示旧执行态",
      acceptanceCriteria: ["只在对账完成后显示"]
    });
    const config = { entrancePolicyId: "default-task-entrance-policy", autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await service.reserveRequirementAdvancement(requirement.id, config, "human");
    await service.syncRequirementAdvancement(requirement.id, reserved.idempotencyKey, {
      invocationId: "inv-gated",
      runId: "run-gated",
      status: "running",
      observedAt: "2026-08-12T01:00:00.000Z"
    }, config.pollIntervalMs);
    const completed: InvocationRecord = {
      id: "inv-gated",
      target: { kind: "workflow", id: "team-flow", version: 1 },
      source: { kind: "workbench", taskId: requirement.id },
      status: "completed",
      phase: "done",
      requestSummary: requirement.title,
      runId: "run-gated",
      instanceIds: [],
      createdAt: "2026-08-12T01:00:00.000Z",
      updatedAt: "2026-08-12T01:00:02.000Z",
      completedAt: "2026-08-12T01:00:02.000Z",
      transitions: []
    };
    let resolvePreview!: (value: unknown) => void;
    fetchMock.mockReset().mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));

    const go = vi.fn();
    const notify = vi.fn();
    const projects = [project];
    const invocations = [completed];
    act(() => root.render(<BoardPage spaceId={project.id} go={go} notify={notify} service={service} projects={projects} invocations={invocations} sourceReady={false} />));
    expect(container.querySelectorAll(".board-lane--loading")).toHaveLength(7);
    expect(container.textContent).not.toContain(requirement.title);
    expect(button("手动创建").disabled).toBe(true);
    expect(button("和 AI 说需求").disabled).toBe(true);

    act(() => root.render(<BoardPage spaceId={project.id} go={go} notify={notify} service={service} projects={projects} invocations={invocations} sourceReady />));
    for (let attempt = 0; attempt < 20 && fetchMock.mock.calls.length === 0; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(container.querySelectorAll(".board-lane--loading")).toHaveLength(0);
    expect(container.querySelector<HTMLButtonElement>(`button[aria-label="查看需求详情：${requirement.code} ${requirement.title}"]`)).not.toBeNull();
    expect(button("手动创建").disabled).toBe(false);

    const preview: RunMergePreview = {
      runId: "run-gated",
      status: "awaiting-acceptance",
      eligible: true,
      reasons: [],
      acceptanceReadiness: { ready: false, reasons: ["not a merged delivery"] },
      worktreePath: "/repo/.multi-agent/worktrees/run-gated",
      repositoryRoot: "/repo",
      targetBranch: "main",
      targetClean: true,
      changes: { files: [{ status: "M", path: "client/src/BoardPage.tsx" }], fileCount: 1, summary: "1 file", unifiedDiff: { text: "diff", truncated: false, maxBytes: 1024 } },
      safeGitCommands: [],
      evidence: { assets: [], structuredE2eCount: 1, acceptedVerdict: true, gates: [
        { gateId: "quality-test", required: true, status: "passed", requiredCapability: "quality.test", mode: "before-completion" },
        { gateId: "independent-review", required: true, status: "passed", requiredCapability: "quality.audit", mode: "before-completion" }
      ] },
      confirmationToken: "MERGE run-gated",
      discardConfirmationToken: "DISCARD run-gated"
    };
    await act(async () => {
      resolvePreview({ ok: true, status: 200, json: async () => ({ data: preview }) });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(container.querySelectorAll(".board-lane--loading")).toHaveLength(0);
    expect(container.querySelector<HTMLElement>('section[aria-label^="待验收"]')?.textContent).toContain(requirement.title);
    expect(button("手动创建").disabled).toBe(false);
  });

  it("automatically submits a completed eligible Run to acceptance", async () => {
    const service = createDashboardService({
      delayMs: () => 0,
      initialData: "empty",
      now: () => new Date("2026-08-10T04:00:00.000Z")
    });
    const project = connectedProject();
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "自动进入待验收",
      summary: "Run 完成后自动固定交付证据",
      priority: "high",
      rawRequirement: "测试和 Review 通过后无需再次手动提交",
      acceptanceCriteria: ["卡片自动进入待验收"]
    });
    const config = { entrancePolicyId: "default-task-entrance-policy", autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await service.reserveRequirementAdvancement(requirement.id, config, "human");
    await service.syncRequirementAdvancement(requirement.id, reserved.idempotencyKey, {
      invocationId: "inv-completed",
      runId: "run-completed",
      status: "running",
      observedAt: "2026-08-10T04:00:01.000Z"
    }, config.pollIntervalMs);
    const preview: RunMergePreview = {
      runId: "run-completed",
      status: "awaiting-acceptance",
      eligible: true,
      reasons: [],
      acceptanceReadiness: { ready: false, reasons: ["not a merged delivery"] },
      worktreePath: "/repo/.multi-agent/worktrees/run-completed",
      repositoryRoot: "/repo",
      targetBranch: "main",
      targetClean: true,
      changes: {
        files: [{ status: "M", path: "client/src/BoardPage.tsx" }],
        fileCount: 1,
        summary: "1 file changed",
        unifiedDiff: { text: "diff", truncated: false, maxBytes: 1024 }
      },
      safeGitCommands: [],
      evidence: {
        assets: [],
        structuredE2eCount: 1,
        acceptedVerdict: true,
        gates: [
          { gateId: "quality-test", required: true, status: "passed", requiredCapability: "quality.test", mode: "before-completion" },
          { gateId: "independent-review", required: true, status: "passed", requiredCapability: "quality.audit", mode: "before-completion" }
        ]
      },
      confirmationToken: "MERGE run-completed",
      discardConfirmationToken: "DISCARD run-completed"
    };
    fetchMock.mockImplementation((input: RequestInfo) => Promise.resolve({
      ok: String(input).endsWith("/api/runs/run-completed/merge-preview"),
      status: 200,
      json: async () => ({ data: preview })
    }));
    const completed: InvocationRecord = {
      id: "inv-completed",
      target: { kind: "workflow", id: "team-flow", version: 1 },
      source: { kind: "workbench", taskId: requirement.id },
      status: "completed",
      phase: "done",
      requestSummary: requirement.title,
      runId: "run-completed",
      instanceIds: [],
      createdAt: "2026-08-10T04:00:00.000Z",
      updatedAt: "2026-08-10T04:00:02.000Z",
      completedAt: "2026-08-10T04:00:02.000Z",
      transitions: []
    };

    act(() => root.render(<BoardPage
      spaceId={project.id}
      go={vi.fn()}
      notify={vi.fn()}
      service={service}
      projects={[project]}
      invocations={[completed]}
    />));
    for (let attempt = 0; attempt < 20 && (await service.getRequirement(requirement.id)).lane !== "acceptance"; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }

    const accepted = await service.getRequirement(requirement.id);
    expect(accepted.lane).toBe("acceptance");
    expect(accepted.evidence.acceptance).toMatchObject({
      runId: "run-completed",
      eligible: true,
      testGate: { gateId: "quality-test", status: "passed" },
      reviewGate: { gateId: "independent-review", status: "passed" }
    });
    expect(container.querySelector<HTMLElement>('section[aria-label^="待验收"]')?.textContent).toContain(requirement.title);
  });

  it("keeps the board readable when merged delivery reconciliation rejects a mismatched fixed Run", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    const project = connectedProject();
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "保留可读的需求卡",
      summary: "错误 Run 不得清空看板",
      priority: "high",
      rawRequirement: "验收 Run 与交付 Run 不一致",
      acceptanceCriteria: ["看板仍可读"]
    });
    const config = { entrancePolicyId: "default-task-entrance-policy", autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await service.reserveRequirementAdvancement(requirement.id, config, "human");
    await service.syncRequirementAdvancement(requirement.id, reserved.idempotencyKey, {
      invocationId: "inv-other",
      runId: "run-other",
      status: "completed",
      observedAt: "2026-08-12T02:00:02.000Z"
    }, config.pollIntervalMs);
    await service.submitRequirementForAcceptance(requirement.id, {
      runId: "run-accepted",
      eligible: true,
      worktreePath: "/repo/.multi-agent/worktrees/run-accepted",
      testGate: { gateId: "quality-test", status: "passed" },
      reviewGate: { gateId: "independent-review", status: "passed" },
      mediaCount: 0,
      structuredE2eCount: 1,
      diffFiles: ["client/src/BoardPage.tsx"],
      capturedAt: "2026-08-12T02:00:00.000Z"
    });
    await service.updateRequirementLane(requirement.id, "inbox");
    const preview: RunMergePreview = {
      runId: "run-other", status: "merged", eligible: true, reasons: [], acceptanceReadiness: { ready: false, reasons: ["legacy fixture"] },
      worktreePath: "/repo/.multi-agent/worktrees/run-other", repositoryRoot: "/repo", targetBranch: "main", targetClean: true,
      changes: { files: [], fileCount: 0, summary: "", unifiedDiff: { text: "", truncated: false, maxBytes: 1024 } },
      safeGitCommands: [], evidence: { assets: [], structuredE2eCount: 1, acceptedVerdict: true, gates: [] },
      delivery: { runId: "run-other", status: "merged", updatedAt: "2026-08-12T02:00:02.000Z" },
      confirmationToken: "MERGE run-other", discardConfirmationToken: "DISCARD run-other"
    };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: preview }) });
    const notify = vi.fn();
    const completed: InvocationRecord = {
      id: "inv-other", target: { kind: "workflow", id: "team-flow", version: 1 },
      source: { kind: "workbench", taskId: requirement.id }, status: "completed", phase: "done",
      requestSummary: requirement.title, runId: "run-other", instanceIds: [],
      createdAt: "2026-08-12T02:00:00.000Z", updatedAt: "2026-08-12T02:00:02.000Z",
      completedAt: "2026-08-12T02:00:02.000Z", transitions: []
    };

    act(() => root.render(<BoardPage spaceId={project.id} go={vi.fn()} notify={notify} service={service} projects={[project]} invocations={[completed]} />));
    for (let attempt = 0; attempt < 20 && !notify.mock.calls.some(([message]) => String(message).includes(requirement.code)); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }

    expect(container.querySelectorAll(".board-lane--loading")).toHaveLength(0);
    expect(container.textContent).toContain(requirement.title);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(`${requirement.code} 需求推进状态同步失败`), "error");
    expect(container.textContent).not.toContain("加载需求看板失败");
    const unchanged = await service.getRequirement(requirement.id);
    expect(unchanged.lane).toBe("inbox");
    expect(unchanged.evidence.acceptance?.runId).toBe("run-accepted");
    expect(unchanged.delivery).toBeUndefined();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("adopts a newer system retry only from the same browser-local requirement family", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    const project = connectedProject();
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "领队协议修复后重跑",
      summary: "旧 Run 阻塞后由系统新开一轮",
      priority: "high",
      rawRequirement: "继续同一条需求",
      acceptanceCriteria: ["新 Run 通过后自动进入待验收"]
    });
    const config = { entrancePolicyId: "default-task-entrance-policy", autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await service.reserveRequirementAdvancement(requirement.id, config, "human");
    await service.syncRequirementAdvancement(requirement.id, reserved.idempotencyKey, {
      invocationId: "inv-old-blocked",
      runId: "run-old-blocked",
      status: "blocked",
      observedAt: "2026-08-12T04:16:07.000Z"
    }, config.pollIntervalMs);
    const family = `requirement-run:${reserved.idempotencyKey}`;
    const base: Pick<InvocationRecord, "target" | "source" | "phase" | "requestSummary" | "instanceIds" | "transitions"> = {
      target: { kind: "workflow", id: "team-flow", version: 1 },
      source: { kind: "workbench", project: project.id, taskId: requirement.id, contextId: family },
      phase: "done",
      requestSummary: requirement.title,
      instanceIds: [],
      transitions: []
    };
    const oldInvocation: InvocationRecord = {
      ...base,
      id: "inv-old-blocked",
      status: "blocked",
      runId: "run-old-blocked",
      createdAt: "2026-08-12T04:04:27.000Z",
      updatedAt: "2026-08-12T04:16:07.000Z",
      completedAt: "2026-08-12T04:16:07.000Z"
    };
    const newerInvocation: InvocationRecord = {
      ...base,
      id: "inv-system-retry",
      status: "completed",
      runId: "run-system-retry",
      createdAt: "2026-08-12T06:00:00.000Z",
      updatedAt: "2026-08-12T06:30:00.000Z",
      completedAt: "2026-08-12T06:30:00.000Z"
    };
    const unrelatedLocalCollision: InvocationRecord = {
      ...newerInvocation,
      id: "inv-other-browser",
      runId: "run-other-browser",
      source: { ...newerInvocation.source, contextId: "requirement-run:another-browser-key" },
      createdAt: "2026-08-12T07:00:00.000Z",
      updatedAt: "2026-08-12T07:30:00.000Z",
      completedAt: "2026-08-12T07:30:00.000Z"
    };
    const preview: RunMergePreview = {
      runId: "run-system-retry",
      status: "awaiting-acceptance",
      eligible: true,
      reasons: [],
      acceptanceReadiness: { ready: false, reasons: ["not a merged delivery"] },
      worktreePath: "/repo/.multi-agent/worktrees/run-system-retry",
      repositoryRoot: "/repo",
      targetBranch: "main",
      targetClean: true,
      changes: { files: [{ status: "M", path: "client/src/BoardPage.tsx" }], fileCount: 1, summary: "1 file", unifiedDiff: { text: "diff", truncated: false, maxBytes: 1024 } },
      safeGitCommands: [],
      evidence: {
        assets: [],
        structuredE2eCount: 1,
        acceptedVerdict: true,
        gates: [
          { gateId: "quality-test", required: true, status: "passed", requiredCapability: "quality.test", mode: "before-completion" },
          { gateId: "independent-review", required: true, status: "passed", requiredCapability: "quality.audit", mode: "before-completion" }
        ]
      },
      confirmationToken: "MERGE run-system-retry",
      discardConfirmationToken: "DISCARD run-system-retry"
    };
    fetchMock.mockImplementation((input: RequestInfo) => Promise.resolve({
      ok: String(input).endsWith("/api/runs/run-system-retry/merge-preview"),
      status: 200,
      json: async () => ({ data: preview })
    }));

    act(() => root.render(<BoardPage
      spaceId={project.id}
      go={vi.fn()}
      notify={vi.fn()}
      service={service}
      projects={[project]}
      invocations={[oldInvocation, newerInvocation, unrelatedLocalCollision]}
    />));
    for (let attempt = 0; attempt < 20 && (await service.getRequirement(requirement.id)).lane !== "acceptance"; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }

    const adopted = await service.getRequirement(requirement.id);
    expect(adopted.advancement).toMatchObject({ invocationId: "inv-system-retry", runId: "run-system-retry", status: "completed" });
    expect(adopted.lane).toBe("acceptance");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("run-system-retry"), expect.anything());
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("run-other-browser"))).toBe(false);
  });

  it("reconciles an already merged Run to done without repeating the acceptance warning", async () => {
    const service = createDashboardService({
      delayMs: () => 0,
      initialData: "empty",
      now: () => new Date("2026-08-11T04:00:00.000Z")
    });
    const project = connectedProject();
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "已合入的需求",
      summary: "本地看板仍停留在执行中",
      priority: "high",
      rawRequirement: "合入完成后终态对账",
      acceptanceCriteria: ["卡片自动进入已完成"]
    });
    const config = { entrancePolicyId: "default-task-entrance-policy", autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await service.reserveRequirementAdvancement(requirement.id, config, "human");
    await service.syncRequirementAdvancement(requirement.id, reserved.idempotencyKey, {
      invocationId: "inv-merged",
      runId: "run-merged",
      status: "running",
      observedAt: "2026-08-11T04:00:01.000Z"
    }, config.pollIntervalMs);
    await service.submitRequirementForAcceptance(requirement.id, {
      runId: "run-merged",
      eligible: true,
      worktreePath: "/repo/.multi-agent/worktrees/run-merged",
      testGate: { gateId: "quality-test", status: "passed" },
      reviewGate: { gateId: "independent-review", status: "passed" },
      mediaCount: 1,
      structuredE2eCount: 1,
      diffFiles: ["client/src/BoardPage.tsx"],
      capturedAt: "2026-08-11T04:00:02.000Z"
    });
    await service.syncRequirementEvidenceCapture(requirement.id, "run-merged", {
      status: "running",
      updatedAt: "2026-08-11T04:00:03.000Z"
    });
    const preview: RunMergePreview = {
      runId: "run-merged",
      status: "merged",
      eligible: false,
      reasons: ["该交付已经合并。"],
      acceptanceReadiness: { ready: false, reasons: ["原始交付 diff 为空。"] },
      worktreePath: "/repo/.multi-agent/worktrees/run-merged",
      repositoryRoot: "/repo",
      targetBranch: "main",
      targetClean: true,
      changes: { files: [], fileCount: 0, summary: "", unifiedDiff: { text: "", truncated: false, maxBytes: 1024 } },
      safeGitCommands: [],
      evidence: { assets: [], structuredE2eCount: 1, acceptedVerdict: true, gates: [] },
      delivery: { runId: "run-merged", status: "merged", updatedAt: "2026-08-11T04:00:04.000Z" },
      confirmationToken: "MERGE run-merged",
      discardConfirmationToken: "DISCARD run-merged"
    };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: preview }) });
    const notify = vi.fn();
    const completed: InvocationRecord = {
      id: "inv-merged",
      target: { kind: "workflow", id: "team-flow", version: 1 },
      source: { kind: "workbench", taskId: requirement.id },
      status: "completed",
      phase: "done",
      requestSummary: requirement.title,
      runId: "run-merged",
      instanceIds: [],
      createdAt: "2026-08-11T04:00:00.000Z",
      updatedAt: "2026-08-11T04:00:04.000Z",
      completedAt: "2026-08-11T04:00:04.000Z",
      transitions: []
    };

    act(() => root.render(<BoardPage
      spaceId={project.id}
      go={vi.fn()}
      notify={notify}
      service={service}
      projects={[project]}
      invocations={[completed]}
    />));
    for (let attempt = 0; attempt < 20 && (await service.getRequirement(requirement.id)).lane !== "done"; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }

    expect((await service.getRequirement(requirement.id)).lane).toBe("done");
    expect(container.querySelector<HTMLElement>('section[aria-label^="已完成"]')?.textContent).toContain(requirement.title);
    expect(notify).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls active merge delivery into an exact terminal blocker and then stops polling", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    const project = connectedProject();
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "候选环境失败可见",
      summary: "待合入卡片必须显示服务端真实终态",
      priority: "high",
      rawRequirement: "不要永久显示等待串行合入",
      acceptanceCriteria: ["失败后看板显示候选环境阻塞"]
    });
    const runId = "run-conflict-poll";
    await service.submitRequirementForAcceptance(requirement.id, {
      runId,
      eligible: true,
      worktreePath: `/repo/.multi-agent/worktrees/${runId}`,
      testGate: { gateId: "quality-test", status: "passed" },
      reviewGate: { gateId: "independent-review", status: "passed" },
      mediaCount: 1,
      structuredE2eCount: 1,
      diffFiles: ["client/src/BoardPage.tsx"],
      capturedAt: "2026-08-15T07:00:00.000Z"
    });
    await service.syncRequirementDelivery(requirement.id, runId, "queued-for-merge");
    const preview: RunMergePreview = {
      runId,
      status: "conflict",
      eligible: false,
      reasons: ["AI 冲突处理未通过"],
      acceptanceReadiness: { ready: false, reasons: ["交付仍在冲突阶段"] },
      worktreePath: `/repo/.multi-agent/worktrees/${runId}`,
      repositoryRoot: "/repo",
      targetBranch: "main",
      targetClean: true,
      changes: { files: [], fileCount: 0, summary: "", unifiedDiff: { text: "", truncated: false, maxBytes: 1024 } },
      safeGitCommands: [],
      evidence: { assets: [], structuredE2eCount: 1, acceptedVerdict: true, gates: [] },
      delivery: {
        runId,
        status: "conflict",
        updatedAt: "2026-08-15T07:01:00.000Z",
        message: "受管候选预览启动失败；候选仍在待合入队列。",
        conflictResolution: {
          status: "failed",
          targetCommit: "target-commit",
          updatedAt: "2026-08-15T07:01:00.000Z",
          failureClass: "environment-blocked",
          message: "Vite 启动超时"
        }
      },
      confirmationToken: `MERGE ${runId}`,
      discardConfirmationToken: `DISCARD ${runId}`
    };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: preview }) });

    act(() => root.render(<BoardPage
      spaceId={project.id}
      go={vi.fn()}
      notify={vi.fn()}
      service={service}
      projects={[project]}
    />));
    for (let attempt = 0; attempt < 20 && (await service.getRequirement(requirement.id)).delivery?.conflictResolution?.status !== "failed"; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }

    expect(await service.getRequirement(requirement.id)).toMatchObject({
      lane: "merging",
      exception: "blocked",
      delivery: { status: "conflict", conflictResolution: { status: "failed", failureClass: "environment-blocked" } }
    });
    const chip = [...container.querySelectorAll<HTMLElement>('[role="status"]')].find((item) => item.textContent === "候选环境阻塞");
    expect(chip?.title).toBe("Vite 启动超时");
    const callsAfterFailure = fetchMock.mock.calls.length;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFailure);
  });
});
