import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createRequirementReader,
  deliveryLane,
  invocationLane,
  latestRequirementInvocation,
  loadRequirementsFile,
  projectRequirement,
  type RequirementServerRecord
} from "../src/workbench/requirementService.js";
import type { InvocationRecord, InvocationStatus } from "../src/workbench/types.js";

function record(overrides: Partial<RequirementServerRecord> = {}): RequirementServerRecord {
  return {
    schemaVersion: 1,
    id: "req-1",
    legacyClientId: "req-local-1",
    projectId: "proj-1",
    code: "R-1",
    title: "标题",
    summary: "摘要",
    priority: "medium",
    owner: "owner",
    rawRequirement: "原始需求",
    acceptanceCriteria: ["标准一"],
    intentLane: "inbox",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    revision: 1,
    ...overrides
  };
}

function invocation(status: InvocationStatus, overrides: Partial<InvocationRecord> = {}): InvocationRecord {
  return {
    id: `inv-${status}`,
    target: { kind: "workflow", id: "wf", version: 1 },
    source: { kind: "workbench", project: "proj-1", taskId: "req-local-1" },
    status,
    phase: "running",
    requestSummary: "summary",
    runId: `run-${status}`,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T01:00:00.000Z",
    ...overrides
  } as InvocationRecord;
}

describe("requirement server projection (P1)", () => {
  it("maps invocation statuses with client parity", () => {
    expect(invocationLane("queued")).toBe("queued");
    expect(invocationLane("running")).toBe("running");
    expect(invocationLane("cancellation-requested")).toBe("running");
    expect(invocationLane("awaiting-human-decision")).toBe("confirmation");
    // An ended attempt is an unresolved product obligation → confirmation.
    expect(invocationLane("completed")).toBe("confirmation");
    expect(invocationLane("blocked")).toBe("confirmation");
    expect(invocationLane("failed")).toBe("confirmation");
    expect(invocationLane("cancelled")).toBe("confirmation");
  });

  it("maps the full delivery status set to lanes", () => {
    expect(deliveryLane("merged")).toBe("done");
    expect(deliveryLane("returned-to-acceptance")).toBe("acceptance");
    expect(deliveryLane("awaiting-acceptance")).toBe("acceptance");
    expect(deliveryLane("kept")).toBe("acceptance");
    expect(deliveryLane("discarded")).toBe("inbox");
    expect(deliveryLane("queued-for-merge")).toBe("merging");
    expect(deliveryLane("retesting")).toBe("merging");
    expect(deliveryLane("merging")).toBe("merging");
    expect(deliveryLane("conflict")).toBe("merging");
  });

  it("projects pure intent when no execution facts exist", () => {
    const projected = projectRequirement(record({ intentLane: "clarify" }));
    expect(projected.lane).toBe("clarify");
    expect(projected.exception).toBeNull();
    expect(projected.invocation).toBeUndefined();
  });

  it("derives the lane from the latest invocation fact", () => {
    const projected = projectRequirement(record(), invocation("running"));
    expect(projected.lane).toBe("running");
    expect(projected.invocation?.id).toBe("inv-running");
  });

  it("flags blocked/failed/cancelled as exceptions in confirmation", () => {
    for (const status of ["blocked", "failed", "cancelled"] as const) {
      const projected = projectRequirement(record(), invocation(status));
      expect(projected.lane).toBe("confirmation");
      expect(projected.exception).toBe(status);
    }
  });

  it("outranks the invocation status with a fixed acceptance or delivery lifecycle", () => {
    const accepted = projectRequirement(record({ acceptance: { runId: "run-x", snapshot: {}, submittedAt: "2026-08-20T00:00:00.000Z" } }), invocation("completed"));
    expect(accepted.lane).toBe("acceptance");
    const merging = projectRequirement(record(), invocation("completed"), { status: "retesting", runId: "run-completed", updatedAt: "2026-08-20T02:00:00.000Z" });
    expect(merging.lane).toBe("merging");
    const done = projectRequirement(record(), invocation("completed"), { status: "merged", runId: "run-completed", updatedAt: "2026-08-20T02:00:00.000Z" });
    expect(done.lane).toBe("done");
  });

  it("keeps a kept candidate visible in acceptance without merging", () => {
    const byDecision = projectRequirement(record({
      decision: { kind: "keep", runId: "run-completed", at: "2026-08-20T03:00:00.000Z", actor: "human" }
    }), invocation("completed"), { status: "conflict", runId: "run-completed", updatedAt: "2026-08-20T02:00:00.000Z" });
    expect(byDecision.lane).toBe("acceptance");
    expect(byDecision.keptWithoutMerge?.runId).toBe("run-completed");
    const byDelivery = projectRequirement(record(), invocation("completed"), { status: "kept", runId: "run-completed", updatedAt: "2026-08-20T04:00:00.000Z" });
    expect(byDelivery.lane).toBe("acceptance");
    expect(byDelivery.keptWithoutMerge?.runId).toBe("run-completed");
  });

  it("returns a discarded candidate to inbox for a fresh cycle", () => {
    const projected = projectRequirement(record({
      decision: { kind: "discard", runId: "run-completed", at: "2026-08-20T03:00:00.000Z", actor: "human" }
    }), invocation("failed"), { status: "discarded", runId: "run-completed", updatedAt: "2026-08-20T04:00:00.000Z" });
    expect(projected.lane).toBe("inbox");
  });

  it("joins invocations by legacy client id or canonical id within the project", () => {
    const invocations = {
      a: invocation("running", { id: "a", updatedAt: "2026-08-20T01:00:00.000Z" }),
      b: invocation("completed", {
        id: "b",
        updatedAt: "2026-08-20T02:00:00.000Z",
        source: { kind: "workbench", project: "proj-1", taskId: "req-local-1", contextId: "requirement-lineage:lin-1" }
      }),
      otherProject: invocation("failed", { id: "otherProject", updatedAt: "2026-08-20T03:00:00.000Z", source: { kind: "workbench", project: "proj-2", taskId: "req-local-1" } }),
      otherTask: invocation("cancelled", { id: "otherTask", updatedAt: "2026-08-20T04:00:00.000Z", source: { kind: "workbench", project: "proj-1", taskId: "req-local-999" } })
    };
    expect(latestRequirementInvocation(record(), invocations)?.id).toBe("b");
    expect(latestRequirementInvocation(record({ legacyClientId: undefined }), invocations)?.id).toBeUndefined();
  });

  it("reads an empty domain when requirements.json is absent", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "req-svc-"));
    const file = await loadRequirementsFile(dataRoot);
    expect(file).toEqual({ schemaVersion: 1, requirements: {} });
    const reader = createRequirementReader({
      dataRoot,
      snapshot: () => ({ invocations: {} }),
      readDelivery: async () => undefined
    });
    expect(await reader.list()).toEqual([]);
    expect(await reader.get("req-1")).toBeUndefined();
  });

  it("loads records and projects them through the reader with delivery join", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "req-svc-"));
    await fs.writeFile(path.join(dataRoot, "requirements.json"), JSON.stringify({
      schemaVersion: 1,
      requirements: {
        "req-1": record({ intentLane: "planned" })
      }
    }, null, 2), "utf8");
    const reader = createRequirementReader({
      dataRoot,
      snapshot: () => ({ invocations: { inv: invocation("completed") } }),
      readDelivery: async (runDir, runId) => ({ status: "queued-for-merge", runId, updatedAt: `${runDir}-at` })
    });
    const listed = await reader.list("proj-1");
    expect(listed).toHaveLength(1);
    const projected = listed[0];
    if (!projected) throw new Error("expected one projected requirement");
    expect(projected.lane).toBe("merging");
    expect(projected.delivery?.runId).toBe("run-completed");
    expect(await reader.list("proj-other")).toEqual([]);
    const detail = await reader.get("req-1");
    expect(detail?.invocation?.status).toBe("completed");
  });

  it("rejects an unsupported requirements.json schema", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "req-svc-"));
    await fs.writeFile(path.join(dataRoot, "requirements.json"), JSON.stringify({ schemaVersion: 9, requirements: {} }), "utf8");
    await expect(loadRequirementsFile(dataRoot)).rejects.toThrow(/unsupported schema/);
  });
});
