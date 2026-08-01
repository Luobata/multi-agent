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
  await service.createProject({
    id: "desk-project",
    name: "Desk Project",
    description: "A connected daemon test project.",
    rootPath: root,
    descriptorPath: path.join(root, "multi-agent.project.yaml"),
    connector: { kind: "generic", config: {} },
    roles: [{ id: "reviewer", displayName: "Reviewer", description: "Review project work.", instructions: "PROJECT_POLICY_MARKER" }]
  });
  await service.saveProjectBinding("desk-project", { roles: [{ roleId: "reviewer", employeeId: "desk-agent" }] });
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
  return { base: `http://127.0.0.1:${port}`, service };
}

describe("workbench daemon", () => {
  it("preserves Unicode invocation metadata from encoded and legacy HTTP headers", async () => {
    const { base } = await fixture();
    const invoke = (label: string) => fetch(`${base}/api/employees/desk-agent/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-multi-agent-source-label": label
      },
      body: JSON.stringify({ message: "Check source metadata" })
    });

    await invoke(`utf8:${encodeURIComponent("直接交办调试台")}`);
    await invoke(Buffer.from("小狐整体档案设计", "utf8").toString("latin1"));
    const activity = await fetch(`${base}/api/activity`).then((response) => response.json()) as {
      data: { invocations: Array<{ source: { label?: string } }> };
    };
    expect(activity.data.invocations.slice(0, 2).map((invocation) => invocation.source.label))
      .toEqual(["小狐整体档案设计", "直接交办调试台"]);
  });

  it("streams live invocation and work-instance changes over SSE", async () => {
    const { base } = await fixture();
    const controller = new AbortController();
    const response = await fetch(`${base}/api/activity/stream`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const invocation = fetch(`${base}/api/publications/desk-public/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-multi-agent-project": "sse-project" },
      body: JSON.stringify({ message: "Show this live" })
    });
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes('"type":"instance.changed"')) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    await invocation;
    controller.abort();
    await reader!.cancel().catch(() => undefined);
    expect(received).toContain("event: snapshot");
    expect(received).toContain("event: activity");
    expect(received).toContain("sse-project");
  });

  it("manages Knowledge Bases and previews Employee evidence through HTTP", async () => {
    const { base } = await fixture();
    const knowledgeResponse = await fetch(`${base}/api/knowledge-bases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "desk-handbook",
        description: "Desk operating knowledge.",
        domain: "desk",
        collections: [{ id: "operations", displayName: "Operations", description: "Desk operations.", authority: "canonical", tags: ["desk", "review"] }],
        documents: [{ id: "review-guide", title: "Review guide", content: "Desk reviews must preserve traceable evidence.", collectionId: "operations" }],
        publish: true
      })
    });
    expect(knowledgeResponse.status).toBe(201);

    const profileResponse = await fetch(`${base}/api/knowledge-profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "desk-knowledge",
        description: "Desk operations only.",
        rules: [{
          id: "operations",
          selector: { knowledgeBaseIds: ["desk-handbook"], collectionIds: ["operations"] },
          activation: "core",
          priority: 10,
          required: false,
          budget: { maxCollections: 1, maxChunks: 3, maxTokens: 1200 }
        }]
      })
    });
    expect(profileResponse.status).toBe(201);
    const assignment = await fetch(`${base}/api/employees/desk-agent`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ knowledgeProfileIds: ["desk-knowledge"] })
    });
    expect(assignment.status).toBe(200);

    const preview = await fetch(`${base}/api/employees/desk-agent/knowledge-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Review desk evidence" })
    }).then((response) => response.json()) as {
      data: { plan: { selectedCollections: Array<{ knowledgeBaseId: string; collectionId: string }> }; evidence: Array<{ documentId: string }> };
    };
    expect(preview.data.plan.selectedCollections).toEqual([
      expect.objectContaining({ knowledgeBaseId: "desk-handbook", collectionId: "operations" })
    ]);
    expect(preview.data.evidence).toEqual([expect.objectContaining({ documentId: "review-guide" })]);

    const assessment = await fetch(`${base}/api/knowledge-bases/desk-handbook/assessment?revision=1`)
      .then((response) => response.json()) as { data: { status: string; documentCount: number } };
    expect(assessment.data).toMatchObject({ status: "ready", documentCount: 1 });
    const revisionPreview = await fetch(`${base}/api/knowledge-bases/desk-handbook/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "traceable evidence", revision: 1 })
    }).then((response) => response.json()) as { data: { revision: number; evidence: Array<{ documentId: string }> } };
    expect(revisionPreview.data).toMatchObject({ revision: 1 });
    expect(revisionPreview.data.evidence).toEqual([expect.objectContaining({ documentId: "review-guide" })]);

    const impact = await fetch(`${base}/api/knowledge/impact`).then((response) => response.json()) as {
      data: { knowledgeBases: Array<{ knowledgeBaseId: string; employees: Array<{ employeeId: string }> }> };
    };
    expect(impact.data.knowledgeBases).toContainEqual(expect.objectContaining({
      knowledgeBaseId: "desk-handbook",
      employees: [expect.objectContaining({ employeeId: "desk-agent" })]
    }));

    const bootstrap = await fetch(`${base}/api/bootstrap`).then((response) => response.json()) as {
      data: { knowledgeBases: Array<{ id: string }>; knowledgeProfiles: Array<{ id: string }> };
    };
    expect(bootstrap.data.knowledgeBases.map((item) => item.id)).toContain("desk-handbook");
    expect(bootstrap.data.knowledgeProfiles.map((item) => item.id)).toContain("desk-knowledge");
  });

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

    const projectResponse = await fetch(`${base}/api/projects/desk-project/roles/reviewer/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Review through the project assignment" })
    });
    expect(projectResponse.status).toBe(200);
    const projectInvocation = await projectResponse.json() as { data: { message: string; session: { assignment?: { projectId: string; roleId: string } } } };
    expect(projectInvocation.data.message).toContain("Desk Agent received");
    expect(projectInvocation.data.session.assignment).toMatchObject({ projectId: "desk-project", roleId: "reviewer" });
    const projectDetail = await fetch(`${base}/api/projects/desk-project`).then((response) => response.json()) as {
      data: { project: { id: string }; binding: { roles: Array<{ employeeId: string }> } };
    };
    expect(projectDetail.data.project.id).toBe("desk-project");
    expect(projectDetail.data.binding.roles[0]?.employeeId).toBe("desk-agent");

    const packageResponse = await fetch(`${base}/api/publications/desk-public/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-multi-agent-project": "outside-project",
        "x-multi-agent-context": "outside-thread"
      },
      body: JSON.stringify({ message: "Invoke the package" })
    });
    expect(packageResponse.status).toBe(200);
    const activity = await fetch(`${base}/api/activity`).then((response) => response.json()) as {
      data: { invocations: Array<{ source: { kind: string; project?: string; contextId?: string; publicationId?: string } }> };
    };
    expect(activity.data.invocations[0]?.source).toMatchObject({
      kind: "http",
      project: "outside-project",
      contextId: "outside-thread",
      publicationId: "desk-public"
    });
    await fetch(`${base}/api/publications/desk-public/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-multi-agent-project": "outside-project",
        "x-multi-agent-context": "outside-thread"
      },
      body: JSON.stringify({ message: "Continue the same external context" })
    });
    const continuedActivity = await fetch(`${base}/api/activity`).then((response) => response.json()) as {
      data: { invocations: Array<{ sessionId?: string; source: { project?: string; contextId?: string; publicationId?: string } }> };
    };
    const outsideInvocations = continuedActivity.data.invocations.filter((invocation) =>
      invocation.source.project === "outside-project" && invocation.source.contextId === "outside-thread"
    );
    expect(outsideInvocations).toHaveLength(2);
    expect(new Set(outsideInvocations.map((invocation) => invocation.sessionId)).size).toBe(1);

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
      expect(tools.tools.map((tool) => tool.name)).toContain("invoke_publication");
      expect(tools.tools.map((tool) => tool.name)).toContain("invoke_project_role");
      const result = await client.callTool({
        name: "invoke_employee",
        arguments: { employeeId: "desk-agent", message: "Call through MCP" }
      });
      const resultContent = result.content as Array<{ type: string; text?: string }>;
      const text = resultContent.find((item) => item.type === "text");
      expect(text?.text ?? "").toContain("Desk Agent received");
      const packaged = await client.callTool({
        name: "invoke_publication",
        arguments: { publicationId: "desk-public", input: { message: "Call package through MCP" }, project: "mcp-project" }
      });
      const packageContent = packaged.content as Array<{ type: string; text?: string }>;
      expect(packageContent.find((item) => item.type === "text")?.text ?? "").toContain("Desk Agent received");
      const projectResult = await client.callTool({
        name: "invoke_project_role",
        arguments: { projectId: "desk-project", roleId: "reviewer", message: "Call project role through MCP" }
      });
      const projectContent = projectResult.content as Array<{ type: string; text?: string }>;
      expect(projectContent.find((item) => item.type === "text")?.text ?? "").toContain("Desk Agent received");
      const activity = await fetch(`${base}/api/activity`).then((response) => response.json()) as {
        data: { invocations: Array<{ source: { kind: string; project?: string; projectRole?: string; publicationId?: string } }> };
      };
      expect(activity.data.invocations[0]?.source).toMatchObject({ kind: "mcp", project: "desk-project", projectRole: "reviewer" });
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it("exposes a proposal-only Knowledge Control MCP profile and keeps approval human-owned", async () => {
    const { base, service } = await fixture();
    await service.createKnowledgeBase({
      id: "governed-desk",
      description: "A governed desk catalog.",
      domain: "desk",
      collections: [{ id: "general", displayName: "General", description: "General desk knowledge.", authority: "canonical", tags: [] }]
    });
    const mcpServer = createWorkbenchMcpServer(base, { profile: "knowledge-control" });
    const client = new Client({ name: "knowledge-steward-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain("knowledge_change_propose");
      expect(names).toContain("knowledge_control_snapshot");
      expect(names).not.toContain("invoke_employee");
      expect(names).not.toContain("knowledge_change_approve");
      expect(names).not.toContain("knowledge_change_cancel");

      const invalid = await client.callTool({
        name: "knowledge_change_propose",
        arguments: {
          title: "不规范提案",
          reason: "验证 MCP 类型边界。",
          operation: {
            type: "knowledge-base.update",
            targetId: "governed-desk",
            payload: { description: "Valid field.", inventedAction: true }
          }
        }
      });
      expect(invalid.isError).toBe(true);
      expect(service.listKnowledgeChangeRequests()).toHaveLength(0);

      const proposed = await client.callTool({
        name: "knowledge_change_propose",
        arguments: {
          title: "更新 Desk 说明",
          reason: "让目录边界更清晰。",
          operation: {
            type: "knowledge-base.update",
            targetId: "governed-desk",
            payload: { description: "A clearer governed desk catalog." }
          }
        }
      });
      const text = (proposed.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
      const change = JSON.parse(text) as { id: string; status: string };
      expect(change.status).toBe("awaiting-approval");
      expect(service.getKnowledgeBase("governed-desk").description).toBe("A governed desk catalog.");

      const approved = await fetch(`${base}/api/knowledge-changes/${change.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment: "Human review passed" })
      });
      expect(approved.status).toBe(200);
      expect(service.getKnowledgeBase("governed-desk").description).toBe("A clearer governed desk catalog.");
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });
});
