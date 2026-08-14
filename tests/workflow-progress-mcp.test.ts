import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { encodeUtf8HeaderValue } from "../src/core/httpHeaders.js";
import { createWorkbenchMcpServer } from "../src/mcp/server.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workflow progress MCP contract", () => {
  it("declares the mandatory monitor loop and forwards wait/continue requests", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const server = createWorkbenchMcpServer("http://127.0.0.1:4318");
    const client = new Client({ name: "workflow-progress-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const start = listed.tools.find((tool) => tool.name === "start_workflow");
      const startPublication = listed.tools.find((tool) => tool.name === "start_publication");
      const resume = listed.tools.find((tool) => tool.name === "resume_workflow_monitor");
      const wait = listed.tools.find((tool) => tool.name === "wait_workflow_progress");
      const cancel = listed.tools.find((tool) => tool.name === "cancel_workflow");
      const snapshot = listed.tools.find((tool) => tool.name === "get_workflow_progress");
      const continuation = listed.tools.find((tool) => tool.name === "continue_workflow_conversation");
      const dispatch = listed.tools.find((tool) => tool.name === "dispatch_entrance_policy");
      expect(start?.description).toContain("MUST immediately loop wait_workflow_progress");
      expect(start?.description).toContain("MUST NOT end the current turn");
      expect(startPublication?.description).toContain("MUST immediately loop wait_workflow_progress");
      expect(startPublication?.description).toContain("stable Publication boundary");
      expect(resume?.description).toContain("known runId");
      expect(resume?.description).toContain("MUST NOT end the current turn");
      expect(wait?.description).toContain("terminal=false");
      expect(wait?.description).toContain("heartbeat");
      expect(wait?.description).toContain("MUST NOT be injected into model context");
      expect(cancel?.description).toContain("idempotent");
      expect(snapshot?.description).toContain("Compatibility snapshot");
      expect(continuation?.description).toContain("rejects arbitrary Employee Sessions");
      expect(dispatch?.description).toContain("invocation-started");
      expect(wait?.inputSchema).toMatchObject({
        properties: {
          invocationId: { type: "string" },
          cursor: { type: "string" },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 55000 }
        }
      });
      expect(start?.inputSchema).toMatchObject({ properties: { idempotencyKey: { type: "string" } } });
      expect(startPublication?.inputSchema).toMatchObject({ properties: { idempotencyKey: { type: "string" } } });
      expect(dispatch?.inputSchema).toMatchObject({
        properties: { source: { properties: { idempotencyKey: { type: "string" } } } }
      });

      await client.callTool({ name: "start_workflow", arguments: {
        workflowId: "review-flow",
        input: { message: "持续评审" },
        project: "中文项目",
        idempotencyKey: "工作流:req-1"
      } });
      await client.callTool({
        name: "start_publication",
        arguments: { publicationId: "review-package", input: { message: "持续评审" }, project: "desk", idempotencyKey: "publication:req-1" }
      });
      await client.callTool({
        name: "resume_workflow_monitor",
        arguments: { runId: "run-2026-08-10T00-00-00-000Z-demo" }
      });
      await client.callTool({
        name: "wait_workflow_progress",
        arguments: { invocationId: "inv-1", cursor: "v1:cursor", timeoutMs: 12_000 }
      });
      await client.callTool({
        name: "cancel_workflow",
        arguments: { invocationId: "inv-1", reason: "stop" }
      });
      await client.callTool({
        name: "continue_workflow_conversation",
        arguments: { leaderSessionId: "leader-session-1", message: "继续说明", project: "desk" }
      });
      expect(requests[0]?.url).toBe("http://127.0.0.1:4318/api/workflows/review-flow/start");
      expect(requests[0]?.init?.method).toBe("POST");
      expect(new Headers(requests[0]?.init?.headers).get("x-multi-agent-project")).toBe(encodeUtf8HeaderValue("中文项目"));
      expect(new Headers(requests[0]?.init?.headers).get("x-multi-agent-idempotency-key")).toBe(encodeUtf8HeaderValue("工作流:req-1"));
      expect(requests[1]?.url).toBe("http://127.0.0.1:4318/api/publications/review-package/start");
      expect(new Headers(requests[1]?.init?.headers).get("x-multi-agent-idempotency-key")).toBe(encodeUtf8HeaderValue("publication:req-1"));
      expect(requests[2]?.url).toBe(
        "http://127.0.0.1:4318/api/runs/run-2026-08-10T00-00-00-000Z-demo/monitor"
      );
      expect(requests[3]?.url).toBe(
        "http://127.0.0.1:4318/api/invocations/inv-1/progress/wait?cursor=v1%3Acursor&timeoutMs=12000"
      );
      expect(requests[4]?.url).toBe("http://127.0.0.1:4318/api/invocations/inv-1/cancel");
      expect(requests[5]?.url).toBe("http://127.0.0.1:4318/api/workflow-conversations/continue");
      expect(JSON.parse(String(requests[5]?.init?.body))).toEqual({
        leaderSessionId: "leader-session-1",
        message: "继续说明"
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
