/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsPage, filterRuns } from "./RunsPage";
import type { Run } from "./types";

const runs: Run[] = [
  { id: "run-single-1", workflow: "direct-alice", architecture: "graph", artifactDir: "/a", status: "passed", createdAt: "2026-08-06T03:00:00.000Z", nodes: {}, category: "single", project: "demo-project", trigger: "mcp" },
  { id: "run-graph-1", workflow: "graph-flow", architecture: "graph", artifactDir: "/b", status: "passed", createdAt: "2026-08-06T02:00:00.000Z", nodes: {}, category: "graph", trigger: "workbench" },
  { id: "run-sup-1", workflow: "team-flow", architecture: "supervisor", artifactDir: "/c", status: "blocked", createdAt: "2026-08-06T01:00:00.000Z", nodes: {}, category: "supervisor", project: "other-project", trigger: "http" }
];

describe("RunsPage classification filters", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: runs }) });
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
