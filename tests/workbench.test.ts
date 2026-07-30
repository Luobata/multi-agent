import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchService } from "../src/workbench/service.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-workbench-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Local Agent Workbench", () => {
  it("versions, clones, archives, invokes, and persists Employees through the Graph runtime", async () => {
    const root = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot: root });
    await service.createSkill({
      id: "evidence-review",
      displayName: "Evidence Review",
      description: "Review supplied evidence.",
      instructions: "Review evidence with {{skill.config.tone}} language.",
      configSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tone"],
        properties: { tone: { type: "string" } }
      },
      tools: ["read-artifacts"]
    });
    const employee = await service.createEmployee({
      id: "local-analyst",
      identity: {
        displayName: "Local Analyst",
        background: "An evidence-oriented analyst.",
        responsibilities: ["Inspect requests", "Return traceable results"],
        goals: ["Preserve evidence"],
        constraints: ["State uncertainty"]
      },
      description: "Reviews evidence locally.",
      skills: [{ id: "evidence-review", config: { tone: "concise" } }],
      providerId: "mock",
      presentation: { accent: "#6A5544", initials: "LA", avatarUrl: "/avatars/local-analyst.png" }
    });
    expect(employee.presentation.avatarUrl).toBe("/avatars/local-analyst.png");

    const first = await service.invokeEmployee(employee.id, { message: "Review the first dossier" });
    expect(first.status).toBe("passed");
    expect(first.message).toContain("Local Analyst received");
    expect(first.session.employeeVersion).toBe(1);
    expect(fs.existsSync(path.join(first.runDir, "run.json"))).toBe(true);

    const versionTwo = await service.updateEmployee(employee.id, {
      identity: { ...employee.identity, displayName: "Senior Local Analyst" }
    });
    expect(versionTwo.version).toBe(2);
    const skillVersionTwo = await service.updateSkill("evidence-review", {
      instructions: "This updated instruction must not leak into an older Employee version."
    });
    expect(skillVersionTwo.version).toBe(2);
    const continued = await service.invokeEmployee(employee.id, {
      message: "Continue the same dossier",
      sessionId: first.session.id
    });
    expect(continued.session.employeeVersion).toBe(1);
    expect(continued.message).toContain("Local Analyst received");
    expect(continued.message).not.toContain("Senior Local Analyst received");

    const context = await service.getEmployeeContext(employee.id, first.session.id);
    expect(context.effectivePrompt?.combined).toContain("Evidence Review");
    expect(context.effectivePrompt?.combined).toContain("Review evidence with concise language.");
    expect(context.effectivePrompt?.combined).not.toContain("must not leak");
    expect(context.effectivePrompt?.runId).toBe(continued.runId);

    const clone = await service.cloneEmployee(employee.id, "analyst-copy", "Analyst Copy");
    expect(clone.version).toBe(1);
    expect(clone.identity.displayName).toBe("Analyst Copy");
    expect(clone.skillVersions["evidence-review"]).toBe(1);
    expect(clone.presentation.avatarUrl).toBe("/avatars/local-analyst.png");
    expect(service.listSessions(clone.id)).toEqual([]);

    const workflow = await service.createWorkflow({
      id: "analysis-flow",
      description: "Run the cloned analyst.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: { message: { type: "string" } }
      },
      nodes: [{ id: "review", employeeId: clone.id, needs: [], with: {} }]
    });
    expect(workflow.nodes[0]?.employeeVersion).toBe(1);
    await expect(service.runWorkbenchWorkflow("analysis-flow", {})).rejects.toThrow(/input validation failed/);
    const workflowRun = await service.runWorkbenchWorkflow("analysis-flow", { message: "Run the workflow" });
    expect(workflowRun.run.status).toBe("passed");
    expect(workflowRun.run.nodes.review?.output).toEqual({ message: "Analyst Copy received: Run the workflow." });

    await service.archiveEmployee(clone.id);
    await expect(service.runWorkbenchWorkflow("analysis-flow", { message: "Run again" })).rejects.toThrow(/archived/);

    const archived = await service.archiveEmployee(employee.id);
    expect(archived.status).toBe("archived");
    expect(archived.version).toBe(3);
    await expect(service.invokeEmployee(employee.id, { message: "new work" })).rejects.toThrow(/archived/);

    const reopened = await WorkbenchService.open({ dataRoot: root });
    expect(reopened.getEmployee(employee.id).version).toBe(3);
    expect(reopened.getEmployee(employee.id).presentation.avatarUrl).toBe("/avatars/local-analyst.png");
    expect(reopened.getSession(first.session.id).messages).toHaveLength(4);
    await expect(reopened.listRuns()).resolves.toHaveLength(3);
  });

  it("validates Skill configuration before saving an Employee", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await service.createSkill({
      id: "strict-skill",
      description: "Requires a level.",
      instructions: "Use level {{skill.config.level}}.",
      configSchema: { type: "object", required: ["level"], properties: { level: { type: "integer" } } }
    });
    await expect(service.createEmployee({
      id: "invalid-worker",
      identity: { displayName: "Invalid Worker", background: "Test", responsibilities: ["Test"] },
      skills: [{ id: "strict-skill", config: { level: "high" } }]
    })).rejects.toThrow(/config is invalid/);
  });

  it("keeps disabled Skill bindings configured and pinned without injecting them at runtime", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await service.createSkill({
      id: "optional-voice",
      description: "Optional tone guidance.",
      instructions: "DISABLED_SKILL_MARKER must appear only when this binding is enabled."
    });
    const employee = await service.createEmployee({
      id: "toggle-worker",
      identity: { displayName: "Toggle Worker", background: "Tests scoped capability switches.", responsibilities: ["Respond"] },
      skills: [{ id: "optional-voice", config: {}, enabled: false }]
    });
    const disabledRun = await service.invokeEmployee(employee.id, { message: "First" });
    const disabledContext = await service.getEmployeeContext(employee.id, disabledRun.session.id);
    expect(disabledContext.layers.skills[0]).toMatchObject({ id: "optional-voice", enabled: false });
    expect(disabledContext.effectivePrompt?.combined).not.toContain("DISABLED_SKILL_MARKER");

    const enabledEmployee = await service.updateEmployee(employee.id, {
      skills: [{ id: "optional-voice", config: {}, enabled: true }],
      skillVersions: employee.skillVersions
    });
    const enabledRun = await service.invokeEmployee(enabledEmployee.id, { message: "Second" });
    const enabledContext = await service.getEmployeeContext(enabledEmployee.id, enabledRun.session.id);
    expect(enabledContext.layers.skills[0]).toMatchObject({ id: "optional-voice", enabled: true });
    expect(enabledContext.effectivePrompt?.combined).toContain("DISABLED_SKILL_MARKER");
  });

  it("archives and restores shared Skills while preserving version history", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await service.createSkill({ id: "recoverable-skill", description: "Recoverable", instructions: "Keep history." });
    const archived = await service.archiveSkill("recoverable-skill");
    expect(archived).toMatchObject({ status: "archived", version: 2 });
    expect(service.listSkills()).toEqual([]);
    expect(service.listSkills(true)[0]).toMatchObject({ id: "recoverable-skill", status: "archived" });
    const restored = await service.restoreSkill("recoverable-skill");
    expect(restored).toMatchObject({ status: "active", version: 3 });
    expect(service.listSkills()).toHaveLength(1);
  });

  it("persists graph template provenance separately from visual canvas positions", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    for (const id of ["planner", "builder", "reviewer"]) {
      await service.createEmployee({
        id,
        identity: { displayName: id, background: `${id} employee`, responsibilities: ["Work"] }
      });
    }
    const generated = service.instantiateArchitectureTemplate("sequential-pipeline", ["planner", "builder", "reviewer"]);
    const workflow = await service.createWorkflow({
      id: "template-flow",
      ...generated,
      presentation: { positions: { discover: { x: 20, y: 30 }, execute: { x: 240, y: 30 }, verify: { x: 460, y: 30 } } }
    });
    expect(workflow.architecture).toBe("graph");
    expect(workflow.patternId).toBe("sequential-pipeline");
    expect(workflow.presentation?.positions?.execute).toEqual({ x: 240, y: 30 });
    const plan = await service.planWorkflow(workflow.id);
    expect(plan.nodes.map((node) => node.id)).toEqual(["discover", "execute", "verify"]);
  });

  it("serializes mutations from two independently opened stores", async () => {
    const root = temporaryRoot();
    const left = await WorkbenchService.open({ dataRoot: root });
    const right = await WorkbenchService.open({ dataRoot: root });
    await Promise.all([
      left.createSkill({ id: "left-skill", description: "Left", instructions: "Left instructions" }),
      right.createSkill({ id: "right-skill", description: "Right", instructions: "Right instructions" })
    ]);
    expect(left.listSkills().map((skill) => skill.id).sort()).toEqual(["left-skill", "right-skill"]);
    expect(right.listSkills().map((skill) => skill.id).sort()).toEqual(["left-skill", "right-skill"]);
  });

  it("refuses to persist plaintext command Provider environment values", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await expect(service.putProvider("unsafe-provider", {
      adapter: "command",
      command: process.execPath,
      env: { API_TOKEN: "plaintext-secret" }
    })).rejects.toThrow(/must use a \$ENV:VARIABLE_NAME reference/);
    await expect(service.putProvider("referenced-provider", {
      adapter: "command",
      command: process.execPath,
      env: { API_TOKEN: "$ENV:MULTI_AGENT_MODEL_TOKEN" }
    })).resolves.toBeUndefined();
  });
});
