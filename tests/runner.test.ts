import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifest } from "../src/config/loadManifest.js";
import { ProviderExecutionError } from "../src/core/errors.js";
import type { ProviderAdapter, ProviderRegistry } from "../src/runtime/providers.js";
import { runWorkflow } from "../src/runtime/runner.js";

const temporaryDirectories: string[] = [];

function fixture(): { directory: string; config: string; input: Record<string, string> } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-runner-"));
  temporaryDirectories.push(directory);
  fs.cpSync(path.resolve("templates/review-council"), directory, { recursive: true });
  return {
    directory,
    config: path.join(directory, "multi-agent.yaml"),
    input: {
      requirement: "Resume at the first unreviewed file.",
      changeSummary: "Adds a persisted cursor.",
      dashboardUrl: "http://127.0.0.1:4767/review/test"
    }
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("workflow runtime", () => {
  it("resumes a durable Run without repeating successful nodes", async () => {
    const { config, input } = fixture();
    const loaded = loadManifest(config);
    const calls: string[] = [];
    const adapter: ProviderAdapter = {
      id: "command",
      validate: () => [],
      async invoke(invocation) {
        const role = (invocation.templateContext.role as { id: string }).id;
        calls.push(role);
        const output = role === "chair"
          ? { verdict: "Pass", summary: "approved", agreements: ["evidence"], disagreements: [], nextActions: [] }
          : { verdict: "Pass", summary: "reviewed", evidence: ["evidence"], risks: [] };
        return { stdout: JSON.stringify(output), stderr: "", durationMs: 1 };
      }
    };
    const providers: ProviderRegistry = new Map([["command", adapter]]);
    const runId = "run-durable-resume-1";
    const first = await runWorkflow(loaded, "review-council", { runId, input, providers });
    expect(first.run.status).toBe("passed");
    expect(calls).toHaveLength(4);

    const runPath = path.join(first.runDir, "run.json");
    const interrupted = JSON.parse(fs.readFileSync(runPath, "utf8")) as typeof first.run;
    interrupted.status = "running";
    delete interrupted.completedAt;
    const final = interrupted.nodes["final-decision"]!;
    final.status = "running";
    delete final.completedAt;
    delete final.output;
    fs.writeFileSync(runPath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");
    calls.length = 0;

    const resumed = await runWorkflow(loaded, "review-council", { runId, input, providers, resume: true });

    expect(resumed.run.status).toBe("passed");
    expect(calls).toEqual(["chair"]);
    expect(resumed.run.nodes["product-review"]?.attempts).toBe(1);
    expect(resumed.run.nodes["design-review"]?.attempts).toBe(1);
    expect(resumed.run.nodes["test-review"]?.attempts).toBe(1);
    expect(resumed.run.nodes["final-decision"]?.attempts).toBe(2);
    const events = fs.readFileSync(path.join(resumed.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"run.resumed"');
    expect(events).toContain('"type":"node.replayed"');
  });

  it("runs the bundled council and persists complete evidence", async () => {
    const { config, input } = fixture();
    const result = await runWorkflow(loadManifest(config), "review-council", { input });

    expect(result.run.status).toBe("passed");
    expect(result.run.architecture).toBe("graph");
    expect(result.run.nodes["final-decision"]?.status).toBe("passed");
    expect(fs.existsSync(path.join(result.runDir, "run.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.runDir, "events.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(result.runDir, "nodes", "product-review", "attempt-1", "prompt.md"))).toBe(true);
    expect(fs.existsSync(path.join(result.runDir, "nodes", "product-review", "attempt-1", "system-prompt.md"))).toBe(true);
    expect(fs.existsSync(path.join(result.runDir, "nodes", "product-review", "attempt-1", "request-prompt.md"))).toBe(true);
    expect(fs.existsSync(path.join(result.runDir, "nodes", "product-review", "attempt-1", "stdout.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(result.runDir, "nodes", "product-review", "attempt-1", "system-prompt.md"), "utf8")).toContain(
      "Requirement Analysis"
    );
    const events = fs.readFileSync(path.join(result.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; nodeId?: string });
    expect(events.some((event) => event.type === "node.started" && event.nodeId === "product-review")).toBe(true);
    expect(events.at(-1)?.type).toBe("run.passed");
    const persisted = JSON.parse(fs.readFileSync(path.join(result.runDir, "run.json"), "utf8")) as typeof result.run;
    expect(Object.values(persisted.nodes).every((node) => !["pending", "running"].includes(node.status))).toBe(true);
  });

  it("lets synthesis consume a domain Block", async () => {
    const { config, input } = fixture();
    const contexts: Record<string, unknown>[] = [];
    const invocationDirectories: string[] = [];
    const providerCwd = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-provider-cwd-"));
    temporaryDirectories.push(providerCwd);
    const adapter: ProviderAdapter = {
      id: "command",
      validate: () => [],
      async invoke(invocation) {
        contexts.push(invocation.templateContext);
        invocationDirectories.push(invocation.cwd);
        const role = (invocation.templateContext.role as { id: string }).id;
        const output = role === "chair"
          ? { verdict: "Block", summary: "One reviewer blocked.", agreements: [], disagreements: ["Runtime evidence missing."], nextActions: ["Collect evidence."] }
          : { verdict: role === "designer" ? "Block" : "Pass", summary: "reviewed", evidence: ["evidence"], risks: [] };
        return { stdout: JSON.stringify(output), stderr: "", durationMs: 1 };
      }
    };
    const providers: ProviderRegistry = new Map([["command", adapter]]);
    const result = await runWorkflow(loadManifest(config), "review-council", { input, providers, providerCwd });

    expect(result.run.nodes["design-review"]?.status).toBe("blocked");
    expect(result.run.nodes["final-decision"]?.status).toBe("blocked");
    expect(result.run.status).toBe("blocked");
    const productContext = contexts.find((context) => (context.role as { id: string }).id === "product-manager");
    const resolvedRole = productContext?.role as {
      identity: { displayName: string };
      toolsCsv: string;
      nativeDefinitionJson: string;
    };
    expect(resolvedRole.identity.displayName).toBe("Product Manager");
    expect(resolvedRole.toolsCsv).toBe("read-repository");
    expect(JSON.parse(resolvedRole.nativeDefinitionJson)["product-manager"].prompt).toContain("Requirement Analysis");
    expect(productContext?.requestPrompt).toContain("Resume at the first unreviewed file");
    expect(invocationDirectories.every((directory) => directory === providerCwd)).toBe(true);
    expect((productContext?.run as { projectRoot?: string }).projectRoot).toBe(providerCwd);
  });

  it("skips synthesis after a technical dependency failure", async () => {
    const { config, input } = fixture();
    const adapter: ProviderAdapter = {
      id: "command",
      validate: () => [],
      async invoke(invocation) {
        const role = (invocation.templateContext.role as { id: string }).id;
        if (role === "designer") throw new Error("provider unavailable");
        return {
          stdout: JSON.stringify({ verdict: "Pass", summary: "reviewed", evidence: ["evidence"], risks: [] }),
          stderr: "",
          durationMs: 1
        };
      }
    };
    const providers: ProviderRegistry = new Map([["command", adapter]]);
    const result = await runWorkflow(loadManifest(config), "review-council", { input, providers });

    expect(result.run.nodes["design-review"]?.status).toBe("failed");
    expect(result.run.nodes["final-decision"]?.status).toBe("skipped");
    expect(result.run.status).toBe("failed");
  });

  it("persists Provider progress and long-running events", async () => {
    const { config, input } = fixture();
    const loaded = loadManifest(config);
    loaded.manifest.workflows["progress-review"] = {
      architecture: "graph",
      config: { nodes: [{ id: "review", role: "product-manager" }] }
    };
    const observed: string[] = [];
    const adapter: ProviderAdapter = {
      id: "command",
      validate: () => [],
      async invoke(invocation) {
        const common = {
          at: new Date().toISOString(),
          stream: "stderr" as const,
          chunkBytes: 4,
          totalBytes: 4,
          elapsedMs: 10,
          idleMs: 0,
          softTimeoutMs: 20,
          idleTimeoutMs: 50,
          hardTimeoutMs: 100,
          longRunning: false
        };
        await invocation.onProgress?.({ ...common, kind: "output" });
        await invocation.onProgress?.({
          ...common,
          kind: "long-running",
          stream: null,
          chunkBytes: 0,
          elapsedMs: 20,
          idleMs: 10,
          longRunning: true
        });
        return {
          stdout: JSON.stringify({ verdict: "Pass", summary: "reviewed", evidence: ["evidence"], risks: [] }),
          stderr: "tick",
          durationMs: 30
        };
      }
    };

    const result = await runWorkflow(loaded, "progress-review", {
      input,
      providers: new Map([["command", adapter]]),
      onEvent: (event) => { observed.push(event.type); }
    });

    expect(result.run.status).toBe("passed");
    expect(observed).toEqual(expect.arrayContaining(["node.progress", "node.long-running"]));
    const events = fs.readFileSync(path.join(result.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"node.progress"');
    expect(events).toContain('"type":"node.long-running"');
  });

  it("records node preparation failures without abandoning sibling-safe architecture scheduling", async () => {
    const { config, input } = fixture();
    const loaded = loadManifest(config);
    loaded.manifest.workflows["prepared-review"] = {
      architecture: "graph",
      config: {
        nodes: [
          { id: "review", role: "product-manager" },
          { id: "sibling", role: "designer" }
        ]
      }
    };
    let providerCalls = 0;
    const adapter: ProviderAdapter = {
      id: "command",
      validate: () => [],
      async invoke() {
        providerCalls += 1;
        return {
          stdout: JSON.stringify({ verdict: "Pass", summary: "reviewed", evidence: ["evidence"], risks: [] }),
          stderr: "",
          durationMs: 1
        };
      }
    };

    const result = await runWorkflow(loaded, "prepared-review", {
      input,
      providers: new Map([["command", adapter]]),
      prepareNode: async (node) => {
        if (node.id === "review") throw new Error("knowledge preparation unavailable");
        return { node };
      }
    });

    expect(providerCalls).toBe(1);
    expect(result.run.status).toBe("failed");
    expect(result.run.nodes.review).toMatchObject({
      status: "failed",
      attempts: 0,
      error: "knowledge preparation unavailable"
    });
    expect(result.run.nodes.sibling?.status).toBe("passed");
    const events = fs.readFileSync(path.join(result.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"node.failed"');
    expect(events).toContain('"phase":"prepare"');
  });

  it("keeps shared node resources exclusive and releases them after execution", async () => {
    const { config, input } = fixture();
    const loaded = loadManifest(config);
    loaded.manifest.workflows["resource-guarded"] = {
      architecture: "graph",
      config: {
        maxConcurrency: 2,
        nodes: [
          { id: "first-browser", role: "product-manager" },
          { id: "second-browser", role: "designer" }
        ]
      }
    };
    let activeProviders = 0;
    let maximumActiveProviders = 0;
    let tail = Promise.resolve();
    const events: string[] = [];
    const adapter: ProviderAdapter = {
      id: "command",
      validate: () => [],
      async invoke() {
        activeProviders += 1;
        maximumActiveProviders = Math.max(maximumActiveProviders, activeProviders);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeProviders -= 1;
        return {
          stdout: JSON.stringify({ verdict: "Pass", summary: "reviewed", evidence: ["evidence"], risks: [] }),
          stderr: "",
          durationMs: 10
        };
      }
    };

    const result = await runWorkflow(loaded, "resource-guarded", {
      input,
      providers: new Map([["command", adapter]]),
      acquireNodePermit: async () => {
        const predecessor = tail;
        let release = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        tail = predecessor.then(() => gate);
        await predecessor;
        return { release, resources: ["shared-browser"] };
      },
      onEvent: (event) => { events.push(event.type); }
    });

    expect(result.run.status).toBe("passed");
    expect(maximumActiveProviders).toBe(1);
    expect(events.filter((event) => event === "node.resources.acquired")).toHaveLength(2);
    expect(events.filter((event) => event === "node.resources.released")).toHaveLength(2);
  });

  it("starts newly-ready nodes without waiting for an unrelated node in the same compiled wave", async () => {
    const { config, input } = fixture();
    const loaded = loadManifest(config);
    loaded.manifest.workflows["dependency-ready"] = {
      architecture: "graph",
      config: {
        maxConcurrency: 2,
        failFast: false,
        nodes: [
          { id: "fast-root", role: "product-manager" },
          { id: "slow-root", role: "designer" },
          { id: "fast-child", role: "tester", needs: ["fast-root"] }
        ]
      }
    };
    const order: string[] = [];
    let childStarted = () => {};
    const childGate = new Promise<void>((resolve) => { childStarted = resolve; });
    const adapter: ProviderAdapter = {
      id: "command",
      validate: () => [],
      async invoke(invocation) {
        const role = (invocation.templateContext.role as { id: string }).id;
        order.push(`${role}:start`);
        if (role === "designer") {
          await Promise.race([childGate, new Promise((resolve) => setTimeout(resolve, 250))]);
          order.push("designer:end");
        }
        if (role === "tester") childStarted();
        return {
          stdout: JSON.stringify({ verdict: "Pass", summary: "reviewed", evidence: ["evidence"], risks: [] }),
          stderr: "",
          durationMs: 1
        };
      }
    };

    const result = await runWorkflow(loaded, "dependency-ready", {
      input,
      providers: new Map([["command", adapter]])
    });

    expect(result.run.status).toBe("passed");
    expect(order.indexOf("tester:start")).toBeLessThan(order.indexOf("designer:end"));
  });

  it("honors concurrency and stops new work after fail-fast while allowing running siblings to finish", async () => {
    const { config, input } = fixture();
    const loaded = loadManifest(config);
    loaded.manifest.workflows["fail-fast"] = {
      architecture: "graph",
      config: {
        maxConcurrency: 2,
        failFast: true,
        nodes: [
          { id: "fatal", role: "product-manager" },
          { id: "running-sibling", role: "designer" },
          { id: "not-started", role: "tester" }
        ]
      }
    };
    const started: string[] = [];
    let active = 0;
    let peakActive = 0;
    let siblingStarted = () => {};
    const siblingGate = new Promise<void>((resolve) => { siblingStarted = resolve; });
    const adapter: ProviderAdapter = {
      id: "command",
      validate: () => [],
      async invoke(invocation) {
        const role = (invocation.templateContext.role as { id: string }).id;
        started.push(role);
        active += 1;
        peakActive = Math.max(peakActive, active);
        try {
          if (role === "product-manager") {
            await siblingGate;
            throw new ProviderExecutionError("deterministic failure", "", "", { kind: "exit", retryable: false });
          }
          if (role === "designer") {
            siblingStarted();
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return {
            stdout: JSON.stringify({ verdict: "Pass", summary: "reviewed", evidence: ["evidence"], risks: [] }),
            stderr: "",
            durationMs: 1
          };
        } finally {
          active -= 1;
        }
      }
    };

    const result = await runWorkflow(loaded, "fail-fast", {
      input,
      providers: new Map([["command", adapter]])
    });

    expect(peakActive).toBe(2);
    expect(started).toEqual(expect.arrayContaining(["product-manager", "designer"]));
    expect(started).not.toContain("tester");
    expect(result.run.nodes.fatal?.status).toBe("failed");
    expect(result.run.nodes["running-sibling"]?.status).toBe("passed");
    expect(result.run.nodes["not-started"]?.status).toBe("skipped");
    expect(result.run.status).toBe("failed");
  });

  it("does not repeat deterministic or budget-style Provider failures", async () => {
    const { config, input } = fixture();
    const loaded = loadManifest(config);
    loaded.manifest.workflows["single-review"] = {
      architecture: "graph",
      config: { nodes: [{ id: "review", role: "product-manager" }] }
    };
    loaded.manifest.roles["product-manager"]!.maxAttempts = 3;
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "command",
      validate: () => [],
      async invoke() {
        calls += 1;
        throw new ProviderExecutionError("budget exhausted", "", "", { kind: "budget", retryable: false });
      }
    };

    const result = await runWorkflow(loaded, "single-review", {
      input,
      providers: new Map([["command", adapter]])
    });

    expect(calls).toBe(1);
    expect(result.run.nodes.review?.attempts).toBe(1);
    expect(result.run.nodes.review?.failure).toEqual({ category: "provider", kind: "budget", retryable: false });
    expect(result.run.status).toBe("failed");
  });

  it("retries only failures explicitly classified as transient", async () => {
    const { config, input } = fixture();
    const loaded = loadManifest(config);
    loaded.manifest.workflows["single-review"] = {
      architecture: "graph",
      config: { nodes: [{ id: "review", role: "product-manager" }] }
    };
    loaded.manifest.roles["product-manager"]!.maxAttempts = 3;
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "command",
      validate: () => [],
      async invoke() {
        calls += 1;
        if (calls === 1) {
          throw new ProviderExecutionError("upstream overloaded", "", "", { kind: "rate-limit", retryable: true });
        }
        return {
          stdout: JSON.stringify({ verdict: "Pass", summary: "reviewed", evidence: ["evidence"], risks: [] }),
          stderr: "",
          durationMs: 1
        };
      }
    };

    const result = await runWorkflow(loaded, "single-review", {
      input,
      providers: new Map([["command", adapter]])
    });

    expect(calls).toBe(2);
    expect(result.run.nodes.review?.attempts).toBe(2);
    expect(result.run.status).toBe("passed");
  });
});
