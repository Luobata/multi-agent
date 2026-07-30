#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadManifest } from "../config/loadManifest.js";
import { compilePlan, formatPlanMermaid, formatPlanText } from "../core/plan.js";
import { resolveRoleProfile } from "../core/roles.js";
import type { JsonObject, LoadedManifest } from "../core/types.js";
import { runWorkflow } from "../runtime/runner.js";
import { startDaemon } from "../daemon/server.js";
import { WorkbenchService } from "../workbench/service.js";
import type {
  EmployeeCreateInput,
  PublicationDefinition,
  SkillCreateInput,
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
  .option("--json", "print machine-readable output")
  .action(async (workflow: string | undefined, options: { config: string; input?: string; dryRun?: boolean; json?: boolean }) => {
    const loaded = loadManifest(options.config);
    const workflowId = resolveWorkflow(loaded, workflow);
    if (options.dryRun) {
      process.stdout.write(`${formatPlanText(compilePlan(loaded, workflowId))}\n`);
      return;
    }
    const result = await runWorkflow(loaded, workflowId, { input: readInput(options.input) });
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

workbench
  .command("skill-create")
  .argument("<file>", "Skill JSON definition")
  .action(async (file: string) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).createSkill(readJsonFile<SkillCreateInput>(file)), null, 2)}\n`);
  });

const workbenchWorkflow = workbench.command("workflow").description("Create and run Employee Graph workflows");
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
