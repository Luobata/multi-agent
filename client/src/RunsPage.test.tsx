/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsPage, acceptanceSnapshotFromPreview, filterRuns, isRunAcceptanceReady, sortHumanDecisionRequests } from "./RunsPage";
import type { DashboardService } from "./dashboard/service";
import type { Requirement } from "./dashboard/types";
import type { HumanDecisionRequest, Run, RunMergePreview, RunMergeQueueResult } from "./types";

const runs: Run[] = [
  { id: "run-single-1", workflow: "direct-alice", architecture: "graph", artifactDir: "/a", status: "passed", createdAt: "2026-08-06T03:00:00.000Z", nodes: {}, category: "single", project: "demo-project", trigger: "mcp" },
  { id: "run-graph-1", workflow: "graph-flow", architecture: "graph", artifactDir: "/b", status: "passed", createdAt: "2026-08-06T02:00:00.000Z", nodes: {}, category: "graph", trigger: "workbench" },
  { id: "run-sup-1", workflow: "team-flow", architecture: "supervisor", artifactDir: "/c", status: "blocked", createdAt: "2026-08-06T01:00:00.000Z", nodes: {}, category: "supervisor", project: "other-project", trigger: "http" }
];

function unavailablePreview(runId: string): RunMergePreview {
  return {
    runId,
    status: "not-ready",
    eligible: false,
    reasons: ["该 Run 没有可交付的 worktree。"],
    acceptanceReadiness: { ready: false, reasons: ["该 Run 没有可验证的受管 worktree。"] },
    targetClean: false,
    changes: { files: [], fileCount: 0, summary: "", unifiedDiff: { text: "", truncated: false, maxBytes: 262_144 } },
    safeGitCommands: [],
    evidence: { assets: [], structuredE2eCount: 0, acceptedVerdict: false, gates: [] },
    confirmationToken: `MERGE ${runId}`,
    discardConfirmationToken: `DISCARD ${runId}`
  };
}

describe("RunsPage classification filters", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: runs }) });
      if (url.endsWith("/merge-preview")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: unavailablePreview(url.split("/").at(-2) ?? "") }) });
      if (url.startsWith("/api/runs/")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: runs.find((run) => url.endsWith(run.id)) }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: {} }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<RunsPage notify={vi.fn()} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    fetchMock.mockReset();
  });

  it("renders all runs with category tags by default", () => {
    const cards = container.querySelectorAll(".run-card");
    expect(cards).toHaveLength(3);
    expect(container.querySelector(".run-category-tag--single")).toBeTruthy();
    expect(container.querySelector(".run-category-tag--graph")).toBeTruthy();
    expect(container.querySelector(".run-category-tag--supervisor")).toBeTruthy();
  });

  it("renders both classification filters", () => {
    expect(container.querySelector('[data-testid="run-type-filter"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="run-project-filter"]')).toBeTruthy();
  });

  it("shows the concrete delivery blocker and withholds merge when the preview is ineligible", () => {
    expect(container.textContent).toContain("该 Run 没有可交付的 worktree。");
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "批准并加入待合入")).toBe(false);
  });
});

const evidenceRun: Run = {
  id: "run-e2e-1",
  workflow: "team-e2e",
  architecture: "supervisor",
  artifactDir: "/e2e",
  status: "blocked",
  createdAt: "2026-08-06T04:00:00.000Z",
  category: "supervisor",
  nodes: {
    tester: {
      nodeId: "tester",
      roleId: "qa",
      status: "passed",
      attempts: 1,
      output: { e2eEvidence: [{ method: "browser", steps: "open cart", observed: "cta works" }] },
      artifactDir: "/e2e/tester"
    }
  },
  output: {
    gates: [{ gateId: "e2e", status: "blocked", reason: "缺少 e2e 证据", requiredCapability: "quality.test" }]
  }
};

describe("RunsPage dossier validator verdict + e2e evidence", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [evidenceRun] }) });
      if (url.endsWith("/merge-preview")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: unavailablePreview(evidenceRun.id) }) });
      if (url.startsWith("/api/runs/")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: evidenceRun }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: {} }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<RunsPage notify={vi.fn()} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    fetchMock.mockReset();
  });

  it("renders structured e2e evidence (method / steps / observed), not only raw JSON", () => {
    const evidence = container.querySelector(".run-e2e-evidence");
    expect(evidence).toBeTruthy();
    const text = evidence?.textContent ?? "";
    expect(text).toContain("browser");
    expect(text).toContain("open cart");
    expect(text).toContain("cta works");
  });

  it("renders the gate validator verdict reason for a non-passed gate", () => {
    const reason = container.querySelector(".gate-reason");
    expect(reason).toBeTruthy();
    expect(container.textContent ?? "").toContain("缺少 e2e 证据");
  });
});

const worktreeRun: Run = {
  id: "run-iso-worktree",
  workflow: "team-iso",
  architecture: "supervisor",
  artifactDir: "/iso",
  status: "passed",
  createdAt: "2026-08-06T05:00:00.000Z",
  category: "supervisor",
  nodes: {},
  isolation: { mode: "worktree", worktreePath: "/x/.multi-agent/worktrees/run-1" }
};

const fallbackRun: Run = {
  id: "run-iso-fallback",
  workflow: "team-iso",
  architecture: "supervisor",
  artifactDir: "/iso",
  status: "passed",
  createdAt: "2026-08-06T05:00:00.000Z",
  category: "supervisor",
  nodes: {},
  isolation: { mode: "none", fallbackReason: "worktree 创建失败" }
};

function renderRunDetail(run: Run): { container: HTMLDivElement; root: Root } {
  const fetchMock = vi.fn((input: RequestInfo) => {
    const url = String(input);
    if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [run] }) });
    if (url.endsWith("/merge-preview")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: unavailablePreview(run.id) }) });
    if (url.startsWith("/api/runs/")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: run }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: {} }) });
  });
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root };
}

describe("RunsPage dossier isolation status", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("renders a worktree isolation row with its worktree path", async () => {
    ({ container, root } = renderRunDetail(worktreeRun));
    act(() => root.render(<RunsPage notify={vi.fn()} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const isolation = container.querySelector(".run-isolation");
    expect(isolation).toBeTruthy();
    const text = isolation?.textContent ?? "";
    expect(text).toContain("worktree");
    expect(text).toContain("/x/.multi-agent/worktrees/run-1");
  });

  it("renders a fallback isolation row with the fallback reason", async () => {
    ({ container, root } = renderRunDetail(fallbackRun));
    act(() => root.render(<RunsPage notify={vi.fn()} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const isolation = container.querySelector(".run-isolation");
    expect(isolation).toBeTruthy();
    const text = isolation?.textContent ?? "";
    expect(text).toContain("回退");
    expect(text).toContain("worktree 创建失败");
  });
});

describe("RunsPage focused hash selection", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();
  const scrollIntoView = vi.fn();
  const nativeScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const nativeMatchMedia = window.matchMedia;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: runs }) });
      if (url.endsWith("/merge-preview")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: unavailablePreview(url.split("/").at(-2) ?? "") }) });
      if (url.startsWith("/api/runs/")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: runs.find((run) => url.endsWith(run.id)) }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: {} }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<RunsPage notify={vi.fn()} focusedRunId="run-graph-1" />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    fetchMock.mockReset();
    scrollIntoView.mockReset();
    if (nativeScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: nativeScrollIntoView });
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    if (nativeMatchMedia) Object.defineProperty(window, "matchMedia", { configurable: true, value: nativeMatchMedia });
    else Reflect.deleteProperty(window, "matchMedia");
  });

  it("restores the exact run named by the hash after loading, not the first run", () => {
    expect(container.querySelector("#run-graph-1")?.classList.contains("selected")).toBe(true);
    expect(container.querySelector("#run-single-1")?.classList.contains("selected")).toBe(false);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("does not auto-scroll the completed dossier again when background activity refreshes the list", async () => {
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<RunsPage notify={vi.fn()} focusedRunId="run-graph-1" activityRevision="another-agent-updated" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/runs?")).length).toBeGreaterThan(1);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("keeps an already loaded focused dossier interactive while background refreshes are pending", async () => {
    let releaseList!: () => void;
    let releaseDetail!: () => void;
    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return new Promise((resolve) => {
        releaseList = () => resolve({ ok: true, status: 200, json: async () => ({ data: runs }) });
      });
      if (url === "/api/runs/run-graph-1") return new Promise((resolve) => {
        releaseDetail = () => resolve({ ok: true, status: 200, json: async () => ({ data: runs[1] }) });
      });
      if (url.endsWith("/merge-preview")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: unavailablePreview("run-graph-1") }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: {} }) });
    });

    await act(async () => {
      root.render(<RunsPage notify={vi.fn()} focusedRunId="run-graph-1" activityRevision="poll-in-flight" />);
      await Promise.resolve();
    });

    expect(container.querySelector(".run-dossier")).toBeTruthy();
    expect(container.querySelector('[aria-label="正在调取运行卷宗"]')).toBeNull();
    expect(container.querySelector(".dossier-cover code")?.textContent).toBe("run-graph-1");

    await act(async () => {
      releaseList();
      releaseDetail();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("updates the deep link when the operator selects another run", async () => {
    const onSelectRun = vi.fn();
    await act(async () => { root.render(<RunsPage notify={vi.fn()} focusedRunId="run-graph-1" onSelectRun={onSelectRun} />); await Promise.resolve(); });
    const target = container.querySelector<HTMLButtonElement>("#run-sup-1");
    await act(async () => { target?.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(onSelectRun).toHaveBeenCalledWith("run-sup-1");
  });

  it("embeds an acceptance-only work surface without the separate run list", async () => {
    await act(async () => { root.render(<RunsPage notify={vi.fn()} mode="embedded" view="acceptance" focusedRunId="run-graph-1" />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector(".page-grid--runs-embedded")).toBeTruthy();
    expect(container.textContent).toContain("验收与合并");
    expect(container.textContent).not.toContain("运行元数据");
  });

  it("switches an embedded requirement dossier to the new exact focused Run without falling back to the first Run", async () => {
    await act(async () => {
      root.render(<RunsPage notify={vi.fn()} mode="embedded" focusedRunId="run-graph-1" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector("#run-graph-1")?.classList.contains("selected")).toBe(true);

    await act(async () => {
      root.render(<RunsPage notify={vi.fn()} mode="embedded" focusedRunId="run-sup-1" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector("#run-sup-1")?.classList.contains("selected")).toBe(true);
    expect(container.querySelector("#run-single-1")?.classList.contains("selected")).toBe(false);
    expect(container.querySelector(".dossier-cover code")?.textContent).toBe("run-sup-1");
  });

  it("renders a focused Run returned by the detail endpoint even when it is outside the recent list", async () => {
    const historicalRun: Run = {
      ...runs[1],
      id: "run-historical-103",
      workflow: "req-103-acceptance",
      artifactDir: "/historical/req-103"
    };
    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: runs }) });
      if (url === `/api/runs/${historicalRun.id}`) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: historicalRun }) });
      if (url.endsWith("/merge-preview")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: unavailablePreview(historicalRun.id) }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: {} }) });
    });

    await act(async () => {
      root.render(<RunsPage notify={vi.fn()} mode="embedded" focusedRunId={historicalRun.id} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector(".dossier-cover code")?.textContent).toBe(historicalRun.id);
    expect(container.textContent).toContain("req-103-acceptance");
    expect(container.querySelector("#run-single-1")?.classList.contains("selected")).toBe(false);
  });

  it("shows the focused target error and never falls back when its detail request fails", async () => {
    const missingRunId = "run-missing-focused-103";
    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: runs }) });
      if (url === `/api/runs/${missingRunId}`) return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: { message: "目标 Run 不存在" } }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: {} }) });
    });

    await act(async () => {
      root.render(<RunsPage notify={vi.fn()} mode="embedded" focusedRunId={missingRunId} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("目标 Run 不存在");
    expect(container.textContent).toContain(missingRunId);
    expect(container.querySelector(".run-dossier")).toBeNull();
    expect(container.querySelector("#run-single-1")?.classList.contains("selected")).toBe(false);
  });

  it("shows a persistent establishing state instead of selecting the first Run", async () => {
    act(() => root.render(<RunsPage notify={vi.fn()} pendingRunId="run-missing-1" onReturnOffice={vi.fn()} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("运行卷宗正在建立");
    expect(container.textContent).toContain("Run run-missing-1 尚未出现在本地 Run Store");
    expect(container.querySelector("#run-single-1")?.classList.contains("selected")).toBe(false);
  });
});

describe("RunsPage request context", () => {
  it("renders full request fields and running node placeholders without truncating them", async () => {
    const fullRun: Run = {
      ...runs[2], status: "running", invocation: { id: "inv-1", requestSummary: "核对摘要", requestText: "第一行\n第二行完整请求", taskDescription: "完整任务描述" },
      nodes: { leader: { nodeId: "leader", roleId: "supervisor", status: "running", attempts: 1 } }
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [fullRun] }) });
      if (url.endsWith("/merge-preview")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: unavailablePreview(fullRun.id) }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: fullRun }) });
    }));
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<RunsPage notify={vi.fn()} pendingRunId={fullRun.id} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("第一行\n第二行完整请求");
    expect(container.textContent).toContain("完整任务描述");
    expect(container.textContent).toContain("该节点正在执行，尚无输出");
    expect(container.querySelector(".run-context-warning")).toBeNull();
    act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });
});

const deliveryRun: Run = {
  id: "run-delivery-ui-1",
  workflow: "delivery-flow",
  architecture: "supervisor",
  artifactDir: "/delivery",
  status: "passed",
  createdAt: "2026-08-06T06:00:00.000Z",
  taskId: "req-104",
  nodes: {},
  isolation: { mode: "worktree", worktreePath: "/repo/.multi-agent/worktrees/run-delivery-ui-1" }
};

const eligiblePreview: RunMergePreview = {
  runId: deliveryRun.id,
  status: "awaiting-acceptance",
  eligible: true,
  reasons: [],
  acceptanceReadiness: { ready: false, reasons: ["仅 merged 历史交付使用独立回填资格。"] },
  worktreePath: deliveryRun.isolation?.worktreePath,
  repositoryRoot: "/repo",
  targetBranch: "main",
  targetClean: true,
  changes: {
    files: [{ status: "M", path: "client/src/RunsPage.tsx" }],
    fileCount: 1,
    summary: "1 file changed",
    unifiedDiff: { text: "diff --git a/client/src/RunsPage.tsx b/client/src/RunsPage.tsx\n", truncated: false, maxBytes: 262_144 }
  },
  safeGitCommands: ["git -C /repo/.multi-agent/worktrees/run-delivery-ui-1 status --short", "git -C /repo/.multi-agent/worktrees/run-delivery-ui-1 diff --stat"],
  evidence: {
    assets: [
      { id: "a".repeat(20), kind: "screenshot", name: "acceptance.png", relativePath: "evidence/acceptance.png", mediaType: "image/png", sizeBytes: 2048, url: `/api/runs/${deliveryRun.id}/evidence/${"a".repeat(20)}` },
      { id: "b".repeat(20), kind: "recording", name: "flow.mp4", relativePath: "evidence/flow.mp4", mediaType: "video/mp4", sizeBytes: 4096, url: `/api/runs/${deliveryRun.id}/evidence/${"b".repeat(20)}` }
    ],
    structuredE2eCount: 1,
    acceptedVerdict: true,
    gates: [
      { gateId: "test", required: true, status: "passed", requiredCapability: "quality.test", mode: "before-completion" },
      { gateId: "review", required: true, status: "passed", requiredCapability: "quality.audit", mode: "before-completion" }
    ]
  },
  confirmationToken: `MERGE ${deliveryRun.id}`,
  discardConfirmationToken: `DISCARD ${deliveryRun.id}`
};

describe("RunsPage delivery acceptance", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();
  const notify = vi.fn();
  let deliveryStatus: "base" | "conflict" | "conflict-failed" | "evidence-failed" | "evidence-queued" | "retesting" | "kept" | "discarded" | "merged" = "base";
  let heldMergePreview: Promise<{ ok: boolean; status: number; json: () => Promise<{ data: RunMergePreview }> }> | undefined;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) { this.setAttribute("open", ""); }
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) { this.removeAttribute("open"); }
    });
    deliveryStatus = "base";
    heldMergePreview = undefined;
    fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [deliveryRun] }) });
      if (url.endsWith("/merge-preview")) {
        if (heldMergePreview) return heldMergePreview;
        const preview = deliveryStatus === "conflict" || deliveryStatus === "conflict-failed"
          ? {
            ...eligiblePreview,
            status: "conflict" as const,
            delivery: {
              runId: deliveryRun.id,
              status: "conflict" as const,
              updatedAt: "2026-08-06T06:05:00.000Z",
              baseCommit: "base",
              sourceBranch: "codex/run-delivery-ui-1",
              sourceCommit: "source",
              targetBranch: "main",
              ...(deliveryStatus === "conflict-failed" ? {
                conflictResolution: {
                  status: "failed" as const,
                  targetCommit: "target",
                  updatedAt: "2026-08-06T06:05:00.000Z",
                  message: "原领队没有完成冲突处理，候选仍保留在待合入队列。"
                }
              } : {}),
              message: "CONFLICT (content): Merge conflict in client/src/RunsPage.tsx"
            }
          }
          : deliveryStatus === "evidence-failed" || deliveryStatus === "evidence-queued"
            ? {
              ...eligiblePreview,
              delivery: {
                runId: deliveryRun.id,
                status: "awaiting-acceptance" as const,
                updatedAt: "2026-08-06T06:05:00.000Z",
                evidenceRerun: {
                  status: deliveryStatus === "evidence-queued" ? "queued" as const : "failed" as const,
                  actor: "workbench-operator",
                  requestedAt: "2026-08-06T05:50:00.000Z",
                  updatedAt: "2026-08-06T06:05:00.000Z",
                  mediaCount: 2,
                  message: "daemon 重启中断了补采；已保留 2 项媒体证据。"
                }
              }
            }
            : deliveryStatus === "retesting"
              ? {
                ...eligiblePreview,
                status: "retesting" as const,
                delivery: {
                  runId: deliveryRun.id,
                  status: "retesting" as const,
                  updatedAt: "2026-08-06T06:05:00.000Z",
                  message: "rebase 已完成，正在回跑独立测试。",
                  conflictResolution: {
                    status: "retesting" as const,
                    targetCommit: "target",
                    updatedAt: "2026-08-06T06:05:00.000Z"
                  }
                }
              }
          : deliveryStatus === "merged"
            ? {
              ...eligiblePreview,
              status: "merged" as const,
              eligible: false,
              reasons: ["该交付已经合并。"],
              acceptanceReadiness: { ready: true, reasons: [] },
              delivery: {
                runId: deliveryRun.id, status: "merged" as const, updatedAt: "2026-08-12T04:00:00.000Z",
                baseCommit: "base", sourceBranch: "codex/run-delivery-ui-1", sourceCommit: "source",
                targetBranch: "main", mergeCommit: "merge"
              }
            }
          : deliveryStatus === "kept"
            ? {
              ...eligiblePreview,
              status: "kept" as const,
              delivery: {
                runId: deliveryRun.id,
                status: "kept" as const,
                updatedAt: "2026-08-06T06:05:00.000Z",
                baseCommit: "base",
                sourceBranch: "codex/run-delivery-ui-1",
                sourceCommit: "source",
                targetBranch: "main",
                humanDecision: { action: "keep" as const, actor: "workbench-operator", at: "2026-08-06T06:05:00.000Z" }
              }
            }
            : deliveryStatus === "discarded"
              ? {
                ...eligiblePreview,
                status: "discarded" as const,
                eligible: false,
                reasons: ["该交付已经丢弃，不能再次交付。"],
                delivery: {
                  runId: deliveryRun.id,
                  status: "discarded" as const,
                  updatedAt: "2026-08-06T06:05:00.000Z",
                  baseCommit: "base",
                  sourceBranch: "codex/run-delivery-ui-1",
                  sourceCommit: "source",
                  targetBranch: "main",
                  humanDecision: { action: "discard" as const, actor: "workbench-operator", at: "2026-08-06T06:05:00.000Z" }
                }
              }
              : eligiblePreview;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: preview }) });
      }
      if (url.endsWith("/merge-queue") && init?.method === "POST") {
        const result: RunMergeQueueResult = {
          status: "queued-for-merge",
          delivery: {
            runId: deliveryRun.id,
            status: "queued-for-merge",
            updatedAt: "2026-08-06T06:05:00.000Z",
            baseCommit: "base",
            sourceBranch: "codex/run-delivery-ui-1",
            sourceCommit: "source",
            targetBranch: "main",
            message: "人工验收已通过，正在等待目标分支的串行合入协调。"
          }
        };
        return Promise.resolve({ ok: true, status: 202, json: async () => ({ data: result }) });
      }
      if (url.endsWith("/merge-conflict-retry") && init?.method === "POST") {
        deliveryStatus = "conflict";
        return Promise.resolve({ ok: true, status: 202, json: async () => ({ data: {
          status: "queued-for-merge",
          delivery: {
            runId: deliveryRun.id,
            status: "queued-for-merge",
            updatedAt: "2026-08-06T06:06:00.000Z",
            targetBranch: "main",
            message: "冲突处理已重新排队。"
          }
        } }) });
      }
      if (url.endsWith("/keep") && init?.method === "POST") {
        deliveryStatus = "kept";
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { status: "kept", delivery: { runId: deliveryRun.id, status: "kept" } } }) });
      }
      if (url.endsWith("/discard") && init?.method === "POST") {
        deliveryStatus = "discarded";
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { status: "discarded", delivery: { runId: deliveryRun.id, status: "discarded" } } }) });
      }
      if (url.endsWith("/open-worktree") && init?.method === "POST") {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { runId: deliveryRun.id, worktreePath: deliveryRun.isolation?.worktreePath, repositoryRoot: "/repo" } }) });
      }
      if (url.endsWith("/evidence-rerun") && init?.method === "POST") {
        return Promise.resolve({ ok: true, status: 202, json: async () => ({ data: {
          runId: deliveryRun.id,
          status: "awaiting-acceptance",
          updatedAt: "2026-08-06T06:06:00.000Z",
          evidenceRerun: { status: "queued", actor: "workbench-operator", requestedAt: "2026-08-06T06:06:00.000Z", updatedAt: "2026-08-06T06:06:00.000Z" }
        } }) });
      }
      if (url === `/api/runs/${deliveryRun.id}`) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: deliveryRun }) });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<RunsPage notify={notify} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    fetchMock.mockReset();
    notify.mockReset();
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  });

  it("shows media evidence in an in-project viewer and exposes merge only for an eligible preview", async () => {
    expect(container.querySelector<HTMLImageElement>('img[alt="acceptance.png"]')?.src).toContain("/evidence/");
    expect(container.querySelector<HTMLVideoElement>('video[aria-label="flow.mp4"]')).toBeTruthy();
    const preview = container.querySelector<HTMLButtonElement>('[aria-label="在项目内预览证据 acceptance.png"]');
    expect(preview).toBeTruthy();
    await act(async () => { preview?.click(); await Promise.resolve(); });
    expect(document.querySelector('.run-evidence-viewer-modal [aria-label="关闭弹窗"]')).toBeTruthy();
    expect(document.querySelector('.run-evidence-viewer-stage img[alt="acceptance.png"]')).toBeTruthy();
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "批准并加入待合入")).toBe(true);
  });

  it("offers only acceptance backfill for a ready merged delivery", async () => {
    deliveryStatus = "merged";
    const dashboard = {
      getRequirement: vi.fn().mockResolvedValue({ evidence: {} }),
      submitRequirementForAcceptance: vi.fn().mockResolvedValue({ id: "req-104", code: "REQ-104", lane: "acceptance" }),
      syncRequirementDelivery: vi.fn().mockResolvedValue({ id: "req-104" })
    };
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<RunsPage notify={notify} dashboard={dashboard as never} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const labels = Array.from(container.querySelectorAll("button")).map((button) => button.textContent);
    expect(labels).toContain("补登记该需求到待验收");
    expect(labels).not.toContain("批准并加入待合入");
    expect(labels).not.toContain("让 test-engineer 补采证据");
    const backfill = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "补登记该需求到待验收");
    await act(async () => { backfill?.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(dashboard.submitRequirementForAcceptance).toHaveBeenCalledWith("req-104", expect.objectContaining({
      runId: deliveryRun.id, eligible: true, diffFiles: ["client/src/RunsPage.tsx"]
    }));
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/merge-queue"))).toBe(false);
  });

  it("navigates to a different bound acceptance Run without starting a cross-Run evidence rerun", async () => {
    const originalAssets = eligiblePreview.evidence.assets;
    eligiblePreview.evidence.assets = [];
    try {
      const projected = { id: "req-104", code: "REQ-104", lane: "running" } as Requirement;
      const dashboard = {
        getRequirement: vi.fn().mockResolvedValue({ evidence: { acceptance: { runId: "run-accepted" } } }),
        syncRequirementEvidenceCapture: vi.fn().mockResolvedValue(projected)
      } as unknown as DashboardService;
      const onDashboardSync = vi.fn();
      const onSelectRun = vi.fn();
      await act(async () => { root.render(<RunsPage notify={notify} dashboard={dashboard} onDashboardSync={onDashboardSync} onSelectRun={onSelectRun} />); await Promise.resolve(); });
      const openBoundRun = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "打开该需求绑定的验收 Run →");
      expect(openBoundRun).toBeTruthy();
      expect(container.textContent).toContain("为避免跨 Run 写入，不能在当前卷宗补采");
      await act(async () => { openBoundRun?.click(); await Promise.resolve(); });
      expect(onSelectRun).toHaveBeenCalledWith("run-accepted");
      expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/evidence-rerun") && (init as RequestInit | undefined)?.method === "POST")).toBe(false);
      expect(dashboard.syncRequirementEvidenceCapture).not.toHaveBeenCalled();
    } finally {
      eligiblePreview.evidence.assets = originalAssets;
    }
  });

  it("reruns evidence for the selected bound Run when media is missing and its worktree exists", async () => {
    const originalAssets = eligiblePreview.evidence.assets;
    eligiblePreview.evidence.assets = [];
    try {
      const projected = { id: "req-104", code: "REQ-104", lane: "acceptance" } as Requirement;
      const dashboard = {
        getRequirement: vi.fn().mockResolvedValue({ evidence: { acceptance: { runId: deliveryRun.id } } }),
        syncRequirementEvidenceCapture: vi.fn().mockResolvedValue(projected)
      } as unknown as DashboardService;
      await act(async () => { root.render(<RunsPage notify={notify} dashboard={dashboard} />); await Promise.resolve(); });
      const rerun = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "让 test-engineer 补采证据");
      expect(rerun?.disabled).toBe(false);
      await act(async () => { rerun?.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith(`/api/runs/${deliveryRun.id}/evidence-rerun`) && (init as RequestInit | undefined)?.method === "POST")).toBe(true);
      expect(dashboard.syncRequirementEvidenceCapture).toHaveBeenCalledWith("req-104", deliveryRun.id, expect.objectContaining({ status: "queued" }));
    } finally {
      eligiblePreview.evidence.assets = originalAssets;
    }
  });

  it("reruns evidence for the selected Run without a task binding", async () => {
    const originalAssets = eligiblePreview.evidence.assets;
    const originalTaskId = deliveryRun.taskId;
    eligiblePreview.evidence.assets = [];
    deliveryRun.taskId = undefined;
    try {
      await act(async () => { root.render(<RunsPage notify={notify} />); await Promise.resolve(); });
      const rerun = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "让 test-engineer 补采证据");
      expect(rerun?.disabled).toBe(false);
      expect(container.textContent).not.toContain("该需求尚未提交到待验收");
      await act(async () => { rerun?.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith(`/api/runs/${deliveryRun.id}/evidence-rerun`) && (init as RequestInit | undefined)?.method === "POST")).toBe(true);
    } finally {
      eligiblePreview.evidence.assets = originalAssets;
      deliveryRun.taskId = originalTaskId;
    }
  });

  it("fails closed with an explicit reason when the acceptance binding cannot be read", async () => {
    const originalAssets = eligiblePreview.evidence.assets;
    eligiblePreview.evidence.assets = [];
    const dashboard = {
      getRequirement: vi.fn().mockRejectedValue(new Error("dashboard unavailable")),
      syncRequirementEvidenceCapture: vi.fn()
    } as unknown as DashboardService;
    try {
      await act(async () => { root.render(<RunsPage notify={notify} dashboard={dashboard} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      const rerun = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "让 test-engineer 补采证据");
      expect(rerun?.disabled).toBe(true);
      expect(container.textContent).toContain("无法核对该需求绑定的验收 Run，请重试或刷新页面后再补采");
      expect(container.textContent).not.toContain("该需求尚未提交到待验收");
      rerun?.click();
      expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/evidence-rerun") && (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    } finally {
      eligiblePreview.evidence.assets = originalAssets;
    }
  });

  it("keeps evidence rerun disabled with a visible reason while the acceptance binding loads", async () => {
    const originalAssets = eligiblePreview.evidence.assets;
    eligiblePreview.evidence.assets = [];
    const dashboard = {
      getRequirement: vi.fn().mockReturnValue(new Promise(() => undefined)),
      syncRequirementEvidenceCapture: vi.fn()
    } as unknown as DashboardService;
    try {
      await act(async () => { root.render(<RunsPage notify={notify} dashboard={dashboard} />); await Promise.resolve(); });
      const rerun = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "让 test-engineer 补采证据");
      expect(rerun?.disabled).toBe(true);
      expect(container.textContent).toContain("正在核对该需求绑定的验收 Run");
      rerun?.click();
      expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/evidence-rerun") && (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    } finally {
      eligiblePreview.evidence.assets = originalAssets;
    }
  });

  it("explains why the bound acceptance Run cannot rerun evidence without a worktree", async () => {
    const originalAssets = eligiblePreview.evidence.assets;
    const originalWorktreePath = eligiblePreview.worktreePath;
    eligiblePreview.evidence.assets = [];
    eligiblePreview.worktreePath = undefined;
    const dashboard = {
      getRequirement: vi.fn().mockResolvedValue({ evidence: { acceptance: { runId: deliveryRun.id } } }),
      syncRequirementEvidenceCapture: vi.fn()
    } as unknown as DashboardService;
    try {
      await act(async () => { root.render(<RunsPage notify={notify} dashboard={dashboard} />); await Promise.resolve(); });
      const rerun = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "让 test-engineer 补采证据");
      expect(rerun?.disabled).toBe(true);
      expect(container.textContent).toContain("绑定的验收 Run 没有可用 worktree");
      expect(container.textContent).toContain("请重新发起验收 Run");
    } finally {
      eligiblePreview.evidence.assets = originalAssets;
      eligiblePreview.worktreePath = originalWorktreePath;
    }
  });

  it("treats recovered media as usable evidence without offering a contradictory rerun", async () => {
    deliveryStatus = "evidence-failed";
    await act(async () => {
      root.render(<RunsPage notify={notify} activityRevision="evidence-failed" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector(".run-delivery-evidence-attention")?.textContent).toContain("媒体证据已恢复，无需重复补采");
    expect(container.querySelector(".run-delivery-evidence-attention")?.textContent).toContain("2 项可查看");
    expect(container.querySelector(".run-delivery-evidence-wall")).toBeTruthy();
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "重新运行 test-engineer 补采");
    expect(retry).toBeUndefined();
    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input).endsWith("/evidence-rerun") && (init as RequestInit | undefined)?.method === "POST"
    ))).toBe(false);
  });

  it("does not project a queued rerun superseded by the fixed acceptance snapshot", async () => {
    deliveryStatus = "evidence-queued";
    const dashboard = {
      getRequirement: vi.fn().mockResolvedValue({ evidence: { acceptance: {
        runId: deliveryRun.id,
        capturedAt: "2026-08-06T06:10:00.000Z",
        mediaCount: 4
      } } }),
      syncRequirementEvidenceCapture: vi.fn()
    } as unknown as DashboardService;

    await act(async () => {
      root.render(<RunsPage notify={notify} dashboard={dashboard} activityRevision="stale-evidence-queued" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(dashboard.syncRequirementEvidenceCapture).not.toHaveBeenCalled();
  });

  it("shows conflict revalidation as a pre-merge stage and keeps the dossier stable while polling", async () => {
    deliveryStatus = "retesting";
    await act(async () => {
      root.render(<RunsPage notify={notify} activityRevision="retesting" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("冲突处理 2/3 · 正在重新验收");
    expect(container.textContent).toContain("当前尚未写入目标分支");

    let release!: (value: { ok: boolean; status: number; json: () => Promise<{ data: RunMergePreview }> }) => void;
    heldMergePreview = new Promise((resolve) => { release = resolve; });
    await act(async () => {
      root.render(<RunsPage notify={notify} activityRevision="poll-in-flight" />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("冲突处理 2/3 · 正在重新验收");
    expect(container.querySelector(".run-delivery-evidence-wall")).toBeTruthy();

    heldMergePreview = undefined;
    await act(async () => {
      release({ ok: true, status: 200, json: async () => ({ data: eligiblePreview }) });
      await Promise.resolve();
    });
  });

  it("lets the operator retry a failed conflict through the original leader workflow", async () => {
    deliveryStatus = "conflict-failed";
    await act(async () => {
      root.render(<RunsPage notify={notify} activityRevision="conflict-failed" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "重新让原领队处理冲突");
    expect(retry).toBeTruthy();
    await act(async () => { retry?.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/merge-conflict-retry") && (init as RequestInit | undefined)?.method === "POST")).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("原领队"), "success");
  });

  it("derives board acceptance from the server eligible result, not the legacy acceptedVerdict", () => {
    const snapshot = acceptanceSnapshotFromPreview({
      ...eligiblePreview,
      evidence: { ...eligiblePreview.evidence, acceptedVerdict: false }
    }, "2026-08-06T06:10:00.000Z");
    expect(snapshot.eligible).toBe(true);
    expect(snapshot.testGate?.status).toBe("passed");
    expect(snapshot.reviewGate?.status).toBe("passed");
  });

  it("keeps a verified Run acceptance-ready when only target cleanliness blocks merge", () => {
    const preview: RunMergePreview = {
      ...eligiblePreview,
      status: "not-ready",
      eligible: false,
      reasons: ["目标仓库存在未提交改动，请先处理后再合并。"],
      acceptanceReadiness: { ready: false, reasons: ["缺少与当前 Run 精确匹配的 merged 交付记录。"] }
    };
    expect(isRunAcceptanceReady(preview)).toBe(true);
    expect(acceptanceSnapshotFromPreview(preview, "2026-08-14T05:30:00.000Z").eligible).toBe(true);
  });

  it("does not bypass a product or evidence blocker when merge is also unavailable", () => {
    const preview: RunMergePreview = {
      ...eligiblePreview,
      status: "not-ready",
      eligible: false,
      reasons: ["Run 尚未通过，不能进入合并验收。", "目标仓库存在未提交改动，请先处理后再合并。"],
      acceptanceReadiness: { ready: false, reasons: ["Run 尚未通过。"] }
    };
    expect(isRunAcceptanceReady(preview)).toBe(false);
  });

  it("derives a fixed acceptance snapshot from merged historical readiness without reopening merge eligibility", () => {
    const snapshot = acceptanceSnapshotFromPreview({
      ...eligiblePreview,
      status: "merged",
      eligible: false,
      reasons: ["该交付已经合并。"],
      acceptanceReadiness: { ready: true, reasons: [] }
    }, "2026-08-12T04:00:00.000Z");
    expect(snapshot).toMatchObject({ runId: deliveryRun.id, eligible: true, diffFiles: ["client/src/RunsPage.tsx"] });
  });

  it("opens the validated worktree through the explicit daemon action", async () => {
    const open = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "在系统中打开");
    await act(async () => { open?.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/open-worktree") && (init as RequestInit | undefined)?.method === "POST")).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已在系统中打开"), "success");
  });

  it("copies the complete read-only Git command set", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const copy = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "复制全部命令");
    await act(async () => { copy?.click(); await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith(eligiblePreview.safeGitCommands.join("\n"));
  });

  it("keeps the candidate without closing later human merge or discard choices", async () => {
    const keep = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "人工保留");
    await act(async () => { keep?.click(); });
    const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>("dialog button")).find((button) => button.textContent === "确认人工保留");
    await act(async () => { confirm?.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("交付已人工保留");
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "批准并加入待合入")).toBe(true);
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "丢弃候选结果")).toBe(true);
  });

  it("requires the exact discard token before the destructive action is enabled", async () => {
    const discard = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "丢弃候选结果");
    await act(async () => { discard?.click(); });
    const dialog = container.querySelector("dialog");
    const input = dialog?.querySelector<HTMLInputElement>('input[type="text"]');
    const confirm = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) => button.textContent === "确认丢弃候选结果");
    expect(confirm?.disabled).toBe(true);
    await act(async () => {
      if (input) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, eligiblePreview.discardConfirmationToken);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    expect(confirm?.disabled).toBe(false);
    await act(async () => { confirm?.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const post = fetchMock.mock.calls.find(([request, init]) => String(request).endsWith("/discard") && (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit | undefined)?.body))).toMatchObject({ confirmation: eligiblePreview.discardConfirmationToken });
    expect(container.textContent).toContain("候选结果已丢弃");
  });

  it("keeps preview opening read-only and posts the exact token only after explicit confirmation", async () => {
    const open = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "批准并加入待合入");
    await act(async () => { open?.click(); });
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/merge-queue") && (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
    const dialog = container.querySelector("dialog");
    expect(dialog?.textContent).toContain("批准后由队列串行推进");
    expect(dialog?.textContent).toContain(`MERGE ${deliveryRun.id}`);
    const submit = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) => button.textContent?.startsWith("批准并排队合入"));
    expect(submit?.disabled).toBe(true);

    await act(async () => { dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click(); });
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const post = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/merge-queue") && (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit | undefined)?.body))).toEqual({
      confirmation: `MERGE ${deliveryRun.id}`,
      targetBranch: "main",
      actor: "workbench-operator"
    });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("待合入队列"), "success");
  });
});

const humanDecisionRun: Run = {
  id: "run-human-1",
  workflow: "team-human",
  architecture: "supervisor",
  artifactDir: "/human",
  status: "running",
  createdAt: "2026-08-09T01:00:00.000Z",
  category: "supervisor",
  nodes: {}
};

function humanDecisionRequest(overrides: Partial<HumanDecisionRequest> = {}): HumanDecisionRequest {
  return {
    id: "hdr-1",
    idempotencyKey: "key-1",
    invocationId: "inv-1",
    runId: humanDecisionRun.id,
    workflowId: "team-human",
    workflowVersion: 3,
    supervisorNodeId: "lead",
    round: 2,
    riskCategory: "dependency-install",
    summary: "安装 playwright 浏览器依赖以运行 e2e 验收。",
    proposedAction: { action: "delegate", summary: "安装 playwright", assignments: [{ roleId: "backend-developer", task: "npx playwright install" }] },
    status: "pending",
    createdAt: "2026-08-09T01:05:00.000Z",
    updatedAt: "2026-08-09T01:05:00.000Z",
    ...overrides
  };
}

describe("RunsPage human-in-the-loop decisions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let requests: HumanDecisionRequest[];
  let decideFailures: number;
  let detailFetches: number;
  const fetchMock = vi.fn();
  const notify = vi.fn();

  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) { this.setAttribute("open", ""); }
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) { this.removeAttribute("open"); }
    });
    requests = [humanDecisionRequest()];
    decideFailures = 0;
    detailFetches = 0;
    fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [humanDecisionRun] }) });
      if (url.endsWith("/merge-preview")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: unavailablePreview(humanDecisionRun.id) }) });
      if (url.startsWith("/api/human-decision-requests/") && url.endsWith("/decide") && init?.method === "POST") {
        if (decideFailures > 0) {
          decideFailures -= 1;
          return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: { message: "daemon 写入失败" } }) });
        }
        const body = JSON.parse(String(init.body)) as { decision: "approve" | "reject"; decidedBy: string; comment?: string };
        const decided: HumanDecisionRequest = {
          ...requests.find((request) => url.includes(request.id))!,
          status: body.decision === "approve" ? "approved" : "rejected",
          decidedBy: body.decidedBy,
          comment: body.comment,
          decidedAt: "2026-08-09T01:10:00.000Z",
          updatedAt: "2026-08-09T01:10:00.000Z"
        };
        requests = requests.map((request) => (request.id === decided.id ? decided : request));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: decided }) });
      }
      if (url === "/api/human-decision-requests") return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: requests }) });
      if (url === `/api/runs/${humanDecisionRun.id}`) {
        detailFetches += 1;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: humanDecisionRun }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: {} }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<RunsPage notify={notify} />));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    fetchMock.mockReset();
    notify.mockReset();
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  });

  const decidePosts = () => fetchMock.mock.calls.filter(([input, init]) => String(input).includes("/decide") && (init as RequestInit | undefined)?.method === "POST");
  const button = (text: string, scope: ParentNode = container) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => candidate.textContent === text);

  it("renders the pending request as a prominent awaiting banner with risk evidence", () => {
    const card = container.querySelector(".human-decision-card--pending");
    expect(card).toBeTruthy();
    const sectionTitles = [...container.querySelectorAll(".dossier-section h3")].map((element) => element.textContent);
    expect(sectionTitles[0]).toBe("需要你的决定");
    expect(card?.querySelector('[role="alert"]')?.textContent).toContain("等待你的决定");
    const text = card?.textContent ?? "";
    expect(text).toContain("依赖安装");
    expect(text).toContain("team-human · v3");
    expect(text).toContain("run-human-1");
    expect(text).toContain("Round 2");
    expect(card?.querySelector("pre")?.textContent).toContain("npx playwright install");
    expect(button("拒绝并返回领队", card as ParentNode)).toBeTruthy();
    expect(button("批准并继续原 Run", card as ParentNode)).toBeTruthy();
  });

  it("keeps both actions behind an explicit confirmation dialog with zero writes before confirm", async () => {
    await act(async () => { button("批准并继续原 Run")?.click(); });
    const dialog = container.querySelector("dialog");
    expect(dialog?.textContent).toContain("确认前零写入");
    expect(dialog?.textContent).toContain("hdr-1");
    expect(decidePosts()).toHaveLength(0);
    await act(async () => { button("再想想", dialog as ParentNode)?.click(); });
    expect(container.querySelector("dialog")).toBeNull();
    expect(decidePosts()).toHaveLength(0);
    expect(container.querySelector(".human-decision-card--pending")).toBeTruthy();
  });

  it("posts the decision with feedback, refreshes the run detail, and shows the read-only history", async () => {
    const fetchesBefore = detailFetches;
    await act(async () => {
      const textarea = container.querySelector<HTMLTextAreaElement>(".human-decision-comment-field textarea");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "仅限锁定版本");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("批准并继续原 Run")?.click(); });
    const dialog = container.querySelector("dialog");
    expect(dialog?.textContent).toContain("仅限锁定版本");
    await act(async () => {
      button("确认批准", dialog as ParentNode)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    expect(decidePosts()).toHaveLength(1);
    expect(JSON.parse(String((decidePosts()[0][1] as RequestInit).body))).toEqual({
      decision: "approve",
      decidedBy: "workbench-operator",
      comment: "仅限锁定版本"
    });
    expect(container.querySelector("dialog")).toBeNull();
    expect(detailFetches).toBeGreaterThan(fetchesBefore);
    const history = container.querySelector(".human-decision-card--approved");
    expect(history?.textContent).toContain("已批准");
    expect(history?.textContent).toContain("workbench-operator");
    expect(history?.textContent).toContain("仅限锁定版本");
    expect(container.querySelector(".human-decision-card--pending")).toBeNull();
  });

  it("keeps the dialog, feedback, and retry path when the decide call fails", async () => {
    decideFailures = 1;
    await act(async () => {
      const textarea = container.querySelector<HTMLTextAreaElement>(".human-decision-comment-field textarea");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "风险太高");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("拒绝并返回领队")?.click(); });
    let dialog = container.querySelector("dialog");
    await act(async () => {
      button("确认拒绝", dialog as ParentNode)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    dialog = container.querySelector("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain("daemon 写入失败");
    expect(container.querySelector<HTMLTextAreaElement>(".human-decision-comment-field textarea")?.value).toBe("风险太高");
    await act(async () => {
      button("确认拒绝", dialog as ParentNode)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    expect(decidePosts()).toHaveLength(2);
    expect(JSON.parse(String((decidePosts()[1][1] as RequestInit).body))).toEqual({
      decision: "reject",
      decidedBy: "workbench-operator",
      comment: "风险太高"
    });
    expect(container.querySelector(".human-decision-card--rejected")?.textContent).toContain("已拒绝");
  });

  it("renders a concise empty state when the run has no human-decision requests", async () => {
    requests = [];
    act(() => root.render(<RunsPage notify={notify} activityRevision="rev-empty" />));
    await flush();
    expect(container.textContent).toContain("本 Run 没有人在回路请求。");
    expect(container.querySelector(".human-decision-card")).toBeNull();
  });

  it("renders voided requests as read-only history without action buttons", async () => {
    requests = [humanDecisionRequest({ id: "hdr-void", status: "voided", updatedAt: "2026-08-09T01:08:00.000Z" })];
    act(() => root.render(<RunsPage notify={notify} activityRevision="rev-void" />));
    await flush();
    const card = container.querySelector(".human-decision-card--voided");
    expect(card?.textContent).toContain("已作废");
    expect(card?.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("sortHumanDecisionRequests", () => {
  it("pins pending requests first, then newest first", () => {
    const sorted = sortHumanDecisionRequests([
      humanDecisionRequest({ id: "old-approved", status: "approved", createdAt: "2026-08-09T00:01:00.000Z" }),
      humanDecisionRequest({ id: "pending-old", createdAt: "2026-08-09T00:02:00.000Z" }),
      humanDecisionRequest({ id: "new-approved", status: "rejected", createdAt: "2026-08-09T00:03:00.000Z" }),
      humanDecisionRequest({ id: "pending-new", createdAt: "2026-08-09T00:04:00.000Z" })
    ]).map((request) => request.id);
    expect(sorted).toEqual(["pending-new", "pending-old", "new-approved", "old-approved"]);
  });
});

describe("filterRuns", () => {
  it("filters by category and project", () => {
    expect(filterRuns(runs, { category: "single", project: "all" }).map((run) => run.id)).toEqual(["run-single-1"]);
    expect(filterRuns(runs, { category: "all", project: "other-project" }).map((run) => run.id)).toEqual(["run-sup-1"]);
    expect(filterRuns(runs, { category: "all", project: "none" }).map((run) => run.id)).toEqual(["run-graph-1"]);
    expect(filterRuns(runs, { category: "all", project: "all" })).toHaveLength(3);
  });

  it("treats a missing category as graph", () => {
    const legacy: Run[] = [{ id: "legacy", workflow: "w", architecture: "graph", artifactDir: "/x", status: "passed", createdAt: "2026-08-06T00:00:00.000Z", nodes: {} }];
    expect(filterRuns(legacy, { category: "graph", project: "all" }).map((run) => run.id)).toEqual(["legacy"]);
    expect(filterRuns(legacy, { category: "single", project: "all" })).toHaveLength(0);
  });
});
