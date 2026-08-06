// src/memory/retriever.ts
import { knowledgeQueryTokens } from "../knowledge/store.js";
import type { MemoryStore } from "./store.js";
import type { MemoryEvidence, MemoryRecord, MemorySearchQuery } from "./types.js";

const DEFAULT_LIMIT = 5;
const MEMORY_MAX_TOKENS = 4000;

function scoreRecord(record: MemoryRecord, query: string): number {
  const queryTokens = new Set(knowledgeQueryTokens(query));
  if (queryTokens.size === 0) return 0;
  const contentTokens = new Set(knowledgeQueryTokens(record.content));
  const titleTokens = new Set(knowledgeQueryTokens(record.title));
  let overlap = 0;
  let titleOverlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) overlap += 1;
    if (titleTokens.has(token)) titleOverlap += 1;
  }
  return overlap / queryTokens.size + (titleOverlap / queryTokens.size) * 0.6;
}

export class MemoryRetriever {
  constructor(private readonly store: MemoryStore) {}

  async search(query: MemorySearchQuery): Promise<MemoryEvidence[]> {
    const limit = Math.max(1, Math.min(40, query.limit ?? DEFAULT_LIMIT));
    const wantedKind = query.kind ?? "run-summary";

    // 只加载相关 scope 分片（不扫全局）——效率核心
    const scopeKeys: string[] = [];
    if (query.scope.employeeId) scopeKeys.push(`employee:${query.scope.employeeId}`);
    if (query.scope.projectId) scopeKeys.push(`project:${query.scope.projectId}`);

    const seen = new Set<string>();
    const candidates: MemoryRecord[] = [];
    for (const scopeKey of scopeKeys) {
      for (const record of await this.store.listByScope(scopeKey)) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        if (record.status !== "active") continue;
        if (record.kind !== wantedKind) continue;
        candidates.push(record);
      }
    }

    const scored = candidates
      .map((record) => ({ record, score: scoreRecord(record, query.query) }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) =>
        right.score - left.score || right.record.createdAt.localeCompare(left.record.createdAt));

    const evidence: MemoryEvidence[] = [];
    let usedTokens = 0;
    for (const hit of scored) {
      if (evidence.length >= limit) break;
      if (usedTokens + hit.record.tokens > MEMORY_MAX_TOKENS) continue;
      usedTokens += hit.record.tokens;
      evidence.push({
        citationId: `M${evidence.length + 1}`,
        memoryId: hit.record.id,
        kind: hit.record.kind,
        title: hit.record.title,
        content: hit.record.content,
        traceId: hit.record.provenance.traceId,
        score: Number(hit.score.toFixed(6)),
        createdAt: hit.record.createdAt
      });
    }
    return evidence;
  }
}
