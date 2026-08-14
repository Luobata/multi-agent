import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateWorkspaceSnapshot } from "../src/runtime/candidateRevision.js";

const roots: string[] = [];

function repository(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "candidate-revision-")));
  roots.push(root);
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "candidate@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Candidate Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "tracked.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-m", "seed"], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("candidateWorkspaceSnapshot", () => {
  it("changes for tracked and untracked candidate content and reports exact changed paths", async () => {
    const root = repository();
    const clean = await candidateWorkspaceSnapshot(root);
    fs.writeFileSync(path.join(root, "tracked.txt"), "two\n");
    fs.writeFileSync(path.join(root, "new.txt"), "candidate\n");
    const changed = await candidateWorkspaceSnapshot(root);
    expect(changed.revision).not.toBe(clean.revision);
    expect(changed.changedFiles).toEqual(["new.txt", "tracked.txt"]);
    expect(changed.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
