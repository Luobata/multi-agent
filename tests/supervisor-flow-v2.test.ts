import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatPlanMermaid, formatPlanText } from "../src/core/plan.js";
import type { JsonObject } from "../src/core/types.js";
import type { ProviderRegistry } from "../src/runtime/providers.js";
import { WorkbenchService } from "../src/workbench/service.js";
import type { SupervisorDagNodeInput } from "../src/workbench/types.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-supervisor-flow-v2-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function parallelBarrier(expected: number): () => Promise<void> {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrivals += 1;
    if (arrivals === expected) release();
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("expected DAG nodes to run in parallel")), 1_000))
    ]);
  };
}

async function createFlowTeam(service: WorkbenchService, providerId: string): Promise<void> {
  const employees = [
    ["flow-lead", "Lead", ["Coordinate"], ["team.lead"]],
    ["flow-frontend", "Frontend", ["Build frontend"], ["code.frontend"]],
    ["flow-backend", "Backend", ["Build backend"], ["code.backend"]],
    ["flow-tester", "Tester", ["Test"], ["quality.test"]],
    ["flow-integrator", "Integrator", ["Merge"], ["code.integration"]]
  ] as const;
  for (const [id, displayName, responsibilities, capabilities] of employees) {
    await service.createEmployee({
      id,
      identity: { displayName, background: `${displayName} flow worker.`, responsibilities: [...responsibilities] },
      capabilities: [...capabilities],
      providerId
    });
  }
  await service.createManagementPolicy({
    id: "flow-policy",
    allowedRoleIds: ["frontend", "backend", "tester", "integrator"],
    instructions: "Execute only declared ready DAG nodes and finish after required work passes.",
    limits: { maxRounds: 6, maxDelegations: 8, maxParallelDelegations: 3, maxDurationMs: 60_000 }
  });
}

const flowStages = [
  { id: "plan", kind: "supervisor" as const, title: "Plan" },
  { id: "loop", kind: "delegation-loop" as const, title: "Execute DAG" },
  { id: "delivery", kind: "delivery" as const, title: "Deliver" }
];

const flowDag: { nodes: SupervisorDagNodeInput[] } = {
  nodes: [
    { nodeId: "frontend-task", roleRef: "frontend", needs: [], kind: "task" as const, task: "Implement frontend.", requiredCapabilities: ["code.frontend"], workKind: "code", changeSet: "frontend" },
    { nodeId: "backend-task", roleId: "backend", needs: [], kind: "task" as const, task: "Implement backend.", requiredCapabilities: ["code.backend"], workKind: "code", changeSet: "backend" },
    { nodeId: "frontend-test", roleId: "tester", needs: ["frontend-task"], kind: "test" as const, task: "Test frontend branch.", requiredCapabilities: ["quality.test"] },
    { nodeId: "backend-test", roleId: "tester", needs: ["backend-task"], kind: "test" as const, task: "Test backend branch.", requiredCapabilities: ["quality.test"] },
    { nodeId: "merge", roleId: "integrator", needs: ["frontend-test", "backend-test"], kind: "merge" as const, task: "Merge tested branches.", requiredCapabilities: ["code.integration"] },
    { nodeId: "integration-test", roleId: "tester", needs: ["merge"], kind: "integration-test" as const, task: "Test the merged result.", requiredCapabilities: ["quality.test"] }
  ]
};

async function createDagWorkflow(service: WorkbenchService, id = "flow-v2"): Promise<void> {
  await service.createWorkflow({
    id,
    architecture: "supervisor",
    supervisor: { employeeId: "flow-lead" },
    managementPolicy: { id: "flow-policy" },
    members: [
      { roleId: "frontend", employeeId: "flow-frontend" },
      { roleId: "backend", employeeId: "flow-backend" },
      { roleId: "tester", employeeId: "flow-tester" },
      { roleId: "integrator", employeeId: "flow-integrator" }
    ],
    flow: { stages: flowStages, gates: [], dag: flowDag }
  });
}

describe("Supervisor Flow v2 declarative DAG runtime", () => {
  it("runs ready frontend/backend and branch tests in parallel, then merge and integration-test", async () => {
    const buildBarrier = parallelBarrier(2);
    const testBarrier = parallelBarrier(2);
    const observedNeeds = new Map<string, string[]>();
    const providers: ProviderRegistry = new Map([["flow-v2-runtime", {
      id: "flow-v2-runtime",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        const node = invocation.templateContext.node as {
          metadata?: { flowNodeId?: string };
          with?: { __supervisorRound?: number };
        };
        const round = Number(node.with?.__supervisorRound ?? 0);
        if (role === "supervisor") {
          const decisions: Record<number, JsonObject> = {
            1: { action: "delegate", assignments: [
              { nodeId: "frontend-task", roleId: "frontend" },
              { nodeId: "backend-task", roleId: "backend" }
            ] },
            2: { action: "delegate", assignments: [
              { nodeId: "frontend-test", roleId: "tester" },
              { nodeId: "backend-test", roleId: "tester" }
            ] },
            3: { action: "delegate", assignments: [{ nodeId: "merge", roleId: "integrator" }] },
            4: { action: "delegate", assignments: [{ nodeId: "integration-test", roleId: "tester" }] },
            5: { action: "finish", summary: "Flow v2 complete.", result: { delivered: true } }
          };
          return { stdout: JSON.stringify(decisions[round]), stderr: "", durationMs: 1 };
        }
        const flowNodeId = node.metadata?.flowNodeId;
        if (!flowNodeId) throw new Error("member execution is missing flowNodeId");
        observedNeeds.set(flowNodeId, Object.keys(invocation.templateContext.needs as Record<string, unknown>));
        if (flowNodeId === "frontend-task" || flowNodeId === "backend-task") await buildBarrier();
        if (flowNodeId === "frontend-test" || flowNodeId === "backend-test") await testBarrier();
        return { stdout: JSON.stringify({ message: `${flowNodeId} passed.` }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("flow-provider", { adapter: "flow-v2-runtime", outputProtocol: "json" });
    await createFlowTeam(service, "flow-provider");
    await createDagWorkflow(service);

    const workflow = service.getWorkflow("flow-v2");
    expect(workflow.architecture).toBe("supervisor");
    if (workflow.architecture !== "supervisor") throw new Error("expected Supervisor workflow");
    expect(workflow.flow.dag?.nodes[0]).toMatchObject({ nodeId: "frontend-task", roleId: "frontend", required: true });
    expect(workflow.flow.dag?.nodes[0]).not.toHaveProperty("roleRef");
    const plan = await service.planWorkflow("flow-v2");
    expect(formatPlanText(plan)).toContain("DAG: frontend-task [task, frontend]");
    expect(formatPlanMermaid(plan)).toContain("dag_frontend_test --> dag_merge");

    const result = await service.runWorkbenchWorkflow("flow-v2", { message: "Ship both branches." });
    expect(result.run.status, JSON.stringify(result.run.output)).toBe("passed");
    expect(result.run.output).toMatchObject({
      summary: "Flow v2 complete.",
      result: { delivered: true },
      dag: { nodes: expect.arrayContaining(flowDag.nodes.map((node) => expect.objectContaining({ nodeId: node.nodeId, status: "passed" }))) }
    });
    expect(observedNeeds.get("merge")).toEqual(expect.arrayContaining(["supervisor-r3", "frontend-test", "backend-test"]));
    expect(observedNeeds.get("integration-test")).toEqual(expect.arrayContaining(["supervisor-r4", "merge"]));
    expect(Object.keys(result.run.nodes)).toEqual(expect.arrayContaining([
      "frontend-task", "backend-task", "frontend-test", "backend-test", "merge", "integration-test"
    ]));
    expect(result.run.nodes["frontend-task"]?.metadata).toMatchObject({
      flowNodeId: "frontend-task",
      workKind: "code",
      changeSet: "frontend",
      requiredCapabilities: ["code.frontend"]
    });

    const testerInstances = service.getActivitySnapshot().instances
      .filter((instance) => instance.runId === result.run.id && instance.employeeId === "flow-tester")
      .map((instance) => instance.nodeId)
      .sort();
    expect(testerInstances).toEqual(["backend-test", "frontend-test", "integration-test"]);
  });

  it.each([
    {
      name: "out-of-bounds node",
      assignment: { nodeId: "not-declared", roleId: "frontend" },
      reason: "outside the declared DAG"
    },
    {
      name: "wrong role",
      assignment: { nodeId: "frontend-task", roleId: "backend" },
      reason: "expected frontend"
    },
    {
      name: "early merge",
      assignment: { nodeId: "merge", roleId: "integrator" },
      reason: "before dependencies passed"
    },
    {
      name: "work kind override",
      assignment: { nodeId: "frontend-task", roleId: "frontend", workKind: "discussion" },
      reason: "expected code"
    },
    {
      name: "change set override",
      assignment: { nodeId: "frontend-task", roleId: "frontend", changeSet: "backend" },
      reason: "expected frontend"
    }
  ])("blocks $name and persists readable DAG evidence", async ({ assignment, reason }) => {
    const providers: ProviderRegistry = new Map([["invalid-flow-decision", {
      id: "invalid-flow-decision",
      validate: () => [],
      invoke: async () => ({
        stdout: JSON.stringify({ action: "delegate", assignments: [assignment] }),
        stderr: "",
        durationMs: 1
      })
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("invalid-flow-provider", { adapter: "invalid-flow-decision", outputProtocol: "json" });
    await createFlowTeam(service, "invalid-flow-provider");
    await createDagWorkflow(service, "invalid-flow");

    const result = await service.runWorkbenchWorkflow("invalid-flow", { message: "Attempt invalid scheduling." });
    expect(result.run.status).toBe("blocked");
    expect(result.run.output).toMatchObject({
      reason: expect.stringContaining(reason),
      dag: { nodes: expect.arrayContaining([expect.objectContaining({ nodeId: "merge", status: "pending" })]) }
    });
    expect(Object.keys(result.run.nodes)).toEqual(["supervisor-r1"]);
    const events = fs.readFileSync(path.join(result.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; detail?: { reason?: string } });
    expect(events).toContainEqual(expect.objectContaining({
      type: "supervisor.dag.blocked",
      detail: expect.objectContaining({ reason: expect.stringContaining(reason) })
    }));
  });

  it("rejects invalid merge/integration structure and duplicate DAG node ids before execution", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await createFlowTeam(service, "mock");
    let workflowSequence = 0;
    const create = (nodes: SupervisorDagNodeInput[]) => service.createWorkflow({
      id: `invalid-structure-${++workflowSequence}`,
      architecture: "supervisor" as const,
      supervisor: { employeeId: "flow-lead" },
      managementPolicy: { id: "flow-policy" },
      members: [
        { roleId: "frontend", employeeId: "flow-frontend" },
        { roleId: "backend", employeeId: "flow-backend" },
        { roleId: "tester", employeeId: "flow-tester" },
        { roleId: "integrator", employeeId: "flow-integrator" }
      ],
      flow: { stages: flowStages, gates: [], dag: { nodes } }
    });
    const frontendNode = flowDag.nodes[0]!;
    await expect(create([
      frontendNode,
      { ...frontendNode }
    ])).rejects.toThrow(/duplicate supervisor dag node frontend-task/);
    await expect(create([
      frontendNode,
      { nodeId: "merge", roleId: "integrator", needs: ["frontend-task"], kind: "merge", task: "Merge." }
    ])).rejects.toThrow(/merge node merge must directly depend on at least two test nodes/);
    await expect(create([
      frontendNode,
      { nodeId: "integration-test", roleId: "tester", needs: ["frontend-task"], kind: "integration-test", task: "Test." }
    ])).rejects.toThrow(/integration-test node integration-test must directly depend on a merge node/);
    await expect(create([
      { nodeId: "cycle-one", roleId: "frontend", needs: ["cycle-two"], kind: "task", task: "One." },
      { nodeId: "cycle-two", roleId: "backend", needs: ["cycle-one"], kind: "task", task: "Two." }
    ])).rejects.toThrow(/supervisor flow dag contains a cycle/);
  });

  it("preserves legacy role-only Supervisor delegation when no DAG is declared", async () => {
    const legacySupervisorContexts: Array<{ requestPrompt: string; with: Record<string, unknown> }> = [];
    const providers: ProviderRegistry = new Map([["legacy-supervisor", {
      id: "legacy-supervisor",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        const supervisorNode = invocation.templateContext.node as { with?: { __supervisorRound?: number } };
        const round = Number(supervisorNode.with?.__supervisorRound ?? 0);
        if (role === "supervisor") {
          legacySupervisorContexts.push({
            requestPrompt: String(invocation.templateContext.requestPrompt),
            with: (supervisorNode.with ?? {}) as Record<string, unknown>
          });
        }
        if (role === "supervisor" && round === 1) {
          return {
            stdout: JSON.stringify({ action: "delegate", assignments: [{ roleId: "frontend", task: "Legacy task." }] }),
            stderr: "",
            durationMs: 1
          };
        }
        if (role === "supervisor") {
          return { stdout: JSON.stringify({ action: "finish", summary: "Legacy done.", result: {} }), stderr: "", durationMs: 1 };
        }
        return { stdout: JSON.stringify({ message: "Legacy worker passed." }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("legacy-provider", { adapter: "legacy-supervisor", outputProtocol: "json" });
    await createFlowTeam(service, "legacy-provider");
    await service.createWorkflow({
      id: "legacy-flow",
      architecture: "supervisor",
      supervisor: { employeeId: "flow-lead" },
      managementPolicy: { id: "flow-policy" },
      members: [{ roleId: "frontend", employeeId: "flow-frontend" }]
    });

    const result = await service.runWorkbenchWorkflow("legacy-flow", { message: "Use legacy delegation." });
    expect(result.run.status).toBe("passed");
    expect(Object.keys(result.run.nodes)).toEqual(["supervisor-r1", "frontend-r1-1", "supervisor-r2"]);
    expect(result.run.output).not.toHaveProperty("dag");
    expect(legacySupervisorContexts.every((context) => !context.requestPrompt.includes("Declarative DAG"))).toBe(true);
    expect(legacySupervisorContexts.every((context) => !("__supervisorDag" in context.with))).toBe(true);
  });
});
