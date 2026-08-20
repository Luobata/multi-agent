import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { InvocationRecord, InvocationStatus } from "./types.js";
import type { DeliveryStatus } from "../runtime/worktreeDelivery.js";

/**
 * Server-side Requirement domain (P1: read-only projection).
 *
 * Design: reports/plan-backup-requirement-server-design.md (§2/§3). The server
 * persists human intent only — content, priority, the three intent lanes,
 * keep/discard decisions, and a fixed acceptance snapshot. Execution lanes
 * (queued/running/confirmation/acceptance/merging/done) and the exception flag
 * are derived at read time by joining the latest lineage-linked Invocation and
 * its delivery record, mirroring the client projection semantics
 * (client/src/dashboard/advancement.ts:119, dash/types.ts:181-192):
 *
 * - queued → queued; running/cancellation-requested → running;
 *   awaiting-human-decision/completed/blocked/failed/cancelled → confirmation
 *   (an ended attempt is an unresolved product obligation until a human
 *   reviews delivery, starts a successor, or discards).
 * - delivery queued-for-merge/retesting/merging/conflict → merging;
 *   merged → done; returned-to-acceptance → acceptance.
 * - decision.keep pins the card in acceptance with an explicit kept-note;
 *   decision.discard returns it to inbox for a fresh cycle (a discard ends the
 *   candidate, not the requirement).
 */

export type RequirementIntentLane = "inbox" | "clarify" | "planned";
export type RequirementLane = "inbox" | "clarify" | "planned" | "queued" | "running" | "confirmation" | "acceptance" | "merging" | "done";
export type RequirementException = "blocked" | "failed" | "cancelled" | null;

export interface RequirementServerRecord {
  schemaVersion: 1;
  id: string;
  /** Legacy browser-local id (req-local-N) kept for the Invocation join during migration. */
  legacyClientId?: string;
  projectId: string;
  code: string;
  title: string;
  summary: string;
  priority: "low" | "medium" | "high";
  owner: string;
  rawRequirement: string;
  acceptanceCriteria: string[];
  intentLane: RequirementIntentLane;
  decision?: { kind: "keep" | "discard"; runId: string; note?: string; at: string; actor: string };
  acceptance?: { runId: string; snapshot: unknown; submittedAt: string };
  advancementReservation?: {
    lineageId: string;
    cycle: number;
    idempotencyKey: string;
    entrancePolicyId: string;
    reservedAt: string;
  };
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Per-record monotonic revision for future PATCH CAS (P3). */
  revision: number;
}

export interface RequirementsFile {
  schemaVersion: 1;
  requirements: Record<string, RequirementServerRecord>;
}

export interface RequirementDeliveryProgress {
  status: DeliveryStatus;
  runId: string;
  updatedAt: string;
}

export interface ProjectedRequirement {
  id: string;
  legacyClientId?: string;
  projectId: string;
  code: string;
  title: string;
  summary: string;
  priority: "low" | "medium" | "high";
  owner: string;
  rawRequirement: string;
  acceptanceCriteria: string[];
  intentLane: RequirementIntentLane;
  /** Derived execution lane — computed at read time, never persisted. */
  lane: RequirementLane;
  exception: RequirementException;
  /** Set when a human kept a candidate without merging it. */
  keptWithoutMerge?: { runId: string; note?: string; at: string };
  /** Latest lineage-linked invocation fact backing the projection. */
  invocation?: { id: string; runId?: string; status: InvocationStatus; updatedAt: string };
  delivery?: RequirementDeliveryProgress;
  acceptance?: RequirementServerRecord["acceptance"];
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}


/** Client parity: client/src/dashboard/advancement.ts:119 advancementLane. */
export function invocationLane(status: InvocationStatus): RequirementLane {
  if (status === "queued") return "queued";
  if (status === "running" || status === "cancellation-requested") return "running";
  if (status === "awaiting-human-decision" || status === "completed"
    || status === "blocked" || status === "failed" || status === "cancelled") return "confirmation";
  return "queued";
}

/** Client parity: dash/types.ts:181-192 delivery → lane mapping, covering the full DeliveryStatus set. */
export function deliveryLane(status: DeliveryStatus): "inbox" | "acceptance" | "merging" | "done" {
  if (status === "merged") return "done";
  if (status === "returned-to-acceptance" || status === "awaiting-acceptance" || status === "kept") return "acceptance";
  if (status === "discarded") return "inbox";
  return "merging";
}

function exceptionFrom(status: InvocationStatus | undefined): RequirementException {
  if (status === "blocked" || status === "failed" || status === "cancelled") return status;
  return null;
}

/**
 * Pure projection: intent record + latest invocation fact + its delivery
 * record → the lane a board should render. Ordering mirrors the client:
 * a fixed acceptance or a delivery lifecycle outranks the raw invocation
 * status; a discard rewinds to inbox; a keep pins to acceptance.
 */
export function projectRequirement(
  record: RequirementServerRecord,
  invocation?: { id: string; runId?: string; status: InvocationStatus; updatedAt: string },
  delivery?: RequirementDeliveryProgress
): ProjectedRequirement {
  let lane: RequirementLane = record.intentLane;
  if (invocation) lane = invocationLane(invocation.status);
  if (record.acceptance || delivery) {
    lane = delivery
      ? deliveryLane(delivery.status)
      : "acceptance";
  }
  let keptWithoutMerge: ProjectedRequirement["keptWithoutMerge"];
  if (delivery?.status === "kept") {
    keptWithoutMerge = { runId: delivery.runId, at: delivery.updatedAt };
  }
  if (record.decision?.kind === "keep") {
    lane = "acceptance";
    keptWithoutMerge = { runId: record.decision.runId, note: record.decision.note, at: record.decision.at };
  } else if (record.decision?.kind === "discard") {
    // A discard ends the current candidate, not the requirement: the card
    // returns to inbox so a new cycle can be reserved (audit ruling).
    lane = "inbox";
  }
  return {
    id: record.id,
    ...(record.legacyClientId ? { legacyClientId: record.legacyClientId } : {}),
    projectId: record.projectId,
    code: record.code,
    title: record.title,
    summary: record.summary,
    priority: record.priority,
    owner: record.owner,
    rawRequirement: record.rawRequirement,
    acceptanceCriteria: record.acceptanceCriteria,
    intentLane: record.intentLane,
    lane,
    exception: exceptionFrom(invocation?.status),
    ...(keptWithoutMerge ? { keptWithoutMerge } : {}),
    ...(invocation ? { invocation: { id: invocation.id, runId: invocation.runId, status: invocation.status, updatedAt: invocation.updatedAt } } : {}),
    ...(delivery ? { delivery } : {}),
    ...(record.acceptance ? { acceptance: record.acceptance } : {}),
    ...(record.archivedAt !== undefined ? { archivedAt: record.archivedAt } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export async function loadRequirementsFile(dataRoot: string): Promise<RequirementsFile> {
  const filePath = path.join(dataRoot, "requirements.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as RequirementsFile;
    if (parsed.schemaVersion !== 1 || typeof parsed.requirements !== "object" || parsed.requirements === null) {
      throw new Error(`requirements.json has an unsupported schema: ${String((parsed as { schemaVersion?: unknown }).schemaVersion)}`);
    }
    return parsed;
  } catch (error) {
    // A fresh object every call — a shared EMPTY_FILE constant would leak records
    // across data roots once the first caller mutates the returned file.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, requirements: {} };
    throw error;
  }
}

export interface RequirementReaderDeps {
  dataRoot: string;
  /** Store snapshot provider (WorkbenchService.snapshot or a test fixture). */
  snapshot: () => { invocations: Record<string, InvocationRecord> };
  /** Delivery reader over artifacts/runs/<runId> (readRunDelivery or a test stub). */
  readDelivery: (runDir: string, runId: string) => Promise<RequirementDeliveryProgress | undefined>;
}

function requirementInvocationKeys(record: RequirementServerRecord): string[] {
  return [record.legacyClientId, record.id].filter((key): key is string => typeof key === "string" && key.length > 0);
}

/**
 * Latest workflow Invocation linked to the requirement: joined by
 * source.taskId (legacy client id or canonical id) within the same project,
 * preferring requirement-lineage contexts (service.ts:8240 single-active
 * invariant), newest updatedAt first.
 */
export function latestRequirementInvocation(
  record: RequirementServerRecord,
  invocations: Record<string, InvocationRecord>
): InvocationRecord | undefined {
  const keys = new Set(requirementInvocationKeys(record));
  return Object.values(invocations)
    .filter((invocation) => keys.has(String(invocation.source.taskId))
      && invocation.source.project === record.projectId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function createRequirementReader(deps: RequirementReaderDeps) {
  return {
    async list(projectId?: string): Promise<ProjectedRequirement[]> {
      const file = await loadRequirementsFile(deps.dataRoot);
      const invocations = deps.snapshot().invocations;
      const records = Object.values(file.requirements)
        .filter((record) => projectId === undefined || record.projectId === projectId);
      return Promise.all(records.map(async (record) => {
        const invocation = latestRequirementInvocation(record, invocations);
        const delivery = invocation?.runId
          ? await deps.readDelivery(path.join(deps.dataRoot, "artifacts", "runs", invocation.runId), invocation.runId)
          : undefined;
        return projectRequirement(record, invocation, delivery);
      }));
    },
    async get(id: string): Promise<ProjectedRequirement | undefined> {
      const file = await loadRequirementsFile(deps.dataRoot);
      const record = file.requirements[id];
      if (!record) return undefined;
      const invocation = latestRequirementInvocation(record, deps.snapshot().invocations);
      const delivery = invocation?.runId
        ? await deps.readDelivery(path.join(deps.dataRoot, "artifacts", "runs", invocation.runId), invocation.runId)
        : undefined;
      return projectRequirement(record, invocation, delivery);
    }
  };
}

// ---------------------------------------------------------------------------
// P2 write path. requirements.json shares the state.lock + tmp→rename atomic
// write conventions with state.json (design §2.1), so config writes and
// requirement writes serialize on the same file lock. Import is all-or-nothing
// per commit and idempotent on (legacyClientId, contentHash); the browser's
// localStorage copy is never the source of truth after a successful commit.

async function writeRequirementsAtomic(dataRoot: string, file: RequirementsFile): Promise<void> {
  const filePath = path.join(dataRoot, "requirements.json");
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function withRequirementsLock<T>(dataRoot: string, mutate: (file: RequirementsFile) => Promise<T> | T): Promise<T> {
  const lockPath = path.join(dataRoot, "state.lock");
  let release: (() => Promise<void>) | undefined;
  for (let attempt = 0; attempt < 240 && !release; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
      release = async () => {
        await handle.close();
        await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.min(attempt, 40)));
    }
  }
  if (!release) throw new Error(`timed out waiting for requirements lock: ${lockPath}`);
  try {
    const file = await loadRequirementsFile(dataRoot);
    const result = await mutate(file);
    await writeRequirementsAtomic(dataRoot, file);
    return result;
  } finally {
    await release();
  }
}

export interface RequirementCreateInput {
  projectId: string;
  title: string;
  summary: string;
  priority: RequirementServerRecord["priority"];
  owner: string;
  rawRequirement: string;
  acceptanceCriteria: string[];
  intentLane?: RequirementIntentLane;
}

function nextRequirementCode(file: RequirementsFile): string {
  let max = 0;
  for (const record of Object.values(file.requirements)) {
    const match = /^R-(\d+)$/.exec(record.code);
    if (match?.[1]) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return `R-${String(max + 1).padStart(3, "0")}`;
}

export function createRequirementWriter(deps: { dataRoot: string; projectExists: (projectId: string) => boolean }) {
  return {
    async create(input: RequirementCreateInput): Promise<RequirementServerRecord> {
      if (!deps.projectExists(input.projectId)) {
        throw new Error(`unknown project: ${input.projectId}`);
      }
      return withRequirementsLock(deps.dataRoot, (file) => {
        const now = new Date().toISOString();
        const record: RequirementServerRecord = {
          schemaVersion: 1,
          id: `req-${randomUUID().slice(0, 8)}`,
          projectId: input.projectId,
          code: nextRequirementCode(file),
          title: input.title,
          summary: input.summary,
          priority: input.priority,
          owner: input.owner,
          rawRequirement: input.rawRequirement,
          acceptanceCriteria: input.acceptanceCriteria,
          intentLane: input.intentLane ?? "inbox",
          createdAt: now,
          updatedAt: now,
          revision: 1
        };
        file.requirements[record.id] = record;
        return record;
      });
    },
    /** Content/priority/intent updates with per-record revision CAS. */
    async update(id: string, patch: Partial<Pick<RequirementServerRecord, "title" | "summary" | "priority" | "owner" | "rawRequirement" | "acceptanceCriteria" | "intentLane">>, ifMatchRevision?: number): Promise<RequirementServerRecord> {
      return withRequirementsLock(deps.dataRoot, (file) => {
        const record = file.requirements[id];
        if (!record) throw new Error(`requirement not found: ${id}`);
        if (ifMatchRevision !== undefined && record.revision !== ifMatchRevision) {
          const conflict = new Error(`revision conflict: expected ${ifMatchRevision}, current ${record.revision}`);
          (conflict as Error & { conflict?: boolean }).conflict = true;
          throw conflict;
        }
        Object.assign(record, patch);
        record.updatedAt = new Date().toISOString();
        record.revision += 1;
        return record;
      });
    },
    async archive(id: string): Promise<RequirementServerRecord> {
      return withRequirementsLock(deps.dataRoot, (file) => {
        const record = file.requirements[id];
        if (!record) throw new Error(`requirement not found: ${id}`);
        record.archivedAt = new Date().toISOString();
        record.updatedAt = record.archivedAt;
        record.revision += 1;
        return record;
      });
    },
    async restore(id: string): Promise<RequirementServerRecord> {
      return withRequirementsLock(deps.dataRoot, (file) => {
        const record = file.requirements[id];
        if (!record) throw new Error(`requirement not found: ${id}`);
        record.archivedAt = null;
        record.updatedAt = new Date().toISOString();
        record.revision += 1;
        return record;
      });
    },
    /** One-shot migration import; dry-run reports the diff, commit is idempotent. */
    async import(payload: RequirementImportEntry[], mode: "dry-run" | "commit"): Promise<RequirementImportReport> {
      const report: RequirementImportReport = { mode, created: [], skipped: [], invalid: [] };
      await withRequirementsLock(deps.dataRoot, async (file) => {
        const byLegacy = new Map(Object.values(file.requirements)
          .filter((record) => record.legacyClientId)
          .map((record) => [record.legacyClientId as string, record]));
        for (const entry of payload) {
          if (!entry.legacyClientId || !entry.projectId || !entry.title) {
            report.invalid.push({ legacyClientId: entry.legacyClientId, reason: "缺少 legacyClientId/projectId/title" });
            continue;
          }
          if (!deps.projectExists(entry.projectId)) {
            report.invalid.push({ legacyClientId: entry.legacyClientId, reason: `projectId 不存在: ${entry.projectId}` });
            continue;
          }
          const legacyClientId = entry.legacyClientId;
          const contentHash = requirementContentHash({
            projectId: entry.projectId,
            title: entry.title,
            summary: entry.summary ?? "",
            rawRequirement: entry.rawRequirement ?? "",
            acceptanceCriteria: entry.acceptanceCriteria ?? []
          });
          const existing = byLegacy.get(legacyClientId);
          if (existing && requirementContentHash(existing) === contentHash) {
            report.skipped.push({ legacyClientId: entry.legacyClientId, reason: "内容 hash 相同（已导入）" });
            continue;
          }
          if (existing) {
            report.skipped.push({ legacyClientId: entry.legacyClientId, reason: "legacyClientId 已存在且内容不同——commit 不覆盖，需人工裁决" });
            continue;
          }
          const now = new Date().toISOString();
          const record: RequirementServerRecord = {
            schemaVersion: 1,
            id: `req-${randomUUID().slice(0, 8)}`,
            legacyClientId: entry.legacyClientId,
            projectId: entry.projectId,
            code: entry.code ?? nextRequirementCode(file),
            title: entry.title,
            summary: entry.summary ?? "",
            priority: entry.priority ?? "medium",
            owner: entry.owner ?? "",
            rawRequirement: entry.rawRequirement ?? "",
            acceptanceCriteria: entry.acceptanceCriteria ?? [],
            intentLane: entry.intentLane ?? "inbox",
            archivedAt: entry.archivedAt ?? null,
            createdAt: entry.createdAt ?? now,
            updatedAt: entry.updatedAt ?? now,
            revision: 1
          };
          byLegacy.set(legacyClientId, record);
          report.created.push({ id: record.id, legacyClientId, code: record.code });
          if (mode === "commit") file.requirements[record.id] = record;
        }
      });
      return report;
    }
  };
}

export interface RequirementImportEntry {
  legacyClientId: string;
  projectId: string;
  code?: string;
  title: string;
  summary?: string;
  priority?: RequirementServerRecord["priority"];
  owner?: string;
  rawRequirement?: string;
  acceptanceCriteria?: string[];
  intentLane?: RequirementIntentLane;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface RequirementImportReport {
  mode: "dry-run" | "commit";
  created: Array<{ id: string; legacyClientId: string; code: string }>;
  skipped: Array<{ legacyClientId: string; reason: string }>;
  invalid: Array<{ legacyClientId?: string; reason: string }>;
}

/** Stable hash over the human-intent content used for import idempotency. */
export function requirementContentHash(value: Pick<RequirementServerRecord, "projectId" | "title" | "summary" | "rawRequirement" | "acceptanceCriteria">): string {
  return createHash("sha256").update(JSON.stringify([
    value.projectId,
    value.title,
    value.summary,
    value.rawRequirement,
    value.acceptanceCriteria
  ])).digest("hex");
}
