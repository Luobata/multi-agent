import type { RunMergePreview } from "../types";
import type { RunAcceptanceSnapshot } from "./types";

const ACCEPTANCE_NEUTRAL_MERGE_REASONS = new Set([
  "目标仓库存在未提交改动，请先处理后再合并。",
  "目标仓库当前不在命名分支上。"
]);

/**
 * Board acceptance fixes the evidence for a passed candidate; it is not merge approval.
 * A dirty/detached target may block merge, but must not strand an otherwise verified Run
 * in the execution lane.
 */
export function isRunAcceptanceReady(preview: RunMergePreview): boolean {
  if (preview.acceptanceReadiness.ready || preview.eligible) return true;
  if (["discarded", "queued-for-merge", "retesting", "merging"].includes(preview.status)) return false;
  if (preview.reasons.some((reason) => !ACCEPTANCE_NEUTRAL_MERGE_REASONS.has(reason))) return false;
  const requiredGates = preview.evidence.gates.filter((gate) => gate.required);
  const passedGate = (capability: string) => preview.evidence.gates.some((gate) => (
    gate.required
    && gate.requiredCapability === capability
    && gate.mode === "before-completion"
    && gate.status === "passed"
  ));
  return Boolean(
    preview.worktreePath
    && preview.changes.files.length > 0
    && preview.evidence.acceptedVerdict
    && requiredGates.length > 0
    && requiredGates.every((gate) => gate.status === "passed")
    && passedGate("quality.test")
    && passedGate("quality.audit")
    && (preview.evidence.assets.length > 0 || preview.evidence.structuredE2eCount > 0)
  );
}

/** Extract the immutable board snapshot from the server-authoritative delivery preview. */
export function acceptanceSnapshotFromPreview(preview: RunMergePreview, capturedAt: string): RunAcceptanceSnapshot {
  const pickGate = (capability: string) => preview.evidence.gates.find((gate) => gate.requiredCapability === capability);
  const testGate = pickGate("quality.test");
  const reviewGate = pickGate("quality.audit");
  return {
    runId: preview.runId,
    eligible: isRunAcceptanceReady(preview),
    source: preview.commitAnchor && preview.repositoryRoot
      ? { kind: "merged-commits", repositoryRoot: preview.repositoryRoot, ...preview.commitAnchor }
      : { kind: "worktree", worktreePath: preview.worktreePath ?? "" },
    ...(testGate ? { testGate: { gateId: testGate.gateId, status: testGate.status } } : {}),
    ...(reviewGate ? { reviewGate: { gateId: reviewGate.gateId, status: reviewGate.status } } : {}),
    mediaCount: preview.evidence.assets.length,
    structuredE2eCount: preview.evidence.structuredE2eCount,
    diffFiles: preview.changes.files.map((file) => file.path),
    capturedAt
  };
}
