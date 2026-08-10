import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodeUtf8HeaderValue } from "../core/httpHeaders.js";

interface ApiEnvelope<T> {
  data?: T;
  error?: { message?: string };
}

async function request<T>(daemonUrl: string, pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${daemonUrl.replace(/\/$/, "")}${pathname}`, {
    ...init,
    headers: {
      "x-multi-agent-mcp-root": encodeUtf8HeaderValue(process.cwd()),
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
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

export type WorkbenchMcpProfile = "full" | "knowledge-control" | "configuration-control" | "gate-control";

const resourceId = z.string().regex(/^[a-z][a-z0-9-]*$/, "use a lowercase kebab-case resource id");
const catalogValue = z.string().min(1);
const expectedVersion = z.number().int().positive().optional();
const classification = z.enum(["internal", "confidential", "restricted"]);
const authority = z.enum(["canonical", "reference", "experimental"]);
const activation = z.enum(["core", "conditional", "on-demand"]);
const referenceType = z.enum(["related", "supports", "contradicts", "depends-on", "supersedes"]);
const conversationAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  base64: z.string().min(1).max(11_184_812)
}).strict();
const conversationAttachmentsSchema = z.array(conversationAttachmentSchema).max(5).optional();
const entranceSourceSchema = z.object({
  kind: z.enum(["workbench", "http", "mcp", "a2a"]),
  label: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  projectRole: z.string().min(1).optional(),
  projectBindingVersion: z.number().int().positive().optional(),
  caller: z.string().min(1).optional(),
  contextId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  publicationId: z.string().min(1).optional()
}).strict();
const entranceEvaluationShape = {
  route: z.enum(["auto", "direct", "specialist", "leader"]),
  specialistKey: resourceId.optional(),
  tags: z.array(z.string().min(1)).optional(),
  signals: z.record(z.string(), z.unknown()).optional(),
  source: entranceSourceSchema.optional()
};
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

const supervisorGateSchema = z.object({
  id: resourceId,
  requiredCapability: z.string().min(1),
  mode: z.enum(["after-each-delegation", "before-completion"]),
  required: z.boolean(),
  instructions: z.string().min(1),
  fallback: z.enum(["supervisor", "block"]),
  validatorId: z.string().min(1).optional()
}).strict();
const supervisorGatePatchSchema = z.object({
  requiredCapability: z.string().min(1).optional(),
  mode: z.enum(["after-each-delegation", "before-completion"]).optional(),
  required: z.boolean().optional(),
  instructions: z.string().min(1).optional(),
  fallback: z.enum(["supervisor", "block"]).optional(),
  validatorId: z.string().min(1).optional()
}).strict();
const workflowChangeOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("add-gate"),
    gate: supervisorGateSchema,
    rationale: z.string().min(1),
    risk: z.string().min(1)
  }).strict(),
  z.object({
    kind: z.literal("update-gate"),
    gateId: z.string().min(1),
    patch: supervisorGatePatchSchema,
    rationale: z.string().min(1),
    risk: z.string().min(1)
  }).strict(),
  z.object({
    kind: z.literal("remove-gate"),
    gateId: z.string().min(1),
    rationale: z.string().min(1),
    risk: z.string().min(1)
  }).strict()
]);

const configurationRisk = z.enum(["low", "medium", "high"]);
const configurationIdentitySchema = z.object({
  displayName: z.string().min(1),
  background: z.string().min(1),
  responsibilities: z.array(z.string().min(1)).min(1),
  goals: z.array(z.string().min(1)).optional(),
  constraints: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}).strict();
const configurationSkillBindingSchema = z.union([
  resourceId,
  z.object({
    id: resourceId,
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional()
  }).strict()
]);
const configurationVerdictSchema = z.object({
  path: z.string().min(1),
  pass: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  block: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
}).strict();
const configurationOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("identity-profile.set"),
    rationale: z.string().min(1),
    risk: configurationRisk,
    payload: z.object({ identity: configurationIdentitySchema, description: z.string().min(1) }).strict()
  }).strict(),
  z.object({
    type: z.literal("prompts.set"),
    rationale: z.string().min(1),
    risk: configurationRisk,
    payload: z.object({ systemPrompt: z.string().min(1), requestPrompt: z.string().min(1) }).strict()
  }).strict(),
  z.object({
    type: z.literal("capabilities.set"),
    rationale: z.string().min(1),
    risk: configurationRisk,
    payload: z.object({ capabilities: z.array(z.string().min(1)) }).strict()
  }).strict(),
  z.object({
    type: z.literal("skills.set"),
    rationale: z.string().min(1),
    risk: configurationRisk,
    payload: z.object({
      skills: z.array(configurationSkillBindingSchema),
      skillVersions: z.record(resourceId, z.number().int().positive()).optional()
    }).strict()
  }).strict(),
  z.object({
    type: z.literal("runtime.set"),
    rationale: z.string().min(1),
    risk: configurationRisk,
    payload: z.object({ providerId: resourceId, maxAttempts: z.number().int().min(1).max(10) }).strict()
  }).strict(),
  z.object({
    type: z.literal("permissions.set"),
    rationale: z.string().min(1),
    risk: configurationRisk,
    payload: z.object({
      permissions: z.object({
        write: z.enum(["none", "artifacts-only", "project"]),
        tools: z.array(z.string().min(1)).optional()
      }).strict()
    }).strict()
  }).strict(),
  z.object({
    type: z.literal("output-contract.set"),
    rationale: z.string().min(1),
    risk: configurationRisk,
    payload: z.object({
      outputSchema: z.record(z.string(), z.unknown()),
      verdict: configurationVerdictSchema.nullable().optional()
    }).strict()
  }).strict(),
  z.object({
    type: z.literal("context-policy.set"),
    rationale: z.string().min(1),
    risk: configurationRisk,
    payload: z.object({ historyLimit: z.number().int().min(0).max(100) }).strict()
  }).strict(),
  z.object({
    type: z.literal("presentation.set"),
    rationale: z.string().min(1),
    risk: configurationRisk,
    payload: z.object({
      accent: z.string().min(1).optional(),
      initials: z.string().min(1).optional(),
      avatarUrl: z.string().min(1).optional()
    }).strict()
  }).strict()
]);

export function createWorkbenchMcpServer(
  daemonUrl = "http://127.0.0.1:4318",
  options: { profile?: WorkbenchMcpProfile; sourceRunId?: string } = {}
): McpServer {
  const server = new McpServer({ name: "local-agent-workbench", version: "0.1.0" });

  if (options.profile === "configuration-control") {
    const sourceRunId = () => {
      const value = options.sourceRunId?.trim();
      if (!value) throw new Error("configuration-control MCP requires a source Run id");
      return value;
    };
    server.registerTool("configuration_control_snapshot", {
      title: "Inspect one Employee configuration target",
      description: "Read one existing Employee, available Providers and Skills, and its frozen configuration proposals. Knowledge grants are intentionally excluded. This tool never mutates state.",
      inputSchema: {}
    }, async () => content(await request(
      daemonUrl,
      `/api/configuration-control/snapshot?sourceRunId=${encodeURIComponent(sourceRunId())}`
    )));

    server.registerTool("configuration_proposal_list", {
      title: "List Employee configuration proposals",
      description: "List frozen proposals and human review progress for one Employee. This tool cannot review or apply them.",
      inputSchema: {}
    }, async () => content(await request(
      daemonUrl,
      `/api/configuration-control/proposals?sourceRunId=${encodeURIComponent(sourceRunId())}`
    )));

    server.registerTool("configuration_proposal_get", {
      title: "Inspect one Employee configuration proposal",
      description: "Read semantic before/after review items, expected Employee version, risk, plan hash, and review progress.",
      inputSchema: { proposalId: z.string().min(1) }
    }, async ({ proposalId }) => content(await request(
      daemonUrl,
      `/api/configuration-control/proposals/${encodeURIComponent(proposalId)}?sourceRunId=${encodeURIComponent(sourceRunId())}`
    )));

    server.registerTool("configuration_proposal_create", {
      title: "Create a governed Employee configuration proposal",
      description: "Create one frozen, strictly typed proposal for a single existing Employee. This never reviews, applies, patches, or changes the Employee. Read the current target first.",
      inputSchema: {
        title: z.string().min(1),
        reason: z.string().min(1),
        operations: z.array(configurationOperationSchema).min(1).max(9)
      }
    }, async (input) => content(await request(
      daemonUrl,
      "/api/configuration-proposals",
      {
        method: "POST",
        body: JSON.stringify({
          ...input,
          sourceRunId: sourceRunId()
        })
      }
    )));

    return server;
  }

  if (options.profile === "gate-control") {
    server.registerTool("workflow_control_snapshot", {
      title: "Inspect the workflow gate control plane",
      description: "Read supervisor workflows, their flow gates, and pending workflow change requests. Only supervisor workflows have gates. This tool never mutates state.",
      inputSchema: {}
    }, async () => {
      const bootstrap = await request<Record<string, unknown>>(daemonUrl, "/api/bootstrap");
      return content({
        workflows: bootstrap.workflows,
        workflowChanges: bootstrap.workflowChanges
      });
    });

    server.registerTool("workflow_change_list", {
      title: "List workflow gate change requests",
      description: "List awaiting-approval, applied, and rejected supervisor workflow gate changes.",
      inputSchema: {}
    }, async () => content(await request(daemonUrl, "/api/workflow-changes")));

    server.registerTool("workflow_change_get", {
      title: "Inspect a workflow gate change request",
      description: "Read the exact target workflow, frozen version, gate operations, rationale, risk, and review result for one change request.",
      inputSchema: { changeRequestId: z.string().min(1) }
    }, async ({ changeRequestId }) => content(await request(
      daemonUrl,
      `/api/workflow-changes/${encodeURIComponent(changeRequestId)}`
    )));

    server.registerTool("workflow_change_propose", {
      title: "Propose a governed supervisor workflow gate change",
      description: "Create one typed, validated change request that adds, updates, or removes supervisor workflow gates, for human review. This tool never approves or applies the change. Read the current workflow snapshot first and never invent workflow ids, gate ids, or validator ids.",
      inputSchema: {
        workflowId: z.string().min(1),
        title: z.string().min(1),
        reason: z.string().min(1),
        operations: z.array(workflowChangeOperationSchema).min(1)
      }
    }, async ({ workflowId, title, reason, operations }) => content(await request(
      daemonUrl,
      "/api/workflow-changes",
      {
        method: "POST",
        body: JSON.stringify({ workflowId, title, reason, requestedBy: "gate-steward", operations })
      }
    )));

    return server;
  }

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

  server.registerTool("list_entrance_policies", {
    title: "List task entrance policies",
    description: "List deterministic, versioned Entrance Policies without evaluating or starting work.",
    inputSchema: { includeArchived: z.boolean().optional() }
  }, async ({ includeArchived }) => content(await request(
    daemonUrl,
    `/api/entrance-policies?includeArchived=${includeArchived ? "true" : "false"}`
  )));

  server.registerTool("get_entrance_policy", {
    title: "Get task entrance policy",
    description: "Read one Entrance Policy and its immutable version history, including pinned route targets.",
    inputSchema: { entrancePolicyId: resourceId }
  }, async ({ entrancePolicyId }) => content(await request(
    daemonUrl,
    `/api/entrance-policies/${encodeURIComponent(entrancePolicyId)}`
  )));

  server.registerTool("evaluate_entrance_policy", {
    title: "Evaluate task entrance policy",
    description: "Evaluate only structured route, tag, source, and signal fields. This never creates an Invocation or Run and never reads message text.",
    inputSchema: {
      entrancePolicyId: resourceId,
      ...entranceEvaluationShape
    }
  }, async ({ entrancePolicyId, route, specialistKey, tags, signals, source }) => content(await request(
    daemonUrl,
    `/api/entrance-policies/${encodeURIComponent(entrancePolicyId)}/evaluate`,
    {
      method: "POST",
      body: JSON.stringify({ route, specialistKey, tags, signals, source: source ?? { kind: "mcp" } }),
      headers: invocationHeaders()
    }
  )));

  server.registerTool("dispatch_entrance_policy", {
    title: "Dispatch through task entrance policy",
    description: "Evaluate structured routing metadata, then return to the caller, invoke a pinned Employee/project role, or asynchronously start a pinned workflow. Message text is execution-only. If the result is invocation-started, the host MUST immediately loop wait_workflow_progress with receipt.monitor.initialCursor, keep the current turn open while terminal=false, relay every changed result or heartbeat, and deliver the final summary at terminal state.",
    inputSchema: {
      entrancePolicyId: resourceId,
      ...entranceEvaluationShape,
      message: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional()
    }
  }, async ({ entrancePolicyId, route, specialistKey, tags, signals, source, message, sessionId }) => {
    const dispatchSource = { ...source, kind: "mcp" as const };
    return content(await request(
      daemonUrl,
      `/api/entrance-policies/${encodeURIComponent(entrancePolicyId)}/dispatch`,
      {
        method: "POST",
        body: JSON.stringify({ route, specialistKey, tags, signals, source: dispatchSource, message, sessionId }),
        headers: invocationHeaders({
          project: dispatchSource.project,
          contextId: dispatchSource.contextId,
          caller: dispatchSource.caller
        })
      }
    ));
  });

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
      attachments: conversationAttachmentsSchema,
      project: z.string().min(1).optional(),
      contextId: z.string().min(1).optional(),
      caller: z.string().min(1).optional()
    }
  }, async ({ employeeId, message, sessionId, attachments, project, contextId, caller }) => content(await request(
    daemonUrl,
    `/api/employees/${encodeURIComponent(employeeId)}/invoke`,
    {
      method: "POST",
      body: JSON.stringify({ message, sessionId, attachments }),
      headers: invocationHeaders({ project, contextId, caller })
    }
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
      attachments: conversationAttachmentsSchema,
      contextId: z.string().min(1).optional(),
      caller: z.string().min(1).optional()
    }
  }, async ({ projectId, roleId, message, sessionId, attachments, contextId, caller }) => content(await request(
    daemonUrl,
    `/api/projects/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(roleId)}/invoke`,
    {
      method: "POST",
      body: JSON.stringify({ message, sessionId, attachments }),
      headers: invocationHeaders({ project: projectId, contextId, caller })
    }
  )));

  server.registerTool("list_workflows", {
    title: "List multi-agent workflows",
    description: "List Graph and Supervisor workflows registered in the local workbench.",
    inputSchema: { includeArchived: z.boolean().optional() }
  }, async ({ includeArchived }) => content(await request(
    daemonUrl,
    `/api/workflows?includeArchived=${includeArchived ? "true" : "false"}`
  )));

  server.registerTool("run_workflow", {
    title: "Run multi-agent workflow",
    description: "Compatibility entry point that waits for a registered Graph or Supervisor workflow to finish. Prefer start_workflow for long-running work.",
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
    description: "Start a registered Graph or Supervisor workflow asynchronously. The host MUST immediately loop wait_workflow_progress using monitor.initialCursor; while terminal=false it MUST NOT end the current turn, and it MUST relay every changed result or heartbeat to the user. At terminal state deliver progressReport as the final summary. Supervisor starts also return leaderSessionId for later continue_workflow_conversation; Graph starts never impersonate a leader session.",
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

  server.registerTool("list_human_decision_requests", {
    title: "List Supervisor human decisions",
    description: "List durable high-risk human-decision requests, optionally scoped to one invocation. Pending requests mean the proposed assignments have not been scheduled.",
    inputSchema: {
      invocationId: z.string().min(1).optional(),
      status: z.enum(["pending", "approved", "rejected", "voided"]).optional()
    }
  }, async ({ invocationId, status }) => {
    const query = new URLSearchParams();
    if (invocationId) query.set("invocationId", invocationId);
    if (status) query.set("status", status);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return content(await request(daemonUrl, `/api/human-decision-requests${suffix}`));
  });

  server.registerTool("get_human_decision_request", {
    title: "Get Supervisor human decision",
    description: "Read the exact invocation, Run, workflow version, Supervisor round, risk, proposed action, and decision audit for one request.",
    inputSchema: { requestId: z.string().min(1) }
  }, async ({ requestId }) => content(await request(
    daemonUrl,
    `/api/human-decision-requests/${encodeURIComponent(requestId)}`
  )));

  server.registerTool("decide_human_decision_request", {
    title: "Decide Supervisor high-risk action",
    description: "Approve or reject one pending high-risk action. Approval resumes the same invocation; rejection returns the comment to the same Supervisor loop for replanning. A request can be decided only once.",
    inputSchema: {
      requestId: z.string().min(1),
      decision: z.enum(["approve", "reject"]),
      comment: z.string().max(4_000).optional(),
      decidedBy: z.string().min(1).optional()
    }
  }, async ({ requestId, decision, comment, decidedBy }) => content(await request(
    daemonUrl,
    `/api/human-decision-requests/${encodeURIComponent(requestId)}/decide`,
    {
      method: "POST",
      body: JSON.stringify({ decision, comment, decidedBy: decidedBy ?? "mcp-local-owner" })
    }
  )));

  server.registerTool("get_workflow_progress", {
    title: "Get workflow progress",
    description: "Compatibility snapshot of aggregated workflow progress. Existing callers may keep using it; new asynchronous hosts should use event-driven wait_workflow_progress to avoid busy polling and preserve the current turn until terminal delivery.",
    inputSchema: { invocationId: z.string().min(1) }
  }, async ({ invocationId }) => content(await request(
    daemonUrl,
    `/api/invocations/${encodeURIComponent(invocationId)}/progress`
  )));

  server.registerTool("wait_workflow_progress", {
    title: "Wait for workflow progress",
    description: "Long-poll one asynchronous workflow without busy polling. Call immediately after start_workflow or an invocation-started Entrance dispatch, then call again with nextCursor while terminal=false. The host MUST keep the current turn open and report progressReport on every changed response and heartbeat; when terminal=true, stop waiting and actively deliver the final summary.",
    inputSchema: {
      invocationId: z.string().min(1),
      cursor: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1_000).max(55_000).optional()
    }
  }, async ({ invocationId, cursor, timeoutMs }) => {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    if (timeoutMs !== undefined) query.set("timeoutMs", String(timeoutMs));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return content(await request(
      daemonUrl,
      `/api/invocations/${encodeURIComponent(invocationId)}/progress/wait${suffix}`
    ));
  });

  server.registerTool("continue_workflow_conversation", {
    title: "Continue Supervisor leader conversation",
    description: "Continue talking in the durable, version-pinned leader Employee Session returned by a Supervisor workflow. The daemon rejects arbitrary Employee Sessions and preserves the original workflow/run context, including an interrupted-run explanation after daemon restart.",
    inputSchema: {
      leaderSessionId: z.string().min(1),
      message: z.string().min(1),
      attachments: conversationAttachmentsSchema,
      project: z.string().min(1).optional(),
      contextId: z.string().min(1).optional(),
      caller: z.string().min(1).optional()
    }
  }, async ({ leaderSessionId, message, attachments, project, contextId, caller }) => content(await request(
    daemonUrl,
    "/api/workflow-conversations/continue",
    {
      method: "POST",
      body: JSON.stringify({ leaderSessionId, message, attachments }),
      headers: invocationHeaders({ project, contextId, caller })
    }
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

  server.registerTool("search_memory", {
    title: "Search employee memory",
    description: "按 employee/project 维度检索该 Agent 过去运行的精炼经验；平时不注入以省 token，需要时才按需检索。默认返回运行级摘要。",
    inputSchema: {
      query: z.string().min(1),
      employeeId: z.string().optional(),
      projectId: z.string().optional(),
      limit: z.number().int().min(1).max(40).optional(),
      kind: z.enum(["run-summary", "node-detail", "preference"]).optional()
    }
  }, async (args) => {
    const data = await request<{ evidence: unknown[] }>(daemonUrl, "/api/memory/search", {
      method: "POST",
      body: JSON.stringify(args)
    });
    return content(data.evidence);
  });

  return server;
}
