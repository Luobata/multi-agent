import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { JsonObject, LoadedManifest, MultiAgentManifest, RoleDefinition, SkillDefinition } from "../core/types.js";
import { loadManifest } from "../config/loadManifest.js";
import type { ProviderRegistry } from "../runtime/providers.js";
import type { ArchitectureRegistry } from "../architectures/types.js";
import type {
  EmployeeDefinition,
  ManagementPolicyDefinition,
  SupervisorWorkbenchWorkflowDefinition,
  WorkbenchSkillDefinition,
  WorkbenchState,
  WorkbenchWorkflowDefinition
} from "./types.js";

export const SUPERVISOR_RUNTIME_ROLE_ID = "supervisor";

export function supervisorMemberRuntimeRoleId(roleId: string): string {
  return `member-${safeId(roleId)}`;
}

export function supervisorDecisionSchema(
  roleIds: string[],
  gateIds: string[],
  maxParallelDelegations: number,
  dagNodeIds?: string[]
): JsonObject {
  const dagMode = dagNodeIds !== undefined;
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["action", "assignments"],
        properties: {
          action: { const: "delegate" },
          summary: { type: "string" },
          assignments: {
            type: "array",
            minItems: 1,
            maxItems: maxParallelDelegations,
            items: {
              type: "object",
              additionalProperties: false,
              required: dagMode ? ["nodeId", "roleId"] : ["roleId", "task"],
              properties: {
                ...(dagMode ? { nodeId: { type: "string", minLength: 1 } } : {}),
                roleId: dagMode ? { type: "string", minLength: 1 } : { type: "string", enum: roleIds },
                task: { type: "string", minLength: 1 },
                requiredCapabilities: {
                  type: "array",
                  uniqueItems: true,
                  items: { type: "string", minLength: 1 }
                },
                workKind: { enum: ["discussion", "code", "test", "audit", "integration", "other"] },
                changeSet: { type: "string", minLength: 1 },
                context: { type: "object" }
              }
            }
          }
        }
      },
      ...(gateIds.length > 0 ? [{
        type: "object",
        additionalProperties: false,
        required: ["action", "gateId", "summary", "evidence"],
        properties: {
          action: { const: "satisfy-gate" },
          gateId: { type: "string", enum: gateIds },
          summary: { type: "string", minLength: 1 },
          evidence: {}
        }
      }] : []),
      {
        type: "object",
        additionalProperties: false,
        required: ["action", "summary", "result"],
        properties: {
          action: { const: "finish" },
          summary: { type: "string", minLength: 1 },
          result: {}
        }
      }
    ]
  };
}

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

function policyVersion(state: WorkbenchState, workflow: SupervisorWorkbenchWorkflowDefinition): ManagementPolicyDefinition {
  const record = state.managementPolicies[workflow.managementPolicy.id];
  const found = record?.versions.find((candidate) => candidate.version === workflow.managementPolicy.version);
  if (!found) {
    throw new Error(`management policy ${workflow.managementPolicy.id} version ${workflow.managementPolicy.version} not found`);
  }
  return found;
}

function skillVersion(state: WorkbenchState, id: string, version: number): WorkbenchSkillDefinition {
  const current = state.skills[id];
  const found = current?.version === version
    ? current
    : state.skillHistory[id]?.find((candidate) => candidate.version === version);
  if (!found) throw new Error(`workbench skill ${id} version ${version} not found`);
  return found;
}

function requestTemplateFor(
  workflow: WorkbenchWorkflowDefinition,
  runtimeRoleId: string,
  employee: EmployeeDefinition
): string {
  if (workflow.architecture === "graph") {
    return `${employee.requestPrompt.trim()}\n\n## Knowledge evidence\n\n{{node.with.__knowledgeEvidence}}\n\n## Current input\n\n{{input}}\n\n## Dependency evidence\n\n{{needs}}\n`;
  }
  if (runtimeRoleId === SUPERVISOR_RUNTIME_ROLE_ID) {
    if (!workflow.flow.dag) {
      return `${employee.requestPrompt.trim()}\n\n## Supervisor control contract\n\nYou are the workflow supervisor. Decide the next action; do not perform a member's specialist task yourself.\n\nFixed flow and Gates (hard requirements are enforced by the runtime):\n{{node.with.__supervisorFlow}}\n\nManagement policy (hard limits are enforced by the runtime):\n{{node.with.__managementPolicy}}\n\nAvailable member role slots and explicit capabilities:\n{{node.with.__supervisorTeam}}\n\nCurrent round:\n{{node.with.__supervisorRound}}\n\nCurrent Gate state:\n{{node.with.__supervisorGates}}\n\nGate execution request, when this node is acting as an allowed supervisor fallback:\n{{node.with.__gateExecution}}\n\nPrior decision, delegation, and Gate ledger:\n{{node.with.__supervisorHistory}}\n\nLatest delegated evidence:\n{{needs}}\n\nKnowledge evidence:\n{{node.with.__knowledgeEvidence}}\n\nOriginal workflow input:\n{{input}}\n\nReturn exactly one JSON decision matching the supplied output schema. Use action \"delegate\" with one or more assignments, action \"satisfy-gate\" only for the requested Gate fallback, or action \"finish\" with the final result.\n`;
    }
    return `${employee.requestPrompt.trim()}\n\n## Supervisor control contract\n\nYou are the workflow supervisor. Decide the next action; do not perform a member's specialist task yourself.\n\nFixed flow and Gates (hard requirements are enforced by the runtime):\n{{node.with.__supervisorFlow}}\n\nDeclarative DAG and current logical-node state, when configured:\n{{node.with.__supervisorDag}}\n\nManagement policy (hard limits are enforced by the runtime):\n{{node.with.__managementPolicy}}\n\nAvailable member role slots and explicit capabilities:\n{{node.with.__supervisorTeam}}\n\nCurrent round:\n{{node.with.__supervisorRound}}\n\nCurrent Gate state:\n{{node.with.__supervisorGates}}\n\nGate execution request, when this node is acting as an allowed supervisor fallback:\n{{node.with.__gateExecution}}\n\nPrior decision, delegation, and Gate ledger:\n{{node.with.__supervisorHistory}}\n\nLatest delegated evidence:\n{{needs}}\n\nKnowledge evidence:\n{{node.with.__knowledgeEvidence}}\n\nOriginal workflow input:\n{{input}}\n\nReturn exactly one JSON decision matching the supplied output schema. In DAG mode every delegate assignment must name its declared nodeId and matching roleId; delegate only ready nodes whose dependencies passed. Use action \"delegate\" with one or more assignments, action \"satisfy-gate\" only for the requested Gate fallback, or action \"finish\" with the final result.\n`;
  }
  return `${employee.requestPrompt.trim()}\n\n## Delegation from the workflow supervisor\n\nYour workflow-local role slot:\n{{node.with.__delegatedRoleId}}\n\nDelegated task:\n{{node.with.__delegatedTask}}\n\nRequired capabilities:\n{{node.with.__requiredCapabilities}}\n\nWork kind and change set:\n{{node.with.__workKind}} / {{node.with.__changeSet}}\n\nGate execution request, when present:\n{{node.with.__gateExecution}}\n\nDelegated context:\n{{node.with.__delegatedContext}}\n\nSupervisor summary:\n{{node.with.__supervisorSummary}}\n\nKnowledge evidence:\n{{node.with.__knowledgeEvidence}}\n\nOriginal workflow input:\n{{input}}\n\nReturn the requested specialist result using your normal output contract.\n`;
}

export async function materializeWorkflow(options: MaterializeOptions): Promise<MaterializedWorkflow> {
  const bundleId = `${safeId(options.workflow.id)}-${randomUUID()}`;
  const bundleDir = path.join(options.dataRoot, "generated", bundleId);
  await fs.mkdir(path.join(bundleDir, "roles"), { recursive: true });
  await fs.mkdir(path.join(bundleDir, "skills"), { recursive: true });
  await fs.mkdir(path.join(bundleDir, "schemas"), { recursive: true });

  const supervisorWorkflow = options.workflow.architecture === "supervisor" ? options.workflow : undefined;
  const supervisorPolicy = supervisorWorkflow
    ? policyVersion(options.state, supervisorWorkflow)
    : undefined;
  const orchestrationSkill = supervisorWorkflow
    ? skillVersion(options.state, supervisorWorkflow.orchestrationSkill.id, supervisorWorkflow.orchestrationSkill.version)
    : undefined;
  if (orchestrationSkill && (orchestrationSkill.owner !== "system" || orchestrationSkill.injection !== "supervisor")) {
    throw new Error(`workbench skill ${orchestrationSkill.id} v${orchestrationSkill.version} is not a supervisor system injection`);
  }

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
  if (orchestrationSkill) {
    requiredSkills.set(`${orchestrationSkill.id}-v${orchestrationSkill.version}`, orchestrationSkill);
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
  for (const [runtimeRoleId, employee] of options.employees) {
    const roleDir = path.join(bundleDir, "roles", safeId(runtimeRoleId));
    await fs.mkdir(roleDir, { recursive: true });
    const instructions = `roles/${runtimeRoleId}/instructions.md`;
    const requestTemplate = `roles/${runtimeRoleId}/request.md`;
    const outputSchema = `schemas/${runtimeRoleId}-output.schema.json`;
    await fs.writeFile(path.join(bundleDir, instructions), employee.systemPrompt.trim(), "utf8");
    await fs.writeFile(path.join(bundleDir, requestTemplate), requestTemplateFor(options.workflow, runtimeRoleId, employee), "utf8");
    const isSupervisor = options.workflow.architecture === "supervisor" && runtimeRoleId === SUPERVISOR_RUNTIME_ROLE_ID;
    await writeJson(
      path.join(bundleDir, outputSchema),
      isSupervisor
        ? supervisorDecisionSchema(
            supervisorWorkflow!.members.map((member) => member.roleId),
            supervisorWorkflow!.flow.gates.map((gate) => gate.id),
            supervisorPolicy!.limits.maxParallelDelegations,
            supervisorWorkflow!.flow.dag?.nodes.map((node) => node.nodeId)
          )
        : employee.outputSchema
    );
    const employeeSkills = employee.skills.filter((binding) => typeof binding === "string" || binding.enabled !== false).map((binding) => {
      const id = typeof binding === "string" ? binding : binding.id;
      const version = employee.skillVersions[id] ?? options.state.skills[id]?.version;
      if (!version) throw new Error(`unknown workbench skill ${id}`);
      return {
        id: `${id}-v${version}`,
        config: typeof binding === "string" ? {} : binding.config ?? {}
      };
    });
    if (isSupervisor) {
      employeeSkills.push({ id: `${orchestrationSkill!.id}-v${orchestrationSkill!.version}`, config: {} });
    }
    roles[runtimeRoleId] = {
      identity: {
        ...employee.identity,
        metadata: {
          ...(employee.identity.metadata ?? {}),
          employeeId: employee.id,
          employeeVersion: employee.version,
          capabilities: employee.capabilities,
          ...(isSupervisor ? {
            runtimeSkillInjections: [{
              skillId: orchestrationSkill!.id,
              version: orchestrationSkill!.version,
              reason: "supervisor-runtime"
            }]
          } : {})
        }
      },
      description: employee.description,
      provider: employee.providerId,
      instructions,
      skills: employeeSkills,
      requestTemplate,
      outputSchema,
      maxAttempts: employee.maxAttempts,
      permissions: employee.permissions,
      verdict: isSupervisor ? undefined : employee.verdict
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

  const workflowConfig: JsonObject = options.workflow.architecture === "graph"
    ? {
        maxConcurrency: options.workflow.maxConcurrency,
        failFast: options.workflow.failFast,
        nodes: options.workflow.nodes.map((node) => ({
          id: node.id,
          role: node.employeeId,
          needs: node.needs,
          with: { ...node.with, __knowledgeEvidence: node.with.__knowledgeEvidence ?? "" }
        }))
      }
    : {
        supervisor: {
          role: SUPERVISOR_RUNTIME_ROLE_ID,
          capabilities: [...options.employees.get(SUPERVISOR_RUNTIME_ROLE_ID)!.capabilities],
          skillInjection: {
            id: orchestrationSkill!.id,
            version: orchestrationSkill!.version,
            reason: "supervisor-runtime"
          }
        },
        policy: {
          id: supervisorPolicy!.id,
          version: supervisorPolicy!.version,
          instructions: supervisorPolicy!.instructions,
          allowedRoleIds: [...supervisorPolicy!.allowedRoleIds],
          limits: { ...supervisorPolicy!.limits },
          failure: { ...supervisorPolicy!.failure },
          completion: { ...supervisorPolicy!.completion }
        },
        members: supervisorWorkflow!.members.map((member) => ({
          roleId: member.roleId,
          role: supervisorMemberRuntimeRoleId(member.roleId),
          description: member.description,
          capabilities: [...options.employees.get(supervisorMemberRuntimeRoleId(member.roleId))!.capabilities]
        })),
        flow: {
          version: supervisorWorkflow!.flow.version,
          stages: supervisorWorkflow!.flow.stages.map((stage) => ({ ...stage })),
          gates: supervisorWorkflow!.flow.gates.map((gate) => ({ ...gate })),
          ...(supervisorWorkflow!.flow.dag ? {
            dag: {
              nodes: supervisorWorkflow!.flow.dag.nodes.map((node) => ({
                ...node,
                needs: [...node.needs]
              }))
            }
          } : {})
        }
      };
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
        config: workflowConfig
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
