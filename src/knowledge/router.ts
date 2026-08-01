import { knowledgeQueryTokens } from "./store.js";
import type {
  KnowledgeCandidateCollection,
  KnowledgeCandidateMatch,
  KnowledgeExclusion,
  KnowledgePlan,
  KnowledgeScope,
  KnowledgeSelectedCollection
} from "./types.js";

export interface KnowledgeRouterOptions {
  maxCollections?: number;
}

interface SelectionOption {
  candidate: KnowledgeCandidateCollection;
  match: KnowledgeCandidateMatch;
  relevance: number;
  score: number;
}

function metadataText(candidate: KnowledgeCandidateCollection): string {
  return [
    candidate.knowledgeBaseId,
    candidate.knowledgeBaseName,
    candidate.domain,
    candidate.product,
    candidate.projectId,
    candidate.collection.id,
    candidate.collection.displayName,
    candidate.collection.description,
    candidate.collection.authority,
    ...candidate.collection.tags
  ].filter(Boolean).join(" ");
}

function relevanceScore(candidate: KnowledgeCandidateCollection, requestTokens: Set<string>): number {
  if (requestTokens.size === 0) return 0;
  const candidateTokens = new Set(knowledgeQueryTokens(metadataText(candidate)));
  let overlap = 0;
  for (const token of requestTokens) if (candidateTokens.has(token)) overlap += 1;
  return overlap / requestTokens.size;
}

function matchScore(match: KnowledgeCandidateMatch, relevance: number): number | undefined {
  const requiredBonus = match.required ? 10_000 : 0;
  if (match.activation === "core") return requiredBonus + 1_000 + match.priority * 10 + relevance;
  if (match.activation === "conditional") return requiredBonus + 700 + match.priority * 10 + relevance;
  if (relevance <= 0) return undefined;
  return requiredBonus + 300 + match.priority * 10 + relevance * 100;
}

function bestOptions(scope: KnowledgeScope): SelectionOption[] {
  const requestTokens = new Set(knowledgeQueryTokens(scope.context.request));
  const options: SelectionOption[] = [];
  for (const candidate of scope.eligibleCollections) {
    const relevance = relevanceScore(candidate, requestTokens);
    for (const match of candidate.matches) {
      const score = matchScore(match, relevance);
      if (score !== undefined) options.push({ candidate, match, relevance, score });
    }
  }
  return options.sort((left, right) =>
    right.score - left.score
    || left.candidate.knowledgeBaseId.localeCompare(right.candidate.knowledgeBaseId)
    || left.candidate.collection.id.localeCompare(right.candidate.collection.id)
  );
}

function routeReason(option: SelectionOption): string {
  const base = option.match.reason;
  if (option.match.activation !== "on-demand") return base;
  return `${base} · metadata relevance ${option.relevance.toFixed(3)}`;
}

export function routeKnowledge(scope: KnowledgeScope, options: KnowledgeRouterOptions = {}): KnowledgePlan {
  const maxCollections = Math.max(1, Math.min(12, options.maxCollections ?? 4));
  const selected: KnowledgeSelectedCollection[] = [];
  const selectedKeys = new Set<string>();
  const ruleCounts = new Map<string, number>();
  const exclusions: KnowledgeExclusion[] = [...scope.exclusions];

  for (const option of bestOptions(scope)) {
    const collectionKey = `${option.candidate.knowledgeBaseId}/${option.candidate.collection.id}`;
    if (selectedKeys.has(collectionKey)) continue;
    if (selected.length >= maxCollections) break;
    const ruleKey = `${option.match.profileId}/${option.match.ruleId}`;
    if ((ruleCounts.get(ruleKey) ?? 0) >= option.match.budget.maxCollections) continue;
    selectedKeys.add(collectionKey);
    ruleCounts.set(ruleKey, (ruleCounts.get(ruleKey) ?? 0) + 1);
    selected.push({
      knowledgeBaseId: option.candidate.knowledgeBaseId,
      knowledgeBaseVersion: option.candidate.knowledgeBaseVersion,
      revision: option.candidate.revision,
      collectionId: option.candidate.collection.id,
      collectionName: option.candidate.collection.displayName,
      profileId: option.match.profileId,
      ruleId: option.match.ruleId,
      activation: option.match.activation,
      priority: option.match.priority,
      reason: routeReason(option),
      query: scope.context.request,
      budget: option.match.budget
    });
  }

  for (const candidate of scope.eligibleCollections) {
    const key = `${candidate.knowledgeBaseId}/${candidate.collection.id}`;
    if (selectedKeys.has(key)) continue;
    const hasAlwaysEligibleMatch = candidate.matches.some((match) => match.activation !== "on-demand");
    exclusions.push({
      knowledgeBaseId: candidate.knowledgeBaseId,
      collectionId: candidate.collection.id,
      profileId: candidate.matches[0]?.profileId,
      reason: hasAlwaysEligibleMatch ? "collection budget excluded this candidate" : "on-demand metadata did not match the request"
    });
  }

  return {
    employeeId: scope.employeeId,
    employeeVersion: scope.employeeVersion,
    context: scope.context,
    profileVersions: scope.profileVersions,
    eligibleCollections: scope.eligibleCollections.map((candidate) => ({
      knowledgeBaseId: candidate.knowledgeBaseId,
      collectionId: candidate.collection.id,
      revision: candidate.revision,
      activations: [...new Set(candidate.matches.map((match) => match.activation))]
    })),
    selectedCollections: selected,
    exclusions,
    strategy: "deterministic-metadata-v1",
    createdAt: new Date().toISOString()
  };
}
