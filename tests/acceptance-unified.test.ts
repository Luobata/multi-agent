import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveAcceptanceEvidence,
  RunDeliveryStore,
  type AcceptanceEvidenceRef
} from "../src/runtime/worktreeDelivery.js";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const REVISION = `sha256:${"c".repeat(64)}`;

function sampleEvidence(overrides: Partial<AcceptanceEvidenceRef> = {}): AcceptanceEvidenceRef {
  return {
    kind: "merge-queue-retest",
    archivedAt: "2026-08-19T00:00:00.000Z",
    testRunId: "inv-acceptance-1",
    url: "http://127.0.0.1:59999/?candidate-token=token",
    sourceCommit: COMMIT_A,
    targetCommit: COMMIT_B,
    candidateRevision: REVISION,
    items: [],
    ...overrides
  };
}

describe("acceptance evidence archive", () => {
  it("archives the structured retest output and midscene reports with sha256 references", async () => {
    const root = temporaryRoot("acceptance-archive-");
    const runDir = path.join(root, "artifacts", "runs", "run-acceptance-1");
    const worktreePath = path.join(root, "worktree");
    fs.mkdirSync(path.join(worktreePath, "midscene_run", "report"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "midscene_run", "report", "run-1.html"), "<html>report</html>");
    fs.writeFileSync(path.join(worktreePath, "midscene_run", "report", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const ref = await archiveAcceptanceEvidence({
      kind: "conflict-retest",
      runDir,
      testRunId: "inv-acceptance-1",
      url: "http://127.0.0.1:59999/?candidate-token=token",
      sourceCommit: COMMIT_A,
      targetCommit: COMMIT_B,
      candidateRevision: REVISION,
      invocationStatus: "passed",
      message: "回归通过",
      output: { verdict: "pass", summary: "CANDIDATE_IDENTITY ok" },
      worktreePath
    });

    expect(ref.kind).toBe("conflict-retest");
    expect(ref.archiveError).toBeUndefined();
    expect(ref.items).toHaveLength(3);
    const outputItem = ref.items.find((item) => item.type === "retest-output");
    const reportItem = ref.items.find((item) => item.type === "midscene-report");
    const screenshotItem = ref.items.find((item) => item.type === "screenshot");
    expect(outputItem).toBeDefined();
    expect(reportItem).toBeDefined();
    expect(screenshotItem).toBeDefined();

    for (const item of ref.items) {
      const absolute = path.join(runDir, item.relativePath.split("/").join(path.sep));
      expect(fs.existsSync(absolute)).toBe(true);
      const bytes = fs.readFileSync(absolute);
      expect(item.sizeBytes).toBe(bytes.length);
      expect(item.sha256).toBe(sha256(bytes));
      expect(item.relativePath.startsWith("delivery-evidence/inv-acceptance-1/")).toBe(true);
    }

    const archived = JSON.parse(fs.readFileSync(path.join(runDir, outputItem!.relativePath.split("/").join(path.sep)), "utf8")) as {
      kind: string;
      testRunId: string;
      output: { verdict: string };
    };
    expect(archived.kind).toBe("conflict-retest");
    expect(archived.testRunId).toBe("inv-acceptance-1");
    expect(archived.output.verdict).toBe("pass");
  });

  it("is best-effort: a missing midscene directory archives only the output without errors", async () => {
    const root = temporaryRoot("acceptance-archive-empty-");
    const runDir = path.join(root, "runs", "run-acceptance-2");
    const worktreePath = path.join(root, "worktree");
    fs.mkdirSync(worktreePath, { recursive: true });

    const ref = await archiveAcceptanceEvidence({
      kind: "merge-queue-retest",
      runDir,
      testRunId: "inv-acceptance-2",
      url: "http://127.0.0.1:59999/",
      sourceCommit: COMMIT_A,
      targetCommit: COMMIT_B,
      candidateRevision: REVISION,
      invocationStatus: "passed",
      message: "ok",
      output: { verdict: "pass" },
      worktreePath
    });

    expect(ref.archiveError).toBeUndefined();
    expect(ref.items).toHaveLength(1);
    expect(ref.items[0]?.type).toBe("retest-output");
  });

  it("records partial failures in archiveError instead of throwing", async () => {
    const root = temporaryRoot("acceptance-archive-partial-");
    const runDir = path.join(root, "runs", "run-acceptance-3");
    const worktreePath = path.join(root, "worktree");
    fs.mkdirSync(worktreePath, { recursive: true });
    // midscene_run as a file makes the walk fail with ENOTDIR — output must still archive.
    fs.writeFileSync(path.join(worktreePath, "midscene_run"), "not a directory");

    const ref = await archiveAcceptanceEvidence({
      kind: "merge-queue-retest",
      runDir,
      testRunId: "inv-acceptance-3",
      url: "http://127.0.0.1:59999/",
      sourceCommit: COMMIT_A,
      targetCommit: COMMIT_B,
      candidateRevision: REVISION,
      invocationStatus: "passed",
      message: "ok",
      output: { verdict: "pass" },
      worktreePath
    });

    expect(ref.items).toHaveLength(1);
    expect(ref.archiveError).toContain("midscene_run");
  });
});

describe("delivery record evidence references", () => {
  it("round-trips mergeValidation.evidence through validation.passed", async () => {
    const root = temporaryRoot("acceptance-delivery-");
    const runId = "run-acceptance-delivery-1";
    const runDir = path.join(root, "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    const store = RunDeliveryStore.forRunDirectory(runDir, runId);
    const evidence = sampleEvidence();

    await store.advanceDelivery(runId, 0, [{ kind: "absent" }], {
      type: "source.prepared",
      actor: "runtime",
      payload: {
        baseCommit: COMMIT_A,
        sourceBranch: "candidate",
        sourceCommit: COMMIT_A,
        targetBranch: "main",
        targetCommitBeforeMerge: COMMIT_B
      }
    });
    await store.advanceDelivery(runId, 1, [{ kind: "record", status: "awaiting-acceptance" }], {
      type: "merge.approved",
      actor: "reviewer",
      payload: { targetBranch: "main", queuedTargetCommit: COMMIT_B, message: "approved" }
    });
    await store.advanceDelivery(runId, 2, [{ kind: "record", status: "queued-for-merge" }], {
      type: "validation.started",
      actor: "runtime",
      payload: { targetCommit: COMMIT_B, message: "started" }
    });
    const passed = await store.advanceDelivery(runId, 3, [{ kind: "record", status: "retesting" }], {
      type: "validation.passed",
      actor: "runtime",
      payload: { required: true, targetCommit: COMMIT_B, runId: "inv-acceptance-1", message: "passed", evidence }
    });

    expect(passed.mergeValidation?.evidence).toEqual(evidence);
    const read = await store.readDelivery(runId);
    expect(read).toMatchObject({ kind: "valid", revision: 4 });
    if (read.kind === "valid") {
      expect(read.record.mergeValidation?.evidence).toEqual(evidence);
      expect(read.record.mergeValidation?.status).toBe("passed");
    }
  });

  it("round-trips conflictResolution.evidence through conflict.stage-completed tested", async () => {
    const root = temporaryRoot("acceptance-conflict-");
    const runId = "run-acceptance-conflict-1";
    const runDir = path.join(root, "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    const store = RunDeliveryStore.forRunDirectory(runDir, runId);
    const evidence = sampleEvidence({ kind: "conflict-retest" });

    await store.advanceDelivery(runId, 0, [{ kind: "absent" }], {
      type: "source.prepared",
      actor: "runtime",
      payload: {
        baseCommit: COMMIT_A,
        sourceBranch: "candidate",
        sourceCommit: COMMIT_A,
        targetBranch: "main",
        targetCommitBeforeMerge: COMMIT_B
      }
    });
    await store.advanceDelivery(runId, 1, [{ kind: "record", status: "awaiting-acceptance" }], {
      type: "merge.approved",
      actor: "reviewer",
      payload: { targetBranch: "main", queuedTargetCommit: COMMIT_B, message: "approved" }
    });
    await store.advanceDelivery(runId, 2, [{ kind: "record", status: "queued-for-merge" }], {
      type: "conflict.started",
      actor: "runtime",
      payload: { targetCommit: COMMIT_B, message: "conflict" }
    });
    await store.advanceDelivery(runId, 3, [{ kind: "record", status: "conflict", conflictStatus: "resolving" }], {
      type: "conflict.stage-completed",
      actor: "runtime",
      payload: { stage: "planned", leaderPlanRunId: "inv-plan-1", executionRoleId: "backend-developer", message: "planned" }
    });
    await store.advanceDelivery(runId, 4, [{ kind: "record", status: "conflict", conflictStatus: "resolving" }], {
      type: "conflict.stage-completed",
      actor: "runtime",
      payload: { stage: "executed", leaderPlanRunId: "inv-plan-1", executionRoleId: "backend-developer", message: "executed" }
    });
    await store.advanceDelivery(runId, 5, [{ kind: "record", status: "conflict", conflictStatus: "resolving" }], {
      type: "conflict.stage-completed",
      actor: "runtime",
      payload: { stage: "rebased", targetCommit: COMMIT_B, sourceCommit: COMMIT_A, message: "rebased" }
    });
    const tested = await store.advanceDelivery(runId, 6, [{ kind: "record", status: "retesting", conflictStatus: "retesting" }], {
      type: "conflict.stage-completed",
      actor: "runtime",
      payload: {
        stage: "tested",
        testRunId: "inv-acceptance-1",
        testedSourceCommit: COMMIT_A,
        testedCandidateRevision: REVISION,
        testedUrl: "http://127.0.0.1:59999/",
        message: "tested",
        evidence
      }
    });

    expect(tested.conflictResolution?.status).toBe("leader-review");
    expect(tested.conflictResolution?.evidence).toEqual(evidence);
    const read = await store.readDelivery(runId);
    expect(read).toMatchObject({ kind: "valid", revision: 7 });
    if (read.kind === "valid") {
      expect(read.record.conflictResolution?.evidence).toEqual(evidence);
    }
  });

  it("rejects records whose evidence reference is corrupt", async () => {
    const root = temporaryRoot("acceptance-corrupt-");
    const runId = "run-acceptance-corrupt-1";
    const runDir = path.join(root, "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    const store = RunDeliveryStore.forRunDirectory(runDir, runId);
    const badEvidence = { ...sampleEvidence(), items: [{ type: "retest-output", relativePath: "../escape.json", sha256: "sha256:bad", sizeBytes: -1 }] };

    await store.advanceDelivery(runId, 0, [{ kind: "absent" }], {
      type: "source.prepared",
      actor: "runtime",
      payload: {
        baseCommit: COMMIT_A,
        sourceBranch: "candidate",
        sourceCommit: COMMIT_A,
        targetBranch: "main",
        targetCommitBeforeMerge: COMMIT_B
      }
    });
    await store.advanceDelivery(runId, 1, [{ kind: "record", status: "awaiting-acceptance" }], {
      type: "merge.approved",
      actor: "reviewer",
      payload: { targetBranch: "main", queuedTargetCommit: COMMIT_B, message: "approved" }
    });
    await store.advanceDelivery(runId, 2, [{ kind: "record", status: "queued-for-merge" }], {
      type: "validation.started",
      actor: "runtime",
      payload: { targetCommit: COMMIT_B, message: "started" }
    });
    // The reducer stores whatever the event carries; corruption is caught at read time.
    await store.advanceDelivery(runId, 3, [{ kind: "record", status: "retesting" }], {
      type: "validation.passed",
      actor: "runtime",
      payload: {
        required: true,
        targetCommit: COMMIT_B,
        runId: "inv-acceptance-1",
        message: "passed",
        evidence: badEvidence as unknown as AcceptanceEvidenceRef
      }
    });

    const read = await store.readDelivery(runId);
    expect(read.kind).toBe("corrupt");
    if (read.kind === "corrupt") {
      expect(read.reason).toContain("mergeValidation.evidence");
    }
  });
});
