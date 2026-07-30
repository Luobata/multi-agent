import fs from "node:fs";
import path from "node:path";
import { ManifestValidationError } from "./errors.js";
import { renderTemplate } from "./template.js";
import type {
  JsonObject,
  LoadedManifest,
  RoleDefinition,
  RoleSkillBinding,
  SkillDefinition,
  WritePolicy
} from "./types.js";

export interface ResolvedSkillProfile {
  id: string;
  displayName: string;
  description: string;
  instructions: string;
  config: JsonObject;
  tools: string[];
}

export interface ResolvedRoleProfile {
  id: string;
  definition: RoleDefinition;
  description: string;
  instructions?: string;
  skills: ResolvedSkillProfile[];
  effectiveTools: string[];
  writePolicy: WritePolicy;
}

function readText(projectRoot: string, relativePath: string): string {
  return fs.readFileSync(path.resolve(projectRoot, relativePath), "utf8").trim();
}

function normalizeBinding(binding: RoleSkillBinding): { id: string; config: JsonObject; enabled: boolean } {
  return typeof binding === "string"
    ? { id: binding, config: {}, enabled: true }
    : { id: binding.id, config: binding.config ?? {}, enabled: binding.enabled !== false };
}

function resolveSkill(
  loaded: LoadedManifest,
  binding: RoleSkillBinding,
  definitions: Record<string, SkillDefinition>
): ResolvedSkillProfile {
  const normalized = normalizeBinding(binding);
  const definition = definitions[normalized.id];
  if (!definition) throw new ManifestValidationError([`unknown skill ${normalized.id}`]);
  return {
    id: normalized.id,
    displayName: definition.displayName ?? normalized.id,
    description: definition.description,
    instructions: readText(loaded.projectRoot, definition.instructions),
    config: normalized.config,
    tools: definition.tools ?? []
  };
}

export function resolveRoleProfile(loaded: LoadedManifest, roleId: string): ResolvedRoleProfile {
  const definition = loaded.manifest.roles[roleId];
  if (!definition) throw new ManifestValidationError([`unknown role ${roleId}`]);
  const skills = (definition.skills ?? [])
    .filter((binding) => normalizeBinding(binding).enabled)
    .map((binding) => resolveSkill(loaded, binding, loaded.manifest.skills ?? {}));
  const effectiveTools = [
    ...new Set([...skills.flatMap((skill) => skill.tools), ...(definition.permissions?.tools ?? [])])
  ];
  return {
    id: roleId,
    definition,
    description: definition.description ?? definition.identity.background,
    instructions: definition.instructions ? readText(loaded.projectRoot, definition.instructions) : undefined,
    skills,
    effectiveTools,
    writePolicy: definition.permissions?.write ?? "none"
  };
}

function listSection(title: string, values: string[] | undefined): string[] {
  if (!values?.length) return [];
  return [`## ${title}`, "", ...values.map((value) => `- ${value}`), ""];
}

export function renderRoleSystemPrompt(profile: ResolvedRoleProfile, context: Record<string, unknown>): string {
  const { identity } = profile.definition;
  const lines = [
    `# Role: ${identity.displayName}`,
    "",
    `Role ID: \`${profile.id}\``,
    "",
    "## Background",
    "",
    identity.background,
    "",
    ...listSection("Responsibilities", identity.responsibilities),
    ...listSection("Goals", identity.goals),
    ...listSection("Constraints", identity.constraints)
  ];

  if (identity.metadata && Object.keys(identity.metadata).length > 0) {
    lines.push("## Identity Metadata", "", "```json", JSON.stringify(identity.metadata, null, 2), "```", "");
  }

  if (profile.skills.length > 0) {
    lines.push("# Skills", "");
    for (const skill of profile.skills) {
      const skillContext = {
        ...context,
        skill: {
          id: skill.id,
          displayName: skill.displayName,
          description: skill.description,
          config: skill.config,
          tools: skill.tools
        }
      };
      lines.push(`## ${skill.displayName} (\`${skill.id}\`)`, "", skill.description, "");
      if (Object.keys(skill.config).length > 0) {
        lines.push("Configuration:", "", "```json", JSON.stringify(skill.config, null, 2), "```", "");
      }
      lines.push(renderTemplate(skill.instructions, skillContext), "");
    }
  }

  if (profile.instructions) {
    lines.push("# Role-specific Instructions", "", renderTemplate(profile.instructions, context), "");
  }

  return lines.join("\n").trim();
}
