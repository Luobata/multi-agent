import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Express, NextFunction, Request, Response } from "express";
import { createDaemonApp } from "../src/daemon/server.js";
import type { JsonValue } from "../src/core/types.js";
import type { ProviderRegistry } from "../src/runtime/providers.js";
import { createWorkbenchMcpServer } from "../src/mcp/server.js";
import { WorkbenchService } from "../src/workbench/service.js";
import type { HumanDecisionRequest } from "../src/workbench/types.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-human-decision-"));
  temporaryDirectories.push(root);
  return root;
}

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (request: Request, response: Response, next: NextFunction) => void }>;
  };
}

async function invokeRoute(
  app: Express,
  method: "get" | "post",
  routePath: string,
  input: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; json?: unknown }> {
  const layers = (app as unknown as { router: { stack: RouteLayer[] } }).router.stack;
  const route = layers.find((candidate) => candidate.route?.path === routePath && candidate.route.methods[method])?.route;
  if (!route) throw new Error(`route not registered: ${method.toUpperCase()} ${routePath}`);
  return new Promise((resolve) => {
    const result: { status: number; json?: unknown } = { status: 200 };
    const response = {
      status(code: number) {
        result.status = code;
        return response;
      },
      json(value: unknown) {
        result.json = value;
        resolve(result);
        return response;
      }
    } as unknown as Response;
    const request = {
      params: input.params ?? {},
      query: input.query ?? {},
      body: input.body,
      headers: {}
    } as unknown as Request;
    route.stack[0]!.handle(request, response, (error?: unknown) => {
      if (!error) return;
      const message = error instanceof Error ? error.message : String(error);
      resolve({ status: /not found/.test(message) ? 404 : 400, json: { error: { message } } });
    });
  });
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function waitForPendingDecision(service: WorkbenchService, invocationId: string): Promise<HumanDecisionRequest> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pending = service.listHumanDecisionRequests({ invocationId, status: "pending" })[0];
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for human decision on ${invocationId}`);
}

async function createFixture(mode: "approve" | "reject", dataRoot = temporaryRoot()) {
  let workerCalls = 0;
  let rejectedHistory: JsonValue[] | undefined;
  const providers: ProviderRegistry = new Map([["human-decision-test", {
    id: "human-decision-test",
    validate: () => [],
    invoke: async (invocation) => {
      const role = invocation.templateContext.role as { id: string };
      const node = invocation.templateContext.node as {
        with?: { __supervisorRound?: number; __supervisorHistory?: JsonValue[] };
      };
      const round = Number(node.with?.__supervisorRound ?? 0);
      if (role.id === "supervisor") {
        if (round === 1) {
          return {
            stdout: JSON.stringify({
              action: "request-human-decision",
              riskCategory: "dependency-install",
              summary: "Install a new native dependency before implementation.",
              assignments: [{ roleId: "builder", task: "Install and use native-addon", workKind: "code" }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        rejectedHistory = node.with?.__supervisorHistory;
        return {
          stdout: JSON.stringify({
            action: "finish",
            summary: mode === "reject" ? "Replanned without the rejected dependency." : "Approved work completed.",
            result: { delivered: true }
          }),
          stderr: "",
          durationMs: 1
        };
      }
      workerCalls += 1;
      return {
        stdout: JSON.stringify({ message: "Installed and implemented after approval." }),
        stderr: "",
        durationMs: 1
      };
    }
  }]]);
  const service = await WorkbenchService.open({ dataRoot, providers });
  await service.putProvider("human-decision-provider", {
    adapter: "human-decision-test",
    outputProtocol: "json"
  });
  await service.createEmployee({
    id: "risk-lead",
    identity: { displayName: "Risk Lead", background: "Plans risky work.", responsibilities: ["Plan"] },
    providerId: "human-decision-provider"
  });
  await service.createEmployee({
    id: "risk-builder",
    identity: { displayName: "Risk Builder", background: "Implements approved work.", responsibilities: ["Build"] },
    providerId: "human-decision-provider"
  });
  await service.createManagementPolicy({
    id: "risk-policy",
    allowedRoleIds: ["builder"],
    instructions: "Request a human decision before high-risk delegation.",
    limits: { maxRounds: 4, maxDelegations: 4, maxParallelDelegations: 1 }
  });
  await service.createWorkflow({
    id: "risk-supervisor",
    architecture: "supervisor",
    supervisor: { employeeId: "risk-lead" },
    managementPolicy: { id: "risk-policy" },
    members: [{ roleId: "builder", employeeId: "risk-builder" }]
  });
  return {
    dataRoot,
    providers,
    service,
    workerCalls: () => workerCalls,
    rejectedHistory: () => rejectedHistory
  };
}

describe("Supervisor high-risk human decision gate", () => {
  it("registers read and decide tools on the full MCP control plane", async () => {
    const server = createWorkbenchMcpServer("http://127.0.0.1:1");
    const client = new Client({ name: "human-decision-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toEqual(expect.arrayContaining([
        "list_human_decision_requests",
        "get_human_decision_request",
        "decide_human_decision_request"
      ]));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("persists an idempotent pinned request, schedules nothing while pending, and resumes the same invocation after HTTP approval", async () => {
    const fixture = await createFixture("approve");
    const app = createDaemonApp(fixture.service, { staticDir: path.join(fixture.dataRoot, "missing-client") });
    const receipt = await fixture.service.startWorkbenchWorkflow("risk-supervisor", { message: "Implement risky change" });
    const pending = await waitForPendingDecision(fixture.service, receipt.invocation.id);
    const awaiting = await fixture.service.getInvocationDetail(receipt.invocation.id);

    expect(awaiting.invocation).toMatchObject({
      id: receipt.invocation.id,
      runId: receipt.runId,
      status: "awaiting-human-decision",
      phase: "awaiting-human-decision"
    });
    expect(awaiting.instances.map((instance) => instance.kind)).toEqual(["supervisor"]);
    expect(fixture.workerCalls()).toBe(0);
    expect(pending).toMatchObject({
      invocationId: receipt.invocation.id,
      runId: receipt.runId,
      workflowId: "risk-supervisor",
      workflowVersion: 1,
      supervisorNodeId: "supervisor-r1",
      round: 1,
      riskCategory: "dependency-install",
      status: "pending"
    });

    const duplicate = await fixture.service.createHumanDecisionRequest({
      invocationId: pending.invocationId,
      runId: pending.runId,
      workflowId: pending.workflowId,
      workflowVersion: pending.workflowVersion,
      supervisorNodeId: pending.supervisorNodeId,
      round: pending.round,
      riskCategory: pending.riskCategory,
      summary: pending.summary,
      proposedAction: pending.proposedAction
    });
    expect(duplicate.id).toBe(pending.id);

    const listed = await invokeRoute(app, "get", "/api/human-decision-requests", {
      query: { invocationId: receipt.invocation.id, status: "pending" }
    });
    expect(listed).toMatchObject({ status: 200, json: { data: [{ id: pending.id }] } });
    const read = await invokeRoute(app, "get", "/api/human-decision-requests/:id", {
      params: { id: pending.id }
    });
    expect(read).toMatchObject({ status: 200, json: { data: { idempotencyKey: pending.idempotencyKey } } });
    expect(await invokeRoute(app, "get", "/api/human-decision-requests", { query: { status: "unknown" } }))
      .toMatchObject({ status: 400, json: { error: { message: expect.stringContaining("unsupported") } } });

    const approvedResponse = await invokeRoute(app, "post", "/api/human-decision-requests/:id/decide", {
      params: { id: pending.id },
      body: {
        decision: "approve",
        decidedBy: "test-owner",
        comment: "Approved for this pinned round."
      }
    });
    expect(approvedResponse).toMatchObject({
      status: 200,
      json: { data: { status: "approved", decidedBy: "test-owner", comment: "Approved for this pinned round." } }
    });

    const repeated = await invokeRoute(app, "post", "/api/human-decision-requests/:id/decide", {
      params: { id: pending.id },
      body: { decision: "approve" }
    });
    expect(repeated).toMatchObject({
      status: 400,
      json: { error: { message: expect.stringContaining("already decided") } }
    });

    const completed = await fixture.service.waitForInvocation(receipt.invocation.id);
    expect(completed.invocation).toMatchObject({ id: receipt.invocation.id, status: "completed" });
    expect(fixture.workerCalls()).toBe(1);
    expect(fixture.service.getActivitySnapshot().invocations.filter((item) => item.target.id === "risk-supervisor")).toHaveLength(1);

    const eventTypes = fs.readFileSync(
      path.join(fixture.dataRoot, "artifacts", "runs", receipt.runId, "events.jsonl"),
      "utf8"
    ).trim().split("\n").map((line) => (JSON.parse(line) as { type: string }).type);
    expect(eventTypes).toContain("human-decision.requested");
    expect(eventTypes).toContain("human-decision.approved");
  }, 10_000);

  it("returns rejection feedback to the next round of the same Supervisor loop without dispatching the rejected action", async () => {
    const fixture = await createFixture("reject");
    const receipt = await fixture.service.startWorkbenchWorkflow("risk-supervisor", { message: "Avoid unsafe dependencies" });
    const pending = await waitForPendingDecision(fixture.service, receipt.invocation.id);

    const progress = await fixture.service.getInvocationProgress(receipt.invocation.id);
    expect(progress).toMatchObject({
      status: "awaiting-human-decision",
      terminal: false,
      humanDecision: { id: pending.id, status: "pending", riskCategory: "dependency-install" }
    });
    expect(progress.leaderReport.delegations).toBe(0);
    expect(fixture.workerCalls()).toBe(0);

    await fixture.service.decideHumanDecisionRequest(pending.id, {
      decision: "reject",
      decidedBy: "test-owner",
      comment: "Use the existing standard library instead."
    });
    const completed = await fixture.service.waitForInvocation(receipt.invocation.id);

    expect(completed.invocation).toMatchObject({ id: receipt.invocation.id, status: "completed" });
    expect(fixture.workerCalls()).toBe(0);
    expect(JSON.stringify(fixture.rejectedHistory())).toContain("Use the existing standard library instead.");
    expect(fixture.service.getHumanDecisionRequest(pending.id)).toMatchObject({ status: "rejected" });
    expect(completed.run).toMatchObject({ output: { delegations: 0, rounds: 2 } });
  }, 10_000);

  it("voids pending requests when restart recovery interrupts their non-terminal invocation", async () => {
    const dataRoot = temporaryRoot();
    const fixture = await createFixture("approve", dataRoot);
    const receipt = await fixture.service.startWorkbenchWorkflow("risk-supervisor", { message: "Will be interrupted" });
    const pending = await waitForPendingDecision(fixture.service, receipt.invocation.id);

    const reopened = await WorkbenchService.open({ dataRoot, providers: fixture.providers });
    await reopened.recoverInterruptedActivity();

    expect((await reopened.getInvocationDetail(receipt.invocation.id)).invocation).toMatchObject({
      status: "failed",
      phase: "interrupted"
    });
    expect(reopened.getHumanDecisionRequest(pending.id)).toMatchObject({
      status: "voided",
      decidedBy: "runtime-recovery",
      comment: expect.stringContaining("restarted")
    });
    await expect(reopened.decideHumanDecisionRequest(pending.id, {
      decision: "approve",
      decidedBy: "late-owner"
    })).rejects.toThrow(/already decided as voided/);
  }, 10_000);
});
