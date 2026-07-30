import fs from "node:fs";
import path from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import YAML from "yaml";
import { createDefaultArchitectureRegistry } from "../architectures/registry.js";
import type { ArchitectureRegistry } from "../architectures/types.js";
import { ManifestValidationError } from "../core/errors.js";
import type { JsonObject, LoadedManifest, MultiAgentManifest, RoleSkillBinding } from "../core/types.js";
import { createDefaultProviderRegistry, type ProviderRegistry } from "../runtime/providers.js";
import { manifestSchema } from "./schema.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(manifestSchema);

function displayAjvIssues(): string[] {
  return (validateShape.errors ?? []).map((error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}

function ensureReadableFile(projectRoot: string, relativePath: string, label: string, issues: string[]): string | undefined {
  const resolved = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    issues.push(`${label} must stay inside the manifest directory: ${relativePath}`);
    return undefined;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    issues.push(`${label} not found: ${relativePath}`);
    return undefined;
  }
  return resolved;
}

function ensureNonEmptyText(filePath: string | undefined, label: string, issues: string[]): void {
  if (filePath && !fs.readFileSync(filePath, "utf8").trim()) issues.push(`${label} is empty`);
}

function ensureJsonSchema(filePath: string | undefined, label: string, issues: string[]): Record<string, unknown> | undefined {
  if (!filePath) return undefined;
  try {
    const schema = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      issues.push(`${label} must contain a JSON Schema object`);
      return undefined;
    }
    new Ajv({ allErrors: true, strict: false }).compile(schema);
    return schema as Record<string, unknown>;
  } catch (error) {
    issues.push(`${label} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function bindingId(binding: RoleSkillBinding): string {
  return typeof binding === "string" ? binding : binding.id;
}

function bindingConfig(binding: RoleSkillBinding): JsonObject {
  return typeof binding === "string" ? {} : (binding.config ?? {});
}

function validateConfig(schema: Record<string, unknown>, config: JsonObject, label: string, issues: string[]): void {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (validate(config)) return;
  const details = (validate.errors ?? []).map(
    (error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
  );
  issues.push(`${label} is invalid: ${details.join("; ")}`);
}

function semanticIssues(
  manifest: MultiAgentManifest,
  projectRoot: string,
  architectures: ArchitectureRegistry,
  providers: ProviderRegistry
): string[] {
  const issues: string[] = [];
  const skillSchemas = new Map<string, Record<string, unknown>>();

  if (manifest.artifactRoot) {
    const artifactRoot = path.resolve(projectRoot, manifest.artifactRoot);
    const relative = path.relative(projectRoot, artifactRoot);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      issues.push(`artifactRoot must stay inside the manifest directory: ${manifest.artifactRoot}`);
    }
  }

  for (const [providerId, provider] of Object.entries(manifest.providers)) {
    const adapter = providers.get(provider.adapter);
    if (!adapter) issues.push(`provider ${providerId} references unregistered adapter ${provider.adapter}`);
    else issues.push(...adapter.validate({ providerId, definition: provider, projectRoot }));
  }

  for (const [skillId, skill] of Object.entries(manifest.skills ?? {})) {
    ensureNonEmptyText(
      ensureReadableFile(projectRoot, skill.instructions, `skill ${skillId} instructions`, issues),
      `skill ${skillId} instructions`,
      issues
    );
    if (skill.configSchema) {
      const schema = ensureJsonSchema(
        ensureReadableFile(projectRoot, skill.configSchema, `skill ${skillId} configSchema`, issues),
        `skill ${skillId} configSchema`,
        issues
      );
      if (schema) skillSchemas.set(skillId, schema);
    }
  }

  for (const [roleId, role] of Object.entries(manifest.roles)) {
    if (!manifest.providers[role.provider]) {
      issues.push(`role ${roleId} references unknown provider ${role.provider}`);
    }
    if (role.instructions) {
      ensureNonEmptyText(
        ensureReadableFile(projectRoot, role.instructions, `role ${roleId} instructions`, issues),
        `role ${roleId} instructions`,
        issues
      );
    }
    ensureNonEmptyText(
      ensureReadableFile(projectRoot, role.requestTemplate, `role ${roleId} requestTemplate`, issues),
      `role ${roleId} requestTemplate`,
      issues
    );
    ensureJsonSchema(
      ensureReadableFile(projectRoot, role.outputSchema, `role ${roleId} outputSchema`, issues),
      `role ${roleId} outputSchema`,
      issues
    );
    const overlap = role.verdict?.pass.filter((value) => role.verdict?.block.includes(value)) ?? [];
    if (overlap.length > 0) {
      issues.push(`role ${roleId} verdict pass/block values overlap: ${overlap.join(", ")}`);
    }
    const seenSkills = new Set<string>();
    for (const binding of role.skills ?? []) {
      const skillId = bindingId(binding);
      if (seenSkills.has(skillId)) issues.push(`role ${roleId} binds skill ${skillId} more than once`);
      seenSkills.add(skillId);
      if (!manifest.skills?.[skillId]) {
        issues.push(`role ${roleId} references unknown skill ${skillId}`);
        continue;
      }
      const configSchema = skillSchemas.get(skillId);
      if (configSchema) validateConfig(configSchema, bindingConfig(binding), `role ${roleId} skill ${skillId} config`, issues);
    }
  }

  for (const [workflowId, workflow] of Object.entries(manifest.workflows)) {
    if (workflow.inputSchema) {
      ensureJsonSchema(
        ensureReadableFile(projectRoot, workflow.inputSchema, `workflow ${workflowId} inputSchema`, issues),
        `workflow ${workflowId} inputSchema`,
        issues
      );
    }
    const adapter = architectures.get(workflow.architecture);
    if (!adapter) issues.push(`workflow ${workflowId} references unregistered architecture ${workflow.architecture}`);
    else issues.push(...adapter.validate({ manifest, workflowId, workflow }));
  }

  return issues;
}

export interface LoadManifestOptions {
  architectures?: ArchitectureRegistry;
  providers?: ProviderRegistry;
}

export function loadManifest(manifestFile = "multi-agent.yaml", options: LoadManifestOptions = {}): LoadedManifest {
  const manifestPath = path.resolve(manifestFile);
  if (!fs.existsSync(manifestPath)) {
    throw new ManifestValidationError([`manifest not found: ${manifestPath}`]);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new ManifestValidationError([`cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (!validateShape(parsed)) {
    throw new ManifestValidationError(displayAjvIssues());
  }
  const manifest = parsed as MultiAgentManifest;
  const projectRoot = path.dirname(manifestPath);
  const issues = semanticIssues(
    manifest,
    projectRoot,
    options.architectures ?? createDefaultArchitectureRegistry(),
    options.providers ?? createDefaultProviderRegistry()
  );
  if (issues.length > 0) throw new ManifestValidationError(issues);
  return { manifest, manifestPath, projectRoot };
}
