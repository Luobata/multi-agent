import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderRegistry } from "../src/runtime/providers.js";
import { WorkbenchService } from "../src/workbench/service.js";
import { loadManifest } from "../src/config/loadManifest.js";
import { runWorkflow } from "../src/runtime/runner.js";

const roots: string[] = [];
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), "real-supervisor-governance-")); roots.push(value); return value; };
const identity = (name: string) => ({ displayName: name, background: `${name} governance fixture.`, responsibilities: ["Deliver evidence"] });

afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

async function team(service: WorkbenchService, providerId: string) {
  await service.putProvider(providerId, { adapter: "real-supervisor", model: "deterministic", outputProtocol: "json" });
  await service.createEmployee({ id: "real-leader", identity: identity("Leader"), providerId, capabilities: ["coordination"] });
  await service.createEmployee({ id: "real-builder", identity: identity("Builder"), providerId, capabilities: ["code.backend"] });
  await service.createEmployee({ id: "real-auditor", identity: identity("Auditor"), providerId, capabilities: ["quality.audit"] });
  const policy = await service.createManagementPolicy({
    id: "real-policy", allowedRoleIds: ["builder", "auditor"], instructions: "Build, independently audit, then finish.",
    limits: { maxRounds: 5, maxDelegations: 3, maxParallelDelegations: 2, maxDurationMs: 30_000 }, completion: { requireDelegation: false }
  });
  return policy;
}

describe("real Supervisor governance through public Workbench paths", () => {
  it("atomically rejects an over-budget delegation batch before any worker starts", async () => {
    let workerCalls = 0;
    const providers: ProviderRegistry = new Map([["real-supervisor", {
      id: "real-supervisor", validate: () => [],
      invoke: async (invocation) => {
        const role = (invocation.templateContext.role as { id: string }).id;
        if (role === "supervisor") return {
          stdout: JSON.stringify({ action: "delegate", assignments: [{ roleId: "builder", task: "must not start" }] }),
          stderr: "", durationMs: 1
        };
        workerCalls += 1;
        return { stdout: JSON.stringify({ message: "unexpected" }), stderr: "", durationMs: 1 };
      }
    }]]);
    const service = await WorkbenchService.open({ dataRoot: root(), providers, executionBudget: { delegations: 0, providerCalls: 2, attempts: 2, depth: 1 } });
    const policy = await team(service, "budget-provider");
    await service.createWorkflow({
      id: "budget-race", architecture: "supervisor", supervisor: { employeeId: "real-leader" },
      managementPolicy: { id: policy.id }, members: [{ roleId: "builder", employeeId: "real-builder" }]
    });
    await expect(service.startWorkbenchWorkflow("budget-race", { message: "enforce quota" })
      .then((receipt) => service.waitForInvocation(receipt.invocation.id))).resolves.toMatchObject({ invocation: { status: "failed" } });
    expect(workerCalls).toBe(0);
  });

  it("real-supervisor-s1-s12", async () => {
    const calls: string[] = [];
    let gateInvocations = 0;
    const providers: ProviderRegistry = new Map([["real-supervisor", {
      id: "real-supervisor", validate: () => [], describe: () => ({ version: 1, capabilities: [] }),
      preflight: async () => { calls.push("preflight"); return []; },
      invoke: async (invocation) => {
        calls.push("invoke");
        const role = (invocation.templateContext.role as { id: string }).id;
        const round = Number((invocation.templateContext.node as { with?: { __supervisorRound?: number; __gateExecution?: unknown } }).with?.__supervisorRound ?? 0);
        const gate = (invocation.templateContext.node as { with?: { __gateExecution?: { gateId?: string } } }).with?.__gateExecution;
        if (gate?.gateId) {
          gateInvocations += 1;
          return { stdout: JSON.stringify({ message: "Independent audit evidence passed: audit-session-independent." }), stderr: "", durationMs: 1 };
        }
        if (role === "supervisor" && round === 1) return { stdout: JSON.stringify({ action: "delegate", summary: "Build first.", assignments: [{ roleId: "builder", task: "Implement bounded change.", workKind: "code", changeSet: "server" }] }), stderr: "", durationMs: 1 };
        if (role === "supervisor") return { stdout: JSON.stringify({ action: "finish", summary: "Governed delivery complete.", result: { delivered: true } }), stderr: "", durationMs: 1 };
        return { stdout: JSON.stringify({ message: `Builder produced digestible evidence.${"x".repeat(70_000)}` }), stderr: "", durationMs: 1 };
      }
    }]]);
    const authorizations: string[] = [];
    const dataRoot = root();
    const service = await WorkbenchService.open({
      dataRoot, providers,
      capabilityBroker: { authorize: (intent) => { authorizations.push(intent.capability); return { decision: "allowed" }; } },
      executionBudget: { providerCalls: 8, attempts: 8, delegations: 3, gates: 2, depth: 5, wallClockMs: 30_000 }
    });
    const policy = await team(service, "real-provider");
    const workflow = await service.createWorkflow({
      id: "real-governed", architecture: "supervisor", supervisor: { employeeId: "real-leader" }, managementPolicy: { id: policy.id },
      members: [{ roleId: "builder", employeeId: "real-builder" }, { roleId: "auditor", employeeId: "real-auditor" }],
      policyPackRef: { id: "software-delivery", version: 1 },
      separationOfDuties: { producerRoleIds: ["builder"], approverRoleIds: ["auditor"], mustDifferEmployee: true, sameSessionForbidden: true, independentEvidenceRequired: true },
      flow: { stages: [{ id: "plan", kind: "supervisor", title: "Plan" }, { id: "work", kind: "delegation-loop", title: "Work" }, { id: "audit-stage", kind: "gate", title: "Audit", gateId: "audit" }, { id: "delivery", kind: "delivery", title: "Delivery" }], gates: [{ id: "audit", requiredCapability: "quality.audit", mode: "before-completion", required: true, instructions: "Independent audit.", fallback: "block" }] }
    });
    await service.createPublication({ id: "real-governed-publication", name: "Governed", target: { kind: "workflow", id: workflow.id } });
    const result = await service.invokePublication("real-governed-publication", { message: "Deliver safely" });
    if (!("run" in result)) throw new Error("expected workflow result");
    expect(result.run.status).toBe("passed");
    expect(calls[0]).toBe("preflight");
    expect(calls.indexOf("preflight")).toBeLessThan(calls.indexOf("invoke"));
    expect(authorizations.length).toBeGreaterThan(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.runDir, "run-manifest.json"), "utf8"));
    expect(manifest.budget.used).toMatchObject({ providerCalls: expect.any(Number), attempts: expect.any(Number), delegations: 1, gates: 1, depth: expect.any(Number) });
    expect(manifest.budget.reserved).toMatchObject({ providerCalls: 0, attempts: 0 });
    expect(gateInvocations).toBe(1);
    const resumed = await runWorkflow(
      loadManifest(result.run.manifestPath, { providers }),
      workflow.id,
      {
        runId: result.run.id,
        input: { message: "Deliver safely" },
        providers,
        artifactRoot: path.join(dataRoot, "artifacts"),
        resume: true
      }
    );
    expect(resumed.run.status).toBe("passed");
    expect(gateInvocations).toBe(1);
    const resumedManifest = JSON.parse(fs.readFileSync(path.join(result.runDir, "run-manifest.json"), "utf8"));
    expect(resumedManifest.budget.used.gates).toBe(1);
    expect(fs.readFileSync(path.join(result.runDir, "events.jsonl"), "utf8")).toContain("gate.shard.reused");
    expect(JSON.parse(fs.readFileSync(path.join(result.runDir, "effective-policy-pack.json"), "utf8"))).toMatchObject({ ref: { id: "software-delivery", version: 1 }, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const projection = JSON.parse(fs.readFileSync(path.join(result.runDir, "nodes", "supervisor-r2", "attempt-1", "context-projection.json"), "utf8"));
    expect(Object.values(projection).find((value) => (value as { mode?: string }).mode === "artifact")).toMatchObject({
      mode: "artifact", kind: "artifact-ref", digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), bytes: expect.any(Number)
    });
    const checkpoint = JSON.parse(fs.readFileSync(path.join(result.runDir, "checkpoint.json"), "utf8"));
    expect(checkpoint).toMatchObject({ revision: expect.any(Number), fencingToken: expect.any(Number), value: { cancellationEpoch: 0 } });
    expect(resumedManifest.checkpointRevision).toBe(checkpoint.revision);
    const invocation = Object.values(service.getActivitySnapshot().invocations).find((item) => item.runId === result.run.id)!;
    expect(invocation.executionSnapshot?.publication).toMatchObject({ publicationVersion: 1, targetVersion: workflow.version, releaseChannel: "pinned" });
    const receipt = await service.getRunReceipt(result.run.id);
    expect((receipt as Record<string, unknown>).budget).toMatchObject({ used: expect.any(Object) });
    expect(receipt.evidence.some((item: { kind: string }) => item.kind.includes("prompt"))).toBe(true);
    expect(receipt.evidence.some((item: { kind: string }) => item.kind.includes("raw-output"))).toBe(true);
    fs.writeFileSync(path.join(path.dirname(result.runDir), "index.json"), "{broken", "utf8");
    expect((await service.listRuns()).some((item) => (item as { id: string }).id === result.run.id)).toBe(true);

    const classify = async (mode: "denied" | "technical") => {
      let invoked = 0;
      const registry: ProviderRegistry = new Map([["real-supervisor", { id: "real-supervisor", validate: () => [], preflight: async () => [], invoke: async () => { invoked += 1; return { stdout: JSON.stringify({ message: "unexpected" }), stderr: "", durationMs: 1 }; } }]]);
      const classified = await WorkbenchService.open({ dataRoot: root(), providers: registry, capabilityBroker: { authorize: () => {
        if (mode === "technical") throw new Error("broker offline");
        return { decision: mode };
      } } });
      await classified.putProvider("classified-provider", { adapter: "real-supervisor", outputProtocol: "json" });
      const worker = await classified.createEmployee({ id: `classified-${mode}`, identity: identity(mode), providerId: "classified-provider" });
      await classified.createWorkflow({ id: `classified-${mode}-flow`, nodes: [{ id: "work", employeeId: worker.id }] });
      await classified.createPublication({ id: `classified-${mode}-publication`, name: mode, target: { kind: "workflow", id: `classified-${mode}-flow` } });
      const classifiedResult = await classified.invokePublication(`classified-${mode}-publication`, { message: mode });
      if (!("run" in classifiedResult)) throw new Error("expected classified workflow result");
      return { run: classifiedResult.run, invoked };
    };
    const denied = await classify("denied");
    expect(denied).toMatchObject({ invoked: 0, run: { status: "failed", nodes: { work: { failure: { category: "authorization", kind: "denied" } } } } });
    const technical = await classify("technical");
    expect(technical).toMatchObject({ invoked: 0, run: { status: "failed", nodes: { work: { failure: { category: "authorization-technical", kind: "broker-unavailable" } } } } });

    for (const decision of ["approve", "reject"] as const) {
      let invoked = 0;
      const registry: ProviderRegistry = new Map([["real-supervisor", {
        id: "real-supervisor", validate: () => [], preflight: async () => [],
        invoke: async () => { invoked += 1; return { stdout: JSON.stringify({ message: "approved work" }), stderr: "", durationMs: 1 }; }
      }]]);
      const approvalRoot = root();
      const approvalService = await WorkbenchService.open({
        dataRoot: approvalRoot, providers: registry,
        capabilityBroker: { authorize: () => ({ decision: "approval-required", reason: "operator grant required" }) }
      });
      await approvalService.putProvider(`approval-${decision}-provider`, { adapter: "real-supervisor", outputProtocol: "json" });
      const worker = await approvalService.createEmployee({ id: `approval-${decision}-worker`, identity: identity(decision), providerId: `approval-${decision}-provider` });
      await approvalService.createWorkflow({ id: `approval-${decision}-flow`, nodes: [{ id: "work", employeeId: worker.id }] });
      const receipt = await approvalService.startWorkbenchWorkflow(`approval-${decision}-flow`, { message: decision });
      let pending = approvalService.listHumanDecisionRequests({ invocationId: receipt.invocation.id, status: "pending" })[0];
      for (let attempt = 0; !pending && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        pending = approvalService.listHumanDecisionRequests({ invocationId: receipt.invocation.id, status: "pending" })[0];
      }
      expect(pending).toMatchObject({
        riskCategory: "irreversible-other",
        proposedAction: { action: "authorize-side-effect", intent: { kind: "provider-call" } }
      });
      expect(invoked).toBe(0);
      await approvalService.decideHumanDecisionRequest(pending!.id, { decision, decidedBy: "governance-test" });
      const completed = await approvalService.waitForInvocation(receipt.invocation.id);
      expect(invoked).toBe(decision === "approve" ? 1 : 0);
      const completedRun = completed.run as { nodes: Record<string, unknown> };
      expect(completedRun.nodes.work).toMatchObject(decision === "approve"
        ? { status: "passed" }
        : { status: "blocked", failure: { category: "authorization", kind: "approval-required" } });
      const events = fs.readFileSync(path.join(approvalRoot, "artifacts", "runs", receipt.runId, "events.jsonl"), "utf8");
      if (decision === "approve") expect(events).toContain("node.authorization.granted");
    }
  }, 15_000);

  it("real-supervisor-legacy-mock", async () => {
    const providers: ProviderRegistry = new Map([["real-supervisor", { id: "real-supervisor", validate: () => [], invoke: async (invocation) => ({ stdout: JSON.stringify((invocation.templateContext.role as { id: string }).id === "supervisor" ? { action: "finish", summary: "Legacy complete.", result: { compatible: true } } : { message: "legacy" }), stderr: "", durationMs: 1 }) }]]);
    const service = await WorkbenchService.open({ dataRoot: root(), providers });
    const policy = await team(service, "legacy-provider");
    await service.createWorkflow({ id: "legacy-supervisor", architecture: "supervisor", supervisor: { employeeId: "real-leader" }, managementPolicy: { id: policy.id }, members: [{ roleId: "builder", employeeId: "real-builder" }] });
    await service.createPublication({ id: "legacy-publication", name: "Legacy", target: { kind: "workflow", id: "legacy-supervisor" } });
    const result = await service.invokePublication("legacy-publication", { message: "legacy compatibility" });
    if (!("run" in result)) throw new Error("expected workflow result");
    expect(result.run.status).toBe("passed");
    const events = fs.readFileSync(path.join(result.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("legacy manifest has no CapabilityBroker");
    const attempt = path.join(result.runDir, "nodes", "supervisor-r1", "attempt-1");
    for (const file of ["prompt.md", "raw-output.txt", "result.json", "metadata.json"]) expect(fs.existsSync(path.join(attempt, file))).toBe(true);
    expect(fs.existsSync(path.join(result.runDir, "run.json"))).toBe(true);
  });
});
