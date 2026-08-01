import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EmployeePage } from "./EmployeePage";
import type { Bootstrap, Employee, Skill } from "./types";

const timestamp = "2026-07-31T00:00:00.000Z";

const humanizer: Skill = {
  id: "humanizer-zh",
  version: 1,
  status: "active",
  displayName: "Humanizer-zh",
  description: "Naturalize Chinese copy.",
  instructions: "Preserve facts and edit the copy.",
  tools: [],
  createdAt: timestamp,
  updatedAt: timestamp
};

const employee: Employee = {
  id: "product-manager",
  version: 1,
  status: "active",
  identity: {
    displayName: "Product Manager",
    background: "Product management",
    responsibilities: ["Define requirements"]
  },
  description: "Defines products.",
  systemPrompt: "Act as a product manager.",
  requestPrompt: "Return a product specification.",
  skills: [{ id: humanizer.id, config: {}, enabled: true }],
  skillVersions: { [humanizer.id]: 1 },
  knowledgeProfileIds: ["product-knowledge"],
  providerId: "mock",
  outputSchema: { type: "object" },
  maxAttempts: 1,
  permissions: { write: "none", tools: [] },
  contextPolicy: { historyLimit: 20 },
  presentation: {},
  createdAt: timestamp,
  updatedAt: timestamp
};

const bootstrap: Bootstrap = {
  providers: [{ id: "mock", definition: { adapter: "mock", model: "deterministic-mock" } }],
  skills: [humanizer],
  knowledgeProfiles: [{
    id: "product-knowledge",
    version: 1,
    status: "active",
    displayName: "产品知识",
    description: "Product evidence.",
    rules: [{
      id: "product",
      selector: { domains: ["product"] },
      activation: "core",
      priority: 10,
      required: false,
      budget: { maxCollections: 1, maxChunks: 3, maxTokens: 1200 }
    }],
    createdAt: timestamp,
    updatedAt: timestamp
  }],
  architectureTemplates: [],
  employees: [employee],
  workflows: [],
  sessions: [],
  publications: [],
  projects: [],
  projectBindings: [],
  activity: { invocations: [], instances: [] }
};

describe("Employee Skill actions", () => {
  it("exposes separate add-from-pool and manage-binding entries", () => {
    const html = renderToStaticMarkup(<EmployeePage data={bootstrap} refresh={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("从技能池添加");
    expect(html).toContain("管理绑定");
    expect(html).toContain("知识 Profile");
    expect(html).toContain("产品知识");
    expect(html).toContain("知识试跑");
  });
});
