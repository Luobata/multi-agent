import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifest } from "../src/config/loadManifest.js";
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
});
