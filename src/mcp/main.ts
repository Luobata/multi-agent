#!/usr/bin/env node
import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWorkbenchMcpServer } from "./server.js";

const program = new Command();
program
  .name("multi-agent-mcp")
  .description("Expose the Local Agent Workbench as MCP tools over stdio")
  .option("--daemon-url <url>", "running workbench daemon URL", "http://127.0.0.1:4318")
  .action(async (options: { daemonUrl: string }) => {
    const server = createWorkbenchMcpServer(options.daemonUrl);
    await server.connect(new StdioServerTransport());
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
