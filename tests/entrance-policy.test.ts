import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchService } from "../src/workbench/service.js";
import type { EntrancePolicyEvaluationInput } from "../src/workbench/types.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-entrance-policy-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function evaluation(
  input: Partial<EntrancePolicyEvaluationInput> = {}
): EntrancePolicyEvaluationInput {
  return {
    route: "auto",
    tags: [],
    signals: {},
    source: { kind: "http" },
    ...input
  };
}

async function createEmployee(service: WorkbenchService, id: string) {
  return service.createEmployee({
    id,
    identity: {
      displayName: id,
      background: `${id} handles entrance policy test work.`,
      responsibilities: ["Handle assigned work"]
    }
  });
}

async function createSupervisorWorkflow(service: WorkbenchService, id: string) {
  await createEmployee(service, `${id}-manager`);
  await createEmployee(service, `${id}-worker`);
  await service.createManagementPolicy({
    id: `${id}-management`,
    allowedRoleIds: ["worker"],
    instructions: "Finish directly when delegation is unnecessary."
  });
  return service.createWorkflow({
    id,
    architecture: "supervisor",
    supervisor: { employeeId: `${id}-manager` },
    managementPolicy: { id: `${id}-management` },
    members: [{ roleId: "worker", employeeId: `${id}-worker` }]
  });
}

describe("task Entrance Policies", () => {
  it("persists versioned CRUD records and keeps resolved target versions pinned", async () => {
    const root = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot: root });
    await createEmployee(service, "pinned-specialist");

    const created = await service.createEntrancePolicy({
      id: "versioned-entrance",
      displayName: "Versioned Entrance",
      direct: { mode: "caller" },
      specialists: { specialist: { kind: "employee", employeeId: "pinned-specialist" } },
      default: { route: "specialist", specialistKey: "specialist" }
    });
    expect(created).toMatchObject({
      version: 1,
      specialists: { specialist: { kind: "employee", employeeId: "pinned-specialist", employeeVersion: 1 } }
    });
    await service.updateEmployee("pinned-specialist", { description: "A newer Employee version." });
    const updated = await service.updateEntrancePolicy(created.id, { description: "A revised entrance policy." });
    expect(updated).toMatchObject({
      version: 2,
      specialists: { specialist: { employeeVersion: 1 } }
    });
    await expect(service.archiveEntrancePolicy(created.id)).resolves.toMatchObject({ version: 3, status: "archived" });
    expect(service.listEntrancePolicies()).toEqual([]);
    await expect(service.restoreEntrancePolicy(created.id)).resolves.toMatchObject({ version: 4, status: "active" });
    expect(service.getEntrancePolicyVersions(created.id).map((policy) => policy.version)).toEqual([4, 3, 2, 1]);

    const reopened = await WorkbenchService.open({ dataRoot: root });
    expect(reopened.getEntrancePolicy(created.id)).toMatchObject({
      version: 4,
      status: "active",
      specialists: { specialist: { employeeVersion: 1 } }
    });
    expect(reopened.snapshot().entrancePolicies[created.id]?.versions).toHaveLength(4);
  });

  it("uses explicit override, then the first matching structured rule, then default without reading message text", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await createEmployee(service, "first-specialist");
    const leader = await createSupervisorWorkflow(service, "routing-leader");
    await service.createEntrancePolicy({
      id: "deterministic-routing",
      direct: { mode: "caller" },
      specialists: { first: { kind: "employee", employeeId: "first-specialist" } },
      leader: { workflowId: leader.id },
      rules: [
        {
          id: "first-rule",
          when: {
            tagsAnyOf: ["review"],
            source: { kind: "http" },
            signals: { "risk.score": { gte: 5, lte: 10 }, urgent: { in: [true, "yes"] } }
          },
          result: { route: "specialist", specialistKey: "first" }
        },
        {
          id: "second-rule",
          when: { tagsAnyOf: ["review"] },
          result: { route: "leader" }
        }
      ],
      default: { route: "direct" }
    });

    const before = service.getActivitySnapshot().invocations.length;
    const first = service.evaluateEntrancePolicy("deterministic-routing", evaluation({
      tags: ["review"],
      signals: { risk: { score: 7 }, urgent: true }
    }));
    expect(first).toMatchObject({
      decidedBy: "rule",
      matchedRuleId: "first-rule",
      result: { route: "specialist", specialistKey: "first" },
      target: { kind: "employee", employeeId: "first-specialist", employeeVersion: 1 }
    });
    const explicit = service.evaluateEntrancePolicy("deterministic-routing", evaluation({ route: "leader" }));
    expect(explicit).toMatchObject({
      decidedBy: "explicit",
      result: { route: "leader" },
      target: { kind: "supervisor-workflow", workflowId: leader.id, workflowVersion: 1 }
    });
    const fallback = await service.dispatchEntrancePolicy("deterministic-routing", {
      ...evaluation(),
      message: "leader urgent specialist review — these words are execution text only"
    });
    expect(fallback).toMatchObject({
      decision: { decidedBy: "default", result: { route: "direct" }, target: { kind: "caller" } },
      dispatch: { kind: "return-to-caller", invocationCreated: false }
    });
    expect(service.getActivitySnapshot().invocations).toHaveLength(before);
    await expect(service.listRuns()).resolves.toEqual([]);
  });

  it("rejects unconfigured explicit overrides and evaluate-only message fields without creating work", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await service.createEntrancePolicy({
      id: "caller-only",
      direct: { mode: "caller" },
      default: { route: "direct" }
    });

    expect(() => service.evaluateEntrancePolicy("caller-only", evaluation({ route: "leader" })))
      .toThrow(/leader route is not configured/);
    await expect(service.dispatchEntrancePolicy("caller-only", {
      ...evaluation({ route: "specialist", specialistKey: "missing" }),
      message: "Do not create work for an invalid override."
    })).rejects.toThrow(/specialist missing is not configured/);
    expect(() => service.evaluateEntrancePolicy("caller-only", {
      ...evaluation(),
      message: "message is not an EvaluationInput field"
    } as EntrancePolicyEvaluationInput)).toThrow(/unsupported fields: message/);
    expect(service.getActivitySnapshot().invocations).toEqual([]);
    await expect(service.listRuns()).resolves.toEqual([]);
  });

  it("dispatches a pinned Employee specialist and records the Entrance snapshot", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await createEmployee(service, "solo-specialist");
    await service.createEntrancePolicy({
      id: "solo-routing",
      specialists: { solo: { kind: "employee", employeeId: "solo-specialist" } },
      default: { route: "specialist", specialistKey: "solo" }
    });
    await service.updateEmployee("solo-specialist", { description: "Current Employee is now v2." });

    const dispatched = await service.dispatchEntrancePolicy("solo-routing", {
      ...evaluation(),
      message: "Handle this with the pinned specialist."
    });
    expect(dispatched.dispatch.kind).toBe("employee");
    const invocation = service.getActivitySnapshot().invocations[0];
    expect(invocation).toMatchObject({
      target: { kind: "employee", id: "solo-specialist", version: 1 },
      executionSnapshot: {
        employees: [{ employeeId: "solo-specialist", employeeVersion: 1 }],
        entrance: {
          policyId: "solo-routing",
          policyVersion: 1,
          result: { route: "specialist", specialistKey: "solo" },
          decidedBy: "default",
          target: { kind: "employee", employeeId: "solo-specialist", employeeVersion: 1 }
        }
      }
    });
  });

  it("dispatches a version-pinned project role through the existing assignment path", async () => {
    const root = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot: root });
    await createEmployee(service, "project-specialist");
    await service.createProject({
      id: "entrance-project",
      name: "Entrance Project",
      rootPath: root,
      descriptorPath: path.join(root, "multi-agent.project.yaml"),
      roles: [{
        id: "backend",
        displayName: "Backend",
        description: "Implement backend work.",
        instructions: "Follow the project backend contract."
      }]
    });
    await service.saveProjectBinding("entrance-project", {
      roles: [{ roleId: "backend", employeeId: "project-specialist" }]
    });
    const policy = await service.createEntrancePolicy({
      id: "project-routing",
      specialists: {
        backend: { kind: "project-role", projectId: "entrance-project", roleId: "backend" }
      },
      default: { route: "specialist", specialistKey: "backend" }
    });
    expect(policy.specialists.backend).toMatchObject({
      kind: "project-role",
      projectVersion: 1,
      projectBindingVersion: 1,
      employeeId: "project-specialist",
      employeeVersion: 1
    });

    const dispatched = await service.dispatchEntrancePolicy("project-routing", {
      ...evaluation({ source: { kind: "mcp", caller: "root-agent" } }),
      message: "Implement the server task."
    });
    expect(dispatched.dispatch.kind).toBe("project-role");
    expect(service.getActivitySnapshot().invocations[0]).toMatchObject({
      source: {
        kind: "mcp",
        caller: "root-agent",
        project: "entrance-project",
        projectRole: "backend",
        projectBindingVersion: 1
      },
      executionSnapshot: {
        entrance: { target: { kind: "project-role", projectVersion: 1, projectBindingVersion: 1 } }
      }
    });
  });

  it("starts pinned Graph specialists and Supervisor leaders asynchronously", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await createEmployee(service, "graph-specialist");
    const graph = await service.createWorkflow({
      id: "specialist-graph",
      nodes: [{ id: "respond", employeeId: "graph-specialist" }]
    });
    const leader = await createSupervisorWorkflow(service, "pinned-leader");
    await service.createEntrancePolicy({
      id: "workflow-routing",
      specialists: { graph: { kind: "graph-workflow", workflowId: graph.id } },
      leader: { workflowId: leader.id },
      rules: [{ id: "graph-rule", when: { tagsAnyOf: ["graph"] }, result: { route: "specialist", specialistKey: "graph" } }],
      default: { route: "leader" }
    });
    await service.updateWorkflow(graph.id, { description: "Graph v2 must not be selected by the pinned policy." });
    await service.updateWorkflow(leader.id, { description: "Supervisor v2 must not be selected by the pinned policy." });

    const graphDispatch = await service.dispatchEntrancePolicy("workflow-routing", {
      ...evaluation({ tags: ["graph"] }),
      message: "Start the graph specialist."
    });
    expect(graphDispatch.dispatch.kind).toBe("invocation-started");
    if (graphDispatch.dispatch.kind !== "invocation-started") throw new Error("expected Graph receipt");
    const graphDetail = await service.waitForInvocation(graphDispatch.dispatch.receipt.invocation.id);
    expect(graphDetail.invocation.executionSnapshot).toMatchObject({
      workflow: { id: graph.id, version: 1, architecture: "graph" },
      entrance: { target: { kind: "graph-workflow", workflowVersion: 1 } }
    });

    const leaderDispatch = await service.dispatchEntrancePolicy("workflow-routing", {
      ...evaluation(),
      message: "Start the supervisor leader."
    });
    expect(leaderDispatch.dispatch.kind).toBe("invocation-started");
    if (leaderDispatch.dispatch.kind !== "invocation-started") throw new Error("expected Supervisor receipt");
    const leaderDetail = await service.waitForInvocation(leaderDispatch.dispatch.receipt.invocation.id);
    expect(leaderDetail.invocation.executionSnapshot).toMatchObject({
      workflow: { id: leader.id, version: 1, architecture: "supervisor" },
      entrance: {
        policyId: "workflow-routing",
        policyVersion: 1,
        target: { kind: "supervisor-workflow", workflowId: leader.id, workflowVersion: 1 }
      }
    });
  });

  it("rejects a non-Supervisor workflow configured as leader", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await createEmployee(service, "not-a-leader");
    await service.createWorkflow({
      id: "plain-graph",
      nodes: [{ id: "respond", employeeId: "not-a-leader" }]
    });

    await expect(service.createEntrancePolicy({
      id: "invalid-leader",
      direct: { mode: "caller" },
      leader: { workflowId: "plain-graph" },
      default: { route: "direct" }
    })).rejects.toThrow(/must use architecture=supervisor/);
    expect(service.listEntrancePolicies(true)).toEqual([]);
  });
});
