/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequirementDetailPage } from "./RequirementDetailPage";
import { createDashboardService } from "./dashboard/service";
import type { RequirementAdvancementGateway } from "./requirementAdvancement";
import type { EntrancePolicy, EntrancePolicyDecision, InvocationRecord, ManagementPolicy, Project, Workflow } from "./types";

const project: Project = {
  id: "project-1",
  version: 1,
  status: "active",
  name: "推进项目",
  description: "test",
  scope: "repository",
  rootPath: "/workspace/project-1",
  descriptorPath: "/workspace/project-1/multi-agent.project.yaml",
  connector: {
    kind: "repository-development",
    config: {
      requirementAdvancement: {
        entrancePolicyId: "default-task-entrance-policy",
        polling: { enabled: false, intervalMs: 15_000 }
      }
    }
  },
  roles: [],
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z"
};

const entrancePolicy = {
  id: "default-task-entrance-policy",
  version: 3,
  status: "active",
  displayName: "任务入口",
  description: "route",
  specialists: {},
  rules: [],
  default: { route: "leader" },
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z"
} satisfies EntrancePolicy;

const managementPolicy = {
  id: "safe-management",
  version: 5,
  status: "active",
  displayName: "安全策略",
  description: "worktree",
  allowedRoleIds: ["frontend", "test", "audit"],
  instructions: "Follow gates.",
  limits: { maxRounds: 8, maxDelegations: 20, maxParallelDelegations: 4 },
  failure: { workerFailure: "observe-and-replan" },
  completion: { requireDelegation: true, requireAllDelegationsSuccessful: true },
  execution: { isolation: "worktree" },
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z"
} satisfies ManagementPolicy;

const workflow = {
  id: "safe-supervisor",
  version: 10,
  status: "active",
  description: "safe leader",
  architecture: "supervisor",
  updatePolicy: "latest",
  supervisor: { employeeId: "leader", employeeVersion: 1 },
  orchestrationSkill: { id: "lead", version: 1 },
  managementPolicy: { id: managementPolicy.id, version: managementPolicy.version },
  members: [],
  flow: {
    version: 1,
    stages: [],
    gates: [
      { id: "test", requiredCapability: "quality.test", mode: "before-completion", required: true, instructions: "test", fallback: "block", validatorId: "e2e-evidence" },
      { id: "audit", requiredCapability: "quality.audit", mode: "before-completion", required: true, instructions: "audit", fallback: "block" }
    ]
  },
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z"
} satisfies Workflow;

const decision: EntrancePolicyDecision = {
  policyId: entrancePolicy.id,
  policyVersion: entrancePolicy.version,
  result: { route: "leader" },
  decidedBy: "default",
  target: { kind: "supervisor-workflow", workflowId: workflow.id, workflowVersion: workflow.version },
  executable: true,
  warnings: []
};

function invocation(): InvocationRecord {
  return {
    id: "inv-1",
    target: { kind: "workflow", id: workflow.id, version: workflow.version },
    source: { kind: "workbench", taskId: "req-1", idempotencyKey: "requirement:req-1:advance:1" },
    status: "queued",
    phase: "queued",
    requestSummary: "推进需求",
    runId: "run-1",
    sessionId: "session-1",
    instanceIds: [],
    createdAt: "2026-08-10T01:00:00.000Z",
    updatedAt: "2026-08-10T01:00:00.000Z",
    transitions: []
  };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  return found;
}

describe("RequirementDetailPage advancement launch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) { this.setAttribute("open", ""); }
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) { this.removeAttribute("open"); }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("shows a prominent start action, confirms the safe route, then persists one queued Run", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", now: () => new Date("2026-08-10T01:00:00.000Z"), idSeed: () => "req-1" });
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "推进需求",
      summary: "需要真实 Agent 执行",
      priority: "high",
      rawRequirement: "请实现开始推进",
      acceptanceCriteria: ["能创建一个真实 Run"]
    });
    const evaluate = vi.fn<RequirementAdvancementGateway["evaluate"]>().mockResolvedValue(decision);
    const dispatch = vi.fn<RequirementAdvancementGateway["dispatch"]>().mockResolvedValue({ invocation: invocation(), runId: "run-1", leaderSessionId: "session-1" });
    const gateway: RequirementAdvancementGateway = { evaluate, dispatch };

    act(() => root.render(<RequirementDetailPage
      requirementId={requirement.id}
      go={vi.fn()}
      notify={vi.fn()}
      service={service}
      projects={[project]}
      entrancePolicies={[entrancePolicy]}
      workflows={[workflow]}
      managementPolicies={[managementPolicy]}
      gateway={gateway}
      onOpenRun={vi.fn()}
    />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(button("开始推进").disabled).toBe(false);
    await act(async () => { button("开始推进").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("safe-supervisor · v10");
    expect(document.body.textContent).toContain("启动门禁通过");

    await act(async () => { button("确认并开始推进").click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![1].source).toMatchObject({
      taskId: requirement.id,
      idempotencyKey: `requirement:${requirement.id}:advance:1`
    });
    expect(await service.getRequirement(requirement.id)).toMatchObject({
      lane: "queued",
      advancement: { invocationId: "inv-1", runId: "run-1", status: "queued" }
    });
    expect(button("查看 Run 与证据")).toBeTruthy();
  });
});
