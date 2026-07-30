import { spawn } from "node:child_process";
import { ProviderExecutionError } from "../core/errors.js";
import { renderTemplate } from "../core/template.js";
import type { CommandProviderDefinition, ProviderDefinition } from "../core/types.js";

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

class MockProviderAdapter implements ProviderAdapter {
  readonly id = "mock";

  validate(context: ProviderValidationContext): string[] {
    const allowed = new Set(["adapter", "model", "outputProtocol", "latencyMs"]);
    const definition = context.definition as Record<string, unknown>;
    const issues = Object.keys(definition)
      .filter((key) => !allowed.has(key))
      .map((key) => `provider ${context.providerId} mock adapter does not support property ${key}`);
    if (definition.model !== undefined && (typeof definition.model !== "string" || !definition.model.trim())) {
      issues.push(`provider ${context.providerId} model must be a non-empty string`);
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
      | { identity?: { displayName?: string }; id?: string }
      | undefined;
    const input = invocation.templateContext.input as { message?: unknown } | undefined;
    const needs = invocation.templateContext.needs as Record<string, unknown> | undefined;
    const request = typeof input?.message === "string" ? input.message : "the supplied workflow input";
    const dependencyCount = needs ? Object.keys(needs).length : 0;
    const displayName = role?.identity?.displayName ?? role?.id ?? "Local employee";
    const suffix = dependencyCount > 0 ? ` I also received evidence from ${dependencyCount} upstream node(s).` : "";
    const punctuation = /[.!?。！？]$/.test(request) ? "" : ".";
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
  const allowed = new Set(["adapter", "model", "command", "args", "env", "inputTemplate", "timeoutMs", "outputProtocol"]);
  for (const key of Object.keys(definition)) {
    if (!allowed.has(key)) issues.push(`${prefix} command adapter does not support property ${key}`);
  }
  if (typeof definition.command !== "string" || !definition.command.trim()) {
    issues.push(`${prefix} command must be a non-empty string`);
  }
  if (definition.model !== undefined && (typeof definition.model !== "string" || !definition.model.trim())) {
    issues.push(`${prefix} model must be a non-empty string`);
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
  if (definition.timeoutMs !== undefined && (!Number.isInteger(definition.timeoutMs) || (definition.timeoutMs as number) < 1)) {
    issues.push(`${prefix} timeoutMs must be a positive integer`);
  }
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
    const timeoutMs = definition.timeoutMs ?? 600_000;
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
      let timedOut = false;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      }, timeoutMs);
      timeout.unref();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        finish(() => reject(new ProviderExecutionError(error.message, stdout, stderr)));
      });
      child.once("close", (status) => {
        finish(() => {
          if (timedOut) {
            reject(new ProviderExecutionError(`provider ${invocation.providerId} timed out after ${timeoutMs}ms`, stdout, stderr));
            return;
          }
          if (status !== 0) {
            reject(new ProviderExecutionError(`provider ${invocation.providerId} exited with status ${status}`, stdout, stderr));
            return;
          }
          resolve({ stdout, stderr, durationMs: Date.now() - started });
        });
      });
      child.stdin.end(input);
    });
  }
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  const command = new CommandProviderAdapter();
  const mock = new MockProviderAdapter();
  return new Map<string, ProviderAdapter>([
    [command.id, command],
    [mock.id, mock]
  ]);
}

export function registerProviderAdapter(registry: ProviderRegistry, adapter: ProviderAdapter): ProviderRegistry {
  if (registry.has(adapter.id)) throw new Error(`provider adapter already registered: ${adapter.id}`);
  registry.set(adapter.id, adapter);
  return registry;
}
