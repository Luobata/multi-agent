import type { EmployeeSession, EmployeeSessionMessage, InvocationRecord, WorkInstanceRecord, WorkbenchState } from "./types.js";

/**
 * Store v2 persistence types (design: plan-backup-store-and-dispatch-design.md A3).
 *
 * v2 splits the monolithic v1 `state.json` into a configuration document
 * (`state.json` holds the 18 config domains plus the shard manifests) and three
 * append-only activity shards under `activity/`. The in-memory assembled shape
 * remains the v1 `WorkbenchState`, so the 100+ read call sites are unchanged.
 */

/** The 18 configuration domains; field shapes are unchanged from v1. */
export type WorkbenchConfigState = Omit<WorkbenchState, "schemaVersion" | "sessions" | "invocations" | "workInstances">;

/** The three activity domains sharded out of state.json in v2. */
export interface ActivityState {
  sessions: Record<string, EmployeeSession>;
  workInstances: Record<string, WorkInstanceRecord>;
  invocations: Record<string, InvocationRecord>;
}

export type ActivityEntity = keyof ActivityState;

export const ACTIVITY_ENTITIES: readonly ActivityEntity[] = ["sessions", "workInstances", "invocations"];

/** Directory name under `activity/` for each entity (logical name → on-disk name). */
export const ACTIVITY_SHARD_DIRS: Record<ActivityEntity, string> = {
  sessions: "sessions",
  workInstances: "workinstances",
  invocations: "invocations"
};

/** Manifest for one activity shard, persisted inside v2 `state.json`. */
export interface ActivityShardManifest {
  version: 1;
  /** Highest log sequence number folded into base.json (inclusive). */
  baseSeq: number;
  /** Number of log.jsonl lines (reconciliation count). */
  logEntries: number;
  /** sha256 of base.json content, verified on every open. */
  baseSha256: `sha256:${string}`;
}

export type ActivityManifests = Record<ActivityEntity, ActivityShardManifest>;

/** v2 on-disk shape of state.json. */
export interface WorkbenchStateV2 {
  schemaVersion: 2;
  config: WorkbenchConfigState;
  activity: ActivityManifests;
}

/** One append-only fact in a shard's log.jsonl (replay is idempotent). */
export type ActivityLogEvent =
  | { v: 1; seq: number; op: "record.upsert"; entity: ActivityEntity; id: string; record: unknown; at: string }
  | { v: 1; seq: number; op: "messages.append"; entity: "sessions"; id: string; message: EmployeeSessionMessage; dedupeKey?: string; at: string }
  | { v: 1; seq: number; op: "record.delete"; entity: ActivityEntity; id: string; at: string };

/** Append intent for the explicit hot-path API (seq is assigned by the store). */
export type ActivityAppend =
  | { op: "record.upsert"; entity: ActivityEntity; id: string; record: unknown }
  | { op: "messages.append"; entity: "sessions"; id: string; message: EmployeeSessionMessage; dedupeKey?: string }
  | { op: "record.delete"; entity: ActivityEntity; id: string };

/** Observability record for one open() (migration, torn-tail, drift). */
export interface StoreOpenReport {
  migrated: boolean;
  migration?: {
    v1Sha256: `sha256:${string}`;
    v2Sha256: `sha256:${string}`;
    domainSha256: Record<string, `sha256:${string}`>;
    activityCounts: Record<ActivityEntity, number>;
    durationMs: number;
  };
  truncatedTail: Array<{ entity: ActivityEntity; bytesDropped: number }>;
  manifestDrift: Array<{ entity: ActivityEntity; expected: number; actual: number }>;
  skippedEvents: number;
}

/** Read-only health report produced by `workbench store-verify`. */
export interface StoreVerifyReport {
  ok: boolean;
  dataRoot: string;
  schemaVersion: 1 | 2;
  shards?: Array<{
    entity: ActivityEntity;
    baseSha256Matches: boolean;
    logEntriesExpected: number;
    logEntriesActual: number;
    recordCount: number;
    truncatedTail: boolean;
  }>;
  backupDrift?: Record<ActivityEntity, { backup: number; current: number }>;
  notes: string[];
}
