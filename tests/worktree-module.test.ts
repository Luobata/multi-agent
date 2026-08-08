import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isGitRepo, createRunWorktree, removeRunWorktree } from "../src/runtime/worktree.js";

function gitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "f.txt"), "x");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

describe("worktree lifecycle", () => {
  it("isGitRepo true for a repo, false for a plain dir", async () => {
    expect(await isGitRepo(gitRepo())).toBe(true);
    expect(await isGitRepo(fs.mkdtempSync(path.join(os.tmpdir(), "plain-")))).toBe(false);
  });

  it("creates and removes a run worktree in a git repo", async () => {
    const root = gitRepo();
    const wt = await createRunWorktree(root, "run-abc");
    expect(wt).not.toBeNull();
    expect(fs.existsSync(wt!.path)).toBe(true);
    expect(wt!.path).toContain(path.join(".multi-agent", "worktrees", "run-abc"));
    await removeRunWorktree(root, wt!.path);
    expect(fs.existsSync(wt!.path)).toBe(false);
  });

  it("returns null when target is not a git repo", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "plain2-"));
    expect(await createRunWorktree(plain, "run-x")).toBeNull();
  });

  it("removeRunWorktree does not throw on a bad path", async () => {
    const root = gitRepo();
    await expect(removeRunWorktree(root, path.join(root, "nope"))).resolves.toBeUndefined();
  });
});
