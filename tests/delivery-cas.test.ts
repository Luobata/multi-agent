import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeliveryRevisionConflict,
  DeliveryTransitionError,
  RunDeliveryStore,
  type ConflictResolutionStatus,
  type DeliveryEvent,
  type DeliveryStateSelector,
  type DeliveryStatus,
  type RunDeliveryRecord
} from "../src/runtime/worktreeDelivery.js";

const roots: string[] = [];

function temporaryRunsRoot(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  const runsRoot = path.join(root, "artifacts", "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  return runsRoot;
}

function runDirectory(runsRoot: string, runId: string): string {
  const runDir = path.join(runsRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function legacyRecord(
  runId: string,
  status: DeliveryStatus = "awaiting-acceptance",
  extra: Partial<RunDeliveryRecord> = {}
): RunDeliveryRecord {
  return {
    runId,
    status,
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...extra
  };
}

function writeLegacy(runsRoot: string, runId: string, record: RunDeliveryRecord): string {
  const runDir = runDirectory(runsRoot, runId);
  const deliveryFile = path.join(runDir, "delivery.json");
  fs.writeFileSync(deliveryFile, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return deliveryFile;
}

function sourcePreparedEvent(): DeliveryEvent {
  return {
    type: "source.prepared",
    actor: "runtime",
    payload: {
      baseCommit: "a".repeat(40),
      sourceBranch: "codex/run-delivery-cas",
      sourceCommit: "b".repeat(40),
      targetBranch: "main",
      targetCommitBeforeMerge: "a".repeat(40)
    }
  };
}

function selector(status: DeliveryStatus, conflictStatus?: ConflictResolutionStatus): DeliveryStateSelector {
  return {
    kind: "record",
    status,
    ...(conflictStatus ? { conflictStatus } : {})
  };
}

async function childAdvance(runsRoot: string, runId: string): Promise<{ name: string; revision?: number }> {
  const moduleUrl = pathToFileURL(path.resolve("src/runtime/worktreeDelivery.ts")).href;
  const script = [
    `import { RunDeliveryStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = new RunDeliveryStore(${JSON.stringify(runsRoot)});`,
    "try {",
    `  const record = await store.advanceDelivery(${JSON.stringify(runId)}, 0, [{ kind: 'absent' }], ${JSON.stringify(sourcePreparedEvent())});`,
    "  process.stdout.write(JSON.stringify({ name: 'success', revision: record.revision }));",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({ name: error instanceof Error ? error.name : String(error) }));",
    "}"
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: path.resolve("."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`delivery CAS child exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as { name: string; revision?: number });
    });
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("RunDeliveryStore immutable CAS", () => {
  it("reads legacy records without changing bytes or mtime, then advances from revision zero strictly by one", async () => {
    const runsRoot = temporaryRunsRoot("multi-agent-delivery-cas-legacy-");
    const runId = "run-delivery-cas-legacy-1";
    const deliveryFile = writeLegacy(runsRoot, runId, legacyRecord(runId));
    const beforeBytes = fs.readFileSync(deliveryFile);
    const beforeStat = fs.statSync(deliveryFile);
    const store = new RunDeliveryStore(runsRoot);

    const legacy = await store.readDelivery(runId);

    expect(legacy).toMatchObject({ kind: "valid", revision: 0, record: { schemaVersion: 2, revision: 0 } });
    expect(digest(fs.readFileSync(deliveryFile, "utf8"))).toBe(digest(beforeBytes.toString("utf8")));
    expect(fs.statSync(deliveryFile).mtimeMs).toBe(beforeStat.mtimeMs);

    const first = await store.advanceDelivery(runId, 0, [selector("awaiting-acceptance")], sourcePreparedEvent());
    expect(first).toMatchObject({ schemaVersion: 2, revision: 1, lastEvent: { fromRevision: 0, toRevision: 1 } });
    const second = await store.advanceDelivery(runId, 1, [selector("awaiting-acceptance")], {
      type: "merge.approved",
      actor: "reviewer",
      payload: { targetBranch: "main", queuedTargetCommit: "a".repeat(40), message: "approved" }
    });
    expect(second).toMatchObject({ revision: 2, lastEvent: { fromRevision: 1, toRevision: 2 } });
    expect(fs.readdirSync(path.join(path.dirname(deliveryFile), "delivery-revisions")).sort()).toEqual([
      "00000000000000000001.json",
      "00000000000000000002.json"
    ]);
  });

  it("lets exactly one of two processes publish expected revision N+1", async () => {
    const runsRoot = temporaryRunsRoot("multi-agent-delivery-cas-process-");
    const runId = "run-delivery-cas-process-1";
    runDirectory(runsRoot, runId);

    const outcomes = await Promise.all([childAdvance(runsRoot, runId), childAdvance(runsRoot, runId)]);

    expect(outcomes.filter((outcome) => outcome.name === "success")).toEqual([{ name: "success", revision: 1 }]);
    expect(outcomes.filter((outcome) => outcome.name === "DeliveryRevisionConflict")).toHaveLength(1);
    const read = await new RunDeliveryStore(runsRoot).readDelivery(runId);
    expect(read).toMatchObject({ kind: "valid", revision: 1 });
    expect(fs.readdirSync(path.join(runsRoot, runId, "delivery-revisions"))).toEqual([
      "00000000000000000001.json"
    ]);
  });

  it("enforces the allowed transition table for every delivery status and conflict substate", async () => {
    const runsRoot = temporaryRunsRoot("multi-agent-delivery-cas-table-");
    const targetCommit = "c".repeat(40);
    const mergeIntent = (): DeliveryEvent => ({
      type: "merge.intent-prepared",
      actor: "runtime",
      payload: {
        intentId: "intent-1",
        targetRef: "refs/heads/main",
        expectedTargetCommit: targetCommit,
        sourceCommit: "d".repeat(40),
        preparedMergeCommit: "e".repeat(40),
        message: "prepared"
      }
    });
    const cases: Array<{
      name: string;
      status: DeliveryStatus;
      conflictStatus?: ConflictResolutionStatus;
      event: DeliveryEvent;
      allowed: boolean;
    }> = [
      { name: "awaiting keep", status: "awaiting-acceptance", event: {
        type: "keep.recorded", actor: "reviewer", payload: {
          baseCommit: targetCommit, targetBranch: "main", message: "kept"
        }
      }, allowed: true },
      { name: "queued validation", status: "queued-for-merge", event: {
        type: "validation.started", actor: "runtime", payload: { targetCommit, message: "testing" }
      }, allowed: true },
      { name: "retesting validation pass", status: "retesting", event: {
        type: "validation.passed", actor: "runtime", payload: {
          required: true, targetCommit, runId: "validation-1", message: "passed"
        }
      }, allowed: true },
      { name: "merging intent", status: "merging", event: mergeIntent(), allowed: true },
      { name: "returned keep", status: "returned-to-acceptance", event: {
        type: "keep.recorded", actor: "reviewer", payload: {
          baseCommit: targetCommit, targetBranch: "main", message: "kept"
        }
      }, allowed: true },
      { name: "conflict resolving", status: "conflict", conflictStatus: "resolving", event: {
        type: "conflict.stage-completed", actor: "runtime", payload: {
          stage: "planned", leaderPlanRunId: "plan-1", executionRoleId: "backend-developer", message: "planned"
        }
      }, allowed: true },
      { name: "conflict retesting", status: "retesting", conflictStatus: "retesting", event: {
        type: "conflict.stage-completed", actor: "runtime", payload: {
          stage: "tested", testRunId: "test-1", testedSourceCommit: "d".repeat(40),
          testedCandidateRevision: "candidate-1", testedUrl: "http://127.0.0.1:4318", message: "tested"
        }
      }, allowed: true },
      { name: "conflict leader review", status: "retesting", conflictStatus: "leader-review", event: {
        type: "conflict.stage-completed", actor: "runtime", payload: {
          stage: "leader-approved", leaderReviewRunId: "leader-1", message: "approved"
        }
      }, allowed: true },
      { name: "conflict failed retry", status: "conflict", conflictStatus: "failed", event: {
        type: "merge.approved", actor: "reviewer", payload: {
          targetBranch: "main", queuedTargetCommit: targetCommit, message: "retry"
        }
      }, allowed: true },
      { name: "conflict passed rejects repeat stage", status: "conflict", conflictStatus: "passed", event: {
        type: "conflict.stage-completed", actor: "runtime", payload: {
          stage: "leader-approved", leaderReviewRunId: "leader-2", message: "repeat"
        }
      }, allowed: false },
      { name: "merged terminal", status: "merged", event: {
        type: "keep.recorded", actor: "reviewer", payload: {
          baseCommit: targetCommit, targetBranch: "main", message: "regress"
        }
      }, allowed: false },
      { name: "kept approval", status: "kept", event: {
        type: "merge.approved", actor: "reviewer", payload: {
          targetBranch: "main", queuedTargetCommit: targetCommit, message: "approved"
        }
      }, allowed: true },
      { name: "discarded terminal", status: "discarded", event: {
        type: "evidence.queued", actor: "reviewer", payload: { evidenceRerun: {
          status: "queued", actor: "reviewer", requestedAt: "2026-08-16T00:00:00.000Z",
          updatedAt: "2026-08-16T00:00:00.000Z"
        } }
      }, allowed: false }
    ];

    for (const [index, testCase] of cases.entries()) {
      const runId = `run-delivery-cas-table-${index + 1}`;
      const extra: Partial<RunDeliveryRecord> = {};
      if (testCase.status === "merging") {
        extra.sourceCommit = "d".repeat(40);
        extra.mergeValidation = {
          required: false,
          status: "not-required",
          targetCommit,
          updatedAt: "2026-08-16T00:00:00.000Z"
        };
      }
      if (testCase.name === "retesting validation pass") {
        extra.mergeValidation = {
          required: true,
          status: "running",
          targetCommit,
          updatedAt: "2026-08-16T00:00:00.000Z"
        };
      }
      if (testCase.conflictStatus) {
        if (["retesting", "leader-review"].includes(testCase.conflictStatus)) {
          extra.sourceCommit = "d".repeat(40);
        }
        extra.conflictResolution = {
          status: testCase.conflictStatus,
          targetCommit,
          updatedAt: "2026-08-16T00:00:00.000Z",
          ...(testCase.conflictStatus === "leader-review" ? {
            testRunId: "test-0",
            testedSourceCommit: "d".repeat(40),
            testedCandidateRevision: "candidate-0",
            testedUrl: "http://127.0.0.1:4318"
          } : {})
        };
      }
      writeLegacy(runsRoot, runId, legacyRecord(runId, testCase.status, extra));
      const store = new RunDeliveryStore(runsRoot);
      const operation = store.advanceDelivery(
        runId,
        0,
        [selector(testCase.status, testCase.conflictStatus)],
        testCase.event
      );
      if (testCase.allowed) {
        await expect(operation, testCase.name).resolves.toMatchObject({ revision: 1 });
      } else {
        await expect(operation, testCase.name).rejects.toBeInstanceOf(DeliveryTransitionError);
      }
    }

    const mismatchRunId = "run-delivery-cas-allowed-from-mismatch-1";
    writeLegacy(runsRoot, mismatchRunId, legacyRecord(mismatchRunId));
    await expect(new RunDeliveryStore(runsRoot).advanceDelivery(
      mismatchRunId,
      0,
      [selector("kept")],
      sourcePreparedEvent()
    )).rejects.toThrow(/allowedFrom/);
  });

  it("fences late worker completion after keep/discard and never regresses terminal state", async () => {
    const runsRoot = temporaryRunsRoot("multi-agent-delivery-cas-late-worker-");
    const keepRunId = "run-delivery-cas-late-keep-1";
    const runningEvidence = {
      status: "running" as const,
      actor: "reviewer",
      requestedAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z"
    };
    writeLegacy(runsRoot, keepRunId, legacyRecord(keepRunId, "awaiting-acceptance", {
      evidenceRerun: runningEvidence
    }));
    const store = new RunDeliveryStore(runsRoot);
    const kept = await store.advanceDelivery(keepRunId, 0, [selector("awaiting-acceptance")], {
      type: "keep.recorded",
      actor: "reviewer",
      payload: { baseCommit: "a".repeat(40), targetBranch: "main", message: "kept" }
    });
    await expect(store.advanceDelivery(keepRunId, 0, [selector("awaiting-acceptance")], {
      type: "evidence.completed",
      actor: "reviewer",
      payload: { evidenceRerun: { ...runningEvidence, status: "passed" } }
    })).rejects.toBeInstanceOf(DeliveryRevisionConflict);
    expect((await store.readDelivery(keepRunId))).toMatchObject({
      kind: "valid", revision: kept.revision, record: { status: "kept", evidenceRerun: { status: "running" } }
    });

    const discardRunId = "run-delivery-cas-late-discard-1";
    writeLegacy(runsRoot, discardRunId, legacyRecord(discardRunId, "awaiting-acceptance", {
      evidenceRerun: runningEvidence
    }));
    const intent = await store.advanceDelivery(discardRunId, 0, [selector("awaiting-acceptance")], {
      type: "discard.intent-prepared",
      actor: "reviewer",
      payload: {
        intentId: "discard-intent-1",
        baseCommit: "a".repeat(40),
        sourceCommit: "b".repeat(40),
        targetBranch: "main",
        message: "discarding"
      }
    });
    const discarded = await store.advanceDelivery(discardRunId, intent.revision, [selector("awaiting-acceptance")], {
      type: "discard.completed",
      actor: "reviewer",
      payload: { intentId: "discard-intent-1", message: "discarded" }
    });
    await expect(store.advanceDelivery(discardRunId, 0, [selector("awaiting-acceptance")], {
      type: "evidence.completed",
      actor: "reviewer",
      payload: { evidenceRerun: { ...runningEvidence, status: "failed" } }
    })).rejects.toBeInstanceOf(DeliveryRevisionConflict);
    await expect(store.advanceDelivery(discardRunId, discarded.revision, [selector("discarded")], {
      type: "validation.failed",
      actor: "runtime",
      payload: { message: "late failure" }
    })).rejects.toBeInstanceOf(DeliveryTransitionError);
    expect((await store.readDelivery(discardRunId))).toMatchObject({
      kind: "valid", revision: discarded.revision, record: { status: "discarded", outcome: "not-merged" }
    });
  });

  it("makes conflict failure own and replace merge validation fields", async () => {
    const runsRoot = temporaryRunsRoot("multi-agent-delivery-cas-conflict-failure-");
    const runId = "run-delivery-cas-conflict-failure-1";
    const currentTarget = "c".repeat(40);
    writeLegacy(runsRoot, runId, legacyRecord(runId, "conflict", {
      conflictResolution: {
        status: "retesting",
        targetCommit: currentTarget,
        updatedAt: "2026-08-16T00:00:00.000Z"
      },
      mergeValidation: {
        required: true,
        status: "passed",
        runId: "stale-validation-run",
        targetCommit: "d".repeat(40),
        message: "stale pass",
        updatedAt: "2026-08-16T00:00:00.000Z"
      }
    }));
    const failed = await new RunDeliveryStore(runsRoot).advanceDelivery(
      runId,
      0,
      [selector("conflict", "retesting")],
      {
        type: "conflict.failed",
        actor: "runtime",
        payload: {
          targetCommit: currentTarget,
          failureClass: "environment-blocked",
          message: "MIDSCENE_ENVIRONMENT_BLOCKED"
        }
      }
    );

    expect(failed.mergeValidation).toMatchObject({
      required: true,
      status: "failed",
      targetCommit: currentTarget,
      message: "MIDSCENE_ENVIRONMENT_BLOCKED"
    });
    expect(failed.mergeValidation?.runId).toBeUndefined();
  });

  it("requires every busy stage event to match the active leaseId", async () => {
    const runsRoot = temporaryRunsRoot("multi-agent-delivery-cas-lease-");
    const runId = "run-delivery-cas-lease-1";
    writeLegacy(runsRoot, runId, legacyRecord(runId, "queued-for-merge"));
    const store = new RunDeliveryStore(runsRoot);
    const claimed = await store.advanceDelivery(runId, 0, [selector("queued-for-merge")], {
      type: "dispatch.claimed",
      actor: "runtime",
      payload: {
        queueKey: `sha256:${"a".repeat(64)}`,
        approvedAt: "2026-08-16T00:00:00.000Z",
        leaseId: "lease-current",
        ownerEpoch: "daemon-epoch-1",
        fencingToken: 1,
        expiresAt: "2026-08-16T00:01:00.000Z"
      }
    });
    const leasedSelector: DeliveryStateSelector = {
      kind: "record",
      status: "queued-for-merge",
      dispatchState: "leased",
      leaseId: "lease-current"
    };
    await expect(store.advanceDelivery(runId, claimed.revision, [leasedSelector], {
      type: "validation.started",
      actor: "runtime",
      payload: { leaseId: "lease-stale", targetCommit: "c".repeat(40), message: "stale worker" }
    })).rejects.toThrow(/leaseId/);

    const running = await store.advanceDelivery(runId, claimed.revision, [leasedSelector], {
      type: "validation.started",
      actor: "runtime",
      payload: { leaseId: "lease-current", targetCommit: "c".repeat(40), message: "current worker" }
    });
    expect(running).toMatchObject({
      status: "retesting",
      lastEvent: { leaseId: "lease-current" },
      dispatch: { state: "leased", lease: { id: "lease-current" } }
    });
  });

  it("recovers from a crash after snapshot publish and detects same-revision mixed writers", async () => {
    const runsRoot = temporaryRunsRoot("multi-agent-delivery-cas-crash-");
    const runId = "run-delivery-cas-crash-1";
    runDirectory(runsRoot, runId);
    const crashing = new RunDeliveryStore(runsRoot, {
      afterSnapshotPublish: () => { throw new Error("simulated projection crash"); }
    });

    await expect(crashing.advanceDelivery(runId, 0, [{ kind: "absent" }], sourcePreparedEvent()))
      .rejects.toThrow("simulated projection crash");
    expect(fs.existsSync(path.join(runsRoot, runId, "delivery.json"))).toBe(false);

    const recoveredStore = new RunDeliveryStore(runsRoot);
    const recovered = await recoveredStore.readDelivery(runId);
    expect(recovered).toMatchObject({ kind: "valid", revision: 1, record: { sourceCommit: "b".repeat(40) } });
    const next = await recoveredStore.advanceDelivery(runId, 1, [selector("awaiting-acceptance")], {
      type: "merge.approved",
      actor: "reviewer",
      payload: { targetBranch: "main", queuedTargetCommit: "a".repeat(40), message: "approved" }
    });
    expect(next.revision).toBe(2);
    await expect(recoveredStore.advanceDelivery(runId, 0, [selector("awaiting-acceptance")], sourcePreparedEvent()))
      .rejects.toBeInstanceOf(DeliveryRevisionConflict);

    const projectionFile = path.join(runsRoot, runId, "delivery.json");
    const tampered = JSON.parse(fs.readFileSync(projectionFile, "utf8")) as Record<string, unknown>;
    tampered.message = "old writer changed projection without advancing revision";
    fs.writeFileSync(projectionFile, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    const mixed = await recoveredStore.readDelivery(runId);
    expect(mixed).toMatchObject({ kind: "corrupt", revision: 2, reason: expect.stringContaining("mixed-writer-detected") });
  });

  it("distinguishes absent and corrupt projection shapes without rewriting them", async () => {
    const runsRoot = temporaryRunsRoot("multi-agent-delivery-cas-corrupt-");
    const store = new RunDeliveryStore(runsRoot);
    const absentRunId = "run-delivery-cas-absent-1";
    runDirectory(runsRoot, absentRunId);
    expect(await store.readDelivery(absentRunId)).toEqual({ kind: "absent", revision: 0 });

    const fixtures: Array<{ runId: string; raw: string; reason: RegExp }> = [
      { runId: "run-delivery-cas-syntax-1", raw: "{not-json", reason: /JSON is invalid/ },
      {
        runId: "run-delivery-cas-wrong-id-1",
        raw: JSON.stringify(legacyRecord("run-delivery-cas-other-1")),
        reason: /runId/
      },
      {
        runId: "run-delivery-cas-status-1",
        raw: JSON.stringify({ ...legacyRecord("run-delivery-cas-status-1"), status: "unknown" }),
        reason: /status/
      },
      {
        runId: "run-delivery-cas-revision-1",
        raw: JSON.stringify({
          ...legacyRecord("run-delivery-cas-revision-1"),
          schemaVersion: 2,
          revision: 0,
          lastEvent: {}
        }),
        reason: /schemaVersion\/revision/
      }
    ];
    for (const fixture of fixtures) {
      const file = path.join(runDirectory(runsRoot, fixture.runId), "delivery.json");
      fs.writeFileSync(file, fixture.raw, "utf8");
      const before = fs.readFileSync(file);
      const result = await store.readDelivery(fixture.runId);
      expect(result).toMatchObject({ kind: "corrupt", reason: expect.stringMatching(fixture.reason) });
      expect(fs.readFileSync(file)).toEqual(before);
    }
  });
});
