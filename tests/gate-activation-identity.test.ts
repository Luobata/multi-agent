import { describe, expect, it } from "vitest";
import {
  deriveGateActivationIdentity,
  deriveGateActivationKey,
  deriveGateEvidenceEpoch,
  supervisorArchitectureAdapter
} from "../src/architectures/supervisor.js";
import type { ArchitectureExecutionContext } from "../src/architectures/types.js";
import { ExecutionBudget } from "../src/runtime/governance.js";
import type {
  ExecutionPlan,
  ExecutionPlanNode,
  JsonValue,
  LoadedManifest,
  NodeRunResult,
  WorkflowRunRecord
} from "../src/core/types.js";

const GATE_ID = "audit";

interface TodoSpec {
  id: string;
  task: string;
  workKind: string;
  changeSet?: string;
}

function buildPlan(gates: unknown[]): ExecutionPlan {
  return {
    architecture: "supervisor",
    workflow: "identity-test",
    description: "B1 gate activation identity test",
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
        id: "identity-policy",
        version: 1,
        instructions: "test",
        allowedRoleIds: ["builder"],
        limits: { maxRounds: 8, maxDelegations: 8, maxParallelDelegations: 3, maxDurationMs: 60_000 },
        failure: { workerFailure: "observe-and-replan" },
        completion: { requireDelegation: false, requireAllDelegationsSuccessful: false }
      },
      members: [{
        roleId: "builder",
        role: "builder",
        employeeId: "builder-emp",
        description: "Builds",
        capabilities: ["code.backend"]
      }],
      flow: { version: 1, stages: [], gates }
    }
  } as unknown as ExecutionPlan;
}

function auditGate(mode: "after-each-delegation" | "before-completion") {
  return {
    id: GATE_ID,
    requiredCapability: "quality.audit",
    mode,
    required: true,
    instructions: "Audit the code.",
    fallback: "supervisor"
  };
}

function buildManifest(): LoadedManifest {
  return {
    manifest: {
      version: 1,
      name: "identity-manifest",
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
    id: "run-identity",
    workflow: "identity-test",
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

function finishDecision(): JsonValue {
  return { action: "finish", summary: "Done.", result: { delivered: true } } as unknown as JsonValue;
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

interface HarnessOptions {
  seedState?: JsonValue;
  /**
   * On resume every TODO is already done, so the leader finishes immediately. The plan must be
   * the one persisted by the first run (it carries the dynamic worker nodes, which the durable
   * delegation-ledger validation checks against — mirroring the runner's plan.json reload).
   */
  resume?: boolean;
  seedPlan?: ExecutionPlan;
  /** Gate executor outcomes in call order; "satisfy" passes, "block" fails the activation. */
  gateOutcomes?: Array<"satisfy" | "block">;
  /**
   * Remediation choreography: round 3 re-delegates todo-1 (the Gate blocked it in round 2),
   * exercising invalidateCompletionGatesForRemediation before the new activation.
   */
  remediation?: boolean;
}

interface HarnessResult {
  events: Array<{ type: string; detail?: JsonValue }>;
  scheduled: string[];
  artifacts: Record<string, unknown>;
  plan: ExecutionPlan;
  error: unknown;
  result: unknown;
}

/**
 * Drives the supervisor with a scripted leader. The leader plans `todos`, then delegates them in
 * order (one per round), then finishes. Gate executor nodes answer per `gateOutcomes`.
 */
async function runSupervisor(todos: TodoSpec[], gateMode: "after-each-delegation" | "before-completion", options: HarnessOptions = {}): Promise<HarnessResult> {
  const events: Array<{ type: string; detail?: JsonValue }> = [];
  const scheduled: string[] = [];
  const artifacts: Record<string, unknown> = {};
  if (options.seedState) artifacts["supervisor-state.json"] = options.seedState;
  const budget = new ExecutionBudget({ delegations: 16, depth: 16, gates: 8 });
  let delegateRound = 0;
  const gateOutcomes = options.gateOutcomes ?? [];
  let gateCalls = 0;
  // The runner appends dynamic nodes to plan.nodes via scheduleNode and persists plan.json, so
  // the durable delegation-ledger validation sees worker ids on resume. Mirror that here.
  const plan = options.seedPlan ?? buildPlan([auditGate(gateMode)]);

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
      const kind = (node.metadata as { kind?: string } | undefined)?.kind;
      if (kind === "gate") {
        const outcome = gateOutcomes[gateCalls] ?? "satisfy";
        gateCalls += 1;
        if (outcome === "block") {
          // A supervisor-fallback executor that does not return satisfy-gate blocks the activation.
          return passed(node, { action: "delegate", summary: "Audit failed; needs remediation." } as unknown as JsonValue);
        }
        return passed(node, {
          action: "satisfy-gate",
          gateId: GATE_ID,
          summary: "Audit passed.",
          evidence: { verdict: "Pass" }
        } as unknown as JsonValue);
      }
      if (node.role === "supervisor") {
        if (options.resume) return passed(node, finishDecision());
        const round = Number((node.metadata as { round?: number } | undefined)?.round ?? 1);
        if (round === 1) return passed(node, planTodosDecision(todos));
        if (options.remediation && round === 3) return passed(node, delegateDecision(todos[0]!.id));
        if (delegateRound < todos.length) {
          const todo = todos[delegateRound]!;
          delegateRound += 1;
          return passed(node, delegateDecision(todo.id));
        }
        return passed(node, finishDecision());
      }
      // Delegated worker node.
      return passed(node, { message: "done" } as unknown as JsonValue);
    },
    readArtifact: (async (relativePath: string) => artifacts[relativePath] as JsonValue | undefined) as ArchitectureExecutionContext["readArtifact"],
    writeArtifact: async (relativePath, value) => { artifacts[relativePath] = value; },
    candidateSnapshot: async () => ({ revision: "r1", changedFiles: [] }) as never,
    executionRoot: () => "",
    executionPackageScripts: async () => ({}),
    persist: async () => {},
    emit: async (type, _nodeId, detail) => { events.push({ type, detail: detail as JsonValue | undefined }); }
  };

  let error: unknown;
  let result: unknown;
  try {
    result = await supervisorArchitectureAdapter.execute(context);
  } catch (caught) {
    error = caught;
  }
  return { events, scheduled, artifacts, plan, error, result };
}

function gateActivations(state: JsonValue): Array<{ key: string; sourceNodeIds: string[]; identity?: JsonValue }> {
  const gates = (state as { gates?: Array<{ activations?: Array<{ key: string; sourceNodeIds: string[]; identity?: JsonValue }> }> }).gates ?? [];
  return gates.flatMap((gate) => gate.activations ?? []);
}

const TWO_CODE_TODOS: TodoSpec[] = [
  { id: "todo-1", task: "Implement part one", workKind: "code", changeSet: "feature-x" },
  { id: "todo-2", task: "Implement part two", workKind: "code", changeSet: "feature-x" }
];

describe("B1 Gate activation identity — pure derivation", () => {
  it("derives a stable sha256 key from persistent facts only (no round, wall clock, or randomness)", () => {
    const identity = deriveGateActivationIdentity({
      gateId: "test",
      sourceNodeIds: ["code-1"],
      candidateRevision: "r1",
      evidence: [{ sourceNodeId: "code-1", passedExecutionNodeId: "ex-1", candidateRevision: "r1" }]
    });
    const key1 = deriveGateActivationKey(identity);
    const key2 = deriveGateActivationKey(deriveGateActivationIdentity({
      gateId: "test",
      sourceNodeIds: ["code-1"],
      candidateRevision: "r1",
      evidence: [{ sourceNodeId: "code-1", passedExecutionNodeId: "ex-1", candidateRevision: "r1" }]
    }));
    expect(identity.identityVersion).toBe(2);
    expect(identity.evidenceEpoch).toMatch(/^epoch:[a-f0-9]{64}$/);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
    expect(key1).toBe(key2);
  });

  it("sorts sourceNodeIds so input order cannot change the key", () => {
    const base = { gateId: "test", candidateRevision: "r1", evidence: [] as Array<{ sourceNodeId: string; passedExecutionNodeId: string; candidateRevision: string }> };
    const keyA = deriveGateActivationKey(deriveGateActivationIdentity({ ...base, sourceNodeIds: ["a", "b"] }));
    const keyB = deriveGateActivationKey(deriveGateActivationIdentity({ ...base, sourceNodeIds: ["b", "a"] }));
    expect(keyA).toBe(keyB);
  });

  it("counterexample 1: two evidence generations for the same changeSet produce different keys, so stale passed evidence is not reused", () => {
    const gen1 = deriveGateActivationIdentity({
      gateId: "test",
      sourceNodeIds: ["code"],
      candidateRevision: "r1",
      evidence: [{ sourceNodeId: "code", passedExecutionNodeId: "ex-v1", candidateRevision: "r1" }]
    });
    // Upstream drift: the same code node re-executes, producing a new passing execution for r2.
    const gen2 = deriveGateActivationIdentity({
      gateId: "test",
      sourceNodeIds: ["code"],
      candidateRevision: "r2",
      evidence: [{ sourceNodeId: "code", passedExecutionNodeId: "ex-v2", candidateRevision: "r2" }]
    });
    const keyGen1 = deriveGateActivationKey(gen1);
    const keyGen2 = deriveGateActivationKey(gen2);
    expect(keyGen1).not.toBe(keyGen2);
    // A Gate that passed on the v1 generation must not match the v2 key: the old passed set
    // contains keyGen1, and the v2 activation is keyed keyGen2, so `passed.has(keyGen2)` is false.
    const passed = new Set([keyGen1]);
    expect(passed.has(keyGen2)).toBe(false);
    expect(gen1.evidenceEpoch).not.toBe(gen2.evidenceEpoch);
  });

  it("counterexample 2: the identity contains no volatile field, so resume re-derives the same key byte-for-byte", () => {
    const identity = deriveGateActivationIdentity({
      gateId: "test",
      sourceNodeIds: ["code-1", "code-2"],
      candidateRevision: "r1",
      evidence: [
        { sourceNodeId: "code-1", passedExecutionNodeId: "ex-1", candidateRevision: "r1" },
        { sourceNodeId: "code-2", passedExecutionNodeId: "ex-2", candidateRevision: "r1" }
      ]
    });
    const serialized = JSON.parse(JSON.stringify(identity)) as typeof identity;
    // Resume restores the persisted identity and re-derives the key from it.
    expect(deriveGateActivationKey(serialized)).toBe(deriveGateActivationKey(identity));
  });

  it("changes the key when the candidate revision changes even with identical sources", () => {
    const base = { gateId: "test", sourceNodeIds: ["code"], evidence: [{ sourceNodeId: "code", passedExecutionNodeId: "ex-1", candidateRevision: "r1" }] };
    const keyR1 = deriveGateActivationKey(deriveGateActivationIdentity({ ...base, candidateRevision: "r1" }));
    const keyR2 = deriveGateActivationKey(deriveGateActivationIdentity({ ...base, candidateRevision: "r2" }));
    expect(keyR1).not.toBe(keyR2);
  });

  it("derives the evidence epoch from per-source passing executions, sorted by source node id", () => {
    const epochA = deriveGateEvidenceEpoch([
      { sourceNodeId: "b", passedExecutionNodeId: "ex-2", candidateRevision: "r1" },
      { sourceNodeId: "a", passedExecutionNodeId: "ex-1", candidateRevision: "r1" }
    ]);
    const epochB = deriveGateEvidenceEpoch([
      { sourceNodeId: "a", passedExecutionNodeId: "ex-1", candidateRevision: "r1" },
      { sourceNodeId: "b", passedExecutionNodeId: "ex-2", candidateRevision: "r1" }
    ]);
    expect(epochA).toBe(epochB);
    const epochC = deriveGateEvidenceEpoch([
      { sourceNodeId: "a", passedExecutionNodeId: "ex-1", candidateRevision: "r1" },
      { sourceNodeId: "b", passedExecutionNodeId: "ex-3", candidateRevision: "r1" }
    ]);
    expect(epochC).not.toBe(epochA);
  });
});

describe("B1 Gate activation identity — durable round-trip", () => {
  it("persists the identity with a sha256 key and re-derives the same key byte-for-byte on resume", async () => {
    const first = await runSupervisor(TWO_CODE_TODOS, "after-each-delegation");
    expect(first.error).toBeUndefined();
    const state = first.artifacts["supervisor-state.json"] as JsonValue;
    const activations = gateActivations(state);
    expect(activations).toHaveLength(2);
    for (const activation of activations) {
      expect(activation.key).toMatch(/^[a-f0-9]{64}$/);
      expect(activation.identity).toMatchObject({
        identityVersion: 2,
        gateId: GATE_ID,
        candidateRevision: "r1"
      });
      const identity = activation.identity as { sourceNodeIds: string[]; evidenceEpoch: string };
      expect(identity.sourceNodeIds).toHaveLength(1);
      expect(identity.evidenceEpoch).toMatch(/^epoch:[a-f0-9]{64}$/);
    }
    // Both generations passed independently.
    expect(first.events.filter((event) => event.type === "gate.passed")).toHaveLength(2);

    // Resume from the persisted state: every restored key must be byte-identical and the Gates
    // must not re-run (their passed activations are replayed, not re-executed).
    const resumed = await runSupervisor(TWO_CODE_TODOS, "after-each-delegation", { seedState: state, seedPlan: structuredClone(first.plan), resume: true });
    expect(resumed.error).toBeUndefined();
    const resumedActivations = gateActivations(resumed.artifacts["supervisor-state.json"] as JsonValue);
    expect(resumedActivations).toHaveLength(2);
    const byKey = new Map(activations.map((activation) => [activation.key, activation]));
    for (const activation of resumedActivations) {
      const original = byKey.get(activation.key);
      expect(original).toBeDefined();
      expect(activation.identity).toEqual(original!.identity);
    }
    expect(resumed.events.filter((event) => event.type === "gate.passed")).toHaveLength(0);
  });

  it("restores a pre-B1 activation (no identity) read-only compatible and keeps the run resumable", async () => {
    const first = await runSupervisor(TWO_CODE_TODOS, "after-each-delegation");
    expect(first.error).toBeUndefined();
    const state = structuredClone(first.artifacts["supervisor-state.json"]) as Record<string, unknown>;
    // Simulate a pre-B1 durable state: strip the identity field from every persisted activation.
    const gates = state.gates as Array<{ activations: Array<{ identity?: unknown }> }>;
    expect(gates.length).toBeGreaterThan(0);
    for (const gate of gates) for (const activation of gate.activations) delete activation.identity;

    const resumed = await runSupervisor(TWO_CODE_TODOS, "after-each-delegation", {
      seedState: state as unknown as JsonValue,
      seedPlan: structuredClone(first.plan),
      resume: true
    });
    expect(resumed.error).toBeUndefined();
    const resumedActivations = gateActivations(resumed.artifacts["supervisor-state.json"] as JsonValue);
    expect(resumedActivations).toHaveLength(2);
    // v1 activations are restored without an identity; they are not re-derived or compared, and
    // the already-passed Gates are not re-executed under a fresh identity.
    for (const activation of resumedActivations) expect(activation.identity).toBeUndefined();
    expect(resumed.events.filter((event) => event.type === "gate.passed")).toHaveLength(0);
  });

  it("fails resume when a persisted key drifts from its identity (tamper / derivation change)", async () => {
    const first = await runSupervisor(TWO_CODE_TODOS, "after-each-delegation");
    expect(first.error).toBeUndefined();
    const state = structuredClone(first.artifacts["supervisor-state.json"]) as Record<string, unknown>;
    const gates = state.gates as Array<{ activations: Array<{ key: string }> }>;
    expect(gates.length).toBeGreaterThan(0);
    expect(gates[0]!.activations.length).toBeGreaterThan(0);
    gates[0]!.activations[0]!.key = `${"0".repeat(64)}`;

    const resumed = await runSupervisor(TWO_CODE_TODOS, "after-each-delegation", {
      seedState: state as unknown as JsonValue,
      seedPlan: structuredClone(first.plan),
      resume: true
    });
    expect(resumed.error).toBeDefined();
    expect(String((resumed.error as Error).message)).toMatch(/key drifted from its identity/);
  });

  it("gives two same-changeSet delegations distinct activation keys (no cross-delegation reuse)", async () => {
    const run = await runSupervisor(TWO_CODE_TODOS, "after-each-delegation");
    expect(run.error).toBeUndefined();
    const activations = gateActivations(run.artifacts["supervisor-state.json"] as JsonValue);
    expect(activations).toHaveLength(2);
    expect(activations[0]!.key).not.toBe(activations[1]!.key);
    expect(activations[0]!.identity).toBeDefined();
    expect(activations[1]!.identity).toBeDefined();
  });

  it("supersedes a stale blocked activation when the same TODO is remediated (no stale-generation reuse)", async () => {
    const run = await runSupervisor(
      [
        { id: "todo-1", task: "Implement the feature", workKind: "code", changeSet: "feature-x" },
        { id: "todo-2", task: "Document the feature", workKind: "docs" }
      ],
      "after-each-delegation",
      // The Gate blocks the first delegation; the leader remediates by re-delegating todo-1,
      // and the Gate passes the second generation.
      { gateOutcomes: ["block", "satisfy"], remediation: true }
    );
    expect(run.error).toBeUndefined();
    const activations = gateActivations(run.artifacts["supervisor-state.json"] as JsonValue);
    // Exactly one activation survives: the stale blocked generation was dropped by the explicit
    // remediation invalidation, so it cannot be mistaken for the passing generation.
    expect(activations).toHaveLength(1);
    expect(activations[0]!.identity).toBeDefined();
    expect(activations[0]!.identity).toMatchObject({ identityVersion: 2, gateId: GATE_ID });
    const gatePassed = run.events.filter((event) => event.type === "gate.passed");
    expect(gatePassed).toHaveLength(1);
    expect(gatePassed[0]!.detail).toMatchObject({ gateId: GATE_ID, status: "passed" });
    // The first generation was observed as a hard block, and the Gate was invalidated once.
    expect(run.events.filter((event) => event.type === "gate.unsatisfied")).toHaveLength(1);
    expect(run.events.filter((event) => event.type === "gate.invalidated")).toHaveLength(1);
    // The passing activation is the one recorded on the gate.passed event.
    expect(gatePassed[0]!.detail).toMatchObject({ activation: activations[0]!.key });
  });
});
