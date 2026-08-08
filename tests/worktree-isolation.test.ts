import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/workbench/service.js";
import type { ProviderRegistry } from "../src/runtime/providers.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "wt-iso-")); }

function gitRepo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-iso-repo-")));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "iso@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Iso Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "seed\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-m", "seed"], { cwd: root });
  return root;
}

function scriptedSupervisorProviders(): ProviderRegistry {
  return new Map([["scripted-supervisor", {
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
        return { stdout: JSON.stringify({ action: "finish", summary: "Evidence accepted.", result: { answer: "complete" } }), stderr: "", durationMs: 1 };
      }
      return { stdout: JSON.stringify({ message: "Research complete." }), stderr: "", durationMs: 1 };
    }
  }]]);
}

async function isolationWorkflow(providerCwdKind: "git" | "plain") {
  const service = await WorkbenchService.open({ dataRoot: tmp(), providers: scriptedSupervisorProviders() });
  await service.putProvider("scripted-provider", { adapter: "scripted-supervisor", model: "supervisor-test-model", outputProtocol: "json" });
  const manager = await service.createEmployee({
    id: "iso-manager",
    identity: { displayName: "Iso Manager", background: "Coordinates.", responsibilities: ["Delegate"] },
    providerId: "scripted-provider"
  });
  const researcher = await service.createEmployee({
    id: "iso-researcher",
    identity: { displayName: "Iso Researcher", background: "Collects.", responsibilities: ["Research"] },
    providerId: "scripted-provider"
  });
  const policy = await service.createManagementPolicy({
    id: "iso-run-policy",
    displayName: "Iso Run Policy",
    description: "Delegate then finish in an isolated worktree.",
    allowedRoleIds: ["researcher"],
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
    members: [{ roleId: "researcher", description: "Collect.", employeeId: researcher.id }]
  });
  const providerCwd = providerCwdKind === "git" ? gitRepo() : tmp();
  const result = await service.runWorkbenchWorkflow(workflow.id, { message: "Investigate" }, { kind: "workbench" }, { providerCwd });
  return { result, providerCwd };
}

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
  it("runs a worktree-isolation supervisor workflow in a worktree and tears it down afterward", async () => {
    const { result } = await isolationWorkflow("git");
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
    // The worktree is cleaned up once the run finishes.
    expect(fs.existsSync(worktreePath as string)).toBe(false);
  });

  it("falls back to no isolation when the execution root is not a git repository", async () => {
    const { result } = await isolationWorkflow("plain");
    expect(result.run.status).toBe("passed");
    expect(result.run.isolation?.mode).toBe("none");
    expect(result.run.isolation?.fallbackReason ?? "").toMatch(/git/i);
    const persisted = JSON.parse(fs.readFileSync(path.join(result.runDir, "run.json"), "utf8")) as {
      isolation?: { mode: string; fallbackReason?: string };
    };
    expect(persisted.isolation?.mode).toBe("none");
    expect(persisted.isolation?.fallbackReason ?? "").toMatch(/git/i);
  });
});
