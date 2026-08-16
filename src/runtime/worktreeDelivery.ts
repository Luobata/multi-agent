import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
export type ConflictRetestFailure = "environment-blocked" | "evidence-incomplete" | "product-failed";

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
    testedSourceCommit?: string;
    testedCandidateRevision?: string;
    testedUrl?: string;
    failureClass?: ConflictRetestFailure;
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

export type DeliveryOutcome = "merged" | "not-merged" | "unknown";

export type DeliveryMissingReason =
  | "delivery-absent"
  | "delivery-corrupt"
  | "worktree-missing"
  | "worktree-unregistered";

export interface DeliveryRecoveryEvidence {
  kind: "unverified-discard" | "attention";
  reason: DeliveryMissingReason | "discard-cleanup-incomplete" | "merge-reconciliation-required";
  actor: string;
  at: string;
  note?: string;
  fingerprint: string;
  rawSha256?: `sha256:${string}`;
  archivePath?: string;
  detail?: string;
}

export interface DeliveryCleanupEvidence {
  checkedAt: string;
  worktree: "removed" | "missing" | "unregistered" | "present" | "unknown";
  sourceBranch: "removed" | "missing" | "present" | "unknown";
  detail?: string;
}

export interface DeliveryDispatch {
  state: "ready" | "leased" | "waiting" | "settled";
  attempt: number;
  queueKey: `sha256:${string}`;
  order: { approvedAt: string; runId: string };
  lease?: {
    id: string;
    ownerEpoch: string;
    fencingToken: number;
    acquiredAt: string;
    heartbeatAt: string;
    expiresAt: string;
  };
  lastFailure?: { at: string; code: string; message: string };
}

export interface DeliverySideEffects {
  discard?: {
    intentId: string;
    requestedBy: string;
    requestedAt: string;
    expectedSourceCommit?: string;
    phase: "prepared" | "cleanup-complete";
  };
  merge?: {
    intentId: string;
    targetRef: string;
    expectedTargetCommit: string;
    sourceCommit: string;
    preparedMergeCommit: string;
    phase: "prepared" | "ref-updated" | "worktree-synchronized";
  };
}

export interface DeliveryEventRef {
  id: string;
  type: DeliveryEvent["type"];
  actor: string;
  at: string;
  fromRevision: number;
  toRevision: number;
  leaseId?: string;
}

export interface RunDeliveryRecordV2 extends RunDeliveryRecord {
  schemaVersion: 2;
  revision: number;
  cleanupVerified?: boolean;
  cleanup?: DeliveryCleanupEvidence;
  outcome?: DeliveryOutcome;
  recovery?: DeliveryRecoveryEvidence;
  dispatch?: DeliveryDispatch;
  sideEffects?: DeliverySideEffects;
  lastEvent: DeliveryEventRef;
}

export type DeliveryReadResult =
  | { kind: "absent"; revision: 0 }
  | { kind: "valid"; revision: number; record: RunDeliveryRecordV2 }
  | { kind: "corrupt"; revision: number; rawSha256: `sha256:${string}`; reason: string };

export type DeliveryStateSelector =
  | { kind: "absent" }
  | { kind: "corrupt"; rawSha256: `sha256:${string}` }
  | {
      kind: "record";
      status: DeliveryStatus;
      conflictStatus?: ConflictResolutionStatus;
      dispatchState?: DeliveryDispatch["state"];
      leaseId?: string;
    };

interface DeliveryEventBase<T extends string, P> {
  type: T;
  actor: string;
  payload: P;
}

interface DeliveryStagePayload {
  message: string;
  leaseId?: string;
}

export type DeliveryEvent =
  | DeliveryEventBase<"source.prepared", {
      baseCommit: string;
      sourceBranch: string;
      sourceCommit: string;
      targetBranch: string;
      targetCommitBeforeMerge: string;
      message?: string;
    }>
  | DeliveryEventBase<"merge.approved", {
      targetBranch: string;
      queuedTargetCommit: string;
      queueKey?: `sha256:${string}`;
      message: string;
    }>
  | DeliveryEventBase<"dispatch.ready", {
      queueKey: `sha256:${string}`;
      approvedAt: string;
      message: string;
    }>
  | DeliveryEventBase<"dispatch.claimed", {
      queueKey: `sha256:${string}`;
      approvedAt: string;
      leaseId: string;
      ownerEpoch: string;
      fencingToken: number;
      expiresAt: string;
    }>
  | DeliveryEventBase<"dispatch.heartbeat", { leaseId: string; expiresAt: string }>
  | DeliveryEventBase<"dispatch.failed", { leaseId: string; code: string; message: string }>
  | DeliveryEventBase<"conflict.started", DeliveryStagePayload & {
      targetCommit: string;
      conflictMessage?: string;
      targetBranch?: string;
      targetCommitBeforeMerge?: string;
      retry?: "rebase" | "retest";
    }>
  | DeliveryEventBase<"conflict.stage-completed", DeliveryStagePayload & (
      | { stage: "planned"; leaderPlanRunId: string; executionRoleId: string; detailMessage?: string }
      | { stage: "executed"; leaderPlanRunId: string; executionRoleId: string; resolutionRunId?: string; detailMessage?: string }
      | { stage: "rebased"; targetCommit: string; sourceCommit: string }
      | {
          stage: "tested";
          testRunId: string;
          testedSourceCommit: string;
          testedCandidateRevision: string;
          testedUrl: string;
          detailMessage?: string;
        }
      | { stage: "leader-approved"; leaderReviewRunId: string; detailMessage?: string }
    )>
  | DeliveryEventBase<"conflict.failed", DeliveryStagePayload & {
      targetCommit: string;
      failureClass: ConflictRetestFailure;
      detailMessage?: string;
    }>
  | DeliveryEventBase<"validation.started", DeliveryStagePayload & {
      targetCommit?: string;
      retryAfterTargetDrift?: boolean;
    }>
  | DeliveryEventBase<"validation.passed", DeliveryStagePayload & {
      required: boolean;
      targetCommit: string;
      runId?: string;
    }>
  | DeliveryEventBase<"validation.failed", DeliveryStagePayload & {
      targetCommit?: string;
      runId?: string;
    }>
  | DeliveryEventBase<"merge.intent-prepared", DeliveryStagePayload & {
      intentId: string;
      targetRef: string;
      expectedTargetCommit: string;
      sourceCommit: string;
      preparedMergeCommit: string;
    }>
  | DeliveryEventBase<"merge.ref-updated", DeliveryStagePayload & { intentId: string }>
  | DeliveryEventBase<"merge.completed", DeliveryStagePayload & {
      intentId: string;
      targetBranch: string;
      targetCommitBeforeMerge: string;
      mergeCommit: string;
    }>
  | DeliveryEventBase<"keep.recorded", {
      baseCommit: string;
      targetBranch: string;
      note?: string;
      message: string;
    }>
  | DeliveryEventBase<"discard.intent-prepared", {
      intentId: string;
      baseCommit: string;
      sourceBranch?: string;
      sourceCommit: string;
      targetBranch: string;
      note?: string;
      message: string;
    }>
  | DeliveryEventBase<"discard.completed", { intentId: string; message: string }>
  | DeliveryEventBase<"discard.unverified", {
      reason: DeliveryMissingReason;
      fingerprint: string;
      outcome: DeliveryOutcome;
      cleanup: DeliveryCleanupEvidence;
      note?: string;
      rawSha256?: `sha256:${string}`;
      archivePath?: string;
      baseCommit?: string;
      sourceBranch?: string;
      sourceCommit?: string;
      targetBranch?: string;
      message: string;
    }>
  | DeliveryEventBase<"evidence.queued" | "evidence.running" | "evidence.completed", {
      evidenceRerun: NonNullable<RunDeliveryRecord["evidenceRerun"]>;
    }>
  | DeliveryEventBase<"terminal.outcome-adjudicated", { outcome: DeliveryOutcome; message: string }>;

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
  delivery?: RunDeliveryRecordV2;
  recoveryRequired?: {
    reason: string;
    fingerprint: string;
    rawSha256?: `sha256:${string}`;
  };
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
  delivery: RunDeliveryRecordV2;
}

export interface RunMergeQueueResult {
  status: "queued-for-merge" | "retesting" | "conflict";
  delivery: RunDeliveryRecordV2;
}

export class TargetChangedAfterValidationError extends Error {
  constructor() {
    super("目标分支 commit 在验证后再次变化，禁止合入未经测试的新组合");
    this.name = "TargetChangedAfterValidationError";
  }
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
  delivery: RunDeliveryRecordV2;
}

export interface UnverifiedDiscardInput {
  confirmation: string;
  actor: string;
  reason: DeliveryMissingReason;
  note?: string;
  expectedRevision: number;
  expectedRawSha256?: `sha256:${string}`;
}

export interface LocalOwnerPrincipal {
  kind: "local-owner";
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

const DELIVERY_REVISIONS_DIRECTORY = "delivery-revisions";
const SNAPSHOT_NAME = /^([0-9]{20})\.json$/;
const DELIVERY_STATUSES = new Set<DeliveryStatus>([
  "awaiting-acceptance",
  "queued-for-merge",
  "retesting",
  "merging",
  "returned-to-acceptance",
  "conflict",
  "merged",
  "kept",
  "discarded"
]);
const TERMINAL_DELIVERY_STATUSES = new Set<DeliveryStatus>(["merged", "discarded"]);
const BUSY_DELIVERY_EVENTS = new Set<DeliveryEvent["type"]>([
  "conflict.started",
  "conflict.stage-completed",
  "conflict.failed",
  "validation.started",
  "validation.passed",
  "validation.failed",
  "merge.intent-prepared",
  "merge.ref-updated",
  "merge.completed"
]);

type PersistedDeliveryEvent = DeliveryEvent & {
  id: string;
  at: string;
  fromRevision: number;
  toRevision: number;
};

interface DeliveryRevisionSnapshot {
  schemaVersion: 2;
  revision: number;
  record: RunDeliveryRecordV2;
  event: PersistedDeliveryEvent;
}

export class DeliveryRevisionConflict extends Error {
  constructor(
    readonly runId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`delivery revision conflict for ${runId}: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "DeliveryRevisionConflict";
  }
}

export class DeliveryTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryTransitionError";
  }
}

export class DeliveryCorruptError extends Error {
  constructor(readonly result: Extract<DeliveryReadResult, { kind: "corrupt" }>) {
    super(`delivery record is corrupt: ${result.reason}`);
    this.name = "DeliveryCorruptError";
  }
}

export class DeliveryRecoveryConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryRecoveryConflict";
  }
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function deliveryReadFingerprint(read: DeliveryReadResult): string {
  if (read.kind === "absent") return "absent";
  const digest = read.kind === "corrupt" ? read.rawSha256 : sha256(JSON.stringify(read.record));
  return digest.slice("sha256:".length, "sha256:".length + 16);
}

export function deliveryQueueKey(repositoryRoot: string, targetBranch: string): `sha256:${string}` {
  return sha256(`${path.resolve(repositoryRoot)}\0${targetBranch}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function legacyAsV2(record: RunDeliveryRecord, digest: `sha256:${string}`): RunDeliveryRecordV2 {
  return {
    ...record,
    schemaVersion: 2,
    revision: 0,
    lastEvent: {
      id: `legacy:${digest.slice("sha256:".length, "sha256:".length + 20)}`,
      type: "source.prepared",
      actor: "runtime",
      at: record.updatedAt,
      fromRevision: 0,
      toRevision: 0
    }
  };
}

function validateDeliveryRecord(
  value: unknown,
  runId: string
): { valid: true; record: RunDeliveryRecordV2; legacy: boolean } | { valid: false; reason: string } {
  if (!isRecord(value)) return { valid: false, reason: "delivery JSON root is not an object" };
  if (value.runId !== runId) return { valid: false, reason: "delivery runId does not match its run directory" };
  if (typeof value.status !== "string" || !DELIVERY_STATUSES.has(value.status as DeliveryStatus)) {
    return { valid: false, reason: "delivery status is invalid" };
  }
  if (typeof value.updatedAt !== "string" || !value.updatedAt.trim()) {
    return { valid: false, reason: "delivery updatedAt is invalid" };
  }
  const hasSchemaVersion = Object.hasOwn(value, "schemaVersion");
  const hasRevision = Object.hasOwn(value, "revision");
  const hasLastEvent = Object.hasOwn(value, "lastEvent");
  if (!hasSchemaVersion && !hasRevision && !hasLastEvent) {
    const serialized = JSON.stringify(value);
    return { valid: true, record: legacyAsV2(value as unknown as RunDeliveryRecord, sha256(serialized)), legacy: true };
  }
  if (value.schemaVersion !== 2 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    return { valid: false, reason: "delivery schemaVersion/revision is invalid" };
  }
  if (!isRecord(value.lastEvent)
    || typeof value.lastEvent.id !== "string"
    || typeof value.lastEvent.type !== "string"
    || typeof value.lastEvent.actor !== "string"
    || typeof value.lastEvent.at !== "string"
    || value.lastEvent.fromRevision !== (value.revision as number) - 1
    || value.lastEvent.toRevision !== value.revision) {
    return { valid: false, reason: "delivery lastEvent does not match revision" };
  }
  if (value.cleanupVerified !== undefined && typeof value.cleanupVerified !== "boolean") {
    return { valid: false, reason: "delivery cleanupVerified is invalid" };
  }
  if (value.outcome !== undefined && !["merged", "not-merged", "unknown"].includes(String(value.outcome))) {
    return { valid: false, reason: "delivery outcome is invalid" };
  }
  if (value.dispatch !== undefined) {
    if (!isRecord(value.dispatch)
      || !["ready", "leased", "waiting", "settled"].includes(String(value.dispatch.state))
      || !Number.isSafeInteger(value.dispatch.attempt)
      || (value.dispatch.attempt as number) < 0
      || typeof value.dispatch.queueKey !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(value.dispatch.queueKey)
      || !isRecord(value.dispatch.order)
      || typeof value.dispatch.order.approvedAt !== "string"
      || value.dispatch.order.runId !== runId) {
      return { valid: false, reason: "delivery dispatch is invalid" };
    }
    if (value.dispatch.state === "leased"
      && (!isRecord(value.dispatch.lease)
        || typeof value.dispatch.lease.id !== "string"
        || typeof value.dispatch.lease.ownerEpoch !== "string"
        || !Number.isSafeInteger(value.dispatch.lease.fencingToken)
        || typeof value.dispatch.lease.expiresAt !== "string")) {
      return { valid: false, reason: "delivery leased dispatch is invalid" };
    }
  }
  return { valid: true, record: value as unknown as RunDeliveryRecordV2, legacy: false };
}

async function readTextIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readBufferIfPresent(filePath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function revisionFileName(revision: number): string {
  return `${String(revision).padStart(20, "0")}.json`;
}

async function highestSnapshotPath(runDir: string): Promise<string | undefined> {
  const directory = path.join(runDir, DELIVERY_REVISIONS_DIRECTORY);
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const latest = entries.filter((entry) => SNAPSHOT_NAME.test(entry)).sort().at(-1);
  return latest ? path.join(directory, latest) : undefined;
}

function validateSnapshot(raw: string, runId: string, filePath: string): DeliveryReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: "corrupt",
      revision: Number(path.basename(filePath).slice(0, 20)) || 0,
      rawSha256: sha256(raw),
      reason: `delivery snapshot JSON is invalid: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 2 || !Number.isSafeInteger(parsed.revision)) {
    return { kind: "corrupt", revision: 0, rawSha256: sha256(raw), reason: "delivery snapshot envelope is invalid" };
  }
  const revision = parsed.revision as number;
  if (path.basename(filePath) !== revisionFileName(revision)) {
    return { kind: "corrupt", revision, rawSha256: sha256(raw), reason: "delivery snapshot filename does not match revision" };
  }
  const validated = validateDeliveryRecord(parsed.record, runId);
  if (!validated.valid || validated.legacy || validated.record.revision !== revision) {
    return {
      kind: "corrupt",
      revision,
      rawSha256: sha256(raw),
      reason: validated.valid ? "delivery snapshot record revision is invalid" : validated.reason
    };
  }
  if (!isRecord(parsed.event)
    || parsed.event.id !== validated.record.lastEvent.id
    || parsed.event.type !== validated.record.lastEvent.type
    || parsed.event.actor !== validated.record.lastEvent.actor
    || parsed.event.at !== validated.record.lastEvent.at
    || parsed.event.fromRevision !== revision - 1
    || parsed.event.toRevision !== revision) {
    return { kind: "corrupt", revision, rawSha256: sha256(raw), reason: "delivery snapshot event does not match record" };
  }
  return { kind: "valid", revision, record: validated.record };
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

async function writeSyncedFile(filePath: string, value: string): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceProjection(runDir: string, record: RunDeliveryRecordV2): Promise<void> {
  const destination = deliveryPath(runDir);
  const temporary = path.join(runDir, `.${DELIVERY_FILE}.${randomUUID()}.tmp`);
  try {
    await writeSyncedFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await fs.rename(temporary, destination);
    await fsyncDirectory(runDir);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

const deliveryMutexTails = new Map<string, Promise<void>>();

async function withDeliveryMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = deliveryMutexTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  deliveryMutexTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (deliveryMutexTails.get(key) === tail) deliveryMutexTails.delete(key);
  }
}

function eventLeaseId(event: DeliveryEvent): string | undefined {
  return "leaseId" in event.payload && typeof event.payload.leaseId === "string"
    ? event.payload.leaseId
    : undefined;
}

function selectorMatches(
  selector: DeliveryStateSelector,
  read: DeliveryReadResult,
  current: RunDeliveryRecordV2 | undefined
): boolean {
  if (selector.kind === "absent") return read.kind === "absent";
  if (selector.kind === "corrupt") {
    return read.kind === "corrupt"
      && read.revision === 0
      && read.rawSha256 === selector.rawSha256;
  }
  if (!current || current.status !== selector.status) return false;
  if (selector.conflictStatus !== undefined && current.conflictResolution?.status !== selector.conflictStatus) return false;
  if (selector.dispatchState !== undefined && current.dispatch?.state !== selector.dispatchState) return false;
  if (selector.leaseId !== undefined && current.dispatch?.lease?.id !== selector.leaseId) return false;
  return true;
}

function eventPolicyAllows(current: RunDeliveryRecordV2 | undefined, event: DeliveryEvent): boolean {
  const status = current?.status;
  const conflictStatus = current?.conflictResolution?.status;
  switch (event.type) {
    case "source.prepared":
      return current === undefined || ["awaiting-acceptance", "kept", "returned-to-acceptance"].includes(status ?? "")
        || (status === "conflict" && conflictStatus === "failed");
    case "merge.approved":
      return ["awaiting-acceptance", "kept", "returned-to-acceptance"].includes(status ?? "")
        || (status === "conflict" && conflictStatus === "failed");
    case "dispatch.ready":
      return Boolean(current
        && !TERMINAL_DELIVERY_STATUSES.has(current.status)
        && current.humanDecision?.action === "merge"
        && (!current.dispatch || current.dispatch.state === "waiting" || current.dispatch.state === "ready"));
    case "keep.recorded":
      return current === undefined || ["awaiting-acceptance", "returned-to-acceptance"].includes(status ?? "")
        || (status === "conflict" && conflictStatus === "failed");
    case "discard.intent-prepared":
      return current === undefined || ["awaiting-acceptance", "returned-to-acceptance", "kept"].includes(status ?? "")
        || (status === "conflict" && conflictStatus === "failed");
    case "discard.completed":
      return Boolean(current?.sideEffects?.discard?.phase === "prepared"
        && current.sideEffects.discard.intentId === event.payload.intentId);
    case "discard.unverified":
      return current === undefined || !TERMINAL_DELIVERY_STATUSES.has(current.status);
    case "evidence.queued":
      return current === undefined || ["awaiting-acceptance", "returned-to-acceptance", "kept"].includes(status ?? "")
        || (status === "conflict" && conflictStatus === "failed");
    case "evidence.running":
      return current?.evidenceRerun?.status === "queued";
    case "evidence.completed":
      return current?.evidenceRerun?.status === "queued" || current?.evidenceRerun?.status === "running";
    case "conflict.started":
      return event.payload.retry
        ? status === "conflict" && conflictStatus === "failed"
        : ["queued-for-merge", "merging"].includes(status ?? "");
    case "conflict.stage-completed":
      if (["planned", "executed", "rebased"].includes(event.payload.stage)) {
        return status === "conflict" && conflictStatus === "resolving";
      }
      if (event.payload.stage === "tested") {
        return status === "retesting" && conflictStatus === "retesting"
          && event.payload.testedSourceCommit === current?.sourceCommit;
      }
      return status === "retesting" && conflictStatus === "leader-review"
        && Boolean(current?.conflictResolution?.testRunId)
        && Boolean(current?.sourceCommit)
        && current?.conflictResolution?.testedSourceCommit === current?.sourceCommit;
    case "conflict.failed":
      return ["conflict", "retesting", "merging"].includes(status ?? "")
        && Boolean(current?.conflictResolution);
    case "validation.started":
      return ["queued-for-merge", "retesting", "merging"].includes(status ?? "");
    case "validation.passed":
      return event.payload.required
        ? ["queued-for-merge", "retesting"].includes(status ?? "")
          && current?.mergeValidation?.status === "running"
          && current.mergeValidation.targetCommit === event.payload.targetCommit
        : status === "queued-for-merge";
    case "validation.failed":
      return ["queued-for-merge", "retesting", "merging"].includes(status ?? "")
        || (status === "conflict" && !current?.conflictResolution);
    case "merge.intent-prepared":
      return status === "merging"
        && !current?.sideEffects?.merge
        && current?.sourceCommit === event.payload.sourceCommit
        && current.mergeValidation?.targetCommit === event.payload.expectedTargetCommit
        && ["passed", "not-required"].includes(current.mergeValidation.status);
    case "merge.ref-updated":
      return status === "merging"
        && current?.sideEffects?.merge?.phase === "prepared"
        && current.sideEffects.merge.intentId === event.payload.intentId;
    case "merge.completed":
      return status === "merging"
        && current?.sideEffects?.merge?.phase === "ref-updated"
        && current.sideEffects.merge.intentId === event.payload.intentId;
    case "dispatch.claimed":
      return Boolean(current && !TERMINAL_DELIVERY_STATUSES.has(current.status)
        && (!current.dispatch || current.dispatch.state === "ready" || current.dispatch.state === "waiting"));
    case "dispatch.heartbeat":
    case "dispatch.failed":
      return current?.dispatch?.state === "leased" && current.dispatch.lease?.id === event.payload.leaseId;
    case "terminal.outcome-adjudicated":
      return Boolean(current
        && TERMINAL_DELIVERY_STATUSES.has(current.status)
        && (current.outcome === undefined
          || current.outcome === "unknown"
          || current.outcome === event.payload.outcome
          || (current.status === "discarded" && event.payload.outcome === "merged")));
  }
}

function assertReducerPreconditions(current: RunDeliveryRecordV2 | undefined, event: DeliveryEvent): void {
  if (current && TERMINAL_DELIVERY_STATUSES.has(current.status) && event.type !== "terminal.outcome-adjudicated") {
    throw new DeliveryTransitionError(`terminal delivery ${current.status} cannot process ${event.type}`);
  }
  if (current?.sideEffects?.discard?.phase === "prepared"
    && event.type !== "discard.completed"
    && event.type !== "discard.unverified"
    && event.type !== "dispatch.claimed"
    && event.type !== "dispatch.heartbeat"
    && event.type !== "dispatch.failed") {
    throw new DeliveryTransitionError("delivery has an active discard intent");
  }
  if (current?.sideEffects?.merge
    && current.sideEffects.merge.phase !== "worktree-synchronized"
    && !["merge.ref-updated", "merge.completed", "dispatch.claimed", "dispatch.heartbeat", "dispatch.failed"].includes(event.type)
    && !(event.type === "validation.started" && event.payload.retryAfterTargetDrift)) {
    throw new DeliveryTransitionError("delivery has an active merge intent");
  }
  if (BUSY_DELIVERY_EVENTS.has(event.type) && current?.dispatch?.state === "leased") {
    if (eventLeaseId(event) !== current.dispatch.lease?.id) {
      throw new DeliveryTransitionError("busy delivery event does not match the active leaseId");
    }
  }
  if (!eventPolicyAllows(current, event)) {
    throw new DeliveryTransitionError(`event ${event.type} is not allowed from ${current?.status ?? "absent"}`);
  }
}

function requireConflictResolution(current: RunDeliveryRecordV2): NonNullable<RunDeliveryRecord["conflictResolution"]> {
  if (!current.conflictResolution) throw new DeliveryTransitionError("delivery conflict event requires conflictResolution");
  return current.conflictResolution;
}

function reduceDelivery(
  runId: string,
  current: RunDeliveryRecordV2 | undefined,
  event: PersistedDeliveryEvent
): RunDeliveryRecordV2 {
  assertReducerPreconditions(current, event);
  const lastEvent: DeliveryEventRef = {
    id: event.id,
    type: event.type,
    actor: event.actor,
    at: event.at,
    fromRevision: event.fromRevision,
    toRevision: event.toRevision,
    ...(eventLeaseId(event) ? { leaseId: eventLeaseId(event) } : {})
  };
  let next: RunDeliveryRecordV2 = {
    ...(current ?? { runId, status: "awaiting-acceptance" as const, updatedAt: event.at }),
    schemaVersion: 2,
    revision: event.toRevision,
    updatedAt: event.at,
    lastEvent
  };
  const message = "message" in event.payload && typeof event.payload.message === "string"
    ? event.payload.message.slice(0, 8_000)
    : undefined;
  switch (event.type) {
    case "source.prepared":
      next = {
        ...next,
        baseCommit: event.payload.baseCommit,
        sourceBranch: event.payload.sourceBranch,
        sourceCommit: event.payload.sourceCommit,
        targetBranch: event.payload.targetBranch,
        targetCommitBeforeMerge: current?.targetCommitBeforeMerge ?? event.payload.targetCommitBeforeMerge,
        ...(message ? { message } : {})
      };
      break;
    case "merge.approved":
      next = {
        ...next,
        status: "queued-for-merge",
        targetBranch: event.payload.targetBranch,
        queuedTargetCommit: event.payload.queuedTargetCommit,
        message,
        conflictResolution: undefined,
        mergeValidation: undefined,
        humanDecision: { action: "merge", actor: event.actor, at: event.at },
        ...(event.payload.queueKey ? {
          dispatch: {
            state: "ready",
            attempt: current?.dispatch?.attempt ?? 0,
            queueKey: event.payload.queueKey,
            order: { approvedAt: event.at, runId }
          }
        } : {})
      };
      break;
    case "dispatch.ready":
      next = {
        ...next,
        message,
        dispatch: {
          state: "ready",
          attempt: current?.dispatch?.attempt ?? 0,
          queueKey: event.payload.queueKey,
          order: { approvedAt: event.payload.approvedAt, runId },
          ...(current?.dispatch?.lastFailure ? { lastFailure: current.dispatch.lastFailure } : {})
        }
      };
      break;
    case "dispatch.claimed": {
      const previousAttempt = current?.dispatch?.attempt ?? 0;
      next = {
        ...next,
        dispatch: {
          state: "leased",
          attempt: previousAttempt + 1,
          queueKey: event.payload.queueKey,
          order: { approvedAt: event.payload.approvedAt, runId },
          lease: {
            id: event.payload.leaseId,
            ownerEpoch: event.payload.ownerEpoch,
            fencingToken: event.payload.fencingToken,
            acquiredAt: event.at,
            heartbeatAt: event.at,
            expiresAt: event.payload.expiresAt
          }
        }
      };
      break;
    }
    case "dispatch.heartbeat":
      next = {
        ...next,
        dispatch: {
          ...current!.dispatch!,
          lease: { ...current!.dispatch!.lease!, heartbeatAt: event.at, expiresAt: event.payload.expiresAt }
        }
      };
      break;
    case "dispatch.failed":
      next = {
        ...next,
        dispatch: {
          ...current!.dispatch!,
          state: "waiting",
          lease: undefined,
          lastFailure: { at: event.at, code: event.payload.code, message: event.payload.message.slice(0, 8_000) }
        }
      };
      break;
    case "conflict.started": {
      if (event.payload.retry) {
        const resolution = requireConflictResolution(current!);
        const rebased = event.payload.retry === "retest";
        next = {
          ...next,
          status: rebased ? "retesting" : "conflict",
          message,
          conflictResolution: {
            ...resolution,
            status: rebased ? "retesting" : "resolving",
            updatedAt: event.at,
            failureClass: undefined,
            testRunId: undefined,
            testedSourceCommit: undefined,
            testedCandidateRevision: undefined,
            testedUrl: undefined,
            leaderReviewRunId: undefined,
            message
          },
          mergeValidation: {
            required: true,
            status: "running",
            targetCommit: resolution.targetCommit,
            message: "上一轮合入验证证据已失效，等待重新验证。",
            updatedAt: event.at
          },
          ...(current?.dispatch ? {
            dispatch: {
              ...current.dispatch,
              state: "ready",
              lease: undefined
            }
          } : {})
        };
      } else {
        next = {
          ...next,
          status: "conflict",
          ...(event.payload.targetBranch ? { targetBranch: event.payload.targetBranch } : {}),
          ...(event.payload.targetCommitBeforeMerge
            ? { targetCommitBeforeMerge: event.payload.targetCommitBeforeMerge }
            : {}),
          message,
          conflictResolution: {
            status: "resolving",
            targetCommit: event.payload.targetCommit,
            ...(event.payload.conflictMessage ? { conflictMessage: event.payload.conflictMessage } : {}),
            updatedAt: event.at,
            message
          }
        };
      }
      break;
    }
    case "conflict.stage-completed": {
      const resolution = requireConflictResolution(current!);
      switch (event.payload.stage) {
        case "planned":
          next = {
            ...next,
            status: "conflict",
            message,
            conflictResolution: {
              ...resolution,
              status: "resolving",
              leaderPlanRunId: event.payload.leaderPlanRunId,
              executionRoleId: event.payload.executionRoleId,
              updatedAt: event.at,
              message: event.payload.detailMessage ?? message
            }
          };
          break;
        case "executed":
          next = {
            ...next,
            status: "conflict",
            message,
            conflictResolution: {
              ...resolution,
              status: "resolving",
              leaderPlanRunId: event.payload.leaderPlanRunId,
              executionRoleId: event.payload.executionRoleId,
              ...(event.payload.resolutionRunId ? { resolutionRunId: event.payload.resolutionRunId } : {}),
              updatedAt: event.at,
              message: event.payload.detailMessage ?? message
            }
          };
          break;
        case "rebased":
          next = {
            ...next,
            status: "retesting",
            baseCommit: event.payload.targetCommit,
            sourceCommit: event.payload.sourceCommit,
            queuedTargetCommit: event.payload.targetCommit,
            targetCommitBeforeMerge: event.payload.targetCommit,
            message,
            conflictResolution: {
              ...resolution,
              status: "retesting",
              targetCommit: event.payload.targetCommit,
              updatedAt: event.at,
              message
            }
          };
          break;
        case "tested":
          next = {
            ...next,
            status: "retesting",
            message,
            conflictResolution: {
              ...resolution,
              status: "leader-review",
              testRunId: event.payload.testRunId,
              testedSourceCommit: event.payload.testedSourceCommit,
              testedCandidateRevision: event.payload.testedCandidateRevision,
              testedUrl: event.payload.testedUrl,
              failureClass: undefined,
              updatedAt: event.at,
              message: event.payload.detailMessage ?? message
            },
            mergeValidation: {
              required: true,
              status: "running",
              runId: event.payload.testRunId,
              targetCommit: resolution.targetCommit,
              message: event.payload.detailMessage ?? message,
              updatedAt: event.at
            }
          };
          break;
        case "leader-approved":
          next = {
            ...next,
            status: "merging",
            message,
            conflictResolution: {
              ...resolution,
              status: "passed",
              leaderReviewRunId: event.payload.leaderReviewRunId,
              updatedAt: event.at,
              message: event.payload.detailMessage ?? message
            },
            mergeValidation: {
              required: true,
              status: "passed",
              runId: resolution.testRunId,
              targetCommit: resolution.targetCommit,
              message: `独立测试与原领队复验通过：${event.payload.detailMessage ?? message}`,
              updatedAt: event.at
            }
          };
          break;
      }
      break;
    }
    case "conflict.failed": {
      const resolution = requireConflictResolution(current!);
      next = {
        ...next,
        status: "conflict",
        message,
        conflictResolution: {
          ...resolution,
          status: "failed",
          targetCommit: event.payload.targetCommit,
          failureClass: event.payload.failureClass,
          updatedAt: event.at,
          message: event.payload.detailMessage ?? message
        },
        mergeValidation: {
          required: true,
          status: "failed",
          targetCommit: event.payload.targetCommit,
          message: event.payload.detailMessage ?? message,
          updatedAt: event.at
        },
        ...(current?.dispatch ? { dispatch: { ...current.dispatch, state: "waiting", lease: undefined } } : {})
      };
      break;
    }
    case "validation.started":
      next = {
        ...next,
        status: event.payload.retryAfterTargetDrift ? "queued-for-merge" : "retesting",
        message,
        ...(event.payload.retryAfterTargetDrift && current?.sideEffects
          ? { sideEffects: { ...current.sideEffects, merge: undefined } }
          : {}),
        mergeValidation: {
          required: true,
          status: "running",
          ...(event.payload.targetCommit ? { targetCommit: event.payload.targetCommit } : {}),
          message,
          updatedAt: event.at
        }
      };
      break;
    case "validation.passed":
      next = {
        ...next,
        status: "merging",
        message,
        mergeValidation: {
          required: event.payload.required,
          status: event.payload.required ? "passed" : "not-required",
          ...(event.payload.runId ? { runId: event.payload.runId } : {}),
          targetCommit: event.payload.targetCommit,
          message,
          updatedAt: event.at
        }
      };
      break;
    case "validation.failed":
      next = {
        ...next,
        status: "returned-to-acceptance",
        message,
        mergeValidation: {
          required: true,
          status: "failed",
          ...(event.payload.runId ? { runId: event.payload.runId } : {}),
          ...(event.payload.targetCommit ? { targetCommit: event.payload.targetCommit } : {}),
          message,
          updatedAt: event.at
        },
        ...(current?.dispatch ? { dispatch: { ...current.dispatch, state: "waiting", lease: undefined } } : {})
      };
      break;
    case "merge.intent-prepared":
      next = {
        ...next,
        status: "merging",
        message,
        sideEffects: {
          ...current?.sideEffects,
          merge: {
            intentId: event.payload.intentId,
            targetRef: event.payload.targetRef,
            expectedTargetCommit: event.payload.expectedTargetCommit,
            sourceCommit: event.payload.sourceCommit,
            preparedMergeCommit: event.payload.preparedMergeCommit,
            phase: "prepared"
          }
        }
      };
      break;
    case "merge.ref-updated":
      next = {
        ...next,
        message,
        sideEffects: {
          ...current!.sideEffects,
          merge: { ...current!.sideEffects!.merge!, phase: "ref-updated" }
        }
      };
      break;
    case "merge.completed":
      next = {
        ...next,
        status: "merged",
        targetBranch: event.payload.targetBranch,
        targetCommitBeforeMerge: event.payload.targetCommitBeforeMerge,
        mergeCommit: event.payload.mergeCommit,
        message,
        outcome: "merged",
        ...(current?.dispatch ? { dispatch: { ...current.dispatch, state: "settled", lease: undefined } } : {}),
        sideEffects: {
          ...current!.sideEffects,
          merge: { ...current!.sideEffects!.merge!, phase: "worktree-synchronized" }
        }
      };
      break;
    case "keep.recorded":
      next = {
        ...next,
        status: "kept",
        baseCommit: event.payload.baseCommit,
        targetBranch: event.payload.targetBranch,
        message,
        humanDecision: {
          action: "keep",
          actor: event.actor,
          at: event.at,
          ...(event.payload.note ? { note: event.payload.note } : {})
        }
      };
      break;
    case "discard.intent-prepared":
      next = {
        ...next,
        baseCommit: event.payload.baseCommit,
        ...(event.payload.sourceBranch ? { sourceBranch: event.payload.sourceBranch } : {}),
        sourceCommit: event.payload.sourceCommit,
        targetBranch: event.payload.targetBranch,
        message,
        humanDecision: {
          action: "discard",
          actor: event.actor,
          at: event.at,
          ...(event.payload.note ? { note: event.payload.note } : {})
        },
        sideEffects: {
          ...current?.sideEffects,
          discard: {
            intentId: event.payload.intentId,
            requestedBy: event.actor,
            requestedAt: event.at,
            expectedSourceCommit: event.payload.sourceCommit,
            phase: "prepared"
          }
        }
      };
      break;
    case "discard.completed":
      next = {
        ...next,
        status: "discarded",
        message,
        cleanupVerified: true,
        cleanup: {
          checkedAt: event.at,
          worktree: "removed",
          sourceBranch: "removed"
        },
        outcome: "not-merged",
        ...(current?.dispatch ? { dispatch: { ...current.dispatch, state: "settled", lease: undefined } } : {}),
        sideEffects: {
          ...current!.sideEffects,
          discard: { ...current!.sideEffects!.discard!, phase: "cleanup-complete" }
        }
      };
      break;
    case "discard.unverified":
      next = {
        ...next,
        status: "discarded",
        ...(event.payload.baseCommit ? { baseCommit: event.payload.baseCommit } : {}),
        ...(event.payload.sourceBranch ? { sourceBranch: event.payload.sourceBranch } : {}),
        ...(event.payload.sourceCommit ? { sourceCommit: event.payload.sourceCommit } : {}),
        ...(event.payload.targetBranch ? { targetBranch: event.payload.targetBranch } : {}),
        message,
        cleanupVerified: false,
        cleanup: event.payload.cleanup,
        outcome: event.payload.outcome,
        recovery: {
          kind: "unverified-discard",
          reason: event.payload.reason,
          actor: event.actor,
          at: event.at,
          fingerprint: event.payload.fingerprint,
          ...(event.payload.note ? { note: event.payload.note } : {}),
          ...(event.payload.rawSha256 ? { rawSha256: event.payload.rawSha256 } : {}),
          ...(event.payload.archivePath ? { archivePath: event.payload.archivePath } : {})
        },
        humanDecision: {
          action: "discard",
          actor: event.actor,
          at: event.at,
          ...(event.payload.note ? { note: event.payload.note } : {})
        },
        ...(current?.dispatch ? { dispatch: { ...current.dispatch, state: "settled", lease: undefined } } : {})
      };
      break;
    case "evidence.queued":
    case "evidence.running":
    case "evidence.completed":
      next = { ...next, evidenceRerun: event.payload.evidenceRerun };
      break;
    case "terminal.outcome-adjudicated":
      next = { ...next, outcome: event.payload.outcome, message };
      break;
  }
  if (current && TERMINAL_DELIVERY_STATUSES.has(current.status) && next.status !== current.status) {
    throw new DeliveryTransitionError("terminal delivery status cannot regress");
  }
  return next;
}

function defaultAllowedFrom(event: DeliveryEvent): DeliveryStateSelector[] {
  if (event.type === "source.prepared" || event.type === "keep.recorded"
    || event.type === "discard.intent-prepared" || event.type === "evidence.queued") {
    return [
      { kind: "absent" },
      { kind: "record", status: "awaiting-acceptance" },
      { kind: "record", status: "returned-to-acceptance" },
      { kind: "record", status: "kept" },
      { kind: "record", status: "conflict", conflictStatus: "failed" }
    ];
  }
  if (event.type === "discard.unverified") {
    return [
      { kind: "absent" },
      { kind: "record", status: "awaiting-acceptance" },
      { kind: "record", status: "returned-to-acceptance" },
      { kind: "record", status: "kept" },
      { kind: "record", status: "queued-for-merge" },
      { kind: "record", status: "retesting" },
      { kind: "record", status: "merging" },
      { kind: "record", status: "conflict" }
    ];
  }
  return [...DELIVERY_STATUSES].map((status) => ({ kind: "record" as const, status }));
}

export interface RunDeliveryStoreOptions {
  afterSnapshotPublish?: (snapshot: DeliveryRevisionSnapshot) => void | Promise<void>;
}

export class RunDeliveryStore {
  private readonly runsRoot: string;

  constructor(runsRoot: string, private readonly options: RunDeliveryStoreOptions = {}) {
    this.runsRoot = path.resolve(runsRoot);
  }

  static forRunDirectory(runDir: string, runId: string, options: RunDeliveryStoreOptions = {}): RunDeliveryStore {
    assertRunId(runId);
    const resolved = path.resolve(runDir);
    if (path.basename(resolved) !== runId) {
      throw new Error("run directory must be the canonical runsRoot/runId path");
    }
    return new RunDeliveryStore(path.dirname(resolved), options);
  }

  private runDirectory(runId: string): string {
    assertRunId(runId);
    return path.join(this.runsRoot, runId);
  }

  async readDelivery(runId: string): Promise<DeliveryReadResult> {
    const runDir = this.runDirectory(runId);
    const snapshotPath = await highestSnapshotPath(runDir);
    if (snapshotPath) {
      const snapshotRaw = await fs.readFile(snapshotPath, "utf8");
      const snapshot = validateSnapshot(snapshotRaw, runId, snapshotPath);
      if (snapshot.kind !== "valid") return snapshot;
      const projectionBytes = await readBufferIfPresent(deliveryPath(runDir));
      if (projectionBytes === undefined) return snapshot;
      const projectionRaw = projectionBytes.toString("utf8");
      let projectionValue: unknown;
      try {
        projectionValue = JSON.parse(projectionRaw);
      } catch {
        return snapshot;
      }
      const projection = validateDeliveryRecord(projectionValue, runId);
      if (!projection.valid || projection.legacy || projection.record.revision < snapshot.revision) return snapshot;
      if (projection.record.revision > snapshot.revision) {
        return {
          kind: "corrupt",
          revision: projection.record.revision,
          rawSha256: sha256(projectionBytes),
          reason: "delivery projection is ahead of the highest immutable snapshot"
        };
      }
      if (!isDeepStrictEqual(projection.record, snapshot.record)) {
        return {
          kind: "corrupt",
          revision: snapshot.revision,
          rawSha256: sha256(projectionBytes),
          reason: "mixed-writer-detected: projection changed without a new immutable revision"
        };
      }
      return snapshot;
    }

    const projectionBytes = await readBufferIfPresent(deliveryPath(runDir));
    if (projectionBytes === undefined) return { kind: "absent", revision: 0 };
    const projectionRaw = projectionBytes.toString("utf8");
    let projectionValue: unknown;
    try {
      projectionValue = JSON.parse(projectionRaw);
    } catch (error) {
      return {
        kind: "corrupt",
        revision: 0,
        rawSha256: sha256(projectionBytes),
        reason: `delivery JSON is invalid: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    const projection = validateDeliveryRecord(projectionValue, runId);
    if (!projection.valid) {
      return { kind: "corrupt", revision: 0, rawSha256: sha256(projectionBytes), reason: projection.reason };
    }
    if (!projection.legacy) {
      return {
        kind: "corrupt",
        revision: projection.record.revision,
        rawSha256: sha256(projectionBytes),
        reason: "v2 delivery projection has no immutable revision snapshot"
      };
    }
    return { kind: "valid", revision: 0, record: projection.record };
  }

  async repairProjectionFromSnapshot(runId: string): Promise<boolean> {
    const runDir = this.runDirectory(runId);
    const snapshotPath = await highestSnapshotPath(runDir);
    if (!snapshotPath) return false;
    const snapshot = validateSnapshot(await fs.readFile(snapshotPath, "utf8"), runId, snapshotPath);
    if (snapshot.kind !== "valid") return false;
    const projectionBytes = await readBufferIfPresent(deliveryPath(runDir));
    if (projectionBytes) {
      try {
        const parsed = validateDeliveryRecord(JSON.parse(projectionBytes.toString("utf8")), runId);
        if (parsed.valid && !parsed.legacy) {
          if (parsed.record.revision === snapshot.revision && isDeepStrictEqual(parsed.record, snapshot.record)) return false;
          if (parsed.record.revision >= snapshot.revision) return false;
        }
      } catch {
        // Invalid projection JSON is repaired only from the already validated immutable snapshot.
      }
    }
    await replaceProjection(runDir, snapshot.record);
    return true;
  }

  async advanceDelivery(
    runId: string,
    expectedRevision: number,
    allowedFrom: readonly DeliveryStateSelector[],
    event: DeliveryEvent
  ): Promise<RunDeliveryRecordV2> {
    const runDir = this.runDirectory(runId);
    return withDeliveryMutex(runDir, async () => {
      const read = await this.readDelivery(runId);
      if (read.kind === "corrupt"
        && !(event.type === "discard.unverified" && expectedRevision === 0 && read.revision === 0)) {
        throw new DeliveryCorruptError(read);
      }
      if (read.revision !== expectedRevision) {
        throw new DeliveryRevisionConflict(runId, expectedRevision, read.revision);
      }
      const current = read.kind === "valid" ? read.record : undefined;
      if (!allowedFrom.some((selector) => selectorMatches(selector, read, current))) {
        throw new DeliveryTransitionError(`delivery state is not in allowedFrom for ${event.type}`);
      }
      const persistedEvent: PersistedDeliveryEvent = {
        ...event,
        id: randomUUID(),
        at: new Date().toISOString(),
        fromRevision: expectedRevision,
        toRevision: expectedRevision + 1
      };
      const next = reduceDelivery(runId, current, persistedEvent);
      const snapshot: DeliveryRevisionSnapshot = {
        schemaVersion: 2,
        revision: next.revision,
        record: next,
        event: persistedEvent
      };
      const revisionsDirectory = path.join(runDir, DELIVERY_REVISIONS_DIRECTORY);
      await fs.mkdir(revisionsDirectory, { recursive: true });
      const temporary = path.join(revisionsDirectory, `.${revisionFileName(next.revision)}.${randomUUID()}.tmp`);
      const destination = path.join(revisionsDirectory, revisionFileName(next.revision));
      try {
        await writeSyncedFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
        try {
          await fs.link(temporary, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            const actual = await this.readDelivery(runId);
            throw new DeliveryRevisionConflict(runId, expectedRevision, actual.revision);
          }
          throw error;
        }
        await fsyncDirectory(revisionsDirectory);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      await this.options.afterSnapshotPublish?.(snapshot);
      await replaceProjection(runDir, next);
      return next;
    });
  }
}

export interface DeliveryBranchLeaseRecord {
  schemaVersion: 1;
  revision: number;
  queueKey: `sha256:${string}`;
  state: "leased" | "released";
  runId?: string;
  lastFencingToken: number;
  updatedAt: string;
  lease?: {
    id: string;
    ownerEpoch: string;
    fencingToken: number;
    acquiredAt: string;
    heartbeatAt: string;
    expiresAt: string;
  };
}

export class DeliveryBranchLeaseRevisionConflict extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`delivery branch lease revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "DeliveryBranchLeaseRevisionConflict";
  }
}

const QUEUE_KEY_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class DeliveryBranchLeaseStore {
  private readonly dispatchRoot: string;
  private readonly revisionsRoot: string;

  constructor(dataRoot: string) {
    const artifactsRoot = path.join(path.resolve(dataRoot), "artifacts");
    this.dispatchRoot = path.join(artifactsRoot, "delivery-dispatch");
    this.revisionsRoot = path.join(artifactsRoot, "delivery-dispatch-revisions");
  }

  private assertQueueKey(queueKey: `sha256:${string}`): void {
    if (!QUEUE_KEY_PATTERN.test(queueKey)) throw new Error("delivery queueKey is invalid");
  }

  private revisionDirectory(queueKey: `sha256:${string}`): string {
    return path.join(this.revisionsRoot, queueKey.slice("sha256:".length));
  }

  private projectionPath(queueKey: `sha256:${string}`): string {
    return path.join(this.dispatchRoot, `${queueKey}.json`);
  }

  async read(queueKey: `sha256:${string}`): Promise<DeliveryBranchLeaseRecord | undefined> {
    this.assertQueueKey(queueKey);
    const directory = this.revisionDirectory(queueKey);
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const latest = entries.filter((entry) => SNAPSHOT_NAME.test(entry)).sort().at(-1);
    if (!latest) return undefined;
    const parsed = JSON.parse(await fs.readFile(path.join(directory, latest), "utf8")) as DeliveryBranchLeaseRecord;
    const revision = Number(latest.slice(0, 20));
    if (parsed.schemaVersion !== 1 || parsed.revision !== revision || parsed.queueKey !== queueKey
      || !["leased", "released"].includes(parsed.state)) {
      throw new Error("delivery branch lease snapshot is corrupt");
    }
    return parsed;
  }

  private async publish(
    queueKey: `sha256:${string}`,
    expectedRevision: number,
    next: DeliveryBranchLeaseRecord
  ): Promise<DeliveryBranchLeaseRecord> {
    return withDeliveryMutex(this.projectionPath(queueKey), async () => {
      const current = await this.read(queueKey);
      const actualRevision = current?.revision ?? 0;
      if (actualRevision !== expectedRevision) {
        throw new DeliveryBranchLeaseRevisionConflict(expectedRevision, actualRevision);
      }
      const directory = this.revisionDirectory(queueKey);
      await fs.mkdir(directory, { recursive: true });
      const destination = path.join(directory, revisionFileName(next.revision));
      const temporary = path.join(directory, `.${revisionFileName(next.revision)}.${randomUUID()}.tmp`);
      try {
        await writeSyncedFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
        try {
          await fs.link(temporary, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            const actual = await this.read(queueKey);
            throw new DeliveryBranchLeaseRevisionConflict(expectedRevision, actual?.revision ?? 0);
          }
          throw error;
        }
        await fsyncDirectory(directory);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      await fs.mkdir(this.dispatchRoot, { recursive: true });
      const projection = this.projectionPath(queueKey);
      const projectionTemporary = `${projection}.${randomUUID()}.tmp`;
      try {
        await writeSyncedFile(projectionTemporary, `${JSON.stringify(next, null, 2)}\n`);
        await fs.rename(projectionTemporary, projection);
        await fsyncDirectory(this.dispatchRoot);
      } finally {
        await fs.rm(projectionTemporary, { force: true });
      }
      return next;
    });
  }

  async claim(
    queueKey: `sha256:${string}`,
    expectedRevision: number,
    input: { runId: string; leaseId: string; ownerEpoch: string; expiresAt: string }
  ): Promise<DeliveryBranchLeaseRecord> {
    this.assertQueueKey(queueKey);
    assertRunId(input.runId);
    const current = await this.read(queueKey);
    const actualRevision = current?.revision ?? 0;
    if (actualRevision !== expectedRevision) {
      throw new DeliveryBranchLeaseRevisionConflict(expectedRevision, actualRevision);
    }
    if (current?.state === "leased" && current.lease && Date.parse(current.lease.expiresAt) > Date.now()) {
      throw new DeliveryTransitionError("delivery branch already has an unexpired lease");
    }
    const at = new Date().toISOString();
    const fencingToken = (current?.lastFencingToken ?? 0) + 1;
    return this.publish(queueKey, expectedRevision, {
      schemaVersion: 1,
      revision: expectedRevision + 1,
      queueKey,
      state: "leased",
      runId: input.runId,
      lastFencingToken: fencingToken,
      updatedAt: at,
      lease: {
        id: input.leaseId,
        ownerEpoch: input.ownerEpoch,
        fencingToken,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: input.expiresAt
      }
    });
  }

  async renew(
    queueKey: `sha256:${string}`,
    expectedRevision: number,
    leaseId: string,
    expiresAt: string
  ): Promise<DeliveryBranchLeaseRecord> {
    const current = await this.read(queueKey);
    if (!current || current.revision !== expectedRevision || current.state !== "leased" || current.lease?.id !== leaseId) {
      throw new DeliveryBranchLeaseRevisionConflict(expectedRevision, current?.revision ?? 0);
    }
    const at = new Date().toISOString();
    return this.publish(queueKey, expectedRevision, {
      ...current,
      revision: expectedRevision + 1,
      updatedAt: at,
      lease: { ...current.lease, heartbeatAt: at, expiresAt }
    });
  }

  async release(
    queueKey: `sha256:${string}`,
    expectedRevision: number,
    leaseId: string
  ): Promise<DeliveryBranchLeaseRecord> {
    const current = await this.read(queueKey);
    if (!current || current.revision !== expectedRevision || current.state !== "leased" || current.lease?.id !== leaseId) {
      throw new DeliveryBranchLeaseRevisionConflict(expectedRevision, current?.revision ?? 0);
    }
    return this.publish(queueKey, expectedRevision, {
      schemaVersion: 1,
      revision: expectedRevision + 1,
      queueKey,
      state: "released",
      lastFencingToken: current.lastFencingToken,
      updatedAt: new Date().toISOString()
    });
  }
}

export class DeliveryLeaseHandle {
  private itemRevision: number;
  private branchRevision: number;
  private released = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    readonly runId: string,
    readonly runDir: string,
    readonly queueKey: `sha256:${string}`,
    readonly leaseId: string,
    readonly ownerEpoch: string,
    readonly fencingToken: number,
    itemRevision: number,
    branchRevision: number,
    private readonly branchStore: DeliveryBranchLeaseStore,
    private readonly leaseDurationMs = 30_000
  ) {
    this.itemRevision = itemRevision;
    this.branchRevision = branchRevision;
  }

  get revision(): number {
    return this.itemRevision;
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async assertActiveNow(): Promise<RunDeliveryRecordV2> {
    if (this.released) throw new DeliveryTransitionError("delivery lease handle has been released");
    const [item, branch] = await Promise.all([
      RunDeliveryStore.forRunDirectory(this.runDir, this.runId).readDelivery(this.runId),
      this.branchStore.read(this.queueKey)
    ]);
    if (item.kind !== "valid"
      || item.record.revision !== this.itemRevision
      || item.record.dispatch?.state !== "leased"
      || item.record.dispatch.lease?.id !== this.leaseId
      || item.record.dispatch.lease.fencingToken !== this.fencingToken
      || Date.parse(item.record.dispatch.lease.expiresAt) <= Date.now()
      || !branch
      || branch.revision !== this.branchRevision
      || branch.state !== "leased"
      || branch.runId !== this.runId
      || branch.lease?.id !== this.leaseId
      || branch.lease.fencingToken !== this.fencingToken
      || Date.parse(branch.lease.expiresAt) <= Date.now()) {
      throw new DeliveryTransitionError("delivery lease was fenced by a newer owner or revision");
    }
    return item.record;
  }

  async assertActive(): Promise<RunDeliveryRecordV2> {
    return this.serialized(() => this.assertActiveNow());
  }

  async renew(): Promise<RunDeliveryRecordV2> {
    return this.serialized(async () => {
      const active = await this.assertActiveNow();
      const expiresAt = new Date(Date.now() + this.leaseDurationMs).toISOString();
      const branch = await this.branchStore.renew(this.queueKey, this.branchRevision, this.leaseId, expiresAt);
      this.branchRevision = branch.revision;
      const current = await RunDeliveryStore.forRunDirectory(this.runDir, this.runId).advanceDelivery(
        this.runId,
        this.itemRevision,
        [{
          kind: "record",
          status: active.status,
          dispatchState: "leased",
          leaseId: this.leaseId
        }],
        {
          type: "dispatch.heartbeat",
          actor: "runtime",
          payload: { leaseId: this.leaseId, expiresAt }
        }
      );
      this.itemRevision = current.revision;
      return current;
    });
  }

  private async currentRecord(): Promise<RunDeliveryRecordV2> {
    const read = await RunDeliveryStore.forRunDirectory(this.runDir, this.runId).readDelivery(this.runId);
    if (read.kind !== "valid") throw new DeliveryTransitionError("delivery record is unavailable to its lease owner");
    return read.record;
  }

  async advance(event: DeliveryEvent): Promise<RunDeliveryRecordV2> {
    return this.serialized(async () => {
      const current = await this.assertActiveNow();
      const fencedEvent = {
        ...event,
        payload: { ...event.payload, leaseId: this.leaseId }
      } as DeliveryEvent;
      const next = await RunDeliveryStore.forRunDirectory(this.runDir, this.runId).advanceDelivery(
        this.runId,
        this.itemRevision,
        [{
          kind: "record",
          status: current.status,
          ...(current.conflictResolution?.status ? { conflictStatus: current.conflictResolution.status } : {}),
          dispatchState: "leased",
          leaseId: this.leaseId
        }],
        fencedEvent
      );
      this.itemRevision = next.revision;
      return next;
    });
  }

  async fail(code: string, message: string): Promise<void> {
    try {
      await this.serialized(async () => {
        const current = await this.assertActiveNow();
        const next = await RunDeliveryStore.forRunDirectory(this.runDir, this.runId).advanceDelivery(
          this.runId,
          this.itemRevision,
          [{ kind: "record", status: current.status, dispatchState: "leased", leaseId: this.leaseId }],
          {
            type: "dispatch.failed",
            actor: "runtime",
            payload: { leaseId: this.leaseId, code, message }
          }
        );
        this.itemRevision = next.revision;
      });
    } catch (error) {
      if (!(error instanceof DeliveryRevisionConflict) && !(error instanceof DeliveryTransitionError)) throw error;
    } finally {
      await this.releaseBranch();
    }
  }

  async releaseBranch(): Promise<void> {
    await this.serialized(async () => {
      if (this.released) return;
      this.released = true;
      try {
        const released = await this.branchStore.release(
          this.queueKey,
          this.branchRevision,
          this.leaseId
        );
        this.branchRevision = released.revision;
      } catch (error) {
        if (!(error instanceof DeliveryBranchLeaseRevisionConflict) && !(error instanceof DeliveryTransitionError)) throw error;
      }
    });
  }
}

export async function readRunDelivery(runDir: string, runId?: string): Promise<RunDeliveryRecordV2 | undefined> {
  const directoryRunId = path.basename(path.resolve(runDir));
  let resolvedRunId = runId ?? (RUN_ID_PATTERN.test(directoryRunId) ? directoryRunId : undefined);
  if (!resolvedRunId) {
    const projectionRaw = await readTextIfPresent(deliveryPath(runDir));
    if (projectionRaw) {
      try {
        const candidate = JSON.parse(projectionRaw) as { runId?: unknown };
        if (typeof candidate.runId === "string") resolvedRunId = candidate.runId;
      } catch {
        throw new DeliveryCorruptError({
          kind: "corrupt",
          revision: 0,
          rawSha256: sha256(projectionRaw),
          reason: "delivery JSON is invalid"
        });
      }
    }
  }
  if (!resolvedRunId) return undefined;
  const read = await RunDeliveryStore.forRunDirectory(runDir, resolvedRunId).readDelivery(resolvedRunId);
  if (read.kind === "corrupt") throw new DeliveryCorruptError(read);
  return read.kind === "valid" ? read.record : undefined;
}

export async function advanceDeliveryEvent(
  runDir: string,
  runId: string,
  expectedRevision: number,
  event: DeliveryEvent
): Promise<RunDeliveryRecordV2> {
  return RunDeliveryStore.forRunDirectory(runDir, runId).advanceDelivery(
    runId,
    expectedRevision,
    defaultAllowedFrom(event),
    event
  );
}

async function managedRunRebaseContext(
  run: WorkflowRunRecord,
  runDir: string,
  targetCommit: string
): Promise<{ worktreePath: string; repositoryRoot: string; sourceBranch: string }> {
  assertRunId(run.id);
  const worktreePath = run.isolation?.mode === "worktree" ? run.isolation.worktreePath : undefined;
  const delivery = await readRunDelivery(runDir, run.id);
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
  targetCommit: string,
  leaseHandle?: DeliveryLeaseHandle
): Promise<ManagedRunRebaseStep> {
  const { worktreePath, sourceBranch } = await managedRunRebaseContext(run, runDir, targetCommit);
  if (await rebaseStateExists(worktreePath)) {
    await git(worktreePath, ["rebase", "--abort"]);
  }
  const branch = await git(worktreePath, ["branch", "--show-current"]);
  if (branch !== sourceBranch) throw new Error("冲突修复改变了受管交付源分支");
  const working = await git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (working.length > 0) throw new Error("开始冲突修复前 worktree 存在未提交文件");

  await leaseHandle?.renew();
  await leaseHandle?.assertActive();
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
  targetCommit: string,
  leaseHandle?: DeliveryLeaseHandle
): Promise<ManagedRunRebaseStep> {
  const { worktreePath } = await managedRunRebaseContext(run, runDir, targetCommit);
  const conflictPaths = await unmergedPaths(worktreePath);
  if (conflictPaths.length === 0) throw new Error("运行核心没有找到等待处理的冲突文件");
  const check = await runGit(worktreePath, ["diff", "--check", "--"]);
  if (check.code !== 0) {
    throw new Error((check.stderr.trim() || check.stdout.trim() || "冲突文件仍包含无效标记").slice(0, 8_000));
  }
  await leaseHandle?.renew();
  await leaseHandle?.assertActive();
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
  targetCommit: string,
  leaseHandle?: DeliveryLeaseHandle
): Promise<RunDeliveryRecordV2> {
  const preview = await previewRunMerge(run, runDir);
  const delivery = await readRunDelivery(runDir, run.id);
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
  if (!delivery?.conflictResolution) throw new Error("缺少冲突修复审计记录");
  const event: DeliveryEvent = {
    type: "conflict.stage-completed",
    actor: "runtime",
    payload: {
      stage: "rebased",
      targetCommit,
      sourceCommit,
      message: "AI 已在原 worktree 完成 rebase 并通过 Git 完整性检查；正在回跑独立测试与原领队复验。"
    }
  };
  return leaseHandle
    ? leaseHandle.advance(event)
    : advanceDeliveryEvent(runDir, run.id, delivery.revision, event);
}

export async function advanceRunEvidenceRerun(
  runDir: string,
  runId: string,
  expectedRevision: number,
  type: "evidence.queued" | "evidence.running" | "evidence.completed",
  evidenceRerun: NonNullable<RunDeliveryRecord["evidenceRerun"]>
): Promise<RunDeliveryRecordV2> {
  return advanceDeliveryEvent(runDir, runId, expectedRevision, {
    type,
    actor: evidenceRerun.actor,
    payload: { evidenceRerun }
  });
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
  const deliveryRead = await RunDeliveryStore.forRunDirectory(runDir, run.id).readDelivery(run.id);
  const delivery = deliveryRead.kind === "valid" ? deliveryRead.record : undefined;
  let recoveryRequired: RunMergePreview["recoveryRequired"];
  if (deliveryRead.kind === "corrupt") {
    recoveryRequired = {
      reason: deliveryRead.reason,
      fingerprint: deliveryReadFingerprint(deliveryRead),
      rawSha256: deliveryRead.rawSha256
    };
    reasons.push(`交付记录损坏，需要本机 owner 执行诚实恢复：${deliveryRead.reason}`);
    acceptanceReasons.push("交付记录损坏，不能证明候选状态。");
  }
  if (delivery?.sideEffects?.discard?.phase === "prepared") {
    recoveryRequired = {
      reason: "discard-cleanup-incomplete",
      fingerprint: deliveryReadFingerprint(deliveryRead)
    };
    reasons.push("人工丢弃 intent 已持久化，但清理完成证据尚未对账。");
    acceptanceReasons.push("候选正在等待丢弃清理对账。");
  }
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
    if (deliveryRead.kind === "absent") {
      recoveryRequired = { reason: "delivery-absent", fingerprint: deliveryReadFingerprint(deliveryRead) };
    }
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
        if (!recoveryRequired) {
          let missingReason: DeliveryMissingReason = "worktree-unregistered";
          try {
            await fs.access(worktreePath);
          } catch (accessError) {
            if ((accessError as NodeJS.ErrnoException).code === "ENOENT") missingReason = "worktree-missing";
          }
          recoveryRequired = {
            reason: missingReason,
            fingerprint: deliveryReadFingerprint(deliveryRead)
          };
        }
      }
      reasons.push(`worktree 不可用：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    acceptanceReasons.push("该交付已经丢弃。");
  }

  const status = recoveryRequired ? "not-ready" : delivery?.status ?? (reasons.length === 0 ? "awaiting-acceptance" : "not-ready");
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
    ...(delivery ? { delivery } : {}),
    ...(recoveryRequired ? { recoveryRequired } : {})
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
): Promise<RunDeliveryRecordV2> {
  if (!preview.repositoryRoot || !preview.worktreePath) throw new Error("该 Run 当前不能准备交付来源");
  const delivery = await readRunDelivery(runDir, run.id);
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
  const sourceCommit = await git(preview.worktreePath, ["rev-parse", "HEAD"]);
  return advanceDeliveryEvent(runDir, run.id, delivery?.revision ?? 0, {
    type: "source.prepared",
    actor: "runtime",
    payload: {
      baseCommit,
      sourceBranch,
      sourceCommit,
      targetBranch: before.branch,
      targetCommitBeforeMerge: delivery?.targetCommitBeforeMerge ?? before.commit
    }
  });
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
  const queued = await advanceDeliveryEvent(runDir, run.id, delivery.revision, {
    type: "merge.approved",
    actor,
    payload: {
      targetBranch: before.branch,
      queueKey: deliveryQueueKey(preview.repositoryRoot, before.branch),
      queuedTargetCommit: ["queued-for-merge", "retesting", "merging"].includes(delivery.status)
        ? delivery.queuedTargetCommit ?? before.commit
        : before.commit,
      message: "人工验收已通过，正在等待目标分支的串行合入协调。"
    }
  });
  return { status: "queued-for-merge", delivery: queued };
}

export async function assessQueuedRun(
  run: WorkflowRunRecord,
  runDir: string
): Promise<QueuedRunAssessment> {
  const preview = await previewRunMerge(run, runDir);
  const delivery = await readRunDelivery(runDir, run.id);
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
  const delivery = await readRunDelivery(runDir, run.id);
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
  input: {
    confirmation: string;
    targetBranch: string;
    expectedTargetCommit: string;
    /** Deterministic synchronization point for the target-ref race regression. Production callers omit it. */
    beforeTargetCompareAndSwap?: () => void | Promise<void>;
    leaseHandle?: DeliveryLeaseHandle;
  }
): Promise<RunMergeResult> {
  if (input.confirmation !== confirmationToken(run.id)) throw new Error("缺少本次 Run 的明确合并确认");
  const preview = await previewRunMerge(run, runDir);
  if (!preview.eligible || !preview.repositoryRoot || !preview.worktreePath || !preview.targetBranch) {
    throw new Error(preview.reasons.join(" ") || "该 Run 当前不能合并");
  }
  if (input.targetBranch !== preview.targetBranch) throw new Error("目标分支已变化，请重新打开预览确认");
  const before = await currentTargetState(preview.repositoryRoot);
  if (before.branch !== input.targetBranch) throw new Error("目标分支已变化，请重新打开预览确认");
  if (before.commit !== input.expectedTargetCommit) {
    throw new TargetChangedAfterValidationError();
  }

  const delivery = await ensureDeliverySource(run, runDir, preview, before);
  if (!delivery.baseCommit || !delivery.sourceBranch || !delivery.sourceCommit || !delivery.targetBranch) {
    throw new Error("交付记录缺少合并所需的来源或目标信息");
  }

  const mergeCheck = await runGit(preview.repositoryRoot, [
    "merge-tree", "--write-tree", before.commit, delivery.sourceCommit
  ]);
  if (mergeCheck.code !== 0) {
    const conflictMessage = (mergeCheck.stderr.trim() || mergeCheck.stdout.trim() || "合并冲突").slice(0, 8_000);
    const conflictEvent: DeliveryEvent = {
      type: "conflict.started",
      actor: "runtime",
      payload: {
        targetCommit: before.commit,
        targetBranch: before.branch,
        targetCommitBeforeMerge: before.commit,
        conflictMessage,
        message: conflictMessage
      }
    };
    const conflict = input.leaseHandle
      ? await input.leaseHandle.advance(conflictEvent)
      : await advanceDeliveryEvent(runDir, run.id, delivery.revision, conflictEvent);
    return { status: "conflict", delivery: conflict };
  }

  const ready = await currentTargetState(preview.repositoryRoot);
  if (ready.branch !== before.branch || ready.commit !== before.commit) {
    throw new TargetChangedAfterValidationError();
  }

  const tree = mergeCheck.stdout.split("\n", 1)[0]?.trim();
  if (!tree || !FULL_COMMIT.test(tree)) throw new Error("合入预检没有生成可验证的 tree object");
  const prepared = await runGit(preview.repositoryRoot, [
    "commit-tree", tree,
    "-p", before.commit,
    "-p", delivery.sourceCommit,
    "-m", `Merge ${delivery.sourceBranch} into ${before.branch}`
  ]);
  if (prepared.code !== 0) {
    throw new Error(prepared.stderr.trim() || prepared.stdout.trim() || "无法构造受验证的 merge commit");
  }
  const mergeCommit = prepared.stdout.trim();
  if (!FULL_COMMIT.test(mergeCommit)) throw new Error("构造的 merge commit 不是完整 commit");
  const parents = (await git(preview.repositoryRoot, ["rev-list", "--parents", "-n", "1", mergeCommit])).split(" ");
  if (parents.length !== 3 || parents[1] !== input.expectedTargetCommit || parents[2] !== delivery.sourceCommit) {
    throw new Error("构造的 merge commit 双亲与已验证 target/source 不一致");
  }

  const intentId = randomUUID();
  const targetRef = `refs/heads/${before.branch}`;
  const intentEvent: DeliveryEvent = {
    type: "merge.intent-prepared",
    actor: "runtime",
    payload: {
      intentId,
      targetRef,
      expectedTargetCommit: input.expectedTargetCommit,
      sourceCommit: delivery.sourceCommit,
      preparedMergeCommit: mergeCommit,
      message: "已持久化受验证的 merge intent；正在以目标 commit 执行 Git CAS。"
    }
  };
  const intent = input.leaseHandle
    ? await input.leaseHandle.advance(intentEvent)
    : await advanceDeliveryEvent(runDir, run.id, delivery.revision, intentEvent);
  await input.leaseHandle?.renew();
  await input.beforeTargetCompareAndSwap?.();
  await input.leaseHandle?.assertActive();
  const updated = await runGit(preview.repositoryRoot, [
    "update-ref", targetRef, mergeCommit, input.expectedTargetCommit
  ]);
  if (updated.code !== 0) throw new TargetChangedAfterValidationError();

  const refUpdatedEvent: DeliveryEvent = {
    type: "merge.ref-updated",
    actor: "runtime",
    payload: {
      intentId,
      message: "目标 ref 已按预期 commit 完成 CAS，正在同步目标 worktree。"
    }
  };
  const refUpdated = input.leaseHandle
    ? await input.leaseHandle.advance(refUpdatedEvent)
    : await advanceDeliveryEvent(runDir, run.id, intent.revision, refUpdatedEvent);

  // update-ref supplies the atomic compare-and-swap guarantee; read-tree only
  // synchronizes the already checked-out target worktree and never rewrites the ref.
  const synchronized = await runGit(preview.repositoryRoot, ["read-tree", "--reset", "-u", mergeCommit]);
  if (synchronized.code !== 0) {
    const rolledBack = await runGit(preview.repositoryRoot, [
      "update-ref", targetRef, input.expectedTargetCommit, mergeCommit
    ]);
    if (rolledBack.code === 0) {
      await runGit(preview.repositoryRoot, ["read-tree", "--reset", "-u", input.expectedTargetCommit]);
    }
    throw new Error(synchronized.stderr.trim() || synchronized.stdout.trim() || "目标 ref 已更新但工作区同步失败");
  }
  const appliedTarget = await git(preview.repositoryRoot, ["rev-parse", targetRef]);
  if (appliedTarget !== mergeCommit) throw new TargetChangedAfterValidationError();

  const completedEvent: DeliveryEvent = {
    type: "merge.completed",
    actor: "runtime",
    payload: {
      intentId,
      targetBranch: before.branch,
      targetCommitBeforeMerge: before.commit,
      mergeCommit,
      message: "用户确认后已合并；源分支保留作为交付证据。"
    }
  };
  const record = input.leaseHandle
    ? await input.leaseHandle.advance(completedEvent)
    : await advanceDeliveryEvent(runDir, run.id, refUpdated.revision, completedEvent);
  await removeRunWorktree(preview.repositoryRoot, preview.worktreePath);
  return { status: "merged", delivery: record };
}

export interface DeliverySideEffectRecoveryResult {
  action: "none" | "discard-completed" | "attention" | "merge-completed" | "merge-retryable" | "merge-revalidation";
  delivery?: RunDeliveryRecordV2;
  reason?: string;
}

export async function reconcileRunDeliverySideEffects(
  run: WorkflowRunRecord,
  runDir: string,
  leaseHandle?: DeliveryLeaseHandle
): Promise<DeliverySideEffectRecoveryResult> {
  const delivery = await readRunDelivery(runDir, run.id);
  if (!delivery || TERMINAL_DELIVERY_STATUSES.has(delivery.status)) return { action: "none", ...(delivery ? { delivery } : {}) };
  const worktreePath = run.isolation?.mode === "worktree" ? run.isolation.worktreePath : undefined;
  const inferredRoot = worktreePath ? inferredRepositoryRoot(worktreePath, run.id) : undefined;
  let repositoryRoot: string | undefined;
  if (inferredRoot) {
    try {
      repositoryRoot = await fs.realpath(inferredRoot);
    } catch {
      repositoryRoot = undefined;
    }
  }

  const discardIntent = delivery.sideEffects?.discard;
  if (discardIntent?.phase === "prepared") {
    if (!worktreePath || !repositoryRoot) {
      return { action: "attention", delivery, reason: "discard intent repository/worktree identity cannot be resolved" };
    }
    const cleanup = await unverifiedCleanupObservation(worktreePath, repositoryRoot, delivery.sourceBranch);
    const listed = await runGit(repositoryRoot, ["worktree", "list", "--porcelain"]);
    const registered = listed.code !== 0
      || listed.stdout.split("\n").some((line) => line === `worktree ${worktreePath}`);
    if (cleanup.worktree !== "missing" || registered || cleanup.sourceBranch !== "missing") {
      return {
        action: "attention",
        delivery,
        reason: `discard cleanup is not fully verified (worktree=${cleanup.worktree}, registered=${registered}, branch=${cleanup.sourceBranch})`
      };
    }
    const completed = await advanceDeliveryEvent(runDir, run.id, delivery.revision, {
      type: "discard.completed",
      actor: "runtime-recovery",
      payload: {
        intentId: discardIntent.intentId,
        message: "startup reconciliation verified path, registry, and source branch cleanup; discard completed."
      }
    });
    return { action: "discard-completed", delivery: completed };
  }

  const mergeIntent = delivery.sideEffects?.merge;
  if (!mergeIntent || mergeIntent.phase === "worktree-synchronized") return { action: "none", delivery };
  if (!repositoryRoot) {
    return { action: "attention", delivery, reason: "merge intent repository root cannot be resolved" };
  }
  if (!leaseHandle) return { action: "merge-retryable", delivery };
  const target = await runGit(repositoryRoot, ["rev-parse", "--verify", mergeIntent.targetRef]);
  if (target.code !== 0) {
    return { action: "attention", delivery, reason: "merge intent target ref cannot be resolved" };
  }
  const targetCommit = target.stdout.trim();
  if (targetCommit !== mergeIntent.preparedMergeCommit && targetCommit !== mergeIntent.expectedTargetCommit) {
    const revalidation = await leaseHandle.advance({
      type: "validation.started",
      actor: "runtime-recovery",
      payload: {
        retryAfterTargetDrift: true,
        targetCommit,
        message: "target ref differs from both persisted merge intent commits; returning to queued revalidation."
      }
    });
    return { action: "merge-revalidation", delivery: revalidation };
  }
  let current = delivery;
  if (targetCommit === mergeIntent.expectedTargetCommit) {
    await leaseHandle.renew();
    await leaseHandle.assertActive();
    const updated = await runGit(repositoryRoot, [
      "update-ref",
      mergeIntent.targetRef,
      mergeIntent.preparedMergeCommit,
      mergeIntent.expectedTargetCommit
    ]);
    if (updated.code !== 0) {
      throw new TargetChangedAfterValidationError();
    }
  }
  if (mergeIntent.phase === "prepared") {
    current = await leaseHandle.advance({
      type: "merge.ref-updated",
      actor: "runtime-recovery",
      payload: {
        intentId: mergeIntent.intentId,
        message: "startup reconciliation verified the prepared merge commit at the target ref."
      }
    });
  }
  const targetBranch = mergeIntent.targetRef.startsWith("refs/heads/")
    ? mergeIntent.targetRef.slice("refs/heads/".length)
    : delivery.targetBranch;
  if (!targetBranch) return { action: "attention", delivery: current, reason: "merge intent target branch is missing" };
  const checkedOutBranch = await runGit(repositoryRoot, ["branch", "--show-current"]);
  if (checkedOutBranch.code === 0 && checkedOutBranch.stdout.trim() === targetBranch) {
    const synchronized = await runGit(repositoryRoot, ["read-tree", "--reset", "-u", mergeIntent.preparedMergeCommit]);
    if (synchronized.code !== 0) {
      throw new Error(synchronized.stderr.trim() || synchronized.stdout.trim() || "merge recovery could not synchronize target worktree");
    }
  }
  const completed = await leaseHandle.advance({
    type: "merge.completed",
    actor: "runtime-recovery",
    payload: {
      intentId: mergeIntent.intentId,
      targetBranch,
      targetCommitBeforeMerge: mergeIntent.expectedTargetCommit,
      mergeCommit: mergeIntent.preparedMergeCommit,
      message: "startup reconciliation completed the persisted merge intent without rebuilding merge evidence."
    }
  });
  if (worktreePath) {
    try {
      await removeRunWorktree(repositoryRoot, worktreePath);
    } catch {
      // Terminal merge evidence is already durable; cleanup remains safely retryable.
    }
  }
  return { action: "merge-completed", delivery: completed };
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
  const existing = await readRunDelivery(runDir, run.id);
  if (existing?.runId && existing.runId !== run.id) throw new Error("交付记录与当前 Run 不匹配");
  if (existing?.status === "merged") throw new Error("已合并的交付不能再标记为保留");
  if (existing?.status === "discarded") throw new Error("已丢弃的交付不能再标记为保留");
  if (existing?.status === "kept") throw new Error("该交付已经记录为人工保留");
  const worktreePath = run.isolation?.mode === "worktree" ? run.isolation.worktreePath : undefined;
  if (!worktreePath) throw new Error("该 Run 没有可保留的 worktree");
  const repositoryRoot = await registeredRepositoryRoot(worktreePath, run.id);
  const targetBranch = await git(repositoryRoot, ["branch", "--show-current"]);
  if (!targetBranch) throw new Error("目标仓库当前不在命名分支上");
  const record = await advanceDeliveryEvent(runDir, run.id, existing?.revision ?? 0, {
    type: "keep.recorded",
    actor,
    payload: {
      baseCommit: existing?.baseCommit ?? run.isolation?.baseCommit ?? await git(worktreePath, ["rev-parse", "HEAD"]),
      targetBranch: existing?.targetBranch ?? targetBranch,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      message: "人工选择保留候选 worktree；未执行 merge 或 push。"
    }
  });
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

function inferredRepositoryRoot(worktreePath: string, runId: string): string | undefined {
  const candidate = path.resolve(path.dirname(path.dirname(worktreePath)), "..");
  return path.resolve(candidate, ".multi-agent", "worktrees", runId) === path.resolve(worktreePath)
    ? candidate
    : undefined;
}

async function archiveCorruptDelivery(
  runDir: string,
  expectedRawSha256: `sha256:${string}`
): Promise<string> {
  const raw = await fs.readFile(deliveryPath(runDir));
  const actual = sha256(raw);
  if (actual !== expectedRawSha256) {
    throw new DeliveryRecoveryConflict("corrupt delivery bytes changed after confirmation");
  }
  const recoveryDirectory = path.join(runDir, "delivery-recovery");
  await fs.mkdir(recoveryDirectory, { recursive: true });
  const name = `corrupt-${expectedRawSha256.slice("sha256:".length)}.json`;
  const destination = path.join(recoveryDirectory, name);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    try {
      handle = await fs.open(destination, "wx", 0o600);
      await handle.writeFile(raw);
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await handle?.close();
    }
    const archived = await fs.readFile(destination);
    if (sha256(archived) !== expectedRawSha256) {
      throw new Error("corrupt delivery archive digest verification failed");
    }
    await fsyncDirectory(recoveryDirectory);
  } catch (error) {
    throw new Error(`无法归档损坏的交付记录：${error instanceof Error ? error.message : String(error)}`);
  }
  return path.posix.join("delivery-recovery", name);
}

async function unverifiedCleanupObservation(
  worktreePath: string | undefined,
  repositoryRoot: string | undefined,
  sourceBranch: string | undefined
): Promise<DeliveryCleanupEvidence> {
  let worktree: DeliveryCleanupEvidence["worktree"] = "unknown";
  if (worktreePath) {
    try {
      await fs.access(worktreePath);
      worktree = "present";
      if (repositoryRoot) {
        const listed = await runGit(repositoryRoot, ["worktree", "list", "--porcelain"]);
        if (listed.code === 0 && !listed.stdout.split("\n").some((line) => line === `worktree ${worktreePath}`)) {
          worktree = "unregistered";
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") worktree = "missing";
    }
  }
  let branch: DeliveryCleanupEvidence["sourceBranch"] = "unknown";
  if (repositoryRoot && sourceBranch) {
    try {
      branch = await branchExists(repositoryRoot, sourceBranch) ? "present" : "missing";
    } catch {
      branch = "unknown";
    }
  }
  return { checkedAt: new Date().toISOString(), worktree, sourceBranch: branch };
}

async function adjudicateUnverifiedOutcome(
  repositoryRoot: string | undefined,
  sourceCommit: string | undefined,
  targetBranch: string | undefined
): Promise<DeliveryOutcome> {
  if (!repositoryRoot || !sourceCommit || !targetBranch || !FULL_COMMIT.test(sourceCommit)) return "unknown";
  try {
    const source = await git(repositoryRoot, ["rev-parse", "--verify", `${sourceCommit}^{commit}`]);
    const target = await git(repositoryRoot, ["rev-parse", "--verify", `${targetBranch}^{commit}`]);
    if (source !== sourceCommit || !FULL_COMMIT.test(target)) return "unknown";
    return await isAncestor(repositoryRoot, sourceCommit, target) ? "merged" : "not-merged";
  } catch {
    return "unknown";
  }
}

export async function discardRunUnverified(
  run: WorkflowRunRecord,
  runDir: string,
  input: UnverifiedDiscardInput,
  principal: LocalOwnerPrincipal
): Promise<RunDeliveryActionResult> {
  assertRunId(run.id);
  if (principal.kind !== "local-owner") throw new Error("discard-unverified requires the local owner principal");
  const actor = humanActor(input.actor);
  const store = RunDeliveryStore.forRunDirectory(runDir, run.id);
  const read = await store.readDelivery(run.id);
  if (read.kind === "valid" && TERMINAL_DELIVERY_STATUSES.has(read.record.status)) {
    throw new Error(`已进入 ${read.record.status} 终态，不能执行未验证丢弃`);
  }
  if (read.revision !== input.expectedRevision) {
    throw new DeliveryRevisionConflict(run.id, input.expectedRevision, read.revision);
  }
  const fingerprint = deliveryReadFingerprint(read);
  if (input.confirmation !== `DISCARD UNVERIFIED ${run.id} ${fingerprint}`) {
    throw new DeliveryRecoveryConflict("缺少与当前交付指纹匹配的未验证丢弃确认");
  }
  if (read.kind === "corrupt") {
    if (input.reason !== "delivery-corrupt") throw new Error("损坏交付必须使用 delivery-corrupt reason");
    if (!input.expectedRawSha256 || input.expectedRawSha256 !== read.rawSha256) {
      throw new DeliveryRecoveryConflict("损坏交付的 raw SHA-256 已变化");
    }
  } else if (read.kind === "absent" && input.reason !== "delivery-absent") {
    throw new Error("缺失交付必须使用 delivery-absent reason");
  } else if (read.kind === "valid" && !["worktree-missing", "worktree-unregistered"].includes(input.reason)) {
    throw new Error("合法交付的未验证丢弃只用于 worktree missing/unregistered 恢复");
  }

  const record = read.kind === "valid" ? read.record : undefined;
  const worktreePath = run.isolation?.mode === "worktree" ? run.isolation.worktreePath : undefined;
  const inferredRoot = worktreePath ? inferredRepositoryRoot(worktreePath, run.id) : undefined;
  let repositoryRoot: string | undefined;
  if (inferredRoot) {
    try {
      repositoryRoot = await fs.realpath(inferredRoot);
    } catch {
      repositoryRoot = undefined;
    }
  }
  const cleanup = await unverifiedCleanupObservation(worktreePath, repositoryRoot, record?.sourceBranch);
  if (read.kind === "valid") {
    if (input.reason === "worktree-missing" && cleanup.worktree !== "missing") {
      throw new Error("受管 worktree 仍存在，不能声明 worktree-missing");
    }
    if (input.reason === "worktree-unregistered" && cleanup.worktree !== "unregistered") {
      throw new Error("受管 worktree 仍已注册，不能声明 worktree-unregistered");
    }
  }
  const outcome = await adjudicateUnverifiedOutcome(repositoryRoot, record?.sourceCommit, record?.targetBranch);
  const archivePath = read.kind === "corrupt" ? await archiveCorruptDelivery(runDir, read.rawSha256) : undefined;
  const allowedFrom: DeliveryStateSelector[] = read.kind === "corrupt"
    ? [{ kind: "corrupt", rawSha256: read.rawSha256 }]
    : read.kind === "absent"
      ? [{ kind: "absent" }]
      : [{
          kind: "record",
          status: read.record.status,
          ...(read.record.conflictResolution?.status ? { conflictStatus: read.record.conflictResolution.status } : {}),
          ...(read.record.dispatch?.state ? { dispatchState: read.record.dispatch.state } : {}),
          ...(read.record.dispatch?.lease?.id ? { leaseId: read.record.dispatch.lease.id } : {})
        }];
  const delivery = await store.advanceDelivery(run.id, read.revision, allowedFrom, {
    type: "discard.unverified",
    actor,
    payload: {
      reason: input.reason,
      fingerprint,
      outcome,
      cleanup,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      ...(read.kind === "corrupt" ? { rawSha256: read.rawSha256 } : {}),
      ...(archivePath ? { archivePath } : {}),
      ...(record?.baseCommit ? { baseCommit: record.baseCommit } : {}),
      ...(record?.sourceBranch ? { sourceBranch: record.sourceBranch } : {}),
      ...(record?.sourceCommit ? { sourceCommit: record.sourceCommit } : {}),
      ...(record?.targetBranch ? { targetBranch: record.targetBranch } : {}),
      message: `本机 owner 已将不可验证候选诚实终止；未删除目录/分支，cleanupVerified=false，outcome=${outcome}。`
    }
  });
  return { status: "discarded", delivery };
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
  const existing = await readRunDelivery(runDir, run.id);
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

  const intentId = randomUUID();
  const intent = await advanceDeliveryEvent(runDir, run.id, existing?.revision ?? 0, {
    type: "discard.intent-prepared",
    actor,
    payload: {
      intentId,
      baseCommit,
      ...(sourceBranchExists ? { sourceBranch: expectedSourceBranch } : {}),
      sourceCommit,
      targetBranch,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      message: "已持久化人工丢弃意图；正在清理受管候选 worktree 与来源分支。"
    }
  });

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

  const record = await advanceDeliveryEvent(runDir, run.id, intent.revision, {
    type: "discard.completed",
    actor,
    payload: {
      intentId,
      message: "人工二次确认后已清理候选 worktree 与未合并的本 Run 交付分支；未修改 run.json。"
    }
  });
  return { status: "discarded", delivery: record };
}
