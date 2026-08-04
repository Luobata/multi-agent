#!/usr/bin/env node
import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWorkbenchMcpServer, type WorkbenchMcpProfile } from "./server.js";

const program = new Command();
program
  .name("multi-agent-mcp")
  .description("Expose the Local Agent Workbench as MCP tools over stdio")
  .option("--daemon-url <url>", "running workbench daemon URL", "http://127.0.0.1:4318")
  .option("--profile <profile>", "tool profile: full, knowledge-control, or configuration-control", "full")
  .option("--source-run-id <runId>", "trusted Workbench Run context for a restricted control profile")
  .action(async (options: { daemonUrl: string; profile: string; sourceRunId?: string }) => {
    if (options.profile !== "full" && options.profile !== "knowledge-control" && options.profile !== "configuration-control") {
      throw new Error("profile must be full, knowledge-control, or configuration-control");
    }
    const server = createWorkbenchMcpServer(options.daemonUrl, {
      profile: options.profile as WorkbenchMcpProfile,
      sourceRunId: options.sourceRunId
    });
    await server.connect(new StdioServerTransport());
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
