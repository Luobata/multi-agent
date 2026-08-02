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

export type WorkbenchMcpProfile = "full" | "knowledge-control";

const resourceId = z.string().regex(/^[a-z][a-z0-9-]*$/, "use a lowercase kebab-case resource id");
const catalogValue = z.string().min(1);
const expectedVersion = z.number().int().positive().optional();
const classification = z.enum(["internal", "confidential", "restricted"]);
const authority = z.enum(["canonical", "reference", "experimental"]);
const activation = z.enum(["core", "conditional", "on-demand"]);
const referenceType = z.enum(["related", "supports", "contradicts", "depends-on", "supersedes"]);
const knowledgeCollectionSchema = z.object({
  id: resourceId,
  displayName: z.string().min(1),
  description: z.string().min(1),
  authority,
  tags: z.array(z.string()).default([])
}).strict();
const knowledgeSourceSchema = z.object({
  id: resourceId,
  kind: z.enum(["file", "directory"]),
  location: z.string().min(1),
  collectionId: resourceId,
  includeExtensions: z.array(z.string().min(1)).optional()
}).strict();
const knowledgeDocumentSchema = z.object({
  id: resourceId,
  title: z.string().min(1),
  content: z.string(),
  collectionId: resourceId,
  sourceId: resourceId.optional(),
  sourceRef: z.string().min(1).optional(),
  order: z.number().int().nonnegative().optional(),
  parentId: resourceId.optional(),
  references: z.array(z.object({
    type: referenceType,
    targetDocumentId: resourceId,
    note: z.string().min(1).optional()
  }).strict()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}).strict();
const knowledgeGrantMutationShape = {
  reason: z.string().min(1).optional(),
  grantedBy: z.string().min(1).optional(),
  grantedAt: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
  reviewCycleDays: z.number().int().min(1).max(3650).optional(),
  lastReviewedAt: z.string().min(1).optional()
};
const knowledgeGrantOverrideSchema = z.object({
  profileId: resourceId,
  ...knowledgeGrantMutationShape
}).strict();
const knowledgeBaseMutableSchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  domain: catalogValue.optional(),
  product: catalogValue.optional(),
  projectId: resourceId.optional(),
  classification: classification.optional(),
  collections: z.array(knowledgeCollectionSchema).optional(),
  sources: z.array(knowledgeSourceSchema).optional()
}).strict();
const selectorSchema = z.object({
  knowledgeBaseIds: z.array(resourceId).optional(),
  domains: z.array(catalogValue).optional(),
  products: z.array(catalogValue).optional(),
  projectIds: z.array(resourceId).optional(),
  collectionIds: z.array(resourceId).optional(),
  authorities: z.array(authority).optional(),
  maxClassification: classification.optional()
}).strict();
const conditionsSchema = z.object({
  projectIds: z.array(resourceId).optional(),
  projectRoleIds: z.array(resourceId).optional(),
  taskTags: z.array(z.string().min(1)).optional(),
  requestTerms: z.array(z.string().min(1)).optional()
}).strict();
const profileRuleSchema = z.object({
  id: resourceId,
  selector: selectorSchema,
  activation,
  conditions: conditionsSchema.optional(),
  priority: z.number().int().min(-100).max(100),
  required: z.boolean(),
  budget: z.object({
    maxCollections: z.number().int().min(1).max(12),
    maxChunks: z.number().int().min(1).max(20),
    maxTokens: z.number().int().min(128).max(16000)
  }).strict()
}).strict();
const knowledgeChangeOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("knowledge-base.create"),
    targetId: resourceId,
    payload: z.object({
      displayName: z.string().min(1).optional(),
      description: z.string().min(1),
      domain: catalogValue,
      product: catalogValue.optional(),
      projectId: resourceId.optional(),
      classification: classification.optional(),
      collections: z.array(knowledgeCollectionSchema),
      sources: z.array(knowledgeSourceSchema).optional(),
      documents: z.array(knowledgeDocumentSchema).optional()
    }).strict()
  }).strict(),
  z.object({ type: z.literal("knowledge-base.update"), targetId: resourceId, expectedVersion, payload: knowledgeBaseMutableSchema }).strict(),
  z.object({ type: z.literal("knowledge-base.sync"), targetId: resourceId, expectedVersion }).strict(),
  z.object({ type: z.literal("knowledge-base.archive"), targetId: resourceId, expectedVersion }).strict(),
  z.object({ type: z.literal("knowledge-base.restore"), targetId: resourceId, expectedVersion }).strict(),
  z.object({
    type: z.literal("knowledge-revision.create"),
    targetId: resourceId,
    expectedVersion,
    payload: z.object({ documents: z.array(knowledgeDocumentSchema) }).strict()
  }).strict(),
  z.object({
    type: z.literal("knowledge-revision.publish"),
    targetId: resourceId,
    expectedVersion,
    payload: z.object({ revision: z.number().int().positive() }).strict()
  }).strict(),
  z.object({
    type: z.literal("knowledge-profile.create"),
    targetId: resourceId,
    payload: z.object({
      displayName: z.string().min(1).optional(),
      description: z.string().min(1),
      rules: z.array(profileRuleSchema).min(1)
    }).strict()
  }).strict(),
  z.object({
    type: z.literal("knowledge-profile.update"),
    targetId: resourceId,
    expectedVersion,
    payload: z.object({
      displayName: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      rules: z.array(profileRuleSchema).min(1).optional()
    }).strict()
  }).strict(),
  z.object({ type: z.literal("knowledge-profile.archive"), targetId: resourceId, expectedVersion }).strict(),
  z.object({ type: z.literal("knowledge-profile.restore"), targetId: resourceId, expectedVersion }).strict(),
  z.object({
    type: z.literal("employee-profiles.set"),
    targetId: resourceId,
    expectedVersion,
    payload: z.object({
      profileIds: z.array(resourceId),
      ...knowledgeGrantMutationShape,
      grantOverrides: z.array(knowledgeGrantOverrideSchema).optional()
    }).strict()
  }).strict(),
  z.object({
    type: z.literal("project-role-profiles.set"),
    projectId: resourceId,
    roleId: resourceId,
    expectedVersion,
    payload: z.object({
      profileIds: z.array(resourceId),
      ...knowledgeGrantMutationShape,
      grantOverrides: z.array(knowledgeGrantOverrideSchema).optional()
    }).strict()
  }).strict()
]);

export function createWorkbenchMcpServer(
  daemonUrl = "http://127.0.0.1:4318",
  options: { profile?: WorkbenchMcpProfile } = {}
): McpServer {
  const server = new McpServer({ name: "local-agent-workbench", version: "0.1.0" });

  if (options.profile === "knowledge-control") {
    server.registerTool("knowledge_control_snapshot", {
      title: "Inspect the knowledge control plane",
      description: "Read Knowledge Bases, Profiles, Employees, project-role assignments, impact, and pending change requests. This tool never mutates state.",
      inputSchema: {}
    }, async () => {
      const bootstrap = await request<Record<string, unknown>>(daemonUrl, "/api/bootstrap");
      const impact = await request<unknown>(daemonUrl, "/api/knowledge/impact");
      return content({
        knowledgeBases: bootstrap.knowledgeBases,
        knowledgeProfiles: bootstrap.knowledgeProfiles,
        employees: bootstrap.employees,
        projects: bootstrap.projects,
        projectBindings: bootstrap.projectBindings,
        knowledgeChanges: bootstrap.knowledgeChanges,
        impact
      });
    });

    server.registerTool("knowledge_base_get", {
      title: "Inspect one Knowledge Base",
      description: "Read one Knowledge Base with immutable Revision history and quality assessments.",
      inputSchema: { knowledgeBaseId: z.string().min(1) }
    }, async ({ knowledgeBaseId }) => content(await request(
      daemonUrl,
      `/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
    )));

    server.registerTool("knowledge_revision_assess", {
      title: "Assess a knowledge Revision",
      description: "Run deterministic publication checks for a draft or published Revision.",
      inputSchema: {
        knowledgeBaseId: z.string().min(1),
        revision: z.number().int().positive().optional()
      }
    }, async ({ knowledgeBaseId, revision }) => content(await request(
      daemonUrl,
      `/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/assessment${revision ? `?revision=${revision}` : ""}`
    )));

    server.registerTool("knowledge_revision_preview", {
      title: "Run a draft retrieval preview",
      description: "Search a specific Revision without invoking an Employee, Provider, publication, or approval action.",
      inputSchema: {
        knowledgeBaseId: z.string().min(1),
        message: z.string().min(1),
        revision: z.number().int().positive().optional(),
        collectionIds: z.array(z.string().min(1)).optional(),
        maxChunks: z.number().int().min(1).max(20).optional(),
        maxTokens: z.number().int().min(128).max(16000).optional()
      }
    }, async ({ knowledgeBaseId, ...input }) => content(await request(
      daemonUrl,
      `/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/preview`,
      { method: "POST", body: JSON.stringify(input) }
    )));

    server.registerTool("knowledge_url_preview", {
      title: "Preview a governed knowledge URL import",
      description: "Fetch one public HTTP(S) page through the SSRF-restricted importer and return deterministic Documents, relation candidates, content hashes, and a frozen preview hash. This tool never persists content.",
      inputSchema: {
        knowledgeBaseId: resourceId,
        collectionId: resourceId,
        url: z.string().url()
      }
    }, async (input) => content(await request(
      daemonUrl,
      "/api/knowledge/url-preview",
      { method: "POST", body: JSON.stringify(input) }
    )));

    server.registerTool("knowledge_url_propose", {
      title: "Propose a governed knowledge URL import",
      description: "Re-fetch a previously previewed public page, require the frozen hash to match, and create an awaiting-approval Revision proposal. This tool never approves or publishes it.",
      inputSchema: {
        knowledgeBaseId: resourceId,
        collectionId: resourceId,
        url: z.string().url(),
        previewHash: z.string().regex(/^[a-f0-9]{64}$/),
        title: z.string().min(1),
        reason: z.string().min(1),
        selectedRelations: z.array(z.object({
          candidateId: z.string().min(1),
          type: referenceType,
          note: z.string().min(1).optional()
        }).strict()).max(5).optional()
      }
    }, async (input) => content(await request(
      daemonUrl,
      "/api/knowledge/url-proposals",
      {
        method: "POST",
        body: JSON.stringify({ ...input, requestedBy: "project-knowledge-steward" })
      }
    )));

    server.registerTool("knowledge_wiki_get", {
      title: "Inspect derived Knowledge Wiki data",
      description: "Read ordered Documents, explicit typed references, backlinks, and non-persisted deterministic relation candidates for one immutable Revision.",
      inputSchema: {
        knowledgeBaseId: resourceId,
        revision: z.number().int().positive().optional()
      }
    }, async ({ knowledgeBaseId, revision }) => content(await request(
      daemonUrl,
      `/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/wiki${revision ? `?revision=${revision}` : ""}`
    )));

    server.registerTool("employee_knowledge_perspective", {
      title: "Inspect an Employee knowledge perspective",
      description: "Explain eligible, activated, selected, and excluded knowledge for one context, plus exact evidence from a bounded window of recent Run Store artifacts.",
      inputSchema: {
        employeeId: resourceId,
        message: z.string().min(1),
        projectId: resourceId.optional(),
        projectRoleId: resourceId.optional(),
        taskTags: z.array(z.string().min(1)).optional(),
        evidenceLimit: z.number().int().min(1).max(50).optional()
      }
    }, async ({ employeeId, ...input }) => content(await request(
      daemonUrl,
      `/api/employees/${encodeURIComponent(employeeId)}/knowledge-perspective`,
      { method: "POST", body: JSON.stringify(input) }
    )));

    server.registerTool("knowledge_review_list", {
      title: "Inspect knowledge authorization reviews",
      description: "List Employee and project-role grant reviews, including legacy grants and expiry reminders. Expiry never revokes access automatically.",
      inputSchema: {
        asOf: z.string().min(1).optional(),
        dueSoonDays: z.number().int().min(0).max(3650).optional()
      }
    }, async ({ asOf, dueSoonDays }) => {
      const query = new URLSearchParams();
      if (asOf) query.set("asOf", asOf);
      if (dueSoonDays !== undefined) query.set("dueSoonDays", String(dueSoonDays));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return content(await request(daemonUrl, `/api/knowledge/reviews${suffix}`));
    });

    server.registerTool("knowledge_impact_get", {
      title: "Inspect knowledge authorization impact",
      description: "Explain deterministic KnowledgeBase to Profile to Employee and Project Role relationships.",
      inputSchema: {}
    }, async () => content(await request(daemonUrl, "/api/knowledge/impact")));

    server.registerTool("knowledge_change_list", {
      title: "List knowledge change requests",
      description: "List proposed, approved, rejected, stale, and applied knowledge changes.",
      inputSchema: {}
    }, async () => content(await request(daemonUrl, "/api/knowledge-changes")));

    server.registerTool("knowledge_change_get", {
      title: "Inspect a knowledge change request",
      description: "Read the exact plan, diff, risk, impact, approval, and execution result for one change request.",
      inputSchema: { changeRequestId: z.string().min(1) }
    }, async ({ changeRequestId }) => content(await request(
      daemonUrl,
      `/api/knowledge-changes/${encodeURIComponent(changeRequestId)}`
    )));

    server.registerTool("knowledge_change_propose", {
      title: "Propose a governed knowledge change",
      description: "Create one typed, validated change request for human review. This tool never approves or applies the change. Read current state first and never invent resource ids.",
      inputSchema: {
        title: z.string().min(1),
        reason: z.string().min(1),
        operation: knowledgeChangeOperationSchema
      }
    }, async ({ title, reason, operation }) => content(await request(
      daemonUrl,
      "/api/knowledge-changes",
      {
        method: "POST",
        body: JSON.stringify({ title, reason, requestedBy: "project-knowledge-steward", operation })
      }
    )));

    return server;
  }

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
    description: "Read the version-pinned identity, Skill, Knowledge Plan, Session, effective prompt, and Run evidence for an Employee.",
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

  server.registerTool("list_projects", {
    title: "List connected projects",
    description: "List source-declared projects connected to the local workbench and available for Employee assignment.",
    inputSchema: { includeArchived: z.boolean().optional() }
  }, async ({ includeArchived }) => content(await request(
    daemonUrl,
    `/api/projects?includeArchived=${includeArchived ? "true" : "false"}`
  )));

  server.registerTool("get_project", {
    title: "Get project assignments",
    description: "Read one Project contract, its role slots, and the version-pinned Employee bindings.",
    inputSchema: { projectId: z.string().min(1) }
  }, async ({ projectId }) => content(await request(
    daemonUrl,
    `/api/projects/${encodeURIComponent(projectId)}`
  )));

  server.registerTool("invoke_project_role", {
    title: "Invoke a project role",
    description: "Resolve a Project role slot to its assigned Employee and pinned Skill subset, then invoke it through the workbench runtime.",
    inputSchema: {
      projectId: z.string().min(1),
      roleId: z.string().min(1),
      message: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      contextId: z.string().min(1).optional(),
      caller: z.string().min(1).optional()
    }
  }, async ({ projectId, roleId, message, sessionId, contextId, caller }) => content(await request(
    daemonUrl,
    `/api/projects/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(roleId)}/invoke`,
    {
      method: "POST",
      body: JSON.stringify({ message, sessionId }),
      headers: invocationHeaders({ project: projectId, contextId, caller })
    }
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
    description: "Compatibility entry point that waits for a registered Graph workflow to finish. Prefer start_workflow for long-running work.",
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

  server.registerTool("start_workflow", {
    title: "Start multi-agent workflow",
    description: "Start a registered Graph workflow asynchronously and return an invocation id immediately. Use get_invocation to inspect status and final Run evidence.",
    inputSchema: {
      workflowId: z.string().min(1),
      input: z.record(z.string(), z.unknown()).optional(),
      project: z.string().min(1).optional(),
      contextId: z.string().min(1).optional(),
      caller: z.string().min(1).optional()
    }
  }, async ({ workflowId, input, project, contextId, caller }) => content(await request(
    daemonUrl,
    `/api/workflows/${encodeURIComponent(workflowId)}/start`,
    { method: "POST", body: JSON.stringify(input ?? {}), headers: invocationHeaders({ project, contextId, caller }) }
  )));

  server.registerTool("get_invocation", {
    title: "Get invocation status",
    description: "Read one asynchronous invocation, its work instances, and Run evidence when available.",
    inputSchema: { invocationId: z.string().min(1) }
  }, async ({ invocationId }) => content(await request(
    daemonUrl,
    `/api/invocations/${encodeURIComponent(invocationId)}`
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
