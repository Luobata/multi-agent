import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDaemonApp } from "../src/daemon/server.js";
import { createWorkbenchMcpServer } from "../src/mcp/server.js";
import { WorkbenchService } from "../src/workbench/service.js";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-daemon-"));
  directories.push(root);
  const service = await WorkbenchService.open({ dataRoot: root });
  await service.createEmployee({
    id: "desk-agent",
    identity: { displayName: "Desk Agent", background: "A local test agent.", responsibilities: ["Handle requests"] }
  });
  await service.createPublication({
    id: "desk-public",
    name: "Desk Agent",
    description: "A loopback A2A publication.",
    target: { kind: "employee", id: "desk-agent" }
  });
  const app = createDaemonApp(service, { baseUrl: "http://127.0.0.1:4318", staticDir: path.join(root, "missing-client") });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}` };
}

describe("workbench daemon", () => {
  it("serves CRUD, Agent Card, and A2A v1 JSON-RPC from loopback", async () => {
    const { base } = await fixture();
    const health = await fetch(`${base}/api/health`).then((response) => response.json()) as { data: { bindPolicy: string } };
    expect(health.data.bindPolicy).toBe("loopback-only");

    const invoked = await fetch(`${base}/api/employees/desk-agent/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Review this" })
    }).then((response) => response.json()) as { data: { message: string } };
    expect(invoked.data.message).toContain("Desk Agent received");

    const cardResponse = await fetch(`${base}/a2a/desk-public/.well-known/agent-card.json`);
    const card = await cardResponse.json() as { name: string; supportedInterfaces: Array<{ protocolVersion: string }> };
    expect(cardResponse.status).toBe(200);
    expect(card.name).toBe("Desk Agent");
    expect(card.supportedInterfaces[0]?.protocolVersion).toBe("1.0");

    const rpcResponse = await fetch(`${base}/a2a/desk-public`, {
      method: "POST",
      headers: { "content-type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "request-1",
        method: "SendMessage",
        params: {
          message: {
            messageId: "message-1",
            role: "ROLE_USER",
            parts: [{ text: "Handle this through A2A" }]
          }
        }
      })
    });
    const rpc = await rpcResponse.json() as {
      result?: { task?: { status?: { state?: string }; artifacts?: Array<{ metadata?: { domainBlock?: boolean } }> } };
      error?: unknown;
    };
    expect(rpcResponse.status).toBe(200);
    expect(rpc.error).toBeUndefined();
    expect(rpc.result?.task?.status?.state).toBe("TASK_STATE_COMPLETED");
    expect(rpc.result?.task?.artifacts).toHaveLength(1);
    expect(rpc.result?.task?.artifacts?.[0]?.metadata?.domainBlock).toBe(false);
  });

  it("exposes the shared daemon registry through MCP tools", async () => {
    const { base } = await fixture();
    const mcpServer = createWorkbenchMcpServer(base);
    const client = new Client({ name: "workbench-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("invoke_employee");
      const result = await client.callTool({
        name: "invoke_employee",
        arguments: { employeeId: "desk-agent", message: "Call through MCP" }
      });
      const resultContent = result.content as Array<{ type: string; text?: string }>;
      const text = resultContent.find((item) => item.type === "text");
      expect(text?.text ?? "").toContain("Desk Agent received");
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });
});
