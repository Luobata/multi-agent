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

describe("block binding/publishing system employees", () => {
  it("rejects publishing a system employee directly", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({
      id: "sys-c",
      identity: { displayName: "Conv", background: "b", responsibilities: ["r"] },
      systemRole: "conversational"
    });
    await expect(svc.createPublication({
      id: "pub-sys-c",
      name: "System Publish",
      target: { kind: "employee", id: "sys-c" }
    })).rejects.toThrow(/系统员工/);
  });

  it("rejects publishing a workflow that contains a system employee member", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({
      id: "sys-auto-wf",
      identity: { displayName: "Auto", background: "b", responsibilities: ["r"] },
      systemRole: "automatic"
    });
    await svc.createWorkflow({
      id: "wf-with-system",
      nodes: [{ id: "respond", employeeId: "sys-auto-wf" }]
    });
    await expect(svc.createPublication({
      id: "pub-wf-system",
      name: "Workflow Publish",
      target: { kind: "workflow", id: "wf-with-system" }
    })).rejects.toThrow(/系统员工/);
  });

  it("still publishes a business employee", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({
      id: "biz-pub",
      identity: { displayName: "Biz", background: "b", responsibilities: ["r"] }
    });
    const pub = await svc.createPublication({
      id: "pub-biz",
      name: "Biz Publish",
      target: { kind: "employee", id: "biz-pub" }
    });
    expect(pub.status).toBe("active");
  });

  it("rejects binding a system employee to a project role", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({
      id: "sys-bind",
      identity: { displayName: "Auto", background: "b", responsibilities: ["r"] },
      systemRole: "automatic"
    });
    await svc.createProject({
      id: "proj-sys",
      name: "Project Sys",
      description: "System employee binding guard.",
      rootPath: tmp(),
      descriptorPath: path.join(tmp(), "multi-agent.project.yaml"),
      connector: { kind: "generic", config: {} },
      roles: [{
        id: "role-a",
        displayName: "Role A",
        description: "Any role.",
        permissions: { write: "none" }
      }]
    });
    await expect(svc.saveProjectBinding("proj-sys", {
      roles: [{ roleId: "role-a", employeeId: "sys-bind" }]
    })).rejects.toThrow(/系统员工/);
  });

  it("still binds a business employee to a project role", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({
      id: "biz-bind",
      identity: { displayName: "Biz", background: "b", responsibilities: ["r"] }
    });
    await svc.createProject({
      id: "proj-biz",
      name: "Project Biz",
      description: "Business employee binding.",
      rootPath: tmp(),
      descriptorPath: path.join(tmp(), "multi-agent.project.yaml"),
      connector: { kind: "generic", config: {} },
      roles: [{
        id: "role-b",
        displayName: "Role B",
        description: "Any role.",
        permissions: { write: "none" }
      }]
    });
    const binding = await svc.saveProjectBinding("proj-biz", {
      roles: [{ roleId: "role-b", employeeId: "biz-bind" }]
    });
    expect(binding.roles[0]?.employeeId).toBe("biz-bind");
  });
});

describe("soft-protect system employees from edit/archive", () => {
  it("soft-protects system employees from edit/archive unless confirmed", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({ id: "sys-a", identity: { displayName: "A", background: "b", responsibilities: ["r"] }, systemRole: "automatic" });
    await expect(svc.updateEmployee("sys-a", { description: "x" })).rejects.toThrow(/系统员工|confirm/);
    const updated = await svc.updateEmployee("sys-a", { description: "x" }, { allowSystemEmployeeMutation: true });
    expect(updated.description).toBe("x");
    await expect(svc.archiveEmployee("sys-a")).rejects.toThrow(/系统员工|confirm/);
    const archived = await svc.archiveEmployee("sys-a", { allowSystemEmployeeMutation: true });
    expect(archived.status).toBe("archived");
  });

  it("does not affect business employees", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({ id: "biz2", identity: { displayName: "B", background: "b", responsibilities: ["r"] } });
    const u = await svc.updateEmployee("biz2", { description: "y" });
    expect(u.description).toBe("y");
  });
});
