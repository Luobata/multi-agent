import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createWorkbenchMcpServer } from "../src/mcp/server.js";

describe("Knowledge Control MCP whitelist", () => {
  it("exposes URL import and read-only knowledge views without approval or generic HTTP tools", async () => {
    const server = createWorkbenchMcpServer("http://127.0.0.1:4318", { profile: "knowledge-control" });
    const client = new Client({ name: "knowledge-whitelist-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "knowledge_url_preview",
        "knowledge_url_propose",
        "knowledge_wiki_get",
        "employee_knowledge_perspective",
        "knowledge_review_list"
      ]));
      expect(names).not.toEqual(expect.arrayContaining([
        "knowledge_change_approve",
        "knowledge_change_apply",
        "knowledge_change_reject",
        "knowledge_change_cancel",
        "invoke_employee",
        "http_get",
        "fetch_url"
      ]));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
