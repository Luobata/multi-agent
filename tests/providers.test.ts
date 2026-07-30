import { describe, expect, it } from "vitest";
import { createDefaultProviderRegistry, registerProviderAdapter } from "../src/runtime/providers.js";

describe("provider adapters", () => {
  it("includes a deterministic local mock adapter", async () => {
    const adapter = createDefaultProviderRegistry().get("mock");
    const response = await adapter!.invoke({
      providerId: "mock",
      definition: { adapter: "mock", outputProtocol: "json", latencyMs: 0 },
      cwd: process.cwd(),
      prompt: "unused",
      templateContext: {
        role: { id: "analyst", identity: { displayName: "Local Analyst" } },
        input: { message: "inspect this" },
        needs: {}
      }
    });
    expect(JSON.parse(response.stdout)).toEqual({ message: "Local Analyst received: inspect this." });
  });

  it("renders a provider-specific stdin template", async () => {
    const adapter = createDefaultProviderRegistry().get("command");
    expect(adapter).toBeDefined();
    const response = await adapter!.invoke({
      providerId: "test-command",
      definition: {
        adapter: "command",
        model: "test-model",
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)"],
        inputTemplate: "{{requestPrompt}}"
      },
      cwd: process.cwd(),
      prompt: "system plus request",
      templateContext: { requestPrompt: "request only" }
    });

    expect(response.stdout).toBe("request only");
  });

  it("accepts non-empty model metadata and rejects empty declarations", () => {
    const registry = createDefaultProviderRegistry();
    const command = registry.get("command")!;
    const mock = registry.get("mock")!;
    expect(command.validate({ providerId: "cli", definition: { adapter: "command", model: "local-v1", command: "agent" }, projectRoot: process.cwd() })).toEqual([]);
    expect(command.validate({ providerId: "cli", definition: { adapter: "command", model: "", command: "agent" }, projectRoot: process.cwd() })).toContain("provider cli model must be a non-empty string");
    expect(mock.validate({ providerId: "mock", definition: { adapter: "mock", model: "deterministic-mock" }, projectRoot: process.cwd() })).toEqual([]);
  });

  it("resolves explicit environment references without persisting their value in a Provider definition", async () => {
    process.env.MULTI_AGENT_TEST_SECRET = "local-secret-value";
    try {
      const adapter = createDefaultProviderRegistry().get("command")!;
      const response = await adapter.invoke({
        providerId: "env-command",
        definition: {
          adapter: "command",
          command: process.execPath,
          args: ["-e", "process.stdout.write(process.env.TEST_SECRET || '')"],
          env: { TEST_SECRET: "$ENV:MULTI_AGENT_TEST_SECRET" }
        },
        cwd: process.cwd(),
        prompt: "unused",
        templateContext: {}
      });
      expect(response.stdout).toBe("local-secret-value");
    } finally {
      delete process.env.MULTI_AGENT_TEST_SECRET;
    }
  });

  it("registers an additional adapter and rejects duplicate ids", () => {
    const registry = createDefaultProviderRegistry();
    const adapter = {
      id: "remote-model",
      validate: () => [],
      invoke: async () => ({ stdout: "{}", stderr: "", durationMs: 1 })
    };

    expect(registerProviderAdapter(registry, adapter).get("remote-model")).toBe(adapter);
    expect(() => registerProviderAdapter(registry, adapter)).toThrow(/already registered/);
  });
});
