/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectControl } from "./components";

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
