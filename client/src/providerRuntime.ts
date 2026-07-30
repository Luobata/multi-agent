import type { ProviderEntry } from "./types";

export interface ProviderRuntimeSummary {
  adapter: string;
  model: string;
  launchCommand: string;
  launchPreview: string;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArgs(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

const sensitiveName = /^(?:api[-_]?key|access[-_]?token|auth(?:orization)?|credential|password|passwd|secret|token)$/iu;
const sensitiveEnvironmentName = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH(?:ORIZATION)?|CREDENTIAL|PASSWORD|PASSWD|SECRET|TOKEN)(?:_|$)/iu;

function isSensitiveFlag(value: string): boolean {
  return sensitiveName.test(value.replace(/^--?/u, ""));
}

function redactInlineCommand(value: string): string {
  const names = "api[-_]?key|access[-_]?token|auth(?:orization)?|credential|password|passwd|secret|token";
  return value
    .replace(new RegExp(`((?:--?)(?:${names})=)(?:"[^"]*"|'[^']*'|\\S+)`, "giu"), "$1***")
    .replace(new RegExp(`((?:--?)(?:${names})\\s+)(?:"[^"]*"|'[^']*'|\\S+)`, "giu"), "$1***")
    .replace(/(^|\s)([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/gu, (match: string, prefix: string, name: string) =>
      sensitiveEnvironmentName.test(name) ? `${prefix}${name}=***` : match);
}

function redactSensitiveArgs(args: string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const equals = argument.indexOf("=");
    if (equals > 0 && argument.startsWith("-") && isSensitiveFlag(argument.slice(0, equals))) {
      redacted.push(`${argument.slice(0, equals)}=***`);
      continue;
    }
    if (isSensitiveFlag(argument)) {
      redacted.push(argument);
      if (index + 1 < args.length) {
        redacted.push("***");
        index += 1;
      }
      continue;
    }
    redacted.push(redactInlineCommand(argument));
  }
  return redacted;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function modelFromArgs(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--model" || argument === "-m") return nonemptyString(args[index + 1]);
    if (argument.startsWith("--model=")) return nonemptyString(argument.slice("--model=".length));
  }
  const shellCommandIndex = args.findIndex((argument) => argument === "-c" || argument === "-ic" || argument === "-lc");
  const inner = shellCommandIndex >= 0 ? nonemptyString(args[shellCommandIndex + 1]) : undefined;
  const match = inner?.match(/(?:^|\s)(?:--model|-m)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/u);
  if (match) return nonemptyString(match[1] ?? match[2] ?? match[3]);
  return undefined;
}

function launchPreview(command: string, args: string[]): string {
  const shellCommandIndex = args.findIndex((argument) => argument === "-c" || argument === "-ic" || argument === "-lc");
  const inner = shellCommandIndex >= 0 ? nonemptyString(args[shellCommandIndex + 1]) : undefined;
  const innerCommand = inner?.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu)
    ?.map((token) => token.replace(/^(?:"|')|(?:"|')$/gu, ""))
    .find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token));
  if (innerCommand) return `${command} → ${innerCommand}`;
  return args.length ? `${command} ${args[0]}${args.length > 1 ? " …" : ""}` : command;
}

export function providerRuntimeSummary(provider?: ProviderEntry): ProviderRuntimeSummary {
  if (!provider) {
    return { adapter: "unknown", model: "Provider 未注册", launchCommand: "Provider 未注册", launchPreview: "Provider 未注册" };
  }
  const definition = provider.definition;
  const adapter = definition.adapter;
  const args = stringArgs(definition.args);
  const model = nonemptyString(definition.model) ?? modelFromArgs(args) ?? (adapter === "mock" ? "deterministic-mock" : "由 Provider 决定");
  if (adapter !== "command") {
    const launchCommand = `built-in://${adapter}`;
    return { adapter, model, launchCommand, launchPreview: launchCommand };
  }
  const command = nonemptyString(definition.command) ?? "command 未配置";
  const launchCommand = [command, ...redactSensitiveArgs(args)].map(shellQuote).join(" ");
  return { adapter, model, launchCommand, launchPreview: launchPreview(command, args) };
}
