import { createHash } from "node:crypto";

export interface ValidationGroup { id: string; requiredChecks: string[]; impactedFiles?: string[] }

export interface RuntimeImpactPlan {
  level: "low" | "medium" | "high";
  regressionScope: "none" | "targeted" | "package" | "full";
  affectedAreas: string[];
  reasons: string[];
  requiredChecks: string[];
  validationGroups?: ValidationGroup[];
}

export interface RuntimeImpactManifest {
  schemaVersion: 1;
  snapshotAvailable: boolean;
  changedFiles: string[];
  declaredImpactedFiles: string[];
  directCoverageProven: boolean;
  dependencyClosureProven: false;
  boundaryChange: boolean;
  widened: boolean;
  effectiveLevel: RuntimeImpactPlan["level"];
  effectiveRegressionScope: RuntimeImpactPlan["regressionScope"];
  requiredChecks: string[];
  reasons: string[];
}

const IMPACT_LEVEL_ORDER: Record<RuntimeImpactPlan["level"], number> = { low: 0, medium: 1, high: 2 };
const IMPACT_SCOPE_ORDER: Record<RuntimeImpactPlan["regressionScope"], number> = { none: 0, targeted: 1, package: 2, full: 3 };

function normalizedPath(value: string): string {
  return value.trim().replace(/^\.\//, "").replace(/\/$/, "");
}

function pathCovered(file: string, declaration: string): boolean {
  const normalizedFile = normalizedPath(file);
  const normalizedDeclaration = normalizedPath(declaration).replace(/\/\*\*$/, "");
  return normalizedDeclaration.length > 0
    && (normalizedFile === normalizedDeclaration || normalizedFile.startsWith(`${normalizedDeclaration}/`));
}

function globalBoundaryFile(file: string): boolean {
  const normalized = normalizedPath(file).toLowerCase();
  return /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig(?:\.[^/]+)?\.json)$/.test(normalized)
    || /(^|\/)(?:migrations?|schemas?|security|auth)(?:\/|\.|$)/.test(normalized)
    || /(^|\/)(?:vite|vitest|webpack|rollup|eslint|prettier)\.config\.[^/]+$/.test(normalized);
}

function widerLevel(left: RuntimeImpactPlan["level"], right: RuntimeImpactPlan["level"]): RuntimeImpactPlan["level"] {
  return IMPACT_LEVEL_ORDER[left] >= IMPACT_LEVEL_ORDER[right] ? left : right;
}

function widerScope(
  left: RuntimeImpactPlan["regressionScope"],
  right: RuntimeImpactPlan["regressionScope"]
): RuntimeImpactPlan["regressionScope"] {
  return IMPACT_SCOPE_ORDER[left] >= IMPACT_SCOPE_ORDER[right] ? left : right;
}

function baselineChecks(
  scope: RuntimeImpactPlan["regressionScope"],
  packageScripts: Record<string, string | undefined>
): string[] {
  if (scope === "full" && packageScripts.check) return ["npm run check"];
  if (scope === "package") {
    return ["typecheck", "test"].filter((name) => Boolean(packageScripts[name])).map((name) => `npm run ${name}`);
  }
  if (scope === "full") {
    return ["typecheck", "test", "build"].filter((name) => Boolean(packageScripts[name])).map((name) => `npm run ${name}`);
  }
  return [];
}

/**
 * Reconcile a leader-authored impact plan with the actual candidate diff. The leader may widen
 * this result but cannot narrow the deterministic floor. This deliberately does not claim a
 * dependency closure; cross-candidate Gate reuse stays disabled until such a proof exists.
 */
export function reconcileRuntimeImpact(input: {
  declared?: RuntimeImpactPlan;
  changedFiles: string[];
  snapshotAvailable: boolean;
  packageScripts: Record<string, string | undefined>;
}): { impact?: RuntimeImpactPlan; manifest: RuntimeImpactManifest } {
  const changedFiles = [...new Set(input.changedFiles.map(normalizedPath).filter(Boolean))].sort();
  const declaredImpactedFiles = [...new Set((input.declared?.validationGroups ?? [])
    .flatMap((group) => group.impactedFiles ?? [])
    .map(normalizedPath)
    .filter(Boolean))].sort();
  const directCoverageProven = input.snapshotAvailable
    && changedFiles.length > 0
    && declaredImpactedFiles.length > 0
    && changedFiles.every((file) => declaredImpactedFiles.some((declaration) => pathCovered(file, declaration)));
  const boundaryChange = changedFiles.some(globalBoundaryFile);
  const deterministicScope: RuntimeImpactPlan["regressionScope"] = !input.snapshotAvailable
    ? "full"
    : boundaryChange
      ? "full"
      : changedFiles.length === 0
        ? "none"
        : directCoverageProven
          ? "targeted"
          : "package";
  const deterministicLevel: RuntimeImpactPlan["level"] = deterministicScope === "full"
    ? "high"
    : deterministicScope === "package"
      ? "medium"
      : "low";
  const effectiveScope = widerScope(input.declared?.regressionScope ?? "none", deterministicScope);
  const effectiveLevel = widerLevel(input.declared?.level ?? "low", deterministicLevel);
  const widened = effectiveScope !== (input.declared?.regressionScope ?? "none")
    || effectiveLevel !== (input.declared?.level ?? "low");
  const reasons = [...new Set([
    ...(input.declared?.reasons ?? []),
    ...(!input.snapshotAvailable ? ["candidate snapshot unavailable; deterministic impact fails closed to full regression"] : []),
    ...(boundaryChange ? ["candidate changes a repository-wide boundary"] : []),
    ...(changedFiles.length > 0 && !directCoverageProven && !boundaryChange
      ? ["actual candidate diff is not fully covered by declared impacted files"]
      : []),
    ...(directCoverageProven ? ["actual candidate diff is directly covered by declared impacted files"] : [])
  ])];
  const requiredChecks = [...new Set([
    ...(input.declared?.requiredChecks ?? []),
    ...baselineChecks(effectiveScope, input.packageScripts)
  ])];
  const affectedAreas = [...new Set([...(input.declared?.affectedAreas ?? []), ...changedFiles])];
  const impact = input.declared || changedFiles.length > 0 || !input.snapshotAvailable
    ? {
        level: effectiveLevel,
        regressionScope: effectiveScope,
        affectedAreas,
        reasons,
        requiredChecks,
        ...(widened || !input.declared?.validationGroups
          ? { validationGroups: requiredChecks.length > 0 ? [{ id: "deterministic-candidate", requiredChecks, impactedFiles: changedFiles }] : [] }
          : { validationGroups: input.declared.validationGroups })
      }
    : undefined;
  return {
    ...(impact ? { impact } : {}),
    manifest: {
      schemaVersion: 1,
      snapshotAvailable: input.snapshotAvailable,
      changedFiles,
      declaredImpactedFiles,
      directCoverageProven,
      dependencyClosureProven: false,
      boundaryChange,
      widened,
      effectiveLevel,
      effectiveRegressionScope: effectiveScope,
      requiredChecks,
      reasons
    }
  };
}

export interface GateCandidatePreflight {
  status: "passed" | "blocked";
  candidateUrl: string;
  candidateRevision: string;
  checks: Array<{ id: string; status: "passed" | "blocked"; reason?: string }>;
}

export async function preflightGateCandidate(input: {
  candidateUrl: string;
  candidateRevision: string;
  probe: (url: URL) => Promise<{ reachable: boolean; revision?: string; reason?: string }>;
}): Promise<GateCandidatePreflight> {
  const checks: GateCandidatePreflight["checks"] = [];
  let url: URL;
  try {
    url = new URL(input.candidateUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("candidate URL must use HTTP(S)");
    checks.push({ id: "candidate-url", status: "passed" });
  } catch (error) {
    return { status: "blocked", candidateUrl: input.candidateUrl, candidateRevision: input.candidateRevision,
      checks: [{ id: "candidate-url", status: "blocked", reason: error instanceof Error ? error.message : String(error) }] };
  }
  const result = await input.probe(url);
  checks.push({ id: "candidate-reachable", status: result.reachable ? "passed" : "blocked", ...(result.reason ? { reason: result.reason } : {}) });
  const revisionMatches = result.revision === input.candidateRevision;
  checks.push({ id: "candidate-revision", status: revisionMatches ? "passed" : "blocked",
    ...(!revisionMatches ? { reason: result.revision ? `served revision ${result.revision} does not match ${input.candidateRevision}` : "served candidate did not prove its revision" } : {}) });
  return { status: checks.every((check) => check.status === "passed") ? "passed" : "blocked",
    candidateUrl: url.href, candidateRevision: input.candidateRevision, checks };
}

export function normalizeValidationGroups(requiredChecks: string[], groups: ValidationGroup[] | undefined, supportedChecks: ReadonlySet<string>): {
  status: "passed" | "configuration-issue"; requiredChecks: string[]; validationGroups: ValidationGroup[]; issues: string[];
} {
  const required = [...new Set(requiredChecks.map((check) => check.trim()).filter(Boolean))];
  const normalized = groups?.map((group) => ({
    id: group.id.trim(),
    requiredChecks: group.requiredChecks.map((check) => check.trim()).filter(Boolean),
    ...(group.impactedFiles?.length ? { impactedFiles: [...new Set(group.impactedFiles.map((file) => file.trim()).filter(Boolean))] } : {})
  }))
    ?? (required.length ? [{ id: "all", requiredChecks: required }] : []);
  const occurrences = new Map<string, number>();
  for (const group of normalized) for (const check of group.requiredChecks) occurrences.set(check, (occurrences.get(check) ?? 0) + 1);
  const issues = [
    ...required.filter((check) => isCommandCheck(check) && !supportedChecks.has(check)).map((check) => `unsupported required check: ${check}`),
    ...required.filter((check) => occurrences.get(check) !== 1).map((check) => `required check must occur exactly once: ${check}`),
    ...[...occurrences.keys()].filter((check) => !required.includes(check)).map((check) => `validation group contains unrequired check: ${check}`)
  ];
  return { status: issues.length ? "configuration-issue" : "passed", requiredChecks: required, validationGroups: normalized, issues };
}

/** Commands are explicit package-manager invocations or conventional bare script names; domain assertions remain semantic checks. */
export function isCommandCheck(check: string): boolean {
  return /^(?:npm(?: run)?|pnpm|yarn|bun)\s+\S+/.test(check) || /^(?:test|lint|typecheck|build|check)$/.test(check);
}

/** Resolve only manifest/package-declared commands; arbitrary shell text is never treated as supported. */
export function supportedRequiredChecks(packageScripts: Record<string, string | undefined>): Set<string> {
  const supported = new Set<string>();
  for (const name of Object.keys(packageScripts)) {
    supported.add(name);
    supported.add(`npm run ${name}`);
    supported.add(`pnpm ${name}`);
  }
  if (packageScripts.test) {
    supported.add("npm test");
    supported.add("pnpm test");
  }
  return supported;
}

export interface GateShardEvidence {
  candidateIdentity: string; candidateRevision: string; gateId: string; shardId: string; checks: string[]; impactedFiles: string[];
  status: "passed"; artifactPath: string; artifactDigest: string; sourceNodeIds: string[];
  inheritedFromCandidateIdentity?: string;
}

export function reusableGateShard(evidence: GateShardEvidence, input: {
  candidateIdentity: string; candidateRevision: string; gateId: string; shardId: string; checks: string[]; changedFiles: string[];
}): boolean {
  const sameCandidate = evidence.candidateIdentity === input.candidateIdentity && evidence.candidateRevision === input.candidateRevision;
  // changedFiles/impactedFiles overlap is not a dependency-closure proof. A shared config,
  // schema, generated artifact, or transitive caller can invalidate a shard without appearing
  // in the prior model-declared impactedFiles. Cross-candidate reuse therefore fails closed until
  // the runtime owns a deterministic dependency manifest and common-base proof.
  return evidence.status === "passed" && sameCandidate && evidence.gateId === input.gateId
    && evidence.shardId === input.shardId && digestList(evidence.checks) === digestList(input.checks)
    && evidence.artifactPath.length > 0 && /^sha256:[a-f0-9]{64}$/.test(evidence.artifactDigest)
    && evidence.sourceNodeIds.length > 0;
}

export function gateCandidateIdentity(input: { candidateRevision: string; sourceNodeIds: string[]; changeSet: string; candidateUrl: string }): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    candidateRevision: input.candidateRevision,
    sourceNodeIds: [...input.sourceNodeIds].sort(),
    changeSet: input.changeSet,
    candidateUrl: input.candidateUrl
  })).digest("hex")}`;
}

export function artifactDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export interface EnvironmentCircuitState { candidateRevision: string; candidateUrl: string; errorClass: string; failures: number; opened: boolean; reason: string }

export function recordEnvironmentFailure(previous: EnvironmentCircuitState | undefined, input: Omit<EnvironmentCircuitState, "failures" | "opened">): EnvironmentCircuitState {
  const same = previous?.candidateRevision === input.candidateRevision && previous.candidateUrl === input.candidateUrl && previous.errorClass === input.errorClass;
  const failures = same ? previous.failures + 1 : 1;
  return { ...input, failures, opened: failures >= 2 };
}

function digestList(values: string[]): string {
  return createHash("sha256").update(JSON.stringify([...values].sort())).digest("hex");
}
