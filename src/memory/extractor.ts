// src/memory/extractor.ts
import { shouldExtract } from "./extractionGate.js";
import type { MemoryStore } from "./store.js";
import type { MemoryRecord, MemoryScope } from "./types.js";

export type RunLike = {
  id: string;
  status: string;
  nodes: Record<string, { status: string; output?: unknown }>;
  output?: unknown;
};

const MAX_EVIDENCE_CHARS = 8000;
const MAX_FIELD_CHARS = 1200;

function renderOutput(output: unknown): string {
  if (output === undefined || output === null) return "";
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text;
}

/**
 * Build a compact, human-readable evidence digest of a run for the summarizer:
 * run id/status, each node's status and output, and the final run output. Bounded
 * to MAX_EVIDENCE_CHARS so the prompt never blows up on large outputs.
 */
export function buildRunEvidence(run: RunLike): string {
  const lines: string[] = [`run=${run.id} status=${run.status}`];
  for (const [nodeId, node] of Object.entries(run.nodes ?? {})) {
    const rendered = renderOutput(node.output);
    lines.push(`- node ${nodeId} [${node.status}]${rendered ? `: ${rendered}` : ""}`);
  }
  const finalOutput = renderOutput(run.output);
  if (finalOutput) lines.push(`final: ${finalOutput}`);
  const text = lines.join("\n");
  return text.length > MAX_EVIDENCE_CHARS ? `${text.slice(0, MAX_EVIDENCE_CHARS)}…` : text;
}

export type SummarizeFn = (input: {
  run: RunLike;
  scope: MemoryScope;
}) => Promise<{ title: string; content: string } | null>;

function estimateTokens(value: string): number {
  const han = value.match(/\p{Script=Han}/gu)?.length ?? 0;
  const remaining = Math.max(0, value.length - han);
  return Math.max(1, han + Math.ceil(remaining / 4));
}

/**
 * Derive memory content from a summarizer employee's output. A codex-backed
 * summarizer must declare an outputSchema, so its output is a JSON object; we
 * prefer a non-empty string `summary` field for clean content, and fall back to
 * a JSON dump only when no usable summary is present. Plain-string outputs
 * (e.g. mock/raw providers) pass through unchanged.
 */
export function summarizerContent(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object" && !Array.isArray(output)) {
    const summary = (output as { summary?: unknown }).summary;
    if (typeof summary === "string" && summary.trim()) return summary.trim();
  }
  return JSON.stringify(output);
}

export class MemoryExtractor {
  constructor(
    private readonly store: MemoryStore,
    private readonly summarize: SummarizeFn,
    private readonly makeId: () => string
  ) {}

  async onRunComplete(input: {
    run: RunLike;
    scope: MemoryScope;
    provenance: { invocationId?: string; source?: { caller?: string; contextId?: string } };
  }): Promise<MemoryRecord | null> {
    try {
      const gate = shouldExtract(input.run);
      if (!gate.extract) return null;

      // 幂等：查 employee 分片是否已有该 runId 的 run-summary
      const existing = (await this.store.listByScope(`employee:${input.scope.employeeId}`))
        .find((r) => r.kind === "run-summary" && r.provenance.runId === input.run.id);
      if (existing) return existing;

      const summary = await this.summarize({ run: input.run, scope: input.scope });
      if (!summary) return null;

      const record: MemoryRecord = {
        id: this.makeId(),
        scope: input.scope,
        kind: "run-summary",
        title: summary.title,
        content: summary.content,
        provenance: {
          runId: input.run.id,
          traceId: input.run.id,
          invocationId: input.provenance.invocationId,
          source: input.provenance.source
        },
        status: "active",
        tokens: estimateTokens(summary.content),
        createdAt: new Date().toISOString(),
        supersedesId: null
      };
      await this.store.put(record);
      return record;
    } catch {
      // 尽力而为：提炼失败不影响主运行链路
      return null;
    }
  }
}
