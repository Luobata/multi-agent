import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderRegistry } from "../src/runtime/providers.js";
import { WorkbenchService } from "../src/workbench/service.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-employee-async-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("asynchronous Employee invocations", () => {
  it("returns a durable receipt, supports Run monitor recovery, and serializes turns in one Session", async () => {
    let releaseFirst = () => {};
    let markFirstStarted = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let providerCalls = 0;
    const providers: ProviderRegistry = new Map([["employee-async-test", {
      id: "employee-async-test",
      validate: () => [],
      invoke: async () => {
        providerCalls += 1;
        const call = providerCalls;
        if (call === 1) {
          markFirstStarted();
          await firstGate;
        }
        return {
          stdout: JSON.stringify({ message: `async reply ${call}` }),
          stderr: "",
          durationMs: 1
        };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("employee-async-provider", {
      adapter: "employee-async-test",
      model: "employee-async-model",
      outputProtocol: "json"
    });
    await service.createEmployee({
      id: "async-employee",
      identity: {
        displayName: "Async Employee",
        background: "Exercises durable asynchronous turns.",
        responsibilities: ["Respond in order"]
      },
      providerId: "employee-async-provider"
    });

    const first = await service.startEmployee("async-employee", { message: "first turn" });
    expect(first).toMatchObject({
      runId: first.invocation.runId,
      invocation: { target: { kind: "employee", id: "async-employee" }, status: "queued" },
      monitor: { mode: "long-poll", tool: "wait_workflow_progress" }
    });
    expect(first.invocation.sessionId).toBeTruthy();
    await firstStarted;
    expect((await service.getInvocationDetail(first.invocation.id)).invocation.status).toBe("running");

    const second = await service.startEmployee("async-employee", {
      message: "second turn",
      sessionId: first.invocation.sessionId
    });
    expect(providerCalls).toBe(1);
    await expect.poll(async () => service.getInvocationDetail(second.invocation.id)).toMatchObject({
      invocation: { status: "queued", sessionId: first.invocation.sessionId },
      instances: [{ status: "waiting", phase: "waiting-session" }]
    });

    const resumed = await service.resumeInvocationMonitor(first.runId);
    expect(resumed).toMatchObject({
      runId: first.runId,
      invocation: { id: first.invocation.id, target: { kind: "employee" } },
      monitor: { mode: "long-poll" }
    });

    releaseFirst();
    await service.waitForInvocation(first.invocation.id);
    await service.waitForInvocation(second.invocation.id);
    expect(providerCalls).toBe(2);
    expect((await service.getInvocationDetail(first.invocation.id)).invocation.status).toBe("completed");
    expect((await service.getInvocationDetail(second.invocation.id)).invocation.status).toBe("completed");
    expect(service.getSession(first.invocation.sessionId!).messages.map((message) => [message.role, message.content]))
      .toEqual([
        ["user", "first turn"],
        ["employee", "async reply 1"],
        ["user", "second turn"],
        ["employee", "async reply 2"]
      ]);
  });

  it("cancels the tracked Employee provider and keeps the durable Invocation cancelled", async () => {
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const providers: ProviderRegistry = new Map([["employee-cancel-test", {
      id: "employee-cancel-test",
      validate: () => [],
      invoke: async ({ signal }) => {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          const fail = () => reject(new Error("provider observed cancellation"));
          if (signal?.aborted) fail();
          else signal?.addEventListener("abort", fail, { once: true });
        });
        return { stdout: "", stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("employee-cancel-provider", {
      adapter: "employee-cancel-test",
      model: "employee-cancel-model",
      outputProtocol: "json"
    });
    await service.createEmployee({
      id: "cancel-employee",
      identity: {
        displayName: "Cancel Employee",
        background: "Exercises explicit cancellation.",
        responsibilities: ["Stop safely"]
      },
      providerId: "employee-cancel-provider"
    });

    const receipt = await service.startEmployee("cancel-employee", { message: "wait until cancelled" });
    await started;
    const cancelled = await service.requestCancellation(receipt.invocation.id, {
      actor: "test-owner",
      reason: "stop this direct turn",
      graceMs: 100
    });
    expect(cancelled).toMatchObject({
      id: receipt.invocation.id,
      status: "cancelled",
      cancellation: { actor: "test-owner", reason: "stop this direct turn", epoch: 1 }
    });
    await service.waitForInvocation(receipt.invocation.id);
    expect((await service.getInvocationDetail(receipt.invocation.id)).invocation.status).toBe("cancelled");
  });

  it("fails an in-flight Employee turn closed on daemon recovery and keeps its monitor reattachable", async () => {
    let releaseProvider = () => {};
    let markStarted = () => {};
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    let providerCalls = 0;
    const providers: ProviderRegistry = new Map([["employee-restart-test", {
      id: "employee-restart-test",
      validate: () => [],
      invoke: async () => {
        providerCalls += 1;
        markStarted();
        await providerGate;
        return {
          stdout: JSON.stringify({ message: "late response after restart" }),
          stderr: "",
          durationMs: 1
        };
      }
    }]]);
    const dataRoot = temporaryRoot();
    const original = await WorkbenchService.open({ dataRoot, providers });
    await original.putProvider("employee-restart-provider", {
      adapter: "employee-restart-test",
      model: "employee-restart-model",
      outputProtocol: "json"
    });
    await original.createEmployee({
      id: "restart-employee",
      identity: {
        displayName: "Restart Employee",
        background: "Exercises fail-closed daemon recovery.",
        responsibilities: ["Preserve terminal evidence"]
      },
      providerId: "employee-restart-provider"
    });

    const receipt = await original.startEmployee("restart-employee", { message: "survive a daemon restart" });
    await providerStarted;
    const queuedReceipt = await original.startEmployee("restart-employee", {
      message: "queued behind the interrupted turn",
      sessionId: receipt.invocation.sessionId
    });
    const reopened = await WorkbenchService.open({ dataRoot, providers });
    await reopened.recoverInterruptedActivity();
    expect(await reopened.getInvocationDetail(receipt.invocation.id)).toMatchObject({
      invocation: {
        status: "failed",
        phase: "interrupted",
        error: "Local runtime restarted before this invocation completed.",
        cancellation: { actor: "runtime-recovery", epoch: 1 }
      },
      instances: [{ status: "failed", phase: "interrupted", failure: { category: "interrupted", retryable: true } }]
    });
    expect(await reopened.getInvocationDetail(queuedReceipt.invocation.id)).toMatchObject({
      invocation: { status: "failed", phase: "interrupted", cancellation: { actor: "runtime-recovery", epoch: 1 } },
      instances: [{ status: "failed", phase: "interrupted" }]
    });
    const resumed = await reopened.resumeInvocationMonitor(receipt.runId);
    expect(resumed.invocation).toMatchObject({ id: receipt.invocation.id, status: "failed", phase: "interrupted" });
    const terminal = await reopened.waitForWorkflowProgress(receipt.invocation.id, {
      cursor: resumed.monitor.initialCursor,
      timeoutMs: 1_000
    });
    expect(terminal).toMatchObject({ terminal: true, reason: "terminal", progress: { status: "failed" } });

    releaseProvider();
    await original.waitForInvocation(receipt.invocation.id);
    await original.waitForInvocation(queuedReceipt.invocation.id);
    expect(providerCalls).toBe(1);
    expect((await reopened.getInvocationDetail(receipt.invocation.id)).invocation).toMatchObject({
      status: "failed",
      phase: "interrupted",
      error: "Local runtime restarted before this invocation completed.",
      cancellation: { actor: "runtime-recovery", epoch: 1 }
    });
    expect((await reopened.getInvocationDetail(queuedReceipt.invocation.id)).invocation)
      .toMatchObject({ status: "failed", phase: "interrupted", cancellation: { actor: "runtime-recovery", epoch: 1 } });
  });
});
