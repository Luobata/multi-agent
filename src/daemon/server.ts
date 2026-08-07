import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { UserBuilder, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import type { JsonObject, ProviderDefinition } from "../core/types.js";
import type { MemoryKind } from "../memory/types.js";
import { decodeUtf8HeaderValue } from "../core/httpHeaders.js";
import { buildAgentCard, createA2ARequestHandler } from "../protocols/a2a.js";
import { WorkbenchService } from "../workbench/service.js";
import type {
  EntrancePolicyDispatchInput,
  EntrancePolicyEvaluationInput,
  InvocationSource,
  InvocationSourceKind
} from "../workbench/types.js";

type AsyncHandler = (request: Request, response: Response, next: NextFunction) => Promise<void>;

function asyncRoute(handler: AsyncHandler) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

function send(response: Response, data: unknown, status = 200): void {
  response.status(status).json({ data });
}

function booleanQuery(value: unknown): boolean {
  return value === "1" || value === "true";
}

function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function queryText(request: Request, name: string): string {
  const value = request.query[name];
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string" || !text.trim()) throw new Error(`${name} query parameter is required`);
  return text.trim();
}

function jsonObject(value: unknown, label = "input"): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function providerDefinition(value: unknown): ProviderDefinition {
  const definition = jsonObject(value, "provider definition");
  if (typeof definition.adapter !== "string" || !definition.adapter) {
    throw new Error("provider definition adapter must be a non-empty string");
  }
  return definition as ProviderDefinition;
}

function headerText(request: Request, name: string, maxLength = 240): string | undefined {
  const value = request.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string") return undefined;
  const decoded = decodeUtf8HeaderValue(text).trim();
  return decoded ? decoded.slice(0, maxLength) : undefined;
}

function invocationSource(request: Request, fallback: InvocationSourceKind): InvocationSource {
  const requestedKind = headerText(request, "x-multi-agent-source");
  const kind: InvocationSourceKind = requestedKind && ["workbench", "http", "mcp", "a2a"].includes(requestedKind)
    ? requestedKind as InvocationSourceKind
    : fallback;
  return {
    kind,
    label: headerText(request, "x-multi-agent-source-label"),
    project: headerText(request, "x-multi-agent-project"),
    caller: headerText(request, "x-multi-agent-caller"),
    contextId: headerText(request, "x-multi-agent-context")
  };
}

function mcpExecutionRoot(request: Request, source: InvocationSource): string | undefined {
  return source.kind === "mcp" ? headerText(request, "x-multi-agent-mcp-root", 4096) : undefined;
}

export interface DaemonAppOptions {
  baseUrl?: string;
  staticDir?: string;
}

export function createDaemonApp(service: WorkbenchService, options: DaemonAppOptions = {}): Express {
  const app = express();
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:4318").replace(/\/$/, "");
  const a2aHandlers = new Map<string, { version: number; handler: ReturnType<typeof jsonRpcHandler> }>();

  app.disable("x-powered-by");
  app.use("/api", express.json({ limit: "2mb" }));
  app.use("/api", (request, _response, next) => {
    const mcpRoot = headerText(request, "x-multi-agent-mcp-root", 4096);
    if (!mcpRoot) {
      next();
      return;
    }
    void service.recordPassiveProjectAccess({
      rootPath: mcpRoot,
      projectKey: headerText(request, "x-multi-agent-project")
    }).then(() => next(), next);
  });

  app.get("/api/health", (_request, response) => {
    send(response, {
      status: "ok",
      version: "0.1.0",
      dataRoot: service.store.dataRoot,
      bindPolicy: "loopback-only",
      capabilities: {
        knowledgeControlPlane: "v1",
        knowledgeDraftPreview: true,
        knowledgeUrlImport: "preview-propose-v1",
        knowledgeWiki: "derived-read-only-v1",
        knowledgePerspective: "run-evidence-v1",
        knowledgeGrantReview: "reminder-only-v1",
        knowledgeImpactAnalysis: true,
        knowledgeConversation: "codex-mcp-v1",
        knowledgeChangeApproval: true,
        configurationProposal: "review-items-v1",
        configurationConversation: "codex-mcp-v1",
        asyncWorkflowInvocations: "v1",
        supervisorWorkflows: "v1",
        managementPolicies: "versioned-v1",
        entrancePolicies: "versioned-routing-v1",
        employeeTemplates: "versioned-static-v1",
        employeeScopes: "version-pinned-v1",
        systemSkills: "read-only-v1",
        passiveProjectAccesses: "mcp-project-root-merge-v1"
      }
    });
  });

  app.get("/api/bootstrap", (_request, response) => {
    send(response, {
      providers: service.listProviders(),
      skills: service.listSkills(true),
      knowledgeBases: service.listKnowledgeBases(true),
      knowledgeProfiles: service.listKnowledgeProfiles(true),
      knowledgeChanges: service.listKnowledgeChangeRequests(),
      configurationProposals: service.listConfigurationProposals(),
      architectureTemplates: service.listArchitectureTemplates(),
      gateValidators: service.listGateValidators(),
      employees: service.listEmployees(true),
      employeeTemplates: service.listEmployeeTemplates(true),
      managementPolicies: service.listManagementPolicies(true),
      entrancePolicies: service.listEntrancePolicies(true),
      workflows: service.listWorkflows(true),
      sessions: service.listSessions(),
      publications: service.listPublications(true),
      projects: service.listProjects(true),
      projectBindings: service.listProjectBindings(),
      passiveProjectAccesses: service.listPassiveProjectAccesses(),
      activity: service.getActivitySnapshot()
    });
  });

  app.get("/api/activity", (request, response) => {
    const parsed = Number(request.query.limit ?? 100);
    send(response, service.getActivitySnapshot(Number.isFinite(parsed) ? parsed : 100));
  });
  app.get("/api/invocations/:id", asyncRoute(async (request, response) => {
    send(response, await service.getInvocationDetail(routeParam(request, "id")));
  }));
  app.get("/api/invocations/:id/progress", asyncRoute(async (request, response) => {
    send(response, await service.getInvocationProgress(routeParam(request, "id")));
  }));
  app.get("/api/activity/stream", (request, response) => {
    response.status(200);
    response.set({
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    response.flushHeaders();
    const write = (event: string, data: unknown) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    write("snapshot", service.getActivitySnapshot());
    const unsubscribe = service.subscribeActivity((event) => write("activity", event));
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      response.end();
    });
  });

  app.get("/api/providers", (_request, response) => send(response, service.listProviders()));
  app.put("/api/providers/:id", asyncRoute(async (request, response) => {
    const id = routeParam(request, "id");
    await service.putProvider(id, providerDefinition(request.body));
    send(response, service.listProviders().find((provider) => provider.id === id));
  }));

  app.get("/api/skills", (request, response) => send(response, service.listSkills(booleanQuery(request.query.includeArchived))));
  app.post("/api/skills", asyncRoute(async (request, response) => {
    send(response, await service.createSkill(request.body), 201);
  }));
  app.patch("/api/skills/:id", asyncRoute(async (request, response) => {
    send(response, await service.updateSkill(routeParam(request, "id"), request.body));
  }));
  app.post("/api/skills/:id/archive", asyncRoute(async (request, response) => {
    send(response, await service.archiveSkill(routeParam(request, "id")));
  }));
  app.post("/api/skills/:id/restore", asyncRoute(async (request, response) => {
    send(response, await service.restoreSkill(routeParam(request, "id")));
  }));

  app.get("/api/knowledge-bases", (request, response) => {
    send(response, service.listKnowledgeBases(booleanQuery(request.query.includeArchived)));
  });
  app.post("/api/knowledge-bases", asyncRoute(async (request, response) => {
    send(response, await service.createKnowledgeBase(request.body), 201);
  }));
  app.get("/api/knowledge-bases/:id", asyncRoute(async (request, response) => {
    send(response, await service.getKnowledgeBaseDetail(routeParam(request, "id")));
  }));
  app.get("/api/knowledge-bases/:id/assessment", asyncRoute(async (request, response) => {
    const revision = request.query.revision === undefined ? undefined : Number(request.query.revision);
    send(response, await service.assessKnowledgeRevision(routeParam(request, "id"), revision));
  }));
  app.post("/api/knowledge-bases/:id/preview", asyncRoute(async (request, response) => {
    send(response, await service.previewKnowledgeRevision(routeParam(request, "id"), request.body));
  }));
  app.get("/api/knowledge-bases/:id/wiki", asyncRoute(async (request, response) => {
    const revision = request.query.revision === undefined ? undefined : Number(request.query.revision);
    send(response, await service.getKnowledgeWiki(routeParam(request, "id"), revision));
  }));
  app.patch("/api/knowledge-bases/:id", asyncRoute(async (request, response) => {
    send(response, await service.updateKnowledgeBase(routeParam(request, "id"), request.body));
  }));
  app.post("/api/knowledge-bases/:id/revisions", asyncRoute(async (request, response) => {
    send(response, await service.createKnowledgeRevision(routeParam(request, "id"), request.body), 201);
  }));
  app.post("/api/knowledge-bases/:id/sync", asyncRoute(async (request, response) => {
    send(response, await service.syncKnowledgeBase(routeParam(request, "id")));
  }));
  app.post("/api/knowledge-bases/:id/publish", asyncRoute(async (request, response) => {
    const revision = request.body?.revision === undefined ? undefined : Number(request.body.revision);
    send(response, await service.publishKnowledgeRevision(routeParam(request, "id"), revision));
  }));
  app.post("/api/knowledge-bases/:id/archive", asyncRoute(async (request, response) => {
    send(response, await service.archiveKnowledgeBase(routeParam(request, "id")));
  }));
  app.post("/api/knowledge-bases/:id/restore", asyncRoute(async (request, response) => {
    send(response, await service.restoreKnowledgeBase(routeParam(request, "id")));
  }));

  app.get("/api/knowledge-profiles", (request, response) => {
    send(response, service.listKnowledgeProfiles(booleanQuery(request.query.includeArchived)));
  });
  app.post("/api/knowledge-profiles", asyncRoute(async (request, response) => {
    send(response, await service.createKnowledgeProfile(request.body), 201);
  }));
  app.patch("/api/knowledge-profiles/:id", asyncRoute(async (request, response) => {
    send(response, await service.updateKnowledgeProfile(routeParam(request, "id"), request.body));
  }));
  app.post("/api/knowledge-profiles/:id/archive", asyncRoute(async (request, response) => {
    send(response, await service.archiveKnowledgeProfile(routeParam(request, "id")));
  }));
  app.post("/api/knowledge-profiles/:id/restore", asyncRoute(async (request, response) => {
    send(response, await service.restoreKnowledgeProfile(routeParam(request, "id")));
  }));
  app.post("/api/employees/:id/knowledge-preview", asyncRoute(async (request, response) => {
    send(response, await service.previewEmployeeKnowledge(routeParam(request, "id"), request.body));
  }));
  app.post("/api/employees/:id/knowledge-perspective", asyncRoute(async (request, response) => {
    send(response, await service.getEmployeeKnowledgePerspective(routeParam(request, "id"), request.body));
  }));
  app.post("/api/knowledge/url-preview", asyncRoute(async (request, response) => {
    send(response, await service.previewKnowledgeUrl(request.body));
  }));
  app.post("/api/knowledge/url-proposals", asyncRoute(async (request, response) => {
    send(response, await service.proposeKnowledgeUrl(request.body), 201);
  }));
  app.get("/api/knowledge/reviews", (request, response, next) => {
    try {
      const dueSoonDays = request.query.dueSoonDays === undefined ? undefined : Number(request.query.dueSoonDays);
      send(response, service.listKnowledgeGrantReviews({
        asOf: typeof request.query.asOf === "string" ? request.query.asOf : undefined,
        dueSoonDays
      }));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/knowledge/impact", (_request, response) => {
    send(response, service.getKnowledgeImpactSnapshot());
  });
  app.get("/api/knowledge-changes", (_request, response) => {
    send(response, service.listKnowledgeChangeRequests());
  });
  app.post("/api/knowledge-changes", asyncRoute(async (request, response) => {
    send(response, await service.createKnowledgeChangeRequest(request.body), 201);
  }));
  app.get("/api/knowledge-changes/:id", (request, response, next) => {
    try {
      send(response, service.getKnowledgeChangeRequest(routeParam(request, "id")));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/knowledge-changes/:id/approve", asyncRoute(async (request, response) => {
    send(response, await service.approveKnowledgeChangeRequest(
      routeParam(request, "id"),
      "local-owner",
      typeof request.body?.comment === "string" ? request.body.comment : undefined
    ));
  }));
  app.post("/api/knowledge-changes/:id/reject", asyncRoute(async (request, response) => {
    send(response, await service.rejectKnowledgeChangeRequest(
      routeParam(request, "id"),
      "local-owner",
      typeof request.body?.comment === "string" ? request.body.comment : undefined
    ));
  }));
  app.post("/api/knowledge-changes/:id/cancel", asyncRoute(async (request, response) => {
    send(response, await service.cancelKnowledgeChangeRequest(
      routeParam(request, "id"),
      "local-owner",
      typeof request.body?.comment === "string" ? request.body.comment : undefined
    ));
  }));

  app.get("/api/configuration-proposals", (request, response) => {
    send(response, service.listConfigurationProposals(
      typeof request.query.employeeId === "string" ? request.query.employeeId : undefined
    ));
  });
  app.get("/api/configuration-control/snapshot", (request, response, next) => {
    try {
      send(response, service.getConfigurationControlSnapshot(queryText(request, "sourceRunId")));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/configuration-control/proposals", (request, response, next) => {
    try {
      send(response, service.listConfigurationProposalsForControl(queryText(request, "sourceRunId")));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/configuration-control/proposals/:id", (request, response, next) => {
    try {
      send(response, service.getConfigurationProposalForControl(
        queryText(request, "sourceRunId"),
        routeParam(request, "id")
      ));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/configuration-proposals", asyncRoute(async (request, response) => {
    send(response, await service.createConfigurationProposal(request.body), 201);
  }));
  app.get("/api/configuration-proposals/:id", (request, response, next) => {
    try {
      send(response, service.getConfigurationProposal(routeParam(request, "id")));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/configuration-proposals/:id/review-items/:reviewItemId/decisions", asyncRoute(async (request, response) => {
    send(response, await service.decideConfigurationReviewItem(
      routeParam(request, "id"),
      routeParam(request, "reviewItemId"),
      {
        decision: request.body?.decision,
        expectedReviewRevision: request.body?.expectedReviewRevision,
        expectedReviewHash: request.body?.expectedReviewHash,
        actor: "local-owner",
        comment: typeof request.body?.comment === "string" ? request.body.comment : undefined
      }
    ));
  }));
  app.post("/api/configuration-proposals/:id/apply", asyncRoute(async (request, response) => {
    send(response, await service.applyConfigurationProposal(routeParam(request, "id"), {
      expectedReviewRevision: request.body?.expectedReviewRevision,
      expectedReviewHash: request.body?.expectedReviewHash
    }, "local-owner"));
  }));
  app.post("/api/configuration-proposals/:id/cancel", asyncRoute(async (request, response) => {
    send(response, await service.cancelConfigurationProposal(
      routeParam(request, "id"),
      "local-owner",
      typeof request.body?.comment === "string" ? request.body.comment : undefined
    ));
  }));

  app.get("/api/architecture-templates", (_request, response) => send(response, service.listArchitectureTemplates()));
  app.post("/api/architecture-templates/:id/instantiate", (request, response, next) => {
    try {
      const employeeIds = request.body?.employeeIds;
      if (!Array.isArray(employeeIds) || employeeIds.some((value) => typeof value !== "string")) {
        throw new Error("employeeIds must be an array of employee ids");
      }
      send(response, service.instantiateArchitectureTemplate(routeParam(request, "id"), employeeIds));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects", (request, response) => {
    send(response, service.listProjects(booleanQuery(request.query.includeArchived)));
  });
  app.get("/api/project-accesses", (_request, response) => {
    send(response, service.listPassiveProjectAccesses());
  });
  app.post("/api/projects/connect", asyncRoute(async (request, response) => {
    send(response, await service.connectProject(request.body), 201);
  }));
  app.get("/api/projects/:id", (request, response, next) => {
    try {
      const id = routeParam(request, "id");
      send(response, {
        project: service.getProject(id),
        versions: service.getProjectVersions(id),
        binding: service.listProjectBindings().find((candidate) => candidate.projectId === id),
        bindingVersions: service.getProjectBindingVersions(id)
      });
    } catch (error) {
      next(error);
    }
  });
  app.put("/api/projects/:id/binding", asyncRoute(async (request, response) => {
    send(response, await service.saveProjectBinding(routeParam(request, "id"), request.body));
  }));
  app.post("/api/projects/:id/binding/refresh", asyncRoute(async (request, response) => {
    send(response, await service.refreshProjectBinding(routeParam(request, "id")));
  }));
  app.post("/api/projects/:id/archive", asyncRoute(async (request, response) => {
    send(response, await service.archiveProject(routeParam(request, "id")));
  }));
  app.post("/api/projects/:id/roles/:roleId/invoke", asyncRoute(async (request, response) => {
    send(response, await service.invokeProjectRole(
      routeParam(request, "id"),
      routeParam(request, "roleId"),
      request.body,
      invocationSource(request, "http")
    ));
  }));

  app.get("/api/employee-templates", (request, response) => {
    send(response, service.listEmployeeTemplates(booleanQuery(request.query.includeArchived)));
  });
  app.post("/api/employee-templates", asyncRoute(async (request, response) => {
    send(response, await service.createEmployeeTemplate(request.body), 201);
  }));
  app.get("/api/employee-templates/:id", (request, response, next) => {
    try {
      const id = routeParam(request, "id");
      send(response, {
        template: service.getEmployeeTemplate(id),
        versions: service.getEmployeeTemplateVersions(id)
      });
    } catch (error) {
      next(error);
    }
  });
  app.patch("/api/employee-templates/:id", asyncRoute(async (request, response) => {
    send(response, await service.updateEmployeeTemplate(routeParam(request, "id"), request.body));
  }));
  app.post("/api/employee-templates/:id/archive", asyncRoute(async (request, response) => {
    send(response, await service.archiveEmployeeTemplate(routeParam(request, "id")));
  }));
  app.post("/api/employee-templates/:id/restore", asyncRoute(async (request, response) => {
    send(response, await service.restoreEmployeeTemplate(routeParam(request, "id")));
  }));
  app.post("/api/employee-templates/:id/employees", asyncRoute(async (request, response) => {
    send(response, await service.createEmployeeFromTemplate(routeParam(request, "id"), request.body), 201);
  }));

  app.get("/api/employees", (request, response) => {
    send(response, service.listEmployees(booleanQuery(request.query.includeArchived)));
  });
  app.post("/api/employees", asyncRoute(async (request, response) => {
    send(response, await service.createEmployee(request.body), 201);
  }));
  app.get("/api/employees/:id", (request, response, next) => {
    try {
      const id = routeParam(request, "id");
      send(response, {
        employee: service.getEmployee(id),
        versions: service.getEmployeeVersions(id),
        sessions: service.listSessions(id)
      });
    } catch (error) {
      next(error);
    }
  });
  app.patch("/api/employees/:id", asyncRoute(async (request, response) => {
    send(response, await service.updateEmployee(routeParam(request, "id"), request.body));
  }));
  app.post("/api/employees/:id/clone", asyncRoute(async (request, response) => {
    send(
      response,
      await service.cloneEmployee(routeParam(request, "id"), String(request.body?.id ?? ""), request.body?.displayName),
      201
    );
  }));
  app.post("/api/employees/:id/archive", asyncRoute(async (request, response) => {
    send(response, await service.archiveEmployee(routeParam(request, "id")));
  }));
  app.get("/api/employees/:id/context", asyncRoute(async (request, response) => {
    send(
      response,
      await service.getEmployeeContext(
        routeParam(request, "id"),
        typeof request.query.sessionId === "string" ? request.query.sessionId : undefined
      )
    );
  }));
  app.post("/api/employees/:id/invoke", asyncRoute(async (request, response) => {
    const source = invocationSource(request, "http");
    send(response, await service.invokeEmployee(
      routeParam(request, "id"),
      request.body,
      source,
      { providerCwd: mcpExecutionRoot(request, source) }
    ));
  }));

  app.get("/api/sessions", (request, response) => {
    send(response, service.listSessions(typeof request.query.employeeId === "string" ? request.query.employeeId : undefined));
  });
  app.get("/api/sessions/:id", (request, response, next) => {
    try {
      send(response, service.getSession(routeParam(request, "id")));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workflows", (request, response) => {
    send(response, service.listWorkflows(booleanQuery(request.query.includeArchived)));
  });
  app.post("/api/workflows", asyncRoute(async (request, response) => {
    send(response, await service.createWorkflow(request.body), 201);
  }));
  app.get("/api/workflows/:id", (request, response, next) => {
    try {
      const id = routeParam(request, "id");
      send(response, { workflow: service.getWorkflow(id), versions: service.getWorkflowVersions(id) });
    } catch (error) {
      next(error);
    }
  });
  app.patch("/api/workflows/:id", asyncRoute(async (request, response) => {
    send(response, await service.updateWorkflow(routeParam(request, "id"), request.body));
  }));
  app.post("/api/workflows/:id/archive", asyncRoute(async (request, response) => {
    send(response, await service.archiveWorkflow(routeParam(request, "id")));
  }));
  app.post("/api/workflows/:id/refresh", asyncRoute(async (request, response) => {
    send(response, await service.refreshWorkflow(routeParam(request, "id")));
  }));
  app.get("/api/workflows/:id/plan", asyncRoute(async (request, response) => {
    send(response, await service.planWorkflow(routeParam(request, "id")));
  }));
  app.post("/api/workflows/:id/run", asyncRoute(async (request, response) => {
    const source = invocationSource(request, "http");
    send(response, await service.runWorkbenchWorkflow(
      routeParam(request, "id"),
      jsonObject(request.body ?? {}, "workflow input"),
      source,
      { providerCwd: mcpExecutionRoot(request, source) }
    ));
  }));
  app.post("/api/workflows/:id/start", asyncRoute(async (request, response) => {
    const source = invocationSource(request, "http");
    const started = await service.startWorkbenchWorkflow(
      routeParam(request, "id"),
      jsonObject(request.body ?? {}, "workflow input"),
      source,
      { providerCwd: mcpExecutionRoot(request, source) }
    );
    send(response, {
      ...started,
      statusUrl: `/api/invocations/${encodeURIComponent(started.invocation.id)}`,
      progressUrl: `/api/invocations/${encodeURIComponent(started.invocation.id)}/progress`,
      streamUrl: "/api/activity/stream"
    }, 202);
  }));

  app.get("/api/management-policies", (request, response) => {
    send(response, service.listManagementPolicies(booleanQuery(request.query.includeArchived)));
  });
  app.post("/api/management-policies", asyncRoute(async (request, response) => {
    send(response, await service.createManagementPolicy(request.body), 201);
  }));
  app.get("/api/management-policies/:id", (request, response, next) => {
    try {
      const id = routeParam(request, "id");
      send(response, {
        policy: service.getManagementPolicy(id),
        versions: service.getManagementPolicyVersions(id)
      });
    } catch (error) {
      next(error);
    }
  });
  app.patch("/api/management-policies/:id", asyncRoute(async (request, response) => {
    send(response, await service.updateManagementPolicy(routeParam(request, "id"), request.body));
  }));
  app.post("/api/management-policies/:id/archive", asyncRoute(async (request, response) => {
    send(response, await service.archiveManagementPolicy(routeParam(request, "id")));
  }));
  app.post("/api/management-policies/:id/restore", asyncRoute(async (request, response) => {
    send(response, await service.restoreManagementPolicy(routeParam(request, "id")));
  }));

  app.get("/api/entrance-policies", (request, response) => {
    send(response, service.listEntrancePolicies(booleanQuery(request.query.includeArchived)));
  });
  app.post("/api/entrance-policies", asyncRoute(async (request, response) => {
    send(response, await service.createEntrancePolicy(request.body), 201);
  }));
  app.get("/api/entrance-policies/:id", (request, response, next) => {
    try {
      const id = routeParam(request, "id");
      send(response, {
        policy: service.getEntrancePolicy(id),
        versions: service.getEntrancePolicyVersions(id)
      });
    } catch (error) {
      next(error);
    }
  });
  app.patch("/api/entrance-policies/:id", asyncRoute(async (request, response) => {
    send(response, await service.updateEntrancePolicy(routeParam(request, "id"), request.body));
  }));
  app.post("/api/entrance-policies/:id/archive", asyncRoute(async (request, response) => {
    send(response, await service.archiveEntrancePolicy(routeParam(request, "id")));
  }));
  app.post("/api/entrance-policies/:id/restore", asyncRoute(async (request, response) => {
    send(response, await service.restoreEntrancePolicy(routeParam(request, "id")));
  }));
  app.post("/api/entrance-policies/:id/evaluate", asyncRoute(async (request, response) => {
    const body = jsonObject(request.body ?? {}, "entrance policy evaluation");
    const input = {
      ...body,
      source: body.source ?? invocationSource(request, "http")
    } as unknown as EntrancePolicyEvaluationInput;
    send(response, service.evaluateEntrancePolicy(routeParam(request, "id"), input));
  }));
  app.post("/api/entrance-policies/:id/dispatch", asyncRoute(async (request, response) => {
    const body = jsonObject(request.body ?? {}, "entrance policy dispatch");
    const input = {
      ...body,
      source: body.source ?? invocationSource(request, "http")
    } as unknown as EntrancePolicyDispatchInput;
    const source = input.source as InvocationSource;
    const result = await service.dispatchEntrancePolicy(routeParam(request, "id"), input, {
      providerCwd: mcpExecutionRoot(request, source)
    });
    if (result.dispatch.kind !== "invocation-started") {
      send(response, result);
      return;
    }
    const invocationId = result.dispatch.receipt.invocation.id;
    send(response, {
      ...result,
      dispatch: {
        ...result.dispatch,
        statusUrl: `/api/invocations/${encodeURIComponent(invocationId)}`,
        progressUrl: `/api/invocations/${encodeURIComponent(invocationId)}/progress`,
        streamUrl: "/api/activity/stream"
      }
    }, 202);
  }));

  app.get("/api/runs", asyncRoute(async (request, response) => {
    const parsed = Number(request.query.limit ?? 50);
    send(response, await service.listRuns(Number.isFinite(parsed) ? parsed : 50));
  }));
  app.get("/api/runs/:id", asyncRoute(async (request, response) => {
    send(response, await service.getRun(routeParam(request, "id")));
  }));

  app.post("/api/memory/search", asyncRoute(async (request, response) => {
    const body = (request.body ?? {}) as {
      query?: unknown;
      employeeId?: unknown;
      projectId?: unknown;
      limit?: unknown;
      kind?: unknown;
    };
    const hits = await service.searchMemory({
      query: typeof body.query === "string" ? body.query : "",
      scope: {
        employeeId: typeof body.employeeId === "string" ? body.employeeId : undefined,
        projectId: typeof body.projectId === "string" ? body.projectId : undefined
      },
      limit: typeof body.limit === "number" ? body.limit : undefined,
      kind: body.kind as MemoryKind | undefined
    });
    send(response, { evidence: hits });
  }));

  app.get("/api/publications", (request, response) => {
    send(response, service.listPublications(booleanQuery(request.query.includeArchived)));
  });
  app.post("/api/publications", asyncRoute(async (request, response) => {
    send(response, await service.createPublication(request.body), 201);
  }));
  app.get("/api/publications/:id", (request, response, next) => {
    try {
      send(response, service.getPublication(routeParam(request, "id")));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/publications/:id/archive", asyncRoute(async (request, response) => {
    send(response, await service.archivePublication(routeParam(request, "id")));
  }));
  app.get("/api/publications/:id/card", (request, response, next) => {
    try {
      send(response, buildAgentCard(service, routeParam(request, "id"), baseUrl, { allowArchived: true }));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/publications/:id/invoke", asyncRoute(async (request, response) => {
    const source = invocationSource(request, "http");
    send(response, await service.invokePublication(
      routeParam(request, "id"),
      jsonObject(request.body ?? {}, "publication input"),
      source,
      { providerCwd: mcpExecutionRoot(request, source) }
    ));
  }));

  app.get("/a2a/:publicationId/.well-known/agent-card.json", (request, response, next) => {
    try {
      response.json(buildAgentCard(service, routeParam(request, "publicationId"), baseUrl));
    } catch (error) {
      next(error);
    }
  });
  app.use("/a2a/:publicationId", (request, response, next) => {
    if (request.method !== "POST" || request.path !== "/") {
      next();
      return;
    }
    try {
      const publicationId = routeParam(request, "publicationId");
      const publication = service.getPublication(publicationId);
      let cached = a2aHandlers.get(publicationId);
      if (!cached || cached.version !== publication.version) {
        cached = {
          version: publication.version,
          handler: jsonRpcHandler({
            requestHandler: createA2ARequestHandler(service, publicationId, baseUrl),
            userBuilder: UserBuilder.noAuthentication
          })
        };
        a2aHandlers.set(publicationId, cached);
      }
      cached.handler(request, response, next);
    } catch (error) {
      next(error);
    }
  });

  const staticDir = options.staticDir ?? path.resolve(process.cwd(), "dist", "client");
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/") || request.path.startsWith("/a2a/")) {
        next();
        return;
      }
      response.sendFile(path.join(staticDir, "index.html"));
    });
  }

  app.use((request, response) => {
    response.status(404).json({ error: { message: `not found: ${request.method} ${request.originalUrl}` } });
  });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/.test(message) ? 404 : /already exists/.test(message) ? 409 : 400;
    response.status(status).json({ error: { message } });
  });

  return app;
}

export interface StartDaemonOptions extends DaemonAppOptions {
  host?: string;
  port?: number;
}

export async function startDaemon(service: WorkbenchService, options: StartDaemonOptions = {}): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4318;
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("v1 daemon is loopback-only");
  }
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const app = createDaemonApp(service, {
    ...options,
    baseUrl: options.baseUrl ?? `http://${urlHost}:${port}`
  });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}
