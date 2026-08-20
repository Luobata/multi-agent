import { describe, expect, it } from "vitest";
import {
  buildShadowDispatchPlan,
  compareShadowDispatch,
  deriveGateActivationIdentity,
  deriveGateActivationKey,
  supervisorArchitectureAdapter,
  type HumanBarrierPolicy,
  type ShadowDispatchPlan
} from "../src/architectures/supervisor.js";
import type { SupervisorDagNodeTracker, SupervisorDagWorkKind } from "../src/architectures/supervisorDag.js";
import type { ArchitectureExecutionContext } from "../src/architectures/types.js";
import { ExecutionBudget } from "../src/runtime/governance.js";
import type {
  ExecutionPlan,
  ExecutionPlanNode,
  JsonValue,
  LoadedManifest,
  NodeRunResult,
  NodeRunStatus,
  RuntimeHumanDecisionOutcome,
  RuntimeHumanDecisionRequest,
  WorkflowRunRecord
} from "../src/core/types.js";

// --- fixtures ---

interface TodoSpec {
  id: string;
  task: string;
  workKind: string;
  changeSet?: string;
  needs?: string[];
}

function dagTracker(
  nodeId: string,
  opts: { workKind?: SupervisorDagWorkKind; changeSet?: string; needs?: string[]; status?: NodeRunStatus } = {}
): SupervisorDagNodeTracker {
  return {
    node: {
      nodeId,
      roleId: "builder",
      needs: opts.needs ?? [],
      kind: "task",
      task: `do ${nodeId}`,
      requiredCapabilities: [],
      workKind: opts.workKind ?? "code",
      required: true,
      ...(opts.changeSet ? { changeSet: opts.changeSet } : {})
    },
    status: opts.status ?? "pending",
    executions: []
  };
}

function gateTracker(
  id: string,
  opts: { requiredCapability?: string; required?: boolean; riskCategory?: string } = {}
) {
  return {
    gate: {
      id,
      requiredCapability: opts.requiredCapability ?? "code.review",
      mode: "after-each-delegation" as const,
      required: opts.required ?? true,
      instructions: "",
      fallback: "block" as const,
      ...(opts.riskCategory ? { riskCategory: opts.riskCategory } : {})
    },
    status: "pending" as const,
    activations: new Map(),
    passed: new Set<string>(),
    executions: [],
    noExecutor: false
  };
}

function shadowPolicy(humanBarrier?: HumanBarrierPolicy) {
  return {
    id: "shadow-policy",
    version: 1,
    instructions: "test",
    allowedRoleIds: ["builder"],
    limits: { maxRounds: 10, maxDelegations: 10, maxParallelDelegations: 3, maxDurationMs: 60_000 },
    failure: { workerFailure: "observe-and-replan" as const },
    completion: { requireDelegation: false, requireAllDelegationsSuccessful: false },
    ...(humanBarrier ? { humanBarrier } : {})
  };
}

type ShadowInput = Parameters<typeof buildShadowDispatchPlan>[0];

function shadowInput(partial: {
  dagTrackers: Map<string, SupervisorDagNodeTracker>;
  gates?: ReturnType<typeof gateTracker>[];
  policy?: HumanBarrierPolicy;
  candidateRevision?: string;
  executionRoot?: string;
}): ShadowInput {
  return {
    dagTrackers: partial.dagTrackers,
    gateTrackers: new Map((partial.gates ?? []).map((tracker) => [tracker.gate.id, tracker])) as never,
    policy: shadowPolicy(partial.policy) as never,
    candidateRevision: partial.candidateRevision ?? "r1",
    executionRoot: partial.executionRoot ?? "/repo"
  };
}

const HASH_64 = /^[a-f0-9]{64}$/;

// --- pure function tests: buildShadowDispatchPlan ---

describe("B5 buildShadowDispatchPlan — compiled dispatcher's would-dispatch projection", () => {
  it("verdicts every DAG node: a mutating code node barriers, a discussion node does not", () => {
    const plan = buildShadowDispatchPlan(shadowInput({
      dagTrackers: new Map([
        ["code-1", dagTracker("code-1", { workKind: "code", changeSet: "feature-x" })],
        ["discuss-1", dagTracker("discuss-1", { workKind: "discussion" })]
      ])
    }));
    // Regression gate: the projection never claims the compiled dispatcher is enabled.
    expect(plan.compiledDispatchEnabled).toBe(false);
    const code = plan.entries.find((entry) => entry.nodeId === "code-1")!;
    expect(code.ready).toBe(true);
    expect(code.barrier.required).toBe(true);
    expect(code.barrier.reasons).toContain("mutation-resource");
    expect(code.barrier.policyHash).toMatch(HASH_64);
    expect(code.wouldDispatch).toBe(false);
    const discuss = plan.entries.find((entry) => entry.nodeId === "discuss-1")!;
    expect(discuss.ready).toBe(true);
    expect(discuss.barrier.required).toBe(false);
    expect(discuss.wouldDispatch).toBe(true);
  });

  it("marks a node with unmet needs not ready and would not dispatch it", () => {
    const plan = buildShadowDispatchPlan(shadowInput({
      dagTrackers: new Map([
        ["a", dagTracker("a", { workKind: "discussion" })],
        ["b", dagTracker("b", { workKind: "discussion", needs: ["a"] })]
      ])
    }));
    const b = plan.entries.find((entry) => entry.nodeId === "b")!;
    expect(b.ready).toBe(false);
    expect(b.wouldDispatch).toBe(false);
  });

  it("predicts the gate activation for a ready code node feeding a required matching gate", () => {
    const plan = buildShadowDispatchPlan(shadowInput({
      dagTrackers: new Map([["code-1", dagTracker("code-1", { workKind: "code", changeSet: "feature-x" })]]),
      gates: [gateTracker("review", { requiredCapability: "code.review", required: true })]
    }));
    const entry = plan.entries.find((candidate) => candidate.nodeId === "code-1")!;
    expect(entry.activation).toBeDefined();
    expect(entry.activation!.gateId).toBe("review");
    expect(entry.activation!.key).toMatch(HASH_64);
    expect(entry.activation!.evidenceEpoch.startsWith("epoch:")).toBe(true);
    // The predicted key is the same sha256 the Gate activation path would derive.
    const expectedKey = deriveGateActivationKey(deriveGateActivationIdentity({
      gateId: "review",
      sourceNodeIds: ["code-1"],
      candidateRevision: "r1",
      evidence: [{ sourceNodeId: "code-1", passedExecutionNodeId: "code-1", candidateRevision: "r1" }]
    }));
    expect(entry.activation!.key).toBe(expectedKey);
  });

  it("predicts no activation without a matching gate", () => {
    const plan = buildShadowDispatchPlan(shadowInput({
      dagTrackers: new Map([["code-1", dagTracker("code-1", { workKind: "code" })]]),
      gates: []
    }));
    expect(plan.entries[0]!.activation).toBeUndefined();
  });

  it("predicts no activation for a non-code node even with a matching gate", () => {
    const plan = buildShadowDispatchPlan(shadowInput({
      dagTrackers: new Map([["discuss-1", dagTracker("discuss-1", { workKind: "discussion" })]]),
      gates: [gateTracker("review", { requiredCapability: "code.review", required: true })]
    }));
    expect(plan.entries[0]!.activation).toBeUndefined();
  });

  it("treats a passed node without fresh evidence as not ready", () => {
    const plan = buildShadowDispatchPlan(shadowInput({
      dagTrackers: new Map([["code-1", dagTracker("code-1", { workKind: "code", status: "passed" })]])
    }));
    expect(plan.entries[0]!.ready).toBe(false);
    expect(plan.entries[0]!.wouldDispatch).toBe(false);
  });
});

// --- pure function tests: compareShadowDispatch ---

describe("B5 compareShadowDispatch — LLM decision vs compiled plan", () => {
  const mixedPlan = (): ShadowDispatchPlan => buildShadowDispatchPlan(shadowInput({
    dagTrackers: new Map([
      ["code-1", dagTracker("code-1", { workKind: "code", changeSet: "feature-x" })],
      ["discuss-1", dagTracker("discuss-1", { workKind: "discussion" })],
      ["blocked-1", dagTracker("blocked-1", { workKind: "discussion", needs: ["discuss-1"] })]
    ])
  }));

  it("flags an LLM dispatch of a not-ready node", () => {
    const divergences = compareShadowDispatch({ plan: mixedPlan(), llmDispatchedNodeIds: ["blocked-1"] });
    expect(divergences).toHaveLength(1);
    expect(divergences[0]!).toMatchObject({ nodeId: "blocked-1", reason: "llm-dispatched-not-ready" });
  });

  it("flags an LLM dispatch of a cancelled node (removed from the active DAG)", () => {
    const divergences = compareShadowDispatch({
      plan: mixedPlan(),
      llmDispatchedNodeIds: ["ghost-1"],
      cancelledNodeIds: ["ghost-1"]
    });
    expect(divergences).toHaveLength(1);
    expect(divergences[0]!).toMatchObject({ nodeId: "ghost-1", reason: "llm-dispatched-cancelled" });
  });

  it("flags an LLM dispatch of a barrier-required ready node with reasons and policy hash", () => {
    const divergences = compareShadowDispatch({ plan: mixedPlan(), llmDispatchedNodeIds: ["code-1"] });
    expect(divergences).toHaveLength(1);
    expect(divergences[0]!.reason).toBe("llm-dispatched-barrier-required");
    expect(divergences[0]!.nodeId).toBe("code-1");
    const detail = divergences[0]!.detail as { reasons: string[]; policyHash: string };
    expect(detail.reasons).toContain("mutation-resource");
    expect(detail.policyHash).toMatch(HASH_64);
  });

  it("does not flag an LLM dispatch of a ready, non-barrier node", () => {
    const divergences = compareShadowDispatch({ plan: mixedPlan(), llmDispatchedNodeIds: ["discuss-1"] });
    expect(divergences).toHaveLength(0);
  });

  it("does not flag the LLM holding a ready node for a later round", () => {
    // Inaction is not a divergence: the iterative LLM legitimately batches across rounds.
    const divergences = compareShadowDispatch({ plan: mixedPlan(), llmDispatchedNodeIds: [] });
    expect(divergences).toHaveLength(0);
  });

  it("ignores an unknown node id that is not marked cancelled (legacy assignment)", () => {
    const divergences = compareShadowDispatch({ plan: mixedPlan(), llmDispatchedNodeIds: ["legacy-thing"] });
    expect(divergences).toHaveLength(0);
  });
});

// --- integration tests ---

function buildPlan(todos: TodoSpec[], humanBarrier: HumanBarrierPolicy | undefined): ExecutionPlan {
  return {
    architecture: "supervisor",
    workflow: "shadow-test",
    description: "B5 compiled shadow test",
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
        id: "shadow-policy",
        version: 1,
        instructions: "test",
        allowedRoleIds: ["builder"],
        limits: { maxRounds: 10, maxDelegations: 10, maxParallelDelegations: 3, maxDurationMs: 60_000 },
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
      name: "shadow-manifest",
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
      needs: todo.needs ?? [],
      workKind: todo.workKind,
      ...(todo.changeSet ? { changeSet: todo.changeSet } : {})
    }))
  } as unknown as JsonValue;
}

function delegateDecision(target: { todoId?: string; nodeId?: string }): JsonValue {
  return {
    action: "delegate",
    summary: "Delegate",
    assignments: [{ ...target, roleId: "builder" }]
  } as unknown as JsonValue;
}

const finishDecision = (): JsonValue =>
  ({ action: "finish", summary: "Done.", result: { delivered: true } }) as unknown as JsonValue;

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

interface ShadowResult {
  events: Array<{ type: string; detail?: JsonValue }>;
  executed: string[];
  humanRequests: RuntimeHumanDecisionRequest[];
  architectureState: JsonValue | undefined;
  error: unknown;
}

async function runShadow(
  todos: TodoSpec[],
  options: {
    leader?: (round: number) => JsonValue;
    humanBarrier?: HumanBarrierPolicy;
  } = {}
): Promise<ShadowResult> {
  const events: Array<{ type: string; detail?: JsonValue }> = [];
  const executed: string[] = [];
  const humanRequests: RuntimeHumanDecisionRequest[] = [];
  const artifacts: Record<string, unknown> = {};
  const budget = new ExecutionBudget({ delegations: 16, depth: 16, gates: 8 });
  const plan = buildPlan(todos, options.humanBarrier);
  const run: WorkflowRunRecord = {
    id: "run-shadow",
    workflow: "shadow-test",
    architecture: "supervisor",
    manifestPath: "",
    artifactDir: "",
    status: "running",
    createdAt: "2026-08-20T00:00:00.000Z",
    nodes: {}
  };

  const defaultLeader = (round: number): JsonValue => {
    if (round === 1) return planTodosDecision(todos);
    const todoIndex = round - 2;
    if (todoIndex < todos.length) return delegateDecision({ todoId: todos[todoIndex]!.id });
    return finishDecision();
  };

  const context: ArchitectureExecutionContext = {
    loaded: buildManifest(),
    input: {},
    plan,
    run,
    budget,
    scheduleNode: async (node) => {
      if (!plan.nodes.some((candidate) => candidate.id === node.id)) plan.nodes.push(node);
    },
    executeNode: async (node) => {
      if (node.role === "supervisor") {
        const round = Number((node.metadata as { round?: number } | undefined)?.round ?? 1);
        const decision = options.leader ? options.leader(round) : defaultLeader(round);
        return passed(node, decision);
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
    requestHumanDecision: async (request: RuntimeHumanDecisionRequest): Promise<RuntimeHumanDecisionOutcome> => {
      humanRequests.push(request);
      return { requestId: `hr-${humanRequests.length}`, decision: "approved" as const };
    }
  };

  let error: unknown;
  try {
    await supervisorArchitectureAdapter.execute(context);
  } catch (caught) {
    error = caught;
  }
  return { events, executed, humanRequests, architectureState: run.architectureState, error };
}

const divergences = (result: ShadowResult) =>
  result.events.filter((event) => event.type === "scheduler.divergence");

const CODE_TODOS: TodoSpec[] = [
  { id: "todo-1", task: "Implement part one", workKind: "code", changeSet: "feature-x" },
  { id: "todo-2", task: "Implement part two", workKind: "code", changeSet: "feature-y" }
];

describe("B5 shadow dispatch plan — projection into architectureState", () => {
  it("projects shadowDispatchPlan every round and keeps compiledDispatchEnabled false", async () => {
    const result = await runShadow(CODE_TODOS);
    expect(result.error).toBeUndefined();
    const scheduling = (result.architectureState as { scheduling?: JsonValue } | undefined)?.scheduling as
      | { compiledDispatchEnabled?: boolean; shadowReadyNodeIds?: string[]; shadowDispatchPlan?: ShadowDispatchPlan }
      | undefined;
    expect(scheduling).toBeDefined();
    // Regression gate: the canary never silently flips on.
    expect(scheduling!.compiledDispatchEnabled).toBe(false);
    expect(scheduling!.shadowReadyNodeIds).toBeInstanceOf(Array);
    const shadowPlan = scheduling!.shadowDispatchPlan;
    expect(shadowPlan).toBeDefined();
    expect(shadowPlan!.compiledDispatchEnabled).toBe(false);
    const entryNodeIds = shadowPlan!.entries.map((entry) => entry.nodeId).sort();
    expect(entryNodeIds).toEqual(["todo-1", "todo-2"]);
    // The code todos carry barrier verdicts in the projection.
    for (const entry of shadowPlan!.entries) {
      expect(entry.barrier.required).toBe(true);
      expect(entry.barrier.policyHash).toMatch(HASH_64);
    }
  });
});

describe("B5 scheduler.divergence — counterexamples", () => {
  it("counterexample — LLM delegates a not-ready node: divergence detected, iterative path still rejects it", async () => {
    const todos: TodoSpec[] = [
      { id: "todo-1", task: "Implement", workKind: "code", changeSet: "feature-x" },
      { id: "todo-2", task: "Discuss the design", workKind: "discussion", needs: ["todo-1"] }
    ];
    // Exempt the code todo's barrier so the only divergence is the not-ready delegation.
    const result = await runShadow(todos, {
      humanBarrier: { allow: ["feature-x"] },
      leader: (round) => {
        if (round === 1) return planTodosDecision(todos);
        if (round === 2) return delegateDecision({ todoId: "todo-2" }); // not ready yet
        if (round === 3) return delegateDecision({ todoId: "todo-1" });
        if (round === 4) return delegateDecision({ todoId: "todo-2" }); // now ready
        return finishDecision();
      }
    });
    expect(result.error).toBeUndefined();
    const found = divergences(result);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatchObject({ nodeId: "todo-2", reason: "llm-dispatched-not-ready", compiledDispatchEnabled: false });
    // The iterative validator rejected the premature delegation; the node ran only after todo-1 passed.
    expect(result.executed.filter((id) => id === "todo-2")).toHaveLength(1);
    expect(result.executed.indexOf("todo-1")).toBeLessThan(result.executed.indexOf("todo-2"));
  });

  it("counterexample — LLM delegates a barrier-required node: divergence detected, shadow does not block", async () => {
    const todos: TodoSpec[] = [
      { id: "todo-1", task: "Implement", workKind: "code", changeSet: "feature-x" },
      { id: "todo-2", task: "Document", workKind: "discussion" }
    ];
    const result = await runShadow(todos, {
      leader: (round) => {
        if (round === 1) return planTodosDecision(todos);
        if (round === 2) return delegateDecision({ todoId: "todo-1" });
        return finishDecision();
      }
    });
    expect(result.error).toBeUndefined();
    const found = divergences(result);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatchObject({ nodeId: "todo-1", reason: "llm-dispatched-barrier-required", compiledDispatchEnabled: false });
    const detail = found[0]!.detail as { detail: { reasons: string[]; policyHash: string } };
    expect(detail.detail.reasons).toContain("mutation-resource");
    expect(detail.detail.policyHash).toMatch(HASH_64);
    // Shadow observation only: the worker still spawned and no human decision was requested.
    expect(result.executed).toContain("todo-1");
    expect(result.humanRequests).toHaveLength(0);
  });

  it("counterexample — LLM delegates a nodeId outside the active DAG: cancelled divergence detected", async () => {
    const todos: TodoSpec[] = [
      { id: "todo-1", task: "Discuss", workKind: "discussion" },
      { id: "todo-2", task: "Outline", workKind: "discussion" }
    ];
    const result = await runShadow(todos, {
      leader: (round) => {
        if (round === 1) return planTodosDecision(todos);
        if (round === 2) return delegateDecision({ nodeId: "todo-ghost" }); // removed/never-existed
        if (round === 3) return delegateDecision({ todoId: "todo-1" });
        return finishDecision();
      }
    });
    expect(result.error).toBeUndefined();
    const found = divergences(result);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatchObject({ nodeId: "todo-ghost", reason: "llm-dispatched-cancelled", compiledDispatchEnabled: false });
    // The iterative validator rejected the outside-DAG delegation.
    expect(result.executed).not.toContain("todo-ghost");
    expect(result.executed).toContain("todo-1");
  });

  it("no divergence when the LLM delegates a ready, non-barrier node", async () => {
    const todos: TodoSpec[] = [
      { id: "todo-1", task: "Discuss the design", workKind: "discussion" },
      { id: "todo-2", task: "Draft the outline", workKind: "discussion" }
    ];
    const result = await runShadow(todos, {
      leader: (round) => {
        if (round === 1) return planTodosDecision(todos);
        if (round === 2) return delegateDecision({ todoId: "todo-1" });
        return finishDecision();
      }
    });
    expect(result.error).toBeUndefined();
    expect(divergences(result)).toHaveLength(0);
    expect(result.executed).toContain("todo-1");
  });
});
