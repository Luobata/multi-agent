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
    expect(workflow.orchestrationSkill).toEqual({ id: "team-orchestration", version: 1 });

    const result = await service.runWorkbenchWorkflow(workflow.id, { message: "Inspect materialization" });
    const manifest = JSON.parse(fs.readFileSync(result.run.manifestPath, "utf8")) as {
      roles: Record<string, { skills: Array<{ id: string }>; identity: { metadata: Record<string, unknown> } }>;
      workflows: Record<string, { config: Record<string, unknown> }>;
    };
    expect(manifest.roles.supervisor?.skills.map((skill) => skill.id)).toEqual([
      "lead-method-v1",
      "team-orchestration-v1"
    ]);
    expect(manifest.roles["member-builder"]?.skills.map((skill) => skill.id)).toEqual(["build-method-v1"]);
    expect(manifest.roles.supervisor?.identity.metadata.runtimeSkillInjections).toEqual([{
      skillId: "team-orchestration",
      version: 1,
      reason: "supervisor-runtime"
    }]);
    expect(manifest.roles["member-builder"]?.identity.metadata.runtimeSkillInjections).toBeUndefined();
    expect(manifest.workflows[workflow.id]?.config).toMatchObject({
      supervisor: { capabilities: ["quality.audit"], skillInjection: { id: "team-orchestration", version: 1 } },
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
    expect(migrated.orchestrationSkill).toEqual({ id: "team-orchestration", version: 1 });
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
          fallback: "supervisor"
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
