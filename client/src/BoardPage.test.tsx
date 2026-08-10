/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardPage, requirementStewardOutput } from "./BoardPage";
import { createDashboardService } from "./dashboard/service";
import type { Project, Session } from "./types";

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

    act(() => setText(textarea, "购物车空态"));
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
});
