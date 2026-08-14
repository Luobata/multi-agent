import { execFile, spawn } from "node:child_process";
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
  runId: string,
  startPoint?: string
): Promise<{ path: string; baseCommit: string } | null> {
  if (!(await isGitRepo(repoRoot))) return null;
  const parentDir = path.join(repoRoot, ".multi-agent", "worktrees");
  await fs.mkdir(parentDir, { recursive: true });
  const relativePath = path.join(".multi-agent", "worktrees", runId);
  const absolutePath = path.join(repoRoot, relativePath);
  let added = false;
  try {
    await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "--detach", relativePath, ...(startPoint ? [startPoint] : [])]);
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

export interface InheritedRunWorktree {
  path: string;
  baseCommit: string;
  changedFiles: string[];
}

async function applyPatch(worktreePath: string, patch: string): Promise<void> {
  if (!patch) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", worktreePath, "apply", "--whitespace=nowarn", "-"], {
      stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || "git apply failed")));
    child.stdin.end(patch);
  });
}

/**
 * Creates a fresh managed worktree and explicitly inherits the complete candidate diff from a
 * terminal predecessor. Both worktrees remain independently inspectable; the caller persists the
 * predecessor Run id as lineage evidence. Paths are Git-derived and every untracked file is
 * constrained to the predecessor root.
 */
export async function createInheritedRunWorktree(input: {
  repoRoot: string;
  runId: string;
  predecessorWorktreePath: string;
  predecessorBaseCommit: string;
}): Promise<InheritedRunWorktree> {
  const predecessorRoot = await fs.realpath(input.predecessorWorktreePath);
  const { stdout: predecessorTopLevel } = await execFileAsync(
    "git", ["-C", predecessorRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }
  );
  if (await fs.realpath(predecessorTopLevel.trim()) !== predecessorRoot) {
    throw new Error("predecessor candidate is not a standalone registered Git worktree");
  }
  const [{ stdout: repositoryCommon }, { stdout: predecessorCommon }] = await Promise.all([
    execFileAsync("git", ["-C", input.repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }),
    execFileAsync("git", ["-C", predecessorRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" })
  ]);
  if (await fs.realpath(repositoryCommon.trim()) !== await fs.realpath(predecessorCommon.trim())) {
    throw new Error("predecessor candidate belongs to a different Git repository");
  }
  await execFileAsync("git", ["-C", predecessorRoot, "rev-parse", "--verify", `${input.predecessorBaseCommit}^{commit}`]);
  const { stdout: trackedPatch } = await execFileAsync(
    "git",
    ["-C", predecessorRoot, "diff", "--binary", input.predecessorBaseCommit, "--"],
    { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }
  );
  const { stdout: trackedNames } = await execFileAsync(
    "git", ["-C", predecessorRoot, "diff", "--name-only", "-z", input.predecessorBaseCommit, "--"], { encoding: "utf8" }
  );
  const { stdout: untrackedNames } = await execFileAsync(
    "git", ["-C", predecessorRoot, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }
  );
  const untracked = untrackedNames.split("\0").filter(Boolean).sort();
  const created = await createRunWorktree(input.repoRoot, input.runId, input.predecessorBaseCommit);
  if (!created) throw new Error(`continuation requires a Git execution root: ${input.repoRoot}`);
  try {
    await applyPatch(created.path, trackedPatch);
    let copiedBytes = 0;
    for (const relativePath of untracked) {
      const source = path.resolve(predecessorRoot, relativePath);
      const relative = path.relative(predecessorRoot, source);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`untracked path escapes predecessor: ${relativePath}`);
      const stat = await fs.lstat(source);
      if (!stat.isFile()) throw new Error(`unsupported untracked continuation entry: ${relativePath}`);
      copiedBytes += stat.size;
      if (copiedBytes > 128 * 1024 * 1024) throw new Error("untracked continuation payload exceeds 128 MiB");
      const target = path.resolve(created.path, relativePath);
      const targetRelative = path.relative(created.path, target);
      if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) throw new Error(`untracked target escapes continuation: ${relativePath}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
    return {
      ...created,
      changedFiles: [...new Set([...trackedNames.split("\0").filter(Boolean), ...untracked])].sort()
    };
  } catch (error) {
    await removeRunWorktree(input.repoRoot, created.path);
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
