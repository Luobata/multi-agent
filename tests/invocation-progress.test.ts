import { describe, expect, it } from "vitest";
import { computeInvocationProgress } from "../src/workbench/invocationProgress.js";
import type { InvocationDetail, InvocationRecord, WorkInstanceRecord } from "../src/workbench/types.js";

const timestamp = "2026-08-05T00:00:00.000Z";

function invocation(overrides: Partial<InvocationRecord> = {}): InvocationRecord {
  return {
    id: "inv-1",
    target: { kind: "workflow", id: "review-supervisor", version: 1 },
    source: { kind: "workbench" },
    status: "running",
    phase: "executing",
    requestSummary: "Organize the review team.",
    runId: "run-abc",
    instanceIds: [],
    executionSnapshot: {
      workflow: { id: "review-supervisor", version: 1, architecture: "supervisor" },
      employees: []
    },
    createdAt: timestamp,
    startedAt: timestamp,
    updatedAt: timestamp,
    transitions: [],
    ...overrides
  };
}

function instance(overrides: Partial<WorkInstanceRecord> & { nodeId: string }): WorkInstanceRecord {
  return {
    id: `work-${overrides.nodeId}`,
    invocationId: "inv-1",
    employeeId: "emp",
    employeeVersion: 1,
    workflowId: "review-supervisor",
    workflowVersion: 1,
    runId: "run-abc",
    providerId: "mock",
    source: { kind: "workbench" },
    status: "queued",
    phase: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    transitions: [],
    ...overrides
  };
}

describe("computeInvocationProgress", () => {
  it("aggregates the leader narrative, round, and per-status tally for a running supervisor invocation", () => {
    const detail: InvocationDetail = {
      invocation: invocation({ instanceIds: ["work-supervisor-r1", "work-member-frontend", "work-supervisor-r2"] }),
      instances: [
        instance({ nodeId: "supervisor-r1", kind: "supervisor", roleId: "supervisor", round: 1, status: "completed", phase: "done" }),
        instance({ nodeId: "member-frontend", kind: "member", roleId: "frontend", round: 1, status: "running", phase: "provider" }),
        instance({ nodeId: "supervisor-r2", kind: "supervisor", roleId: "supervisor", round: 2, status: "running", phase: "provider" })
      ],
      run: {
        id: "run-abc",
        status: "running",
        nodes: {
          "supervisor-r1": {
            metadata: { kind: "supervisor", round: 1 },
            status: "passed",
            output: {
              action: "delegate",
              summary: "先让前端实现界面。",
              assignments: [{ roleId: "frontend", task: "实现登录界面", workKind: "code" }]
            }
          },
          "member-frontend": { metadata: { kind: "member", round: 1, roleId: "frontend" }, status: "running" },
          "supervisor-r2": { metadata: { kind: "supervisor", round: 2 }, status: "running" }
        }
      }
    };

    const progress = computeInvocationProgress(detail);

    expect(progress.status).toBe("running");
    expect(progress.terminal).toBe(false);
    expect(progress.round).toBe(2);
    expect(progress.tally.completed).toBe(1);
    expect(progress.tally.running).toBe(2);
    expect(progress.steps.map((step) => step.nodeId)).toEqual(["supervisor-r1", "member-frontend", "supervisor-r2"]);

    expect(progress.leaderReport.available).toBe(true);
    expect(progress.leaderReport.entries).toHaveLength(2);
    const first = progress.leaderReport.entries[0]!;
    expect(first.round).toBe(1);
    expect(first.action).toBe("delegate");
    expect(first.summary).toBe("先让前端实现界面。");
    expect(first.assignments).toEqual([{ roleId: "frontend", task: "实现登录界面", workKind: "code" }]);
    expect(progress.leaderReport.delegations).toBe(1);
  });

  it("surfaces the final outcome once the run finishes", () => {
    const detail: InvocationDetail = {
      invocation: invocation({ status: "completed", phase: "done", completedAt: timestamp, instanceIds: ["work-supervisor-r1"] }),
      instances: [instance({ nodeId: "supervisor-r1", kind: "supervisor", round: 1, status: "completed", phase: "done" })],
      run: {
        id: "run-abc",
        status: "passed",
        output: { summary: "评审通过并交付。", rounds: 1, delegations: 2, gates: [{ gateId: "audit", status: "passed" }] },
        nodes: {
          "supervisor-r1": {
            metadata: { kind: "supervisor", round: 1 },
            status: "passed",
            output: { action: "finish", summary: "评审通过并交付。", result: { delivered: true } }
          }
        }
      }
    };

    const progress = computeInvocationProgress(detail);

    expect(progress.terminal).toBe(true);
    expect(progress.outcome).toEqual({ status: "passed", summary: "评审通过并交付。" });
    expect(progress.leaderReport.gates).toEqual([{ gateId: "audit", status: "passed" }]);
    expect(progress.leaderReport.rounds).toBe(1);
    expect(progress.leaderReport.delegations).toBe(2);
  });

  it("projects durable supervisor state and includes its revision in the wait cursor sequence", () => {
    const detail: InvocationDetail = {
      invocation: invocation({ transitions: [{ status: "running", phase: "executing", at: timestamp }] }),
      instances: [instance({
        nodeId: "implement",
        status: "running",
        phase: "provider",
        transitions: [{ status: "running", phase: "provider", at: timestamp }]
      })],
      run: {
        id: "run-abc",
        status: "running",
        architectureState: {
          schemaVersion: 1,
          kind: "supervisor",
          sequence: 4,
          round: 2,
          planRevision: 1,
          scheduling: {
            mode: "iterative",
            schedulerVersion: 1,
            compiledDispatchEnabled: false,
            shadowReadyNodeIds: []
          },
          dag: {
            nodes: [{
              nodeId: "verify",
              status: "pending",
              ready: false,
              whyNotRunning: [{ kind: "dependency", nodeId: "implement", status: "running", expectedStatuses: ["passed"] }]
            }]
          }
        },
        nodes: {}
      }
    };

    const progress = computeInvocationProgress(detail);

    expect(progress.sequence).toBe(6);
    expect(progress.supervisor).toMatchObject({
      kind: "supervisor",
      sequence: 4,
      planRevision: 1,
      scheduling: { mode: "iterative", compiledDispatchEnabled: false },
      dag: { nodes: [expect.objectContaining({ nodeId: "verify", ready: false })] }
    });
  });

  it("surfaces a TODO plan and one retained member session as one progress step", () => {
    const detail: InvocationDetail = {
      invocation: invocation({
        instanceIds: ["work-supervisor-r1", "work-builder-session"],
        status: "running",
        phase: "executing"
      }),
      instances: [
        instance({ nodeId: "supervisor-r1", kind: "supervisor", roleId: "supervisor", round: 1, status: "completed", phase: "done" }),
        instance({
          nodeId: "wire-caller",
          nodeIds: ["implement-helper", "wire-caller"],
          kind: "member",
          roleId: "builder",
          round: 3,
          todoId: "wire-caller",
          memberSessionId: "member-session-builder-local-helper",
          status: "running",
          phase: "provider"
        })
      ],
      run: {
        id: "run-abc",
        status: "running",
        nodes: {
          "supervisor-r1": {
            metadata: { kind: "supervisor", round: 1 },
            status: "passed",
            output: {
              action: "plan-todos",
              summary: "拆成两个连续小任务。",
              impact: {
                level: "low",
                regressionScope: "targeted",
                affectedAreas: ["src/local-helper.ts"],
                reasons: ["局部改动"],
                requiredChecks: ["定向单测"]
              },
              todos: [
                { id: "implement-helper", roleId: "builder", task: "实现 helper", needs: [], workKind: "code" },
                { id: "wire-caller", roleId: "builder", task: "接入调用方", needs: ["implement-helper"], workKind: "code" }
              ]
            }
          },
          "wire-caller": { metadata: { kind: "member", round: 3, roleId: "builder" }, status: "running" }
        }
      }
    };

    const progress = computeInvocationProgress(detail);

    expect(progress.leaderReport.entries[0]).toMatchObject({
      action: "plan-todos",
      summary: "拆成两个连续小任务。",
      assignments: [
        { todoId: "implement-helper", roleId: "builder", task: "实现 helper", workKind: "code" },
        { todoId: "wire-caller", roleId: "builder", task: "接入调用方", workKind: "code" }
      ]
    });
    expect(progress.leaderReport.delegations).toBe(0);
    expect(progress.steps[1]).toMatchObject({
      nodeId: "wire-caller",
      nodeIds: ["implement-helper", "wire-caller"],
      todoId: "wire-caller",
      memberSessionId: "member-session-builder-local-helper"
    });
  });

  it("degrades gracefully when no run record is available yet", () => {
    const detail: InvocationDetail = {
      invocation: invocation({ status: "queued", phase: "queued" }),
      instances: [],
      run: undefined
    };

    const progress = computeInvocationProgress(detail);

    expect(progress.round).toBe(0);
    expect(progress.steps).toEqual([]);
    expect(progress.leaderReport.available).toBe(false);
    expect(progress.outcome).toBeUndefined();
  });
});
