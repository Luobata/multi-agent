import { describe, expect, it } from "vitest";
import { providerRuntimeSummary } from "./providerRuntime";

describe("providerRuntimeSummary", () => {
  it("reports explicit model metadata and the exact command argv", () => {
    const summary = providerRuntimeSummary({
      id: "local-cli",
      definition: { adapter: "command", model: "k3-256k", command: "zsh", args: ["-ic", "claude-kimi --print"] }
    });
    expect(summary.model).toBe("k3-256k");
    expect(summary.launchCommand).toBe("zsh -ic 'claude-kimi --print'");
    expect(summary.launchPreview).toBe("zsh → claude-kimi");
  });

  it("derives a model flag and labels built-in adapters honestly", () => {
    expect(providerRuntimeSummary({ id: "cli", definition: { adapter: "command", command: "agent", args: ["--model=local-v2"] } }).model).toBe("local-v2");
    expect(providerRuntimeSummary({ id: "shell-cli", definition: { adapter: "command", command: "zsh", args: ["-ic", "agent --model inner-v3"] } }).model).toBe("inner-v3");
    expect(providerRuntimeSummary({ id: "mock", definition: { adapter: "mock" } })).toMatchObject({ model: "deterministic-mock", launchCommand: "built-in://mock" });
  });

  it("redacts secrets embedded in direct and shell command arguments", () => {
    expect(providerRuntimeSummary({
      id: "safe-cli",
      definition: { adapter: "command", command: "agent", args: ["--api-key", "private", "--token=hidden"] }
    }).launchCommand).toBe("agent --api-key '***' '--token=***'");
    expect(providerRuntimeSummary({
      id: "safe-shell",
      definition: { adapter: "command", command: "zsh", args: ["-ic", "TOKEN=private agent --password secret"] }
    })).toMatchObject({ launchCommand: "zsh -ic 'TOKEN=*** agent --password ***'", launchPreview: "zsh → agent" });
  });
});
