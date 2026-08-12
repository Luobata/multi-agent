import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatPlanMermaid, formatPlanText } from "../src/core/plan.js";
import type { ProviderRegistry } from "../src/runtime/providers.js";
import { WorkbenchService } from "../src/workbench/service.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-supervisor-runtime-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function createTeam(service: WorkbenchService, providerId = "mock"): Promise<void> {
  await service.createEmployee({
    id: "lead",
    identity: { displayName: "Lead", background: "Coordinates work.", responsibilities: ["Plan", "Deliver"] },
    capabilities: ["quality.audit"],
    providerId
  });
  await service.createEmployee({
    id: "builder-one",
    identity: { displayName: "Builder One", background: "Builds code.", responsibilities: ["Implement"] },
    capabilities: ["code.backend"],
    providerId
  });
  await service.createEmployee({
    id: "builder-two",
    identity: { displayName: "Builder Two", background: "Builds code.", responsibilities: ["Implement"] },
    capabilities: ["code.backend"],
    providerId
  });
  await service.createEmployee({
    id: "integrator",
    identity: { displayName: "Integrator", background: "Integrates changes.", responsibilities: ["Integrate"] },
    capabilities: ["code.integration"],
    providerId
  });
  await service.createManagementPolicy({
    id: "delivery-policy",
    allowedRoleIds: ["builder-one", "builder-two", "integrator"],
    instructions: "Delegate explicit work and deliver only after required Gates pass.",
    limits: { maxRounds: 5, maxDelegations: 8, maxParallelDelegations: 3, maxDurationMs: 60_000 }
  });
}

describe("Supervisor flow persistence and materialization", () => {
  it("leaves maxDurationMs unbounded by default and lets an explicit null clear a set ceiling", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    // Omitted duration → no absolute ceiling.
    const created = await service.createManagementPolicy({
      id: "duration-policy",
      allowedRoleIds: ["worker"],
      instructions: "No fixed wall clock."
    });
    expect(created.limits.maxDurationMs).toBeUndefined();

    // Setting a value pins a ceiling.
    const withCeiling = await service.updateManagementPolicy("duration-policy", { limits: { maxDurationMs: 60_000 } });
    expect(withCeiling.limits.maxDurationMs).toBe(60_000);

    // A partial update that omits maxDurationMs inherits the current ceiling.
    const inherited = await service.updateManagementPolicy("duration-policy", { instructions: "Same ceiling." });
    expect(inherited.limits.maxDurationMs).toBe(60_000);

    // An explicit null clears it back to unbounded.
    const cleared = await service.updateManagementPolicy("duration-policy", { limits: { maxDurationMs: null } });
    expect(cleared.limits.maxDurationMs).toBeUndefined();
  });

  it("versions explicit flow changes while preserving the legacy no-Gate default and plan rendering", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await createTeam(service);
    const created = await service.createWorkflow({
      id: "versioned-supervision",
      architecture: "supervisor",
      supervisor: { employeeId: "lead" },
      managementPolicy: { id: "delivery-policy" },
      members: [{ roleId: "builder-one", employeeId: "builder-one" }]
    });
    expect(created.flow).toEqual({
      version: 1,
      stages: [
        { id: "plan", kind: "supervisor", title: "Plan" },
        { id: "delegation-loop", kind: "delegation-loop", title: "Delegation loop" },
        { id: "delivery", kind: "delivery", title: "Delivery" }
      ],
      gates: []
    });
    const metadataOnly = await service.updateWorkflow(created.id, { description: "Updated description only." });
    expect(metadataOnly.architecture).toBe("supervisor");
    if (metadataOnly.architecture !== "supervisor") throw new Error("expected Supervisor workflow");
    expect(metadataOnly.flow.version).toBe(1);

    const withGate = await service.updateWorkflow(created.id, {
      architecture: "supervisor",
      flow: {
        stages: [
          { id: "plan", kind: "supervisor", title: "Plan" },
          { id: "delegation-loop", kind: "delegation-loop", title: "Delegate" },
          { id: "audit", kind: "gate", title: "Audit", gateId: "audit" },
          { id: "delivery", kind: "delivery", title: "Deliver" }
        ],
        gates: [{
          id: "audit",
          requiredCapability: "quality.audit",
          mode: "before-completion",
          required: true,
          instructions: "Audit the completed code work.",
          fallback: "supervisor"
        }]
      }
    });
    expect(withGate.architecture).toBe("supervisor");
    if (withGate.architecture !== "supervisor") throw new Error("expected Supervisor workflow");
    expect(withGate.flow.version).toBe(2);
    expect(service.getWorkflowVersions(created.id).map((workflow) => workflow.version)).toEqual([3, 2, 1]);

    const plan = await service.planWorkflow(created.id);
    expect(formatPlanText(plan)).toContain("Flow v2: Plan [supervisor] -> Delegate [delegation-loop] -> Audit [gate] -> Deliver [delivery]");
    expect(formatPlanText(plan)).toContain("builder-one (member-builder-one; capabilities: code.backend)");
    expect(formatPlanMermaid(plan)).toContain("stage_delegation_loop -. runtime delegation .-> member_builder_one");
    await expect(service.updateWorkflow(created.id, {
      architecture: "supervisor",
      flow: {
        stages: [
          { id: "plan", kind: "supervisor", title: "Plan" },
          { id: "loop", kind: "delegation-loop", title: "Delegate" },
          { id: "delivery", kind: "delivery", title: "Deliver" }
        ],
        gates: [{
          id: "orphaned-audit",
          requiredCapability: "quality.audit",
          mode: "before-completion",
          required: true,
          instructions: "Audit.",
          fallback: "supervisor"
        }]
      }
    })).rejects.toThrow(/gate orphaned-audit is not referenced/);
  });

  it("injects the pinned system Skill only into the materialized supervisor role and records capabilities", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await service.createSkill({ id: "lead-method", description: "Lead method", instructions: "LEAD_METHOD" });
    await service.createSkill({ id: "build-method", description: "Build method", instructions: "BUILD_METHOD" });
    await service.createEmployee({
      id: "materialized-lead",
      identity: { displayName: "Materialized Lead", background: "Coordinates.", responsibilities: ["Coordinate"] },
      capabilities: ["quality.audit"],
      skills: ["lead-method"]
    });
    await service.createEmployee({
      id: "materialized-builder",
      identity: { displayName: "Materialized Builder", background: "Builds.", responsibilities: ["Build"] },
      capabilities: ["code.backend"],
      skills: ["build-method"]
    });
    await service.createManagementPolicy({
      id: "materialize-policy",
      allowedRoleIds: ["builder"],
      instructions: "Coordinate the builder."
    });
    const workflow = await service.createWorkflow({
      id: "materialized-supervision",
      architecture: "supervisor",
      supervisor: { employeeId: "materialized-lead" },
      managementPolicy: { id: "materialize-policy" },
      members: [{ roleId: "builder", employeeId: "materialized-builder" }]
    });
    expect(workflow.orchestrationSkill).toEqual({ id: "team-orchestration", version: 8 });
    expect(service.listSkills(true).find((skill) => skill.id === "team-orchestration")?.instructions)
      .toContain("first emit plan-todos");

    const result = await service.runWorkbenchWorkflow(workflow.id, { message: "Inspect materialization" });
    const manifest = JSON.parse(fs.readFileSync(result.run.manifestPath, "utf8")) as {
      roles: Record<string, { skills: Array<{ id: string }>; identity: { metadata: Record<string, unknown> } }>;
      workflows: Record<string, { config: Record<string, unknown> }>;
    };
    expect(manifest.roles.supervisor?.skills.map((skill) => skill.id)).toEqual([
      "lead-method-v1",
      "team-orchestration-v8"
    ]);
    expect(manifest.roles["member-builder"]?.skills.map((skill) => skill.id)).toEqual(["build-method-v1"]);
    expect(manifest.roles.supervisor?.identity.metadata.runtimeSkillInjections).toEqual([{
      skillId: "team-orchestration",
      version: 8,
      reason: "supervisor-runtime"
    }]);
    expect(manifest.roles["member-builder"]?.identity.metadata.runtimeSkillInjections).toBeUndefined();
    expect(manifest.workflows[workflow.id]?.config).toMatchObject({
      supervisor: { capabilities: ["quality.audit"], skillInjection: { id: "team-orchestration", version: 8 } },
      members: [{
        roleId: "builder",
        capabilities: ["code.backend"],
        // The supervisor sees a bounded member profile to judge fit — responsibilities + per-skill summaries,
        // not just capability tags. The injected system orchestration skill is excluded from member signal.
        responsibilities: ["Build"],
        skillSummaries: ["build-method: Build method"]
      }]
    });
    expect(service.getEmployee("materialized-lead").skills).toEqual(["lead-method"]);
    expect(service.getEmployee("materialized-builder").skills).toEqual(["build-method"]);
  });

  it("migrates a persisted legacy Supervisor workflow to the no-Gate default flow", async () => {
    const root = temporaryRoot();
    let service = await WorkbenchService.open({ dataRoot: root });
    await createTeam(service);
    await service.createWorkflow({
      id: "legacy-supervision",
      architecture: "supervisor",
      supervisor: { employeeId: "lead" },
      managementPolicy: { id: "delivery-policy" },
      members: [{ roleId: "builder-one", employeeId: "builder-one" }]
    });
    const statePath = path.join(root, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      workflows: Record<string, { current: Record<string, unknown>; versions: Array<Record<string, unknown>> }>;
    };
    delete state.workflows["legacy-supervision"]?.current.flow;
    delete state.workflows["legacy-supervision"]?.current.orchestrationSkill;
    for (const version of state.workflows["legacy-supervision"]?.versions ?? []) {
      delete version.flow;
      delete version.orchestrationSkill;
    }
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    service = await WorkbenchService.open({ dataRoot: root });
    const migrated = service.getWorkflow("legacy-supervision");
    expect(migrated.architecture).toBe("supervisor");
    if (migrated.architecture !== "supervisor") throw new Error("expected Supervisor workflow");
    expect(migrated.flow).toMatchObject({ version: 1, gates: [] });
    expect(migrated.flow.stages.map((stage) => stage.kind)).toEqual(["supervisor", "delegation-loop", "delivery"]);
    expect(migrated.orchestrationSkill).toEqual({ id: "team-orchestration", version: 8 });
  });
});

describe("Supervisor deterministic capabilities and Gates", () => {
  it("delegates to the selected member even when its capability tags do not match the advisory requirement", async () => {
    // Capability tags are advisory hints, not a hard gate: the supervisor picks who fits and the
    // runtime delegates regardless of tag mismatch. (Previously this mismatch hard-blocked the run.)
    let round = 0;
    const providers: ProviderRegistry = new Map([["capability-decision", {
      id: "capability-decision",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        if (role !== "supervisor") {
          return { stdout: JSON.stringify({ message: "Implemented the backend change." }), stderr: "", durationMs: 1 };
        }
        round += 1;
        return round === 1
          ? {
              stdout: JSON.stringify({
                action: "delegate",
                assignments: [{
                  roleId: "worker",
                  task: "Implement the backend change.",
                  requiredCapabilities: ["code.backend"],
                  workKind: "code",
                  changeSet: "backend"
                }]
              }),
              stderr: "",
              durationMs: 1
            }
          : { stdout: JSON.stringify({ action: "finish", summary: "Delivered.", result: { delivered: true } }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("capability-provider", { adapter: "capability-decision", outputProtocol: "json" });
    for (const id of ["capability-lead", "discussion-worker"]) {
      await service.createEmployee({
        id,
        identity: { displayName: id, background: "Capability test.", responsibilities: ["Work"] },
        capabilities: id === "discussion-worker" ? ["discussion.facilitation"] : [],
        providerId: "capability-provider"
      });
    }
    await service.createManagementPolicy({
      id: "capability-policy",
      allowedRoleIds: ["worker"],
      instructions: "Delegate only compatible work."
    });
    await service.createWorkflow({
      id: "capability-supervision",
      architecture: "supervisor",
      supervisor: { employeeId: "capability-lead" },
      managementPolicy: { id: "capability-policy" },
      members: [{ roleId: "worker", employeeId: "discussion-worker" }]
    });

    const result = await service.runWorkbenchWorkflow("capability-supervision", { message: "Build" });
    // The mismatched capability tag no longer blocks: the worker is delegated and the run completes.
    expect(result.run.status).toBe("passed");
    expect(JSON.stringify(result.run.output)).not.toContain("lacks required capabilities");
    expect(Object.keys(result.run.nodes)).toContain("worker-r1-1");
  });

  it("executes bounded TODO shards in one retained member Work Instance and scopes regression from impact", async () => {
    let supervisorTurn = 0;
    const builderContexts: Array<Record<string, unknown>> = [];
    const gateContexts: Array<Record<string, unknown>> = [];
    const gateNeeds: Array<Record<string, unknown>> = [];
    const impact = {
      level: "low",
      regressionScope: "targeted",
      affectedAreas: ["src/local-helper.ts"],
      reasons: ["Only one local helper and its direct caller change; public contracts remain stable."],
      requiredChecks: ["local-helper focused unit test", "direct caller behavior check"]
    };
    const providers: ProviderRegistry = new Map([["todo-session-flow", {
      id: "todo-session-flow",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        const node = invocation.templateContext.node as {
          metadata?: { kind?: string };
          with?: Record<string, unknown>;
        };
        if (node.metadata?.kind === "gate") {
          gateContexts.push({ ...(node.with ?? {}) });
          gateNeeds.push({ ...((invocation.templateContext.needs as Record<string, unknown>) ?? {}) });
          return {
            stdout: JSON.stringify({
              message: "Targeted behavior passed.",
              e2eEvidence: [{ method: "automation-run", steps: "run the focused helper behavior test", observed: "the direct caller passed" }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (role === "member-builder") {
          builderContexts.push({ ...(node.with ?? {}) });
          const todoId = String(node.with?.__todoId ?? "");
          return {
            stdout: JSON.stringify({ message: `${todoId} completed without executing another TODO.` }),
            stderr: "",
            durationMs: 1
          };
        }
        supervisorTurn += 1;
        if (supervisorTurn === 1) {
          return {
            stdout: JSON.stringify({
              action: "plan-todos",
              summary: "Split the local change into two serial, verifiable coding milestones.",
              impact,
              todos: [
                {
                  id: "implement-helper",
                  roleId: "builder",
                  task: "Implement only the local helper and its focused unit behavior.",
                  needs: [],
                  workKind: "code",
                  changeSet: "local-helper",
                  sessionKey: "builder-local-helper"
                },
                {
                  id: "wire-caller",
                  roleId: "builder",
                  task: "Wire only the direct caller to the completed helper; do not repeat helper implementation.",
                  needs: ["implement-helper"],
                  workKind: "code",
                  changeSet: "local-helper",
                  sessionKey: "builder-local-helper"
                }
              ]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (supervisorTurn === 2) {
          return {
            stdout: JSON.stringify({
              action: "delegate",
              summary: "Run the first ready TODO only.",
              assignments: [{ todoId: "implement-helper", roleId: "builder" }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (supervisorTurn === 3) {
          return {
            stdout: JSON.stringify({
              action: "delegate",
              summary: "Accidentally override the immutable planned change set.",
              assignments: [{ todoId: "wire-caller", roleId: "builder", changeSet: "wrong-change-set" }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (supervisorTurn === 4) {
          return {
            stdout: JSON.stringify({
              action: "delegate",
              summary: "Continue the retained builder session with the dependent TODO.",
              assignments: [{ todoId: "wire-caller", roleId: "builder" }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (supervisorTurn === 5) {
          return {
            stdout: JSON.stringify({
              action: "delegate",
              summary: "Accidentally invent an unplanned test assignment after the TODO plan.",
              assignments: [{ roleId: "tester", task: "Repeat package tests", workKind: "test" }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        return {
          stdout: JSON.stringify({ action: "finish", summary: "Both TODOs and targeted regression passed.", result: { delivered: true } }),
          stderr: "",
          durationMs: 1
        };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("todo-session-provider", { adapter: "todo-session-flow", outputProtocol: "json" });
    await service.createEmployee({
      id: "todo-lead",
      identity: { displayName: "TODO Lead", background: "Plans bounded work.", responsibilities: ["Plan"] },
      providerId: "todo-session-provider"
    });
    await service.createEmployee({
      id: "todo-builder",
      identity: { displayName: "TODO Builder", background: "Implements bounded changes.", responsibilities: ["Build"] },
      capabilities: ["code.backend"],
      providerId: "todo-session-provider"
    });
    await service.createEmployee({
      id: "todo-tester",
      identity: { displayName: "TODO Tester", background: "Runs scoped behavior tests.", responsibilities: ["Test"] },
      capabilities: ["quality.test", "quality.audit"],
      providerId: "todo-session-provider",
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
      id: "todo-session-policy",
      allowedRoleIds: ["builder", "tester"],
      instructions: "Plan bounded TODOs and use regression impact to choose the smallest safe test scope.",
      limits: { maxRounds: 6, maxDelegations: 2, maxParallelDelegations: 1 }
    });
    await service.createWorkflow({
      id: "todo-session-supervision",
      architecture: "supervisor",
      supervisor: { employeeId: "todo-lead" },
      managementPolicy: { id: "todo-session-policy" },
      members: [
        { roleId: "builder", employeeId: "todo-builder" },
        { roleId: "tester", employeeId: "todo-tester" }
      ],
      flow: {
        stages: [
          { id: "plan", kind: "supervisor", title: "Plan" },
          { id: "loop", kind: "delegation-loop", title: "Build" },
          { id: "test", kind: "gate", title: "Targeted test", gateId: "targeted-test" },
          { id: "audit", kind: "gate", title: "Independent audit", gateId: "independent-audit" },
          { id: "delivery", kind: "delivery", title: "Deliver" }
        ],
        gates: [
          {
            id: "targeted-test",
            requiredCapability: "quality.test",
            mode: "before-completion",
            required: true,
            instructions: "Validate the recorded regression scope.",
            fallback: "block"
          },
          {
            id: "independent-audit",
            requiredCapability: "quality.audit",
            mode: "before-completion",
            required: true,
            instructions: "Audit the candidate and its test evidence.",
            fallback: "block"
          }
        ]
      }
    });

    const result = await service.runWorkbenchWorkflow("todo-session-supervision", { message: "Make one local helper change." });
    expect(result.run.status, JSON.stringify(result.run.output)).toBe("passed");
    expect(supervisorTurn).toBe(5);
    expect(result.run.output).toMatchObject({
      summary: "All planned TODOs passed; the runtime ignored an unplanned late delegation and advanced the configured quality Gates.",
      dag: {
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeId: "implement-helper", status: "passed" }),
          expect.objectContaining({ nodeId: "wire-caller", status: "passed" })
        ])
      },
      gates: expect.arrayContaining([
        expect.objectContaining({ gateId: "targeted-test", status: "passed" }),
        expect.objectContaining({ gateId: "independent-audit", status: "passed" })
      ])
    });

    expect(builderContexts).toHaveLength(2);
    expect(builderContexts[0]).toMatchObject({
      __todoId: "implement-helper",
      __delegatedTask: "Implement only the local helper and its focused unit behavior.",
      __regressionImpact: impact,
      __memberSession: { id: "member-session-builder-local-helper", turns: [] }
    });
    expect(builderContexts[1]).toMatchObject({
      __todoId: "wire-caller",
      __delegatedTask: "Wire only the direct caller to the completed helper; do not repeat helper implementation.",
      __regressionImpact: impact,
      __memberSession: {
        id: "member-session-builder-local-helper",
        turns: [expect.objectContaining({ todoId: "implement-helper", status: "passed" })]
      }
    });
    expect(String(builderContexts[0]?.__delegatedTask)).not.toContain("Wire only");

    expect(gateContexts).toHaveLength(2);
    expect(gateContexts[0]).toMatchObject({ __regressionImpact: impact });
    expect(String(gateContexts[0]?.__delegatedTask)).toContain("Run only changed-path and directly related regression checks");
    expect(String(gateContexts[0]?.__delegatedTask)).toContain("do not run package-wide or repository-wide suites");
    expect(String(gateContexts[1]?.__delegatedTask)).toContain("Upstream quality Gate evidence is attached");
    expect(String(gateContexts[1]?.__delegatedTask)).toContain("Do not repeat browser or automated regression");
    expect(Object.keys(gateNeeds[1] ?? {})).toEqual(expect.arrayContaining([
      "wire-caller",
      expect.stringMatching(/^gate-targeted-test-/)
    ]));

    const builderInstances = service.getActivitySnapshot().instances.filter((candidate) => (
      candidate.runId === result.run.id && candidate.employeeId === "todo-builder"
    ));
    expect(builderInstances).toHaveLength(1);
    expect(builderInstances[0]).toMatchObject({
      status: "completed",
      phase: "member-session-closed",
      nodeId: "wire-caller",
      nodeIds: ["implement-helper", "wire-caller"],
      memberSessionId: "member-session-builder-local-helper",
      memberSessionRetained: false,
      todoId: "wire-caller"
    });
    expect(builderInstances[0]?.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "waiting", phase: "waiting-next-todo" }),
      expect.objectContaining({ status: "queued", phase: "continuing-session" })
    ]));
  });

  it("splits broad quality checks into bounded Gate shards and feeds every shard to the independent audit", async () => {
    let supervisorTurn = 0;
    const gateCalls: Array<{
      task: string;
      execution: Record<string, unknown>;
      needs: string[];
    }> = [];
    const requiredChecks = [
      "client unit tests",
      "server unit tests",
      "client production build",
      "server typecheck",
      "board browser smoke",
      "requirement detail browser smoke",
      "office browser smoke",
      "delivery acceptance smoke"
    ];
    const providers: ProviderRegistry = new Map([["sharded-quality-flow", {
      id: "sharded-quality-flow",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        const node = invocation.templateContext.node as {
          metadata?: { kind?: string };
          with?: Record<string, unknown>;
        };
        if (node.metadata?.kind === "gate") {
          gateCalls.push({
            task: String(node.with?.__delegatedTask ?? ""),
            execution: { ...((node.with?.__gateExecution as Record<string, unknown>) ?? {}) },
            needs: Object.keys((invocation.templateContext.needs as Record<string, unknown>) ?? {})
          });
          return {
            stdout: JSON.stringify({
              message: "The assigned bounded checks passed.",
              e2eEvidence: [{ method: "automation-run", steps: "run only the assigned checks", observed: "all assigned checks passed" }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (role === "member-builder") {
          return { stdout: JSON.stringify({ message: "Implementation complete." }), stderr: "", durationMs: 1 };
        }
        supervisorTurn += 1;
        if (supervisorTurn === 1) {
          return {
            stdout: JSON.stringify({
              action: "plan-todos",
              summary: "Plan one implementation and a bounded package regression.",
              impact: {
                level: "high",
                regressionScope: "package",
                affectedAreas: ["client", "server"],
                reasons: ["The change crosses the board and requirement detail surfaces."],
                requiredChecks
              },
              todos: [
                {
                  id: "inspect-change",
                  roleId: "builder",
                  task: "Inspect the affected surfaces and confirm the bounded change set.",
                  needs: [],
                  workKind: "discussion"
                },
                {
                  id: "implement-change",
                  roleId: "builder",
                  task: "Implement the bounded cross-surface change.",
                  needs: ["inspect-change"],
                  workKind: "code",
                  changeSet: "workbench"
                }
              ]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (supervisorTurn === 2) {
          return {
            stdout: JSON.stringify({ action: "delegate", assignments: [{ todoId: "inspect-change", roleId: "builder" }] }),
            stderr: "",
            durationMs: 1
          };
        }
        if (supervisorTurn === 3) {
          return {
            stdout: JSON.stringify({ action: "delegate", assignments: [{ todoId: "implement-change", roleId: "builder" }] }),
            stderr: "",
            durationMs: 1
          };
        }
        return {
          stdout: JSON.stringify({ action: "finish", summary: "Implementation ready for quality Gates.", result: { delivered: true } }),
          stderr: "",
          durationMs: 1
        };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("sharded-quality-provider", { adapter: "sharded-quality-flow", outputProtocol: "json" });
    await service.createEmployee({
      id: "sharded-quality-lead",
      identity: { displayName: "Lead", background: "Leads.", responsibilities: ["Lead"] },
      providerId: "sharded-quality-provider"
    });
    await service.createEmployee({
      id: "sharded-quality-builder",
      identity: { displayName: "Builder", background: "Builds.", responsibilities: ["Build"] },
      capabilities: ["code.fullstack"],
      providerId: "sharded-quality-provider"
    });
    await service.createEmployee({
      id: "sharded-quality-tester",
      identity: { displayName: "Tester", background: "Tests and audits.", responsibilities: ["Test", "Audit"] },
      capabilities: ["quality.test", "quality.audit"],
      providerId: "sharded-quality-provider",
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
      id: "sharded-quality-policy",
      allowedRoleIds: ["builder", "tester"],
      instructions: "Run bounded quality shards before an evidence-only independent audit.",
      limits: { maxRounds: 5, maxDelegations: 2, maxParallelDelegations: 1 }
    });
    await service.createWorkflow({
      id: "sharded-quality-workflow",
      architecture: "supervisor",
      supervisor: { employeeId: "sharded-quality-lead" },
      managementPolicy: { id: "sharded-quality-policy" },
      members: [
        { roleId: "builder", employeeId: "sharded-quality-builder" },
        { roleId: "tester", employeeId: "sharded-quality-tester" }
      ],
      flow: {
        stages: [
          { id: "plan", kind: "supervisor", title: "Plan" },
          { id: "loop", kind: "delegation-loop", title: "Build" },
          { id: "test", kind: "gate", title: "Test", gateId: "quality-test" },
          { id: "audit", kind: "gate", title: "Audit", gateId: "independent-audit" },
          { id: "delivery", kind: "delivery", title: "Deliver" }
        ],
        gates: [
          {
            id: "quality-test",
            requiredCapability: "quality.test",
            mode: "before-completion",
            required: true,
            instructions: "Run the regression assessment.",
            fallback: "block"
          },
          {
            id: "independent-audit",
            requiredCapability: "quality.audit",
            mode: "before-completion",
            required: true,
            instructions: "Audit the candidate and existing quality evidence.",
            fallback: "block"
          }
        ]
      }
    });

    const result = await service.runWorkbenchWorkflow("sharded-quality-workflow", { message: "Implement and validate the change." });
    expect(result.run.status, JSON.stringify(result.run.output)).toBe("passed");
    const testCalls = gateCalls.filter((call) => call.execution.gateId === "quality-test");
    const auditCall = gateCalls.find((call) => call.execution.gateId === "independent-audit");
    expect(testCalls).toHaveLength(4);
    expect(testCalls.map((call) => call.execution.shard)).toEqual([
      { id: "auto-1", index: 1, total: 4, requiredChecks: requiredChecks.slice(0, 2) },
      { id: "auto-2", index: 2, total: 4, requiredChecks: requiredChecks.slice(2, 4) },
      { id: "auto-3", index: 3, total: 4, requiredChecks: requiredChecks.slice(4, 6) },
      { id: "auto-4", index: 4, total: 4, requiredChecks: requiredChecks.slice(6, 8) }
    ]);
    for (const [index, call] of testCalls.entries()) {
      for (const check of requiredChecks.slice(index * 2, index * 2 + 2)) expect(call.task).toContain(check);
      expect(call.task).toContain(`Quality Gate shard ${index + 1}/4`);
    }
    expect(auditCall?.task).toContain("Do not repeat browser or automated regression");
    expect(auditCall?.needs.filter((nodeId) => nodeId.startsWith("gate-quality-test-"))).toHaveLength(4);
    expect(Object.keys(result.run.nodes)).toEqual(expect.arrayContaining([
      "gate-quality-test-r4-1-s1",
      "gate-quality-test-r4-1-s2",
      "gate-quality-test-r4-1-s3",
      "gate-quality-test-r4-1-s4"
    ]));
  });

  it("reopens a passed code TODO after a required Gate blocks and reruns Gates against the repaired change set", async () => {
    let supervisorTurn = 0;
    let gateAttempt = 0;
    const builderContexts: Array<Record<string, unknown>> = [];
    const providers: ProviderRegistry = new Map([["todo-gate-remediation", {
      id: "todo-gate-remediation",
      validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        const node = invocation.templateContext.node as { metadata?: { kind?: string }; with?: Record<string, unknown> };
        if (node.metadata?.kind === "gate") {
          gateAttempt += 1;
          return {
            stdout: JSON.stringify({
              message: gateAttempt === 1 ? "Parent breadcrumb did not leave detail state." : "Repaired parent breadcrumb returned to the list.",
              verdict: gateAttempt === 1 ? "Block" : "Pass"
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (role === "member-builder") {
          if (node.with?.__todoId === "implement-navigation") builderContexts.push({ ...(node.with ?? {}) });
          return {
            stdout: JSON.stringify({ message: node.with?.__todoId === "inspect-navigation" ? "Navigation inspected." : builderContexts.length === 1 ? "Initial implementation." : "Gate remediation applied." }),
            stderr: "",
            durationMs: 1
          };
        }
        supervisorTurn += 1;
        if (supervisorTurn === 1) {
          return {
            stdout: JSON.stringify({
              action: "plan-todos",
              summary: "Plan one bounded implementation TODO.",
              impact: {
                level: "low",
                regressionScope: "targeted",
                affectedAreas: ["client navigation"],
                reasons: ["one navigation state transition"],
                requiredChecks: ["parent breadcrumb behavior"]
              },
              todos: [
                {
                  id: "inspect-navigation",
                  roleId: "builder",
                  task: "Inspect the existing navigation state transition.",
                  needs: [],
                  workKind: "discussion"
                },
                {
                  id: "implement-navigation",
                  roleId: "builder",
                  task: "Implement the parent breadcrumb navigation state transition.",
                  needs: ["inspect-navigation"],
                  workKind: "code",
                  changeSet: "navigation",
                  sessionKey: "navigation-builder"
                }
              ]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (supervisorTurn === 2) {
          return {
            stdout: JSON.stringify({ action: "delegate", assignments: [{ todoId: "inspect-navigation", roleId: "builder" }] }),
            stderr: "",
            durationMs: 1
          };
        }
        if (supervisorTurn === 3) {
          return {
            stdout: JSON.stringify({ action: "delegate", assignments: [{ todoId: "implement-navigation", roleId: "builder" }] }),
            stderr: "",
            durationMs: 1
          };
        }
        if (supervisorTurn === 4) {
          return {
            stdout: JSON.stringify({ action: "finish", summary: "Run the Gate.", result: { delivered: true } }),
            stderr: "",
            durationMs: 1
          };
        }
        if (supervisorTurn === 5) {
          return {
            stdout: JSON.stringify({
              action: "delegate",
              summary: "Repair the original TODO using the Gate evidence.",
              assignments: [{ todoId: "implement-navigation", roleId: "builder" }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        return {
          stdout: JSON.stringify({ action: "finish", summary: "Run the Gate against the repaired candidate.", result: { delivered: true } }),
          stderr: "",
          durationMs: 1
        };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("todo-gate-remediation-provider", { adapter: "todo-gate-remediation", outputProtocol: "json" });
    await service.createEmployee({
      id: "todo-gate-lead",
      identity: { displayName: "Lead", background: "Leads.", responsibilities: ["Lead"] },
      providerId: "todo-gate-remediation-provider"
    });
    await service.createEmployee({
      id: "todo-gate-builder",
      identity: { displayName: "Builder", background: "Builds.", responsibilities: ["Build"] },
      capabilities: ["code.frontend"],
      providerId: "todo-gate-remediation-provider"
    });
    await service.createEmployee({
      id: "todo-gate-auditor",
      identity: { displayName: "Auditor", background: "Audits.", responsibilities: ["Audit"] },
      capabilities: ["quality.audit"],
      providerId: "todo-gate-remediation-provider",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message", "verdict"],
        properties: { message: { type: "string" }, verdict: { enum: ["Pass", "Block"] } }
      },
      verdict: { path: "verdict", pass: ["Pass"], block: ["Block"] }
    });
    await service.createManagementPolicy({
      id: "todo-gate-remediation-policy",
      allowedRoleIds: ["builder", "auditor"],
      instructions: "Repair the planned change when a required Gate blocks it.",
      limits: { maxRounds: 6, maxDelegations: 3, maxParallelDelegations: 1 }
    });
    await service.createWorkflow({
      id: "todo-gate-remediation-workflow",
      architecture: "supervisor",
      supervisor: { employeeId: "todo-gate-lead" },
      managementPolicy: { id: "todo-gate-remediation-policy" },
      members: [
        { roleId: "builder", employeeId: "todo-gate-builder" },
        { roleId: "auditor", employeeId: "todo-gate-auditor" }
      ],
      flow: {
        stages: [
          { id: "plan", kind: "supervisor", title: "Plan" },
          { id: "loop", kind: "delegation-loop", title: "Build" },
          { id: "audit", kind: "gate", title: "Audit", gateId: "audit" },
          { id: "delivery", kind: "delivery", title: "Deliver" }
        ],
        gates: [{
          id: "audit",
          requiredCapability: "quality.audit",
          mode: "before-completion",
          required: true,
          instructions: "Verify parent breadcrumb behavior.",
          fallback: "block"
        }]
      }
    });

    const result = await service.runWorkbenchWorkflow("todo-gate-remediation-workflow", { message: "Fix navigation." });
    expect(result.run.status, JSON.stringify(result.run.output)).toBe("passed");
    expect(gateAttempt).toBe(2);
    expect(Object.keys(result.run.nodes)).toEqual(expect.arrayContaining([
      "implement-navigation",
      "gate-audit-r4-1",
      "implement-navigation-retry-2",
      "gate-audit-r6-2"
    ]));
    expect(result.run.output).toMatchObject({
      gates: [{
        gateId: "audit",
        status: "passed",
        executions: [
          expect.objectContaining({ status: "blocked", sourceNodeIds: ["implement-navigation"] }),
          expect.objectContaining({ status: "passed", sourceNodeIds: ["implement-navigation-retry-2"] })
        ]
      }],
      dag: {
        nodes: expect.arrayContaining([expect.objectContaining({
          nodeId: "implement-navigation",
          status: "passed",
          executions: [
            expect.objectContaining({ nodeId: "implement-navigation", status: "passed" }),
            expect.objectContaining({ nodeId: "implement-navigation-retry-2", status: "passed" })
          ]
        })])
      }
    });
    expect(builderContexts).toHaveLength(2);
    expect(builderContexts[0]).toMatchObject({
      __memberSession: { id: "member-session-navigation-builder", turns: [] }
    });
    expect(builderContexts[1]).toMatchObject({
      __memberSession: {
        id: "member-session-navigation-builder",
        turns: [expect.objectContaining({ todoId: "implement-navigation", status: "passed" })]
      }
    });
    const builderInstances = service.getActivitySnapshot().instances.filter((instance) => (
      instance.runId === result.run.id
      && instance.employeeId === "todo-gate-builder"
      && instance.memberSessionId === "member-session-navigation-builder"
    ));
    expect(builderInstances).toHaveLength(1);
    expect(builderInstances[0]).toMatchObject({
      nodeIds: ["implement-navigation", "implement-navigation-retry-2"],
      memberSessionRetained: false,
      phase: "member-session-closed"
    });
  });

  it("skips integration for one changeSet and runs it for two independent code changeSets", async () => {
    const providers: ProviderRegistry = new Map([["integration-flow", {
      id: "integration-flow",
      validate: () => [],
      invoke: async (invocation) => {
        const node = invocation.templateContext.node as { metadata?: { kind?: string }; with?: { __supervisorRound?: number } };
        const role = (invocation.templateContext.role as { id: string }).id;
        const round = Number(node.with?.__supervisorRound ?? 0);
        if (node.metadata?.kind === "gate") {
          return { stdout: JSON.stringify({ message: "Integration complete." }), stderr: "", durationMs: 1 };
        }
        if (role === "supervisor" && round === 1) {
          const message = String((invocation.templateContext.input as { message?: string }).message ?? "");
          const assignments = [{
            roleId: "builder-one",
            task: "Implement first change.",
            requiredCapabilities: ["code.backend"],
            workKind: "code",
            changeSet: "package-one"
          }];
          if (message === "two") assignments.push({
            roleId: "builder-two",
            task: "Implement second change.",
            requiredCapabilities: ["code.backend"],
            workKind: "code",
            changeSet: "package-two"
          });
          return { stdout: JSON.stringify({ action: "delegate", assignments }), stderr: "", durationMs: 1 };
        }
        if (role === "supervisor") {
          return { stdout: JSON.stringify({ action: "finish", summary: "Done.", result: { delivered: true } }), stderr: "", durationMs: 1 };
        }
        return { stdout: JSON.stringify({ message: "Code complete." }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("integration-provider", { adapter: "integration-flow", outputProtocol: "json" });
    await createTeam(service, "integration-provider");
    await service.createWorkflow({
      id: "integration-supervision",
      architecture: "supervisor",
      supervisor: { employeeId: "lead" },
      managementPolicy: { id: "delivery-policy" },
      members: [
        { roleId: "builder-one", employeeId: "builder-one" },
        { roleId: "builder-two", employeeId: "builder-two" },
        { roleId: "integrator", employeeId: "integrator" }
      ],
      flow: {
        stages: [
          { id: "plan", kind: "supervisor", title: "Plan" },
          { id: "loop", kind: "delegation-loop", title: "Build" },
          { id: "integration", kind: "gate", title: "Integrate", gateId: "integration" },
          { id: "delivery", kind: "delivery", title: "Deliver" }
        ],
        gates: [{
          id: "integration",
          requiredCapability: "code.integration",
          mode: "before-completion",
          required: true,
          instructions: "Integrate all independent code change sets.",
          fallback: "block"
        }]
      }
    });

    const single = await service.runWorkbenchWorkflow("integration-supervision", { message: "one" });
    expect(single.run.status).toBe("passed");
    expect(single.run.output).toMatchObject({
      gates: [{ gateId: "integration", status: "skipped", activations: 0, executions: [] }]
    });
    expect(Object.keys(single.run.nodes).some((nodeId) => nodeId.startsWith("gate-integration"))).toBe(false);

    const multiple = await service.runWorkbenchWorkflow("integration-supervision", { message: "two" });
    expect(multiple.run.status).toBe("passed");
    expect(multiple.run.output).toMatchObject({
      gates: [{
        gateId: "integration",
        status: "passed",
        activations: 1,
        executions: [expect.objectContaining({ executorRoleId: "integrator", status: "passed" })]
      }]
    });
    expect(Object.keys(multiple.run.nodes)).toContain("gate-integration-r2-1");
  });

  it("routes an applicable required Gate to the supervisor fallback instead of blocking on a capability tag", async () => {
    // No member advertises quality.test, but the gate's fallback is "supervisor": capability tags are
    // hints, not a hard gate, so the gate routes to the supervisor rather than blocking. (Previously
    // this hard-blocked with "no eligible member or supervisor fallback".)
    const providers: ProviderRegistry = new Map([["missing-gate-executor", {
      id: "missing-gate-executor",
      validate: () => [],
      invoke: async (invocation) => {
        const node = invocation.templateContext.node as { metadata?: { kind?: string }; with?: { __supervisorRound?: number; __gateExecution?: { gateId?: string } } };
        const role = (invocation.templateContext.role as { id: string }).id;
        const round = Number(node.with?.__supervisorRound ?? 0);
        if (node.metadata?.kind === "gate") {
          return {
            stdout: JSON.stringify({
              action: "satisfy-gate",
              gateId: node.with?.__gateExecution?.gateId,
              summary: "Supervisor covered the test gate.",
              evidence: { tested: true }
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (role === "supervisor" && round === 1) {
          return {
            stdout: JSON.stringify({
              action: "delegate",
              assignments: [{ roleId: "builder", task: "Build code.", workKind: "code", changeSet: "server" }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (role === "supervisor") {
          return { stdout: JSON.stringify({ action: "finish", summary: "Done.", result: {} }), stderr: "", durationMs: 1 };
        }
        return { stdout: JSON.stringify({ message: "Built." }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("missing-gate-provider", { adapter: "missing-gate-executor", outputProtocol: "json" });
    await service.createEmployee({
      id: "missing-gate-lead",
      identity: { displayName: "Lead", background: "Leads.", responsibilities: ["Lead"] },
      providerId: "missing-gate-provider"
    });
    await service.createEmployee({
      id: "missing-gate-builder",
      identity: { displayName: "Builder", background: "Builds.", responsibilities: ["Build"] },
      capabilities: ["code.backend"],
      providerId: "missing-gate-provider"
    });
    await service.createManagementPolicy({
      id: "missing-gate-policy",
      allowedRoleIds: ["builder"],
      instructions: "Build and test."
    });
    await service.createWorkflow({
      id: "missing-gate-supervision",
      architecture: "supervisor",
      supervisor: { employeeId: "missing-gate-lead" },
      managementPolicy: { id: "missing-gate-policy" },
      members: [{ roleId: "builder", employeeId: "missing-gate-builder" }],
      flow: {
        stages: [
          { id: "plan", kind: "supervisor", title: "Plan" },
          { id: "loop", kind: "delegation-loop", title: "Build" },
          { id: "test", kind: "gate", title: "Test", gateId: "test" },
          { id: "delivery", kind: "delivery", title: "Deliver" }
        ],
        gates: [{
          id: "test",
          requiredCapability: "quality.test",
          mode: "before-completion",
          required: true,
          instructions: "Test the code change.",
          fallback: "supervisor",
          // This test exercises capability-tag routing/fallback, not e2e evidence. Disable the
          // quality.test default validator here so the fallback's non-e2e evidence still passes.
          validatorId: "none"
        }]
      }
    });

    const result = await service.runWorkbenchWorkflow("missing-gate-supervision", { message: "Build" });
    expect(result.run.status).toBe("passed");
    expect(result.run.output).toMatchObject({
      gates: [{
        gateId: "test",
        status: "passed",
        executions: [expect.objectContaining({ executorRoleId: "supervisor", status: "passed" })]
      }]
    });
    expect(JSON.stringify(result.run.output)).not.toContain("no eligible member");
  });

  it("runs after-each code Gates only for matching work and permits a capable supervisor fallback", async () => {
    const providers: ProviderRegistry = new Map([["after-each-gate", {
      id: "after-each-gate",
      validate: () => [],
      invoke: async (invocation) => {
        const node = invocation.templateContext.node as { metadata?: { kind?: string }; with?: { __supervisorRound?: number; __gateExecution?: { gateId?: string } } };
        const role = (invocation.templateContext.role as { id: string }).id;
        const round = Number(node.with?.__supervisorRound ?? 0);
        if (node.metadata?.kind === "gate") {
          return {
            stdout: JSON.stringify({
              action: "satisfy-gate",
              gateId: node.with?.__gateExecution?.gateId,
              summary: "Supervisor audit fallback passed.",
              evidence: { audited: true }
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (role === "supervisor" && round === 1) {
          return {
            stdout: JSON.stringify({
              action: "delegate",
              assignments: [
                { roleId: "builder", task: "Discuss the design.", workKind: "discussion" },
                { roleId: "builder", task: "Implement the design.", workKind: "code", changeSet: "server" }
              ]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (role === "supervisor") {
          return { stdout: JSON.stringify({ action: "finish", summary: "Done.", result: {} }), stderr: "", durationMs: 1 };
        }
        return { stdout: JSON.stringify({ message: "Work complete." }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("after-each-provider", { adapter: "after-each-gate", outputProtocol: "json" });
    await service.createEmployee({
      id: "after-each-lead",
      identity: { displayName: "Lead", background: "Leads and audits.", responsibilities: ["Lead", "Audit"] },
      capabilities: ["quality.audit"],
      providerId: "after-each-provider"
    });
    await service.createEmployee({
      id: "after-each-builder",
      identity: { displayName: "Builder", background: "Builds.", responsibilities: ["Build"] },
      capabilities: ["code.backend"],
      providerId: "after-each-provider"
    });
    await service.createManagementPolicy({
      id: "after-each-policy",
      allowedRoleIds: ["builder"],
      instructions: "Audit every code delegation.",
      limits: { maxParallelDelegations: 2 }
    });
    await service.createWorkflow({
      id: "after-each-supervision",
      architecture: "supervisor",
      supervisor: { employeeId: "after-each-lead" },
      managementPolicy: { id: "after-each-policy" },
      members: [{ roleId: "builder", employeeId: "after-each-builder" }],
      flow: {
        stages: [
          { id: "plan", kind: "supervisor", title: "Plan" },
          { id: "loop", kind: "delegation-loop", title: "Build" },
          { id: "audit", kind: "gate", title: "Audit", gateId: "audit" },
          { id: "delivery", kind: "delivery", title: "Deliver" }
        ],
        gates: [{
          id: "audit",
          requiredCapability: "quality.audit",
          mode: "after-each-delegation",
          required: true,
          instructions: "Audit this code delegation.",
          fallback: "supervisor"
        }]
      }
    });

    const result = await service.runWorkbenchWorkflow("after-each-supervision", { message: "Discuss and build" });
    expect(result.run.status).toBe("passed");
    expect(result.run.output).toMatchObject({
      gates: [{
        gateId: "audit",
        status: "passed",
        activations: 1,
        executions: [expect.objectContaining({ executorRoleId: "supervisor", status: "passed" })]
      }]
    });
    expect(Object.keys(result.run.nodes).filter((nodeId) => nodeId.startsWith("gate-audit"))).toEqual(["gate-audit-r1-1"]);
  });

  it("blocks a required quality.test Gate when the executor omits real e2e evidence and passes it when present", async () => {
    // A quality.test gate resolves the e2e-evidence validator by default: the gate executor's output
    // must carry at least one real e2e evidence entry. A tester member advertises quality.test, so it
    // is the hinted gate executor. One workflow, two runs keyed by the input message — the block
    // variant omits e2eEvidence (rejected), the pass variant supplies it (accepted).
    const providers: ProviderRegistry = new Map([["e2e-gate", {
      id: "e2e-gate",
      validate: () => [],
      invoke: async (invocation) => {
        const node = invocation.templateContext.node as { metadata?: { kind?: string }; with?: { __supervisorRound?: number } };
        const role = (invocation.templateContext.role as { id: string }).id;
        const round = Number(node.with?.__supervisorRound ?? 0);
        const message = String((invocation.templateContext.input as { message?: string }).message ?? "");
        if (node.metadata?.kind === "gate") {
          // The tester runs the gate. Only the pass variant returns real e2e evidence.
          return message === "with-e2e"
            ? {
                stdout: JSON.stringify({
                  message: "Ran the browser e2e suite.",
                  e2eEvidence: [{ method: "browser", steps: "open /app, submit the form", observed: "success toast rendered" }]
                }),
                stderr: "",
                durationMs: 1
              }
            : { stdout: JSON.stringify({ message: "Ran static type + lint checks only." }), stderr: "", durationMs: 1 };
        }
        if (role === "supervisor" && round === 1) {
          return {
            stdout: JSON.stringify({
              action: "delegate",
              assignments: [{ roleId: "builder", task: "Build the feature.", workKind: "code", changeSet: "server" }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (role === "supervisor") {
          return { stdout: JSON.stringify({ action: "finish", summary: "Deliver.", result: { delivered: true } }), stderr: "", durationMs: 1 };
        }
        return { stdout: JSON.stringify({ message: "Built the feature." }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("e2e-gate-provider", { adapter: "e2e-gate", outputProtocol: "json" });
    await service.createEmployee({
      id: "e2e-lead",
      identity: { displayName: "Lead", background: "Leads.", responsibilities: ["Lead"] },
      providerId: "e2e-gate-provider"
    });
    await service.createEmployee({
      id: "e2e-builder",
      identity: { displayName: "Builder", background: "Builds.", responsibilities: ["Build"] },
      capabilities: ["code.backend"],
      providerId: "e2e-gate-provider"
    });
    await service.createEmployee({
      id: "e2e-tester",
      identity: { displayName: "Tester", background: "Runs e2e.", responsibilities: ["Test"] },
      capabilities: ["quality.test"],
      providerId: "e2e-gate-provider",
      // The tester's output contract admits the e2eEvidence array the validator inspects.
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: {
          message: { type: "string" },
          e2eEvidence: {
            type: "array",
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
      id: "e2e-gate-policy",
      allowedRoleIds: ["builder", "tester"],
      instructions: "Deliver only after the e2e gate passes.",
      limits: { maxRounds: 2 }
    });
    await service.createWorkflow({
      id: "e2e-gate-supervision",
      architecture: "supervisor",
      supervisor: { employeeId: "e2e-lead" },
      managementPolicy: { id: "e2e-gate-policy" },
      members: [
        { roleId: "builder", employeeId: "e2e-builder" },
        { roleId: "tester", employeeId: "e2e-tester" }
      ],
      flow: {
        stages: [
          { id: "plan", kind: "supervisor", title: "Plan" },
          { id: "loop", kind: "delegation-loop", title: "Build" },
          { id: "e2e", kind: "gate", title: "E2E", gateId: "e2e" },
          { id: "delivery", kind: "delivery", title: "Deliver" }
        ],
        gates: [{
          id: "e2e",
          requiredCapability: "quality.test",
          mode: "before-completion",
          required: true,
          instructions: "Run the end-to-end test suite and report real evidence.",
          fallback: "block"
        }]
      }
    });

    // Block variant: no real e2e evidence → gate rejects, run blocks with the e2e reason surfaced.
    const blockedRun = await service.runWorkbenchWorkflow("e2e-gate-supervision", { message: "no-e2e" });
    expect(blockedRun.run.status).toBe("blocked");
    const blockedGates = (blockedRun.run.output as { gates: Array<{ gateId: string; status: string; reason: string | null }> }).gates;
    const blockedGate = blockedGates.find((gate) => gate.gateId === "e2e");
    expect(blockedGate?.status).not.toBe("passed");
    expect(String(blockedGate?.reason)).toMatch(/e2e/i);

    // Pass variant: real e2e evidence present → gate passes and no longer blocks the run.
    const passedRun = await service.runWorkbenchWorkflow("e2e-gate-supervision", { message: "with-e2e" });
    expect(passedRun.run.status).toBe("passed");
    const passedGates = (passedRun.run.output as { gates: Array<{ gateId: string; status: string }> }).gates;
    expect(passedGates.find((gate) => gate.gateId === "e2e")?.status).toBe("passed");
  });

  it("retries an unsatisfied required Gate after finish interception and preserves both evidence attempts", async () => {
    let gateAttempts = 0;
    const providers: ProviderRegistry = new Map([["retry-gate", {
      id: "retry-gate",
      validate: () => [],
      invoke: async (invocation) => {
        const node = invocation.templateContext.node as { metadata?: { kind?: string }; with?: { __supervisorRound?: number } };
        const role = (invocation.templateContext.role as { id: string }).id;
        const round = Number(node.with?.__supervisorRound ?? 0);
        if (node.metadata?.kind === "gate") {
          gateAttempts += 1;
          return {
            stdout: JSON.stringify({ message: `Audit ${gateAttempts}.`, verdict: gateAttempts === 1 ? "Block" : "Pass" }),
            stderr: "",
            durationMs: 1
          };
        }
        if (role === "supervisor" && round === 1) {
          return {
            stdout: JSON.stringify({
              action: "delegate",
              assignments: [{ roleId: "builder", task: "Build code.", workKind: "code", changeSet: "server" }]
            }),
            stderr: "",
            durationMs: 1
          };
        }
        if (role === "supervisor") {
          return { stdout: JSON.stringify({ action: "finish", summary: "Deliver.", result: { delivered: true } }), stderr: "", durationMs: 1 };
        }
        return { stdout: JSON.stringify({ message: "Built." }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), providers });
    await service.putProvider("retry-gate-provider", { adapter: "retry-gate", outputProtocol: "json" });
    await service.createEmployee({
      id: "retry-lead",
      identity: { displayName: "Lead", background: "Leads.", responsibilities: ["Lead"] },
      providerId: "retry-gate-provider"
    });
    await service.createEmployee({
      id: "retry-builder",
      identity: { displayName: "Builder", background: "Builds.", responsibilities: ["Build"] },
      capabilities: ["code.backend"],
      providerId: "retry-gate-provider"
    });
    await service.createEmployee({
      id: "retry-auditor",
      identity: { displayName: "Auditor", background: "Audits.", responsibilities: ["Audit"] },
      capabilities: ["quality.audit"],
      providerId: "retry-gate-provider",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message", "verdict"],
        properties: { message: { type: "string" }, verdict: { enum: ["Pass", "Block"] } }
      },
      verdict: { path: "verdict", pass: ["Pass"], block: ["Block"] }
    });
    await service.createManagementPolicy({
      id: "retry-gate-policy",
      allowedRoleIds: ["builder", "auditor"],
      instructions: "Deliver only after audit.",
      limits: { maxRounds: 3 }
    });
    await service.createWorkflow({
      id: "retry-gate-supervision",
      architecture: "supervisor",
      supervisor: { employeeId: "retry-lead" },
      managementPolicy: { id: "retry-gate-policy" },
      members: [
        { roleId: "builder", employeeId: "retry-builder" },
        { roleId: "auditor", employeeId: "retry-auditor" }
      ],
      flow: {
        stages: [
          { id: "plan", kind: "supervisor", title: "Plan" },
          { id: "loop", kind: "delegation-loop", title: "Build" },
          { id: "audit", kind: "gate", title: "Audit", gateId: "audit" },
          { id: "delivery", kind: "delivery", title: "Deliver" }
        ],
        gates: [{
          id: "audit",
          requiredCapability: "quality.audit",
          mode: "before-completion",
          required: true,
          instructions: "Audit the code change.",
          fallback: "block"
        }]
      }
    });

    const result = await service.runWorkbenchWorkflow("retry-gate-supervision", { message: "Build safely" });
    expect(result.run.status).toBe("passed");
    expect(result.run.output).toMatchObject({
      rounds: 3,
      gates: [{
        gateId: "audit",
        status: "passed",
        executions: [
          expect.objectContaining({ status: "blocked" }),
          expect.objectContaining({ status: "passed" })
        ]
      }]
    });
    expect(Object.keys(result.run.nodes)).toEqual([
      "supervisor-r1",
      "builder-r1-1",
      "supervisor-r2",
      "gate-audit-r2-1",
      "supervisor-r3",
      "gate-audit-r3-2"
    ]);
    const gateInstances = service.getActivitySnapshot().instances.filter((instance) => instance.runId === result.run.id && instance.kind === "gate");
    expect(gateInstances).toHaveLength(2);
  });
});

describe("Supervisor workflow version tracking", () => {
  async function seedTeam(service: WorkbenchService): Promise<void> {
    await service.createEmployee({
      id: "vt-lead",
      identity: { displayName: "Lead", background: "Leads.", responsibilities: ["Lead"] },
      providerId: "mock"
    });
    await service.createEmployee({
      id: "vt-worker",
      identity: { displayName: "Worker", background: "Works.", responsibilities: ["Work"] },
      providerId: "mock"
    });
    await service.createManagementPolicy({
      id: "vt-policy",
      allowedRoleIds: ["worker"],
      instructions: "Deliver.",
      completion: { requireDelegation: false }
    });
    await service.createWorkflow({
      id: "vt-team",
      architecture: "supervisor",
      supervisor: { employeeId: "vt-lead" },
      managementPolicy: { id: "vt-policy" },
      members: [{ roleId: "worker", employeeId: "vt-worker" }]
    });
  }

  it("defaults to latest and re-resolves newer employee/policy versions at run time", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await seedTeam(service);
    const created = service.getWorkflow("vt-team");
    if (created.architecture !== "supervisor") throw new Error("expected supervisor workflow");
    expect(created.updatePolicy).toBe("latest");
    expect(created.supervisor.employeeVersion).toBe(1);

    // Bump the member employee and the policy after the workflow was pinned at v1.
    await service.updateEmployee("vt-worker", { description: "Works harder." });
    await service.updateManagementPolicy("vt-policy", { instructions: "Deliver faster." });
    expect(service.getEmployee("vt-worker").version).toBe(2);
    expect(service.getManagementPolicy("vt-policy").version).toBe(2);

    const result = await service.runWorkbenchWorkflow("vt-team", { message: "Go" });
    // The run resolved and used the newest employee/policy versions (it completes without a version
    // error), yet the stored workflow still pins v1 — latest resolves per-run, it does not rewrite
    // the saved definition.
    expect(result.run.status).toBe("passed");
    expect(service.getWorkflow("vt-team").version).toBe(1);
  });

  it("keeps pinned versions when updatePolicy is locked", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await seedTeam(service);
    await service.updateWorkflow("vt-team", { architecture: "supervisor", updatePolicy: "locked" });
    await service.updateEmployee("vt-worker", { description: "Changed." });
    expect(service.getEmployee("vt-worker").version).toBe(2);

    const prepared = service.getWorkflow("vt-team");
    if (prepared.architecture !== "supervisor") throw new Error("expected supervisor workflow");
    expect(prepared.updatePolicy).toBe("locked");
    // Locked keeps the member pinned at v1 in the stored definition.
    expect(prepared.members[0]!.employeeVersion).toBe(1);
  });

  it("refresh re-pins to latest and reports the changes", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await seedTeam(service);
    await service.updateWorkflow("vt-team", { architecture: "supervisor", updatePolicy: "locked" });
    await service.updateEmployee("vt-worker", { description: "v2." });
    await service.updateManagementPolicy("vt-policy", { instructions: "v2." });
    await service.store.mutate((state) => {
      const current = state.skills["team-orchestration"]!;
      const next = { ...current, version: current.version + 1, updatedAt: "2026-08-11T00:00:00.000Z" };
      state.skills["team-orchestration"] = next;
      (state.skillHistory["team-orchestration"] ??= [current]).push(next);
    });

    const result = await service.refreshWorkflow("vt-team");
    expect(result.changed).toBe(true);
    const kinds = result.changes.map((change) => `${change.kind}:${change.from}->${change.to}`);
    expect(kinds).toContain("member:1->2");
    expect(kinds).toContain("management-policy:1->2");
    expect(kinds).toContain("orchestration-skill:8->9");
    const refreshed = service.getWorkflow("vt-team");
    if (refreshed.architecture !== "supervisor") throw new Error("expected supervisor workflow");
    expect(refreshed.members[0]!.employeeVersion).toBe(2);
    expect(refreshed.managementPolicy.version).toBe(2);
    expect(refreshed.orchestrationSkill.version).toBe(9);

    // A second refresh with nothing new reports no change.
    const again = await service.refreshWorkflow("vt-team");
    expect(again.changed).toBe(false);
    expect(again.changes).toEqual([]);
  });

  it("bulk-refreshes every active Entrance Policy pinned to an older team version and preserves history", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await seedTeam(service);
    await service.createEntrancePolicy({
      id: "team-entry-one",
      displayName: "Team entry one",
      leader: { workflowId: "vt-team" },
      default: { route: "leader" }
    });
    await service.createEntrancePolicy({
      id: "team-entry-two",
      displayName: "Team entry two",
      leader: { workflowId: "vt-team" },
      default: { route: "leader" }
    });
    await service.createEntrancePolicy({
      id: "direct-entry",
      displayName: "Direct entry",
      direct: { mode: "caller" },
      default: { route: "direct" }
    });
    await service.updateWorkflow("vt-team", { architecture: "supervisor", description: "Team v2." });
    expect(service.getWorkflow("vt-team").version).toBe(2);
    expect(service.getEntrancePolicy("team-entry-one").leader?.workflowVersion).toBe(1);

    const result = await service.refreshWorkflowEntrancePolicies("vt-team");

    expect(result).toMatchObject({
      workflowId: "vt-team",
      workflowVersion: 2,
      changed: true,
      changes: expect.arrayContaining([
        {
          policyId: "team-entry-one",
          fromPolicyVersion: 1,
          toPolicyVersion: 2,
          fromWorkflowVersion: 1,
          toWorkflowVersion: 2
        },
        {
          policyId: "team-entry-two",
          fromPolicyVersion: 1,
          toPolicyVersion: 2,
          fromWorkflowVersion: 1,
          toWorkflowVersion: 2
        }
      ])
    });
    expect(result.changes).toHaveLength(2);
    expect(service.getEntrancePolicy("team-entry-one")).toMatchObject({
      version: 2,
      leader: { workflowId: "vt-team", workflowVersion: 2 }
    });
    expect(service.getEntrancePolicyVersions("team-entry-one").map((policy) => policy.version)).toEqual([2, 1]);
    expect(service.getEntrancePolicy("direct-entry").version).toBe(1);

    const again = await service.refreshWorkflowEntrancePolicies("vt-team");
    expect(again).toMatchObject({ changed: false, changes: [] });
    expect(service.getEntrancePolicy("team-entry-one").version).toBe(2);
  });

  it("blocks a latest run when the newest policy no longer allows a member role", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await seedTeam(service);
    // New policy version drops the "worker" role slot the workflow member relies on.
    await service.updateManagementPolicy("vt-policy", { allowedRoleIds: ["reviewer"] });

    await expect(service.runWorkbenchWorkflow("vt-team", { message: "Go" })).rejects.toThrow(/no longer allows member role worker/);
  });
});
