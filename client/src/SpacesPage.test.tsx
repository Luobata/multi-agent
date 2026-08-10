/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SpacesPage } from "./SpacesPage";
import { createDashboardService } from "./dashboard/service";
import type { PassiveProjectAccess, Project } from "./types";

const timestamp = "2026-08-09T00:00:00.000Z";

function formalProject(): Project {
  return {
    id: "formal-project",
    version: 1,
    status: "active",
    name: "正式研发项目",
    description: "ready",
    scope: "repository",
    rootPath: "/workspace/formal-project",
    descriptorPath: "/workspace/formal-project/multi-agent.project.yaml",
    connector: { kind: "repository-development", config: {} },
    roles: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function passiveAccess(overrides: Partial<PassiveProjectAccess> = {}): PassiveProjectAccess {
  return {
    id: "mcp-new-project",
    rootPath: "/workspace/mcp-new-project",
    projectKeys: ["new-project-key"],
    displayName: "MCP 新项目",
    transport: "mcp",
    requestCount: 4,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    ...overrides
  };
}

async function waitForSpaceTree(container: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!container.textContent?.includes("正在加载空间树")) return;
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 5)); });
  }
  throw new Error("space tree did not finish loading");
}

describe("SpacesPage MCP catalog", () => {
  it("在同一目录区分正式项目与 MCP 待完善节点，并隔离看板入口", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const service = createDashboardService({ delayMs: () => 0 });
    const access = passiveAccess();
    service.syncConnectedProjects([formalProject()], [access]);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(<SpacesPage embedded service={service} go={vi.fn()} notify={vi.fn()} onCompleteMcp={vi.fn()} />));
    await waitForSpaceTree(container);

    expect(container.textContent).toContain("MCP 已发现 · 待完善");
    expect(container.textContent).toContain("正式研发项目");
    expect(container.textContent).toContain("1 个正式项目 · 1 个 MCP 待完善");
    expect(container.querySelector(`.space-kind--mcp-observed`)).not.toBeNull();
    const observedRow = [...container.querySelectorAll(".space-row")].find((row) => row.textContent?.includes("MCP 新项目"));
    expect(observedRow?.textContent).toContain("完善接入");
    expect(observedRow?.textContent).not.toContain("看板");
    expect(observedRow?.querySelector(".space-name--static")).not.toBeNull();
    expect(observedRow?.querySelector("button.space-name")).toBeNull();
    expect(observedRow?.parentElement?.textContent).toContain("new-project-key");

    act(() => root.unmount());
    container.remove();
  });

  it("linkedProjectId 只显示正式项目行并附 MCP 接通证据", async () => {
    const service = createDashboardService({ delayMs: () => 0 });
    service.syncConnectedProjects([formalProject()], [passiveAccess({ linkedProjectId: "formal-project" })]);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(<SpacesPage embedded service={service} go={vi.fn()} notify={vi.fn()} />));
    await waitForSpaceTree(container);

    expect(container.textContent).toContain("MCP 已接通");
    expect(container.textContent).not.toContain("MCP 新项目");
    expect(container.querySelectorAll(".space-row")).toHaveLength(4); // 三个虚拟文件夹 + 一个正式项目
    expect(container.querySelector(".space-kind--mcp-observed")).toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});
