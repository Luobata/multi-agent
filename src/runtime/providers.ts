import { spawn } from "node:child_process";
import path from "node:path";
import { ProviderExecutionError } from "../core/errors.js";
import { renderTemplate } from "../core/template.js";
import type { CodexProviderDefinition, CommandProviderDefinition, JsonValue, ProviderDefinition } from "../core/types.js";

const DEFAULT_PROVIDER_SOFT_TIMEOUT_MS = 600_000;
const MINIMUM_DEFAULT_HARD_TIMEOUT_MS = 3_600_000;
const PROGRESS_EVENT_INTERVAL_MS = 5_000;

type ProviderTimeoutDefinition = Pick<CommandProviderDefinition, "timeoutMs" | "idleTimeoutMs" | "hardTimeoutMs">;

export type ProviderProgress = {
  [key: string]: JsonValue;
  kind: "output" | "long-running" | "idle-timeout" | "hard-timeout";
  at: string;
  stream: "stdout" | "stderr" | null;
  chunkBytes: number;
  totalBytes: number;
  elapsedMs: number;
  idleMs: number;
  softTimeoutMs: number;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  longRunning: boolean;
};

export interface ProviderValidationContext {
  providerId: string;
  definition: ProviderDefinition;
  projectRoot: string;
}

export interface ProviderInvocation {
  providerId: string;
  definition: ProviderDefinition;
  cwd: string;
  prompt: string;
  templateContext: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (progress: ProviderProgress) => void | Promise<void>;
}

export interface ProviderResponse {
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ProviderAdapter {
  id: string;
  validate(context: ProviderValidationContext): string[];
  invoke(invocation: ProviderInvocation): Promise<ProviderResponse>;
}

export type ProviderRegistry = Map<string, ProviderAdapter>;

function validateTimeoutPolicy(prefix: string, definition: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const key of ["timeoutMs", "idleTimeoutMs", "hardTimeoutMs"] as const) {
    if (definition[key] !== undefined && (!Number.isInteger(definition[key]) || (definition[key] as number) < 1)) {
      issues.push(`${prefix} ${key} must be a positive integer`);
    }
  }
  const soft = definition.timeoutMs;
  const idle = definition.idleTimeoutMs;
  const hard = definition.hardTimeoutMs;
  if (typeof soft === "number" && typeof hard === "number" && soft > hard) {
    issues.push(`${prefix} timeoutMs must not exceed hardTimeoutMs`);
  }
  if (typeof idle === "number" && typeof hard === "number" && idle > hard) {
    issues.push(`${prefix} idleTimeoutMs must not exceed hardTimeoutMs`);
  }
  return issues;
}

function providerTimeoutPolicy(definition: ProviderTimeoutDefinition): {
  softTimeoutMs: number;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
} {
  const softTimeoutMs = definition.timeoutMs ?? DEFAULT_PROVIDER_SOFT_TIMEOUT_MS;
  return {
    softTimeoutMs,
    idleTimeoutMs: definition.idleTimeoutMs ?? softTimeoutMs,
    hardTimeoutMs: definition.hardTimeoutMs ?? Math.max(softTimeoutMs * 4, MINIMUM_DEFAULT_HARD_TIMEOUT_MS)
  };
}

function monitorProviderProcess(
  invocation: ProviderInvocation,
  definition: ProviderTimeoutDefinition,
  started: number,
  terminate: () => void
): {
  noteOutput: (stream: "stdout" | "stderr", chunk: string) => void;
  stop: () => void;
  flush: () => Promise<void>;
  timeoutKind: () => "idle-timeout" | "hard-timeout" | undefined;
  policy: ReturnType<typeof providerTimeoutPolicy>;
} {
  const policy = providerTimeoutPolicy(definition);
  let timeoutKind: "idle-timeout" | "hard-timeout" | undefined;
  let longRunning = false;
  let lastOutputAt = started;
  let lastProgressEventAt = 0;
  let totalBytes = 0;
  let progressQueue = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout>;

  const publish = (
    kind: ProviderProgress["kind"],
    stream: ProviderProgress["stream"] = null,
    chunkBytes = 0
  ) => {
    if (!invocation.onProgress) return;
    const timestamp = Date.now();
    const progress: ProviderProgress = {
      kind,
      at: new Date(timestamp).toISOString(),
      stream,
      chunkBytes,
      totalBytes,
      elapsedMs: timestamp - started,
      idleMs: timestamp - lastOutputAt,
      softTimeoutMs: policy.softTimeoutMs,
      idleTimeoutMs: policy.idleTimeoutMs,
      hardTimeoutMs: policy.hardTimeoutMs,
      longRunning
    };
    progressQueue = progressQueue
      .then(async () => { await invocation.onProgress?.(progress); })
      .catch(() => undefined);
  };

  const expireIdle = () => {
    if (timeoutKind) return;
    timeoutKind = "idle-timeout";
    publish("idle-timeout");
    terminate();
  };
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(expireIdle, policy.idleTimeoutMs);
    idleTimer.unref();
  };
  resetIdleTimer();

  const softTimer = setTimeout(() => {
    longRunning = true;
    publish("long-running");
  }, policy.softTimeoutMs);
  softTimer.unref();
  const hardTimer = setTimeout(() => {
    if (timeoutKind) return;
    timeoutKind = "hard-timeout";
    publish("hard-timeout");
    terminate();
  }, policy.hardTimeoutMs);
  hardTimer.unref();

  return {
    noteOutput(stream, chunk) {
      const timestamp = Date.now();
      const chunkBytes = Buffer.byteLength(chunk);
      lastOutputAt = timestamp;
      totalBytes += chunkBytes;
      resetIdleTimer();
      if (lastProgressEventAt === 0 || timestamp - lastProgressEventAt >= PROGRESS_EVENT_INTERVAL_MS) {
        lastProgressEventAt = timestamp;
        publish("output", stream, chunkBytes);
      }
    },
    stop() {
      clearTimeout(softTimer);
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
    },
    flush: () => progressQueue,
    timeoutKind: () => timeoutKind,
    policy
  };
}

/**
 * Extract the supervisor decision actions a role's output schema permits.
 * Understands the flattened `{ properties: { action: { enum | const } } }` shape and the
 * legacy root-level `oneOf` variant shape, so the mock provider works with either.
 */
function supervisorSchemaActions(schema: Record<string, unknown> | undefined): Set<string> {
  const actions = new Set<string>();
  if (!schema || typeof schema !== "object") return actions;
  const collectFromAction = (action: unknown): void => {
    if (typeof action !== "object" || action === null) return;
    const asRecord = action as { const?: unknown; enum?: unknown };
    if (typeof asRecord.const === "string") actions.add(asRecord.const);
    if (Array.isArray(asRecord.enum)) for (const value of asRecord.enum) if (typeof value === "string") actions.add(value);
  };
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (properties && typeof properties === "object") collectFromAction(properties.action);
  const variants = (schema as { oneOf?: unknown }).oneOf;
  if (Array.isArray(variants)) {
    for (const variant of variants) {
      if (typeof variant !== "object" || variant === null) continue;
      collectFromAction((variant as { properties?: Record<string, unknown> }).properties?.action);
    }
  }
  return actions;
}

class MockProviderAdapter implements ProviderAdapter {
  readonly id = "mock";

  validate(context: ProviderValidationContext): string[] {
    const allowed = new Set(["adapter", "model", "runtimeProfiles", "outputProtocol", "latencyMs"]);
    const definition = context.definition as Record<string, unknown>;
    const issues = Object.keys(definition)
      .filter((key) => !allowed.has(key))
      .map((key) => `provider ${context.providerId} mock adapter does not support property ${key}`);
    if (definition.model !== undefined && (typeof definition.model !== "string" || !definition.model.trim())) {
      issues.push(`provider ${context.providerId} model must be a non-empty string`);
    }
    if (definition.runtimeProfiles !== undefined && (!Array.isArray(definition.runtimeProfiles)
      || definition.runtimeProfiles.some((profile) => typeof profile !== "string" || !profile.trim()))) {
      issues.push(`provider ${context.providerId} runtimeProfiles must be an array of non-empty strings`);
    }
    if (
      definition.latencyMs !== undefined &&
      (!Number.isInteger(definition.latencyMs) || (definition.latencyMs as number) < 0 || (definition.latencyMs as number) > 10_000)
    ) {
      issues.push(`provider ${context.providerId} latencyMs must be an integer between 0 and 10000`);
    }
    return issues;
  }

  async invoke(invocation: ProviderInvocation): Promise<ProviderResponse> {
    const issues = this.validate({
      providerId: invocation.providerId,
      definition: invocation.definition,
      projectRoot: invocation.cwd
    });
    if (issues.length > 0) throw new ProviderExecutionError(issues.join("; "));
    const started = Date.now();
    const latencyMs = Number((invocation.definition as Record<string, unknown>).latencyMs ?? 20);
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const role = invocation.templateContext.role as
      | { identity?: { displayName?: string }; id?: string; outputSchema?: Record<string, unknown> }
      | undefined;
    const input = invocation.templateContext.input as { message?: unknown } | undefined;
    const needs = invocation.templateContext.needs as Record<string, unknown> | undefined;
    const request = typeof input?.message === "string" ? input.message : "the supplied workflow input";
    const dependencyCount = needs ? Object.keys(needs).length : 0;
    const displayName = role?.identity?.displayName ?? role?.id ?? "Local employee";
    const suffix = dependencyCount > 0 ? ` I also received evidence from ${dependencyCount} upstream node(s).` : "";
    const punctuation = /[.!?。！？]$/.test(request) ? "" : ".";
    const node = invocation.templateContext.node as { with?: { __gateExecution?: unknown } } | undefined;
    const gateExecution = typeof node?.with?.__gateExecution === "object" && node.with.__gateExecution !== null
      ? node.with.__gateExecution as { gateId?: unknown }
      : undefined;
    // Discover which supervisor actions the role's output schema allows. Supports both the
    // flattened `{ properties: { action: { enum } } }` schema and legacy root-level `oneOf` variants.
    const supervisorActions = supervisorSchemaActions(role?.outputSchema);
    const supportsSupervisorGate = supervisorActions.has("satisfy-gate");
    const supportsSupervisorFinish = supervisorActions.has("finish");
    if (gateExecution && supportsSupervisorGate && typeof gateExecution.gateId === "string") {
      return {
        stdout: JSON.stringify({
          action: "satisfy-gate",
          gateId: gateExecution.gateId,
          summary: `${displayName} satisfied Gate ${gateExecution.gateId} with the local mock provider.`,
          evidence: { gateId: gateExecution.gateId, deterministicMock: true }
        }),
        stderr: "",
        durationMs: Date.now() - started
      };
    }
    if (supportsSupervisorFinish) {
      return {
        stdout: JSON.stringify({
          action: "finish",
          summary: `${displayName} completed the supervisor decision loop with the local mock provider.`,
          result: { message: `${displayName} received: ${request}${punctuation}` }
        }),
        stderr: "",
        durationMs: Date.now() - started
      };
    }
    return {
      stdout: JSON.stringify({ message: `${displayName} received: ${request}${punctuation}${suffix}` }),
      stderr: "",
      durationMs: Date.now() - started
    };
  }
}

function validateCommandProvider(context: ProviderValidationContext): string[] {
  const prefix = `provider ${context.providerId}`;
  const definition = context.definition as unknown as Record<string, unknown>;
  const issues: string[] = [];
  const allowed = new Set([
    "adapter",
    "model",
    "runtimeProfiles",
    "command",
    "args",
    "env",
    "inputTemplate",
    "timeoutMs",
    "idleTimeoutMs",
    "hardTimeoutMs",
    "outputProtocol"
  ]);
  for (const key of Object.keys(definition)) {
    if (!allowed.has(key)) issues.push(`${prefix} command adapter does not support property ${key}`);
  }
  if (typeof definition.command !== "string" || !definition.command.trim()) {
    issues.push(`${prefix} command must be a non-empty string`);
  }
  if (definition.model !== undefined && (typeof definition.model !== "string" || !definition.model.trim())) {
    issues.push(`${prefix} model must be a non-empty string`);
  }
  if (definition.runtimeProfiles !== undefined && (!Array.isArray(definition.runtimeProfiles)
    || definition.runtimeProfiles.some((profile) => typeof profile !== "string" || !profile.trim()))) {
    issues.push(`${prefix} runtimeProfiles must be an array of non-empty strings`);
  }
  if (definition.args !== undefined && (!Array.isArray(definition.args) || definition.args.some((value) => typeof value !== "string"))) {
    issues.push(`${prefix} args must be an array of strings`);
  }
  if (
    definition.env !== undefined &&
    (typeof definition.env !== "object" || definition.env === null || Array.isArray(definition.env) ||
      Object.values(definition.env).some((value) => typeof value !== "string"))
  ) {
    issues.push(`${prefix} env must be an object with string values`);
  }
  if (definition.inputTemplate !== undefined && (typeof definition.inputTemplate !== "string" || !definition.inputTemplate)) {
    issues.push(`${prefix} inputTemplate must be a non-empty string`);
  }
  issues.push(...validateTimeoutPolicy(prefix, definition));
  if (
    definition.outputProtocol !== undefined &&
    !["json", "claude-json", "raw"].includes(String(definition.outputProtocol))
  ) {
    issues.push(`${prefix} outputProtocol must be json, claude-json, or raw`);
  }
  return issues;
}

class CommandProviderAdapter implements ProviderAdapter {
  readonly id = "command";

  validate(context: ProviderValidationContext): string[] {
    return validateCommandProvider(context);
  }

  invoke(invocation: ProviderInvocation): Promise<ProviderResponse> {
    const issues = this.validate({
      providerId: invocation.providerId,
      definition: invocation.definition,
      projectRoot: invocation.cwd
    });
    if (issues.length > 0) throw new ProviderExecutionError(issues.join("; "));
    const definition = invocation.definition as CommandProviderDefinition;
    const context = { ...invocation.templateContext, prompt: invocation.prompt };
    const args = (definition.args ?? []).map((argument) => renderTemplate(argument, context));
    const env = Object.fromEntries(
      Object.entries(definition.env ?? {}).map(([key, value]) => {
        const reference = /^\$ENV:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
        if (!reference) return [key, renderTemplate(value, context)];
        const environmentName = reference[1];
        const resolved = environmentName ? process.env[environmentName] : undefined;
        if (resolved === undefined) {
          throw new ProviderExecutionError(`provider ${invocation.providerId} requires environment variable ${environmentName}`);
        }
        return [key, resolved];
      })
    );
    const input = renderTemplate(definition.inputTemplate ?? "{{prompt}}", context);
    const started = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(definition.command, args, {
        cwd: invocation.cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const failureOptions = (status: number | null) => {
        const detail = `${stdout}\n${stderr}`.toLowerCase();
        if (/maximum budget|max_budget|budget exhausted/.test(detail)) {
          return { kind: "budget" as const, retryable: false, durationMs: Date.now() - started };
        }
        if (/rate.?limit|\b429\b|overloaded|temporar(?:y|ily unavailable)|econnreset|etimedout|socket hang up/.test(detail)) {
          return { kind: "rate-limit" as const, retryable: true, durationMs: Date.now() - started };
        }
        return { kind: "exit" as const, retryable: status === 75, durationMs: Date.now() - started };
      };

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        monitor.stop();
        invocation.signal?.removeEventListener("abort", abort);
        void monitor.flush().then(callback);
      };
      const abort = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      };
      const monitor = monitorProviderProcess(invocation, definition, started, abort);
      invocation.signal?.addEventListener("abort", abort, { once: true });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        monitor.noteOutput("stdout", chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        monitor.noteOutput("stderr", chunk);
      });
      child.once("error", (error) => {
        finish(() => reject(new ProviderExecutionError(error.message, stdout, stderr, {
          kind: "start",
          retryable: false,
          durationMs: Date.now() - started
        })));
      });
      child.once("close", (status) => {
        finish(() => {
          if (invocation.signal?.aborted) {
            reject(new ProviderExecutionError(`provider ${invocation.providerId} was aborted`, stdout, stderr, {
              kind: "aborted",
              retryable: false,
              durationMs: Date.now() - started
            }));
            return;
          }
          const timeoutKind = monitor.timeoutKind();
          if (timeoutKind) {
            const timeoutMs = timeoutKind === "idle-timeout" ? monitor.policy.idleTimeoutMs : monitor.policy.hardTimeoutMs;
            const reason = timeoutKind === "idle-timeout" ? "was idle" : "reached its hard timeout";
            reject(new ProviderExecutionError(`provider ${invocation.providerId} ${reason} after ${timeoutMs}ms`, stdout, stderr, {
              kind: timeoutKind,
              retryable: false,
              durationMs: Date.now() - started
            }));
            return;
          }
          if (status !== 0) {
            reject(new ProviderExecutionError(
              `provider ${invocation.providerId} exited with status ${status}`,
              stdout,
              stderr,
              failureOptions(status)
            ));
            return;
          }
          resolve({ stdout, stderr, durationMs: Date.now() - started });
        });
      });
      child.stdin.end(input);
    });
  }
}

function validateCodexProvider(context: ProviderValidationContext): string[] {
  const prefix = `provider ${context.providerId}`;
  const definition = context.definition as Record<string, unknown>;
  const issues: string[] = [];
  const allowed = new Set([
    "adapter",
    "model",
    "runtimeProfiles",
    "outputProtocol",
    "command",
    "sandbox",
    "filesystemIsolation",
    "workingDirectory",
    "approvalPolicy",
    "timeoutMs",
    "idleTimeoutMs",
    "hardTimeoutMs",
    "mcpServers"
  ]);
  for (const key of Object.keys(definition)) {
    if (!allowed.has(key)) issues.push(`${prefix} codex adapter does not support property ${key}`);
  }
  if (definition.command !== undefined && (typeof definition.command !== "string" || !definition.command.trim())) {
    issues.push(`${prefix} command must be a non-empty string`);
  }
  if (definition.model !== undefined && (typeof definition.model !== "string" || !definition.model.trim())) {
    issues.push(`${prefix} model must be a non-empty string`);
  }
  if (definition.runtimeProfiles !== undefined && (!Array.isArray(definition.runtimeProfiles)
    || definition.runtimeProfiles.some((profile) => typeof profile !== "string" || !profile.trim()))) {
    issues.push(`${prefix} runtimeProfiles must be an array of non-empty strings`);
  }
  if (definition.outputProtocol !== undefined && definition.outputProtocol !== "json") {
    issues.push(`${prefix} outputProtocol must be json`);
  }
  if (definition.sandbox !== undefined && !["read-only", "workspace-write"].includes(String(definition.sandbox))) {
    issues.push(`${prefix} sandbox must be read-only or workspace-write`);
  }
  if (definition.filesystemIsolation !== undefined && definition.filesystemIsolation !== "workspace-read-only") {
    issues.push(`${prefix} filesystemIsolation must be workspace-read-only`);
  }
  if (definition.filesystemIsolation !== undefined && definition.sandbox !== undefined) {
    issues.push(`${prefix} cannot combine filesystemIsolation with sandbox`);
  }
  if (definition.workingDirectory !== undefined && (typeof definition.workingDirectory !== "string" || !definition.workingDirectory.trim())) {
    issues.push(`${prefix} workingDirectory must be a non-empty string`);
  }
  if (definition.approvalPolicy !== undefined && definition.approvalPolicy !== "never") {
    issues.push(`${prefix} approvalPolicy must be never for non-interactive execution`);
  }
  issues.push(...validateTimeoutPolicy(prefix, definition));
  if (definition.mcpServers !== undefined) {
    if (typeof definition.mcpServers !== "object" || definition.mcpServers === null || Array.isArray(definition.mcpServers)) {
      issues.push(`${prefix} mcpServers must be an object`);
    } else {
      for (const [name, value] of Object.entries(definition.mcpServers as Record<string, unknown>)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) issues.push(`${prefix} MCP server name ${name} is invalid`);
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          issues.push(`${prefix} MCP server ${name} must be an object`);
          continue;
        }
        const server = value as Record<string, unknown>;
        if (typeof server.command !== "string" || !server.command.trim()) {
          issues.push(`${prefix} MCP server ${name} command must be a non-empty string`);
        }
        if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((argument) => typeof argument !== "string"))) {
          issues.push(`${prefix} MCP server ${name} args must be an array of strings`);
        }
        if (server.cwd !== undefined && (typeof server.cwd !== "string" || !server.cwd.trim())) {
          issues.push(`${prefix} MCP server ${name} cwd must be a non-empty string`);
        }
        if (
          server.enabledTools !== undefined &&
          (!Array.isArray(server.enabledTools) || server.enabledTools.some((tool) => typeof tool !== "string" || !tool.trim()))
        ) {
          issues.push(`${prefix} MCP server ${name} enabledTools must be an array of non-empty strings`);
        }
        if (
          server.defaultToolsApprovalMode !== undefined &&
          !["auto", "prompt", "writes", "approve"].includes(String(server.defaultToolsApprovalMode))
        ) {
          issues.push(`${prefix} MCP server ${name} defaultToolsApprovalMode must be auto, prompt, writes, or approve`);
        }
        for (const key of Object.keys(server)) {
          if (!new Set(["command", "args", "cwd", "enabledTools", "defaultToolsApprovalMode"]).has(key)) {
            issues.push(`${prefix} MCP server ${name} does not support property ${key}`);
          }
        }
      }
    }
  }
  return issues;
}

export function buildCodexInvocationArgs(
  definition: CodexProviderDefinition,
  context: Record<string, unknown>,
  outputSchemaPath: string
): string[] {
  const args = ["--strict-config", "--ask-for-approval", definition.approvalPolicy ?? "never"];
  if (definition.filesystemIsolation === "workspace-read-only") {
    args.push("-c", `default_permissions=${JSON.stringify("knowledge-control")}`);
    args.push(
      "-c",
      'permissions.knowledge-control.filesystem={":root"="deny", ":minimal"="read", ":workspace_roots"={"."="read"}}'
    );
    args.push("-c", "permissions.knowledge-control.network.enabled=false");
  } else {
    args.push("--sandbox", definition.sandbox ?? "read-only");
  }
  if (definition.model) args.push("--model", definition.model);
  for (const [name, server] of Object.entries(definition.mcpServers ?? {})) {
    const command = renderTemplate(server.command, context);
    const serverArgs = (server.args ?? []).map((argument) => renderTemplate(argument, context));
    args.push("-c", `mcp_servers.${name}.command=${JSON.stringify(command)}`);
    args.push("-c", `mcp_servers.${name}.args=${JSON.stringify(serverArgs)}`);
    if (server.cwd) args.push("-c", `mcp_servers.${name}.cwd=${JSON.stringify(renderTemplate(server.cwd, context))}`);
    if (server.enabledTools) args.push("-c", `mcp_servers.${name}.enabled_tools=${JSON.stringify(server.enabledTools)}`);
    if (server.defaultToolsApprovalMode) {
      args.push("-c", `mcp_servers.${name}.default_tools_approval_mode=${JSON.stringify(server.defaultToolsApprovalMode)}`);
    }
  }
  args.push(
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--output-schema",
    outputSchemaPath,
    "-"
  );
  return args;
}

class CodexProviderAdapter implements ProviderAdapter {
  readonly id = "codex";

  validate(context: ProviderValidationContext): string[] {
    return validateCodexProvider(context);
  }

  invoke(invocation: ProviderInvocation): Promise<ProviderResponse> {
    const issues = this.validate({
      providerId: invocation.providerId,
      definition: invocation.definition,
      projectRoot: invocation.cwd
    });
    if (issues.length > 0) throw new ProviderExecutionError(issues.join("; "));
    const definition = invocation.definition as CodexProviderDefinition;
    const role = invocation.templateContext.role as { outputSchemaPath?: unknown } | undefined;
    if (typeof role?.outputSchemaPath !== "string" || !role.outputSchemaPath) {
      throw new ProviderExecutionError(`provider ${invocation.providerId} requires role.outputSchemaPath`);
    }
    const context = { ...invocation.templateContext, prompt: invocation.prompt };
    const args = buildCodexInvocationArgs(definition, context, role.outputSchemaPath);
    const workingDirectory = definition.workingDirectory
      ? path.resolve(invocation.cwd, renderTemplate(definition.workingDirectory, context))
      : invocation.cwd;
    const started = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(definition.command?.trim() || "codex", args, {
        cwd: workingDirectory,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        monitor.stop();
        invocation.signal?.removeEventListener("abort", abort);
        void monitor.flush().then(callback);
      };
      const abort = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      };
      const monitor = monitorProviderProcess(invocation, definition, started, abort);
      invocation.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        monitor.noteOutput("stdout", chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        monitor.noteOutput("stderr", chunk);
      });
      child.once("error", (error) => finish(() => reject(new ProviderExecutionError(
        `provider ${invocation.providerId} could not start ${definition.command?.trim() || "codex"}; set MULTI_AGENT_CODEX_COMMAND when Codex is outside the daemon PATH (${error.message})`,
        stdout,
        stderr,
        { kind: "start", retryable: false, durationMs: Date.now() - started }
      ))));
      child.once("close", (status) => finish(() => {
        if (invocation.signal?.aborted) {
          reject(new ProviderExecutionError(`provider ${invocation.providerId} was aborted`, stdout, stderr, {
            kind: "aborted",
            retryable: false,
            durationMs: Date.now() - started
          }));
        } else if (monitor.timeoutKind()) {
          const timeoutKind = monitor.timeoutKind()!;
          const timeoutMs = timeoutKind === "idle-timeout" ? monitor.policy.idleTimeoutMs : monitor.policy.hardTimeoutMs;
          const reason = timeoutKind === "idle-timeout" ? "was idle" : "reached its hard timeout";
          reject(new ProviderExecutionError(`provider ${invocation.providerId} ${reason} after ${timeoutMs}ms`, stdout, stderr, {
            kind: timeoutKind,
            retryable: false,
            durationMs: Date.now() - started
          }));
        } else if (status !== 0) {
          const detail = `${stdout}\n${stderr}`.toLowerCase();
          const budget = /maximum budget|max_budget|budget exhausted/.test(detail);
          const transient = /rate.?limit|\b429\b|overloaded|temporar(?:y|ily unavailable)|econnreset|etimedout|socket hang up/.test(detail);
          reject(new ProviderExecutionError(`provider ${invocation.providerId} exited with status ${status}`, stdout, stderr, {
            kind: budget ? "budget" : transient ? "rate-limit" : "exit",
            retryable: transient,
            durationMs: Date.now() - started
          }));
        } else {
          resolve({ stdout, stderr, durationMs: Date.now() - started });
        }
      }));
      child.stdin.end(invocation.prompt);
    });
  }
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  const command = new CommandProviderAdapter();
  const mock = new MockProviderAdapter();
  const codex = new CodexProviderAdapter();
  return new Map<string, ProviderAdapter>([
    [command.id, command],
    [mock.id, mock],
    [codex.id, codex]
  ]);
}

export function registerProviderAdapter(registry: ProviderRegistry, adapter: ProviderAdapter): ProviderRegistry {
  if (registry.has(adapter.id)) throw new Error(`provider adapter already registered: ${adapter.id}`);
  registry.set(adapter.id, adapter);
  return registry;
}
