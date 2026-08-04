/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupervisorDagEditorCanvas } from "./SupervisorDagEditorCanvas";
import type { DagNodeDraft } from "./supervisorDag";

const nodes: DagNodeDraft[] = [
  { nodeId: "frontend-task", roleId: "frontend", needs: [], kind: "task", task: "Build UI", capabilitiesText: "code.frontend", workKind: "code", changeSet: "frontend", required: true },
  { nodeId: "frontend-test", roleId: "tester", needs: ["frontend-task"], kind: "test", task: "Test UI", capabilitiesText: "quality.test", workKind: "test", changeSet: "", required: true },
  { nodeId: "integration-test", roleId: "tester", needs: [], kind: "integration-test", task: "Test merge", capabilitiesText: "quality.test", workKind: "test", changeSet: "", required: true }
];

describe("SupervisorDagEditorCanvas", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders dependency edges and gives every reuse of one role the same visual badge", () => {
    act(() => root.render(<SupervisorDagEditorCanvas
      nodes={nodes}
      positions={{}}
      selectedIndex={1}
      issues={["集成测试节点 integration-test 必须直接依赖一个 merge 节点"]}
      onSelect={vi.fn()}
      onPositionsChange={vi.fn()}
      onConnect={vi.fn()}
      roleDisplay={(roleId) => roleId === "tester" ? "测试员工" : "前端员工"}
    />));

    expect(container.querySelectorAll(".workflow-canvas-edges > path")).toHaveLength(1);
    expect(container.querySelector(".supervisor-dag-editor-node.selected")?.textContent).toContain("frontend-test");
    expect(container.querySelector(".supervisor-dag-editor-node.invalid")?.textContent).toContain("integration-test");
    const testerNodes = Array.from(container.querySelectorAll<HTMLElement>(".supervisor-dag-editor-node"))
      .filter((node) => node.textContent?.includes("tester"));
    expect(testerNodes).toHaveLength(2);
    expect(testerNodes[0]!.style.getPropertyValue("--role-accent")).toBe(testerNodes[1]!.style.getPropertyValue("--role-accent"));
    expect(testerNodes[0]!.textContent).toContain("测试员工");
  });

  it("creates needs through output-to-input port clicks and keeps keyboard position editing", () => {
    const onConnect = vi.fn();
    const onPositionsChange = vi.fn();
    act(() => root.render(<SupervisorDagEditorCanvas
      nodes={nodes}
      positions={{ "frontend-task": { x: 40, y: 40 } }}
      selectedIndex={0}
      onSelect={vi.fn()}
      onPositionsChange={onPositionsChange}
      onConnect={onConnect}
    />));

    const output = container.querySelectorAll<HTMLButtonElement>(".supervisor-dag-port--output")[0]!;
    const target = container.querySelectorAll<HTMLButtonElement>(".supervisor-dag-port--input")[2]!;
    act(() => output.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.textContent).toContain("点击目标端口");
    act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onConnect).toHaveBeenCalledWith(0, 2);

    const body = container.querySelectorAll<HTMLButtonElement>(".supervisor-dag-node-body")[0]!;
    act(() => body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(onPositionsChange).toHaveBeenCalledWith(expect.objectContaining({
      "frontend-task": { x: 48, y: 40 }
    }));
  });
});
