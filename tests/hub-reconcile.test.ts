import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectDeliveryChain,
  readRunDelivery,
  repairDeliveryChain,
  RunDeliveryStore
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

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const COMMIT_D = "d".repeat(40);

async function buildHealthyChain(root: string, runId: string): Promise<{ runDir: string; store: RunDeliveryStore }> {
  const runDir = path.join(root, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const store = RunDeliveryStore.forRunDirectory(runDir, runId);
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
  await store.advanceDelivery(runId, 3, [{ kind: "record", status: "retesting" }], {
    type: "validation.passed",
    actor: "runtime",
    payload: { required: true, targetCommit: COMMIT_B, runId: "inv-1", message: "passed" }
  });
  return { runDir, store };
}

function revisionFileName(revision: number): string {
  return `${String(revision).padStart(20, "0")}.json`;
}

function readSnapshotRecord(runDir: string, revision: number): Record<string, unknown> {
  const file = path.join(runDir, "delivery-revisions", revisionFileName(revision));
  const envelope = JSON.parse(fs.readFileSync(file, "utf8")) as { record: Record<string, unknown> };
  return envelope.record;
}

describe("hub-reconcile delivery chain inspection", () => {
  it("reports an aligned chain as a no-op", async () => {
    const root = temporaryRoot("hub-reconcile-healthy-");
    const runId = "run-hub-reconcile-healthy";
    const { runDir } = await buildHealthyChain(root, runId);

    const report = await inspectDeliveryChain(runDir, runId);
    expect(report.status).toBe("aligned");
    expect(report.highestRevision).toBe(4);
    expect(report.projectionRevision).toBe(4);
    expect(report.findings).toHaveLength(0);

    const repaired = await repairDeliveryChain(runDir, runId);
    expect(repaired.status).toBe("aligned");
    expect(repaired.applied).toHaveLength(0);
    expect(repaired.repaired).toBe(false);
  });

  it("detects and repairs a snapshot filename that does not match its revision", async () => {
    const root = temporaryRoot("hub-reconcile-filename-");
    const runId = "run-hub-reconcile-filename";
    const { runDir } = await buildHealthyChain(root, runId);
    const revisionsDir = path.join(runDir, "delivery-revisions");
    // Hand-craft the misalignment: rev 2 snapshot filed under the wrong name.
    fs.renameSync(path.join(revisionsDir, revisionFileName(2)), path.join(revisionsDir, revisionFileName(7)));

    const before = await inspectDeliveryChain(runDir, runId);
    expect(before.status).toBe("misaligned");
    const finding = before.findings.find((entry) => entry.code === "snapshot-filename-mismatch");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("repairable");
    expect(finding?.repair).toContain(revisionFileName(2));

    const repaired = await repairDeliveryChain(runDir, runId);
    expect(repaired.applied.some((step) => step.startsWith("renamed snapshot"))).toBe(true);
    expect(repaired.status).toBe("aligned");
    expect(repaired.repaired).toBe(true);
    expect(fs.existsSync(path.join(revisionsDir, revisionFileName(2)))).toBe(true);
    expect(fs.existsSync(path.join(revisionsDir, revisionFileName(7)))).toBe(false);

    const delivery = await readRunDelivery(runDir, runId);
    expect(delivery?.revision).toBe(4);
  });

  it("detects and repairs a record.lastEvent that diverged from its snapshot event", async () => {
    const root = temporaryRoot("hub-reconcile-lastevent-");
    const runId = "run-hub-reconcile-lastevent";
    const { runDir } = await buildHealthyChain(root, runId);
    const snapshotFile = path.join(runDir, "delivery-revisions", revisionFileName(4));
    // Hand-craft the misalignment: corrupt only the denormalized lastEvent pointer.
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as {
      record: { lastEvent: { id: string } };
    };
    snapshot.record.lastEvent.id = "bogus-event-id";
    fs.writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);

    const before = await inspectDeliveryChain(runDir, runId);
    expect(before.status).toBe("misaligned");
    expect(before.findings.some((entry) => entry.code === "snapshot-last-event-mismatch")).toBe(true);

    const repaired = await repairDeliveryChain(runDir, runId);
    expect(repaired.applied.some((step) => step.includes("rewrote record.lastEvent"))).toBe(true);
    expect(repaired.status).toBe("aligned");
    expect(repaired.repaired).toBe(true);

    const delivery = await readRunDelivery(runDir, runId);
    expect(delivery?.revision).toBe(4);
    const fixed = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as {
      record: { lastEvent: { id: string } };
      event: { id: string };
    };
    expect(fixed.record.lastEvent.id).toBe(fixed.event.id);
    expect(fixed.record.lastEvent.id).not.toBe("bogus-event-id");
  });

  it("detects and repairs a delivery.json projection that diverged from the latest revision", async () => {
    const root = temporaryRoot("hub-reconcile-projection-");
    const runId = "run-hub-reconcile-projection";
    const { runDir } = await buildHealthyChain(root, runId);
    // Hand-craft the misalignment: roll delivery.json back to the revision 3 record.
    const staleRecord = readSnapshotRecord(runDir, 3);
    fs.writeFileSync(path.join(runDir, "delivery.json"), `${JSON.stringify(staleRecord, null, 2)}\n`);

    const before = await inspectDeliveryChain(runDir, runId);
    expect(before.status).toBe("misaligned");
    expect(before.projectionRevision).toBe(3);
    expect(before.findings.some((entry) => entry.code === "projection-diverged")).toBe(true);

    const repaired = await repairDeliveryChain(runDir, runId);
    expect(repaired.applied).toContain("rewrote delivery.json from the highest valid snapshot");
    expect(repaired.status).toBe("aligned");
    expect(repaired.repaired).toBe(true);

    const delivery = await readRunDelivery(runDir, runId);
    expect(delivery?.revision).toBe(4);
  });

  it("refuses to repair when the projection is ahead of every snapshot (attention, all-or-nothing)", async () => {
    const root = temporaryRoot("hub-reconcile-ahead-");
    const runId = "run-hub-reconcile-ahead";
    const { runDir } = await buildHealthyChain(root, runId);
    // Hand-craft the unrepairable misalignment: a v2 projection ahead of the immutable chain.
    const record = readSnapshotRecord(runDir, 4) as { lastEvent?: { at?: string } };
    const ahead = {
      ...record,
      revision: 5,
      lastEvent: { id: "manual-event", type: "validation.passed", actor: "runtime", at: record.lastEvent?.at, fromRevision: 4, toRevision: 5 }
    };
    fs.writeFileSync(path.join(runDir, "delivery.json"), `${JSON.stringify(ahead, null, 2)}\n`);

    const before = await inspectDeliveryChain(runDir, runId);
    expect(before.status).toBe("corrupt");
    expect(before.findings.some((entry) => entry.code === "projection-ahead" && entry.severity === "attention")).toBe(true);

    const repaired = await repairDeliveryChain(runDir, runId);
    expect(repaired.applied).toHaveLength(0);
    expect(repaired.repaired).toBe(false);
    expect(repaired.status).toBe("corrupt");
    // The corrupt projection was left untouched.
    const onDisk = JSON.parse(fs.readFileSync(path.join(runDir, "delivery.json"), "utf8")) as { revision: number };
    expect(onDisk.revision).toBe(5);
  });

  it("verifies a persisted merge intent against an expected merge commit", async () => {
    const root = temporaryRoot("hub-reconcile-merge-");
    const runId = "run-hub-reconcile-merge";
    const { runDir, store } = await buildHealthyChain(root, runId);
    await store.advanceDelivery(runId, 4, [{ kind: "record", status: "merging" }], {
      type: "merge.intent-prepared",
      actor: "runtime",
      payload: {
        intentId: "intent-1",
        targetRef: "refs/heads/main",
        expectedTargetCommit: COMMIT_B,
        sourceCommit: COMMIT_A,
        preparedMergeCommit: COMMIT_C,
        message: "merge intent prepared"
      }
    });

    const mismatch = await inspectDeliveryChain(runDir, runId, { expectedMergeCommit: COMMIT_D });
    expect(mismatch.status).toBe("corrupt");
    expect(mismatch.findings.some((entry) => entry.code === "merge-intent-commit-mismatch")).toBe(true);

    const matched = await inspectDeliveryChain(runDir, runId, { expectedMergeCommit: COMMIT_C });
    expect(matched.status).toBe("aligned");
    expect(matched.findings).toHaveLength(0);
  });
});
