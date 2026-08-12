import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { startRecoveredDaemon } from "../src/daemon/startup.js";
import type { WorkbenchService } from "../src/workbench/service.js";

describe("daemon startup recovery ordering", () => {
  it("does not open the listener until interrupted activity is reconciled", async () => {
    const order: string[] = [];
    let finishRecovery = () => {};
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const service = {
      recoverInterruptedActivity: async () => {
        order.push("recovery-started");
        await recovery;
        order.push("recovery-finished");
      }
    } as WorkbenchService;
    const started = startRecoveredDaemon(service, { port: 4318 }, async () => {
      order.push("listener-opened");
      return {} as Server;
    });

    await Promise.resolve();
    expect(order).toEqual(["recovery-started"]);
    finishRecovery();
    await started;
    expect(order).toEqual(["recovery-started", "recovery-finished", "listener-opened"]);
  });
});
