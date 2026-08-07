/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPage } from "./MemoryPage";
import type { MemoryEvidence, MemoryRecord } from "./types";

const record: MemoryRecord = {
  id: "mem_1",
  scope: { employeeId: "researcher", employeeVersion: 1, projectId: "cart-fe" },
  kind: "run-summary",
  title: "前端改价",
  content: "完成前端改价评审并给出结论。",
  provenance: { runId: "run_9", traceId: "run_9", invocationId: "inv_3" },
  status: "active",
  tokens: 5,
  createdAt: "2026-08-07T02:00:00.000Z",
  supersedesId: null
};

const evidence: MemoryEvidence = {
  citationId: "cite_1",
  memoryId: "mem_2",
  kind: "preference",
  title: "偏好：先跑 e2e",
  content: "改动前先补 e2e 证据。",
  traceId: "trace_7",
  score: 0.82,
  createdAt: "2026-08-07T01:00:00.000Z"
};

function envelope(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data }) });
}

describe("MemoryPage", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  const flush = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const click = (element: Element) => {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  };
  const findByText = (selector: string, text: string): HTMLElement => {
    const element = Array.from(container.querySelectorAll<HTMLElement>(selector))
      .find((candidate) => candidate.textContent?.includes(text));
    if (!element) throw new Error(`element not found: ${selector} containing "${text}"`);
    return element;
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders scopes, lists memory on scope select, expands detail and fires onOpenRun with the runId", async () => {
    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/memory/scopes") return envelope({ scopes: [{ scopeKey: "employee:researcher", count: 1 }, { scopeKey: "project:cart-fe", count: 1 }] });
      if (url.startsWith("/api/memory/scope?")) return envelope({ records: [record] });
      return envelope({});
    });
    const onOpenRun = vi.fn();
    act(() => root.render(<MemoryPage notify={vi.fn()} onOpenRun={onOpenRun} />));
    await flush();

    // Left pane: scope list grouped, showing scope keys.
    const scopeButton = findByText(".memory-scope-card", "employee:researcher");
    expect(scopeButton).toBeTruthy();
    expect(container.querySelector(".memory-scope-card")?.textContent).toContain("employee:researcher");

    // Selecting a scope loads and lists its memory records in the middle pane.
    click(scopeButton);
    await flush();
    const recordButton = findByText(".memory-record-card", "前端改价");
    expect(recordButton).toBeTruthy();

    // Selecting a record shows the summary; the provenance jump appears only after expanding.
    click(recordButton);
    await flush();
    expect(container.textContent).toContain("前端改价");
    expect(container.querySelector('[data-testid="memory-run-link"]')).toBeNull();

    click(findByText(".detail-pane button", "展开完整详情"));
    await flush();
    const runLink = container.querySelector<HTMLButtonElement>('[data-testid="memory-run-link"]');
    expect(runLink).toBeTruthy();
    expect(runLink?.textContent).toContain("run_9");

    click(runLink!);
    expect(onOpenRun).toHaveBeenCalledWith("run_9");
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/scopes", expect.anything());
  });

  it("searches via /api/memory/search when the query is non-empty and omits the run jump when evidence lacks a runId", async () => {
    fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/memory/scopes") return envelope({ scopes: [{ scopeKey: "employee:researcher", count: 1 }] });
      if (url.startsWith("/api/memory/scope?")) return envelope({ records: [record] });
      if (url === "/api/memory/search" && init?.method === "POST") return envelope({ evidence: [evidence] });
      return envelope({});
    });
    act(() => root.render(<MemoryPage notify={vi.fn()} onOpenRun={vi.fn()} />));
    await flush();

    click(findByText(".memory-scope-card", "employee:researcher"));
    await flush();

    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "e2e");
      search!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    // The search hit renders, but evidence carries only a traceId so no run jump is offered.
    const searchHit = findByText(".memory-record-card", "偏好：先跑 e2e");
    expect(searchHit).toBeTruthy();
    click(searchHit);
    await flush();
    click(findByText(".detail-pane button", "展开完整详情"));
    await flush();
    expect(container.querySelector('[data-testid="memory-run-link"]')).toBeNull();
    expect(container.textContent).toContain("trace_7");
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/search", expect.objectContaining({ method: "POST" }));
  });

  it("shows an empty state when there are no scopes", async () => {
    fetchMock.mockImplementation(() => envelope({ scopes: [] }));
    act(() => root.render(<MemoryPage notify={vi.fn()} onOpenRun={vi.fn()} />));
    await flush();

    const empty = container.querySelector(".empty-state");
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toContain("记忆");
    expect(empty?.textContent).toContain("自动");
  });

  it("notifies on a failed scope load without crashing", async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: { message: "boom" } }) }));
    const notify = vi.fn();
    act(() => root.render(<MemoryPage notify={notify} onOpenRun={vi.fn()} />));
    await flush();

    expect(notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(container.querySelector(".empty-state")).toBeTruthy();
  });
});
