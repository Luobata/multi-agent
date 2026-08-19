import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../src/core/types.js";
import type { ProviderRegistry } from "../src/runtime/providers.js";
import { compactSupervisorHistory } from "../src/architectures/supervisor.js";
import { WorkbenchService } from "../src/workbench/service.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-supervisor-history-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function providerResponse(value: JsonValue): { stdout: string; stderr: string; durationMs: number } {
  return { stdout: JSON.stringify(value), stderr: "", durationMs: 1 };
}

function planTodosResponse(todoCount: number): { stdout: string; stderr: string; durationMs: number } {
  return providerResponse({
    action: "plan-todos",
    summary: "Split the work into serial milestones.",
    impact: {
      level: "low",
      regressionScope: "targeted",
      affectedAreas: ["src/feature.ts"],
      reasons: ["The change is isolated to one local feature."],
      requiredChecks: ["feature behavior"]
    },
    todos: Array.from({ length: todoCount }, (_unused, index) => ({
      id: `todo-${index + 1}`,
      roleId: "builder",
      task: `Implement milestone ${index + 1}.`,
      needs: index === 0 ? [] : [`todo-${index}`],
      workKind: "code",
      changeSet: "feature",
      sessionKey: "history-builder"
    }))
  });
}

function delegateResponse(todoId: string, round: number): { stdout: string; stderr: string; durationMs: number } {
  return providerResponse({
    action: "delegate",
    summary: `Delegate round ${round} marker`,
    assignments: [{ todoId, roleId: "builder" }]
  });
}

function finishResponse(): { stdout: string; stderr: string; durationMs: number } {
  return providerResponse({ action: "finish", summary: "Done.", result: { delivered: true } });
}

function supervisorRound(invocation: { templateContext: Record<string, unknown> }): number {
  const node = invocation.templateContext.node as { with?: { __supervisorRound?: number } };
  return Number(node.with?.__supervisorRound ?? 0);
}

async function createTeam(service: WorkbenchService, providerId: string): Promise<void> {
  await service.createEmployee({
    id: "history-lead",
    identity: { displayName: "Lead", background: "Coordinates work.", responsibilities: ["Plan", "Deliver"] },
    capabilities: ["quality.audit"],
    providerId
  });
  await service.createEmployee({
    id: "history-builder",
    identity: { displayName: "Builder", background: "Builds code.", responsibilities: ["Implement"] },
    capabilities: ["code.backend"],
    providerId
  });
  await service.createManagementPolicy({
    id: "history-policy",
    allowedRoleIds: ["builder"],
    instructions: "Delegate explicit work and deliver only after required Gates pass.",
    limits: { maxRounds: 12, maxDelegations: 12, maxParallelDelegations: 2, maxDurationMs: 60_000 }
  });
}

async function createWorkflow(service: WorkbenchService): Promise<void> {
  await service.createWorkflow({
    id: "history-supervision",
    architecture: "supervisor",
    supervisor: { employeeId: "history-lead" },
    managementPolicy: { id: "history-policy" },
    members: [{ roleId: "builder", employeeId: "history-builder" }]
  });
}

describe("supervisor history compaction (unit)", () => {
  const decisionEntry = (round: number, action: string): JsonValue => ({
    round,
    supervisorNodeId: `supervisor-r${round}`,
    decision: { action, summary: `round ${round} summary` }
  });

  it("keeps the last K rounds verbatim and compresses older rounds to one-line strings", () => {
    const history: JsonValue[] = [
      decisionEntry(1, "plan-todos"),
      decisionEntry(2, "delegate"),
      decisionEntry(3, "delegate"),
      decisionEntry(4, "finish")
    ];
    const compacted = compactSupervisorHistory(history, 5, 2);

    expect(compacted.keepRounds).toBe(2);
    expect(compacted.compactedEntries).toBe(3);
    expect(compacted.compactedRounds).toBe(3);
    // Rounds 1-3 (currentRound 5 - keepRounds 2 = 3) are compressed; round 4 stays verbatim.
    expect(typeof compacted.entries[0]).toBe("string");
    expect(String(compacted.entries[0])).toContain("[r1] plan-todos");
    expect(String(compacted.entries[1])).toContain("[r2] delegate");
    expect(compacted.entries[3]).toEqual(decisionEntry(4, "finish"));
    expect(compacted.charsSaved).toBeGreaterThan(0);
  });

  it("keeps human decisions verbatim regardless of age", () => {
    const humanEntry: JsonValue = {
      round: 1,
      supervisorNodeId: "supervisor-r1",
      decision: { action: "request-human-decision", riskCategory: "dependency-install", summary: "risky" },
      humanDecision: {
        requestId: "req-1",
        decision: "rejected",
        decidedBy: "owner",
        comment: "Use the existing standard library instead.",
        candidateUrl: null
      }
    };
    const compacted = compactSupervisorHistory([humanEntry, decisionEntry(2, "delegate")], 9, 1);

    expect(compacted.entries[0]).toEqual(humanEntry);
    expect(JSON.stringify(compacted.entries[0])).toContain("Use the existing standard library instead.");
    // The ordinary round-2 entry is still compressed (round 2 <= 9 - 1).
    expect(typeof compacted.entries[1]).toBe("string");
  });

  it("keeps Gate decisions and Gate snapshots verbatim regardless of age", () => {
    const gateEntry: JsonValue = {
      round: 1,
      supervisorNodeId: "supervisor-r1",
      decision: { action: "satisfy-gate", gateId: "quality-test", summary: "gate evidence", evidence: { ok: true } }
    };
    const gateSnapshotEntry: JsonValue = {
      round: 2,
      supervisorNodeId: "supervisor-r2",
      decision: { action: "finish", summary: "intercepted" },
      finishIntercepted: true,
      gates: [{ gateId: "quality-test", status: "blocked", reason: "needs evidence" }]
    };
    const compacted = compactSupervisorHistory([gateEntry, gateSnapshotEntry, decisionEntry(3, "delegate")], 9, 1);

    expect(compacted.entries[0]).toEqual(gateEntry);
    expect(compacted.entries[1]).toEqual(gateSnapshotEntry);
    expect(typeof compacted.entries[2]).toBe("string");
  });

  it("summarizes delegation outcomes and rejection reasons deterministically", () => {
    const delegationEntry: JsonValue = {
      round: 1,
      supervisorNodeId: "supervisor-r1",
      decision: { action: "delegate", assignments: [{ todoId: "todo-1", roleId: "builder" }] },
      delegations: [{ nodeId: "worker-1", roleId: "builder", status: "passed" }]
    };
    const rejectedEntry: JsonValue = {
      round: 2,
      supervisorNodeId: "supervisor-r2",
      decision: { action: "delegate", assignments: [{ todoId: "todo-2", roleId: "builder" }] },
      decisionRejected: "assignment references an unknown todo"
    };
    const compacted = compactSupervisorHistory([delegationEntry, rejectedEntry], 9, 0);

    expect(String(compacted.entries[0])).toBe("[r1] delegate → roles=[builder] → statuses=[passed]");
    expect(String(compacted.entries[1])).toContain("[r2] delegate → roles=[builder]");
    expect(String(compacted.entries[1])).toContain("rejected=assignment references an unknown todo");
    // Deterministic: same input, same output.
    expect(compactSupervisorHistory([delegationEntry, rejectedEntry], 9, 0)).toEqual(compacted);
  });

  it("saves zero characters and compresses nothing when all rounds are within K", () => {
    const history: JsonValue[] = [decisionEntry(1, "plan-todos"), decisionEntry(2, "finish")];
    const compacted = compactSupervisorHistory(history, 3, 6);

    expect(compacted.compactedEntries).toBe(0);
    expect(compacted.charsSaved).toBe(0);
    expect(compacted.entries).toEqual(history);
  });

  it("does not mutate the input history", () => {
    const history: JsonValue[] = [decisionEntry(1, "plan-todos"), decisionEntry(2, "finish")];
    const snapshot = JSON.stringify(history);
    compactSupervisorHistory(history, 4, 1);
    expect(JSON.stringify(history)).toBe(snapshot);
  });
});

describe("supervisor history compaction (integration)", () => {
  it("compacts aged rounds in the injected prompt, keeps recent rounds verbatim, emits an event, and persists the full history", async () => {
    const supervisorPrompts: string[] = [];
    const providers: ProviderRegistry = new Map([["history-flow", {
      id: "history-flow",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        if (role === "supervisor") {
          supervisorPrompts.push(invocation.prompt);
          const round = supervisorRound(invocation);
          if (round === 1) return planTodosResponse(6);
          if (round >= 2 && round <= 7) return delegateResponse(`todo-${round - 1}`, round);
          return finishResponse();
        }
        return providerResponse({ message: "done" });
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("history-provider", { adapter: "history-flow", outputProtocol: "json" });
    await createTeam(service, "history-provider");
    await createWorkflow(service);
    const providerCwd = temporaryRoot();
    fs.writeFileSync(path.join(providerCwd, "package.json"), JSON.stringify({ scripts: {} }));

    const result = await service.runWorkbenchWorkflow(
      "history-supervision",
      { message: "Build the feature." },
      { kind: "workbench" },
      { providerCwd }
    );

    expect(result.run.status, JSON.stringify(result.run.output)).toBe("passed");
    expect(supervisorPrompts.length).toBe(8);
    const finalPrompt = supervisorPrompts[7]!;
    // Rounds 1-2 are beyond the default keep window (6) and appear as compressed one-liners.
    expect(finalPrompt).toContain("[r1] plan-todos");
    expect(finalPrompt).toContain("[r2] delegate");
    // Round 7 is within the keep window: its full decision text is injected verbatim.
    expect(finalPrompt).toContain("Delegate round 7 marker");
    // Round 2's full decision text was compressed out of the prompt.
    expect(finalPrompt).not.toContain("Delegate round 2 marker");
    // Compaction is observable in the run event ledger.
    const events = fs.readFileSync(path.join(result.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("supervisor.history-compacted");
    // Persisted state keeps the full, uncompacted history.
    const persistedState = fs.readFileSync(path.join(result.runDir, "supervisor-state.json"), "utf8");
    expect(persistedState).toContain("Delegate round 2 marker");
  });
});
