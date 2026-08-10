import { describe, expect, it } from "vitest";
import { ProviderExecutionError } from "../src/core/errors.js";
import { buildCodexInvocationArgs, createDefaultProviderRegistry, registerProviderAdapter } from "../src/runtime/providers.js";

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

  it("lets the local mock finish a Supervisor decision contract deterministically", async () => {
    const adapter = createDefaultProviderRegistry().get("mock")!;
    const response = await adapter.invoke({
      providerId: "mock",
      definition: { adapter: "mock", outputProtocol: "json", latencyMs: 0 },
      cwd: process.cwd(),
      prompt: "unused",
      templateContext: {
        role: {
          id: "supervisor",
          identity: { displayName: "Local Supervisor" },
          outputSchema: {
            oneOf: [
              { type: "object", properties: { action: { const: "delegate" } } },
              { type: "object", properties: { action: { const: "finish" } } }
            ]
          }
        },
        input: { message: "coordinate this" },
        needs: {}
      }
    });
    expect(JSON.parse(response.stdout)).toEqual({
      action: "finish",
      summary: "Local Supervisor completed the supervisor decision loop with the local mock provider.",
      result: { message: "Local Supervisor received: coordinate this." }
    });
  });

  it("lets the local mock satisfy an explicit Supervisor Gate fallback deterministically", async () => {
    const adapter = createDefaultProviderRegistry().get("mock")!;
    const response = await adapter.invoke({
      providerId: "mock",
      definition: { adapter: "mock", outputProtocol: "json", latencyMs: 0 },
      cwd: process.cwd(),
      prompt: "unused",
      templateContext: {
        role: {
          id: "supervisor",
          identity: { displayName: "Local Supervisor" },
          outputSchema: {
            oneOf: [
              { type: "object", properties: { action: { const: "satisfy-gate" } } },
              { type: "object", properties: { action: { const: "finish" } } }
            ]
          }
        },
        node: { with: { __gateExecution: { gateId: "audit" } } },
        input: { message: "coordinate this" },
        needs: {}
      }
    });
    expect(JSON.parse(response.stdout)).toEqual({
      action: "satisfy-gate",
      gateId: "audit",
      summary: "Local Supervisor satisfied Gate audit with the local mock provider.",
      evidence: { gateId: "audit", deterministicMock: true }
    });
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

  it("classifies a Provider budget exit as deterministic and non-retryable", async () => {
    const adapter = createDefaultProviderRegistry().get("command")!;
    const failure = await adapter.invoke({
      providerId: "budget-command",
      definition: {
        adapter: "command",
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({ subtype: 'error_max_budget_usd' })); process.exit(1)"]
      },
      cwd: process.cwd(),
      prompt: "unused",
      templateContext: {}
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderExecutionError);
    expect(failure).toMatchObject({ kind: "budget", retryable: false });
  });

  it("classifies an explicit rate limit exit as retryable", async () => {
    const adapter = createDefaultProviderRegistry().get("command")!;
    const failure = await adapter.invoke({
      providerId: "rate-limited-command",
      definition: {
        adapter: "command",
        command: process.execPath,
        args: ["-e", "process.stderr.write('429 rate limit'); process.exit(1)"]
      },
      cwd: process.cwd(),
      prompt: "unused",
      templateContext: {}
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderExecutionError);
    expect(failure).toMatchObject({ kind: "rate-limit", retryable: true });
  });

  it("classifies an upstream 5xx / internal-server disconnect as transient and retryable", async () => {
    const adapter = createDefaultProviderRegistry().get("command")!;
    // Reproduces the observed claude-relay signature: the error text arrives in stdout (JSON body)
    // with a non-zero exit, phrased as an upstream InternalServerException / 厂商资源问题断连.
    const failure = await adapter.invoke({
      providerId: "upstream-5xx-command",
      definition: {
        adapter: "command",
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({ is_error: true, result: 'API Error: 厂商资源问题断连：InternalServerException: unexpected error' })); process.exit(1)"]
      },
      cwd: process.cwd(),
      prompt: "unused",
      templateContext: {}
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderExecutionError);
    expect(failure).toMatchObject({ kind: "rate-limit", retryable: true });
  });

  it("keeps an active Provider alive after the soft timeout", async () => {
    const adapter = createDefaultProviderRegistry().get("command")!;
    const progress: Array<{ kind: string; longRunning: boolean }> = [];
    const response = await adapter.invoke({
      providerId: "active-command",
      definition: {
        adapter: "command",
        command: process.execPath,
        args: [
          "-e",
          "let ticks=0; const timer=setInterval(() => { process.stderr.write('tick'); ticks += 1; if (ticks === 4) { clearInterval(timer); process.stdout.write('{}'); } }, 40)"
        ],
        timeoutMs: 50,
        idleTimeoutMs: 500,
        hardTimeoutMs: 2_000
      },
      cwd: process.cwd(),
      prompt: "unused",
      templateContext: {},
      onProgress: (event) => { progress.push({ kind: event.kind, longRunning: event.longRunning }); }
    });

    expect(response.stdout).toBe("{}");
    expect(response.durationMs).toBeGreaterThan(50);
    expect(progress.some((event) => event.kind === "long-running")).toBe(true);
    expect(progress.some((event) => event.kind === "output")).toBe(true);
  });

  it("terminates a Provider only after its output becomes idle", async () => {
    const adapter = createDefaultProviderRegistry().get("command")!;
    const progress: string[] = [];
    const failure = await adapter.invoke({
      providerId: "idle-command",
      definition: {
        adapter: "command",
        command: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"],
        timeoutMs: 50,
        idleTimeoutMs: 100,
        hardTimeoutMs: 500
      },
      cwd: process.cwd(),
      prompt: "unused",
      templateContext: {},
      onProgress: (event) => { progress.push(event.kind); }
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderExecutionError);
    expect(failure).toMatchObject({ kind: "idle-timeout", retryable: false });
    expect(progress).toContain("long-running");
    expect(progress).toContain("idle-timeout");
  });

  it("retains an absolute hard timeout for a noisy infinite Provider", async () => {
    const adapter = createDefaultProviderRegistry().get("command")!;
    const failure = await adapter.invoke({
      providerId: "noisy-command",
      definition: {
        adapter: "command",
        command: process.execPath,
        args: ["-e", "setInterval(() => process.stderr.write('tick'), 10)"],
        timeoutMs: 50,
        idleTimeoutMs: 250,
        hardTimeoutMs: 300
      },
      cwd: process.cwd(),
      prompt: "unused",
      templateContext: {}
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderExecutionError);
    expect(failure).toMatchObject({ kind: "hard-timeout", retryable: false });
  });

  it("does not impose an absolute hard timeout when progress-driven execution omits it", async () => {
    const adapter = createDefaultProviderRegistry().get("command")!;
    const progress: Array<{ hardTimeoutMs: number | null }> = [];
    const response = await adapter.invoke({
      providerId: "progress-driven-command",
      definition: {
        adapter: "command",
        command: process.execPath,
        args: ["-e", "process.stderr.write('start'); let ticks=0; const timer=setInterval(() => { process.stderr.write('tick'); if (++ticks === 5) { clearInterval(timer); process.stdout.write('{}'); } }, 25)"],
        timeoutMs: 20,
        idleTimeoutMs: 2_000
      },
      cwd: process.cwd(),
      prompt: "unused",
      templateContext: {},
      onProgress: (event) => { progress.push({ hardTimeoutMs: event.hardTimeoutMs }); }
    });

    expect(response.stdout).toBe("{}");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((event) => event.hardTimeoutMs === null)).toBe(true);
  });

  it("accepts non-empty model metadata and rejects empty declarations", () => {
    const registry = createDefaultProviderRegistry();
    const command = registry.get("command")!;
    const mock = registry.get("mock")!;
    const codex = registry.get("codex")!;
    expect(command.validate({ providerId: "cli", definition: { adapter: "command", model: "local-v1", command: "agent" }, projectRoot: process.cwd() })).toEqual([]);
    expect(command.validate({ providerId: "cli", definition: { adapter: "command", model: "", command: "agent" }, projectRoot: process.cwd() })).toContain("provider cli model must be a non-empty string");
    expect(mock.validate({ providerId: "mock", definition: { adapter: "mock", model: "deterministic-mock" }, projectRoot: process.cwd() })).toEqual([]);
    expect(codex.validate({
      providerId: "codex-knowledge-control",
      definition: {
        adapter: "codex",
        sandbox: "read-only",
        approvalPolicy: "never",
        mcpServers: { knowledge_control: { command: "npm", args: ["run", "mcp"] } }
      },
      projectRoot: process.cwd()
    })).toEqual([]);
    expect(codex.validate({
      providerId: "unsafe-codex",
      definition: { adapter: "codex", sandbox: "danger-full-access" },
      projectRoot: process.cwd()
    })).toContain("provider unsafe-codex sandbox must be read-only or workspace-write");
    expect(command.validate({
      providerId: "invalid-timeouts",
      definition: {
        adapter: "command",
        command: "agent",
        timeoutMs: 200,
        idleTimeoutMs: 300,
        hardTimeoutMs: 100
      },
      projectRoot: process.cwd()
    })).toEqual(expect.arrayContaining([
      "provider invalid-timeouts timeoutMs must not exceed hardTimeoutMs",
      "provider invalid-timeouts idleTimeoutMs must not exceed hardTimeoutMs"
    ]));
  });

  it("places Codex global safety and MCP options before the exec subcommand", () => {
    const args = buildCodexInvocationArgs({
      adapter: "codex",
      filesystemIsolation: "workspace-read-only",
      approvalPolicy: "never",
      mcpServers: {
        knowledge_control: {
          command: "npm",
          args: ["run", "mcp"],
          cwd: "{{run.projectRoot}}",
          enabledTools: ["knowledge_control_snapshot"],
          defaultToolsApprovalMode: "approve"
        }
      }
    }, { run: { projectRoot: "/tmp/project" } }, "/tmp/knowledge-output.schema.json");

    expect(args.slice(0, 3)).toEqual(["--strict-config", "--ask-for-approval", "never"]);
    expect(args).not.toContain("--sandbox");
    expect(args).toContain('default_permissions="knowledge-control"');
    expect(args).toContain('permissions.knowledge-control.filesystem={":root"="deny", ":minimal"="read", ":workspace_roots"={"."="read"}}');
    expect(args).toContain('mcp_servers.knowledge_control.cwd="/tmp/project"');
    expect(args).toContain('mcp_servers.knowledge_control.enabled_tools=["knowledge_control_snapshot"]');
    expect(args).toContain('mcp_servers.knowledge_control.default_tools_approval_mode="approve"');
    expect(args.indexOf("-c")).toBeLessThan(args.indexOf("exec"));
    expect(args.slice(args.indexOf("exec"))).toEqual([
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--output-schema",
      "/tmp/knowledge-output.schema.json",
      "-"
    ]);
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
