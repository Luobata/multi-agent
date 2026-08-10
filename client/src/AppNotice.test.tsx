/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNotice } from "./App";

afterEach(() => {
  document.body.innerHTML = "";
  delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
  delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
});

describe("AppNotice", () => {
  it("promotes errors to the top layer and offers a relevant close action", () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const showPopover = vi.fn();
    const hidePopover = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: showPopover });
    Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true, value: hidePopover });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(<AppNotice notice={{ kind: "error", message: "项目接入失败" }} onClose={vi.fn()} />));

    const notice = container.querySelector<HTMLElement>('[role="alert"]');
    expect(showPopover).toHaveBeenCalledOnce();
    expect(notice?.getAttribute("popover")).toBe("manual");
    expect(notice?.textContent).toContain("操作没有完成");
    expect(notice?.textContent).toContain("关闭提示");
    expect(notice?.textContent).not.toContain("重试连接");

    act(() => root.unmount());
    expect(hidePopover).toHaveBeenCalledOnce();
  });
});
