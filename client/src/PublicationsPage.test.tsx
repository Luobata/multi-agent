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
});
