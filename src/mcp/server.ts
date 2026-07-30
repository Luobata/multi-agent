import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface ApiEnvelope<T> {
  data?: T;
  error?: { message?: string };
}

async function request<T>(daemonUrl: string, pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${daemonUrl.replace(/\/$/, "")}${pathname}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers
  });
  const envelope = await response.json() as ApiEnvelope<T>;
  if (!response.ok || envelope.error) {
    throw new Error(envelope.error?.message ?? `workbench daemon returned HTTP ${response.status}`);
  }
  return envelope.data as T;
}

function content(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function invocationHeaders(metadata: { project?: string; contextId?: string; caller?: string } = {}): Record<string, string> {
  return Object.fromEntries(Object.entries({
    "x-multi-agent-source": "mcp",
    "x-multi-agent-source-label": "MCP conversation",
    "x-multi-agent-project": metadata.project,
    "x-multi-agent-context": metadata.contextId,
    "x-multi-agent-caller": metadata.caller
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0));
}

export function createWorkbenchMcpServer(daemonUrl = "http://127.0.0.1:4318"): McpServer {
  const server = new McpServer({ name: "local-agent-workbench", version: "0.1.0" });

  server.registerTool("list_employees", {
    title: "List local employees",
    description: "List addressable Employee identities registered in the local workbench.",
    inputSchema: { includeArchived: z.boolean().optional() }
  }, async ({ includeArchived }) => content(await request(
    daemonUrl,
    `/api/employees?includeArchived=${includeArchived ? "true" : "false"}`
  )));

  server.registerTool("get_employee_context", {
    title: "Inspect employee context",
    description: "Read the version-pinned identity, Skill, Session, effective prompt, and Run evidence for an Employee.",
    inputSchema: {
      employeeId: z.string().min(1),
      sessionId: z.string().min(1).optional()
    }
  }, async ({ employeeId, sessionId }) => content(await request(
    daemonUrl,
    `/api/employees/${encodeURIComponent(employeeId)}/context${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`
  )));

  server.registerTool("invoke_employee", {
    title: "Invoke local employee",
    description: "Send a request to an Employee through the same one-node Graph runtime used by the workbench.",
    inputSchema: {
      employeeId: z.string().min(1),
      message: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      project: z.string().min(1).optional(),
      contextId: z.string().min(1).optional(),
      caller: z.string().min(1).optional()
    }
  }, async ({ employeeId, message, sessionId, project, contextId, caller }) => content(await request(
    daemonUrl,
    `/api/employees/${encodeURIComponent(employeeId)}/invoke`,
    { method: "POST", body: JSON.stringify({ message, sessionId }), headers: invocationHeaders({ project, contextId, caller }) }
  )));

  server.registerTool("list_workflows", {
    title: "List multi-agent workflows",
    description: "List Graph workflows registered in the local workbench.",
    inputSchema: { includeArchived: z.boolean().optional() }
  }, async ({ includeArchived }) => content(await request(
    daemonUrl,
    `/api/workflows?includeArchived=${includeArchived ? "true" : "false"}`
  )));

  server.registerTool("run_workflow", {
    title: "Run multi-agent workflow",
    description: "Run a registered Graph workflow with structured JSON input and persist its complete evidence.",
    inputSchema: {
      workflowId: z.string().min(1),
      input: z.record(z.string(), z.unknown()).optional(),
      project: z.string().min(1).optional(),
      contextId: z.string().min(1).optional(),
      caller: z.string().min(1).optional()
    }
  }, async ({ workflowId, input, project, contextId, caller }) => content(await request(
    daemonUrl,
    `/api/workflows/${encodeURIComponent(workflowId)}/run`,
    { method: "POST", body: JSON.stringify(input ?? {}), headers: invocationHeaders({ project, contextId, caller }) }
  )));

  server.registerTool("list_publications", {
    title: "List callable agent packages",
    description: "List published single-Agent and multi-Agent packages without exposing their internal prompts or graph.",
    inputSchema: { includeArchived: z.boolean().optional() }
  }, async ({ includeArchived }) => content(await request(
    daemonUrl,
    `/api/publications?includeArchived=${includeArchived ? "true" : "false"}`
  )));

  server.registerTool("invoke_publication", {
    title: "Invoke agent package",
    description: "Invoke a published single-Agent or multi-Agent package through one stable MCP tool.",
    inputSchema: {
      publicationId: z.string().min(1),
      input: z.record(z.string(), z.unknown()).optional(),
      project: z.string().min(1).optional(),
      contextId: z.string().min(1).optional(),
      caller: z.string().min(1).optional()
    }
  }, async ({ publicationId, input, project, contextId, caller }) => content(await request(
    daemonUrl,
    `/api/publications/${encodeURIComponent(publicationId)}/invoke`,
    { method: "POST", body: JSON.stringify(input ?? {}), headers: invocationHeaders({ project, contextId, caller }) }
  )));

  server.registerTool("list_runs", {
    title: "List workbench runs",
    description: "List recent immutable Run records and their workflow status.",
    inputSchema: { limit: z.number().int().min(1).max(200).optional() }
  }, async ({ limit }) => content(await request(daemonUrl, `/api/runs?limit=${limit ?? 50}`)));

  return server;
}
