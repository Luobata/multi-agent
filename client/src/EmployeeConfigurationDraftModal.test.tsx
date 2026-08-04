/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EmployeeConfigurationDraftModal } from "./EmployeeConfigurationDraftModal";
import { DaemonGate } from "./components";
import type { Bootstrap, ConfigurationProposal, Employee } from "./types";

const timestamp = "2026-08-04T00:00:00.000Z";
const employee: Employee = {
  id: "draft-target",
  version: 3,
  status: "active",
  identity: { displayName: "Draft Target", background: "Current background.", responsibilities: ["Deliver"] },
  description: "Current profile.",
  systemPrompt: "Current system.",
  requestPrompt: "Current request.",
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

const proposal: ConfigurationProposal = {
  id: "cp-review",
  status: "awaiting-review",
  title: "聚焦提示词",
  reason: "让输出保留证据边界。",
  employeeId: employee.id,
  expectedEmployeeVersion: 3,
  operations: [{
    type: "prompts.set",
    rationale: "明确证据要求。",
    risk: "medium",
    payload: { systemPrompt: "Preserve evidence.", requestPrompt: "Return JSON." }
  }],
  reviewItems: [{
    id: "review-01-prompts",
    operationIndex: 0,
    operationType: "prompts.set",
    label: "提示词",
    rationale: "明确证据要求。",
    risk: "medium",
    before: { systemPrompt: "Current system.", requestPrompt: "Current request." },
    after: { systemPrompt: "Preserve evidence.", requestPrompt: "Return JSON." }
  }],
  decisions: [],
  progress: { total: 1, reviewed: 0, accepted: 0, rejected: 0, pending: 1 },
  reviewRevision: 0,
  reviewHash: "def456abc123",
  source: {
    kind: "ai-generated",
    invocationId: "inv-configuration-control",
    projectId: "local-agent-workbench",
    projectVersion: 4,
    projectRoleId: "configuration-steward",
    projectBindingVersion: 7,
    employeeId: "configuration-steward",
    employeeVersion: 2,
    requestedBy: "configuration-steward",
    sessionId: "session-configuration-control",
    runId: "run-configuration-control"
  },
  planHash: "abc123def456",
  validation: { valid: true, errors: [] },
  createdAt: timestamp,
  updatedAt: timestamp
};

const data: Bootstrap = {
  providers: [{ id: "mock", definition: { adapter: "mock" } }],
  skills: [],
  configurationProposals: [proposal],
  architectureTemplates: [],
  employees: [employee, { ...employee, id: "configuration-steward", identity: { ...employee.identity, displayName: "Configuration Steward" } }],
  workflows: [],
  sessions: [],
  publications: [],
  projects: [{
    id: "local-agent-workbench",
    version: 4,
    status: "active",
    name: "Local Agent Workbench",
    description: "Workbench.",
    scope: "repository",
    rootPath: "/repo",
    descriptorPath: "/repo/multi-agent.project.yaml",
    connector: { kind: "repository-development", config: {} },
    roles: [{
      id: "configuration-steward",
      displayName: "员工配置管家",
      description: "Draft configurations.",
      requiredSkills: [],
      optionalSkills: [],
      knowledgeProfileIds: [],
      instructions: "Use governed tools."
    }],
    createdAt: timestamp,
    updatedAt: timestamp
  }],
  projectBindings: [{
    projectId: "local-agent-workbench",
    projectVersion: 4,
    version: 7,
    roles: [{
      roleId: "configuration-steward",
      employeeId: "configuration-steward",
      employeeVersion: 2,
      skills: [],
      skillVersions: {},
      knowledgeProfileIds: [],
      updatePolicy: "locked"
    }],
    createdAt: timestamp,
    updatedAt: timestamp
  }],
  activity: { invocations: [], instances: [] }
};

describe("Employee configuration drafting modal", () => {
  it("shows AI provenance, version, risk, progress, per-item decisions, and no bulk accept action", () => {
    const html = renderToStaticMarkup(<EmployeeConfigurationDraftModal employee={employee} data={data} refresh={vi.fn()} notify={vi.fn()} onClose={vi.fn()} />);

    expect(html).toContain("AI 生成提案");
    expect(html).toContain("local-agent-workbench/configuration-steward");
    expect(html).toContain("expected v3");
    expect(html).toContain("中风险");
    expect(html).toContain("0/1");
    expect(html).toContain("BEFORE · 当前值");
    expect(html).toContain("AFTER · AI 建议");
    expect(html).toContain("拒绝此项");
    expect(html).toContain("接受此项");
    expect(html).toContain("显式应用为 v4");
    expect(html).not.toMatch(/<button[^>]*>[^<]*(全部接受|一键接受)[^<]*<\/button>/);
  });

  it("keeps proposal evidence readable while daemon-offline write controls are disabled with text status", () => {
    const html = renderToStaticMarkup(<DaemonGate status="offline"><EmployeeConfigurationDraftModal employee={employee} data={data} refresh={vi.fn()} notify={vi.fn()} onClose={vi.fn()} /></DaemonGate>);

    expect(html).toContain("daemon 离线：历史可读，不能发送或写入");
    expect(html).toContain("Preserve evidence");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>接受此项<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>显式应用为 v4<\/button>/);
  });

  it("only reuses configuration-steward sessions that target the current Employee", () => {
    const sessionBase = {
      employeeId: "configuration-steward",
      employeeVersion: 2,
      assignment: {
        projectId: "local-agent-workbench",
        projectVersion: 4,
        projectBindingVersion: 7,
        roleId: "configuration-steward"
      },
      title: "配置对话",
      status: "active" as const,
      createdAt: timestamp
    };
    const scopedData: Bootstrap = {
      ...data,
      sessions: [{
        ...sessionBase,
        id: "session-other-employee",
        context: { kind: "employee-configuration", employeeId: "another-employee", expectedEmployeeVersion: 1 },
        messages: [
          { id: "foreign-user", role: "user", content: "[Employee target: another-employee · expected v1]\nForeign target request", at: timestamp },
          { id: "foreign-ai", role: "employee", content: "FOREIGN_EMPLOYEE_CONTEXT", at: timestamp }
        ],
        updatedAt: "2026-08-04T02:00:00.000Z"
      }, {
        ...sessionBase,
        id: "session-current-employee",
        context: { kind: "employee-configuration", employeeId: "draft-target", expectedEmployeeVersion: 3 },
        messages: [
          { id: "target-user", role: "user", content: "[Employee target: draft-target · expected v3]\nCurrent target request", at: timestamp },
          { id: "target-ai", role: "employee", content: "CURRENT_EMPLOYEE_CONTEXT", at: timestamp }
        ],
        updatedAt: "2026-08-04T01:00:00.000Z"
      }]
    };

    const html = renderToStaticMarkup(<EmployeeConfigurationDraftModal employee={employee} data={scopedData} refresh={vi.fn()} notify={vi.fn()} onClose={vi.fn()} />);

    expect(html).toContain("CURRENT_EMPLOYEE_CONTEXT");
    expect(html).not.toContain("FOREIGN_EMPLOYEE_CONTEXT");
  });
});
