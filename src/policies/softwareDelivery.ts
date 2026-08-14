import { createHash } from "node:crypto";
import type { CompiledPolicyPack } from "./types.js";

const snapshot = {
  ref: { id: "software-delivery", version: 1 },
  assignment: { workKinds: ["code", "test", "audit", "integration"], requireBoundedChangeSet: true },
  gates: { testCapability: "quality.test", auditCapability: "quality.audit", independentReview: true },
  context: { worktree: true, e2e: true, regressionImpact: true, validationGroups: true }
};

export const softwareDeliveryPolicyPackV1: CompiledPolicyPack = {
  ...snapshot,
  digest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")
};
