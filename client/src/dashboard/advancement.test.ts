import { describe, expect, it } from "vitest";
import {
  advancementLane,
  dueRequirementAdvancements,
  observeAdvancement,
  planRequirementAdvancementPoll,
  requirementAdvancementConfig,
  requirementOwnerLabel,
  reserveAdvancement
} from "./advancement";
import type { Requirement, RequirementDetail } from "./types";
import type { Project } from "../types";

function detail(overrides: Partial<RequirementDetail> = {}): RequirementDetail {
  return {
    id: "req-1",
    projectId: "project-1",
    code: "REQ-1",
    title: "推进需求",
    summary: "需要真实执行",
    lane: "inbox",
    exception: null,
    priority: "medium",
    owner: "待分配",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    archivedAt: null,
    rawRequirement: "推进需求",
    acceptanceCriteria: ["可验收"],
    dag: { demo: true, nodes: [] },
    timeline: { demo: true, entries: [] },
    resourceOverview: { demo: true, agents: 0, elapsedMinutes: 0, tokensUsed: 0 },
    evidence: { diffSummary: "", testReport: "", reviewNotes: "", deliverables: [] },
    ...overrides
  };
}

const config = { entrancePolicyId: "requirement-policy", autoPollEnabled: false, pollIntervalMs: 15_000 };

describe("requirement advancement control state", () => {
  it("reads the project-owned policy and polling schedule without hard-coding a workflow", () => {
    const project = {
      connector: {
        kind: "repository-development",
        config: {
          requirementAdvancement: {
            entrancePolicyId: "requirement-policy",
            candidateUrl: "http://127.0.0.1:4319",
            polling: { enabled: true, intervalMs: 30_000 }
          }
        }
      }
    } as unknown as Project;
    expect(requirementAdvancementConfig(project)).toEqual({
      entrancePolicyId: "requirement-policy",
      candidateUrl: "http://127.0.0.1:4319",
      autoPollEnabled: true,
      pollIntervalMs: 30_000
    });
  });

  it("ignores a non-HTTP candidate URL from project configuration", () => {
    const project = { connector: { config: { requirementAdvancement: {
      entrancePolicyId: "requirement-policy", candidateUrl: "file:///tmp/candidate"
    } } } } as unknown as Project;
    expect(requirementAdvancementConfig(project)).not.toHaveProperty("candidateUrl");
  });

  it("reserves a stable key and reuses it after a response-less failure", () => {
    const first = reserveAdvancement(detail(), config, "human", "2026-08-10T01:00:00.000Z");
    expect(first).toMatchObject({ cycle: 1, status: "dispatching" });
    expect(first.idempotencyKey).toMatch(/^requirement:project-1:req-1:advance:1:/);
    const retried = reserveAdvancement(
      detail({ advancement: { ...first, status: "failed", error: "network lost" } }),
      config,
      "automatic",
      "2026-08-10T01:01:00.000Z"
    );
    expect(retried.idempotencyKey).toBe(first.idempotencyKey);
    expect(retried.cycle).toBe(1);
    expect(retried.trigger).toBe("automatic");
  });

  it("rotates only a key proven to belong to another browser-local board", () => {
    const first = reserveAdvancement(detail(), config, "human", "2026-08-10T01:00:00.000Z");
    const retried = reserveAdvancement(detail({ advancement: {
      ...first,
      status: "failed",
      error: `idempotency key ${first.idempotencyKey} is already bound to another workflow Invocation`
    } }), config, "human", "2026-08-10T01:01:00.000Z");
    expect(retried.cycle).toBe(1);
    expect(retried.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(retried.idempotencyKey).toMatch(/^requirement:project-1:req-1:advance:1:/);
  });

  it("keeps concurrent requirements isolated and replaces the pending owner once a cycle exists", () => {
    const first = reserveAdvancement(detail({ id: "req-1" }), config, "human", "2026-08-10T01:00:00.000Z");
    const second = reserveAdvancement(detail({ id: "req-2" }), config, "human", "2026-08-10T01:00:00.000Z");
    expect(first.idempotencyKey).toMatch(/^requirement:project-1:req-1:advance:1:/);
    expect(second.idempotencyKey).toMatch(/^requirement:project-1:req-2:advance:1:/);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(requirementOwnerLabel(detail())).toBe("待分配");
    expect(requirementOwnerLabel(detail({ advancement: first }))).toBe("Agent 团队");
  });

  it("opens a new cycle after a recorded Run fails, while completed delivery stays protected", () => {
    const first = reserveAdvancement(detail(), config, "human", "2026-08-10T01:00:00.000Z");
    const failed = {
      ...first,
      status: "failed" as const,
      invocationId: "inv-1",
      runId: "run-1"
    };
    const next = reserveAdvancement(
      detail({ advancement: failed, exception: "failed" }),
      config,
      "human",
      "2026-08-10T01:05:00.000Z"
    );
    expect(next).toMatchObject({ cycle: 2, status: "dispatching" });
    expect(next.idempotencyKey).toMatch(/^requirement:project-1:req-1:advance:2:/);
    expect(() => reserveAdvancement(
      detail({ advancement: { ...failed, status: "completed" }, exception: null }),
      config,
      "human",
      "2026-08-10T01:05:00.000Z"
    )).toThrow(/已经产生 Run/);
  });

  it("opens a new cycle only for a cancelled requirement backed by a cancelled Invocation", () => {
    const first = reserveAdvancement(detail(), config, "human", "2026-08-10T01:00:00.000Z");
    const cancelled = { ...first, status: "cancelled" as const, invocationId: "inv-cancelled", runId: "run-cancelled" };
    const next = reserveAdvancement(
      detail({ advancement: cancelled, exception: "cancelled", lane: "running" }),
      config,
      "human",
      "2026-08-10T02:00:00.000Z"
    );

    expect(next).toMatchObject({ cycle: 2, status: "dispatching" });
    expect(next.idempotencyKey).not.toBe(cancelled.idempotencyKey);
    expect(() => reserveAdvancement(detail({ exception: "cancelled" }), config, "human", "2026-08-10T02:00:00.000Z"))
      .toThrow("已取消的需求不能开始推进");
    expect(() => reserveAdvancement(
      detail({ advancement: { ...cancelled, status: "completed" }, exception: "cancelled" }),
      config,
      "human",
      "2026-08-10T02:00:00.000Z"
    )).toThrow("这轮推进已经产生 Run");
  });

  it("selects only due active cursors for a future poller and maps execution states to lanes", () => {
    const reserved = reserveAdvancement(detail(), config, "human", "2026-08-10T01:00:00.000Z");
    const due = detail({ advancement: { ...reserved, status: "running", nextCheckAt: "2026-08-10T01:00:15.000Z" } });
    const later = detail({ id: "req-2", advancement: { ...reserved, idempotencyKey: "requirement:req-2:advance:1", nextCheckAt: "2026-08-10T01:05:00.000Z" } });
    const terminal = detail({ id: "req-3", advancement: { ...reserved, status: "completed", nextCheckAt: undefined } });
    expect(dueRequirementAdvancements([due, later, terminal] as Requirement[], "2026-08-10T01:00:20.000Z").map((item) => item.id)).toEqual(["req-1"]);
    expect(advancementLane("queued", "inbox")).toBe("queued");
    expect(advancementLane("awaiting-human-decision", "running")).toBe("confirmation");
    expect(advancementLane("running", "confirmation")).toBe("running");
    expect(advancementLane("blocked", "confirmation")).toBe("running");
    expect(advancementLane("failed", "confirmation")).toBe("running");
    expect(advancementLane("failed", "running")).toBe("running");
  });

  it("ignores an older Invocation observation so the board cannot regress after approval", () => {
    const reserved = reserveAdvancement(detail(), config, "human", "2026-08-10T03:00:00.000Z");
    const current = { ...reserved, invocationId: "inv-1", runId: "run-1", status: "running" as const, updatedAt: "2026-08-10T03:00:02.000Z" };
    expect(observeAdvancement(current, {
      invocationId: "inv-1",
      runId: "run-1",
      status: "awaiting-human-decision",
      observedAt: "2026-08-10T03:00:01.000Z"
    }, 15_000)).toEqual(current);
  });

  it("plans automatic launch and observation actions without performing side effects", () => {
    const automatic = { ...config, autoPollEnabled: true };
    const reserved = reserveAdvancement(detail(), automatic, "automatic", "2026-08-10T01:00:00.000Z");
    const actions = planRequirementAdvancementPoll([
      detail(),
      detail({ id: "req-2", advancement: { ...reserved, idempotencyKey: "requirement:req-2:advance:1", invocationId: "inv-2", status: "running", nextCheckAt: "2026-08-10T01:00:10.000Z" } }),
      detail({ id: "req-3", lane: "clarify" })
    ], () => automatic, "2026-08-10T01:00:20.000Z");
    expect(actions).toEqual([
      { kind: "launch", requirementId: "req-1", config: automatic },
      { kind: "observe", requirementId: "req-2", invocationId: "inv-2", config: automatic }
    ]);
  });
});
