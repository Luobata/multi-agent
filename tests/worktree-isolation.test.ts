import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/workbench/service.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "wt-iso-")); }

describe("management policy execution.isolation", () => {
  it("persists execution.isolation on a policy", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    const policy = await svc.createManagementPolicy({
      id: "iso-policy", displayName: "Iso", description: "d",
      allowedRoleIds: ["researcher"], instructions: "i",
      limits: { maxRounds: 2, maxDelegations: 2, maxParallelDelegations: 1, maxDurationMs: 60000 },
      execution: { isolation: "worktree" }
    } as never);
    expect(policy.execution?.isolation).toBe("worktree");
  });

  it("defaults to no execution isolation", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    const policy = await svc.createManagementPolicy({
      id: "plain", displayName: "Plain", description: "d",
      allowedRoleIds: ["researcher"], instructions: "i",
      limits: { maxRounds: 2, maxDelegations: 2, maxParallelDelegations: 1, maxDurationMs: 60000 }
    } as never);
    expect(policy.execution?.isolation).toBeUndefined();
  });
});
