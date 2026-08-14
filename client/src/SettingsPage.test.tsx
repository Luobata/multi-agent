// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

const containers: HTMLElement[] = [];
afterEach(() => { vi.unstubAllGlobals(); containers.splice(0).forEach(node => node.remove()); });
async function render() { const node = document.createElement("div"); document.body.append(node); containers.push(node); const root = createRoot(node); await act(async () => { root.render(<SettingsPage />); }); return node; }

describe("SettingsPage operational controls", () => {
  it("renders four sections and the shared doctor states", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { overall: "partial", generatedAt: "2026-01-01T00:00:00Z", staleAt: "2026-01-01T00:05:00Z", checks: [{ id: "providers", status: "warning", code: "PROVIDERS_EMPTY", message: "0 providers", remediation: "Configure one" }] } }), { status: 200, headers: { "content-type": "application/json" } })));
    const node = await render();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(node.textContent).toContain("模式与迁移"); expect(node.textContent).toContain("环境诊断"); expect(node.textContent).toContain("数据保留 / 备份 / 重置"); expect(node.textContent).toContain("安全"); expect(node.textContent).toContain("PROVIDERS_EMPTY");
  });

  it("locates invalid JSON before any apply write", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { overall: "ready", generatedAt: "", staleAt: "", checks: [] } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch); const node = await render(); const textarea = node.querySelector("textarea")!;
    await act(async () => { textarea.value = "{"; textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    const validate = [...node.querySelectorAll("button")].find(button => button.textContent === "校验并预览")!;
    await act(async () => { validate.click(); });
    expect(node.textContent).toContain("JSON 格式无效"); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
