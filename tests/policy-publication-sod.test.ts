import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkbenchService } from "../src/workbench/service.js";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "policy-publication-"));
const identity = (displayName: string) => ({ displayName, background: "Test employee.", responsibilities: ["Work"] });

describe("policy packs, publication pins, workflow contracts, and SoD", () => {
  it("pins publication targets per Invocation and resolves floating only for a new Invocation", async () => {
    const service = await WorkbenchService.open({ dataRoot: root() });
    const employee = await service.createEmployee({ id: "published-worker", identity: identity("Worker") });
    const v1 = await service.createWorkflow({ id: "published-flow", nodes: [{ id: "work", employeeId: employee.id }] });
    const pinned = await service.createPublication({ id: "pinned-flow", name: "Pinned", target: { kind: "workflow", id: v1.id } });
    const floating = await service.createPublication({ id: "floating-flow", name: "Floating", releaseChannel: "floating", target: { kind: "workflow", id: v1.id } });
    const v2 = await service.updateWorkflow(v1.id, { description: "v2" });

    const pinnedRun = await service.invokePublication(pinned.id, { message: "pinned" });
    const floatingRun = await service.invokePublication(floating.id, { message: "floating" });
    if (!("run" in pinnedRun) || !("run" in floatingRun)) throw new Error("expected workflow publication results");
    const invocations = service.getActivitySnapshot().invocations;
    expect(invocations.find((item) => item.runId === pinnedRun.run.id)?.executionSnapshot?.publication).toMatchObject({ publicationVersion: 1, targetVersion: v1.version, releaseChannel: "pinned" });
    expect(invocations.find((item) => item.runId === floatingRun.run.id)?.executionSnapshot?.publication).toMatchObject({ publicationVersion: 1, targetVersion: v2.version, releaseChannel: "floating" });
  });

  it("classifies and persists second-layer workflow output validation failures", async () => {
    const service = await WorkbenchService.open({ dataRoot: root() });
    const employee = await service.createEmployee({ id: "contract-worker", identity: identity("Contract Worker") });
    const workflow = await service.createWorkflow({
      id: "contract-flow",
      nodes: [{ id: "work", employeeId: employee.id }],
      workflowOutputSchemaVersion: 3,
      workflowOutputSchema: { type: "object", required: ["releaseArtifact"], properties: { releaseArtifact: { type: "string" } } }
    });
    const result = await service.runWorkbenchWorkflow(workflow.id, { message: "work" });
    expect(result.run.status).toBe("failed");
    expect(JSON.parse(fs.readFileSync(path.join(result.runDir, "workflow-output-validation.json"), "utf8"))).toMatchObject({ status: "failed", category: "workflow-output-validation", schemaVersion: 3 });
  });

  it("surfaces a staffing gap when SoD roles resolve to the same Employee", async () => {
    const service = await WorkbenchService.open({ dataRoot: root() });
    const lead = await service.createEmployee({ id: "sod-lead", identity: identity("Lead") });
    const shared = await service.createEmployee({ id: "sod-shared", identity: identity("Shared") });
    const policy = await service.createManagementPolicy({ id: "sod-policy", allowedRoleIds: ["producer", "approver"], instructions: "Separate production and approval." });
    await expect(service.createWorkflow({
      id: "sod-gap", architecture: "supervisor", supervisor: { employeeId: lead.id }, managementPolicy: { id: policy.id },
      members: [{ roleId: "producer", employeeId: shared.id }, { roleId: "approver", employeeId: shared.id }],
      separationOfDuties: { producerRoleIds: ["producer"], approverRoleIds: ["approver"], mustDifferEmployee: true, sameSessionForbidden: true, independentEvidenceRequired: true }
    })).rejects.toThrow(/staffing-gap\/preparation/);
  });
});
