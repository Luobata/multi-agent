/** @vitest-environment jsdom */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Breadcrumb, COMPLETED_STATE_LINGER_MS, TERMINAL_ATTENTION_LINGER_MS, RuntimeStatusChip, SelectControl, SwitchControl, employeeRuntimeHealth, employeeRuntimeStatus } from "./components";
import type { WorkInstanceRecord } from "./types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options = [
  { value: "compatible", label: "兼容更新（推荐）", description: "安全变更自动同步" },
  { value: "locked", label: "锁定版本", description: "保留当前固定版本" },
  { value: "latest", label: "始终最新", description: "采用员工最新版本" }
];

describe("Breadcrumb", () => {
  it("renders links, unavailable segments, and the current page with distinct semantics", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Breadcrumb items={[{ label: "项目", href: "#projects" }, { label: "未知上级", unavailableReason: "不可用" }, { label: "REQ-101", current: true }]} />));
    expect(host.querySelector("nav")?.getAttribute("aria-label")).toBe("面包屑");
    expect(host.querySelector("nav")?.getAttribute("data-testid")).toBe("breadcrumb");
    expect(host.querySelectorAll("a")).toHaveLength(1);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("#projects");
    expect(host.querySelector("a")?.getAttribute("data-testid")).toBe("breadcrumb-link-0");
    const unavailable = Array.from(host.querySelectorAll("li > span")).find((item) => item.textContent?.includes("未知上级"));
    expect(unavailable?.getAttribute("aria-label")).toBe("未知上级，不可跳转：不可用");
    expect(unavailable?.hasAttribute("title")).toBe(false);
    expect(host.querySelector("[aria-current='page']")?.textContent).toBe("REQ-101");
    act(() => root.unmount());
  });

  it.each(["Enter", " "])("activates a focused link once with %j without scrolling", (key) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<Breadcrumb items={[{ label: "项目", href: "#projects" }, { label: "当前" }]} />));
    const link = host.querySelector("a")!;
    const click = vi.spyOn(link, "click");
    window.location.hash = "#projects/project-1";
    link.focus();
    expect(document.activeElement).toBe(link);
    const scrollY = window.scrollY;
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(window.location.hash).toBe("#projects");
    expect(click).not.toHaveBeenCalled();
    expect(window.scrollY).toBe(scrollY);
    act(() => root.unmount());
    host.remove();
  });

  it("keeps long labels inside its own scroll container in both themes", () => {
    const css = readFileSync(resolve(process.cwd(), "client/src/styles.css"), "utf8");
    expect(css).toMatch(/\.app-breadcrumb \{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.app-content \{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.app-breadcrumb ol \{[^}]*display:\s*flex[^}]*max-width:\s*100%/s);
    expect(css).toMatch(/\.app-breadcrumb li \{[^}]*min-width:\s*0[^}]*white-space:\s*nowrap/s);
    expect(css).toMatch(/\[data-theme="pixel"\] \.app-breadcrumb/);

    for (const theme of ["crayon", "pixel"]) {
      document.documentElement.dataset.theme = theme;
      const host = document.createElement("div");
      const root = createRoot(host);
      act(() => root.render(<Breadcrumb items={[
        { label: `项目-${"很长的中文项目名称".repeat(12)}`, href: "#projects" },
        { label: `requirement-${"long-id-".repeat(20)}`, current: true }
      ]} />));
      expect(host.querySelector(".app-breadcrumb")?.classList.contains("daemon-write-surface")).toBe(false);
      expect(host.querySelectorAll("a, [aria-current='page']")).toHaveLength(2);
      act(() => root.unmount());
    }
  });

  it("provides non-color interaction feedback without depending on pointer media detection", () => {
    const css = readFileSync(resolve(process.cwd(), "client/src/styles.css"), "utf8");
    expect(css).toMatch(/\.app-breadcrumb a:hover \{[^}]*transform:\s*translateY\(-1px\)[^}]*border-bottom-color:\s*currentColor[^}]*text-decoration:\s*underline[^}]*text-decoration-thickness:\s*2px/s);
    expect(css).toMatch(/\.app-breadcrumb a:focus-visible \{[^}]*outline:\s*2px solid var\(--focus\)[^}]*transform:\s*translateY\(-1px\)[^}]*border-bottom-color:\s*currentColor[^}]*text-decoration:\s*underline[^}]*text-decoration-thickness:\s*2px[^}]*transition:\s*none/s);
    expect(css).toMatch(/\[data-theme="pixel"\] \.app-breadcrumb a:focus-visible \{[^}]*transform:\s*translateY\(-2px\)/s);
    expect(css).toMatch(/\.app-breadcrumb a:active \{[^}]*transform:\s*translate\(2px, 2px\)/s);
    expect(css).not.toMatch(/@media \(hover:\s*hover\)[^{]*\{\s*\.app-breadcrumb a:hover/);
  });

  it("keeps publication evidence shrinkable within the crayon page grid", () => {
    const css = readFileSync(resolve(process.cwd(), "client/src/styles.css"), "utf8");
    expect(css).toMatch(/\.page-grid--publications,[\s\S]*?\.publication-dossier \.evidence-block pre \{\s*min-width:\s*0;\s*max-width:\s*100%;\s*\}/);
  });
});

function productionTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionTsxFiles(path);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
  });
}

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

  it("is the only dropdown primitive used by production client views", () => {
    const sourceRoot = resolve(process.cwd(), "client/src");
    const nativeSelectFiles = productionTsxFiles(sourceRoot)
      .filter((path) => /<select\b/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(sourceRoot.length + 1));

    expect(nativeSelectFiles).toEqual([]);
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

describe("SwitchControl", () => {
  it("shows an explicit on/off word in addition to the switch position", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(<SwitchControl checked={false} ariaLabel="测试开关" onChange={vi.fn()} />));
    expect(container.querySelector(".switch-control-state")?.textContent).toBe("关");
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-label")).toBe("测试开关");

    act(() => root.render(<SwitchControl checked ariaLabel="测试开关" onChange={vi.fn()} />));
    expect(container.querySelector(".switch-control-state")?.textContent).toBe("开");

    act(() => root.unmount());
    container.remove();
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

  it("keeps recent failures and blocks visible without pinning a seat forever", () => {
    const recent = new Date(now - TERMINAL_ATTENTION_LINGER_MS + 1000).toISOString();
    const stale = new Date(now - TERMINAL_ATTENTION_LINGER_MS - 1000).toISOString();
    expect(employeeRuntimeStatus([record("failed", recent)], now)).toBe("failed");
    expect(employeeRuntimeStatus([record("blocked", recent)], now)).toBe("blocked");
    expect(employeeRuntimeStatus([record("failed", stale)], now)).toBe("idle");
    expect(employeeRuntimeStatus([record("blocked", stale)], now)).toBe("idle");
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

describe("employeeRuntimeHealth", () => {
  it("uses only the current Employee version and separates interruptions from technical failures", () => {
    const records = [
      { employeeVersion: 2, status: "completed" as const, phase: "done", updatedAt: "2026-08-01T12:00:00.000Z" },
      { employeeVersion: 2, status: "blocked" as const, phase: "done", updatedAt: "2026-08-01T11:59:00.000Z" },
      { employeeVersion: 2, status: "failed" as const, phase: "error", failure: { category: "provider" as const, kind: "exit" as const, retryable: false }, updatedAt: "2026-08-01T11:58:00.000Z" },
      { employeeVersion: 2, status: "failed" as const, phase: "interrupted", failure: { category: "interrupted" as const, retryable: true }, updatedAt: "2026-08-01T11:57:00.000Z" },
      { employeeVersion: 2, status: "completed" as const, phase: "done", failure: { category: "interrupted" as const, retryable: true }, updatedAt: "2026-08-01T11:56:30.000Z" },
      { employeeVersion: 1, status: "failed" as const, phase: "error", updatedAt: "2026-08-01T11:56:00.000Z" }
    ];
    expect(employeeRuntimeHealth(records, 2)).toEqual({ total: 5, completed: 1, blocked: 1, failed: 1, interrupted: 2 });
  });
});
