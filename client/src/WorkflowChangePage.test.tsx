import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkflowChangePage, gateUpdateDiff } from "./WorkflowChangePage.js";
import type { Bootstrap, SupervisorGate, SupervisorWorkflow, WorkflowChangeRequest } from "./types.js";

const timestamp = "2026-08-01T00:00:00.000Z";

const existingGate: SupervisorGate = {
  id: "quality-gate",
  requiredCapability: "quality.test",
  mode: "before-completion",
  required: false,
  instructions: "旧的验证说明。",
  fallback: "supervisor"
};

const supervisorWorkflow: SupervisorWorkflow = {
  id: "review-supervisor",
  version: 3,
  status: "active",
  architecture: "supervisor",
  updatePolicy: "latest",
  description: "评审领队团队。",
  supervisor: { employeeId: "lead", employeeVersion: 1 },
  orchestrationSkill: { id: "orchestration", version: 1 },
  managementPolicy: { id: "review-policy", version: 1 },
  members: [],
  flow: { version: 1, stages: [], gates: [existingGate] },
  createdAt: timestamp,
  updatedAt: timestamp
};

const addChange: WorkflowChangeRequest = {
  id: "wc-add-1",
  workflowId: "review-supervisor",
  workflowVersion: 3,
  status: "awaiting-approval",
  title: "新增端到端验证门禁",
  reason: "上线前必须校验 e2e 证据。",
  requestedBy: "gate-steward",
  operations: [{
    kind: "add-gate",
    gate: {
      id: "e2e-gate",
      requiredCapability: "quality.test",
      mode: "before-completion",
      required: true,
      instructions: "运行端到端测试并附上证据。",
      fallback: "supervisor",
      validatorId: "e2e-evidence"
    },
    rationale: "缺少端到端硬门禁。",
    risk: "high"
  }],
  createdAt: timestamp,
  updatedAt: timestamp
};

const updateChange: WorkflowChangeRequest = {
  id: "wc-update-1",
  workflowId: "review-supervisor",
  workflowVersion: 3,
  status: "applied",
  title: "收紧质量门禁",
  reason: "质量门禁需从可选升级为硬门禁。",
  requestedBy: "gate-steward",
  operations: [{
    kind: "update-gate",
    gateId: "quality-gate",
    patch: { required: true, instructions: "新的验证说明。" },
    rationale: "必须阻止未验证的交付。",
    risk: "critical"
  }],
  review: { actor: "local-owner", comment: "同意收紧。", at: "2026-08-02T09:00:00.000Z" },
  createdAt: timestamp,
  updatedAt: "2026-08-02T09:00:00.000Z"
};

function changeBootstrap(changes: WorkflowChangeRequest[]): Bootstrap {
  return {
    providers: [],
    skills: [],
    architectureTemplates: [],
    employees: [],
    workflows: [supervisorWorkflow],
    sessions: [],
    publications: [],
    projects: [],
    projectBindings: [],
    activity: { invocations: [], instances: [] },
    workflowChanges: changes
  };
}

describe("gateUpdateDiff", () => {
  it("pairs each patched field with its prior value from the frozen gate", () => {
    const diff = gateUpdateDiff(existingGate, { required: true, instructions: "新的验证说明。" });
    expect(diff).toEqual([
      { field: "required", before: "false", after: "true" },
      { field: "instructions", before: "旧的验证说明。", after: "新的验证说明。" }
    ]);
  });

  it("marks unknown prior fields as absent when the gate is missing", () => {
    const diff = gateUpdateDiff(undefined, { required: true });
    expect(diff).toEqual([{ field: "required", before: "—", after: "true" }]);
  });
});

describe("WorkflowChangePage read-only viewer", () => {
  it("lists each change with target workflow, frozen version, status, requester and time", () => {
    const html = renderToStaticMarkup(<WorkflowChangePage data={changeBootstrap([addChange, updateChange])} />);

    expect(html).toContain("门禁变更");
    expect(html).toContain("新增端到端验证门禁");
    expect(html).toContain("review-supervisor");
    expect(html).toContain("冻结 v3");
    expect(html).toContain("待人工批准");
    expect(html).toContain("已应用");
    expect(html).toContain("gate-steward");
  });

  it("renders an add-gate operation with readable gate fields, rationale and risk", () => {
    const html = renderToStaticMarkup(<WorkflowChangePage data={changeBootstrap([addChange])} />);

    expect(html).toContain("新增门禁");
    expect(html).toContain("e2e-gate");
    expect(html).toContain("quality.test");
    expect(html).toContain("运行端到端测试并附上证据。");
    expect(html).toContain("e2e-evidence");
    expect(html).toContain("缺少端到端硬门禁。");
    expect(html).toContain("风险 高");
  });

  it("renders an update-gate operation as a before/after field diff", () => {
    const html = renderToStaticMarkup(<WorkflowChangePage data={changeBootstrap([updateChange])} />);

    expect(html).toContain("修改门禁");
    expect(html).toContain("quality-gate");
    expect(html).toContain("旧的验证说明。");
    expect(html).toContain("新的验证说明。");
    // before/after arrow marker
    expect(html).toContain("→");
    expect(html).toContain("必须阻止未验证的交付。");
    expect(html).toContain("风险 严重");
  });

  it("shows the human review record with actor, comment and time", () => {
    const html = renderToStaticMarkup(<WorkflowChangePage data={changeBootstrap([updateChange])} />);

    expect(html).toContain("审批记录");
    expect(html).toContain("local-owner");
    expect(html).toContain("同意收紧。");
  });

  it("never renders approve, reject or apply write controls", () => {
    const html = renderToStaticMarkup(<WorkflowChangePage data={changeBootstrap([addChange, updateChange])} />);

    expect(html).not.toContain("批准并执行");
    expect(html).not.toContain("应用变更");
    // A read-only viewer renders no interactive controls at all.
    expect(html).not.toContain("<button");
  });

  it("shows an empty state when there are no workflow change requests", () => {
    const html = renderToStaticMarkup(<WorkflowChangePage data={changeBootstrap([])} />);

    expect(html).toContain("暂无门禁变更提案");
  });
});
