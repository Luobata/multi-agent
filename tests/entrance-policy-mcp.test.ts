import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkbenchMcpServer } from "../src/mcp/server.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Entrance Policy MCP adapter", () => {
  it("registers clear list/get/evaluate/dispatch tools and forwards structured inputs", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const server = createWorkbenchMcpServer("http://127.0.0.1:4318");
    const client = new Client({ name: "entrance-policy-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "list_entrance_policies",
        "get_entrance_policy",
        "evaluate_entrance_policy",
        "dispatch_entrance_policy"
      ]));
      await client.callTool({ name: "list_entrance_policies", arguments: { includeArchived: true } });
      await client.callTool({ name: "get_entrance_policy", arguments: { entrancePolicyId: "desk-entrance" } });
      await client.callTool({
        name: "evaluate_entrance_policy",
        arguments: {
          entrancePolicyId: "desk-entrance",
          route: "specialist",
          specialistKey: "backend",
          tags: ["server"],
          signals: { risk: 7 },
          source: { kind: "http", project: "desk-project" }
        }
      });
      await client.callTool({
        name: "dispatch_entrance_policy",
        arguments: {
          entrancePolicyId: "desk-entrance",
          route: "auto",
          tags: ["server"],
          signals: { risk: 7 },
          source: { kind: "http", caller: "root-agent" },
          message: "Execute after routing."
        }
      });

      expect(requests.map((request) => request.url)).toEqual([
        "http://127.0.0.1:4318/api/entrance-policies?includeArchived=true",
        "http://127.0.0.1:4318/api/entrance-policies/desk-entrance",
        "http://127.0.0.1:4318/api/entrance-policies/desk-entrance/evaluate",
        "http://127.0.0.1:4318/api/entrance-policies/desk-entrance/dispatch"
      ]);
      const evaluated = JSON.parse(String(requests[2]?.init?.body)) as Record<string, unknown>;
      expect(evaluated).toEqual({
        route: "specialist",
        specialistKey: "backend",
        tags: ["server"],
        signals: { risk: 7 },
        source: { kind: "http", project: "desk-project" }
      });
      expect(evaluated).not.toHaveProperty("message");
      const dispatched = JSON.parse(String(requests[3]?.init?.body)) as {
        source: { kind: string; caller?: string };
        message: string;
      };
      expect(dispatched).toMatchObject({
        route: "auto",
        source: { kind: "mcp", caller: "root-agent" },
        message: "Execute after routing."
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
