#!/usr/bin/env node
import { Command } from "commander";
import { WorkbenchService } from "../workbench/service.js";
import { startRecoveredDaemon } from "./startup.js";

const program = new Command();
program
  .name("multi-agent-daemon")
  .description("Run the loopback Local Agent Workbench daemon")
  .option("--host <host>", "listen host", "127.0.0.1")
  .option("--port <port>", "listen port", "4318")
  .option("--data-root <path>", "workbench data directory")
  .option("--static-dir <path>", "built client directory")
  .action(async (options: { host: string; port: string; dataRoot?: string; staticDir?: string }) => {
    if (options.host !== "127.0.0.1" && options.host !== "::1" && options.host !== "localhost") {
      throw new Error("v1 daemon is loopback-only; use 127.0.0.1, ::1, or localhost");
    }
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");
    const service = await WorkbenchService.open({ dataRoot: options.dataRoot });
    await startRecoveredDaemon(service, { host: options.host, port, staticDir: options.staticDir });
    const urlHost = options.host.includes(":") && !options.host.startsWith("[") ? `[${options.host}]` : options.host;
    process.stdout.write(`Local Agent Workbench: http://${urlHost}:${port}\n`);
    process.stdout.write(`Data root: ${service.store.dataRoot}\n`);
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
