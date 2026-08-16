import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowRunRecord } from "../src/core/types.js";
import { startRecoveredDaemon } from "../src/daemon/startup.js";
import { createRunWorktree } from "../src/runtime/worktree.js";
import {
  DeliveryBranchLeaseStore,
  RunDeliveryStore,
  deliveryQueueKey,
  type DeliveryEvent,
  type RunDeliveryRecordV2
} from "../src/runtime/worktreeDelivery.js";
import { WorkbenchService } from "../src/workbench/service.js";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repository(): string {
  const root = temporaryRoot("multi-agent-dispatcher-repo-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "dispatcher@example.com");
  git(root, "config", "user.name", "Delivery Dispatcher Test");
  fs.writeFileSync(path.join(root, ".gitignore"), ".multi-agent/\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "seed\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-m", "seed");
  return root;
}

function runsRoot(dataRoot: string): string {
  const root = path.join(dataRoot, "artifacts", "runs");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function runDirectory(dataRoot: string, runId: string): string {
  const runDir = path.join(runsRoot(dataRoot), runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function sourceEvent(runId: string, targetCommit = "a".repeat(40)): DeliveryEvent {
  return {
    type: "source.prepared",
    actor: "runtime",
    payload: {
      baseCommit: targetCommit,
      sourceBranch: `codex/${runId}`,
      sourceCommit: "b".repeat(40),
      targetBranch: "main",
      targetCommitBeforeMerge: targetCommit
    }
  };
}

async function writeReadyDelivery(
  dataRoot: string,
  runId: string,
  queueKey: `sha256:${string}`
): Promise<RunDeliveryRecordV2> {
  const store = new RunDeliveryStore(runsRoot(dataRoot));
  runDirectory(dataRoot, runId);
  const source = await store.advanceDelivery(runId, 0, [{ kind: "absent" }], sourceEvent(runId));
  return store.advanceDelivery(runId, source.revision, [{ kind: "record", status: "awaiting-acceptance" }], {
    type: "merge.approved",
    actor: "owner",
    payload: { targetBranch: "main", queuedTargetCommit: "a".repeat(40), queueKey, message: "approved" }
  });
}

function writeRun(runDir: string, input: {
  runId: string;
  worktreePath?: string;
  baseCommit?: string;
}): WorkflowRunRecord {
  const run: WorkflowRunRecord = {
    id: input.runId,
    workflow: "delivery-dispatcher-test",
    architecture: "supervisor",
    manifestPath: path.join(runDir, "multi-agent.yaml"),
    artifactDir: runDir,
    status: "passed",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...(input.worktreePath && input.baseCommit ? {
      isolation: { mode: "worktree" as const, worktreePath: input.worktreePath, baseCommit: input.baseCommit }
    } : {}),
    nodes: {}
  };
  fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return run;
}

async function waitForDelivery(
  store: RunDeliveryStore,
  runId: string,
  predicate: (record: RunDeliveryRecordV2) => boolean
): Promise<RunDeliveryRecordV2> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const read = await store.readDelivery(runId);
    if (read.kind === "valid" && predicate(read.record)) return read.record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`delivery ${runId} did not reach expected state: ${JSON.stringify(await store.readDelivery(runId))}`);
}

function fileEvidence(filePath: string): { hash: string; mtimeMs: number; size: number } {
  const body = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return { hash: createHash("sha256").update(body).digest("hex"), mtimeMs: stat.mtimeMs, size: stat.size };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("durable delivery dispatcher", () => {
  it("runs delivery recovery after activity recovery and before opening the listener", async () => {
    const order: string[] = [];
    const service = {
      recoverInterruptedActivity: async () => { order.push("activity"); },
      recoverDeliveryDispatches: async () => {
        order.push("delivery");
        return { scanned: 0, ready: 0, leased: 0, waiting: 0, incidents: [] };
      }
    } as unknown as WorkbenchService;
    await startRecoveredDaemon(service, {}, async () => {
      order.push("listen");
      return {} as Server;
    });
    expect(order).toEqual(["activity", "delivery", "listen"]);
  });

  it("claims an active delivery on recovery without any GET request", async () => {
    const dataRoot = temporaryRoot("multi-agent-dispatcher-startup-");
    const queueKey = deliveryQueueKey(path.join(dataRoot, "repo"), "main");
    const runId = "run-delivery-dispatch-startup-1";
    await writeReadyDelivery(dataRoot, runId, queueKey);
    fs.writeFileSync(path.join(runDirectory(dataRoot, runId), "delivery.json"), "{broken-projection", "utf8");
    const service = await WorkbenchService.open({ dataRoot });

    const summary = await service.recoverDeliveryDispatches();
    expect(summary).toMatchObject({ ready: 1 });
    const store = new RunDeliveryStore(runsRoot(dataRoot));
    const claimed = await waitForDelivery(
      store,
      runId,
      (record) => record.dispatch?.attempt === 1 && record.dispatch.state === "waiting"
    );
    expect(claimed.dispatch).toMatchObject({ attempt: 1, state: "waiting" });
    const branchStore = new DeliveryBranchLeaseStore(dataRoot);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await branchStore.read(queueKey))?.state === "released") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await branchStore.read(queueKey)).toMatchObject({ state: "released" });
    expect(JSON.parse(fs.readFileSync(path.join(runDirectory(dataRoot, runId), "delivery.json"), "utf8")))
      .toMatchObject({ schemaVersion: 2, runId });
  });

  it("allows only one of two daemon instances to claim the same branch head", async () => {
    const dataRoot = temporaryRoot("multi-agent-dispatcher-race-");
    const queueKey = deliveryQueueKey(path.join(dataRoot, "repo"), "main");
    const runId = "run-delivery-dispatch-race-1";
    await writeReadyDelivery(dataRoot, runId, queueKey);
    const left = await WorkbenchService.open({ dataRoot });
    const right = await WorkbenchService.open({ dataRoot });

    const handles = await Promise.all([
      left.claimNextDelivery(queueKey, "daemon-left"),
      right.claimNextDelivery(queueKey, "daemon-right")
    ]);
    expect(handles.filter(Boolean)).toHaveLength(1);
    const branch = await new DeliveryBranchLeaseStore(dataRoot).read(queueKey);
    expect(branch).toMatchObject({ state: "leased", revision: 1, runId });
    await handles.find(Boolean)?.releaseBranch();
  });

  it("orders equal approvals by runId and advances branch fencing after expiry", async () => {
    const dataRoot = temporaryRoot("multi-agent-dispatcher-order-");
    const queueKey = deliveryQueueKey(path.join(dataRoot, "repo"), "main");
    const laterId = "run-delivery-dispatch-order-b";
    const earlierId = "run-delivery-dispatch-order-a";
    const later = await writeReadyDelivery(dataRoot, laterId, queueKey);
    const earlier = await writeReadyDelivery(dataRoot, earlierId, queueKey);
    const store = new RunDeliveryStore(runsRoot(dataRoot));
    const approvedAt = "2026-08-16T00:00:00.000Z";
    await store.advanceDelivery(laterId, later.revision, [{ kind: "record", status: "queued-for-merge", dispatchState: "ready" }], {
      type: "dispatch.ready",
      actor: "runtime",
      payload: { queueKey, approvedAt, message: "same approval time" }
    });
    await store.advanceDelivery(earlierId, earlier.revision, [{ kind: "record", status: "queued-for-merge", dispatchState: "ready" }], {
      type: "dispatch.ready",
      actor: "runtime",
      payload: { queueKey, approvedAt, message: "same approval time" }
    });
    const service = await WorkbenchService.open({ dataRoot });
    const handle = await service.claimNextDelivery(queueKey, "ordered-daemon");
    expect(handle?.runId).toBe(earlierId);
    await handle?.releaseBranch();

    const expiryKey = deliveryQueueKey(path.join(dataRoot, "repo"), "release");
    const branches = new DeliveryBranchLeaseStore(dataRoot);
    const expired = await branches.claim(expiryKey, 0, {
      runId: earlierId,
      leaseId: "expired-lease",
      ownerEpoch: "old-daemon",
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    });
    const reclaimed = await branches.claim(expiryKey, expired.revision, {
      runId: laterId,
      leaseId: "new-lease",
      ownerEpoch: "new-daemon",
      expiresAt: new Date(Date.now() + 30_000).toISOString()
    });
    expect(reclaimed).toMatchObject({
      revision: 2,
      lastFencingToken: 2,
      lease: { id: "new-lease", fencingToken: 2 }
    });
  });

  it("keeps repeated merge-preview GETs byte- and mtime-stable with no claim side effects", async () => {
    const dataRoot = temporaryRoot("multi-agent-dispatcher-get-");
    const runId = "run-delivery-dispatch-get-1";
    const queueKey = deliveryQueueKey(path.join(dataRoot, "repo"), "main");
    await writeReadyDelivery(dataRoot, runId, queueKey);
    const runDir = runDirectory(dataRoot, runId);
    writeRun(runDir, { runId });
    const deliveryFile = path.join(runDir, "delivery.json");
    const revisionDirectory = path.join(runDir, "delivery-revisions");
    const revisionFiles = fs.readdirSync(revisionDirectory).sort().map((name) => path.join(revisionDirectory, name));
    const before = [deliveryFile, ...revisionFiles].map(fileEvidence);
    const service = await WorkbenchService.open({ dataRoot });

    await service.getRunMergePreview(runId);
    await service.getRunMergePreview(runId);

    expect([deliveryFile, ...revisionFiles].map(fileEvidence)).toEqual(before);
    expect(fs.existsSync(path.join(dataRoot, "artifacts", "delivery-dispatch"))).toBe(false);
    const read = await new RunDeliveryStore(runsRoot(dataRoot)).readDelivery(runId);
    expect(read).toMatchObject({ kind: "valid", record: { dispatch: { state: "ready", attempt: 0 } } });
  });

  it("fences a stale worker catch after an owner records a terminal disposition", async () => {
    const dataRoot = temporaryRoot("multi-agent-dispatcher-stale-");
    const runId = "run-delivery-dispatch-stale-1";
    const queueKey = deliveryQueueKey(path.join(dataRoot, "repo"), "main");
    await writeReadyDelivery(dataRoot, runId, queueKey);
    const service = await WorkbenchService.open({ dataRoot });
    const handle = await service.claimNextDelivery(queueKey, "daemon-stale");
    expect(handle).toBeDefined();
    const store = new RunDeliveryStore(runsRoot(dataRoot));
    const current = await store.readDelivery(runId);
    expect(current.kind).toBe("valid");
    if (current.kind !== "valid") throw new Error("expected valid delivery");
    const terminal = await store.advanceDelivery(runId, current.revision, [{
      kind: "record",
      status: current.record.status,
      dispatchState: "leased",
      leaseId: handle!.leaseId
    }], {
      type: "discard.unverified",
      actor: "owner",
      payload: {
        reason: "worktree-missing",
        fingerprint: "stale-test",
        outcome: "unknown",
        cleanup: { checkedAt: new Date().toISOString(), worktree: "missing", sourceBranch: "unknown" },
        message: "terminal owner disposition"
      }
    });
    expect(terminal.status).toBe("discarded");

    await handle!.fail("late-worker", "must not overwrite terminal");
    const after = await store.readDelivery(runId);
    expect(after).toMatchObject({
      kind: "valid",
      revision: terminal.revision,
      record: { status: "discarded", message: "terminal owner disposition" }
    });
  });

  it("reconciles completed discard cleanup and a target-ref-updated merge intent after restart", async () => {
    const dataRoot = temporaryRoot("multi-agent-dispatcher-intents-");
    const repo = repository();
    const store = new RunDeliveryStore(runsRoot(dataRoot));

    const discardRunId = "run-delivery-dispatch-discard-crash-1";
    const discardWorktree = await createRunWorktree(repo, discardRunId);
    expect(discardWorktree).not.toBeNull();
    const discardBranch = `codex/${discardRunId}`;
    git(discardWorktree!.path, "switch", "-c", discardBranch);
    fs.writeFileSync(path.join(discardWorktree!.path, "discard.txt"), "discard\n", "utf8");
    git(discardWorktree!.path, "add", "discard.txt");
    git(discardWorktree!.path, "commit", "-m", "discard candidate");
    const discardSource = git(discardWorktree!.path, "rev-parse", "HEAD");
    const discardRunDir = runDirectory(dataRoot, discardRunId);
    writeRun(discardRunDir, {
      runId: discardRunId,
      worktreePath: discardWorktree!.path,
      baseCommit: discardWorktree!.baseCommit
    });
    const discardPrepared = await store.advanceDelivery(discardRunId, 0, [{ kind: "absent" }], {
      ...sourceEvent(discardRunId, discardWorktree!.baseCommit),
      payload: {
        ...sourceEvent(discardRunId, discardWorktree!.baseCommit).payload,
        sourceCommit: discardSource
      }
    } as DeliveryEvent);
    await store.advanceDelivery(discardRunId, discardPrepared.revision, [{ kind: "record", status: "awaiting-acceptance" }], {
      type: "discard.intent-prepared",
      actor: "owner",
      payload: {
        intentId: "discard-intent",
        baseCommit: discardWorktree!.baseCommit,
        sourceBranch: discardBranch,
        sourceCommit: discardSource,
        targetBranch: "main",
        message: "discard intent persisted"
      }
    });
    git(repo, "worktree", "remove", "--force", discardWorktree!.path);
    git(repo, "branch", "-D", discardBranch);

    const mergeRunId = "run-delivery-dispatch-merge-crash-1";
    const mergeWorktree = await createRunWorktree(repo, mergeRunId);
    expect(mergeWorktree).not.toBeNull();
    const mergeBranch = `codex/${mergeRunId}`;
    git(mergeWorktree!.path, "switch", "-c", mergeBranch);
    fs.writeFileSync(path.join(mergeWorktree!.path, "merge.txt"), "merge\n", "utf8");
    git(mergeWorktree!.path, "add", "merge.txt");
    git(mergeWorktree!.path, "commit", "-m", "merge candidate");
    const mergeSource = git(mergeWorktree!.path, "rev-parse", "HEAD");
    const expectedTarget = git(repo, "rev-parse", "main");
    const mergeRunDir = runDirectory(dataRoot, mergeRunId);
    writeRun(mergeRunDir, {
      runId: mergeRunId,
      worktreePath: mergeWorktree!.path,
      baseCommit: mergeWorktree!.baseCommit
    });
    const mergeSourceRecord = await store.advanceDelivery(mergeRunId, 0, [{ kind: "absent" }], {
      ...sourceEvent(mergeRunId, expectedTarget),
      payload: { ...sourceEvent(mergeRunId, expectedTarget).payload, sourceCommit: mergeSource }
    } as DeliveryEvent);
    const queueKey = deliveryQueueKey(repo, "main");
    const approved = await store.advanceDelivery(mergeRunId, mergeSourceRecord.revision, [{ kind: "record", status: "awaiting-acceptance" }], {
      type: "merge.approved",
      actor: "owner",
      payload: { targetBranch: "main", queuedTargetCommit: expectedTarget, queueKey, message: "approved" }
    });
    const validated = await store.advanceDelivery(mergeRunId, approved.revision, [{ kind: "record", status: "queued-for-merge" }], {
      type: "validation.passed",
      actor: "runtime",
      payload: { required: false, targetCommit: expectedTarget, message: "validated" }
    });
    const tree = git(repo, "merge-tree", "--write-tree", expectedTarget, mergeSource).split("\n", 1)[0]!;
    const preparedCommit = git(
      repo,
      "commit-tree", tree,
      "-p", expectedTarget,
      "-p", mergeSource,
      "-m", `Merge ${mergeBranch} into main`
    );
    await store.advanceDelivery(mergeRunId, validated.revision, [{ kind: "record", status: "merging" }], {
      type: "merge.intent-prepared",
      actor: "runtime",
      payload: {
        intentId: "merge-intent",
        targetRef: "refs/heads/main",
        expectedTargetCommit: expectedTarget,
        sourceCommit: mergeSource,
        preparedMergeCommit: preparedCommit,
        message: "merge intent persisted"
      }
    });
    git(repo, "update-ref", "refs/heads/main", preparedCommit, expectedTarget);

    const service = await WorkbenchService.open({ dataRoot });
    await service.recoverDeliveryDispatches();
    const discarded = await waitForDelivery(store, discardRunId, (record) => record.status === "discarded");
    const merged = await waitForDelivery(store, mergeRunId, (record) => record.status === "merged");
    expect(discarded).toMatchObject({ cleanupVerified: true, outcome: "not-merged" });
    expect(merged).toMatchObject({ outcome: "merged", mergeCommit: preparedCommit });
    expect(git(repo, "rev-parse", "main")).toBe(preparedCommit);
  }, 20_000);
});
