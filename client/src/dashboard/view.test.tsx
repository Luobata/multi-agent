/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashTabs, dashTabId, dashTabPanelId, useServiceData, type DashTab } from "./view";

function DeferredLoader({ enabled, revision, loader }: { enabled: boolean; revision: number; loader: () => Promise<string> }) {
  const { state } = useServiceData(loader, [revision], { enabled });
  return <output data-status={state.status}>{state.data}</output>;
}

const tabs: DashTab[] = [
  { id: "overview", label: "概览" },
  { id: "repos", label: "仓库" },
  { id: "members", label: "成员", disabled: true, disabledReason: "阶段一不开放成员管理" },
  { id: "settings", label: "设置" }
];

describe("DashTabs", () => {
  let container: HTMLElement;
  let root: Root;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  function renderTabs(initial = "overview") {
    const onChange = vi.fn();
    let active = initial;
    const render = () => act(() => root.render(<DashTabs baseId="project" ariaLabel="项目分区" tabs={tabs} activeTab={active} onChange={(id) => { active = id; onChange(id); render(); }} />));
    render();
    return { onChange, current: () => active };
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it("renders a standard tablist with roving tabindex and paired panel ids", () => {
    renderTabs();
    const tablist = container.querySelector("[role='tablist']");
    expect(tablist?.getAttribute("aria-label")).toBe("项目分区");
    const all = [...container.querySelectorAll<HTMLButtonElement>("[role='tab']")];
    expect(all).toHaveLength(4);
    expect(all.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    expect(all.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(all[0].id).toBe(dashTabId("project", "overview"));
    expect(all[0].getAttribute("aria-controls")).toBe(dashTabPanelId("project", "overview"));
  });

  it("moves and activates with ArrowRight/ArrowLeft, wrapping around and skipping disabled tabs", () => {
    const { onChange, current } = renderTabs();
    const tablist = container.querySelector<HTMLDivElement>("[role='tablist']")!;
    act(() => tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(onChange).toHaveBeenCalledWith("repos");
    expect(current()).toBe("repos");
    // repos → ArrowRight 跳过 disabled 的 members 到 settings
    act(() => tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(current()).toBe("settings");
    // settings → ArrowRight 循环回 overview
    act(() => tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(current()).toBe("overview");
    act(() => tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
    expect(current()).toBe("settings");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    const selected = container.querySelector<HTMLButtonElement>("[role='tab'][aria-selected='true']")!;
    expect(selected.tabIndex).toBe(0);
    expect(document.activeElement).toBe(selected);
  });

  it("jumps to first/last enabled tab with Home/End", () => {
    const { current } = renderTabs("repos");
    const tablist = container.querySelector<HTMLDivElement>("[role='tablist']")!;
    act(() => tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    expect(current()).toBe("settings");
    act(() => tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
    expect(current()).toBe("overview");
  });

  it("keeps disabled tabs out of activation and carries a textual reason", () => {
    const { onChange } = renderTabs();
    const disabled = container.querySelector<HTMLButtonElement>("[role='tab']:disabled")!;
    expect(disabled.textContent).toBe("成员");
    expect(disabled.title).toBe("阶段一不开放成员管理");
    act(() => disabled.click());
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("useServiceData", () => {
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

  it("stays loading while disabled and lets the newest request win", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const loader = vi.fn(() => new Promise<string>((resolve) => resolvers.push(resolve)));
    act(() => root.render(<DeferredLoader enabled={false} revision={0} loader={loader} />));
    expect(container.querySelector("output")?.dataset.status).toBe("loading");
    expect(loader).not.toHaveBeenCalled();

    act(() => root.render(<DeferredLoader enabled revision={1} loader={loader} />));
    act(() => root.render(<DeferredLoader enabled revision={2} loader={loader} />));
    expect(loader).toHaveBeenCalledTimes(2);
    await act(async () => { resolvers[1]!("latest"); await Promise.resolve(); });
    expect(container.textContent).toBe("latest");
    await act(async () => { resolvers[0]!("stale"); await Promise.resolve(); });
    expect(container.textContent).toBe("latest");
  });
});
