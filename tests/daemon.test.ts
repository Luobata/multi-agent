import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  WorkbenchService,
  createDaemonApp,
  createWorkbenchMcpServer,
  type KnowledgeFetchedUrl
} from "../src/index.js";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fetchedKnowledgePage(): KnowledgeFetchedUrl {
  const html = `<!doctype html><html><head><title>Desk URL Handbook</title></head><body>
    <p>Desk reviews preserve traceable evidence.</p>
    <h2 id="review-steps">Review steps</h2>
    <p>Review the evidence before approval.</p>
  </body></html>`;
  const body = Buffer.from(html);
  return {
    requestedUrl: "https://public.example/desk-handbook",
    finalUrl: "https://public.example/desk-handbook",
    redirects: [],
    contentType: "text/html",
    byteLength: body.length,
    contentSha256: createHash("sha256").update(body).digest("hex"),
    html,
    fetchedAt: "2026-01-15T00:00:00.000Z"
  };
}

async function fixture(options: { knowledgeUrlFetcher?: { fetch: (url: string) => Promise<KnowledgeFetchedUrl> } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-daemon-"));
  directories.push(root);
  const service = await WorkbenchService.open({
    dataRoot: root,
    knowledgeUrlFetcher: options.knowledgeUrlFetcher
  });
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
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, service };
}

describe("workbench daemon", () => {
  it("serves same-origin browser assets while rejecting cross-origin requests", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-daemon-origin-"));
    directories.push(root);
    fs.writeFileSync(path.join(root, "app.js"), "globalThis.__workbenchLoaded = true;\n", "utf8");
    const service = await WorkbenchService.open({ dataRoot: path.join(root, "data") });
    const app = createDaemonApp(service, { baseUrl: "http://127.0.0.1:4318", staticDir: root });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const sameOrigin = await fetch(`${base}/app.js`, { headers: { origin: "http://127.0.0.1:4318" } });
    expect(sameOrigin.status).toBe(200);
    expect(await sameOrigin.text()).toContain("__workbenchLoaded");

    const crossOrigin = await fetch(`${base}/app.js`, { headers: { origin: "https://attacker.example" } });
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toEqual({ error: { message: "request Origin is not allowed" } });

    const sameOriginPost = await fetch(`${base}/api/bundles/export`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:4318" },
      body: JSON.stringify({ modes: ["employee"] })
    });
    expect(sameOriginPost.status).toBe(200);
    await expect(sameOriginPost.json()).resolves.toMatchObject({ data: { mode: ["employee"] } });

    const secured = createDaemonApp(service, {
      baseUrl: "http://127.0.0.1:4318",
      staticDir: root,
      capabilityToken: "test-capability"
    }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      secured.once("listening", resolve);
      secured.once("error", reject);
    });
    servers.push(secured);
    const securedBase = `http://127.0.0.1:${(secured.address() as AddressInfo).port}`;
    const missingCapability = await fetch(`${securedBase}/api/bundles/export`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:4318" },
      body: JSON.stringify({ modes: ["employee"] })
    });
    expect(missingCapability.status).toBe(403);
    const authorized = await fetch(`${securedBase}/api/bundles/export`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4318",
        "x-multi-agent-capability": "test-capability"
      },
      body: JSON.stringify({ modes: ["employee"] })
    });
    expect(authorized.status).toBe(200);
  });

  it("hosts a target project's conversation through another compatible assigned project role", async () => {
    const { base, service } = await fixture();
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-conversation-target-"));
    directories.push(targetRoot);
    await service.createProject({
      id: "target-without-intake-role",
      name: "Target Without Intake Role",
      rootPath: targetRoot,
      descriptorPath: path.join(targetRoot, "multi-agent.project.yaml"),
      roles: [{ id: "developer", displayName: "Developer" }]
    });

    const response = await fetch(`${base}/api/projects/target-without-intake-role/conversations/reviewer/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Please clarify this vague request" })
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { data: { session: { assignment?: { projectId: string; roleId: string } } } };
    expect(payload.data.session.assignment).toMatchObject({ projectId: "desk-project", roleId: "reviewer" });

    const [invocation] = service.getActivitySnapshot().invocations;
    expect(invocation?.source).toMatchObject({
      project: "desk-project",
      targetProject: "target-without-intake-role",
      projectRole: "reviewer"
    });
    const detail = await service.getInvocationDetail(invocation!.id);
    expect(JSON.stringify(detail.run)).toContain("Target Without Intake Role");
    expect(JSON.stringify(detail.run)).toContain("Please clarify this vague request");
  });

  it("starts Employee and project conversations with recoverable Invocation receipts", async () => {
    const { base, service } = await fixture();
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-async-conversation-target-"));
    directories.push(targetRoot);
    await service.createProject({
      id: "async-conversation-target",
      name: "Async Conversation Target",
      rootPath: targetRoot,
      descriptorPath: path.join(targetRoot, "multi-agent.project.yaml"),
      roles: [{ id: "developer", displayName: "Developer" }]
    });

    const directResponse = await fetch(`${base}/api/employees/desk-agent/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Start a direct durable turn" })
    });
    expect(directResponse.status).toBe(202);
    const direct = await directResponse.json() as {
      data: {
        invocation: { id: string; sessionId: string; target: { kind: string; id: string } };
        runId: string;
        statusUrl: string;
        progressUrl: string;
        monitor: { initialCursor: string; waitUrl: string };
      };
    };
    expect(direct.data).toMatchObject({
      invocation: { target: { kind: "employee", id: "desk-agent" } },
      statusUrl: `/api/invocations/${direct.data.invocation.id}`,
      progressUrl: `/api/invocations/${direct.data.invocation.id}/progress`,
      monitor: { waitUrl: `/api/invocations/${direct.data.invocation.id}/progress/wait` }
    });
    await service.waitForInvocation(direct.data.invocation.id);
    expect(service.getSession(direct.data.invocation.sessionId).messages).toEqual([
      expect.objectContaining({ role: "user", content: "Start a direct durable turn", runId: direct.data.runId }),
      expect.objectContaining({ role: "employee", runId: direct.data.runId })
    ]);

    const conversationResponse = await fetch(
      `${base}/api/projects/async-conversation-target/conversations/reviewer/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Clarify asynchronously" })
      }
    );
    expect(conversationResponse.status).toBe(202);
    const conversation = await conversationResponse.json() as {
      data: {
        invocation: { id: string; sessionId: string; source: { project?: string; targetProject?: string; projectRole?: string } };
        runId: string;
        monitor: { waitUrl: string };
      };
    };
    expect(conversation.data.invocation.source).toMatchObject({
      project: "desk-project",
      targetProject: "async-conversation-target",
      projectRole: "reviewer"
    });
    await service.waitForInvocation(conversation.data.invocation.id);
    const recoveredResponse = await fetch(`${base}/api/runs/${encodeURIComponent(conversation.data.runId)}/monitor`);
    expect(recoveredResponse.status).toBe(200);
    await expect(recoveredResponse.json()).resolves.toMatchObject({
      data: {
        invocation: { id: conversation.data.invocation.id, target: { kind: "employee" } },
        runId: conversation.data.runId,
        monitor: { waitUrl: conversation.data.monitor.waitUrl }
      }
    });
    expect(JSON.stringify(await service.getInvocationDetail(conversation.data.invocation.id)))
      .toContain("Async Conversation Target");
  });

  it("repins a project-scoped Employee through the live daemon after a project descriptor upgrade", async () => {
    const { base, service } = await fixture();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-repin-project-"));
    directories.push(projectRoot);
    const projectInput = {
      id: "repin-project",
      name: "Repin Project",
      rootPath: projectRoot,
      descriptorPath: path.join(projectRoot, "multi-agent.project.yaml"),
      roles: [{ id: "developer", displayName: "Developer" }]
    };
    await service.createProject(projectInput);
    await service.createEmployee({
      id: "repin-worker",
      identity: {
        displayName: "Repin Worker",
        background: "Works only in the repin fixture.",
        responsibilities: ["Implement fixture work"]
      },
      scope: { kind: "project", projectId: projectInput.id, projectVersion: 1 }
    });
    await service.updateProject(projectInput.id, { ...projectInput, description: "Project v2." });

    const response = await fetch(`${base}/api/employees/repin-worker/repin-project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { id: "repin-worker", version: 2, scope: { projectVersion: 2 } }
    });
  });

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

  it("creates version-pinned Management Policies and Supervisor Workflows through HTTP", async () => {
    const { base, service } = await fixture();
    const createPolicy = await fetch(`${base}/api/management-policies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "desk-supervision",
        displayName: "Desk Supervision",
        description: "Coordinate one desk role.",
        allowedRoleIds: ["reviewer"],
        instructions: "Delegate when needed, then finish with evidence.",
        completion: { requireDelegation: false }
      })
    });
    expect(createPolicy.status).toBe(201);
    const policy = await createPolicy.json() as { data: { id: string; version: number } };
    expect(policy.data).toMatchObject({ id: "desk-supervision", version: 1 });

    const createWorkflow = await fetch(`${base}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "desk-supervisor",
        architecture: "supervisor",
        description: "A local supervisor team.",
        supervisor: { employeeId: "desk-agent" },
        managementPolicy: { id: "desk-supervision" },
        members: [{ roleId: "reviewer", employeeId: "desk-agent" }]
      })
    });
    expect(createWorkflow.status).toBe(201);
    const workflow = await createWorkflow.json() as { data: { architecture: string; managementPolicy: { version: number } } };
    expect(workflow.data).toMatchObject({ architecture: "supervisor", managementPolicy: { version: 1 } });
    const createEntrance = await fetch(`${base}/api/entrance-policies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "desk-team-entry",
        displayName: "Desk team entry",
        leader: { workflowId: "desk-supervisor" },
        default: { route: "leader" }
      })
    });
    expect(createEntrance.status).toBe(201);
    expect((await fetch(`${base}/api/workflows/desk-supervisor`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ architecture: "supervisor", description: "A local supervisor team v2." })
    })).status).toBe(200);
    const refreshedEntries = await fetch(`${base}/api/workflows/desk-supervisor/entrance-policies/refresh`, { method: "POST" });
    expect(refreshedEntries.status).toBe(200);
    expect(await refreshedEntries.json()).toMatchObject({
      data: {
        changed: true,
        workflowId: "desk-supervisor",
        workflowVersion: 2,
        changes: [{
          policyId: "desk-team-entry",
          fromPolicyVersion: 1,
          toPolicyVersion: 2,
          fromWorkflowVersion: 1,
          toWorkflowVersion: 2
        }]
      }
    });
    const missingMcpRoot = path.join(os.tmpdir(), `missing-mcp-project-${Date.now()}`);
    const rejectedExecutionRoot = await fetch(`${base}/api/workflows/desk-supervisor/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-multi-agent-source": "mcp",
        "x-multi-agent-mcp-root": missingMcpRoot
      },
      body: JSON.stringify({ message: "Do not start outside the caller project" })
    });
    expect(rejectedExecutionRoot.status).toBe(400);
    expect(await rejectedExecutionRoot.json()).toMatchObject({
      error: { message: expect.stringContaining("workflow execution root is unavailable") }
    });
    await service.updateManagementPolicy("desk-supervision", { instructions: "A newer policy version." });
    expect(service.getWorkflow("desk-supervisor")).toMatchObject({ managementPolicy: { version: 1 } });

    const start = await fetch(`${base}/api/workflows/desk-supervisor/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Coordinate the desk" })
    });
    expect(start.status).toBe(202);
    const receipt = await start.json() as {
      data: {
        invocation: { id: string };
        leaderSessionId: string;
        monitor: { initialCursor: string; waitUrl: string; maxTimeoutMs: number };
      };
    };
    expect(receipt.data.leaderSessionId).toBeTruthy();
    expect(receipt.data.monitor).toMatchObject({
      waitUrl: `/api/invocations/${receipt.data.invocation.id}/progress/wait`,
      maxTimeoutMs: 55_000
    });
    const completed = await service.waitForInvocation(receipt.data.invocation.id);
    expect(completed.invocation.status).toBe("completed");
    expect(completed.instances).toEqual([expect.objectContaining({ kind: "supervisor", nodeId: "supervisor-r1" })]);
    expect(completed.run).toMatchObject({
      architecture: "supervisor",
      status: "passed",
      output: { rounds: 1, delegations: 0 }
    });
    const waited = await fetch(
      `${base}${receipt.data.monitor.waitUrl}?cursor=${encodeURIComponent(receipt.data.monitor.initialCursor)}&timeoutMs=1000`
    ).then((response) => response.json()) as {
      data: { terminal: boolean; changed: boolean; leaderSessionId: string; progressReport: string };
    };
    expect(waited.data).toMatchObject({
      terminal: true,
      changed: true,
      leaderSessionId: receipt.data.leaderSessionId
    });
    expect(waited.data.progressReport).toContain("工作流已完成");
    const continued = await fetch(`${base}/api/workflow-conversations/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaderSessionId: receipt.data.leaderSessionId, message: "继续说明交付" })
    });
    expect(continued.status).toBe(200);
    expect(await continued.json()).toMatchObject({
      data: { session: { id: receipt.data.leaderSessionId, status: "active" } }
    });

    const bootstrap = await fetch(`${base}/api/bootstrap`).then((response) => response.json()) as {
      data: { managementPolicies: Array<{ id: string; version: number }>; workflows: Array<{ id: string; architecture: string }> };
    };
    expect(bootstrap.data.managementPolicies).toContainEqual(expect.objectContaining({ id: "desk-supervision", version: 2 }));
    expect(bootstrap.data.workflows).toContainEqual(expect.objectContaining({ id: "desk-supervisor", architecture: "supervisor" }));
    const rejectedArchive = await fetch(`${base}/api/management-policies/desk-supervision/archive`, { method: "POST" });
    expect(rejectedArchive.status).toBe(400);
    await fetch(`${base}/api/workflows/desk-supervisor/archive`, { method: "POST" });
    expect((await fetch(`${base}/api/management-policies/desk-supervision/archive`, { method: "POST" })).status).toBe(200);
    expect((await fetch(`${base}/api/management-policies/desk-supervision/restore`, { method: "POST" })).status).toBe(200);
  });

  it("exposes read-only system Skills and versioned Employee Template APIs in bootstrap", async () => {
    const { base } = await fixture();
    const createdTemplate = await fetch(`${base}/api/employee-templates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "desk-project-worker",
        displayName: "Desk project worker",
        description: "Project-scoped desk defaults.",
        defaults: {
          identity: { background: "Works in the desk project.", responsibilities: ["Handle project work"] },
          capabilities: ["code.backend"],
          scope: { kind: "project", projectId: "desk-project", projectVersion: 1 }
        }
      })
    });
    expect(createdTemplate.status).toBe(201);
    expect(await createdTemplate.json()).toMatchObject({
      data: { id: "desk-project-worker", version: 1, status: "active" }
    });

    const createdEmployee = await fetch(`${base}/api/employee-templates/desk-project-worker/employees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "desk-backend", identity: { displayName: "Desk Backend" } })
    });
    expect(createdEmployee.status).toBe(201);
    expect(await createdEmployee.json()).toMatchObject({
      data: {
        id: "desk-backend",
        capabilities: ["code.backend"],
        scope: { kind: "project", projectId: "desk-project", projectVersion: 1 },
        template: { id: "desk-project-worker", version: 1 }
      }
    });

    const detail = await fetch(`${base}/api/employee-templates/desk-project-worker`).then((response) => response.json()) as {
      data: { template: { id: string }; versions: Array<{ version: number }> };
    };
    expect(detail.data).toMatchObject({ template: { id: "desk-project-worker" }, versions: [{ version: 1 }] });

    const bootstrap = await fetch(`${base}/api/bootstrap`).then((response) => response.json()) as {
      data: {
        skills: Array<{ id: string; owner: string; injection: string }>;
        employees: Array<{ id: string; capabilities: string[]; scope: { kind: string }; template?: { id: string; version: number } }>;
        employeeTemplates: Array<{ id: string; version: number }>;
      };
    };
    expect(bootstrap.data.skills).toContainEqual(expect.objectContaining({
      id: "team-orchestration",
      owner: "system",
      injection: "supervisor"
    }));
    expect(bootstrap.data.employeeTemplates).toContainEqual(expect.objectContaining({ id: "desk-project-worker", version: 1 }));
    expect(bootstrap.data.employees).toContainEqual(expect.objectContaining({
      id: "desk-backend",
      capabilities: ["code.backend"],
      scope: expect.objectContaining({ kind: "project" }),
      template: { id: "desk-project-worker", version: 1 }
    }));

    expect((await fetch(`${base}/api/skills/team-orchestration`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Override system behavior." })
    })).status).toBe(400);
    expect((await fetch(`${base}/api/employees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "manual-system-skill-worker",
        identity: { displayName: "Manual", background: "Invalid.", responsibilities: ["Coordinate"] },
        skills: ["team-orchestration"]
      })
    })).status).toBe(400);
  });

  it("exposes deterministic Entrance Policy CRUD, evaluation, and dispatch through HTTP", async () => {
    const { base, service } = await fixture();
    const createdResponse = await fetch(`${base}/api/entrance-policies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "desk-entrance",
        displayName: "Desk Entrance",
        direct: { mode: "caller" },
        specialists: {
          reviewer: { kind: "project-role", projectId: "desk-project", roleId: "reviewer" }
        },
        rules: [{
          id: "structured-review",
          when: { tagsAnyOf: ["review"], signals: { risk: { gte: 5 } } },
          result: { route: "specialist", specialistKey: "reviewer" }
        }],
        default: { route: "direct" }
      })
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as {
      data: { id: string; version: number; specialists: { reviewer: { projectVersion: number; projectBindingVersion: number } } };
    };
    expect(created.data).toMatchObject({
      id: "desk-entrance",
      version: 1,
      specialists: { reviewer: { projectVersion: 1, projectBindingVersion: 1 } }
    });

    const before = service.getActivitySnapshot().invocations.length;
    const evaluated = await fetch(`${base}/api/entrance-policies/desk-entrance/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "auto", tags: ["review"], signals: { risk: 7 }, source: { kind: "http" } })
    });
    expect(evaluated.status).toBe(200);
    const decision = await evaluated.json() as {
      data: { decidedBy: string; target: { kind: string; projectVersion: number; projectBindingVersion: number } };
    };
    expect(decision.data).toMatchObject({
      decidedBy: "rule",
      target: { kind: "project-role", projectVersion: 1, projectBindingVersion: 1 }
    });
    expect(service.getActivitySnapshot().invocations).toHaveLength(before);

    const invalidEvaluation = await fetch(`${base}/api/entrance-policies/desk-entrance/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "auto", message: "review risk leader", source: { kind: "http" } })
    });
    expect(invalidEvaluation.status).toBe(400);
    expect(await invalidEvaluation.text()).toContain("unsupported fields: message");

    const returned = await fetch(`${base}/api/entrance-policies/desk-entrance/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "auto", message: "review risk leader" })
    });
    expect(returned.status).toBe(200);
    const returnedBody = await returned.json() as { data: { dispatch: { kind: string; invocationCreated: boolean } } };
    expect(returnedBody.data.dispatch).toEqual({ kind: "return-to-caller", invocationCreated: false });
    expect(service.getActivitySnapshot().invocations).toHaveLength(before);

    const dispatched = await fetch(`${base}/api/entrance-policies/desk-entrance/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-multi-agent-caller": "http-root" },
      body: JSON.stringify({ route: "specialist", specialistKey: "reviewer", message: "Review through the project role." })
    });
    expect(dispatched.status).toBe(200);
    const invocation = service.getActivitySnapshot().invocations[0];
    expect(invocation).toMatchObject({
      source: { kind: "http", caller: "http-root", project: "desk-project", projectRole: "reviewer" },
      executionSnapshot: {
        entrance: {
          policyId: "desk-entrance",
          policyVersion: 1,
          decidedBy: "explicit",
          target: { kind: "project-role", projectVersion: 1, projectBindingVersion: 1 }
        }
      }
    });

    const detail = await fetch(`${base}/api/entrance-policies/desk-entrance`).then((response) => response.json()) as {
      data: { policy: { id: string }; versions: Array<{ version: number }> };
    };
    expect(detail.data.policy.id).toBe("desk-entrance");
    expect(detail.data.versions.map((version) => version.version)).toEqual([1]);
    expect((await fetch(`${base}/api/entrance-policies/desk-entrance`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Updated through HTTP." })
    })).status).toBe(200);
    expect((await fetch(`${base}/api/entrance-policies/desk-entrance/archive`, { method: "POST" })).status).toBe(200);
    expect((await fetch(`${base}/api/entrance-policies/desk-entrance/restore`, { method: "POST" })).status).toBe(200);

    const health = await fetch(`${base}/api/health`).then((response) => response.json()) as {
      data: { capabilities: Record<string, unknown> };
    };
    expect(health.data.capabilities.entrancePolicies).toBe("versioned-routing-v1");
    const bootstrap = await fetch(`${base}/api/bootstrap`).then((response) => response.json()) as {
      data: { entrancePolicies: Array<{ id: string; version: number }> };
    };
    expect(bootstrap.data.entrancePolicies).toContainEqual(expect.objectContaining({ id: "desk-entrance", version: 4 }));
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

  it("serves governed URL import, Wiki, perspective, and grant-review endpoints", async () => {
    const fetched = fetchedKnowledgePage();
    const fetchUrl = vi.fn(async () => fetched);
    const { base, service } = await fixture({ knowledgeUrlFetcher: { fetch: fetchUrl } });
    await service.createKnowledgeBase({
      id: "governed-handbook",
      description: "Governed desk knowledge.",
      domain: "desk",
      collections: [{
        id: "reviews",
        displayName: "Reviews",
        description: "Traceable desk review evidence.",
        authority: "canonical",
        tags: ["desk", "review"]
      }],
      documents: [{
        id: "existing-review-guide",
        title: "Existing review guide",
        content: "Desk reviews preserve traceable evidence before approval.",
        collectionId: "reviews"
      }],
      publish: true
    });
    await service.createKnowledgeProfile({
      id: "governed-reviews",
      description: "Governed review knowledge.",
      rules: [{
        id: "review-core",
        selector: { knowledgeBaseIds: ["governed-handbook"], collectionIds: ["reviews"] },
        activation: "core",
        priority: 10,
        required: false,
        budget: { maxCollections: 1, maxChunks: 3, maxTokens: 1_200 }
      }]
    });
    await service.updateEmployee("desk-agent", {
      knowledgeProfileIds: ["governed-reviews"],
      knowledgeGrants: [{
        profileId: "governed-reviews",
        reason: "Desk Agent reviews governed evidence.",
        grantedBy: "desk-owner",
        grantedAt: "2025-10-01T00:00:00.000Z",
        expiresAt: "2026-02-01T00:00:00.000Z"
      }]
    });

    const health = await fetch(`${base}/api/health`).then((response) => response.json()) as {
      data: { capabilities: Record<string, unknown> };
    };
    expect(health.data.capabilities).toMatchObject({
      knowledgeUrlImport: "preview-propose-v1",
      knowledgeWiki: "derived-read-only-v1",
      knowledgePerspective: "run-evidence-v1",
      knowledgeGrantReview: "reminder-only-v1"
    });

    const wikiResponse = await fetch(`${base}/api/knowledge-bases/governed-handbook/wiki?revision=1`);
    expect(wikiResponse.status).toBe(200);
    const wiki = await wikiResponse.json() as {
      data: { revision: number; visibility: string; documents: Array<{ document: { id: string } }> };
    };
    expect(wiki.data).toMatchObject({ revision: 1, visibility: "published" });
    expect(wiki.data.documents.map((item) => item.document.id)).toEqual(["existing-review-guide"]);

    const perspectiveResponse = await fetch(`${base}/api/employees/desk-agent/knowledge-perspective`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Review desk evidence", evidenceLimit: 5 })
    });
    expect(perspectiveResponse.status).toBe(200);
    const perspective = await perspectiveResponse.json() as {
      data: {
        eligible: Array<{
          knowledgeBaseId: string;
          collection: { id: string };
          matches: Array<{ profileId: string; ruleId: string; reason: string }>;
        }>;
        activated: Array<{ collection: { id: string } }>;
      };
    };
    expect(perspective.data.eligible).toEqual([
      expect.objectContaining({
        knowledgeBaseId: "governed-handbook",
        collection: expect.objectContaining({ id: "reviews" }),
        matches: [expect.objectContaining({
          profileId: "governed-reviews",
          ruleId: "review-core",
          reason: expect.stringContaining("profile rule review-core")
        })]
      })
    ]);
    expect(perspective.data.activated.map((item) => item.collection.id)).toEqual(["reviews"]);

    const reviewsResponse = await fetch(`${base}/api/knowledge/reviews?asOf=2026-01-15T00%3A00%3A00.000Z&dueSoonDays=30`);
    expect(reviewsResponse.status).toBe(200);
    const reviews = await reviewsResponse.json() as {
      data: { policy: string; items: Array<{ status: string; reminderOnly: boolean; grant: { profileId: string } }> };
    };
    expect(reviews.data.policy).toBe("reminder-only-v1");
    expect(reviews.data.items).toContainEqual(expect.objectContaining({
      status: "due-soon",
      reminderOnly: true,
      grant: expect.objectContaining({ profileId: "governed-reviews" })
    }));

    const previewResponse = await fetch(`${base}/api/knowledge/url-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        knowledgeBaseId: "governed-handbook",
        collectionId: "reviews",
        url: fetched.requestedUrl
      })
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as {
      data: { previewHash: string; documents: Array<{ metadata?: { sourceKind?: string } }> };
    };
    expect(preview.data.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.data.documents).toContainEqual(expect.objectContaining({
      metadata: expect.objectContaining({ sourceKind: "url" })
    }));
    expect(service.getKnowledgeBase("governed-handbook")).toMatchObject({ latestRevision: 1, publishedRevision: 1 });

    const proposalResponse = await fetch(`${base}/api/knowledge/url-proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        knowledgeBaseId: "governed-handbook",
        collectionId: "reviews",
        url: fetched.requestedUrl,
        previewHash: preview.data.previewHash,
        title: "Import governed desk handbook",
        reason: "The frozen URL preview was reviewed."
      })
    });
    expect(proposalResponse.status).toBe(201);
    const proposal = await proposalResponse.json() as { data: { id: string; status: string } };
    expect(proposal.data.status).toBe("awaiting-approval");
    expect(fetchUrl).toHaveBeenCalledTimes(2);
    expect(service.getKnowledgeBase("governed-handbook")).toMatchObject({ latestRevision: 1, publishedRevision: 1 });

    const approvalResponse = await fetch(`${base}/api/knowledge-changes/${proposal.data.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comment: "Frozen import approved" })
    });
    expect(approvalResponse.status).toBe(200);
    expect(fetchUrl).toHaveBeenCalledTimes(2);
    expect(service.getKnowledgeBase("governed-handbook")).toMatchObject({ latestRevision: 2, publishedRevision: 1 });
    const draftWiki = await fetch(`${base}/api/knowledge-bases/governed-handbook/wiki?revision=2`)
      .then((response) => response.json()) as {
        data: { visibility: string; references: unknown[]; candidateRelations: Array<{ persisted: boolean }> };
      };
    expect(draftWiki.data.visibility).toBe("draft");
    expect(draftWiki.data.references).toEqual([]);
    expect(draftWiki.data.candidateRelations.every((candidate) => candidate.persisted === false)).toBe(true);
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

  it("accepts a workflow asynchronously and exposes status without holding the request open", async () => {
    const { base, service } = await fixture();
    const rejectedEmployeePackage = await fetch(`${base}/api/publications/desk-public/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Employee packages stay conversational" })
    });
    expect(rejectedEmployeePackage.status).toBe(400);
    expect(await rejectedEmployeePackage.json()).toMatchObject({
      error: { message: expect.stringContaining("use invoke_publication instead") }
    });
    await service.createWorkflow({
      id: "desk-flow",
      nodes: [{ id: "respond", employeeId: "desk-agent" }]
    });

    const response = await fetch(`${base}/api/workflows/desk-flow/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Run asynchronously" })
    });
    expect(response.status).toBe(202);
    const receipt = await response.json() as {
      data: {
        invocation: { id: string; runId: string };
        runId: string;
        leaderSessionId?: string;
        monitor: { waitUrl: string };
        statusUrl: string;
        streamUrl: string;
      };
    };
    expect(receipt.data.runId).toBe(receipt.data.invocation.runId);
    expect(receipt.data.statusUrl).toBe(`/api/invocations/${receipt.data.invocation.id}`);
    expect(receipt.data.leaderSessionId).toBeUndefined();
    expect(receipt.data.monitor.waitUrl).toBe(`/api/invocations/${receipt.data.invocation.id}/progress/wait`);
    expect(receipt.data.streamUrl).toBe("/api/activity/stream");

    await service.waitForInvocation(receipt.data.invocation.id);
    const detail = await fetch(`${base}${receipt.data.statusUrl}`).then((result) => result.json()) as {
      data: { invocation: { status: string }; instances: Array<{ status: string }>; run: { status: string } };
    };
    expect(detail.data.invocation.status).toBe("completed");
    expect(detail.data.instances[0]?.status).toBe("completed");
    expect(detail.data.run.status).toBe("passed");

    await service.createPublication({
      id: "desk-flow-package",
      name: "Desk Flow Package",
      description: "A stable asynchronous package for the desk flow.",
      target: { kind: "workflow", id: "desk-flow" }
    });
    const packagedResponse = await fetch(`${base}/api/publications/desk-flow-package/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-multi-agent-project": "outside-project" },
      body: JSON.stringify({ message: "Run the stable package asynchronously" })
    });
    expect(packagedResponse.status).toBe(202);
    const packaged = await packagedResponse.json() as {
      data: { invocation: { id: string; source: { publicationId?: string } }; runId: string; monitor: { waitUrl: string } };
    };
    expect(packaged.data.invocation.source.publicationId).toBe("desk-flow-package");
    expect(packaged.data.monitor.waitUrl).toBe(`/api/invocations/${packaged.data.invocation.id}/progress/wait`);

    const recovered = await fetch(`${base}/api/runs/${packaged.data.runId}/monitor`);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      data: {
        invocation: { id: packaged.data.invocation.id },
        runId: packaged.data.runId,
        monitor: {
          tool: "wait_workflow_progress",
          waitUrl: `/api/invocations/${packaged.data.invocation.id}/progress/wait`
        }
      }
    });
    await service.waitForInvocation(packaged.data.invocation.id);
  });

  it("exposes the shared daemon registry through MCP tools", async () => {
    const { base, service } = await fixture();
    await service.createWorkflow({
      id: "mcp-flow",
      nodes: [{ id: "respond", employeeId: "desk-agent" }]
    });
    await service.createPublication({
      id: "mcp-flow-package",
      name: "MCP Flow Package",
      description: "Stable asynchronous workflow package.",
      target: { kind: "workflow", id: "mcp-flow" }
    });
    await service.createEntrancePolicy({
      id: "mcp-entrance",
      direct: { mode: "employee", employeeId: "desk-agent" },
      default: { route: "direct" }
    });
    const mcpServer = createWorkbenchMcpServer(base);
    const client = new Client({ name: "workbench-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("invoke_employee");
      expect(tools.tools.map((tool) => tool.name)).toContain("invoke_publication");
      expect(tools.tools.map((tool) => tool.name)).toContain("start_publication");
      expect(tools.tools.map((tool) => tool.name)).toContain("resume_workflow_monitor");
      expect(tools.tools.map((tool) => tool.name)).toContain("invoke_project_role");
      expect(tools.tools.map((tool) => tool.name)).toContain("start_workflow");
      expect(tools.tools.map((tool) => tool.name)).toContain("get_invocation");
      expect(tools.tools.map((tool) => tool.name)).toContain("list_entrance_policies");
      expect(tools.tools.map((tool) => tool.name)).toContain("get_entrance_policy");
      expect(tools.tools.map((tool) => tool.name)).toContain("evaluate_entrance_policy");
      expect(tools.tools.map((tool) => tool.name)).toContain("dispatch_entrance_policy");
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
      const started = await client.callTool({
        name: "start_workflow",
        arguments: { workflowId: "mcp-flow", input: { message: "Start through MCP" } }
      });
      const startedText = (started.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}";
      const receipt = JSON.parse(startedText) as { invocation: { id: string } };
      await service.waitForInvocation(receipt.invocation.id);
      const status = await client.callTool({
        name: "get_invocation",
        arguments: { invocationId: receipt.invocation.id }
      });
      const statusText = (status.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
      expect(statusText).toContain('"status": "completed"');
      const packagedWorkflow = await client.callTool({
        name: "start_publication",
        arguments: { publicationId: "mcp-flow-package", input: { message: "Start package through MCP" } }
      });
      const packagedWorkflowText = (packagedWorkflow.content as Array<{ type: string; text?: string }>)
        .find((item) => item.type === "text")?.text ?? "{}";
      const packagedReceipt = JSON.parse(packagedWorkflowText) as { invocation: { id: string }; runId: string };
      await service.waitForInvocation(packagedReceipt.invocation.id);
      const resumed = await client.callTool({
        name: "resume_workflow_monitor",
        arguments: { runId: packagedReceipt.runId }
      });
      const resumedText = (resumed.content as Array<{ type: string; text?: string }>)
        .find((item) => item.type === "text")?.text ?? "{}";
      expect(JSON.parse(resumedText)).toMatchObject({
        invocation: { id: packagedReceipt.invocation.id },
        runId: packagedReceipt.runId,
        monitor: { tool: "wait_workflow_progress" }
      });
      const entranceList = await client.callTool({
        name: "list_entrance_policies",
        arguments: {}
      });
      expect((entranceList.content as Array<{ type: string; text?: string }>)[0]?.text).toContain("mcp-entrance");
      const entranceDetail = await client.callTool({
        name: "get_entrance_policy",
        arguments: { entrancePolicyId: "mcp-entrance" }
      });
      expect((entranceDetail.content as Array<{ type: string; text?: string }>)[0]?.text).toContain('"employeeVersion": 1');
      const entranceDecision = await client.callTool({
        name: "evaluate_entrance_policy",
        arguments: { entrancePolicyId: "mcp-entrance", route: "auto", tags: [], signals: {} }
      });
      expect((entranceDecision.content as Array<{ type: string; text?: string }>)[0]?.text).toContain('"decidedBy": "default"');
      const entranceDispatch = await client.callTool({
        name: "dispatch_entrance_policy",
        arguments: {
          entrancePolicyId: "mcp-entrance",
          route: "auto",
          message: "Dispatch through MCP Entrance Policy",
          source: { kind: "mcp", caller: "mcp-root", contextId: "entrance-context" }
        }
      });
      expect((entranceDispatch.content as Array<{ type: string; text?: string }>)[0]?.text).toContain('"kind": "employee"');
      const activity = await fetch(`${base}/api/activity`).then((response) => response.json()) as {
        data: {
          invocations: Array<{
            source: { kind: string; project?: string; projectRole?: string; publicationId?: string; caller?: string };
            executionSnapshot?: { entrance?: { policyId: string; target: { employeeVersion?: number } } };
          }>;
        };
      };
      expect(activity.data.invocations.find((invocation) => invocation.source.projectRole === "reviewer")?.source)
        .toMatchObject({ kind: "mcp", project: "desk-project", projectRole: "reviewer" });
      expect(activity.data.invocations.find((invocation) => invocation.source.caller === "mcp-root"))
        .toMatchObject({
          source: { kind: "mcp", caller: "mcp-root" },
          executionSnapshot: { entrance: { policyId: "mcp-entrance", target: { employeeVersion: 1 } } }
        });
      const passiveAccesses = await fetch(`${base}/api/project-accesses`).then((response) => response.json()) as {
        data: Array<{
          rootPath?: string;
          projectKeys: string[];
          displayName: string;
          transport: string;
          requestCount: number;
          firstSeenAt: string;
          lastSeenAt: string;
          linkedProjectId?: string;
        }>;
      };
      expect(passiveAccesses.data).toContainEqual(expect.objectContaining({
        rootPath: process.cwd(),
        projectKeys: ["desk-project", "mcp-project"],
        displayName: path.basename(process.cwd()),
        transport: "mcp",
        requestCount: expect.any(Number),
        linkedProjectId: "desk-project"
      }));
      expect(passiveAccesses.data).toHaveLength(1);
      const recorded = passiveAccesses.data.find((access) => access.rootPath === process.cwd());
      expect(recorded?.requestCount).toBeGreaterThanOrEqual(1);
      expect(recorded?.firstSeenAt).toBeTruthy();
      expect(recorded?.lastSeenAt).toBeTruthy();
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

  it("exposes a proposal-only Configuration Control MCP profile while review and apply remain human-owned", async () => {
    const { base, service } = await fixture();
    const controlTools = [
      "configuration_control_snapshot",
      "configuration_proposal_list",
      "configuration_proposal_get",
      "configuration_proposal_create"
    ];
    await service.createProject({
      id: "configuration-project",
      rootPath: service.store.dataRoot,
      descriptorPath: path.join(service.store.dataRoot, "configuration.project.yaml"),
      roles: [{
        id: "configuration-steward",
        displayName: "Configuration Steward",
        description: "Draft Employee configuration proposals.",
        instructions: "Use restricted tools.",
        permissions: { write: "none", tools: controlTools }
      }]
    });
    const steward = await service.createEmployee({
      id: "configuration-steward",
      identity: {
        displayName: "Configuration Steward",
        background: "Project-internal control agent.",
        responsibilities: ["Draft proposals"],
        metadata: { internalProjectId: "configuration-project", internalProjectRoleId: "configuration-steward" }
      },
      scope: { kind: "project", projectId: "configuration-project", projectVersion: 1 },
      providerId: "codex-configuration-control",
      permissions: { write: "none", tools: controlTools }
    });
    await service.saveProjectBinding("configuration-project", {
      roles: [{ roleId: "configuration-steward", employeeId: steward.id }]
    });
    const sourceRunId = "run-configuration-mcp";
    const sourceSessionId = "session-configuration-mcp";
    const timestamp = "2026-08-04T00:00:00.000Z";
    await service.store.mutate((state) => {
      state.sessions[sourceSessionId] = {
        id: sourceSessionId,
        employeeId: steward.id,
        employeeVersion: steward.version,
        assignment: {
          projectId: "configuration-project",
          projectVersion: 1,
          projectBindingVersion: 1,
          roleId: "configuration-steward"
        },
        title: "Configure desk-agent",
        status: "active",
        context: { kind: "employee-configuration", employeeId: "desk-agent", expectedEmployeeVersion: 1 },
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.invocations["inv-configuration-mcp"] = {
        id: "inv-configuration-mcp",
        target: { kind: "employee", id: steward.id, version: steward.version },
        source: {
          kind: "workbench",
          project: "configuration-project",
          projectRole: "configuration-steward",
          projectBindingVersion: 1
        },
        status: "running",
        phase: "provider",
        requestSummary: "Configure desk-agent",
        requestContext: { kind: "employee-configuration", employeeId: "desk-agent", expectedEmployeeVersion: 1 },
        runId: sourceRunId,
        sessionId: sourceSessionId,
        instanceIds: [],
        createdAt: timestamp,
        startedAt: timestamp,
        updatedAt: timestamp,
        transitions: [{ at: timestamp, status: "running", phase: "provider" }]
      };
    });
    const mcpServer = createWorkbenchMcpServer(base, { profile: "configuration-control", sourceRunId });
    const client = new Client({ name: "configuration-steward-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual([
        "configuration_control_snapshot",
        "configuration_proposal_list",
        "configuration_proposal_get",
        "configuration_proposal_create"
      ]);
      expect(names).not.toEqual(expect.arrayContaining([
        "configuration_proposal_review",
        "configuration_proposal_apply",
        "update_employee",
        "invoke_employee"
      ]));

      const snapshot = await client.callTool({
        name: "configuration_control_snapshot",
        arguments: {}
      });
      const snapshotText = (snapshot.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(snapshotText).toContain('"id": "desk-agent"');
      expect(snapshotText).not.toContain("knowledgeProfileIds");
      expect(snapshotText).not.toContain('"command"');
      expect(snapshotText).not.toContain('"args"');
      expect(snapshotText).not.toContain('"env"');
      expect(snapshotText).not.toContain('"instructions"');

      const invalid = await client.callTool({
        name: "configuration_proposal_create",
        arguments: {
          title: "Invalid arbitrary patch",
          reason: "The MCP schema must reject paths.",
          operations: [{
            type: "prompts.set",
            rationale: "Invalid path field.",
            risk: "medium",
            path: "/systemPrompt",
            payload: { systemPrompt: "New system.", requestPrompt: "New request." }
          }]
        }
      });
      expect(invalid.isError).toBe(true);
      expect(service.listConfigurationProposals()).toHaveLength(0);

      const proposed = await client.callTool({
        name: "configuration_proposal_create",
        arguments: {
          title: "Clarify Desk prompts",
          reason: "Preserve evidence in each response.",
          operations: [{
            type: "prompts.set",
            rationale: "Make evidence requirements explicit.",
            risk: "medium",
            payload: { systemPrompt: "Preserve evidence.", requestPrompt: "Return the scoped result." }
          }]
        }
      });
      const text = (proposed.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
      const proposal = JSON.parse(text) as {
        id: string;
        status: string;
        reviewItems: Array<{ id: string }>;
        reviewRevision: number;
        reviewHash: string;
      };
      expect(proposal.status).toBe("awaiting-review");
      expect(service.getEmployee("desk-agent")).toMatchObject({ version: 1 });
      expect(service.getEmployee("desk-agent").systemPrompt).not.toBe("Preserve evidence.");

      await service.store.mutate((state) => {
        const invocation = state.invocations["inv-configuration-mcp"]!;
        invocation.status = "completed";
        invocation.phase = "done";
        invocation.completedAt = timestamp;
        invocation.updatedAt = timestamp;
        invocation.transitions.push({ at: timestamp, status: "completed", phase: "done" });
        state.sessions[sourceSessionId]!.messages.push({
          id: "configuration-proposal-attestation",
          role: "employee",
          content: `Created ${proposal.id}`,
          at: timestamp,
          runId: sourceRunId,
          output: { message: "Proposal created.", proposalIds: [proposal.id] }
        });
      });

      const reviewed = await fetch(`${base}/api/configuration-proposals/${proposal.id}/review-items/${proposal.reviewItems[0]!.id}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "accepted",
          expectedReviewRevision: proposal.reviewRevision,
          expectedReviewHash: proposal.reviewHash
        })
      });
      expect(reviewed.status).toBe(200);
      const reviewedEnvelope = await reviewed.json() as { data: { reviewRevision: number; reviewHash: string } };
      const reviewedProposal = reviewedEnvelope.data;
      expect(service.getEmployee("desk-agent").version).toBe(1);

      const applied = await fetch(`${base}/api/configuration-proposals/${proposal.id}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedReviewRevision: reviewedProposal.reviewRevision,
          expectedReviewHash: reviewedProposal.reviewHash
        })
      });
      expect(applied.status).toBe(200);
      expect(service.getEmployee("desk-agent")).toMatchObject({ version: 2, systemPrompt: "Preserve evidence." });
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });
});
