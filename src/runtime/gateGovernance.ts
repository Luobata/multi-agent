import { createHash } from "node:crypto";

export interface ValidationGroup { id: string; requiredChecks: string[]; impactedFiles?: string[] }

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
  const provenUnaffectedInheritance = evidence.candidateIdentity !== input.candidateIdentity && input.changedFiles.length > 0
    && evidence.impactedFiles.length > 0 && !input.changedFiles.some((file) => evidence.impactedFiles.includes(file));
  return evidence.status === "passed" && (sameCandidate || provenUnaffectedInheritance) && evidence.gateId === input.gateId
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
