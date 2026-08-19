import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchService } from "../src/workbench/service.js";

const roots: string[] = [];
function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-retention-"));
  roots.push(value);
  return value;
}
afterEach(() => roots.splice(0).forEach((value) => fs.rmSync(value, { recursive: true, force: true })));

const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

/** Seeds a mixed-age, mixed-status state across invocations, sessions, and work instances. */
async function seedMixedState(service: WorkbenchService): Promise<void> {
  await service.store.mutate((state) => {
    // Old terminal invocation (20 days) — candidate.
    state.invocations["inv-old"] = {
      id: "inv-old",
      target: { kind: "workflow", id: "wf", version: 1 },
      source: { kind: "workbench" },
      status: "completed",
      phase: "completed",
      requestSummary: "old run",
      runId: "run-old",
      instanceIds: [],
      createdAt: daysAgo(21),
      updatedAt: daysAgo(20),
      completedAt: daysAgo(20),
      transitions: [{ at: daysAgo(20), status: "completed", phase: "completed" }]
    } as never;
    // Active invocation — protected.
    state.invocations["inv-active"] = {
      id: "inv-active",
      target: { kind: "workflow", id: "wf", version: 1 },
      source: { kind: "workbench" },
      status: "running",
      phase: "running",
      requestSummary: "active run",
      runId: "run-active",
      instanceIds: [],
      createdAt: daysAgo(0),
      updatedAt: daysAgo(0),
      transitions: [{ at: daysAgo(0), status: "running", phase: "running" }]
    } as never;

    // Old closed session (20 days) — candidate.
    state.sessions["session-old"] = {
      id: "session-old",
      employeeId: "emp-1",
      employeeVersion: 1,
      title: "Old conversation",
      status: "closed",
      messages: [{ id: "m-1", role: "user", content: "done", at: daysAgo(20) }],
      createdAt: daysAgo(25),
      updatedAt: daysAgo(20)
    } as never;
    // Young closed session (5 days) — protected by age.
    state.sessions["session-young"] = {
      id: "session-young",
      employeeId: "emp-1",
      employeeVersion: 1,
      title: "Recent conversation",
      status: "closed",
      messages: [{ id: "m-2", role: "user", content: "recent", at: daysAgo(5) }],
      createdAt: daysAgo(6),
      updatedAt: daysAgo(5)
    } as never;
    // Active session — protected.
    state.sessions["session-active"] = {
      id: "session-active",
      employeeId: "emp-1",
      employeeVersion: 1,
      title: "Live conversation",
      status: "active",
      messages: [],
      createdAt: daysAgo(1),
      updatedAt: daysAgo(0)
    } as never;

    // Old terminal work instance (20 days, completed) — candidate.
    state.workInstances["wi-old"] = {
      id: "wi-old",
      invocationId: "inv-old",
      employeeId: "emp-1",
      employeeVersion: 1,
      workflowId: "wf",
      workflowVersion: 1,
      nodeId: "node-1",
      runId: "run-old",
      providerId: "mock",
      source: { kind: "workbench" },
      status: "completed",
      phase: "completed",
      createdAt: daysAgo(21),
      updatedAt: daysAgo(20),
      completedAt: daysAgo(20),
      transitions: [{ at: daysAgo(20), status: "completed", phase: "completed" }]
    } as never;
    // Young terminal work instance (5 days) — protected by age.
    state.workInstances["wi-young"] = {
      id: "wi-young",
      invocationId: "inv-old",
      employeeId: "emp-1",
      employeeVersion: 1,
      workflowId: "wf",
      workflowVersion: 1,
      nodeId: "node-2",
      runId: "run-old",
      providerId: "mock",
      source: { kind: "workbench" },
      status: "completed",
      phase: "completed",
      createdAt: daysAgo(6),
      updatedAt: daysAgo(5),
      completedAt: daysAgo(5),
      transitions: [{ at: daysAgo(5), status: "completed", phase: "completed" }]
    } as never;
    // Non-terminal work instance (running) — protected.
    state.workInstances["wi-running"] = {
      id: "wi-running",
      invocationId: "inv-active",
      employeeId: "emp-1",
      employeeVersion: 1,
      workflowId: "wf",
      workflowVersion: 1,
      nodeId: "node-3",
      runId: "run-active",
      providerId: "mock",
      source: { kind: "workbench" },
      status: "running",
      phase: "running",
      createdAt: daysAgo(0),
      updatedAt: daysAgo(0),
      transitions: [{ at: daysAgo(0), status: "running", phase: "running" }]
    } as never;
  });
}

describe("retention extension (A0): sessions + work instances", () => {
  it("previews old terminal sessions and work instances while protecting active and young records", async () => {
    const service = await WorkbenchService.open({ dataRoot: root() });
    await seedMixedState(service);

    const preview = await service.previewRetention({});
    // One old invocation, one old closed session, one old terminal work instance.
    expect(preview.candidates.map((c) => c.invocationId)).toEqual(["inv-old"]);
    expect(preview.sessions.map((s) => s.sessionId)).toEqual(["session-old"]);
    expect(preview.workInstances.map((w) => w.instanceId)).toEqual(["wi-old"]);
    expect(preview.deleteCount).toBe(3);
    // Status-protected records: active session, running work instance, active invocation.
    // (Age-protected records are simply skipped, not counted as protected.)
    expect(preview.protected).toBe(3);
    // The token digest spans all three domains.
    expect(preview.token).toMatch(/^DELETE-[A-F0-9]{12}$/);
    expect(preview.irreversible).toContain("session history");
    expect(preview.irreversible).toContain("work instance history");
    // Estimated bytes cover all three domains.
    expect(preview.estimatedBytes).toBeGreaterThan(0);
    expect(preview.sessions[0]!.estimatedBytes).toBeGreaterThan(0);
    expect(preview.workInstances[0]!.estimatedBytes).toBeGreaterThan(0);
  });

  it("defaults to a 14-day terminal cutoff", async () => {
    const service = await WorkbenchService.open({ dataRoot: root() });
    await service.store.mutate((state) => {
      // 10 days old — inside the 14-day window, protected.
      state.sessions["s-10d"] = {
        id: "s-10d", employeeId: "e", employeeVersion: 1, title: "t", status: "closed",
        messages: [], createdAt: daysAgo(11), updatedAt: daysAgo(10)
      } as never;
      // 20 days old — outside the window, candidate.
      state.sessions["s-20d"] = {
        id: "s-20d", employeeId: "e", employeeVersion: 1, title: "t", status: "closed",
        messages: [], createdAt: daysAgo(21), updatedAt: daysAgo(20)
      } as never;
    });

    const preview = await service.previewRetention({});
    expect(preview.sessions.map((s) => s.sessionId)).toEqual(["s-20d"]);
  });

  it("deletes all three domains with the confirmation token and refuses a wrong token", async () => {
    const service = await WorkbenchService.open({ dataRoot: root() });
    await seedMixedState(service);

    const preview = await service.previewRetention({});
    await expect(service.applyRetention({}, "WRONG-TOKEN")).rejects.toThrow("confirmation token required");

    const result = await service.applyRetention({}, preview.token);
    expect(result.deleted).toBe(3);
    const snapshot = service.snapshot();
    expect(snapshot.invocations["inv-old"]).toBeUndefined();
    expect(snapshot.sessions["session-old"]).toBeUndefined();
    expect(snapshot.workInstances["wi-old"]).toBeUndefined();
    // Protected records survive.
    expect(snapshot.sessions["session-young"]).toBeDefined();
    expect(snapshot.sessions["session-active"]).toBeDefined();
    expect(snapshot.workInstances["wi-running"]).toBeDefined();
    expect(snapshot.invocations["inv-active"]).toBeDefined();
  });

  it("refuses to apply when a session was reopened between preview and apply (token mismatch)", async () => {
    const service = await WorkbenchService.open({ dataRoot: root() });
    await seedMixedState(service);

    const preview = await service.previewRetention({});
    // The session is reopened after the preview but before apply.
    await service.store.mutate((state) => {
      state.sessions["session-old"]!.status = "active";
    });

    // The reopened session changed the candidate set, so the preview token is stale.
    await expect(service.applyRetention({}, preview.token)).rejects.toThrow("confirmation token required");
    // The reopened session survives.
    expect(service.snapshot().sessions["session-old"]).toBeDefined();
  });

  it("refuses to apply when a work instance left the terminal state between preview and apply (token mismatch)", async () => {
    const service = await WorkbenchService.open({ dataRoot: root() });
    await seedMixedState(service);

    const preview = await service.previewRetention({});
    await service.store.mutate((state) => {
      state.workInstances["wi-old"]!.status = "running";
    });

    await expect(service.applyRetention({}, preview.token)).rejects.toThrow("confirmation token required");
    expect(service.snapshot().workInstances["wi-old"]).toBeDefined();
  });

  it("changes the token when a session domain record is added or removed", async () => {
    const service = await WorkbenchService.open({ dataRoot: root() });
    await seedMixedState(service);

    const before = (await service.previewRetention({})).token;
    await service.store.mutate((state) => {
      delete state.sessions["session-old"];
    });
    const after = (await service.previewRetention({})).token;
    expect(after).not.toBe(before);
  });
});
