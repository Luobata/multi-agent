import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { WorkbenchService } from "../src/workbench/service.js";
import type { WorkflowChangeRequest, WorkflowChangeOperation, SupervisorGate } from "../src/workbench/types.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-workflow-change-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function createEmployee(service: WorkbenchService, id: string): Promise<void> {
  await service.createEmployee({
    id,
    identity: {
      displayName: id,
      background: `${id} handles workflow change test work.`,
      responsibilities: ["Handle assigned work"]
    }
  });
}

/** Minimal supervisor workflow scaffold, mirroring tests/entrance-policy.test.ts createSupervisorWorkflow. */
async function createSupervisorWorkflow(service: WorkbenchService, id: string): Promise<string> {
  await createEmployee(service, `${id}-manager`);
  await createEmployee(service, `${id}-worker`);
  await service.createManagementPolicy({
    id: `${id}-management`,
    allowedRoleIds: ["worker"],
    instructions: "Finish directly when delegation is unnecessary."
  });
  const workflow = await service.createWorkflow({
    id,
    architecture: "supervisor",
    supervisor: { employeeId: `${id}-manager` },
    managementPolicy: { id: `${id}-management` },
    members: [{ roleId: "worker", employeeId: `${id}-worker` }]
  });
  return workflow.id;
}

async function createGraphWorkflow(service: WorkbenchService, id: string): Promise<string> {
  await createEmployee(service, `${id}-specialist`);
  const workflow = await service.createWorkflow({
    id,
    nodes: [{ id: "respond", employeeId: `${id}-specialist` }]
  });
  return workflow.id;
}

function addGateOperation(gate: Partial<SupervisorGate> = {}): WorkflowChangeOperation {
  return {
    kind: "add-gate",
    gate: {
      id: "e2e",
      requiredCapability: "quality.test",
      mode: "before-completion",
      required: true,
      instructions: "Require real e2e evidence before completion.",
      fallback: "block",
      validatorId: "e2e-evidence",
      ...gate
    },
    rationale: "Enforce e2e evidence.",
    risk: "low"
  };
}

describe("WorkflowChangeRequest types", () => {
  it("shapes an add-gate operation", () => {
    const op: WorkflowChangeOperation = {
      kind: "add-gate",
      gate: { id: "g1", requiredCapability: "quality.test", mode: "before-completion", required: true, instructions: "x", fallback: "block", validatorId: "e2e-evidence" },
      rationale: "r", risk: "low"
    };
    const req: WorkflowChangeRequest = {
      id: "wc-1", workflowId: "w", workflowVersion: 1, status: "awaiting-approval",
      title: "t", reason: "r", requestedBy: "gate-steward", operations: [op],
      createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z"
    };
    expect(req.operations[0]?.kind).toBe("add-gate");
  });
});

describe("WorkflowChangeRequest approval chain (create/list/get)", () => {
  it("creates a change request freezing the workflow version and lists it", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    const workflowId = await createSupervisorWorkflow(service, "supervised-change");
    const workflow = service.getWorkflow(workflowId);

    const req = await service.createWorkflowChangeRequest({
      workflowId,
      title: "加e2e门禁",
      reason: "Require real e2e evidence at completion.",
      operations: [addGateOperation()]
    });

    expect(req.status).toBe("awaiting-approval");
    expect(req.workflowId).toBe(workflowId);
    expect(req.workflowVersion).toBe(workflow.version);
    expect(req.requestedBy).toBe("gate-steward");
    expect(req.id).toMatch(/^wc-/);
    expect(req.operations).toHaveLength(1);

    const listed = await service.listWorkflowChangeRequests();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(req.id);

    const fetched = await service.getWorkflowChangeRequest(req.id);
    expect(fetched.id).toBe(req.id);
  });

  it("orders list results by createdAt descending", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    const workflowId = await createSupervisorWorkflow(service, "ordered-change");
    const first = await service.createWorkflowChangeRequest({
      workflowId, title: "first", reason: "r1", operations: [addGateOperation({ id: "gate-one" })]
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await service.createWorkflowChangeRequest({
      workflowId, title: "second", reason: "r2", operations: [addGateOperation({ id: "gate-two" })]
    });
    const listed = await service.listWorkflowChangeRequests();
    expect(listed.map((request) => request.id)).toEqual([second.id, first.id]);
  });

  it("honors an explicit requestedBy", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    const workflowId = await createSupervisorWorkflow(service, "requested-by-change");
    const req = await service.createWorkflowChangeRequest({
      workflowId, title: "t", reason: "r", requestedBy: "alice", operations: [addGateOperation()]
    });
    expect(req.requestedBy).toBe("alice");
  });

  it("rejects an unknown validatorId", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    const workflowId = await createSupervisorWorkflow(service, "bad-validator-change");
    await expect(service.createWorkflowChangeRequest({
      workflowId, title: "t", reason: "r", operations: [addGateOperation({ validatorId: "nope" })]
    })).rejects.toThrow(/validator/);
  });

  it("rejects an unsupported gate mode", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    const workflowId = await createSupervisorWorkflow(service, "bad-mode-change");
    await expect(service.createWorkflowChangeRequest({
      workflowId, title: "t", reason: "r",
      operations: [addGateOperation({ mode: "sometimes" as SupervisorGate["mode"] })]
    })).rejects.toThrow();
  });

  it("rejects an add-gate whose id already exists in the flow", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    const workflowId = await createSupervisorWorkflow(service, "dup-gate-change");
    await service.updateWorkflow(workflowId, {
      architecture: "supervisor",
      flow: {
        stages: [
          { id: "plan", kind: "supervisor", title: "Plan" },
          { id: "delegation-loop", kind: "delegation-loop", title: "Delegate" },
          { id: "e2e-stage", kind: "gate", title: "E2E", gateId: "e2e" },
          { id: "delivery", kind: "delivery", title: "Deliver" }
        ],
        gates: [{
          id: "e2e", requiredCapability: "quality.test", mode: "before-completion",
          required: true, instructions: "existing gate", fallback: "block", validatorId: "e2e-evidence"
        }]
      }
    });
    await expect(service.createWorkflowChangeRequest({
      workflowId, title: "t", reason: "r", operations: [addGateOperation({ id: "e2e" })]
    })).rejects.toThrow(/e2e/);
  });

  it("rejects update-gate / remove-gate on a gate absent from the flow", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    const workflowId = await createSupervisorWorkflow(service, "missing-gate-change");
    await expect(service.createWorkflowChangeRequest({
      workflowId, title: "t", reason: "r",
      operations: [{ kind: "remove-gate", gateId: "ghost", rationale: "r", risk: "low" }]
    })).rejects.toThrow(/ghost/);
    await expect(service.createWorkflowChangeRequest({
      workflowId, title: "t", reason: "r",
      operations: [{ kind: "update-gate", gateId: "ghost", patch: { required: false }, rationale: "r", risk: "low" }]
    })).rejects.toThrow(/ghost/);
  });

  it("rejects operating on a non-supervisor (graph) workflow", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    const workflowId = await createGraphWorkflow(service, "graph-change");
    await expect(service.createWorkflowChangeRequest({
      workflowId, title: "t", reason: "r", operations: [addGateOperation()]
    })).rejects.toThrow();
  });

  it("throws when getting a missing change request", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    expect(() => service.getWorkflowChangeRequest("wc-missing")).toThrow();
  });
});
