import { describe, expect, it } from "vitest";
import { normalizeValidationGroups, preflightGateCandidate, recordEnvironmentFailure, reusableGateShard, supportedRequiredChecks } from "../src/runtime/gateGovernance.js";

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

  it("reuses only traceable same-revision unaffected passed shards", () => {
    const evidence = { candidateIdentity: "same", candidateRevision: "abc", gateId: "quality-test", shardId: "unit", checks: ["test"], impactedFiles: ["src/a.ts"], sourceNodeIds: ["code"], status: "passed" as const, artifactPath: "gates/unit.json", artifactDigest: `sha256:${"a".repeat(64)}` };
    expect(reusableGateShard(evidence, { candidateIdentity: "same", candidateRevision: "abc", gateId: "quality-test", shardId: "unit", checks: ["test"], changedFiles: ["src/b.ts"] })).toBe(true);
    expect(reusableGateShard(evidence, { candidateIdentity: "new", candidateRevision: "def", gateId: "quality-test", shardId: "unit", checks: ["test"], changedFiles: ["src/b.ts"] })).toBe(true);
    expect(reusableGateShard(evidence, { candidateIdentity: "new", candidateRevision: "def", gateId: "quality-test", shardId: "unit", checks: ["test"], changedFiles: ["src/a.ts"] })).toBe(false);
    expect(reusableGateShard({ ...evidence, impactedFiles: [] }, { candidateIdentity: "new", candidateRevision: "def", gateId: "quality-test", shardId: "unit", checks: ["test"], changedFiles: ["src/b.ts"] })).toBe(false);
  });

  it("allows one bounded recovery then opens the environment circuit", () => {
    const input = { candidateRevision: "abc", candidateUrl: "http://localhost:1", errorClass: "MIDSCENE_ENVIRONMENT_BLOCKED", reason: "browser unavailable" };
    const first = recordEnvironmentFailure(undefined, input);
    expect(first.opened).toBe(false);
    expect(recordEnvironmentFailure(first, input)).toMatchObject({ failures: 2, opened: true });
    expect(recordEnvironmentFailure(first, { ...input, candidateRevision: "def" })).toMatchObject({ failures: 1, opened: false });
  });
});
