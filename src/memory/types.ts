// src/memory/types.ts
export type MemoryKind = "run-summary" | "node-detail" | "preference";

export interface MemoryScope {
  employeeId: string;
  employeeVersion: number;
  projectId?: string;
}

export interface MemoryProvenance {
  runId: string;
  traceId: string;
  invocationId?: string;
  nodeId?: string;
  source?: { caller?: string; contextId?: string };
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  content: string;
  provenance: MemoryProvenance;
  status: "active" | "archived";
  tokens: number;
  createdAt: string; // ISO 8601
  supersedesId: string | null;
}

export interface MemorySearchQuery {
  query: string;
  scope: Partial<MemoryScope>;
  limit?: number;
  kind?: MemoryKind;
}

export interface MemoryEvidence {
  citationId: string;
  memoryId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  traceId: string;
  score: number;
  createdAt: string;
}
