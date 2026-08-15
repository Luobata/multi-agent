import type { InvocationRecord, WorkInstanceStatus } from "./types";

const TERMINAL_INVOCATION_STATUSES = new Set(["completed", "blocked", "failed", "cancelled"]);

export function completionRatio(tally: Record<WorkInstanceStatus, number>): number {
  // Failed/blocked/skipped instances are retained as immutable attempt evidence.
  // They must not permanently depress delivery progress after the Supervisor has
  // replanned and a replacement instance succeeds.
  const actionable = tally.completed + tally.queued + tally.waiting + tally.running + tally["cancellation-requested"];
  return actionable === 0 ? (tally.completed > 0 ? 1 : 0) : tally.completed / actionable;
}

export function historicalExceptionCount(tally: Record<WorkInstanceStatus, number>): number {
  return tally.blocked + tally.failed + tally.skipped + tally.cancelled;
}

export function progressTone(status: InvocationRecord["status"]): "running" | "confirmation" | "completed" | "blocked" | "failed" {
  if (status === "awaiting-human-decision") return "confirmation";
  if (status === "completed") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "failed" || status === "cancelled") return "failed";
  return "running";
}

export function activeSupervisorInvocations(invocations: InvocationRecord[]): InvocationRecord[] {
  return invocations.filter((invocation) =>
    invocation.executionSnapshot?.workflow.architecture === "supervisor"
    && !TERMINAL_INVOCATION_STATUSES.has(invocation.status));
}

const STUDIO_TERMINAL_GRACE_MS = 45_000;

export function studioSupervisorInvocations(
  invocations: InvocationRecord[],
  now: number,
  graceMs: number = STUDIO_TERMINAL_GRACE_MS
): InvocationRecord[] {
  return invocations.filter((invocation) => {
    if (invocation.executionSnapshot?.workflow.architecture !== "supervisor") return false;
    if (!TERMINAL_INVOCATION_STATUSES.has(invocation.status)) return true;
    if (!invocation.completedAt) return false;
    return now - new Date(invocation.completedAt).getTime() <= graceMs;
  });
}
