import type { RunMergePreview } from "../types";
import type { RunAcceptanceSnapshot } from "./types";

/** Extract the immutable board snapshot from the server-authoritative delivery preview. */
export function acceptanceSnapshotFromPreview(preview: RunMergePreview, capturedAt: string): RunAcceptanceSnapshot {
  const pickGate = (capability: string) => preview.evidence.gates.find((gate) => gate.requiredCapability === capability);
  const testGate = pickGate("quality.test");
  const reviewGate = pickGate("quality.audit");
  return {
    runId: preview.runId,
    eligible: preview.eligible,
    worktreePath: preview.worktreePath ?? "",
    ...(testGate ? { testGate: { gateId: testGate.gateId, status: testGate.status } } : {}),
    ...(reviewGate ? { reviewGate: { gateId: reviewGate.gateId, status: reviewGate.status } } : {}),
    mediaCount: preview.evidence.assets.length,
    structuredE2eCount: preview.evidence.structuredE2eCount,
    diffFiles: preview.changes.files.map((file) => file.path),
    capturedAt
  };
}
