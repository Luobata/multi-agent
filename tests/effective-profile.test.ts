import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EffectiveExecutionProfile } from "../src/workbench/types.js";
import { WorkbenchService } from "../src/workbench/service.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-effective-profile-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("effective execution profile", () => {
  it("pins compiled values to expandable Employee, Project, Binding, Skill, Provider, Workflow, and Task snapshots", async () => {
    const dataRoot = temporaryRoot();
    const projectRoot = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot });
    await service.createSkill({
      id: "coding-gateway",
      displayName: "Coding Gateway",
      description: "Checks coding boundaries.",
      instructions: "GATEWAY_V1",
      tools: ["read-project"]
    });
    const employee = await service.createEmployee({
      id: "project-coder",
      identity: {
        displayName: "Project Coder",
        background: "Implements scoped changes.",
        responsibilities: ["Implement approved specifications"]
      },
      systemPrompt: "EMPLOYEE_BASE_POLICY",
      capabilities: ["code.fullstack"],
      skills: ["coding-gateway"],
      permissions: { write: "project", tools: ["read-project", "write-project"] }
    });
    await service.updateSkill("coding-gateway", { instructions: "GATEWAY_V2_MUST_NOT_REPLACE_PINNED_SOURCE" });
    await service.createProject({
      id: "cart-coding",
      name: "Cart Coding",
      description: "Cart implementation project.",
      rootPath: projectRoot,
      descriptorPath: path.join(projectRoot, "multi-agent.project.yaml"),
      roles: [{
        id: "developer",
        displayName: "Cart Developer",
        description: "Implements cart changes.",
        requiredSkills: ["coding-gateway"],
        optionalSkills: [],
        knowledgeProfileIds: [],
        instructions: "PROJECT_CONTRACT_POLICY",
        permissions: { write: "artifacts-only", tools: ["read-project"] }
      }]
    });
    await service.saveProjectBinding("cart-coding", {
      roles: [{ roleId: "developer", employeeId: employee.id, skills: ["coding-gateway"], updatePolicy: "locked" }]
    });

    const result = await service.invokeProjectRole("cart-coding", "developer", { message: "Implement the approved cart change" });
    const artifactPath = path.join(result.runDir, "effective-profile", "respond.json");
    const profile = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as EffectiveExecutionProfile;

    expect(profile).toMatchObject({
      schemaVersion: 1,
      runId: result.runId,
      nodeId: "respond",
      employee: { id: employee.id, version: 1 },
      assignment: {
        projectId: "cart-coding",
        projectVersion: 1,
        projectBindingVersion: 1,
        roleId: "developer"
      }
    });
    expect(profile.fields.find((field) => field.key === "instructions")?.value).toMatchObject({
      systemPrompt: expect.stringContaining("PROJECT_CONTRACT_POLICY")
    });
    expect(profile.fields.find((field) => field.key === "permissions")?.value).toEqual({
      write: "artifacts-only",
      tools: ["read-project"]
    });

    const skillReference = profile.references.find((reference) => reference.kind === "skill");
    expect(skillReference).toMatchObject({ id: "coding-gateway", version: 1, route: { page: "skills", entityId: "coding-gateway" } });
    expect(JSON.stringify(skillReference?.snapshot)).toContain("GATEWAY_V1");
    expect(JSON.stringify(skillReference?.snapshot)).not.toContain("GATEWAY_V2_MUST_NOT_REPLACE_PINNED_SOURCE");
    expect(profile.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "employee", id: employee.id, version: 1 }),
      expect.objectContaining({ kind: "project-contract", id: "cart-coding/developer", version: 1 }),
      expect.objectContaining({ kind: "project-binding", id: "cart-coding/developer", version: 1 }),
      expect.objectContaining({ kind: "provider", id: "mock" }),
      expect.objectContaining({ kind: "workflow", id: "project-cart-coding-developer", version: 1 }),
      expect.objectContaining({ kind: "task", id: result.runId, route: { page: "runs", entityId: result.runId } })
    ]));

    const context = await service.getEmployeeContext(employee.id, result.session.id);
    expect(context.effectiveProfile).toEqual(profile);
    const run = await service.getRun(result.runId) as { effectiveProfiles?: Record<string, EffectiveExecutionProfile> };
    expect(run.effectiveProfiles?.respond).toEqual(profile);
  });

  it("sanitizes Provider snapshots before persisting provenance", async () => {
    const dataRoot = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot });
    await service.putProvider("private-command", {
      adapter: "command",
      command: "/private/runtime/agent",
      args: ["--token", "do-not-persist"],
      env: { SECRET_TOKEN: "$ENV:SECRET_TOKEN" },
      model: "private-model",
      outputProtocol: "json"
    });
    const employee = await service.createEmployee({
      id: "safe-provenance-worker",
      identity: { displayName: "Safe Worker", background: "Tests provenance.", responsibilities: ["Respond"] },
      providerId: "private-command"
    });
    // Compilation happens before Provider invocation. A failed command still leaves the immutable profile artifact.
    const result = await service.invokeEmployee(employee.id, { message: "Compile safely" });
    expect(result.status).toBe("failed");
    const invocation = service.getActivitySnapshot().invocations[0]!;
    const runDir = path.join(dataRoot, "artifacts", "runs", invocation.runId);
    const profile = JSON.parse(fs.readFileSync(path.join(runDir, "effective-profile", "respond.json"), "utf8")) as EffectiveExecutionProfile;
    const providerSnapshot = profile.references.find((reference) => reference.kind === "provider")?.snapshot;
    expect(providerSnapshot).toEqual({
      id: "private-command",
      adapter: "command",
      model: "private-model",
      outputProtocol: "json"
    });
    expect(JSON.stringify(providerSnapshot)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(providerSnapshot)).not.toContain("do-not-persist");
  });
});
