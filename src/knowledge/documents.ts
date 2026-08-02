import { createHash } from "node:crypto";
import { knowledgeQueryTokens } from "./store.js";
import type {
  KnowledgeDocumentDefinition,
  KnowledgeRelationCandidate,
  KnowledgeRevision,
  KnowledgeWikiReference,
  KnowledgeWikiView
} from "./types.js";

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function metadataStrings(document: KnowledgeDocumentDefinition, key: string): string[] {
  const value = document.metadata?.[key];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function referenceBase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return value.split("#", 1)[0];
  }
}

function relationId(sourceDocumentId: string, targetDocumentId: string): string {
  const digest = createHash("sha256")
    .update(`${sourceDocumentId}\0${targetDocumentId}\0related`)
    .digest("hex")
    .slice(0, 20);
  return `relation-${digest}`;
}

function overlap(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => right.has(value)).sort();
}

function candidate(
  source: KnowledgeDocumentDefinition,
  target: KnowledgeDocumentDefinition
): KnowledgeRelationCandidate | undefined {
  if (source.id === target.id) return undefined;
  if (source.references.some((reference) => reference.targetDocumentId === target.id)) return undefined;
  if (source.sourceRef && target.sourceRef && referenceBase(source.sourceRef) === referenceBase(target.sourceRef)) {
    return undefined;
  }

  const signals: string[] = [];
  let score = 0;
  const links = metadataStrings(source, "links");
  if (target.sourceRef && links.some((link) => link === target.sourceRef || referenceBase(link) === referenceBase(target.sourceRef))) {
    signals.push("source links to target");
    score += 10;
  }

  const sourceTitle = new Set(knowledgeQueryTokens(source.title));
  const targetTitle = new Set(knowledgeQueryTokens(target.title));
  const sharedTitle = overlap(sourceTitle, targetTitle);
  if (sharedTitle.length > 0) {
    const denominator = Math.max(1, new Set([...sourceTitle, ...targetTitle]).size);
    score += (sharedTitle.length / denominator) * 4;
    signals.push(`shared title terms: ${sharedTitle.slice(0, 4).join(", ")}`);
  }

  const sourceHeadings = new Set(metadataStrings(source, "headingPath").map((value) => value.normalize("NFKC").toLowerCase()));
  const targetHeadings = new Set(metadataStrings(target, "headingPath").map((value) => value.normalize("NFKC").toLowerCase()));
  const sharedHeadings = overlap(sourceHeadings, targetHeadings);
  if (sharedHeadings.length > 0) {
    score += 2;
    signals.push("shared heading path");
  }

  const sourceContent = new Set(knowledgeQueryTokens(source.content.slice(0, 1_200)));
  const targetContent = new Set(knowledgeQueryTokens(target.content.slice(0, 1_200)));
  const sharedContent = overlap(sourceContent, targetContent);
  if (sharedContent.length > 0) {
    const denominator = Math.max(1, Math.min(sourceContent.size, targetContent.size));
    const contentScore = Math.min(1, sharedContent.length / denominator);
    score += contentScore;
    signals.push(`shared content terms: ${sharedContent.slice(0, 4).join(", ")}`);
  }

  if (score < 0.35) return undefined;
  return {
    id: relationId(source.id, target.id),
    sourceDocumentId: source.id,
    targetDocumentId: target.id,
    suggestedType: "related",
    strength: "candidate",
    persisted: false,
    score: Number(score.toFixed(6)),
    signals: unique(signals)
  };
}

export function deriveKnowledgeRelationCandidates(
  sourceDocuments: KnowledgeDocumentDefinition[],
  targetDocuments: KnowledgeDocumentDefinition[],
  maxCandidates = 5,
  uniquePairs = false
): KnowledgeRelationCandidate[] {
  const candidates: KnowledgeRelationCandidate[] = [];
  const seen = new Set<string>();
  for (const source of [...sourceDocuments].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const target of [...targetDocuments].sort((left, right) => left.id.localeCompare(right.id))) {
      const key = `${source.id}\0${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (uniquePairs && (
        source.references.some((reference) => reference.targetDocumentId === target.id)
        || target.references.some((reference) => reference.targetDocumentId === source.id)
      )) continue;
      const found = candidate(source, target);
      if (found) candidates.push(found);
    }
  }
  const deduplicated = uniquePairs
    ? [...candidates.reduce((grouped, item) => {
      const key = [item.sourceDocumentId, item.targetDocumentId].sort().join("\0");
      const current = grouped.get(key);
      if (!current || item.score > current.score
        || (item.score === current.score && `${item.sourceDocumentId}/${item.targetDocumentId}` < `${current.sourceDocumentId}/${current.targetDocumentId}`)) {
        grouped.set(key, item);
      }
      return grouped;
    }, new Map<string, KnowledgeRelationCandidate>()).values()]
    : candidates;
  return deduplicated
    .sort((left, right) => right.score - left.score
      || left.sourceDocumentId.localeCompare(right.sourceDocumentId)
      || left.targetDocumentId.localeCompare(right.targetDocumentId))
    .slice(0, Math.max(0, Math.min(5, maxCandidates)));
}

export function buildKnowledgeWiki(
  revision: KnowledgeRevision,
  visibility: KnowledgeWikiView["visibility"],
  generatedAt = new Date().toISOString()
): KnowledgeWikiView {
  const references: KnowledgeWikiReference[] = revision.documents.flatMap((document) =>
    document.references.map((reference) => ({
      sourceDocumentId: document.id,
      targetDocumentId: reference.targetDocumentId,
      type: reference.type,
      strength: "explicit" as const,
      note: reference.note
    }))
  ).sort((left, right) => left.sourceDocumentId.localeCompare(right.sourceDocumentId)
    || left.targetDocumentId.localeCompare(right.targetDocumentId)
    || left.type.localeCompare(right.type));

  const ordered = [...revision.documents].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const candidateRelations = deriveKnowledgeRelationCandidates(
    ordered,
    ordered,
    5,
    true
  );

  return {
    knowledgeBaseId: revision.knowledgeBaseId,
    revision: revision.revision,
    visibility,
    documents: ordered.map((document) => ({
      document,
      outgoingReferences: references.filter((reference) => reference.sourceDocumentId === document.id),
      backlinks: references.filter((reference) => reference.targetDocumentId === document.id),
      candidateRelations: candidateRelations.filter((relation) => relation.sourceDocumentId === document.id)
    })),
    references,
    candidateRelations,
    generatedAt
  };
}
