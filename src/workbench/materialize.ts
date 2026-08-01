import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { JsonObject, LoadedManifest, MultiAgentManifest, RoleDefinition, SkillDefinition } from "../core/types.js";
import { loadManifest } from "../config/loadManifest.js";
import type { ProviderRegistry } from "../runtime/providers.js";
import type { ArchitectureRegistry } from "../architectures/types.js";
import type {
  EmployeeDefinition,
  WorkbenchSkillDefinition,
  WorkbenchState,
  WorkbenchWorkflowDefinition
} from "./types.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeId(value: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new Error(`invalid id: ${value}`);
  return value;
}

export interface MaterializeOptions {
  dataRoot: string;
  state: WorkbenchState;
  workflow: WorkbenchWorkflowDefinition;
  employees: Map<string, EmployeeDefinition>;
  providers: ProviderRegistry;
  architectures: ArchitectureRegistry;
}

export interface MaterializedWorkflow {
  loaded: LoadedManifest;
  workflowId: string;
  bundleDir: string;
}

export async function materializeWorkflow(options: MaterializeOptions): Promise<MaterializedWorkflow> {
  const bundleId = `${safeId(options.workflow.id)}-${randomUUID()}`;
  const bundleDir = path.join(options.dataRoot, "generated", bundleId);
  await fs.mkdir(path.join(bundleDir, "roles"), { recursive: true });
  await fs.mkdir(path.join(bundleDir, "skills"), { recursive: true });
  await fs.mkdir(path.join(bundleDir, "schemas"), { recursive: true });

  const requiredSkills = new Map<string, WorkbenchSkillDefinition>();
  for (const employee of options.employees.values()) {
    for (const binding of employee.skills) {
      if (typeof binding !== "string" && binding.enabled === false) continue;
      const skillId = typeof binding === "string" ? binding : binding.id;
      const current = options.state.skills[skillId];
      if (!current) throw new Error(`unknown workbench skill ${skillId}`);
      const version = employee.skillVersions[skillId] ?? current.version;
      const skill = current.version === version
        ? current
        : options.state.skillHistory[skillId]?.find((candidate) => candidate.version === version);
      if (!skill) throw new Error(`unknown workbench skill ${skillId} version ${version}`);
      requiredSkills.set(`${skillId}-v${version}`, skill);
    }
  }

  const skills: Record<string, SkillDefinition> = {};
  for (const [materializedId, skill] of requiredSkills) {
    const instructionPath = `skills/${safeId(materializedId)}.md`;
    await fs.writeFile(path.join(bundleDir, instructionPath), skill.instructions.trim(), "utf8");
    let configSchemaPath: string | undefined;
    if (skill.configSchema) {
      configSchemaPath = `schemas/skill-${safeId(materializedId)}.schema.json`;
      await writeJson(path.join(bundleDir, configSchemaPath), skill.configSchema);
    }
    skills[materializedId] = {
      displayName: skill.displayName,
      description: skill.description,
      instructions: instructionPath,
      configSchema: configSchemaPath,
      tools: skill.tools
    };
  }

  const roles: Record<string, RoleDefinition> = {};
  for (const [employeeId, employee] of options.employees) {
    const roleDir = path.join(bundleDir, "roles", safeId(employeeId));
    await fs.mkdir(roleDir, { recursive: true });
    const instructions = `roles/${employeeId}/instructions.md`;
    const requestTemplate = `roles/${employeeId}/request.md`;
    const outputSchema = `schemas/${employeeId}-output.schema.json`;
    await fs.writeFile(path.join(bundleDir, instructions), employee.systemPrompt.trim(), "utf8");
    await fs.writeFile(
      path.join(bundleDir, requestTemplate),
      `${employee.requestPrompt.trim()}\n\n## Knowledge evidence\n\n{{node.with.__knowledgeEvidence}}\n\n## Current input\n\n{{input}}\n\n## Dependency evidence\n\n{{needs}}\n`,
      "utf8"
    );
    await writeJson(path.join(bundleDir, outputSchema), employee.outputSchema);
    roles[employeeId] = {
      identity: {
        ...employee.identity,
        metadata: {
          ...(employee.identity.metadata ?? {}),
          employeeVersion: employee.version
        }
      },
      description: employee.description,
      provider: employee.providerId,
      instructions,
      skills: employee.skills.filter((binding) => typeof binding === "string" || binding.enabled !== false).map((binding) => {
        const id = typeof binding === "string" ? binding : binding.id;
        const version = employee.skillVersions[id] ?? options.state.skills[id]?.version;
        if (!version) throw new Error(`unknown workbench skill ${id}`);
        return {
          id: `${id}-v${version}`,
          config: typeof binding === "string" ? {} : binding.config ?? {}
        };
      }),
      requestTemplate,
      outputSchema,
      maxAttempts: employee.maxAttempts,
      permissions: employee.permissions,
      verdict: employee.verdict
    };
  }

  const providerIds = new Set([...options.employees.values()].map((employee) => employee.providerId));
  const manifestProviders = Object.fromEntries(
    [...providerIds].map((providerId) => {
      const provider = options.state.providers[providerId];
      if (!provider) throw new Error(`unknown workbench provider ${providerId}`);
      return [providerId, provider];
    })
  );

  const manifest: MultiAgentManifest = {
    version: 1,
    name: `workbench-${options.workflow.id}`,
    artifactRoot: ".multi-agent",
    providers: manifestProviders,
    skills,
    roles,
    workflows: {
      [options.workflow.id]: {
        architecture: options.workflow.architecture,
        description: options.workflow.description,
        inputSchema: options.workflow.inputSchema ? `schemas/${safeId(options.workflow.id)}-input.schema.json` : undefined,
        config: {
          maxConcurrency: options.workflow.maxConcurrency,
          failFast: options.workflow.failFast,
          nodes: options.workflow.nodes.map((node) => ({
            id: node.id,
            role: node.employeeId,
            needs: node.needs,
            with: { ...node.with, __knowledgeEvidence: node.with.__knowledgeEvidence ?? "" }
          }))
        }
      }
    }
  };
  if (options.workflow.inputSchema) {
    await writeJson(
      path.join(bundleDir, `schemas/${safeId(options.workflow.id)}-input.schema.json`),
      options.workflow.inputSchema
    );
  }
  const manifestPath = path.join(bundleDir, "multi-agent.json");
  await writeJson(manifestPath, manifest);
  return {
    loaded: loadManifest(manifestPath, { providers: options.providers, architectures: options.architectures }),
    workflowId: options.workflow.id,
    bundleDir
  };
}

export function resolveSkillBinding(
  binding: EmployeeDefinition["skills"][number],
  skill: WorkbenchSkillDefinition
): { id: string; enabled: boolean; instructions: string; config: JsonObject; tools: string[] } {
  return {
    id: skill.id,
    enabled: typeof binding === "string" || binding.enabled !== false,
    instructions: skill.instructions,
    config: typeof binding === "string" ? {} : binding.config ?? {},
    tools: skill.tools
  };
}
