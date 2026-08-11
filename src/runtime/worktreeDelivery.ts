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
  worktreePath?: string;
  repositoryRoot?: string;
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
  } = {}
): Promise<RunDeliveryRecord> {
  return updateRunDelivery(runDir, runId, (current) => ({
    ...current,
    runId,
    status,
    updatedAt: new Date().toISOString(),
    ...(input.message !== undefined ? { message: input.message.slice(0, 8_000) } : {}),
    ...(input.mergeValidation ? { mergeValidation: input.mergeValidation } : {})
  }));
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
  baseCommit?: string
): Promise<{ text: string; truncated: boolean; maxBytes: number }> {
  const tracked = await runGit(worktreePath, [
    "diff", "--no-ext-diff", "--no-color", "--unified=3", baseCommit ?? "HEAD", "--"
  ]);
  if (tracked.code !== 0) {
    throw new Error(tracked.stderr.trim() || tracked.stdout.trim() || "git diff failed");
  }
  const chunks = [tracked.stdout];
  let truncated = false;
  const untracked = (await git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  for (const file of untracked.slice(0, MAX_UNTRACKED_DIFF_FILES)) {
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

  if (run.status !== "passed") reasons.push("Run 尚未通过，不能进入合并验收。");
  if (!gatesPassed) reasons.push("一个或多个 required Gate 尚未通过；acceptedVerdict 不能替代 Gate。");
  if (!qualityTestPassed) reasons.push("缺少通过的 before-completion required quality.test Gate。");
  if (!qualityAuditPassed) reasons.push("缺少通过的 before-completion required quality.audit Gate。");
  if (assets.length === 0 && structured.e2eCount === 0) reasons.push("缺少截图、录屏或结构化 E2E 验收证据。");
  if (delivery?.status === "merged") reasons.push("该交付已经合并。");
  if (delivery?.status === "discarded") reasons.push("该交付已经丢弃，不能再次交付。");

  let repositoryRoot: string | undefined;
  let targetBranch: string | undefined;
  let targetClean = false;
  let changes: Array<{ status: string; path: string }> = [];
  let summary = "";
  let unifiedDiff = { text: "", truncated: false, maxBytes: MAX_UNIFIED_DIFF_BYTES };
  let safeGitCommands: string[] = [];
  const worktreePath = run.isolation?.mode === "worktree" ? run.isolation.worktreePath : undefined;
  if (!worktreePath) {
    reasons.push("该 Run 没有可交付的 worktree。");
  } else if (delivery?.status !== "merged" && delivery?.status !== "discarded") {
    try {
      repositoryRoot = await registeredRepositoryRoot(worktreePath, run.id);
      targetBranch = await git(repositoryRoot, ["branch", "--show-current"]);
      if (!targetBranch) reasons.push("目标仓库当前不在命名分支上。");
      const targetStatus = await git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
      targetClean = targetStatus.length === 0;
      if (!targetClean) reasons.push("目标仓库存在未提交改动，请先处理后再合并。");
      const baseCommit = delivery?.baseCommit ?? run.isolation?.baseCommit;
      safeGitCommands = safeGitInspectionCommands(repositoryRoot, worktreePath, baseCommit);
      const workingChanges = parsePorcelain(
        await git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"])
      );
      const committedChanges = baseCommit
        ? (await git(worktreePath, ["diff", "--name-status", baseCommit, "HEAD", "--"]))
          .split("\n").filter(Boolean).map((line) => {
          const [status = "?", ...parts] = line.split("\t");
          return { status, path: parts.at(-1) ?? "" };
        })
        : [];
      const changesByPath = new Map(committedChanges.map((change) => [change.path, change]));
      for (const change of workingChanges) changesByPath.set(change.path, change);
      changes = [...changesByPath.values()];
      summary = baseCommit
        ? await git(worktreePath, ["diff", "--stat", baseCommit, "HEAD", "--"])
        : await git(worktreePath, ["diff", "--stat", "HEAD", "--"]);
      if (workingChanges.length > 0) {
        summary = [summary, `${workingChanges.length} 个未提交或未跟踪文件`].filter(Boolean).join("\n");
      }
      unifiedDiff = await readUnifiedDiff(worktreePath, baseCommit);
      if (changes.length === 0) reasons.push("worktree 没有可合并的代码变更。");
    } catch (error) {
      reasons.push(`worktree 不可用：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const status = delivery?.status ?? (reasons.length === 0 ? "awaiting-acceptance" : "not-ready");
  return {
    runId: run.id,
    status,
    eligible: reasons.length === 0,
    reasons,
    ...(worktreePath ? { worktreePath } : {}),
    ...(repositoryRoot ? { repositoryRoot } : {}),
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
    if (run.isolation?.baseCommit && delivery.baseCommit !== run.isolation.baseCommit) {
      throw new Error("交付记录的 worktree 基线与当前 Run 不匹配");
    }
    const [currentSourceBranch, currentSourceCommit] = await Promise.all([
      git(preview.worktreePath, ["branch", "--show-current"]),
      git(preview.worktreePath, ["rev-parse", "HEAD"])
    ]);
    if (currentSourceBranch !== expectedSourceBranch || currentSourceCommit !== delivery.sourceCommit) {
      throw new Error("交付记录的源分支或 commit 已变化，请重新核对 worktree");
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
    targetChanged: current.commit !== delivery.queuedTargetCommit,
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
