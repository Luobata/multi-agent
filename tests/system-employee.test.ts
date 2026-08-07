import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkbenchService, isSystemEmployee, systemRoleOf } from "../src/workbench/service.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "sysemp-")); }

describe("systemRole field + helpers", () => {
  it("helpers classify employees", () => {
    expect(isSystemEmployee({})).toBe(false);
    expect(isSystemEmployee({ systemRole: "automatic" })).toBe(true);
    expect(systemRoleOf({ systemRole: "conversational" })).toBe("conversational");
    expect(systemRoleOf({})).toBeUndefined();
  });

  it("createEmployee persists systemRole", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    const e = await svc.createEmployee({
      id: "sys-auto",
      identity: { displayName: "Auto", background: "bg", responsibilities: ["r"] },
      systemRole: "automatic"
    });
    expect(e.systemRole).toBe("automatic");
  });

  it("createEmployee rejects an invalid systemRole", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await expect(svc.createEmployee({
      id: "bad", identity: { displayName: "X", background: "b", responsibilities: ["r"] },
      systemRole: "nope" as never
    })).rejects.toThrow(/systemRole/);
  });

  it("business employees have no systemRole", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    const e = await svc.createEmployee({ id: "biz", identity: { displayName: "Biz", background: "b", responsibilities: ["r"] } });
    expect(e.systemRole).toBeUndefined();
  });
});
