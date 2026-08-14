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
        candidateUrl: "http://127.0.0.1:4319",
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
    vi.unstubAllGlobals();
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
    expect(evaluate.mock.calls[0]![1]).not.toHaveProperty("candidateUrl");
    expect(dispatch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("safe-supervisor · v10");
    expect(document.body.textContent).toContain("启动门禁通过");

    await act(async () => { button("确认并开始推进").click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![1]).toMatchObject({ candidateUrl: "http://127.0.0.1:4319" });
    expect(dispatch.mock.calls[0]![1].source).toMatchObject({
      taskId: requirement.id
    });
    expect(dispatch.mock.calls[0]![1].source.idempotencyKey).toMatch(
      new RegExp(`^requirement:${project.id}:${requirement.id}:advance:1:`)
    );
    expect(dispatch.mock.calls[0]![1].source.contextId).toBe(
      `requirement-run:${dispatch.mock.calls[0]![1].source.idempotencyKey}`
    );
    expect(await service.getRequirement(requirement.id)).toMatchObject({
      lane: "queued",
      advancement: { invocationId: "inv-1", runId: "run-1", status: "queued" }
    });
    expect(button("查看 Run 与证据")).toBeTruthy();
  });

  it("refreshes a stale entrance-policy team pin before showing the launch confirmation", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", idSeed: () => "req-stale-policy" });
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "入口策略自动跟随团队",
      summary: "避免旧团队版本永久阻塞",
      priority: "high",
      rawRequirement: "团队升级后仍可开始推进",
      acceptanceCriteria: ["启动前自动刷新入口策略引用"]
    });
    const staleDecision: EntrancePolicyDecision = {
      ...decision,
      target: { kind: "supervisor-workflow", workflowId: workflow.id, workflowVersion: workflow.version - 1 }
    };
    const evaluate = vi.fn<RequirementAdvancementGateway["evaluate"]>()
      .mockResolvedValueOnce(staleDecision)
      .mockResolvedValueOnce(decision);
    const refreshWorkflowReferences = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();

    act(() => root.render(<RequirementDetailPage
      requirementId={requirement.id}
      go={vi.fn()}
      notify={notify}
      service={service}
      projects={[project]}
      entrancePolicies={[entrancePolicy]}
      workflows={[workflow]}
      managementPolicies={[managementPolicy]}
      gateway={{ evaluate, dispatch: vi.fn(), refreshWorkflowReferences }}
    />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { button("开始推进").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(refreshWorkflowReferences).toHaveBeenCalledWith(workflow.id);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(`${workflow.id} · v${workflow.version}`);
    expect(document.body.textContent).toContain("启动门禁通过");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(`v${workflow.version}`));
  });

  it("keeps lifecycle sections inside one deep-linked requirement dossier", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", idSeed: () => "req-section" });
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id, title: "连续需求卷宗", summary: "不再跨页寻找上下文", priority: "medium",
      rawRequirement: "把需求和验收放在同一处", acceptanceCriteria: ["刷新仍位于相同分区"]
    });
    const go = vi.fn();
    act(() => root.render(<RequirementDetailPage requirementId={requirement.id} section="run" go={go} notify={vi.fn()} service={service} projects={[project]} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector(".requirement-lifecycle-nav")?.textContent).toContain("需求定义");
    expect(container.textContent).toContain("尚未绑定 Run");
    act(() => button("验收与合入").click());
    expect(go).toHaveBeenCalledWith(`requirements/${requirement.id}?section=acceptance`);
  });

  it("pins the acceptance section and standalone dossier to the fixed acceptance Run", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", now: () => new Date("2026-08-10T03:00:00.000Z"), idSeed: () => "req-fixed-run" });
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id, title: "固定验收卷宗", summary: "验收与后续推进分离", priority: "high",
      rawRequirement: "固定验收 Run", acceptanceCriteria: ["验收区不漂移"]
    });
    const config = { entrancePolicyId: entrancePolicy.id, autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await service.reserveRequirementAdvancement(requirement.id, config, "human");
    await service.syncRequirementAdvancement(requirement.id, reserved.idempotencyKey, {
      invocationId: "inv-new", runId: "run-new", status: "completed", observedAt: "2026-08-10T03:00:01.000Z"
    }, config.pollIntervalMs);
    await service.submitRequirementForAcceptance(requirement.id, {
      runId: "run-accepted", eligible: true, diffFiles: ["client/src/App.tsx"], structuredE2eCount: 1, mediaCount: 0,
      capturedAt: "2026-08-10T03:00:02.000Z",
      testGate: { gateId: "test", status: "passed" }, reviewGate: { gateId: "audit", status: "passed" },
      source: { kind: "worktree", worktreePath: "/tmp/run-accepted" }
    });
    const go = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    act(() => root.render(<RequirementDetailPage requirementId={requirement.id} section="acceptance" go={go} notify={vi.fn()} service={service} projects={[project]} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(container.textContent).toContain("验收 Run 与最新推进 Run 不同");
    expect(container.textContent).toContain("run-accepted");
    expect(container.textContent).toContain("run-new");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/runs/run-accepted"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/runs/run-new"))).toBe(false);
    act(() => button("独立运行卷宗").click());
    expect(go).toHaveBeenCalledWith("runs?run=run-accepted");
  });

  it("explains the pending decision and opens the exact Run as the primary action", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", now: () => new Date("2026-08-10T02:00:00.000Z"), idSeed: () => "req-confirm" });
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "高风险修改确认",
      summary: "等待人工批准",
      priority: "high",
      rawRequirement: "需要安装依赖",
      acceptanceCriteria: ["批准后继续原 Run"]
    });
    const config = { entrancePolicyId: entrancePolicy.id, autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await service.reserveRequirementAdvancement(requirement.id, config, "human");
    await service.syncRequirementAdvancement(requirement.id, reserved.idempotencyKey, {
      invocationId: "inv-confirm",
      runId: "run-confirm",
      status: "awaiting-human-decision",
      observedAt: "2026-08-10T02:00:01.000Z"
    }, config.pollIntervalMs);
    const onOpenRun = vi.fn();

    act(() => root.render(<RequirementDetailPage
      requirementId={requirement.id}
      go={vi.fn()}
      notify={vi.fn()}
      service={service}
      projects={[project]}
      entrancePolicies={[entrancePolicy]}
      workflows={[workflow]}
      managementPolicies={[managementPolicy]}
      onOpenRun={onOpenRun}
    />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(container.querySelector(".dash-confirmation-guide")?.textContent).toContain("这个 Run 已暂停，正在等你");
    expect(container.querySelector(".dash-confirmation-guide")?.textContent).toContain("批准或拒绝");
    await act(async () => { button("查看问题并作决定").click(); });
    expect(onOpenRun).toHaveBeenCalledWith("run-confirm");
  });

  it("offers a new governed cycle after the previous Run failed", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", now: () => new Date("2026-08-10T01:00:00.000Z"), idSeed: () => "req-retry" });
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "失败后重试",
      summary: "保留上次 Run",
      priority: "high",
      rawRequirement: "修复执行根后重试",
      acceptanceCriteria: ["产生新的推进轮次"]
    });
    const config = { entrancePolicyId: entrancePolicy.id, autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await service.reserveRequirementAdvancement(requirement.id, config, "human");
    await service.syncRequirementAdvancement(requirement.id, reserved.idempotencyKey, {
      invocationId: "inv-failed",
      runId: "run-failed",
      status: "failed",
      observedAt: "2026-08-10T01:00:01.000Z",
      error: "worktree setup failed"
    }, config.pollIntervalMs);
    const gateway: RequirementAdvancementGateway = {
      evaluate: vi.fn().mockResolvedValue(decision),
      dispatch: vi.fn()
    };

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

    expect(button("查看上次 Run")).toBeTruthy();
    expect(button("重新推进").disabled).toBe(false);
    await act(async () => { button("重新推进").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(gateway.evaluate).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("启动门禁通过");
  });

  it("offers the previous Run and a new launch for a governance-cancelled Invocation cycle", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", idSeed: () => "req-cancelled" });
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "取消后恢复",
      summary: "错误 Gate 证据导致取消",
      priority: "high",
      rawRequirement: "修正证据后重新推进",
      acceptanceCriteria: ["创建下一推进周期"]
    });
    const config = { entrancePolicyId: entrancePolicy.id, autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await service.reserveRequirementAdvancement(requirement.id, config, "human");
    await service.syncRequirementAdvancement(requirement.id, reserved.idempotencyKey, {
      invocationId: "inv-cancelled",
      runId: "run-cancelled",
      status: "cancelled",
      observedAt: "2026-08-10T01:00:01.000Z"
    }, config.pollIntervalMs);
    const gateway: RequirementAdvancementGateway = {
      evaluate: vi.fn().mockResolvedValue(decision),
      dispatch: vi.fn()
    };

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

    expect(button("查看上次 Run")).toBeTruthy();
    expect(button("重新推进").disabled).toBe(false);
    await act(async () => { button("重新推进").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(gateway.evaluate).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("启动门禁通过");
    expect(document.body.textContent).toContain("已取消的需求不能迁移列");
  });

  it("shows the exact blocked Run reason and whether test gates were reached in every dossier section", async () => {
    const service = createDashboardService({ delayMs: () => 0, initialData: "empty", now: () => new Date("2026-08-12T04:16:07.000Z"), idSeed: () => "req-blocked" });
    service.syncConnectedProjects([project]);
    const requirement = await service.createRequirement({
      projectId: project.id,
      title: "编排协议阻塞",
      summary: "需要在详情看见真实原因",
      priority: "high",
      rawRequirement: "显示动态 TODO 委派错误",
      acceptanceCriteria: ["详情直接展示原始阻塞原因和测试状态"]
    });
    const config = { entrancePolicyId: entrancePolicy.id, autoPollEnabled: false, pollIntervalMs: 15_000 };
    const reserved = await service.reserveRequirementAdvancement(requirement.id, config, "human");
    await service.syncRequirementAdvancement(requirement.id, reserved.idempotencyKey, {
      invocationId: "inv-blocked",
      runId: "run-blocked",
      status: "blocked",
      observedAt: "2026-08-12T04:16:07.000Z"
    }, config.pollIntervalMs);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          status: "blocked",
          outcome: { status: "blocked", reason: "dynamic TODO delegation must specify todoId" },
          leaderReport: { gates: [{ gateId: "quality-test", status: "skipped" }, { gateId: "independent-review", status: "skipped" }] },
          steps: []
        }
      })
    }));
    const go = vi.fn();

    act(() => root.render(<RequirementDetailPage
      requirementId={requirement.id}
      section="overview"
      go={go}
      notify={vi.fn()}
      service={service}
      projects={[project]}
      entrancePolicies={[entrancePolicy]}
    />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    const callout = container.querySelector(".requirement-blocker-callout");
    expect(callout?.textContent).toContain("已找到本轮停止原因");
    expect(callout?.textContent).toContain("领队在动态委派任务时没有指出要推进的 TODO");
    expect(callout?.textContent).toContain("dynamic TODO delegation must specify todoId");
    expect(callout?.textContent).toContain("尚未执行：quality-test、independent-review");
    expect(callout?.textContent).toContain("run-blocked");

    act(() => button("查看阻塞现场与完整证据").click());
    expect(go).toHaveBeenCalledWith(`requirements/${requirement.id}?section=run`);
  });
});
