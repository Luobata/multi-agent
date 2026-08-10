// One-off onboarding for 小配 (configuration-steward) and 小关 (gate-steward).
// Mirrors how 小知 (knowledge-steward) was installed: create the conversation
// skills, add the two project roles, create the employees pinned to the project's
// current version, then bind them to their project roles.
//
// Runs against WorkbenchService (coordinates with the daemon via the file lock).
// Point MULTI_AGENT_DATA_DIR at a sandbox copy first to dry-run.
import fs from "node:fs";
import path from "node:path";
import { WorkbenchService } from "../src/workbench/service.js";

const root = path.resolve(".");
const readTpl = (p) => JSON.parse(fs.readFileSync(path.join(root, "templates/workbench", p), "utf8"));

const configSkill = readTpl("configuration-control-conversation.skill.json");
const gateSkill = readTpl("gate-control-conversation.skill.json");
const configEmp = readTpl("configuration-steward.employee.json");
const gateEmp = readTpl("gate-steward.employee.json");

const PROJECT_ID = "local-agent-workbench";

async function ensureSkill(service, skill) {
  const exists = service.listSkills(true).some((s) => s.id === skill.id);
  if (exists) { console.log(`skill ${skill.id}: already present`); return; }
  await service.createSkill(skill);
  console.log(`skill ${skill.id}: created`);
}

async function main() {
  const service = await WorkbenchService.open();
  console.log("dataRoot:", service.store.dataRoot);

  // 1. Conversation skills the stewards bind.
  await ensureSkill(service, configSkill);
  await ensureSkill(service, gateSkill);

  // 2. Current project + roles. updateProject replaces the whole role set and bumps
  //    the version, so carry existing roles forward and append the two steward roles.
  const project = service.getProject(PROJECT_ID);
  const existingRoleIds = new Set(project.roles.map((r) => r.id));
  const rolesToAdd = [
    {
      id: "configuration-steward",
      displayName: "配置管家",
      description: "起草员工配置提案。",
      instructions: "只用受限 Configuration Control MCP 起草配置提案，人工审阅后应用。",
      requiredSkills: [configSkill.id],
      permissions: { write: "none", tools: configEmp.permissions?.tools ?? [] }
    },
    {
      id: "gate-steward",
      displayName: "门禁管家",
      description: "起草工作流门禁变更提案。",
      instructions: "只用受限 Gate Control MCP 起草门禁变更提案，人工审批后应用。",
      requiredSkills: [gateSkill.id],
      permissions: { write: "none", tools: gateEmp.permissions?.tools ?? [] }
    }
  ].filter((r) => !existingRoleIds.has(r.id));

  if (rolesToAdd.length > 0) {
    const carriedRoles = project.roles.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      description: r.description,
      instructions: r.instructions,
      requiredSkills: r.requiredSkills,
      optionalSkills: r.optionalSkills,
      requiredProviderProfiles: r.requiredProviderProfiles,
      knowledgeProfileIds: r.knowledgeProfileIds,
      outputSchema: r.outputSchema,
      permissions: r.permissions
    }));
    const updated = await service.updateProject(PROJECT_ID, {
      id: PROJECT_ID,
      name: project.name,
      description: project.description,
      rootPath: project.rootPath,
      descriptorPath: project.descriptorPath,
      roles: [...carriedRoles, ...rolesToAdd]
    });
    console.log(`project: added roles ${rolesToAdd.map((r) => r.id).join(", ")} -> v${updated.version}`);
  } else {
    console.log("project: steward roles already present");
  }

  // 3. Employees, pinned to the project's CURRENT version (createEmployee resolves
  //    the current version when scope.projectVersion is omitted).
  const currentProjectVersion = service.getProject(PROJECT_ID).version;
  for (const emp of [configEmp, gateEmp]) {
    if (service.listEmployees(true).some((e) => e.id === emp.id)) {
      console.log(`employee ${emp.id}: already present`);
      continue;
    }
    const created = await service.createEmployee({
      ...emp,
      scope: { kind: "project", projectId: PROJECT_ID, projectVersion: currentProjectVersion }
    });
    console.log(`employee ${emp.id}: created (systemRole=${created.systemRole}, scope v${created.scope.projectVersion})`);
  }

  // 4. Bind. saveProjectBinding replaces ALL role bindings and re-validates each at
  //    the current project version, so we must re-pin any steward pinned to an older
  //    project version first. Carry existing bindings forward + add the two stewards.
  const binding = service.getProjectBinding(PROJECT_ID);
  for (const roleBinding of binding.roles) {
    const emp = service.getEmployee(roleBinding.employeeId);
    if (emp.scope.kind === "project" && emp.scope.projectVersion !== currentProjectVersion) {
      const repinned = await service.repinEmployeeProject(roleBinding.employeeId);
      console.log(`repinned ${roleBinding.employeeId} -> project v${repinned.scope.projectVersion}`);
    }
  }
  const carriedBindings = binding.roles.map((r) => ({
    roleId: r.roleId,
    employeeId: r.employeeId,
    skills: r.skills,
    knowledgeProfileIds: r.knowledgeProfileIds,
    knowledgeGrants: r.knowledgeGrants,
    updatePolicy: r.updatePolicy
  }));
  const newBindings = [
    { roleId: "configuration-steward", employeeId: configEmp.id, updatePolicy: "locked" },
    { roleId: "gate-steward", employeeId: gateEmp.id, updatePolicy: "locked" }
  ].filter((b) => !carriedBindings.some((c) => c.roleId === b.roleId));
  if (newBindings.length === 0) {
    console.log(`binding: steward roles already bound (v${binding.version}), no change`);
  } else {
    const saved = await service.saveProjectBinding(PROJECT_ID, {
      roles: [...carriedBindings, ...newBindings]
    });
    console.log(`binding: v${saved.version} at projectVersion ${saved.projectVersion}, roles=${saved.roles.map((r) => r.roleId).join(", ")}`);
  }

  // Summary.
  const employees = service.listEmployees(true);
  const system = employees.filter((e) => e.systemRole);
  console.log("\n=== system employees now ===");
  for (const e of system) {
    console.log(`  ${e.id} | ${e.identity.displayName} | systemRole=${e.systemRole} | provider=${e.providerId}`);
  }
}

main().then(() => { console.log("\nDONE"); process.exit(0); }).catch((error) => {
  console.error("\nFAILED:", error?.message ?? error);
  process.exit(1);
});
