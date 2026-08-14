import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CandidateWorkspaceSnapshot {
  revision: string;
  baseCommit: string;
  changedFiles: string[];
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout;
}

function nulList(value: string): string[] {
  return value.split("\0").filter(Boolean).sort();
}

/**
 * Produces a content-addressed identity for the candidate currently present in a Git worktree.
 * Runtime Gates and candidate preview servers use this same function, so a reachable page can
 * prove that it is serving the exact worktree under review.
 */
export async function candidateWorkspaceSnapshot(root: string): Promise<CandidateWorkspaceSnapshot> {
  const repositoryRoot = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
  const baseCommit = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  const trackedDiff = await git(repositoryRoot, ["diff", "--binary", "HEAD", "--"]);
  const trackedFiles = nulList(await git(repositoryRoot, ["diff", "--name-only", "-z", "HEAD", "--"]));
  const untrackedFiles = nulList(await git(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const digest = createHash("sha256")
    .update("candidate-workspace-v1\0")
    .update(baseCommit)
    .update("\0")
    .update(trackedDiff);
  for (const relativePath of untrackedFiles) {
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    const relative = path.relative(repositoryRoot, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`candidate file escapes worktree: ${relativePath}`);
    }
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile()) throw new Error(`candidate contains unsupported untracked entry: ${relativePath}`);
    digest.update("\0untracked\0").update(relativePath).update("\0").update(await fs.readFile(absolutePath));
  }
  return {
    revision: `sha256:${digest.digest("hex")}`,
    baseCommit,
    changedFiles: [...new Set([...trackedFiles, ...untrackedFiles])].sort()
  };
}
