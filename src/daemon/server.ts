import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { UserBuilder, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import type { JsonObject, ProviderDefinition } from "../core/types.js";
import { buildAgentCard, createA2ARequestHandler } from "../protocols/a2a.js";
import { WorkbenchService } from "../workbench/service.js";

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

  app.get("/api/health", (_request, response) => {
    send(response, {
      status: "ok",
      version: "0.1.0",
      dataRoot: service.store.dataRoot,
      bindPolicy: "loopback-only"
    });
  });

  app.get("/api/bootstrap", (_request, response) => {
    send(response, {
      providers: service.listProviders(),
      skills: service.listSkills(true),
      architectureTemplates: service.listArchitectureTemplates(),
      employees: service.listEmployees(true),
      workflows: service.listWorkflows(true),
      sessions: service.listSessions(),
      publications: service.listPublications(true)
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
    send(response, await service.invokeEmployee(routeParam(request, "id"), request.body));
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
  app.get("/api/workflows/:id/plan", asyncRoute(async (request, response) => {
    send(response, await service.planWorkflow(routeParam(request, "id")));
  }));
  app.post("/api/workflows/:id/run", asyncRoute(async (request, response) => {
    send(response, await service.runWorkbenchWorkflow(routeParam(request, "id"), jsonObject(request.body ?? {}, "workflow input")));
  }));

  app.get("/api/runs", asyncRoute(async (request, response) => {
    const parsed = Number(request.query.limit ?? 50);
    send(response, await service.listRuns(Number.isFinite(parsed) ? parsed : 50));
  }));
  app.get("/api/runs/:id", asyncRoute(async (request, response) => {
    send(response, await service.getRun(routeParam(request, "id")));
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
