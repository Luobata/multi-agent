import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowRunRecord } from "../src/core/types.js";
import { createRunWorktree } from "../src/runtime/worktree.js";
import {
  advanceDeliveryEvent,
  previewRunMerge,
  queueAcceptedRun
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
  const root = temporaryRoot("multi-agent-delivery-recovery-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "delivery@example.com");
  git(root, "config", "user.name", "Delivery Test");
  fs.writeFileSync(path.join(root, ".gitignore"), ".multi-agent/\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "seed\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-m", "seed");
  return root;
}

function artifactDirectory(dataRoot: string, runId: string): string {
  const dir = path.join(dataRoot, "artifacts", "runs", runId);
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evidence", "acceptance.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return dir;
}

function runRecord(runId: string, runDir: string, worktreePath: string, baseCommit: string): WorkflowRunRecord {
  return {
    id: runId,
    workflow: "delivery-recovery",
    architecture: "supervisor",
    manifestPath: path.join(runDir, "multi-agent.yaml"),
    artifactDir: runDir,
    status: "passed",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    isolation: { mode: "worktree", worktreePath, baseCommit },
    output: {
      gates: [
        { gateId: "quality-test", requiredCapability: "quality.test", mode: "before-completion", required: true, status: "passed" },
        { gateId: "quality-audit", requiredCapability: "quality.audit", mode: "before-completion", required: true, status: "passed" }
      ]
    },
    nodes: {}
  };
}

async function queueAndReturn(
  dataRoot: string,
  repo: string,
  runId: string
): Promise<{ run: WorkflowRunRecord; runDir: string; delivery: Awaited<ReturnType<typeof queueAcceptedRun>>["delivery"] }> {
  const worktree = await createRunWorktree(repo, runId);
  expect(worktree).not.toBeNull();
  fs.writeFileSync(path.join(worktree!.path, "candidate.txt"), "candidate change\n", "utf8");
  const runDir = artifactDirectory(dataRoot, runId);
  const run = runRecord(runId, runDir, worktree!.path, worktree!.baseCommit);
  fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  const queued = await queueAcceptedRun(run, runDir, {
    confirmation: `MERGE ${runId}`,
    targetBranch: "main",
    actor: "delivery-reviewer"
  });
  return { run, runDir, delivery: queued.delivery };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("delivery recovery — returned-to-acceptance", () => {
  it("allows retryRunMergeConflict for returned-to-acceptance with humanDecision=merge", async () => {
    const dataRoot = temporaryRoot("multi-agent-dr-data-");
    const repo = repository();
    const runId = "run-dr-retry-1";
    const { runDir, delivery } = await queueAndReturn(dataRoot, repo, runId);

    // Advance to returned-to-acceptance: validation.started → validation.failed
    const started = await advanceDeliveryEvent(runDir, runId, delivery.revision, {
      type: "validation.started",
      actor: "runtime",
      payload: { targetCommit: delivery.queuedTargetCommit!, message: "validating" }
    });
    await advanceDeliveryEvent(runDir, runId, started.revision, {
      type: "validation.failed",
      actor: "runtime",
      payload: { targetCommit: delivery.queuedTargetCommit!, message: "validation failed" }
    });

    const service = await WorkbenchService.open({ dataRoot });
    // Should not throw — returned-to-acceptance with humanDecision=merge is allowed.
    const result = await service.retryRunMergeConflict(runId, { actor: "owner" });
    expect(["conflict", "retesting"]).toContain(result.status);
  });

  it("skips baseCommit mismatch in prepareAcceptedSource for returned-to-acceptance with approval", async () => {
    const dataRoot = temporaryRoot("multi-agent-dr-data-");
    const repo = repository();
    const runId = "run-dr-basecommit-1";
    const { run, runDir, delivery } = await queueAndReturn(dataRoot, repo, runId);

    // Advance to returned-to-acceptance
    const started = await advanceDeliveryEvent(runDir, runId, delivery.revision, {
      type: "validation.started",
      actor: "runtime",
      payload: { targetCommit: delivery.queuedTargetCommit!, message: "validating" }
    });
    await advanceDeliveryEvent(runDir, runId, started.revision, {
      type: "validation.failed",
      actor: "runtime",
      payload: { targetCommit: delivery.queuedTargetCommit!, message: "validation failed" }
    });

    // Simulate baseCommit drift by changing the run's isolation.baseCommit
    const runPath = path.join(runDir, "run.json");
    const runRecord = JSON.parse(fs.readFileSync(runPath, "utf8")) as WorkflowRunRecord;
    runRecord.isolation = { mode: "worktree", worktreePath: runRecord.isolation?.worktreePath ?? "", baseCommit: "0".repeat(40) };
    fs.writeFileSync(runPath, JSON.stringify(runRecord, null, 2));

    // queueAcceptedRun calls prepareAcceptedSource; should not throw on baseCommit mismatch.
    const requeued = await queueAcceptedRun(run, runDir, {
      confirmation: `MERGE ${runId}`,
      targetBranch: "main",
      actor: "delivery-reviewer"
    });
    expect(requeued.delivery.status).toBe("queued-for-merge");
  });
});

describe("delivery recovery — git reality sync", () => {
  it("auto-syncs to merged when sourceCommit is already in the target branch", async () => {
    const dataRoot = temporaryRoot("multi-agent-dr-data-");
    const repo = repository();
    const runId = "run-dr-git-sync-1";
    const { run, runDir, delivery } = await queueAndReturn(dataRoot, repo, runId);

    // Manually merge the sourceCommit into main (simulating a manual merge)
    const sourceCommit = delivery.sourceCommit!;
    git(repo, "merge", "--no-edit", sourceCommit);

    const preview = await previewRunMerge(run, runDir);
    expect(preview.status).toBe("merged");
    expect(preview.delivery?.status).toBe("merged");
    expect(preview.delivery?.mergeCommit).toBe(sourceCommit);
  });

  it("does not auto-sync when sourceCommit is not in the target branch", async () => {
    const dataRoot = temporaryRoot("multi-agent-dr-data-");
    const repo = repository();
    const runId = "run-dr-git-sync-no-1";
    const { run, runDir } = await queueAndReturn(dataRoot, repo, runId);

    const preview = await previewRunMerge(run, runDir);
    // Should not be merged — sourceCommit is on a branch, not in main.
    expect(preview.status).not.toBe("merged");
    expect(preview.delivery?.status).toBe("queued-for-merge");
  });

  it("is idempotent — calling previewRunMerge twice returns merged both times", async () => {
    const dataRoot = temporaryRoot("multi-agent-dr-data-");
    const repo = repository();
    const runId = "run-dr-git-sync-idem-1";
    const { run, runDir, delivery } = await queueAndReturn(dataRoot, repo, runId);

    const sourceCommit = delivery.sourceCommit!;
    git(repo, "merge", "--no-edit", sourceCommit);

    const first = await previewRunMerge(run, runDir);
    expect(first.status).toBe("merged");
    const second = await previewRunMerge(run, runDir);
    expect(second.status).toBe("merged");
    expect(second.delivery?.mergeCommit).toBe(sourceCommit);
  });
});
