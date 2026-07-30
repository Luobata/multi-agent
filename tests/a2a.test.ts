import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonApp } from "../src/daemon/server.js";
import type { ProviderRegistry } from "../src/runtime/providers.js";
import { WorkbenchService } from "../src/workbench/service.js";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("A2A publication mapping", () => {
  it("maps a valid domain Block to a completed Task with a Block artifact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-a2a-"));
    directories.push(root);
    const providers: ProviderRegistry = new Map([["mock", {
      id: "mock",
      validate: () => [],
      invoke: async () => ({
        stdout: JSON.stringify({ message: "Release evidence is incomplete.", verdict: "Block" }),
        stderr: "",
        durationMs: 1
      })
    }]]);
    const service = await WorkbenchService.open({ dataRoot: root, providers });
    await service.createEmployee({
      id: "blocking-reviewer",
      identity: { displayName: "Blocking Reviewer", background: "Reviews release evidence.", responsibilities: ["Return a verdict"] },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message", "verdict"],
        properties: { message: { type: "string" }, verdict: { enum: ["Pass", "Block"] } }
      },
      verdict: { path: "verdict", pass: ["Pass"], block: ["Block"] }
    });
    await service.createPublication({
      id: "blocking-desk",
      name: "Blocking Desk",
      target: { kind: "employee", id: "blocking-reviewer" }
    });
    const server = createDaemonApp(service, { staticDir: path.join(root, "missing") }).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/a2a/blocking-desk`, {
      method: "POST",
      headers: { "content-type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "block-request",
        method: "SendMessage",
        params: { message: { messageId: "block-message", role: "ROLE_USER", parts: [{ text: "Review release" }] } }
      })
    });
    const rpc = await response.json() as {
      result: { task: { status: { state: string }; artifacts: Array<{ name: string; metadata: { domainBlock: boolean } }> } };
    };
    expect(rpc.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(rpc.result.task.artifacts[0]?.name).toBe("Domain block");
    expect(rpc.result.task.artifacts[0]?.metadata.domainBlock).toBe(true);
  });
});
