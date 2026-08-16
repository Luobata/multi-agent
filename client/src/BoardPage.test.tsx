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

/** 需求管家 /start 202 回执夹具（client 侧 InvocationStartReceipt 形状）。 */
function stewardReceiptFixture(sessionId: string, runId: string) {
  return {
    invocation: {
      id: "inv-steward-1",
      target: { kind: "workflow", id: "team-flow", version: 1 },
      source: { kind: "workbench", project: "connected-a" },
      status: "queued",
      phase: "排队",
      requestSummary: "需求整理",
      runId,
      sessionId,
      instanceIds: [],
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      transitions: []
    },
    runId,
    statusUrl: "/api/invocations/inv-steward-1",
    progressUrl: "/api/invocations/inv-steward-1/progress",
    streamUrl: "/api/invocations/inv-steward-1/stream",
    monitor: {
      mode: "long-poll",
      tool: "wait_workflow_progress",
      initialCursor: "inv-steward-1:0",
      defaultTimeoutMs: 20_000,
      maxTimeoutMs: 60_000,
      instructions: "long poll",
      waitUrl: "/api/invocations/inv-steward-1/progress/wait"
    }
  };
}

function stewardProgressPayload(runId: string, status: string, terminal: boolean) {
  return {
    invocationId: "inv-steward-1",
    runId,
    workflowId: "team-flow",
    architecture: "graph",
    status,
    phase: "整理",
    terminal,
    updatedAt: "2026-08-09T00:00:02.000Z",
    round: 1,
    tally: {},
    steps: [],
    leaderReport: { available: false, rounds: 0, delegations: 0, entries: [], gates: [] }
  };
}

function stewardWaitResponse(overrides: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: {
      invocationId: "inv-steward-1",
      nextCursor: "inv-steward-1:1",
      changed: false,
      terminal: false,
      reason: "heartbeat",
      progressReport: "",
      progress: stewardProgressPayload("run-steward-1", "running", false),
      ...overrides
    } })
  };
}

function stewardTerminalWait(runId: string, status = "completed") {
  return stewardWaitResponse({
    nextCursor: "inv-steward-1:9",
    terminal: true,
    reason: "terminal",
    progress: stewardProgressPayload(runId, status, true)
  });
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

  const stewardSession: Session = {
    id: "session-requirement-1",
    employeeId: "xiaomiwang-product-manager",
    employeeVersion: 1,
    assignment: { projectId: "connected-a", projectVersion: 1, projectBindingVersion: 1, roleId: "requirement-steward" },
    title: "首条真实需求",
    status: "active",
    messages: [
      { id: "m1", role: "user", content: "购物车空态增加优惠推荐", at: "2026-08-09T00:00:00.000Z" },
      { id: "m2", role: "employee", content: "我已整理成草稿，请确认。", at: "2026-08-09T00:00:01.000Z", output: {
        message: "我已整理成草稿，请确认。",
        nextAction: "draft",
        draft: {
          title: "购物车空态优惠推荐",
          summary: "为空购物车提供优惠推荐",
          priority: "high",
          rawRequirement: "Agent 不应覆盖成这句",
          acceptanceCriteria: ["空态可以看到推荐", "点击可进入商品详情"]
        }
      } }
    ],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:01.000Z"
  };

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
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes("/conversations/requirement-steward/start")) {
        return Promise.resolve({ ok: true, status: 202, json: async () => ({ data: stewardReceiptFixture("session-requirement-1", "run-requirement-1") }) });
      }
      if (url.includes("/progress/wait")) return Promise.resolve(stewardTerminalWait("run-requirement-1"));
      if (url.startsWith("/api/sessions/")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: stewardSession }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
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

  const settle = async (ms = 30) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
  const stewardStartCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes("/conversations/requirement-steward/start"));

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
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/projects/connected-b/conversations/requirement-steward/start");
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

  it("keeps the genuine empty-board copy when no requirements exist", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    service.syncConnectedProjects([connectedProject()]);
    act(() => root.render(<BoardPage go={vi.fn()} notify={vi.fn()} service={service} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain("看板还没有需求");
    expect(container.textContent).not.toContain("无匹配需求");
  });

  it("distinguishes zero filter matches from a genuinely empty board and clears filters", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    service.syncConnectedProjects([connectedProject()]);
    await service.createRequirement({
      projectId: "connected-a", title: "真实需求甲", summary: "看板筛选诚实性", priority: "medium",
      rawRequirement: "原始需求", acceptanceCriteria: []
    });
    act(() => root.render(<BoardPage go={vi.fn()} notify={vi.fn()} service={service} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain("真实需求甲");

    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).toBeTruthy();
    act(() => setText(search!, "不存在的关键词"));
    // 有需求但筛选无命中时，不能说「看板还没有需求」。
    expect(container.textContent).toContain("无匹配需求");
    expect(container.textContent).not.toContain("看板还没有需求");

    await act(async () => { button("清除筛选").click(); });
    expect(container.textContent).toContain("真实需求甲");
    expect(search!.value).toBe("");
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
    await settle();
    expect(container.querySelector(".board-ai-draft-fields")).toBeTruthy();
    await chooseSelect("AI 需求所属项目", "真实项目 A");
    expect(container.querySelector(".board-ai-draft-fields")).toBeNull();
    expect(container.textContent).not.toContain("我已整理成草稿，请确认。");
    act(() => setText(composer, "切换后的 AI 需求"));
    await act(async () => { button("交给需求管家").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();
    expect(String(stewardStartCalls().at(-1)?.[0])).toContain("/api/projects/connected-a/");
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
    await settle();

    expect(stewardStartCalls()).toHaveLength(1);
    expect(String(stewardStartCalls()[0]![0])).toContain("/conversations/requirement-steward/start");
    expect(JSON.parse(String(stewardStartCalls()[0]![1]?.body))).toMatchObject({
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

  it("keeps the composer content on a failed start and shows the waiting bubble only after the receipt", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    service.syncConnectedProjects([connectedProject()]);
    let startAttempts = 0;
    let resolveWait!: (value: unknown) => void;
    fetchMock.mockReset().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes("/conversations/requirement-steward/start")) {
        startAttempts += 1;
        if (startAttempts === 1) return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: { message: "失败" } }) });
        return Promise.resolve({ ok: true, status: 202, json: async () => ({ data: stewardReceiptFixture("session-requirement-1", "run-requirement-1") }) });
      }
      if (url.includes("/progress/wait")) return new Promise((resolve) => { resolveWait = resolve; });
      if (url.startsWith("/api/sessions/")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: stewardSession }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    });
    act(() => root.render(<BoardPage spaceId="connected-a" go={vi.fn()} notify={vi.fn()} service={service} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    act(() => button("和 AI 说需求").click());
    const textarea = document.querySelector('textarea[aria-label="描述需求"]') as HTMLTextAreaElement;
    act(() => setText(textarea, "等待中的需求"));

    // /start 本身失败：没有回执就没有等待气泡，正文与附件全部保留。
    await act(async () => { button("交给需求管家").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.querySelector('[aria-label="需求管家整理中"]')).toBeNull();
    expect(document.querySelector(".composer-loading")).toBeNull();
    expect(textarea.value).toBe("等待中的需求");
    expect(container.textContent).toContain("失败");

    // 拿到回执后立即进入等待气泡，composer 清空，证据链接随即可用。
    await act(async () => { button("交给需求管家").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.querySelector(".composer-loading")).toBeNull();
    expect(textarea.value).toBe("");
    const bubble = document.querySelector('[aria-label="需求管家整理中"]');
    expect(bubble).toBeTruthy();
    expect(bubble?.querySelector("a.board-ai-waiting-evidence")?.getAttribute("href")).toBe("#runs/run-requirement-1");

    // 服务端终态到达后气泡消失，会话证据进入对话区。
    await act(async () => {
      resolveWait(stewardTerminalWait("run-requirement-1"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    expect(document.querySelector('[aria-label="需求管家整理中"]')).toBeNull();
    expect(container.textContent).toContain("我已整理成草稿，请确认。");
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
    const clarifySession: Session = {
      ...sessionBase,
      messages: [
        { id: "c1", role: "user", content: "做个推荐", at: "2026-08-09T00:00:00.000Z" },
        { id: "c2", role: "employee", content: "推荐出现在哪个页面？", at: "2026-08-09T00:00:01.000Z", output: { message: "推荐出现在哪个页面？", nextAction: "clarify", draft: null } }
      ],
      updatedAt: "2026-08-09T00:00:01.000Z"
    };
    const draftSession: Session = {
      ...sessionBase,
      messages: [
        { id: "c1", role: "user", content: "做个推荐", at: "2026-08-09T00:00:00.000Z" },
        { id: "c2", role: "employee", content: "推荐出现在哪个页面？", at: "2026-08-09T00:00:01.000Z", output: { message: "推荐出现在哪个页面？", nextAction: "clarify", draft: null } },
        { id: "c3", role: "user", content: "购物车空态", at: "2026-08-09T00:00:02.000Z" },
        { id: "c4", role: "employee", content: "已经可以形成草稿。", at: "2026-08-09T00:00:03.000Z", output: {
          message: "已经可以形成草稿。",
          nextAction: "draft",
          draft: {
            title: "购物车空态推荐",
            summary: "空购物车展示推荐",
            priority: "medium",
            rawRequirement: "Agent rewrite",
            acceptanceCriteria: ["空态显示推荐"]
          }
        } }
      ],
      updatedAt: "2026-08-09T00:00:03.000Z"
    };
    let sessionFetches = 0;
    fetchMock.mockReset().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes("/conversations/requirement-steward/start")) {
        return Promise.resolve({ ok: true, status: 202, json: async () => ({ data: stewardReceiptFixture("session-clarify-1", "run-clarify-1") }) });
      }
      if (url.includes("/progress/wait")) return Promise.resolve(stewardTerminalWait("run-clarify-1"));
      if (url.startsWith("/api/sessions/")) {
        sessionFetches += 1;
        const session = sessionFetches === 1 ? clarifySession : draftSession;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: session }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    });

    act(() => root.render(<BoardPage spaceId="connected-a" go={vi.fn()} notify={vi.fn()} service={service} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { button("和 AI 说需求").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const textarea = document.querySelector('textarea[aria-label="描述需求"]') as HTMLTextAreaElement;
    act(() => setText(textarea, "做个推荐"));
    await act(async () => { button("交给需求管家").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();

    expect(container.textContent).toContain("需要你补充一点");
    expect(container.textContent).toContain("推荐出现在哪个页面？");
    expect(button("确认创建并进入收件箱").disabled).toBe(true);
    expect(await service.listBoard()).toEqual([]);

    const followupTextarea = document.querySelector('textarea[aria-label="描述需求"]') as HTMLTextAreaElement;
    act(() => setText(followupTextarea, "购物车空态"));
    await act(async () => { button("继续说明").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();

    expect(JSON.parse(String(stewardStartCalls()[1]![1]?.body))).toMatchObject({
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
    const family = `requirement-lineage:${reserved.lineageId}`;
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

describe("BoardPage requirement steward async monitor", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

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

  let waitQueue: Array<Deferred<unknown>>;

  const stewardSession: Session = {
    id: "sess-steward-1",
    employeeId: "xiaomiwang-product-manager",
    employeeVersion: 1,
    assignment: { projectId: "connected-a", projectVersion: 1, projectBindingVersion: 1, roleId: "requirement-steward" },
    title: "整理一个需求",
    status: "active",
    messages: [
      { id: "s1", role: "user", content: "整理一个需求", at: "2026-08-09T00:00:00.000Z" },
      { id: "s2", role: "employee", content: "草稿已整理。", at: "2026-08-09T00:00:01.000Z", output: {
        message: "草稿已整理。",
        nextAction: "draft",
        draft: {
          title: "空态推荐草稿",
          summary: "摘要",
          priority: "medium",
          rawRequirement: "Agent rewrite",
          acceptanceCriteria: ["可验收"]
        }
      } }
    ],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:01.000Z"
  };

  const settle = async (ms = 30) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
  const startCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes("/conversations/requirement-steward/start"));
  const postCalls = () => fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "POST");
  const waitCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes("/progress/wait"));
  const waitingBubble = () => document.querySelector<HTMLElement>('[aria-label="需求管家整理中"]');

  const submitSteward = async (text: string) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="描述需求"]');
    if (!textarea) throw new Error("composer textarea not found");
    act(() => setText(textarea, text));
    await act(async () => {
      button("交给需求管家").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

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
    waitQueue = [];
    fetchMock.mockReset().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes("/conversations/requirement-steward/start")) {
        return Promise.resolve({ ok: true, status: 202, json: async () => ({ data: stewardReceiptFixture("sess-steward-1", "run-steward-1") }) });
      }
      if (url.includes("/progress/wait")) {
        const request = deferred<unknown>();
        waitQueue.push(request);
        return request.promise;
      }
      if (url === "/api/sessions/sess-steward-1") return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: stewardSession }) });
      if (url.includes("/api/invocations/inv-steward-1/cancel")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { id: "inv-steward-1", status: "cancellation-requested" } }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty" });
    service.syncConnectedProjects([connectedProject()]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<BoardPage spaceId="connected-a" go={vi.fn()} notify={vi.fn()} service={service} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { button("和 AI 说需求").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("clears the composer on the receipt and shows the waiting bubble with the evidence link immediately", async () => {
    await submitSteward("整理一个需求");

    expect(startCalls()).toHaveLength(1);
    expect(String(startCalls()[0]?.[0])).toContain("/api/projects/connected-a/conversations/requirement-steward/start");
    expect(JSON.parse(String(startCalls()[0]?.[1]?.body))).toEqual({ message: "整理一个需求" });
    const headers = new Headers(startCalls()[0]?.[1]?.headers as HeadersInit);
    expect(headers.get("x-multi-agent-project")).toBe("connected-a");
    expect(headers.get("x-multi-agent-source")).toBe("workbench");

    const bubble = waitingBubble();
    expect(bubble).toBeTruthy();
    expect(bubble?.querySelector<HTMLAnchorElement>("a.board-ai-waiting-evidence")?.getAttribute("href")).toBe("#runs/run-steward-1");
    expect(bubble?.textContent).toContain("取消");
    // composer 已清空且没有第二次 POST。
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="描述需求"]')?.value).toBe("");
    expect(postCalls()).toHaveLength(1);

    // 单在途锁定：composer 与所属项目选择器都禁用，并用 offlineHint 说明原因。
    const lockedTextarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="描述需求"]')!;
    const projectSelect = document.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="AI 需求所属项目"]')!;
    const submitButton = lockedTextarea.closest("form")!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(lockedTextarea.disabled).toBe(true);
    expect(submitButton.disabled).toBe(true);
    expect(projectSelect.disabled).toBe(true);
    expect(container.textContent).toContain("需求管家整理中，结束后才能继续说明");
    // 代码级兜底：强制派发提交也不会产生第二个 /start。
    await act(async () => {
      lockedTextarea.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startCalls()).toHaveLength(1);
    expect(postCalls()).toHaveLength(1);
  });

  it("keeps waiting on heartbeat with the latest state and a ticking elapsed clock", async () => {
    await submitSteward("整理一个需求");
    expect(waitingBubble()?.textContent).toContain("已受理，等待服务端进度");

    act(() => waitQueue[0]?.resolve(stewardWaitResponse({ nextCursor: "inv-steward-1:1", reason: "heartbeat" })));
    await settle();

    expect(waitingBubble()?.textContent).toContain("心跳");
    const elapsed = () => waitingBubble()?.querySelector("time")?.textContent;
    expect(elapsed()).toBe("00:00");
    await settle(1100);
    expect(elapsed()).toBe("00:01");
    expect(waitCalls().some((call) => String(call[0]).includes("cursor=inv-steward-1%3A1"))).toBe(true);
    expect(startCalls()).toHaveLength(1);
  });

  it("hydrates the draft from the last employee message output on terminal completion", async () => {
    await submitSteward("整理一个需求");
    act(() => waitQueue[0]?.resolve(stewardTerminalWait("run-steward-1")));
    await settle();
    await settle();

    expect(fetchMock.mock.calls.some((call) => String(call[0]) === "/api/sessions/sess-steward-1")).toBe(true);
    expect(waitingBubble()).toBeNull();
    expect(container.textContent).toContain("草稿已整理。");
    expect((document.querySelector('input[value="空态推荐草稿"]') as HTMLInputElement | null)?.value).toBe("空态推荐草稿");
    // 原始需求保留用户原话，而不是 Agent 的改写。
    const raw = [...document.querySelectorAll("textarea")].find((candidate) => candidate.value === "整理一个需求");
    expect(raw).toBeTruthy();
    expect(button("确认创建并进入收件箱").disabled).toBe(false);
  });

  it("posts an operator cancellation and settles on the server-driven cancelled terminal", async () => {
    await submitSteward("整理一个需求");
    const cancel = [...waitingBubble()!.querySelectorAll("button")].find((item) => item.textContent === "取消");
    expect(cancel).toBeTruthy();
    await act(async () => {
      cancel!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const cancelCalls = postCalls().filter((call) => String(call[0]) === "/api/invocations/inv-steward-1/cancel");
    expect(cancelCalls).toHaveLength(1);
    expect(JSON.parse(String(cancelCalls[0]?.[1]?.body))).toEqual({ actor: "workbench-operator" });
    expect(waitingBubble()?.textContent).toContain("取消中");

    act(() => waitQueue[0]?.resolve(stewardTerminalWait("run-steward-1", "cancelled")));
    await settle();
    await settle();

    expect(waitingBubble()).toBeNull();
    expect(fetchMock.mock.calls.some((call) => String(call[0]) === "/api/sessions/sess-steward-1")).toBe(true);
    expect(container.textContent).toContain("已取消本次整理；取消与执行证据保留在运行卷宗 #run-steward-1");
    // 终态后监听停止，没有继续轮询。
    expect(waitCalls()).toHaveLength(1);
    expect(startCalls()).toHaveLength(1);
  });

  it("re-attaches the monitor from the same receipt and cursor after an interruption without resubmitting", async () => {
    await submitSteward("整理一个需求");
    act(() => waitQueue[0]?.reject(new Error("network down")));
    await settle();

    expect(waitingBubble()?.textContent).toContain("监听通道中断（网络或服务暂时不可达）");
    // 中断态同时提供重挂与取消两个出口（证据链接是 <a>，不计入按钮）。
    const actions = [...waitingBubble()!.querySelectorAll(".board-ai-waiting-actions button")].map((item) => item.textContent);
    expect(actions).toEqual(["重新挂载监听", "取消"]);
    const retry = [...waitingBubble()!.querySelectorAll("button")].find((item) => item.textContent === "重新挂载监听");
    expect(retry).toBeTruthy();

    await act(async () => {
      retry!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(waitCalls()).toHaveLength(2);
    expect(String(waitCalls()[1]?.[0])).toContain("cursor=inv-steward-1%3A0");

    act(() => waitQueue[1]?.resolve(stewardTerminalWait("run-steward-1")));
    await settle();
    await settle();

    expect(startCalls()).toHaveLength(1);
    // 用户原话只在对话区出现一次（草稿 textarea 的 value 不参与此计数）。
    const transcript = container.querySelector(".board-ai-transcript")?.textContent ?? "";
    expect(transcript.split("整理一个需求").length - 1).toBe(1);
    expect(container.textContent).toContain("草稿已整理。");
  });

  it("keeps the pending turn across modal close/reopen and re-attaches from the last seen cursor", async () => {
    await submitSteward("整理一个需求");
    // 先推进一次心跳，把游标前进到 inv-steward-1:1；第二次 wait 永远挂着（关闭时脱钩）。
    act(() => waitQueue[0]?.resolve(stewardWaitResponse({ reason: "heartbeat" })));
    await settle(300);
    expect(waitCalls()).toHaveLength(2);

    // 关闭弹窗：监听脱钩、工单继续，pending 与会话都不重置。
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="关闭弹窗"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector("dialog")).toBeNull();

    // 重新打开：同一个 pending 气泡还在，证据链接与脱钩提示都在，且没有重新 /start。
    await act(async () => {
      button("和 AI 说需求").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const bubble = waitingBubble();
    expect(bubble).toBeTruthy();
    expect(bubble?.querySelector<HTMLAnchorElement>("a.board-ai-waiting-evidence")?.getAttribute("href")).toBe("#runs/run-steward-1");
    expect(bubble?.textContent).toContain("监听已断开");
    expect(startCalls()).toHaveLength(1);

    // 重挂监听：从最后见过的游标 inv-steward-1:1 续上，而不是从头开始。
    const remount = [...bubble!.querySelectorAll("button")].find((item) => item.textContent === "重新挂载监听");
    expect(remount).toBeTruthy();
    await act(async () => {
      remount!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(waitCalls()).toHaveLength(3);
    expect(String(waitCalls()[2]?.[0])).toContain("cursor=inv-steward-1%3A1");

    act(() => waitQueue[2]?.resolve(stewardTerminalWait("run-steward-1")));
    await settle();
    await settle();

    // 关闭/重开没有重置会话：用户原话在对话区仍只出现一次。
    const transcript = container.querySelector(".board-ai-transcript")?.textContent ?? "";
    expect(transcript.split("整理一个需求").length - 1).toBe(1);
    expect(container.textContent).toContain("草稿已整理。");
    expect(startCalls()).toHaveLength(1);
  });
});
