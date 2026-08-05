import type { JsonObject, JsonValue } from "../core/types.js";
import type {
  InvocationDetail,
  InvocationStatus,
  WorkInstanceRecord,
  WorkInstanceStatus
} from "./types.js";

/** Aggregated, caller-facing progress for one asynchronous invocation. */
export interface InvocationProgress {
  invocationId: string;
  runId: string;
  workflowId: string;
  architecture: string;
  /** Overall lifecycle status of the invocation. */
  status: InvocationStatus;
  /** Human-facing phase label carried on the invocation record. */
  phase: string;
  /** True once the invocation reached a terminal status. */
  terminal: boolean;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  /** Highest supervisor round observed so far (0 when no round metadata exists). */
  round: number;
  /** Count of work instances in each status, so a caller can render a tally without the raw list. */
  tally: Record<WorkInstanceStatus, number>;
  /** One line per work instance, ordered by round then creation. */
  steps: InvocationProgressStep[];
  /** Leader (supervisor) narrative reconstructed from the run record, newest round last. */
  leaderReport: LeaderReport;
  /** Present when the run finished with a delivery/blocked/failed summary. */
  outcome?: { status: string; summary?: string; reason?: string };
}

export interface InvocationProgressStep {
  nodeId: string;
  roleId?: string;
  kind?: WorkInstanceRecord["kind"];
  round?: number;
  employeeId: string;
  status: WorkInstanceStatus;
  phase: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface LeaderReport {
  /** True when a supervisor run record was available to derive the narrative. */
  available: boolean;
  /** How many delegation rounds the leader has completed so far. */
  rounds: number;
  /** How many worker delegations the leader has dispatched in total. */
  delegations: number;
  /** Per-round narrative of what the leader decided. */
  entries: LeaderReportEntry[];
  /** Gate outcomes captured on the run output, when present. */
  gates: LeaderGateStatus[];
}

export interface LeaderReportEntry {
  round: number;
  /** "delegate" | "satisfy-gate" | "finish" | "unknown". */
  action: string;
  /** The leader's own summary for the round, when it provided one. */
  summary?: string;
  /** Assignments dispatched this round: which role got what task. */
  assignments: Array<{ roleId?: string; task?: string; workKind?: string }>;
  status: WorkInstanceStatus | "pending";
}

export interface LeaderGateStatus {
  gateId: string;
  status: string;
}

const EMPTY_TALLY: Record<WorkInstanceStatus, number> = {
  queued: 0,
  waiting: 0,
  running: 0,
  completed: 0,
  blocked: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0
};

const TERMINAL_STATUSES = new Set<InvocationStatus>(["completed", "blocked", "failed", "cancelled"]);

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function metadataRound(instance: WorkInstanceRecord): number {
  return typeof instance.round === "number" ? instance.round : 0;
}

/**
 * Reconstruct the leader's decision narrative from the immutable run record.
 * Each `supervisor-r{N}` node stores the parsed leader decision as its output,
 * so we can present what the leader planned each round without touching the runtime loop.
 */
function buildLeaderReport(run: JsonObject | undefined): LeaderReport {
  if (!run) return { available: false, rounds: 0, delegations: 0, entries: [], gates: [] };
  const nodes = asObject(run.nodes);
  const entries: LeaderReportEntry[] = [];
  let delegations = 0;
  if (nodes) {
    for (const [nodeId, rawNode] of Object.entries(nodes)) {
      const node = asObject(rawNode);
      if (!node) continue;
      const metadata = asObject(node.metadata);
      if (metadata?.kind !== "supervisor") continue;
      const round = typeof metadata.round === "number" ? metadata.round : Number(/supervisor-r(\d+)/.exec(nodeId)?.[1] ?? 0);
      const decision = asObject(node.output);
      const action = asString(decision?.action) ?? "unknown";
      const rawAssignments = Array.isArray(decision?.assignments) ? decision.assignments : [];
      const assignments = rawAssignments.map((entry: JsonValue) => {
        const assignment = asObject(entry) ?? {};
        return {
          roleId: asString(assignment.roleId),
          task: asString(assignment.task),
          workKind: asString(assignment.workKind)
        };
      });
      delegations += assignments.length;
      entries.push({
        round,
        action,
        summary: asString(decision?.summary),
        assignments,
        status: (asString(node.status) as WorkInstanceStatus | undefined) ?? "pending"
      });
    }
  }
  entries.sort((left, right) => left.round - right.round);
  const output = asObject(run.output);
  const gates = Array.isArray(output?.gates)
    ? output.gates
        .map((entry: JsonValue) => asObject(entry))
        .filter((gate: JsonObject | undefined): gate is JsonObject => Boolean(gate))
        .map((gate: JsonObject) => ({ gateId: asString(gate.gateId) ?? asString(gate.id) ?? "gate", status: asString(gate.status) ?? "unknown" }))
    : [];
  const runDelegations = typeof output?.delegations === "number" ? output.delegations : delegations;
  const runRounds = typeof output?.rounds === "number" ? output.rounds : entries.at(-1)?.round ?? 0;
  return { available: true, rounds: runRounds, delegations: runDelegations, entries, gates };
}

function buildOutcome(run: JsonObject | undefined): InvocationProgress["outcome"] {
  if (!run) return undefined;
  const status = asString(run.status);
  if (!status) return undefined;
  const output = asObject(run.output);
  const summary = asString(output?.summary);
  const reason = asString(output?.reason);
  if (!summary && !reason) return { status };
  return { status, summary, reason };
}

/**
 * Derive an aggregated, caller-facing progress report from an invocation detail.
 * Pure and deterministic: no I/O, no runtime coupling — safe to call on every poll.
 */
export function computeInvocationProgress(detail: InvocationDetail): InvocationProgress {
  const { invocation, instances } = detail;
  const run = asObject(detail.run);
  const tally = { ...EMPTY_TALLY };
  for (const instance of instances) tally[instance.status] += 1;
  const steps: InvocationProgressStep[] = [...instances]
    .sort((left, right) => (metadataRound(left) - metadataRound(right)) || left.createdAt.localeCompare(right.createdAt))
    .map((instance) => ({
      nodeId: instance.nodeId,
      roleId: instance.roleId,
      kind: instance.kind,
      round: instance.round,
      employeeId: instance.employeeId,
      status: instance.status,
      phase: instance.phase,
      error: instance.error,
      startedAt: instance.startedAt,
      completedAt: instance.completedAt
    }));
  const leaderReport = buildLeaderReport(run);
  const round = Math.max(
    0,
    leaderReport.rounds,
    ...instances.map(metadataRound)
  );
  return {
    invocationId: invocation.id,
    runId: invocation.runId,
    workflowId: invocation.target.id,
    architecture: invocation.executionSnapshot?.workflow.architecture ?? "unknown",
    status: invocation.status,
    phase: invocation.phase,
    terminal: TERMINAL_STATUSES.has(invocation.status),
    startedAt: invocation.startedAt,
    completedAt: invocation.completedAt,
    updatedAt: invocation.updatedAt,
    round,
    tally,
    steps,
    leaderReport,
    outcome: buildOutcome(run)
  };
}
