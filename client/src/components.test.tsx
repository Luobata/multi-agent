/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPLETED_STATE_LINGER_MS, RuntimeStatusChip, SelectControl, employeeRuntimeStatus } from "./components";
import type { WorkInstanceRecord } from "./types";

const options = [
  { value: "compatible", label: "兼容更新（推荐）", description: "安全变更自动同步" },
  { value: "locked", label: "锁定版本", description: "保留当前固定版本" },
  { value: "latest", label: "始终最新", description: "采用员工最新版本" }
];

describe("SelectControl", () => {
  let container: HTMLElement;
  let root: Root;
  const nativeScrollIntoView = HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    if (nativeScrollIntoView) HTMLElement.prototype.scrollIntoView = nativeScrollIntoView;
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it("uses a product-styled listbox instead of a native select popup", () => {
    const onChange = vi.fn();
    act(() => root.render(<SelectControl ariaLabel="更新策略" value="compatible" options={options} onChange={onChange} />));

    const trigger = container.querySelector<HTMLButtonElement>("[role='combobox']");
    expect(trigger).not.toBeNull();
    expect(container.querySelector("select")).toBeNull();

    act(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector("[role='listbox']")).not.toBeNull();
    expect(document.body.querySelectorAll("[role='option']")).toHaveLength(3);

    const locked = Array.from(document.body.querySelectorAll<HTMLButtonElement>("[role='option']"))
      .find((option) => option.textContent?.includes("锁定版本"));
    act(() => locked?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith("locked");
    expect(document.body.querySelector("[role='listbox']")).toBeNull();
  });

  it("supports arrow navigation, selection, and Escape without trapping focus", () => {
    const onChange = vi.fn();
    act(() => root.render(<SelectControl ariaLabel="更新策略" value="compatible" options={options} onChange={onChange} />));
    const trigger = container.querySelector<HTMLButtonElement>("[role='combobox']")!;

    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.body.querySelector("[role='option'][data-active='true']")?.textContent).toContain("锁定版本");
    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onChange).toHaveBeenCalledWith("locked");

    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the menu inside a modal top layer instead of portaling behind it", () => {
    const dialog = document.createElement("dialog");
    dialog.open = true;
    act(() => root.unmount());
    container.replaceWith(dialog);
    container = dialog;
    root = createRoot(dialog);
    act(() => root.render(<SelectControl ariaLabel="弹窗选择器" value="compatible" options={options} onChange={vi.fn()} />));

    const trigger = dialog.querySelector<HTMLButtonElement>("[role='combobox']")!;
    act(() => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const listbox = dialog.querySelector("[role='listbox']");
    expect(listbox).not.toBeNull();
    expect(listbox?.parentElement).toBe(dialog);
  });

  it("keeps the active option visible while navigating a long list", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const onChange = vi.fn();
    const longOptions = Array.from({ length: 24 }, (_, index) => ({ value: String(index + 1), label: `选项 ${index + 1}` }));
    act(() => root.render(<SelectControl ariaLabel="长列表" value="1" options={longOptions} onChange={onChange} />));
    const trigger = container.querySelector<HTMLButtonElement>("[role='combobox']")!;

    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));

    const active = document.body.querySelector("[role='option'][data-active='true']");
    expect(active?.textContent).toContain("选项 24");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(active?.id);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onChange).toHaveBeenCalledWith("24");
  });

  it("gives empty, all-disabled, and invalid states explicit accessible feedback", () => {
    act(() => root.render(<SelectControl ariaLabel="空列表" value="" options={[]} onChange={vi.fn()} />));
    let trigger = container.querySelector<HTMLButtonElement>("[role='combobox']")!;
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toContain("暂无可选项");

    act(() => root.render(<SelectControl ariaLabel="全禁用列表" value="" options={[{ value: "a", label: "A", disabled: true }]} onChange={vi.fn()} />));
    trigger = container.querySelector<HTMLButtonElement>("[role='combobox']")!;
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toContain("暂无可用选项");

    act(() => root.render(<SelectControl ariaLabel="错误列表" value="" options={options} errorMessage="请选择一个有效选项。" onChange={vi.fn()} />));
    trigger = container.querySelector<HTMLButtonElement>("[role='combobox']")!;
    const error = container.querySelector<HTMLElement>("[role='alert']")!;
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(trigger.getAttribute("aria-describedby")).toBe(error.id);
    expect(error.textContent).toBe("请选择一个有效选项。");
  });

  it("skips disabled options and lets Tab continue the natural focus flow", () => {
    act(() => root.render(<SelectControl ariaLabel="含禁用项" value="a" options={[
      { value: "a", label: "A" },
      { value: "b", label: "B", disabled: true },
      { value: "c", label: "C" }
    ]} onChange={vi.fn()} />));
    const trigger = container.querySelector<HTMLButtonElement>("[role='combobox']")!;

    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.body.querySelector("[role='option'][data-active='true']")?.textContent).toContain("C");
    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("RuntimeStatusChip", () => {
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
    document.body.replaceChildren();
  });

  it("renders explicit text and a hidden 16px shape for every status", () => {
    act(() => root.render(<>
      <RuntimeStatusChip status="running" />
      <RuntimeStatusChip status="queued" />
      <RuntimeStatusChip status="waiting" />
      <RuntimeStatusChip status="completed" />
      <RuntimeStatusChip status="failed" />
      <RuntimeStatusChip status="idle" />
    </>));

    const chips = container.querySelectorAll(".runtime-chip");
    expect(chips).toHaveLength(6);
    for (const chip of chips) {
      const shape = chip.querySelector("svg.runtime-chip-shape");
      expect(shape?.getAttribute("aria-hidden")).toBe("true");
      expect(shape?.getAttribute("viewBox")).toBe("0 0 16 16");
    }
    expect(container.querySelector(".runtime-chip--running")?.textContent).toContain("工作中");
    expect(container.querySelector(".runtime-chip--queued")?.textContent).toContain("排队中");
    expect(container.querySelector(".runtime-chip--waiting")?.textContent).toContain("等待中");
    expect(container.querySelector(".runtime-chip--completed")?.textContent).toContain("已完成");
    expect(container.querySelector(".runtime-chip--failed")?.textContent).toContain("故障");
    expect(container.querySelector(".runtime-chip--idle")?.textContent).toContain("空闲待命");
  });

  it("distinguishes statuses by shape instead of color alone", () => {
    act(() => root.render(<>
      <RuntimeStatusChip status="queued" />
      <RuntimeStatusChip status="waiting" />
      <RuntimeStatusChip status="running" />
      <RuntimeStatusChip status="completed" />
      <RuntimeStatusChip status="failed" />
    </>));

    // queued: hollow diamond, waiting: hollow circle
    expect(container.querySelector(".runtime-chip--queued path")?.getAttribute("d")).toBe("M8 2.5 13.5 8 8 13.5 2.5 8Z");
    expect(container.querySelector(".runtime-chip--waiting circle")).not.toBeNull();
    // running star and completed pixel heart are solid fills
    expect(container.querySelector(".runtime-chip--running path")?.getAttribute("fill")).toBe("currentColor");
    expect(container.querySelector(".runtime-chip--completed path")?.getAttribute("fill")).toBe("currentColor");
    // failed: warning triangle plus an exclamation mark
    expect(container.querySelectorAll(".runtime-chip--failed path").length).toBeGreaterThan(1);
  });

  it("shows the parallel instance count and supports an explicit label override", () => {
    act(() => root.render(<RuntimeStatusChip status="running" count={3} />));
    expect(container.textContent).toContain("工作中 ×3");

    act(() => root.render(<RuntimeStatusChip status="failed" label="需要处理" />));
    expect(container.textContent).toContain("需要处理");
  });
});

describe("reduced-motion runtime signals", () => {
  it("stops looping runtime animations while keeping static shape, text and rail signals", () => {
    const css = readFileSync(resolve(process.cwd(), "client/src/styles.css"), "utf8");
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));

    // Looping motion stops: running chip pulse and the seat character bob/wait.
    expect(reducedMotion).toContain(".runtime-chip--running .runtime-chip-shape");
    expect(reducedMotion).toContain(".runtime-running .office-character");
    expect(reducedMotion).toContain(".runtime-waiting .office-character,");
    expect(reducedMotion).toContain(".runtime-queued .office-character,");
    expect(reducedMotion).toContain("animation: none;");
    // Static non-color signals are never animated away: 16px pixel shape, the
    // explicit text chip body and the permanent 3px seat rail stay intact.
    expect(css).toContain(".runtime-chip-shape { width: 16px; height: 16px;");
    expect(css).toContain(".runtime-chip { width: fit-content;");
    expect(css).toContain(".seat-status-bar { position: absolute; z-index: 2; top: 0; bottom: 0; left: 0; width: 3px;");
  });
});

describe("employeeRuntimeStatus", () => {
  const record = (status: WorkInstanceRecord["status"], updatedAt: string) => ({ status, updatedAt });
  const now = new Date("2026-08-01T12:00:00.000Z").getTime();

  it("prefers live work over terminal records", () => {
    expect(employeeRuntimeStatus([
      record("failed", "2026-08-01T11:59:00.000Z"),
      record("running", "2026-08-01T11:58:00.000Z")
    ], now)).toBe("running");
    expect(employeeRuntimeStatus([
      record("queued", "2026-08-01T11:59:00.000Z"),
      record("waiting", "2026-08-01T11:58:00.000Z")
    ], now)).toBe("waiting");
    expect(employeeRuntimeStatus([record("queued", "2026-08-01T11:59:00.000Z")], now)).toBe("queued");
  });

  it("keeps failures and blocks visible instead of expiring them", () => {
    expect(employeeRuntimeStatus([record("failed", "2020-01-01T00:00:00.000Z")], now)).toBe("failed");
    expect(employeeRuntimeStatus([record("blocked", "2020-01-01T00:00:00.000Z")], now)).toBe("blocked");
  });

  it("lets a completed state linger briefly, then returns to idle", () => {
    const recent = new Date(now - COMPLETED_STATE_LINGER_MS + 1000).toISOString();
    const stale = new Date(now - COMPLETED_STATE_LINGER_MS - 1000).toISOString();
    expect(employeeRuntimeStatus([record("completed", recent)], now)).toBe("completed");
    expect(employeeRuntimeStatus([record("completed", stale)], now)).toBe("idle");
  });

  it("is idle without instances and never derives from archive state", () => {
    expect(employeeRuntimeStatus([], now)).toBe("idle");
  });
});
