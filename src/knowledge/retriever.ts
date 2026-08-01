import { KnowledgeStore, knowledgeQueryTokens } from "./store.js";
import type { KnowledgeEvidence, KnowledgeIndexChunk, KnowledgePlan, KnowledgeSelectedCollection } from "./types.js";

export interface KnowledgeRetrieverOptions {
  maxChunks?: number;
  maxTokens?: number;
  minimumScore?: number;
}

interface ScoredChunk {
  selected: KnowledgeSelectedCollection;
  chunk: KnowledgeIndexChunk;
  score: number;
  tokenEstimate: number;
}

function estimateTokens(value: string): number {
  const han = value.match(/\p{Script=Han}/gu)?.length ?? 0;
  const remaining = Math.max(0, value.length - han);
  return Math.max(1, han + Math.ceil(remaining / 4));
}

function scoreChunk(chunk: KnowledgeIndexChunk, query: string): number {
  const queryTokens = new Set(knowledgeQueryTokens(query));
  if (queryTokens.size === 0) return 0;
  const chunkTokens = new Set(chunk.tokens);
  const titleTokens = new Set(knowledgeQueryTokens(chunk.title));
  let overlap = 0;
  let titleOverlap = 0;
  for (const token of queryTokens) {
    if (chunkTokens.has(token)) overlap += 1;
    if (titleTokens.has(token)) titleOverlap += 1;
  }
  const coverage = overlap / queryTokens.size;
  const titleCoverage = titleOverlap / queryTokens.size;
  const normalizedQuery = query.normalize("NFKC").trim().toLowerCase();
  const exactBonus = normalizedQuery.length >= 4 && chunk.content.normalize("NFKC").toLowerCase().includes(normalizedQuery) ? 0.5 : 0;
  return coverage + titleCoverage * 0.6 + exactBonus;
}

export class KnowledgeRetriever {
  constructor(private readonly store: KnowledgeStore) {}

  async search(plan: KnowledgePlan, options: KnowledgeRetrieverOptions = {}): Promise<KnowledgeEvidence[]> {
    return this.searchCollections(plan.selectedCollections, options);
  }

  async searchCollections(
    selectedCollections: KnowledgeSelectedCollection[],
    options: KnowledgeRetrieverOptions = {}
  ): Promise<KnowledgeEvidence[]> {
    const globalMaxChunks = Math.max(1, Math.min(40, options.maxChunks ?? 12));
    const globalMaxTokens = Math.max(128, Math.min(32_000, options.maxTokens ?? 6_000));
    const minimumScore = Math.max(0, Math.min(2, options.minimumScore ?? 0.08));
    const hits: ScoredChunk[] = [];

    for (const selected of selectedCollections) {
      const index = await this.store.readIndex(selected.knowledgeBaseId, selected.revision);
      const collectionHits = index.chunks
        .filter((chunk) => chunk.collectionId === selected.collectionId)
        .map((chunk) => ({
          selected,
          chunk,
          score: scoreChunk(chunk, selected.query),
          tokenEstimate: estimateTokens(chunk.content)
        }))
        .filter((hit) => hit.score >= minimumScore)
        .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
      let collectionTokens = 0;
      for (const hit of collectionHits.slice(0, selected.budget.maxChunks)) {
        if (collectionTokens + hit.tokenEstimate > selected.budget.maxTokens) continue;
        collectionTokens += hit.tokenEstimate;
        hits.push(hit);
      }
    }

    hits.sort((left, right) =>
      right.selected.priority - left.selected.priority
      || right.score - left.score
      || left.chunk.id.localeCompare(right.chunk.id)
    );
    const evidence: KnowledgeEvidence[] = [];
    let usedTokens = 0;
    for (const hit of hits) {
      if (evidence.length >= globalMaxChunks) break;
      if (usedTokens + hit.tokenEstimate > globalMaxTokens) continue;
      usedTokens += hit.tokenEstimate;
      evidence.push({
        citationId: `K${evidence.length + 1}`,
        knowledgeBaseId: hit.selected.knowledgeBaseId,
        revision: hit.selected.revision,
        collectionId: hit.selected.collectionId,
        documentId: hit.chunk.documentId,
        title: hit.chunk.title,
        content: hit.chunk.content,
        sourceRef: hit.chunk.sourceRef,
        score: Number(hit.score.toFixed(6))
      });
    }
    return evidence;
  }
}
