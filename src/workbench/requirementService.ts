import { promises as fs } from "node:fs";
import path from "node:path";
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

const EMPTY_FILE: RequirementsFile = { schemaVersion: 1, requirements: {} };

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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_FILE;
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
