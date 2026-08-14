/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";
import { createDashboardService } from "./dashboard/service";
import type { Bootstrap, InvocationRecord } from "./types";

const stamp = "2026-08-13T06:00:00.000Z";
const empty: Bootstrap = { providers: [], skills: [], knowledgeBases: [], knowledgeProfiles: [], architectureTemplates: [], gateValidators: [], employees: [], managementPolicies: [], entrancePolicies: [], workflows: [], sessions: [], publications: [], projects: [], projectBindings: [], activity: { invocations: [], instances: [] } };

function invocation(status: InvocationRecord["status"]): InvocationRecord {
  return { id: "inv-1", target: { kind: "workflow", id: "delivery", version: 2 }, source: { kind: "workbench", targetProject: "local-agent-workbench" }, status, phase: "执行", requestSummary: "完成 U6/U7", runId: "run-1", instanceIds: [], createdAt: stamp, updatedAt: stamp, transitions: [] };
}

describe("DashboardPage", () => {
  let root: Root;
  let container: HTMLElement;
  const go = vi.fn();
  beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement("div"); document.body.append(container); root = createRoot(container); go.mockClear(); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it("shows the four-step start path and disables writes offline", async () => {
    act(() => root.render(<DashboardPage go={go} bootstrap={empty} daemon="offline" service={createDashboardService({ initialData: "empty", delayMs: () => 0 })} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.textContent).toContain("01 创建或完善员工");
    expect(container.textContent).toContain("04 查看交付证据");
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  });

  it("prioritizes a human decision and opens its Run Receipt by keyboard click", async () => {
    const bootstrap = { ...empty, activity: { invocations: [invocation("awaiting-human-decision")], instances: [] } };
    act(() => root.render(<DashboardPage go={go} bootstrap={bootstrap} daemon="online" service={createDashboardService({ initialData: "empty", delayMs: () => 0 })} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes("补充决策"))!;
    expect(button.textContent).toContain("Run run-1");
    act(() => button.click());
    expect(go).toHaveBeenCalledWith("runs/run-1");
  });
});
