import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchService } from "../src/workbench/service.js";

const roots: string[] = [];
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-operations-")); roots.push(value); return value; }
afterEach(() => roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true })));

describe("Workbench operational controls", () => {
  it("roundtrips portable records, defaults conflicts to skip, and requires confirmation for sensitive replacement", async () => {
    const source = await WorkbenchService.open({ dataRoot: root() });
    await source.createEmployee({ id: "portable", identity: { displayName: "Portable", background: "test", responsibilities: ["test"] }, providerId: "mock" });
    const bundle = source.exportPortableBundle(["employee"]);
    expect(JSON.stringify(bundle)).not.toMatch(/secret|token/i);

    const target = await WorkbenchService.open({ dataRoot: root() });
    const creation = target.previewPortableBundle(bundle);
    expect(creation).toMatchObject({ valid: true, diff: [{ action: "create", id: "portable" }] });
    await target.applyPortableBundle(bundle, "skip", creation.confirmationToken);
    expect(target.getEmployee("portable").version).toBe(1);
    expect(target.previewPortableBundle(bundle).diff[0]?.action).toBe("skip");
    const replacement = target.previewPortableBundle(bundle, "replace");
    await expect(target.applyPortableBundle(bundle, "replace")).rejects.toThrow("confirmation token required");
    await expect(target.applyPortableBundle(bundle, "replace", replacement.confirmationToken)).resolves.toMatchObject({ replaced: 1 });
  });

  it("reports invalid fields without writing and diagnoses a ready data directory", async () => {
    const service = await WorkbenchService.open({ dataRoot: root() });
    const before = JSON.stringify(service.snapshot());
    expect(service.previewPortableBundle({ schemaVersion: 2, records: [] })).toMatchObject({ valid: false, errors: expect.arrayContaining([expect.objectContaining({ path: "/schemaVersion" })]) });
    expect(JSON.stringify(service.snapshot())).toBe(before);
    const doctor = await service.doctor();
    expect(doctor.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "node" }), expect.objectContaining({ id: "data-dir", status: "ready" })]));
  });

  it("protects active invocations, redacts backups, validates traversal, and gates reset on a receipt", async () => {
    const dataRoot = root(); const outputRoot = root();
    const service = await WorkbenchService.open({ dataRoot });
    const preview = await service.previewRetention({ olderThanDays: 0 });
    expect(preview.protected).toBeGreaterThanOrEqual(0);
    await expect(service.backup(path.join(outputRoot, "..", "escape.json"), outputRoot)).rejects.toThrow("path traversal");
    expect(() => service.backupForBrowser("../escape.json")).toThrow("safe .json basename");
    const receipt = await service.backup(path.join(outputRoot, "backup.json"), outputRoot);
    expect(receipt.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(receipt.path, "utf8")).not.toMatch(/"(?:secret|token|password)"/i);
    await expect(service.reset({ scopes: ["config"], backupDigest: "", backupPath: receipt.path, allowedRoot: outputRoot, confirmation: "RESET-CONFIG" })).rejects.toThrow("backup receipt");
    await expect(service.reset({ scopes: ["config"], backupDigest: receipt.digest, backupPath: receipt.path, allowedRoot: outputRoot, confirmation: "RESET-CONFIG" })).resolves.toMatchObject({ runEvidencePreserved: true });
  });

  it("uses a fixed browser backup root and refuses overwrite", async () => {
    const service = await WorkbenchService.open({ dataRoot: root() });
    const receipt = await service.backupForBrowser("safe-backup.json");
    expect(receipt.path).toBe(path.join(service.backupRoot(), "safe-backup.json"));
    await expect(service.backupForBrowser("safe-backup.json")).rejects.toMatchObject({ code: "EEXIST" });
  });
});
