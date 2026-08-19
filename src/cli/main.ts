#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadManifest } from "../config/loadManifest.js";
import { formatDateTime } from "../config/datetime.js";
import { compilePlan, formatPlanMermaid, formatPlanText } from "../core/plan.js";
import { resolveRoleProfile } from "../core/roles.js";
import type { JsonObject, LoadedManifest } from "../core/types.js";
import type {
  KnowledgeBaseCreateInput,
  KnowledgeBaseUpdateInput,
  KnowledgeChangeCreateInput,
  KnowledgeProfileCreateInput,
  KnowledgeProfileUpdateInput,
  KnowledgeRevisionCreateInput
} from "../knowledge/types.js";
import { runWorkflow } from "../runtime/runner.js";
import { inspectDeliveryChain, repairDeliveryChain } from "../runtime/worktreeDelivery.js";
import { startDaemon } from "../daemon/server.js";
import type { MemoryKind } from "../memory/types.js";
import { WorkbenchService } from "../workbench/service.js";
import type {
  EmployeeCreateInput,
  EntrancePolicyCreateInput,
  EntrancePolicyDispatchInput,
  EntrancePolicyEvaluationInput,
  EntrancePolicyUpdateInput,
  ManagementPolicyCreateInput,
  ManagementPolicyUpdateInput,
  PublicationDefinition,
  ProjectBindingInput,
  SkillCreateInput,
  WorkflowChangeCreateInput,
  WorkflowCreateInput
} from "../workbench/types.js";
import { scaffoldWorkflow } from "./scaffold.js";

function resolveWorkflow(loaded: LoadedManifest, requested: string | undefined): string {
  if (requested) return requested;
  const workflows = Object.keys(loaded.manifest.workflows);
  if (workflows.length === 1 && workflows[0]) return workflows[0];
  throw new Error(`choose a workflow: ${workflows.join(", ")}`);
}

function readInput(inputPath: string | undefined): JsonObject {
  if (!inputPath) return {};
  const parsed = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("workflow input must be a JSON object");
  }
  return parsed as JsonObject;
}

function readJsonFile<T>(inputPath: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8")) as T;
}

async function workbenchService(): Promise<WorkbenchService> {
  return WorkbenchService.open({ dataRoot: program.opts<{ dataRoot?: string }>().dataRoot });
}

const program = new Command();
program
  .name("multi-agent")
  .description("Design, validate, visualize, and run declarative multi-agent workflows")
  .version("0.1.0")
  .option("--data-root <path>", "Local Agent Workbench data directory");

program
  .command("init")
  .description("Create a runnable review-council starter in an empty directory")
  .argument("[directory]", "target directory", "multi-agent-workflow")
  .action((directory: string) => {
    const target = scaffoldWorkflow(directory);
    process.stdout.write(`Created workflow starter at ${target}\n`);
    process.stdout.write(`Next: multi-agent validate --config ${path.join(target, "multi-agent.yaml")}\n`);
  });

program
  .command("validate")
  .description("Validate manifest shape, references, schemas, and workflow topology")
  .option("-c, --config <path>", "manifest path", "multi-agent.yaml")
  .option("--json", "print machine-readable output")
  .action((options: { config: string; json?: boolean }) => {
    const loaded = loadManifest(options.config);
    const result = {
      ok: true,
      manifest: loaded.manifestPath,
      providers: Object.keys(loaded.manifest.providers),
      skills: Object.keys(loaded.manifest.skills ?? {}),
      roles: Object.keys(loaded.manifest.roles),
      workflows: Object.keys(loaded.manifest.workflows),
      architectures: [...new Set(Object.values(loaded.manifest.workflows).map((workflow) => workflow.architecture))]
    };
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Valid: ${loaded.manifest.name} (${result.providers.length} providers, ${result.skills.length} skills, ${result.roles.length} roles, ${result.workflows.length} workflows)\n`
    );
  });

const inspect = program.command("inspect").description("Inspect resolved registry entries");

inspect
  .command("role")
  .description("Show a role's composed identity, skills, and effective permissions")
  .argument("<role>", "role id")
  .option("-c, --config <path>", "manifest path", "multi-agent.yaml")
  .action((roleId: string, options: { config: string }) => {
    const loaded = loadManifest(options.config);
    const profile = resolveRoleProfile(loaded, roleId);
    process.stdout.write(
      `${JSON.stringify(
        {
          id: profile.id,
          identity: profile.definition.identity,
          description: profile.description,
          provider: profile.definition.provider,
          skills: profile.skills.map((skill) => ({
            id: skill.id,
            displayName: skill.displayName,
            description: skill.description,
            config: skill.config,
            tools: skill.tools
          })),
          permissions: { write: profile.writePolicy, tools: profile.effectiveTools },
          requestTemplate: profile.definition.requestTemplate,
          outputSchema: profile.definition.outputSchema
        },
        null,
        2
      )}\n`
    );
  });

program
  .command("plan")
  .description("Compile a workflow DAG without invoking providers")
  .argument("[workflow]", "workflow id")
  .option("-c, --config <path>", "manifest path", "multi-agent.yaml")
  .option("-f, --format <format>", "text, json, or mermaid", "text")
  .action((workflow: string | undefined, options: { config: string; format: string }) => {
    const loaded = loadManifest(options.config);
    const plan = compilePlan(loaded, resolveWorkflow(loaded, workflow));
    if (options.format === "json") process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    else if (options.format === "mermaid") process.stdout.write(`${formatPlanMermaid(plan)}\n`);
    else if (options.format === "text") process.stdout.write(`${formatPlanText(plan)}\n`);
    else throw new Error(`unsupported plan format: ${options.format}`);
  });

program
  .command("run")
  .description("Run a workflow and persist complete execution evidence")
  .argument("[workflow]", "workflow id")
  .option("-c, --config <path>", "manifest path", "multi-agent.yaml")
  .option("-i, --input <path>", "JSON input file")
  .option("--dry-run", "compile and print the plan without invoking providers")
  .option("--require-member-handoff", "treat member delegation attempts without a handoff file as incomplete (blocked)")
  .option("--supervisor-history-keep-rounds <n>", "number of recent supervisor rounds kept verbatim in the injected history (older rounds are compacted; default 6)")
  .option("--json", "print machine-readable output")
  .action(async (workflow: string | undefined, options: { config: string; input?: string; dryRun?: boolean; requireMemberHandoff?: boolean; supervisorHistoryKeepRounds?: string; json?: boolean }) => {
    const loaded = loadManifest(options.config);
    const workflowId = resolveWorkflow(loaded, workflow);
    if (options.dryRun) {
      process.stdout.write(`${formatPlanText(compilePlan(loaded, workflowId))}\n`);
      return;
    }
    const keepRounds = options.supervisorHistoryKeepRounds === undefined
      ? undefined
      : Number.parseInt(options.supervisorHistoryKeepRounds, 10);
    if (keepRounds !== undefined && (!Number.isSafeInteger(keepRounds) || keepRounds < 0)) {
      throw new Error("--supervisor-history-keep-rounds must be a non-negative integer");
    }
    const result = await runWorkflow(loaded, workflowId, {
      input: readInput(options.input),
      ...(options.requireMemberHandoff ? { requireMemberHandoff: true } : {}),
      ...(keepRounds !== undefined ? { supervisorHistoryKeepRounds: keepRounds } : {})
    });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`Run ${result.run.id}: ${result.run.status}\nArtifacts: ${result.runDir}\n`);
    if (result.run.status === "failed") process.exitCode = 1;
    if (result.run.status === "blocked") process.exitCode = 2;
  });

program
  .command("status")
  .description("Read a persisted run record")
  .argument("<run-directory>", "path containing run.json")
  .action((runDirectory: string) => {
    const runPath = path.resolve(runDirectory, "run.json");
    process.stdout.write(fs.readFileSync(runPath, "utf8"));
  });

const workbench = program.command("workbench").description("Manage the local Employee registry and workbench daemon");

const bundle = workbench.command("bundle").description("Export, validate, preview, and import portable Workbench bundles");
bundle.command("export")
  .requiredOption("--modes <modes>", "comma-separated employee,project,workflow,publication,run-evidence modes")
  .option("--output <file>", "write bundle JSON to a file")
  .action(async (options: { modes: string; output?: string }) => {
    const result = (await workbenchService()).exportPortableBundle(options.modes.split(",").map(value => value.trim()).filter(Boolean) as never);
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) fs.writeFileSync(path.resolve(options.output), output, { flag: "wx" }); else process.stdout.write(output);
  });
bundle.command("preview")
  .argument("<file>", "bundle JSON")
  .option("--replace", "preview explicit replacement")
  .action(async (file: string, options: { replace?: boolean }) => { process.stdout.write(`${JSON.stringify((await workbenchService()).previewPortableBundle(readJsonFile(file), options.replace ? "replace" : "skip"), null, 2)}\n`); });
bundle.command("import")
  .argument("<file>", "bundle JSON")
  .option("--replace", "replace conflicting records")
  .option("--confirmation <token>", "confirmation token from preview")
  .action(async (file: string, options: { replace?: boolean; confirmation?: string }) => { process.stdout.write(`${JSON.stringify(await (await workbenchService()).applyPortableBundle(readJsonFile(file), options.replace ? "replace" : "skip", options.confirmation), null, 2)}\n`); });

workbench.command("doctor")
  .option("--json", "machine-readable JSON")
  .action(async () => {
    const report = await (await workbenchService()).doctor();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.overall === "blocked") process.exitCode = 2;
  });

const workbenchRun = workbench.command("run").description("Inspect durable Run records");
workbenchRun.command("get").argument("<id>").action(async (id: string) => { process.stdout.write(`${JSON.stringify(await (await workbenchService()).getRunReceipt(id), null, 2)}\n`); });
const employee = workbench.command("employee").description("Create, inspect, invoke, clone, and archive Employees");

employee
  .command("list")
  .option("--all", "include archived Employees")
  .action(async (options: { all?: boolean }) => {
    process.stdout.write(`${JSON.stringify((await workbenchService()).listEmployees(Boolean(options.all)), null, 2)}\n`);
  });

employee
  .command("create")
  .argument("<file>", "Employee JSON definition")
  .action(async (file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).createEmployee(readJsonFile<EmployeeCreateInput>(file)), null, 2)}\n`);
  });

employee
  .command("clone")
  .argument("<source>", "source Employee id")
  .argument("<new-id>", "new Employee id")
  .option("--name <name>", "new display name")
  .action(async (source: string, newId: string, options: { name?: string }) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).cloneEmployee(source, newId, options.name), null, 2)}\n`);
  });

employee
  .command("archive")
  .argument("<id>", "Employee id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).archiveEmployee(id), null, 2)}\n`);
  });

employee
  .command("repin-project")
  .description("Create a new Employee version pinned to its project's current or requested version")
  .argument("<id>", "project-scoped Employee id")
  .option("--project-version <version>", "specific existing project version", (value: string) => Number(value))
  .action(async (id: string, options: { projectVersion?: number }) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).repinEmployeeProject(id, options.projectVersion), null, 2)}\n`);
  });

employee
  .command("invoke")
  .argument("<id>", "Employee id")
  .argument("<message>", "request text")
  .option("--session <id>", "continue a version-pinned Session")
  .action(async (id: string, message: string, options: { session?: string }) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).invokeEmployee(id, {
      message,
      sessionId: options.session
    }), null, 2)}\n`);
  });

employee
  .command("context")
  .argument("<id>", "Employee id")
  .option("--session <id>", "version-pinned Session id")
  .action(async (id: string, options: { session?: string }) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).getEmployeeContext(id, options.session), null, 2)}\n`);
  });

employee
  .command("knowledge")
  .description("Replace an Employee's reusable Knowledge Profile assignments")
  .argument("<id>", "Employee id")
  .argument("[profiles...]", "Knowledge Profile ids")
  .action(async (id: string, profiles: string[]) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).updateEmployee(id, { knowledgeProfileIds: profiles }), null, 2)}\n`);
  });

const memory = workbench.command("memory").description("检索、归档与重建本地 memory");

memory
  .command("search <query>")
  .option("--employee <id>", "限定 employee scope")
  .option("--project <id>", "限定 project scope")
  .option("--limit <n>", "返回条数上限", (v: string) => Number.parseInt(v, 10))
  .option("--kind <kind>", "run-summary | node-detail | preference")
  .action(async (query: string, options: { employee?: string; project?: string; limit?: number; kind?: MemoryKind }) => {
    const hits = await (await workbenchService()).searchMemory({
      query,
      scope: { employeeId: options.employee, projectId: options.project },
      limit: options.limit,
      kind: options.kind
    });
    const display = hits.map((h) => ({ ...h, displayCreatedAt: formatDateTime(h.createdAt) }));
    process.stdout.write(`${JSON.stringify(display, null, 2)}\n`);
  });

memory
  .command("archive <id>")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).archiveMemory(id), null, 2)}\n`);
  });

memory
  .command("reindex")
  .action(async () => {
    const count = await (await workbenchService()).reindexMemory();
    process.stdout.write(`${JSON.stringify({ reindexed: count }, null, 2)}\n`);
  });

workbench
  .command("skill-create")
  .argument("<file>", "Skill JSON definition")
  .action(async (file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).createSkill(readJsonFile<SkillCreateInput>(file)), null, 2)}\n`);
  });

const knowledgeBase = workbench.command("knowledge-base").description("Manage versioned Knowledge Bases and local indexes");
knowledgeBase
  .command("list")
  .option("--all", "include archived Knowledge Bases")
  .action(async (options: { all?: boolean }) => {
    process.stdout.write(`${JSON.stringify((await workbenchService()).listKnowledgeBases(Boolean(options.all)), null, 2)}\n`);
  });
knowledgeBase
  .command("create")
  .argument("<file>", "Knowledge Base JSON definition")
  .action(async (file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).createKnowledgeBase(readJsonFile<KnowledgeBaseCreateInput>(file)), null, 2)}\n`);
  });
knowledgeBase
  .command("get")
  .argument("<id>", "Knowledge Base id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).getKnowledgeBaseDetail(id), null, 2)}\n`);
  });
knowledgeBase
  .command("update")
  .argument("<id>", "Knowledge Base id")
  .argument("<file>", "Knowledge Base update JSON")
  .action(async (id: string, file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).updateKnowledgeBase(id, readJsonFile<KnowledgeBaseUpdateInput>(file)), null, 2)}\n`);
  });
knowledgeBase
  .command("revision")
  .argument("<id>", "Knowledge Base id")
  .argument("<file>", "Knowledge Revision JSON definition")
  .action(async (id: string, file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).createKnowledgeRevision(id, readJsonFile<KnowledgeRevisionCreateInput>(file)), null, 2)}\n`);
  });
knowledgeBase
  .command("assess")
  .argument("<id>", "Knowledge Base id")
  .option("--revision <revision>", "Revision to assess; defaults to latest")
  .action(async (id: string, options: { revision?: string }) => {
    const revision = options.revision === undefined ? undefined : Number(options.revision);
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).assessKnowledgeRevision(id, revision), null, 2)}\n`);
  });
knowledgeBase
  .command("preview")
  .argument("<id>", "Knowledge Base id")
  .argument("<query>", "Representative retrieval question")
  .option("--revision <revision>", "Revision to preview; defaults to latest")
  .option("--collections <collections>", "Comma-separated Collection ids")
  .action(async (id: string, query: string, options: { revision?: string; collections?: string }) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).previewKnowledgeRevision(id, {
      message: query,
      revision: options.revision === undefined ? undefined : Number(options.revision),
      collectionIds: options.collections?.split(",").map((value) => value.trim()).filter(Boolean)
    }), null, 2)}\n`);
  });
knowledgeBase
  .command("sync")
  .argument("<id>", "Knowledge Base id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).syncKnowledgeBase(id), null, 2)}\n`);
  });
knowledgeBase
  .command("publish")
  .argument("<id>", "Knowledge Base id")
  .option("--revision <revision>", "Revision to publish or roll back to")
  .action(async (id: string, options: { revision?: string }) => {
    const revision = options.revision === undefined ? undefined : Number(options.revision);
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).publishKnowledgeRevision(id, revision), null, 2)}\n`);
  });
knowledgeBase
  .command("archive")
  .argument("<id>", "Knowledge Base id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).archiveKnowledgeBase(id), null, 2)}\n`);
  });
knowledgeBase
  .command("restore")
  .argument("<id>", "Knowledge Base id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).restoreKnowledgeBase(id), null, 2)}\n`);
  });

const knowledgeProfile = workbench.command("knowledge-profile").description("Manage reusable Employee knowledge policies");
knowledgeProfile
  .command("list")
  .option("--all", "include archived Knowledge Profiles")
  .action(async (options: { all?: boolean }) => {
    process.stdout.write(`${JSON.stringify((await workbenchService()).listKnowledgeProfiles(Boolean(options.all)), null, 2)}\n`);
  });
knowledgeProfile
  .command("create")
  .argument("<file>", "Knowledge Profile JSON definition")
  .action(async (file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).createKnowledgeProfile(readJsonFile<KnowledgeProfileCreateInput>(file)), null, 2)}\n`);
  });
knowledgeProfile
  .command("get")
  .argument("<id>", "Knowledge Profile id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify((await workbenchService()).getKnowledgeProfile(id), null, 2)}\n`);
  });
knowledgeProfile
  .command("update")
  .argument("<id>", "Knowledge Profile id")
  .argument("<file>", "Knowledge Profile update JSON")
  .action(async (id: string, file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).updateKnowledgeProfile(id, readJsonFile<KnowledgeProfileUpdateInput>(file)), null, 2)}\n`);
  });
knowledgeProfile
  .command("archive")
  .argument("<id>", "Knowledge Profile id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).archiveKnowledgeProfile(id), null, 2)}\n`);
  });
knowledgeProfile
  .command("restore")
  .argument("<id>", "Knowledge Profile id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).restoreKnowledgeProfile(id), null, 2)}\n`);
  });

workbench
  .command("knowledge-impact")
  .description("Explain Knowledge Base → Profile → Employee and project-role reach")
  .action(async () => {
    process.stdout.write(`${JSON.stringify((await workbenchService()).getKnowledgeImpactSnapshot(), null, 2)}\n`);
  });

const knowledgeChange = workbench.command("knowledge-change").description("Review and apply governed knowledge change requests");
knowledgeChange
  .command("list")
  .action(async () => {
    process.stdout.write(`${JSON.stringify((await workbenchService()).listKnowledgeChangeRequests(), null, 2)}\n`);
  });
knowledgeChange
  .command("get")
  .argument("<id>", "Knowledge change request id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify((await workbenchService()).getKnowledgeChangeRequest(id), null, 2)}\n`);
  });
knowledgeChange
  .command("propose")
  .argument("<file>", "KnowledgeChangeCreateInput JSON")
  .action(async (file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).createKnowledgeChangeRequest(readJsonFile<KnowledgeChangeCreateInput>(file)), null, 2)}\n`);
  });
knowledgeChange
  .command("approve")
  .argument("<id>", "Knowledge change request id")
  .option("--comment <comment>", "Human approval comment")
  .action(async (id: string, options: { comment?: string }) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).approveKnowledgeChangeRequest(id, "local-cli-owner", options.comment), null, 2)}\n`);
  });
knowledgeChange
  .command("reject")
  .argument("<id>", "Knowledge change request id")
  .option("--comment <comment>", "Human rejection reason")
  .action(async (id: string, options: { comment?: string }) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).rejectKnowledgeChangeRequest(id, "local-cli-owner", options.comment), null, 2)}\n`);
  });
knowledgeChange
  .command("cancel")
  .argument("<id>", "Knowledge change request id")
  .option("--comment <comment>", "Human cancellation reason")
  .action(async (id: string, options: { comment?: string }) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).cancelKnowledgeChangeRequest(id, "local-cli-owner", options.comment), null, 2)}\n`);
  });

const workflowChange = workbench.command("workflow-change").description("Review and apply governed workflow change requests");
workflowChange
  .command("list")
  .action(async () => {
    process.stdout.write(`${JSON.stringify((await workbenchService()).listWorkflowChangeRequests(), null, 2)}\n`);
  });
workflowChange
  .command("get")
  .argument("<id>", "Workflow change request id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify((await workbenchService()).getWorkflowChangeRequest(id), null, 2)}\n`);
  });
workflowChange
  .command("propose")
  .argument("<file>", "WorkflowChangeCreateInput JSON")
  .action(async (file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).createWorkflowChangeRequest(readJsonFile<WorkflowChangeCreateInput>(file)), null, 2)}\n`);
  });
workflowChange
  .command("approve")
  .argument("<id>", "Workflow change request id")
  .option("--comment <comment>", "Human approval comment")
  .action(async (id: string, options: { comment?: string }) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).approveWorkflowChangeRequest(id, "local-cli-owner", options.comment), null, 2)}\n`);
  });
workflowChange
  .command("reject")
  .argument("<id>", "Workflow change request id")
  .option("--comment <comment>", "Human rejection reason")
  .action(async (id: string, options: { comment?: string }) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).rejectWorkflowChangeRequest(id, "local-cli-owner", options.comment), null, 2)}\n`);
  });

const workbenchProject = workbench.command("project").description("Connect projects and assign Employees to project role slots");
workbenchProject
  .command("list")
  .option("--all", "include archived projects")
  .action(async (options: { all?: boolean }) => {
    const service = await workbenchService();
    process.stdout.write(`${JSON.stringify({ projects: service.listProjects(Boolean(options.all)), bindings: service.listProjectBindings() }, null, 2)}\n`);
  });
workbenchProject
  .command("connect")
  .argument("[directory]", "project root directory", ".")
  .option("--descriptor <path>", "descriptor path; relative paths resolve from the project root", "multi-agent.project.yaml")
  .action(async (directory: string, options: { descriptor: string }) => {
    const project = await (await workbenchService()).connectProject({ rootPath: directory, descriptorPath: options.descriptor });
    process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
  });
workbenchProject
  .command("bind")
  .argument("<id>", "project id")
  .argument("<file>", "ProjectBinding JSON definition")
  .action(async (id: string, file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).saveProjectBinding(id, readJsonFile<ProjectBindingInput>(file)), null, 2)}\n`);
  });
workbenchProject
  .command("invoke")
  .argument("<id>", "project id")
  .argument("<role>", "project role id")
  .argument("<message>", "request text")
  .option("--session <id>", "continue a version-pinned project Session")
  .action(async (id: string, role: string, message: string, options: { session?: string }) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).invokeProjectRole(id, role, {
      message,
      sessionId: options.session
    }), null, 2)}\n`);
  });

const managementPolicy = workbench.command("management-policy").description("Manage versioned Supervisor policies");
managementPolicy
  .command("list")
  .option("--all", "include archived Management Policies")
  .action(async (options: { all?: boolean }) => {
    process.stdout.write(`${JSON.stringify((await workbenchService()).listManagementPolicies(Boolean(options.all)), null, 2)}\n`);
  });
managementPolicy
  .command("create")
  .argument("<file>", "Management Policy JSON definition")
  .action(async (file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).createManagementPolicy(readJsonFile<ManagementPolicyCreateInput>(file)), null, 2)}\n`);
  });
managementPolicy
  .command("get")
  .argument("<id>", "Management Policy id")
  .action(async (id: string) => {
    const service = await workbenchService();
    process.stdout.write(`${JSON.stringify({ policy: service.getManagementPolicy(id), versions: service.getManagementPolicyVersions(id) }, null, 2)}\n`);
  });
managementPolicy
  .command("update")
  .argument("<id>", "Management Policy id")
  .argument("<file>", "Management Policy update JSON")
  .action(async (id: string, file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).updateManagementPolicy(id, readJsonFile<ManagementPolicyUpdateInput>(file)), null, 2)}\n`);
  });
managementPolicy
  .command("archive")
  .argument("<id>", "Management Policy id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).archiveManagementPolicy(id), null, 2)}\n`);
  });
managementPolicy
  .command("restore")
  .argument("<id>", "Management Policy id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).restoreManagementPolicy(id), null, 2)}\n`);
  });

const entrancePolicy = workbench.command("entrance-policy").description("Manage and execute versioned task entrance policies");
entrancePolicy
  .command("list")
  .option("--all", "include archived Entrance Policies")
  .action(async (options: { all?: boolean }) => {
    process.stdout.write(`${JSON.stringify((await workbenchService()).listEntrancePolicies(Boolean(options.all)), null, 2)}\n`);
  });
entrancePolicy
  .command("create")
  .argument("<file>", "Entrance Policy JSON definition")
  .action(async (file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).createEntrancePolicy(readJsonFile<EntrancePolicyCreateInput>(file)), null, 2)}\n`);
  });
entrancePolicy
  .command("get")
  .argument("<id>", "Entrance Policy id")
  .action(async (id: string) => {
    const service = await workbenchService();
    process.stdout.write(`${JSON.stringify({ policy: service.getEntrancePolicy(id), versions: service.getEntrancePolicyVersions(id) }, null, 2)}\n`);
  });
entrancePolicy
  .command("update")
  .argument("<id>", "Entrance Policy id")
  .argument("<file>", "Entrance Policy update JSON")
  .action(async (id: string, file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).updateEntrancePolicy(id, readJsonFile<EntrancePolicyUpdateInput>(file)), null, 2)}\n`);
  });
entrancePolicy
  .command("archive")
  .argument("<id>", "Entrance Policy id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).archiveEntrancePolicy(id), null, 2)}\n`);
  });
entrancePolicy
  .command("restore")
  .argument("<id>", "Entrance Policy id")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).restoreEntrancePolicy(id), null, 2)}\n`);
  });
entrancePolicy
  .command("evaluate")
  .argument("<id>", "Entrance Policy id")
  .argument("<file>", "structured Entrance Policy evaluation JSON")
  .action(async (id: string, file: string) => {
    process.stdout.write(`${JSON.stringify((await workbenchService()).evaluateEntrancePolicy(id, readJsonFile<EntrancePolicyEvaluationInput>(file)), null, 2)}\n`);
  });
entrancePolicy
  .command("dispatch")
  .argument("<id>", "Entrance Policy id")
  .argument("<file>", "structured Entrance Policy dispatch JSON")
  .action(async (id: string, file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).dispatchEntrancePolicy(id, readJsonFile<EntrancePolicyDispatchInput>(file)), null, 2)}\n`);
  });

const workbenchWorkflow = workbench.command("workflow").description("Create and run Graph or Supervisor workflows");
workbenchWorkflow
  .command("create")
  .argument("<file>", "Workflow JSON definition")
  .action(async (file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).createWorkflow(readJsonFile<WorkflowCreateInput>(file)), null, 2)}\n`);
  });
workbenchWorkflow
  .command("run")
  .argument("<id>", "Workflow id")
  .option("-i, --input <file>", "JSON input file")
  .action(async (id: string, options: { input?: string }) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).runWorkbenchWorkflow(id, readInput(options.input)), null, 2)}\n`);
  });

workbench
  .command("hub-reconcile")
  .description("Diff a Run's delivery revision chain (dry-run by default) and optionally repair it")
  .argument("<run-id>", "Run id whose delivery chain should be reconciled")
  .option("--apply", "apply repairable fixes through the CAS/event-chain mechanisms (default: dry-run diff report only)")
  .option("--merge-commit <sha>", "optional expected merge commit to verify against a persisted merge intent")
  .action(async (runId: string, options: { apply?: boolean; mergeCommit?: string }) => {
    const dataRoot = program.opts<{ dataRoot?: string }>().dataRoot ?? WorkbenchService.defaultDataRoot();
    const runDir = path.join(dataRoot, "artifacts", "runs", runId);
    const report = options.apply
      ? await repairDeliveryChain(runDir, runId, { expectedMergeCommit: options.mergeCommit })
      : await inspectDeliveryChain(runDir, runId, { expectedMergeCommit: options.mergeCommit });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status === "corrupt" || (options.apply && report.status !== "aligned" && report.status !== "absent")) {
      process.exitCode = 1;
    }
  });

workbench
  .command("publish")
  .argument("<file>", "Publication JSON definition")
  .action(async (file: string) => {
    const definition = readJsonFile<{
      id: string;
      name: string;
      description?: string;
      target: PublicationDefinition["target"];
    }>(file);
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).createPublication(definition), null, 2)}\n`);
  });

workbench
  .command("serve")
  .option("--host <host>", "loopback listen host", "127.0.0.1")
  .option("--port <port>", "listen port", "4318")
  .option("--static-dir <path>", "built client directory")
  .action(async (options: { host: string; port: string; staticDir?: string }) => {
    if (!["127.0.0.1", "::1", "localhost"].includes(options.host)) {
      throw new Error("v1 daemon is loopback-only");
    }
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");
    const service = await workbenchService();
    await startDaemon(service, { host: options.host, port, staticDir: options.staticDir });
    const urlHost = options.host.includes(":") && !options.host.startsWith("[") ? `[${options.host}]` : options.host;
    process.stdout.write(`Local Agent Workbench: http://${urlHost}:${port}\n`);
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
