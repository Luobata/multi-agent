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

export class ProviderExecutionError extends Error {
  constructor(message: string, public readonly stdout = "", public readonly stderr = "") {
    super(message);
    this.name = "ProviderExecutionError";
  }
}
