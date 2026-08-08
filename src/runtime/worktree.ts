import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Returns true when `root` is inside a git working tree.
 */
export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a detached git worktree for a run under `.multi-agent/worktrees/<runId>`.
 * Returns the absolute worktree path, or null when `repoRoot` is not a git repo.
 * `runId` is used only as a single path segment (safe format: run-<ts>-<uuid>).
 */
export async function createRunWorktree(
  repoRoot: string,
  runId: string
): Promise<{ path: string } | null> {
  if (!(await isGitRepo(repoRoot))) return null;
  const parentDir = path.join(repoRoot, ".multi-agent", "worktrees");
  await fs.mkdir(parentDir, { recursive: true });
  const relativePath = path.join(".multi-agent", "worktrees", runId);
  const absolutePath = path.join(repoRoot, relativePath);
  await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "--detach", relativePath]);
  return { path: absolutePath };
}

/**
 * Removes a run worktree and prunes stale worktree metadata.
 * Never throws: failures are logged via console.warn.
 */
export async function removeRunWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreePath]);
    await execFileAsync("git", ["-C", repoRoot, "worktree", "prune"]);
  } catch (error) {
    console.warn(`removeRunWorktree failed for ${worktreePath}: ${String(error)}`);
  }
}
