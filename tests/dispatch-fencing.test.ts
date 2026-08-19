import { describe, expect, it } from "vitest";
import {
  supervisorArchitectureAdapter,
  type DispatchLedgerEntry
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

function buildPlan(): ExecutionPlan {
  return {
    architecture: "supervisor",
    workflow: "fence-test",
    description: "B3 cancel fencing test",
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
        id: "fence-policy",
        version: 1,
        instructions: "test",
        allowedRoleIds: ["builder"],
        limits: { maxRounds: 5, maxDelegations: 8, maxParallelDelegations: 3, maxDurationMs: 60_000 },
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
      flow: { version: 1, stages: [], gates: [] }
    }
  };
}

function buildManifest(): LoadedManifest {
  return {
    manifest: {
      version: 1,
      name: "fence-manifest",
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
    id: "run-fence",
    workflow: "fence-test",
    architecture: "supervisor",
    manifestPath: "",
    artifactDir: "",
    status: "running",
    createdAt: new Date().toISOString(),
    nodes: {}
  };
}

function planTodosDecision(): JsonValue {
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
    todos: [
      { id: "todo-1", roleId: "builder", task: "Implement the feature", needs: [], workKind: "code" },
      { id: "todo-2", roleId: "builder", task: "Test the feature", needs: ["todo-1"], workKind: "test" }
    ]
  } as unknown as JsonValue;
}

function delegateDecision(): JsonValue {
  return {
    action: "delegate",
    summary: "Delegate todo-1",
    assignments: [{ todoId: "todo-1", roleId: "builder" }]
  } as unknown as JsonValue;
}

function passed(node: ExecutionPlanNode, output: JsonValue): NodeRunResult {
  return {
    nodeId: node.id,
    roleId: node.role,
    status: "passed",
    attempts: 1,
    output,
    completedAt: new Date().toISOString()
  };
}

interface FenceOutcome {
  events: Array<{ type: string; detail?: JsonValue }>;
  scheduled: string[];
  ledger: DispatchLedgerEntry[];
  error: unknown;
}

/**
 * Drives the supervisor architecture with a controlled cancellation epoch. The epoch flips at a
 * chosen injection point, simulating a cancel landing in the dispatch window (window injection).
 */
async function runFenceTest(flipEpochAt: "leader-decision" | "worker-completion"): Promise<FenceOutcome> {
  let epoch = 0;
  const events: Array<{ type: string; detail?: JsonValue }> = [];
  const scheduled: string[] = [];
  const artifacts: Record<string, unknown> = {};
  const budget = new ExecutionBudget({ delegations: 8, depth: 10 });

  const context: ArchitectureExecutionContext = {
    loaded: buildManifest(),
    input: {},
    plan: buildPlan(),
    run: buildRun(),
    budget,
    scheduleNode: async (node) => { scheduled.push(node.id); },
    executeNode: async (node) => {
      if (node.role === "supervisor") {
        const round = Number((node.metadata as { round?: number } | undefined)?.round ?? 1);
        if (round === 1) return passed(node, planTodosDecision());
        if (flipEpochAt === "leader-decision") epoch = 1;
        return passed(node, delegateDecision());
      }
      // Worker node: the cancel lands while the batch is in flight.
      if (flipEpochAt === "worker-completion") epoch = 1;
      return passed(node, { message: "done" } as unknown as JsonValue);
    },
    readArtifact: async () => undefined,
    writeArtifact: async (relativePath, value) => { artifacts[relativePath] = value; },
    candidateSnapshot: async () => ({ revision: "r1", changedFiles: [] }) as never,
    executionRoot: () => "",
    getCancellationEpoch: () => epoch,
    executionPackageScripts: async () => ({}),
    persist: async () => {},
    emit: async (type, _nodeId, detail) => { events.push({ type, detail: detail as JsonValue | undefined }); }
  };

  let error: unknown;
  try {
    await supervisorArchitectureAdapter.execute(context);
  } catch (caught) {
    error = caught;
  }
  const state = artifacts["supervisor-state.json"] as { dispatchLedger?: DispatchLedgerEntry[] } | undefined;
  return { events, scheduled, ledger: state?.dispatchLedger ?? [], error };
}

describe("B3 dispatch cancel fencing (window injection)", () => {
  it("fences the whole batch when the epoch changes between the leader decision and spawn (zero orphan workers)", async () => {
    const outcome = await runFenceTest("leader-decision");

    // No worker node was ever scheduled or executed.
    expect(outcome.scheduled.filter((id) => !id.startsWith("supervisor-"))).toEqual([]);
    // The fence fired with a durable event.
    const fenced = outcome.events.filter((event) => event.type === "supervisor.dispatch.fenced");
    expect(fenced).toHaveLength(1);
    expect(fenced[0]!.detail).toMatchObject({ phase: "dispatch", decisionEpoch: 0, currentEpoch: 1 });
    // Every ledger row is terminal and released.
    expect(outcome.ledger.length).toBeGreaterThan(0);
    for (const entry of outcome.ledger) {
      expect(entry.state).toBe("settled-release");
      expect(entry.settledReason).toBe("cancel-fenced");
    }
    // The run is aborted, not silently completed.
    expect(outcome.error).toBeDefined();
    expect(String((outcome.error as Error).message)).toMatch(/cancellation epoch changed/);
  });

  it("discards in-flight completions when the epoch changes while the batch is running (no new dispatch after cancel)", async () => {
    const outcome = await runFenceTest("worker-completion");

    // Workers were spawned for the batch...
    expect(outcome.scheduled.filter((id) => !id.startsWith("supervisor-")).length).toBeGreaterThan(0);
    // ...but the completion fence discarded them: the run aborts before any post-cancel dispatch.
    const fenced = outcome.events.filter((event) => event.type === "supervisor.dispatch.fenced");
    expect(fenced).toHaveLength(1);
    expect(fenced[0]!.detail).toMatchObject({ phase: "completion", dispatchEpoch: 0, currentEpoch: 1 });
    for (const entry of outcome.ledger) {
      expect(entry.state).toBe("settled-release");
      expect(entry.settledReason).toBe("cancel-fenced");
    }
    expect(outcome.error).toBeDefined();
    expect(String((outcome.error as Error).message)).toMatch(/cancellation epoch changed/);
  });
});
