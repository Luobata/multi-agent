import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  cancelInvocation,
  encodeMetadataHeaderValue,
  getSession,
  monitorInvocation,
  startInvocation,
  waitInvocationOnce,
  type InvocationStartReceipt,
  type InvocationWaitResult
} from "./api";
import type { InvocationProgress, InvocationRecord, InvocationStatus } from "./types";

afterEach(() => vi.unstubAllGlobals());

describe("Workbench HTTP metadata", () => {
  it("encodes Unicode metadata as an ASCII-only header value", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ data: { ok: true } }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    await api("/api/example", {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "x-multi-agent-source": "workbench",
        "x-multi-agent-source-label": "直接交办调试台"
      }
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Headers;
    expect(headers.get("x-multi-agent-source")).toBe("workbench");
    expect(headers.get("x-multi-agent-source-label")).toBe(`utf8:${encodeURIComponent("直接交办调试台")}`);
  });

  it("leaves existing ASCII metadata unchanged", () => {
    expect(encodeMetadataHeaderValue("MCP conversation")).toBe("MCP conversation");
  });
});

const timestamp = "2026-08-15T00:00:00.000Z";

function invocationRecord(status: InvocationStatus): InvocationRecord {
  return {
    id: "inv-1",
    target: { kind: "employee", id: "product-manager", version: 1 },
    source: { kind: "workbench" },
    status,
    phase: "执行",
    requestSummary: "测试工单",
    runId: "run-1",
    sessionId: "sess-1",
    instanceIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    transitions: []
  };
}

function receiptFixture(): InvocationStartReceipt {
  return {
    invocation: invocationRecord("queued"),
    runId: "run-1",
    statusUrl: "/api/invocations/inv-1",
    progressUrl: "/api/invocations/inv-1/progress",
    streamUrl: "/api/invocations/inv-1/stream",
    monitor: {
      mode: "long-poll",
      tool: "wait_workflow_progress",
      initialCursor: "inv-1:0",
      defaultTimeoutMs: 20_000,
      maxTimeoutMs: 60_000,
      instructions: "long poll",
      waitUrl: "/api/invocations/inv-1/progress/wait"
    }
  };
}

function progressFixture(status: InvocationStatus, terminal: boolean): InvocationProgress {
  return {
    invocationId: "inv-1",
    runId: "run-1",
    workflowId: "wf-1",
    architecture: "graph",
    status,
    phase: "执行",
    terminal,
    updatedAt: timestamp,
    round: 1,
    tally: { queued: 0, waiting: 0, running: 1, "cancellation-requested": 0, completed: 0, blocked: 0, failed: 0, skipped: 0, cancelled: 0 },
    steps: [],
    leaderReport: { available: false, rounds: 0, delegations: 0, entries: [], gates: [] }
  };
}

function waitResultFixture(overrides: Partial<InvocationWaitResult> & { nextCursor: string }): InvocationWaitResult {
  return {
    invocationId: "inv-1",
    changed: false,
    terminal: false,
    reason: "heartbeat",
    progressReport: "",
    progress: progressFixture("running", false),
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Invocation async helpers", () => {
  it("posts a start request and returns the parsed receipt", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: receiptFixture() }, 202));
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await startInvocation("/api/employees/product-manager/start", { message: "你好" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/employees/product-manager/start");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ message: "你好" });
    expect(receipt.invocation.id).toBe("inv-1");
    expect(receipt.monitor.waitUrl).toBe("/api/invocations/inv-1/progress/wait");
  });

  it("advances the cursor across changed, heartbeat and terminal responses", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: waitResultFixture({ nextCursor: "inv-1:1", changed: true, reason: "changed" }) }))
      .mockResolvedValueOnce(jsonResponse({ data: waitResultFixture({ nextCursor: "inv-1:2" }) }))
      .mockResolvedValueOnce(jsonResponse({ data: waitResultFixture({
        nextCursor: "inv-1:3",
        terminal: true,
        reason: "terminal",
        progress: progressFixture("completed", true)
      }) }));
    vi.stubGlobal("fetch", fetchMock);
    const seen: InvocationWaitResult[] = [];

    const terminal = await monitorInvocation(receiptFixture(), { onUpdate: (result) => seen.push(result), yieldMs: 0 });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain("cursor=inv-1%3A0");
    expect(urls[1]).toContain("cursor=inv-1%3A1");
    expect(urls[2]).toContain("cursor=inv-1%3A2");
    expect(urls.every((url) => url.includes("timeoutMs=20000"))).toBe(true);
    expect(seen).toHaveLength(3);
    expect(terminal?.terminal).toBe(true);
    expect(terminal?.progress.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a malformed wait result instead of advancing", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: { invocationId: "inv-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(waitInvocationOnce("/api/invocations/inv-1/progress/wait", "inv-1:0")).rejects.toThrow("无法识别");
  });

  it("rethrows a failed wait and resumes from an explicit startCursor on retry", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: waitResultFixture({ nextCursor: "inv-1:1", changed: true, reason: "changed" }) }))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse({ data: waitResultFixture({
        nextCursor: "inv-1:2",
        terminal: true,
        reason: "terminal",
        progress: progressFixture("completed", true)
      }) }));
    vi.stubGlobal("fetch", fetchMock);

    // 第一轮：游标推进到 inv-1:1 后第二次 wait 抛错，错误原样抛给调用方。
    await expect(monitorInvocation(receiptFixture(), { yieldMs: 0 })).rejects.toThrow("network down");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("cursor=inv-1%3A0");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=inv-1%3A1");

    // 调用方用最后可见游标重挂监听：不回 initialCursor，不重新 /start。
    const terminal = await monitorInvocation(receiptFixture(), { yieldMs: 0, startCursor: "inv-1:1" });
    expect(terminal?.terminal).toBe(true);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("cursor=inv-1%3A1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops quietly when aborted without further wait calls", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      return jsonResponse({ data: waitResultFixture({ nextCursor: "inv-1:1" }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await monitorInvocation(receiptFixture(), { signal: controller.signal, yieldMs: 0 });

    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("posts cancellation with the workbench-operator actor and fetches sessions by id", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: invocationRecord("cancellation-requested") }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "sess-1", messages: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await cancelInvocation("inv-1", "不需要了");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/invocations/inv-1/cancel");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ actor: "workbench-operator", reason: "不需要了" });

    await getSession("sess-1");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/sessions/sess-1");
  });
});
