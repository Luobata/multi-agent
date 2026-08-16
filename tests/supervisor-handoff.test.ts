import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../src/core/types.js";
import type { ProviderRegistry } from "../src/runtime/providers.js";
import { WorkbenchService } from "../src/workbench/service.js";
import type { HumanDecisionRequest } from "../src/workbench/types.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-supervisor-handoff-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const HANDOFF_MARKER = "HANDOFF-MARKER: touched src/feature.ts; kept the legacy adapter; unexplored retry path";

function writeHandoffFile(cwd: string, sessionKey: string, content: string): void {
  const sanitized = sessionKey.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const dir = path.join(cwd, ".multi-agent", "handoff");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sanitized}.md`), content, "utf8");
}

interface MemberCall {
  todoId: string;
  handoffPath: string;
  handoff: string;
  prompt: string;
}

function captureMemberCall(invocation: {
  cwd: string;
  prompt: string;
  templateContext: Record<string, unknown>;
}): MemberCall {
  const node = invocation.templateContext.node as { with?: Record<string, unknown> };
  const withValue = node.with ?? {};
  return {
    todoId: String(withValue.__todoId ?? ""),
    handoffPath: String(withValue.__memberSessionHandoffPath ?? ""),
    handoff: String(withValue.__memberSessionHandoff ?? ""),
    prompt: invocation.prompt
  };
}

function providerResponse(value: JsonValue): { stdout: string; stderr: string; durationMs: number } {
  return { stdout: JSON.stringify(value), stderr: "", durationMs: 1 };
}

function planTodosResponse(sessionKey: string): { stdout: string; stderr: string; durationMs: number } {
  return providerResponse({
    action: "plan-todos",
    summary: "Split the work into two serial milestones for one member.",
    impact: {
      level: "low",
      regressionScope: "targeted",
      affectedAreas: ["src/feature.ts"],
      reasons: ["The change is isolated to one local feature."],
      requiredChecks: ["feature behavior"]
    },
    todos: [
      {
        id: "todo-1",
        roleId: "builder",
        task: "Implement the feature.",
        needs: [],
        workKind: "code",
        changeSet: "feature",
        sessionKey
      },
      {
        id: "todo-2",
        roleId: "builder",
        task: "Wire the feature into the caller.",
        needs: ["todo-1"],
        workKind: "code",
        changeSet: "feature",
        sessionKey
      }
    ]
  });
}

function delegateResponse(todoId: string): { stdout: string; stderr: string; durationMs: number } {
  return providerResponse({
    action: "delegate",
    summary: `Delegate ${todoId}.`,
    assignments: [{ todoId, roleId: "builder" }]
  });
}

function finishResponse(): { stdout: string; stderr: string; durationMs: number } {
  return providerResponse({ action: "finish", summary: "Done.", result: { delivered: true } });
}

function supervisorRound(invocation: { templateContext: Record<string, unknown> }): number {
  const node = invocation.templateContext.node as { with?: { __supervisorRound?: number } };
  return Number(node.with?.__supervisorRound ?? 0);
}

async function createTeam(service: WorkbenchService, providerId: string): Promise<void> {
  await service.createEmployee({
    id: "handoff-lead",
    identity: { displayName: "Lead", background: "Coordinates work.", responsibilities: ["Plan", "Deliver"] },
    capabilities: ["quality.audit"],
    providerId
  });
  await service.createEmployee({
    id: "handoff-builder",
    identity: { displayName: "Builder", background: "Builds code.", responsibilities: ["Implement"] },
    capabilities: ["code.backend"],
    providerId
  });
  await service.createManagementPolicy({
    id: "handoff-policy",
    allowedRoleIds: ["builder"],
    instructions: "Delegate explicit work and deliver only after required Gates pass.",
    limits: { maxRounds: 6, maxDelegations: 8, maxParallelDelegations: 2, maxDurationMs: 60_000 }
  });
}

async function createWorkflow(service: WorkbenchService): Promise<void> {
  await service.createWorkflow({
    id: "handoff-supervision",
    architecture: "supervisor",
    supervisor: { employeeId: "handoff-lead" },
    managementPolicy: { id: "handoff-policy" },
    members: [{ roleId: "builder", employeeId: "handoff-builder" }]
  });
}

async function waitForPendingDecision(service: WorkbenchService, invocationId: string): Promise<HumanDecisionRequest> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pending = service.listHumanDecisionRequests({ invocationId, status: "pending" })[0];
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for human decision on ${invocationId}`);
}

describe("Supervisor member session handoff", () => {
  it("carries a prior handoff into the second delegation of the same member session", async () => {
    const memberCalls: MemberCall[] = [];
    const providers: ProviderRegistry = new Map([["handoff-flow", {
      id: "handoff-flow",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        if (role === "supervisor") {
          const round = supervisorRound(invocation);
          if (round === 1) return planTodosResponse("handoff-builder");
          if (round === 2) return delegateResponse("todo-1");
          if (round === 3) return delegateResponse("todo-2");
          return finishResponse();
        }
        const call = captureMemberCall(invocation);
        memberCalls.push(call);
        if (call.todoId === "todo-1") writeHandoffFile(invocation.cwd, "handoff-builder", HANDOFF_MARKER);
        return providerResponse({ message: `${call.todoId} completed.` });
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("handoff-provider", { adapter: "handoff-flow", outputProtocol: "json" });
    await createTeam(service, "handoff-provider");
    await createWorkflow(service);
    const providerCwd = temporaryRoot();
    fs.writeFileSync(path.join(providerCwd, "package.json"), JSON.stringify({ scripts: {} }));

    const result = await service.runWorkbenchWorkflow(
      "handoff-supervision",
      { message: "Build the feature." },
      { kind: "workbench" },
      { providerCwd }
    );

    expect(result.run.status, JSON.stringify(result.run.output)).toBe("passed");
    expect(memberCalls).toHaveLength(2);
    // First delegation: empty handoff, absolute path ending in <key>.md.
    expect(memberCalls[0]!.handoff).toBe("");
    expect(path.isAbsolute(memberCalls[0]!.handoffPath)).toBe(true);
    expect(memberCalls[0]!.handoffPath.endsWith("handoff-builder.md")).toBe(true);
    // Second delegation: same path, carries the prior handoff content.
    expect(memberCalls[1]!.handoffPath).toBe(memberCalls[0]!.handoffPath);
    expect(memberCalls[1]!.handoff).toContain(HANDOFF_MARKER);
  });

  it("renders the handoff section with empty values on the first delegation", async () => {
    const memberCalls: MemberCall[] = [];
    const providers: ProviderRegistry = new Map([["handoff-render-flow", {
      id: "handoff-render-flow",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        if (role === "supervisor") {
          const round = supervisorRound(invocation);
          if (round === 1) return planTodosResponse("handoff-render");
          if (round === 2) return delegateResponse("todo-1");
          if (round === 3) return delegateResponse("todo-2");
          return finishResponse();
        }
        const call = captureMemberCall(invocation);
        memberCalls.push(call);
        if (call.todoId === "todo-1") writeHandoffFile(invocation.cwd, "handoff-render", HANDOFF_MARKER);
        return providerResponse({ message: `${call.todoId} completed.` });
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("handoff-render-provider", { adapter: "handoff-render-flow", outputProtocol: "json" });
    await createTeam(service, "handoff-render-provider");
    await createWorkflow(service);

    const result = await service.runWorkbenchWorkflow("handoff-supervision", { message: "Build." }, { kind: "workbench" });
    expect(result.run.status, JSON.stringify(result.run.output)).toBe("passed");
    expect(memberCalls.length).toBeGreaterThanOrEqual(1);

    const prompt = memberCalls[0]!.prompt;
    expect(prompt).toContain("Member handoff");
    expect(prompt).toContain("write your updated handoff back to the same absolute path");
    const handoffSection = prompt.slice(prompt.indexOf("Member handoff"), prompt.indexOf("Required capabilities"));
    expect(handoffSection).not.toContain("null");
    expect(handoffSection).not.toContain("undefined");
  });

  it("keeps handoff notes across a restart recovery", async () => {
    const memberCalls: MemberCall[] = [];
    const providers: ProviderRegistry = new Map([["handoff-resume-flow", {
      id: "handoff-resume-flow",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        if (role === "supervisor") {
          const round = supervisorRound(invocation);
          if (round === 1) return planTodosResponse("handoff-resume");
          if (round === 2) return delegateResponse("todo-1");
          if (round === 3) {
            return providerResponse({
              action: "request-human-decision",
              riskCategory: "scope-expansion",
              summary: "Approve the second milestone before it starts.",
              assignments: [{ todoId: "todo-2", roleId: "builder", workKind: "code" }]
            });
          }
          return finishResponse();
        }
        const call = captureMemberCall(invocation);
        memberCalls.push(call);
        if (call.todoId === "todo-1") writeHandoffFile(invocation.cwd, "handoff-resume", HANDOFF_MARKER);
        return providerResponse({ message: `${call.todoId} completed.` });
      }
    }]]);
    const dataRoot = temporaryRoot();
    const projectRoot = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot, providers });
    await service.putProvider("handoff-resume-provider", { adapter: "handoff-resume-flow", outputProtocol: "json" });
    await createTeam(service, "handoff-resume-provider");
    await createWorkflow(service);
    await service.createProject({
      id: "handoff-project",
      name: "Handoff Project",
      rootPath: projectRoot,
      descriptorPath: path.join(projectRoot, "multi-agent.project.yaml"),
      roles: [
        { id: "lead", displayName: "Lead", description: "Leads.", instructions: "Lead." },
        { id: "builder", displayName: "Builder", description: "Builds.", instructions: "Build." }
      ]
    });
    await service.saveProjectBinding("handoff-project", {
      roles: [
        { roleId: "lead", employeeId: "handoff-lead" },
        { roleId: "builder", employeeId: "handoff-builder" }
      ]
    });
    await service.createWorkflow({
      id: "handoff-resume-supervision",
      architecture: "supervisor",
      supervisor: { employeeId: "handoff-lead", projectRoleId: "lead" },
      managementPolicy: { id: "handoff-policy" },
      members: [{ roleId: "builder", employeeId: "handoff-builder", projectRoleId: "builder" }]
    });

    const receipt = await service.startWorkbenchWorkflow(
      "handoff-resume-supervision",
      { message: "Build the feature." },
      { kind: "workbench", project: "handoff-project" }
    );
    const pending = await waitForPendingDecision(service, receipt.invocation.id);

    // Simulate a daemon restart: reopen the same data root and recover interrupted activity.
    const reopened = await WorkbenchService.open({ dataRoot, providers });
    await reopened.recoverInterruptedActivity();
    await waitForPendingDecision(reopened, receipt.invocation.id);
    await reopened.decideHumanDecisionRequest(pending.id, { decision: "approve", decidedBy: "restart-owner" });
    const completed = await reopened.waitForInvocation(receipt.invocation.id);

    expect(completed.invocation.status).toBe("completed");
    const completedRun = completed.run as { status: string; output?: unknown };
    expect(completedRun.status, JSON.stringify(completedRun.output)).toBe("passed");
    const todo2Call = memberCalls.find((call) => call.todoId === "todo-2");
    expect(todo2Call).toBeDefined();
    // todo-2 ran after the restart; its handoff came from the restored member session, not a fresh file write.
    expect(todo2Call!.handoff).toContain(HANDOFF_MARKER);
    expect(path.isAbsolute(todo2Call!.handoffPath)).toBe(true);
  }, 15_000);

  it("feeds a prior shard's handoff into the next Gate shard", async () => {
    const shardCalls: Array<{ index: number; handoffPath: string; handoff: string }> = [];
    const requiredChecks = ["client unit tests", "server unit tests", "client production build", "server typecheck"];
    const providers: ProviderRegistry = new Map([["handoff-gate-flow", {
      id: "handoff-gate-flow",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        const node = invocation.templateContext.node as {
          with?: Record<string, unknown>;
          metadata?: { kind?: string; gateShardIndex?: number; memberSessionKey?: string };
        };
        if (node.metadata?.kind === "gate") {
          const index = node.metadata.gateShardIndex ?? 0;
          const sessionKey = String(node.metadata.memberSessionKey ?? "");
          shardCalls.push({
            index,
            handoffPath: String(node.with?.__memberSessionHandoffPath ?? ""),
            handoff: String(node.with?.__memberSessionHandoff ?? "")
          });
          if (index === 1) writeHandoffFile(invocation.cwd, sessionKey, HANDOFF_MARKER);
          return providerResponse({
            message: "The assigned bounded checks passed.",
            e2eEvidence: [{ method: "automation-run", steps: "run only the assigned checks", observed: "all assigned checks passed" }]
          });
        }
        if (role === "supervisor") {
          const round = supervisorRound(invocation);
          if (round === 1) {
            return providerResponse({
              action: "plan-todos",
              summary: "Plan one implementation with a package regression.",
              impact: {
                level: "high",
                regressionScope: "package",
                affectedAreas: ["client", "server"],
                reasons: ["The change crosses two surfaces."],
                requiredChecks
              },
              todos: [
                {
                  id: "inspect",
                  roleId: "builder",
                  task: "Inspect the affected surfaces.",
                  needs: [],
                  workKind: "discussion"
                },
                {
                  id: "implement",
                  roleId: "builder",
                  task: "Implement the bounded cross-surface change.",
                  needs: ["inspect"],
                  workKind: "code",
                  changeSet: "cross-surface"
                }
              ]
            });
          }
          if (round === 2) return delegateResponse("inspect");
          if (round === 3) return delegateResponse("implement");
          return finishResponse();
        }
        return providerResponse({ message: "Implementation complete." });
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("handoff-gate-provider", { adapter: "handoff-gate-flow", outputProtocol: "json" });
    await service.createEmployee({
      id: "handoff-lead",
      identity: { displayName: "Lead", background: "Leads.", responsibilities: ["Lead"] },
      capabilities: ["quality.audit"],
      providerId: "handoff-gate-provider"
    });
    await service.createEmployee({
      id: "handoff-builder",
      identity: { displayName: "Builder", background: "Builds.", responsibilities: ["Build"] },
      capabilities: ["code.fullstack"],
      providerId: "handoff-gate-provider"
    });
    await service.createEmployee({
      id: "handoff-tester",
      identity: { displayName: "Tester", background: "Tests and audits.", responsibilities: ["Test"] },
      capabilities: ["quality.test"],
      providerId: "handoff-gate-provider",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message", "e2eEvidence"],
        properties: {
          message: { type: "string" },
          e2eEvidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["method", "steps", "observed"],
              properties: {
                method: { type: "string" },
                steps: { type: "string" },
                observed: { type: "string" }
              }
            }
          }
        }
      }
    });
    await service.createManagementPolicy({
      id: "handoff-gate-policy",
      allowedRoleIds: ["builder", "tester"],
      instructions: "Run bounded quality shards before delivery.",
      limits: { maxRounds: 5, maxDelegations: 4, maxParallelDelegations: 1 }
    });
    await service.createWorkflow({
      id: "handoff-gate-workflow",
      architecture: "supervisor",
      supervisor: { employeeId: "handoff-lead" },
      managementPolicy: { id: "handoff-gate-policy" },
      members: [
        { roleId: "builder", employeeId: "handoff-builder" },
        { roleId: "tester", employeeId: "handoff-tester" }
      ],
      flow: {
        stages: [
          { id: "plan", kind: "supervisor", title: "Plan" },
          { id: "loop", kind: "delegation-loop", title: "Build" },
          { id: "test", kind: "gate", title: "Test", gateId: "quality-test" },
          { id: "delivery", kind: "delivery", title: "Deliver" }
        ],
        gates: [{
          id: "quality-test",
          requiredCapability: "quality.test",
          mode: "before-completion",
          required: true,
          instructions: "Run the regression assessment.",
          fallback: "block"
        }]
      }
    });
    const providerCwd = temporaryRoot();
    fs.writeFileSync(path.join(providerCwd, "package.json"), JSON.stringify({ scripts: {} }));

    const result = await service.runWorkbenchWorkflow(
      "handoff-gate-workflow",
      { message: "Implement and validate the change." },
      { kind: "workbench" },
      { providerCwd }
    );
    expect(result.run.status, JSON.stringify(result.run.output)).toBe("passed");
    const sorted = [...shardCalls].sort((a, b) => a.index - b.index);
    expect(sorted).toHaveLength(2);
    // Shard 1 starts cold; shard 2 carries shard 1's handoff.
    expect(sorted[0]!.handoff).toBe("");
    expect(sorted[1]!.handoff).toContain(HANDOFF_MARKER);
    expect(path.isAbsolute(sorted[0]!.handoffPath)).toBe(true);
    expect(sorted[0]!.handoffPath.endsWith(".md")).toBe(true);
  });

  it("degrades gracefully for delegations without a member session", async () => {
    const memberCalls: MemberCall[] = [];
    const providers: ProviderRegistry = new Map([["handoff-nosession-flow", {
      id: "handoff-nosession-flow",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        if (role === "supervisor") {
          const round = supervisorRound(invocation);
          if (round === 1) {
            return providerResponse({
              action: "delegate",
              summary: "Delegate directly without a member session.",
              assignments: [{
                roleId: "builder",
                task: "Implement the backend change.",
                requiredCapabilities: ["code.backend"],
                workKind: "code",
                changeSet: "backend"
              }]
            });
          }
          return finishResponse();
        }
        memberCalls.push(captureMemberCall(invocation));
        return providerResponse({ message: "Implemented." });
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("handoff-nosession-provider", { adapter: "handoff-nosession-flow", outputProtocol: "json" });
    await createTeam(service, "handoff-nosession-provider");
    await createWorkflow(service);

    const result = await service.runWorkbenchWorkflow("handoff-supervision", { message: "Build." }, { kind: "workbench" });
    expect(result.run.status, JSON.stringify(result.run.output)).toBe("passed");
    expect(memberCalls).toHaveLength(1);
    expect(memberCalls[0]!.handoff).toBe("");
    expect(memberCalls[0]!.handoffPath).toBe("");
    // The prompt rendered without throwing (the run passed) and still carries the handoff section.
    expect(memberCalls[0]!.prompt).toContain("Member handoff");
  });

  it("truncates handoff notes past the size limit", async () => {
    const memberCalls: MemberCall[] = [];
    const longContent = "x".repeat(9000);
    const providers: ProviderRegistry = new Map([["handoff-truncate-flow", {
      id: "handoff-truncate-flow",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        if (role === "supervisor") {
          const round = supervisorRound(invocation);
          if (round === 1) return planTodosResponse("handoff-truncate");
          if (round === 2) return delegateResponse("todo-1");
          if (round === 3) return delegateResponse("todo-2");
          return finishResponse();
        }
        const call = captureMemberCall(invocation);
        memberCalls.push(call);
        if (call.todoId === "todo-1") writeHandoffFile(invocation.cwd, "handoff-truncate", longContent);
        return providerResponse({ message: `${call.todoId} completed.` });
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("handoff-truncate-provider", { adapter: "handoff-truncate-flow", outputProtocol: "json" });
    await createTeam(service, "handoff-truncate-provider");
    await createWorkflow(service);
    const providerCwd = temporaryRoot();
    fs.writeFileSync(path.join(providerCwd, "package.json"), JSON.stringify({ scripts: {} }));

    const result = await service.runWorkbenchWorkflow(
      "handoff-supervision",
      { message: "Build the feature." },
      { kind: "workbench" },
      { providerCwd }
    );
    expect(result.run.status, JSON.stringify(result.run.output)).toBe("passed");
    expect(memberCalls).toHaveLength(2);
    const handoff = memberCalls[1]!.handoff;
    expect(handoff.endsWith("…[truncated]")).toBe(true);
    expect(handoff.length).toBeLessThanOrEqual(8000 + "\n…[truncated]".length);
    expect(handoff.startsWith("x".repeat(8000))).toBe(true);
  });
});
