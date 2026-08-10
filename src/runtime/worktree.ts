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
): Promise<{ path: string; baseCommit: string } | null> {
  if (!(await isGitRepo(repoRoot))) return null;
  const parentDir = path.join(repoRoot, ".multi-agent", "worktrees");
  await fs.mkdir(parentDir, { recursive: true });
  const relativePath = path.join(".multi-agent", "worktrees", runId);
  const absolutePath = path.join(repoRoot, relativePath);
  let added = false;
  try {
    await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "--detach", relativePath]);
    added = true;
    const { stdout } = await execFileAsync("git", ["-C", absolutePath, "rev-parse", "HEAD"], { encoding: "utf8" });
    return { path: absolutePath, baseCommit: stdout.trim() };
  } catch (error) {
    if (added) {
      try {
        await execFileAsync("git", ["-C", repoRoot, "worktree", "remove", "--force", absolutePath]);
        await execFileAsync("git", ["-C", repoRoot, "worktree", "prune"]);
      } catch {
        // Preserve the original setup error. The caller fails closed and can surface the managed
        // path for manual recovery if Git itself cannot remove the partial worktree.
      }
    }
    throw error;
  }
}

/**
 * Returns whether a run worktree contains tracked or untracked changes.
 * Callers intentionally treat inspection failures as "unknown/preserve" rather than clean.
 */
export async function worktreeHasChanges(worktreePath: string, baseCommit?: string): Promise<boolean> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" }
  );
  if (stdout.length > 0) return true;
  if (!baseCommit) return false;
  const { stdout: committedChanges } = await execFileAsync(
    "git",
    ["-C", worktreePath, "diff", "--name-only", baseCommit, "HEAD", "--"],
    { encoding: "utf8" }
  );
  return committedChanges.length > 0;
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
