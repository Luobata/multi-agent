export class ManifestValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid multi-agent manifest:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ManifestValidationError";
  }
}

export class TemplateRenderError extends Error {
  constructor(public readonly placeholders: string[]) {
    super(`Template values missing: ${placeholders.join(", ")}`);
    this.name = "TemplateRenderError";
  }
}

export type ProviderFailureKind =
  | "aborted"
  | "budget"
  | "rate-limit"
  | "start"
  | "timeout"
  | "idle-timeout"
  | "hard-timeout"
  | "exit"
  | "unknown";

export interface ProviderExecutionErrorOptions {
  kind?: ProviderFailureKind;
  retryable?: boolean;
  durationMs?: number;
}

export class ProviderExecutionError extends Error {
  readonly kind: ProviderFailureKind;
  readonly retryable: boolean;
  readonly durationMs?: number;

  constructor(
    message: string,
    public readonly stdout = "",
    public readonly stderr = "",
    options: ProviderExecutionErrorOptions = {}
  ) {
    super(message);
    this.name = "ProviderExecutionError";
    this.kind = options.kind ?? "unknown";
    this.retryable = options.retryable ?? false;
    this.durationMs = options.durationMs;
  }
}
