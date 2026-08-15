import { describe, expect, it } from "vitest";
import {
  normalizeValidationGroups,
  preflightGateCandidate,
  reconcileRuntimeImpact,
  recordEnvironmentFailure,
  reusableGateShard,
  supportedRequiredChecks
} from "../src/runtime/gateGovernance.js";

describe("gate governance", () => {
  it("fails closed unless the HTTP candidate proves reachability and revision", async () => {
    const result = await preflightGateCandidate({ candidateUrl: "http://127.0.0.1:4173", candidateRevision: "abc", probe: async () => ({ reachable: true, revision: "old" }) });
    expect(result.status).toBe("blocked");
    expect(result.checks.at(-1)?.reason).toMatch(/does not match/);
  });

  it("rejects unsupported checks and non-exact validation group coverage before gates", () => {
    const result = normalizeValidationGroups(["test", "lint"], [{ id: "a", requiredChecks: ["test", "test"] }], new Set(["test"]));
    expect(result.status).toBe("configuration-issue");
    expect(result.issues).toEqual(expect.arrayContaining(["unsupported required check: lint", "required check must occur exactly once: test"]));
  });

  it("derives supported checks from declared package scripts instead of guessing lint", () => {
    const supported = supportedRequiredChecks({ test: "vitest", typecheck: "tsc" });
    expect(supported).toContain("npm run typecheck");
    expect(supported).toContain("npm test");
    expect(supported).not.toContain("npm run lint");
  });

  it("reuses only traceable same-candidate same-revision passed shards", () => {
    const evidence = { candidateIdentity: "same", candidateRevision: "abc", gateId: "quality-test", shardId: "unit", checks: ["test"], impactedFiles: ["src/a.ts"], sourceNodeIds: ["code"], status: "passed" as const, artifactPath: "gates/unit.json", artifactDigest: `sha256:${"a".repeat(64)}` };
    expect(reusableGateShard(evidence, { candidateIdentity: "same", candidateRevision: "abc", gateId: "quality-test", shardId: "unit", checks: ["test"], changedFiles: ["src/b.ts"] })).toBe(true);
    expect(reusableGateShard(evidence, { candidateIdentity: "new", candidateRevision: "def", gateId: "quality-test", shardId: "unit", checks: ["test"], changedFiles: ["src/b.ts"] })).toBe(false);
    expect(reusableGateShard(evidence, { candidateIdentity: "new", candidateRevision: "def", gateId: "quality-test", shardId: "unit", checks: ["test"], changedFiles: ["src/a.ts"] })).toBe(false);
    expect(reusableGateShard({ ...evidence, impactedFiles: [] }, { candidateIdentity: "new", candidateRevision: "def", gateId: "quality-test", shardId: "unit", checks: ["test"], changedFiles: ["src/b.ts"] })).toBe(false);
  });

  it("widens an under-declared candidate diff to package checks", () => {
    const result = reconcileRuntimeImpact({
      declared: {
        level: "low",
        regressionScope: "targeted",
        affectedAreas: ["src/view.ts"],
        reasons: ["declared local change"],
        requiredChecks: ["visual check"],
        validationGroups: [{ id: "view", requiredChecks: ["visual check"], impactedFiles: ["src/view.ts"] }]
      },
      changedFiles: ["src/view.ts", "src/shared.ts"],
      snapshotAvailable: true,
      packageScripts: { test: "vitest", typecheck: "tsc" }
    });

    expect(result.impact).toMatchObject({
      level: "medium",
      regressionScope: "package",
      requiredChecks: ["visual check", "npm run typecheck", "npm run test"],
      validationGroups: [{
        id: "deterministic-candidate",
        impactedFiles: ["src/shared.ts", "src/view.ts"]
      }]
    });
    expect(result.manifest).toMatchObject({
      directCoverageProven: false,
      dependencyClosureProven: false,
      widened: true
    });
  });

  it("fails closed to full regression for a repository boundary or missing snapshot", () => {
    const boundary = reconcileRuntimeImpact({
      changedFiles: ["package.json"],
      snapshotAvailable: true,
      packageScripts: { check: "npm test" }
    });
    expect(boundary.impact).toMatchObject({
      level: "high",
      regressionScope: "full",
      requiredChecks: ["npm run check"]
    });
    expect(boundary.manifest.boundaryChange).toBe(true);

    const unknown = reconcileRuntimeImpact({
      changedFiles: [],
      snapshotAvailable: false,
      packageScripts: { test: "vitest", typecheck: "tsc", build: "tsc" }
    });
    expect(unknown.impact).toMatchObject({
      level: "high",
      regressionScope: "full",
      requiredChecks: ["npm run typecheck", "npm run test", "npm run build"]
    });
  });

  it("allows one bounded recovery then opens the environment circuit", () => {
    const input = { candidateRevision: "abc", candidateUrl: "http://localhost:1", errorClass: "MIDSCENE_ENVIRONMENT_BLOCKED", reason: "browser unavailable" };
    const first = recordEnvironmentFailure(undefined, input);
    expect(first.opened).toBe(false);
    expect(recordEnvironmentFailure(first, input)).toMatchObject({ failures: 2, opened: true });
    expect(recordEnvironmentFailure(first, { ...input, candidateRevision: "def" })).toMatchObject({ failures: 1, opened: false });
  });
});
