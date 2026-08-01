import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderRegistry } from "../src/runtime/providers.js";
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
  it("repairs persisted invocation metadata written with the legacy header encoding", async () => {
    const root = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot: root });
    await service.createEmployee({
      id: "encoding-worker",
      identity: { displayName: "Encoding Worker", background: "Tests metadata.", responsibilities: ["Respond"] }
    });
    await service.invokeEmployee(
      "encoding-worker",
      { message: "Create persisted activity" },
      { kind: "http", label: "placeholder", project: "placeholder" }
    );

    const statePath = path.join(root, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      invocations: Record<string, { source: { label?: string; project?: string } }>;
      workInstances: Record<string, { source: { label?: string; project?: string } }>;
    };
    for (const activity of [...Object.values(state.invocations), ...Object.values(state.workInstances)]) {
      activity.source.label = Buffer.from("小狐整体档案设计", "utf8").toString("latin1");
      activity.source.project = `utf8:${encodeURIComponent("档案室项目")}`;
    }
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const reopened = await WorkbenchService.open({ dataRoot: root });
    const snapshot = reopened.getActivitySnapshot();
    expect(snapshot.invocations[0]?.source).toMatchObject({ label: "小狐整体档案设计", project: "档案室项目" });
    expect(snapshot.instances[0]?.source).toMatchObject({ label: "小狐整体档案设计", project: "档案室项目" });
  });

  it("tracks concurrent calls as isolated work instances on one Employee identity", async () => {
    let started = 0;
    let signalStarted = () => {};
    let release = () => {};
    const bothStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const providers: ProviderRegistry = new Map([["slow", {
      id: "slow",
      validate: () => [],
      invoke: async (invocation) => {
        started += 1;
        if (started === 2) signalStarted();
        await gate;
        const displayName = String((invocation.templateContext.role as { identity?: { displayName?: string } }).identity?.displayName ?? "Worker");
        return { stdout: JSON.stringify({ message: `${displayName} completed isolated work.` }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("slow-provider", { adapter: "slow", model: "slow-test-model", outputProtocol: "json" });
    const employee = await service.createEmployee({
      id: "shared-worker",
      identity: { displayName: "Shared Worker", background: "Handles concurrent projects.", responsibilities: ["Work independently"] },
      providerId: "slow-provider"
    });

    const first = service.invokeEmployee(employee.id, { message: "Project Alpha" }, { kind: "mcp", project: "alpha", contextId: "thread-alpha" });
    const second = service.invokeEmployee(employee.id, { message: "Project Beta" }, { kind: "a2a", project: "beta", contextId: "thread-beta" });
    await bothStarted;

    const live = service.getActivitySnapshot();
    expect(live.instances.filter((instance) => instance.employeeId === employee.id && instance.status === "running")).toHaveLength(2);
    expect(new Set(live.instances.map((instance) => instance.source.project))).toEqual(new Set(["alpha", "beta"]));
    expect(new Set(live.instances.map((instance) => instance.model))).toEqual(new Set(["slow-test-model"]));
    expect(new Set(live.instances.map((instance) => instance.invocationId)).size).toBe(2);

    release();
    await Promise.all([first, second]);
    const completed = service.getActivitySnapshot();
    expect(completed.invocations.slice(0, 2).every((invocation) => invocation.status === "completed")).toBe(true);
    expect(completed.instances.slice(0, 2).every((instance) => instance.status === "completed")).toBe(true);
  });

  it("serializes concurrent calls that share one Session context", async () => {
    let calls = 0;
    let signalSecond = () => {};
    let signalThird = () => {};
    let releaseSecond = () => {};
    let releaseThird = () => {};
    const secondStarted = new Promise<void>((resolve) => { signalSecond = resolve; });
    const thirdStarted = new Promise<void>((resolve) => { signalThird = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const thirdGate = new Promise<void>((resolve) => { releaseThird = resolve; });
    const providers: ProviderRegistry = new Map([["session-lane", {
      id: "session-lane",
      validate: () => [],
      invoke: async () => {
        calls += 1;
        if (calls === 2) { signalSecond(); await secondGate; }
        if (calls === 3) { signalThird(); await thirdGate; }
        return { stdout: JSON.stringify({ message: `Call ${calls} completed.` }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("session-provider", { adapter: "session-lane", model: "serialized-context", outputProtocol: "json" });
    const employee = await service.createEmployee({
      id: "session-worker",
      identity: { displayName: "Session Worker", background: "Maintains ordered context.", responsibilities: ["Respond in order"] },
      providerId: "session-provider"
    });
    const seed = await service.invokeEmployee(employee.id, { message: "Start session" });

    const first = service.invokeEmployee(employee.id, { message: "Second turn", sessionId: seed.session.id });
    const second = service.invokeEmployee(employee.id, { message: "Third turn", sessionId: seed.session.id });
    await secondStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = service.getActivitySnapshot().instances.filter(
      (instance) => instance.sessionId === seed.session.id && ["running", "waiting", "queued"].includes(instance.status)
    );
    expect(calls).toBe(2);
    expect(queued.map((instance) => instance.status).sort()).toEqual(["running", "waiting"]);
    expect(queued.find((instance) => instance.status === "waiting")?.phase).toBe("waiting-session");

    releaseSecond();
    await thirdStarted;
    expect(calls).toBe(3);
    releaseThird();
    await Promise.all([first, second]);
    expect(service.getSession(seed.session.id).messages).toHaveLength(6);
  });

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

  it("binds one Employee to a project role with a version-pinned Skill subset and Session", async () => {
    const projectRoot = temporaryRoot();
    const providerInvocations: Array<{ cwd: string; projectRoot?: string }> = [];
    const providers: ProviderRegistry = new Map([["mock", {
      id: "mock",
      validate: () => [],
      invoke: async (invocation) => {
        const context = invocation.templateContext.run as { projectRoot?: string };
        providerInvocations.push({ cwd: invocation.cwd, projectRoot: context.projectRoot });
        const role = invocation.templateContext.role as { identity?: { displayName?: string } };
        const input = invocation.templateContext.input as { message?: string };
        return {
          stdout: JSON.stringify({ message: `${role.identity?.displayName ?? "Employee"} received: ${input.message ?? "request"}.` }),
          stderr: "",
          durationMs: 1
        };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.createSkill({
      id: "browser-e2e-validation",
      description: "Validate browser behavior.",
      instructions: "BROWSER_E2E_SKILL_MARKER"
    });
    await service.createSkill({
      id: "project-visual-style",
      description: "Apply one optional project style.",
      instructions: "PROJECT_STYLE_MUST_NOT_BE_ACTIVE"
    });
    const employee = await service.createEmployee({
      id: "shared-tester",
      identity: { displayName: "Shared Tester", background: "Independent QA.", responsibilities: ["Verify behavior"] },
      systemPrompt: "BASE_TESTER_PROMPT",
      skills: ["browser-e2e-validation", "project-visual-style"]
    });
    await service.createProject({
      id: "cart-review",
      name: "Cart Review",
      description: "Review the shopping-cart project.",
      rootPath: projectRoot,
      descriptorPath: path.join(projectRoot, "multi-agent.project.yaml"),
      connector: { kind: "worktree-review", config: {} },
      roles: [{
        id: "tester",
        displayName: "Project Tester",
        description: "Run browser acceptance.",
        requiredSkills: ["browser-e2e-validation"],
        optionalSkills: ["project-visual-style"],
        instructions: "PROJECT_ROLE_POLICY_MARKER",
        permissions: { write: "none" }
      }]
    });
    const binding = await service.saveProjectBinding("cart-review", {
      roles: [{
        roleId: "tester",
        employeeId: employee.id,
        skills: ["browser-e2e-validation"],
        updatePolicy: "compatible"
      }]
    });
    expect(binding).toMatchObject({ projectVersion: 1, version: 1 });
    expect(binding.roles[0]?.skills).toEqual([{ id: "browser-e2e-validation", config: {}, enabled: true }]);

    const first = await service.invokeProjectRole("cart-review", "tester", { message: "Check the running page" });
    expect(first.session.assignment).toMatchObject({
      projectId: "cart-review",
      projectVersion: 1,
      projectBindingVersion: 1,
      roleId: "tester"
    });
    const context = await service.getEmployeeContext(employee.id, first.session.id);
    expect(context.layers.skills.map((skill) => skill.id)).toEqual(["browser-e2e-validation"]);
    expect(context.effectivePrompt?.combined).toContain("BASE_TESTER_PROMPT");
    expect(context.effectivePrompt?.combined).toContain("PROJECT_ROLE_POLICY_MARKER");
    expect(context.effectivePrompt?.combined).toContain("BROWSER_E2E_SKILL_MARKER");
    expect(context.effectivePrompt?.combined).not.toContain("PROJECT_STYLE_MUST_NOT_BE_ACTIVE");

    const versionTwo = await service.updateEmployee(employee.id, {
      identity: { ...employee.identity, displayName: "Senior Shared Tester" },
      systemPrompt: "UPDATED_TESTER_PROMPT"
    });
    expect(versionTwo.version).toBe(2);
    const refresh = await service.refreshProjectBinding("cart-review");
    expect(refresh.changed).toBe(true);
    expect(refresh.binding.roles[0]?.employeeVersion).toBe(2);
    expect(refresh.roles[0]?.status).toBe("updated");

    const continued = await service.invokeProjectRole("cart-review", "tester", {
      message: "Continue the pinned review",
      sessionId: first.session.id
    });
    expect(continued.session.assignment?.projectBindingVersion).toBe(1);
    expect(continued.message).toContain("Shared Tester received");
    expect(continued.message).not.toContain("Senior Shared Tester received");
    const fresh = await service.invokeProjectRole("cart-review", "tester", { message: "Start a new review" });
    expect(fresh.session.assignment?.projectBindingVersion).toBe(2);
    expect(fresh.message).toContain("Senior Shared Tester received");
    expect(providerInvocations).toHaveLength(3);
    expect(providerInvocations.every((invocation) => invocation.cwd === projectRoot)).toBe(true);
    expect(providerInvocations.every((invocation) => invocation.projectRoot === projectRoot)).toBe(true);
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
