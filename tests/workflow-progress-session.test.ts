import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderRegistry } from "../src/runtime/providers.js";
import { WorkbenchService } from "../src/workbench/service.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-workflow-session-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function createSupervisorFixture(options: { blockFirstSupervisor?: boolean; dataRoot?: string } = {}) {
  let release = () => {};
  let started = () => {};
  let progressSettled = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  const providerProgressSettled = new Promise<void>((resolve) => { progressSettled = resolve; });
  let supervisorCalls = 0;
  const prompts: string[] = [];
  const providers: ProviderRegistry = new Map([["leader-session-test", {
    id: "leader-session-test",
    validate: () => [],
    invoke: async (invocation) => {
      prompts.push(invocation.prompt);
      const role = invocation.templateContext.role as { id: string };
      const round = Number((invocation.templateContext.node as { with?: { __supervisorRound?: number } }).with?.__supervisorRound ?? 0);
      if (role.id === "supervisor" && round > 0) {
        supervisorCalls += 1;
        started();
        await invocation.onProgress?.({
          kind: "output",
          at: new Date().toISOString(),
          stream: "stdout",
          chunkBytes: 1,
          totalBytes: 1,
          elapsedMs: 1,
          idleMs: 0,
          softTimeoutMs: 10_000,
          idleTimeoutMs: 20_000,
          hardTimeoutMs: 30_000,
          longRunning: false
        });
        await invocation.onProgress?.({
          kind: "output",
          at: new Date().toISOString(),
          stream: "stdout",
          chunkBytes: 1,
          totalBytes: 1,
          elapsedMs: 2,
          idleMs: 0,
          softTimeoutMs: 10_000,
          idleTimeoutMs: 20_000,
          hardTimeoutMs: 30_000,
          longRunning: false
        });
        progressSettled();
        if (options.blockFirstSupervisor) await gate;
        return {
          stdout: JSON.stringify({ action: "finish", summary: "领队已完成最终交付。", result: { delivered: true } }),
          stderr: "",
          durationMs: 1
        };
      }
      return {
        stdout: JSON.stringify({ message: "已在原领队会话中继续回答。" }),
        stderr: "",
        durationMs: 1
      };
    }
  }]]);
  const service = await WorkbenchService.open({ dataRoot: options.dataRoot ?? temporaryRoot(), providers });
  await service.putProvider("leader-session-provider", {
    adapter: "leader-session-test",
    model: "leader-session-model",
    outputProtocol: "json"
  });
  await service.createEmployee({
    id: "durable-leader",
    identity: { displayName: "Durable Leader", background: "Leads durable work.", responsibilities: ["Deliver"] },
    providerId: "leader-session-provider"
  });
  await service.createEmployee({
    id: "durable-member",
    identity: { displayName: "Durable Member", background: "Supports work.", responsibilities: ["Support"] },
    providerId: "leader-session-provider"
  });
  await service.createManagementPolicy({
    id: "durable-policy",
    allowedRoleIds: ["member"],
    instructions: "Finish when the task is already complete."
  });
  await service.createWorkflow({
    id: "durable-supervisor",
    architecture: "supervisor",
    supervisor: { employeeId: "durable-leader" },
    managementPolicy: { id: "durable-policy" },
    members: [{ roleId: "member", employeeId: "durable-member" }]
  });
  return {
    service,
    providers,
    providerStarted,
    providerProgressSettled,
    release,
    prompts,
    supervisorCalls: () => supervisorCalls
  };
}

describe("Supervisor workflow progress sessions", () => {
  it("creates a pinned active leader Session, persists deduplicated progress and terminal delivery, and keeps Graph separate", async () => {
    const fixture = await createSupervisorFixture();
    const receipt = await fixture.service.startWorkbenchWorkflow("durable-supervisor", { message: "完成持久会话任务" });
    expect(receipt.leaderSessionId).toBeTruthy();
    expect(receipt.monitor).toMatchObject({
      mode: "long-poll",
      tool: "wait_workflow_progress",
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 55_000
    });
    await fixture.service.waitForInvocation(receipt.invocation.id);

    const session = fixture.service.getSession(receipt.leaderSessionId!);
    expect(session).toMatchObject({
      employeeId: "durable-leader",
      employeeVersion: 1,
      status: "active",
      supervisor: {
        architecture: "supervisor",
        invocationId: receipt.invocation.id,
        runId: receipt.runId,
        workflowId: "durable-supervisor",
        workflowVersion: 1
      }
    });
    expect(session.messages[0]).toMatchObject({ role: "user", content: "完成持久会话任务" });
    expect(session.messages[1]).toMatchObject({ role: "system", content: expect.stringContaining("正在后台执行") });
    expect(session.messages.at(-1)).toMatchObject({ role: "employee", content: expect.stringContaining("领队已完成最终交付") });
    const dedupeKeys = session.messages.flatMap((message) => message.dedupeKey ? [message.dedupeKey] : []);
    expect(new Set(dedupeKeys).size).toBe(dedupeKeys.length);
    expect(dedupeKeys.filter((key) => key.startsWith("supervisor-delivery:"))).toHaveLength(1);

    await fixture.service.createWorkflow({
      id: "plain-graph-session-check",
      nodes: [{ id: "respond", employeeId: "durable-member" }]
    });
    const graph = await fixture.service.startWorkbenchWorkflow("plain-graph-session-check", { message: "Graph task" });
    expect(graph.leaderSessionId).toBeUndefined();
    expect(graph.invocation.sessionId).toBeUndefined();
    await fixture.service.waitForInvocation(graph.invocation.id);
  }, 10_000);

  it("long-polls on changes and terminal state, emits a timeout heartbeat, and cleans every listener", async () => {
    const fixture = await createSupervisorFixture({ blockFirstSupervisor: true });
    const receipt = await fixture.service.startWorkbenchWorkflow("durable-supervisor", { message: "等待后台完成" });
    await fixture.providerStarted;
    await fixture.providerProgressSettled;
    const current = await fixture.service.waitForWorkflowProgress(receipt.invocation.id);
    let activeListeners = 0;
    const subscribe = fixture.service.subscribeActivity.bind(fixture.service);
    vi.spyOn(fixture.service, "subscribeActivity").mockImplementation((listener) => {
      activeListeners += 1;
      const unsubscribe = subscribe(listener);
      return () => {
        activeListeners -= 1;
        unsubscribe();
      };
    });

    const heartbeat = await fixture.service.waitForWorkflowProgress(receipt.invocation.id, {
      cursor: current.nextCursor,
      timeoutMs: 1_000
    });
    expect(heartbeat).toMatchObject({ changed: false, terminal: false, reason: "heartbeat" });
    expect(heartbeat.progressReport).toContain("心跳汇报");
    expect(activeListeners).toBe(0);

    await expect(fixture.service.continueWorkflowConversation(receipt.leaderSessionId!, "运行中不应插话"))
      .rejects.toThrow(/still running/);
    const controller = new AbortController();
    const abortedPromise = fixture.service.waitForWorkflowProgress(receipt.invocation.id, {
      cursor: heartbeat.nextCursor,
      timeoutMs: 5_000,
      signal: controller.signal
    });
    for (let attempt = 0; attempt < 100 && activeListeners === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(activeListeners).toBe(1);
    controller.abort();
    await expect(abortedPromise).rejects.toThrow(/aborted/);
    expect(activeListeners).toBe(0);

    const changedPromise = fixture.service.waitForWorkflowProgress(receipt.invocation.id, {
      cursor: heartbeat.nextCursor,
      timeoutMs: 5_000
    });
    for (let attempt = 0; attempt < 100 && activeListeners === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(activeListeners).toBe(1);
    fixture.release();
    let terminal = await changedPromise;
    expect(terminal.changed).toBe(true);
    expect(activeListeners).toBe(0);
    while (!terminal.terminal) {
      terminal = await fixture.service.waitForWorkflowProgress(receipt.invocation.id, {
        cursor: terminal.nextCursor,
        timeoutMs: 5_000
      });
      expect(activeListeners).toBe(0);
    }
    await fixture.service.waitForInvocation(receipt.invocation.id);
    expect(terminal).toMatchObject({ changed: true, terminal: true, reason: "terminal", leaderSessionId: receipt.leaderSessionId });
    expect(terminal.progressReport).toContain("领队已完成最终交付");
    expect(activeListeners).toBe(0);
  }, 10_000);

  it("continues with the pinned leader version after terminal delivery and rejects arbitrary Session reuse", async () => {
    const fixture = await createSupervisorFixture();
    const receipt = await fixture.service.startWorkbenchWorkflow("durable-supervisor", {
      message: "先完成原任务",
      context: { ticket: "T-1" }
    });
    await fixture.service.waitForInvocation(receipt.invocation.id);
    await fixture.service.updateEmployee("durable-leader", { description: "Version two must not replace the pinned leader." });

    const continued = await fixture.service.continueWorkflowConversation(
      receipt.leaderSessionId!,
      "请解释刚才的交付",
      { kind: "mcp", caller: "host" }
    );
    expect(continued.session.id).toBe(receipt.leaderSessionId);
    expect(continued.session.employeeVersion).toBe(1);
    expect(continued.session.status).toBe("active");
    expect(continued.session.context).toEqual({ ticket: "T-1" });
    expect(continued.message).toBe("已在原领队会话中继续回答。");
    expect(fixture.prompts.at(-1)).toContain("先完成原任务");
    expect(fixture.prompts.at(-1)).toContain("领队已完成最终交付");
    await expect(fixture.service.invokeEmployee("durable-leader", {
      message: "不允许绕过专用入口",
      sessionId: receipt.leaderSessionId
    })).rejects.toThrow(/continue_workflow_conversation/);

    const ordinary = await fixture.service.invokeEmployee("durable-member", { message: "普通会话" });
    await expect(fixture.service.continueWorkflowConversation(ordinary.session.id, "伪装成领队"))
      .rejects.toThrow(/not a Supervisor workflow leader session/);
  }, 10_000);

  it("does not create an orphan leader Session for the synchronous compatibility run", async () => {
    const fixture = await createSupervisorFixture();
    const result = await fixture.service.runWorkbenchWorkflow("durable-supervisor", { message: "同步兼容任务" });
    const invocation = fixture.service.getActivitySnapshot().invocations.find((candidate) => candidate.runId === result.run.id);
    expect(invocation?.sessionId).toBeUndefined();
    expect(fixture.service.listSessions("durable-leader")).toEqual([]);
  }, 10_000);

  it("keeps an interrupted leader Session readable and continuable after restart with an interruption explanation", async () => {
    const dataRoot = temporaryRoot();
    const fixture = await createSupervisorFixture({ blockFirstSupervisor: true, dataRoot });
    const receipt = await fixture.service.startWorkbenchWorkflow("durable-supervisor", { message: "会被重启中断的任务" });
    await fixture.providerStarted;

    const reopened = await WorkbenchService.open({ dataRoot, providers: fixture.providers });
    await reopened.recoverInterruptedActivity();
    const interrupted = reopened.getSession(receipt.leaderSessionId!);
    expect(interrupted.status).toBe("active");
    expect(interrupted.messages.at(-1)?.content).toContain("Local runtime restarted before this invocation completed");
    expect((await reopened.getInvocationDetail(receipt.invocation.id)).invocation).toMatchObject({
      status: "failed",
      phase: "interrupted"
    });

    const continued = await reopened.continueWorkflowConversation(receipt.leaderSessionId!, "原运行发生了什么？");
    expect(continued.message).toBe("已在原领队会话中继续回答。");
    expect(continued.session.status).toBe("active");
  }, 10_000);
});
