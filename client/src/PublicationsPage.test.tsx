/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicationsPage } from "./PublicationsPage";
import type { Bootstrap, Employee } from "./types";

const timestamp = "2026-08-03T00:00:00.000Z";

function employee(id: string, displayName: string, metadata?: Record<string, string>): Employee {
  return {
    id,
    version: 1,
    status: "active",
    identity: {
      displayName,
      background: "Test background",
      responsibilities: ["Test responsibility"],
      ...(metadata ? { metadata } : {})
    },
    description: "Test employee.",
    systemPrompt: "Test.",
    requestPrompt: "Return evidence.",
    capabilities: [],
    scope: { kind: "global" },
    skills: [],
    skillVersions: {},
    providerId: "mock",
    outputSchema: { type: "object" },
    maxAttempts: 1,
    permissions: { write: "none", tools: [] },
    contextPolicy: { historyLimit: 20 },
    presentation: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

const data: Bootstrap = {
  providers: [{ id: "mock", definition: { adapter: "mock", model: "deterministic-mock" } }],
  skills: [],
  knowledgeBases: [],
  knowledgeProfiles: [],
  architectureTemplates: [],
  employees: [
    employee("product-manager", "普通员工"),
    employee("knowledge-steward", "小知 · 项目知识管理员", {
      internalProjectId: "local-agent-workbench",
      internalProjectRoleId: "knowledge-steward"
    })
  ],
  workflows: [],
  sessions: [],
  publications: [],
  projects: [],
  projectBindings: [],
  activity: { invocations: [], instances: [] }
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("Publication Employee targets", () => {
  it("excludes system Employees from external publication choices", () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    HTMLDialogElement.prototype.close = function close() { this.open = false; };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(<PublicationsPage data={data} refresh={vi.fn()} notify={vi.fn()} />));
    const createButton = container.querySelector<HTMLButtonElement>('button[aria-label="新建调用包"]');
    act(() => createButton?.click());
    const targetSelect = container.querySelector<HTMLButtonElement>('button[aria-label="调用包目标"]');
    act(() => targetSelect?.click());

    const optionText = Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent ?? "").join("\n");
    expect(optionText).toContain("普通员工");
    expect(optionText).not.toContain("小知 · 项目知识管理员");

    act(() => root.unmount());
  });

  it("recommends asynchronous start and durable monitoring for Workflow publications", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })));
    const workflowData: Bootstrap = {
      ...data,
      workflows: [{
        id: "review-team",
        version: 1,
        status: "active",
        architecture: "graph",
        description: "Review changes.",
        nodes: [],
        maxConcurrency: 2,
        failFast: false,
        createdAt: timestamp,
        updatedAt: timestamp
      }],
      publications: [{
        id: "review-package",
        version: 1,
        status: "active",
        name: "Review Package",
        description: "Stable review workflow package.",
        target: { kind: "workflow", id: "review-team" },
        createdAt: timestamp,
        updatedAt: timestamp
      }]
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<PublicationsPage data={workflowData} refresh={vi.fn()} notify={vi.fn()} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('"tool": "start_publication"');
    expect(container.textContent).toContain("循环调用 wait_workflow_progress");
    expect(container.textContent).toContain("resume_workflow_monitor(runId)");
    expect(container.textContent).toContain("/api/publications/review-package/start");

    act(() => root.unmount());
  });
});
