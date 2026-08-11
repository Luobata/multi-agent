import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderExecutionError } from "../src/core/errors.js";
import { createDefaultProviderRegistry, type ProviderRegistry } from "../src/runtime/providers.js";
import type { JsonObject, RoleVerdictDefinition } from "../src/core/types.js";
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
  it("keeps passive MCP discovery read-only and scaffolds only after explicit connection", async () => {
    const dataRoot = temporaryRoot();
    const externalRoot = temporaryRoot();
    const descriptorPath = path.join(externalRoot, "multi-agent.project.yaml");
    const service = await WorkbenchService.open({ dataRoot });

    await service.recordPassiveProjectAccess({ rootPath: externalRoot, projectKey: "vibe-docing" });
    expect(fs.existsSync(descriptorPath)).toBe(false);

    const project = await service.connectProject({
      rootPath: externalRoot,
      createDescriptorIfMissing: true,
      projectIdHint: "vibe-docing",
      projectNameHint: "Vibe Docing"
    });

    expect(fs.existsSync(descriptorPath)).toBe(true);
    expect(project).toMatchObject({ id: "vibe-docing", name: "Vibe Docing", connector: { kind: "mcp" } });
    expect(service.listPassiveProjectAccesses()[0]).toMatchObject({ linkedProjectId: "vibe-docing" });
  });

  it("persists and merges MCP project keys with their observed root", async () => {
    const dataRoot = temporaryRoot();
    const externalRoot = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot });

    await service.recordPassiveProjectAccess({ rootPath: externalRoot });
    await service.recordPassiveProjectAccess({ projectKey: "source-alias" });
    expect(service.listPassiveProjectAccesses()).toHaveLength(2);

    await service.recordPassiveProjectAccess({ rootPath: externalRoot, projectKey: "source-alias" });
    expect(service.listPassiveProjectAccesses()).toEqual([
      expect.objectContaining({
        rootPath: externalRoot,
        projectKeys: ["source-alias"],
        transport: "mcp",
        requestCount: 3,
        linkedProjectId: undefined
      })
    ]);

    await service.createProject({
      id: "observed-project",
      name: "Observed Project",
      rootPath: externalRoot,
      descriptorPath: path.join(externalRoot, "multi-agent.project.yaml"),
      roles: [{ id: "reviewer" }]
    });
    expect(service.listPassiveProjectAccesses()[0]).toMatchObject({
      rootPath: externalRoot,
      projectKeys: ["source-alias"],
      requestCount: 3,
      linkedProjectId: "observed-project"
    });

    const reopened = await WorkbenchService.open({ dataRoot });
    expect(reopened.listPassiveProjectAccesses()[0]).toMatchObject({
      rootPath: externalRoot,
      projectKeys: ["source-alias"],
      requestCount: 3,
      linkedProjectId: "observed-project"
    });
  });

  it("persists an idempotent key-only migration from historical MCP Invocations", async () => {
    const dataRoot = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot });
    await service.createEmployee({
      id: "legacy-mcp-worker",
      identity: { displayName: "Legacy MCP Worker", background: "Tests migration.", responsibilities: ["Respond"] }
    });
    await service.invokeEmployee(
      "legacy-mcp-worker",
      { message: "First historical request" },
      { kind: "mcp", project: "vibe-docing", caller: "yaochenghao" }
    );
    await service.invokeEmployee(
      "legacy-mcp-worker",
      { message: "Second historical request" },
      { kind: "mcp", project: "vibe-docing", caller: "yaochenghao" }
    );
    await service.invokeEmployee(
      "legacy-mcp-worker",
      { message: "Non-MCP metadata must not migrate" },
      { kind: "http", project: "ignored-http-project" }
    );

    const statePath = path.join(dataRoot, "state.json");
    const legacy = JSON.parse(fs.readFileSync(statePath, "utf8")) as { passiveProjectAccesses?: unknown };
    delete legacy.passiveProjectAccesses;
    fs.writeFileSync(statePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const migrated = await WorkbenchService.open({ dataRoot });
    expect(migrated.listPassiveProjectAccesses()).toEqual([
      expect.objectContaining({
        rootPath: undefined,
        projectKeys: ["vibe-docing"],
        displayName: "vibe-docing",
        requestCount: 2,
        linkedProjectId: undefined
      })
    ]);
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      passiveProjectAccesses?: Record<string, { projectKeys?: string[]; requestCount?: number }>;
    };
    expect(Object.values(persisted.passiveProjectAccesses ?? {})).toEqual([
      expect.objectContaining({ projectKeys: ["vibe-docing"], requestCount: 2 })
    ]);

    const reopened = await WorkbenchService.open({ dataRoot });
    expect(reopened.listPassiveProjectAccesses()[0]).toMatchObject({
      projectKeys: ["vibe-docing"],
      requestCount: 2
    });

    const connectedRoot = temporaryRoot();
    await reopened.createProject({
      id: "vibe-docing",
      name: "Vibe Docing",
      rootPath: connectedRoot,
      descriptorPath: path.join(connectedRoot, "multi-agent.project.yaml"),
      roles: [{ id: "programmer" }]
    });
    expect(reopened.listPassiveProjectAccesses()[0]).toMatchObject({
      rootPath: undefined,
      projectKeys: ["vibe-docing"],
      linkedProjectId: "vibe-docing"
    });
  });

  it("migrates the retired relay retry/session experiment before materializing a new Run", async () => {
    const dataRoot = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot });
    await service.putProvider("claude-relay", {
      adapter: "command",
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({ message: 'relay recovered' }))"],
      outputProtocol: "json"
    });

    const statePath = path.join(dataRoot, "state.json");
    const legacy = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    const legacyRelay = legacy.providers["claude-relay"]!;
    legacyRelay.args = [
      ...legacyRelay.args as string[],
      "--max-budget-usd",
      "3"
    ];
    legacyRelay.retry = {
      initialDelayMs: 2_000,
      maxDelayMs: 30_000,
      multiplier: 2,
      jitterRatio: 0.2
    };
    legacyRelay.session = {
      idArgs: ["--session-id", "{{providerSession.id}}"],
      resumeArgs: ["--resume", "{{providerSession.id}}"],
      resumeInputTemplate: "Continue the interrupted Provider Session.",
      maxReconnects: 3,
      initialDelayMs: 2_000,
      maxDelayMs: 30_000,
      multiplier: 2,
      jitterRatio: 0.2
    };
    fs.writeFileSync(statePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const reopened = await WorkbenchService.open({ dataRoot });
    const migrated = reopened.listProviders().find((provider) => provider.id === "claude-relay")!.definition;
    expect(migrated).not.toHaveProperty("retry");
    expect(migrated).not.toHaveProperty("session");
    expect(migrated.args).not.toContain("--max-budget-usd");

    const employee = await reopened.createEmployee({
      id: "relay-recovery-worker",
      identity: {
        displayName: "Relay Recovery Worker",
        background: "Verifies Provider state compatibility.",
        responsibilities: ["Return one structured response"]
      },
      providerId: "claude-relay",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: { message: { type: "string" } }
      }
    });
    const result = await reopened.invokeEmployee(employee.id, { message: "Verify compatibility" });
    expect(result.status).toBe("passed");
    expect(result.output).toEqual({ message: "relay recovered" });

    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(persisted.providers["claude-relay"]).not.toHaveProperty("retry");
    expect(persisted.providers["claude-relay"]).not.toHaveProperty("session");
  });

  it("keeps unknown relay recovery shapes fail-closed", async () => {
    const dataRoot = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot });
    await service.putProvider("claude-relay", {
      adapter: "command",
      command: process.execPath,
      args: ["-e", "process.stdout.write('{}')"],
      outputProtocol: "json"
    });

    const statePath = path.join(dataRoot, "state.json");
    const legacy = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    legacy.providers["claude-relay"]!.retry = { arbitraryExecutionPolicy: true };
    fs.writeFileSync(statePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const reopened = await WorkbenchService.open({ dataRoot });
    const provider = reopened.listProviders().find((candidate) => candidate.id === "claude-relay")!.definition;
    expect(provider).toHaveProperty("retry");
    expect(createDefaultProviderRegistry().get("command")?.validate({
      providerId: "claude-relay",
      definition: provider,
      projectRoot: dataRoot
    })).toContain("provider claude-relay command adapter does not support property retry");
  });

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

  it("starts a multi-agent workflow asynchronously and exposes durable invocation status", async () => {
    let started = () => {};
    let release = () => {};
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    const providerGate = new Promise<void>((resolve) => { release = resolve; });
    const providers: ProviderRegistry = new Map([["slow", {
      id: "slow",
      validate: () => [],
      invoke: async () => {
        started();
        await providerGate;
        return { stdout: JSON.stringify({ message: "Async work completed." }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("slow-provider", { adapter: "slow", model: "slow-test-model", outputProtocol: "json" });
    const employee = await service.createEmployee({
      id: "async-worker",
      identity: { displayName: "Async Worker", background: "Runs in the background.", responsibilities: ["Respond"] },
      providerId: "slow-provider"
    });
    await service.createWorkflow({
      id: "async-flow",
      nodes: [{ id: "respond", employeeId: employee.id }]
    });

    const receipt = await service.startWorkbenchWorkflow("async-flow", { message: "Start without blocking" });
    expect(receipt.runId).toBe(receipt.invocation.runId);
    expect(receipt.invocation.status).toBe("queued");
    await providerStarted;
    expect((await service.getInvocationDetail(receipt.invocation.id)).invocation.status).toBe("running");

    release();
    const completed = await service.waitForInvocation(receipt.invocation.id);
    expect(completed.invocation.status).toBe("completed");
    expect(completed.instances[0]?.status).toBe("completed");
    expect(completed.run).toMatchObject({ id: receipt.runId, status: "passed" });
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

  it("classifies runs by category and project in listRuns", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await service.createSkill({ id: "noop", description: "noop", instructions: "Respond." });
    const employee = await service.createEmployee({
      id: "classify-worker",
      identity: { displayName: "Classify Worker", background: "Test", responsibilities: ["Respond"] },
      skills: [{ id: "noop", config: {} }],
      providerId: "mock"
    });

    await service.invokeEmployee(
      employee.id,
      { message: "single task" },
      { kind: "mcp", project: "demo-project", taskId: "req-102" }
    );

    await service.createWorkflow({
      id: "graph-flow",
      description: "Graph flow.",
      nodes: [{ id: "review", employeeId: employee.id, needs: [], with: {} }]
    });
    await service.runWorkbenchWorkflow("graph-flow", {}, { kind: "workbench" });

    const runs = await service.listRuns() as Array<{ id: string; category: string; project?: string; taskId?: string; trigger?: string; workflow: string }>;
    const single = runs.find((run) => run.workflow.startsWith("direct-"));
    const graph = runs.find((run) => run.workflow === "graph-flow");

    expect(single?.category).toBe("single");
    expect(single?.project).toBe("demo-project");
    expect(single?.taskId).toBe("req-102");
    expect(single?.trigger).toBe("mcp");
    const singleDetail = await service.getRun(single!.id) as { taskId?: string; project?: string };
    expect(singleDetail).toMatchObject({ taskId: "req-102", project: "demo-project" });
    expect(graph?.category).toBe("graph");
    expect(graph?.trigger).toBe("workbench");
  });

  it("falls back to run architecture when no invocation is correlated", async () => {
    const root = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot: root });
    const runDir = path.join(root, "artifacts", "runs", "run-orphan-1");
    await fs.promises.mkdir(runDir, { recursive: true });
    await fs.promises.writeFile(path.join(runDir, "run.json"), JSON.stringify({
      id: "run-orphan-1",
      workflow: "direct-ghost",
      architecture: "graph",
      artifactDir: runDir,
      status: "passed",
      createdAt: "2026-08-06T00:00:00.000Z",
      nodes: {}
    }));
    const runs = await service.listRuns() as Array<{ category: string; project?: string; trigger?: string; id: string }>;
    const orphan = runs.find((run) => run.id === "run-orphan-1");
    expect(orphan?.category).toBe("single");
    expect(orphan?.project).toBeUndefined();
    expect(orphan?.trigger).toBeUndefined();
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

  it("versions Management Policies and runs a Supervisor Workflow as a dynamic execution graph", async () => {
    const providers: ProviderRegistry = new Map([["scripted-supervisor", {
      id: "scripted-supervisor",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        const round = Number((invocation.templateContext.node as { with?: { __supervisorRound?: number } }).with?.__supervisorRound ?? 0);
        if (role === "supervisor" && round === 1) {
          return {
            stdout: JSON.stringify({
              action: "delegate",
              summary: "Collect specialist evidence.",
              assignments: [{ roleId: "researcher", task: "Research the supplied request." }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (role === "supervisor") {
          return {
            stdout: JSON.stringify({ action: "finish", summary: "Evidence accepted.", result: { answer: "complete" } }),
            stderr: "",
            durationMs: 1
          };
        }
        return { stdout: JSON.stringify({ message: "Research complete." }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("scripted-provider", {
      adapter: "scripted-supervisor",
      model: "supervisor-test-model",
      outputProtocol: "json"
    });
    const manager = await service.createEmployee({
      id: "team-manager",
      identity: { displayName: "Team Manager", background: "Coordinates specialists.", responsibilities: ["Delegate", "Synthesize"] },
      providerId: "scripted-provider"
    });
    const researcher = await service.createEmployee({
      id: "team-researcher",
      identity: { displayName: "Team Researcher", background: "Collects evidence.", responsibilities: ["Research"] },
      providerId: "scripted-provider"
    });
    const policy = await service.createManagementPolicy({
      id: "evidence-manager",
      displayName: "Evidence Manager",
      description: "Delegate research before synthesis.",
      allowedRoleIds: ["researcher"],
      instructions: "Delegate evidence collection and finish only after reviewing it.",
      limits: { maxRounds: 4, maxDelegations: 4, maxParallelDelegations: 2, maxDurationMs: 60_000 }
    });
    const workflow = await service.createWorkflow({
      id: "supervised-research",
      architecture: "supervisor",
      description: "A dynamically managed research team.",
      supervisor: { employeeId: manager.id },
      managementPolicy: { id: policy.id },
      members: [{ roleId: "researcher", description: "Collect evidence.", employeeId: researcher.id }]
    });
    expect(workflow).toMatchObject({
      architecture: "supervisor",
      managementPolicy: { id: policy.id, version: 1 },
      supervisor: { employeeVersion: 1 }
    });
    const policyV2 = await service.updateManagementPolicy(policy.id, { instructions: "A newer policy adopted by the default latest updatePolicy at run time." });
    expect(policyV2.version).toBe(2);
    // The stored workflow definition still pins v1; latest resolution happens per-run, not by rewriting it.
    expect(service.getWorkflow(workflow.id)).toMatchObject({ managementPolicy: { id: policy.id, version: 1 } });

    const result = await service.runWorkbenchWorkflow(workflow.id, { message: "Investigate this topic" });
    expect(result.run).toMatchObject({
      architecture: "supervisor",
      status: "passed",
      output: { summary: "Evidence accepted.", result: { answer: "complete" }, rounds: 2, delegations: 1 }
    });
    expect(Object.keys(result.run.nodes)).toEqual(["supervisor-r1", "researcher-r1-1", "supervisor-r2"]);
    const invocation = service.getActivitySnapshot().invocations.find((item) => item.runId === result.run.id)!;
    const detail = await service.getInvocationDetail(invocation.id);
    expect(detail.invocation.status).toBe("completed");
    // updatePolicy defaults to "latest", so the run adopts the newest policy version (v2) even though
    // the stored workflow still pins v1.
    expect(detail.invocation.executionSnapshot).toMatchObject({
      workflow: { id: workflow.id, version: 1, architecture: "supervisor" },
      managementPolicy: { id: policy.id, version: 2 }
    });
    expect(detail.instances.map((instance) => [instance.nodeId, instance.kind, instance.roleId, instance.round])).toEqual([
      ["supervisor-r1", "supervisor", "supervisor", 1],
      ["researcher-r1-1", "member", "researcher", 1],
      ["supervisor-r2", "supervisor", "supervisor", 2]
    ]);
    const events = fs.readFileSync(path.join(result.runDir, "events.jsonl"), "utf8");
    expect(events.match(/"type":"node.scheduled"/g)).toHaveLength(3);
    await expect(service.archiveManagementPolicy(policy.id)).rejects.toThrow(/used by active workflows: supervised-research/);
    await service.archiveWorkflow(workflow.id);
    await expect(service.archiveManagementPolicy(policy.id)).resolves.toMatchObject({ status: "archived", version: 3 });
    await expect(service.restoreManagementPolicy(policy.id)).resolves.toMatchObject({ status: "active", version: 4 });
  });

  it("distills a memory from a passed multi-node Supervisor Workflow run", async () => {
    const providers: ProviderRegistry = new Map([["scripted-supervisor", {
      id: "scripted-supervisor",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        const round = Number((invocation.templateContext.node as { with?: { __supervisorRound?: number } }).with?.__supervisorRound ?? 0);
        if (role === "supervisor" && round === 1) {
          return { stdout: JSON.stringify({ action: "delegate", summary: "Collect evidence.", assignments: [{ roleId: "researcher", task: "Research it." }] }), stderr: "", durationMs: 1 };
        }
        if (role === "supervisor") {
          return { stdout: JSON.stringify({ action: "finish", summary: "Done.", result: { answer: "ok" } }), stderr: "", durationMs: 1 };
        }
        return { stdout: JSON.stringify({ message: "Research complete." }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("scripted-provider", { adapter: "scripted-supervisor", model: "supervisor-test-model", outputProtocol: "json" });
    const manager = await service.createEmployee({
      id: "mem-manager",
      identity: { displayName: "Mem Manager", background: "Coordinates.", responsibilities: ["Delegate"] },
      providerId: "scripted-provider"
    });
    const researcher = await service.createEmployee({
      id: "mem-researcher",
      identity: { displayName: "Mem Researcher", background: "Collects.", responsibilities: ["Research"] },
      providerId: "scripted-provider"
    });
    const policy = await service.createManagementPolicy({
      id: "mem-policy",
      displayName: "Mem Policy",
      description: "Delegate then finish.",
      allowedRoleIds: ["researcher"],
      instructions: "Delegate then finish.",
      limits: { maxRounds: 4, maxDelegations: 4, maxParallelDelegations: 2, maxDurationMs: 60_000 }
    });
    const workflow = await service.createWorkflow({
      id: "mem-supervised",
      architecture: "supervisor",
      description: "Team that produces a memory.",
      supervisor: { employeeId: manager.id },
      managementPolicy: { id: policy.id },
      members: [{ roleId: "researcher", description: "Collect.", employeeId: researcher.id }]
    });

    const result = await service.runWorkbenchWorkflow(workflow.id, { message: "Investigate" });
    expect(result.run.status).toBe("passed");
    expect(Object.keys(result.run.nodes).length).toBeGreaterThan(1);

    // Extraction is a fire-and-forget side path; poll until the supervisor's scope appears.
    const scopeKey = `employee:${manager.id}`;
    let scopes: Array<{ scopeKey: string; count: number }> = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      scopes = await service.listMemoryScopes();
      if (scopes.some((entry) => entry.scopeKey === scopeKey && entry.count > 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scopes.some((entry) => entry.scopeKey === scopeKey && entry.count > 0)).toBe(true);

    const records = await service.listMemoryByScope(scopeKey);
    expect(records.length).toBeGreaterThan(0);
    const [first] = records;
    expect(first).toBeDefined();
    expect(first!.kind).toBe("run-summary");
    expect(first!.provenance.runId).toBe(result.run.id);
  });

  it("runs an MCP-triggered Supervisor Workflow in the caller project root", async () => {
    const callerRoot = temporaryRoot();
    const providerCwds: string[] = [];
    const providers: ProviderRegistry = new Map([["cwd-supervisor", {
      id: "cwd-supervisor",
      validate: () => [],
      invoke: async (invocation) => {
        providerCwds.push(invocation.cwd);
        return {
          stdout: JSON.stringify({ action: "finish", summary: "Caller root confirmed.", result: { cwd: invocation.cwd } }),
          stderr: "",
          durationMs: 1
        };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("cwd-provider", { adapter: "cwd-supervisor", outputProtocol: "json" });
    for (const id of ["cwd-manager", "cwd-worker"]) {
      await service.createEmployee({
        id,
        identity: { displayName: id, background: "Checks execution roots.", responsibilities: ["Work"] },
        providerId: "cwd-provider"
      });
    }
    await service.createManagementPolicy({
      id: "cwd-policy",
      description: "Allow a Supervisor to inspect the caller project root.",
      allowedRoleIds: ["worker"],
      instructions: "Inspect the caller project and finish with evidence.",
      completion: { requireDelegation: false }
    });
    await service.createWorkflow({
      id: "cwd-team",
      architecture: "supervisor",
      supervisor: { employeeId: "cwd-manager" },
      managementPolicy: { id: "cwd-policy" },
      members: [{ roleId: "worker", employeeId: "cwd-worker" }]
    });

    const result = await service.runWorkbenchWorkflow(
      "cwd-team",
      { message: "Inspect this project" },
      { kind: "mcp", project: "external-project" },
      { providerCwd: callerRoot }
    );
    expect(result.run.status).toBe("passed");
    const resolvedCallerRoot = fs.realpathSync(callerRoot);
    expect(providerCwds).toEqual([resolvedCallerRoot]);
    expect(result.run.output).toMatchObject({ result: { cwd: resolvedCallerRoot } });
  });

  it("repairs a malformed Supervisor decision inside the node attempt budget", async () => {
    let supervisorAttempts = 0;
    const prompts: string[] = [];
    const providers: ProviderRegistry = new Map([["repairing-supervisor", {
      id: "repairing-supervisor",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        if (role !== "supervisor") return { stdout: JSON.stringify({ message: "done" }), stderr: "", durationMs: 1 };
        supervisorAttempts += 1;
        prompts.push(invocation.prompt);
        return supervisorAttempts === 1
          ? { stdout: JSON.stringify({ action: "finish" }), stderr: "", durationMs: 1 }
          : {
              stdout: JSON.stringify({ action: "finish", summary: "Repaired decision.", result: { repaired: true } }),
              stderr: "",
              durationMs: 1
            };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("repairing-provider", { adapter: "repairing-supervisor", outputProtocol: "json" });
    await service.createEmployee({
      id: "repair-manager",
      identity: { displayName: "Repair Manager", background: "Repairs output.", responsibilities: ["Manage"] },
      providerId: "repairing-provider",
      maxAttempts: 2
    });
    await service.createEmployee({
      id: "repair-worker",
      identity: { displayName: "Repair Worker", background: "Provides a member slot.", responsibilities: ["Work"] },
      providerId: "repairing-provider"
    });
    await service.createManagementPolicy({
      id: "repair-policy",
      description: "Allow malformed Supervisor decisions to be repaired locally.",
      allowedRoleIds: ["worker"],
      instructions: "Return one schema-valid decision.",
      completion: { requireDelegation: false }
    });
    await service.createWorkflow({
      id: "repair-team",
      architecture: "supervisor",
      supervisor: { employeeId: "repair-manager" },
      managementPolicy: { id: "repair-policy" },
      members: [{ roleId: "worker", employeeId: "repair-worker" }]
    });

    const result = await service.runWorkbenchWorkflow("repair-team", { message: "Return a valid decision" });
    expect(result.run.status).toBe("passed");
    expect(result.run.nodes["supervisor-r1"]).toMatchObject({ status: "passed", attempts: 2 });
    expect(prompts[1]).toContain("Previous structured-decision validation error");
    expect(prompts[1]).toContain("output schema validation failed");
  });

  it("repairs a malformed delegated specialist result inside the Employee attempt budget", async () => {
    let workerAttempts = 0;
    const workerPrompts: string[] = [];
    const providers: ProviderRegistry = new Map([["repairing-member", {
      id: "repairing-member",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        const round = Number((invocation.templateContext.node as { with?: { __supervisorRound?: number } }).with?.__supervisorRound ?? 0);
        if (role === "supervisor") {
          return round === 1
            ? { stdout: JSON.stringify({ action: "delegate", assignments: [{ roleId: "worker", task: "Return strict output." }] }), stderr: "", durationMs: 1 }
            : { stdout: JSON.stringify({ action: "finish", summary: "Worker repaired its output.", result: { repaired: true } }), stderr: "", durationMs: 1 };
        }
        workerAttempts += 1;
        workerPrompts.push(invocation.prompt);
        return workerAttempts === 1
          ? { stdout: JSON.stringify({ message: "done", unexpected: true }), stderr: "", durationMs: 1 }
          : { stdout: JSON.stringify({ message: "done" }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("repairing-member-provider", { adapter: "repairing-member", outputProtocol: "json" });
    await service.createEmployee({
      id: "member-repair-manager",
      identity: { displayName: "Member Repair Manager", background: "Coordinates.", responsibilities: ["Manage"] },
      providerId: "repairing-member-provider"
    });
    await service.createEmployee({
      id: "member-repair-worker",
      identity: { displayName: "Member Repair Worker", background: "Repairs strict output.", responsibilities: ["Work"] },
      providerId: "repairing-member-provider",
      maxAttempts: 2,
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: { message: { type: "string" } }
      }
    });
    await service.createManagementPolicy({
      id: "member-repair-policy",
      description: "Repair specialist output once.",
      allowedRoleIds: ["worker"],
      instructions: "Delegate once, then finish.",
      completion: { requireDelegation: true }
    });
    await service.createWorkflow({
      id: "member-repair-team",
      architecture: "supervisor",
      supervisor: { employeeId: "member-repair-manager" },
      managementPolicy: { id: "member-repair-policy" },
      members: [{ roleId: "worker", employeeId: "member-repair-worker" }]
    });

    const result = await service.runWorkbenchWorkflow("member-repair-team", { message: "Repair member output" });
    expect(result.run.status).toBe("passed");
    expect(result.run.nodes["worker-r1-1"]).toMatchObject({ status: "passed", attempts: 2 });
    expect(workerPrompts[1]).toContain("Previous structured-output validation error");
    expect(workerPrompts[1]).toContain("additional properties");
  });

  it("opens the Supervisor circuit after a deterministic member budget failure", async () => {
    let workerCalls = 0;
    const providers: ProviderRegistry = new Map([["budget-circuit", {
      id: "budget-circuit",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        if (role === "supervisor") {
          return {
            stdout: JSON.stringify({ action: "delegate", assignments: [{ roleId: "designer", task: "Repeat the same expensive design task." }] }),
            stderr: "",
            durationMs: 1
          };
        }
        workerCalls += 1;
        throw new ProviderExecutionError("provider design exhausted its configured budget", "", "", {
          kind: "budget",
          retryable: false
        });
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("budget-circuit-provider", { adapter: "budget-circuit", outputProtocol: "json" });
    await service.createEmployee({
      id: "budget-manager",
      identity: { displayName: "Budget Manager", background: "Coordinates.", responsibilities: ["Manage"] },
      providerId: "budget-circuit-provider"
    });
    await service.createEmployee({
      id: "budget-designer",
      identity: { displayName: "Budget Designer", background: "Designs.", responsibilities: ["Design"] },
      providerId: "budget-circuit-provider",
      maxAttempts: 3
    });
    await service.createManagementPolicy({
      id: "budget-circuit-policy",
      description: "Stop deterministic Provider repeats.",
      allowedRoleIds: ["designer"],
      instructions: "Do not repeat deterministic technical failures.",
      completion: { requireDelegation: true }
    });
    await service.createWorkflow({
      id: "budget-circuit-team",
      architecture: "supervisor",
      supervisor: { employeeId: "budget-manager" },
      managementPolicy: { id: "budget-circuit-policy" },
      members: [{ roleId: "designer", employeeId: "budget-designer" }]
    });

    const result = await service.runWorkbenchWorkflow("budget-circuit-team", { message: "Respect the budget circuit" });
    expect(workerCalls).toBe(1);
    expect(result.run.status).toBe("blocked");
    expect(result.run.output).toMatchObject({ reason: expect.stringContaining("technical circuit opened for designer") });
    expect(service.getActivitySnapshot().instances.find((instance) => instance.employeeId === "budget-designer")?.failure)
      .toEqual({ category: "provider", kind: "budget", retryable: false });
  });

  it("does not execute an unchanged blocked delegation repeatedly", async () => {
    const providers: ProviderRegistry = new Map([["blocked-dedup-supervisor", {
      id: "blocked-dedup-supervisor",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        const round = Number((invocation.templateContext.node as { with?: { __supervisorRound?: number } }).with?.__supervisorRound ?? 0);
        if (role !== "supervisor") {
          return { stdout: JSON.stringify({ message: "No runnable test target.", verdict: "Block" }), stderr: "", durationMs: 1 };
        }
        if (round <= 2) {
          return {
            stdout: JSON.stringify({
              action: "delegate",
              assignments: [{ roleId: "tester", task: "Run the unchanged test target.", workKind: "test" }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        return {
          stdout: JSON.stringify({ action: "finish", summary: "Disclose the unavailable test target.", result: { risk: "test unavailable" } }),
          stderr: "",
          durationMs: 1
        };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("blocked-dedup-provider", { adapter: "blocked-dedup-supervisor", outputProtocol: "json" });
    await service.createEmployee({
      id: "dedup-manager",
      identity: { displayName: "Dedup Manager", background: "Stops repeated blockers.", responsibilities: ["Manage"] },
      providerId: "blocked-dedup-provider"
    });
    await service.createEmployee({
      id: "dedup-tester",
      identity: { displayName: "Dedup Tester", background: "Reports blockers.", responsibilities: ["Test"] },
      providerId: "blocked-dedup-provider",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message", "verdict"],
        properties: { message: { type: "string" }, verdict: { enum: ["Pass", "Block"] } }
      },
      verdict: { path: "verdict", pass: ["Pass"], block: ["Block"] }
    });
    await service.createManagementPolicy({
      id: "dedup-policy",
      description: "Prevent unchanged blocked test assignments from looping.",
      allowedRoleIds: ["tester"],
      instructions: "Do not repeat an unchanged blocked test assignment.",
      limits: { maxRounds: 4, maxDelegations: 4, maxParallelDelegations: 1, maxDurationMs: 60_000 }
    });
    await service.createWorkflow({
      id: "dedup-team",
      architecture: "supervisor",
      supervisor: { employeeId: "dedup-manager" },
      managementPolicy: { id: "dedup-policy" },
      members: [{ roleId: "tester", employeeId: "dedup-tester" }]
    });

    const result = await service.runWorkbenchWorkflow("dedup-team", { message: "Avoid an endless blocker" });
    expect(result.run.status).toBe("passed");
    expect(Object.keys(result.run.nodes).filter((id) => id.startsWith("tester-r"))).toEqual(["tester-r1-1"]);
    expect(result.run.output).toMatchObject({ rounds: 3, delegations: 1 });
    expect(fs.readFileSync(path.join(result.runDir, "events.jsonl"), "utf8"))
      .toContain("supervisor.delegation.rejected");
  });

  it("marks Supervisor policy exhaustion as blocked instead of a technical failure", async () => {
    const providers: ProviderRegistry = new Map([["non-converging", {
      id: "non-converging",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        return role === "supervisor"
          ? {
              stdout: JSON.stringify({ action: "delegate", assignments: [{ roleId: "worker", task: "Continue." }] }),
              stderr: "",
              durationMs: 1
            }
          : { stdout: JSON.stringify({ message: "Worked." }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("non-converging-provider", { adapter: "non-converging", outputProtocol: "json" });
    for (const id of ["loop-manager", "loop-worker"]) {
      await service.createEmployee({
        id,
        identity: { displayName: id, background: "Exercises policy limits.", responsibilities: ["Work"] },
        providerId: "non-converging-provider"
      });
    }
    const policy = await service.createManagementPolicy({
      id: "one-round",
      allowedRoleIds: ["worker"],
      instructions: "Try to delegate.",
      limits: { maxRounds: 1, maxDelegations: 2, maxParallelDelegations: 1, maxDurationMs: 60_000 }
    });
    await service.createWorkflow({
      id: "bounded-supervisor",
      architecture: "supervisor",
      supervisor: { employeeId: "loop-manager" },
      managementPolicy: { id: policy.id },
      members: [{ roleId: "worker", employeeId: "loop-worker" }]
    });
    const result = await service.runWorkbenchWorkflow("bounded-supervisor", { message: "Never converge" });
    expect(result.run.status).toBe("blocked");
    expect(result.run.output).toMatchObject({ reason: expect.stringContaining("round limit"), rounds: 1, delegations: 0 });
    const invocation = service.getActivitySnapshot().invocations.find((item) => item.runId === result.run.id);
    expect(invocation?.status).toBe("blocked");
    expect(service.getActivitySnapshot().instances.find((item) => item.runId === result.run.id)?.status).toBe("completed");
  });

  it("enforces the Supervisor duration deadline even when a Provider returns after ignoring abort", async () => {
    const providers: ProviderRegistry = new Map([["slow-supervisor", {
      id: "slow-supervisor",
      validate: () => [],
      invoke: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_050));
        return {
          stdout: JSON.stringify({ action: "finish", summary: "Late result.", result: { accepted: true } }),
          stderr: "",
          durationMs: 1_050
        };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("slow-supervisor-provider", { adapter: "slow-supervisor", outputProtocol: "json" });
    for (const id of ["deadline-manager", "deadline-worker"]) {
      await service.createEmployee({
        id,
        identity: { displayName: id, background: "Exercises duration limits.", responsibilities: ["Work"] },
        providerId: "slow-supervisor-provider"
      });
    }
    await service.createManagementPolicy({
      id: "one-second-supervision",
      allowedRoleIds: ["worker"],
      instructions: "Respect the bounded control-loop duration.",
      limits: { maxDurationMs: 1_000 }
    });
    await service.createWorkflow({
      id: "deadline-team",
      architecture: "supervisor",
      supervisor: { employeeId: "deadline-manager" },
      managementPolicy: { id: "one-second-supervision" },
      members: [{ roleId: "worker", employeeId: "deadline-worker" }]
    });

    const result = await service.runWorkbenchWorkflow("deadline-team", { message: "Respect the deadline" });
    expect(result.run.status).toBe("blocked");
    expect(result.run.output).toMatchObject({ reason: expect.stringContaining("duration limit"), rounds: 1 });
    expect(result.run.nodes["supervisor-r1"]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("deadline")
    });
  });

  it("runs without a wall-clock deadline when the policy omits maxDurationMs", async () => {
    // A slow supervisor that would have tripped the old fixed default: with no maxDurationMs the run
    // has no wall-clock deadline and completes on progress instead of being aborted by the clock.
    const providers: ProviderRegistry = new Map([["unbounded-supervisor", {
      id: "unbounded-supervisor",
      validate: () => [],
      invoke: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_050));
        return {
          stdout: JSON.stringify({ action: "finish", summary: "Delivered without a clock.", result: { accepted: true } }),
          stderr: "",
          durationMs: 1_050
        };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("unbounded-provider", { adapter: "unbounded-supervisor", outputProtocol: "json" });
    for (const id of ["unbounded-manager", "unbounded-worker"]) {
      await service.createEmployee({
        id,
        identity: { displayName: id, background: "Runs without a duration ceiling.", responsibilities: ["Work"] },
        providerId: "unbounded-provider"
      });
    }
    const policy = await service.createManagementPolicy({
      id: "unbounded-supervision",
      allowedRoleIds: ["worker"],
      instructions: "Keep working while progress is made; no fixed wall clock.",
      limits: { maxRounds: 3, maxDelegations: 4, maxParallelDelegations: 1 }
    });
    // The policy carries no absolute duration ceiling.
    expect(policy.limits.maxDurationMs).toBeUndefined();
    await service.createWorkflow({
      id: "unbounded-team",
      architecture: "supervisor",
      supervisor: { employeeId: "unbounded-manager" },
      managementPolicy: { id: "unbounded-supervision" },
      members: [{ roleId: "worker", employeeId: "unbounded-worker" }]
    });

    const result = await service.runWorkbenchWorkflow("unbounded-team", { message: "Deliver without a deadline" });
    expect(result.run.status).toBe("passed");
    expect(JSON.stringify(result.run.output)).not.toContain("duration limit");
  });

  it("allows a Supervisor to recover from a failed member while preserving the failed WorkInstance", async () => {
    const providers: ProviderRegistry = new Map([["recovering-supervisor", {
      id: "recovering-supervisor",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        const round = Number((invocation.templateContext.node as { with?: { __supervisorRound?: number } }).with?.__supervisorRound ?? 0);
        if (role === "member-worker") throw new Error("worker provider unavailable");
        return round === 1
          ? {
              stdout: JSON.stringify({ action: "delegate", assignments: [{ roleId: "worker", task: "Attempt the task." }] }),
              stderr: "",
              durationMs: 1
            }
          : {
              stdout: JSON.stringify({ action: "finish", summary: "Recovered with a bounded fallback.", result: { fallback: true } }),
              stderr: "",
              durationMs: 1
            };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("recovering-provider", { adapter: "recovering-supervisor", outputProtocol: "json" });
    for (const id of ["recovery-manager", "recovery-worker"]) {
      await service.createEmployee({
        id,
        identity: { displayName: id, background: "Tests recovery.", responsibilities: ["Work"] },
        providerId: "recovering-provider"
      });
    }
    await service.createManagementPolicy({
      id: "recover-worker",
      allowedRoleIds: ["worker"],
      instructions: "Observe worker failure and choose a fallback.",
      failure: { workerFailure: "observe-and-replan" }
    });
    await service.createWorkflow({
      id: "recovering-team",
      architecture: "supervisor",
      supervisor: { employeeId: "recovery-manager" },
      managementPolicy: { id: "recover-worker" },
      members: [{ roleId: "worker", employeeId: "recovery-worker" }]
    });
    const result = await service.runWorkbenchWorkflow("recovering-team", { message: "Recover this task" });
    expect(result.run.status).toBe("passed");
    expect(result.run.nodes["worker-r1-1"]?.status).toBe("failed");
    expect(result.run.nodes["supervisor-r2"]?.status).toBe("passed");
    expect(result.run.output).toMatchObject({ summary: "Recovered with a bounded fallback.", result: { fallback: true } });
    const invocation = service.getActivitySnapshot().invocations.find((item) => item.runId === result.run.id)!;
    expect(invocation.status).toBe("completed");
    expect(service.getActivitySnapshot().instances.find((instance) => instance.runId === result.run.id && instance.kind === "member")?.status).toBe("failed");
  });

  it("does not treat a blocked delegation as successful when the Management Policy requires every delegation to pass", async () => {
    const providers: ProviderRegistry = new Map([["blocking-supervisor", {
      id: "blocking-supervisor",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        const round = Number((invocation.templateContext.node as { with?: { __supervisorRound?: number } }).with?.__supervisorRound ?? 0);
        if (role === "supervisor") {
          return round === 1
            ? {
                stdout: JSON.stringify({ action: "delegate", assignments: [{ roleId: "reviewer", task: "Review the evidence." }] }),
                stderr: "",
                durationMs: 1
              }
            : {
                stdout: JSON.stringify({ action: "finish", summary: "Review considered.", result: { accepted: true } }),
                stderr: "",
                durationMs: 1
              };
        }
        return {
          stdout: JSON.stringify({ message: "Required evidence is missing.", verdict: "Block" }),
          stderr: "",
          durationMs: 1
        };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("blocking-provider", { adapter: "blocking-supervisor", outputProtocol: "json" });
    await service.createEmployee({
      id: "strict-manager",
      identity: { displayName: "Strict Manager", background: "Coordinates review.", responsibilities: ["Manage"] },
      providerId: "blocking-provider"
    });
    await service.createEmployee({
      id: "blocking-reviewer",
      identity: { displayName: "Blocking Reviewer", background: "Reviews evidence.", responsibilities: ["Review"] },
      providerId: "blocking-provider",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message", "verdict"],
        properties: { message: { type: "string" }, verdict: { enum: ["Pass", "Block"] } }
      },
      verdict: { path: "verdict", pass: ["Pass"], block: ["Block"] }
    });
    await service.createManagementPolicy({
      id: "all-delegations-must-pass",
      allowedRoleIds: ["reviewer"],
      instructions: "Delegate review and finish only if every delegation passes.",
      completion: { requireAllDelegationsSuccessful: true }
    });
    await service.createWorkflow({
      id: "strict-review-team",
      architecture: "supervisor",
      supervisor: { employeeId: "strict-manager" },
      managementPolicy: { id: "all-delegations-must-pass" },
      members: [{ roleId: "reviewer", employeeId: "blocking-reviewer" }]
    });

    const result = await service.runWorkbenchWorkflow("strict-review-team", { message: "Approve the release" });
    expect(result.run.nodes["reviewer-r1-1"]?.status).toBe("blocked");
    expect(result.run.status).toBe("blocked");
    expect(result.run.output).toMatchObject({ reason: expect.stringContaining("every delegation"), rounds: 2, delegations: 1 });
  });

  it("archives and restores shared Skills while preserving version history", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await service.createSkill({ id: "recoverable-skill", description: "Recoverable", instructions: "Keep history." });
    const archived = await service.archiveSkill("recoverable-skill");
    expect(archived).toMatchObject({ status: "archived", version: 2 });
    expect(service.listSkills().filter((skill) => skill.owner === "user")).toEqual([]);
    expect(service.listSkills(true)).toContainEqual(expect.objectContaining({ id: "recoverable-skill", status: "archived" }));
    const restored = await service.restoreSkill("recoverable-skill");
    expect(restored).toMatchObject({ status: "active", version: 3 });
    expect(service.listSkills().filter((skill) => skill.owner === "user")).toHaveLength(1);
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
    expect(left.listSkills().filter((skill) => skill.owner === "user").map((skill) => skill.id).sort()).toEqual(["left-skill", "right-skill"]);
    expect(right.listSkills().filter((skill) => skill.owner === "user").map((skill) => skill.id).sort()).toEqual(["left-skill", "right-skill"]);
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

  it("normalizes legacy Skill and Employee fields and protects the deterministic system Skill", async () => {
    const root = temporaryRoot();
    let service = await WorkbenchService.open({ dataRoot: root });
    await service.createSkill({
      id: "legacy-capability",
      description: "Legacy user-owned capability.",
      instructions: "Preserve this user Skill."
    });
    await service.createEmployee({
      id: "legacy-project-worker",
      identity: {
        displayName: "Legacy Project Worker",
        background: "Predates structured scope.",
        responsibilities: ["Work inside one project"],
        metadata: { internalProjectId: "legacy-project" }
      },
      skills: ["legacy-capability"]
    });

    const statePath = path.join(root, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      skills: Record<string, Record<string, unknown>>;
      skillHistory: Record<string, Array<Record<string, unknown>>>;
      employees: Record<string, { current: Record<string, unknown>; versions: Array<Record<string, unknown>> }>;
      employeeTemplates?: unknown;
    };
    delete state.skills["team-orchestration"];
    delete state.skillHistory["team-orchestration"];
    delete state.skills["legacy-capability"]?.owner;
    delete state.skills["legacy-capability"]?.injection;
    for (const version of state.skillHistory["legacy-capability"] ?? []) {
      delete version.owner;
      delete version.injection;
    }
    delete state.employeeTemplates;
    delete state.employees["legacy-project-worker"]?.current.capabilities;
    delete state.employees["legacy-project-worker"]?.current.scope;
    for (const version of state.employees["legacy-project-worker"]?.versions ?? []) {
      delete version.capabilities;
      delete version.scope;
    }
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    service = await WorkbenchService.open({ dataRoot: root });
    expect(service.listSkills(true)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "legacy-capability", owner: "user", injection: "none" }),
      expect.objectContaining({ id: "team-orchestration", owner: "system", injection: "supervisor", status: "active" })
    ]));
    expect(service.getEmployee("legacy-project-worker")).toMatchObject({
      capabilities: [],
      scope: { kind: "project", projectId: "legacy-project", projectVersion: 1 }
    });
    expect(service.snapshot().employeeTemplates).toEqual({});

    await expect(service.updateSkill("team-orchestration", { instructions: "User override" })).rejects.toThrow(/system skill/);
    await expect(service.archiveSkill("team-orchestration")).rejects.toThrow(/system skill/);
    await expect(service.restoreSkill("team-orchestration")).rejects.toThrow(/system skill/);
    await expect(service.createEmployee({
      id: "manual-supervisor-skill",
      identity: { displayName: "Manual", background: "Invalid binding.", responsibilities: ["Coordinate"] },
      skills: ["team-orchestration"]
    })).rejects.toThrow(/cannot be bound.*manually/);
  });

  it("keeps Employee Templates non-executable, versioned, and statically copied into Employees", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    const templateProjectRoot = temporaryRoot();
    await service.createProject({
      id: "template-project",
      name: "Template Project",
      rootPath: templateProjectRoot,
      descriptorPath: "/tmp/template-project/multi-agent.project.yaml",
      roles: [{ id: "builder", displayName: "Builder", description: "Build project changes.", instructions: "Build safely." }]
    });
    const firstTemplate = await service.createEmployeeTemplate({
      id: "backend-builder",
      displayName: "Backend builder",
      description: "Defaults for a project backend employee.",
      defaults: {
        identity: { background: "Builds backend systems.", responsibilities: ["Implement backend changes"] },
        systemPrompt: "BACKEND_TEMPLATE_V1",
        capabilities: ["code.backend", "quality.audit", "code.backend"],
        scope: { kind: "project", projectId: "template-project", projectVersion: 1 }
      }
    });
    expect(firstTemplate).toMatchObject({ version: 1, defaults: { capabilities: ["code.backend", "quality.audit"] } });

    const first = await service.createEmployeeFromTemplate("backend-builder", {
      id: "project-backend-one",
      identity: { displayName: "Project Backend One" }
    });
    expect(first).toMatchObject({
      version: 1,
      template: { id: "backend-builder", version: 1 },
      systemPrompt: "BACKEND_TEMPLATE_V1",
      scope: { kind: "project", projectId: "template-project", projectVersion: 1 },
      capabilities: ["code.backend", "quality.audit"]
    });

    const secondTemplate = await service.updateEmployeeTemplate("backend-builder", {
      defaults: {
        ...firstTemplate.defaults,
        systemPrompt: "BACKEND_TEMPLATE_V2",
        capabilities: [...(firstTemplate.defaults.capabilities ?? []), "quality.test"]
      }
    });
    const second = await service.createEmployeeFromTemplate("backend-builder", {
      id: "project-backend-two",
      templateVersion: secondTemplate.version,
      identity: { displayName: "Project Backend Two" }
    });
    expect(second).toMatchObject({
      template: { id: "backend-builder", version: 2 },
      systemPrompt: "BACKEND_TEMPLATE_V2",
      capabilities: ["code.backend", "quality.audit", "quality.test"]
    });
    expect(service.getEmployee(first.id)).toMatchObject({
      template: { id: "backend-builder", version: 1 },
      systemPrompt: "BACKEND_TEMPLATE_V1",
      version: 1
    });
    await service.updateEmployee(first.id, { description: "Explicit Employee-only update." });
    expect(service.getEmployee(first.id)).toMatchObject({
      template: { id: "backend-builder", version: 1 },
      systemPrompt: "BACKEND_TEMPLATE_V1",
      version: 2
    });
    await expect(service.createWorkflow({
      id: "template-is-not-an-employee",
      nodes: [{ id: "work", employeeId: "backend-builder" }]
    })).rejects.toThrow(/employee not found/);
    await service.updateProject("template-project", {
      id: "template-project",
      name: "Template Project",
      description: "Project version two.",
      rootPath: templateProjectRoot,
      descriptorPath: "/tmp/template-project/multi-agent.project.yaml",
      roles: [{ id: "builder", displayName: "Builder", description: "Build project changes.", instructions: "Build safely." }]
    });
    await expect(service.saveProjectBinding("template-project", {
      roles: [{ roleId: "builder", employeeId: first.id }]
    })).rejects.toThrow(/fixed to project template-project v1, not v2/);

    const archived = await service.archiveEmployeeTemplate("backend-builder");
    expect(archived).toMatchObject({ status: "archived", version: 3 });
    await expect(service.createEmployeeFromTemplate("backend-builder", {
      id: "archived-template-worker",
      identity: { displayName: "Archived Template Worker" }
    })).rejects.toThrow(/template backend-builder is archived/);
    const restored = await service.restoreEmployeeTemplate("backend-builder");
    expect(restored).toMatchObject({ status: "active", version: 4 });
    expect(service.getEmployeeTemplateVersions("backend-builder").map((version) => version.version)).toEqual([4, 3, 2, 1]);
  });

  async function createSupervisorTeam(service: WorkbenchService): Promise<void> {
    await service.createEmployee({
      id: "validator-lead",
      identity: { displayName: "Validator Lead", background: "Coordinates work.", responsibilities: ["Plan", "Deliver"] },
      capabilities: ["quality.audit"],
      providerId: "mock"
    });
    await service.createEmployee({
      id: "validator-tester",
      identity: { displayName: "Validator Tester", background: "Runs tests.", responsibilities: ["Test"] },
      capabilities: ["quality.test"],
      providerId: "mock"
    });
    await service.createManagementPolicy({
      id: "validator-policy",
      allowedRoleIds: ["tester"],
      instructions: "Delegate testing and deliver only after required Gates pass."
    });
  }

  function supervisorWorkflowWithGate(validatorId?: string) {
    return {
      id: "validator-workflow",
      architecture: "supervisor" as const,
      supervisor: { employeeId: "validator-lead" },
      managementPolicy: { id: "validator-policy" },
      members: [{ roleId: "tester", employeeId: "validator-tester" }],
      flow: {
        stages: [
          { id: "plan", kind: "supervisor" as const, title: "Plan" },
          { id: "delegation-loop", kind: "delegation-loop" as const, title: "Delegate" },
          { id: "e2e", kind: "gate" as const, title: "E2E", gateId: "e2e" },
          { id: "delivery", kind: "delivery" as const, title: "Deliver" }
        ],
        gates: [{
          id: "e2e",
          requiredCapability: "quality.test",
          mode: "before-completion" as const,
          required: true,
          instructions: "Require real e2e evidence before delivery.",
          fallback: "block" as const,
          ...(validatorId === undefined ? {} : { validatorId })
        }]
      }
    };
  }

  it("round-trips a gate validatorId through supervisor workflow authoring", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await createSupervisorTeam(service);
    const workflow = await service.createWorkflow(supervisorWorkflowWithGate("e2e-evidence"));
    if (workflow.architecture !== "supervisor") throw new Error("expected Supervisor workflow");
    expect(workflow.flow.gates.find((gate) => gate.id === "e2e")?.validatorId).toBe("e2e-evidence");

    const reread = service.getWorkflow(workflow.id);
    if (reread.architecture !== "supervisor") throw new Error("expected Supervisor workflow");
    expect(reread.flow.gates.find((gate) => gate.id === "e2e")?.validatorId).toBe("e2e-evidence");
  });

  it("rejects a gate that references an unknown validator at authoring time", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await createSupervisorTeam(service);
    await expect(service.createWorkflow(supervisorWorkflowWithGate("nope"))).rejects.toThrow(/unknown validator/);
  });

  it("rejects a gate whose validatorId is a prototype key at authoring time", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await createSupervisorTeam(service);
    await expect(service.createWorkflow(supervisorWorkflowWithGate("toString"))).rejects.toThrow(/unknown validator/);
  });

  it("accepts and preserves the \"none\" validator disable sentinel", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await createSupervisorTeam(service);
    const workflow = await service.createWorkflow(supervisorWorkflowWithGate("none"));
    if (workflow.architecture !== "supervisor") throw new Error("expected Supervisor workflow");
    expect(workflow.flow.gates.find((gate) => gate.id === "e2e")?.validatorId).toBe("none");
  });

  interface XiaomixiangTemplate {
    identity: { constraints?: string[] };
    systemPrompt: string;
    requestPrompt: string;
    providerId: string;
    permissions: { write: string; tools: string[] };
    outputSchema: JsonObject;
    verdict?: RoleVerdictDefinition;
  }

  function loadXiaomixiangTemplate(): XiaomixiangTemplate {
    const templatePath = path.resolve("templates", "workbench", "xiaomixiang-tester.employee.json");
    return JSON.parse(fs.readFileSync(templatePath, "utf8")) as XiaomixiangTemplate;
  }

  it("declares the 小米象 e2e evidence constraint, prompt, output schema, and verdict in the template", () => {
    const template = loadXiaomixiangTemplate();
    expect(template.identity.constraints ?? []).toContain(
      "任何验收必须包含真实 e2e/行为验证，禁止仅凭静态检查（读源码/类型/lint）判定通过"
    );
    expect(template.systemPrompt).toContain("严禁仅凭静态检查判定通过；每条结论必须有真实 e2e/行为证据。");
    expect(template.providerId).toBe("claude-relay-execution");
    expect(template.permissions).toEqual({
      write: "none",
      tools: ["Read", "Glob", "Grep", "WebFetch", "Bash"]
    });
    expect(template.verdict).toEqual({ path: "/verdict", pass: ["pass"], block: ["block"] });
    expect(template.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["verdict", "summary", "e2eEvidence"],
      properties: {
        verdict: { enum: ["pass", "block"] },
        summary: { type: "string", minLength: 1 },
        e2eEvidence: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["method", "steps", "observed"],
            properties: {
              method: { enum: ["browser", "http-behavior", "automation-run"] },
              steps: { type: "string", minLength: 1 },
              observed: { type: "string", minLength: 1 }
            }
          }
        }
      }
    });
    // The requestPrompt must instruct returning the new e2e fields, not the retired e2eCoverage field.
    expect(template.requestPrompt).not.toContain("e2eCoverage");
    for (const field of ["verdict", "summary", "e2eEvidence", "risks"]) {
      expect(template.requestPrompt).toContain(field);
    }
  });

  it("configures the executable relay Provider from the effective Role tools", () => {
    const definition = JSON.parse(fs.readFileSync(
      path.resolve("templates", "workbench", "claude-relay-execution.provider.json"),
      "utf8"
    )) as { adapter: string; args?: string[]; hardTimeoutMs?: number };
    expect(createDefaultProviderRegistry().get("command")?.validate({
      providerId: "claude-relay-execution",
      definition,
      projectRoot: process.cwd()
    })).toEqual([]);
    expect(definition.args).toEqual(expect.arrayContaining([
      "--tools",
      "{{role.toolsCsv}}",
      "--allowedTools"
    ]));
    expect(definition.args).not.toContain("--no-session-persistence");
    expect(definition.args).not.toContain("--max-budget-usd");
    expect(definition.hardTimeoutMs).toBeUndefined();
  });

  async function openScriptedTester(): Promise<{
    service: WorkbenchService;
    employeeId: string;
    setOutput: (value: unknown) => void;
  }> {
    const template = loadXiaomixiangTemplate();
    let scriptedOutput: unknown = { message: "unset" };
    const providers: ProviderRegistry = new Map([["scripted-tester", {
      id: "scripted-tester",
      validate: () => [],
      invoke: async () => ({ stdout: JSON.stringify(scriptedOutput), stderr: "", durationMs: 1 })
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("scripted-tester-provider", { adapter: "scripted-tester", outputProtocol: "json" });
    const employee = await service.createEmployee({
      id: "xiaomixiang-tester-instance",
      identity: {
        displayName: "小米象 · 测试工程师",
        background: "独立测试验收工程师。",
        responsibilities: ["验证真实行为"]
      },
      providerId: "scripted-tester-provider",
      outputSchema: template.outputSchema,
      verdict: template.verdict
    });
    return { service, employeeId: employee.id, setOutput: (value) => { scriptedOutput = value; } };
  }

  it("fails 小米象 output-schema validation when the tester omits e2eEvidence", async () => {
    const { service, employeeId, setOutput } = await openScriptedTester();
    setOutput({ verdict: "pass", summary: "仅读了源码，看起来没问题", risks: [] });

    const result = await service.invokeEmployee(employeeId, { message: "验收登录改动" });
    expect(result.status).toBe("failed");
    const run = JSON.parse(fs.readFileSync(path.join(result.runDir, "run.json"), "utf8")) as {
      status: string;
      nodes: Record<string, { status: string; error?: string }>;
    };
    expect(run.status).toBe("failed");
    expect(run.nodes.respond?.status).toBe("failed");
    expect(run.nodes.respond?.error).toMatch(/output schema validation failed/);
    expect(run.nodes.respond?.error).toMatch(/e2eEvidence/);
  });

  it("blocks the 小米象 run when the tester returns verdict block with real e2e evidence", async () => {
    const { service, employeeId, setOutput } = await openScriptedTester();
    setOutput({
      verdict: "block",
      summary: "登录页在生产环境返回 500，阻塞发布。",
      e2eEvidence: [{ method: "browser", steps: "打开登录页并提交表单", observed: "页面返回 500 错误" }],
      risks: ["用户无法登录"]
    });

    const result = await service.invokeEmployee(employeeId, { message: "验收登录改动" });
    expect(result.status).toBe("blocked");
    expect(result.output).toMatchObject({ verdict: "block" });
  });

  it("passes the 小米象 run when the tester returns verdict pass with real e2e evidence", async () => {
    const { service, employeeId, setOutput } = await openScriptedTester();
    setOutput({
      verdict: "pass",
      summary: "关键路径全部通过。",
      e2eEvidence: [{ method: "automation-run", steps: "运行 npm test", observed: "全部用例通过" }]
    });

    const result = await service.invokeEmployee(employeeId, { message: "验收登录改动" });
    expect(result.status).toBe("passed");
    expect(result.output).toMatchObject({ verdict: "pass" });
  });

  it("lists registered gate validators including the e2e-evidence validator", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    const validators = service.listGateValidators();
    const e2e = validators.find((validator) => validator.id === "e2e-evidence");
    expect(e2e).toBeDefined();
    expect(e2e?.description.length).toBeGreaterThan(0);
  });
});
