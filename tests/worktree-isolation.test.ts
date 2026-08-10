import { afterEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/workbench/service.js";
import type { ProviderRegistry } from "../src/runtime/providers.js";

const roots: string[] = [];

function tmp(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-iso-")));
  roots.push(root);
  return root;
}

function gitRepo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-iso-repo-")));
  roots.push(root);
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "iso@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Iso Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "seed\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-m", "seed"], { cwd: root });
  return root;
}

function scriptedSupervisorProviders(
  options: { writeChange?: boolean; commitChange?: boolean; onInvoke?: () => void } = {}
): ProviderRegistry {
  let wroteChange = false;
  return new Map([["scripted-supervisor", {
    id: "scripted-supervisor",
    validate: () => [],
    invoke: async (invocation) => {
      options.onInvoke?.();
      if (options.writeChange && !wroteChange) {
        fs.writeFileSync(path.join(invocation.cwd, "delivery-feature.txt"), "candidate delivery\n", "utf8");
        if (options.commitChange) {
          execFileSync("git", ["-C", invocation.cwd, "add", "delivery-feature.txt"]);
          execFileSync("git", ["-C", invocation.cwd, "commit", "-m", "agent committed delivery"]);
        }
        wroteChange = true;
      }
      const role = (invocation.templateContext.role as { id: string }).id;
      const round = Number((invocation.templateContext.node as { with?: { __supervisorRound?: number } }).with?.__supervisorRound ?? 0);
      if (role === "supervisor" && round === 1) {
        return {
          stdout: JSON.stringify({
            action: "delegate",
            summary: "Collect specialist evidence.",
            assignments: [{
              roleId: "researcher",
              task: "Implement the supplied request.",
              workKind: "code",
              changeSet: "candidate"
            }]
          }),
          stderr: "",
          durationMs: 1
        };
      }
      if (role === "supervisor") {
        return { stdout: JSON.stringify({ action: "finish", summary: "Evidence accepted.", result: { answer: "complete" } }), stderr: "", durationMs: 1 };
      }
      const gate = (invocation.templateContext.node as { with?: { __gateExecution?: { requiredCapability?: string } } })
        .with?.__gateExecution;
      if (gate?.requiredCapability === "quality.test") {
        return {
          stdout: JSON.stringify({
            message: "Real e2e passed.",
            verdict: "pass",
            e2eEvidence: [{ method: "automation-run", steps: "Run the isolated behavior test", observed: "Passed" }]
          }),
          stderr: "",
          durationMs: 1
        };
      }
      if (gate?.requiredCapability === "quality.audit") {
        return { stdout: JSON.stringify({ message: "Independent audit passed.", verdict: "pass" }), stderr: "", durationMs: 1 };
      }
      return { stdout: JSON.stringify({ message: "Research complete." }), stderr: "", durationMs: 1 };
    }
  }]]);
}

async function isolationFixture(
  providerCwdKind: "git" | "plain",
  options: { writeChange?: boolean; commitChange?: boolean; independentAuditor?: boolean } = {}
) {
  const calls = { count: 0 };
  const service = await WorkbenchService.open({
    dataRoot: tmp(),
    providers: scriptedSupervisorProviders({ ...options, onInvoke: () => { calls.count += 1; } })
  });
  await service.putProvider("scripted-provider", { adapter: "scripted-supervisor", model: "supervisor-test-model", outputProtocol: "json" });
  const manager = await service.createEmployee({
    id: "iso-manager",
    identity: { displayName: "Iso Manager", background: "Coordinates.", responsibilities: ["Delegate"] },
    providerId: "scripted-provider"
  });
  const researcher = await service.createEmployee({
    id: "iso-researcher",
    identity: { displayName: "Iso Researcher", background: "Collects.", responsibilities: ["Research"] },
    providerId: "scripted-provider",
    capabilities: ["code.backend", ...(options.independentAuditor === false ? ["quality.audit"] : [])]
  });
  const tester = await service.createEmployee({
    id: "iso-tester",
    identity: { displayName: "Iso Tester", background: "Tests.", responsibilities: ["Run real e2e"] },
    providerId: "scripted-provider",
    capabilities: ["quality.test"],
    outputSchema: { type: "object" }
  });
  const auditor = options.independentAuditor === false ? undefined : await service.createEmployee({
    id: "iso-auditor",
    identity: { displayName: "Iso Auditor", background: "Audits.", responsibilities: ["Review independently"] },
    providerId: "scripted-provider",
    capabilities: ["quality.audit"],
    outputSchema: { type: "object" }
  });
  const policy = await service.createManagementPolicy({
    id: "iso-run-policy",
    displayName: "Iso Run Policy",
    description: "Delegate then finish in an isolated worktree.",
    allowedRoleIds: ["researcher", "tester", ...(auditor ? ["auditor"] : [])],
    instructions: "Delegate then finish.",
    limits: { maxRounds: 4, maxDelegations: 4, maxParallelDelegations: 2, maxDurationMs: 60_000 },
    execution: { isolation: "worktree" }
  });
  const workflow = await service.createWorkflow({
    id: "iso-supervised",
    architecture: "supervisor",
    description: "Team that runs in an isolated worktree.",
    supervisor: { employeeId: manager.id },
    managementPolicy: { id: policy.id },
    members: [
      { roleId: "researcher", description: "Implement.", employeeId: researcher.id },
      { roleId: "tester", description: "Run real e2e.", employeeId: tester.id },
      ...(auditor ? [{ roleId: "auditor", description: "Audit independently.", employeeId: auditor.id }] : [])
    ],
    flow: {
      stages: [
        { id: "plan", kind: "supervisor", title: "Plan" },
        { id: "delegation-loop", kind: "delegation-loop", title: "Delegate" },
        { id: "quality-test-stage", kind: "gate", title: "E2E", gateId: "quality-test" },
        { id: "quality-audit-stage", kind: "gate", title: "Audit", gateId: "quality-audit" },
        { id: "delivery", kind: "delivery", title: "Deliver" }
      ],
      gates: [
        {
          id: "quality-test", requiredCapability: "quality.test", mode: "before-completion",
          required: true, instructions: "Run real e2e.", fallback: "block"
        },
        {
          id: "quality-audit", requiredCapability: "quality.audit", mode: "before-completion",
          required: true, instructions: "Review the code independently.", fallback: "block"
        }
      ]
    }
  });
  const providerCwd = providerCwdKind === "git" ? gitRepo() : tmp();
  return { service, workflow, providerCwd, calls };
}

async function isolationWorkflow(providerCwdKind: "git" | "plain", options: { writeChange?: boolean; commitChange?: boolean } = {}) {
  const fixture = await isolationFixture(providerCwdKind, options);
  const { service, workflow, providerCwd } = fixture;
  const result = await service.runWorkbenchWorkflow(workflow.id, { message: "Investigate" }, { kind: "workbench" }, { providerCwd });
  return { ...fixture, result };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("management policy execution.isolation", () => {
  it("persists execution.isolation on a policy", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    const policy = await svc.createManagementPolicy({
      id: "iso-policy", displayName: "Iso", description: "d",
      allowedRoleIds: ["researcher"], instructions: "i",
      limits: { maxRounds: 2, maxDelegations: 2, maxParallelDelegations: 1, maxDurationMs: 60000 },
      execution: { isolation: "worktree" }
    } as never);
    expect(policy.execution?.isolation).toBe("worktree");
  });

  it("defaults to no execution isolation", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    const policy = await svc.createManagementPolicy({
      id: "plain", displayName: "Plain", description: "d",
      allowedRoleIds: ["researcher"], instructions: "i",
      limits: { maxRounds: 2, maxDelegations: 2, maxParallelDelegations: 1, maxDurationMs: 60000 }
    } as never);
    expect(policy.execution?.isolation).toBeUndefined();
  });
});

describe("runTrackedWorkflow worktree isolation", () => {
  it("resolves a trusted connected Project root for an Entrance Policy workflow start", async () => {
    const { service, workflow, providerCwd, calls } = await isolationFixture("git");
    await service.createProject({
      id: "requirement-source-project",
      name: "Requirement Source Project",
      description: "Supplies the trusted repository root for board-triggered work.",
      scope: "repository",
      rootPath: providerCwd,
      descriptorPath: path.join(providerCwd, "multi-agent.project.yaml"),
      roles: [{ id: "developer" }]
    });
    await service.createEntrancePolicy({
      id: "requirement-source-entrance",
      leader: { workflowId: workflow.id },
      default: { route: "leader" }
    });

    const dispatched = await service.dispatchEntrancePolicy("requirement-source-entrance", {
      route: "auto",
      tags: ["requirement-advancement"],
      signals: { requiresDynamicReplanning: true },
      message: "Advance this project requirement.",
      source: { kind: "workbench", project: "requirement-source-project", taskId: "req-1" }
    });
    expect(dispatched.dispatch.kind).toBe("invocation-started");
    if (dispatched.dispatch.kind !== "invocation-started") throw new Error("expected workflow receipt");
    const detail = await service.waitForInvocation(dispatched.dispatch.receipt.invocation.id);
    expect(detail.invocation.status).toBe("completed");
    expect(await service.getRun(dispatched.dispatch.receipt.runId)).toMatchObject({
      status: "passed",
      isolation: { mode: "worktree", worktreePath: expect.stringContaining(".multi-agent/worktrees") }
    });
    expect(calls.count).toBeGreaterThan(0);
  });

  it("runs a worktree-isolation supervisor workflow in a worktree and tears it down afterward", async () => {
    const { result, service, workflow } = await isolationWorkflow("git");
    expect(result.run.status).toBe("passed");
    expect(result.run.isolation?.mode).toBe("worktree");
    const worktreePath = result.run.isolation?.worktreePath;
    expect(worktreePath).toBeTruthy();
    // The run.json persisted on disk carries the same isolation evidence.
    const persisted = JSON.parse(fs.readFileSync(path.join(result.runDir, "run.json"), "utf8")) as {
      isolation?: { mode: string; worktreePath?: string };
    };
    expect(persisted.isolation?.mode).toBe("worktree");
    expect(persisted.isolation?.worktreePath).toBe(worktreePath);
    expect((await service.planWorkflow(workflow.id)).data).toMatchObject({
      policy: { execution: { isolation: "worktree" } }
    });
    const auditGate = (result.run.output as { gates: Array<{
      requiredCapability: string;
      executions: Array<{ executorRuntimeRole: string; sourceNodeIds: string[] }>;
    }> }).gates.find((gate) => gate.requiredCapability === "quality.audit");
    expect(auditGate?.executions[0]).toMatchObject({
      executorRuntimeRole: "member-auditor",
      sourceNodeIds: [expect.stringContaining("researcher-r")]
    });
    // The worktree is cleaned up once the run finishes.
    expect(fs.existsSync(worktreePath as string)).toBe(false);
  });

  it("keeps a changed worktree after the run for explicit delivery acceptance", async () => {
    const { result } = await isolationWorkflow("git", { writeChange: true });
    expect(result.run.status).toBe("passed");
    const worktreePath = result.run.isolation?.worktreePath;
    expect(worktreePath).toBeTruthy();
    expect(fs.existsSync(worktreePath as string)).toBe(true);
    expect(execFileSync(
      "git",
      ["-C", worktreePath as string, "status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8" }
    )).toContain("delivery-feature.txt");
  });

  it("keeps committed code changes even when the worktree status is clean", async () => {
    const { result } = await isolationWorkflow("git", { writeChange: true, commitChange: true });
    expect(result.run.status).toBe("passed");
    const worktreePath = result.run.isolation?.worktreePath;
    expect(worktreePath).toBeTruthy();
    expect(result.run.isolation?.baseCommit).toBeTruthy();
    expect(fs.existsSync(worktreePath as string)).toBe(true);
    expect(execFileSync("git", ["-C", worktreePath as string, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
    expect(execFileSync(
      "git",
      ["-C", worktreePath as string, "diff", "--name-only", result.run.isolation!.baseCommit!, "HEAD", "--"],
      { encoding: "utf8" }
    )).toContain("delivery-feature.txt");
  });

  it("fails closed before Provider execution when the execution root is not a Git repository", async () => {
    const { service, workflow, providerCwd, calls } = await isolationFixture("plain");
    await expect(service.runWorkbenchWorkflow(
      workflow.id,
      { message: "Investigate" },
      { kind: "workbench" },
      { providerCwd }
    )).rejects.toThrow(/worktree isolation setup failed before Provider execution|Git execution root/);
    expect(calls.count).toBe(0);
    expect(service.getActivitySnapshot().invocations[0]).toMatchObject({ status: "failed" });
  });

  it("rejects missing strict Gates at create, update, and latest-policy run time", async () => {
    const { service, workflow, providerCwd, calls } = await isolationFixture("git");
    await expect(service.createWorkflow({
      id: "missing-strict-gates",
      architecture: "supervisor",
      supervisor: workflow.supervisor,
      managementPolicy: workflow.managementPolicy,
      members: workflow.members
    })).rejects.toThrow(/quality\.test.*quality\.audit|quality\.test/);

    await expect(service.createWorkflow({
      id: "disabled-e2e-gate",
      architecture: "supervisor",
      supervisor: workflow.supervisor,
      managementPolicy: workflow.managementPolicy,
      members: workflow.members,
      flow: {
        stages: workflow.flow.stages,
        gates: workflow.flow.gates.map((gate) => gate.requiredCapability === "quality.test"
          ? { ...gate, validatorId: "none" }
          : gate)
      }
    })).rejects.toThrow(/quality\.test.*real e2e/);

    await expect(service.createWorkflow({
      id: "supervisor-audit-fallback",
      architecture: "supervisor",
      supervisor: workflow.supervisor,
      managementPolicy: workflow.managementPolicy,
      members: workflow.members,
      flow: {
        stages: workflow.flow.stages,
        gates: workflow.flow.gates.map((gate) => gate.requiredCapability === "quality.audit"
          ? { ...gate, fallback: "supervisor" as const }
          : gate)
      }
    })).rejects.toThrow(/quality\.audit.*fallback=block/);

    const withoutAudit = {
      stages: workflow.flow.stages.filter((stage) => stage.kind !== "gate" || stage.gateId !== "quality-audit"),
      gates: workflow.flow.gates.filter((gate) => gate.requiredCapability !== "quality.audit")
    };
    await expect(service.updateWorkflow(workflow.id, {
      architecture: "supervisor",
      flow: withoutAudit
    })).rejects.toThrow(/quality\.audit/);

    const nonePolicy = await service.createManagementPolicy({
      id: "becomes-worktree",
      allowedRoleIds: workflow.members.map((member) => member.roleId),
      instructions: "Start compatible, then become strict."
    });
    const legacyWorkflow = await service.createWorkflow({
      id: "legacy-before-worktree",
      architecture: "supervisor",
      supervisor: workflow.supervisor,
      managementPolicy: { id: nonePolicy.id },
      members: workflow.members
    });
    await service.updateManagementPolicy(nonePolicy.id, { execution: { isolation: "worktree" } });
    const callsBefore = calls.count;
    await expect(service.runWorkbenchWorkflow(
      legacyWorkflow.id,
      { message: "Must reject stale flow" },
      { kind: "workbench" },
      { providerCwd }
    )).rejects.toThrow(/quality\.test|quality\.audit/);
    expect(calls.count).toBe(callsBefore);
  });

  it("blocks quality.audit when only the reviewed runtime role has audit capability", async () => {
    const { service, workflow, providerCwd } = await isolationFixture("git", { independentAuditor: false });
    const result = await service.runWorkbenchWorkflow(
      workflow.id,
      { message: "Implement and audit" },
      { kind: "workbench" },
      { providerCwd }
    );
    expect(result.run.status).toBe("blocked");
    const auditGate = (result.run.output as { gates: Array<{
      requiredCapability: string;
      reason: string;
      executions: Array<{ status: string; evidence: { reason: string; excludedRuntimeRoles: string[] } }>;
    }> }).gates.find((gate) => gate.requiredCapability === "quality.audit");
    expect(auditGate).toMatchObject({
      reason: expect.stringContaining("independent quality.audit"),
      executions: [{
        status: "blocked",
        evidence: {
          reason: expect.stringContaining("independent quality.audit"),
          excludedRuntimeRoles: ["member-researcher"]
        }
      }]
    });
  });
});
