import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { JsonObject, RolePermissionDefinition } from "../core/types.js";
import type { ProjectConnectInput, ProjectCreateInput, ProjectScope } from "./types.js";

const DEFAULT_DESCRIPTOR = "multi-agent.project.yaml";
const MAX_REFERENCED_FILE_BYTES = 512 * 1024;
const MCP_STARTER_DESCRIPTOR = fileURLToPath(
  new URL("../../templates/workbench/mcp-project-starter.project.yaml", import.meta.url)
);

export interface EnsuredProjectDescriptor {
  descriptorPath: string;
  created: boolean;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function textValue(value: unknown, label: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  return value.trim();
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => String(item).trim()))];
}

function jsonObject(value: unknown, label: string): JsonObject {
  return objectValue(value, label) as JsonObject;
}

function resolveProjectFile(rootPath: string, reference: string, label: string): string {
  const resolved = path.resolve(rootPath, reference);
  const relative = path.relative(rootPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the project root`);
  }
  return resolved;
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

async function resolveProjectRoot(input: ProjectConnectInput): Promise<string> {
  const requestedRoot = path.resolve(textValue(input.rootPath, "project rootPath"));
  let rootStat;
  try {
    rootStat = await fs.stat(requestedRoot);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") throw new Error(`project rootPath does not exist: ${requestedRoot}`);
    throw error;
  }
  if (!rootStat.isDirectory()) throw new Error(`project rootPath is not a directory: ${requestedRoot}`);
  return fs.realpath(requestedRoot);
}

function requestedDescriptorPath(input: ProjectConnectInput, rootPath: string): string {
  const requestedDescriptor = input.descriptorPath
    ? textValue(input.descriptorPath, "project descriptorPath")
    : DEFAULT_DESCRIPTOR;
  return path.isAbsolute(requestedDescriptor)
    ? path.resolve(requestedDescriptor)
    : path.resolve(rootPath, requestedDescriptor);
}

function starterProjectId(input: ProjectConnectInput, rootPath: string): string {
  const hint = input.projectIdHint?.trim() || input.projectNameHint?.trim() || path.basename(rootPath);
  let id = hint
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) id = `local-project-${createHash("sha256").update(rootPath).digest("hex").slice(0, 8)}`;
  if (/^[0-9]/.test(id)) id = `project-${id}`;
  return id;
}

/**
 * Scaffold the small, project-owned descriptor only after an explicit control-plane action.
 * Existing files are never rewritten, and both the target and any symlinked parent must stay
 * inside the real project root.
 */
export async function ensureProjectDescriptor(input: ProjectConnectInput): Promise<EnsuredProjectDescriptor> {
  const rootPath = await resolveProjectRoot(input);
  const requestedPath = requestedDescriptorPath(input, rootPath);
  const descriptorPath = resolveProjectFile(rootPath, requestedPath, "project descriptorPath");
  const parentPath = path.dirname(descriptorPath);
  let parentStat;
  try {
    parentStat = await fs.stat(parentPath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      throw new Error(`project descriptor directory does not exist: ${parentPath}`);
    }
    throw error;
  }
  if (!parentStat.isDirectory()) throw new Error(`project descriptor directory is not a directory: ${parentPath}`);
  const realParent = await fs.realpath(parentPath);
  const safeDescriptorPath = resolveProjectFile(
    rootPath,
    path.join(realParent, path.basename(descriptorPath)),
    "project descriptorPath"
  );

  try {
    const existingStat = await fs.stat(safeDescriptorPath);
    const realDescriptorPath = resolveProjectFile(
      rootPath,
      await fs.realpath(safeDescriptorPath),
      "project descriptorPath"
    );
    if (!existingStat.isFile()) throw new Error(`project descriptor is not a file: ${safeDescriptorPath}`);
    return { descriptorPath: realDescriptorPath, created: false };
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }

  const template = objectValue(
    YAML.parse(await fs.readFile(MCP_STARTER_DESCRIPTOR, "utf8")),
    "MCP starter project descriptor"
  );
  const project = objectValue(template.project, "MCP starter project descriptor.project");
  project.id = starterProjectId(input, rootPath);
  project.name = input.projectNameHint?.trim() || path.basename(rootPath) || project.id;
  project.description = "通过 MCP 发现并在 Workbench 中显式接入的本地项目。";
  const contents = YAML.stringify(template, { lineWidth: 0 });

  try {
    await fs.writeFile(safeDescriptorPath, contents, { encoding: "utf8", flag: "wx", mode: 0o644 });
    return { descriptorPath: safeDescriptorPath, created: true };
  } catch (error) {
    // Another explicit onboarding request may have won the race. Treat that file
    // exactly like any pre-existing descriptor and leave its contents untouched.
    if (nodeErrorCode(error) !== "EEXIST") throw error;
    const existingStat = await fs.stat(safeDescriptorPath);
    if (!existingStat.isFile()) throw new Error(`project descriptor is not a file: ${safeDescriptorPath}`);
    return { descriptorPath: safeDescriptorPath, created: false };
  }
}

async function readReferencedText(rootPath: string, reference: string, label: string): Promise<string> {
  const filePath = resolveProjectFile(rootPath, reference, label);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${reference}`);
  if (stat.size > MAX_REFERENCED_FILE_BYTES) throw new Error(`${label} exceeds 512 KiB: ${reference}`);
  return textValue(await fs.readFile(filePath, "utf8"), label);
}

function permissionsValue(value: unknown, label: string): RolePermissionDefinition | undefined {
  if (value === undefined) return undefined;
  const object = objectValue(value, label);
  const write = textValue(object.write, `${label}.write`);
  if (!(["none", "artifacts-only", "project"] as string[]).includes(write)) {
    throw new Error(`${label}.write must be none, artifacts-only, or project`);
  }
  return {
    write: write as RolePermissionDefinition["write"],
    tools: object.tools === undefined ? undefined : stringList(object.tools, `${label}.tools`)
  };
}

export async function loadProjectDescriptor(input: ProjectConnectInput): Promise<ProjectCreateInput> {
  const rootPath = await resolveProjectRoot(input);
  const descriptorPath = requestedDescriptorPath(input, rootPath);
  let descriptorStat;
  try {
    descriptorStat = await fs.stat(descriptorPath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") throw new Error(`project descriptor does not exist: ${descriptorPath}`);
    throw error;
  }
  if (!descriptorStat.isFile()) throw new Error(`project descriptor is not a file: ${descriptorPath}`);
  if (descriptorStat.size > MAX_REFERENCED_FILE_BYTES) throw new Error(`project descriptor exceeds 512 KiB: ${descriptorPath}`);

  const parsed = objectValue(YAML.parse(await fs.readFile(descriptorPath, "utf8")), "project descriptor");
  if (parsed.version !== 1) throw new Error("project descriptor version must be 1");
  const project = objectValue(parsed.project, "project descriptor.project");
  const connector = objectValue(parsed.connector ?? { kind: "generic" }, "project descriptor.connector");
  const roles = objectValue(parsed.roles, "project descriptor.roles");
  const roleEntries = Object.entries(roles);
  if (roleEntries.length === 0) throw new Error("project descriptor.roles must contain at least one role slot");

  const scope = textValue(project.scope, "project descriptor.project.scope", "repository");
  if (scope !== "repository" && scope !== "workspace") {
    throw new Error("project descriptor.project.scope must be repository or workspace");
  }

  return {
    id: textValue(project.id, "project descriptor.project.id"),
    name: textValue(project.name, "project descriptor.project.name", textValue(project.id, "project descriptor.project.id")),
    description: textValue(project.description, "project descriptor.project.description", "Locally connected project."),
    scope: scope as ProjectScope,
    rootPath,
    descriptorPath,
    connector: {
      kind: textValue(connector.kind, "project descriptor.connector.kind"),
      config: connector.config === undefined ? {} : jsonObject(connector.config, "project descriptor.connector.config")
    },
    roles: await Promise.all(roleEntries.map(async ([id, rawRole]) => {
      const role = objectValue(rawRole, `project descriptor.roles.${id}`);
      const policyRef = role.policyRef === undefined
        ? undefined
        : textValue(role.policyRef, `project descriptor.roles.${id}.policyRef`);
      const instructions = policyRef
        ? await readReferencedText(rootPath, policyRef, `project role ${id} policyRef`)
        : textValue(role.instructions, `project descriptor.roles.${id}.instructions`, `Follow the ${id} project role contract.`);
      const outputSchemaRef = role.outputSchemaRef === undefined
        ? undefined
        : textValue(role.outputSchemaRef, `project descriptor.roles.${id}.outputSchemaRef`);
      const outputSchema = outputSchemaRef
        ? jsonObject(JSON.parse(await readReferencedText(rootPath, outputSchemaRef, `project role ${id} outputSchemaRef`)), `project role ${id} output schema`)
        : role.outputSchema === undefined
          ? undefined
          : jsonObject(role.outputSchema, `project descriptor.roles.${id}.outputSchema`);
      return {
        id,
        displayName: textValue(role.displayName, `project descriptor.roles.${id}.displayName`, id),
        description: textValue(role.description, `project descriptor.roles.${id}.description`, `Project role ${id}.`),
        requiredSkills: stringList(role.requiredSkills, `project descriptor.roles.${id}.requiredSkills`),
        optionalSkills: stringList(role.optionalSkills, `project descriptor.roles.${id}.optionalSkills`),
        requiredProviderProfiles: stringList(role.requiredProviderProfiles, `project descriptor.roles.${id}.requiredProviderProfiles`),
        knowledgeProfileIds: stringList(role.knowledgeProfiles, `project descriptor.roles.${id}.knowledgeProfiles`),
        instructions,
        outputSchema,
        permissions: permissionsValue(role.permissions, `project descriptor.roles.${id}.permissions`)
      };
    }))
  };
}
