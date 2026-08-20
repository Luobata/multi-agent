import { describe, expect, it } from "vitest";
import {
  deriveHumanBarrierPolicyHash,
  requiresHumanBarrier,
  supervisorArchitectureAdapter,
  type HumanBarrierPolicy
} from "../src/architectures/supervisor.js";
import type { ArchitectureExecutionContext } from "../src/architectures/types.js";
import { ExecutionBudget } from "../src/runtime/governance.js";
import type {
  ExecutionPlan,
  ExecutionPlanNode,
  JsonValue,
  LoadedManifest,
  NodeRunResult,
  RuntimeHumanDecisionOutcome,
  RuntimeHumanDecisionRequest,
  WorkflowRunRecord
} from "../src/core/types.js";

interface TodoSpec {
  id: string;
  task: string;
  workKind: string;
  changeSet?: string;
}

function buildPlan(todos: TodoSpec[], humanBarrier: HumanBarrierPolicy | undefined): ExecutionPlan {
  return {
    architecture: "supervisor",
    workflow: "barrier-test",
    description: "B4 human-risk barrier test",
    nodes: [{
      id: "supervisor-r1",
      role: "supervisor",
      provider: "mock",
      needs: [],
      with: {},
      metadata: { kind: "supervisor", roleId: "supervisor", round: 1 }
    }],
    data: {
      supervisor: { role: "supervisor", capabilities: [] },
      policy: {
        id: "barrier-policy",
        version: 1,
        instructions: "test",
        allowedRoleIds: ["builder"],
        limits: { maxRounds: 8, maxDelegations: 8, maxParallelDelegations: 3, maxDurationMs: 60_000 },
        failure: { workerFailure: "observe-and-replan" },
        completion: { requireDelegation: false, requireAllDelegationsSuccessful: false },
        ...(humanBarrier ? { humanBarrier } : {})
      },
      members: [{
        roleId: "builder",
        role: "builder",
        employeeId: "builder-emp",
        description: "Builds",
        capabilities: ["code.backend"]
      }],
      flow: { version: 1, stages: [], gates: [] }
    }
  } as unknown as ExecutionPlan;
}

function buildManifest(): LoadedManifest {
  return {
    manifest: {
      version: 1,
      name: "barrier-manifest",
      providers: { mock: { id: "mock", adapter: "mock" } },
      roles: {
        supervisor: { identity: { id: "supervisor" }, provider: "mock", requestTemplate: "", outputSchema: "" },
        builder: { identity: { id: "builder" }, provider: "mock", requestTemplate: "", outputSchema: "" }
      },
      workflows: {}
    },
    manifestPath: "",
    projectRoot: ""
  } as unknown as LoadedManifest;
}

function buildRun(): WorkflowRunRecord {
  return {
    id: "run-barrier",
    workflow: "barrier-test",
    architecture: "supervisor",
    manifestPath: "",
    artifactDir: "",
    status: "running",
    createdAt: "2026-08-20T00:00:00.000Z",
    nodes: {}
  };
}

function planTodosDecision(todos: TodoSpec[]): JsonValue {
  return {
    action: "plan-todos",
    summary: "Plan the work",
    impact: {
      level: "low",
      regressionScope: "targeted",
      affectedAreas: ["src/feature.ts"],
      reasons: ["isolated change"],
      requiredChecks: []
    },
    todos: todos.map((todo) => ({
      id: todo.id,
      roleId: "builder",
      task: todo.task,
      needs: [],
      workKind: todo.workKind,
      ...(todo.changeSet ? { changeSet: todo.changeSet } : {})
    }))
  } as unknown as JsonValue;
}

function delegateDecision(todoId: string): JsonValue {
  return {
    action: "delegate",
    summary: `Delegate ${todoId}`,
    assignments: [{ todoId, roleId: "builder" }]
  } as unknown as JsonValue;
}

function passed(node: ExecutionPlanNode, output: JsonValue): NodeRunResult {
  return {
    nodeId: node.id,
    roleId: node.role,
    status: "passed",
    attempts: 1,
    output,
    completedAt: "2026-08-20T00:00:00.000Z"
  };
}

interface HarnessResult {
  events: Array<{ type: string; detail?: JsonValue }>;
  scheduled: string[];
  executed: string[];
  humanRequests: RuntimeHumanDecisionRequest[];
  artifacts: Record<string, unknown>;
  error: unknown;
}

async function runBarrier(
  todos: TodoSpec[],
  options: {
    humanBarrier?: HumanBarrierPolicy;
    onHumanDecision?: (request: RuntimeHumanDecisionRequest, callIndex: number) => RuntimeHumanDecisionOutcome;
    includeControlPlane?: boolean;
  } = {}
): Promise<HarnessResult> {
  const events: Array<{ type: string; detail?: JsonValue }> = [];
  const scheduled: string[] = [];
  const executed: string[] = [];
  const humanRequests: RuntimeHumanDecisionRequest[] = [];
  const artifacts: Record<string, unknown> = {};
  const budget = new ExecutionBudget({ delegations: 16, depth: 16, gates: 8 });
  let delegateRound = 0;
  const plan = buildPlan(todos, options.humanBarrier);

  const requestHumanDecision = options.includeControlPlane === false
    ? undefined
    : async (request: RuntimeHumanDecisionRequest): Promise<RuntimeHumanDecisionOutcome> => {
        humanRequests.push(request);
        const outcome = options.onHumanDecision
          ? options.onHumanDecision(request, humanRequests.length - 1)
          : { requestId: `hr-${humanRequests.length}`, decision: "approved" as const };
        return outcome;
      };

  const context: ArchitectureExecutionContext = {
    loaded: buildManifest(),
    input: {},
    plan,
    run: buildRun(),
    budget,
    scheduleNode: async (node) => {
      scheduled.push(node.id);
      if (!plan.nodes.some((candidate) => candidate.id === node.id)) plan.nodes.push(node);
    },
    executeNode: async (node) => {
      if (node.role === "supervisor") {
        const round = Number((node.metadata as { round?: number } | undefined)?.round ?? 1);
        if (round === 1) return passed(node, planTodosDecision(todos));
        if (delegateRound < todos.length) {
          const todo = todos[delegateRound]!;
          delegateRound += 1;
          return passed(node, delegateDecision(todo.id));
        }
        return passed(node, { action: "finish", summary: "Done.", result: { delivered: true } } as unknown as JsonValue);
      }
      executed.push(node.id);
      return passed(node, { message: "done" } as unknown as JsonValue);
    },
    readArtifact: (async (relativePath: string) => artifacts[relativePath] as JsonValue | undefined) as ArchitectureExecutionContext["readArtifact"],
    writeArtifact: async (relativePath, value) => { artifacts[relativePath] = value; },
    candidateSnapshot: async () => ({ revision: "r1", changedFiles: [] }) as never,
    executionRoot: () => "/repo",
    executionPackageScripts: async () => ({}),
    persist: async () => {},
    emit: async (type, _nodeId, detail) => { events.push({ type, detail: detail as JsonValue | undefined }); },
    ...(requestHumanDecision ? { requestHumanDecision } : {})
  };

  let error: unknown;
  try {
    await supervisorArchitectureAdapter.execute(context);
  } catch (caught) {
    error = caught;
  }
  return { events, scheduled, executed, humanRequests, artifacts, error };
}

const CODE_TODOS: TodoSpec[] = [
  { id: "todo-1", task: "Implement part one", workKind: "code", changeSet: "feature-x" },
  { id: "todo-2", task: "Implement part two", workKind: "code", changeSet: "feature-y" }
];

describe("B4 requiresHumanBarrier — pure function branch matrix", () => {
  const baseInput = {
    mutationResources: ["workspace-mutation:/repo"],
    workKind: "code" as string | undefined,
    changeSet: "feature-x" as string | undefined,
    gateRiskCategories: [] as Array<{ gateId: string; riskCategory?: string }>,
    policy: undefined as HumanBarrierPolicy | undefined
  };

  it("barriers a mutating code node under the default narrow policy", () => {
    const verdict = requiresHumanBarrier(baseInput);
    expect(verdict.required).toBe(true);
    expect(verdict.reasons).toContain("mutation-resource");
    expect(verdict.policyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not barrier a non-mutating discussion node", () => {
    const verdict = requiresHumanBarrier({ ...baseInput, mutationResources: [], workKind: "discussion" });
    expect(verdict.required).toBe(false);
    expect(verdict.reasons).toHaveLength(0);
  });

  it("barriers integration work even when mutation resources are narrowed away", () => {
    const verdict = requiresHumanBarrier({
      ...baseInput,
      mutationResources: ["workspace-mutation:/elsewhere"],
      workKind: "integration",
      policy: { crossRepoResourcePatterns: ["workspace-mutation:/repo"] }
    });
    expect(verdict.required).toBe(true);
    expect(verdict.reasons).toContain("integration-work");
    expect(verdict.reasons).not.toContain("mutation-resource");
  });

  it("barriers a protected changeSet target", () => {
    const verdict = requiresHumanBarrier({
      ...baseInput,
      mutationResources: [],
      workKind: "other",
      policy: { protectedTargets: ["feature-x"] }
    });
    expect(verdict.required).toBe(true);
    expect(verdict.reasons).toContain("protected-target");
  });

  it("barriers when a gate strategy declares high risk", () => {
    const verdict = requiresHumanBarrier({
      ...baseInput,
      mutationResources: [],
      workKind: "other",
      gateRiskCategories: [{ gateId: "audit", riskCategory: "high" }]
    });
    expect(verdict.required).toBe(true);
    expect(verdict.reasons).toContain("gate-high-risk");
  });

  it("does not barrier for a low-risk gate under the default [high] gate categories", () => {
    const verdict = requiresHumanBarrier({
      ...baseInput,
      mutationResources: [],
      workKind: "other",
      gateRiskCategories: [{ gateId: "audit", riskCategory: "low" }]
    });
    expect(verdict.required).toBe(false);
  });

  it("policy deny forces a barrier even when an allow pattern also matches", () => {
    const verdict = requiresHumanBarrier({
      ...baseInput,
      policy: { deny: ["feature-x"], allow: ["feature-x"] }
    });
    expect(verdict.required).toBe(true);
    expect(verdict.reasons).toEqual(["policy-deny"]);
  });

  it("policy allow exempts a mutating node from the barrier", () => {
    const verdict = requiresHumanBarrier({
      ...baseInput,
      policy: { allow: ["feature-x"] }
    });
    expect(verdict.required).toBe(false);
  });

  it("crossRepoResourcePatterns narrows which mutation resources count", () => {
    const matching = requiresHumanBarrier({
      ...baseInput,
      mutationResources: ["workspace-mutation:/repo"],
      policy: { crossRepoResourcePatterns: ["/repo"] }
    });
    expect(matching.required).toBe(true);
    const nonMatching = requiresHumanBarrier({
      ...baseInput,
      mutationResources: ["workspace-mutation:/other"],
      policy: { crossRepoResourcePatterns: ["/repo"] }
    });
    expect(nonMatching.required).toBe(false);
  });

  it("counterexample — LLM forgets to report risk: the deterministic verdict does not depend on LLM input", () => {
    // The pure function takes no LLM riskCategory. A node that writes to a shared workspace
    // barriers whether or not the LLM flagged it — there is no parameter to forget.
    const verdict = requiresHumanBarrier(baseInput);
    expect(verdict.required).toBe(true);
    // The LLM's (absent) riskCategory cannot lower this; the function signature has no such input.
    expect(requiresHumanBarrier.length).toBeGreaterThan(0);
  });

  it("counterexample — LLM marks everything high-risk: the narrow deterministic verdict is unchanged", () => {
    // An LLM "high" rating is not an input to the deterministic function. The verdict is driven
    // by resources/work-kind/gates/policy only, so an over-cautious LLM cannot mass-barrier.
    const noMutations = requiresHumanBarrier({ ...baseInput, mutationResources: [], workKind: "discussion" });
    expect(noMutations.required).toBe(false);
    // Even if the LLM said "high" for this node, the deterministic verdict stays no-barrier.
  });

  it("policy hash is stable for the same policy and changes when the policy changes", () => {
    const policy: HumanBarrierPolicy = { protectedTargets: ["feature-x"] };
    const hash1 = deriveHumanBarrierPolicyHash(policy);
    const hash2 = deriveHumanBarrierPolicyHash({ protectedTargets: ["feature-x"] });
    expect(hash1).toBe(hash2);
    const hash3 = deriveHumanBarrierPolicyHash({ protectedTargets: ["feature-y"] });
    expect(hash3).not.toBe(hash1);
    // Absent policy and empty-object policy hash the same (default narrow).
    expect(deriveHumanBarrierPolicyHash(undefined)).toBe(deriveHumanBarrierPolicyHash({}));
  });
});

describe("B4 human-risk barrier — enforcement (seam on)", () => {
  it("barrier hit: worker does not spawn until the human approves via the existing control plane", async () => {
    const result = await runBarrier(CODE_TODOS, {
      humanBarrier: { enforce: true },
      onHumanDecision: () => ({ requestId: "hr-1", decision: "approved" as const })
    });
    expect(result.error).toBeUndefined();
    // Each code delegation hit the barrier and requested a human decision.
    expect(result.humanRequests).toHaveLength(2);
    expect(result.humanRequests[0]!.riskCategory).toBe("irreversible-other");
    expect(result.humanRequests[0]!.proposedAction).toMatchObject({ action: "delegate" });
    // Both workers spawned only after approval.
    expect(result.executed).toHaveLength(2);
    // Enforcement events were emitted with shadow: false.
    const barriers = result.events.filter((event) => event.type === "supervisor.dispatch.human-barrier");
    expect(barriers).toHaveLength(2);
    for (const barrier of barriers) expect(barrier.detail).toMatchObject({ shadow: false });
  });

  it("barrier reject: worker never spawns and the todo is marked failed", async () => {
    const result = await runBarrier(CODE_TODOS, {
      humanBarrier: { enforce: true },
      onHumanDecision: () => ({ requestId: "hr-1", decision: "rejected" as const, comment: "no" })
    });
    expect(result.error).toBeUndefined();
    // The first delegation was rejected: its worker never spawned.
    expect(result.humanRequests).toHaveLength(2);
    expect(result.executed).toHaveLength(0);
    // The dispatch ledger records the human-barrier rejection.
    const state = result.artifacts["supervisor-state.json"] as { dispatchLedger?: Array<{ settledReason?: string }> };
    const rejected = (state.dispatchLedger ?? []).filter((entry) => entry.settledReason === "human-barrier-rejected");
    expect(rejected.length).toBeGreaterThan(0);
  });

  it("counterexample — stale approval: a policy change during the human wait invalidates the approval and re-requests", async () => {
    // The policy object is shared between the plan and the decision callback so the callback can
    // tighten it mid-wait, simulating a policy change while the human is deciding.
    const policy: HumanBarrierPolicy = { enforce: true };
    let decisions = 0;
    const result = await runBarrier(
      [{ id: "todo-1", task: "Implement", workKind: "code", changeSet: "feature-x" },
       { id: "todo-2", task: "Document", workKind: "docs" }],
      {
        humanBarrier: policy,
        onHumanDecision: () => {
          decisions += 1;
          if (decisions === 1) {
            // Tighten the policy while the human is deciding: the approval below is stale.
            policy.protectedTargets = ["feature-x"];
            return { requestId: "hr-1", decision: "approved" as const };
          }
          return { requestId: "hr-2", decision: "approved" as const };
        }
      }
    );
    expect(result.error).toBeUndefined();
    // todo-1 requested twice (stale approval re-requested); todo-2 (docs, no mutation) requested zero times.
    expect(result.humanRequests).toHaveLength(2);
    // todo-1's worker spawned exactly once, after the fresh approval.
    expect(result.executed).toHaveLength(2);
  });

  it("fails the run when the barrier hits but no human-decision control plane is available", async () => {
    const result = await runBarrier(CODE_TODOS, {
      humanBarrier: { enforce: true },
      includeControlPlane: false
    });
    expect(result.error).toBeDefined();
    expect(String((result.error as Error).message)).toMatch(/human-risk barrier/);
    expect(result.executed).toHaveLength(0);
  });
});

describe("B4 human-risk barrier — shadow (seam off, iterative default)", () => {
  it("emits a shadow observation and spawns normally without calling the control plane", async () => {
    const result = await runBarrier(CODE_TODOS);
    expect(result.error).toBeUndefined();
    // The verdict ran and was observed, but the iterative path is unaffected.
    const barriers = result.events.filter((event) => event.type === "supervisor.dispatch.human-barrier");
    expect(barriers).toHaveLength(2);
    for (const barrier of barriers) {
      expect(barrier.detail).toMatchObject({ shadow: true });
      expect(barrier.detail).toHaveProperty("policyHash");
      expect(barrier.detail).toHaveProperty("reasons");
    }
    // No human decision was requested; both workers spawned.
    expect(result.humanRequests).toHaveLength(0);
    expect(result.executed).toHaveLength(2);
  });

  it("an allow-listed node emits no shadow barrier observation", async () => {
    const result = await runBarrier(CODE_TODOS, {
      humanBarrier: { allow: ["feature-x", "feature-y"] }
    });
    expect(result.error).toBeUndefined();
    const barriers = result.events.filter((event) => event.type === "supervisor.dispatch.human-barrier");
    expect(barriers).toHaveLength(0);
    expect(result.executed).toHaveLength(2);
  });
});
