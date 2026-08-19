import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  reconcileDispatchLedger,
  supervisorArchitectureAdapter,
  type DispatchLedgerEntry
} from "../src/architectures/supervisor.js";
import type { ArchitectureExecutionContext } from "../src/architectures/types.js";
import { ExecutionBudget } from "../src/runtime/governance.js";
import { RunStore } from "../src/runtime/artifacts.js";
import { WorkbenchService } from "../src/workbench/service.js";
import type {
  ExecutionPlan,
  ExecutionPlanNode,
  JsonValue,
  LoadedManifest,
  NodeRunResult,
  WorkflowRunRecord
} from "../src/core/types.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-dispatch-ledger-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function entry(overrides: Partial<DispatchLedgerEntry> & { dispatchId: string; nodeId: string }): DispatchLedgerEntry {
  return {
    activationKey: overrides.nodeId,
    epoch: 0,
    budgetReserved: { delegations: 1 },
    state: "reserved",
    ...overrides
  };
}

describe("reconcileDispatchLedger (B2 crash recovery)", () => {
  it("settles reserved entries as released (the reservation never reached a worker)", () => {
    const entries = [entry({ dispatchId: "d-1", nodeId: "todo-1", state: "reserved" })];
    const result = reconcileDispatchLedger(entries, () => false, "2026-08-19T00:00:00.000Z");
    expect(result.recovered).toBe(1);
    expect(result.entries[0]!.state).toBe("settled-release");
    expect(result.entries[0]!.settledReason).toBe("crash-recovered");
    expect(result.entries[0]!.settledAt).toBe("2026-08-19T00:00:00.000Z");
    expect(result.committed).toEqual({});
    expect(result.outstanding).toEqual({});
  });

  it("settles dispatched entries with durable worker artifacts as committed (the worker consumed the budget)", () => {
    const entries = [entry({ dispatchId: "d-2", nodeId: "todo-1", state: "dispatched" })];
    const result = reconcileDispatchLedger(entries, (nodeId) => nodeId === "todo-1", "2026-08-19T00:00:00.000Z");
    expect(result.recovered).toBe(1);
    expect(result.entries[0]!.state).toBe("settled-commit");
    expect(result.entries[0]!.settledReason).toBe("crash-recovered");
    expect(result.committed).toEqual({ delegations: 1 });
    expect(result.outstanding).toEqual({});
  });

  it("releases dispatched entries whose worker left no durable trace (the dispatch was lost)", () => {
    const entries = [entry({ dispatchId: "d-3", nodeId: "todo-2", state: "dispatched" })];
    const result = reconcileDispatchLedger(entries, () => false, "2026-08-19T00:00:00.000Z");
    expect(result.entries[0]!.state).toBe("settled-release");
    expect(result.entries[0]!.settledReason).toBe("crash-recovered");
    expect(result.committed).toEqual({});
    expect(result.outstanding).toEqual({});
  });

  it("leaves already-terminal entries untouched and does not double-count them", () => {
    const committed = entry({ dispatchId: "d-4", nodeId: "todo-1", state: "settled-commit", settledReason: "committed", settledAt: "2026-08-18T00:00:00.000Z" });
    const released = entry({ dispatchId: "d-5", nodeId: "todo-2", state: "settled-release", settledReason: "cancel-fenced", settledAt: "2026-08-18T00:00:00.000Z" });
    const result = reconcileDispatchLedger([committed, released], () => true, "2026-08-19T00:00:00.000Z");
    expect(result.recovered).toBe(0);
    expect(result.entries[0]!.settledReason).toBe("committed");
    expect(result.entries[0]!.settledAt).toBe("2026-08-18T00:00:00.000Z");
    expect(result.entries[1]!.settledReason).toBe("cancel-fenced");
    expect(result.committed).toEqual({});
    expect(result.outstanding).toEqual({});
  });

  it("folds committed sums and leaves outstanding sums for entries still live after reconciliation", () => {
    const entries = [
      entry({ dispatchId: "d-6", nodeId: "todo-1", state: "dispatched", budgetReserved: { delegations: 2 } }),
      entry({ dispatchId: "d-7", nodeId: "todo-2", state: "dispatched", budgetReserved: { delegations: 1 } }),
      entry({ dispatchId: "d-8", nodeId: "todo-3", state: "reserved", budgetReserved: { delegations: 1 } })
    ];
    // todo-1 has artifacts (commit), todo-2 has no artifacts (release), todo-3 reserved (release).
    const result = reconcileDispatchLedger(entries, (nodeId) => nodeId === "todo-1", "2026-08-19T00:00:00.000Z");
    expect(result.recovered).toBe(3);
    expect(result.committed).toEqual({ delegations: 2 });
    // Everything settled terminal, so outstanding is empty.
    expect(result.outstanding).toEqual({});
    expect(result.entries.map((entry) => entry.state)).toEqual(["settled-commit", "settled-release", "settled-release"]);
  });
});

describe("ExecutionBudget.reconcileDispatchLedger (B2 budget recovery)", () => {
  it("replaces the untrusted reserved map with ledger-derived outstanding and folds committed exactly once", () => {
    // A crashed process left leaked reservations: every handle died, so reserved is un-settleable.
    const leaked = new ExecutionBudget(
      { delegations: 8, attempts: 10 },
      {
        startedAt: new Date(Date.now() - 5_000).toISOString(),
        elapsedMs: 5_000,
        limits: { delegations: 8, attempts: 10 },
        used: { delegations: 1 },
        reserved: { delegations: 5, attempts: 2 }
      }
    );
    // Ledger says: one dispatched entry with worker artifacts (committed) and nothing still outstanding.
    leaked.reconcileDispatchLedger("delegations", { committed: 1, outstanding: 0 });
    const snapshot = leaked.snapshot();
    // The leaked reserved.delegations=5 is gone; the ledger is the authority.
    expect(snapshot.reserved).toEqual({});
    // used.delegations was 1, plus the committed ledger entry folded once = 2 (not doubled to 3+).
    expect(snapshot.used.delegations).toBe(2);
    // The leaked attempts reservation is cleared too (every handle died).
    expect(snapshot.reserved.attempts).toBeUndefined();
  });

  it("rebuilds reserved from outstanding ledger entries so a live dispatch still holds quota", () => {
    const budget = new ExecutionBudget(
      { delegations: 4 },
      {
        startedAt: new Date().toISOString(),
        elapsedMs: 0,
        limits: { delegations: 4 },
        used: { delegations: 0 },
        reserved: { delegations: 9 }
      }
    );
    budget.reconcileDispatchLedger("delegations", { committed: 0, outstanding: 2 });
    const snapshot = budget.snapshot();
    expect(snapshot.reserved.delegations).toBe(2);
    // A subsequent reserve must succeed against the rebuilt (not leaked) reserved total.
    const handle = budget.reserve("delegations", 1);
    handle.commit();
    expect(budget.snapshot().used.delegations).toBe(1);
  });

  it("does not fold committed when the ledger has no committed entries", () => {
    const budget = new ExecutionBudget(
      { delegations: 4 },
      {
        startedAt: new Date().toISOString(),
        elapsedMs: 0,
        limits: { delegations: 4 },
        used: { delegations: 3 },
        reserved: { delegations: 1 }
      }
    );
    budget.reconcileDispatchLedger("delegations", { committed: 0, outstanding: 0 });
    const snapshot = budget.snapshot();
    expect(snapshot.used.delegations).toBe(3);
    expect(snapshot.reserved).toEqual({});
  });
});

describe("recoverDispatchLedgers (B2 daemon startup scan)", () => {
  it("force-settles outstanding ledger entries in dead runs and reports the count", async () => {
    const dataRoot = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot });
    const runId = "run-dead-ledger";
    const runStore = await RunStore.create(path.join(dataRoot, "artifacts"), runId);
    await runStore.writeArtifact("supervisor-state.json", {
      schemaVersion: 1,
      round: 3,
      delegations: 2,
      dispatchLedger: [
        entry({ dispatchId: "d-1", nodeId: "todo-1", state: "reserved" }),
        entry({ dispatchId: "d-2", nodeId: "todo-2", state: "dispatched" })
      ]
    });

    const result = await service.recoverDispatchLedgers();
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.reconciled).toBe(2);
    expect(result.incidents).toEqual([]);

    const settled = JSON.parse(
      fs.readFileSync(path.join(dataRoot, "artifacts", "runs", runId, "supervisor-state.json"), "utf8")
    ) as { dispatchLedger: DispatchLedgerEntry[] };
    for (const ledgerEntry of settled.dispatchLedger) {
      expect(["settled-commit", "settled-release"]).toContain(ledgerEntry.state);
      expect(ledgerEntry.settledReason).toBe("startup-recovered");
      expect(ledgerEntry.settledAt).toBeTruthy();
    }
  });

  it("skips runs whose ledger is already all-terminal", async () => {
    const dataRoot = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot });
    const runId = "run-terminal-ledger";
    const runStore = await RunStore.create(path.join(dataRoot, "artifacts"), runId);
    await runStore.writeArtifact("supervisor-state.json", {
      schemaVersion: 1,
      round: 2,
      delegations: 1,
      dispatchLedger: [
        entry({ dispatchId: "d-1", nodeId: "todo-1", state: "settled-commit", settledReason: "committed", settledAt: "2026-08-18T00:00:00.000Z" })
      ]
    });

    const result = await service.recoverDispatchLedgers();
    expect(result.reconciled).toBe(0);
    expect(result.incidents).toEqual([]);
  });

  it("reports an incident for an unreadable supervisor-state.json instead of crashing startup", async () => {
    const dataRoot = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot });
    const runId = "run-corrupt-ledger";
    const runDir = path.join(dataRoot, "artifacts", "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "supervisor-state.json"), "{ not valid json");

    const result = await service.recoverDispatchLedgers();
    expect(result.incidents).toContainEqual({ runId, reason: "supervisor-state.json is unreadable" });
    expect(result.reconciled).toBe(0);
  });

  it("does not touch a run that still has an active invocation (the live process owns it)", async () => {
    const dataRoot = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot });
    const runId = "run-active-ledger";
    const runStore = await RunStore.create(path.join(dataRoot, "artifacts"), runId);
    await runStore.writeArtifact("supervisor-state.json", {
      schemaVersion: 1,
      round: 2,
      delegations: 1,
      dispatchLedger: [entry({ dispatchId: "d-1", nodeId: "todo-1", state: "dispatched" })]
    });
    // Register a live (non-terminal) invocation owning this run.
    await service.store.mutate((state) => {
      state.invocations["inv-active"] = {
        id: "inv-active",
        runId,
        status: "running",
        source: { kind: "workbench" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      } as never;
    });

    const result = await service.recoverDispatchLedgers();
    expect(result.reconciled).toBe(0);
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]!.runId).toBe(runId);
    expect(result.incidents[0]!.reason).toContain("active run has 1 outstanding dispatch ledger entries");

    // The entry is untouched.
    const untouched = JSON.parse(
      fs.readFileSync(path.join(dataRoot, "artifacts", "runs", runId, "supervisor-state.json"), "utf8")
    ) as { dispatchLedger: DispatchLedgerEntry[] };
    expect(untouched.dispatchLedger[0]!.state).toBe("dispatched");
  });
});

// --- In-run crash-window resume (B2): the restore block reconciles outstanding ledger entries ---

function fenceTestPlan(): ExecutionPlan {
  return {
    architecture: "supervisor",
    workflow: "ledger-resume",
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
        id: "p", version: 1, instructions: "test", allowedRoleIds: ["builder"],
        limits: { maxRounds: 5, maxDelegations: 8, maxParallelDelegations: 3, maxDurationMs: 60_000 },
        failure: { workerFailure: "observe-and-replan" },
        completion: { requireDelegation: false, requireAllDelegationsSuccessful: false }
      },
      members: [{ roleId: "builder", role: "builder", employeeId: "b", description: "", capabilities: [] }],
      flow: { version: 1, stages: [], gates: [] }
    }
  };
}

function fenceTestManifest(): LoadedManifest {
  return {
    manifest: {
      version: 1, name: "m", providers: { mock: { id: "mock", adapter: "mock" } },
      roles: {
        supervisor: { identity: { id: "supervisor" }, provider: "mock", requestTemplate: "", outputSchema: "" },
        builder: { identity: { id: "builder" }, provider: "mock", requestTemplate: "", outputSchema: "" }
      },
      workflows: {}
    },
    manifestPath: "", projectRoot: ""
  } as unknown as LoadedManifest;
}

function passedNode(node: ExecutionPlanNode, output: JsonValue): NodeRunResult {
  return { nodeId: node.id, roleId: node.role, status: "passed", attempts: 1, output, completedAt: new Date().toISOString() };
}

describe("in-run crash-window resume (B2 restore reconciliation)", () => {
  it("reconciles reserved and dispatched entries at resume and rebuilds the budget without doubling", async () => {
    // Durable state as left by a killed process: one reserved row (never spawned), one dispatched
    // row whose worker left durable artifacts (todo-1 has attempts), one already-settled row.
    const resumeState = {
      schemaVersion: 1,
      round: 2,
      delegations: 1,
      planRevision: 1,
      latestNodeIds: ["supervisor-r1"],
      remainingDurationMs: null,
      history: [],
      dynamicTodos: null,
      dagTrackers: null,
      gates: [],
      memberSessions: [],
      delegationLedger: [],
      gateSequence: 0,
      impact: null,
      dispatchLedger: [
        entry({ dispatchId: "d-1", nodeId: "todo-9", state: "reserved" }),
        entry({ dispatchId: "d-2", nodeId: "todo-1", state: "dispatched" }),
        entry({ dispatchId: "d-3", nodeId: "todo-0", state: "settled-commit", settledReason: "committed", settledAt: "2026-08-18T00:00:00.000Z" })
      ],
      dispatchSequence: 3
    };
    // The budget as left by the killed process: one committed delegation plus a leaked reservation
    // whose handle died with the process (un-settleable, would deadlock future reserves).
    const budget = new ExecutionBudget(
      { delegations: 8, depth: 10 },
      {
        startedAt: new Date(Date.now() - 5_000).toISOString(),
        elapsedMs: 5_000,
        limits: { delegations: 8, depth: 10 },
        used: { delegations: 1 },
        reserved: { delegations: 5 }
      }
    );
    const events: Array<{ type: string; detail?: JsonValue }> = [];
    const artifacts: Record<string, unknown> = {};
    const run: WorkflowRunRecord = {
      id: "run-resume", workflow: "ledger-resume", architecture: "supervisor",
      manifestPath: "", artifactDir: "", status: "running",
      createdAt: new Date().toISOString(),
      // todo-1 has durable worker artifacts (attempts > 0); todo-9 does not.
      nodes: { "todo-1": { nodeId: "todo-1", roleId: "builder", status: "passed", attempts: 1 } }
    };
    const context: ArchitectureExecutionContext = {
      loaded: fenceTestManifest(),
      input: {},
      plan: fenceTestPlan(),
      run,
      budget,
      scheduleNode: async () => {},
      executeNode: async (node) => {
        if (node.role === "supervisor") {
          return passedNode(node, { action: "finish", summary: "Done", result: { delivered: true } } as unknown as JsonValue);
        }
        return passedNode(node, { message: "done" } as unknown as JsonValue);
      },
      readArtifact: (async (relativePath: string) =>
        (relativePath === "supervisor-state.json" ? resumeState : undefined)
      ) as ArchitectureExecutionContext["readArtifact"],
      writeArtifact: async (relativePath, value) => { artifacts[relativePath] = value; },
      candidateSnapshot: async () => ({ revision: "r1", changedFiles: [] }) as never,
      executionRoot: () => "",
      getCancellationEpoch: () => 0,
      executionPackageScripts: async () => ({}),
      persist: async () => {},
      emit: async (type, _nodeId, detail) => { events.push({ type, detail: detail as JsonValue | undefined }); }
    };

    await supervisorArchitectureAdapter.execute(context);

    // The restore block reconciled the two outstanding entries (d-1, d-2) and left d-3 untouched.
    const recovered = events.filter((event) => event.type === "supervisor.dispatch.recovered");
    expect(recovered).toHaveLength(1);
    expect((recovered[0]!.detail as { recovered: number }).recovered).toBe(2);

    // The next durable supervisor-state write carries an all-terminal ledger.
    const states = Object.values(artifacts).filter((value): value is { dispatchLedger?: DispatchLedgerEntry[] } =>
      typeof value === "object" && value !== null && Array.isArray((value as { dispatchLedger?: unknown }).dispatchLedger)
    );
    expect(states.length).toBeGreaterThan(0);
    const finalLedger = states.at(-1)!.dispatchLedger!;
    expect(finalLedger).toHaveLength(3);
    for (const ledgerEntry of finalLedger) {
      expect(["settled-commit", "settled-release"]).toContain(ledgerEntry.state);
    }
    // d-2 (todo-1, artifacts present) was committed; d-1 (todo-9, no artifacts) was released.
    const d1 = finalLedger.find((ledgerEntry) => ledgerEntry.dispatchId === "d-1")!;
    const d2 = finalLedger.find((ledgerEntry) => ledgerEntry.dispatchId === "d-2")!;
    expect(d1.state).toBe("settled-release");
    expect(d2.state).toBe("settled-commit");
    expect(d2.settledReason).toBe("crash-recovered");

    // Budget: the leaked reserved.delegations=5 was cleared (ledger is authority), and the committed
    // entry was folded exactly once — used.delegations is 2 (prior 1 + recovered 1), not doubled.
    // (reserved.depth=0 is the round loop's own reserve/commit, unrelated to the delegation ledger.)
    const snapshot = budget.snapshot();
    expect(snapshot.reserved.delegations).toBeUndefined();
    expect(snapshot.used.delegations).toBe(2);
  });
});
