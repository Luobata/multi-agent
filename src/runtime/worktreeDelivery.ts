import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { JsonValue, WorkflowRunRecord } from "../core/types.js";
import { removeRunWorktree } from "./worktree.js";

const RUN_ID_PATTERN = /^run-[A-Za-z0-9-]+$/;
const DELIVERY_FILE = "delivery.json";
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_UNIFIED_DIFF_BYTES = 256 * 1024;
const MAX_UNTRACKED_DIFF_FILE_BYTES = 128 * 1024;
const MAX_UNTRACKED_DIFF_FILES = 100;
const MAX_EVIDENCE_FILES = 2_000;
const MAX_EVIDENCE_DEPTH = 10;

export type DeliveryStatus =
  | "awaiting-acceptance"
  | "queued-for-merge"
  | "retesting"
  | "merging"
  | "returned-to-acceptance"
  | "conflict"
  | "merged"
  | "kept"
  | "discarded";

export type EvidenceRerunStatus = "queued" | "running" | "passed" | "failed";
export type ConflictResolutionStatus = "resolving" | "retesting" | "leader-review" | "passed" | "failed";

export interface RunEvidenceAsset {
  id: string;
  kind: "screenshot" | "recording";
  name: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  url: string;
}

interface ResolvedRunEvidenceAsset extends RunEvidenceAsset {
  absolutePath: string;
}

export interface RunGateEvidence {
  gateId: string;
  requiredCapability?: string;
  mode?: string;
  required: boolean;
  status: string;
  reason?: string;
}

export interface RunDeliveryRecord {
  runId: string;
  status: DeliveryStatus;
  updatedAt: string;
  baseCommit?: string;
  sourceBranch?: string;
  sourceCommit?: string;
  targetBranch?: string;
  targetCommitBeforeMerge?: string;
  queuedTargetCommit?: string;
  mergeCommit?: string;
  message?: string;
  conflictResolution?: {
    status: ConflictResolutionStatus;
    targetCommit: string;
    updatedAt: string;
    conflictMessage?: string;
    leaderPlanRunId?: string;
    executionRoleId?: string;
    resolutionRunId?: string;
    testRunId?: string;
    leaderReviewRunId?: string;
    message?: string;
  };
  mergeValidation?: {
    required: boolean;
    status: "not-required" | "running" | "passed" | "failed";
    runId?: string;
    targetCommit?: string;
    message?: string;
    updatedAt: string;
  };
  evidenceRerun?: {
    status: EvidenceRerunStatus;
    actor: string;
    requestedAt: string;
    updatedAt: string;
    runId?: string;
    message?: string;
    mediaCount?: number;
  };
  humanDecision?: {
    action: "keep" | "discard" | "merge";
    actor: string;
    at: string;
    note?: string;
  };
}

export interface RunMergePreview {
  runId: string;
  status: "not-ready" | DeliveryStatus;
  eligible: boolean;
  reasons: string[];
  acceptanceReadiness: { ready: boolean; reasons: string[] };
  worktreePath?: string;
  repositoryRoot?: string;
  commitAnchor?: { baseCommit: string; sourceCommit: string; mergeCommit: string };
  sourceBranch?: string;
  sourceCommit?: string;
  targetBranch?: string;
  targetClean: boolean;
  changes: {
    files: Array<{ status: string; path: string }>;
    fileCount: number;
    summary: string;
    unifiedDiff: {
      text: string;
      truncated: boolean;
      maxBytes: number;
    };
  };
  safeGitCommands: string[];
  evidence: {
    assets: RunEvidenceAsset[];
    structuredE2eCount: number;
    acceptedVerdict: boolean;
    gates: RunGateEvidence[];
  };
  confirmationToken: string;
  discardConfirmationToken: string;
  delivery?: RunDeliveryRecord;
}

const FULL_COMMIT = /^[0-9a-f]{40}$/;

async function mergedCommitEvidence(
  run: WorkflowRunRecord,
  delivery: RunDeliveryRecord,
  worktreePath: string
): Promise<{
  repositoryRoot: string;
  anchor: { baseCommit: string; sourceCommit: string; mergeCommit: string };
  changes: Array<{ status: string; path: string }>;
  summary: string;
  unifiedDiff: { text: string; truncated: boolean; maxBytes: number };
}> {
  const expected = path.resolve(path.dirname(path.dirname(worktreePath)), "..");
  if (path.resolve(expected, ".multi-agent", "worktrees", run.id) !== path.resolve(worktreePath)) {
    throw new Error("历史 worktree 路径不是该 Run 的受管路径");
  }
  const repositoryRoot = await fs.realpath(expected);
  const anchor = {
    baseCommit: delivery.baseCommit ?? "",
    sourceCommit: delivery.sourceCommit ?? "",
    mergeCommit: delivery.mergeCommit ?? ""
  };
  for (const [name, commit] of Object.entries(anchor)) {
    if (!FULL_COMMIT.test(commit)) throw new Error(`${name} 不是完整 commit`);
    const resolved = await git(repositoryRoot, ["rev-parse", "--verify", `${commit}^{commit}`]);
    if (resolved !== commit) throw new Error(`${name} 在仓库中不可解析`);
  }
  for (const [ancestor, descendant, message] of [
    [anchor.baseCommit, anchor.sourceCommit, "source commit 不包含 base commit"],
    [anchor.sourceCommit, anchor.mergeCommit, "merge commit 不包含 source commit"]
  ] as const) {
    if ((await runGit(repositoryRoot, ["merge-base", "--is-ancestor", ancestor, descendant])).code !== 0) {
      throw new Error(message);
    }
  }
  const raw = await git(repositoryRoot, ["diff", "--name-status", anchor.baseCommit, anchor.sourceCommit, "--"]);
  const changes = raw.split("\n").filter(Boolean).map((line) => {
    const [status = "?", ...parts] = line.split("\t");
    return { status, path: parts.at(-1) ?? "" };
  });
  if (changes.length === 0) throw new Error("原始交付 diff 为空");
  return {
    repositoryRoot,
    anchor,
    changes,
    summary: await git(repositoryRoot, ["diff", "--stat", anchor.baseCommit, anchor.sourceCommit, "--"]),
    unifiedDiff: await readUnifiedDiff(repositoryRoot, anchor.baseCommit, anchor.sourceCommit)
  };
}

export interface RunMergeResult {
  status: "merged" | "conflict";
  delivery: RunDeliveryRecord;
}

export interface RunMergeQueueResult {
  status: "queued-for-merge";
  delivery: RunDeliveryRecord;
}

export interface QueuedRunAssessment {
  repositoryRoot: string;
  worktreePath: string;
  targetBranch: string;
  queuedTargetCommit: string;
  currentTargetCommit: string;
  targetChanged: boolean;
  conflict: boolean;
  conflictMessage?: string;
}

export interface MergeValidationWorktree {
  repositoryRoot: string;
  worktreePath: string;
  targetBranch: string;
  targetCommit: string;
  sourceCommit: string;
}

export interface RunDeliveryActionResult {
  status: "kept" | "discarded";
  delivery: RunDeliveryRecord;
}

export interface RunWorktreeOpenResult {
  runId: string;
  worktreePath: string;
  repositoryRoot: string;
}

export interface ManagedRunRebaseStep {
  status: "conflict" | "completed";
  conflictPaths: string[];
  message: string;
}

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException | null)?.code === "number"
        ? (error as NodeJS.ErrnoException & { code: number }).code
        : error ? 1 : 0;
      if (error && typeof (error as NodeJS.ErrnoException).code !== "number") {
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0] ?? "command"} failed`);
  }
  // Porcelain status uses a leading space to distinguish an unstaged change
  // (for example ` M README.md`). Trimming the start shifts the first row and
  // corrupts its path during fixed-column parsing, so only remove line endings.
  return result.stdout.trimEnd();
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("run id is invalid");
}

function deliveryPath(runDir: string): string {
  return path.join(runDir, DELIVERY_FILE);
}

export async function readRunDelivery(runDir: string): Promise<RunDeliveryRecord | undefined> {
  try {
    return JSON.parse(await fs.readFile(deliveryPath(runDir), "utf8")) as RunDeliveryRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeRunDelivery(runDir: string, record: RunDeliveryRecord): Promise<void> {
  const destination = deliveryPath(runDir);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, destination);
}

export async function updateRunDelivery(
  runDir: string,
  runId: string,
  update: (current: RunDeliveryRecord | undefined) => RunDeliveryRecord
): Promise<RunDeliveryRecord> {
  assertRunId(runId);
  const current = await readRunDelivery(runDir);
  if (current?.runId && current.runId !== runId) {
    throw new Error("交付记录与当前 Run 不匹配，请检查 Run Store 完整性");
  }
  const next = update(current);
  if (next.runId !== runId) throw new Error("交付记录更新不能改变 Run ID");
  await writeRunDelivery(runDir, next);
  return next;
}

export async function transitionRunDelivery(
  runDir: string,
  runId: string,
  status: DeliveryStatus,
  input: {
    message?: string;
    mergeValidation?: RunDeliveryRecord["mergeValidation"];
    conflictResolution?: RunDeliveryRecord["conflictResolution"];
  } = {}
): Promise<RunDeliveryRecord> {
  return updateRunDelivery(runDir, runId, (current) => ({
    ...current,
    runId,
    status,
    updatedAt: new Date().toISOString(),
    ...(input.message !== undefined ? { message: input.message.slice(0, 8_000) } : {}),
    ...(input.mergeValidation ? { mergeValidation: input.mergeValidation } : {}),
    ...(input.conflictResolution ? { conflictResolution: input.conflictResolution } : {})
  }));
}

async function managedRunRebaseContext(
  run: WorkflowRunRecord,
  runDir: string,
  targetCommit: string
): Promise<{ worktreePath: string; repositoryRoot: string; sourceBranch: string }> {
  assertRunId(run.id);
  const worktreePath = run.isolation?.mode === "worktree" ? run.isolation.worktreePath : undefined;
  const delivery = await readRunDelivery(runDir);
  if (!worktreePath || !delivery?.sourceBranch || !delivery.targetBranch) {
    throw new Error("冲突修复缺少受管 worktree、交付源分支或目标分支");
  }
  const repositoryRoot = await registeredRepositoryRoot(worktreePath, run.id);
  const currentTarget = await git(repositoryRoot, ["rev-parse", "--verify", `refs/heads/${delivery.targetBranch}^{commit}`]);
  if (currentTarget !== targetCommit) throw new Error("冲突修复开始前目标分支已再次变化，请重新进入队列预检");
  return { worktreePath, repositoryRoot, sourceBranch: delivery.sourceBranch };
}

async function rebaseStateExists(worktreePath: string): Promise<boolean> {
  const gitDir = await git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  return Promise.any([
    fs.access(path.join(gitDir, "rebase-merge")).then(() => true),
    fs.access(path.join(gitDir, "rebase-apply")).then(() => true)
  ]).catch(() => false);
}

async function unmergedPaths(worktreePath: string): Promise<string[]> {
  const output = await git(worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z", "--"]);
  return output.split("\u0000").filter(Boolean);
}

/**
 * Starts a rebase at the trusted delivery boundary. Provider sandboxes may edit
 * files inside a Run worktree, but they intentionally cannot write the parent
 * repository's `.git/worktrees/*` metadata. Git state transitions therefore
 * stay here while an engineering project role resolves only the working files.
 */
export async function beginManagedRunRebase(
  run: WorkflowRunRecord,
  runDir: string,
  targetCommit: string
): Promise<ManagedRunRebaseStep> {
  const { worktreePath, sourceBranch } = await managedRunRebaseContext(run, runDir, targetCommit);
  if (await rebaseStateExists(worktreePath)) {
    await git(worktreePath, ["rebase", "--abort"]);
  }
  const branch = await git(worktreePath, ["branch", "--show-current"]);
  if (branch !== sourceBranch) throw new Error("冲突修复改变了受管交付源分支");
  const working = await git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (working.length > 0) throw new Error("开始冲突修复前 worktree 存在未提交文件");

  const result = await runGit(worktreePath, ["rebase", targetCommit]);
  if (result.code === 0) {
    return { status: "completed", conflictPaths: [], message: "运行核心已完成无冲突 rebase。" };
  }
  const conflictPaths = await unmergedPaths(worktreePath);
  if (conflictPaths.length === 0) {
    if (await rebaseStateExists(worktreePath)) await runGit(worktreePath, ["rebase", "--abort"]);
    throw new Error((result.stderr.trim() || result.stdout.trim() || "rebase 启动失败").slice(0, 8_000));
  }
  return {
    status: "conflict",
    conflictPaths,
    message: (result.stderr.trim() || result.stdout.trim() || "rebase 等待解决冲突").slice(0, 8_000)
  };
}

/** Accepts one engineering resolution round and advances the trusted rebase. */
export async function continueManagedRunRebase(
  run: WorkflowRunRecord,
  runDir: string,
  targetCommit: string
): Promise<ManagedRunRebaseStep> {
  const { worktreePath } = await managedRunRebaseContext(run, runDir, targetCommit);
  const conflictPaths = await unmergedPaths(worktreePath);
  if (conflictPaths.length === 0) throw new Error("运行核心没有找到等待处理的冲突文件");
  const check = await runGit(worktreePath, ["diff", "--check", "--"]);
  if (check.code !== 0) {
    throw new Error((check.stderr.trim() || check.stdout.trim() || "冲突文件仍包含无效标记").slice(0, 8_000));
  }
  await git(worktreePath, ["add", "--", ...conflictPaths]);
  const result = await runGit(worktreePath, [
    "-c", "core.editor=true",
    "-c", "sequence.editor=true",
    "rebase", "--continue"
  ]);
  if (result.code === 0) {
    return { status: "completed", conflictPaths: [], message: "运行核心已暂存工程修复并完成 rebase。" };
  }
  const nextPaths = await unmergedPaths(worktreePath);
  if (nextPaths.length === 0) {
    throw new Error((result.stderr.trim() || result.stdout.trim() || "rebase continue 失败").slice(0, 8_000));
  }
  return {
    status: "conflict",
    conflictPaths: nextPaths,
    message: (result.stderr.trim() || result.stdout.trim() || "rebase 进入下一轮冲突").slice(0, 8_000)
  };
}

/**
 * Fail-closed verification after the original leader says a conflict is resolved.
 * The leader may edit Git state, but only this deterministic boundary can accept
 * the rebased source commit back into the delivery queue.
 */
export async function acceptRebasedRunSource(
  run: WorkflowRunRecord,
  runDir: string,
  targetCommit: string
): Promise<RunDeliveryRecord> {
  const preview = await previewRunMerge(run, runDir);
  const delivery = await readRunDelivery(runDir);
  if (!preview.repositoryRoot || !preview.worktreePath || !delivery?.sourceBranch) {
    throw new Error("冲突修复缺少受管 worktree、目标仓库或交付源分支");
  }
  const branch = await git(preview.worktreePath, ["branch", "--show-current"]);
  if (branch !== delivery.sourceBranch) throw new Error("冲突修复改变了受管交付源分支");
  const working = await git(preview.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (working.length > 0) throw new Error("冲突修复后 worktree 仍有未提交文件或未完成的 rebase");
  const sourceCommit = await git(preview.worktreePath, ["rev-parse", "HEAD"]);
  const ancestry = await runGit(preview.worktreePath, ["merge-base", "--is-ancestor", targetCommit, sourceCommit]);
  if (ancestry.code !== 0) throw new Error("冲突修复结果没有 rebase 到指定目标 commit");
  const changes = await git(preview.worktreePath, ["diff", "--name-only", targetCommit, sourceCommit, "--"]);
  if (!changes.trim()) throw new Error("冲突修复后候选不再包含需求代码变更");
  const mergeCheck = await runGit(preview.repositoryRoot, ["merge-tree", "--write-tree", targetCommit, sourceCommit]);
  if (mergeCheck.code !== 0) {
    throw new Error((mergeCheck.stderr.trim() || mergeCheck.stdout.trim() || "冲突仍未解决").slice(0, 8_000));
  }
  return updateRunDelivery(runDir, run.id, (current) => {
    if (!current?.conflictResolution) throw new Error("缺少冲突修复审计记录");
    return {
      ...current,
      runId: run.id,
      status: "retesting",
      baseCommit: targetCommit,
      sourceCommit,
      queuedTargetCommit: targetCommit,
      targetCommitBeforeMerge: targetCommit,
      updatedAt: new Date().toISOString(),
      message: "AI 已在原 worktree 完成 rebase 并通过 Git 完整性检查；正在回跑独立测试与原领队复验。",
      conflictResolution: {
        ...current.conflictResolution,
        status: "retesting",
        targetCommit,
        updatedAt: new Date().toISOString(),
        message: "rebase 结果已由运行核心验证。"
      }
    };
  });
}

export async function updateRunEvidenceRerun(
  runDir: string,
  runId: string,
  evidenceRerun: NonNullable<RunDeliveryRecord["evidenceRerun"]>
): Promise<RunDeliveryRecord> {
  return updateRunDelivery(runDir, runId, (current) => ({
    ...current,
    runId,
    status: current?.status ?? "awaiting-acceptance",
    updatedAt: new Date().toISOString(),
    evidenceRerun
  }));
}

const EVIDENCE_MEDIA: Record<string, { kind: RunEvidenceAsset["kind"]; mediaType: string }> = {
  ".png": { kind: "screenshot", mediaType: "image/png" },
  ".jpg": { kind: "screenshot", mediaType: "image/jpeg" },
  ".jpeg": { kind: "screenshot", mediaType: "image/jpeg" },
  ".webp": { kind: "screenshot", mediaType: "image/webp" },
  ".gif": { kind: "screenshot", mediaType: "image/gif" },
  ".mp4": { kind: "recording", mediaType: "video/mp4" },
  ".webm": { kind: "recording", mediaType: "video/webm" },
  ".mov": { kind: "recording", mediaType: "video/quicktime" }
};

async function discoverResolvedRunEvidenceAssets(runDir: string, runId: string): Promise<ResolvedRunEvidenceAsset[]> {
  const root = await fs.realpath(runDir);
  const assets: ResolvedRunEvidenceAsset[] = [];
  let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_EVIDENCE_DEPTH || visited >= MAX_EVIDENCE_FILES) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (visited++ >= MAX_EVIDENCE_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const media = EVIDENCE_MEDIA[path.extname(entry.name).toLowerCase()];
      if (!media) continue;
      const resolved = await fs.realpath(absolutePath);
      const relativePath = path.relative(root, resolved);
      if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue;
      const stat = await fs.stat(resolved);
      const id = createHash("sha256").update(relativePath).digest("hex").slice(0, 20);
      assets.push({
        id,
        kind: media.kind,
        name: entry.name,
        relativePath,
        mediaType: media.mediaType,
        sizeBytes: stat.size,
        url: `/api/runs/${encodeURIComponent(runId)}/evidence/${id}`,
        absolutePath: resolved
      });
    }
  };
  await visit(root, 0);
  return assets.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function discoverRunEvidenceAssets(runDir: string, runId: string): Promise<RunEvidenceAsset[]> {
  assertRunId(runId);
  return (await discoverResolvedRunEvidenceAssets(runDir, runId)).map(({ absolutePath: _absolutePath, ...asset }) => asset);
}

export async function resolveRunEvidenceAsset(
  runDir: string,
  runId: string,
  assetId: string
): Promise<{ filePath: string; asset: RunEvidenceAsset }> {
  assertRunId(runId);
  if (!/^[0-9a-f]{20}$/.test(assetId)) throw new Error("run evidence asset id is invalid");
  const found = (await discoverResolvedRunEvidenceAssets(runDir, runId)).find((asset) => asset.id === assetId);
  if (!found) throw new Error(`run evidence asset not found: ${assetId}`);
  const { absolutePath, ...asset } = found;
  return { filePath: absolutePath, asset };
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function collectStructuredEvidence(value: JsonValue | undefined): { e2eCount: number; acceptedVerdict: boolean } {
  let e2eCount = 0;
  let acceptedVerdict = false;
  const visit = (candidate: JsonValue | undefined): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const object = asObject(candidate);
    if (!object) return;
    if (typeof object.verdict === "string" && object.verdict.toLowerCase() === "pass") acceptedVerdict = true;
    if (Array.isArray(object.e2eEvidence)) {
      e2eCount += object.e2eEvidence.filter((item) => {
        const entry = asObject(item);
        return Boolean(entry && (typeof entry.method === "string" || typeof entry.steps === "string" || typeof entry.observed === "string"));
      }).length;
    }
    for (const [key, item] of Object.entries(object)) {
      if (key !== "e2eEvidence") visit(item);
    }
  };
  visit(value);
  return { e2eCount, acceptedVerdict };
}

function collectGateEvidence(output: JsonValue | undefined): RunGateEvidence[] {
  const gates = asObject(output)?.gates;
  if (!Array.isArray(gates)) return [];
  return gates.flatMap((candidate) => {
    const gate = asObject(candidate);
    if (!gate || typeof gate.gateId !== "string") return [];
    return [{
      gateId: gate.gateId,
      ...(typeof gate.requiredCapability === "string" ? { requiredCapability: gate.requiredCapability } : {}),
      ...(typeof gate.mode === "string" ? { mode: gate.mode } : {}),
      required: gate.required !== false,
      status: typeof gate.status === "string" ? gate.status : "unknown",
      ...(typeof gate.reason === "string" ? { reason: gate.reason } : {})
    }];
  });
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let text = bytes.subarray(0, maxBytes).toString("utf8");
  if (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  return { text, truncated: true };
}

async function readUnifiedDiff(
  worktreePath: string,
  baseCommit?: string,
  sourceCommit?: string
): Promise<{ text: string; truncated: boolean; maxBytes: number }> {
  const tracked = await runGit(worktreePath, [
    "diff", "--no-ext-diff", "--no-color", "--unified=3", baseCommit ?? "HEAD", ...(sourceCommit ? [sourceCommit] : []), "--"
  ]);
  if (tracked.code !== 0) {
    throw new Error(tracked.stderr.trim() || tracked.stdout.trim() || "git diff failed");
  }
  const chunks = [tracked.stdout];
  let truncated = false;
  const untracked = sourceCommit ? [] : (await git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  for (const file of untracked.slice(0, MAX_UNTRACKED_DIFF_FILES)) {
    const absolutePath = path.resolve(worktreePath, file);
    const relativePath = path.relative(worktreePath, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`untracked diff path escapes worktree: ${file}`);
    }
    const stat = await fs.lstat(absolutePath);
    // Browser reports can contain several megabytes of embedded screenshots. Asking Git to
    // render the full no-index diff before truncating it can exceed child_process.maxBuffer and
    // incorrectly make an otherwise healthy delivery ineligible. Keep the file visible in the
    // preview, but bound expansion before invoking Git.
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_DIFF_FILE_BYTES) {
      chunks.push([
        `diff --git a/${file} b/${file}`,
        "new file omitted from inline preview",
        `[${stat.size} bytes; inspect the worktree for full contents]`
      ].join("\n"));
      truncated = true;
      continue;
    }
    const diff = await runGit(worktreePath, [
      "diff", "--no-index", "--no-ext-diff", "--no-color", "--unified=3", "--", "/dev/null", file
    ]);
    if (diff.code !== 0 && diff.code !== 1) {
      throw new Error(diff.stderr.trim() || diff.stdout.trim() || `git diff failed for ${file}`);
    }
    chunks.push(diff.stdout);
  }
  if (untracked.length > MAX_UNTRACKED_DIFF_FILES) truncated = true;
  const bounded = truncateUtf8(chunks.filter(Boolean).join("\n"), MAX_UNIFIED_DIFF_BYTES);
  return {
    text: bounded.text,
    truncated: truncated || bounded.truncated,
    maxBytes: MAX_UNIFIED_DIFF_BYTES
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function safeGitInspectionCommands(repositoryRoot: string, worktreePath: string, baseCommit?: string): string[] {
  return [
    `git -C ${shellQuote(repositoryRoot)} status --short --branch`,
    `git -C ${shellQuote(worktreePath)} status --short --branch`,
    ...(baseCommit ? [
      `git -C ${shellQuote(worktreePath)} diff --stat ${shellQuote(baseCommit)} --`,
      `git -C ${shellQuote(worktreePath)} diff --no-ext-diff --no-color ${shellQuote(baseCommit)} --`
    ] : [])
  ];
}

function parsePorcelain(value: string): Array<{ status: string; path: string }> {
  return value.split("\n").filter(Boolean).map((line) => ({
    status: line.slice(0, 2).trim() || "?",
    path: line.slice(3).trim()
  }));
}

async function registeredRepositoryRoot(worktreePath: string, runId: string): Promise<string> {
  const resolvedWorktree = await fs.realpath(worktreePath);
  if (path.basename(resolvedWorktree) !== runId) throw new Error("run worktree path does not match the run id");
  const commonDir = await git(resolvedWorktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const repositoryRoot = path.dirname(commonDir);
  const expected = path.join(repositoryRoot, ".multi-agent", "worktrees", runId);
  if (resolvedWorktree !== await fs.realpath(expected)) throw new Error("run worktree is outside the managed worktree root");
  const registered = (await git(repositoryRoot, ["worktree", "list", "--porcelain"]))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  if (!registered.includes(resolvedWorktree)) throw new Error("run worktree is no longer registered");
  return repositoryRoot;
}

/**
 * Opens only a registered, managed Run worktree using the operating system's file browser.
 * The path is validated before crossing the desktop boundary and is passed as an argv item,
 * never through a shell.
 */
export async function openManagedRunWorktree(
  run: WorkflowRunRecord,
  opener: (worktreePath: string) => Promise<void> = async (worktreePath) => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    await new Promise<void>((resolve, reject) => {
      execFile(command, [worktreePath], { windowsHide: true }, (error) => {
        if (error) {
          reject(new Error(`无法在系统中打开 worktree：${error.message}`));
          return;
        }
        resolve();
      });
    });
  }
): Promise<RunWorktreeOpenResult> {
  assertRunId(run.id);
  const worktreePath = run.isolation?.mode === "worktree" ? run.isolation.worktreePath : undefined;
  if (!worktreePath) throw new Error("该 Run 没有可打开的 worktree");
  const repositoryRoot = await registeredRepositoryRoot(worktreePath, run.id);
  await opener(worktreePath);
  return { runId: run.id, worktreePath, repositoryRoot };
}

function confirmationToken(runId: string): string {
  return `MERGE ${runId}`;
}

function discardConfirmationToken(runId: string): string {
  return `DISCARD ${runId}`;
}

export async function previewRunMerge(
  run: WorkflowRunRecord,
  runDir: string
): Promise<RunMergePreview> {
  assertRunId(run.id);
  const reasons: string[] = [];
  const acceptanceReasons: string[] = [];
  const delivery = await readRunDelivery(runDir);
  const assets = await discoverRunEvidenceAssets(runDir, run.id);
  const structuredValues: JsonValue[] = [run.output ?? null, ...Object.values(run.nodes).map((node) => node.output ?? null)];
  const structured = structuredValues.reduce<{ e2eCount: number; acceptedVerdict: boolean }>((total, value) => {
    const current = collectStructuredEvidence(value);
    return {
      e2eCount: total.e2eCount + current.e2eCount,
      acceptedVerdict: total.acceptedVerdict || current.acceptedVerdict
    };
  }, { e2eCount: 0, acceptedVerdict: false });
  const gates = collectGateEvidence(run.output);
  const requiredGates = gates.filter((gate) => gate.required);
  const gatesPassed = requiredGates.length > 0 && requiredGates.every((gate) => gate.status === "passed");
  const qualityTestPassed = gates.some((gate) => (
    gate.required
    && gate.requiredCapability === "quality.test"
    && gate.mode === "before-completion"
    && gate.status === "passed"
  ));
  const qualityAuditPassed = gates.some((gate) => (
    gate.required
    && gate.requiredCapability === "quality.audit"
    && gate.mode === "before-completion"
    && gate.status === "passed"
  ));

  if (run.status !== "passed") { reasons.push("Run 尚未通过，不能进入合并验收。"); acceptanceReasons.push("Run 尚未通过。"); }
  if (!gatesPassed) { reasons.push("一个或多个 required Gate 尚未通过；acceptedVerdict 不能替代 Gate。"); acceptanceReasons.push("一个或多个 required Gate 尚未通过。"); }
  if (!qualityTestPassed) { reasons.push("缺少通过的 before-completion required quality.test Gate。"); acceptanceReasons.push("缺少通过的 before-completion required quality.test Gate。"); }
  if (!qualityAuditPassed) { reasons.push("缺少通过的 before-completion required quality.audit Gate。"); acceptanceReasons.push("缺少通过的 before-completion required quality.audit Gate。"); }
  if (assets.length === 0 && structured.e2eCount === 0) { reasons.push("缺少截图、录屏或结构化 E2E 验收证据。"); acceptanceReasons.push("缺少截图、录屏或结构化 E2E 验收证据。"); }
  if (delivery?.status === "merged") reasons.push("该交付已经合并。");
  if (delivery?.status === "discarded") reasons.push("该交付已经丢弃，不能再次交付。");
  if (delivery?.status !== "merged" || delivery.runId !== run.id) acceptanceReasons.push("缺少与当前 Run 精确匹配的 merged 交付记录。");
  if (delivery?.status === "merged" && (!delivery.baseCommit || !delivery.sourceCommit || !delivery.mergeCommit)) acceptanceReasons.push("merged 交付记录缺少 baseCommit、sourceCommit 或 mergeCommit。");

  let repositoryRoot: string | undefined;
  let targetBranch: string | undefined;
  let targetClean = false;
  let changes: Array<{ status: string; path: string }> = [];
  let summary = "";
  let unifiedDiff = { text: "", truncated: false, maxBytes: MAX_UNIFIED_DIFF_BYTES };
  let safeGitCommands: string[] = [];
  let commitAnchor: { baseCommit: string; sourceCommit: string; mergeCommit: string } | undefined;
  const worktreePath = run.isolation?.mode === "worktree" ? run.isolation.worktreePath : undefined;
  if (!worktreePath) {
    reasons.push("该 Run 没有可交付的 worktree。");
    acceptanceReasons.push("该 Run 没有可验证的受管 worktree。");
  } else if (delivery?.status !== "discarded") {
    try {
      repositoryRoot = await registeredRepositoryRoot(worktreePath, run.id);
      const historicalSource = delivery?.status === "merged" ? delivery.sourceCommit : undefined;
      targetBranch = delivery?.status === "merged" ? delivery.targetBranch : await git(repositoryRoot, ["branch", "--show-current"]);
      if (!targetBranch) reasons.push("目标仓库当前不在命名分支上。");
      if (delivery?.status !== "merged") {
        const targetStatus = await git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
        targetClean = targetStatus.length === 0;
        if (!targetClean) reasons.push("目标仓库存在未提交改动，请先处理后再合并。");
      }
      const baseCommit = delivery?.baseCommit ?? run.isolation?.baseCommit;
      safeGitCommands = safeGitInspectionCommands(repositoryRoot, worktreePath, baseCommit);
      const workingChanges = historicalSource ? [] : parsePorcelain(
        await git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"])
      );
      const committedChanges = baseCommit
        ? (await git(worktreePath, ["diff", "--name-status", baseCommit, historicalSource ?? "HEAD", "--"]))
          .split("\n").filter(Boolean).map((line) => {
          const [status = "?", ...parts] = line.split("\t");
          return { status, path: parts.at(-1) ?? "" };
        })
        : [];
      const changesByPath = new Map(committedChanges.map((change) => [change.path, change]));
      for (const change of workingChanges) changesByPath.set(change.path, change);
      changes = [...changesByPath.values()];
      summary = baseCommit
        ? await git(worktreePath, ["diff", "--stat", baseCommit, historicalSource ?? "HEAD", "--"])
        : await git(worktreePath, ["diff", "--stat", "HEAD", "--"]);
      if (workingChanges.length > 0) {
        summary = [summary, `${workingChanges.length} 个未提交或未跟踪文件`].filter(Boolean).join("\n");
      }
      unifiedDiff = await readUnifiedDiff(worktreePath, baseCommit, historicalSource);
      if (changes.length === 0) reasons.push("worktree 没有可合并的代码变更。");
      if (delivery?.status === "merged" && !unifiedDiff.text.trim()) acceptanceReasons.push("原始交付 diff 为空。");
    } catch (error) {
      if (delivery?.status === "merged") {
        try {
          const evidence = await mergedCommitEvidence(run, delivery, worktreePath);
          repositoryRoot = evidence.repositoryRoot;
          commitAnchor = evidence.anchor;
          changes = evidence.changes;
          summary = evidence.summary;
          unifiedDiff = evidence.unifiedDiff;
          safeGitCommands = [];
        } catch (anchorError) {
          acceptanceReasons.push(`已合并提交证据不可验证：${anchorError instanceof Error ? anchorError.message : String(anchorError)}`);
        }
      } else {
        acceptanceReasons.push(`受管 worktree 不可验证：${error instanceof Error ? error.message : String(error)}`);
      }
      reasons.push(`worktree 不可用：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    acceptanceReasons.push("该交付已经丢弃。");
  }

  const status = delivery?.status ?? (reasons.length === 0 ? "awaiting-acceptance" : "not-ready");
  return {
    runId: run.id,
    status,
    eligible: reasons.length === 0,
    reasons,
    acceptanceReadiness: { ready: acceptanceReasons.length === 0, reasons: acceptanceReasons },
    ...(worktreePath ? { worktreePath } : {}),
    ...(repositoryRoot ? { repositoryRoot } : {}),
    ...(commitAnchor ? { commitAnchor } : {}),
    ...(delivery?.sourceBranch ? { sourceBranch: delivery.sourceBranch } : {}),
    ...(delivery?.sourceCommit ? { sourceCommit: delivery.sourceCommit } : {}),
    ...(targetBranch ? { targetBranch } : delivery?.targetBranch ? { targetBranch: delivery.targetBranch } : {}),
    targetClean,
    changes: { files: changes, fileCount: changes.length, summary, unifiedDiff },
    safeGitCommands,
    evidence: {
      assets,
      structuredE2eCount: structured.e2eCount,
      acceptedVerdict: structured.acceptedVerdict,
      gates
    },
    confirmationToken: confirmationToken(run.id),
    discardConfirmationToken: discardConfirmationToken(run.id),
    ...(delivery ? { delivery } : {})
  };
}

function deliveryBranch(runId: string): string {
  return `codex/${runId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
}

async function currentTargetState(repositoryRoot: string): Promise<{ branch: string; commit: string }> {
  const branch = await git(repositoryRoot, ["branch", "--show-current"]);
  if (!branch) throw new Error("目标仓库当前不在命名分支上");
  if ((await git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).length > 0) {
    throw new Error("目标仓库存在未提交改动，请先处理后再合并");
  }
  return { branch, commit: await git(repositoryRoot, ["rev-parse", "HEAD"]) };
}

async function ensureDeliverySource(
  run: WorkflowRunRecord,
  runDir: string,
  preview: RunMergePreview,
  before: { branch: string; commit: string }
): Promise<RunDeliveryRecord> {
  if (!preview.repositoryRoot || !preview.worktreePath) throw new Error("该 Run 当前不能准备交付来源");
  let delivery = await readRunDelivery(runDir);
  if (delivery?.sourceCommit) {
    const expectedSourceBranch = deliveryBranch(run.id);
    if (
      delivery.runId !== run.id
      || delivery.sourceBranch !== expectedSourceBranch
      || !delivery.baseCommit
      || !delivery.targetBranch
    ) {
      throw new Error("交付记录与当前 Run 不匹配，请检查 Run Store 完整性");
    }
    const acceptedRebase = delivery.conflictResolution?.status === "passed"
      && delivery.baseCommit === delivery.conflictResolution.targetCommit;
    const independentlyValidatedSource = delivery.mergeValidation?.status === "passed"
      && delivery.mergeValidation.targetCommit === before.commit;
    if (run.isolation?.baseCommit
      && delivery.baseCommit !== run.isolation.baseCommit
      && !acceptedRebase
      && !independentlyValidatedSource) {
      throw new Error("交付记录的 worktree 基线与当前 Run 不匹配");
    }
    const [currentSourceBranch, currentSourceCommit] = await Promise.all([
      git(preview.worktreePath, ["branch", "--show-current"]),
      git(preview.worktreePath, ["rev-parse", "HEAD"])
    ]);
    if (currentSourceBranch !== expectedSourceBranch || currentSourceCommit !== delivery.sourceCommit) {
      throw new Error("交付记录的源分支或 commit 已变化，请重新核对 worktree");
    }
    if (independentlyValidatedSource) {
      const ancestry = await runGit(preview.worktreePath, [
        "merge-base", "--is-ancestor", delivery.baseCommit, currentSourceCommit
      ]);
      if (ancestry.code !== 0) throw new Error("独立回归对应的候选不再包含受管 rebase 基线");
    }
    return delivery;
  }

  const baseCommit = run.isolation?.baseCommit ?? await git(preview.worktreePath, ["rev-parse", "HEAD"]);
  const sourceBranch = deliveryBranch(run.id);
  const currentSourceBranch = await git(preview.worktreePath, ["branch", "--show-current"]);
  if (currentSourceBranch !== sourceBranch) {
    const exists = (await git(preview.repositoryRoot, ["branch", "--list", sourceBranch])).length > 0;
    await git(preview.worktreePath, exists ? ["switch", sourceBranch] : ["switch", "-c", sourceBranch]);
  }
  await git(preview.worktreePath, ["add", "-A"]);
  if ((await git(preview.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"])).length > 0) {
    await git(preview.worktreePath, [
      "-c", "user.name=Local Agent Workbench",
      "-c", "user.email=workbench@local.invalid",
      "commit", "--no-verify", "-m", `chore: deliver ${run.id}`
    ]);
  }
  delivery = {
    ...delivery,
    runId: run.id,
    status: delivery?.status ?? "awaiting-acceptance",
    updatedAt: new Date().toISOString(),
    baseCommit,
    sourceBranch,
    sourceCommit: await git(preview.worktreePath, ["rev-parse", "HEAD"]),
    targetBranch: before.branch,
    targetCommitBeforeMerge: delivery?.targetCommitBeforeMerge ?? before.commit
  };
  await writeRunDelivery(runDir, delivery);
  return delivery;
}

export async function queueAcceptedRun(
  run: WorkflowRunRecord,
  runDir: string,
  input: { confirmation: string; targetBranch: string; actor: string }
): Promise<RunMergeQueueResult> {
  if (input.confirmation !== confirmationToken(run.id)) throw new Error("缺少本次 Run 的明确合并确认");
  const actor = humanActor(input.actor);
  const preview = await previewRunMerge(run, runDir);
  if (!preview.eligible || !preview.repositoryRoot || !preview.worktreePath || !preview.targetBranch) {
    throw new Error(preview.reasons.join(" ") || "该 Run 当前不能进入待合入队列");
  }
  if (preview.delivery?.evidenceRerun?.status === "queued" || preview.delivery?.evidenceRerun?.status === "running") {
    throw new Error("验收截图仍在补采，请等待证据任务完成后再批准合入");
  }
  if (input.targetBranch !== preview.targetBranch) throw new Error("目标分支已变化，请重新打开预览确认");
  const before = await currentTargetState(preview.repositoryRoot);
  if (before.branch !== input.targetBranch) throw new Error("目标分支已变化，请重新打开预览确认");
  const delivery = await ensureDeliverySource(run, runDir, preview, before);
  if (delivery.status === "merged" || delivery.status === "discarded") {
    throw new Error(delivery.status === "merged" ? "该交付已经合并" : "该交付已经丢弃");
  }
  const queued: RunDeliveryRecord = {
    ...delivery,
    status: "queued-for-merge",
    updatedAt: new Date().toISOString(),
    targetBranch: before.branch,
    queuedTargetCommit: ["queued-for-merge", "retesting", "merging"].includes(delivery.status)
      ? delivery.queuedTargetCommit ?? before.commit
      : before.commit,
    message: "人工验收已通过，正在等待目标分支的串行合入协调。",
    humanDecision: {
      action: "merge",
      actor,
      at: new Date().toISOString()
    }
  };
  await writeRunDelivery(runDir, queued);
  return { status: "queued-for-merge", delivery: queued };
}

export async function assessQueuedRun(
  run: WorkflowRunRecord,
  runDir: string
): Promise<QueuedRunAssessment> {
  const preview = await previewRunMerge(run, runDir);
  const delivery = await readRunDelivery(runDir);
  if (!preview.repositoryRoot || !preview.worktreePath || !delivery?.sourceCommit || !delivery.targetBranch || !delivery.queuedTargetCommit) {
    throw new Error("待合入记录缺少候选来源、目标分支或队列基线");
  }
  const current = await currentTargetState(preview.repositoryRoot);
  if (current.branch !== delivery.targetBranch) throw new Error("目标分支已切换，不能继续自动合入");
  const mergeCheck = await runGit(preview.repositoryRoot, [
    "merge-tree", "--write-tree", current.commit, delivery.sourceCommit
  ]);
  return {
    repositoryRoot: preview.repositoryRoot,
    worktreePath: preview.worktreePath,
    targetBranch: current.branch,
    queuedTargetCommit: delivery.queuedTargetCommit,
    currentTargetCommit: current.commit,
    // Revalidate whenever the integration target differs from either the
    // candidate's implementation base or the commit observed at queue time.
    // Checking only the queue snapshot misses code that landed after the
    // candidate worktree was created but before human acceptance.
    targetChanged: current.commit !== delivery.baseCommit
      || current.commit !== delivery.queuedTargetCommit,
    conflict: mergeCheck.code !== 0,
    ...(mergeCheck.code !== 0
      ? { conflictMessage: (mergeCheck.stderr.trim() || mergeCheck.stdout.trim() || "合并冲突").slice(0, 8_000) }
      : {})
  };
}

export async function createMergeValidationWorktree(
  run: WorkflowRunRecord,
  runDir: string
): Promise<MergeValidationWorktree> {
  const assessment = await assessQueuedRun(run, runDir);
  if (assessment.conflict) throw new Error(assessment.conflictMessage ?? "合并冲突");
  const delivery = await readRunDelivery(runDir);
  if (!delivery?.sourceCommit) throw new Error("待合入记录缺少候选 commit");
  const parent = path.join(assessment.repositoryRoot, ".multi-agent", "merge-validation");
  await fs.mkdir(parent, { recursive: true });
  const worktreePath = path.join(parent, `${run.id}-${randomUUID()}`);
  const added = await runGit(assessment.repositoryRoot, [
    "worktree", "add", "--detach", worktreePath, assessment.currentTargetCommit
  ]);
  if (added.code !== 0) throw new Error(added.stderr.trim() || added.stdout.trim() || "无法创建合入重测 worktree");
  const merged = await runGit(worktreePath, ["merge", "--no-commit", "--no-ff", delivery.sourceCommit]);
  if (merged.code !== 0) {
    await removeRunWorktree(assessment.repositoryRoot, worktreePath);
    throw new Error(merged.stderr.trim() || merged.stdout.trim() || "合入重测 worktree 发生冲突");
  }
  return {
    repositoryRoot: assessment.repositoryRoot,
    worktreePath,
    targetBranch: assessment.targetBranch,
    targetCommit: assessment.currentTargetCommit,
    sourceCommit: delivery.sourceCommit
  };
}

export async function removeMergeValidationWorktree(input: MergeValidationWorktree): Promise<void> {
  await removeRunWorktree(input.repositoryRoot, input.worktreePath);
}

export async function mergeAcceptedRun(
  run: WorkflowRunRecord,
  runDir: string,
  input: { confirmation: string; targetBranch: string }
): Promise<RunMergeResult> {
  if (input.confirmation !== confirmationToken(run.id)) throw new Error("缺少本次 Run 的明确合并确认");
  const preview = await previewRunMerge(run, runDir);
  if (!preview.eligible || !preview.repositoryRoot || !preview.worktreePath || !preview.targetBranch) {
    throw new Error(preview.reasons.join(" ") || "该 Run 当前不能合并");
  }
  if (input.targetBranch !== preview.targetBranch) throw new Error("目标分支已变化，请重新打开预览确认");
  const before = await currentTargetState(preview.repositoryRoot);
  if (before.branch !== input.targetBranch) throw new Error("目标分支已变化，请重新打开预览确认");

  const delivery = await ensureDeliverySource(run, runDir, preview, before);
  if (!delivery.baseCommit || !delivery.sourceBranch || !delivery.sourceCommit || !delivery.targetBranch) {
    throw new Error("交付记录缺少合并所需的来源或目标信息");
  }

  const mergeCheck = await runGit(preview.repositoryRoot, [
    "merge-tree", "--write-tree", before.commit, delivery.sourceCommit
  ]);
  if (mergeCheck.code !== 0) {
    const conflict: RunDeliveryRecord = {
      ...delivery,
      status: "conflict",
      updatedAt: new Date().toISOString(),
      targetBranch: before.branch,
      targetCommitBeforeMerge: before.commit,
      message: (mergeCheck.stderr.trim() || mergeCheck.stdout.trim() || "合并冲突").slice(0, 8_000)
    };
    await writeRunDelivery(runDir, conflict);
    return { status: "conflict", delivery: conflict };
  }

  const ready = await currentTargetState(preview.repositoryRoot);
  if (ready.branch !== before.branch || ready.commit !== before.commit) {
    throw new Error("目标分支或 commit 已变化，请重新打开预览确认");
  }

  const merged = await runGit(preview.repositoryRoot, [
    "merge", "--no-ff", "--no-edit", "--no-verify", delivery.sourceCommit
  ]);
  if (merged.code !== 0) {
    const mergeHead = await runGit(preview.repositoryRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if (mergeHead.code === 0) await runGit(preview.repositoryRoot, ["merge", "--abort"]);
    const conflict: RunDeliveryRecord = {
      ...delivery,
      status: "conflict",
      updatedAt: new Date().toISOString(),
      targetBranch: before.branch,
      targetCommitBeforeMerge: before.commit,
      message: (merged.stderr.trim() || merged.stdout.trim() || "合并失败，目标分支已恢复").slice(0, 8_000)
    };
    await writeRunDelivery(runDir, conflict);
    return { status: "conflict", delivery: conflict };
  }

  const record: RunDeliveryRecord = {
    ...delivery,
    status: "merged",
    updatedAt: new Date().toISOString(),
    targetBranch: before.branch,
    targetCommitBeforeMerge: before.commit,
    mergeCommit: await git(preview.repositoryRoot, ["rev-parse", "HEAD"]),
    message: "用户确认后已合并；源分支保留作为交付证据。"
  };
  await writeRunDelivery(runDir, record);
  await removeRunWorktree(preview.repositoryRoot, preview.worktreePath);
  return { status: "merged", delivery: record };
}

function humanActor(value: string | undefined): string {
  const actor = value?.trim();
  if (!actor) throw new Error("人工交付动作必须记录 actor");
  return actor;
}

export async function keepRunWorktree(
  run: WorkflowRunRecord,
  runDir: string,
  input: { actor: string; note?: string }
): Promise<RunDeliveryActionResult> {
  assertRunId(run.id);
  const actor = humanActor(input.actor);
  const existing = await readRunDelivery(runDir);
  if (existing?.runId && existing.runId !== run.id) throw new Error("交付记录与当前 Run 不匹配");
  if (existing?.status === "merged") throw new Error("已合并的交付不能再标记为保留");
  if (existing?.status === "discarded") throw new Error("已丢弃的交付不能再标记为保留");
  if (existing?.status === "kept") throw new Error("该交付已经记录为人工保留");
  const worktreePath = run.isolation?.mode === "worktree" ? run.isolation.worktreePath : undefined;
  if (!worktreePath) throw new Error("该 Run 没有可保留的 worktree");
  const repositoryRoot = await registeredRepositoryRoot(worktreePath, run.id);
  const timestamp = new Date().toISOString();
  const targetBranch = await git(repositoryRoot, ["branch", "--show-current"]);
  if (!targetBranch) throw new Error("目标仓库当前不在命名分支上");
  const record: RunDeliveryRecord = {
    ...existing,
    runId: run.id,
    status: "kept",
    updatedAt: timestamp,
    baseCommit: existing?.baseCommit ?? run.isolation?.baseCommit ?? await git(worktreePath, ["rev-parse", "HEAD"]),
    targetBranch: existing?.targetBranch ?? targetBranch,
    message: "人工选择保留候选 worktree；未执行 merge 或 push。",
    humanDecision: {
      action: "keep",
      actor,
      at: timestamp,
      ...(input.note?.trim() ? { note: input.note.trim() } : {})
    }
  };
  await writeRunDelivery(runDir, record);
  return { status: "kept", delivery: record };
}

async function branchExists(repositoryRoot: string, branch: string): Promise<boolean> {
  return (await git(repositoryRoot, ["branch", "--list", branch])).length > 0;
}

async function isAncestor(repositoryRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runGit(repositoryRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(result.stderr.trim() || result.stdout.trim() || "git merge-base failed");
}

export async function discardRunWorktree(
  run: WorkflowRunRecord,
  runDir: string,
  input: { confirmation: string; actor: string; note?: string }
): Promise<RunDeliveryActionResult> {
  assertRunId(run.id);
  if (input.confirmation !== discardConfirmationToken(run.id)) {
    throw new Error("缺少本次 Run 的精确丢弃确认");
  }
  const actor = humanActor(input.actor);
  const existing = await readRunDelivery(runDir);
  if (existing?.runId && existing.runId !== run.id) throw new Error("交付记录与当前 Run 不匹配");
  if (existing?.status === "merged") throw new Error("已合并的交付不能丢弃");
  if (existing?.status === "discarded") throw new Error("该交付已经丢弃，不能重复执行");
  const worktreePath = run.isolation?.mode === "worktree" ? run.isolation.worktreePath : undefined;
  if (!worktreePath) throw new Error("该 Run 没有可丢弃的 worktree");
  const repositoryRoot = await registeredRepositoryRoot(worktreePath, run.id);
  const expectedSourceBranch = deliveryBranch(run.id);
  if (existing?.sourceBranch && existing.sourceBranch !== expectedSourceBranch) {
    throw new Error("交付记录的来源分支不属于当前 Run");
  }
  const baseCommit = existing?.baseCommit ?? run.isolation?.baseCommit ?? await git(worktreePath, ["rev-parse", "HEAD"]);
  const targetBranch = existing?.targetBranch ?? await git(repositoryRoot, ["branch", "--show-current"]);
  if (!targetBranch) throw new Error("目标仓库当前不在命名分支上");
  const sourceBranchExists = await branchExists(repositoryRoot, expectedSourceBranch);
  const worktreeCommit = await git(worktreePath, ["rev-parse", "HEAD"]);
  const sourceCommit = sourceBranchExists
    ? await git(repositoryRoot, ["rev-parse", expectedSourceBranch])
    : worktreeCommit;
  if (sourceCommit !== baseCommit && await isAncestor(repositoryRoot, sourceCommit, targetBranch)) {
    throw new Error("候选交付已经合并到目标分支，拒绝丢弃");
  }

  const removal = await runGit(repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
  if (removal.code !== 0) {
    throw new Error(removal.stderr.trim() || removal.stdout.trim() || "清理候选 worktree 失败");
  }
  await git(repositoryRoot, ["worktree", "prune"]);
  if (sourceBranchExists) {
    const deleted = await runGit(repositoryRoot, ["branch", "-D", expectedSourceBranch]);
    if (deleted.code !== 0) {
      throw new Error(deleted.stderr.trim() || deleted.stdout.trim() || "清理本 Run 的交付分支失败");
    }
  }
  try {
    await fs.access(worktreePath);
    throw new Error("候选 worktree 清理后仍然存在");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (await branchExists(repositoryRoot, expectedSourceBranch)) {
    throw new Error("本 Run 的交付分支清理后仍然存在");
  }

  const timestamp = new Date().toISOString();
  const record: RunDeliveryRecord = {
    ...existing,
    runId: run.id,
    status: "discarded",
    updatedAt: timestamp,
    baseCommit,
    ...(sourceBranchExists ? { sourceBranch: expectedSourceBranch } : {}),
    sourceCommit,
    targetBranch,
    message: "人工二次确认后已清理候选 worktree 与未合并的本 Run 交付分支；未修改 run.json。",
    humanDecision: {
      action: "discard",
      actor,
      at: timestamp,
      ...(input.note?.trim() ? { note: input.note.trim() } : {})
    }
  };
  await writeRunDelivery(runDir, record);
  return { status: "discarded", delivery: record };
}
