import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifest } from "../src/config/loadManifest.js";
import {
  CheckpointCell,
  ExecutionBudget,
  ExecutionBudgetExceededError
} from "../src/runtime/governance.js";
import type { ProviderAdapter, ProviderRegistry } from "../src/runtime/providers.js";
import { runWorkflow } from "../src/runtime/runner.js";
import { preflightStrictOutputSchema } from "../src/runtime/output.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("runtime governance", () => {
  it("rejects non-strict object output schemas before runtime invocation", () => {
    expect(() => preflightStrictOutputSchema({
      type: "object",
      properties: { message: { type: "string" } },
      required: [],
      additionalProperties: false
    }, "role")).toThrow(/properties and required must match exactly/);
    expect(() => preflightStrictOutputSchema({
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"]
    }, "role")).toThrow(/additionalProperties must be false/);
  });

  it("persists Provider preflight before invoke and fails closed on a strong capability mismatch", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-preflight-"));
    directories.push(directory);
    fs.cpSync(path.resolve("templates/review-council"), directory, { recursive: true });
    const loaded = loadManifest(path.join(directory, "multi-agent.yaml"));
    const providerId = loaded.manifest.roles["product-manager"]!.provider;
    loaded.manifest.providers[providerId]!.requiredCapabilities = ["structured-stream-v2"];
    let calls = 0;
    const providers: ProviderRegistry = new Map([["command", {
      id: "command",
      validate: () => [],
      describe: () => ({ version: 1, capabilities: [] }),
      async invoke() { calls += 1; throw new Error("must not invoke"); }
    }]]);
    const result = await runWorkflow(loaded, "review-council", {
      runId: "preflight-mismatch",
      input: { requirement: "x", changeSummary: "y", dashboardUrl: "z" },
      providers
    });
    expect(calls).toBe(0);
    const preflight = JSON.parse(fs.readFileSync(path.join(result.runDir, "nodes", "product-review", "attempt-1", "preflight.json"), "utf8"));
    expect(preflight.unsupportedCapabilities).toEqual(["structured-stream-v2"]);
  });

  it("rejects a schema required by the adapter before Provider invocation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-enforced-schema-"));
    directories.push(directory);
    fs.cpSync(path.resolve("templates/review-council"), directory, { recursive: true });
    const loaded = loadManifest(path.join(directory, "multi-agent.yaml"));
    loaded.manifest.workflows["review-council"]!.config.nodes = [
      { id: "product-review", role: "product-manager" }
    ];
    fs.writeFileSync(path.join(directory, "schemas", "reviewer-output.schema.json"), JSON.stringify({
      type: "object",
      properties: { verdict: { type: "string" }, message: { type: "string" }, risks: { type: "array" } },
      required: ["verdict", "message"],
      additionalProperties: false
    }), "utf8");
    let calls = 0;
    const providers: ProviderRegistry = new Map([["command", {
      id: "command",
      validate: () => [],
      describe: () => ({
        version: 1 as const,
        capabilities: ["strict-output-schema"],
        invocationRequirements: ["strict-output-schema"]
      }),
      async invoke() { calls += 1; return { stdout: "{}", stderr: "", durationMs: 1 }; }
    }]]);
    const result = await runWorkflow(loaded, "review-council", {
      runId: "enforced-schema", input: { requirement: "x", changeSummary: "y", dashboardUrl: "z" }, providers
    });
    expect(result.run.status).toBe("failed");
    expect(calls).toBe(0);
    expect(result.run.nodes["product-review"]?.error).toMatch(/properties and required must match exactly/);
  });

  it("keeps non-enforcing Providers compatible with ordinary JSON schemas", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-compatible-schema-"));
    directories.push(directory);
    fs.cpSync(path.resolve("templates/review-council"), directory, { recursive: true });
    const loaded = loadManifest(path.join(directory, "multi-agent.yaml"));
    loaded.manifest.workflows["review-council"]!.config.nodes = [
      { id: "product-review", role: "product-manager" }
    ];
    fs.writeFileSync(path.join(directory, "schemas", "reviewer-output.schema.json"), JSON.stringify({
      type: "object",
      properties: { verdict: { type: "string" }, message: { type: "string" }, risks: { type: "array" } },
      required: ["verdict", "message"],
      additionalProperties: false
    }), "utf8");
    let calls = 0;
    const providers: ProviderRegistry = new Map([["command", {
      id: "command", validate: () => [],
      async invoke() {
        calls += 1;
        return { stdout: JSON.stringify({ verdict: "Pass", message: "ok" }), stderr: "", durationMs: 1 };
      }
    }]]);
    const result = await runWorkflow(loaded, "review-council", {
      runId: "compatible-schema", input: { requirement: "x", changeSummary: "y", dashboardUrl: "z" }, providers
    });
    expect(calls).toBe(1);
    expect(result.run.status).toBe("passed");
  });

  it("rejects a corrupt durable checkpoint instead of silently rerunning a Run", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-checkpoint-"));
    directories.push(directory);
    fs.cpSync(path.resolve("templates/review-council"), directory, { recursive: true });
    const loaded = loadManifest(path.join(directory, "multi-agent.yaml"));
    const output = JSON.stringify({ verdict: "Pass", summary: "ok", evidence: ["e"], risks: [] });
    const chair = JSON.stringify({ verdict: "Pass", summary: "ok", agreements: [], disagreements: [], nextActions: [] });
    const providers: ProviderRegistry = new Map([["command", {
      id: "command", validate: () => [],
      async invoke(invocation) { return { stdout: invocation.prompt.includes("agreements") ? chair : output, stderr: "", durationMs: 1 }; }
    }]]);
    const first = await runWorkflow(loaded, "review-council", {
      runId: "corrupt-resume", input: { requirement: "x", changeSummary: "y", dashboardUrl: "z" }, providers
    });
    fs.writeFileSync(path.join(first.runDir, "checkpoint.json"), "{broken", "utf8");
    await expect(runWorkflow(loaded, "review-council", {
      runId: "corrupt-resume", input: { requirement: "x", changeSummary: "y", dashboardUrl: "z" }, providers, resume: true
    })).rejects.toThrow(/checkpoint is corrupt/);
  });

  it("projects large dependency output as a digest-verified ArtifactRef", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-context-"));
    directories.push(directory);
    fs.cpSync(path.resolve("templates/review-council"), directory, { recursive: true });
    const loaded = loadManifest(path.join(directory, "multi-agent.yaml"));
    const large = "evidence-".repeat(10_000);
    let chairPrompt = "";
    const providers: ProviderRegistry = new Map([["command", {
      id: "command", validate: () => [],
      async invoke(invocation) {
        if ((invocation.templateContext.run as { nodeId?: string }).nodeId === "final-decision") {
          chairPrompt = invocation.prompt;
          return { stdout: JSON.stringify({ verdict: "Pass", summary: "ok", agreements: [], disagreements: [], nextActions: [] }), stderr: "", durationMs: 1 };
        }
        return { stdout: JSON.stringify({ verdict: "Pass", summary: large, evidence: ["e"], risks: [] }), stderr: "", durationMs: 1 };
      }
    }]]);
    const result = await runWorkflow(loaded, "review-council", {
      runId: "bounded-context", input: { requirement: "x", changeSummary: "y", dashboardUrl: "z" }, providers
    });
    expect(result.run.status).toBe("passed");
    expect(chairPrompt).toContain("artifact-ref");
    expect(chairPrompt).not.toContain(large);
    const projection = JSON.parse(fs.readFileSync(path.join(result.runDir, "nodes", "final-decision", "attempt-1", "context-projection.json"), "utf8"));
    expect(Object.values(projection).every((entry) => (entry as { mode: string }).mode === "artifact")).toBe(true);
  });
  it("reserves concurrent budget atomically and preserves elapsed time on recovery", () => {
    let clock = 1_000;
    const budget = new ExecutionBudget({ providerCalls: 1, wallClockMs: 500 }, undefined, () => clock);
    const first = budget.reserve("providerCalls");
    expect(() => budget.reserve("providerCalls")).toThrow(ExecutionBudgetExceededError);
    first.release();
    budget.reserve("providerCalls").commit();
    clock = 1_300;
    const snapshot = budget.snapshot();
    const recovered = new ExecutionBudget(snapshot.limits, snapshot, () => clock);
    clock = 1_501;
    expect(() => recovered.assertWallClock()).toThrow(/wallClockMs exhausted/);
  });

  it("rejects stale checkpoint owners and fencing tokens", () => {
    const cell = new CheckpointCell<{ status: string }>();
    const first = cell.acquire("owner-a", 10_000, { status: "running" });
    expect(() => cell.acquire("owner-b", 10_000, { status: "stolen" }, first.revision)).toThrow(/held by owner-a/);
    const second = cell.compareAndSwap("owner-a", first.fencingToken, first.revision, { status: "passed" }, 10_000);
    expect(second.value.status).toBe("passed");
    expect(() => cell.compareAndSwap("owner-a", first.fencingToken, second.revision, { status: "late" }, 10_000))
      .toThrow(/fencing token is stale/);
  });

  it("authorizes at the actual Provider boundary and classifies denial without invoking it", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-governance-"));
    directories.push(directory);
    fs.cpSync(path.resolve("templates/review-council"), directory, { recursive: true });
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "command",
      validate: () => [],
      async invoke() {
        calls += 1;
        throw new Error("must not be called");
      }
    };
    const providers: ProviderRegistry = new Map([["command", adapter]]);
    const result = await runWorkflow(loadManifest(path.join(directory, "multi-agent.yaml")), "review-council", {
      input: { requirement: "x", changeSummary: "y", dashboardUrl: "http://localhost" },
      providers,
      capabilityBroker: {
        authorize: () => ({ decision: "denied", reason: "principal lacks provider capability" })
      }
    });

    expect(calls).toBe(0);
    expect(result.run.status).toBe("failed");
    expect(Object.values(result.run.nodes).some((node) => node.failure?.category === "authorization"
      && node.failure.kind === "denied")).toBe(true);
  });
});
